/**
 * Locally-metered LLM spend (dashboard-spec.md stories 19, 20): three rolling
 * windows, per-decision cost at p50/p95, and LLM latency at p50/p95.
 *
 * Four things this panel is careful about, all of them spec rules rather than
 * taste:
 *
 *  - **This is not a balance and not an invoice.** It is what this bot spent,
 *    counted from the `usage` block on each response.
 *  - **Both honest caveats travel with the numbers**, whenever their counts are
 *    non-zero — not one of them, and not in a tooltip. `unpriced_calls` means
 *    `cost_usd` is a floor rather than a total; `unattributed_calls` means
 *    spend that is in the window total but in none of the per-debate figures.
 *  - **p50/p95, never a mean** — LLM latency is long-tailed and a mean over
 *    that tail reports a duration no debate actually experienced.
 *  - **The word "Anthropic" does not appear.** All LLM traffic moved to Nous
 *    in ADR-0009; the numbers were always right, only the label was wrong.
 */

import type { LlmSpendSummary, LlmSpendWindow } from '../../../../dashboard/types.ts';
import { formatCount, formatStageDuration, formatUsd, formatUsdPrecise } from '../../lib/format.ts';

export interface SpendPanelProps {
  spend: LlmSpendSummary | null;
}

const WINDOW_LABELS: readonly { key: keyof LlmSpendSummary; label: string }[] = [
  { key: 'last_24h', label: '24 hours' },
  { key: 'last_7d', label: '7 days' },
  { key: 'all_time', label: 'all time' },
];

function WindowCell({ label, window }: { label: string; window: LlmSpendWindow }) {
  return (
    <li className="spend-cell">
      <span className="stat-label">{label}</span>
      <b className="stat-value numeric">{formatUsd(window.cost_usd)}</b>
      <span className="stat-note">
        {formatCount(window.calls)} calls · {formatCount(window.input_tokens)} in /{' '}
        {formatCount(window.output_tokens)} out
      </span>
      <span className="stat-note">
        cache {formatCount(window.cache_read_input_tokens)} read /{' '}
        {formatCount(window.cache_creation_input_tokens)} written
      </span>
    </li>
  );
}

export function SpendPanel({ spend }: SpendPanelProps) {
  if (spend === null) {
    return (
      <section className="panel panel-spend" aria-label="LLM spend">
        <div className="panel-head">
          <h2>LLM spend</h2>
        </div>
        <p className="empty-state">
          No spend summary on this snapshot — the figure is metered locally into the
          <code> llm_spend</code> table, so an absent summary means the read failed, not that
          nothing was spent.
        </p>
      </section>
    );
  }

  const perDebate = spend.all_time.per_debate;
  const unpriced =
    spend.last_24h.unpriced_calls + spend.last_7d.unpriced_calls + spend.all_time.unpriced_calls;
  const unattributed =
    spend.last_24h.per_debate.unattributed_calls +
    spend.last_7d.per_debate.unattributed_calls +
    spend.all_time.per_debate.unattributed_calls;

  return (
    <section className="panel panel-spend" aria-label="LLM spend">
      <div className="panel-head">
        <h2>LLM spend</h2>
        <span className="panel-sub">metered locally — not a balance, not an invoice</span>
      </div>
      <ul className="spend-grid">
        {WINDOW_LABELS.map(({ key, label }) => (
          <WindowCell key={key} label={label} window={spend[key]} />
        ))}
      </ul>
      <dl className="kv-list">
        <div className="kv">
          <dt>debates metered (all time)</dt>
          <dd className="numeric">{formatCount(perDebate.debates)}</dd>
        </div>
        <div className="kv">
          <dt>cost / debate p50 · p95</dt>
          <dd className="numeric">
            {formatUsdPrecise(perDebate.cost_usd_p50, 4)} ·{' '}
            {formatUsdPrecise(perDebate.cost_usd_p95, 4)}
          </dd>
        </div>
        <div className="kv">
          <dt>LLM latency p50 · p95</dt>
          <dd className="numeric">
            {formatStageDuration(perDebate.llm_latency_ms_p50)} ·{' '}
            {formatStageDuration(perDebate.llm_latency_ms_p95)}
          </dd>
        </div>
      </dl>
      <p className="panel-sub">
        Latency is time spent inside LLM calls, not a debate's wall-clock elapsed time — the two
        differ whenever calls overlap or one is retried.
      </p>
      {unpriced > 0 && (
        <p className="caveat" data-caveat="unpriced">
          {formatCount(unpriced)} unpriced calls — their model is absent from the rate table, so
          they contribute tokens but no dollars. Every cost figure above is a{' '}
          <b>floor, not a total</b>, and so is the burn meter.
        </p>
      )}
      {unattributed > 0 && (
        <p className="caveat" data-caveat="unattributed">
          {formatCount(unattributed)} calls carry no <code>debate_id</code> — their spend is in the
          window totals above but in <b>none</b> of the per-debate figures.
        </p>
      )}
    </section>
  );
}
