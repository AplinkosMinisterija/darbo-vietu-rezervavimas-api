import type { Knex } from 'knex';

/**
 * Soft-delete support for users. An admin "deleting" a user sets `deleted_at`
 * instead of removing the row, so reservation history + audit entries that
 * reference the user (reservations.user_id is ON DELETE RESTRICT) stay intact.
 *
 * The same person logging back in via Microsoft SSO is reactivated
 * (`deleted_at` cleared) in users.findOrCreate — the unique email / ms_object_id
 * constraints are left global on purpose so the reconcile path finds the row.
 */
export async function up(knex: Knex): Promise<void> {
  // Idempotency guard: tolerate a partial-apply (e.g. process killed between
  // COMMIT and the migrations-table write) so a boot-time re-run doesn't loop.
  if (await knex.schema.hasColumn('users', 'deleted_at')) return;
  await knex.schema.alterTable('users', (table) => {
    table.timestamp('deleted_at', { useTz: true });
    table.index('deleted_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  // Drop the index by its generated name (not the column) so the rollback is
  // robust even if the column was already removed by a partial down().
  await knex.raw('DROP INDEX IF EXISTS users_deleted_at_index');
  if (await knex.schema.hasColumn('users', 'deleted_at')) {
    await knex.schema.alterTable('users', (table) => {
      table.dropColumn('deleted_at');
    });
  }
}
