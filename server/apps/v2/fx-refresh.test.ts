import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JournalledFill } from '../../../contracts/index.js';
import type { Logger } from '../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../shared/store/index.js';
import { reloadingFx } from './api/main.js';
import { TaxReader } from './api/tax.js';
import {
  appendBoeRows,
  boeXudlussUrl,
  type FxFetch,
  fxRefreshFor,
  overlapStart,
  refreshBoeFx,
} from './fx-refresh.js';
import { Journal } from './journal/index.js';

const FILE = [
  'DATE,XUDLUSS',
  '10 Sep 2026,1.33',
  '22 Sep 2026,1.3348',
  '23 Sep 2026,1.3265',
  '24 Sep 2026,1.322',
  '',
].join('\n');
const FROM = '2026-09-10';
const BOE_REFRESH = [
  'DATE,XUDLUSS',
  '10 Sep 2026,1.33',
  '22 Sep 2026,1.3348',
  '23 Sep 2026,1.3265',
  '24 Sep 2026,1.322',
  '25 Sep 2026,1.3301',
  '29 Sep 2026,1.34',
  '',
].join('\r\n');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fxFile(text: string = FILE): string {
  const dir = mkdtempSync(join(tmpdir(), 'fx-refresh-'));
  dirs.push(dir);
  const path = join(dir, 'gbpusd-boe-xudluss.csv');
  writeFileSync(path, text);
  return path;
}

function recorder() {
  const entries: Parameters<Logger['log']>[0][] = [];
  const logger: Logger = { log: (entry) => void entries.push(entry) };
  return { entries, logger };
}

function answering(body: string, status = 200): { fetch: FxFetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: (url) => {
      urls.push(url);
      return Promise.resolve({ ok: status === 200, status, text: () => Promise.resolve(body) });
    },
  };
}

describe('boeXudlussUrl', () => {
  it('asks the IADB for XUDLUSS from the given day to now, in the committed file format', () => {
    expect(boeXudlussUrl('2026-09-03')).toBe(
      'https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp?csv.x=yes' +
        '&Datefrom=03/Sep/2026&Dateto=now&SeriesCodes=XUDLUSS&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N',
    );
  });
});

describe('overlapStart', () => {
  it('re-reads the two weeks before the last fix and refuses an empty file', () => {
    expect(overlapStart([{ date: '2026-09-24', gbpUsd: 1.322 }])).toBe(FROM);
    expect(() => overlapStart([])).toThrow(/no rows/);
  });
});

describe('appendBoeRows', () => {
  const overlap = BOE_REFRESH.replaceAll('\r\n', '\n');

  it('appends only the fixes after the last row, as BoE wrote them', () => {
    const result = appendBoeRows(FILE, overlap, FROM);
    expect(result.added).toEqual([
      { date: '2026-09-25', gbpUsd: 1.3301 },
      { date: '2026-09-29', gbpUsd: 1.34 },
    ]);
    expect(result.text).toBe(`${FILE}25 Sep 2026,1.3301\n29 Sep 2026,1.34\n`);
  });

  it('leaves the file text alone when BoE has nothing newer', () => {
    expect(appendBoeRows(FILE, FILE, FROM)).toEqual({ text: FILE, added: [] });
  });

  it('refuses a revised fix inside the overlap rather than splice two series', () => {
    expect(() => appendBoeRows(FILE, overlap.replace('1.3265', '1.3266'), FROM)).toThrow(
      'fx refresh: BoE 2026-09-23 is 1.3266, the file holds 1.3265',
    );
  });

  it('refuses an overlap missing a row the file holds', () => {
    expect(() => appendBoeRows(FILE, overlap.replace('23 Sep 2026,1.3265\n', ''), FROM)).toThrow(
      'fx refresh: BoE returned 3 rows from 2026-09-10 to 2026-09-24, the file holds 4',
    );
  });

  it('refuses a response that is not a BoE series in ascending date order', () => {
    expect(() => appendBoeRows(FILE, '<html>error</html>', FROM)).toThrow(/unexpected header/);
    expect(() => appendBoeRows(FILE, `${overlap}28 Sep 2026,1.35\n`, FROM)).toThrow(
      /not strictly ascending/,
    );
  });
});

describe('refreshBoeFx', () => {
  it('fetches from the overlap start and writes the extended file', async () => {
    const path = fxFile();
    const boe = answering(`${FILE}25 Sep 2026,1.3301\n`);
    const result = await refreshBoeFx({ path, fetch: boe.fetch, logger: recorder().logger });
    expect(boe.urls).toEqual([boeXudlussUrl(FROM)]);
    expect(result.added).toEqual([{ date: '2026-09-25', gbpUsd: 1.3301 }]);
    expect(readFileSync(path, 'utf8')).toBe(`${FILE}25 Sep 2026,1.3301\n`);
  });

  it('keeps the file on an HTTP error', async () => {
    const path = fxFile();
    const boe = answering('', 503);
    await expect(
      refreshBoeFx({ path, fetch: boe.fetch, logger: recorder().logger }),
    ).rejects.toThrow('fx refresh: BoE IADB answered HTTP 503');
    expect(readFileSync(path, 'utf8')).toBe(FILE);
  });
});

describe('fxRefreshFor', () => {
  it('logs what it appended and reports no bar work', async () => {
    const path = fxFile();
    const { entries, logger } = recorder();
    const boe = answering(`${FILE}25 Sep 2026,1.3301\n`);
    expect(await fxRefreshFor({ path, fetch: boe.fetch, logger }).run()).toEqual({
      attempted: 0,
      updated: [],
      noNewBars: [],
      failed: [],
    });
    expect(entries.map(({ level, event, message }) => [level, event, message])).toEqual([
      ['info', 'v2_fx_refresh_summary', 'BoE XUDLUSS appended 1 fixes to 2026-09-25'],
    ]);
  });

  it('says so when BoE has no newer fix', async () => {
    const { entries, logger } = recorder();
    await fxRefreshFor({ path: fxFile(), fetch: answering(FILE).fetch, logger }).run();
    expect(entries.map((entry) => entry.message)).toEqual([
      'BoE XUDLUSS has no fix after the file',
    ]);
  });

  it('warns and keeps the file on any failure, so later USD fills stay held out', async () => {
    const path = fxFile();
    const { entries, logger } = recorder();
    const failing: FxFetch = () => Promise.reject(new Error('connect refused'));
    await fxRefreshFor({ path, fetch: failing, logger }).run();
    expect(entries.map(({ level, event, message }) => [level, event, message])).toEqual([
      [
        'warn',
        'v2_fx_refresh_failed',
        "connect refused; the tax log holds out every USD fill after the file's last fix",
      ],
    ]);
    expect(readFileSync(path, 'utf8')).toBe(FILE);
  });
});

describe('a USD fill after the file ends', () => {
  const clock = { now: () => new Date('2026-09-30T21:40:00.000Z') };

  function sellAfterTheFile(): StoreHandle {
    const db = openSharedStore(':memory:');
    const journal = new Journal(db, clock);
    const fill = (id: string, side: 'buy' | 'sell', fillDate: string, price: number) => {
      journal.recordOrder({
        client_order_id: id,
        decision_id: null,
        book_id: 'debate/primary',
        trading_date: fillDate,
        instrument: 'AAPL',
        venue: 'alpaca',
        leg: side === 'buy' ? 'entry' : 'exit',
        side,
        dry_run: false,
        outcome: 'submitted',
        payload: {},
      });
      const row: JournalledFill = {
        fill_id: `f-${id}`,
        client_order_id: id,
        book_id: 'debate/primary',
        trading_date: fillDate,
        instrument: 'AAPL',
        venue: 'alpaca',
        leg: side === 'buy' ? 'entry' : 'exit',
        side,
        qty: 10,
        price_gbp: price,
        fee_gbp: 0,
        currency: 'USD',
        price_native: price,
        fee_native: 0,
        fx_quote_per_gbp: 1.3,
        fx_source: 'boe-xudluss:year-start:2026@2025-12-31',
        fill_date: fillDate,
      };
      journal.recordFill(row);
    };
    fill('buy', 'buy', '2026-09-22', 133.48);
    fill('sell', 'sell', '2026-09-29', 147.4);
    return db;
  }

  it('is held out before the refresh and priced at the day fix after it', async () => {
    const path = fxFile();
    const tax = new TaxReader(sellAfterTheFile(), clock, reloadingFx(path));

    expect(tax.read({ year: 2026, format: 'json' }).disposals).toMatchObject({
      status: 'fed',
      rows: [],
      held_out: [
        {
          instrument: 'AAPL',
          reason: 'fill f-sell: BoE XUDLUSS series ends 2026-09-24, before 2026-09-29',
        },
      ],
    });

    await refreshBoeFx({ path, fetch: answering(BOE_REFRESH).fetch, logger: recorder().logger });

    expect(tax.read({ year: 2026, format: 'json' }).disposals).toMatchObject({
      status: 'fed',
      held_out: [],
      rows: [
        {
          disposal_date: '2026-09-29',
          proceeds_gbp: expect.closeTo(1_474 / 1.34, 9),
          cost_gbp: expect.closeTo(1_334.8 / 1.3348, 9),
          fx_source: 'boe-xudluss:2026-09-29',
        },
      ],
    });
  });
});
