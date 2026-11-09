import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ParquetBarStore } from '../../providers/bar-store/index.js';
import type { ChartPage, ChartSample } from '../../providers/saxo-bars/index.js';
import type { DailyBar } from '../../shared/index.js';
import { type CfdCatalogue, parseCfdCatalogue } from './data/index.js';
import {
  fillUkBarHeads,
  parseUkBarHeadArgs,
  runUkBarHead,
  type UkBarHeadApi,
} from './uk-stock-bar-head.js';

const SYMBOL = 'OCDO_XLON';
const TODAY = '2026-11-09';
const OLDER = ['2022-01-13', '2022-01-14', '2022-01-17'];
const STORED = ['2022-01-18', '2022-01-19', '2022-01-20'];

const stores: ParquetBarStore[] = [];
afterAll(() => {
  for (const store of stores) store.close();
});

function catalogue(): CfdCatalogue {
  return parseCfdCatalogue(
    JSON.stringify({
      asOf: TODAY,
      instruments: [
        {
          symbol: SYMBOL,
          saxoSymbol: 'OCDO:xlon',
          uic: 77,
          assetType: 'CfdOnStock',
          currency: 'GBP',
          priceToContractFactor: 0.01,
          tradable: true,
          shortTradeDisabled: false,
          borrowCostPerDay: null,
          bid: 5,
          ask: 5.01,
          averageVolume30Days: 10_000_000,
        },
      ],
    }),
  );
}

function sample(date: string, pence: number): ChartSample {
  return {
    Time: `${date}T00:00:00.000000Z`,
    Open: pence,
    High: pence,
    Low: pence,
    Close: pence,
    Volume: 1_000,
  };
}

function apiOf(dates: readonly string[], revised: Record<string, number> = {}) {
  const calls: Array<[number, string]> = [];
  const api: UkBarHeadApi = {
    dailyHistory: async (uic, assetType) => {
      calls.push([uic, assetType]);
      const page: ChartPage = {
        firstSampleTime: undefined,
        delayedByMinutes: 15,
        samples: dates.map((date) => sample(date, revised[date] ?? 500)),
      };
      return page;
    },
  };
  return { api, calls };
}

function bar(date: string, rawClose = 5): DailyBar {
  return { date, open: 5, high: 5, low: 5, close: 5, volume: 1_000, rawClose };
}

async function storeWith(rawClose = 5): Promise<{ store: ParquetBarStore; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'uk-bar-head-'));
  const store = await ParquetBarStore.open(root);
  stores.push(store);
  await store.write('saxo', [{ symbol: SYMBOL, bars: STORED.map((d) => bar(d, rawClose)) }]);
  return { store, root };
}

const request = (write: boolean) => ({
  symbols: [SYMBOL],
  from: '2022-01-14',
  tradingDate: TODAY,
  write,
});

async function storedDates(store: ParquetBarStore): Promise<string[]> {
  return ((await store.readSeries('saxo', SYMBOL))?.bars ?? []).map((one) => one.date);
}

describe('fillUkBarHeads (#2143)', () => {
  it('pages CfdOnStock history and only reports on a dry run', async () => {
    const { store } = await storeWith();
    const { api, calls } = apiOf([...OLDER, ...STORED]);
    await expect(fillUkBarHeads(api, store, catalogue(), request(false))).resolves.toEqual([
      { symbol: SYMBOL, outcome: 'would_fill', added: ['2022-01-14', '2022-01-17'] },
    ]);
    expect(calls).toEqual([[77, 'CfdOnStock']]);
    await expect(storedDates(store)).resolves.toEqual(STORED);
  });

  it('prepends only bars from the pinned start, in cash units, keeping the stored bars', async () => {
    const { store } = await storeWith();
    const { api } = apiOf([...OLDER, ...STORED]);
    await expect(fillUkBarHeads(api, store, catalogue(), request(true))).resolves.toEqual([
      { symbol: SYMBOL, outcome: 'filled', added: ['2022-01-14', '2022-01-17'] },
    ]);
    await expect(storedDates(store)).resolves.toEqual(['2022-01-14', '2022-01-17', ...STORED]);
    const first = (await store.readSeries('saxo', SYMBOL))?.bars[0];
    expect(first?.close).toBe(5);
  });

  it('ignores a data hole older than the pinned start', async () => {
    const { store } = await storeWith();
    const { api } = apiOf([...OLDER, ...STORED], { '2022-01-13': 5_000 });
    await expect(fillUkBarHeads(api, store, catalogue(), request(false))).resolves.toEqual([
      { symbol: SYMBOL, outcome: 'would_fill', added: ['2022-01-14', '2022-01-17'] },
    ]);
  });

  it('gives prepended bars the stored raw scale', async () => {
    const { store } = await storeWith(10);
    const { api } = apiOf([...OLDER, ...STORED]);
    await fillUkBarHeads(api, store, catalogue(), request(true));
    expect((await store.readSeries('saxo', SYMBOL))?.bars[0]?.rawClose).toBe(10);
  });

  it('refuses and writes nothing when one overlapping field differs', async () => {
    const { store } = await storeWith();
    const { api } = apiOf([...OLDER, ...STORED], { '2022-01-19': 501 });
    await expect(fillUkBarHeads(api, store, catalogue(), request(true))).resolves.toEqual([
      {
        symbol: SYMBOL,
        outcome: 'refused',
        reason: '2022-01-19 open is 5 stored and 5.01 from Saxo',
      },
    ]);
    await expect(storedDates(store)).resolves.toEqual(STORED);
  });

  it('refuses when Saxo no longer serves a stored bar', async () => {
    const { store } = await storeWith();
    const { api } = apiOf([...OLDER, ...STORED.slice(1)]);
    await expect(fillUkBarHeads(api, store, catalogue(), request(true))).resolves.toEqual([
      {
        symbol: SYMBOL,
        outcome: 'refused',
        reason: 'Saxo no longer serves the stored bar 2022-01-18',
      },
    ]);
  });

  it('reports when Saxo holds nothing older', async () => {
    const { store } = await storeWith();
    const { api } = apiOf(STORED);
    await expect(fillUkBarHeads(api, store, catalogue(), request(true))).resolves.toEqual([
      { symbol: SYMBOL, outcome: 'nothing_older' },
    ]);
  });

  it('refuses a name outside the catalogue or with no stored bars', async () => {
    const { store } = await storeWith();
    const { api } = apiOf(STORED);
    await expect(
      fillUkBarHeads(api, store, catalogue(), { ...request(true), symbols: ['NOPE_XLON'] }),
    ).resolves.toEqual([
      { symbol: 'NOPE_XLON', outcome: 'refused', reason: 'not in the CFD catalogue' },
    ]);
    const empty = await ParquetBarStore.open(mkdtempSync(join(tmpdir(), 'uk-bar-head-')));
    stores.push(empty);
    await expect(fillUkBarHeads(api, empty, catalogue(), request(true))).resolves.toEqual([
      { symbol: SYMBOL, outcome: 'refused', reason: 'no stored bars to extend' },
    ]);
  });

  it('turns a failed pull into a refusal for that name', async () => {
    const { store } = await storeWith();
    const api: UkBarHeadApi = {
      dailyHistory: async () => {
        throw new Error('Saxo 404');
      },
    };
    await expect(fillUkBarHeads(api, store, catalogue(), request(true))).resolves.toEqual([
      { symbol: SYMBOL, outcome: 'refused', reason: 'Saxo 404' },
    ]);
  });
});

describe('parseUkBarHeadArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseUkBarHeadArgs(['--symbols', 'A,B', '--from', '2022-01-14'], TODAY)).toEqual({
      symbols: ['A', 'B'],
      from: '2022-01-14',
      tradingDate: TODAY,
      write: false,
    });
  });

  it('writes only on an explicit mode', () => {
    const args = ['--symbols', 'A', '--from', '2022-01-14', '--mode', 'write'];
    expect(parseUkBarHeadArgs(args, TODAY).write).toBe(true);
  });

  it.each([
    [['--from', '2022-01-14']],
    [['--symbols', 'A']],
    [['--symbols', 'A', '--from', 'soon']],
    [['--symbols', 'A', '--from', '2022-01-14', '--mode', 'maybe']],
  ])('rejects %j', (args) => {
    expect(() => parseUkBarHeadArgs(args, TODAY)).toThrow(/usage/);
  });
});

describe('runUkBarHead', () => {
  const argv = ['--symbols', SYMBOL, '--from', '2022-01-14'];

  function depsFor(root: string, api: UkBarHeadApi) {
    const lines: string[] = [];
    let stopped = 0;
    return {
      lines,
      stopped: () => stopped,
      deps: {
        connect: () => ({
          api,
          stop: async () => {
            stopped += 1;
          },
        }),
        storeRoot: root,
        catalogue: () => catalogue() as CfdCatalogue | undefined,
        now: () => new Date(`${TODAY}T12:00:00Z`),
        write: (line: string) => void lines.push(line),
      },
    };
  }

  it('prints each outcome, exits 0 and stops the session', async () => {
    const { root } = await storeWith();
    const run = depsFor(root, apiOf([...OLDER, ...STORED]).api);
    await expect(runUkBarHead(argv, run.deps)).resolves.toBe(0);
    expect(JSON.parse(run.lines[0] ?? '').outcome).toBe('would_fill');
    expect(run.stopped()).toBe(1);
  });

  it('exits 1 on any refusal', async () => {
    const { root } = await storeWith();
    const run = depsFor(root, apiOf(STORED.slice(1)).api);
    await expect(runUkBarHead(argv, run.deps)).resolves.toBe(1);
  });

  it('throws with no catalogue, before connecting', async () => {
    const { root } = await storeWith();
    const run = depsFor(root, apiOf(STORED).api);
    await expect(runUkBarHead(argv, { ...run.deps, catalogue: () => undefined })).rejects.toThrow(
      'no CFD catalogue on disk',
    );
    expect(run.stopped()).toBe(0);
  });
});
