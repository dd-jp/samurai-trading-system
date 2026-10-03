import type { BrokerCashInLieu, BrokerCashInLieuReader } from '../../../../../contracts/index.js';
import type { AlpacaBrokerClient, AlpacaCashInLieuActivity } from './alpaca-client.js';
import { ALPACA_ACTIVITY_PAGE_SIZE } from './alpaca-http-client.js';

export const ALPACA_CASH_IN_LIEU_MAX_PAGES = 20;

type ListCashInLieu = (after: string, pageToken?: string) => Promise<AlpacaCashInLieuActivity[]>;

function qtyOf(activity: AlpacaCashInLieuActivity): number | null {
  const qty = Math.abs(Number(activity.qty ?? 0));
  return qty > 0 ? qty : null;
}

function toCashInLieu(activity: AlpacaCashInLieuActivity): BrokerCashInLieu {
  return {
    activity_id: activity.id,
    instrument: activity.symbol,
    activity_date: activity.date,
    qty: qtyOf(activity),
    amount: Number(activity.net_amount),
    currency: 'USD',
    status: activity.status,
  };
}

export class AlpacaCashInLieuReader implements BrokerCashInLieuReader {
  readonly venue = 'alpaca';

  constructor(private readonly list: ListCashInLieu) {}

  async read(sinceDate: string): Promise<readonly BrokerCashInLieu[]> {
    const activities: AlpacaCashInLieuActivity[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < ALPACA_CASH_IN_LIEU_MAX_PAGES; page += 1) {
      const rows = await this.list(sinceDate, pageToken);
      activities.push(...rows);
      if (rows.length < ALPACA_ACTIVITY_PAGE_SIZE) return activities.map(toCashInLieu);
      pageToken = (rows.at(-1) as AlpacaCashInLieuActivity).id;
    }
    throw new Error(
      `Alpaca CIL activities since ${sinceDate} run past ${ALPACA_CASH_IN_LIEU_MAX_PAGES} pages`,
    );
  }
}

export function alpacaCashInLieuReader(
  client: AlpacaBrokerClient | undefined,
): BrokerCashInLieuReader | undefined {
  const list = client?.listCashInLieu?.bind(client);
  return list === undefined ? undefined : new AlpacaCashInLieuReader(list);
}
