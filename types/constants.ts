'use strict';

/**
 * Endpoint authorization gate. Used in service action definitions via
 * `types: [EndpointType.ADMIN]` and enforced by `api.service.ts:authorize`.
 *
 *   PUBLIC — no authentication required (auth flow entry points).
 *   USER   — any authenticated user (role USER or ADMIN).
 *   ADMIN  — only role=ADMIN.
 *
 * Critical: `EndpointType.ADMIN` is the BROAD gate. For destructive writes
 * that touch privileges or system integrity, ALSO add `requireAdminHook`
 * as a Moleculer `before` hook — internal `ctx.call` invocations bypass
 * the gateway-level `authorize()` but DO run before-hooks.
 */
export enum EndpointType {
  PUBLIC = 'PUBLIC',
  USER = 'USER',
  ADMIN = 'ADMIN',
}

/**
 * User role. Persisted as a Postgres enum on the `users` table.
 */
export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
}
