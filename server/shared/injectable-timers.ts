export interface InjectableTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export const DEFAULT_INJECTABLE_TIMERS: InjectableTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs).unref(),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
