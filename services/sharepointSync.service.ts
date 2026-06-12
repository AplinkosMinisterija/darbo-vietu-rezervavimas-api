'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import Cron from '@r2d2bzh/moleculer-cron';
import knex from 'knex';
import knexConfig from '../knexfile';
import { EndpointType } from '../types/constants';
import { requireAdminHook, AuthUser } from '../utils/auth';
import {
  fetchOnSiteOnlyEmployees,
  isSharePointConfigured,
  OnSitePerson,
} from '../utils/sharepoint';

const db = knex(knexConfig);

/** Settings key gating the weekly auto-reservation cron. Absent → ON (so the
 *  prior always-on behavior is preserved until an admin toggles it off). */
const AUTO_RESERVE_SETTING_KEY = 'sharepoint_auto_reserve_enabled';

interface UserAuthMeta {
  user?: AuthUser;
  _systemTransition?: boolean;
}

/** Lowercased local-part of an email (before `@`), for cross-domain matching
 *  (@am.lt vs @*.onmicrosoft.com share the same local-part). */
function localPart(email: string | null | undefined): string | null {
  if (!email) return null;
  const lp = email.toLowerCase().trim().split('@')[0];
  return lp || null;
}

/**
 * Normalized full name for fallback matching when a SharePoint person has no
 * email: strip diacritics, drop parenthetical maiden names, keep letters,
 * sort tokens so word order ("Vardas Pavardė" vs "Pavardė Vardas") doesn't
 * matter. Returns null for empty/unusable input.
 */
function normalizeName(s: string | null | undefined): string | null {
  if (!s) return null;
  const n = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
  return n || null;
}

interface DbUser {
  id: string;
  email: string;
  displayName: string;
}

interface UserIndex {
  byLocal: Map<string, DbUser>;
  byName: Map<string, DbUser>;
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Mon–Fri dates (YYYY-MM-DD) of the upcoming week: the week starting the next
 * Monday. Run on a Sunday → tomorrow's Monday through Friday. Run on a Monday
 * (e.g. a mid-week initial trigger) → that same week. Computed in UTC; the
 * 20:00 Vilnius trigger is well within the same UTC calendar day.
 */
function upcomingWeekdays(now: Date): string[] {
  const dow = now.getUTCDay() === 0 ? 7 : now.getUTCDay(); // 1=Mon..7=Sun
  const daysUntilMonday = (8 - dow) % 7; // Sun->1, Mon->0, Sat->2, Fri->3
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday),
  );
  const out: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    out.push(ymd(d));
  }
  return out;
}

interface PickedRoom {
  id: string;
  number: string;
  name: string;
  deskCount: number;
  isShared: boolean;
}

interface SyncReport {
  trigger: string;
  targetWeek: { from: string; to: string };
  sharePointPeople: number;
  matchedUsers: number;
  reservationsCreated: number;
  skippedExisting: number;
  skippedNoDesk: number;
  unmatched: string[];
  usersWithoutRoom: string[];
  perUser: Array<{ email: string; displayName: string; room: string; dates: string[] }>;
  /** Set when the run was skipped because another run was in progress. */
  skipped?: boolean;
}

/**
 * Weekly SharePoint-driven auto-reservation.
 *
 * Every Sunday 20:00 (Europe/Vilnius) we reserve desks for the upcoming
 * Monday–Friday for employees who work full-day from the ministry only
 * ("Vien tik iš AM" in the intranet remote-work list). The schedule uses the
 * team's `@r2d2bzh/moleculer-cron` mixin (same pattern as biip-medziokle-api
 * seasons.service). The cron's `onTick` is a no-op when SharePoint isn't
 * configured (SHAREPOINT_* unset), so staging/prod stay green until wired.
 *
 * The initial run is triggered manually via `POST /api/sharepointSync/run`
 * (admin) after the first deploy — we intentionally do NOT run on boot.
 */
@Service({
  name: 'sharepointSync',
  mixins: [Cron],
  crons: [
    {
      name: 'sharepointWeeklyAutoReserve',
      cronTime: '0 20 * * 0', // Sundays 20:00
      timeZone: 'Europe/Vilnius',
      async onTick(this: any) {
        if (!isSharePointConfigured()) return;
        // Admin kill-switch: skip the weekly run when auto-reserve is disabled.
        if (!(await this.isAutoReserveEnabled())) {
          this.logger.info('[sharepointSync] cron skipped — auto-reserve disabled by admin.');
          return;
        }
        try {
          await this.runSync('cron');
        } catch (err: any) {
          this.logger.error(`[sharepointSync] cron run failed: ${err?.message || err}`);
        }
      },
    },
  ],
})
export default class SharePointSyncService extends moleculer.Service {
  /** Overlap guard: prevents the weekly cron and a manual `runNow` (or two
   *  manual runs) from executing concurrently. The DB unique constraints make
   *  overlap data-safe; this just keeps the report counters accurate. */
  running = false;

  // --- admin actions ---

  /**
   * Admin: trigger the sync immediately (used for the initial run after
   * deploy, or to re-run on demand). Returns the full report.
   */
  @Action({ rest: 'POST /run', auth: true, types: [EndpointType.ADMIN] })
  async runNow(ctx: Context<{}, UserAuthMeta>) {
    requireAdminHook(ctx);
    if (!isSharePointConfigured()) {
      return { configured: false, message: 'SharePoint integration is not configured.' };
    }
    return this.runSync('manual', ctx.meta?.user?.id);
  }

  /**
   * Admin: preview which SharePoint on-site-only people map to DB users —
   * WITHOUT creating any reservations. Sanity-checks the match before/
   * independent of the weekly job.
   */
  @Action({ rest: 'GET /preview', auth: true, types: [EndpointType.ADMIN] })
  async preview(ctx: Context<{}, UserAuthMeta>) {
    requireAdminHook(ctx);
    if (!isSharePointConfigured()) {
      return { configured: false };
    }
    const people = await fetchOnSiteOnlyEmployees();
    const idx = await this.buildUserIndex();
    const rows = people.map((p) => {
      const user = this.matchPerson(p, idx);
      return {
        name: p.name,
        email: p.email,
        matched: Boolean(user),
        matchedBy: user ? (localPart(p.email) && idx.byLocal.get(localPart(p.email)!) ? 'email' : 'name') : null,
        dbUserId: user?.id ?? null,
        dbEmail: user?.email ?? null,
      };
    });
    const d = upcomingWeekdays(new Date());
    return {
      configured: true,
      sharePointPeople: people.length,
      matched: rows.filter((r) => r.matched).length,
      targetWeek: { from: d[0], to: d[4] },
      people: rows,
    };
  }

  /**
   * Admin: current integration state — whether the weekly auto-reserve cron is
   * enabled (admin kill-switch) and whether SharePoint env is configured at all.
   */
  @Action({ rest: 'GET /status', auth: true, types: [EndpointType.ADMIN] })
  async status(ctx: Context<{}, UserAuthMeta>) {
    requireAdminHook(ctx);
    return {
      enabled: await this.isAutoReserveEnabled(),
      configured: isSharePointConfigured(),
    };
  }

  /**
   * Admin: enable/disable the weekly auto-reserve cron. Persisted in `settings`
   * so it survives restarts. Does not touch the manual `runNow` action — an
   * admin can still trigger a one-off run on demand.
   */
  @Action({
    rest: 'POST /enabled',
    auth: true,
    types: [EndpointType.ADMIN],
    params: { enabled: { type: 'boolean', convert: true } },
  })
  async setEnabled(ctx: Context<{ enabled: boolean }, UserAuthMeta>) {
    requireAdminHook(ctx);
    await this.setAutoReserveEnabled(ctx.params.enabled);
    await this.safeAuditLog(ctx.meta?.user?.id, 'SHAREPOINT_AUTO_RESERVE_TOGGLED', {
      enabled: ctx.params.enabled,
    });
    return { enabled: ctx.params.enabled, configured: isSharePointConfigured() };
  }

  // --- settings (kill-switch) ---

  /** Reads the persisted flag; absent → true (auto-reserve on by default). */
  @Method
  async isAutoReserveEnabled(): Promise<boolean> {
    const rows = await db('settings').where({ key: AUTO_RESERVE_SETTING_KEY }).limit(1);
    if (rows.length === 0) return true;
    const v = rows[0].value;
    return v === true || v === 'true';
  }

  @Method
  async setAutoReserveEnabled(enabled: boolean): Promise<void> {
    const json = JSON.stringify(Boolean(enabled));
    await db('settings')
      .insert({
        key: AUTO_RESERVE_SETTING_KEY,
        value: db.raw('?::jsonb', [json]),
        updated_at: db.fn.now(),
      })
      .onConflict('key')
      .merge();
  }

  // --- core ---

  @Method
  async runSync(trigger: string, actorId?: string): Promise<SyncReport> {
    const dates = upcomingWeekdays(new Date());
    const emptyReport: SyncReport = {
      trigger,
      targetWeek: { from: dates[0], to: dates[4] },
      sharePointPeople: 0,
      matchedUsers: 0,
      reservationsCreated: 0,
      skippedExisting: 0,
      skippedNoDesk: 0,
      unmatched: [],
      usersWithoutRoom: [],
      perUser: [],
    };

    if (this.running) {
      this.logger.warn('[sharepointSync] run skipped — a previous run is still in progress.');
      return { ...emptyReport, skipped: true };
    }
    this.running = true;
    try {
      return await this.runSyncInner(trigger, actorId, dates);
    } finally {
      this.running = false;
    }
  }

  @Method
  async runSyncInner(trigger: string, actorId: string | undefined, dates: string[]): Promise<SyncReport> {
    this.logger.info(`[sharepointSync] run (${trigger}) — target week ${dates[0]}..${dates[4]}`);

    const people: OnSitePerson[] = await fetchOnSiteOnlyEmployees();
    const idx = await this.buildUserIndex();

    const report: SyncReport = {
      trigger,
      targetWeek: { from: dates[0], to: dates[4] },
      sharePointPeople: people.length,
      matchedUsers: 0,
      reservationsCreated: 0,
      skippedExisting: 0,
      skippedNoDesk: 0,
      unmatched: [],
      usersWithoutRoom: [],
      perUser: [],
    };

    for (const person of people) {
      const user = this.matchPerson(person, idx);
      if (!user) {
        report.unmatched.push(person.email || person.name || '(unknown)');
        continue;
      }
      report.matchedUsers += 1;

      const room = await this.pickRoomForUser(user.id);
      if (!room) {
        report.usersWithoutRoom.push(user.email);
        continue;
      }

      const created: string[] = [];
      for (const date of dates) {
        const outcome = await this.reserveDesk(user.id, room, date);
        if (outcome === 'created') {
          report.reservationsCreated += 1;
          created.push(date);
        } else if (outcome === 'existing') {
          report.skippedExisting += 1;
        } else if (outcome === 'no-desk') {
          report.skippedNoDesk += 1;
        }
      }
      report.perUser.push({
        email: user.email,
        displayName: user.displayName,
        room: `${room.number} ${room.name}`,
        dates: created,
      });
    }

    this.logger.info(
      `[sharepointSync] done: people=${report.sharePointPeople} matched=${report.matchedUsers} ` +
        `created=${report.reservationsCreated} existing=${report.skippedExisting} ` +
        `noDesk=${report.skippedNoDesk} noRoom=${report.usersWithoutRoom.length} ` +
        `unmatched=${report.unmatched.length}`,
    );

    await this.safeAuditLog(actorId, 'SHAREPOINT_AUTO_RESERVE', {
      trigger,
      targetWeek: report.targetWeek,
      sharePointPeople: report.sharePointPeople,
      matchedUsers: report.matchedUsers,
      reservationsCreated: report.reservationsCreated,
      skippedExisting: report.skippedExisting,
      skippedNoDesk: report.skippedNoDesk,
      usersWithoutRoom: report.usersWithoutRoom.length,
      unmatched: report.unmatched.length,
    });

    return report;
  }

  /** DB user lookup indexes: by email local-part (primary) and by normalized
   *  full name (fallback). First-wins on collisions. */
  @Method
  async buildUserIndex(): Promise<UserIndex> {
    // Soft-deleted users must not receive auto-reservations.
    const rows = await db('users').whereNull('deleted_at').select('id', 'email', 'displayName');
    const byLocal = new Map<string, DbUser>();
    const byName = new Map<string, DbUser>();
    for (const u of rows as any[]) {
      const user: DbUser = { id: u.id, email: u.email, displayName: u.displayName };
      const lp = localPart(u.email);
      if (lp && !byLocal.has(lp)) byLocal.set(lp, user);
      const nm = normalizeName(u.displayName);
      if (nm && !byName.has(nm)) byName.set(nm, user);
    }
    return { byLocal, byName };
  }

  /**
   * Matches a SharePoint person to a DB user: by email local-part first
   * (authoritative — both sides are firstname.lastname@…), then by normalized
   * full name only when no email is available.
   */
  @Method
  matchPerson(person: OnSitePerson, idx: UserIndex): DbUser | undefined {
    const lp = localPart(person.email);
    const byEmail = lp ? idx.byLocal.get(lp) : undefined;
    if (byEmail) return byEmail;
    const nm = normalizeName(person.name);
    return nm ? idx.byName.get(nm) : undefined;
  }

  /**
   * Picks the room to reserve a desk in for a given user: prefers their own
   * (non-shared) assigned cabinet, ordered by room number for determinism;
   * falls back to a shared assigned room. Null if no (non-deleted) assignment.
   */
  @Method
  async pickRoomForUser(userId: string): Promise<PickedRoom | null> {
    const rooms = await db('user_room_assignments as a')
      .join('rooms as r', 'r.id', 'a.roomId')
      .where('a.userId', userId)
      .whereNull('r.deletedAt')
      .orderBy([
        { column: 'r.isShared', order: 'asc' },
        { column: 'r.number', order: 'asc' },
      ])
      .select('r.id', 'r.number', 'r.name', 'r.deskCount', 'r.isShared');
    if (!rooms.length) return null;
    const r = rooms[0] as any;
    return {
      id: r.id,
      number: r.number,
      name: r.name,
      deskCount: Number(r.deskCount),
      isShared: Boolean(r.isShared),
    };
  }

  /**
   * Reserves the lowest free desk in `room` for `date`. Idempotent:
   *  - 'existing' — user already has a reservation that day (one-per-day rule)
   *  - 'no-desk'  — every desk in the room is taken that day
   *  - 'created'  — a new reservation row was inserted
   * DB unique violations (race) collapse to 'existing'.
   */
  @Method
  async reserveDesk(
    userId: string,
    room: PickedRoom,
    date: string,
  ): Promise<'created' | 'existing' | 'no-desk'> {
    const mine = await db('reservations').where({ userId, date }).limit(1);
    if (mine.length > 0) return 'existing';

    const taken = await db('reservations').where({ roomId: room.id, date }).select('deskNumber');
    const takenSet = new Set(taken.map((t: any) => Number(t.deskNumber)));

    let desk = 0;
    for (let n = 1; n <= room.deskCount; n += 1) {
      if (!takenSet.has(n)) {
        desk = n;
        break;
      }
    }
    if (!desk) return 'no-desk';

    try {
      await db('reservations').insert({
        user_id: userId,
        room_id: room.id,
        desk_number: desk,
        date,
      });
      return 'created';
    } catch (err: any) {
      if (err?.code === '23505') {
        // Raced against a concurrent insert. Treat as a no-op for this slot.
        return 'existing';
      }
      throw err;
    }
  }

  @Method
  async safeAuditLog(actorId: string | undefined, action: string, payload: any) {
    try {
      await this.broker.call(
        'audit.log',
        { userId: actorId, action, payload },
        { meta: { _systemTransition: true } } as any,
      );
    } catch (err: any) {
      this.logger.warn(`[sharepointSync] audit.log failed: ${err?.message || err}`);
    }
  }
}
