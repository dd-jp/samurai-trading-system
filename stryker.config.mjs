// Stryker Mutator config for the trading-path mutation gate (#1634, decided by #1626).
//
// Not run bare — `npm run mutation:local` (server/tools/mutation-local.ts) invokes this
// with `--mutate` restricted to trading-path files changed vs a base ref, mirroring
// `test:local`'s `vitest run --changed origin/main` diff-scoped pattern. A full-repo
// run against ~2900 tests is not viable per-PR (#1626's resolution). The `mutate`
// glob below is only the fallback for someone running `stryker run` directly.
//
// `thresholds.break` is the trading-path score bar: this config exists to score
// pipeline/risk-manager/verdict/execution (the money-moving stages — sizing, gating,
// order submission), so the bar applies whenever this config runs. Non-trading-path
// changes are never passed to `--mutate` by the wrapper script, so they never hit
// this threshold — see the wrapper for the "unchecked" packages (dashboard, tooling,
// and other server modules like analysts/debate-engine/feedback-loop).
//
// No CI wiring: GitHub Actions is billing-blocked on this repo
// (`actions-billing-blocks-all-ci` memory). Deferred next step once billing unblocks:
// run `npm run mutation:local -- <merge-base-sha>` against the merged tree.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
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
    '!**/*.test.ts',
  ],
  // Points at a file that doesn't exist so Stryker's tsconfig-rewrite preprocessor
  // (sandbox/ts-config-preprocessor.js, unconditional unless `inPlace`) no-ops instead
  // of touching the real tsconfig.json. Needed because that preprocessor calls
  // `ts.parseConfigFileTextToJson`, which `typescript@7.0.2` no longer exports —
  // confirmed 2026-09-15 against this repo's installed version. Harmless here: no
  // `checkers` plugin is configured (see `coverageAnalysis` below), and the only other
  // consumer of `tsconfigFile` is that same preprocessor.
  tsconfigFile: '.stryker-tsconfig-unused.json',
  // 'perTest' scopes each mutant's rerun to the tests that actually cover its line
  // instead of the full suite — required for per-PR runtime given ~2900 tests total.
  coverageAnalysis: 'perTest',
  ignoreStatic: true,
  // `graphify-out` is a symlink to the main checkout's knowledge-graph output; Node's
  // `copyFile` can't clone whatever it resolves to inside a git worktree ("operation
  // not supported on socket", confirmed 2026-09-15) and it isn't test input anyway.
  ignorePatterns: ['graphify-out'],
  reporters: ['progress', 'clear-text'],
  // 80% mirrors common practice for money-moving code (Stryker/PIT guidance); #1626's
  // resolution named "trading-path packages only" but left the exact number to the
  // implementer. Revisit with real trading-path mutation history once it exists.
  thresholds: { high: 90, low: 70, break: 80 },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
};
