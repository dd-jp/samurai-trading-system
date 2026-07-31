/**
 * CII soft-signal consumer (ticket #205). See docs/specs/risk-manager-spec.md
 * ("Module: CII Soft Signal", "Module: State & Accounting") and
 * docs/specs/market-intelligence-spec.md ("Module: WorldMonitor Agent") and
 * ADR-0002. This is the actual call/subscription the Risk Manager makes for
 * WorldMonitor's Country Instability Index (CII, 0-100 per country) — a
 * separate, lower-frequency read than the Market Data Service dependency,
 * decoupled from the trading tick loop the same way the WorldMonitor Agent's
 * news/sentiment polling is (ADR-0002 §2).
 *
 * `client.ts`/`normalizer.ts`/`adapter.ts` (the live `worldmonitor` npm SDK
 * wiring for news/sentiment) are not implemented yet — out of scope here.
 * `CiiScoreProvider` is the seam that work will plug into
 * (`wm.risk(countryCode)` per ADR-0002 §5); until then callers inject
 * whatever provider they have (e.g. a stub in tests).
 */
import type { Clock } from '../../shared/index.js';

/** The raw per-country score read, decoupled from any particular SDK/transport. */
export interface CiiScoreProvider {
  /** Returns the current CII (0-100) for a country code, or null if WorldMonitor has no score for it. */
  getCii(countryCode: string): Promise<number | null>;
}

/** How stale a cached score is allowed to get before a re-poll is attempted. */
export interface CiiConsumerConfig {
  /** Matches WorldMonitor's own decoupled poll cadence (5-15 min, ADR-0002 §2). */
  pollIntervalMs: number;
}

interface CachedScore {
  score: number | null;
  fetchedAt: number;
}

/**
 * Caches per-country CII reads so the Risk Manager's synchronous `evaluate()`
 * never blocks on a network call — `getScores` serves the last poll,
 * stale-tolerant, and triggers a background re-poll once `pollIntervalMs`
 * has elapsed (same posture as `MarketIntelligenceStore`'s stale-tolerant
 * serving between agent polls).
 *
 * A country absent from the returned record means WorldMonitor has never
 * successfully returned a score for it — treated as "no signal", not zero
 * risk, mirroring `CorrelationEstimate`'s omission-as-fallback convention.
 */
export class CiiConsumer {
  private readonly cache = new Map<string, CachedScore>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly provider: CiiScoreProvider,
    private readonly clock: Clock,
    private readonly config: CiiConsumerConfig,
  ) {}

  /**
   * Returns the best-known CII score for each requested country. Countries
   * whose cache is missing or past `pollIntervalMs` are refreshed in the
   * background (fire-and-forget, this call does not await them) so the
   * *next* call serves fresher data — matching WorldMonitor's decoupled poll
   * cadence rather than the trading tick clock.
   */
  getScores(countryCodes: string[]): Record<string, number> {
    const now = this.clock.now().getTime();
    const scores: Record<string, number> = {};

    for (const country of countryCodes) {
      const cached = this.cache.get(country);
      if (cached?.score !== null && cached?.score !== undefined) {
        scores[country] = cached.score;
      }
      if (cached === undefined || now - cached.fetchedAt >= this.config.pollIntervalMs) {
        this.refresh(country);
      }
    }

    return scores;
  }

  private refresh(country: string): void {
    if (this.inFlight.has(country)) {
      return;
    }
    const fetchedAt = this.clock.now().getTime();
    const priorScore = this.cache.get(country)?.score ?? null;
    const promise = this.provider
      .getCii(country)
      .then((score) => {
        this.cache.set(country, { score, fetchedAt });
      })
      .catch((error) => {
        console.error(`[cii-consumer] getCii failed for country=${country}:`, error);
        // Record the attempt (keeping the last known score) so a failing
        // provider is retried on the next poll cycle, not on every call.
        this.cache.set(country, { score: priorScore, fetchedAt });
      })
      .finally(() => {
        this.inFlight.delete(country);
      });
    this.inFlight.set(country, promise);
  }
}
