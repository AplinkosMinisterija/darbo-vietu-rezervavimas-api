'use strict';

import { defineConfig } from 'vitest/config';

// Integration + unit testai prie throwaway docker Postgres (žr. test/globalSetup.ts).
// fileParallelism=false + singleFork — serializuoja DB prieigą (vienas konteineris,
// truncate tarp testų), kad lygiagretūs failai nesitrypdintų vienas kitam.

export default defineConfig({
  test: {
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
