import type { Direction } from '../../../../contracts/index.js';

export type Venue = 'alpaca' | 'saxo';

export type SleeveAction = 'enter_long' | 'enter_short' | 'skip' | 'none';

export interface SleeveDecision {
  readonly sleeve_id: string;
  readonly instrument: string;
  readonly venue: Venue;
  readonly direction: Direction;
  readonly confidence: number;
  readonly action: SleeveAction;
  readonly reason: string;
  readonly price: number;
  readonly atr: number | undefined;
  readonly stop_price: number | undefined;
  readonly inputs_hash: string;
  readonly debate_id: string | undefined;
  readonly payload: Record<string, unknown>;
}

export interface SleeveContext {
  readonly tradingDate: string;
  readonly macroDay: boolean;
  readonly dryRun: boolean;
}

export interface SleeveRefusal {
  readonly scope: string;
  readonly parameter: string;
  readonly ticket: string;
  readonly message: string;
}

export interface SleeveOutput {
  readonly decisions: readonly SleeveDecision[];
  readonly refusals: readonly SleeveRefusal[];
}

export interface Sleeve {
  readonly id: string;
  decide(context: SleeveContext): Promise<SleeveOutput>;
}

export class SleeveRegistry {
  readonly #sleeves = new Map<string, Sleeve>();

  register(sleeve: Sleeve): void {
    if (this.#sleeves.has(sleeve.id)) {
      throw new Error(`SleeveRegistry: sleeve '${sleeve.id}' is already registered`);
    }
    this.#sleeves.set(sleeve.id, sleeve);
  }

  list(): readonly Sleeve[] {
    return [...this.#sleeves.values()];
  }

  ids(): readonly string[] {
    return [...this.#sleeves.keys()];
  }
}
