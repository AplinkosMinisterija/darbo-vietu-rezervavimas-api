import type { Knex } from 'knex';
import { commonFields, uuidPrimaryKey } from '../utils';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (table) => {
    uuidPrimaryKey(knex, table);
    table.text('ms_object_id').unique();
    table.specificType('email', 'citext').notNullable().unique();
    table.text('display_name').notNullable();
    table.text('role').notNullable().defaultTo('USER');
    commonFields(knex, table);
  });

  await knex.raw(
    "ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('USER', 'ADMIN'))",
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('users');
}
