import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DailyBar } from '../../../pipeline/momentum/index.js';
import { ParquetBarStore } from '../../../providers/bar-store/index.js';
import { heldKey, ParquetMarkSource } from './marks.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bar(date: string, rawClose: number): DailyBar {
  return {
    date,
    open: rawClose,
    high: rawClose,
    low: rawClose,
    close: rawClose,
    volume: 1,
    rawClose,
  };
}

async function storeWith(
  venue: string,
  symbol: string,
  bars: readonly DailyBar[],
): Promise<string> {
  const root = dirs.at(-1) ?? mkdtempSync(join(tmpdir(), 'v2-marks-'));
  if (!dirs.includes(root)) dirs.push(root);
  const store = await ParquetBarStore.open(root);
  try {
    await store.write(venue, [{ symbol, bars }]);
  } finally {
    store.close();
  }
  return root;
}

const AAPL = { venue: 'alpaca', instrument: 'AAPL' } as const;

describe('ParquetMarkSource', () => {
  it('returns the last bar strictly before the date, per venue and instrument', async () => {
    const root = await storeWith('alpaca', 'AAPL', [
      bar('2026-10-01', 100),
      bar('2026-10-02', 101),
      bar('2026-10-05', 105),
    ]);
    const found = await new ParquetMarkSource(root).lastBarsBefore([AAPL], '2026-10-05');
    expect(found.get(heldKey(AAPL))).toEqual(bar('2026-10-02', 101));
  });

  it('reads the store afresh on every call, so a new bar moves the mark', async () => {
    const root = await storeWith('alpaca', 'AAPL', [bar('2026-10-01', 100)]);
    const source = new ParquetMarkSource(root);
    expect((await source.lastBarsBefore([AAPL], '2026-10-06')).get(heldKey(AAPL))).toMatchObject({
      date: '2026-10-01',
    });
    await storeWith('alpaca', 'AAPL', [bar('2026-10-01', 100), bar('2026-10-02', 102)]);
    expect((await source.lastBarsBefore([AAPL], '2026-10-06')).get(heldKey(AAPL))).toMatchObject({
      date: '2026-10-02',
      rawClose: 102,
    });
  });

  it('has no bar for an unknown instrument or venue, and a fault for an unreadable one', async () => {
    const root = await storeWith('alpaca', 'AAPL', [bar('2026-10-01', 100)]);
    const held = [
      { venue: 'alpaca', instrument: 'MSFT' },
      { venue: 'saxo', instrument: 'AAPL' },
      { venue: 'alpaca', instrument: 'not a symbol' },
    ] as const;
    const found = await new ParquetMarkSource(root).lastBarsBefore(held, '2026-10-06');
    expect(found.get('alpaca:MSFT')).toBeUndefined();
    expect(found.has('alpaca:MSFT')).toBe(true);
    expect(found.get('saxo:AAPL')).toBeUndefined();
    expect(found.get('alpaca:not a symbol')).toBeInstanceOf(Error);
  });

  it('turns a store that will not open into a fault for every holding', async () => {
    vi.spyOn(ParquetBarStore, 'open').mockRejectedValue('duckdb gone');
    const found = await new ParquetMarkSource('/any').lastBarsBefore([AAPL], '2026-10-06');
    expect(found.get(heldKey(AAPL))).toEqual(new Error('duckdb gone'));
  });

  it('reads nothing, and opens no store, when nothing is held', async () => {
    const open = vi.spyOn(ParquetBarStore, 'open');
    expect(
      (await new ParquetMarkSource('/nonexistent').lastBarsBefore([], '2026-10-06')).size,
    ).toBe(0);
    expect(open).not.toHaveBeenCalled();
  });

  it('closes the store it opened, even when a read faults', async () => {
    const root = await storeWith('alpaca', 'AAPL', [bar('2026-10-01', 100)]);
    const close = vi.spyOn(ParquetBarStore.prototype, 'close');
    await new ParquetMarkSource(root).lastBarsBefore(
      [AAPL, { venue: 'alpaca', instrument: 'not a symbol' }],
      '2026-10-06',
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
