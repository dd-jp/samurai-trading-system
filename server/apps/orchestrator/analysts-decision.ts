/**
 * The `audit_log` decision word for a quorum skip (#1080), and the seam that
 * carries the one fact the tick runner cannot see for itself.
 *
 * `TickSteps.analysts` returns a bare `AnalystView[]`, so the runner's whole
 * evidence about a skipped stage is `views.length === 0`: a mandatory analyst
 * that missed its deadline on every attempt and one that threw on a data gap
 * wrote the same word at the same `info` level. `DEGRADED_DECISIONS`
 * (contracts/pipeline.ts) carries what that cost in the measured session.
 *
 * A relay rather than a widened `analysts` return type: `TickSteps` is the
 * primary test seam and the shape `buildControlAnalystsStep` and
 * `buildControlDebateStep` are annotated against, so widening the step's return
 * to a union would weaken the property those annotations exist to enforce, to
 * carry a field only the production adapter can populate. The precedent is
 * `AnalystViewRelay` (control-arm.ts), which threads the live pass's views to
 * the control arm the same way for the same reason.
 */
import type { QUORUM_SKIP_DECISIONS } from '../../../contracts/index.js';
import type { AnalystFailure } from '../../pipeline/analysts/index.js';

/**
 * One of the words `QUORUM_SKIP_DECISIONS` lists. Derived from that array so
 * this module cannot invent a fourth word the dashboard's lane-outcome
 * classifier has never heard of.
 */
type QuorumSkipDecision = (typeof QUORUM_SKIP_DECISIONS)[number];

/**
 * Why the analysts produced no views.
 *
 * `'fault'` rather than `'error'` (the `AnalystFailure.kind` spelling) because
 * this names the STAGE's outcome, not one persona's: a skip is a fault when the
 * mandatory failure behind it was anything other than a deadline.
 */
export type AnalystSkipKind = 'timeout' | 'fault';

/**
 * How many trace ids the relay will hold before evicting the oldest.
 *
 * Every entry is written and read inside one pass (`buildAnalystsStep` returns,
 * the runner records), so in the shipped path the map never holds more than the
 * passes in flight — `maxConcurrentInstruments`, currently 6. The cap exists for
 * the case this module cannot see: a caller that wires the writer and not the
 * reader, where an unbounded map would grow for the life of the process.
 */
const MAX_RETAINED_SKIPS = 64;

/**
 * The skip kind for a pass, written by the production analysts adapter and read
 * once by the tick runner.
 *
 * Reads are destructive. A kind describes ONE pass, and a stale entry read by a
 * later pass would mislabel it — precisely the confusion this seam exists to
 * remove — so it is better to fall back to the undifferentiated `quorum_skip`
 * than to report a kind that belongs to another tick.
 */
export class AnalystSkipKindRelay {
  readonly #kinds = new Map<string, AnalystSkipKind>();

  set(trace_id: string, kind: AnalystSkipKind): void {
    if (this.#kinds.size >= MAX_RETAINED_SKIPS) {
      const oldest = this.#kinds.keys().next();
      if (!oldest.done) this.#kinds.delete(oldest.value);
    }
    this.#kinds.set(trace_id, kind);
  }

  /** The kind for this pass, or `undefined` when none was recorded. Deletes it. */
  take(trace_id: string): AnalystSkipKind | undefined {
    const kind = this.#kinds.get(trace_id);
    this.#kinds.delete(trace_id);
    return kind;
  }
}

/**
 * The skip kind implied by a run's failures, or `undefined` when the run was
 * not a skip.
 *
 * MANDATORY failures only. An optional persona failing does not skip the tick
 * (`AnalystOrchestrator` shrinks the panel instead), so its failure kind says
 * nothing about why this stage produced no views.
 *
 * A timeout among them wins a mixed set: it is the failure that says a budget
 * has become unreachable, and a run reported as a fault because a second
 * mandatory persona also threw would hide exactly the condition #1080 is about.
 */
export function skipKindOf(
  skipped: boolean,
  failures: readonly AnalystFailure[],
): AnalystSkipKind | undefined {
  if (!skipped) return undefined;
  const mandatory = failures.filter((failure) => failure.role === 'mandatory');
  return mandatory.some((failure) => failure.kind === 'timeout') ? 'timeout' : 'fault';
}

/**
 * The decision word for a stage that produced no views.
 *
 * `undefined` — no relay wired, or nothing recorded for this pass — keeps the
 * original `quorum_skip`.
 *
 * For the backtest harness that is because no kind exists: it runs no
 * production adapter, so nothing ever writes one. The control arm is NOT that
 * case, and saying so would be wrong. `buildControlArmStep` relays the live
 * pass's views, so on a skipped bar the control arm's empty view set has
 * exactly the live arm's cause — it is unreported here, not absent.
 *
 * What keeps that from being a latent bug is structural, not conventional.
 * `controlSteps` wires no `analystSkipKind` reader today, but that is a member
 * nobody can be stopped from adding, so it is not what the safety rests on: the
 * two arms are KEY-separated. A control pass runs under
 * `${trace_id}${CONTROL_TRACE_SUFFIX}` (`control-arm.ts`), a key the production
 * adapter never writes. `take` is destructive, so a shared key would let
 * whichever arm ran first consume the kind and leave the other recording an
 * undifferentiated `quorum_skip` — this ticket's own defect, one arm over. With
 * the suffix, a reader wired into `controlSteps` by mistake reads `undefined`
 * and the live arm keeps its cause.
 *
 * The resulting asymmetry is deliberate and is AC6: on the same bar the live
 * lane writes `quorum_skip_timeout` at `warn` while the control lane writes
 * `quorum_skip` at `info`. The control arm has no analyst layer of its own, so
 * a named cause on its row would attribute the live arm's budget failure to the
 * arm that did not run it, and would break comparability with every control row
 * recorded before #1080.
 */
export function analystsSkipDecisionWord(kind: AnalystSkipKind | undefined): QuorumSkipDecision {
  if (kind === 'timeout') return 'quorum_skip_timeout';
  if (kind === 'fault') return 'quorum_skip_fault';
  return 'quorum_skip';
}
