import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { batchTimeFromUrl, GdeltGkgClient } from './gdelt-gkg-client.js';

/**
 * GKG 2.1 rows, built to the real shape: 27 tab-separated columns, with
 * columns 0/1/3/4/7/15 carrying values copied verbatim from a live batch
 * (`20260815153000.gkg.csv.zip`). The bulky V2ENHANCED* columns are stubbed —
 * this module never reads them, and a 67KB fixture of them would obscure the
 * six fields that matter.
 */
function gkgRow(fields: {
  id: string;
  themes: string;
  tone: string;
  source?: string;
  url?: string;
}): string {
  const columns = new Array<string>(27).fill('');
  columns[0] = fields.id;
  columns[1] = '20260815153000';
  columns[3] = fields.source ?? 'patersontimes.com';
  columns[4] = fields.url ?? 'https://example.test/a';
  columns[7] = fields.themes;
  columns[15] = fields.tone;
  return columns.join('\t');
}

/** A real macro row: matched on ECON_STOCKMARKET, tone +1.20 */
const STOCK_ROW = gkgRow({
  id: '20260815153000-23',
  themes: 'TAX_ETHNICITY;WB_698_TRADE;ECON_STOCKMARKET;EPU_ECONOMY',
  tone: '1.20481927710843,2.4,1.2,3.6,20,0.17,483',
});
/** A real crypto row */
const CRYPTO_ROW = gkgRow({
  id: '20260815153000-91',
  themes: 'ECON_BITCOIN;WB_328_FINANCIAL_INTEGRITY',
  tone: '-5.42635658914729,1.1,6.5,7.6,18,0.2,301',
});
/** A real off-topic row — a local crime report, no econ theme at all */
const NOISE_ROW = gkgRow({
  id: '20260815153000-8',
  themes: 'MANMADE_DISASTER_IMPLIED;TAX_FNCACT;SOC_GENERALCRIME',
  tone: '2.1978021978022,3.2,1.0,4.2,22,0.1,455',
});

/** What the client returns: HTTPS, whatever scheme the manifest advertised */
const BATCH_URL = 'https://data.gdeltproject.org/gdeltv2/20260815153000.gkg.csv.zip';
const BATCH_TIME = new Date('2026-08-15T15:30:00Z');

/**
 * A one-entry deflate zip with non-zero name and extra lengths, as GDELT
 * ships — including a real CRC-32 of the UNCOMPRESSED content at offset 14,
 * matching the live batch sampled 2026-08-17 (general purpose flag `0x0000`,
 * i.e. no trailing data descriptor). `unzipFirstEntry` verifies this field
 * against what it inflates (#713 item 3), so a fixture with a stub/zero CRC
 * would fail every test that reaches decoding.
 */
function zipOf(content: string): Buffer {
  const name = Buffer.from('20260815153000.gkg.csv');
  const extra = Buffer.alloc(28, 7);
  const uncompressed = Buffer.from(content);
  const body = deflateRawSync(uncompressed);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(crc32(uncompressed), 14);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, name, extra, body]);
}

function stubFetch(handlers: {
  lastupdate?: string;
  archive?: Buffer;
  status?: number;
}): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (handlers.status !== undefined && handlers.status !== 200) {
      return new Response('nope', { status: handlers.status, statusText: 'Teapot' });
    }
    if (url.endsWith('lastupdate.txt')) {
      return new Response(handlers.lastupdate ?? '');
    }
    return new Response(handlers.archive ?? Buffer.alloc(0));
  }) as unknown as typeof fetch;
}

/** GDELT's real three-line format: `size md5 url`, export/mentions/gkg */
const LASTUPDATE = [
  '44212 c2b1cae80b87a07106acb37a837c014d http://data.gdeltproject.org/gdeltv2/20260815153000.export.CSV.zip',
  '61450 e86d6493d86819b56d5cc413828825df http://data.gdeltproject.org/gdeltv2/20260815153000.mentions.CSV.zip',
  // GDELT's own manifest names http:// URLs — the client upgrades them
  '3370784 f7c5359b15d09d7e931f8338cd6a7e60 http://data.gdeltproject.org/gdeltv2/20260815153000.gkg.csv.zip',
].join('\n');

describe('GdeltGkgClient — lastupdate.txt', () => {
  it('selects the gkg file by suffix, not by line position', async () => {
    // Reordered on purpose. GDELT's line order is conventional, not
    // contractual, and picking by index would hand the parser a `mentions`
    // file, whose columns mean something entirely different at index 7 and 15
    const shuffled = LASTUPDATE.split('\n').reverse().join('\n');
    const client = new GdeltGkgClient({ fetchImpl: stubFetch({ lastupdate: shuffled }) });

    await expect(client.latestBatchUrl()).resolves.toBe(BATCH_URL);
  });

  it('throws when no gkg entry is present rather than defaulting to another file', async () => {
    const client = new GdeltGkgClient({
      fetchImpl: stubFetch({ lastupdate: LASTUPDATE.split('\n').slice(0, 2).join('\n') }),
    });

    await expect(client.latestBatchUrl()).rejects.toThrow(/no \.gkg\.csv\.zip entry/);
  });

  it('surfaces an HTTP failure instead of returning an empty batch', async () => {
    const client = new GdeltGkgClient({ fetchImpl: stubFetch({ status: 503 }) });

    await expect(client.latestBatchUrl()).rejects.toThrow(/HTTP 503/);
  });

  it('refuses an oversized manifest on content-length, before reading the body (#713 item 1)', async () => {
    const response = new Response(LASTUPDATE, {
      headers: { 'content-length': String(65 * 1024) },
    });
    const readBody = vi.spyOn(response, 'text');
    const fetchImpl = (async () => response) as unknown as typeof fetch;
    const client = new GdeltGkgClient({ fetchImpl });

    await expect(client.latestBatchUrl()).rejects.toThrow(/declares 66560 bytes/);
    // The point of checking the header at all: the post-read ceiling already
    // existed below, and by the time it fires the body is materialised
    expect(readBody).not.toHaveBeenCalled();
  });

  it('refuses an oversized manifest with no declared length, after reading the body (#713 item 1)', async () => {
    const oversized = 'x'.repeat(65 * 1024);
    const client = new GdeltGkgClient({ fetchImpl: stubFetch({ lastupdate: oversized }) });

    await expect(client.latestBatchUrl()).rejects.toThrow(/is 66560 bytes/);
  });

  it('upgrades the manifest URL to the configured scheme rather than following http', async () => {
    const client = new GdeltGkgClient({ fetchImpl: stubFetch({ lastupdate: LASTUPDATE }) });

    // The manifest line says http://. This feed reaches an analyst and so an
    // order, and over plain HTTP an on-path attacker picks the bytes we score
    await expect(client.latestBatchUrl()).resolves.toBe(BATCH_URL);
    expect(BATCH_URL.startsWith('https://')).toBe(true);
  });

  it('refuses a manifest that points the download at another host', async () => {
    const hijacked = [
      '44212 c2b1cae80b87a07106acb37a837c014d http://data.gdeltproject.org/gdeltv2/x.export.CSV.zip',
      '3370784 f7c5359 https://evil.test/gdeltv2/20260815153000.gkg.csv.zip',
    ].join('\n');
    const client = new GdeltGkgClient({ fetchImpl: stubFetch({ lastupdate: hijacked }) });

    // The manifest names an ABSOLUTE URL, so whoever serves it chooses the
    // download host. Matching the suffix is not enough — the host is pinned.
    await expect(client.latestBatchUrl()).rejects.toThrow(/named host evil\.test/);
  });

  it('refuses to follow redirects, without which the host pin is decorative', async () => {
    // The pin checks the host of a URL the server is then free to rewrite: with
    // fetch's default `redirect: 'follow'`, one 3xx from data.gdeltproject.org
    // re-targets the download anywhere and `pinToBaseUrl` never sees it. Asserted
    // on the init rather than by serving a redirect, because following one is the
    // platform's behaviour to suppress, not this module's to reimplement
    const inits: (RequestInit | undefined)[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      inits.push(init);
      return String(input).endsWith('lastupdate.txt')
        ? new Response(LASTUPDATE)
        : new Response(zipOf(STOCK_ROW));
    }) as unknown as typeof fetch;
    const client = new GdeltGkgClient({ fetchImpl });

    await client.fetchBatch(await client.latestBatchUrl());

    expect(inits).toHaveLength(2);
    for (const init of inits) expect(init?.redirect).toBe('error');
  });

  it('drops a query string, so the pin and the stamp parser agree on a batch URL', async () => {
    // Only reachable through `fetchBatch` directly — `latestBatchUrl` selects on
    // a `.gkg.csv.zip` suffix, so a query URL never survives that path. But the
    // method is public and documents that it re-pins for exactly this reason,
    // and `batchTimeFromUrl` anchors its stamp on `.gkg.csv.zip$`: carrying the
    // query through would give a URL the pin accepts and the stamp parser then
    // rejects, which the ingest agent reads as vendor URL drift and abandons
    const client = new GdeltGkgClient({
      fetchImpl: stubFetch({ lastupdate: LASTUPDATE, archive: zipOf(STOCK_ROW) }),
    });

    const result = await client.fetchBatch(`${BATCH_URL}?utm=1`);

    expect(result.file_url).toBe(BATCH_URL);
    expect(result.batch_time.toISOString()).toBe('2026-08-15T15:30:00.000Z');
  });

  it('cites the pinned URL actually fetched in an HTTP-failure diagnostic, not the pre-pin one (#713 item 2)', async () => {
    const client = new GdeltGkgClient({
      fetchImpl: stubFetch({ lastupdate: LASTUPDATE, status: 503 }),
    });

    // Handed a query-carrying, http:// URL — the pre-pin shape. The request
    // that actually goes out is the pinned rewrite (https, no query), so the
    // diagnostic must name that, not the argument
    const preRewrite = `http://data.gdeltproject.org/gdeltv2/20260815153000.gkg.csv.zip?utm=1`;
    let caught: unknown;
    try {
      await client.fetchBatch(preRewrite);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(`${BATCH_URL} returned HTTP 503`);
    expect(message).not.toContain('utm=1');
    expect(message).not.toContain('http://data.gdeltproject.org');
  });

  it('refuses a batch URL on a foreign host even when handed one directly', async () => {
    const client = new GdeltGkgClient({ fetchImpl: stubFetch({ lastupdate: LASTUPDATE }) });

    await expect(
      client.fetchBatch('https://evil.test/gdeltv2/20260815153000.gkg.csv.zip'),
    ).rejects.toThrow(/named host evil\.test/);
  });
});

describe('GdeltGkgClient — batch decoding', () => {
  it('inflates a one-entry deflate zip, reading the variable header lengths', async () => {
    // The name and extra fields are 22 and 28 bytes in the live batch and both
    // are variable. A parser that assumed zero would start inflating 50 bytes
    // into the stream and fail — or worse, succeed on some other batch
    const client = new GdeltGkgClient({
      fetchImpl: stubFetch({
        lastupdate: LASTUPDATE,
        archive: zipOf([STOCK_ROW, NOISE_ROW, CRYPTO_ROW].join('\n')),
      }),
    });

    const batch = await client.fetchLatestBatch();

    expect(batch.scanned).toBe(3);
    expect(batch.records.map((record) => record.native_id)).toEqual([
      '20260815153000-23',
      '20260815153000-91',
    ]);
  });

  it('reads tone from the first field of V1.5TONE, not the whole column', async () => {
    const client = new GdeltGkgClient({
      fetchImpl: stubFetch({ lastupdate: LASTUPDATE, archive: zipOf(STOCK_ROW) }),
    });

    const [record] = (await client.fetchLatestBatch()).records;

    // 1.2048… is average tone; 2.4 that follows it is positive score. Scoring
    // the wrong field would make every row look bullish, since positive score
    // is non-negative by construction
    expect(record?.tone).toBeCloseTo(1.20481927710843, 10);
  });

  it('stamps batch_time from the file URL in UTC', async () => {
    const client = new GdeltGkgClient({
      fetchImpl: stubFetch({ lastupdate: LASTUPDATE, archive: zipOf(STOCK_ROW) }),
    });

    const batch = await client.fetchLatestBatch();

    // Parsed as UTC, not host-local. On a UK host in summer, local parsing
    // would stamp this an hour early — a silent lookahead in every replay
    // window for half the year
    expect(batch.batch_time.toISOString()).toBe('2026-08-15T15:30:00.000Z');
    expect(batch.records[0]?.batch_time.getTime()).toBe(BATCH_TIME.getTime());
  });

  it('carries the six read columns as the payload, not the whole 27-column line', async () => {
    // Measured on a live batch: 200 of 797 rows match the watchlist and a full
    // line averages 14.9KB, almost all of it V2ENHANCED* columns nothing reads
    // — ~4.0GB across a 14-day soak. The projection is ~1.1KB a row.
    const wide = STOCK_ROW.split('\t');
    wide[20] = 'x'.repeat(4096);
    const client = new GdeltGkgClient({
      fetchImpl: stubFetch({ lastupdate: LASTUPDATE, archive: zipOf(wide.join('\t')) }),
    });

    const [record] = (await client.fetchLatestBatch()).records;

    expect(record?.payload).toBe(
      [
        '20260815153000-23',
        '20260815153000',
        'patersontimes.com',
        'https://example.test/a',
        'TAX_ETHNICITY;WB_698_TRADE;ECON_STOCKMARKET;EPU_ECONOMY',
        '1.20481927710843,2.4,1.2,3.6,20,0.17,483',
      ].join('\t'),
    );
    expect(record?.payload).not.toContain('x'.repeat(4096));
  });

  it('keeps the payload re-derivable by pinning the source batch in native_id', async () => {
    const client = new GdeltGkgClient({
      fetchImpl: stubFetch({ lastupdate: LASTUPDATE, archive: zipOf(STOCK_ROW) }),
    });

    const [record] = (await client.fetchLatestBatch()).records;

    // This is what makes dropping columns acceptable against #554: the stamp
    // prefix reconstructs the exact file URL, and GDELT keeps every batch
    // permanently retrievable there, so the dropped columns are re-fetchable
    const stamp = record?.native_id.split('-')[0] ?? '';
    expect(`https://data.gdeltproject.org/gdeltv2/${stamp}.gkg.csv.zip`).toBe(BATCH_URL);
  });

  it('refuses an unsupported compression method rather than emitting garbage', async () => {
    const zip = zipOf(STOCK_ROW);
    zip.writeUInt16LE(12, 8);
    const client = new GdeltGkgClient({
      fetchImpl: stubFetch({ lastupdate: LASTUPDATE, archive: zip }),
    });

    await expect(client.fetchLatestBatch()).rejects.toThrow(
      /unsupported zip compression method 12/,
    );
  });

  it('refuses an oversized batch on content-length, before reading the body', async () => {
    const response = new Response(zipOf(STOCK_ROW), {
      headers: { 'content-length': String(65 * 1024 * 1024) },
    });
    const readBody = vi.spyOn(response, 'arrayBuffer');
    const fetchImpl = (async (input: string | URL) =>
      String(input).endsWith('lastupdate.txt')
        ? new Response(LASTUPDATE)
        : response) as unknown as typeof fetch;
    const client = new GdeltGkgClient({ fetchImpl });

    await expect(client.fetchBatch(BATCH_URL)).rejects.toThrow(/declares 68157440 bytes/);
    // The point of checking the header at all: the post-allocation ceiling
    // already existed, and by the time it fires the body is in memory
    expect(readBody).not.toHaveBeenCalled();
  });

  it('refuses a truncated stored entry rather than clamping it to a short batch', async () => {
    // `subarray` clamps silently, so a truncated download would parse as a
    // complete batch with rows missing — and a small batch is legal, so nothing
    // downstream could tell the difference
    const body = deflateRawSync(Buffer.from(STOCK_ROW));
    const name = Buffer.from('20260815153000.gkg.csv');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(body.length + 5_000, 18);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    const client = new GdeltGkgClient({
      fetchImpl: stubFetch({
        lastupdate: LASTUPDATE,
        archive: Buffer.concat([header, name, body]),
      }),
    });

    await expect(client.fetchBatch(BATCH_URL)).rejects.toThrow(/truncated/);
  });

  it('refuses a batch whose inflated bytes do not match the header CRC-32 (#713 item 3)', async () => {
    const zip = zipOf(STOCK_ROW);
    // Corrupt one byte of the declared CRC-32 at offset 14, leaving the
    // compressed body (and therefore the actual inflated content) untouched —
    // the mutation this check exists to catch
    zip[14] = (zip[14] ?? 0) ^ 0xff;
    const client = new GdeltGkgClient({
      fetchImpl: stubFetch({ lastupdate: LASTUPDATE, archive: zip }),
    });

    await expect(client.fetchLatestBatch()).rejects.toThrow(/CRC-32/);
  });

  it('refuses a zip entry declaring a streaming data descriptor (#713 item 3)', async () => {
    const zip = zipOf(STOCK_ROW);
    // Set general-purpose bit 3: sizes/CRC live in a trailing descriptor this
    // decoder does not read, so the header's CRC field cannot be trusted
    zip.writeUInt16LE(0x0008, 6);
    const client = new GdeltGkgClient({
      fetchImpl: stubFetch({ lastupdate: LASTUPDATE, archive: zip }),
    });

    await expect(client.fetchLatestBatch()).rejects.toThrow(/data descriptor/);
  });

  it('refuses a response that is not a zip at all', async () => {
    const client = new GdeltGkgClient({
      fetchImpl: stubFetch({ lastupdate: LASTUPDATE, archive: Buffer.from('<html>error</html>') }),
    });

    await expect(client.fetchLatestBatch()).rejects.toThrow(/not a zip archive/);
  });
});

describe('GdeltGkgClient — row filtering', () => {
  const client = new GdeltGkgClient({ themes: ['ECON_STOCKMARKET'] });

  it('keeps only rows carrying a watched theme', () => {
    const batch = client.parseBatch(
      [STOCK_ROW, CRYPTO_ROW, NOISE_ROW].join('\n'),
      BATCH_TIME,
      BATCH_URL,
    );

    expect(batch.records).toHaveLength(1);
    expect(batch.records[0]?.native_id).toBe('20260815153000-23');
    // Every theme on the row is retained, not just the matched one — the
    // asset-class split happens at read, and it needs the full list
    expect(batch.records[0]?.themes).toContain('WB_698_TRADE');
  });

  it('skips a malformed row without failing the batch around it', () => {
    // A batch is ~800 rows of scraped worldwide text; a stray tab or an
    // unparseable tone is routine. Throwing would discard 799 good rows over
    // one — the opposite of AlpacaNewsClient, where a bad article means a
    // broken vendor contract on a small structured page
    const truncated = 'only\tthree\tcolumns';
    const noTone = gkgRow({ id: 'x-1', themes: 'ECON_STOCKMARKET', tone: 'not-a-number' });
    const noId = gkgRow({ id: '', themes: 'ECON_STOCKMARKET', tone: '1.0,0,0,0,0,0,0' });

    const batch = client.parseBatch(
      [truncated, noTone, STOCK_ROW, noId].join('\n'),
      BATCH_TIME,
      BATCH_URL,
    );

    expect(batch.records.map((record) => record.native_id)).toEqual(['20260815153000-23']);
    // `scanned` counts what was seen, so a filter that has silently started
    // rejecting everything is distinguishable from a quiet news window
    expect(batch.scanned).toBe(4);
  });

  it('returns an empty batch, not an error, when nothing matches', () => {
    const batch = client.parseBatch(NOISE_ROW, BATCH_TIME, BATCH_URL);

    expect(batch.records).toEqual([]);
    expect(batch.scanned).toBe(1);
  });
});

describe('batchTimeFromUrl', () => {
  it('reads the 14-digit stamp as UTC', () => {
    expect(batchTimeFromUrl(BATCH_URL)?.toISOString()).toBe('2026-08-15T15:30:00.000Z');
  });

  it('returns undefined for a URL carrying no stamp', () => {
    expect(batchTimeFromUrl('http://data.gdeltproject.org/gdeltv2/lastupdate.txt')).toBeUndefined();
  });

  it('rejects an out-of-range stamp instead of rolling it into a valid date', () => {
    const base = 'https://data.gdeltproject.org/gdeltv2/';
    // `Date.UTC` NORMALISES: month 99 rolls forward into a later year and
    // returns a real number, so a NaN check alone never fires and a corrupt
    // stamp becomes a plausible batch_time — a cursor that skips live batches
    expect(batchTimeFromUrl(`${base}20269915153000.gkg.csv.zip`)).toBeUndefined();
    expect(batchTimeFromUrl(`${base}20260899153000.gkg.csv.zip`)).toBeUndefined();
    expect(batchTimeFromUrl(`${base}20260815993000.gkg.csv.zip`)).toBeUndefined();
    // Day 31 of a 30-day month passes a coarse 1-31 check and rolls to Oct 1st
    expect(batchTimeFromUrl(`${base}20260931153000.gkg.csv.zip`)).toBeUndefined();
    // Still accepts a real leap day, so the check is not merely rejecting
    expect(batchTimeFromUrl(`${base}20240229153000.gkg.csv.zip`)?.toISOString()).toBe(
      '2024-02-29T15:30:00.000Z',
    );
  });
});
