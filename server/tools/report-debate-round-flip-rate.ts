/**
 * #1517's flip-rate report: does a debate's verdict ever differ between round
 * 1 and its final round, or does every extra round just re-confirm the
 * first?
 *
 *   yarn report:debate-flip-rate [--days N] [--db <path>]
 *
 * `--db <path>` points at an explicit SQLite file instead of the
 * environment-resolved store (`SAMURAI_MODE` → `sharedStorePath`) — same
 * flag, same reasoning, as `classify-debate-termination.ts`: it is what
 * makes this report checkable against a point-in-time COPY of a soak's
 * database without the environment-resolved default hazard the next
 * section describes. `assertStorePathMatchesMode`'s paper/live filename
 * guard is skipped for `--db`, since the operator named the file directly.
 *
 * ## Why this exists as a command, not a dashboard panel
 *
 * Same reasoning `report-arm-comparison.ts` gives: read on a cadence of days
 * by a human deciding whether debate depth earns its cost, against whichever
 * store a soak is actually running on. `debate_round_log` (migration 0064)
 * is brand new — no wire/dashboard plumbing exists for it, and building that
 * would be a larger change than this ticket asks for.
 *
 * ## What "flip" means here
 *
 * Direction only (bullish/bearish/neutral), per the ticket's own wording —
 * "does the final round's verdict differ from round 1's" — not confidence
 * movement, which is a different (and noisier) question. A debate that moved
 * bearish -> bullish -> bearish across three rounds is NOT counted as a
 * flip: round 1 and the FINAL round agree, even though the direction moved
 * mid-debate. That is deliberate — the ticket asks whether extra rounds
 * change the OUTCOME a trader would act on, not whether the debate was ever
 * uncertain in between.
 *
 * ## The two denominators
 *
 * `total_debates` counts every debate with at least one logged round;
 * `multi_round_debates` restricts to debates with 2+ rounds — a single-round
 * debate cannot flip BY CONSTRUCTION (there is no round to compare round 1
 * against), so folding it into the flip-rate denominator would understate
 * the rate for a reason that has nothing to do with the debate mechanism.
 * `flip_rate` is computed over `multi_round_debates` alone, and is `null`
 * (not 0) when that denominator is 0 — a genuine "cannot measure this", not
 * a padded "no flips found".
 *
 * ## `openSharedStore` applies pending migrations to whatever it opens
 *
 * Same hazard `classify-debate-termination.ts` documents in its own header:
 * `openSharedStore` unconditionally applies pending schema migrations to the
 * file it is pointed at, regardless of this tool's own flags. Never point
 * this at a store a running orchestrator/soak process still holds open —
 * migrating it out from under that process is unsafe. To check this report's
 * output against a soak's data without touching the live file, use `--db
 * <path>` (mirroring `classify-debate-termination.ts`'s flag) against a
 * checkpointed COPY of the `.sqlite` file, never the live one: for
 * `SAMURAI_MODE=paper` run from the repo root, the environment-resolved
 * default (`sharedStorePath`, no `--db`) is a repo-relative
 * `data/samurai-paper.sqlite` — the SAME path a live soak process running
 * from that same cwd holds open, so omitting `--db` there does not read a
 * separate file at all.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { assertStorePathMatchesMode } from '../apps/orchestrator/index.js';
import type { DebateRoundLogEntry, Direction } from '../pipeline/debate-engine/index.js';
import { SqliteDebateLogStore } from '../pipeline/debate-engine/index.js';
import { openSharedStore, resolveStoreMode, sharedStorePath } from '../shared/store/index.js';

export const DEFAULT_WINDOW_DAYS = 30;

export interface FlipRateReport {
  total_debates: number;
  multi_round_debates: number;
  flips: number;
  /** `flips / multi_round_debates`, or `null` when that denominator is 0 */
  flip_rate: number | null;
}

/** Round 1's direction and the highest-numbered round's direction, for one debate */
function firstAndLastDirection(rows: DebateRoundLogEntry[]): {
  first: Direction;
  last: Direction;
  rounds: number;
} {
  const sorted = [...rows].sort((a, b) => a.round - b.round);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error('firstAndLastDirection: called with an empty row set');
  }
  return { first: first.direction, last: last.direction, rounds: sorted.length };
}

export function computeFlipRate(rows: DebateRoundLogEntry[]): FlipRateReport {
  const byDebate = new Map<string, DebateRoundLogEntry[]>();
  for (const r of rows) {
    const existing = byDebate.get(r.debate_id);
    if (existing === undefined) {
      byDebate.set(r.debate_id, [r]);
    } else {
      existing.push(r);
    }
  }

  let multi_round_debates = 0;
  let flips = 0;
  for (const debateRows of byDebate.values()) {
    const { first, last, rounds } = firstAndLastDirection(debateRows);
    if (rounds < 2) {
      continue;
    }
    multi_round_debates += 1;
    if (first !== last) {
      flips += 1;
    }
  }

  return {
    total_debates: byDebate.size,
    multi_round_debates,
    flips,
    flip_rate: multi_round_debates === 0 ? null : flips / multi_round_debates,
  };
}

export function formatFlipRateReport(report: FlipRateReport, from: Date, to: Date): string {
  const lines: string[] = [
    'DEBATE ROUND FLIP RATE — round 1 vs the final round (#1517)',
    `  window: ${from.toISOString()} -> ${to.toISOString()}`,
    `  debates with round-level logging: ${report.total_debates}`,
    `  debates with 2+ rounds (the only ones that CAN flip): ${report.multi_round_debates}`,
  ];

  if (report.multi_round_debates === 0) {
    lines.push(
      '',
      '  NO FLIP RATE: no multi-round debates in this window. Since #1080,',
      '  MAX_ROUNDS_BY_ASSET_CLASS is 1 for both asset classes, so a debate',
      '  logged AFTER that change has exactly one round and cannot flip by',
      '  construction. This is expected, not a defect — widening --days cannot',
      '  reach a pre-#1080 row (debate_round_log only exists from migration',
      '  0064 onward); re-run once the round cap changes instead.',
    );
  } else {
    const rate = report.flip_rate ?? 0;
    lines.push(
      '',
      `  flips: ${report.flips} / ${report.multi_round_debates} (${(rate * 100).toFixed(2)}%)`,
    );
  }

  return lines.join('\n');
}

/** Parses `--days N`; anything else is rejected rather than silently defaulted */
export function parseWindowDays(argv: readonly string[]): number {
  const index = argv.indexOf('--days');
  if (index === -1) return DEFAULT_WINDOW_DAYS;

  const raw = argv[index + 1];
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`--days must be a positive number of days, got ${JSON.stringify(raw)}.`);
  }
  return days;
}

/**
 * Guards an explicit `--db <path>` before it reaches `openSharedStore`, same
 * reasoning as `classify-debate-termination.ts`'s `assertDbPathExists`:
 * `better-sqlite3` opens a nonexistent path by silently CREATING an empty
 * database file, which would make this report read a confident "0 debates"
 * off a typo'd path instead of failing loudly
 */
export function assertDbPathExists(dbPath: string): void {
  if (!existsSync(dbPath)) {
    throw new Error(`--db ${dbPath} does not exist — refusing to create a new database file.`);
  }
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined &&
  import.meta.url ===
    new URL(`file://${isAbsolute(invokedPath) ? invokedPath : resolve(invokedPath)}`).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const days = parseWindowDays(argv);
  const explicitDbIndex = argv.indexOf('--db');
  const explicitDbPath = explicitDbIndex === -1 ? undefined : argv[explicitDbIndex + 1];
  if (explicitDbIndex !== -1 && explicitDbPath === undefined) {
    throw new Error('--db requires a path argument.');
  }

  let dbPath: string;
  if (explicitDbPath !== undefined) {
    // An explicit path names its own file — the paper/live filename guard
    // below exists to protect the environment-resolved default, not this
    assertDbPathExists(explicitDbPath);
    dbPath = explicitDbPath;
  } else {
    const mode = resolveStoreMode();
    dbPath = sharedStorePath(mode);
    assertStorePathMatchesMode({ dbPath, mode });
  }
  const db = openSharedStore(dbPath);
  const store = new SqliteDebateLogStore(db);

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  console.log(formatFlipRateReport(computeFlipRate(store.listRoundVerdicts(from, to)), from, to));
}
