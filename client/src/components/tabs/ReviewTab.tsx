import type {
  AnalystPerformanceRow,
  ArmComparisonRow,
  ArmPerformanceWire,
  ClosedTradeRow,
  DebateRow,
  MetricsSuiteWire,
  OutsideBenchmarkRow,
  OutsideBenchmarkWire,
} from '@contracts';
import { EXIT_CLASSES_WIRE } from '@contracts';
import type { WireSnapshot } from '../../hooks/useSnapshot.ts';
import { debateDegradedGloss } from '../../lib/debate-termination.ts';
import {
  formatClockUtc,
  formatCount,
  formatDateUtc,
  formatFixed,
  formatHeld,
  formatPercent,
  formatPrice,
  formatQty,
  formatSignedR,
  formatSignedUsd,
  formatUsd,
  formatWhen,
} from '../../lib/format.ts';
import { resolveTrade, type TradeDetail, tradeDebate } from '../../lib/resolve-trace.ts';
import { presentCloseReason } from '../../lib/state-presentation.ts';
import { CONTROL_NO_ANALYSTS, CONTROL_NO_DEBATE, sideWord } from '../../lib/vocabulary.ts';
import { Seal } from '../Seal.tsx';
import { pnlTone, StateWord } from '../StateWord.tsx';
import { DebateSection, FillsList, GatesSection, Timeline } from '../TraceSections.tsx';
import { Track } from '../Track.tsx';

export interface ReviewTabProps {
  snapshot: WireSnapshot;
  /** The selected closed trade's `idempotency_key` */
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

interface Tile {
  label: string;
  value: string;
  tone?: 'warn';
  note?: string;
}

/**
 * `profit_factor`'s tile text (#1270). An exhaustive switch, not a lookup
 * table, because one variant (`ratio`) carries a payload the other two
 * don't — the `never` in `default` is what makes adding a fourth
 * `ProfitFactorWire` variant without a case here a compile error, catching
 * it at build time rather than here at render.
 *
 * `no_losses` reads as the plain fact it is — a window with wins and no
 * losses, the best possible outcome, not an absence — so it gets its own
 * words rather than `formatFixed`'s em dash, which this dashboard reserves
 * for "we don't know" (dashboard-spec.md: never a bare dash for a real
 * state). `unreadable` has a real production route: `useSnapshot.ts`'s
 * `profitFactorOf` maps a pre-#1270 server's bare number or
 * `JSON.stringify`-collapsed `null` here, since this client cannot tell
 * which non-finite value a `null` on that wire used to be.
 *
 * `default` returns rather than throws (review round 1, MAJOR) even though
 * `profitFactorOf` should make it unreachable: `main.tsx` mounts with no
 * error boundary, so a throw here is a white screen on a live-money
 * surface, not a bad tile — the same reasoning `Rail.tsx`'s
 * `drawdownReasonOf` already applies to its sibling field.
 */
function profitFactorText(pf: MetricsSuiteWire['profit_factor']): string {
  switch (pf.kind) {
    case 'ratio':
      return formatFixed(pf.value);
    case 'no_losses':
      return 'no losing trades';
    case 'unreadable':
      return 'could not be read';
    default: {
      // `never` still catches a missed case at compile time (delete a case
      // above and this line fails to build) even though the runtime arm
      // below degrades rather than throws (review round 1, MAJOR) — the
      // compile-time guarantee and the choice to never crash the tab are
      // independent, and this keeps both. The returned words match
      // `'unreadable'` above exactly (review round 2, NIT): raw JSON on an
      // operator's tile would be a second unreadable-looking failure mode
      // layered on top of the first
      const unreachable: never = pf;
      void unreachable;
      return 'could not be read';
    }
  }
}

function headlineTiles(metrics: MetricsSuiteWire): Tile[] {
  return [
    { label: 'Sharpe', value: formatFixed(metrics.sharpe), note: 'annualized, Lo-adjusted' },
    { label: 'Sortino', value: formatFixed(metrics.sortino) },
    { label: 'Max drawdown', value: formatPercent(metrics.max_drawdown, 2), tone: 'warn' },
    { label: 'Expectancy', value: formatFixed(metrics.expectancy), note: 'per trade, net' },
    { label: 'Profit factor', value: profitFactorText(metrics.profit_factor) },
    { label: 'Calmar', value: formatFixed(metrics.calmar) },
  ];
}

function restOfSuite(metrics: MetricsSuiteWire): Tile[] {
  return [
    { label: 'Skew', value: formatFixed(metrics.skew) },
    { label: 'Excess kurtosis', value: formatFixed(metrics.kurtosis), note: '0 = normal' },
    { label: 'Turnover', value: formatFixed(metrics.turnover) },
    { label: 'Exposure', value: formatPercent(metrics.exposure, 1) },
    { label: 'Observations', value: formatFixed(metrics.observations, 0) },
  ];
}

/**
 * Takes the suite, not `MetricsSuiteWire | null`: `metrics` is required and
 * non-nullable on the wire (`contracts/snapshot.ts`), and `hasWireShape`
 * rejects a payload where it is not a non-null object, so the "no metrics on
 * this snapshot" empty state this card used to carry could only ever be
 * reached through a null SNAPSHOT — the cold start `App.tsx` now states once,
 * for the whole page (#1520). A suite that ran and reported an unusable
 * figure is still named per tile below.
 */
function MetricsCard({ metrics }: { metrics: MetricsSuiteWire }) {
  return (
    <section className="card" aria-label="Metrics suite">
      <h3>Metrics suite</h3>
      <ul className="tile-grid">
        {headlineTiles(metrics).map((tile) => (
          <li key={tile.label} className="tile">
            <span className="label">{tile.label}</span>
            <b className={`tile-value mono${tile.tone === 'warn' ? ' warn' : ''}`}>{tile.value}</b>
            {tile.note !== undefined && <span className="muted small">{tile.note}</span>}
          </li>
        ))}
      </ul>
      <dl className="kv-list">
        {restOfSuite(metrics).map((tile) => (
          <div key={tile.label} className="kv">
            <dt>{tile.label}</dt>
            <dd className="mono">
              {tile.value}
              {tile.note !== undefined && <span className="muted"> · {tile.note}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <p className="muted small">daily suite — reported together, never one number</p>
    </section>
  );
}

const ARM_LABEL: Record<ArmPerformanceWire['arm'], string> = {
  live: 'Live arm',
  control: 'Control',
};

function isBelowTradeFloor(row: ArmComparisonRow): boolean {
  return (
    row.live.trade_count < row.min_trades_per_arm ||
    row.control.trade_count < row.min_trades_per_arm
  );
}

type ArmVerdictState = 'diverged' | 'below-floor' | 'ok';

function armVerdictState(row: ArmComparisonRow): ArmVerdictState {
  // `diverged` ALONE. `divergence_reason` is `null` exactly when `diverged` is
  // false (`contracts/snapshot.ts`), so a divergence carrying no reason is a
  // wire-contract violation — and requiring the reason here rendered it as
  // "Did not diverge", the one reassurance this panel exists to withhold
  if (row.diverged) return 'diverged';
  if (isBelowTradeFloor(row)) return 'below-floor';
  return 'ok';
}

const ARM_TREND_CLASS: Readonly<Record<ArmVerdictState, string>> = {
  diverged: 'arm-trend-diverged',
  'below-floor': 'arm-trend-below-floor',
  ok: '',
};

/** The one sentence the sample earns: FL's own divergence reason, the floor, or "did not diverge" */
function ArmVerdict({ row }: { row: ArmComparisonRow }) {
  const state = armVerdictState(row);
  if (state === 'diverged') {
    return (
      <p className="arm-verdict arm-diverged" data-arm-state="diverged">
        DIVERGED: {row.divergence_reason ?? 'no reason recorded (contract violation upstream)'}.
      </p>
    );
  }
  if (state === 'below-floor') {
    return (
      <p className="arm-verdict arm-below-floor" data-arm-state="below-floor">
        No verdict until {row.min_trades_per_arm} closed trades per arm (live {row.live.trade_count}
        , control {row.control.trade_count}).
      </p>
    );
  }
  return (
    <p className="arm-verdict arm-ok" data-arm-state="ok">
      Did not diverge: the control is not ahead of the live arm on both return and drawdown
      together.
    </p>
  );
}

/**
 * Per arm: a positive count is shown, `0` renders nothing (there is nothing
 * to say). `null` also renders nothing here — it is a ROW-level fact, not a
 * per-arm one (`RefusedPassNotTracked` below states it once), so folding it
 * into this per-arm span would print the same note under both arms.
 */
function RefusedPassCount({ count }: { count: number | null }) {
  if (!count) {
    return null;
  }
  return <span className="muted"> · {formatCount(count)} refused</span>;
}

/**
 * `refused_pass_count` is `null` on both arms or neither, never mixed
 * (#1099/#1483): `append` always writes both counts from one
 * `ArmComparisonSample`, whose `refused_pass_count` is a required `number`
 * on `ArmPerformance` — the only way either column reads back `null` is a
 * row from before migration 0057, which wrote neither. Checking `live` alone
 * is therefore checking the whole row, stated once rather than once per arm
 * — collapsing this into a `0` reading would show "no refusals" for a window
 * this row never actually measured, the exact silence #1483 exists to break.
 */
function RefusedPassNotTracked({ row }: { row: ArmComparisonRow }) {
  if (row.live.refused_pass_count !== null) {
    return null;
  }
  return <p className="muted small">refusals not tracked for this cycle</p>;
}

/**
 * `dropped/seen (rate)` per exit class for one arm — `null` when this row
 * predates migration 0065, which `CostBasisDrops` below states once for the
 * whole row rather than twice under two arms
 */
function dropSummary(arm: ArmPerformanceWire): string | null {
  const drops = arm.cost_basis_drops;
  if (drops === null) {
    return null;
  }
  const classes = EXIT_CLASSES_WIRE.map((exitClass) => {
    const { kept, dropped } = drops[exitClass];
    const seen = kept + dropped;
    // No rate for a class nothing closed — `0.0%` would assert one
    const rate = seen === 0 ? 'n/a' : formatPercent(dropped / seen, 1);
    return `${exitClass} ${formatCount(dropped)}/${formatCount(seen)} (${rate})`;
  });
  return `${ARM_LABEL[arm.arm]} ${classes.join(', ')}`;
}

/**
 * #1546: how the trade counts above were SELECTED. Rendered even when every
 * count is zero, unlike `RefusedPassCount` — "the exclusion removed nothing
 * from this window, so these counts are the whole population" is a positive
 * fact #1412 needs, and a block that vanished when it held would make its
 * absence mean either that or "this row predates the measurement". A row that
 * genuinely predates it says so instead.
 */
function CostBasisDrops({ row }: { row: ArmComparisonRow }) {
  const live = dropSummary(row.live);
  const control = dropSummary(row.control);
  if (live === null || control === null) {
    return <p className="muted small">cost-basis exclusion not counted for this cycle</p>;
  }
  return (
    <p className="muted small" data-cost-basis-drops="true">
      Dropped before these counts — {live} · {control}. A flatten close needs TWO successful
      submit-time cost captures to be counted, a protective close ONE, so the flatten rate is
      expected to be the higher of the two; the gap between an arm's own two rates is how far its
      population is selected on exit type.
    </p>
  );
}

function ArmLine({ arm }: { arm: ArmPerformanceWire }) {
  return (
    <li className="arm-row" data-arm={arm.arm}>
      <span>
        <b className="display">{ARM_LABEL[arm.arm]}</b>
        {arm.arm === 'control' ? <span className="muted"> indicator only, no LLM</span> : null}
      </span>
      <span className={`mono arm-pnl ${pnlTone(arm.realized_pnl_net)}`}>
        {formatSignedUsd(arm.realized_pnl_net)}
      </span>
      <span className="mono muted small">
        {`return ${formatPercent(arm.return_pct, 2)} · drawdown ${formatPercent(
          arm.max_drawdown_pct,
          2,
        )} · ${formatCount(arm.trade_count)} trades`}
        <RefusedPassCount count={arm.refused_pass_count} />
      </span>
    </li>
  );
}

function ArmCard({ comparisons }: { comparisons: readonly ArmComparisonRow[] }) {
  const latest = comparisons[0];
  return (
    <section className="card" aria-label="Arm comparison">
      <h3>Live vs matched control</h3>
      {latest === undefined ? (
        <p className="empty-state">
          The Feedback Loop has not computed a comparison yet. It runs on the daily feedback cycle —
          this is a missing measurement, not two flat arms.
        </p>
      ) : (
        <>
          <ul className="arm-list">
            <ArmLine arm={latest.live} />
            <ArmLine arm={latest.control} />
          </ul>
          <RefusedPassNotTracked row={latest} />
          <CostBasisDrops row={latest} />
          <p className="muted small">
            {formatDateUtc(latest.window_from)} to {formatDateUtc(latest.window_to)} · one window,
            both arms · basis {formatUsd(latest.basis)}
          </p>
          <ArmVerdict row={latest} />
          {/*
            #1180: `basis` converted from the declared GBP book to the account's
            currency, so a trend spanning that ship date steps by 1/1.27 on both
            arms at once. Each row is honest at its own denominator — the row
            carries the basis it was computed against — and neither arm's
            standing against the other changes, but the step is real and a
            reader should not read it as performance. It reaches the row
            colours too: `diverged` tests an absolute gap in return, so one
            unchanged USD pnl gap can mark a row diverged before the ship date
            and leave it plain after. No backfill is owed: unlike `sizing_capital_ceiling`,
            nothing compares this column across rows.
          */}
          {comparisons.length > 1 ? (
            <ul className="arm-trend">
              {comparisons.map((row) => {
                const state = armVerdictState(row);
                return (
                  <li key={row.computed_at} className={ARM_TREND_CLASS[state]}>
                    <span className="mono muted">{formatDateUtc(row.computed_at)}</span>
                    <span className="mono">
                      {`live ${formatPercent(row.live.return_pct, 2)} / ${formatPercent(
                        row.live.max_drawdown_pct,
                        2,
                      )} dd`}
                    </span>
                    <span className="mono">
                      {`control ${formatPercent(row.control.return_pct, 2)} / ${formatPercent(
                        row.control.max_drawdown_pct,
                        2,
                      )} dd`}
                    </span>
                    {state === 'below-floor' ? <span>below floor</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <p className="muted small">
            The control has no debate rounds, so it always trades where the indicator fires; the
            live arm can decline to. Read return and drawdown together — the wire reports both.
          </p>
        </>
      )}
    </section>
  );
}

const BENCHMARK_LABEL: Record<OutsideBenchmarkWire, string> = {
  spy: 'SPY',
  sixty_forty: '60/40 (SPY/AGG)',
};
const ALL_BENCHMARKS = Object.keys(BENCHMARK_LABEL) as OutsideBenchmarkWire[];

function BenchmarksCard({ benchmarks }: { benchmarks: readonly OutsideBenchmarkRow[] }) {
  const latest = benchmarks[0];
  const latestCycle = latest
    ? benchmarks.filter((row) => row.computed_at === latest.computed_at)
    : [];
  const measured = new Set(latestCycle.map((row) => row.benchmark));
  const missing = ALL_BENCHMARKS.filter((id) => !measured.has(id));
  return (
    <section className="card panel-secondary" aria-label="Outside benchmarks">
      <h3>Outside benchmarks</h3>
      <p className="muted small">
        secondary context, not the control — falsifier arm 2 is the matched control · return and
        drawdown
      </p>
      {latest === undefined ? (
        <p className="empty-state">
          The Feedback Loop has not measured an outside benchmark yet — a missing measurement, not a
          flat benchmark.
        </p>
      ) : (
        <>
          <ul className="benchmark-list">
            {latestCycle.map((row) => (
              <li key={row.benchmark} className="benchmark-row">
                <span>{BENCHMARK_LABEL[row.benchmark]}</span>
                <span className="mono muted small">
                  {`return ${formatPercent(row.buy_and_hold_return_pct, 2)} · drawdown ${formatPercent(
                    row.max_drawdown_pct,
                    2,
                  )} · ${formatCount(row.observation_count)} daily obs`}
                </span>
              </li>
            ))}
          </ul>
          {missing.length > 0 ? (
            <p className="muted small">
              Not measured this cycle: {missing.map((id) => BENCHMARK_LABEL[id]).join(', ')} —
              absent, not zero.
            </p>
          ) : null}
          <p className="muted small">
            Same window as the arm comparison. A benchmark is fully invested through every night
            while the book is flat by close, so the percentages share units but not a denominator.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * `analysts[]` is the Feedback Loop's per-analyst DEBATE attribution
 * (`getAnalystWeights`, unscoped by arm) — the control arm runs no debate,
 * so it earns no analyst its own weight or rolling R could belong to. Unlike
 * `risk_critics`/`verdicts`/`pipeline` (#1594), this read was not widened to
 * take `arm`, because there is nothing arm-scoped to widen it to: a control
 * row would have to attribute a trade to an analyst that never argued for it.
 * Showing the live arm's weights under the control view would be exactly the
 * live-arm-only leak dashboard-spec.md's arm selector rule forbids (#1597),
 * so this card reads the structural absence directly rather than rendering
 * `analysts[]` at all.
 */
function AnalystsCard({
  analysts,
  isControl,
}: {
  analysts: readonly AnalystPerformanceRow[];
  isControl: boolean;
}) {
  return (
    <section className="card" aria-label="Analysts">
      <h3>Analyst weights</h3>
      {isControl ? (
        <p className="empty-state">{CONTROL_NO_ANALYSTS}</p>
      ) : analysts.length === 0 ? (
        <p className="empty-state">
          No analyst weights on this snapshot — the Feedback Loop writes them after its first
          attribution cycle.
        </p>
      ) : (
        <ul className="analyst-list">
          {analysts.map((row) => {
            return (
              <li key={row.analyst_id} className="analyst-row">
                <span className="analyst-name">{row.analyst_id}</span>
                {Number.isFinite(row.weight) ? (
                  <Track
                    fraction={row.weight}
                    tone="cyan"
                    label={`${row.analyst_id} weight ${formatPercent(row.weight, 0)}`}
                  />
                ) : (
                  <span className="muted">weight not a number</span>
                )}
                <span className="mono analyst-weight">{formatPercent(row.weight, 0)}</span>
                <span className="mono muted small">
                  {formatSignedR(row.rolling_r)} over {row.window_days}d
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {!isControl && (
        <p className="muted small">
          Weight is the Feedback Loop's current trust; rolling R is attributed return over the
          window. Neither is a hit rate — the wire carries no per-analyst accuracy.
        </p>
      )}
    </section>
  );
}

function whyTaken(debate: DebateRow | undefined, isControl: boolean): string {
  if (isControl) return CONTROL_NO_DEBATE;
  if (debate === undefined) return 'debate not in the recent-debates window';
  const lead = [...debate.contributions].sort((a, b) => b.influence_score - a.influence_score)[0];
  const rounds = `${debate.direction} · ${debate.rounds} rounds`;
  const base =
    lead === undefined
      ? rounds
      : `${rounds} · ${lead.analyst_id} led (influence ${formatFixed(lead.influence_score, 2)})`;
  const gloss = debateDegradedGloss(debate);
  return gloss === null ? base : `${base} · ${gloss}`;
}

function TradeRow(props: {
  trade: ClosedTradeRow;
  debate: DebateRow | undefined;
  asOf: string;
  isControl: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { trade, debate, asOf, isControl, selected, onSelect } = props;
  const tone = pnlTone(trade.realized_pnl_net);
  const closeReason = presentCloseReason(trade.close_reason);
  // Same hook `TraceSections.tsx`'s `DebateSection` sets (#1080's
  // "only one renderer set the data-degraded hook" gap, docs/coding-
  // standards.md) — both renderers of the same `debateDegradedGloss` result
  // must expose it in the DOM, not just in this row's joined text
  const degraded = debate !== undefined && debateDegradedGloss(debate) !== null;
  return (
    <li>
      <button
        type="button"
        className={`trade-row${selected ? ' trade-row-selected' : ''}`}
        data-key={trade.idempotency_key}
        aria-pressed={selected}
        aria-label={`${trade.instrument}, ${sideWord(trade.side)}, ${
          closeReason.word
        }, ${formatSignedUsd(trade.realized_pnl_net)}`}
        onClick={onSelect}
      >
        <span className="mono muted">{formatWhen(trade.closed_at, asOf)}</span>
        <b className="display">{trade.instrument}</b>
        <span className="mono">{sideWord(trade.side)}</span>
        <span className="mono muted">{formatHeld(trade.opened_at, trade.closed_at)}</span>
        <StateWord state={closeReason} />
        <span className="muted trade-why" data-degraded={degraded ? 'true' : undefined}>
          {whyTaken(debate, isControl)}
        </span>
        <span className={`mono trade-pnl ${tone}`}>{formatSignedUsd(trade.realized_pnl_net)}</span>
      </button>
    </li>
  );
}

function TradesTable(props: ReviewTabProps) {
  const { snapshot, selectedKey, onSelect } = props;
  const trades = snapshot.closed_trades;
  const isControl = snapshot.arm === 'control';
  return (
    <section className="trades" aria-label="Closed trades">
      <div className="section-head">
        <h2>Closed trades</h2>
        <span className="muted small">
          {`${trades.length} on this snapshot · newest first · select a row for the full trace`}
        </span>
      </div>
      <div className="trade-row trade-header" aria-hidden="true">
        <span className="label">Closed</span>
        <span className="label">Instrument</span>
        <span className="label">Side</span>
        <span className="label">Held</span>
        <span className="label">Reason</span>
        <span className="label">Why it was taken</span>
        <span className="label trade-pnl">P&amp;L</span>
      </div>
      {trades.length === 0 ? (
        <p className="empty-state">
          No closed trade in the recent-history window. A round trip appears here once it flattens —
          this is a reading, not a missing panel.
        </p>
      ) : (
        <ul className="trade-list">
          {snapshot.closed_trades.map((trade) => (
            <TradeRow
              key={trade.idempotency_key}
              trade={trade}
              debate={tradeDebate(snapshot.debates, trade)}
              asOf={snapshot.as_of}
              isControl={isControl}
              selected={selectedKey === trade.idempotency_key}
              onSelect={() => onSelect(trade.idempotency_key)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

const NO_TIMELINE: Readonly<Record<NonNullable<TradeDetail['absence']['trace']>, string>> = {
  unreachable:
    'No trace id reaches this trade — the stage record keys on the Risk decision, and none in the recent-decisions window names its debate.',
  aged_out:
    'This trace has aged out of the 15-minute pipeline window; the Risk decision and verdict below are what remain.',
};

function TradeDrawer({ snapshot, selectedKey }: Pick<ReviewTabProps, 'snapshot' | 'selectedKey'>) {
  const detail = selectedKey === null ? null : resolveTrade(snapshot, selectedKey);
  if (detail === null) {
    return (
      <aside className="drawer" aria-label="Trade detail">
        <p className="empty-state">
          {selectedKey === null
            ? 'No trade selected — choose a closed trade to see why it was taken and how it ended.'
            : 'The selected trade is no longer in the recent-history window.'}
        </p>
      </aside>
    );
  }
  const { trade, verdict } = detail;
  const gross = trade.realized_pnl_net + trade.fees_total;
  const tone = pnlTone(trade.realized_pnl_net);
  const isControl = snapshot.arm === 'control';
  return (
    <aside className="drawer" aria-label="Trade detail" data-key={trade.idempotency_key}>
      <div className="drawer-head">
        {verdict !== undefined && <Seal outcome={verdict.status} />}
        <h2 className="display">{trade.instrument}</h2>
        <b className={tone}>{formatSignedUsd(trade.realized_pnl_net)}</b>
        <span className="mono muted drawer-trace">{trade.idempotency_key}</span>
      </div>
      <p className="drawer-line muted">
        {`${sideWord(trade.side)} ${formatQty(trade.filled_size)} · ${trade.asset_class} · ${
          presentCloseReason(trade.close_reason).word
        } · ${formatClockUtc(trade.opened_at)} to ${formatClockUtc(trade.closed_at)}`}
      </p>

      <h3>Why it was taken</h3>
      <DebateSection
        debate={detail.debate}
        inFlight={false}
        linkedBy={detail.debateJoin}
        isControl={isControl}
      />

      <h3>Stages</h3>
      {detail.cells !== null ? (
        <Timeline cells={detail.cells} />
      ) : (
        <p className="empty-state">{NO_TIMELINE[detail.absence.trace ?? 'unreachable']}</p>
      )}

      <h3>Gates and conditions</h3>
      <GatesSection
        riskCritic={detail.riskCritic}
        verdict={verdict}
        keyedBy={detail.riskCriticJoin}
        isControl={isControl}
      />

      <h3>P&amp;L breakdown</h3>
      <dl className="kv-list" data-section="pnl">
        <div className="kv">
          <dt>Gross</dt>
          <dd className={`mono ${pnlTone(gross)}`}>{formatSignedUsd(gross)}</dd>
        </div>
        <div className="kv">
          <dt>Fees</dt>
          <dd className="mono">{formatSignedUsd(-trade.fees_total)}</dd>
        </div>
        <div className="kv kv-total">
          <dt>Net</dt>
          <dd className={`mono ${tone}`}>{formatSignedUsd(trade.realized_pnl_net)}</dd>
        </div>
      </dl>
      <p className="muted small">
        {`Fees are the only cost the wire itemises; spread is inside the fill prices. Entry ${formatPrice(
          trade.entry_price,
        )} · exit ${formatPrice(trade.exit_price)} · ${formatUsd(
          trade.filled_size * trade.entry_price,
        )} notional at entry.`}
      </p>

      <h3>Fills</h3>
      <FillsList fills={detail.fills} />
    </aside>
  );
}

export function ReviewTab(props: ReviewTabProps) {
  const { snapshot } = props;
  return (
    <div className="review">
      <div className="review-main">
        <div className="section-head">
          <h2 className="display review-title">Review</h2>
          <span className="muted small">
            {`as of ${formatDateUtc(snapshot.as_of)} ${formatClockUtc(snapshot.as_of)}`}
          </span>
        </div>
        <div className="review-cards">
          <MetricsCard metrics={snapshot.metrics} />
          <div className="review-arms">
            <ArmCard comparisons={snapshot.arm_comparison} />
            <BenchmarksCard benchmarks={snapshot.outside_benchmarks} />
          </div>
          <AnalystsCard analysts={snapshot.analysts} isControl={snapshot.arm === 'control'} />
        </div>
        <TradesTable {...props} />
      </div>
      <TradeDrawer snapshot={snapshot} selectedKey={props.selectedKey} />
    </div>
  );
}
