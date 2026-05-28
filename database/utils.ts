'use strict';

import type { Knex } from 'knex';

/**
 * Shared migration helpers.
 *
 * commonFields: appends `created_at` and `updated_at` timestamptz columns
 * with sensible defaults. Use on every table.
 */
export function commonFields(knex: Knex, table: Knex.CreateTableBuilder): void {
  table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now()).notNullable();
  table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now()).notNullable();
}

/**
 * Adds a `uuid` primary key column with a `gen_random_uuid()` default.
 * Requires the `pgcrypto` extension — enable in the first migration:
 *   await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
 */
export function uuidPrimaryKey(knex: Knex, table: Knex.CreateTableBuilder): void {
  table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
}
