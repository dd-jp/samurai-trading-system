import type { VerdictRow } from '@contracts';
import type { WireSnapshot } from '../../hooks/useSnapshot.ts';
import {
  formatClockUtc,
  formatPercent,
  formatPrice,
  formatQty,
  formatSignedPercent,
  formatSignedUsd,
  formatUsd,
  UNKNOWN,
} from '../../lib/format.ts';
import { deployedNotional, openRiskRow, pnlToday } from '../../lib/glance.ts';
import type { LedgerEntry } from '../../lib/ledger.ts';
import {
  OUTCOME_WORD,
  sideWord,
  stageName,
  WAITING_FOR_FIRST_SNAPSHOT,
} from '../../lib/vocabulary.ts';
import { Seal } from '../Seal.tsx';
import { pnlTone } from '../StateWord.tsx';
import { Track } from '../Track.tsx';
import type { Selection } from './LiveTab.tsx';

export interface EquitySample {
  observed_at: string | null;
  equity: number;
}

export interface GlanceTabProps {
  snapshot: WireSnapshot | null;
  equitySamples: readonly EquitySample[];
  ledger: readonly LedgerEntry[];
  verdictsByTrace: ReadonlyMap<string, VerdictRow>;
  /** Opens the trace on the Live tab. */
  onOpenTrace: (selection: Selection) => void;
}

const SPARK_WIDTH = 560;
const SPARK_HEIGHT = 60;
const MIN_SPARK_POINTS = 2;

function EquitySparkline({ samples }: { samples: readonly EquitySample[] }) {
  const values = samples.map((sample) => sample.equity).filter((value) => Number.isFinite(value));
  if (values.length < MIN_SPARK_POINTS) {
    return (
      <p className="empty-state">
        No equity line yet — it plots the Alpaca balance as the 60-second probe observes it, and the
        probe has reported {values.length === 0 ? 'no' : 'one'} distinct observation so far. The
        wire carries no historical equity curve.
      </p>
    );
  }
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * SPARK_WIDTH;
    const y = SPARK_HEIGHT - 3 - ((value - low) / span) * (SPARK_HEIGHT - 8);
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point}`).join(' ');
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const tone = last >= first ? 'gain' : 'loss';
  return (
    <figure className="spark-figure">
      <svg
        className={`spark spark-${tone}`}
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Alpaca equity observed this session: ${values.length} samples, ${formatUsd(
          first,
        )} to ${formatUsd(last)}`}
      >
        <path
          d={`${path} L${SPARK_WIDTH} ${SPARK_HEIGHT} L0 ${SPARK_HEIGHT}Z`}
          className="spark-fill"
        />
        <path d={path} className="spark-line" />
      </svg>
      <figcaption className="muted">
        Alpaca equity, {values.length} probe observations this session — not a historical curve.
      </figcaption>
    </figure>
  );
}

function PnlCard({ snapshot, equitySamples }: Pick<GlanceTabProps, 'snapshot' | 'equitySamples'>) {
  if (snapshot === null) {
    return (
      <section className="panel" aria-label="P&L today">
        <h2>P&amp;L today</h2>
        <p className="empty-state">{WAITING_FOR_FIRST_SNAPSHOT}</p>
      </section>
    );
  }
  const pnl = pnlToday(snapshot.positions, snapshot.closed_trades, snapshot.as_of);
  const equity = snapshot.providers.alpaca.balance?.equity ?? null;
  const tone = pnlTone(pnl.total);
  return (
    <section className="panel" aria-label="P&L today">
      <h2>P&amp;L today</h2>
      <div className="big-row">
        <span className={`big ${tone}`} data-field="pnl-today">
          {formatSignedUsd(pnl.total)}
        </span>
        <span className="muted">
          {equity === null
            ? 'Alpaca equity unavailable — no book figure to measure against'
            : `${formatSignedPercent(pnl.total / equity)} of ${formatUsd(equity)} equity`}
        </span>
      </div>
      <div className="figure-row">
        <div>
          <span className="label">Realized</span>
          <span className={`mono ${pnlTone(pnl.realized)}`}>{formatSignedUsd(pnl.realized)}</span>
        </div>
        <div>
          <span className="label">Unrealized</span>
          <span className={`mono ${pnlTone(pnl.unrealized)}`}>
            {formatSignedUsd(pnl.unrealized)}
          </span>
        </div>
        <div>
          <span className="label">Costs</span>
          <span className="mono muted">{formatSignedUsd(-pnl.costs)}</span>
        </div>
        <div>
          <span className="label">Trades</span>
          <span className="mono">
            {pnl.closedCount} closed · {pnl.openCount} open
          </span>
        </div>
      </div>
      <p className="muted small">
        Realized and costs are today's UTC closes on this snapshot's recent-history window;
        unrealized is every open position at its mark.
      </p>
      <EquitySparkline samples={equitySamples} />
    </section>
  );
}

function OpenRiskCard({ snapshot }: Pick<GlanceTabProps, 'snapshot'>) {
  const positions = snapshot?.positions ?? [];
  const equity = snapshot?.providers.alpaca.balance?.equity ?? null;
  const deployed = deployedNotional(positions);
  return (
    <section className="panel" aria-label="Open risk">
      <h2>
        Open risk
        {snapshot !== null && (
          <span className="h2-note">
            {' '}
            · {formatUsd(deployed)} deployed
            {equity === null ? '' : ` of ${formatUsd(equity)}`}
          </span>
        )}
      </h2>
      {snapshot === null ? (
        <p className="empty-state">{WAITING_FOR_FIRST_SNAPSHOT}</p>
      ) : positions.length === 0 ? (
        <p className="empty-state">
          No open position — nothing at risk. This is a reading from the store, not a missing panel.
        </p>
      ) : (
        <ul className="risk-list">
          {positions.map((position) => {
            const row = openRiskRow(position);
            const tone = pnlTone(position.unrealized_pnl);
            return (
              <li
                key={position.idempotency_key}
                className="risk-row"
                data-instrument={position.instrument}
              >
                <div className="risk-head">
                  <span>
                    <b className="display">{position.instrument}</b>{' '}
                    <span className="muted">
                      {sideWord(position.side)} {formatQty(position.filled_size)} ·{' '}
                      {formatUsd(row.notional)} · mark {formatPrice(position.mark_price)}
                    </span>
                  </span>
                  <span className={`mono ${tone}`}>{formatSignedUsd(position.unrealized_pnl)}</span>
                </div>
                {row.progress === null ? (
                  <p className="muted small">bracket has no width — stop equals target</p>
                ) : (
                  <Track
                    fraction={row.progress}
                    tone={tone}
                    thick
                    label={`${position.instrument}: mark ${formatPercent(
                      row.progress,
                      0,
                    )} of the way from stop to target`}
                  />
                )}
                <div className="risk-foot mono muted">
                  <span>
                    stop {formatPrice(position.stop)} ·{' '}
                    {Number.isFinite(row.stopDistance)
                      ? row.stopDistance < 0
                        ? `${formatPercent(-row.stopDistance)} through`
                        : `${formatPercent(row.stopDistance)} away`
                      : UNKNOWN}
                  </span>
                  <span>target {formatPrice(position.target)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function verdictSummary(entry: LedgerEntry, verdict: VerdictRow | undefined): string {
  const parts: string[] = [];
  if (verdict !== undefined) parts.push(verdict.reason);
  else if (entry.final_stage !== null) parts.push(`settled at ${stageName(entry.final_stage)}`);
  return parts.join(' · ');
}

function VerdictsCard(props: Pick<GlanceTabProps, 'ledger' | 'verdictsByTrace' | 'onOpenTrace'>) {
  const { ledger, verdictsByTrace, onOpenTrace } = props;
  return (
    <section className="panel" aria-label="Verdicts this session">
      <h2>Verdicts this session</h2>
      {ledger.length === 0 ? (
        <p className="empty-state">
          No settled decision observed yet — a row appears here the moment a tick settles while this
          page is open, and the currently-settled lanes seed it on first paint.
        </p>
      ) : (
        <ul className="verdict-list">
          {ledger.map((entry) => {
            const verdict = verdictsByTrace.get(entry.trace_id);
            const override = verdict?.hitl_override === true;
            const summary = verdictSummary(entry, verdict);
            const name = [
              entry.instrument,
              OUTCOME_WORD[entry.outcome],
              ...(override ? ['human override'] : []),
              ...(summary === '' ? [] : [summary]),
            ].join(', ');
            return (
              <li key={entry.trace_id}>
                <button
                  type="button"
                  className="verdict-row"
                  data-trace-id={entry.trace_id}
                  aria-label={name}
                  onClick={() =>
                    onOpenTrace({ instrument: entry.instrument, traceId: entry.trace_id })
                  }
                >
                  <Seal outcome={entry.outcome} />
                  <span className="mono muted">
                    {entry.settled_at === null ? UNKNOWN : formatClockUtc(entry.settled_at)}
                  </span>
                  <span className="display verdict-instrument">{entry.instrument}</span>
                  <span>
                    <b className={`outcome-${entry.outcome}`}>{OUTCOME_WORD[entry.outcome]}</b>
                    {override ? <span className="hitl">HITL</span> : null}
                    {summary === '' ? null : <span className="muted"> · {summary}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function GlanceTab(props: GlanceTabProps) {
  const { snapshot, equitySamples, ledger, verdictsByTrace, onOpenTrace } = props;
  return (
    <div className="glance">
      <div className="glance-top">
        <PnlCard snapshot={snapshot} equitySamples={equitySamples} />
        <OpenRiskCard snapshot={snapshot} />
      </div>
      <VerdictsCard ledger={ledger} verdictsByTrace={verdictsByTrace} onOpenTrace={onOpenTrace} />
    </div>
  );
}
