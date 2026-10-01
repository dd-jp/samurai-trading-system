export type SignalEntryWire = number | readonly [number, number];

export interface SignalPayloadWire {
  readonly symbol: string;
  readonly entry: SignalEntryWire;
  readonly targets: readonly number[];
  readonly stop: number;
  readonly size?: number | undefined;
  readonly trail_after?: number | undefined;
  readonly source?: string | undefined;
  readonly received_at?: string | undefined;
}

export type SignalSessionWire = 'in_session' | 'out_of_session';

export type SignalStatusWire = 'queued' | 'processed' | 'refused' | 'failed';

export interface SignalEventWire {
  readonly status: SignalStatusWire;
  readonly detail: string;
  readonly recorded_at: string;
}

export interface SignalWire {
  readonly signal_id: string;
  readonly symbol: string;
  readonly entry: SignalEntryWire;
  readonly targets: readonly number[];
  readonly stop: number;
  readonly size: number | null;
  readonly trail_after: number | null;
  readonly source: string | null;
  readonly sent_at: string | null;
  readonly received_at: string;
  readonly session: SignalSessionWire;
  readonly process_after: string;
  readonly status: SignalStatusWire;
  readonly events: readonly SignalEventWire[];
}

export interface SignalPostResponseWire {
  readonly signal: SignalWire;
  readonly replayed: boolean;
}

export interface SignalListWire {
  readonly signals: readonly SignalWire[];
}
