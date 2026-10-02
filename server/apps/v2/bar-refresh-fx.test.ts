import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../shared/index.js';
import { barRefreshFor } from './bar-refresh.js';
import { inSequence } from './bar-refresh-core.js';
import { boeXudlussUrl, type FxFetch } from './fx-refresh.js';

vi.mock('./bar-refresh-core.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bar-refresh-core.js')>();
  return { ...actual, inSequence: vi.fn(actual.inSequence) };
});
vi.mock('../../providers/bar-store/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../providers/bar-store/index.js')>();
  return {
    ...actual,
    ParquetBarStore: { open: () => Promise.reject(new Error('no bar store in this test')) },
  };
});
vi.mock('./saxo-bar-refresh.js', () => ({
  saxoBarRefreshFor: () => ({ run: () => Promise.reject(new Error('no Saxo in this test')) }),
}));
vi.mock('./cfd-catalogue-refresh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cfd-catalogue-refresh.js')>();
  return {
    ...actual,
    cfdCatalogueRefreshFor: () => ({
      run: () => Promise.reject(new Error('no CFDs in this test')),
    }),
  };
});

const SILENT: Logger = { log: () => undefined };
const ENV = { ALPACA_API_KEY: 'k', ALPACA_API_SECRET: 's' };

function fixture(): { constituents: string; fx: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bar-refresh-fx-'));
  const constituents = join(dir, 'constituents.csv');
  writeFileSync(constituents, 'date,tickers\n2016-01-01,"AAPL,MSFT"\n');
  const fx = join(dir, 'fx.csv');
  writeFileSync(fx, 'DATE,XUDLUSS\n24 Sep 2026,1.322\n');
  return { constituents, fx };
}

function recordingFetch(): { fetch: FxFetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: (url) => {
      urls.push(url);
      return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') });
    },
  };
}

async function runEveryLeg(): Promise<void> {
  const legs = vi.mocked(inSequence).mock.lastCall?.[0] ?? [];
  for (const leg of legs) await leg.run().catch(() => undefined);
}

describe('barRefreshFor BoE FX leg', () => {
  it('requests XUDLUSS for the given file on a non-dry run', async () => {
    const { constituents, fx } = fixture();
    const boe = recordingFetch();
    barRefreshFor(false, ENV, '2026-09-25', constituents, SILENT, 'x/catalogue.json', {
      path: fx,
      fetch: boe.fetch,
    });
    await runEveryLeg();
    expect(boe.urls).toEqual([boeXudlussUrl('2026-09-10')]);
  });

  it('requests nothing on a dry run', async () => {
    const { constituents, fx } = fixture();
    const boe = recordingFetch();
    vi.mocked(inSequence).mockClear();
    const refresh = barRefreshFor(true, ENV, '2026-09-25', constituents, SILENT, 'x', {
      path: fx,
      fetch: boe.fetch,
    });
    await refresh.run();
    await runEveryLeg();
    expect(inSequence).not.toHaveBeenCalled();
    expect(boe.urls).toEqual([]);
  });
});
