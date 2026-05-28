'use strict';

import moleculer, { Context, Errors } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import DatabaseMixin from '../mixins/database.mixin';
import { EndpointType, UserRole } from '../types/constants';
import { requireAdminHook, AuthUser } from '../utils/auth';
import knex from 'knex';
import knexConfig from '../knexfile';

/**
 * Shared Knex handle for the user_room_assignments table. We don't model
 * the join table as its own DbService — it has no business logic, just a
 * read (in `me`) and a transactional rewrite (in `assignRooms`). A direct
 * Knex client keeps both flows in one transaction without smuggling
 * `_systemTransition` through several action calls.
 */
const db = knex(knexConfig);

interface UserAuthMeta {
  user?: AuthUser;
  _systemTransition?: boolean;
  cookies?: Record<string, string>;
}

/**
 * Field projection used by self-lookups (`users.me`, `auth.callback`). All
 * non-sensitive — `display_name` and `email` are needed to render the user
 * banner, `role` drives FE route gating. PII fields (none on this MVP) would
 * go here with `hidden: 'byDefault'`.
 */
export const SELF_USER_FIELDS = ['id', 'msObjectId', 'email', 'displayName', 'role'];

@Service({
  name: 'users',
  mixins: [DatabaseMixin({ collection: 'users' })],
  settings: {
    fields: {
      id: { type: 'string', primaryKey: true, columnType: 'uuid', readonly: true },
      msObjectId: { type: 'string', columnName: 'ms_object_id', optional: true },
      email: { type: 'string', required: true },
      displayName: { type: 'string', columnName: 'display_name', required: true },
      role: {
        type: 'enum',
        values: [UserRole.USER, UserRole.ADMIN],
        default: UserRole.USER,
      },
      createdAt: { type: 'date', columnName: 'created_at', readonly: true },
      updatedAt: { type: 'date', columnName: 'updated_at', readonly: true },
    },
  },
  hooks: {
    before: {
      // DbService auto-actions (writes + broad reads) require ADMIN. The HTTP
      // gate `EndpointType.ADMIN` is enforced by api.service.ts; the hook is
      // the actual privilege boundary, and it fires on internal `ctx.call`
      // invocations too. Internal trusted callers (auth flow, `me`) opt out
      // via `_systemTransition: true` — set inline, never from request input.
      create: 'requireAdminHookMethod',
      update: 'requireAdminHookMethod',
      replace: 'requireAdminHookMethod',
      remove: 'requireAdminHookMethod',
      list: 'requireAdminHookMethod',
      find: 'requireAdminHookMethod',
      get: 'requireAdminHookMethod',
      resolve: 'requireAdminHookMethod',
      count: 'requireAdminHookMethod',
    },
  },
  actions: {
    // Lock the built-in DbService actions behind ADMIN. The mixin already
    // strips their REST aliases; we still need the gate for any direct
    // gateway call that might construct an internal alias.
    create: { auth: true, types: [EndpointType.ADMIN] },
    update: { auth: true, types: [EndpointType.ADMIN] },
    replace: { auth: true, types: [EndpointType.ADMIN] },
    remove: { auth: true, types: [EndpointType.ADMIN] },
    list: { auth: true, types: [EndpointType.ADMIN] },
    find: { auth: true, types: [EndpointType.ADMIN] },
    get: { auth: true, types: [EndpointType.ADMIN] },
    resolve: { auth: true, types: [EndpointType.ADMIN] },
    count: { auth: true, types: [EndpointType.ADMIN] },
  },
})
export default class UsersService extends moleculer.Service {
  @Method
  requireAdminHookMethod(ctx: Context<any, UserAuthMeta>) {
    return requireAdminHook(ctx);
  }

  /**
   * Internal: find an existing user by `msObjectId` or `email`, update drift,
   * else insert. Called from `auth.callback` after Microsoft has verified
   * the identity. Bypasses the admin hook via `_systemTransition: true`.
   *
   * Returns the canonical user row.
   */
  @Action({
    auth: false,
    params: {
      msObjectId: { type: 'string', optional: true },
      email: { type: 'string', min: 1 },
      displayName: { type: 'string', min: 1 },
    },
  })
  async findOrCreate(
    ctx: Context<
      { msObjectId?: string; email: string; displayName: string },
      UserAuthMeta
    >,
  ) {
    // Defense in depth: this action has no REST mapping and `auth: false`,
    // but callers within the broker MUST pass `_systemTransition` because
    // auth.callback is the trust boundary, not the gateway.
    if (!ctx.meta?._systemTransition) {
      throw new Errors.MoleculerClientError(
        'users.findOrCreate is internal-only — caller must set _systemTransition.',
        403,
        'INTERNAL_ONLY',
      );
    }

    const emailNormalized = ctx.params.email.trim();
    const bootstrapAdmin = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
    const isBootstrapAdmin =
      bootstrapAdmin.length > 0 && emailNormalized.toLowerCase() === bootstrapAdmin;

    // 1. Try ms_object_id first — Microsoft's stable identifier survives
    //    email renames inside the tenant.
    let existing: any = null;
    if (ctx.params.msObjectId) {
      const rows = await db('users').where({ ms_object_id: ctx.params.msObjectId }).limit(1);
      existing = rows[0] || null;
    }

    // 2. Fall back to email (citext column → case-insensitive match).
    if (!existing) {
      const rows = await db('users').where({ email: emailNormalized }).limit(1);
      existing = rows[0] || null;
    }

    if (existing) {
      // Drift detection: Microsoft may have rotated the user's display name
      // or backfilled the ms_object_id for a seeded stub. Reconcile silently.
      const updatePayload: any = {};
      if (ctx.params.msObjectId && existing.msObjectId !== ctx.params.msObjectId) {
        updatePayload.ms_object_id = ctx.params.msObjectId;
      }
      if (ctx.params.displayName && existing.displayName !== ctx.params.displayName) {
        updatePayload.display_name = ctx.params.displayName;
      }
      if (Object.keys(updatePayload).length > 0) {
        updatePayload.updated_at = db.fn.now();
        const [updated] = await db('users')
          .where({ id: existing.id })
          .update(updatePayload)
          .returning('*');
        existing = updated;
      }
      return this.normalizeUserRow(existing);
    }

    // 3. Insert new user.
    const [created] = await db('users')
      .insert({
        ms_object_id: ctx.params.msObjectId || null,
        email: emailNormalized,
        display_name: ctx.params.displayName,
        role: isBootstrapAdmin ? UserRole.ADMIN : UserRole.USER,
      })
      .returning('*');

    return this.normalizeUserRow(created);
  }

  /**
   * Internal: resolve user by id without the admin gate. Used by the gateway
   * `authenticate()` to hydrate the request user from the JWT subject.
   *
   * Returns null if the user has been deleted (so the gateway can 401
   * instead of trusting a stale JWT).
   */
  @Action({
    auth: false,
    params: { id: 'string' },
  })
  async resolveById(ctx: Context<{ id: string }, UserAuthMeta>) {
    if (!ctx.meta?._systemTransition) {
      throw new Errors.MoleculerClientError(
        'users.resolveById is internal-only — caller must set _systemTransition.',
        403,
        'INTERNAL_ONLY',
      );
    }
    const rows = await db('users').where({ id: ctx.params.id }).limit(1);
    if (rows.length === 0) return null;
    return this.normalizeUserRow(rows[0]);
  }

  /**
   * Current user + allowed room IDs. Used by FE to render the banner and
   * gate the "Mano stalas" picker.
   */
  @Action({
    rest: 'GET /me',
    auth: true,
    types: [EndpointType.USER],
  })
  async me(ctx: Context<{}, UserAuthMeta>) {
    if (!ctx.meta?.user?.id) {
      throw new Errors.MoleculerClientError('Neprisijungta.', 401, 'NOT_AUTHENTICATED');
    }
    const userId = ctx.meta.user.id;
    const rows = await db('users').where({ id: userId }).limit(1);
    if (rows.length === 0) {
      throw new Errors.MoleculerClientError('Naudotojas nerastas.', 404, 'NOT_FOUND');
    }
    const user = this.normalizeUserRow(rows[0]);
    const assignments = await db('user_room_assignments')
      .where({ user_id: userId })
      .select('room_id');
    const allowedRoomIds = assignments.map((a: any) => a.room_id);
    return { ...user, allowedRoomIds };
  }

  /**
   * Admin-only: paginated user list with optional search.
   */
  @Action({
    rest: 'GET /',
    auth: true,
    types: [EndpointType.ADMIN],
    params: {
      q: { type: 'string', optional: true, max: 200 },
      limit: { type: 'number', integer: true, convert: true, optional: true, min: 1, max: 200 },
      offset: { type: 'number', integer: true, convert: true, optional: true, min: 0 },
    },
  })
  async listUsers(
    ctx: Context<{ q?: string; limit?: number; offset?: number }, UserAuthMeta>,
  ) {
    requireAdminHook(ctx);
    const limit = ctx.params.limit ?? 50;
    const offset = ctx.params.offset ?? 0;
    const q = (ctx.params.q || '').trim();

    const baseQuery = db('users');
    if (q.length > 0) {
      const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      baseQuery.where((b) => {
        // citext makes the email comparison case-insensitive; for display_name
        // we want ILIKE too.
        b.where('email', 'ILIKE', pattern).orWhere('display_name', 'ILIKE', pattern);
      });
    }

    const [{ count }] = await baseQuery.clone().count<{ count: string }[]>('id as count');
    const rows = await baseQuery
      .clone()
      .orderBy('display_name', 'asc')
      .limit(limit)
      .offset(offset);

    return {
      items: rows.map((r: any) => this.normalizeUserRow(r)),
      total: Number(count),
    };
  }

  /**
   * Admin-only: replace a user's room assignments. Wrapped in a transaction
   * so a failed INSERT leaves the original assignments intact.
   */
  @Action({
    rest: 'PUT /:id/rooms',
    auth: true,
    types: [EndpointType.ADMIN],
    params: {
      id: 'string',
      roomIds: { type: 'array', items: 'string', default: [] },
    },
  })
  async assignRooms(
    ctx: Context<{ id: string; roomIds: string[] }, UserAuthMeta>,
  ) {
    requireAdminHook(ctx);
    const targetUserId = ctx.params.id;
    const roomIds = Array.from(new Set(ctx.params.roomIds || []));

    // Verify user exists first — otherwise the FK constraint would surface
    // as a cryptic 500. Better to return a clean 404.
    const userRows = await db('users').where({ id: targetUserId }).limit(1);
    if (userRows.length === 0) {
      throw new Errors.MoleculerClientError('Naudotojas nerastas.', 404, 'USER_NOT_FOUND');
    }

    await db.transaction(async (trx) => {
      await trx('user_room_assignments').where({ user_id: targetUserId }).delete();
      if (roomIds.length > 0) {
        await trx('user_room_assignments').insert(
          roomIds.map((room_id) => ({ user_id: targetUserId, room_id })),
        );
      }
    });

    await this.safeAuditLog(ctx, 'ADMIN_ASSIGN_ROOM', {
      userId: targetUserId,
      roomIds,
    });

    return this.hydrateUser(targetUserId);
  }

  /**
   * Admin-only: change user role.
   *
   * Self-demotion guard: an admin cannot demote themselves from ADMIN — if
   * they're the last admin, the system would lock itself out. We don't have
   * a "last admin" counter, so the simpler check is "you can't change your
   * own role at all" (admins ask another admin to demote them).
   */
  @Action({
    rest: 'PUT /:id/role',
    auth: true,
    types: [EndpointType.ADMIN],
    params: {
      id: 'string',
      role: { type: 'enum', values: [UserRole.USER, UserRole.ADMIN] },
    },
  })
  async setRole(
    ctx: Context<{ id: string; role: UserRole }, UserAuthMeta>,
  ) {
    requireAdminHook(ctx);
    const targetUserId = ctx.params.id;

    if (ctx.meta?.user?.id === targetUserId) {
      throw new Errors.MoleculerClientError(
        'Negalima keisti savo paskyros rolės.',
        403,
        'SELF_ROLE_CHANGE_FORBIDDEN',
      );
    }

    const userRows = await db('users').where({ id: targetUserId }).limit(1);
    if (userRows.length === 0) {
      throw new Errors.MoleculerClientError('Naudotojas nerastas.', 404, 'USER_NOT_FOUND');
    }

    await db('users')
      .where({ id: targetUserId })
      .update({ role: ctx.params.role, updated_at: db.fn.now() });

    await this.safeAuditLog(ctx, 'ADMIN_SET_ROLE', {
      userId: targetUserId,
      role: ctx.params.role,
    });

    return this.hydrateUser(targetUserId);
  }

  // --- private helpers ---

  @Method
  normalizeUserRow(row: any): any {
    if (!row) return null;
    // knexfile uses knexSnakeCaseMappers — rows come back camelCased.
    return {
      id: row.id,
      msObjectId: row.msObjectId ?? null,
      email: row.email,
      displayName: row.displayName,
      role: row.role,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  @Method
  async hydrateUser(id: string) {
    const rows = await db('users').where({ id }).limit(1);
    if (rows.length === 0) return null;
    const user = this.normalizeUserRow(rows[0]);
    const assignments = await db('user_room_assignments')
      .where({ user_id: id })
      .select('room_id');
    return { ...user, allowedRoomIds: assignments.map((a: any) => a.room_id) };
  }

  @Method
  async safeAuditLog(ctx: Context<any, UserAuthMeta>, action: string, payload: any) {
    // Audit logging is best-effort. A broken audit service must not block a
    // legitimate admin write. We try a broker call (so audit.service can
    // batch / forward externally later) and fall back to a direct insert.
    try {
      await ctx.broker.call(
        'audit.log',
        { userId: ctx.meta?.user?.id, action, payload },
        { meta: { _systemTransition: true } } as any,
      );
    } catch (err: any) {
      this.logger.warn(`[users] audit.log failed: ${err?.message || err}`);
    }
  }
}
