import {
  JOURNAL_FILTER_MAX_CHARS,
  type JournalActionFilterWire,
  type JournalDayWire,
  type JournalDecisionWire,
  type JournalFillWire,
  type JournalOrderWire,
  type JournalRefusalWire,
  type JournalWire,
  type SleeveAction,
  V2_CONTRACT_VERSION,
} from '../../../../contracts/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import {
  ALPACA_SHORT_EQUITY_FLOOR_USD,
  CFD_ENTRY_GATES,
  G18_SENTIMENT_DEDUP_RULE,
  G18_SMALL_CAP_FLOORS,
  G18_SOCIAL_SOURCE,
  LSE_LIQUIDITY_SCREEN,
} from '../signal/index.js';

const VETO_PREFIX = 'vetoed:';
const DEFAULT_DAYS = 7;
const MAX_DAYS = 31;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIONS: ReadonlySet<string> = new Set<JournalActionFilterWire>([
  'enter_long',
  'enter_short',
  'exit',
  'skip',
  'none',
  'vetoed',
]);

export interface JournalQuery {
  readonly from?: string;
  readonly to?: string;
  readonly before?: string;
  readonly book?: string;
  readonly instrument?: string;
  readonly action?: JournalActionFilterWire;
  readonly veto?: string;
  readonly limit: number;
}

export type JournalQueryResult =
  | { readonly ok: true; readonly query: JournalQuery }
  | { readonly ok: false; readonly reason: string };

const INVALID = Symbol('invalid');
type Parsed = string | number | typeof INVALID;

function parseDate(raw: string): Parsed {
  if (!ISO_DATE.test(raw)) return INVALID;
  const [year, month, day] = raw.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  return date === raw ? raw : INVALID;
}

function parseText(raw: string): Parsed {
  return raw !== '' && raw.length <= JOURNAL_FILTER_MAX_CHARS ? raw : INVALID;
}

function parseAction(raw: string): Parsed {
  return ACTIONS.has(raw) ? raw : INVALID;
}

function parseLimit(raw: string): Parsed {
  const days = /^\d{1,2}$/.test(raw) ? Number(raw) : 0;
  return days >= 1 && days <= MAX_DAYS ? days : INVALID;
}

const PARAMS: Readonly<Record<string, (raw: string) => Parsed>> = {
  from: parseDate,
  to: parseDate,
  before: parseDate,
  book: parseText,
  instrument: parseText,
  action: parseAction,
  veto: parseText,
  limit: parseLimit,
};

function parseParam(
  params: URLSearchParams,
  key: string,
): { readonly value: string | number } | string {
  const parse = Object.hasOwn(PARAMS, key) ? PARAMS[key] : undefined;
  if (parse === undefined) return `unknown parameter; allowed: ${Object.keys(PARAMS).join(', ')}`;
  const values = params.getAll(key);
  if (values.length > 1) return `${key} is given more than once`;
  const value = parse(values[0] as string);
  return value === INVALID ? `${key} is invalid` : { value };
}

export function parseJournalQuery(params: URLSearchParams): JournalQueryResult {
  const query: Record<string, string | number> = { limit: DEFAULT_DAYS };
  for (const key of new Set(params.keys())) {
    const parsed = parseParam(params, key);
    if (typeof parsed === 'string') return { ok: false, reason: parsed };
    query[key] = parsed.value;
  }
  const { from, to } = query;
  if (from !== undefined && to !== undefined && from > to) {
    return { ok: false, reason: 'from is after to' };
  }
  return { ok: true, query: query as unknown as JournalQuery };
}

export function vetoOf(action: SleeveAction, reason: string): string | null {
  return action === 'skip' && reason.startsWith(VETO_PREFIX)
    ? reason.slice(VETO_PREFIX.length).trim()
    : null;
}

interface Filter {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const DATE_BOUNDS = [
  ['from', '>='],
  ['to', '<='],
  ['before', '<'],
] as const;

function dateFilters(query: JournalQuery, alias: string): Filter[] {
  return DATE_BOUNDS.flatMap(([key, op]) => {
    const value = query[key];
    return value === undefined ? [] : [{ sql: `${alias}.trading_date ${op} ?`, params: [value] }];
  });
}

function scopeFilters(query: JournalQuery, alias: string): Filter[] {
  const filters: Filter[] = [];
  if (query.book !== undefined) filters.push({ sql: `${alias}.book_id = ?`, params: [query.book] });
  if (query.instrument !== undefined) {
    filters.push({ sql: `${alias}.instrument = ? COLLATE NOCASE`, params: [query.instrument] });
  }
  return filters;
}

const IS_VETO = 'substr(d.reason, 1, ?) = ?';
const VETO_PARAMS = [VETO_PREFIX.length, VETO_PREFIX];

function actionFilters(action: JournalActionFilterWire | undefined): Filter[] {
  if (action === undefined) return [];
  if (action === 'vetoed')
    return [{ sql: `d.action = 'skip' AND ${IS_VETO}`, params: VETO_PARAMS }];
  if (action === 'skip')
    return [{ sql: `d.action = 'skip' AND NOT ${IS_VETO}`, params: VETO_PARAMS }];
  return [{ sql: 'd.action = ?', params: [action] }];
}

function vetoFilters(veto: string | undefined): Filter[] {
  if (veto === undefined) return [];
  return [
    {
      sql: `d.action = 'skip' AND ${IS_VETO} AND trim(substr(d.reason, ?)) = ?`,
      params: [...VETO_PARAMS, VETO_PREFIX.length + 1, veto],
    },
  ];
}

function decisionFilters(query: JournalQuery): Filter[] {
  return [...scopeFilters(query, 'd'), ...actionFilters(query.action), ...vetoFilters(query.veto)];
}

function includesUnlinkedOrders(query: JournalQuery): boolean {
  return query.action === undefined && query.veto === undefined;
}

// NULL book_id/instrument means cycle-wide: once a day is selected, a cycle-wide
// refusal must still display under any book/instrument filter, so unlike scopeFilters
// this widens with IS NULL rather than excluding unscoped rows
function refusalDisplayFilters(query: JournalQuery): Filter[] {
  const filters: Filter[] = [];
  if (query.book !== undefined) {
    filters.push({ sql: 'r.book_id IS NULL OR r.book_id = ?', params: [query.book] });
  }
  if (query.instrument !== undefined) {
    filters.push({
      sql: 'r.instrument IS NULL OR r.instrument = ? COLLATE NOCASE',
      params: [query.instrument],
    });
  }
  return filters;
}

function where(filters: readonly Filter[]): Filter {
  return filters.length === 0
    ? { sql: '', params: [] }
    : {
        sql: `WHERE ${filters.map((filter) => `(${filter.sql})`).join(' AND ')}`,
        params: filters.flatMap((filter) => filter.params),
      };
}

function inDays(alias: string, days: readonly string[]): Filter {
  return {
    sql: `${alias}.trading_date IN (SELECT value FROM json_each(?))`,
    params: [JSON.stringify(days)],
  };
}

function daySources(query: JournalQuery): Filter[] {
  const decisions = where([...dateFilters(query, 'd'), ...decisionFilters(query)]);
  const sources = [
    { sql: `SELECT d.trading_date FROM v2_decisions d ${decisions.sql}`, params: decisions.params },
  ];
  if (includesUnlinkedOrders(query)) {
    const orders = where([
      { sql: 'o.decision_id IS NULL', params: [] },
      ...dateFilters(query, 'o'),
      ...scopeFilters(query, 'o'),
    ]);
    sources.push({
      sql: `SELECT o.trading_date FROM v2_orders o ${orders.sql}`,
      params: orders.params,
    });
  }
  if (includesUnlinkedOrders(query)) {
    // Exact-match here, not refusalDisplayFilters: a cycle-wide refusal must not
    // make every day match a book/instrument filter
    const refusals = where([...dateFilters(query, 'r'), ...scopeFilters(query, 'r')]);
    sources.push({
      sql: `SELECT r.trading_date FROM v2_refusals r ${refusals.sql}`,
      params: refusals.params,
    });
  }
  return sources;
}

interface DecisionRow {
  decision_id: string;
  book_id: string;
  variant: string;
  trading_date: string;
  instrument: string;
  venue: string;
  direction: string;
  action: SleeveAction;
  reason: string;
  confidence: number;
  size_shares: number;
  stop_price: number | null;
  inputs_hash: string;
  payload: string;
  recorded_at: string;
}

interface OrderRow {
  client_order_id: string;
  decision_id: string | null;
  book_id: string;
  trading_date: string;
  instrument: string;
  venue: string;
  leg: string;
  side: string;
  dry_run: number;
  outcome: string;
  payload: string;
  recorded_at: string;
}

type FillRow = JournalFillWire & { client_order_id: string };
type RefusalRow = Omit<JournalRefusalWire, 'feature_off'> & { trading_date: string };

const FEATURE_LABELS: ReadonlyMap<string, string> = new Map([
  [G18_SOCIAL_SOURCE.name, 'social source'],
  [G18_SMALL_CAP_FLOORS.name, 'small-cap floors'],
  [G18_SENTIMENT_DEDUP_RULE.name, 'sentiment dedup'],
  [ALPACA_SHORT_EQUITY_FLOOR_USD.name, 'Alpaca shorts floor'],
  [LSE_LIQUIDITY_SCREEN.name, 'LSE liquidity screen'],
]);

// David 2026-09-30: paper needs CFDs, so an unset CFD gate is a blocker to keep in view,
// not a feature switched off
const CFD_GATE_NAMES: ReadonlySet<string> = new Set(
  CFD_ENTRY_GATES.map(({ parameter }) => parameter.name),
);

// 'universe' qualifies only because every universe refusal is built from an
// UnsetParameterError (`buildUniverse` in server/apps/v2/signal/debate-sleeve.ts); a
// universe refusal of any other kind would be hidden in the collapsed row
const FEATURE_OFF_SCOPES: ReadonlySet<string> = new Set(['parameter', 'universe']);

export function featureOffLabel(scope: string, parameter: string): string | null {
  if (!FEATURE_OFF_SCOPES.has(scope) || CFD_GATE_NAMES.has(parameter)) return null;
  return FEATURE_LABELS.get(parameter) ?? parameter;
}

const ORDER_COLUMNS = `o.client_order_id, o.decision_id, o.book_id, o.trading_date, o.instrument,
  o.venue, o.leg, o.side, o.dry_run, o.outcome, o.payload, o.recorded_at`;

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string | null): Map<string | null, T[]> {
  const groups = new Map<string | null, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

function debateIdOf(payload: Record<string, unknown>): string | null {
  return typeof payload.debate_id === 'string' ? payload.debate_id : null;
}

function orderWire(row: OrderRow, fills: ReadonlyMap<string | null, FillRow[]>): JournalOrderWire {
  return {
    client_order_id: row.client_order_id,
    book_id: row.book_id,
    instrument: row.instrument,
    venue: row.venue,
    leg: row.leg,
    side: row.side,
    dry_run: row.dry_run === 1,
    outcome: row.outcome,
    payload: JSON.parse(row.payload),
    recorded_at: row.recorded_at,
    fills: (fills.get(row.client_order_id) ?? []).map(
      ({ client_order_id: _order, ...fill }) => fill,
    ),
  };
}

function decisionWire(row: DecisionRow, orders: readonly JournalOrderWire[]): JournalDecisionWire {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  const veto = vetoOf(row.action, row.reason);
  return {
    decision_id: row.decision_id,
    book_id: row.book_id,
    variant: row.variant,
    instrument: row.instrument,
    venue: row.venue,
    direction: row.direction,
    action: row.action,
    vetoed: veto !== null,
    veto,
    reason: row.reason,
    confidence: row.confidence,
    size_shares: row.size_shares,
    stop_price: row.stop_price,
    inputs_hash: row.inputs_hash,
    debate_id: debateIdOf(payload),
    payload,
    recorded_at: row.recorded_at,
    orders,
  };
}

function refusalWire({ trading_date: _day, ...refusal }: RefusalRow): JournalRefusalWire {
  return { ...refusal, feature_off: featureOffLabel(refusal.scope, refusal.parameter) };
}

export class JournalReader {
  constructor(private readonly db: StoreHandle) {}

  read(query: JournalQuery): JournalWire {
    return this.db.transaction(() => this.#page(query))();
  }

  #page(query: JournalQuery): JournalWire {
    const found = this.#days(query);
    const days = found.slice(0, query.limit);
    const decisions = this.#decisions(query, days);
    const unlinked = includesUnlinkedOrders(query) ? this.#unlinkedOrders(query, days) : [];
    const linked = this.#all<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM v2_orders o
        WHERE o.decision_id IN (SELECT value FROM json_each(?))
        ORDER BY o.recorded_at, o.client_order_id`,
      [JSON.stringify(decisions.map((row) => row.decision_id))],
    );
    const fills = this.#fills([...linked, ...unlinked]);
    const ordersByDecision = groupBy(linked, (row) => row.decision_id);
    const refusals = this.#refusals(query, days);
    const toOrder = (order: OrderRow) => orderWire(order, fills);
    const decisionsByDay = groupBy(
      decisions.map((row) => ({
        trading_date: row.trading_date,
        wire: decisionWire(row, (ordersByDecision.get(row.decision_id) ?? []).map(toOrder)),
      })),
      (row) => row.trading_date,
    );
    const unlinkedByDay = groupBy(unlinked, (row) => row.trading_date);
    const refusalsByDay = groupBy(refusals, (row) => row.trading_date);
    return {
      contract_version: V2_CONTRACT_VERSION,
      days: days.map(
        (day): JournalDayWire => ({
          trading_date: day,
          decisions: (decisionsByDay.get(day) ?? []).map((row) => row.wire),
          unlinked_orders: (unlinkedByDay.get(day) ?? []).map(toOrder),
          refusals: (refusalsByDay.get(day) ?? []).map(refusalWire),
        }),
      ),
      next_before: found.length > query.limit ? (days.at(-1) as string) : null,
    };
  }

  #all<T>(sql: string, params: readonly unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  #days(query: JournalQuery): string[] {
    const sources = daySources(query);
    return this.#all<{ trading_date: string }>(
      `SELECT DISTINCT trading_date FROM (${sources.map((source) => source.sql).join(' UNION ')})
        ORDER BY trading_date DESC LIMIT ?`,
      [...sources.flatMap((source) => source.params), query.limit + 1],
    ).map((row) => row.trading_date);
  }

  #decisions(query: JournalQuery, days: readonly string[]): DecisionRow[] {
    const filter = where([inDays('d', days), ...decisionFilters(query)]);
    return this.#all<DecisionRow>(
      `SELECT d.decision_id, d.book_id, b.variant, d.trading_date, d.instrument, d.venue, d.direction,
              d.action, d.reason, d.confidence, d.size_shares, d.stop_price, d.inputs_hash, d.payload,
              d.recorded_at
         FROM v2_decisions d JOIN v2_books b USING (book_id) ${filter.sql}
        ORDER BY d.trading_date DESC, b.sleeve_id, b.variant <> 'primary', d.book_id, d.instrument,
                 d.decision_id`,
      filter.params,
    );
  }

  #unlinkedOrders(query: JournalQuery, days: readonly string[]): OrderRow[] {
    const filter = where([
      { sql: 'o.decision_id IS NULL', params: [] },
      inDays('o', days),
      ...scopeFilters(query, 'o'),
    ]);
    return this.#all<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM v2_orders o LEFT JOIN v2_books b ON b.book_id = o.book_id
        ${filter.sql}
        ORDER BY b.sleeve_id, b.variant <> 'primary', o.book_id, o.instrument, o.recorded_at,
                 o.client_order_id`,
      filter.params,
    );
  }

  #fills(orders: readonly OrderRow[]): Map<string | null, FillRow[]> {
    const rows = this.#all<FillRow>(
      `SELECT client_order_id, fill_id, qty, price_gbp, fee_gbp, recorded_at FROM v2_fills
        WHERE client_order_id IN (SELECT value FROM json_each(?))
        ORDER BY recorded_at, fill_id`,
      [JSON.stringify(orders.map((order) => order.client_order_id))],
    );
    return groupBy(rows, (row) => row.client_order_id);
  }

  #refusals(query: JournalQuery, days: readonly string[]): RefusalRow[] {
    const filter = where([inDays('r', days), ...refusalDisplayFilters(query)]);
    return this.#all<RefusalRow>(
      `SELECT r.refusal_id, r.trading_date, r.scope, r.parameter, r.ticket, r.message, r.book_id,
              r.instrument, r.recorded_at
         FROM v2_refusals r ${filter.sql} ORDER BY r.refusal_id`,
      filter.params,
    );
  }
}
