import { readFileSync } from 'node:fs';
import type { DebateTermination } from '../shared/index.js';
import { openSharedStore } from '../shared/store/index.js';
import { assertDbPathExists, resolveDbPathFromArgv } from './cli-args.js';
import { isMainModule } from './cli-entrypoint.js';

export interface DebateLogTerminationRow {
  debate_id: string;
  converged: number | null;
  termination: string | null;
  created_at: string;
}

export interface CoverageInterval {
  start: string;
  end: string;
}

export interface LogCoverage {
  timeoutIds: Set<string>;
  intervals: CoverageInterval[];
}

export const MAX_INTER_LINE_GAP_MS = 15 * 60_000;

function recordTimeoutId(record: Record<string, unknown>, timeoutIds: Set<string>): void {
  if (record.message !== 'debate.timeout') return;
  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null) return;
  const debate_id = (payload as Record<string, unknown>).debate_id;
  if (typeof debate_id === 'string') {
    timeoutIds.add(debate_id);
  }
}

function parseLineTimestamp(
  record: Record<string, unknown>,
): { timestamp: string; ms: number } | undefined {
  const rawTimestamp = record.timestamp;
  if (typeof rawTimestamp !== 'string') return undefined;
  const parsedMs = Date.parse(rawTimestamp);
  if (Number.isNaN(parsedMs)) return undefined;
  return { timestamp: new Date(parsedMs).toISOString(), ms: parsedMs };
}

function parseJsonRecord(
  rawLine: string,
  closeSpan: () => void,
): Record<string, unknown> | undefined {
  const line = rawLine.trim();
  if (line === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    closeSpan();
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    closeSpan();
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

export function parseLogCoverage(lines: Iterable<string>): LogCoverage {
  const timeoutIds = new Set<string>();
  const intervals: CoverageInterval[] = [];
  let spanStart: string | undefined;
  let spanEnd: string | undefined;
  let spanEndMs: number | undefined;

  const closeSpan = (): void => {
    if (spanStart !== undefined && spanEnd !== undefined) {
      intervals.push({ start: spanStart, end: spanEnd });
    }
    spanStart = undefined;
    spanEnd = undefined;
    spanEndMs = undefined;
  };

  for (const rawLine of lines) {
    const record = parseJsonRecord(rawLine, closeSpan);
    if (record === undefined) continue;

    recordTimeoutId(record, timeoutIds);

    if (record.trace_id === 'startup') {
      closeSpan();
    }

    const parsedLine = parseLineTimestamp(record);
    if (parsedLine === undefined) {
      continue;
    }

    const gapTooLarge =
      spanEndMs !== undefined && parsedLine.ms - spanEndMs > MAX_INTER_LINE_GAP_MS;
    if (gapTooLarge) {
      closeSpan();
    }

    if (spanStart === undefined) spanStart = parsedLine.timestamp;
    spanEnd = parsedLine.timestamp;
    spanEndMs = parsedLine.ms;
  }
  closeSpan();

  return { timeoutIds, intervals };
}

export function parseLatencyTruncatedDebateIds(lines: Iterable<string>): Set<string> {
  return parseLogCoverage(lines).timeoutIds;
}

export function isCovered(createdAt: string, intervals: readonly CoverageInterval[]): boolean {
  return intervals.some((interval) => interval.start <= createdAt && createdAt <= interval.end);
}

export interface ClassifiedRow {
  debate_id: string;
  termination: DebateTermination;
}

export interface ClassificationResult {
  classified: ClassifiedRow[];
  uncovered: string[];
  indeterminate: string[];
}

function classifyRowTermination(
  row: DebateLogTerminationRow,
  coverage: LogCoverage,
): DebateTermination | 'uncovered' | 'indeterminate' {
  if (coverage.timeoutIds.has(row.debate_id)) {
    return 'latency_truncated';
  }

  if (isCovered(row.created_at, coverage.intervals)) {
    if (row.converged === null) {
      return 'indeterminate';
    }
    return row.converged === 1 ? 'converged' : 'non_converged';
  }

  return 'uncovered';
}

export function classifyRows(
  rows: readonly DebateLogTerminationRow[],
  coverage: LogCoverage,
): ClassificationResult {
  const classified: ClassifiedRow[] = [];
  const uncovered: string[] = [];
  const indeterminate: string[] = [];

  for (const row of rows) {
    if (row.termination !== null) continue;

    const termination = classifyRowTermination(row, coverage);
    if (termination === 'uncovered') {
      uncovered.push(row.debate_id);
    } else if (termination === 'indeterminate') {
      indeterminate.push(row.debate_id);
    } else {
      classified.push({ debate_id: row.debate_id, termination });
    }
  }

  return { classified, uncovered, indeterminate };
}

export function summarizeClassification(
  classified: readonly ClassifiedRow[],
): Record<DebateTermination, number> {
  const summary: Record<DebateTermination, number> = {
    converged: 0,
    non_converged: 0,
    latency_truncated: 0,
  };
  for (const row of classified) {
    summary[row.termination] += 1;
  }
  return summary;
}

export function formatClassificationReport(result: ClassificationResult, applied: boolean): string {
  const summary = summarizeClassification(result.classified);
  const totalRead =
    result.classified.length + result.uncovered.length + result.indeterminate.length;
  const lines = [
    `#1081 debate_log termination classification (${applied ? 'APPLIED' : 'DRY RUN — no rows written'})`,
    `  rows read (termination IS NULL): ${totalRead}`,
    `  classified from positive log evidence: ${result.classified.length}`,
    `    converged:         ${summary.converged}`,
    `    non_converged:     ${summary.non_converged}`,
    `    latency_truncated: ${summary.latency_truncated}`,
    `  left uncovered — no log evidence either way, termination stays NULL: ${result.uncovered.length}`,
    `  left indeterminate — log covers it but converged is itself NULL, termination stays NULL: ${result.indeterminate.length}`,
  ];

  if (result.classified.length > 0) {
    const truncatedPct = ((summary.latency_truncated / result.classified.length) * 100).toFixed(1);
    lines.push(
      '',
      `  ${truncatedPct}% of the classified rows were the latency budget firing, not the market.`,
    );
  }

  if (!applied) {
    lines.push('', '  Re-run with --apply to write these values into debate_log.termination.');
  }

  return lines.join('\n');
}

export function parseLogPaths(argv: readonly string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--log') continue;
    const raw = argv[i + 1];
    if (raw === undefined) {
      throw new Error('--log requires a path argument.');
    }
    for (const path of raw.split(',')) {
      const trimmed = path.trim();
      if (trimmed !== '') paths.push(trimmed);
    }
  }
  return [...new Set(paths)];
}

export { assertDbPathExists };

function parseIsoFlag(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const raw = argv[index + 1];
  if (raw === undefined || Number.isNaN(Date.parse(raw))) {
    throw new Error(`${flag} requires a valid ISO timestamp, got ${JSON.stringify(raw)}.`);
  }
  return raw;
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const logPaths = parseLogPaths(argv);
  if (logPaths.length === 0) {
    throw new Error(
      'classify-debate-termination: at least one --log <path> is required (comma-separated or ' +
        'repeated) — the JSONL orchestrator log(s) covering the session being classified.',
    );
  }
  const since = parseIsoFlag(argv, '--since');
  const until = parseIsoFlag(argv, '--until');
  const apply = argv.includes('--apply');
  const dbPath = resolveDbPathFromArgv(argv);
  const db = openSharedStore(dbPath);

  const coverage: LogCoverage = { timeoutIds: new Set(), intervals: [] };
  for (const logPath of logPaths) {
    const lines = readFileSync(logPath, 'utf8').split('\n');
    const fileCoverage = parseLogCoverage(lines);
    for (const id of fileCoverage.timeoutIds) {
      coverage.timeoutIds.add(id);
    }
    coverage.intervals.push(...fileCoverage.intervals);
  }

  const whereClauses = ['termination IS NULL'];
  const params: string[] = [];
  if (since !== undefined) {
    whereClauses.push('created_at >= ?');
    params.push(new Date(since).toISOString());
  }
  if (until !== undefined) {
    whereClauses.push('created_at < ?');
    params.push(new Date(until).toISOString());
  }

  const rows = db
    .prepare(
      `SELECT debate_id, converged, termination, created_at FROM debate_log WHERE ${whereClauses.join(' AND ')} ORDER BY created_at`,
    )
    .all(...params) as DebateLogTerminationRow[];

  const result = classifyRows(rows, coverage);

  if (apply) {
    const update = db.prepare(
      'UPDATE debate_log SET termination = ? WHERE debate_id = ? AND termination IS NULL',
    );
    const applyAll = db.transaction((toApply: readonly ClassifiedRow[]) => {
      for (const row of toApply) {
        update.run(row.termination, row.debate_id);
      }
    });
    applyAll(result.classified);
  }

  console.log(formatClassificationReport(result, apply));
}
