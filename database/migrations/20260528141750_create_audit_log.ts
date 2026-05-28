import type { Knex } from 'knex';
import { uuidPrimaryKey } from '../utils';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('audit_log', (table) => {
    uuidPrimaryKey(knex, table);
    table.uuid('user_id').references('id').inTable('users').onDelete('SET NULL');
    table.text('action').notNullable();
    table.jsonb('payload').notNullable().defaultTo('{}');
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now()).notNullable();

    table.index('action');
    table.index('user_id');
    table.index('created_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_log');
}
