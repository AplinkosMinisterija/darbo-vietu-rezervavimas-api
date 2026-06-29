'use strict';

// Centralizuota integration testų konfigūracija. Tiek `globalSetup` (atskiras
// procesas, paleidžia docker Postgres + migracijas), tiek `setup.ts` (kiekvienas
// worker'is) skaito TUOS PAČIUS kintamuosius, kad connection string'as sutaptų.
//
// Portą galima override'inti per TEST_PG_PORT — taip keli lygiagretūs test
// run'ai (pvz. sub-agentai) gali turėti atskirus konteinerius, nekonfliktuojant.

export const TEST_PG_PORT = process.env.TEST_PG_PORT || '55433';
export const TEST_PG_CONTAINER = process.env.TEST_PG_CONTAINER || 'resv-test-pg';
export const TEST_DB_NAME = 'resv_test';
export const TEST_DB_URL = `postgresql://test:test@127.0.0.1:${TEST_PG_PORT}/${TEST_DB_NAME}`;
// >=32 simbolių, kad praeitų getJwtSecret() floor patikrą (HS512).
export const TEST_JWT_SECRET = 'test-jwt-secret-0123456789-abcdef-xyz';
