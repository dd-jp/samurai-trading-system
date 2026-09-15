/**
 * #753's two-arm report: the live arm against falsifier arm 2, over one window,
 * with return AND drawdown for each — `npm run report:arms`.
 *
 * ## Why this exists as a command
 *
 * Acceptance criteria 4 and 5 are both worded about the *report*: both arms over
 * the same tape from the same start, and a return-only comparison that cannot be
 * produced. `buildArmComparison` makes the second true as a TYPE
 * (`max_drawdown_pct` is required, so no drawdown-less per-arm view exists), but
 * a builder nothing calls is this repo's dominant defect class — a tested
 * mechanism with no production caller. This file is the caller, and
 * `formatArmComparison` is where AC5 is discharged at the SURFACE: the renderer
 * cannot emit a return without the drawdown beside it, because both come off the
 * same row of the same table.
 *
 * ## Why a command rather than an API field
 *
 * Same reasoning `check-live-money-gates.ts` gives. The comparison is read by a
 * human deciding whether the debate layer earned its cost, on a cadence of days,
 * against whichever store a soak is actually running on. Threading it through
 * the wire contract, the snapshot and the dashboard would be a larger change
 * than #753 asks for, and none of it would make the numbers arrive sooner.
 *
 * ## KEPT after #971, deliberately — and what it is now FOR
 *
 * #971 did thread the comparison through the wire, the snapshot and the
 * dashboard, which retires the paragraph above as a *reason not to*. It does not
 * retire the command, because the two answer different questions:
 *
 *  - The dashboard panel shows what the **Feedback Loop measured** — FL's own
 *    persisted `arm_comparison_samples` rows, on FL's cadence, over FL's fixed
 *    30-day window. That is the point: the panel and the divergence alert must
 *    read the same row, or the page and the alert can disagree.
 *  - This command recomputes from `closed_trades` **ad hoc**, over any window
 *    the operator names, against any store path — including a store whose
 *    orchestrator never ran an FL cycle, or a historical window that predates
 *    the sample series entirely. FL cannot answer those, by construction.
 *
 * It is also the independent check on the panel. If this command and the panel
 * ever disagree over the same window, one of them is wrong, and having two
 * routes to the number is what makes that discoverable at all. Retiring it would
 * leave the persisted samples unfalsifiable by anything but reading SQL by hand.
 *
 * ## Testability
 *
 * `formatArmComparison` is pure and takes an `ArmComparison`. The store is
 * opened only under `isMain`, so nothing under `npm run test` touches `data/`.
 */

import { isAbsolute, resolve } from 'node:path';
import { assertStorePathMatchesMode } from '../apps/orchestrator/index.js';
import { LIVE_BOOK_SIZING_USD } from '../apps/orchestrator/paper-profile.js';
import {
  type ArmComparison,
  buildArmComparison,
  EXIT_CLASSES,
  SqliteArmComparisonSource,
} from '../pipeline/control-arm/index.js';
import { openSharedStore, resolveStoreMode, sharedStorePath } from '../shared/store/index.js';

/** How far back the report looks when no window is given on the command line */
export const DEFAULT_WINDOW_DAYS = 30;

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * The report, as text.
 *
 * Every arm gets ONE line carrying both figures. That shape is deliberate and it
 * is AC5's surface half: there is no branch here that prints a return without
 * the drawdown, and no flag that suppresses one column. `docs/research/
 * 12-edge-hypothesis-critique.md` D4 rules out return-only comparison against a
 * risk-targeted stream, and a renderer that *could* omit the drawdown would
 * re-open exactly that door however strict the type upstream is.
 */
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

  // #1099. Printed BEFORE the zero-trade note below, which reads differently
  // once a refusal count is on the page: a refused pass is positive evidence
  // the arm ran and could not act, which is the one thing that note otherwise
  // tells the operator to go and check by hand
  // Per arm, never a total: today only the control can refuse, but the count is
  // a per-arm field and a merged figure would name no arm on the day that
  // changes
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

  // #1121 review, finding 5: the automated reader (`evaluateArmDivergence`)
  // floors both arms at `min_trades_per_arm`, so a gutted arm reads as NO
  // VERDICT there. This report has no floor — it prints the count straight to
  // an operator, and the most likely reason the live count is 0 today is the
  // exclusion, not an idle arm: a live row with `modelled_cost_charged = 0` is
  // dropped by `SqliteArmComparisonSource`. Without this note that reads as
  // "the live arm closed nothing", which is false
  //
  // BOTH regimes, and staying in step with `modelledCostCharged`'s doc there
  // (#1121 review round 2, finding 4). The historic one is migration 0049's
  // backfill: every live row closed before #1121 stamps 0. The ONGOING one is
  // the derived writer — `captureSubmitSnapshot` is best-effort, so a lot that
  // closes today with a covered leg missing its `cost_breakdown` stamps 0 too
  // Naming only the historic regime let an operator running a post-fix window
  // conclude the note did not apply to them, which is the exact misreading it
  // exists to prevent
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

/**
 * #1546: the cost-basis exclusion's composition, printed UNCONDITIONALLY.
 *
 * Not gated on a non-zero drop count, unlike the refusal note above. An
 * all-zero table is the reading #1412 most needs and cannot otherwise get — "the
 * filter removed nothing from this window, so the trade counts are the whole
 * population" is a positive fact, and a section that vanished when it held would
 * make its absence mean either that or "this report predates the measurement".
 *
 * Per class, never a per-arm total: the whole point is that the two classes are
 * not excluded at the same rate, and a merged figure is exactly the number that
 * hides it.
 */
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

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined &&
  import.meta.url ===
    new URL(`file://${isAbsolute(invokedPath) ? invokedPath : resolve(invokedPath)}`).href;

if (isMain) {
  const days = parseWindowDays(process.argv.slice(2));
  const mode = resolveStoreMode();
  const dbPath = sharedStorePath(mode);
  // Same resolution the orchestrator uses, for the reason `place-soak-position`
  // gives: a report that opened a different database than the running process
  // writes would be confidently wrong rather than empty
  assertStorePathMatchesMode({ dbPath, mode });
  const db = openSharedStore(dbPath);

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const source = new SqliteArmComparisonSource(db);

  // #1546: trades and exclusion counts in one read, so the composition printed
  // below is the composition of the population printed above it
  const window = source.getClosedTradeWindowBetween(from, to);

  console.log(
    formatArmComparison(
      buildArmComparison({
        trades: window.trades,
        cost_basis_drops: window.cost_basis_drops,
        // #1099: the same window, from the same reader, in the same expression
        // — a refusal count taken over a different window would be a second
        // window to get wrong, which is what `SqliteArmComparisonSource`'s
        // header exists to prevent
        refused_passes: source.getRefusedPassCountsBetween(from, to),
        from,
        to,
        // The declared book, not live equity: both arms must be divided by the
        // SAME denominator or the two `return_pct` figures are not comparable,
        // and live equity is a per-arm quantity
        basis: LIVE_BOOK_SIZING_USD,
      }),
    ),
  );
}
