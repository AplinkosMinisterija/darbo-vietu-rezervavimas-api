'use strict';

import moleculer, { Context, Errors } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import Cron from '@r2d2bzh/moleculer-cron';
import knex from 'knex';
import knexConfig from '../knexfile';
import { EndpointType } from '../types/constants';
import { requireAdminHook, AuthUser } from '../utils/auth';
import {
  AM_CONTACTS_URL,
  httpsGetText,
  parseLeadership,
  matchLeadersToRooms,
  AmLeader,
} from '../utils/amContacts';

const db = knex(knexConfig);

/** Settings key gating the monthly manager auto-sync cron (absent → ON). */
const MANAGER_SYNC_SETTING_KEY = 'manager_sync_enabled';

interface UserAuthMeta {
  user?: AuthUser;
  _systemTransition?: boolean;
}

interface SyncReport {
  trigger: string;
  leadersOnPage: number;
  matchedToRoom: number;
  matchedToUser: number;
  autoManagersSet: number;
  manualKept: number;
  unmatchedUnits: string[];
  unmatchedUsers: string[];
  skipped?: boolean;
}

/**
 * Derives room managers from the public AM contacts page and keeps them current
 * with a monthly cron. Department heads (vedėjas/grupės vadovas/direktorius) →
 * the room named after their unit. The cron only rewrites `source='auto'` rows;
 * admin-set `source='manual'` rows survive. Admin can also run it on demand,
 * preview, or toggle it off.
 */
@Service({
  name: 'roomManagers',
  mixins: [Cron],
  crons: [
    {
      name: 'monthlyManagerSync',
      cronTime: '0 21 1 * *', // 1st of every month, 21:00
      timeZone: 'Europe/Vilnius',
      async onTick(this: any) {
        try {
          if (!(await this.isSyncEnabled())) {
            this.logger.info('[roomManagers] cron skipped — manager sync disabled by admin.');
            return;
          }
          await this.runSync('cron');
        } catch (err: any) {
          this.logger.error(`[roomManagers] cron sync failed: ${err?.message || err}`);
        }
      },
    },
  ],
})
export default class RoomManagersService extends moleculer.Service {
  running = false;

  // --- admin actions ---

  /** Admin: list room↔manager rows (optional roomId filter), joined for the UI. */
  @Action({
    rest: 'GET /',
    auth: true,
    types: [EndpointType.ADMIN],
    params: { roomId: { type: 'string', optional: true } },
  })
  async listManagers(ctx: Context<{ roomId?: string }, UserAuthMeta>) {
    requireAdminHook(ctx);
    const q = db('room_managers as rm')
      .join('users as u', 'u.id', 'rm.user_id')
      .join('rooms as r', 'r.id', 'rm.room_id')
      .whereNull('u.deleted_at')
      .whereNull('r.deleted_at');
    if (ctx.params.roomId) q.where('rm.room_id', ctx.params.roomId);
    const rows = await q
      .orderBy([{ column: 'r.number', order: 'asc' }])
      .select(
        'rm.id',
        'rm.source',
        'rm.roomId',
        'rm.userId',
        'u.displayName as userDisplayName',
        'u.email as userEmail',
        'r.number as roomNumber',
        'r.name as roomName',
      );
    return rows.map((x: any) => ({
      id: x.id,
      source: x.source,
      room: { id: x.roomId, number: x.roomNumber, name: x.roomName },
      user: { id: x.userId, displayName: x.userDisplayName, email: x.userEmail },
    }));
  }

  /** Admin: manually assign a manager to a room (sticky — survives cron). */
  @Action({
    rest: 'POST /',
    auth: true,
    types: [EndpointType.ADMIN],
    params: { userId: { type: 'uuid' }, roomId: { type: 'uuid' } },
  })
  async addManager(ctx: Context<{ userId: string; roomId: string }, UserAuthMeta>) {
    requireAdminHook(ctx);
    const u = await db('users').where({ id: ctx.params.userId }).whereNull('deleted_at').first();
    if (!u) throw new Errors.MoleculerClientError('Naudotojas nerastas.', 404, 'USER_NOT_FOUND');
    const r = await db('rooms').where({ id: ctx.params.roomId }).whereNull('deleted_at').first();
    if (!r) throw new Errors.MoleculerClientError('Patalpa nerasta.', 404, 'ROOM_NOT_FOUND');
    await db('room_managers')
      .insert({ user_id: ctx.params.userId, room_id: ctx.params.roomId, source: 'manual' })
      .onConflict(['user_id', 'room_id'])
      .merge({ source: 'manual' });
    await this.safeAudit(ctx.meta?.user?.id, 'ADMIN_ADD_ROOM_MANAGER', {
      userId: ctx.params.userId,
      roomId: ctx.params.roomId,
    });
    return { ok: true };
  }

  /** Admin: remove a manager row by id. */
  @Action({
    rest: 'DELETE /:id',
    auth: true,
    types: [EndpointType.ADMIN],
    params: { id: { type: 'uuid' } },
  })
  async removeManager(ctx: Context<{ id: string }, UserAuthMeta>) {
    requireAdminHook(ctx);
    const row = await db('room_managers').where({ id: ctx.params.id }).first();
    if (!row) throw new Errors.MoleculerClientError('Įrašas nerastas.', 404, 'NOT_FOUND');
    await db('room_managers').where({ id: ctx.params.id }).delete();
    await this.safeAudit(ctx.meta?.user?.id, 'ADMIN_REMOVE_ROOM_MANAGER', {
      managerRowId: ctx.params.id,
      userId: row.userId,
      roomId: row.roomId,
    });
    return { ok: true };
  }

  /** Admin: run the AM-derived auto-sync now. */
  @Action({ rest: 'POST /sync', auth: true, types: [EndpointType.ADMIN] })
  async runNow(ctx: Context<{}, UserAuthMeta>) {
    requireAdminHook(ctx);
    return this.runSync('manual', ctx.meta?.user?.id);
  }

  /** Admin: preview the AM-derived mapping without writing. */
  @Action({ rest: 'GET /preview', auth: true, types: [EndpointType.ADMIN] })
  async preview(ctx: Context<{}, UserAuthMeta>) {
    requireAdminHook(ctx);
    const { leaders, mapped, rooms } = await this.derive();
    const roomById = new Map(rooms.map((r) => [r.id, r]));
    const usersByEmail = await this.usersByEmail();
    return {
      leadersOnPage: leaders.length,
      rows: mapped.map((m) => ({
        email: m.email,
        matchedUser: Boolean(usersByEmail.get(m.email)),
        rooms: m.roomIds.map((id) => roomById.get(id)?.number).filter(Boolean),
      })),
    };
  }

  /** Admin: cron on/off status. */
  @Action({ rest: 'GET /status', auth: true, types: [EndpointType.ADMIN] })
  async status(ctx: Context<{}, UserAuthMeta>) {
    requireAdminHook(ctx);
    return { enabled: await this.isSyncEnabled() };
  }

  /** Admin: enable/disable the monthly cron. */
  @Action({
    rest: 'POST /enabled',
    auth: true,
    types: [EndpointType.ADMIN],
    params: { enabled: { type: 'boolean', convert: true } },
  })
  async setEnabled(ctx: Context<{ enabled: boolean }, UserAuthMeta>) {
    requireAdminHook(ctx);
    const json = JSON.stringify(Boolean(ctx.params.enabled));
    await db('settings')
      .insert({ key: MANAGER_SYNC_SETTING_KEY, value: db.raw('?::jsonb', [json]), updated_at: db.fn.now() })
      .onConflict('key')
      .merge();
    await this.safeAudit(ctx.meta?.user?.id, 'MANAGER_SYNC_TOGGLED', { enabled: ctx.params.enabled });
    return { enabled: ctx.params.enabled };
  }

  // --- core ---

  @Method
  async derive(): Promise<{ leaders: AmLeader[]; mapped: Array<{ email: string; roomIds: string[] }>; rooms: any[] }> {
    const html = await httpsGetText(AM_CONTACTS_URL);
    const leaders = parseLeadership(html);
    const rooms = await db('rooms').whereNull('deleted_at').select('id', 'number', 'name');
    const mapped = matchLeadersToRooms(leaders, rooms);
    return { leaders, mapped, rooms };
  }

  @Method
  async usersByEmail(): Promise<Map<string, any>> {
    const users = await db('users').whereNull('deleted_at').select('id', 'email');
    return new Map(users.map((u: any) => [String(u.email).toLowerCase(), u]));
  }

  @Method
  async runSync(trigger: string, actorId?: string): Promise<SyncReport> {
    if (this.running) {
      this.logger.warn('[roomManagers] sync skipped — already running.');
      return {
        trigger,
        leadersOnPage: 0,
        matchedToRoom: 0,
        matchedToUser: 0,
        autoManagersSet: 0,
        manualKept: 0,
        unmatchedUnits: [],
        unmatchedUsers: [],
        skipped: true,
      };
    }
    this.running = true;
    try {
      const { leaders, mapped, rooms } = await this.derive();
      const usersByEmail = await this.usersByEmail();

      // Desired auto rows: (user_id, room_id) for every leader that matched
      // BOTH a room and a DB user.
      const desired: Array<{ user_id: string; room_id: string }> = [];
      const unmatchedUsers: string[] = [];
      for (const m of mapped) {
        const u = usersByEmail.get(m.email);
        if (!u) {
          unmatchedUsers.push(m.email);
          continue;
        }
        for (const roomId of m.roomIds) desired.push({ user_id: u.id, room_id: roomId });
      }

      let manualKept = 0;
      await db.transaction(async (trx) => {
        const [{ c }] = await trx('room_managers')
          .where({ source: 'manual' })
          .count<{ c: string }[]>('id as c');
        manualKept = Number(c) || 0;
        // Replace only the auto-managed rows.
        await trx('room_managers').where({ source: 'auto' }).delete();
        if (desired.length) {
          await trx('room_managers')
            .insert(desired.map((d) => ({ ...d, source: 'auto' })))
            // If the pair already exists as a manual row, keep it manual.
            .onConflict(['user_id', 'room_id'])
            .ignore();
        }
      });

      const matchedUnitsCount = mapped.length;
      const report: SyncReport = {
        trigger,
        leadersOnPage: leaders.length,
        matchedToRoom: matchedUnitsCount,
        matchedToUser: desired.length,
        autoManagersSet: desired.length,
        manualKept,
        unmatchedUnits: leaders.filter((l) => !mapped.find((m) => m.email === l.email)).map((l) => l.dept),
        unmatchedUsers,
      };
      this.logger.info(
        `[roomManagers] sync (${trigger}): leaders=${report.leadersOnPage} ` +
          `auto=${report.autoManagersSet} manualKept=${report.manualKept} ` +
          `noUser=${report.unmatchedUsers.length} noRoom=${report.unmatchedUnits.length}`,
      );
      await this.safeAudit(actorId, 'MANAGER_SYNC', {
        trigger,
        autoManagersSet: report.autoManagersSet,
        manualKept: report.manualKept,
      });
      return report;
    } finally {
      this.running = false;
    }
  }

  // --- settings (kill-switch) ---

  @Method
  async isSyncEnabled(): Promise<boolean> {
    const rows = await db('settings').where({ key: MANAGER_SYNC_SETTING_KEY }).limit(1);
    if (rows.length === 0) return true;
    const v = rows[0].value;
    return v === true || v === 'true';
  }

  @Method
  async safeAudit(actorId: string | undefined, action: string, payload: any) {
    try {
      await this.broker.call(
        'audit.log',
        { userId: actorId, action, payload },
        { meta: { _systemTransition: true } } as any,
      );
    } catch (err: any) {
      this.logger.warn(`[roomManagers] audit.log failed: ${err?.message || err}`);
    }
  }
}
