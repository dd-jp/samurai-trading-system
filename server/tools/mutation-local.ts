import { execFileSync, type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_REF = 'origin/main';

export const TRADING_PATH_PREFIXES = [
  'server/pipeline/trader/',
  'server/pipeline/risk-manager/',
  'server/pipeline/verdict/',
  'server/pipeline/execution/',
  'server/apps/v2/risk/',
  'server/pipeline/momentum/loss-budget.ts',
  'server/pipeline/momentum/sizing.ts',
] as const;

export function testFilesGlob(prefix: string): string {
  return prefix.endsWith('/') ? `${prefix}**/*.test.ts` : prefix.replace(/\.ts$/, '.test.ts');
}

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

function printHelp(log: (line: string) => void): void {
  log(`Usage: npm run mutation:local -- [--list] [baseRef]

Runs Stryker Mutator against trading-path files changed since baseRef (default:
${DEFAULT_BASE_REF}) and HEAD diverged, mirroring test:local's diff-scoped pattern.
baseRef's own commits after that point are excluded; uncommitted working-tree
changes are included. Trading-path packages:
${TRADING_PATH_PREFIXES.map((prefix) => `  ${prefix}`).join('\n')}

Non-trading-path changes (dashboard, tooling, other server packages) are listed
but not mutated — no score bar applies to them. --list prints the trading-path
files that would be mutated and runs nothing; CI uses it to skip the mutation job.

Coverage is scoped to these packages' own tests only, so a line whose only
covering test lives elsewhere (e.g. an orchestrator wiring test) reads as
uncovered. Check for that before treating a red gate as a real regression.

CI runs it on the PR's merge ref whenever --list is non-empty.`);
}

function logAdvisory(advisory: readonly string[], log: (line: string) => void): void {
  if (advisory.length === 0) return;
  log(`Advisory — changed but not mutated (no score bar), ${advisory.length} file(s):`);
  for (const file of advisory) log(`  ${file}`);
}

function logTradingPath(
  tradingPath: readonly string[],
  baseRef: string,
  log: (line: string) => void,
): void {
  log(`Mutating ${tradingPath.length} trading-path file(s) changed vs ${baseRef}:`);
  for (const file of tradingPath) log(`  ${file}`);
}

function runStryker(root: string, tradingPath: readonly string[]): SpawnSyncReturns<Buffer> {
  const testFileGlobs = TRADING_PATH_PREFIXES.map(testFilesGlob);
  const strykerBin = fileURLToPath(new URL('../../node_modules/.bin/stryker', import.meta.url));
  return spawnSync(
    strykerBin,
    ['run', '--mutate', tradingPath.join(','), '--testFiles', testFileGlobs.join(',')],
    { cwd: root, stdio: 'inherit' },
  );
}

export interface MutationGateDeps {
  readonly changedFiles: (baseRef: string) => readonly string[];
  readonly stryker: (
    tradingPath: readonly string[],
  ) => Pick<SpawnSyncReturns<Buffer>, 'error' | 'status'>;
  readonly log: (line: string) => void;
}

type GateMode = 'help' | 'list' | 'run';

export function parseGateArgs(args: readonly string[]): { mode: GateMode; baseRef: string } {
  const [arg, listBaseRef] = args;
  if (arg === '--help' || arg === '-h') return { mode: 'help', baseRef: DEFAULT_BASE_REF };
  if (arg === '--list') return { mode: 'list', baseRef: listBaseRef ?? DEFAULT_BASE_REF };
  return { mode: 'run', baseRef: arg ?? DEFAULT_BASE_REF };
}

function strykerExitCode(result: Pick<SpawnSyncReturns<Buffer>, 'error' | 'status'>): number {
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function mutateChanged(
  tradingPath: readonly string[],
  advisory: readonly string[],
  baseRef: string,
  deps: MutationGateDeps,
): number {
  logAdvisory(advisory, deps.log);
  if (tradingPath.length === 0) {
    deps.log(`No trading-path files changed vs ${baseRef} — mutation gate skipped.`);
    return 0;
  }
  logTradingPath(tradingPath, baseRef, deps.log);
  return strykerExitCode(deps.stryker(tradingPath));
}

export function runMutationGate(args: readonly string[], deps: MutationGateDeps): number {
  const { mode, baseRef } = parseGateArgs(args);
  if (mode === 'help') {
    printHelp(deps.log);
    return 0;
  }
  const { tradingPath, advisory } = partitionChangedFiles(deps.changedFiles(baseRef));
  if (mode === 'list') {
    for (const file of tradingPath) deps.log(file);
    return 0;
  }
  return mutateChanged(tradingPath, advisory, baseRef, deps);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  process.exitCode = runMutationGate(process.argv.slice(2), {
    changedFiles: (baseRef) => getChangedFiles(baseRef, root),
    stryker: (tradingPath) => runStryker(root, tradingPath),
    log: (line) => console.log(line),
  });
}
