import { execFileSync, type SpawnSyncReturns, spawnSync } from 'node:child_process';
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

export function partitionChangedFiles(files: readonly string[]): PartitionedChanges {
  const mutable = files.filter(isMutableProductionFile);
  return {
    tradingPath: mutable.filter(isTradingPathFile),
    advisory: mutable.filter((file) => !isTradingPathFile(file)),
  };
}

export function resolveMergeBase(baseRef: string, root: string): string {
  return execFileSync('git', ['-C', root, 'merge-base', baseRef, 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

export function getChangedFiles(baseRef: string, root: string): readonly string[] {
  const mergeBase = resolveMergeBase(baseRef, root);
  const diffOutput = execFileSync(
    'git',
    ['-C', root, 'diff', '--name-only', '--diff-filter=ACMR', mergeBase],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return parseChangedFiles(diffOutput).filter((file) => existsSync(`${root}/${file}`));
}

function printHelp(): void {
  console.log(`Usage: npm run mutation:local -- [baseRef]

Runs Stryker Mutator against trading-path files changed since baseRef (default:
${DEFAULT_BASE_REF}) and HEAD diverged, mirroring test:local's diff-scoped pattern.
baseRef's own commits after that point are excluded; uncommitted working-tree
changes are included. Trading-path packages:
${TRADING_PATH_PREFIXES.map((prefix) => `  ${prefix}`).join('\n')}

Non-trading-path changes (dashboard, tooling, other server packages) are listed
but not mutated — no score bar applies to them.

Coverage is scoped to these packages' own tests only, so a line whose only
covering test lives elsewhere (e.g. an orchestrator wiring test) reads as
uncovered. Check for that before treating a red gate as a real regression.

Implementer gate only, not CI: GitHub Actions is billing-blocked on this repo.
Run against the merge ref once billing is unblocked (deferred, not part of #1634).`);
}

function logAdvisory(advisory: readonly string[]): void {
  if (advisory.length === 0) return;
  console.log(`Advisory — changed but not mutated (no score bar), ${advisory.length} file(s):`);
  for (const file of advisory) console.log(`  ${file}`);
}

function logTradingPath(tradingPath: readonly string[], baseRef: string): void {
  console.log(`Mutating ${tradingPath.length} trading-path file(s) changed vs ${baseRef}:`);
  for (const file of tradingPath) console.log(`  ${file}`);
}

function runStryker(root: string, tradingPath: readonly string[]): SpawnSyncReturns<Buffer> {
  const testFileGlobs = TRADING_PATH_PREFIXES.map((prefix) => `${prefix}**/*.test.ts`);
  const strykerBin = fileURLToPath(new URL('../../node_modules/.bin/stryker', import.meta.url));
  return spawnSync(
    strykerBin,
    ['run', '--mutate', tradingPath.join(','), '--testFiles', testFileGlobs.join(',')],
    { cwd: root, stdio: 'inherit' },
  );
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

  logAdvisory(advisory);

  if (tradingPath.length === 0) {
    console.log(`No trading-path files changed vs ${baseRef} — mutation gate skipped.`);
    return;
  }

  logTradingPath(tradingPath, baseRef);

  const result = runStryker(root, tradingPath);

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
