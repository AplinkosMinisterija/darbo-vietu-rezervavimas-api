import type { Knex } from 'knex';

/**
 * Room managers — a user (skyriaus vedėja/vadovas, grupės vadovas, direktorius,
 * vadovybė) who manages specific room(s). A manager may edit their room's desk
 * count + name, manage who is assigned to it, and create/cancel reservations in
 * it — scoped strictly to the rooms they manage (NOT a global admin).
 *
 * `source` distinguishes how the row was created:
 *   - 'auto'   — derived from the AM contacts page by the monthly cron. The
 *                cron REPLACES only 'auto' rows; it never touches 'manual'.
 *   - 'manual' — set by an admin in the panel. Survives cron re-syncs.
 *
 * Many-to-many: a manager can run several rooms; a room can have several
 * managers. ON DELETE CASCADE on both sides (dropping a user/room drops its
 * management rows).
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('room_managers')) return;
  await knex.schema.createTable('room_managers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('room_id').notNullable().references('id').inTable('rooms').onDelete('CASCADE');
    table.text('source').notNullable().defaultTo('manual');
    // No updated_at: rows are replaced (delete+insert by the cron), not updated.
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now()).notNullable();
    // CHECK inside createTable so the hasTable guard covers it (atomic DDL).
    table.check("source in ('auto', 'manual')", {}, 'room_managers_source_check');

    table.unique(['user_id', 'room_id']);
    table.index('user_id');
    table.index('room_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('room_managers');
}
