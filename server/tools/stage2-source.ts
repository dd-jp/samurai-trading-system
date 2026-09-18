import { timeframeToMs } from '../providers/market-data-service/index.js';
import {
  type DateRange,
  DEFAULT_STAGE2_TIMEFRAME,
  FreeStackAggregatesClient,
  HttpPolygonClient,
  type PolygonClient,
} from './backtest/index.js';

export const STAGE2_PINNED_WINDOW: DateRange = {
  start: new Date('2021-08-06T18:17:07.694Z'),
  end: new Date('2026-08-05T18:17:07.694Z'),
};

export const STAGE2_FREE_STACK_WINDOW: DateRange = {
  start: new Date('2016-01-01T00:00:00.000Z'),
  end: STAGE2_PINNED_WINDOW.end,
};

type Stage2SourceLabel = 'polygon' | 'free-stack';

export interface Stage2Source {
  client: PolygonClient;
  window: DateRange;
  label: Stage2SourceLabel;
  timeframe: string;
}

export function resolveStage2Timeframe(env: NodeJS.ProcessEnv = process.env): string {
  const timeframe = env.STAGE2_TIMEFRAME?.trim();
  if (timeframe === undefined || timeframe.length === 0) return DEFAULT_STAGE2_TIMEFRAME;
  timeframeToMs(timeframe);
  return timeframe;
}

export function resolveStage2Source(env: NodeJS.ProcessEnv = process.env): Stage2Source {
  const requested = env.STAGE2_SOURCE ?? 'polygon';
  const timeframe = resolveStage2Timeframe(env);

  if (requested === 'polygon') {
    return {
      client: new HttpPolygonClient(
        env.POLYGON_API_KEY === undefined ? {} : { apiKey: env.POLYGON_API_KEY },
      ),
      window: STAGE2_PINNED_WINDOW,
      label: 'polygon',
      timeframe,
    };
  }

  if (requested === 'free-stack') {
    return {
      client: new FreeStackAggregatesClient({
        alpacaKeyId: env.ALPACA_API_KEY,
        alpacaSecretKey: env.ALPACA_API_SECRET,
      }),
      window: STAGE2_FREE_STACK_WINDOW,
      label: 'free-stack',
      timeframe,
    };
  }

  throw new Error(
    `resolveStage2Source: STAGE2_SOURCE='${requested}' is not recognised. ` +
      "Use 'polygon' (default, 2y) or 'free-stack' (10y).",
  );
}
