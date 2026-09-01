/**
 * The risk-adjusted outside benchmarks — SPY and 60/40 (#981, under #636).
 *
 * The companion to `ArmComparisonPanel`, and deliberately the QUIETER of the
 * two. #981: the outside benchmark "must not be laid out so it reads as the
 * thing to beat."
 *
 * ## How "secondary" is expressed here, and why it is not just a smaller font
 *
 * Falsifier arm 2 is the primary matched control; an outside benchmark never
 * substitutes for it (CLAUDE.md Key Constraints; ADR-0014 amendment 2; ADR-0017
 * §Consequences). Four things carry that on this panel, and none of them is a
 * styling choice a redesign could quietly undo:
 *
 *  1. **There is no verdict line and no alert class.** The arm panel's most
 *     prominent element is `arm-divergence` — a claim, sometimes in alert
 *     styling. This panel has no equivalent, because the wire gives it nothing
 *     to make one from: `OutsideBenchmarkRow` carries no `diverged` field. A
 *     future author cannot add a "the benchmark won" banner without changing
 *     the contract first.
 *  2. **It states its own status in words**, in the sub-head and in the footer:
 *     context, not the control. Colour is never the only carrier of anything
 *     here (the page's rule).
 *  3. **It never renders the arms.** A side-by-side of a benchmark's return and
 *     an arm's would invite exactly the comparison the denominators do not
 *     support — see the footnote this panel prints.
 *  4. **`panel-secondary`** marks the whole section, so the design system can
 *     de-emphasise it in one place rather than per element.
 *
 * ## Return AND drawdown, on every branch — D4 again
 *
 * `docs/research/12-edge-hypothesis-critique.md` D4 binds the outside benchmarks
 * exactly as hard as it binds the arms (CLAUDE.md: outside benchmarks "report
 * return AND drawdown together"). `OutsideBenchmarkRow.max_drawdown_pct` is
 * required on the wire, and there is no branch below that prints a return
 * without its drawdown beside it, and no toggle that hides one.
 *
 * ## The denominators differ, and the panel says so
 *
 * The benchmark's return is a FULLY-INVESTED notional's — it holds through every
 * night. The live book is flat by close (ADR-0014), so its `return_pct` is
 * realized PnL on capital that is at risk only while a trade is on. Stacking the
 * two as though they were one column is #636's named failure mode, so the wire
 * gives them different NAMES (`buy_and_hold_return_pct` vs `return_pct`) and
 * this panel prints the caveat rather than assuming a reader will remember it.
 *
 * ## A benchmark that could not be measured is absent, and absence is stated
 *
 * FL persists nothing for a benchmark whose series it could not fetch — a zero
 * row would be a fabricated benchmark. So a cycle can legitimately carry SPY and
 * not 60/40, and this panel names the missing one as "not measured this cycle"
 * rather than dropping it silently or drawing it as 0.00%.
 */

import type { OutsideBenchmarkRow, OutsideBenchmarkWire } from '@contracts';
import { formatClockUtc, formatCount, formatPercent } from '../../lib/format.ts';

export interface OutsideBenchmarkPanelProps {
  /** Most-recently-computed first. Empty = the Feedback Loop has measured none. */
  benchmarks: readonly OutsideBenchmarkRow[];
}

/**
 * Every benchmark the system measures, so the panel can name one that is
 * MISSING from a cycle rather than only rendering what arrived. Mirrors the
 * server's `OUTSIDE_BENCHMARKS`; #636 settled the set.
 */
const BENCHMARK_LABEL: Record<OutsideBenchmarkWire, string> = {
  spy: 'SPY',
  sixty_forty: '60/40 (SPY/AGG)',
};

const ALL_BENCHMARKS = Object.keys(BENCHMARK_LABEL) as OutsideBenchmarkWire[];

/**
 * One benchmark's row. Takes the WHOLE row rather than individual numbers: a
 * props shape of `{ returnPct }` would be a drawdown-less view of a benchmark,
 * which is what the wire type refuses to let exist.
 */
function BenchmarkRow({ row }: { row: OutsideBenchmarkRow }) {
  return (
    <li className="benchmark-row">
      <span className="benchmark-name">{BENCHMARK_LABEL[row.benchmark]}</span>
      <span className="benchmark-return numeric">
        return {formatPercent(row.buy_and_hold_return_pct, 2)}
      </span>
      <span className="benchmark-drawdown numeric">
        max drawdown {formatPercent(row.max_drawdown_pct, 2)}
      </span>
      <span className="benchmark-observations numeric">
        {formatCount(row.observation_count)} daily obs
      </span>
    </li>
  );
}

export function OutsideBenchmarkPanel({ benchmarks }: OutsideBenchmarkPanelProps) {
  const latest = benchmarks[0];
  // The most recent cycle's rows only — a benchmark from an older cycle would
  // be over a DIFFERENT window, and mixing windows in one list is the thing
  // #636 calls noise rather than a comparison.
  const latestCycle = latest
    ? benchmarks.filter((row) => row.computed_at === latest.computed_at)
    : [];
  const measured = new Set(latestCycle.map((row) => row.benchmark));
  const missing = ALL_BENCHMARKS.filter((id) => !measured.has(id));

  return (
    <section
      className="panel panel-outside-benchmark panel-secondary"
      aria-label="Outside benchmarks"
    >
      <div className="panel-head">
        <h2>Outside benchmarks</h2>
        <span className="panel-sub">secondary context, not the control · return AND drawdown</span>
      </div>

      {latest === undefined ? (
        <p className="empty-state">
          The Feedback Loop has not measured an outside benchmark yet. It runs on the daily feedback
          cycle — this is a missing measurement, not a flat benchmark.
        </p>
      ) : (
        <>
          <p className="benchmark-window">
            {formatClockUtc(latest.window_from)} → {formatClockUtc(latest.window_to)} · the same
            window the arm comparison used
          </p>
          <ul className="benchmark-list">
            {latestCycle.map((row) => (
              <BenchmarkRow key={row.benchmark} row={row} />
            ))}
          </ul>
          {missing.length > 0 ? (
            <p className="benchmark-unmeasured">
              Not measured this cycle: {missing.map((id) => BENCHMARK_LABEL[id]).join(', ')} — the
              series was unavailable. Absent, not zero.
            </p>
          ) : null}
          <p className="benchmark-caveat">
            Secondary to the arm comparison, never a replacement for it: falsifier arm 2 is the
            matched control, and only that comparison can raise a divergence. These figures are also
            not directly comparable with the arms&apos; returns — a benchmark is fully invested
            through every night, while the book is flat by close, so the two percentages share their
            units but not their denominator.
          </p>
        </>
      )}
    </section>
  );
}
