import type { LatestQuoteSource } from '../../../../../contracts/index.js';
import type { AlpacaQuoteClient } from './alpaca-client.js';
import { AlpacaHttpBrokerClient, type AlpacaTradingEnvironment } from './alpaca-http-client.js';

export function alpacaLatestQuotes(client: () => AlpacaQuoteClient): LatestQuoteSource {
  return {
    async latestQuote(symbol) {
      const { t, ap, bp } = await client().getLatestQuote(symbol);
      if (ap <= 0) throw new Error(`Alpaca latest ${symbol} quote at ${t} has no ask`);
      return { ask: ap, bid: bp, quoted_at: new Date(t).toISOString() };
    },
  };
}

export function alpacaQuotesFor(environment: AlpacaTradingEnvironment): LatestQuoteSource {
  let client: AlpacaQuoteClient | undefined;
  return alpacaLatestQuotes(() => {
    client ??= new AlpacaHttpBrokerClient({ environment });
    return client;
  });
}
