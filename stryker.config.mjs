export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.ts',
  },
  mutate: [
    'server/pipeline/trader/**/*.ts',
    'server/pipeline/risk-manager/**/*.ts',
    'server/pipeline/verdict/**/*.ts',
    'server/pipeline/execution/**/*.ts',
    'server/pipeline/momentum/**/*.ts',
    '!**/*.test.ts',
  ],
  tsconfigFile: '.stryker-tsconfig-unused.json',
  coverageAnalysis: 'perTest',
  ignorePatterns: ['graphify-out'],
  reporters: ['progress', 'clear-text'],
  thresholds: { high: 90, low: 70, break: 80 },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
};
