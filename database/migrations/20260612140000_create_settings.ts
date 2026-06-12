import type { Knex } from 'knex';

/**
 * Generic key/value settings store for runtime-toggleable app config that must
 * survive container restarts (env vars can't — they need a redeploy). First
 * use: the `sharepoint_auto_reserve_enabled` flag that gates the weekly
 * SharePoint auto-reservation cron. Read paths default to a sensible value
 * when a key is absent, so no seed row is required.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('settings')) return;
  await knex.schema.createTable('settings', (table) => {
    table.text('key').primary();
    table.jsonb('value').notNullable();
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now()).notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('settings');
}
