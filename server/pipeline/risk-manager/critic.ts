
import type { MarketDataService } from '../../providers/market-data-service/index.js';
import { INDICATOR_KINDS } from '../../providers/market-data-service/index.js';
import type { LogEventCode, Logger, OrderIntent } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import { hashPromptTemplate } from '../../shared/llm/index.js';
import type { FailureCause, LlmClient, SpendCap } from '../debate-engine/index.js';
import {
  BARE_JSON_INSTRUCTION,
  classifyFailureCause,
  unwrapFencedJson,
  wrapUntrusted,
} from '../debate-engine/index.js';
import {
  evaluateConditions,
  MAX_INVALIDATION_LOOKBACK,
  validateConditions,
} from './invalidation.js';
import type {
  DroppedCondition,
  EvaluatedCondition,
  RiskCriticStore,
  RiskCriticVerdict,
} from './types.js';

const DEFAULT_CRITIC_BUDGET_MS = 10_000;

const MAX_REASONING_CHARS = 400;

interface CriticHeldPosition {
  instrument: string;
  notional: number;
}

export interface RiskCriticRequest {
  trace_id: string;
  intent: OrderIntent;
  portfolio: {
    equity: number;
    gross_exposure: number;
    held: readonly CriticHeldPosition[];
  };
  asOf: Date;
}

export interface RiskCriticProducer {
  produce(request: RiskCriticRequest): Promise<RiskCriticVerdict | undefined>;
}

function toDecisionInput(verdict: RiskCriticVerdict): RiskCriticVerdict | undefined {
  return verdict.verdict === 'unavailable' ? undefined : verdict;
}

function unavailable(reason: string): RiskCriticVerdict {
  return { verdict: 'unavailable', max_notional: null, reasoning: reason };
}

const CRITIC_PROMPT_TEMPLATE = [
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
  'SEPARATELY, name 3 to 5 INVALIDATION CONDITIONS: measurable facts which, if',
  'already true right now, would mean the thesis behind this trade has already',
  'failed. You do NOT evaluate them — you only name what to check. They are',
  'measured by code against market data, so a condition that names something',
  'unmeasurable is discarded.',
  '',
  'Reply with JSON only:',
  '{"verdict":"pass"|"trim"|"reject","max_notional":number|null,"reasoning":string,',
  ' "conditions":[{"id":string,"observable":Observable,"comparator":"<"|"<="|">"|">=",',
  '                "threshold":number,"rationale":string}]}',
  '- "trim" requires "max_notional": the notional this position should be capped',
  '  at, strictly greater than 0. It can only reduce the position, never raise it.',
  '- "pass" and "reject" must set "max_notional" to null.',
  '- "reasoning" is one or two sentences, and is recorded verbatim in the audit log.',
  '- Observable is exactly one of:',
  '    {"kind":"mark"}  — the instrument\'s current price',
  `    {"kind":"indicator","spec":{"indicator":<one of ${INDICATOR_KINDS.join('|')}>,`,
  `                               "params":{"period":number},"lookback":number (<= ${MAX_INVALIDATION_LOOKBACK}),"timeframe":"1h"}}`,
  `    {"kind":"bars","window":{"timeframe":"1h","lookback":number (<= ${MAX_INVALIDATION_LOOKBACK})},"measure":"volume_ratio"}`,
  "  — the latest bar's volume over the mean of the preceding bars.",
  '- A condition must fire when the thesis is FAILING, not when it is working:',
  '  for a "buy" that means price/momentum observables BELOW a threshold, for a',
  '  "sell" ABOVE one; volume_ratio is always "<" (thinning participation).',
  '- Give NO severity, weight, confidence or evaluation state. Conditions are',
  '  predicates; the state is measured, never asserted.',
  '- An empty or omitted "conditions" list is accepted and recorded. It does not',
  '  change the verdict above; do not invent conditions to fill it.',
  BARE_JSON_INSTRUCTION,
].join('\n');

export const CRITIC_PROMPT_TEMPLATE_HASH = hashPromptTemplate(CRITIC_PROMPT_TEMPLATE);

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
    CRITIC_PROMPT_TEMPLATE,
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
  conditions?: unknown;
}

export interface ParsedCriticResponse {
  verdict: RiskCriticVerdict;
  raw_conditions: unknown;
}

export function parseCriticVerdict(
  rawText: string,
): { valid: true; data: ParsedCriticResponse } | { valid: false; reason: string } {
  let parsed: RawCriticVerdict;
  try {
    parsed = JSON.parse(unwrapFencedJson(rawText)) as RawCriticVerdict;
  } catch (error) {
    return { valid: false, reason: `critic response is not JSON: ${describeThrownSafely(error)}` };
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

  const raw_conditions = parsed.conditions;

  if (verdict !== 'trim') {
    return {
      valid: true,
      data: { verdict: { verdict, max_notional: null, reasoning }, raw_conditions },
    };
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

  return { valid: true, data: { verdict: { verdict, max_notional, reasoning }, raw_conditions } };
}

export interface LlmRiskCriticProducerOptions {
  llm: LlmClient;
  store: RiskCriticStore;
  spendCap: SpendCap;
  marketData: MarketDataService;
  logger?: Logger;
  budgetMs?: number;
}

type CriticUnavailableCause = FailureCause | 'spend_cap';

export class LlmRiskCriticProducer implements RiskCriticProducer {
  readonly #llm: LlmClient;
  readonly #store: RiskCriticStore;
  readonly #spendCap: SpendCap;
  readonly #marketData: MarketDataService;
  readonly #logger: Logger | undefined;
  readonly #budgetMs: number;

  constructor(options: LlmRiskCriticProducerOptions) {
    this.#llm = options.llm;
    this.#store = options.store;
    this.#spendCap = options.spendCap;
    this.#marketData = options.marketData;
    this.#logger = options.logger;
    this.#budgetMs = options.budgetMs ?? DEFAULT_CRITIC_BUDGET_MS;
  }

  async produce(request: RiskCriticRequest): Promise<RiskCriticVerdict | undefined> {
    const debate_id = request.intent.metadata.debate_id;

    const logged = this.#store.getByDebateId(debate_id);
    if (logged !== undefined) return toDecisionInput(logged.verdict);

    const cap = this.#spendCap.check();
    if (!cap.admitted) {
      const reason = cap.reason ?? 'spend cap refused a critic call';
      this.#logUnavailable(request, 'spend_cap', reason);
      return this.#record(request, unavailable(reason));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#budgetMs);
    try {
      return await this.#produceWithin(request, controller);
    } finally {
      clearTimeout(timer);
    }
  }

  async #produceWithin(
    request: RiskCriticRequest,
    controller: AbortController,
  ): Promise<RiskCriticVerdict | undefined> {
    const debate_id = request.intent.metadata.debate_id;
    let parsed: ParsedCriticResponse;
    try {
      const response = await Promise.race([
        this.#llm.complete({
          prompt: renderCriticPrompt(request),
          context: {
            analyst_views: [],
            attribution: {
              trace_id: request.trace_id,
              stage: 'risk_critic',
              debate_id,
              prompt_template_hash: CRITIC_PROMPT_TEMPLATE_HASH,
            },
          },
          parseResponse: parseCriticVerdict,
          signal: controller.signal,
        }),
        this.#expiry(controller.signal),
      ]);
      parsed = response.data;
    } catch (error) {
      this.#logUnavailable(
        request,
        controller.signal.aborted ? 'timeout' : classifyFailureCause(error),
        describeThrownSafely(error),
      );
      return this.#record(request, unavailable(describeThrownSafely(error)));
    }

    return this.#record(request, await this.#withConditions(request, parsed, controller.signal));
  }

  async #withConditions(
    request: RiskCriticRequest,
    parsed: ParsedCriticResponse,
    signal: AbortSignal,
  ): Promise<RiskCriticVerdict> {
    try {
      const { accepted, dropped } = validateConditions(parsed.raw_conditions, request.intent.side);
      const conditions = await evaluateConditions({
        conditions: accepted,
        instrument: request.intent.instrument,
        marketData: this.#marketData,
        asOf: request.asOf,
        signal,
      });
      this.#reportThinEmission(request, conditions, dropped);
      return { ...parsed.verdict, conditions, dropped_conditions: dropped };
    } catch (error) {
      this.#warn(
        request,
        'risk_critic_conditions_unevaluated',
        'risk critic invalidation conditions could not be evaluated; the PROSE verdict ' +
          'stands with full authority and the conditions report no_conditions',
        { instrument: request.intent.instrument, error: describeThrownSafely(error) },
      );
      return { ...parsed.verdict, conditions: [], dropped_conditions: [] };
    }
  }

  #reportThinEmission(
    request: RiskCriticRequest,
    conditions: readonly EvaluatedCondition[],
    dropped: readonly DroppedCondition[],
  ): void {
    if (dropped.length === 0 && conditions.length > 0) return;
    this.#warn(
      request,
      conditions.length === 0 ? 'risk_critic_conditions_absent' : 'risk_critic_conditions_dropped',
      conditions.length === 0
        ? 'risk critic emitted NO checkable invalidation condition; the prose verdict stands ' +
            'alone and conditions enforce nothing (no_conditions)'
        : 'risk critic emitted invalidation conditions the validator refused in part',
      {
        instrument: request.intent.instrument,
        accepted: conditions.length,
        dropped: dropped.map((entry) => ({ id: entry.id, reason: entry.reason })),
      },
    );
  }

  #warn(
    request: RiskCriticRequest,
    event: LogEventCode,
    message: string,
    payload: Record<string, unknown>,
  ): void {
    try {
      this.#logger?.log({
        trace_id: request.trace_id,
        stage: 'risk',
        event,
        level: 'warn',
        message,
        payload,
      });
    } catch {
    }
  }

  #logUnavailable(
    request: RiskCriticRequest,
    failure_cause: CriticUnavailableCause,
    detail: string,
  ): void {
    this.#warn(
      request,
      'risk_critic_verdict_unavailable',
      'risk critic could not produce a verdict; the decision proceeds on the mechanical ' +
        'steps and records risk_critic: skipped',
      {
        instrument: request.intent.instrument,
        debate_id: request.intent.metadata.debate_id,
        failure_cause,
        error: detail,
      },
    );
  }

  #expiry(signal: AbortSignal): Promise<never> {
    return new Promise<never>((_, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new Error(`risk critic exceeded its ${this.#budgetMs}ms budget`)),
        { once: true },
      );
    });
  }

  #record(request: RiskCriticRequest, verdict: RiskCriticVerdict): RiskCriticVerdict | undefined {
    try {
      this.#store.writeVerdict({
        debate_id: request.intent.metadata.debate_id,
        verdict,
        created_at: request.asOf,
      });
    } catch (error) {
      this.#logger?.log({
        trace_id: request.trace_id,
        stage: 'risk',
        event: 'risk_critic_verdict_discarded',
        level: 'warn',
        message:
          'risk critic verdict could not be persisted; it is DISCARDED and the decision ' +
          'proceeds on the mechanical steps with risk_critic: skipped, so live and replay ' +
          'see the same input',
        payload: {
          instrument: request.intent.instrument,
          debate_id: request.intent.metadata.debate_id,
          verdict: verdict.verdict,
          error: describeThrownSafely(error),
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
