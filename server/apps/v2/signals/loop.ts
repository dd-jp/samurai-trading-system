import type { Clock, Logger } from '../../../shared/index.js';
import { describeThrownSafely } from '../../../shared/index.js';
import type { SignalPass, SignalProcessorStore, V2Root } from '../index.js';
import { sessionDate, signalsDue } from './processor.js';

export const SIGNAL_POLL_MS = 30_000;

export interface SignalLoopDeps {
  readonly signals: SignalProcessorStore;
  readonly calendar: { isOpen(instant: Date): boolean };
  readonly clock: Clock;
  readonly logger: Logger;
  readonly openRoot: (tradingDate: string) => Pick<V2Root, 'processSignals' | 'close'>;
  readonly onPass?: (ok: boolean) => void;
}

export class SignalLoop {
  #running: Promise<void> | undefined;
  #again = false;

  constructor(private readonly deps: SignalLoopDeps) {}

  tick(): Promise<void> {
    if (this.#running !== undefined) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#drain().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #drain(): Promise<void> {
    do {
      this.#again = false;
      await this.#once();
    } while (this.#again);
  }

  async #once(): Promise<void> {
    const now = this.deps.clock.now();
    let root: Pick<V2Root, 'processSignals' | 'close'> | undefined;
    try {
      if (!signalsDue(this.deps, now)) return;
      root = this.deps.openRoot(sessionDate(now));
      this.#report(await root.processSignals(this.deps.signals, now));
      this.deps.onPass?.(true);
    } catch (error) {
      this.#log('error', 'v2_signal_pass_failed', describeThrownSafely(error));
      this.deps.onPass?.(false);
    } finally {
      root?.close();
    }
  }

  #report(pass: SignalPass): void {
    if (pass.ran) {
      this.#log('info', 'v2_signal_pass', `${pass.outcomes.length} signals settled`);
      return;
    }
    this.#log('info', 'v2_signal_pass_skipped', `${pass.reason}: ${pass.detail}`);
  }

  #log(level: 'error' | 'info', event: string, message: string): void {
    this.deps.logger.log({ trace_id: 'v2-signals', stage: 'v2', level, event, message });
  }
}
