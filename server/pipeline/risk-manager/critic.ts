/**
 * The risk critic's PRODUCER (#957) — check-pipeline step 7's missing half,
 * decided by [#955](https://github.com/dd-jp/samurai-trading-system/issues/955)
 * under map #513 and specified by [ADR-0003](../../../docs/adr/0003-risk-manager-critic-layer.md)
 * plus `docs/specs/risk-manager-spec.md` ("Module: Risk Critic").
 *
 * ## The seam, and why the LLM lives HERE
 *
 * `RiskManagerImpl.evaluate()` is a pure, synchronous function and must stay
 * one (#642, PR #779): it consumes a critic verdict as pre-built data on
 * `RiskInput.critic`, exactly as it consumes `cii` and `correlation`, and can
 * never tell whether that value came from a model, a replayed log row or a
 * fixture. Everything model-shaped — the prompt, the call, the timeout, the
 * spend meter, the persistence — is in this file, and it runs BEFORE
 * `evaluate()` is called (see `buildRiskStep` in
 * `apps/orchestrator/production/direct-bind.ts`).
 *
 * ## What it is for
 *
 * Narrative/qualitative risk ONLY — the thing the six mechanical steps
 * structurally cannot express (ADR-0003 §1, #955's resolution). Position caps,
 * exposure caps, the deployment envelope, the pairwise-correlation
 * concentration check and the circuit breakers are exhaustively quantitative
 * and none of them reasons about a trade's THESIS. The canonical catch is
 * several open positions quietly levered to the same macro catalyst with no
 * shared price history yet for the correlation check to see.
 *
 * One pass, framed as "argue why this trade should be trimmed or rejected".
 * Not a 3-persona debate (ADR-0003 §4 — Stage 3 already spends that budget)
 * and no rebuttal round (§5).
 *
 * ## Cadence and cost
 *
 * Per VIABLE ENTRY intent: the caller runs `evaluate()` once with no verdict,
 * and only consults the critic when that dry run actually reached step 7 —
 * i.e. the intent survived the exit bypass, the unvalued-book refusal, the
 * breaker gate and the `min_viable_size` reject. At ADR-0016/0017's trade
 * counts that is ~1-2 calls/day, ~$1/yr at the measured $0.0015/call, so
 * #955 accepted it with NO critic-specific cap. It is still checked against
 * ADR-0008's overall `SpendCap` before dialling — "no second cap" is not "no
 * cap", and a run that has exhausted its ceiling must not open a new billed
 * surface here.
 *
 * ## Determinism
 *
 * ADR-0003 §2: `live`/`paper` call the model and PERSIST the verdict keyed by
 * `debate_id`; `backtest` REPLAYS the logged verdict and never calls anything.
 * That is a determinism constraint, not a cost one — a live call inside a
 * replayed path would void Stage 2's PBO/DSR/MinBTL statistics. The backtest
 * producer therefore holds no LLM client at all, so there is no code path by
 * which it could fall back to one, and a `debate_id` with no logged row
 * replays as NO VERDICT rather than as a fresh call.
 *
 * ## Failure posture: fail-open, by record
 *
 * Every failure — a spend-cap refusal, a provider error, a timeout, an
 * unreadable answer, or a PERSISTENCE failure after a real answer — yields
 * `undefined`, which leaves `evaluate()` on its
 * existing `critic === undefined` path and its explicit
 * `risk_critic: skipped` reason (`index.ts`). The mechanical steps remain the
 * safety net (ADR-0003 Consequences; #640's fail-open precedent). Where the
 * log is reachable a row IS still written, with `verdict: 'unavailable'`, so
 * the failure is auditable and so a later backtest replays the same "no
 * verdict" input the live run had — `unavailable` maps back to `undefined` on
 * the way out, in both producers, for exactly that reason.
 *
 * The persistence case is the one that reads as a special case and is not.
 * An un-persisted verdict has NO row for its `debate_id`, so the backtest that
 * replays this decision sees "no verdict" no matter what the live run did with
 * it. Acting on it live would therefore make the live decision unreproducible
 * by construction — the same-code-path-live-and-replay invariant ADR-0003 §2
 * and `docs/specs/risk-manager-spec.md` state, broken silently and only for
 * the trades taken while the store was down. So a write failure degrades to
 * the same fail-open `undefined` as any other producer failure: the decision
 * runs on the mechanical steps, and live and replay agree on what step 7 saw.
 */

import type { Logger, OrderIntent } from '../../shared/index.js';
import type { LlmClient, SpendCap } from '../debate-engine/index.js';
import { BARE_JSON_INSTRUCTION, unwrapFencedJson, wrapUntrusted } from '../debate-engine/index.js';
import type { RiskCriticStore, RiskCriticVerdict } from './types.js';

/**
 * The whole critic's wall-clock budget, retries included.
 *
 * This call is AWAITED in front of an order the tick is about to submit, which
 * is the hazard `direct-bind.ts`'s Telegram comment (#710) spells out: a
 * black-holed provider must not hold the intent. The injected `LlmClient` is
 * the shared one, whose own timeout and retry config belong to the debate
 * (3 attempts over a 60s wire timeout ~ minutes), so the bound has to be
 * imposed HERE rather than inherited. 10s is comfortably inside the debate's
 * own 15s crypto budget for a single call against a model measured at ~2.9s
 * p50 (`shared/llm/nous-config.ts`), and expiring costs only the critic: the
 * decision continues on the mechanical steps with `risk_critic: skipped`.
 */
export const DEFAULT_CRITIC_BUDGET_MS = 10_000;

/**
 * NOTE on the response budget: `max_tokens` belongs to the injected
 * `LlmClient`'s own config (`AnthropicLlmClientConfig`), which this producer
 * shares with the debate rather than re-declaring. A trim/reject argument is a
 * short paragraph, so the debate's budget is comfortably enough; the prompt
 * asks for one or two sentences, and `MAX_REASONING_CHARS` bounds what is kept
 * regardless of what comes back.
 */

/**
 * Cap on the model's own text before it lands in `RiskDecision.reasons` and
 * from there in `risk_log.reasons_json`. An unbounded string from a provider
 * has no business sizing a durable audit row.
 */
const MAX_REASONING_CHARS = 400;

/** One held position, as the critic sees it. */
export interface CriticHeldPosition {
  instrument: string;
  notional: number;
}

/** Everything the critic is shown. See `renderCriticPrompt` for the wire form. */
export interface RiskCriticRequest {
  trace_id: string;
  intent: OrderIntent;
  /** Book context — the co-catalyst read ADR-0003 §1 names as the blind spot. */
  portfolio: {
    equity: number;
    gross_exposure: number;
    held: readonly CriticHeldPosition[];
  };
  asOf: Date;
}

/**
 * The seam `buildRiskStep` calls. `undefined` means "no verdict" and is always
 * safe: the pipeline records `risk_critic: skipped` and proceeds on the
 * mechanical steps.
 */
export interface RiskCriticProducer {
  produce(request: RiskCriticRequest): Promise<RiskCriticVerdict | undefined>;
}

/** `unavailable` is persisted for audit but never handed to `evaluate()` — see the module header. */
function toDecisionInput(verdict: RiskCriticVerdict): RiskCriticVerdict | undefined {
  return verdict.verdict === 'unavailable' ? undefined : verdict;
}

function unavailable(reason: string): RiskCriticVerdict {
  return { verdict: 'unavailable', max_notional: null, reasoning: reason };
}

function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The prompt. Deliberately narrow: the critic is told what the mechanical
 * steps already cover so it does not spend its one pass re-deriving an
 * exposure cap, and it is told that "pass" is a full answer — an adversarial
 * frame with no way to say "nothing here" manufactures objections.
 *
 * The book context is wrapped by `wrapUntrusted` even though none of it is
 * ingested free text today: instrument ids come from a pool file, and the one
 * cheap guarantee worth keeping is that no data block can ever read as an
 * instruction (#208).
 */
export function renderCriticPrompt(request: RiskCriticRequest): string {
  const { intent, portfolio } = request;
  const notional = intent.size * intent.entry;
  const held =
    portfolio.held.length === 0
      ? 'none'
      : portfolio.held
          .map((position) => `${position.instrument} (notional ${position.notional})`)
          .join(', ');

  return [
    'You are a risk critic on a live-money intraday trading system. Argue why the',
    'proposed trade below should be TRIMMED or REJECTED. Restrict yourself to',
    'NARRATIVE and QUALITATIVE risk: a shared macro or event catalyst across the',
    'book, a thesis that depends on something already priced in, an instrument',
    'whose structure makes the stated thesis unlikely to pay. Position caps,',
    'exposure caps, portfolio drawdown, circuit breakers and pairwise price',
    'correlation are ALREADY enforced mechanically — do not restate them.',
    '',
    'If you find no narrative risk, answer "pass". That is a complete and useful',
    'answer; inventing an objection to fill the field is worse than passing.',
    '',
    'Reply with JSON only:',
    '{"verdict":"pass"|"trim"|"reject","max_notional":number|null,"reasoning":string}',
    '- "trim" requires "max_notional": the notional this position should be capped',
    '  at, strictly greater than 0. It can only reduce the position, never raise it.',
    '- "pass" and "reject" must set "max_notional" to null.',
    '- "reasoning" is one or two sentences, and is recorded verbatim in the audit log.',
    BARE_JSON_INSTRUCTION,
    '',
    wrapUntrusted(
      [
        `Proposed: ${intent.side} ${intent.instrument} (${intent.asset_class}), ${intent.intent_type}`,
        `Notional: ${notional} (size ${intent.size} at entry ${intent.entry})`,
        `Stop: ${intent.stop}. Target: ${intent.target}.`,
        `Conviction: ${intent.metadata.conviction}. Debate converged: ${intent.metadata.converged}.`,
        `Book: equity ${portfolio.equity}, gross exposure ${portfolio.gross_exposure}.`,
        `Currently held: ${held}.`,
        `As of: ${request.asOf.toISOString()}.`,
      ].join('\n'),
    ),
  ].join('\n');
}

interface RawCriticVerdict {
  verdict?: unknown;
  max_notional?: unknown;
  reasoning?: unknown;
}

/**
 * Validates the model's answer into a verdict the pipeline may act on, or
 * rejects it as malformed.
 *
 * `max_notional` is the ONE number this ticket lets a model touch on the
 * sizing path, so it is validated here rather than trusted downstream:
 * `applyCritic` (index.ts) compares it against the trimmed notional and a
 * non-finite value would slip past both `>= notional` and the later
 * `approvedSize <= 0` / `< min_viable_size` guards as `NaN`, submitting a
 * position of unknown size. A malformed verdict is refused outright — the
 * fail-open path is strictly safer than a half-read one.
 *
 * `'unavailable'` is not accepted from the wire: it is this producer's own
 * word for "the critic could not answer", and a model claiming it would be
 * indistinguishable from a genuine failure in the log.
 */
export function parseCriticVerdict(
  rawText: string,
): { valid: true; data: RiskCriticVerdict } | { valid: false; reason: string } {
  let parsed: RawCriticVerdict;
  try {
    parsed = JSON.parse(unwrapFencedJson(rawText)) as RawCriticVerdict;
  } catch (error) {
    return { valid: false, reason: `critic response is not JSON: ${describeThrown(error)}` };
  }

  const verdict = parsed.verdict;
  if (verdict !== 'pass' && verdict !== 'trim' && verdict !== 'reject') {
    return {
      valid: false,
      reason: `critic verdict must be "pass", "trim" or "reject", got ${JSON.stringify(verdict)}`,
    };
  }

  if (typeof parsed.reasoning !== 'string' || parsed.reasoning.trim() === '') {
    return { valid: false, reason: 'critic response carries no reasoning text' };
  }
  const reasoning = parsed.reasoning.trim().slice(0, MAX_REASONING_CHARS);

  if (verdict !== 'trim') {
    return { valid: true, data: { verdict, max_notional: null, reasoning } };
  }

  const max_notional = parsed.max_notional;
  if (typeof max_notional !== 'number' || !Number.isFinite(max_notional) || max_notional <= 0) {
    return {
      valid: false,
      reason: `a "trim" verdict needs a finite max_notional above 0, got ${JSON.stringify(
        max_notional,
      )}`,
    };
  }

  return { valid: true, data: { verdict, max_notional, reasoning } };
}

export interface LlmRiskCriticProducerOptions {
  llm: LlmClient;
  store: RiskCriticStore;
  /** ADR-0008's overall ceiling. Checked before dialling; a refusal is a fail-open skip. */
  spendCap: SpendCap;
  logger?: Logger;
  /** Overall wall-clock budget, retries included. See `DEFAULT_CRITIC_BUDGET_MS`. */
  budgetMs?: number;
}

/** The `live`/`paper` producer: one metered LLM pass per viable entry intent, persisted by `debate_id`. */
export class LlmRiskCriticProducer implements RiskCriticProducer {
  readonly #llm: LlmClient;
  readonly #store: RiskCriticStore;
  readonly #spendCap: SpendCap;
  readonly #logger: Logger | undefined;
  readonly #budgetMs: number;

  constructor(options: LlmRiskCriticProducerOptions) {
    this.#llm = options.llm;
    this.#store = options.store;
    this.#spendCap = options.spendCap;
    this.#logger = options.logger;
    this.#budgetMs = options.budgetMs ?? DEFAULT_CRITIC_BUDGET_MS;
  }

  async produce(request: RiskCriticRequest): Promise<RiskCriticVerdict | undefined> {
    const debate_id = request.intent.metadata.debate_id;

    // A verdict already logged for this debate is REUSED rather than re-asked.
    // The store's key is the debate, and a tick re-run after a crash must not
    // bill a second call — nor produce a second, possibly different, verdict
    // for one decision, which is the thing replay-from-log exists to prevent.
    const logged = this.#store.getByDebateId(debate_id);
    if (logged !== undefined) return toDecisionInput(logged.verdict);

    const cap = this.#spendCap.check();
    if (!cap.admitted) {
      return this.#record(request, unavailable(cap.reason ?? 'spend cap refused a critic call'));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#budgetMs);
    try {
      const response = await Promise.race([
        this.#llm.complete({
          prompt: renderCriticPrompt(request),
          context: {
            analyst_views: [],
            // Meter bookkeeping, never sent to the model (`LlmAttribution`).
            // `stage: 'risk_critic'` keeps this call attributable in
            // `llm_spend` instead of landing inside the debate's cost; the
            // `debate_id` still joins it to the decision it belongs to.
            attribution: { trace_id: request.trace_id, stage: 'risk_critic', debate_id },
          },
          parseResponse: parseCriticVerdict,
          signal: controller.signal,
        }),
        this.#expiry(controller.signal),
      ]);
      return this.#record(request, response.data);
    } catch (error) {
      // EVERY failure lands here and fails open: provider error, cancellation
      // on the budget above, or a response that could not be read.
      this.#logger?.log({
        trace_id: request.trace_id,
        stage: 'risk',
        level: 'warn',
        message:
          'risk critic could not produce a verdict; the decision proceeds on the mechanical ' +
          'steps and records risk_critic: skipped',
        payload: { instrument: request.intent.instrument, debate_id, error: describeThrown(error) },
      });
      return this.#record(request, unavailable(describeThrown(error)));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The budget's own arm of the race.
   *
   * `signal` already cancels a client that honours it — this only guarantees
   * the PRODUCER returns within the budget even if the injected client does
   * not, which is the property the tick actually needs: the order must not
   * wait on a provider that never answers.
   */
  #expiry(signal: AbortSignal): Promise<never> {
    return new Promise<never>((_, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new Error(`risk critic exceeded its ${this.#budgetMs}ms budget`)),
        { once: true },
      );
    });
  }

  /** Persists the verdict (audit + replay) and returns what `evaluate()` should see. */
  #record(request: RiskCriticRequest, verdict: RiskCriticVerdict): RiskCriticVerdict | undefined {
    try {
      this.#store.writeVerdict({
        debate_id: request.intent.metadata.debate_id,
        verdict,
        created_at: request.asOf,
      });
    } catch (error) {
      // Never a throw — like `SqliteLlmSpendStore.record`, this is bookkeeping
      // attached to a decision the tick is waiting on, and a store failure
      // must not take the risk stage down.
      //
      // But it is not merely logged either: the verdict is DROPPED, and the
      // decision proceeds on the mechanical steps with `risk_critic: skipped`.
      // A verdict with no row cannot be replayed — a backtest reading this
      // `debate_id` finds nothing and reaches its decision without it — so
      // acting on it live would put the live run on a code path replay can
      // never reproduce, which is exactly what ADR-0003 §2's
      // same-code-path-live-and-replay invariant forbids. Fail-open costs one
      // narrative check while the store is down; the alternative silently
      // invalidates every trade taken in that window against its own backtest.
      this.#logger?.log({
        trace_id: request.trace_id,
        stage: 'risk',
        level: 'warn',
        message:
          'risk critic verdict could not be persisted; it is DISCARDED and the decision ' +
          'proceeds on the mechanical steps with risk_critic: skipped, so live and replay ' +
          'see the same input',
        payload: {
          instrument: request.intent.instrument,
          debate_id: request.intent.metadata.debate_id,
          verdict: verdict.verdict,
          error: describeThrown(error),
        },
      });
      return undefined;
    }
    return toDecisionInput(verdict);
  }
}

export interface ReplayRiskCriticProducerOptions {
  store: RiskCriticStore;
  logger?: Logger;
}

/**
 * The `backtest` producer: reads the logged verdict, calls nothing.
 *
 * It takes NO `LlmClient` — structurally, not by a mode check inside a client
 * that has one. A `debate_id` with no row replays as `undefined`
 * (`risk_critic: skipped`), which is the honest answer for history the critic
 * never saw, and never as a live call: a fresh backtest over unseen history
 * silently issuing model calls is exactly what would void ADR-0003 §2's
 * determinism guarantee and Stage 2's PBO/DSR statistics.
 */
export class ReplayRiskCriticProducer implements RiskCriticProducer {
  readonly #store: RiskCriticStore;
  readonly #logger: Logger | undefined;

  constructor(options: ReplayRiskCriticProducerOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
  }

  produce(request: RiskCriticRequest): Promise<RiskCriticVerdict | undefined> {
    const logged = this.#store.getByDebateId(request.intent.metadata.debate_id);
    if (logged === undefined) {
      this.#logger?.log({
        trace_id: request.trace_id,
        stage: 'risk',
        level: 'info',
        message:
          'risk critic replay found no logged verdict for this debate; the decision records ' +
          'risk_critic: skipped rather than calling the model (ADR-0003 §2)',
        payload: {
          instrument: request.intent.instrument,
          debate_id: request.intent.metadata.debate_id,
        },
      });
      return Promise.resolve(undefined);
    }
    return Promise.resolve(toDecisionInput(logged.verdict));
  }
}

export interface BuildRiskCriticProducerOptions extends LlmRiskCriticProducerOptions {
  mode: 'live' | 'paper' | 'backtest';
}

/** Mode branch, in ONE place: `backtest` gets a producer with no LLM client at all. */
export function buildRiskCriticProducer(
  options: BuildRiskCriticProducerOptions,
): RiskCriticProducer {
  if (options.mode === 'backtest') {
    return new ReplayRiskCriticProducer({
      store: options.store,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }
  return new LlmRiskCriticProducer(options);
}
