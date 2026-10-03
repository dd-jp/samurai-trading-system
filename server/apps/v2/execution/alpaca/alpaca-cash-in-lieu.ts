import type { BrokerCashInLieu, BrokerCashInLieuReader } from '../../../../../contracts/index.js';
import { readActivityPages } from './alpaca-activity-pages.js';
import type { AlpacaBrokerClient, AlpacaCashInLieuActivity } from './alpaca-client.js';

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
    return (await readActivityPages(this.list, sinceDate, 'CIL')).map(toCashInLieu);
  }
}

export function alpacaCashInLieuReader(
  client: AlpacaBrokerClient | undefined,
): BrokerCashInLieuReader | undefined {
  const list = client?.listCashInLieu?.bind(client);
  return list === undefined ? undefined : new AlpacaCashInLieuReader(list);
}
