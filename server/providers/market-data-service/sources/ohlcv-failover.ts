import { describeThrownSafely } from '../../../shared/index.js';
import type { Bar, BarWindow } from '../index.js';

export type BarFetcher = (symbol: string, window: BarWindow, asOf: Date) => Promise<Bar[]>;

export interface FailoverEvent {
  leg: 'equities' | 'crypto';
  symbol: string;
  timeframe: string;
  primaryName: string;
  fallbackName: string;
  primaryError: string;
}

export type FailoverAlerter = (event: FailoverEvent) => void;

function safeAlert(alert: FailoverAlerter, event: FailoverEvent): void {
  try {
    alert(event);
  } catch {}
}

export interface OhlcvFailoverConfig {
  leg: 'equities' | 'crypto';
  primary: BarFetcher;
  primaryName: string;
  fallback: BarFetcher;
  fallbackName: string;
  alert: FailoverAlerter;
}

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
