'use strict';

import type { Knex } from 'knex';

/**
 * Room-manager access helpers. A manager has elevated, room-scoped rights
 * (edit desk count + name, manage assignments, create/cancel reservations) on
 * the rooms listed in `room_managers`. These are the authoritative server-side
 * checks — never trust the FE to scope a manager's actions.
 *
 * knexfile uses knexSnakeCaseMappers, so we pass/read camelCase identifiers.
 */
export async function isRoomManager(db: Knex, userId: string, roomId: string): Promise<boolean> {
  // Join rooms + require not soft-deleted: managing a deleted room is meaningless.
  const row = await db('room_managers as rm')
    .join('rooms as r', 'r.id', 'rm.roomId')
    .where({ 'rm.userId': userId, 'rm.roomId': roomId })
    .whereNull('r.deletedAt')
    .first();
  return Boolean(row);
}

export async function getManagedRoomIds(db: Knex, userId: string): Promise<string[]> {
  const rows = await db('room_managers as rm')
    .join('rooms as r', 'r.id', 'rm.roomId')
    .where({ 'rm.userId': userId })
    .whereNull('r.deletedAt')
    .select('rm.roomId as roomId');
  return rows.map((r: any) => r.roomId);
}
