import type {
  BrokerCashActivity,
  BrokerCashActivityReader,
} from '../../../../../contracts/index.js';
import { readActivityPages } from './alpaca-activity-pages.js';
import type { AlpacaBrokerClient, AlpacaCashActivity } from './alpaca-client.js';

// Cash the store books from no fill. Left out on purpose: FILL is the store's own flow; CIL is
// booked as the split's cash-in-lieu estimate fill; deposits and withdrawals (CSD, CSW, JNLC,
// TRANS) are the operator's recorded moves, so reading them too would count them twice;
// corporate actions (MA, REORG, SPIN, SSO, SSP) carry stock as well as cash and stay in the gap;
// JNL is a journal the operator records; CFEE is crypto, which is out of scope; MISC has no
// defined meaning, so it stays in the gap for the operator to record
export function alpacaNonTradeCashTypes(): readonly string[] {
  return [
    'DIV',
    'DIVCGL',
    'DIVCGS',
    'DIVFEE',
    'DIVFT',
    'DIVNRA',
    'DIVROC',
    'DIVTW',
    'DIVTXEX',
    'INT',
    'INTNRA',
    'INTTW',
    'FEE',
    'PTC',
    'PTR',
  ];
}

type ListCashActivities = (
  types: readonly string[],
  after: string,
  pageToken?: string,
) => Promise<AlpacaCashActivity[]>;

function toCashActivity(activity: AlpacaCashActivity): BrokerCashActivity {
  return {
    activity_id: activity.id,
    activity_type: activity.activity_type,
    activity_date: activity.date,
    amount: Number(activity.net_amount),
    status: activity.status,
  };
}

export class AlpacaCashActivityReader implements BrokerCashActivityReader {
  readonly venue = 'alpaca';

  constructor(private readonly list: ListCashActivities) {}

  async read(sinceDate: string): Promise<readonly BrokerCashActivity[]> {
    const page = (after: string, pageToken?: string) =>
      this.list(alpacaNonTradeCashTypes(), after, pageToken);
    return (await readActivityPages(page, sinceDate, 'non-trade cash')).map(toCashActivity);
  }
}

export function alpacaCashActivityReader(
  client: AlpacaBrokerClient | undefined,
): BrokerCashActivityReader | undefined {
  const list = client?.listCashActivities?.bind(client);
  return list === undefined ? undefined : new AlpacaCashActivityReader(list);
}
