/**
 * #1081 — backfills `debate_log.termination` for rows written before
 * migration 0041, by correlating each row's `debate_id` against a run log's
 * `debate.timeout` lines (the same JSON `logger.logTimeout` writes,
 * `debate-engine/latency-budget.ts`).
 *
 * ## Why this exists as a command, not an automatic migration step
 *
 * Migration 0041 deliberately leaves every pre-existing row's `termination`
 * NULL rather than guess: the migration has no access to the run logs, and a
 * schema change is not a truthful place to correlate two different data
 * sources. This command is the honest fix — it reads the SAME store the
 * orchestrator writes and the SAME JSONL logs `JsonLogger` emits.
 *
 * ## Positive coverage, not absence-as-evidence
 *
 * A `debate_id` present in a `debate.timeout` line is unambiguous positive
 * evidence of `'latency_truncated'` — direct, regardless of anything else.
 * But the converse is NOT true: a `debate_id` **absent** from that set is not
 * evidence the debate converged or genuinely disagreed. `logTimeout` is, as
 * of this writing, the only `DebateLogger` method any production code path
 * actually calls (`enforceLatencyBudget` is its one caller) — there is no
 * "debate completed" log line to confirm a given row's debate was even
 * covered by the supplied logs. A rotated-away log, a partial `--log` set,
 * or a torn line from a mid-write restart can all make a row's debate
 * invisible to this run without that being evidence of anything.
 *
 * So a row is only classified `'converged'`/`'non_converged'` when the
 * supplied logs positively COVER its `created_at` — `parseLogCoverage`
 * builds contiguous `[start, end]` timestamp spans from consecutive,
 * successfully-parsed, timestamped log lines, closing the span (not
 * bridging across it) at every unparseable line, so a torn log or a gap
 * between rotated files does not silently claim coverage it does not have.
 * A row whose `created_at` falls outside every span — and whose `debate_id`
 * has no direct `debate.timeout` match — is left NULL and reported
 * separately as `uncovered`, exactly like a row with no log at all. Nothing
 * here ever treats "we didn't see a timeout for it" as proof the debate
 * wasn't truncated.
 *
 * ## Read-only by default, for `debate_log.termination`
 *
 * Opening the store (`openSharedStore`) always applies any pending schema
 * migrations, regardless of `--apply` — that is `openSharedStore`'s own
 * unconditional behaviour (`open-shared-store.ts`), not something this tool
 * controls. `--apply` gates only this tool's own writes: without it, no
 * `debate_log.termination` value is written, this run only reports what it
 * would write. `--apply` writes ONLY into rows where `termination IS NULL`
 * — it can never overwrite a value migration 0041's writer already set,
 * matching the append-only posture the rest of `debate_log` keeps
 * (SqliteDebateLogStore's duplicate-write guard).
 *
 * ## Usage
 *
 *   yarn classify:debate-termination --log <path>[,<path>...] [--since ISO] [--until ISO] [--db <path>] [--apply]
 *
 * `--log` accepts multiple JSONL orchestrator log files (comma-separated or
 * repeated) — a rotated log means the window an operator cares about can span
 * more than one file; coverage is computed per file and merged, so a gap
 * between two rotated files (or inside one of them) still leaves the rows
 * that fall in it uncovered rather than guessed. `--since`/`--until` filter
 * `debate_log` by `created_at`; both are optional and default to no bound.
 *
 * `--db <path>` points at an explicit SQLite file instead of the
 * environment-resolved store (`SAMURAI_MODE` → `sharedStorePath`). This is
 * what makes the tool's own read path independently checkable against a
 * point-in-time COPY of the live database, rather than trusting a one-off
 * script to have reimplemented `classifyRows` correctly — see #1081's PR body
 * for the run this produced against the 2026-09-03 paper soak. Because the
 * path is explicit, `assertStorePathMatchesMode`'s paper/live filename guard
 * is skipped for `--db`: that guard exists to stop the environment-resolved
 * default from silently writing into the wrong mode's file, which does not
 * apply when the operator names the file directly. `--db` plus `--apply`
 * together still only ever write into the named file.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { assertStorePathMatchesMode } from '../apps/orchestrator/index.js';
import type { DebateTermination } from '../shared/index.js';
import { openSharedStore, resolveStoreMode, sharedStorePath } from '../shared/store/index.js';

/** One `debate_log` row, the columns classification needs. */
export interface DebateLogTerminationRow {
  debate_id: string;
  /** SQLite 1/0/NULL, matching the raw column — not yet converted to boolean. */
  converged: number | null;
  /** NULL for a pre-0041 row; a row already classified is never reclassified. */
  termination: string | null;
  /** ISO timestamp — the coordinate `isCovered` checks against a log's spans. */
  created_at: string;
}

/** A contiguous span of ISO timestamps a log positively covers — see `parseLogCoverage`. */
export interface CoverageInterval {
  start: string;
  end: string;
}

/**
 * What a run log positively establishes: every `debate_id` a `debate.timeout`
 * line named (direct evidence of `'latency_truncated'`), and the timestamp
 * spans the log actually saw (coverage evidence for everything else).
 */
export interface LogCoverage {
  timeoutIds: Set<string>;
  intervals: CoverageInterval[];
}

/**
 * Parses one JSONL run log (`JsonLogger`'s wire format — one JSON object per
 * line, each carrying its own `timestamp`) into a `LogCoverage`.
 *
 * `debate.timeout` lines are collected into `timeoutIds` regardless of
 * whether they carry a parseable `timestamp` — that match is direct evidence
 * on its own, independent of coverage spans. Every other successfully-parsed,
 * timestamped line extends the current coverage span; a line that fails to
 * parse (or parses to something with no usable `timestamp`) is NOT bridged
 * over — malformed/non-empty lines close the current span, and the next
 * timestamped line starts a new one. A log file accumulated over a live soak
 * routinely carries a torn line from a restart mid-write; the debates that
 * fell in the resulting gap are not something this log can vouch for either
 * way, so the span must not claim to cover them.
 */
export function parseLogCoverage(lines: Iterable<string>): LogCoverage {
  const timeoutIds = new Set<string>();
  const intervals: CoverageInterval[] = [];
  let spanStart: string | undefined;
  let spanEnd: string | undefined;

  const closeSpan = (): void => {
    if (spanStart !== undefined && spanEnd !== undefined) {
      intervals.push({ start: spanStart, end: spanEnd });
    }
    spanStart = undefined;
    spanEnd = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      closeSpan(); // torn line — coverage does not bridge across it
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      closeSpan();
      continue;
    }
    const record = parsed as Record<string, unknown>;

    if (record.message === 'debate.timeout') {
      const payload = record.payload;
      if (typeof payload === 'object' && payload !== null) {
        const debate_id = (payload as Record<string, unknown>).debate_id;
        if (typeof debate_id === 'string') {
          timeoutIds.add(debate_id);
        }
      }
    }

    const timestamp = record.timestamp;
    if (typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp))) {
      if (spanStart === undefined) spanStart = timestamp;
      spanEnd = timestamp;
    }
    // A well-formed line with no usable timestamp neither extends nor closes
    // the current span — it is not evidence of a gap, just a line this
    // function cannot place in time.
  }
  closeSpan();

  return { timeoutIds, intervals };
}

/**
 * The `debate_id`s a run log's `debate.timeout` lines name — a thin view over
 * `parseLogCoverage`, kept as its own export because direct timeout matching
 * is useful (and testable) independent of coverage-span reasoning.
 */
export function parseLatencyTruncatedDebateIds(lines: Iterable<string>): Set<string> {
  return parseLogCoverage(lines).timeoutIds;
}

/** Whether `createdAt` falls inside any of the given coverage spans (inclusive). */
export function isCovered(createdAt: string, intervals: readonly CoverageInterval[]): boolean {
  return intervals.some((interval) => interval.start <= createdAt && createdAt <= interval.end);
}

/** One row's proposed classification — `classifyRows` never emits one for a row already classified. */
export interface ClassifiedRow {
  debate_id: string;
  termination: DebateTermination;
}

/** `classifyRows`' full output: what it proposes to write, and what it could not. */
export interface ClassificationResult {
  classified: ClassifiedRow[];
  /** `debate_id`s left NULL — no `debate.timeout` match AND no log span covers the row's `created_at`. */
  uncovered: string[];
}

/**
 * Classifies every row that carries no `termination` yet, against a merged
 * `LogCoverage` (see `parseLogCoverage` — callers merge per-file coverage by
 * unioning `timeoutIds` and concatenating `intervals`).
 *
 * A `debate_id` present in `coverage.timeoutIds` is `'latency_truncated'`
 * unconditionally — that is direct evidence, independent of span coverage.
 * Otherwise, the row is classified `'converged'`/`'non_converged'` (from its
 * `converged` column) ONLY when `coverage.intervals` positively covers its
 * `created_at` — this is deliberately NOT the same derivation `buildDebateLog`
 * applies going forward: `buildDebateLog` has a single producer with total
 * information (the resolved `DebateResult` it just built), so an absent
 * `timed_out` there is conclusive. This function has partial, external
 * evidence (whatever logs the operator happened to supply), so absence from
 * `timeoutIds` alone proves nothing — a row outside every covered span stays
 * NULL and is reported in `uncovered` instead of being guessed at.
 *
 * A row that already carries a `termination` (post-0041 write, or a prior
 * run of this same tool) is skipped entirely — this function only proposes
 * values for what migration 0041 left indeterminate, never reclassifies a
 * row already settled.
 */
export function classifyRows(
  rows: readonly DebateLogTerminationRow[],
  coverage: LogCoverage,
): ClassificationResult {
  const classified: ClassifiedRow[] = [];
  const uncovered: string[] = [];

  for (const row of rows) {
    if (row.termination !== null) continue;

    if (coverage.timeoutIds.has(row.debate_id)) {
      classified.push({ debate_id: row.debate_id, termination: 'latency_truncated' });
      continue;
    }

    if (isCovered(row.created_at, coverage.intervals)) {
      classified.push({
        debate_id: row.debate_id,
        termination: row.converged === 1 ? 'converged' : 'non_converged',
      });
      continue;
    }

    uncovered.push(row.debate_id);
  }

  return { classified, uncovered };
}

/** Per-`termination` counts, for the operator-facing report. */
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

/** Renders the classification as a human-readable report. */
export function formatClassificationReport(result: ClassificationResult, applied: boolean): string {
  const summary = summarizeClassification(result.classified);
  const totalRead = result.classified.length + result.uncovered.length;
  const lines = [
    `#1081 debate_log termination classification (${applied ? 'APPLIED' : 'DRY RUN — no rows written'})`,
    `  rows read (termination IS NULL): ${totalRead}`,
    `  classified from positive log evidence: ${result.classified.length}`,
    `    converged:         ${summary.converged}`,
    `    non_converged:     ${summary.non_converged}`,
    `    latency_truncated: ${summary.latency_truncated}`,
    `  left uncovered — no log evidence either way, termination stays NULL: ${result.uncovered.length}`,
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

/** Parses `--log a,b --log c` (comma-separated and/or repeated) into a flat, deduped list. */
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

function parseIsoFlag(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const raw = argv[index + 1];
  if (raw === undefined || Number.isNaN(Date.parse(raw))) {
    throw new Error(`${flag} requires a valid ISO timestamp, got ${JSON.stringify(raw)}.`);
  }
  return raw;
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined &&
  import.meta.url ===
    new URL(`file://${isAbsolute(invokedPath) ? invokedPath : resolve(invokedPath)}`).href;

if (isMain) {
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
  const explicitDbIndex = argv.indexOf('--db');
  const explicitDbPath = explicitDbIndex === -1 ? undefined : argv[explicitDbIndex + 1];
  if (explicitDbIndex !== -1 && explicitDbPath === undefined) {
    throw new Error('--db requires a path argument.');
  }

  let dbPath: string;
  if (explicitDbPath !== undefined) {
    // An explicit path names its own file — the paper/live filename guard
    // below exists to protect the environment-resolved default, not this.
    dbPath = explicitDbPath;
  } else {
    const mode = resolveStoreMode();
    dbPath = sharedStorePath(mode);
    // Same guard `report-arm-comparison.ts` and `place-soak-position.ts` apply:
    // a classification run against the wrong database would silently report
    // numbers that describe no real session.
    assertStorePathMatchesMode({ dbPath, mode });
  }
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
