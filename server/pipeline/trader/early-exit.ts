import {
  InsufficientBarsError,
  type MarketDataService,
} from '../../providers/market-data-service/index.js';
import { type AxisVote, MACD_SPEC, momentumVote, RSI_SPEC } from '../analysts/index.js';

export interface EarlyExitConfig {
  momentum_release_at: -1 | 0;
}

export const DEFAULT_EARLY_EXIT_CONFIG: EarlyExitConfig = {
  momentum_release_at: -1,
};

type SignalDecayVerdict = 'decayed' | 'holds' | 'signal_unavailable';

export interface SignalDecayRead {
  verdict: SignalDecayVerdict;
  signed_momentum: AxisVote | null;
}

export async function readSignalDecay(input: {
  instrument: string;
  side: 'buy' | 'sell';
  marketData: MarketDataService;
  asOf: Date;
  config: EarlyExitConfig;
}): Promise<SignalDecayRead> {
  const { asOf, config, instrument, marketData, side } = input;

  let rsi: number;
  let macd: number;
  try {
    macd = (await marketData.getIndicator(instrument, MACD_SPEC, asOf)).value;
    rsi = (await marketData.getIndicator(instrument, RSI_SPEC, asOf)).value;
  } catch (cause) {
    if (cause instanceof InsufficientBarsError) {
      return { verdict: 'signal_unavailable', signed_momentum: null };
    }
    throw cause;
  }

  const vote = momentumVote(rsi, macd);
  const signed: AxisVote = vote === 0 || side === 'buy' ? vote : ((0 - vote) as AxisVote);

  return {
    verdict: signed <= config.momentum_release_at ? 'decayed' : 'holds',
    signed_momentum: signed,
  };
}
