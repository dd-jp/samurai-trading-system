import type { Clock, Logger } from '../../shared/index.js';
import { describeThrownSafely } from '../../shared/index.js';
import {
  FLATTEN_POLL_MS,
  type FlattenLedger,
  type FlattenPass,
  type FlattenTarget,
} from './flatten.js';
import type { V2Root } from './index.js';

export interface FlattenLoopDeps {
  readonly ledger: Pick<FlattenLedger, 'due'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly openRoot: (tradingDate: string) => Pick<V2Root, 'flatten' | 'close'>;
  readonly notify: (text: string) => Promise<void>;
  readonly flush: () => Promise<void>;
}

export class FlattenLoop {
  #running: Promise<void> | undefined;

  constructor(private readonly deps: FlattenLoopDeps) {}

  start(): () => void {
    const poll = setInterval(() => {
      void this.tick();
    }, FLATTEN_POLL_MS);
    void this.tick();
    return () => clearInterval(poll);
  }

  tick(): Promise<void> {
    this.#running ??= this.#once().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  settled(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }

  async #once(): Promise<void> {
    let root: Pick<V2Root, 'flatten' | 'close'> | undefined;
    try {
      const target = this.deps.ledger.due(this.deps.clock.now().toISOString().slice(0, 10));
      if (target === undefined) return;
      root = this.deps.openRoot(target.tradingDate);
      await this.#report(target, await root.flatten(target));
    } catch (error) {
      this.#log('error', 'v2_flatten_failed', describeThrownSafely(error));
    } finally {
      root?.close();
      await this.deps.flush();
    }
  }

  async #report(target: FlattenTarget, pass: FlattenPass): Promise<void> {
    if (!pass.ran) {
      this.#log(
        'info',
        'v2_flatten_deferred',
        `control ${target.controlId}: run lease held by ${pass.detail}; retried at the next poll`,
      );
      return;
    }
    if (pass.result.outcome === 'closed') {
      await this.deps.notify(
        `Flatten done (control ${target.controlId}): every position has its exit in flight. ${pass.result.detail}`,
      );
    }
  }

  #log(level: 'error' | 'info', event: string, message: string): void {
    this.deps.logger.log({ trace_id: 'v2-flatten', stage: 'v2', level, event, message });
  }
}
