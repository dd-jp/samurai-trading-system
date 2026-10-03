import { execFileSync, type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const DEFAULT_BASE_REF = 'origin/main';
export const REPORT_DIR = 'reports/mutation';
export const INCREMENTAL_FILE = `${REPORT_DIR}/incremental.json`;

export const TRADING_PATH_PREFIXES = [
  'server/apps/v2/risk/',
  'server/apps/v2/execution/alpaca/',
  'server/apps/v2/execution/broker-state/',
  'server/apps/v2/execution/saxo/',
  'server/apps/v2/cycle.ts',
  'server/apps/v2/split.ts',
  'server/apps/v2/reconcile.ts',
  'server/apps/v2/reconcile-compare.ts',
  'server/apps/v2/cash-anchor.ts',
  'server/shared/market/sizing.ts',
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

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface MutateTarget {
  readonly file: string;
  readonly range: LineRange;
}

const NEW_FILE_HEADER_RE = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function hunkRange(line: string): LineRange | undefined {
  const match = HUNK_HEADER_RE.exec(line);
  if (!match) return undefined;
  const start = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  return count === 0 ? undefined : { start, end: start + count - 1 };
}

function mergeRanges(ranges: readonly LineRange[]): readonly LineRange[] {
  const merged: LineRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function startFile(byFile: Map<string, LineRange[]>, file: string | undefined): LineRange[] {
  const ranges: LineRange[] = [];
  if (file !== undefined) byFile.set(file, ranges);
  return ranges;
}

export function parseAddedLineRanges(
  zeroContextDiff: string,
): ReadonlyMap<string, readonly LineRange[]> {
  const byFile = new Map<string, LineRange[]>();
  let current: LineRange[] = [];
  for (const line of zeroContextDiff.split('\n')) {
    const header = NEW_FILE_HEADER_RE.exec(line);
    const range = header ? undefined : hunkRange(line);
    if (header) current = startFile(byFile, header[1]);
    else if (range) current.push(range);
  }
  return new Map([...byFile].map(([file, ranges]) => [file, mergeRanges(ranges)]));
}

export function mutateTargets(
  files: readonly string[],
  ranges: ReadonlyMap<string, readonly LineRange[]>,
): readonly MutateTarget[] {
  return files.flatMap((file) => (ranges.get(file) ?? []).map((range) => ({ file, range })));
}

export function erasedLines(source: string): readonly string[] | undefined {
  try {
    return stripTypeScriptTypes(source).split('\n');
  } catch {
    return undefined;
  }
}

export function hasRuntimeCode(erased: readonly string[] | undefined, range: LineRange): boolean {
  return (
    erased === undefined ||
    erased.slice(range.start - 1, range.end).some((line) => line.trim().length > 0)
  );
}

export interface RuntimeTargets {
  readonly targets: readonly MutateTarget[];
  readonly typeOnly: readonly string[];
}

export function dropTypeOnlyTargets(
  targets: readonly MutateTarget[],
  readSource: (file: string) => string,
): RuntimeTargets {
  const files = [...new Set(targets.map(({ file }) => file))];
  const erased = new Map(files.map((file) => [file, erasedLines(readSource(file))]));
  const kept = targets.filter(({ file, range }) => hasRuntimeCode(erased.get(file), range));
  const keptFiles = new Set(kept.map(({ file }) => file));
  return { targets: kept, typeOnly: files.filter((file) => !keptFiles.has(file)) };
}

export function mutatePattern({ file, range }: MutateTarget): string {
  return `${file}:${range.start}-${range.end}`;
}

function rangeWeight({ range }: MutateTarget): number {
  return range.end - range.start + 1;
}

export function assignShards(
  targets: readonly MutateTarget[],
  count: number,
): readonly MutateTarget[][] {
  const shards: MutateTarget[][] = Array.from({ length: count }, () => []);
  const load: number[] = Array.from({ length: count }, () => 0);
  const heaviestFirst = [...targets].sort(
    (a, b) => rangeWeight(b) - rangeWeight(a) || mutatePattern(a).localeCompare(mutatePattern(b)),
  );
  for (const target of heaviestFirst) {
    const lightest = load.indexOf(Math.min(...load));
    shards[lightest]?.push(target);
    load[lightest] = (load[lightest] ?? 0) + rangeWeight(target);
  }
  return shards;
}

export function resolveMergeBase(baseRef: string, root: string): string {
  return execFileSync('git', ['-C', root, 'merge-base', baseRef, 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

function gitDiff(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, 'diff', '--no-color', '--no-ext-diff', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function getChangedFiles(baseRef: string, root: string): readonly string[] {
  const mergeBase = resolveMergeBase(baseRef, root);
  const diffOutput = gitDiff(root, ['--name-only', '--diff-filter=ACMR', mergeBase]);
  return parseChangedFiles(diffOutput).filter((file) => existsSync(`${root}/${file}`));
}

export function getAddedLineRanges(
  baseRef: string,
  root: string,
): ReadonlyMap<string, readonly LineRange[]> {
  const mergeBase = resolveMergeBase(baseRef, root);
  return parseAddedLineRanges(
    gitDiff(root, ['-U0', '--src-prefix=a/', '--dst-prefix=b/', '--diff-filter=ACMR', mergeBase]),
  );
}

type MutantStatus =
  | 'Killed'
  | 'Survived'
  | 'NoCoverage'
  | 'Timeout'
  | 'CompileError'
  | 'RuntimeError'
  | 'Ignored'
  | 'Pending';

interface ReportMutant {
  readonly status: MutantStatus;
  readonly killedBy?: readonly string[];
  readonly coveredBy?: readonly string[];
  readonly location: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  };
  readonly [key: string]: unknown;
}

interface ReportFile {
  readonly mutants: readonly ReportMutant[];
  readonly [key: string]: unknown;
}

interface ReportTest {
  readonly id: string;
  readonly name: string;
  readonly location?: { readonly start: { readonly line: number } };
  readonly [key: string]: unknown;
}

interface ReportTestFile {
  readonly tests: readonly ReportTest[];
  readonly [key: string]: unknown;
}

export interface MutationReport {
  readonly files: Readonly<Record<string, ReportFile>>;
  readonly testFiles?: Readonly<Record<string, ReportTestFile>>;
  readonly [key: string]: unknown;
}

function withinTarget(mutant: ReportMutant, target: MutateTarget): boolean {
  return (
    mutant.location.start.line >= target.range.start && mutant.location.end.line <= target.range.end
  );
}

function mutantsInScope(
  report: MutationReport,
  targets: readonly MutateTarget[],
): ReadonlyMap<string, readonly ReportMutant[]> {
  const byFile = new Map<string, ReportMutant[]>();
  for (const target of targets) {
    const mutants = report.files[target.file]?.mutants;
    if (mutants === undefined) continue;
    const kept = byFile.get(target.file) ?? [];
    kept.push(...mutants.filter((mutant) => withinTarget(mutant, target)));
    byFile.set(target.file, kept);
  }
  return byFile;
}

// Stryker numbers test ids per run, so each shard's killedBy/coveredBy are rewritten to a key
// that means the same test in every shard before the reports are merged and reused
function stableTestIds(report: MutationReport): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  for (const [file, testFile] of Object.entries(report.testFiles ?? {})) {
    for (const test of testFile.tests) {
      ids.set(test.id, `${file}#${test.name}#${test.location?.start.line ?? ''}`);
    }
  }
  return ids;
}

function restampIds(ids: readonly string[], stable: ReadonlyMap<string, string>): string[] {
  return ids.map((id) => stable.get(id) ?? id);
}

function restampMutant(mutant: ReportMutant, stable: ReadonlyMap<string, string>): ReportMutant {
  const { killedBy, coveredBy } = mutant;
  return {
    ...mutant,
    ...(killedBy && { killedBy: restampIds(killedBy, stable) }),
    ...(coveredBy && { coveredBy: restampIds(coveredBy, stable) }),
  };
}

function restampTestFiles(
  report: MutationReport,
  stable: ReadonlyMap<string, string>,
): Record<string, ReportTestFile> {
  return Object.fromEntries(
    Object.entries(report.testFiles ?? {}).map(([file, testFile]) => [
      file,
      {
        ...testFile,
        tests: testFile.tests.map((test) => ({ ...test, id: stable.get(test.id) ?? test.id })),
      },
    ]),
  );
}

export function scopeShardReports(
  shards: readonly { readonly report: MutationReport; readonly targets: readonly MutateTarget[] }[],
): MutationReport {
  const files: Record<string, ReportFile> = {};
  let testFiles: Record<string, ReportTestFile> = {};
  for (const { report, targets } of shards) {
    const stable = stableTestIds(report);
    for (const [file, mutants] of mutantsInScope(report, targets)) {
      const source = files[file] ?? { ...report.files[file], mutants: [] };
      const restamped = mutants.map((mutant) => restampMutant(mutant, stable));
      files[file] = { ...source, mutants: [...source.mutants, ...restamped] };
    }
    testFiles = { ...testFiles, ...restampTestFiles(report, stable) };
  }
  return { ...shards[0]?.report, files, testFiles };
}

export interface MutationScore {
  readonly detected: number;
  readonly undetected: number;
  readonly score: number | undefined;
}

const DETECTED: ReadonlySet<MutantStatus> = new Set(['Killed', 'Timeout']);
const UNDETECTED: ReadonlySet<MutantStatus> = new Set(['Survived', 'NoCoverage']);

export function scoreReport(report: MutationReport): MutationScore {
  const mutants = Object.values(report.files).flatMap((file) => file.mutants);
  const detected = mutants.filter((mutant) => DETECTED.has(mutant.status)).length;
  const undetected = mutants.filter((mutant) => UNDETECTED.has(mutant.status)).length;
  const valid = detected + undetected;
  return { detected, undetected, score: valid === 0 ? undefined : (detected / valid) * 100 };
}

export function shardReportFile(index: number): string {
  return `${REPORT_DIR}/shard-${index}.json`;
}

function printHelp(log: (line: string) => void): void {
  log(`Usage: npm run mutation:local -- [--list] [--shard i/n] [--merge n] [baseRef]

Runs Stryker Mutator against the lines of trading-path files added or changed
since baseRef (default: ${DEFAULT_BASE_REF}) and HEAD diverged (doc 66,
2026-10-01): each git diff hunk becomes a Stryker line range, so untouched lines in
a touched file are not mutated. baseRef's own commits after that point are
excluded; uncommitted edits to tracked files are included. Trading-path packages:
${TRADING_PATH_PREFIXES.map((prefix) => `  ${prefix}`).join('\n')}

Non-trading-path changes are listed but not mutated — no score bar applies.
A changed range whose lines are all erased by TypeScript type stripping (type
aliases, interfaces, type-only imports and exports, declare) has nothing for
Stryker to mutate, so it is dropped (doc 66, 2026-10-03); a file left with no
range is listed as type-only.

  --list         print the mutate ranges (of shard i/n with --shard) and run nothing
  --shard i/n    run only shard i of n; the score bar is applied by --merge instead
  --merge n      score the n shard reports in ${REPORT_DIR}/ together against the bar

Results are kept in ${INCREMENTAL_FILE} and reused by the next run (Stryker
incremental mode): a mutant whose code and covering tests are unchanged is not
re-run. Stryker cannot see changes to other source files the code calls, so delete
that file to force a full re-run when a dependency changed. Stryker's own summary
table also counts reused mutants outside this run's ranges; the gate's score line
counts the changed lines only.

Coverage is scoped to these packages' own tests only, so a line whose only
covering test lives elsewhere (e.g. an orchestrator wiring test) reads as
uncovered. Check for that before treating a red gate as a real regression.`);
}

function logAdvisory(scope: GateScope, log: (line: string) => void): void {
  if (scope.advisory.length > 0) {
    log(`Advisory — changed but not mutated (no score bar), ${scope.advisory.length} file(s):`);
    for (const file of scope.advisory) log(`  ${file}`);
  }
  for (const file of scope.typeOnly) log(`Advisory — ${file}: type-only, nothing to mutate`);
}

export interface StrykerRun {
  readonly patterns: readonly string[];
  readonly incrementalFile: string;
}

function runStryker(root: string, run: StrykerRun): SpawnSyncReturns<Buffer> {
  const testFileGlobs = TRADING_PATH_PREFIXES.map(testFilesGlob);
  const strykerBin = fileURLToPath(new URL('../../node_modules/.bin/stryker', import.meta.url));
  mkdirSync(join(root, REPORT_DIR), { recursive: true });
  return spawnSync(
    strykerBin,
    [
      'run',
      '--mutate',
      run.patterns.join(','),
      '--testFiles',
      testFileGlobs.join(','),
      '--incremental',
      '--incrementalFile',
      run.incrementalFile,
    ],
    { cwd: root, stdio: 'inherit', env: { ...process.env, STRYKER_NO_BREAK: '1' } },
  );
}

export interface MutationGateDeps {
  readonly changedFiles: (baseRef: string) => readonly string[];
  readonly addedLines: (baseRef: string) => ReadonlyMap<string, readonly LineRange[]>;
  readonly readSource: (file: string) => string;
  readonly stryker: (run: StrykerRun) => Pick<SpawnSyncReturns<Buffer>, 'error' | 'status'>;
  readonly readReport: (path: string) => MutationReport | undefined;
  readonly writeReport: (path: string, report: MutationReport) => void;
  readonly breakThreshold: number;
  readonly log: (line: string) => void;
}

type GateMode = 'help' | 'list' | 'run' | 'merge';

export interface GateArgs {
  readonly mode: GateMode;
  readonly baseRef: string;
  readonly shard?: { readonly index: number; readonly count: number };
  readonly mergeCount?: number;
}

const SHARD_RE = /^(\d+)\/(\d+)$/;

function parseShard(value: string | undefined): GateArgs['shard'] {
  if (value === undefined) return undefined;
  const match = SHARD_RE.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || index < 1 || index > count)
    throw new Error(`--shard wants i/n with 1 ≤ i ≤ n, got ${value}`);
  return { index, count };
}

function parseMergeCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`--merge wants a shard count, got ${value}`);
  return count;
}

function gateMode(values: { help?: boolean; list?: boolean; merge?: string }): GateMode {
  if (values.help) return 'help';
  if (values.list) return 'list';
  return values.merge === undefined ? 'run' : 'merge';
}

export function parseGateArgs(args: readonly string[]): GateArgs {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      list: { type: 'boolean' },
      shard: { type: 'string' },
      merge: { type: 'string' },
    },
  });
  const shard = parseShard(values.shard);
  const mergeCount = parseMergeCount(values.merge);
  return {
    mode: gateMode(values),
    baseRef: positionals[0] ?? DEFAULT_BASE_REF,
    ...(shard && { shard }),
    ...(mergeCount !== undefined && { mergeCount }),
  };
}

function strykerExitCode(result: Pick<SpawnSyncReturns<Buffer>, 'error' | 'status'>): number {
  if (result.error) throw result.error;
  return result.status ?? 1;
}

interface GateScope extends RuntimeTargets {
  readonly advisory: readonly string[];
}

function gateScope(baseRef: string, deps: MutationGateDeps): GateScope {
  const { tradingPath, advisory } = partitionChangedFiles(deps.changedFiles(baseRef));
  const changed =
    tradingPath.length === 0 ? [] : mutateTargets(tradingPath, deps.addedLines(baseRef));
  return { ...dropTypeOnlyTargets(changed, deps.readSource), advisory };
}

function shardTargets(
  targets: readonly MutateTarget[],
  shard: GateArgs['shard'],
): readonly MutateTarget[] {
  return shard ? (assignShards(targets, shard.count)[shard.index - 1] ?? []) : targets;
}

function runTargets(
  args: GateArgs,
  targets: readonly MutateTarget[],
  incrementalFile: string,
  deps: MutationGateDeps,
): number {
  deps.log(`Mutating ${targets.length} changed trading-path range(s) vs ${args.baseRef}:`);
  for (const target of targets) deps.log(`  ${mutatePattern(target)}`);
  return strykerExitCode(deps.stryker({ patterns: targets.map(mutatePattern), incrementalFile }));
}

function formatScore({ detected, undetected, score }: MutationScore): string {
  const total = detected + undetected;
  return score === undefined
    ? 'no valid mutants'
    : `${score.toFixed(2)} (${detected} / ${total} valid mutants)`;
}

interface ScopedReport {
  readonly targets: readonly MutateTarget[];
  readonly path: string;
}

function scoreReports(scoped: readonly ScopedReport[], deps: MutationGateDeps): number {
  const reports = scoped.map(({ targets, path }) => ({
    targets,
    path,
    report: deps.readReport(path),
  }));
  const missing = reports.filter(({ report }) => report === undefined).map(({ path }) => path);
  if (missing.length > 0) {
    deps.log(`Missing mutation report(s): ${missing.join(', ')}`);
    return 1;
  }
  const merged = scopeShardReports(
    reports.map(({ targets, report }) => ({ targets, report: report as MutationReport })),
  );
  deps.writeReport(INCREMENTAL_FILE, merged);
  const score = scoreReport(merged);
  deps.log(
    `Mutation score on changed lines: ${formatScore(score)}, break at ${deps.breakThreshold}`,
  );
  return score.score !== undefined && score.score < deps.breakThreshold ? 1 : 0;
}

function mutateChanged(args: GateArgs, scope: GateScope, deps: MutationGateDeps): number {
  logAdvisory(scope, deps.log);
  const targets = shardTargets(scope.targets, args.shard);
  if (targets.length === 0) {
    deps.log(
      `No runtime trading-path lines changed vs ${args.baseRef} in this run — mutation gate skipped.`,
    );
    return 0;
  }
  if (args.shard) return runTargets(args, targets, shardReportFile(args.shard.index), deps);
  const status = runTargets(args, targets, INCREMENTAL_FILE, deps);
  return status === 0 ? scoreReports([{ targets, path: INCREMENTAL_FILE }], deps) : status;
}

function mergeShards(count: number, scope: GateScope, deps: MutationGateDeps): number {
  const shards = assignShards(scope.targets, count)
    .map((targets, i) => ({ targets, path: shardReportFile(i + 1) }))
    .filter(({ targets }) => targets.length > 0);
  if (shards.length === 0) {
    deps.log('No runtime trading-path lines changed — mutation gate skipped.');
    return 0;
  }
  return scoreReports(shards, deps);
}

export function runMutationGate(argv: readonly string[], deps: MutationGateDeps): number {
  const args = parseGateArgs(argv);
  if (args.mode === 'help') {
    printHelp(deps.log);
    return 0;
  }
  const scope = gateScope(args.baseRef, deps);
  if (args.mode === 'list') {
    for (const target of shardTargets(scope.targets, args.shard)) deps.log(mutatePattern(target));
    return 0;
  }
  if (args.mode === 'merge') return mergeShards(args.mergeCount ?? 1, scope, deps);
  return mutateChanged(args, scope, deps);
}

export function breakThresholdOf(config: { default: { thresholds: { break: unknown } } }): number {
  const breakAt = config.default.thresholds.break;
  if (typeof breakAt !== 'number' || !Number.isFinite(breakAt)) {
    throw new Error(`stryker.config.mjs thresholds.break must be a number, got ${String(breakAt)}`);
  }
  return breakAt;
}

function readReport(root: string, path: string): MutationReport | undefined {
  const full = join(root, path);
  return existsSync(full) ? (JSON.parse(readFileSync(full, 'utf8')) as MutationReport) : undefined;
}

function writeReport(root: string, path: string, report: MutationReport): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(report));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const config = (await import(pathToFileURL(join(root, 'stryker.config.mjs')).href)) as {
    default: { thresholds: { break: unknown } };
  };
  process.exitCode = runMutationGate(process.argv.slice(2), {
    changedFiles: (baseRef) => getChangedFiles(baseRef, root),
    addedLines: (baseRef) => getAddedLineRanges(baseRef, root),
    readSource: (file) => readFileSync(join(root, file), 'utf8'),
    stryker: (run) => runStryker(root, run),
    readReport: (path) => readReport(root, path),
    writeReport: (path, report) => writeReport(root, path, report),
    breakThreshold: breakThresholdOf(config),
    log: (line) => console.log(line),
  });
}
