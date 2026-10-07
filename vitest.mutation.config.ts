import { defineConfig } from 'vitest/config';
import { TRADING_PATH_PREFIXES, testFilesGlob } from './server/tools/mutation-local.js';
import base from './vitest.config.js';

// Stryker's --testFiles makes it activate static mutants at runtime, after module load, so they
// never take effect; scoping here instead lets them run (doc 66, 2026-10-07, #2023)
export default defineConfig({
  ...base,
  test: { ...base.test, include: TRADING_PATH_PREFIXES.map(testFilesGlob) },
});
