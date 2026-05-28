import type { Knex } from 'knex';
import { uuidPrimaryKey } from '../utils';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_room_assignments', (table) => {
    uuidPrimaryKey(knex, table);
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('room_id').notNullable().references('id').inTable('rooms').onDelete('RESTRICT');
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now()).notNullable();

    table.unique(['user_id', 'room_id']);
    table.index('user_id');
    table.index('room_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_room_assignments');
}
