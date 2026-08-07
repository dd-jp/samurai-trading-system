/**
 * The telemetry strip (dashboard-spec.md, "Layout" section 1): run mode, the
 * live-tick readout, the LLM burn meter against the ADR-0008 $50 cap, the
 * Alpaca balance, Polygon reachability, and the snapshot clock.
 *
 * Three rules from the spec are enforced here rather than left to CSS:
 *
 *  - **Status is a coloured word, never a dot**, and there are no pulsing
 *    indicators anywhere on this strip.
 *  - **Staleness is a label plus a border, not a disappearance.** Numbers keep
 *    their last values and are marked stale; a blank field reads as zero.
 *  - **A missing `mode` renders "mode unknown"**, never "paper". A missing
 *    field is ignorance, and displaying ignorance as the safe case is how an
 *    operator ends up watching live money on a page that says paper.
 */

import type { WireSnapshot } from '../hooks/useSnapshot.ts';
import { barWidth, formatClockUtc, formatPercent, formatUsd, UNKNOWN } from '../lib/format.ts';
import { providerStateWord } from '../lib/vocabulary.ts';

/** ADR-0008's spend cap, in USD. The burn meter's denominator. */
export const LLM_SPEND_CAP_USD = 50;

export interface TelemetryStripProps {
  snapshot: WireSnapshot | null;
  stale: boolean;
  /** `generated_at` of the last successful poll — what the stale label reports. */
  lastSuccessAt: string | null;
  /** Why the last poll failed, when one did. */
  error: string | null;
}

function ModeCell({ snapshot }: { snapshot: WireSnapshot | null }) {
  // Validated against the two literals rather than printed: the field is
  // untrusted like every other wire value, and a garbage `mode` must read as
  // ignorance, not as whatever string the server sent.
  const mode = snapshot?.mode;
  const known = mode === 'paper' || mode === 'live';
  return (
    <div className="telemetry-cell" data-field="mode">
      <span className="telemetry-label">Mode</span>
      <span className={known ? `telemetry-mode telemetry-mode-${mode}` : 'telemetry-mode-unknown'}>
        {known ? mode.toUpperCase() : 'mode unknown'}
      </span>
    </div>
  );
}

function LiveTickCell({ snapshot }: { snapshot: WireSnapshot | null }) {
  const tick = snapshot?.tick_status ?? null;
  const enteredAt = snapshot?.pipeline.live_entered_at ?? null;
  // Both fields come from `current_tick`, so they normally agree; `tick_status`
  // is preferred and `pipeline.live_trace_id` is the fallback, because the
  // theater's live-room glow is driven by the latter and the readout must not
  // disagree with the room that is glowing.
  const traceId = tick?.trace_id ?? snapshot?.pipeline.live_trace_id ?? null;
  return (
    <div className="telemetry-cell" data-field="live-tick">
      <span className="telemetry-label">Live tick</span>
      {tick === null ? (
        <span className="telemetry-value telemetry-muted">idle — no tick in progress</span>
      ) : (
        <span className="telemetry-value">
          {tick.instrument} · {tick.asset_class} · {tick.stage}
          {enteredAt !== null && (
            <span className="telemetry-since"> since {formatClockUtc(enteredAt)}</span>
          )}
        </span>
      )}
      <span className="telemetry-caveat">
        {traceId === null ? 'no live trace' : `trace ${traceId}`}
      </span>
    </div>
  );
}

function BurnMeterCell({ snapshot }: { snapshot: WireSnapshot | null }) {
  const allTime = snapshot?.llm_spend.all_time;
  const spent = allTime?.cost_usd;
  const fraction = spent === undefined ? Number.NaN : spent / LLM_SPEND_CAP_USD;
  const width = barWidth(fraction);
  const overCap = spent !== undefined && Number.isFinite(spent) && spent >= LLM_SPEND_CAP_USD;
  // A non-zero `unpriced_calls` means `cost_usd` counts tokens it could not
  // price, so the meter is a lower bound on consumption of the cap and must
  // say so rather than implying precision (spec, "Honest caveats").
  const unpriced = allTime?.unpriced_calls ?? 0;
  const label =
    width === null
      ? 'LLM budget used: unknown'
      : `LLM budget used: ${formatPercent(fraction)} of the $${LLM_SPEND_CAP_USD} cap`;

  return (
    <div className="telemetry-cell" data-field="burn-meter">
      <span className="telemetry-label">
        LLM burn · all time · {spent === undefined ? UNKNOWN : formatUsd(spent)} of $
        {LLM_SPEND_CAP_USD} cap
      </span>
      {width === null ? (
        <span className="telemetry-value telemetry-muted">
          no spend figure on this snapshot — meter not drawable
        </span>
      ) : (
        <span className="burn-meter" role="img" aria-label={label}>
          <span className={overCap ? 'burn-fill burn-fill-over' : 'burn-fill'} style={{ width }} />
        </span>
      )}
      <span className="telemetry-caveat">
        {overCap ? 'over cap · ' : ''}
        {unpriced > 0 ? `lower bound — ${unpriced} unpriced calls` : 'metered locally'}
      </span>
    </div>
  );
}

function AlpacaCell({ snapshot }: { snapshot: WireSnapshot | null }) {
  const tile = snapshot?.providers.alpaca;
  const word = tile === undefined ? null : providerStateWord(tile.state);
  const balance = tile?.balance ?? null;
  return (
    <div className="telemetry-cell" data-field="alpaca-balance">
      <span className="telemetry-label">Alpaca</span>
      {balance === null ? (
        // `balance` is null unless the probe is ok — a stale balance shown
        // next to a failed probe reads as current, which is worse than showing
        // nothing (spec).
        <span className="telemetry-value telemetry-muted">
          unavailable — {word ?? 'not polled'}
          {tile?.detail !== undefined && tile.detail !== '' ? ` · ${tile.detail}` : ''}
        </span>
      ) : (
        <span className="telemetry-value">
          equity {formatUsd(balance.equity)} · cash {formatUsd(balance.cash)} · buying power{' '}
          {balance.buying_power === null ? UNKNOWN : formatUsd(balance.buying_power)}
        </span>
      )}
    </div>
  );
}

function PolygonCell({ snapshot }: { snapshot: WireSnapshot | null }) {
  const tile = snapshot?.providers.polygon;
  const word = tile === undefined ? null : providerStateWord(tile.state);
  return (
    <div className="telemetry-cell" data-field="polygon">
      <span className="telemetry-label">Polygon</span>
      <span className={`telemetry-value provider-${tile?.state ?? 'unknown'}`}>
        {word ?? 'state not recognised'}
      </span>
      {tile !== undefined && tile.detail !== '' && (
        <span className="telemetry-caveat">{tile.detail}</span>
      )}
    </div>
  );
}

function ClockCell(props: { snapshot: WireSnapshot | null; stale: boolean; error: string | null }) {
  const { snapshot, stale, error } = props;
  const asOf = snapshot?.as_of ?? null;
  return (
    <div className="telemetry-cell telemetry-clock" data-field="snapshot-clock">
      <span className="telemetry-label">{stale ? 'Snapshot · STALE' : 'Snapshot'}</span>
      <span className="telemetry-value">{asOf === null ? UNKNOWN : formatClockUtc(asOf)}</span>
      {stale && (
        <span className="telemetry-caveat telemetry-stale-note" role="status">
          stale — last update {asOf === null ? UNKNOWN : formatClockUtc(asOf)}
          {error === null ? '' : ` · ${error}`}
        </span>
      )}
    </div>
  );
}

export function TelemetryStrip(props: TelemetryStripProps) {
  const { snapshot, stale, lastSuccessAt, error } = props;
  return (
    <section
      className={stale ? 'telemetry-strip telemetry-strip-stale' : 'telemetry-strip'}
      aria-label="Telemetry"
      data-stale={stale}
    >
      <span className="brand">
        <i aria-hidden="true">侍</i> SAMURAI <small>MISSION CONTROL</small>
      </span>
      <ModeCell snapshot={snapshot} />
      <LiveTickCell snapshot={snapshot} />
      <BurnMeterCell snapshot={snapshot} />
      <AlpacaCell snapshot={snapshot} />
      <PolygonCell snapshot={snapshot} />
      <span className="telemetry-spacer" />
      <ClockCell snapshot={snapshot} stale={stale} error={error} />
      {snapshot === null && (
        <span className="telemetry-caveat">
          {error === null
            ? 'waiting for the first snapshot'
            : `no snapshot yet — last attempt failed: ${error}`}
        </span>
      )}
      {snapshot !== null && lastSuccessAt !== null && (
        <span className="visually-hidden">
          Last successful poll {formatClockUtc(lastSuccessAt)}
        </span>
      )}
    </section>
  );
}
