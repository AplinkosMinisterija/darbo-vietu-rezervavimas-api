import type { Knex } from 'knex';

/**
 * Allow ground/basement floor 0 (e.g. "rūsys"). The original
 * `rooms_floor_check` constrained floor to 1..10; widen it to 0..10 so admins
 * can register basement rooms. Service-layer validation (rooms.service.ts) is
 * widened to match.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_floor_check');
  await knex.raw('ALTER TABLE rooms ADD CONSTRAINT rooms_floor_check CHECK (floor BETWEEN 0 AND 10)');
}

export async function down(knex: Knex): Promise<void> {
  // Reverting to 1..10 only succeeds if no floor-0 rooms exist yet.
  await knex.raw('ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_floor_check');
  await knex.raw('ALTER TABLE rooms ADD CONSTRAINT rooms_floor_check CHECK (floor BETWEEN 1 AND 10)');
}
