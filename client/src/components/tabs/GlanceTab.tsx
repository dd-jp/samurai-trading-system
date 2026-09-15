import type { VerdictRow } from '@contracts';
import type { EquitySample } from '../../hooks/useEquitySamples.ts';
import type { WireSnapshot } from '../../hooks/useSnapshot.ts';
import {
  formatClockUtc,
  formatCount,
  formatPercent,
  formatPrice,
  formatQty,
  formatSignedGbp,
  formatSignedPercent,
  formatSignedUsd,
  formatUsd,
  UNKNOWN,
} from '../../lib/format.ts';
import { deployedNotional, openRiskRow } from '../../lib/glance.ts';
import type { LedgerEntry } from '../../lib/ledger.ts';
import type { Selection } from '../../lib/resolve-trace.ts';
import {
  CONTROL_NO_EQUITY,
  OUTCOME_WORD,
  PNL_RATE_SOURCE_WORD,
  sideWord,
  stageName,
} from '../../lib/vocabulary.ts';
import { Seal } from '../Seal.tsx';
import { pnlTone } from '../StateWord.tsx';
import { Track } from '../Track.tsx';

export interface GlanceTabProps {
  snapshot: WireSnapshot;
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

/** "X% of the £1,000 book" — the same basis phrase beside both headline figures. */
function ofBook(fraction: number): string {
  return `${formatSignedPercent(fraction)} of the £1,000 book`;
}

function PnlCard({ snapshot, equitySamples }: Pick<GlanceTabProps, 'snapshot' | 'equitySamples'>) {
  const { pnl, arm } = snapshot;
  const isControl = arm === 'control';
  const equity = snapshot.providers.alpaca.balance?.equity ?? null;

  // `pnl` is `PnlHeadlineWire | null` on `useSnapshot.ts`'s `WireSnapshot` —
  // widened there (PR #1619 review, finding 1) because `CONTRACT_VERSION`'s
  // hash is deliberately shallow (top-level field names only, per
  // `contracts/snapshot.ts`), so a rename inside `PnlHeadlineWire.overall`/
  // `.today` moves nothing there and this component would otherwise
  // dereference straight into a shape it never checked. `null` is also what
  // an intermediary that stripped a build failure looks like. Either way it
  // must read as a named absence, never as £0.00 (AC).
  if (pnl == null) {
    return (
      <section className="panel" aria-label="P&L">
        <h2>P&amp;L</h2>
        <p className="empty-state">
          No P&amp;L headline on this snapshot — the server did not include one.
        </p>
      </section>
    );
  }

  const { overall, today } = pnl;
  // `rate_source` is a `Record` lookup, not a formatter call, so an
  // unrecognised value (the same nested-rename skew `isPnlHeadline` guards
  // above, one field `isPnlHeadline` doesn't check) needs its own fallback —
  // an unguarded lookup would interpolate the literal string "undefined".
  const rate = `at ${formatUsd(pnl.rate_usd_per_gbp)}/£, ${PNL_RATE_SOURCE_WORD[pnl.rate_source] ?? UNKNOWN}`;

  return (
    <section className="panel" aria-label="P&L">
      <h2>P&amp;L</h2>
      <div className="pnl-block">
        <h3>Overall</h3>
        <div className="big-row">
          <span className={`big ${pnlTone(overall.net_gbp)}`} data-field="pnl-overall">
            {formatSignedGbp(overall.net_gbp)}
          </span>
          <span className="muted">{ofBook(overall.net_pct_of_book)}</span>
        </div>
        <div className="figure-row">
          <div>
            <span className="label">Max drawdown</span>
            <span className="mono">{formatPercent(overall.max_drawdown_pct)}</span>
          </div>
          <div>
            <span className="label">Trades</span>
            <span className="mono">{formatCount(overall.trade_count)}</span>
          </div>
        </div>
      </div>
      <div className="pnl-block">
        <h3>
          Today <span className="muted small">(Europe/London calendar day)</span>
        </h3>
        <div className="big-row">
          <span className={`big ${pnlTone(today.net_gbp)}`} data-field="pnl-today">
            {formatSignedGbp(today.net_gbp)}
          </span>
          <span className="muted">{ofBook(today.net_pct_of_book)}</span>
        </div>
        <div className="figure-row">
          <div>
            <span className="label">Realized</span>
            <span className={`mono ${pnlTone(today.realized_gbp)}`}>
              {formatSignedGbp(today.realized_gbp)}
            </span>
          </div>
          <div>
            <span className="label">Unrealized</span>
            <span className={`mono ${pnlTone(today.unrealized_gbp)}`}>
              {formatSignedGbp(today.unrealized_gbp)}
            </span>
          </div>
          <div>
            <span className="label">Costs</span>
            <span className="mono muted">{formatSignedGbp(-today.costs_gbp)}</span>
          </div>
          <div>
            <span className="label">Trades</span>
            <span className="mono">{formatCount(today.trade_count)}</span>
          </div>
        </div>
      </div>
      <p className="muted small">{rate}</p>
      {isControl ? (
        <p className="empty-state">{CONTROL_NO_EQUITY}</p>
      ) : (
        <>
          <p className="muted">
            {equity === null ? 'Alpaca equity unavailable' : `Alpaca equity: ${formatUsd(equity)}`}
          </p>
          <EquitySparkline samples={equitySamples} />
        </>
      )}
    </section>
  );
}

function OpenRiskCard({ snapshot }: Pick<GlanceTabProps, 'snapshot'>) {
  const positions = snapshot.positions;
  const isControl = snapshot.arm === 'control';
  // Alpaca's balance is the LIVE broker's equity — reading it as the
  // control arm's denominator would render a live-arm-only figure under the
  // control view (dashboard-spec.md's arm selector rule; #1597). The
  // control's own open-position notional above still applies (`positions`
  // is arm-scoped, #1592), only the "of $equity" denominator is N/A.
  const equity = isControl ? null : (snapshot.providers.alpaca.balance?.equity ?? null);
  const deployed = deployedNotional(positions);
  return (
    <section className="panel" aria-label="Open risk">
      <h2>
        Open risk
        <span className="h2-note">
          {' '}
          · {formatUsd(deployed)} deployed
          {isControl
            ? ` · ${CONTROL_NO_EQUITY}`
            : equity === null
              ? ''
              : ` of ${formatUsd(equity)}`}
        </span>
      </h2>
      {positions.length === 0 ? (
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
