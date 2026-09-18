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
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

interface Tile {
  label: string;
  value: string;
  tone?: 'warn';
  note?: string;
}

function profitFactorText(pf: MetricsSuiteWire['profit_factor']): string {
  switch (pf.kind) {
    case 'ratio':
      return formatFixed(pf.value);
    case 'no_losses':
      return 'no losing trades';
    case 'unreadable':
      return 'could not be read';
    default: {
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
  if (row.diverged) return 'diverged';
  if (isBelowTradeFloor(row)) return 'below-floor';
  return 'ok';
}

const ARM_TREND_CLASS: Readonly<Record<ArmVerdictState, string>> = {
  diverged: 'arm-trend-diverged',
  'below-floor': 'arm-trend-below-floor',
  ok: '',
};

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

function RefusedPassCount({ count }: { count: number | null }) {
  if (!count) {
    return null;
  }
  return <span className="muted"> · {formatCount(count)} refused</span>;
}

function RefusedPassNotTracked({ row }: { row: ArmComparisonRow }) {
  if (row.live.refused_pass_count !== null) {
    return null;
  }
  return <p className="muted small">refusals not tracked for this cycle</p>;
}

function dropSummary(arm: ArmPerformanceWire): string | null {
  const drops = arm.cost_basis_drops;
  if (drops === null) {
    return null;
  }
  const classes = EXIT_CLASSES_WIRE.map((exitClass) => {
    const { kept, dropped } = drops[exitClass];
    const seen = kept + dropped;
    const rate = seen === 0 ? 'n/a' : formatPercent(dropped / seen, 1);
    return `${exitClass} ${formatCount(dropped)}/${formatCount(seen)} (${rate})`;
  });
  return `${ARM_LABEL[arm.arm]} ${classes.join(', ')}`;
}

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
        return {formatPercent(arm.return_pct, 2)} · drawdown{' '}
        {formatPercent(arm.max_drawdown_pct, 2)} · {formatCount(arm.trade_count)} trades
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
          {
            comparisons.length > 1 ? (
              <ul className="arm-trend">
                {comparisons.map((row) => {
                  const state = armVerdictState(row);
                  return (
                    <li key={row.computed_at} className={ARM_TREND_CLASS[state]}>
                      <span className="mono muted">{formatDateUtc(row.computed_at)}</span>
                      <span className="mono">
                        live {formatPercent(row.live.return_pct, 2)} /{' '}
                        {formatPercent(row.live.max_drawdown_pct, 2)} dd
                      </span>
                      <span className="mono">
                        control {formatPercent(row.control.return_pct, 2)} /{' '}
                        {formatPercent(row.control.max_drawdown_pct, 2)} dd
                      </span>
                      {state === 'below-floor' ? <span>below floor</span> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null
          }
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
                  return {formatPercent(row.buy_and_hold_return_pct, 2)} · drawdown{' '}
                  {formatPercent(row.max_drawdown_pct, 2)} · {formatCount(row.observation_count)}{' '}
                  daily obs
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
  unreachable: 'No trace id reaches this trade — no recent Risk decision names its debate.',
  aged_out: 'Trace aged out of the 15-minute pipeline window; Risk decision and verdict remain.',
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
        <b className={`drawer-pnl mono ${tone}`}>{formatSignedUsd(trade.realized_pnl_net)}</b>
      </div>
      <dl className="kv-list" data-section="trade">
        <div className="kv">
          <dt>Position</dt>
          <dd>
            {sideWord(trade.side)} {formatQty(trade.filled_size)} · {trade.asset_class}
          </dd>
        </div>
        <div className="kv">
          <dt>Closed by</dt>
          <dd>{presentCloseReason(trade.close_reason).word}</dd>
        </div>
        <div className="kv">
          <dt>Held</dt>
          <dd className="mono">
            {formatClockUtc(trade.opened_at)} – {formatClockUtc(trade.closed_at)}
          </dd>
        </div>
        <div className="kv">
          <dt>Key</dt>
          <dd className="mono muted kv-truncate" title={trade.idempotency_key}>
            {trade.idempotency_key}
          </dd>
        </div>
      </dl>

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
          <dt>Entry</dt>
          <dd className="mono">{formatPrice(trade.entry_price)}</dd>
        </div>
        <div className="kv">
          <dt>Exit</dt>
          <dd className="mono">{formatPrice(trade.exit_price)}</dd>
        </div>
        <div className="kv">
          <dt>Notional</dt>
          <dd className="mono">{formatUsd(trade.filled_size * trade.entry_price)}</dd>
        </div>
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
      <p className="drawer-caveat">
        Spread sits inside fill prices; fees are the only itemised cost.
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
