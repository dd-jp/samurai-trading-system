import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  readonly name: string;
  readonly complexity: number;
  readonly coverage: number;
  readonly crap: number;
}

export interface CrapEvaluation {
  readonly rows: readonly CrapRow[];
  readonly unmatched: readonly ComplexityFinding[];
  readonly ambiguous: readonly ComplexityFinding[];
}

const COMPLEXITY_CATEGORY = 'lint/complexity/noExcessiveCognitiveComplexity';
const COMPLEXITY_MESSAGE = /Excessive complexity of (\d+) detected/;

export function parseBiomeComplexity(report: BiomeReport, root: string): ComplexityFinding[] {
  const findings: ComplexityFinding[] = [];
  for (const diagnostic of report.diagnostics ?? []) {
    if (diagnostic.category !== COMPLEXITY_CATEGORY) continue;
    const match = COMPLEXITY_MESSAGE.exec(diagnostic.message ?? '');
    const path = diagnostic.location?.path;
    const start = diagnostic.location?.start;
    if (match === null || path === undefined || start === undefined) continue;
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

// Coverage columns are 0-based while Biome's are 1-based; a null end column means "to end of line".
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

// V8-converted coverage starts `loc` at the body brace; Biome reports at the name, which is `decl`.
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

export function functionCoverage(file: FileCoverage, key: string): number {
  const fn = file.fnMap[key];
  if (fn === undefined) throw new Error(`no function ${key} in ${file.path}`);
  let total = 0;
  let covered = 0;
  for (const [id, range] of Object.entries(file.statementMap)) {
    if (!rangeContains(fn.loc, range.start.line, (range.start.column ?? 0) + 1)) continue;
    total += 1;
    if ((file.s[id] ?? 0) > 0) covered += 1;
  }
  if (total === 0) return (file.f[key] ?? 0) > 0 ? 1 : 0;
  return covered / total;
}

export function crapScore(complexity: number, coverage: number): number {
  return complexity * (1 - coverage) ** 2 + complexity;
}

export function evaluateCrap(
  findings: readonly ComplexityFinding[],
  coverage: CoverageReport,
): CrapEvaluation {
  const rows: CrapRow[] = [];
  const unmatched: ComplexityFinding[] = [];
  const ambiguous: ComplexityFinding[] = [];
  for (const finding of findings) {
    const file = coverage[finding.path];
    if (file === undefined) continue;
    const match = innermostFunction(file, finding.line, finding.column);
    if (match.kind === 'none') {
      unmatched.push(finding);
      continue;
    }
    if (match.kind === 'ambiguous') {
      ambiguous.push(finding);
      continue;
    }
    const covered = functionCoverage(file, match.key);
    rows.push({
      path: finding.path,
      line: finding.line,
      name: file.fnMap[match.key]?.name ?? match.key,
      complexity: finding.complexity,
      coverage: covered,
      crap: crapScore(finding.complexity, covered),
    });
  }
  rows.sort((a, b) => b.crap - a.crap);
  return { rows, unmatched, ambiguous };
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
  return prefixes.some((prefix) => path.startsWith(resolve(root, prefix)));
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

interface CliOptions {
  readonly coveragePath: string;
  readonly threshold?: number;
  readonly top: number;
  readonly scope: readonly string[];
}

interface MutableCliOptions {
  coveragePath: string;
  threshold?: number;
  top: number;
  scope: string[];
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
  };

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: MutableCliOptions = {
    coveragePath: 'coverage/coverage-final.json',
    top: 25,
    scope: [],
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

export type BiomeRunner = (root: string, paths: readonly string[]) => BiomeReport;

export function main(
  argv: readonly string[],
  root = process.cwd(),
  runBiome: BiomeRunner = runBiomeAtThresholdOne,
  write: (text: string) => void = (text) => process.stdout.write(text),
): number {
  const options = parseArgs(argv);
  const coverage = JSON.parse(
    readFileSync(resolve(root, options.coveragePath), 'utf8'),
  ) as CoverageReport;
  const findings = parseBiomeComplexity(runBiome(root, ['server', 'contracts']), root).filter(
    (finding) => withinScope(finding.path, root, options.scope),
  );
  const evaluation = evaluateCrap(findings, coverage);
  if (options.threshold === undefined) {
    write(`${formatDistribution(evaluation, root, options.top, [15, 20, 30])}\n`);
    return 0;
  }
  const limit = options.threshold;
  const offenders = evaluation.rows.filter((row) => row.crap > limit);
  for (const row of offenders) {
    write(
      `CRAP ${row.crap.toFixed(1)} > ${limit}  ${row.path.replace(`${root}/`, '')}:${row.line}  ${row.name}\n`,
    );
  }
  const unscored = [...evaluation.unmatched, ...evaluation.ambiguous];
  for (const finding of unscored) {
    write(`unscored: ${finding.path.replace(`${root}/`, '')}:${finding.line}\n`);
  }
  write(
    `crap gate: ${offenders.length} function(s) above ${limit} of ${evaluation.rows.length} scored\n`,
  );
  return offenders.length === 0 && unscored.length === 0 ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
