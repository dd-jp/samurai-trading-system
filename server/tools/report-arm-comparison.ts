/**
 * #753's two-arm report: the live arm against falsifier arm 2, over one window,
 * with return AND drawdown for each — `yarn report:arms`.
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
 * opened only under `isMain`, so nothing under `yarn test` touches `data/`.
 */

import { isAbsolute, resolve } from 'node:path';
import { assertStorePathMatchesMode } from '../apps/orchestrator/index.js';
import { LIVE_BOOK_GBP } from '../apps/orchestrator/paper-profile.js';
import {
  type ArmComparison,
  buildArmComparison,
  SqliteArmComparisonSource,
} from '../pipeline/control-arm/index.js';
import { openSharedStore, resolveStoreMode, sharedStorePath } from '../shared/store/index.js';

/** How far back the report looks when no window is given on the command line. */
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
    `  basis:  £${comparison.basis.toFixed(2)} (the same denominator for both arms)`,
    '',
    '  arm      trades   realized      return   max drawdown',
  ];

  for (const arm of [comparison.live, comparison.control]) {
    lines.push(
      `  ${arm.arm.padEnd(9)}${String(arm.trade_count).padStart(5)}` +
        `${arm.realized_pnl_net.toFixed(2).padStart(12)}` +
        `${pct(arm.return_pct).padStart(12)}` +
        `${pct(arm.max_drawdown_pct).padStart(15)}`,
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

  if (comparison.control.trade_count === 0) {
    lines.push(
      '',
      '  NOTE: the control arm closed no trades in this window. That is not evidence',
      '  of anything until you have checked the control arm actually ran — an unbound',
      '  `TickSteps.controlArm` produces the identical row.',
    );
  }

  return lines.join('\n');
}

/** Parses `--days N`; anything else is rejected rather than silently defaulted. */
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
  // writes would be confidently wrong rather than empty.
  assertStorePathMatchesMode({ dbPath, mode });
  const db = openSharedStore(dbPath);

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  console.log(
    formatArmComparison(
      buildArmComparison({
        trades: new SqliteArmComparisonSource(db).getClosedTradesBetween(from, to),
        from,
        to,
        // The declared book, not live equity: both arms must be divided by the
        // SAME denominator or the two `return_pct` figures are not comparable,
        // and live equity is a per-arm quantity.
        basis: LIVE_BOOK_GBP,
      }),
    ),
  );
}
