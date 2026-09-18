import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string>();

export function runWithTraceId<T>(trace_id: string, fn: () => T): T {
  return storage.run(trace_id, fn);
}

export function currentTraceId(): string | undefined {
  return storage.getStore();
}
