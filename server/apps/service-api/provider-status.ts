import type { AlpacaBrokerClient } from '../../pipeline/execution/adapters/alpaca-client.js';
import { fetchWithTimeout } from '../../shared/index.js';

export type { ProviderStatusPanel } from '../../../contracts/index.js';

import type {
  AlpacaTile,
  PolygonTile,
  ProviderState,
  ProviderStatusPanel,
} from '../../../contracts/index.js';

export interface ProviderStatusReader {
  readProviderStatus(): ProviderStatusPanel;
}

const NOT_YET_POLLED: ProviderStatusPanel = {
  alpaca: {
    provider: 'alpaca',
    state: 'not_configured',
    detail: 'not polled yet',
    observed_at: null,
    balance: null,
  },
  polygon: {
    provider: 'polygon',
    state: 'not_configured',
    detail: 'not polled yet',
    observed_at: null,
  },
};

export const NULL_PROVIDER_STATUS: ProviderStatusReader = {
  readProviderStatus: () => NOT_YET_POLLED,
};

const DEFAULT_POLL_INTERVAL_MS = 15 * 60_000;

const PROBE_TIMEOUT_MS = 10_000;

const DEFAULT_POLYGON_BASE_URL = 'https://api.polygon.io';

const POLYGON_PROBE_PATH = '/v1/marketstatus/now';

function parseMoney(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function swallow(): void {}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  work.catch(swallow);
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function stateForStatus(status: number): ProviderState {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  return 'error';
}

export interface ProviderStatusPollerOptions {
  alpaca?: AlpacaBrokerClient | undefined;
  polygonApiKey?: string;
  polygonBaseUrl?: string;
  intervalMs?: number;
}

export class ProviderStatusPoller implements ProviderStatusReader {
  private panel: ProviderStatusPanel = NOT_YET_POLLED;
  private timer: NodeJS.Timeout | undefined;
  private readonly alpaca: AlpacaBrokerClient | undefined;
  private readonly polygonApiKey: string | undefined;
  private readonly polygonBaseUrl: string;
  private readonly intervalMs: number;

  constructor(options: ProviderStatusPollerOptions = {}) {
    this.alpaca = options.alpaca;
    this.polygonApiKey = options.polygonApiKey ?? process.env.POLYGON_API_KEY;
    this.polygonBaseUrl = options.polygonBaseUrl ?? DEFAULT_POLYGON_BASE_URL;
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  readProviderStatus(): ProviderStatusPanel {
    return this.panel;
  }

  async start(): Promise<void> {
    await this.pollOnce().catch(swallow);
    this.timer = setInterval(() => {
      void this.pollOnce().catch(swallow);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async pollOnce(): Promise<ProviderStatusPanel> {
    const [alpaca, polygon] = await Promise.all([this.probeAlpaca(), this.probePolygon()]);
    this.panel = { alpaca, polygon };
    return this.panel;
  }

  private async probeAlpaca(): Promise<AlpacaTile> {
    const observed_at = new Date().toISOString();
    if (this.alpaca === undefined) {
      return {
        provider: 'alpaca',
        state: 'not_configured',
        detail:
          'no Alpaca client wired (ALPACA_API_KEY / ALPACA_API_SECRET unset — or, under ' +
          'SAMURAI_MODE=live, ALPACA_LIVE_API_KEY / ALPACA_LIVE_API_SECRET?)',
        observed_at,
        balance: null,
      };
    }

    try {
      const account = await withTimeout(
        this.alpaca.getAccount(),
        PROBE_TIMEOUT_MS,
        'Alpaca account probe',
      );
      const cash = parseMoney(account.cash);
      const equity = parseMoney(account.equity);
      if (cash === null || equity === null) {
        return {
          provider: 'alpaca',
          state: 'error',
          detail: 'account returned unparseable cash/equity',
          observed_at,
          balance: null,
        };
      }
      return {
        provider: 'alpaca',
        state: 'ok',
        detail: 'account reachable',
        observed_at,
        balance: { cash, equity, buying_power: parseMoney(account.buying_power) },
      };
    } catch (error) {
      return {
        provider: 'alpaca',
        state: this.stateForError(error),
        detail: this.describeError(error),
        observed_at,
        balance: null,
      };
    }
  }

  private async probePolygon(): Promise<PolygonTile> {
    const observed_at = new Date().toISOString();
    if (this.polygonApiKey === undefined || this.polygonApiKey.length === 0) {
      return {
        provider: 'polygon',
        state: 'not_configured',
        detail: 'POLYGON_API_KEY unset',
        observed_at,
      };
    }

    try {
      const response = await fetchWithTimeout(
        `${this.polygonBaseUrl}${POLYGON_PROBE_PATH}`,
        { headers: { Authorization: `Bearer ${this.polygonApiKey}` } },
        PROBE_TIMEOUT_MS,
      );
      if (!response.ok) {
        return {
          provider: 'polygon',
          state: stateForStatus(response.status),
          detail: `HTTP ${response.status} from ${POLYGON_PROBE_PATH}`,
          observed_at,
        };
      }
      return {
        provider: 'polygon',
        state: 'ok',
        detail: 'key valid, market data reachable',
        observed_at,
      };
    } catch (error) {
      return {
        provider: 'polygon',
        state: 'error',
        detail: this.describeError(error),
        observed_at,
      };
    }
  }

  private stateForError(error: unknown): ProviderState {
    const status = (error as { status?: unknown } | null)?.status;
    return typeof status === 'number' ? stateForStatus(status) : 'error';
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 200 ? `${message.slice(0, 200)}…` : message;
  }
}
