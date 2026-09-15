/**
 * Diff-scoped Stryker mutation gate (#1634, decided by #1626).
 *
 * Mirrors `test:local`'s `vitest run --changed origin/main` pattern: mutate only
 * files changed vs a base ref, not the whole repo — a full-repo Stryker run against
 * ~2900 tests is not viable per-PR. Automates the manual "delete the effect, confirm
 * the gate goes red" discipline `docs/coding-standards.md` describes, for the
 * trading-path packages only (#1626's resolution: pipeline/trader, risk-manager,
 * verdict, execution — the stages that size, gate and submit orders). Every other
 * changed file (dashboard, tooling, and non-trading-path server code such as
 * analysts/debate-engine/feedback-loop) is reported but not mutated: no bar to
 * enforce there, so no Stryker run to pay for.
 *
 * Not wired into GitHub Actions: billing-blocked on this repo
 * (`actions-billing-blocks-all-ci` memory). Once billing is unblocked, run this same
 * command against the merged-tree ref as a CI step — that is the deferred next step,
 * not part of this ticket.
 *
 * Known scope gap: the dry run's `--testFiles` (see `main`) covers only the four
 * trading-path packages' own test files, not the whole suite — a worker_threads
 * incompatibility blocks widening it (see the comment at the call site). A
 * trading-path line whose only covering test lives elsewhere (e.g. an orchestrator
 * wiring test) reads as uncovered and drags the score down for reasons unrelated to
 * the change under review.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_REF = 'origin/main';

export const TRADING_PATH_PREFIXES = [
  'server/pipeline/trader/',
  'server/pipeline/risk-manager/',
  'server/pipeline/verdict/',
  'server/pipeline/execution/',
] as const;

const MUTABLE_ROOTS = ['server/', 'contracts/'] as const;
const PRODUCTION_FILE_RE = /\.tsx?$/;
const TEST_FILE_RE = /\.test\.tsx?$/;

/** A `.ts`/`.tsx` production file Stryker can mutate — excludes tests and `server/tools/` (this script's own package, tooling, lower-stakes per #1634). */
export function isMutableProductionFile(path: string): boolean {
  return (
    PRODUCTION_FILE_RE.test(path) &&
    !TEST_FILE_RE.test(path) &&
    !path.startsWith('server/tools/') &&
    MUTABLE_ROOTS.some((root) => path.startsWith(root))
  );
}

export function isTradingPathFile(path: string): boolean {
  return TRADING_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function parseChangedFiles(diffOutput: string): readonly string[] {
  return diffOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface PartitionedChanges {
  readonly tradingPath: readonly string[];
  readonly advisory: readonly string[];
}

/** Splits changed, mutable production files into the score-barred set and everything else. */
export function partitionChangedFiles(files: readonly string[]): PartitionedChanges {
  const mutable = files.filter(isMutableProductionFile);
  return {
    tradingPath: mutable.filter(isTradingPathFile),
    advisory: mutable.filter((file) => !isTradingPathFile(file)),
  };
}

/**
 * Files changed vs `baseRef`, repo-relative, filtered to ones still present on disk.
 * `--diff-filter=ACMR` already excludes deletes; the `existsSync` check additionally
 * covers a rename-then-delete or a path a test double doesn't create.
 */
export function getChangedFiles(baseRef: string, root: string): readonly string[] {
  const diffOutput = execFileSync(
    'git',
    ['-C', root, 'diff', '--name-only', '--diff-filter=ACMR', baseRef],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return parseChangedFiles(diffOutput).filter((file) => existsSync(`${root}/${file}`));
}

function printHelp(): void {
  console.log(`Usage: npm run mutation:local -- [baseRef]

Runs Stryker Mutator against trading-path files changed vs baseRef (default:
${DEFAULT_BASE_REF}), mirroring test:local's diff-scoped pattern. Trading-path
packages:
${TRADING_PATH_PREFIXES.map((prefix) => `  ${prefix}`).join('\n')}

Non-trading-path changes (dashboard, tooling, other server packages) are listed
but not mutated — no score bar applies to them.

Coverage is scoped to these packages' own tests only, so a line whose only
covering test lives elsewhere (e.g. an orchestrator wiring test) reads as
uncovered. Check for that before treating a red gate as a real regression.

Implementer gate only, not CI: GitHub Actions is billing-blocked on this repo.
Run against the merge ref once billing is unblocked (deferred, not part of #1634).`);
}

function main(): void {
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    printHelp();
    return;
  }

  const baseRef = arg ?? DEFAULT_BASE_REF;
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const changed = getChangedFiles(baseRef, root);
  const { tradingPath, advisory } = partitionChangedFiles(changed);

  if (advisory.length > 0) {
    console.log(`Advisory — changed but not mutated (no score bar), ${advisory.length} file(s):`);
    for (const file of advisory) console.log(`  ${file}`);
  }

  if (tradingPath.length === 0) {
    console.log(`No trading-path files changed vs ${baseRef} — mutation gate skipped.`);
    return;
  }

  console.log(`Mutating ${tradingPath.length} trading-path file(s) changed vs ${baseRef}:`);
  for (const file of tradingPath) console.log(`  ${file}`);

  // Scoped to the same trading-path packages as `--mutate`, not the whole suite: the
  // vitest-runner's dry run hard-codes vitest's `threads` pool (no config escape
  // hatch — confirmed 2026-09-15 in vitest-test-runner.js), and four tests
  // (`orchestrator/startup.test.ts`, `orchestrator/log-retention.test.ts`,
  // `shared/store/open-shared-store.test.ts`, `tools/saxo-login.test.ts`) call
  // `process.chdir()`, which throws under worker_threads. Widening to `server/**` with
  // just those four ignored was tried 2026-09-15: the chdir crash goes away but a
  // fifth, unrelated test (an Alpaca re-arm invariant check) then times out at
  // Stryker's 5s default under the runner — a second, separate incompatibility, not
  // fixed here. Known cost of staying narrow: a trading-path line whose only covering
  // test lives outside these four packages (e.g. an orchestrator wiring test) reads as
  // NoCoverage and counts against the score below. A red gate on a line that has real
  // orchestrator-level coverage may be this gap, not a real regression — check before
  // adding a test.
  const testFileGlobs = TRADING_PATH_PREFIXES.map((prefix) => `${prefix}**/*.test.ts`);
  const strykerBin = fileURLToPath(new URL('../../node_modules/.bin/stryker', import.meta.url));
  const result = spawnSync(
    strykerBin,
    ['run', '--mutate', tradingPath.join(','), '--testFiles', testFileGlobs.join(',')],
    { cwd: root, stdio: 'inherit' },
  );

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
