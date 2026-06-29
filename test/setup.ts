'use strict';

import { TEST_DB_URL, TEST_JWT_SECRET } from './testConfig';

// setupFiles — bėga KIEKVIENAME worker'yje PRIEŠ test failų importą. Svarbu:
// servisai kuria `knex(knexConfig)` modulio krovimo metu, o knexfile.ts meta
// throw be DB_CONNECTION — todėl env turi būti nustatytas čia, prieš bet kokį
// servisų importą.
process.env.DB_CONNECTION = TEST_DB_URL;
process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
