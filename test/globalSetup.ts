'use strict';

import { execSync } from 'node:child_process';
import { TEST_PG_PORT, TEST_PG_CONTAINER, TEST_DB_NAME, TEST_DB_URL } from './testConfig';

// Vitest globalSetup — bėga VIENĄ kartą prieš visus testus, atskirame procese.
// Paleidžia throwaway docker Postgres (NE staging/prod/finansai), pritaiko VISAS
// migracijas + seed'ina kambarius (per app'so paties `db:migrate`/`db:seed`, kad
// ts-node migracijų kelias būtų identiškas produkcijai). Teardown'e — sustabdo.

function sh(cmd: string, env?: NodeJS.ProcessEnv, silent = true) {
  return execSync(cmd, { env: env ?? process.env, stdio: silent ? 'ignore' : 'inherit' });
}

export default async function setup() {
  // Nuimam galimą stale konteinerį (idempotent).
  try { sh(`docker rm -f ${TEST_PG_CONTAINER}`); } catch { /* none */ }

  sh(
    `docker run -d --name ${TEST_PG_CONTAINER} ` +
      `-e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=${TEST_DB_NAME} ` +
      `-p ${TEST_PG_PORT}:5432 postgres:17-alpine`,
  );

  // Laukiam, kol PG REALIAI priima užklausas (pg_isready gali rodyti ready
  // prieš pilną init → flaky migrate). Tikrinam tikru `SELECT 1`.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      sh(`docker exec ${TEST_PG_CONTAINER} psql -U test -d ${TEST_DB_NAME} -c "SELECT 1"`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('Test Postgres neprisikėlė per 60s');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const env = { ...process.env, DB_CONNECTION: TEST_DB_URL, NODE_ENV: 'test' };
  // Migracijos + rooms seed per app'so CLI (knexfile.ts → ts-node).
  sh('yarn db:migrate', env, false);
  sh('yarn db:seed', env, false);

  return async () => {
    try { sh(`docker rm -f ${TEST_PG_CONTAINER}`); } catch { /* none */ }
  };
}
