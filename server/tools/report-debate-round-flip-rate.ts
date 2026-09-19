import type { DebateRoundLogEntry, Direction } from '../pipeline/debate-engine/index.js';
import { SqliteDebateLogStore } from '../pipeline/debate-engine/index.js';
import { openSharedStore } from '../shared/store/index.js';
import { parseWindowDays, resolveDbPathFromArgv } from './cli-args.js';
import { isMainModule } from './cli-entrypoint.js';

export { assertDbPathExists, DEFAULT_WINDOW_DAYS, parseWindowDays } from './cli-args.js';

export interface FlipRateReport {
  total_debates: number;
  multi_round_debates: number;
  flips: number;
  flip_rate: number | null;
}

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

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const days = parseWindowDays(argv);
  const dbPath = resolveDbPathFromArgv(argv);
  const db = openSharedStore(dbPath);
  const store = new SqliteDebateLogStore(db);

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  console.log(formatFlipRateReport(computeFlipRate(store.listRoundVerdicts(from, to)), from, to));
}
