import { describe, expect, it } from 'vitest';
import { currentTraceId, runWithTraceId } from './trace-context.js';

describe('trace context', () => {
  it('is undefined outside a tick, so call sites keep their own fallback label', () => {
    expect(currentTraceId()).toBeUndefined();
  });

  it('is readable inside the run', () => {
    runWithTraceId('tick-1', () => {
      expect(currentTraceId()).toBe('tick-1');
    });
  });

  it('survives await boundaries — the whole point, since the log sites are several awaits deep', async () => {
    await runWithTraceId('tick-2', async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentTraceId()).toBe('tick-2');
    });
  });

  it('does not leak out of the run', async () => {
    await runWithTraceId('tick-3', async () => {
      await Promise.resolve();
    });
    expect(currentTraceId()).toBeUndefined();
  });

  it('keeps concurrent ticks separate', async () => {
    const seen = await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        runWithTraceId(id, async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return currentTraceId();
        }),
      ),
    );
    expect(seen).toEqual(['a', 'b', 'c']);
  });
});
