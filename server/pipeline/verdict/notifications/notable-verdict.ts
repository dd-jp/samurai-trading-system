/**
 * Which verdicts are worth an operator alert (#465).
 *
 * ## Why a filter exists at all
 *
 * verdict-spec.md story 14 asks for fills **and no-gos** on the trade channel.
 * That was written before ADR-0007 removed the human approval gate and before
 * ADR-0008 set the cadence, and the two together change what it costs: ~296
 * instrument-passes/day, the large majority ending in a routine no-go, is
 * roughly **300 Telegram messages a day**.
 *
 * That is alert fatigue by construction — the same failure #342 split the
 * heartbeat into its own chat to avoid. An operator who mutes the channel on
 * day two loses the escalations that matter (orphaned go verdicts, stuck
 * unpriced fills, kill-threshold breaches) along with the noise, which is
 * strictly worse than never having alerted at all.
 *
 * ## The line, and why it falls here
 *
 * Under ADR-0007 the operator is **monitoring, not approving**. So the
 * question is not "what happened" but "what would I want to be interrupted
 * for":
 *
 * - **A `go`** — money moved. Always notable, and low-volume by nature: most
 *   ticks produce no trade at all.
 * - **A no-go the SYSTEM chose about itself** — `breaker`. The system halted
 *   its own trading, which is exactly the event an unattended run exists to
 *   surface.
 * - **A `human_rejected` / `timeout` no-go** — only reachable if the HITL dial
 *   is turned back, and if it ever is, an approval that expired unanswered is
 *   worth knowing about.
 *
 * Everything else — `staleness`, `drift`, `dedup`, `market_closed` — is the
 * pipeline working. A stale signal is not an incident; it is the staleness
 * gate doing its job, several hundred times a day.
 *
 * All of it still lands in `verdict_log` via `LoggingVerdict`, so nothing is
 * lost — this decides what INTERRUPTS someone, not what is recorded.
 */
import type { VerdictDecision } from '../types.js';

/**
 * No-go reasons worth an alert. Note this is an allowlist rather than a
 * denylist of the noisy ones: a `no_go_reason` added later should default to
 * silent, because the failure mode of a new reason quietly joining the alert
 * stream is the fatigue this filter exists to prevent, and the failure mode of
 * one quietly staying out is a line in `verdict_log` that someone reads later.
 */
const NOTABLE_NO_GO_REASONS: ReadonlySet<string> = new Set([
  'breaker',
  'human_rejected',
  'timeout',
]);

/** Whether this verdict should reach the trade channel. */
export function isNotableVerdict(decision: VerdictDecision): boolean {
  if (decision.status === 'go') return true;
  return decision.no_go_reason !== null && NOTABLE_NO_GO_REASONS.has(decision.no_go_reason);
}
