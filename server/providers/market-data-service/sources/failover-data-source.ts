import type { BarWindow, DataSource, Mark, Quote } from '../types.js';
import { type BarFetcher, type FailoverAlerter, withOhlcvFailover } from './ohlcv-failover.js';

export interface DataSourceFallbackLeg {
  leg: 'equities' | 'crypto';
  name: string;
  fetchBars: BarFetcher;
}

export interface FailoverDataSourceConfig {
  primary: DataSource;
  primaryName: string;
  fallbackFor: (instrument: string) => DataSourceFallbackLeg | undefined;
  alert: FailoverAlerter;
  now?: () => Date;
}

export const FAILOVER_CIRCUIT_FAILURE_THRESHOLD = 3;

export const FAILOVER_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

class PrimaryCircuitOpenError extends Error {
  constructor(primaryName: string, consecutiveFailures: number) {
    super(
      `${primaryName} circuit is OPEN after ${consecutiveFailures} consecutive failures — the ` +
        `primary was SKIPPED for this read (#824) and the fallback is serving directly. It is ` +
        `re-probed automatically within ${FAILOVER_CIRCUIT_COOLDOWN_MS / 60_000} minutes; no ` +
        `operator action is needed to close it.`,
    );
    this.name = 'PrimaryCircuitOpenError';
  }
}

type CircuitAdmission = 'closed' | 'probe' | 'open';

class PrimaryCircuitBreaker {
  #consecutiveFailures = 0;
  #openedAt: number | undefined;
  #probeStartedAt: number | undefined;

  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  admit(at: number): CircuitAdmission {
    const openedAt = this.#openedAt;
    if (openedAt === undefined) return 'closed';

    if (!hasElapsed(at, openedAt, FAILOVER_CIRCUIT_COOLDOWN_MS)) return 'open';

    const probeStartedAt = this.#probeStartedAt;
    if (
      probeStartedAt !== undefined &&
      !hasElapsed(at, probeStartedAt, FAILOVER_CIRCUIT_COOLDOWN_MS)
    ) {
      return 'open';
    }

    this.#probeStartedAt = at;
    return 'probe';
  }

  recordSuccess(): void {
    this.#consecutiveFailures = 0;
    this.#openedAt = undefined;
    this.#probeStartedAt = undefined;
  }

  recordFailure(at: number): void {
    this.#probeStartedAt = undefined;
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= FAILOVER_CIRCUIT_FAILURE_THRESHOLD) {
      this.#openedAt = at;
    }
  }
}

function hasElapsed(at: number, since: number, duration: number): boolean {
  const elapsed = at - since;
  return elapsed < 0 || elapsed >= duration;
}

export class FailoverDataSource implements DataSource {
  readonly #config: FailoverDataSourceConfig;
  readonly #breakers = new Map<string, PrimaryCircuitBreaker>();

  constructor(config: FailoverDataSourceConfig) {
    this.#config = config;
  }

  #now(): number {
    return (this.#config.now?.() ?? new Date()).getTime();
  }

  #breakerFor(leg: string): PrimaryCircuitBreaker {
    let breaker = this.#breakers.get(leg);
    if (breaker === undefined) {
      breaker = new PrimaryCircuitBreaker();
      this.#breakers.set(leg, breaker);
    }
    return breaker;
  }

  async fetchBars(instrument: string, window: BarWindow, asOf: Date) {
    const fallback = this.#config.fallbackFor(instrument);
    if (fallback === undefined) {
      return this.#config.primary.fetchBars(instrument, window, asOf);
    }

    const breaker = this.#breakerFor(fallback.leg);
    const admission = breaker.admit(this.#now());

    const fetch = withOhlcvFailover({
      leg: fallback.leg,
      primary: async (symbol, barWindow, at) => {
        if (admission === 'open') {
          throw new PrimaryCircuitOpenError(this.#config.primaryName, breaker.consecutiveFailures);
        }
        try {
          const bars = await this.#config.primary.fetchBars(symbol, barWindow, at);
          breaker.recordSuccess();
          return bars;
        } catch (error) {
          breaker.recordFailure(this.#now());
          throw error;
        }
      },
      primaryName: this.#config.primaryName,
      fallback: fallback.fetchBars,
      fallbackName: fallback.name,
      alert: this.#config.alert,
    });

    return fetch(instrument, window, asOf);
  }

  async fetchMark(instrument: string, asOf: Date, mode: 'live' | 'backtest'): Promise<Mark> {
    return this.#config.primary.fetchMark(instrument, asOf, mode);
  }

  async fetchQuote(instrument: string, asOf: Date): Promise<Quote | null> {
    const primary = this.#config.primary;
    if (primary.fetchQuote === undefined) return null;
    return primary.fetchQuote(instrument, asOf);
  }
}
