
import { isAbsolute, resolve } from 'node:path';
import { assertStorePathMatchesMode, LIVE_BOOK_SIZING_USD } from '../apps/orchestrator/index.js';
import {
  type ArmComparison,
  buildArmComparison,
  EXIT_CLASSES,
  SqliteArmComparisonSource,
} from '../pipeline/control-arm/index.js';
import { openSharedStore, resolveStoreMode, sharedStorePath } from '../shared/store/index.js';

export const DEFAULT_WINDOW_DAYS = 30;

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function formatArmComparison(comparison: ArmComparison): string {
  const lines: string[] = [
    'FALSIFIER ARM 2 — matched control vs the live arm (#753)',
    `  window: ${comparison.from.toISOString()} → ${comparison.to.toISOString()}`,
    `  basis:  $${comparison.basis.toFixed(2)} (the same denominator for both arms)`,
    '',
    '  arm      trades   realized      return   max drawdown   refused passes',
  ];

  for (const arm of [comparison.live, comparison.control]) {
    lines.push(
      `  ${arm.arm.padEnd(9)}${String(arm.trade_count).padStart(5)}` +
        `${arm.realized_pnl_net.toFixed(2).padStart(12)}` +
        `${pct(arm.return_pct).padStart(12)}` +
        `${pct(arm.max_drawdown_pct).padStart(15)}` +
        `${String(arm.refused_pass_count).padStart(17)}`,
    );
  }

  lines.push(
    '',
    '  Read the two numbers TOGETHER. A control that matched the live arm on return',
    '  while taking a deeper drawdown did not match it: doc 12 D4 rules out a',
    '  return-only reading against a risk-targeted stream. The control is the same',
    '  names, the same ADR-0018 D3 bracket and the same stop, entered on the',
    '  deterministic axis vote alone — so the difference between these rows is what',
    '  the debate layer bought, net of nothing else.',
    '',
    '  ONE KNOWN ASYMMETRY. The control arm has no debate rounds, so it is always',
    '  treated as decided (`converged: true`, axis-vote-decision.ts). On bars where',
    '  the live debate did NOT converge, the live arm takes its non-converged size',
    '  haircut and refuses a scale-in; the control takes neither. The arms therefore',
    '  differ in SIZE on those bars, not only in entry — read a return gap on a',
    '  non-converging stretch with that in mind.',
  );

  const refusedByArm = [comparison.live, comparison.control]
    .filter((arm) => arm.refused_pass_count > 0)
    .map((arm) => `${arm.arm}: ${arm.refused_pass_count} pass(es)`);
  if (refusedByArm.length > 0) {
    lines.push(
      '',
      `  NOTE: REFUSED rather than declined — ${refusedByArm.join(', ')}.`,
      '  A refused pass is one the arm could not value its book for at all (a dark or',
      '  stale mark), so it never reached a trading decision. Refused passes write',
      '  `trader_log` rows and no `closed_trades` row, so without this column a stretch',
      '  of them reads exactly like a quiet market (#1089, #1099). A long stretch means',
      '  the comparison is measuring fewer opportunities than the window suggests, on',
      '  the arm(s) named above.',
      '',
      '  Do NOT read `refused / trades` as a rate. The trade counts above are filtered',
      '  (`modelled_cost_charged`, the #1112 sizing regime) and this count is not, so',
      '  the two have different denominators by construction.',
    );
  }

  if (comparison.control.trade_count === 0) {
    lines.push(
      '',
      '  NOTE: the control arm closed no trades in this window.',
      comparison.control.refused_pass_count > 0
        ? '  It DID run — the refused-pass count above is proof — but on those passes it\n' +
            '  could not value its book. Check the mark source before reading this row as a\n' +
            '  control arm that found no setup.'
        : '  That is not evidence of anything until you have checked the control arm actually ran\n' +
            '  — an unbound `TickSteps.controlArm` produces the identical row, and so does a\n' +
            '  control arm that simply found no setup.',
    );
  }

  lines.push(...costBasisDropLines(comparison));

  if (comparison.live.trade_count === 0) {
    lines.push(
      '',
      '  NOTE: the live arm shows no trades in this window. Before reading that as',
      '  "the live arm closed nothing", check whether its rows were EXCLUDED: a',
      '  closed trade with `modelled_cost_charged = 0` is dropped from this',
      '  comparison unconditionally (#1121) because its fees were never brought onto',
      "  the control arm's cost basis. Two ways a row lands on 0, and BOTH are worth",
      '  checking: every live row closed before #1121 shipped was backfilled to 0, and',
      '  a row closed since then stamps 0 whenever a covered leg is missing its',
      '  submit-time cost snapshot (that capture is best-effort). So a window over',
      '  pre-#1121 history is EXPECTED to read 0 here — but so can a window of purely',
      '  recent closes. The COST-BASIS EXCLUSION table above answers which it was for',
      '  this window — a live `dropped` count larger than zero IS the exclusion. Either',
      '  way `closed_trades` still holds the live rows:',
      "    SELECT modelled_cost_charged, COUNT(*) FROM closed_trades WHERE arm = 'live'",
      '     AND closed_at > ? AND closed_at <= ? GROUP BY 1;',
    );
  }

  return lines.join('\n');
}

function costBasisDropLines(comparison: ArmComparison): string[] {
  const lines = [
    '',
    '  COST-BASIS EXCLUSION by exit class (#1546) — closed trades this comparison',
    '  KEPT and DROPPED, before the counts above were taken.',
    '',
    '  arm       exit class     kept   dropped   drop rate',
  ];

  for (const arm of [comparison.live, comparison.control]) {
    for (const exitClass of EXIT_CLASSES) {
      const { kept, dropped } = arm.cost_basis_drops[exitClass];
      const seen = kept + dropped;
      lines.push(
        `  ${arm.arm.padEnd(10)}${exitClass.padEnd(11)}${String(kept).padStart(7)}` +
          `${String(dropped).padStart(10)}` +
          `${(seen === 0 ? 'n/a' : pct(dropped / seen)).padStart(12)}`,
      );
    }
  }

  lines.push(
    '',
    '  Why the split exists. A live lot that exits on its stop or target is priced',
    "  by the ENTRY submission's single best-effort cost capture — the same one its",
    '  entry legs already need — while a lot that exits on a flatten needs that',
    "  capture AND the flatten submission's own. So a flatten close needs TWO",
    '  successful captures to be counted here and a protective close needs ONE, and',
    '  the flatten row above is expected to carry the higher drop rate. The',
    '  surviving live population is enriched in protective exits by exactly that',
    '  much (#1121 review round 2, #1301 round 2, #1546).',
    '',
    "  How to use it. Read the live arm's two drop rates against each other, not",
    "  against the control's — `SimulatedBrokerAdapter` prices its own fills at",
    '  write time, so a control lot never has a leg missing a `cost_breakdown`',
    '  and can only ever land in kept; migration 0049 backfilled every historic',
    '  control row to match, and migration 0037 (the submit-time capture) is a',
    '  live-arm-only concept the control arm never needed. The gap',
    "  between the live arm's two rates bounds how far this window's live",
    '  population is selected on exit type; equal rates mean the selection term',
    '  is zero for this window.',
    '',
    '  What a dropped row is NOT. It is not necessarily a failed capture: every',
    '  live row closed before #1121 shipped was backfilled to dropped, and a lot',
    '  opened before migration 0061 drops on a protective exit because its',
    '  protective leg genuinely carried no modelled estimate. This table does not',
    '  separate those from a capture that failed today.',
  );

  return lines;
}

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

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined &&
  import.meta.url ===
    new URL(`file://${isAbsolute(invokedPath) ? invokedPath : resolve(invokedPath)}`).href;

if (isMain) {
  const days = parseWindowDays(process.argv.slice(2));
  const mode = resolveStoreMode();
  const dbPath = sharedStorePath(mode);
  assertStorePathMatchesMode({ dbPath, mode });
  const db = openSharedStore(dbPath);

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const source = new SqliteArmComparisonSource(db);

  const window = source.getClosedTradeWindowBetween(from, to);

  console.log(
    formatArmComparison(
      buildArmComparison({
        trades: window.trades,
        cost_basis_drops: window.cost_basis_drops,
        refused_passes: source.getRefusedPassCountsBetween(from, to),
        from,
        to,
        basis: LIVE_BOOK_SIZING_USD,
      }),
    ),
  );
}
