'use strict';

// `@moleculer/database` is the Ambrazas fork (commonjs). The package's TS
// typings declare a default export but the runtime shape is the `Service`
// factory directly — `require(...).Service` works in both the published
// build and the GitHub fork that's pinned in package.json.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DbService = require('@moleculer/database').Service;
import knexConfig from '../knexfile';

export interface DatabaseMixinOptions {
  /** Postgres table name. Used both as the `tableName` and the Moleculer entityName. */
  collection: string;
  /** Override entityName if it should differ from the table name. */
  entityName?: string;
  /**
   * If `true` (default), DbService publishes its built-in actions (find/list/
   * get/resolve/create/update/replace/remove). We keep them enabled so
   * services can `ctx.call('users.resolve', { id })` internally, but each
   * service must lock them down with `auth: true, types: [EndpointType.ADMIN]`
   * + a `requireAdminHook` `before` hook so they're never published as
   * unauthenticated REST aliases.
   *
   * Pass `false` to fully suppress all built-in actions (useful for pure
   * write-only services that should only expose custom `@Action` handlers).
   */
  createActions?: boolean;
}

/**
 * Shared DbService wrapper. Mirrors the biip-alis-api `mixins/database.mixin.ts`
 * pattern but trimmed of the ALIS-specific `moleculer-knex-filters` mixin
 * (we don't need its query string -> Knex filter translation yet) and with
 * `createActions: false` as the safe default.
 *
 * Usage:
 *   @Service({ mixins: [DatabaseMixin({ collection: 'users' })], ... })
 *
 * Returned object is shaped for Moleculer's `mixins` array — drop-in.
 */
export function DatabaseMixin(opts: DatabaseMixinOptions): any {
  const createActions = opts.createActions !== false;

  // Strip the auto-published REST aliases on all built-in DbService actions —
  // we want them callable internally (`ctx.call('users.resolve', ...)`) but
  // never directly via HTTP without an explicit `@Action({ rest: ... })` on
  // the service. This is the same defensive posture as biip-alis-api's
  // database.mixin (it nulls the `replace` REST alias for the same reason).
  const removeRestActions: any = createActions
    ? {
        find: { rest: null as any },
        list: { rest: null as any },
        get: { rest: null as any },
        resolve: { rest: null as any },
        count: { rest: null as any },
        create: { rest: null as any },
        update: { rest: null as any },
        replace: { rest: null as any },
        remove: { rest: null as any },
      }
    : {};

  return {
    mixins: [
      DbService({
        adapter: {
          type: 'Knex',
          options: {
            knex: knexConfig,
            tableName: opts.collection,
          },
        },
        // @ts-ignore — DbService's TS definitions are looser than the
        // runtime shape; entityName is honoured at runtime.
        entityName: opts.entityName ?? opts.collection,
        createActions,
      }),
    ],
    actions: {
      ...removeRestActions,
    },
  };
}

export default DatabaseMixin;
