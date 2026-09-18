import type { NativeBracketRequest, NormalizedFill } from './types.js';

export type BrokerVenue = 'alpaca' | 'saxo';

export type BrokerBracketPhase =
  | 'submitting'
  | 'pending_entry'
  | 'arming'
  | 'armed'
  | 'cancelling_sibling'
  | 'resolved';

export interface BrokerBracketRecord {
  venue: BrokerVenue;
  client_order_id: string;
  phase: BrokerBracketPhase;
  entry_order_id: string | null;
  stop_order_id: string | null;
  target_order_id: string | null;
  request: BrokerBracketRequestFields | null;
  armed_qty: number | null;
  arming_qty: number | null;
  arm_attempt: number;
}

export type BrokerBracketRequestFields = Omit<NativeBracketRequest, 'client_order_id'>;

export function toRequestFields(order: NativeBracketRequest): BrokerBracketRequestFields {
  const { client_order_id: _clientOrderId, ...fields } = order;
  return fields;
}

export interface BrokerBracketOrderIds {
  entry_order_id: string | null;
  stop_order_id: string | null;
  target_order_id: string | null;
}

export interface UnpricedFillObservation {
  client_order_id: string;
  broker_fill_id: string;
  leg: NormalizedFill['leg'];
  instrument: string;
  qty: number;
}

export interface UnpricedFillRecord extends UnpricedFillObservation {
  first_seen_at: Date;
  last_seen_at: Date;
  alerted_at: Date | null;
}

export interface BrokerStateStore {
  loadBrackets(venue: BrokerVenue): BrokerBracketRecord[];
  saveBracket(record: BrokerBracketRecord): void;
  recordBracketOrderIds(
    venue: BrokerVenue,
    clientOrderId: string,
    ids: BrokerBracketOrderIds,
  ): void;
  recordUnpricedFill(venue: BrokerVenue, observation: UnpricedFillObservation, seenAt: Date): void;
  loadUnpricedFills(venue: BrokerVenue): UnpricedFillRecord[];
  markUnpricedFillAlerted(
    venue: BrokerVenue,
    clientOrderId: string,
    brokerFillId: string,
    alertedAt: Date,
  ): void;
  clearUnpricedFill(venue: BrokerVenue, clientOrderId: string, brokerFillId: string): void;
}

export class InMemoryBrokerStateStore implements BrokerStateStore {
  private readonly brackets = new Map<string, BrokerBracketRecord>();
  private readonly unpriced = new Map<string, UnpricedFillRecord & { venue: BrokerVenue }>();

  loadBrackets(venue: BrokerVenue): BrokerBracketRecord[] {
    return [...this.brackets.values()].filter((record) => record.venue === venue);
  }

  saveBracket(record: BrokerBracketRecord): void {
    const existing = this.brackets.get(key(record.venue, record.client_order_id));
    this.brackets.set(key(record.venue, record.client_order_id), {
      ...record,
      request: record.request ?? existing?.request ?? null,
    });
  }

  recordBracketOrderIds(
    venue: BrokerVenue,
    clientOrderId: string,
    ids: BrokerBracketOrderIds,
  ): void {
    const existing = this.brackets.get(key(venue, clientOrderId));
    this.brackets.set(key(venue, clientOrderId), {
      venue,
      client_order_id: clientOrderId,
      phase: existing?.phase ?? 'armed',
      request: existing?.request ?? null,
      armed_qty: existing?.armed_qty ?? null,
      arming_qty: existing?.arming_qty ?? null,
      arm_attempt: existing?.arm_attempt ?? 0,
      entry_order_id: ids.entry_order_id ?? existing?.entry_order_id ?? null,
      stop_order_id: ids.stop_order_id ?? existing?.stop_order_id ?? null,
      target_order_id: ids.target_order_id ?? existing?.target_order_id ?? null,
    });
  }

  recordUnpricedFill(venue: BrokerVenue, observation: UnpricedFillObservation, seenAt: Date): void {
    const rowKey = fillKey(venue, observation.client_order_id, observation.broker_fill_id);
    const existing = this.unpriced.get(rowKey);
    this.unpriced.set(rowKey, {
      ...observation,
      venue,
      first_seen_at: existing?.first_seen_at ?? seenAt,
      last_seen_at: seenAt,
      alerted_at: existing?.alerted_at ?? null,
    });
  }

  loadUnpricedFills(venue: BrokerVenue): UnpricedFillRecord[] {
    return [...this.unpriced.values()]
      .filter((row) => row.venue === venue)
      .map(({ venue: _venue, ...row }) => row)
      .sort((a, b) => a.first_seen_at.getTime() - b.first_seen_at.getTime());
  }

  markUnpricedFillAlerted(
    venue: BrokerVenue,
    clientOrderId: string,
    brokerFillId: string,
    alertedAt: Date,
  ): void {
    const existing = this.unpriced.get(fillKey(venue, clientOrderId, brokerFillId));
    if (existing === undefined) return;
    existing.alerted_at = alertedAt;
  }

  clearUnpricedFill(venue: BrokerVenue, clientOrderId: string, brokerFillId: string): void {
    this.unpriced.delete(fillKey(venue, clientOrderId, brokerFillId));
  }
}

function key(venue: BrokerVenue, clientOrderId: string): string {
  return `${venue}|${clientOrderId}`;
}

function fillKey(venue: BrokerVenue, clientOrderId: string, brokerFillId: string): string {
  return `${venue}|${clientOrderId}|${brokerFillId}`;
}
