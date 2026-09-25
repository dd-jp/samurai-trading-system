import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ParquetBarStore } from '../../../providers/bar-store/index.js';
import { roundBarPrices } from './bar-csv.js';
import { tradingCalendar } from './fixture.js';
import type { SaxoLine } from './lse-lines.js';
import { gbpPerQuotedUnit, isSpliced, LSE_MOMENTUM_LINES } from './lse-lines.js';
import type { SaxoSpreadRow } from './measure-saxo-spread.js';
import {
  BURST_READS,
  BURST_SPACING_MS,
  readQuoteBursts,
  spreadSummary,
} from './measure-saxo-spread.js';
import type { PullContext, SaxoBarsApi } from './pull-saxo-bars.js';
import {
  pullAllLines,
  pullMomentumLine,
  saxoBarsManifest,
  saxoPullSummary,
} from './pull-saxo-bars.js';
import type { ChartSample, InfoPriceQuote, InstrumentDetails } from './saxo-api.js';

const USD_PER_GBP = 1.25;
const SPLICED_START = 200;
const calendar = tradingCalendar('2014-01-06', 400);
const SIBLING_UICS = new Set(
  LSE_MOMENTUM_LINES.filter(isSpliced).map((line) => line.spliceFrom.uic),
);
const SPLICED_UICS = new Set(LSE_MOMENTUM_LINES.filter(isSpliced).map((line) => line.uic));

function gbpClose(index: number): number {
  return 100 + index * 0.1;
}

function unitOf(uic: number): SaxoLine['unit'] {
  if (SIBLING_UICS.has(uic)) return 'USD';
  return LSE_MOMENTUM_LINES.find((line) => line.uic === uic)?.unit ?? 'GBX';
}

function quotedClose(unit: SaxoLine['unit'], gbp: number): number {
  return unit === 'USD' ? gbp * USD_PER_GBP : gbp / gbpPerQuotedUnit(unit);
}

function sample(date: string, close: number): ChartSample {
  return {
    Time: `${date}T00:00:00.000000Z`,
    Open: close,
    High: close,
    Low: close,
    Close: close,
    Volume: 1,
  };
}

function fakeApi(options: { readonly noisySibling?: boolean } = {}): SaxoBarsApi {
  const noise = (unit: SaxoLine['unit'], i: number): number => {
    if (options.noisySibling !== true || unit !== 'USD') return 1;
    return i % 2 === 0 ? 1.002 : 0.998;
  };
  return {
    instrumentDetails: async (uic): Promise<InstrumentDetails> => {
      const unit = unitOf(uic);
      return {
        symbol: String(uic),
        currencyCode: unit,
        priceToContractFactor: unit === 'USD' ? 1 : gbpPerQuotedUnit(unit),
        isTradable: true,
        isComplex: false,
        exchangeId: 'LSE_ETF',
      };
    },
    dailyHistory: async (uic) => {
      const unit = unitOf(uic);
      const start = SPLICED_UICS.has(uic) ? SPLICED_START : 0;
      return {
        firstSampleTime: `${calendar[start]}T00:00:00Z`,
        delayedByMinutes: 15,
        samples: calendar
          .slice(start)
          .map((date, i) =>
            sample(date, quotedClose(unit, gbpClose(start + i)) * noise(unit, start + i)),
          ),
      };
    },
  };
}

function spreadRow(symbol: string): SaxoSpreadRow {
  return {
    symbol,
    uic: 0,
    samples: 5,
    p25HalfSpreadBps: 4,
    medianHalfSpreadBps: 5,
    measuredAt: '2026-09-20T11:00:00Z',
  };
}

let root: string;
let store: ParquetBarStore;

function context(
  api: SaxoBarsApi,
  spreadTidms: readonly string[] = LSE_MOMENTUM_LINES.map((line) => line.tidm),
): PullContext {
  const ctx: PullContext = {
    api,
    store,
    auxDir: join(root, 'aux'),
    rawDir: join(root, 'aux', 'raw'),
    fetchDate: '2026-09-25',
    fxRates: [{ date: '2013-12-31', usdPerGbp: USD_PER_GBP }],
    spreads: new Map(spreadTidms.map((tidm) => [tidm, spreadRow(tidm)])),
    spreadsPath: 'spreads.csv',
  };
  mkdirSync(ctx.rawDir, { recursive: true });
  return ctx;
}

function momentumLine(tidm: string) {
  const found = LSE_MOMENTUM_LINES.find((candidate) => candidate.tidm === tidm);
  if (found === undefined) throw new Error(`fixture: ${tidm}`);
  return found;
}

async function storedSymbols(): Promise<string[]> {
  return [...(await store.readVenue('saxo')).keys()];
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'saxo-pull-'));
  store = await ParquetBarStore.open(join(root, 'parquet'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('pullMomentumLine', () => {
  it('includes a plain GBX line in GBP with its measured spread and writes its bars and raw series', async () => {
    const ctx = context(fakeApi());
    const outcome = await pullMomentumLine(ctx, momentumLine('ISF'));
    expect(outcome.kind).toBe('included');
    expect(outcome.entry).toMatchObject({
      uic: 4361,
      unit: 'GBX',
      price_to_contract_factor: 0.01,
      first: calendar[0],
      last: calendar[calendar.length - 1],
      bars: calendar.length,
      half_spread_bps: 4,
      half_spread_median_bps: 5,
    });
    expect(outcome.entry).not.toHaveProperty('spliced_from');
    expect(outcome.pulled.bars[0]?.close).toBeCloseTo(gbpClose(0), 9);
    expect(await storedSymbols()).toEqual(['ISF']);
    expect((await store.readSeries('saxo', 'ISF'))?.bars).toEqual(
      roundBarPrices(outcome.pulled.bars),
    );
    expect(readdirSync(ctx.rawDir)).toEqual(['ISF.csv']);
  });

  it('refuses a line with no measured half spread, naming the spread file, and writes no book bars', async () => {
    const ctx = context(fakeApi(), []);
    await expect(pullMomentumLine(ctx, momentumLine('ISF'))).rejects.toThrow(
      'ISF: no measured half spread in spreads.csv',
    );
    expect(await storedSymbols()).toEqual([]);
  });

  it('splices the FX-converted USD sibling ahead of a short GBX line when the overlap is within tolerance', async () => {
    const ctx = context(fakeApi());
    const outcome = await pullMomentumLine(ctx, momentumLine('IHCU'));
    if (outcome.kind !== 'included') throw new Error('expected included');
    expect(outcome.entry.first).toBe(calendar[0]);
    expect(outcome.entry.bars).toBe(calendar.length);
    expect(outcome.pulled.bars[0]?.close).toBeCloseTo(gbpClose(0), 9);
    expect(outcome.entry.spliced_from).toMatchObject({
      tidm: 'IUHC',
      splice_date: calendar[SPLICED_START],
      sibling_bars_used: SPLICED_START,
      within_tolerance: true,
    });
    expect(await storedSymbols()).toEqual(['IHCU']);
    expect(readdirSync(ctx.auxDir).sort()).toEqual(['IHCU-spliced.csv', 'IUHC.csv', 'raw']);
  });

  it('excludes a spliced line whose sibling overlap breaks the tolerance and keeps its bars out of the book', async () => {
    const ctx = context(fakeApi({ noisySibling: true }));
    const outcome = await pullMomentumLine(ctx, momentumLine('CMFP'));
    if (outcome.kind !== 'excluded') throw new Error('expected excluded');
    expect(outcome.entry.first).toBe(calendar[SPLICED_START]);
    expect(outcome.entry.bars).toBe(calendar.length - SPLICED_START);
    expect(outcome.entry.reason).toMatch(
      /under ten years.*exceeds the pre-declared tolerance.*STOP for David/,
    );
    expect(outcome.entry.spliced_from?.within_tolerance).toBe(false);
    expect(await storedSymbols()).toEqual([]);
    expect(readdirSync(ctx.auxDir)).toContain('CMFP.csv');
  });
});

describe('pullAllLines and the manifest', () => {
  it('pulls every declared line plus the aux line and records the window, checks and exclusions', async () => {
    const ctx = context(fakeApi({ noisySibling: true }));
    const pulled = await pullAllLines(ctx);
    expect(Object.keys(pulled.excluded)).toEqual(['IHCU', 'CMFP']);
    expect(Object.keys(pulled.symbols).length).toBe(LSE_MOMENTUM_LINES.length - 2);
    expect(pulled.delayed).toBe(15);
    expect(pulled.pulled.has('CUKX')).toBe(true);
    expect(pulled.pulled.has('IHCU')).toBe(false);
    expect(readdirSync(ctx.auxDir)).toContain('CUKX.csv');
    expect(await storedSymbols()).toEqual(Object.keys(pulled.symbols).sort());

    const manifest = saxoBarsManifest(ctx, pulled, '2026-09-25T12:00:00Z');
    expect(manifest.fetched_at).toBe('2026-09-25T12:00:00Z');
    expect(manifest.delayed_by_minutes).toBe(15);
    expect(manifest.window_start).toBe(calendar[0]);
    expect(manifest.window_binding_line).toBe('ISF');
    expect(manifest.spread.measured_at).toBe('2026-09-20T11:00:00Z');
    expect(manifest.spread.source).toContain('raw in spreads.csv');
    expect(Object.keys(manifest.checks.aux_hygiene as object)).toEqual(['CUKX']);
    expect(manifest.checks.distribution_adjustment).toMatchObject({
      pair: ['ISF', 'CUKX'],
      from: calendar[0],
    });

    expect(saxoPullSummary('out', manifest)).toBe(
      `wrote ${LSE_MOMENTUM_LINES.length - 2} lines to out (window from ${calendar[0]}, binding ISF); excluded IHCU, CMFP; last bar ${calendar[calendar.length - 1]}`,
    );
  });

  it('omits the distribution check when ISF or CUKX was not pulled and reports no exclusions as none', () => {
    const ctx = context(fakeApi(), []);
    const manifest = saxoBarsManifest(
      ctx,
      { symbols: {}, excluded: {}, pulled: new Map(), delayed: undefined },
      't',
    );
    expect(manifest.checks).toEqual({ aux_hygiene: {} });
    expect(manifest.spread.measured_at).toBe('');
    expect(saxoPullSummary('out', manifest)).toBe(
      'wrote 0 lines to out (window from , binding ); excluded none; last bar ',
    );
  });
});

describe('saxo spread bursts', () => {
  const quote = (uic: number): InfoPriceQuote => ({
    uic,
    bid: 100,
    ask: 100.1,
    delayedByMinutes: 15,
    marketState: 'Open',
    lastUpdated: '',
  });

  it('reads BURST_READS snapshots of the same uics, sleeping the spacing between reads only', async () => {
    const requested: (readonly number[])[] = [];
    const sleeps: number[] = [];
    const bursts = await readQuoteBursts(
      {
        infoPrices: async (uics) => {
          requested.push(uics);
          return uics.map(quote);
        },
      },
      [1, 2],
      async (ms) => {
        sleeps.push(ms);
      },
    );
    expect(bursts.length).toBe(BURST_READS);
    expect(bursts[0]?.map((q) => q.uic)).toEqual([1, 2]);
    expect(requested).toEqual(Array.from({ length: BURST_READS }, () => [1, 2]));
    expect(sleeps).toEqual(Array.from({ length: BURST_READS - 1 }, () => BURST_SPACING_MS));
  });

  it('propagates a failed read without further reads', async () => {
    let calls = 0;
    const failing = {
      infoPrices: async (): Promise<InfoPriceQuote[]> => {
        calls++;
        if (calls === 2) throw new Error('Saxo 500');
        return [];
      },
    };
    await expect(readQuoteBursts(failing, [1], async () => {})).rejects.toThrow('Saxo 500');
    expect(calls).toBe(2);
  });

  it('summarises the p25 median and names the lines with no quote', () => {
    const [isf, vmid] = LSE_MOMENTUM_LINES;
    if (isf === undefined || vmid === undefined) throw new Error('fixture');
    const rows = [
      { ...spreadRow('ISF'), uic: isf.uic, p25HalfSpreadBps: 2 },
      { ...spreadRow('VMID'), uic: vmid.uic, p25HalfSpreadBps: 6 },
    ];
    const summary = spreadSummary(rows, 'spreads.csv');
    expect(summary).toMatch(
      /^wrote 2 rows to spreads.csv; p25 across lines median 4.00 bps; no quote for CUKS, /,
    );
    expect(summary).not.toMatch(/no quote for.*\b(ISF|VMID)\b/);
    const all = LSE_MOMENTUM_LINES.map((line) => ({ ...spreadRow(line.tidm), uic: line.uic }));
    expect(spreadSummary(all, 'p')).toBe(
      `wrote ${all.length} rows to p; p25 across lines median 4.00 bps`,
    );
  });
});
