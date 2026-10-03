export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.ts',
  },
  mutate: [
    'server/pipeline/momentum/**/*.ts',
    'server/apps/v2/**/*.ts',
    '!server/apps/v2/smoke.ts',
    '!**/*.test.ts',
  ],
  tsconfigFile: '.stryker-tsconfig-unused.json',
  coverageAnalysis: 'perTest',
  ignorePatterns: ['graphify-out'],
  reporters: ['progress', 'clear-text'],
  // mutation-local.ts sets STRYKER_NO_BREAK and applies `break` itself, to the changed lines only:
  // an incremental run's own score also counts the earlier run's out-of-scope mutants
  thresholds: { high: 90, low: 70, break: process.env.STRYKER_NO_BREAK ? null : 80 },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
};
