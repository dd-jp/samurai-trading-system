import type { Clock } from '../../../shared/index.js';

export interface CiiScoreProvider {
  getCii(countryCode: string): Promise<number | null>;
}

export interface CiiConsumerConfig {
  pollIntervalMs: number;
}

interface CachedScore {
  score: number | null;
  fetchedAt: number;
}

export class CiiConsumer {
  private readonly cache = new Map<string, CachedScore>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly provider: CiiScoreProvider,
    private readonly clock: Clock,
    private readonly config: CiiConsumerConfig,
  ) {}

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
        this.cache.set(country, { score: priorScore, fetchedAt });
      })
      .finally(() => {
        this.inFlight.delete(country);
      });
    this.inFlight.set(country, promise);
  }
}
