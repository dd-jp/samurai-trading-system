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
 *    Each count is `all_time`'s and names that window, because the three
 *    windows are NESTED (24h ⊂ 7d ⊂ all time) and adding them counts the same
 *    call up to three times (#606).
 *  - **p50/p95, never a mean** — LLM latency is long-tailed and a mean over
 *    that tail reports a duration no debate actually experienced.
 *  - **The word "Anthropic" does not appear.** All LLM traffic moved to Nous
 *    in ADR-0009; the numbers were always right, only the label was wrong.
 */

import type { LlmSpendSummary, LlmSpendWindow } from '@contracts';
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
  // Both counts come from `all_time` ALONE (#606 item 1). The three windows are
  // nested — `SqliteQueryStore.getLlmSpend` bounds `last_24h`/`last_7d` by
  // timestamp and leaves `all_time` open-ended — so summing them counted the
  // same unpriced call two or three times. A caveat exists so a spend figure
  // cannot read as more complete than it is; one that inflates its own count
  // is the honesty convention lying. `all_time` is the superset, so it is the
  // truthful total, and the wording names the window it belongs to. It is also
  // the window the burn meter's caveat already reports, so the strip and this
  // panel now quote the same number.
  const unpriced = spend.all_time.unpriced_calls;
  const unattributed = spend.all_time.per_debate.unattributed_calls;

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
      {/*
        "Every cost figure above" is deliberately WIDER than the count beside
        it: if all of the unpriced calls are older than seven days, `last_24h`
        is exact and only `all_time` is a floor. Over-scoping the caveat is the
        safe direction under the honesty convention — the reader is told a
        figure may be incomplete when it happens to be exact, never the reverse
        — and the alternative, a per-window caveat, would print three of these
        and still say nothing the operator can act on differently.
      */}
      {unpriced > 0 && (
        <p className="caveat" data-caveat="unpriced">
          {formatCount(unpriced)} unpriced calls (all time) — their model is absent from the rate
          table, so they contribute tokens but no dollars. Every cost figure above is a{' '}
          <b>floor, not a total</b>, and so is the burn meter.
        </p>
      )}
      {unattributed > 0 && (
        <p className="caveat" data-caveat="unattributed">
          {formatCount(unattributed)} calls (all time) carry no <code>debate_id</code> — their spend
          is in the window totals above but in <b>none</b> of the per-debate figures.
        </p>
      )}
    </section>
  );
}
