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
import type { WireSnapshot } from '../../hooks/useSnapshot.ts';
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
import {
  closedTradeByKey,
  debateById,
  fillsFor,
  laneFor,
  riskCriticForDebate,
  verdictFor,
} from '../../lib/trace.ts';
import { CLOSE_REASON_WORD, sideWord, WAITING_FOR_FIRST_SNAPSHOT } from '../../lib/vocabulary.ts';
import { Seal } from '../Seal.tsx';
import { closeReasonTone, pnlTone, StateWord } from '../StateWord.tsx';
import { DebateSection, FillsList, GatesSection, Timeline } from '../TraceSections.tsx';
import { Track } from '../Track.tsx';

export interface ReviewTabProps {
  snapshot: WireSnapshot | null;
  /** The selected closed trade's `idempotency_key`. */
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

interface Tile {
  label: string;
  value: string;
  tone?: 'warn';
  note?: string;
}

function headlineTiles(metrics: MetricsSuiteWire): Tile[] {
  return [
    { label: 'Sharpe', value: formatFixed(metrics.sharpe), note: 'annualized, Lo-adjusted' },
    { label: 'Sortino', value: formatFixed(metrics.sortino) },
    { label: 'Max drawdown', value: formatPercent(metrics.max_drawdown, 2), tone: 'warn' },
    { label: 'Expectancy', value: formatFixed(metrics.expectancy), note: 'per trade, net' },
    { label: 'Profit factor', value: formatFixed(metrics.profit_factor) },
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

function MetricsCard({ metrics }: { metrics: MetricsSuiteWire | null }) {
  return (
    <section className="card" aria-label="Metrics suite">
      <h3>Metrics suite</h3>
      {metrics === null ? (
        <p className="empty-state">
          No metrics on this snapshot — the Feedback Loop reports its suite daily, so an empty card
          means no daily run has landed yet.
        </p>
      ) : (
        <>
          <ul className="tile-grid">
            {headlineTiles(metrics).map((tile) => (
              <li key={tile.label} className="tile">
                <span className="label">{tile.label}</span>
                <b className={`tile-value mono${tile.tone === 'warn' ? ' warn' : ''}`}>
                  {tile.value}
                </b>
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
        </>
      )}
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
  if (row.diverged && row.divergence_reason !== null) return 'diverged';
  if (isBelowTradeFloor(row)) return 'below-floor';
  return 'ok';
}

const ARM_TREND_CLASS: Readonly<Record<ArmVerdictState, string>> = {
  diverged: 'arm-trend-diverged',
  'below-floor': 'arm-trend-below-floor',
  ok: '',
};

/** The one sentence the sample earns: FL's own divergence reason, the floor, or "did not diverge". */
function ArmVerdict({ row }: { row: ArmComparisonRow }) {
  const state = armVerdictState(row);
  if (state === 'diverged') {
    return (
      <p className="arm-verdict arm-diverged" data-arm-state="diverged">
        DIVERGED: {row.divergence_reason}.
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
          <p className="muted small">
            {formatDateUtc(latest.window_from)} to {formatDateUtc(latest.window_to)} · one window,
            both arms · basis £{formatFixed(latest.basis, 2)}
          </p>
          <ArmVerdict row={latest} />
          {comparisons.length > 1 ? (
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

function AnalystsCard({ analysts }: { analysts: readonly AnalystPerformanceRow[] }) {
  return (
    <section className="card" aria-label="Analysts">
      <h3>Analyst weights</h3>
      {analysts.length === 0 ? (
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
      <p className="muted small">
        Weight is the Feedback Loop's current trust; rolling R is attributed return over the window.
        Neither is a hit rate — the wire carries no per-analyst accuracy.
      </p>
    </section>
  );
}

function whyTaken(debate: DebateRow | undefined): string {
  if (debate === undefined) return 'debate not in the recent-debates window';
  const lead = [...debate.contributions].sort((a, b) => b.influence_score - a.influence_score)[0];
  const rounds = `${debate.direction} · ${debate.rounds} rounds`;
  return lead === undefined
    ? rounds
    : `${rounds} · ${lead.analyst_id} led (influence ${formatFixed(lead.influence_score, 2)})`;
}

function TradeRow(props: {
  trade: ClosedTradeRow;
  debate: DebateRow | undefined;
  asOf: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { trade, debate, asOf, selected, onSelect } = props;
  const tone = pnlTone(trade.realized_pnl_net);
  const reason = CLOSE_REASON_WORD[trade.close_reason];
  return (
    <li>
      <button
        type="button"
        className={`trade-row${selected ? ' trade-row-selected' : ''}`}
        data-key={trade.idempotency_key}
        aria-pressed={selected}
        aria-label={`${trade.instrument}, ${sideWord(trade.side)}, ${reason}, ${formatSignedUsd(
          trade.realized_pnl_net,
        )}`}
        onClick={onSelect}
      >
        <span className="mono muted">{formatWhen(trade.closed_at, asOf)}</span>
        <b className="display">{trade.instrument}</b>
        <span className="mono">
          {formatPrice(trade.entry_price)} → {formatPrice(trade.exit_price)}
        </span>
        <span className="mono muted">{formatHeld(trade.opened_at, trade.closed_at)}</span>
        <StateWord tone={closeReasonTone(trade.close_reason)}>{reason}</StateWord>
        <span className="muted trade-why">{whyTaken(debate)}</span>
        <span className={`mono trade-pnl ${tone}`}>{formatSignedUsd(trade.realized_pnl_net)}</span>
      </button>
    </li>
  );
}

function TradesTable(props: ReviewTabProps) {
  const { snapshot, selectedKey, onSelect } = props;
  const trades = snapshot?.closed_trades ?? [];
  return (
    <section className="trades" aria-label="Closed trades">
      <div className="section-head">
        <h2>Closed trades</h2>
        <span className="muted small">
          {snapshot === null
            ? WAITING_FOR_FIRST_SNAPSHOT
            : `${trades.length} on this snapshot · newest first · select a row for the full trace`}
        </span>
      </div>
      <div className="trade-row trade-header" aria-hidden="true">
        <span className="label">Closed</span>
        <span className="label">Instrument</span>
        <span className="label">In / out</span>
        <span className="label">Held</span>
        <span className="label">Reason</span>
        <span className="label">Why it was taken</span>
        <span className="label trade-pnl">P&amp;L</span>
      </div>
      {snapshot !== null && trades.length === 0 ? (
        <p className="empty-state">
          No closed trade in the recent-history window. A round trip appears here once it flattens —
          this is a reading, not a missing panel.
        </p>
      ) : (
        <ul className="trade-list">
          {trades.map((trade) => (
            <TradeRow
              key={trade.idempotency_key}
              trade={trade}
              debate={debateById(snapshot?.debates ?? [], trade.debate_id)}
              asOf={snapshot?.as_of ?? ''}
              selected={selectedKey === trade.idempotency_key}
              onSelect={() => onSelect(trade.idempotency_key)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TradeDrawer({ snapshot, selectedKey }: Pick<ReviewTabProps, 'snapshot' | 'selectedKey'>) {
  const trade =
    snapshot === null || selectedKey === null
      ? undefined
      : closedTradeByKey(snapshot.closed_trades, selectedKey);
  if (snapshot === null || trade === undefined) {
    return (
      <aside className="drawer" aria-label="Trade detail">
        <p className="empty-state">
          {snapshot === null
            ? WAITING_FOR_FIRST_SNAPSHOT
            : selectedKey === null
              ? 'No trade selected — choose a closed trade to see why it was taken and how it ended.'
              : 'The selected trade is no longer in the recent-history window.'}
        </p>
      </aside>
    );
  }
  const debate = debateById(snapshot.debates, trade.debate_id);
  const riskCritic = riskCriticForDebate(snapshot.risk_critics ?? [], trade.debate_id);
  const traceId = riskCritic?.trace_id ?? null;
  const verdict = verdictFor(snapshot.verdicts, traceId);
  const lane = laneFor(snapshot.pipeline, trade.instrument, traceId);
  const fills = fillsFor(snapshot.fills, trade.idempotency_key);
  const gross = trade.realized_pnl_net + trade.fees_total;
  const tone = pnlTone(trade.realized_pnl_net);
  return (
    <aside className="drawer" aria-label="Trade detail" data-key={trade.idempotency_key}>
      <div className="drawer-head">
        {verdict !== undefined && <Seal outcome={verdict.status} />}
        <h2 className="display">{trade.instrument}</h2>
        <b className={tone}>{formatSignedUsd(trade.realized_pnl_net)}</b>
        <span className="mono muted drawer-trace">{trade.idempotency_key}</span>
      </div>
      <p className="drawer-line muted">
        {sideWord(trade.side)} {formatQty(trade.filled_size)} · {trade.asset_class} ·{' '}
        {CLOSE_REASON_WORD[trade.close_reason]} · {formatClockUtc(trade.opened_at)} to{' '}
        {formatClockUtc(trade.closed_at)}
      </p>

      <h3>Why it was taken</h3>
      <DebateSection debate={debate} inFlight={false} linkedBy="debate_id" />

      <h3>Stages</h3>
      {lane !== undefined && lane.trace_id !== null && traceId !== null ? (
        <Timeline lane={lane} />
      ) : (
        <p className="empty-state">
          {traceId === null
            ? 'No trace id reaches this trade — the stage record keys on the Risk decision, and none in the recent-decisions window names its debate.'
            : 'This trace has aged out of the 15-minute pipeline window; the Risk decision and verdict below are what remain.'}
        </p>
      )}

      <h3>Gates and conditions</h3>
      <GatesSection riskCritic={riskCritic} verdict={verdict} keyedBy="debate" />

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
        Fees are the only cost the wire itemises; spread is inside the fill prices. Entry{' '}
        {formatPrice(trade.entry_price)} · exit {formatPrice(trade.exit_price)} ·{' '}
        {formatUsd(trade.filled_size * trade.entry_price)} notional at entry.
      </p>

      <h3>Fills</h3>
      <FillsList fills={fills} />
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
            {snapshot === null
              ? WAITING_FOR_FIRST_SNAPSHOT
              : `as of ${formatDateUtc(snapshot.as_of)} ${formatClockUtc(snapshot.as_of)}`}
          </span>
        </div>
        <div className="review-cards">
          <MetricsCard metrics={snapshot?.metrics ?? null} />
          <div className="review-arms">
            <ArmCard comparisons={snapshot?.arm_comparison ?? []} />
            <BenchmarksCard benchmarks={snapshot?.outside_benchmarks ?? []} />
          </div>
          <AnalystsCard analysts={snapshot?.analysts ?? []} />
        </div>
        <TradesTable {...props} />
      </div>
      <TradeDrawer snapshot={snapshot} selectedKey={props.selectedKey} />
    </div>
  );
}
