import {
  AlwaysOpenCalendar,
  type MarketDataService,
  type TradingCalendar,
} from '../../providers/market-data-service/index.js';
import type { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import type { AssetClass, Clock, Logger } from '../../shared/index.js';
import {
  describeThrown,
  MAX_ERROR_BODY_CHARS,
  maskAndCap,
  safeLog,
  sanitizeLogText,
} from '../../shared/index.js';
import type { AnalystView } from '../debate-engine/index.js';
import { classifyFailureCause } from '../debate-engine/index.js';
import { fundamentalAnalyst } from './fundamental-analyst.js';
import { sentimentAnalyst } from './sentiment-analyst.js';
import { technicalAnalyst } from './technical-analyst.js';
import type {
  Analyst,
  AnalystFailure,
  AnalystFailureKind,
  AnalystRunResult,
  AnalystTelemetry,
  Signal,
} from './types.js';
import { NOOP_ANALYST_TELEMETRY } from './types.js';

const ALL_PERSONAS: Analyst[] = [technicalAnalyst, fundamentalAnalyst, sentimentAnalyst];

export const DEFAULT_ANALYST_TIMEOUT_MS = 30_000;

const ATTEMPTS_PER_PERSONA = 2;

export const ANALYST_STAGE_WALL_CLOCK_MS = ATTEMPTS_PER_PERSONA * DEFAULT_ANALYST_TIMEOUT_MS;

export interface AnalystOrchestratorDeps {
  market_intelligence: MarketIntelligenceStore;
  market_data: MarketDataService;
  sessionCalendars?: Record<AssetClass, TradingCalendar>;
  telemetry?: AnalystTelemetry;
  logger?: Logger;
}

function defaultSessionCalendars(): Record<AssetClass, TradingCalendar> {
  return {
    crypto: new AlwaysOpenCalendar(),
    stocks: new AlwaysOpenCalendar(),
  };
}

const NOOP_LOGGER: Logger = {
  log(): void {},
};

function renderErrorDetail(error: unknown): Record<string, unknown> {
  try {
    return renderErrorFields(error);
  } catch {
    return { message: '[unrenderable error]' };
  }
}

function renderField(render: () => string): string {
  try {
    return render();
  } catch {
    return '[unrenderable]';
  }
}

function renderErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: sanitizeLogText(describeThrown(error)) };
  }
  const detail: Record<string, unknown> = {
    name: renderField(() => sanitizeLogText(error.name)),
    message: renderField(() => sanitizeLogText(error.message)),
  };
  const stack = renderField(() =>
    typeof error.stack === 'string' ? maskAndCap(error.stack, MAX_ERROR_BODY_CHARS) : '',
  );
  if (stack !== '') detail.stack = stack;
  if (error.cause !== undefined) {
    detail.cause = renderField(() => sanitizeLogText(describeThrown(error.cause)));
  }
  return detail;
}

export interface AnalystOrchestratorOptions {
  timeout_ms?: number;
}

function logLatePersonaSettlement(
  logger: Logger,
  trace_id: string,
  persona: Analyst,
  attempt: number,
  timeout_ms: number,
  outcome: { status: 'fulfilled'; value: AnalystView } | { status: 'rejected'; error: unknown },
): void {
  safeLog(logger, {
    trace_id,
    stage: 'analysts',
    level: 'debug',
    message:
      `analysts: ${persona.analyst_type} attempt ${attempt} settled after its ` +
      `${timeout_ms}ms deadline had already been reported as a timeout — the ` +
      `cause below, discarded rather than applied to this tick`,
    payload: {
      analyst_type: persona.analyst_type,
      attempt,
      outcome: outcome.status,
      ...(outcome.status === 'rejected' ? renderErrorDetail(outcome.error) : {}),
    },
  });
}

function classifyPersonaAttemptFailure(
  logger: Logger,
  trace_id: string,
  persona: Analyst,
  attempt: number,
  error: unknown,
): { reason: string; kind: AnalystFailureKind } {
  let reason: string;
  try {
    reason = describeThrown(error);
  } catch {
    reason = '[unrenderable error]';
  }
  const kind: AnalystFailureKind =
    error instanceof AnalystTimeoutError ? 'timeout' : classifyFailureCause(error);
  if (kind !== 'timeout') {
    safeLog(logger, {
      trace_id,
      stage: 'analysts',
      level: 'debug',
      message: `analysts: ${persona.analyst_type} attempt ${attempt} rejected — cause below`,
      payload: {
        analyst_type: persona.analyst_type,
        attempt,
        ...renderErrorDetail(error),
      },
    });
  }
  return { reason, kind };
}

class AnalystTimeoutError extends Error {
  constructor(analyst_type: string, timeout_ms: number) {
    super(`${analyst_type} did not answer within ${timeout_ms}ms`);
    this.name = 'AnalystTimeoutError';
  }
}

async function withTimeout<T>(
  work: Promise<T>,
  timeout_ms: number,
  analyst_type: string,
  onLateSettlement?: (
    outcome: { status: 'fulfilled'; value: T } | { status: 'rejected'; error: unknown },
  ) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (onLateSettlement !== undefined) {
            work.then(
              (value) => onLateSettlement({ status: 'fulfilled', value }),
              (error: unknown) => onLateSettlement({ status: 'rejected', error }),
            );
          }
          reject(new AnalystTimeoutError(analyst_type, timeout_ms));
        }, timeout_ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class AnalystOrchestrator {
  private readonly timeoutMs: number;
  private readonly sessionCalendars: Record<AssetClass, TradingCalendar>;
  private readonly logger: Logger;

  constructor(
    private readonly deps: AnalystOrchestratorDeps,
    private readonly personas: Analyst[] = ALL_PERSONAS,
    options: AnalystOrchestratorOptions = {},
  ) {
    this.timeoutMs = options.timeout_ms ?? DEFAULT_ANALYST_TIMEOUT_MS;
    this.sessionCalendars = deps.sessionCalendars ?? defaultSessionCalendars();
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  analystIds(): string[] {
    return [...new Set(this.personas.map((persona) => persona.analyst_type))];
  }

  async runAnalysts(
    trace_id: string,
    signal: Signal,
    clock: Clock,
    bar: Date,
  ): Promise<AnalystRunResult> {
    const applicable = this.personas.filter((persona) => persona.applies_to(signal.asset_class));
    const analyst_count = applicable.length;

    const outcomes = await Promise.all(
      applicable.map(async (persona) => {
        let lastReason = '';
        let lastKind: AnalystFailureKind = 'other';
        for (let attempt = 1; attempt <= ATTEMPTS_PER_PERSONA; attempt++) {
          try {
            const view = await withTimeout(
              persona.run({
                trace_id,
                signal,
                clock,
                bar,
                market_intelligence: this.deps.market_intelligence,
                market_data: this.deps.market_data,
                calendar: this.sessionCalendars[signal.asset_class],
                telemetry: this.deps.telemetry ?? NOOP_ANALYST_TELEMETRY,
              }),
              this.timeoutMs,
              persona.analyst_type,
              (outcome) =>
                logLatePersonaSettlement(
                  this.logger,
                  trace_id,
                  persona,
                  attempt,
                  this.timeoutMs,
                  outcome,
                ),
            );
            return { persona, status: 'fulfilled' as const, view };
          } catch (error) {
            ({ reason: lastReason, kind: lastKind } = classifyPersonaAttemptFailure(
              this.logger,
              trace_id,
              persona,
              attempt,
              error,
            ));
          }
        }
        return {
          persona,
          status: 'rejected' as const,
          reason: `${lastReason} (after ${ATTEMPTS_PER_PERSONA} attempts)`,
          kind: lastKind,
        };
      }),
    );

    const views: AnalystView[] = [];
    const failures: AnalystFailure[] = [];
    let mandatoryFailed = false;

    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') {
        views.push(outcome.view);
        continue;
      }
      failures.push({
        analyst_type: outcome.persona.analyst_type,
        role: outcome.persona.role,
        reason: outcome.reason,
        kind: outcome.kind,
      });
      if (outcome.persona.role === 'mandatory') {
        mandatoryFailed = true;
      }
    }

    return {
      views: mandatoryFailed ? [] : views,
      analyst_count,
      skipped: mandatoryFailed,
      failures,
    };
  }

  async analysts(input: {
    trace_id: string;
    signal: Signal;
    clock: Clock;
    bar: Date;
  }): Promise<AnalystView[]> {
    const result = await this.runAnalysts(input.trace_id, input.signal, input.clock, input.bar);
    return result.views;
  }
}
