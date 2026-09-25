import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogEntry, Logger } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { composeV2Root, llmKeysPresent, parseCliArgs } from './index.js';

const HEADER = 'date,open,high,low,close,volume,raw_close';

function writeFixtures(): {
  directory: string;
  barsDirectory: string;
  constituentsPath: string;
  fxPath: string;
  spreadsPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'v2-root-'));
  const barsDirectory = join(directory, 'bars');
  rmSync(barsDirectory, { recursive: true, force: true });
  const rows: string[] = [HEADER];
  const origin = Date.UTC(2025, 0, 1);
  for (let i = 0; i < 260; i += 1) {
    const close = 20 * (1 + 0.001 * i);
    const date = new Date(origin + i * 86_400_000).toISOString().slice(0, 10);
    rows.push(`${date},${close},${close * 1.01},${close * 0.99},${close},1000000,${close}`);
  }
  writeFileSync(join(directory, 'UP.csv'), `${rows.join('\n')}\n`);
  const constituentsPath = join(directory, 'constituents.csv');
  writeFileSync(constituentsPath, 'date,tickers\n2016-01-04,"UP,MISSING"\n');
  const fxPath = join(directory, 'fx.csv');
  writeFileSync(fxPath, 'DATE,XUDLUSS\n31 Dec 2024,1.25\n02 Jan 2025,1.26\n');
  const spreadsPath = join(directory, 'spreads.csv');
  writeFileSync(spreadsPath, 'symbol,sessions,median_half_spread_bps\nUP,10,1.0\n');
  return { directory, barsDirectory: directory, constituentsPath, fxPath, spreadsPath };
}

const ENTRY_DATE = new Date(Date.UTC(2025, 0, 1) + 260 * 86_400_000).toISOString().slice(0, 10);

describe('composeV2Root', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });

  it('registers only the debate sleeve and a dry run submits nothing while journalling every LLM call', async () => {
    const fixtures = writeFixtures();
    directory = fixtures.directory;
    const logs: LogEntry[] = [];
    const logger: Logger = { log: (entry) => logs.push(entry) };
    const root = composeV2Root({
      ...fixtures,
      tradingDate: ENTRY_DATE,
      dryRun: true,
      storePath: ':memory:',
      anthropicApiKey: 'present',
      openrouterApiKey: 'present',
      clock: new SimulatedClock(new Date(`${ENTRY_DATE}T07:00:00.000Z`)),
      logger,
    });
    try {
      expect(root.registry.ids()).toEqual(['debate']);
      const report = await root.run();
      expect(report.submitted_orders).toBe(0);
      expect(report.entries).toBe(0);
      expect(report.dry_run_refusals).toBe(0);
      expect(root.journal.countOrders('refused_dry_run')).toBe(0);
      expect(report.decisions).toBe(1);
      expect(root.journal.sizeShares('debate/primary', ENTRY_DATE, 'UP')).toBe(0);
      expect(root.journal.decisionsFor('debate/primary', ENTRY_DATE)[0]).toMatchObject({
        instrument: 'UP',
        action: 'enter_long',
      });
      expect(report.refusals.filter((refusal) => refusal.includes('needs David'))).toHaveLength(8);
      expect(report.sleeves).toEqual(['debate']);
      expect(root.books.ids()).toEqual([
        'debate/primary',
        'debate/no-macro-gate',
        'debate/no-sentiment',
        'debate/no-social',
        'debate/large-cap-only',
      ]);
      const llmCalls = root.scriptedTransports.reduce(
        (n, transport) => n + transport.calls.length,
        0,
      );
      expect(llmCalls).toBe(3);
      const spendRows = root.db.prepare('SELECT COUNT(*) AS n FROM llm_spend').get() as {
        n: number;
      };
      expect(spendRows.n).toBe(llmCalls);
      expect(logs.some((entry) => entry.event === 'v2_llm_transport_scripted')).toBe(true);
      expect(root.journal.countOrders('submitted')).toBe(0);
    } finally {
      root.close();
    }
  });

  it('refuses a paper run without LLM keys', () => {
    expect(() =>
      composeV2Root({ tradingDate: '2026-09-25', dryRun: false, storePath: ':memory:' }),
    ).toThrow(/without ANTHROPIC_API_KEY/);
    expect(() =>
      composeV2Root({
        tradingDate: '2026-09-25',
        dryRun: false,
        storePath: ':memory:',
        anthropicApiKey: '',
        openrouterApiKey: 'x',
      }),
    ).toThrow(/without ANTHROPIC_API_KEY/);
  });

  it('refuses live mode', () => {
    expect(() =>
      composeV2Root({
        tradingDate: '2026-09-25',
        dryRun: true,
        samuraiMode: 'live',
        storePath: ':memory:',
      }),
    ).toThrow(/refuses SAMURAI_MODE=live/);
  });

  it('parses the CLI and detects LLM keys', () => {
    expect(parseCliArgs(['--dry-run', '--date', '2026-09-23'], '2026-09-25')).toEqual({
      dryRun: true,
      tradingDate: '2026-09-23',
    });
    expect(parseCliArgs([], '2026-09-25')).toEqual({ dryRun: false, tradingDate: '2026-09-25' });
    expect(() => parseCliArgs(['--date'], '2026-09-25')).toThrow(/--date needs/);
    expect(() => parseCliArgs(['--bogus'], '2026-09-25')).toThrow(/unknown argument/);
    expect(llmKeysPresent({ tradingDate: 'd', dryRun: true })).toBe(false);
    expect(
      llmKeysPresent({
        tradingDate: 'd',
        dryRun: true,
        anthropicApiKey: 'a',
        openrouterApiKey: 'b',
      }),
    ).toBe(true);
  });
});
