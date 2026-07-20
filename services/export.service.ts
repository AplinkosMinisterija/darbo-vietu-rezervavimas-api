'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import knex from 'knex';
import knexConfig from '../knexfile';
import { EndpointType } from '../types/constants';
import { requireAdminHook, AuthUser } from '../utils/auth';
import {
  AssignmentRow,
  RoomRow,
  UserRow,
  buildExportWorkbook,
} from '../utils/exportWorkbook';

/**
 * Shared Knex handle. The export is a read-only snapshot across three tables
 * (users, rooms, user_room_assignments) joined in memory — a single DbService
 * collection doesn't fit, so we query Knex directly.
 */
const db = knex(knexConfig);

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface UserAuthMeta {
  user?: AuthUser;
  _systemTransition?: boolean;
  // moleculer-web reads these to stream a binary response instead of JSON.
  $responseType?: string;
  $responseHeaders?: Record<string, string>;
}

/**
 * Admin-only data export. Produces a single .xlsx workbook with three sheets:
 *
 *   - "Vartotojai"  — every user + how many / which rooms they're assigned to
 *   - "Patalpos"    — every active room + how many users are assigned
 *   - "Priskyrimai" — flat user↔room assignment list (one row per pair)
 *
 * Reservations are intentionally excluded (per requirements). Read-only.
 * Pattern (Buffer return + `$responseHeaders`) mirrors the working Excel
 * export in biip-zvejyba-api.
 */
@Service({
  name: 'export',
})
export default class ExportService extends moleculer.Service {
  /**
   * GET /api/export/xlsx — returns the workbook as an attachment download.
   * ADMIN gate is enforced both at the gateway (`types`) and via the
   * `requireAdminHook` call, matching the rest of the codebase's defense
   * in depth (internal `ctx.call` bypasses the gateway authorize()).
   */
  @Action({
    rest: 'GET /xlsx',
    auth: true,
    types: [EndpointType.ADMIN],
  })
  async xlsx(ctx: Context<{}, UserAuthMeta>) {
    requireAdminHook(ctx);

    // Snapshot all three tables (rooms incl. soft-deleted — `buildExportWorkbook`
    // filters the listing but keeps deleted rooms in its lookup map).
    const [users, rooms, assignments] = await Promise.all([
      db<UserRow>('users').orderBy('displayName', 'asc'),
      db<RoomRow>('rooms').orderBy([
        { column: 'floor', order: 'asc' },
        { column: 'number', order: 'asc' },
      ]),
      db<AssignmentRow>('user_room_assignments').select('userId', 'roomId', 'createdAt'),
    ]);

    const workbook = buildExportWorkbook(users, rooms, assignments);
    const buffer = await workbook.xlsx.writeBuffer();

    ctx.meta.$responseHeaders = {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="${this.buildFilename()}"`,
    };

    return buffer;
  }

  /**
   * `darbo-vietu-eksportas-YYYY-MM-DD.xlsx`. Date in the name so a user can
   * keep several exports side by side without overwriting.
   */
  @Method
  buildFilename(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `darbo-vietu-eksportas-${yyyy}-${mm}-${dd}.xlsx`;
  }
}
