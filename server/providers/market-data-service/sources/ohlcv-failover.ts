/**
 * Primary -> fallback failover for the #512 warm-start backfill script's
 * equities bar fetcher (#496): Alpaca -> Polygon — see
 * `backfill-market-data.ts`'s `runFromEnvironment` for the real wiring,
 * which is the composition root for this fetch path. Generic over
 * `BarFetcher` rather than hardcoded to that pair: until #1157 the same
 * wrapper also composed a Coinbase -> Bitstamp crypto leg, and that
 * genericity is kept rather than collapsed onto the one leg that remains.
 * **The LIVE orchestrator reaches this module too, as of #562** — not
 * directly, but through `FailoverDataSource`
 * (`./failover-data-source.ts`), which adapts this same wrapper to the
 * `DataSource` port and is constructed in `production.ts` by
 * `buildFailoverDataSource` (`orchestrator/production/data-failover.ts`).
 * Until then the live path had no failover at all, which is the residual
 * gap `backfill-market-data.ts`'s module doc used to record. Live scope is
 * the EQUITIES leg only (Alpaca -> Polygon): crypto left Samurai's scope on
 * 2026-08-16 (ADR-0015's amendment).
 *
 * **"Failure" here means a THROW from `primary`, not a short-but-successful
 * read.** `AlpacaHttpDataClient` widens-and-retries and only then throws
 * `AlpacaDataUnderfetchError` on a genuinely short read, and this wrapper
 * does not second-guess that: a thrown error is the trigger, a
 * short-but-returned array is not.
 */

import { describeThrownSafely } from '../../../shared/index.js';
import type { Bar, BarWindow } from '../index.js';

export type BarFetcher = (symbol: string, window: BarWindow, asOf: Date) => Promise<Bar[]>;

export interface FailoverEvent {
  leg: 'equities' | 'crypto';
  symbol: string;
  timeframe: string;
  primaryName: string;
  fallbackName: string;
  /** `primary`'s thrown error, stringified — never the raw error object (never re-thrown from inside the alert). */
  primaryError: string;
}

export type FailoverAlerter = (event: FailoverEvent) => void;

/**
 * Guards `alert` so a broken alert channel (stdout `EPIPE`, an alerter that
 * itself throws) can never mask the fallback's own result or crash the
 * fetch — same posture as `tick-loop.ts`'s `safeLog`.
 */
function safeAlert(alert: FailoverAlerter, event: FailoverEvent): void {
  try {
    alert(event);
  } catch {
    // Nothing left to do — see doc comment above; the failover must proceed
    // regardless of whether the operator could be told about it.
  }
}

export interface OhlcvFailoverConfig {
  leg: 'equities' | 'crypto';
  primary: BarFetcher;
  primaryName: string;
  fallback: BarFetcher;
  fallbackName: string;
  /** Called once, BEFORE the fallback is attempted, so the operator learns about a stall even if the fallback also fails. */
  alert: FailoverAlerter;
}

/**
 * Wraps `primary`/`fallback` into a single `BarFetcher`: try `primary`,
 * alert-then-fall-back on a throw, and surface which source actually served
 * via the `Bar.source` every real client here already stamps
 * (`'alpaca'`/`'polygon'`) — persisted per bar by
 * `SqliteMarketDataStore.appendBars` into the `bars.source` column
 * (`0001_init.sql`), so a caller never has to trust this wrapper's own
 * bookkeeping to know which vendor a bar came from.
 */
export function withOhlcvFailover(config: OhlcvFailoverConfig): BarFetcher {
  return async (symbol, window, asOf) => {
    try {
      return await config.primary(symbol, window, asOf);
    } catch (primaryError) {
      const primaryMessage = describeThrownSafely(primaryError);
      safeAlert(config.alert, {
        leg: config.leg,
        symbol,
        timeframe: window.timeframe,
        primaryName: config.primaryName,
        fallbackName: config.fallbackName,
        primaryError: primaryMessage,
      });

      try {
        return await config.fallback(symbol, window, asOf);
      } catch (fallbackError) {
        throw new Error(
          `${config.leg} bars for ${symbol} ${window.timeframe}: both ${config.primaryName} ` +
            `(primary, failed: ${primaryMessage}) and ${config.fallbackName} (fallback) failed.`,
          { cause: fallbackError },
        );
      }
    }
  };
}
