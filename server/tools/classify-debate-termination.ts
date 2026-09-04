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
 * orchestrator writes and the SAME JSONL logs `JsonLogger` emits, and only
 * classifies a row when the correlation is unambiguous: an exact `debate_id`
 * match against a `debate.timeout` log line. A row with no such match is left
 * NULL rather than guessed at as `'converged'`; there is no positive evidence
 * either way, and inventing one would recreate the ambiguity #1081 exists to
 * remove.
 *
 * ## Read-only by default
 *
 * Reports counts and writes nothing unless `--apply` is given. `--apply`
 * writes ONLY into rows where `termination IS NULL` — it can never overwrite
 * a value migration 0041's writer already set, matching the append-only
 * posture the rest of `debate_log` keeps (SqliteDebateLogStore's duplicate-
 * write guard).
 *
 * ## Usage
 *
 *   yarn classify:debate-termination --log <path>[,<path>...] [--since ISO] [--until ISO] [--db <path>] [--apply]
 *
 * `--log` accepts multiple JSONL orchestrator log files (comma-separated or
 * repeated) — a rotated log means the window an operator cares about can span
 * more than one file. `--since`/`--until` filter `debate_log` by
 * `created_at`; both are optional and default to no bound.
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
}

/**
 * Parses `debate.timeout` lines out of a run log (JSONL — one JSON object per
 * line, `JsonLogger`'s wire format) and returns the `debate_id`s the latency
 * budget truncated. Malformed lines and every other message are ignored
 * rather than failing the whole read: a log file accumulated over a live soak
 * routinely carries a torn line from a restart mid-write.
 */
export function parseLatencyTruncatedDebateIds(lines: Iterable<string>): Set<string> {
  const ids = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (record.message !== 'debate.timeout') continue;

    const payload = record.payload;
    if (typeof payload !== 'object' || payload === null) continue;
    const debate_id = (payload as Record<string, unknown>).debate_id;
    if (typeof debate_id === 'string') {
      ids.add(debate_id);
    }
  }

  return ids;
}

/** One row's proposed classification — `classifyRows` never emits one for a row already classified. */
export interface ClassifiedRow {
  debate_id: string;
  termination: DebateTermination;
}

/**
 * Classifies every row that carries no `termination` yet. A `debate_id`
 * present in `latencyTruncatedIds` is `'latency_truncated'` regardless of its
 * `converged` value — the log correlation is the unambiguous signal; a row
 * absent from that set falls back to what `converged` alone can say
 * (`'converged'` / `'non_converged'`), the same derivation
 * `buildDebateLog` applies going forward.
 *
 * A row that already carries a `termination` (post-0041 write) is skipped
 * entirely — this function only proposes values for what migration 0041 left
 * indeterminate, never reclassifies a row the writer already settled.
 */
export function classifyRows(
  rows: readonly DebateLogTerminationRow[],
  latencyTruncatedIds: ReadonlySet<string>,
): ClassifiedRow[] {
  const classified: ClassifiedRow[] = [];

  for (const row of rows) {
    if (row.termination !== null) continue;

    const termination: DebateTermination = latencyTruncatedIds.has(row.debate_id)
      ? 'latency_truncated'
      : row.converged === 1
        ? 'converged'
        : 'non_converged';

    classified.push({ debate_id: row.debate_id, termination });
  }

  return classified;
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
export function formatClassificationReport(
  classified: readonly ClassifiedRow[],
  applied: boolean,
): string {
  const summary = summarizeClassification(classified);
  const lines = [
    `#1081 debate_log termination classification (${applied ? 'APPLIED' : 'DRY RUN — no rows written'})`,
    `  rows classified: ${classified.length}`,
    `    converged:         ${summary.converged}`,
    `    non_converged:     ${summary.non_converged}`,
    `    latency_truncated: ${summary.latency_truncated}`,
  ];

  if (classified.length > 0) {
    const truncatedPct = ((summary.latency_truncated / classified.length) * 100).toFixed(1);
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

  const timeoutIds = new Set<string>();
  for (const logPath of logPaths) {
    const lines = readFileSync(logPath, 'utf8').split('\n');
    for (const id of parseLatencyTruncatedDebateIds(lines)) {
      timeoutIds.add(id);
    }
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
      `SELECT debate_id, converged, termination FROM debate_log WHERE ${whereClauses.join(' AND ')} ORDER BY created_at`,
    )
    .all(...params) as DebateLogTerminationRow[];

  const classified = classifyRows(rows, timeoutIds);

  if (apply) {
    const update = db.prepare(
      'UPDATE debate_log SET termination = ? WHERE debate_id = ? AND termination IS NULL',
    );
    const applyAll = db.transaction((toApply: readonly ClassifiedRow[]) => {
      for (const row of toApply) {
        update.run(row.termination, row.debate_id);
      }
    });
    applyAll(classified);
  }

  console.log(formatClassificationReport(classified, apply));
}
