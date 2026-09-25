import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { isMainModule } from './cli-entrypoint.js';

export interface Position {
  readonly line: number;
  readonly column: number | null;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface FunctionEntry {
  readonly name: string;
  readonly decl?: Range;
  readonly loc: Range;
}

export interface FileCoverage {
  readonly path: string;
  readonly statementMap: Readonly<Record<string, Range>>;
  readonly s: Readonly<Record<string, number>>;
  readonly fnMap: Readonly<Record<string, FunctionEntry>>;
  readonly f: Readonly<Record<string, number>>;
}

export type CoverageReport = Readonly<Record<string, FileCoverage>>;

export interface BiomeDiagnostic {
  readonly category?: string;
  readonly message?: string;
  readonly location?: { readonly path?: string; readonly start?: Position };
}

export interface BiomeReport {
  readonly diagnostics?: readonly BiomeDiagnostic[];
}

export interface ComplexityFinding {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly complexity: number;
}

export interface CrapRow {
  readonly path: string;
  readonly line: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly name: string;
  readonly complexity: number;
  readonly coverage: number;
  readonly crap: number;
}

export interface CrapEvaluation {
  readonly rows: readonly CrapRow[];
  readonly unmatched: readonly ComplexityFinding[];
  readonly ambiguous: readonly ComplexityFinding[];
  readonly uncovered: readonly ComplexityFinding[];
}

const COMPLEXITY_CATEGORY = 'lint/complexity/noExcessiveCognitiveComplexity';
const COMPLEXITY_MESSAGE = /Excessive complexity of (\d+) detected/;
const TEST_FILE = /\.test\.tsx?$/;

export function parseBiomeComplexity(report: BiomeReport, root: string): ComplexityFinding[] {
  const findings: ComplexityFinding[] = [];
  for (const diagnostic of report.diagnostics ?? []) {
    if (diagnostic.category !== COMPLEXITY_CATEGORY) continue;
    const match = COMPLEXITY_MESSAGE.exec(diagnostic.message ?? '');
    const path = diagnostic.location?.path;
    const start = diagnostic.location?.start;
    if (match === null || path === undefined || start === undefined) {
      throw new Error(`unreadable complexity diagnostic: ${JSON.stringify(diagnostic)}`);
    }
    findings.push({
      path: resolve(root, path),
      line: start.line,
      column: start.column ?? 1,
      complexity: Number(match[1]),
    });
  }
  return findings;
}

function comparePoint(aLine: number, aColumn: number, bLine: number, bColumn: number): number {
  return aLine === bLine ? aColumn - bColumn : aLine - bLine;
}

// Coverage columns are 0-based while Biome's are 1-based; a null end column means "to end of line"
function rangeContains(range: Range, line: number, biomeColumn: number): boolean {
  const column = biomeColumn - 1;
  const startColumn = range.start.column ?? 0;
  const endColumn = range.end.column ?? Number.POSITIVE_INFINITY;
  return (
    comparePoint(line, column, range.start.line, startColumn) >= 0 &&
    comparePoint(line, column, range.end.line, endColumn) <= 0
  );
}

function span(range: Range): [number, number] {
  const startColumn = range.start.column ?? 0;
  const endColumn = range.end.column ?? Number.MAX_SAFE_INTEGER;
  return [range.end.line - range.start.line, endColumn - startColumn];
}

function compareSpan(a: Range, b: Range): number {
  const [aLines, aColumns] = span(a);
  const [bLines, bColumns] = span(b);
  return aLines === bLines ? aColumns - bColumns : aLines - bLines;
}

export type FunctionMatch =
  | { readonly kind: 'matched'; readonly key: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous' };

// V8-converted coverage starts `loc` at the body brace; Biome reports at the name, which is `decl`
function declToEnd(fn: FunctionEntry): Range {
  return { start: fn.decl?.start ?? fn.loc.start, end: fn.loc.end };
}

export function innermostFunction(file: FileCoverage, line: number, column: number): FunctionMatch {
  const entries = Object.entries(file.fnMap);
  const exact = entries.filter(
    ([, fn]) => fn.decl?.start.line === line && fn.decl.start.column === column - 1,
  );
  if (exact.length > 1) return { kind: 'ambiguous' };
  const [exactMatch] = exact;
  if (exactMatch !== undefined) return { kind: 'matched', key: exactMatch[0] };
  const containing = entries
    .filter(([, fn]) => rangeContains(declToEnd(fn), line, column))
    .sort(([, a], [, b]) => compareSpan(declToEnd(a), declToEnd(b)));
  const [first, second] = containing;
  if (first === undefined) return { kind: 'none' };
  if (second !== undefined && compareSpan(declToEnd(first[1]), declToEnd(second[1])) === 0) {
    return { kind: 'ambiguous' };
  }
  return { kind: 'matched', key: first[0] };
}

function endPoint(range: Range): [number, number] {
  return [range.end.line, range.end.column ?? Number.POSITIVE_INFINITY];
}

function strictlyInside(inner: Range, outer: Range): boolean {
  const startCompare = comparePoint(
    inner.start.line,
    inner.start.column ?? 0,
    outer.start.line,
    outer.start.column ?? 0,
  );
  const endCompare = comparePoint(...endPoint(inner), ...endPoint(outer));
  return startCompare >= 0 && endCompare <= 0 && (startCompare > 0 || endCompare < 0);
}

function ownStatementIds(file: FileCoverage, fn: FunctionEntry): string[] {
  const nested = Object.values(file.fnMap)
    .map((other) => other.loc)
    .filter((loc) => strictlyInside(loc, fn.loc));
  return Object.entries(file.statementMap)
    .filter(([, range]) => {
      const column = (range.start.column ?? 0) + 1;
      return (
        rangeContains(fn.loc, range.start.line, column) &&
        !nested.some((loc) => rangeContains(loc, range.start.line, column))
      );
    })
    .map(([id]) => id);
}

export function functionCoverage(file: FileCoverage, key: string): number {
  const fn = file.fnMap[key];
  if (fn === undefined) throw new Error(`no function ${key} in ${file.path}`);
  const ids = ownStatementIds(file, fn);
  if (ids.length === 0) return (file.f[key] ?? 0) > 0 ? 1 : 0;
  return ids.filter((id) => (file.s[id] ?? 0) > 0).length / ids.length;
}

export function crapScore(complexity: number, coverage: number): number {
  return complexity * (1 - coverage) ** 2 + complexity;
}

type UnscoredKind = 'unmatched' | 'ambiguous' | 'uncovered';

type ScoredFinding =
  | { readonly kind: 'row'; readonly row: CrapRow }
  | { readonly kind: UnscoredKind | 'test-file' };

// Biome reports an arrow function at its `=>` line, below a multi-line parameter list
function spanStart(finding: ComplexityFinding, fn: FunctionEntry | undefined): number {
  const decl = fn?.decl?.start.line ?? finding.line;
  return Math.min(finding.line, decl, fn?.loc.start.line ?? finding.line);
}

function toRow(finding: ComplexityFinding, file: FileCoverage, key: string): CrapRow {
  const fn = file.fnMap[key];
  const covered = functionCoverage(file, key);
  return {
    path: finding.path,
    line: finding.line,
    startLine: spanStart(finding, fn),
    endLine: fn?.loc.end.line ?? finding.line,
    name: fn?.name ?? key,
    complexity: finding.complexity,
    coverage: covered,
    crap: crapScore(finding.complexity, covered),
  };
}

function scoreFinding(finding: ComplexityFinding, coverage: CoverageReport): ScoredFinding {
  const file = coverage[finding.path];
  if (file === undefined) return { kind: TEST_FILE.test(finding.path) ? 'test-file' : 'uncovered' };
  const match = innermostFunction(file, finding.line, finding.column);
  if (match.kind === 'none') return { kind: 'unmatched' };
  if (match.kind === 'ambiguous') return { kind: 'ambiguous' };
  return { kind: 'row', row: toRow(finding, file, match.key) };
}

export function evaluateCrap(
  findings: readonly ComplexityFinding[],
  coverage: CoverageReport,
): CrapEvaluation {
  const rows: CrapRow[] = [];
  const unscored: Record<UnscoredKind, ComplexityFinding[]> = {
    unmatched: [],
    ambiguous: [],
    uncovered: [],
  };
  for (const finding of findings) {
    const scored = scoreFinding(finding, coverage);
    if (scored.kind === 'row') rows.push(scored.row);
    else if (scored.kind !== 'test-file') unscored[scored.kind].push(finding);
  }
  rows.sort((a, b) => b.crap - a.crap);
  return { rows, ...unscored };
}

export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const index = Math.min(
    sortedAscending.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAscending.length) - 1),
  );
  return sortedAscending[index] ?? 0;
}

export function withinScope(path: string, root: string, prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return true;
  return prefixes.some((prefix) => {
    const base = resolve(root, prefix);
    return path === base || path.startsWith(`${base}${sep}`);
  });
}

export function formatDistribution(
  evaluation: CrapEvaluation,
  root: string,
  top: number,
  thresholds: readonly number[],
): string {
  const scores = evaluation.rows.map((row) => row.crap).sort((a, b) => a - b);
  const lines = [
    `functions scored:  ${scores.length} (complexity 1 functions are not reported by Biome; their CRAP is at most 2)`,
    `unmatched:         ${evaluation.unmatched.length}`,
    `ambiguous:         ${evaluation.ambiguous.length}`,
    `p50 ${percentile(scores, 50).toFixed(1)}  p90 ${percentile(scores, 90).toFixed(1)}  p95 ${percentile(scores, 95).toFixed(1)}  p99 ${percentile(scores, 99).toFixed(1)}  max ${percentile(scores, 100).toFixed(1)}`,
    ...thresholds.map(
      (t) => `above ${String(t).padStart(3)}:  ${scores.filter((score) => score > t).length}`,
    ),
    '',
    `worst ${top}:`,
    ...evaluation.rows
      .slice(0, top)
      .map(
        (row) =>
          `${row.crap.toFixed(1).padStart(6)}  c=${String(row.complexity).padStart(2)}  cov=${(row.coverage * 100).toFixed(0).padStart(3)}%  ${row.path.replace(`${root}/`, '')}:${row.line}  ${row.name}`,
      ),
  ];
  return lines.join('\n');
}

function runBiomeAtThresholdOne(root: string, paths: readonly string[]): BiomeReport {
  const configDir = mkdtempSync(join(tmpdir(), 'crap-biome-'));
  writeFileSync(
    join(configDir, 'biome.json'),
    JSON.stringify({
      linter: {
        enabled: true,
        rules: {
          recommended: false,
          complexity: {
            noExcessiveCognitiveComplexity: {
              level: 'error',
              options: { maxAllowedComplexity: 1 },
            },
          },
        },
      },
      formatter: { enabled: false },
    }),
  );
  const result = spawnSync(
    'npx',
    [
      'biome',
      'lint',
      `--config-path=${configDir}`,
      '--reporter=json',
      '--max-diagnostics=none',
      ...paths,
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  if (result.error !== undefined) throw result.error;
  return JSON.parse(result.stdout) as BiomeReport;
}

export type ChangedLines = ReadonlyMap<string, ReadonlySet<number> | 'all'>;

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function hunkLines(header: string): number[] {
  const match = HUNK_HEADER.exec(header);
  if (match === null) return [];
  const first = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  if (count === 0) return [first, first + 1];
  return Array.from({ length: count }, (_, i) => first + i);
}

const FILE_HEADER = /^--- [^\n]*\n\+\+\+ /m;

export function parseUnifiedDiff(diff: string, root: string): Map<string, Set<number> | 'all'> {
  const changed = new Map<string, Set<number> | 'all'>();
  for (const section of diff.split(FILE_HEADER).slice(1)) {
    const [header = '', ...rest] = section.split('\n');
    const target = header.replace(/\t$/, '');
    if (target === '/dev/null') continue;
    changed.set(resolve(root, target.slice('b/'.length)), new Set(rest.flatMap(hunkLines)));
  }
  return changed;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
}

function nulSeparated(output: string, top: string): string[] {
  return output
    .split('\0')
    .filter((entry) => entry.length > 0)
    .map((entry) => resolve(top, entry));
}

export function reconcileChangedFiles(
  changed: Map<string, Set<number> | 'all'>,
  expectedFiles: readonly string[],
): Map<string, Set<number> | 'all'> {
  const expected = new Set(expectedFiles);
  const stray = [...changed.keys()].filter((path) => !expected.has(path));
  if (stray.length > 0) {
    throw new Error(`diff parse disagrees with git --name-only: ${stray.join(', ')}`);
  }
  for (const path of expectedFiles) {
    if (!changed.has(path)) changed.set(path, 'all');
  }
  return changed;
}

export function gitChangedLines(root: string, ref: string): ChangedLines {
  const top = git(root, ['rev-parse', '--show-toplevel']).trim();
  const base = git(top, ['merge-base', ref, 'HEAD']).trim();
  const diffArgs = ['diff', '--no-renames', '--no-ext-diff', base];
  const changed = reconcileChangedFiles(
    parseUnifiedDiff(
      git(top, [...diffArgs, '-U0', '--no-color', '--src-prefix=a/', '--dst-prefix=b/']),
      top,
    ),
    nulSeparated(git(top, [...diffArgs, '--name-only', '-z', '--diff-filter=d']), top),
  );
  const untracked = git(top, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const path of nulSeparated(untracked, top)) changed.set(path, 'all');
  return changed;
}

export interface GatePolicy {
  readonly root: string;
  readonly strict: readonly string[];
  readonly changed?: ChangedLines;
}

function touches(
  lines: ReadonlySet<number> | 'all' | undefined,
  from: number,
  to: number,
): boolean {
  if (lines === 'all') return true;
  return [...(lines ?? [])].some((line) => line >= from && line <= to);
}

export function isGated(policy: GatePolicy, path: string, from: number, to: number): boolean {
  if (policy.changed === undefined) return true;
  if (policy.strict.length > 0 && withinScope(path, policy.root, policy.strict)) return true;
  return touches(policy.changed.get(path), from, to);
}

interface CliOptions {
  readonly coveragePath: string;
  readonly threshold?: number;
  readonly top: number;
  readonly scope: readonly string[];
  readonly strict: readonly string[];
  readonly changedSince?: string;
}

interface MutableCliOptions {
  coveragePath: string;
  threshold?: number;
  top: number;
  scope: string[];
  strict: string[];
  changedSince?: string;
}

function finiteNumber(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`bad ${flag}: ${value}`);
  return parsed;
}

const FLAG_HANDLERS: Readonly<Record<string, (options: MutableCliOptions, value: string) => void>> =
  {
    '--coverage': (options, value) => {
      options.coveragePath = value;
    },
    '--threshold': (options, value) => {
      options.threshold = finiteNumber('--threshold', value);
    },
    '--top': (options, value) => {
      options.top = finiteNumber('--top', value);
    },
    '--scope': (options, value) => {
      options.scope.push(value);
    },
    '--strict': (options, value) => {
      options.strict.push(value);
    },
    '--changed-since': (options, value) => {
      options.changedSince = value;
    },
  };

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: MutableCliOptions = {
    coveragePath: 'coverage/coverage-final.json',
    top: 25,
    scope: [],
    strict: [],
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? '';
    const handler = FLAG_HANDLERS[flag];
    if (handler === undefined) throw new Error(`unknown flag ${flag}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    handler(options, value);
  }
  return options;
}

export interface GateResult {
  readonly code: number;
  readonly text: string;
}

function relative(root: string, path: string): string {
  return path.replace(`${root}/`, '');
}

export function gateReport(
  evaluation: CrapEvaluation,
  limit: number,
  policy: GatePolicy,
): GateResult {
  if (evaluation.rows.length === 0) {
    return {
      code: 1,
      text: 'crap gate: no complexity findings scored; refusing to pass an empty run\n',
    };
  }
  const gated = evaluation.rows.filter((row) =>
    isGated(policy, row.path, row.startLine, row.endLine),
  );
  const offenders = gated.filter((row) => row.crap > limit);
  const unscored = [
    ...evaluation.unmatched,
    ...evaluation.ambiguous,
    ...evaluation.uncovered,
  ].filter((finding) => isGated(policy, finding.path, finding.line, finding.line));
  const outside = evaluation.rows.filter((row) => row.crap > limit).length - offenders.length;
  const lines = [
    ...offenders.map(
      (row) =>
        `CRAP ${row.crap.toFixed(1)} > ${limit}  ${relative(policy.root, row.path)}:${row.line}  ${row.name}`,
    ),
    ...unscored.map(
      (finding) => `unscored: ${relative(policy.root, finding.path)}:${finding.line}`,
    ),
    `crap gate: ${offenders.length} function(s) above ${limit} of ${gated.length} gated (${evaluation.rows.length} scored; ${outside} above ${limit} outside the ratchet, not gated)`,
  ];
  const pass = offenders.length === 0 && unscored.length === 0;
  return { code: pass ? 0 : 1, text: `${lines.join('\n')}\n` };
}

export type BiomeRunner = (root: string, paths: readonly string[]) => BiomeReport;

export interface GateDeps {
  readonly runBiome: BiomeRunner;
  readonly changedLines: (root: string, ref: string) => ChangedLines;
  readonly write: (text: string) => void;
}

// Changed paths resolve against git's real top level and rows against `root`; a mismatch
// (a symlinked checkout) would leave every non-strict function ungated and the gate green
function changedUnder(root: string, changed: ChangedLines): ChangedLines {
  const outside = [...changed.keys()].filter((path) => !path.startsWith(`${root}/`));
  if (outside.length > 0) {
    throw new Error(`changed paths outside ${root}: ${outside.join(', ')}`);
  }
  return changed;
}

const DEFAULT_DEPS: GateDeps = {
  runBiome: runBiomeAtThresholdOne,
  changedLines: gitChangedLines,
  write: (text) => process.stdout.write(text),
};

export function main(
  argv: readonly string[],
  root = process.cwd(),
  overrides: Partial<GateDeps> = {},
): number {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const options = parseArgs(argv);
  const coverage = JSON.parse(
    readFileSync(resolve(root, options.coveragePath), 'utf8'),
  ) as CoverageReport;
  const findings = parseBiomeComplexity(deps.runBiome(root, ['server', 'contracts']), root).filter(
    (finding) => withinScope(finding.path, root, options.scope),
  );
  const evaluation = evaluateCrap(findings, coverage);
  if (options.threshold === undefined) {
    deps.write(`${formatDistribution(evaluation, root, options.top, [7, 15, 20])}\n`);
    return 0;
  }
  const changed =
    options.changedSince === undefined
      ? undefined
      : changedUnder(root, deps.changedLines(root, options.changedSince));
  const result = gateReport(evaluation, options.threshold, {
    root,
    strict: options.strict,
    ...(changed === undefined ? {} : { changed }),
  });
  deps.write(result.text);
  return result.code;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
