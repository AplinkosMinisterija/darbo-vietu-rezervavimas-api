import type { Knex } from 'knex';
import { commonFields, uuidPrimaryKey } from '../utils';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('rooms', (table) => {
    uuidPrimaryKey(knex, table);
    table.text('number').notNullable().unique();
    table.text('name').notNullable();
    table.integer('floor').notNullable();
    table.integer('desk_count').notNullable().defaultTo(0);
    table.boolean('is_shared').notNullable().defaultTo(false);
    table.timestamp('deleted_at', { useTz: true });
    commonFields(knex, table);

    table.index('floor');
    table.index('deleted_at');
  });

  await knex.raw('ALTER TABLE rooms ADD CONSTRAINT rooms_desk_count_check CHECK (desk_count >= 0)');
  await knex.raw('ALTER TABLE rooms ADD CONSTRAINT rooms_floor_check CHECK (floor BETWEEN 1 AND 10)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('rooms');
}
