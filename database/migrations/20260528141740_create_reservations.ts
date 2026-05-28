import type { Knex } from 'knex';
import { commonFields, uuidPrimaryKey } from '../utils';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('reservations', (table) => {
    uuidPrimaryKey(knex, table);
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    table.uuid('room_id').notNullable().references('id').inTable('rooms').onDelete('RESTRICT');
    table.integer('desk_number').notNullable();
    table.date('date').notNullable();
    commonFields(knex, table);

    table.unique(['room_id', 'desk_number', 'date'], {
      indexName: 'reservations_room_desk_date_unique',
    });
    table.unique(['user_id', 'date'], {
      indexName: 'reservations_user_date_unique',
    });
    table.index('date');
    table.index('user_id');
  });

  await knex.raw(
    'ALTER TABLE reservations ADD CONSTRAINT reservations_desk_number_check CHECK (desk_number >= 1)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('reservations');
}
