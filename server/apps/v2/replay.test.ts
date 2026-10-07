import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SleeveDecision } from '../../../contracts/index.js';
import { ParquetBarStore } from '../../providers/bar-store/index.js';
import type {
  AnthropicMessageRequest,
  AnthropicMessagesClient,
} from '../../shared/debate/index.js';
import {
  LlmProviderError,
  LlmRateLimitError,
  MAX_CAPTURED_PROMPT_CHARS,
} from '../../shared/debate/index.js';
import type { DailyBar } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { guardedStore, openReadOnlyStore, openSharedStore } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import type { NewsSource, VenueSessionGate } from './data/index.js';
import { AlpacaNewsSource, MarketauxNewsSource, SqliteNewsLedger } from './data/index.js';
import { composeV2Root } from './index.js';
import type { InputDigest } from './input-digest.js';
import {
  compareDecision,
  type Divergence,
  divergencesOf,
  formatReplay,
  type JournalledDecision,
  journalledLseRefusal,
  type ReplayResult,
  redactor,
  replayExitCode,
} from './replay.js';
import { main, parseReplayArgs, type ReplayCliOptions, replayFromFiles } from './replay-cli.js';
import { CapitalConfigStore } from './risk/index.js';
import type { LoggedCall, ModelPin } from './signal/index.js';
import { ReplayLog, ScriptedTransport } from './signal/index.js';

vi.mock('../../shared/store/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/store/index.js')>();
  return { ...actual, openReadOnlyStore: vi.fn(actual.openReadOnlyStore) };
});

const ORIGIN = Date.UTC(2026, 0, 1);
const dateAt = (day: number) => new Date(ORIGIN + day * 86_400_000).toISOString().slice(0, 10);
const TRADING_DATE = dateAt(260);
const OPEN_EVERY_DAY: VenueSessionGate = {
  entrySitOut: () => undefined,
  timeStopPausedVenues: () => [],
};

function rising(): DailyBar[] {
  const bars: DailyBar[] = [];
  for (let i = 0; i <= 260; i += 1) {
    const close = 20 * (1 + 0.001 * i);
    bars.push({
      date: dateAt(i),
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
      rawClose: close,
    });
  }
  return bars;
}

function answer(request: AnthropicMessageRequest): string {
  const prompt = request.messages[0]?.content ?? '';
  if (prompt.includes('Mediator persona')) {
    return '{"stance":"bullish","rationale":"trend and headlines agree","converged":true}';
  }
  return prompt.includes('Bull persona')
    ? '{"stance":"bullish","rationale":"above the 200-day"}'
    : '{"stance":"bearish","rationale":"stretched"}';
}

let directory: string;
let options: ReplayCliOptions;
let files: Omit<ReplayCliOptions, 'storePath' | 'venueSessions'>;

const FIXTURE_NEWS: NewsSource = {
  headlines: (symbol) =>
    Promise.resolve(symbol === 'UP' ? ['UP beats estimates', 'UP raises guidance'] : []),
};

const scripted = (pin: ModelPin) => new ScriptedTransport(pin, answer);

async function seedDay(
  name: string,
  transportFor: (pin: ModelPin) => AnthropicMessagesClient,
  newsSource: NewsSource = FIXTURE_NEWS,
  prepare: (seed: StoreHandle) => void = () => {},
): Promise<ReplayCliOptions> {
  const storePath = join(directory, `${name}.sqlite`);
  const seed = openSharedStore(storePath);
  new CapitalConfigStore(seed, new SimulatedClock(new Date('2026-01-01T00:00:00.000Z'))).setYear(
    2026,
    1_000,
    1_500,
  );
  prepare(seed);
  seed.close();
  const root = composeV2Root({
    tradingDate: files.tradingDate,
    barStoreRoot: files.barStoreRoot,
    constituentsPath: files.constituentsPath,
    fxPath: files.fxPath,
    spreadsPath: files.spreadsPath,
    cfdCataloguePath: files.cfdCataloguePath,
    dryRun: true,
    storePath,
    clock: new SimulatedClock(new Date(`${TRADING_DATE}T07:30:00.000Z`)),
    logger: { log: () => {} },
    venueSessions: OPEN_EVERY_DAY,
    transportFor,
    newsSource,
  });
  try {
    await root.run();
  } finally {
    root.close();
  }
  return { ...files, storePath, venueSessions: OPEN_EVERY_DAY };
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'v2-replay-'));
  const barStoreRoot = join(directory, 'parquet');
  const store = await ParquetBarStore.open(barStoreRoot);
  await store.write('alpaca', [
    { symbol: 'UP', bars: rising() },
    { symbol: 'SPY', bars: rising() },
  ]);
  store.close();
  const constituentsPath = join(directory, 'constituents.csv');
  writeFileSync(constituentsPath, 'date,tickers\n2016-01-04,"UP,MISSING"\n');
  const fxPath = join(directory, 'fx.csv');
  writeFileSync(fxPath, 'DATE,XUDLUSS\n31 Dec 2025,1.25\n02 Jan 2026,1.26\n');
  const spreadsPath = join(directory, 'spreads.csv');
  writeFileSync(spreadsPath, 'symbol,sessions,median_half_spread_bps\nUP,10,0\n');
  files = {
    tradingDate: TRADING_DATE,
    barStoreRoot,
    constituentsPath,
    fxPath,
    spreadsPath,
    cfdCataloguePath: join(directory, 'absent-catalogue.json'),
    saxoSpreadsPath: join(directory, 'absent-saxo-spreads.csv'),
  };
  options = await seedDay('paper', scripted);
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function digestOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function tamperedCopy(name: string, sql: string): ReplayCliOptions {
  const storePath = join(directory, `${name}.sqlite`);
  copyFileSync(options.storePath, storePath);
  const db = new BetterSqlite3(storePath);
  db.exec(sql);
  db.close();
  return { ...options, storePath };
}

const NO_OUTCOME = { stopReason: null, errorClass: null, errorMessage: null } as const;

const DEBATE_CALLS = `SELECT id FROM llm_call_log WHERE trace_id LIKE 'v2-${TRADING_DATE}-UP'`;

describe('replayFromFiles', () => {
  it('replays the fixture day to identical decisions and inputs hashes without writing', async () => {
    const before = digestOf(options.storePath);
    const result = await replayFromFiles(options);
    expect(result.decisions).toBe(3);
    expect(result.calls).toBe(3);
    expect(result.orders).toBe(3);
    expect(result.divergences).toEqual([]);
    expect(digestOf(options.storePath)).toBe(before);
  });

  it('opens the store read-only by default, so any write through it throws', async () => {
    const opened = vi.mocked(openReadOnlyStore);
    opened.mockClear();
    await replayFromFiles(options);
    expect(opened).toHaveBeenCalledWith(options.storePath);
    const handle = opened.mock.results[0]?.value as StoreHandle;
    expect(handle.readonly).toBe(true);
    const writable = new BetterSqlite3(options.storePath);
    try {
      expect(writable.readonly).toBe(false);
    } finally {
      writable.close();
    }
  });

  it('detects a changed judge response as a changed decision', async () => {
    const result = await replayFromFiles(
      tamperedCopy(
        'judge',
        `UPDATE llm_call_log SET response = '{"stance":"bearish","rationale":"tampered","converged":true}'
          WHERE model = 'anthropic/claude-opus-5.5'`,
      ),
    );
    expect(result.divergences[0]).toMatchObject({
      kind: 'decision_field',
      instrument: 'UP',
      field: 'direction',
      journalled: 'bullish',
      replayed: 'bearish',
    });
  });

  it('detects a changed debater response at the judge request it changes', async () => {
    const result = await replayFromFiles(
      tamperedCopy(
        'bull',
        `UPDATE llm_call_log SET response = '{"stance":"bullish","rationale":"tampered"}'
          WHERE id = (${DEBATE_CALLS} ORDER BY id LIMIT 1)`,
      ),
    );
    const [first] = result.divergences;
    expect(first?.kind).toBe('llm_request');
    expect(first?.kind === 'llm_request' && first.miss).toMatchObject({
      kind: 'request_not_logged',
      model: 'anthropic/claude-opus-5.5',
    });
  });

  it('fails closed on a request with no logged response', async () => {
    const result = await replayFromFiles(
      tamperedCopy(
        'missing',
        `DELETE FROM llm_call_log WHERE id = (${DEBATE_CALLS} ORDER BY id DESC LIMIT 1)`,
      ),
    );
    const [first] = result.divergences;
    expect(first?.kind === 'llm_request' && first.miss.kind).toBe('request_not_logged');
    expect(result.divergences.some((entry) => entry.kind === 'decision_field')).toBe(true);
  });

  it.each([16_384, 4_096])(
    'fails closed on a logged response a %i-character capture cap truncated',
    async (cap) => {
      const long = `${'x'.repeat(cap)}… (truncated, 20000 chars total)`;
      const result = await replayFromFiles(
        tamperedCopy(
          `truncated-${cap}`,
          `UPDATE llm_call_log SET response = '${long}' WHERE model = 'anthropic/claude-opus-5.5'`,
        ),
      );
      const [first] = result.divergences;
      expect(first?.kind === 'llm_request' && first.miss.kind).toBe('response_truncated');
    },
  );

  it('journals one digest per name the cycle read and one for the catalogue', () => {
    const db = openReadOnlyStore(options.storePath);
    try {
      const rows = db
        .prepare('SELECT input, name, row_count, last_bar_date, sha256 FROM v2_input_digests')
        .all() as { input: string; name: string; row_count: number | null; sha256: string }[];
      const keys = rows.map((row) => `${row.input}:${row.name}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual(
        expect.arrayContaining([
          'bars:ISF',
          'bars:MISSING',
          'bars:SPY',
          'bars:UP',
          'cfd_catalogue:saxo-cfd-catalogue',
        ]),
      );
      expect(rows.find((row) => row.name === 'MISSING')?.row_count).toBe(0);
      expect(rows.find((row) => row.name === 'UP')).toMatchObject({
        row_count: 240,
        last_bar_date: dateAt(259),
      });
      expect(rows.find((row) => row.input === 'cfd_catalogue')?.sha256).toBeNull();
    } finally {
      db.close();
    }
  });

  it('journals no digest from a re-run the marked day skips', async () => {
    const { storePath } = tamperedCopy(
      'before-digests',
      'DROP TRIGGER v2_input_digests_no_delete; DELETE FROM v2_input_digests;',
    );
    const rerun = composeV2Root({
      tradingDate: TRADING_DATE,
      dryRun: true,
      storePath,
      barStoreRoot: options.barStoreRoot,
      fxPath: options.fxPath,
      spreadsPath: options.spreadsPath,
      cfdCataloguePath: options.cfdCataloguePath,
      clock: new SimulatedClock(new Date(`${TRADING_DATE}T09:00:00.000Z`)),
      logger: { log: () => {} },
      venueSessions: OPEN_EVERY_DAY,
      transportFor: (pin: ModelPin) => new ScriptedTransport(pin, answer),
    });
    try {
      expect(await rerun.run()).toMatchObject({ skipped: true });
      expect(rerun.db.prepare('SELECT COUNT(*) AS n FROM v2_input_digests').get()).toEqual({
        n: 0,
      });
    } finally {
      rerun.close();
    }
  });

  it('names a rewritten bar window as an input change before any decision divergence', async () => {
    const barStoreRoot = join(directory, 'revised-parquet');
    const revised = await ParquetBarStore.open(barStoreRoot);
    const bars = rising().map((bar, index) =>
      index === 250 ? { ...bar, high: bar.high * 1.05, close: bar.close * 1.05 } : bar,
    );
    await revised.write('alpaca', [
      { symbol: 'UP', bars },
      { symbol: 'SPY', bars: rising() },
    ]);
    revised.close();
    const result = await replayFromFiles({ ...options, barStoreRoot });
    const changes = result.divergences.filter((entry) => entry.kind === 'input_changed_since');
    expect(changes).toEqual([
      expect.objectContaining({
        tradingDate: TRADING_DATE,
        journalled: expect.objectContaining({
          input: 'bars',
          name: 'UP',
          row_count: 240,
          first_bar_date: dateAt(20),
        }),
        current: expect.objectContaining({ input: 'bars', name: 'UP', row_count: 240 }),
      }),
    ]);
    expect(result.divergences[0]).toBe(changes[0]);
    expect(result.divergences[1]).toMatchObject({
      kind: 'decision_field',
      instrument: 'UP',
      field: 'inputs_hash',
    });
  });

  it('replays identically over a bar rewritten before every window the cycle read (#2028)', async () => {
    const barStoreRoot = await revisedBarStore('old-bar-parquet', 19);
    expect((await replayFromFiles({ ...options, barStoreRoot })).divergences).toEqual([]);
  });

  it('names the oldest bar of the window the cycle read as an input change (#2028)', async () => {
    const barStoreRoot = await revisedBarStore('window-edge-parquet', 20);
    const [first] = (await replayFromFiles({ ...options, barStoreRoot })).divergences;
    expect(first).toMatchObject({ kind: 'input_changed_since', journalled: { name: 'UP' } });
  });

  it('names a catalogue written since the day as an input change', async () => {
    const cfdCataloguePath = join(directory, 'written-later.json');
    writeFileSync(cfdCataloguePath, JSON.stringify({ asOf: TRADING_DATE, instruments: [] }));
    const result = await replayFromFiles({ ...options, cfdCataloguePath });
    expect(result.divergences[0]).toMatchObject({
      kind: 'input_changed_since',
      journalled: { input: 'cfd_catalogue', sha256: null },
      current: { input: 'cfd_catalogue', sha256: digestOf(cfdCataloguePath), as_of: TRADING_DATE },
    });
  });

  it('reports a day with no journalled decision', async () => {
    const result = await replayFromFiles({ ...options, tradingDate: dateAt(100) });
    expect(result.divergences).toEqual([{ kind: 'nothing_to_replay', tradingDate: dateAt(100) }]);
  });
});

// CPU-heavy: each block runs a full composed day; ~1 s under 3x CPU oversubscription, CI timed out at 5 s
describe('replay from the US headline journal (#1981)', { timeout: 30_000 }, () => {
  let capped: ReplayCliOptions;

  beforeAll(async () => {
    const storePath = join(directory, 'capped.sqlite');
    const writer = openSharedStore(storePath);
    const long = (index: number) => `UP headline ${index} ${'x'.repeat(2_000)}`;
    const articles = Array.from({ length: 10 }, (_, index) => ({
      id: `bz-${index}`,
      headline: long(index),
      summary: '',
      symbols: ['UP'],
      source: 'benzinga',
      url: '',
      created_at: new Date(Date.UTC(2026, 8, 17, index)),
      updated_at: new Date(Date.UTC(2026, 8, 17, index)),
      payload: '',
    }));
    const news = new AlpacaNewsSource(
      { fetchNews: ([symbol]) => Promise.resolve(symbol === 'UP' ? articles : []) },
      new SqliteNewsLedger(guardedStore(writer, 'v2')),
    );
    try {
      capped = await seedDay('capped', scripted, news);
    } finally {
      writer.close();
    }
  }, 30_000);

  it('replays identical a name whose logged prompt hit the capture cap', async () => {
    const db = new BetterSqlite3(capped.storePath, { readonly: true });
    const prompts = db
      .prepare(`SELECT prompt FROM llm_call_log WHERE trace_id = 'v2-${TRADING_DATE}-UP'`)
      .all() as { prompt: string }[];
    db.close();
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.every((row) => row.prompt.length >= MAX_CAPTURED_PROMPT_CHARS)).toBe(true);
    const result = await replayFromFiles(capped);
    expect(result.decisions).toBe(3);
    expect(result.divergences).toEqual([]);
  });

  it('diverges as a news error without the journal, as before #1981', async () => {
    const storePath = join(directory, 'capped-unjournalled.sqlite');
    copyFileSync(capped.storePath, storePath);
    const db = new BetterSqlite3(storePath);
    db.exec("DROP TRIGGER v2_news_no_delete; DELETE FROM v2_news WHERE provider = 'alpaca'");
    db.close();
    const result = await replayFromFiles({ ...capped, storePath });
    expect(result.divergences).toContainEqual(
      expect.objectContaining({
        kind: 'decision_field',
        instrument: 'UP',
        field: 'inputs_hash',
        replayed: '',
      }),
    );
  });
});

// CPU-heavy: each block runs a full composed day; ~1 s under 3x CPU oversubscription, CI timed out at 5 s
describe('replay from the UK headline journal (#1981)', { timeout: 30_000 }, () => {
  let capped: ReplayCliOptions;

  beforeAll(async () => {
    const storePath = join(directory, 'capped-uk.sqlite');
    const writer = openSharedStore(storePath);
    const publishedAt = new Date(Date.parse(`${TRADING_DATE}T07:30:00.000Z`) - 3_600_000);
    const articles = Array.from({ length: 10 }, (_, index) => ({
      title: `UP plc headline ${index} ${'y'.repeat(2_000)}`,
      publishedAt: new Date(publishedAt.getTime() - index * 60_000).toISOString(),
      companyCount: 1,
    }));
    const news = new MarketauxNewsSource({
      client: { fetchArticles: () => Promise.resolve({ found: articles.length, articles }) },
      ledger: new SqliteNewsLedger(guardedStore(writer, 'v2')),
    });
    try {
      capped = await seedDay('capped-uk', scripted, news);
    } finally {
      writer.close();
    }
  }, 30_000);

  it('replays identical a UK name whose logged prompt hit the capture cap, from its marketaux rows', async () => {
    const db = new BetterSqlite3(capped.storePath, { readonly: true });
    const prompts = db
      .prepare(`SELECT prompt FROM llm_call_log WHERE trace_id = 'v2-${TRADING_DATE}-UP'`)
      .all() as { prompt: string }[];
    const providers = db.prepare('SELECT DISTINCT provider, status FROM v2_news').all();
    db.close();
    expect(providers).toEqual([{ provider: 'marketaux', status: 'ok' }]);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.every((row) => row.prompt.length >= MAX_CAPTURED_PROMPT_CHARS)).toBe(true);
    const result = await replayFromFiles(capped);
    expect(result.decisions).toBe(3);
    expect(result.divergences).toEqual([]);
  });

  it('diverges as a news error once the marketaux rows are gone', async () => {
    const storePath = join(directory, 'capped-uk-unjournalled.sqlite');
    copyFileSync(capped.storePath, storePath);
    const tamper = new BetterSqlite3(storePath);
    tamper.exec('DROP TRIGGER v2_news_no_delete; DELETE FROM v2_news');
    tamper.close();
    const fallback = await replayFromFiles({ ...capped, storePath });
    expect(fallback.divergences).toContainEqual(
      expect.objectContaining({ instrument: 'UP', field: 'inputs_hash', replayed: '' }),
    );
  });
});

function failingOnce(
  pin: ModelPin,
  persona: string,
  failure: () => Error,
): AnthropicMessagesClient {
  const scripted = new ScriptedTransport(pin, answer);
  let failed = false;
  return {
    createMessage: (request, callOptions) => {
      if (!failed && (request.messages[0]?.content ?? '').includes(persona)) {
        failed = true;
        return Promise.reject(failure());
      }
      return scripted.createMessage(request, callOptions);
    },
  };
}

function refusingJudge(pin: ModelPin): AnthropicMessagesClient {
  const retried = failingOnce(pin, 'Bull persona', () => new LlmRateLimitError('Nous 429: slow'));
  return {
    createMessage: (request, callOptions) =>
      (request.messages[0]?.content ?? '').includes('Mediator persona')
        ? Promise.resolve({
            content: [{ type: 'text', text: '' }],
            usage: { input_tokens: 12, output_tokens: 0 },
            stop_reason: 'refusal',
            model: pin.priced,
          })
        : retried.createMessage(request, callOptions),
  };
}

describe('replayFromFiles on failed calls (#1980)', () => {
  let refused: ReplayCliOptions;
  let failed: ReplayCliOptions;

  beforeAll(async () => {
    refused = await seedDay('refused', refusingJudge);
    failed = await seedDay('failed', (pin) =>
      failingOnce(pin, 'Bear persona', () => new LlmProviderError('Nous 503: upstream down')),
    );
  });

  function rowsOf(path: string, sql: string): unknown[] {
    const db = new BetterSqlite3(path, { readonly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  }

  it('journals an unbilled retried failure and a refusal, and replays the day identical', async () => {
    expect(
      rowsOf(
        refused.storePath,
        `SELECT l.error_class, l.error_message, l.stop_reason, l.response, s.cost_usd
           FROM llm_call_log l JOIN llm_spend s ON s.id = l.spend_id
          WHERE l.error_class IS NOT NULL OR l.stop_reason = 'refusal' ORDER BY l.id`,
      ),
    ).toEqual([
      {
        error_class: 'LlmRateLimitError',
        error_message: 'Nous 429: slow',
        stop_reason: null,
        response: null,
        cost_usd: 0,
      },
      {
        error_class: null,
        error_message: null,
        stop_reason: 'refusal',
        response: '',
        cost_usd: expect.any(Number),
      },
    ]);
    expect(rowsOf(refused.storePath, 'SELECT DISTINCT reason FROM v2_decisions')).toContainEqual({
      reason: expect.stringContaining('LLM refused to answer'),
    });
    const result = await replayFromFiles(refused);
    expect(result.divergences).toEqual([]);
  });

  it('replays an unbilled failure that ended the debate to the same reason', async () => {
    expect(rowsOf(failed.storePath, 'SELECT DISTINCT reason FROM v2_decisions')).toContainEqual({
      reason: 'llm_error:Nous 503: upstream down',
    });
    const result = await replayFromFiles(failed);
    expect(result.divergences).toEqual([]);
  });

  it('diverges when a logged failure is changed', async () => {
    const storePath = join(directory, 'failed-tampered.sqlite');
    copyFileSync(failed.storePath, storePath);
    const db = new BetterSqlite3(storePath);
    db.exec(`UPDATE llm_call_log SET error_message = 'other' WHERE error_class IS NOT NULL`);
    db.close();
    const result = await replayFromFiles({ ...failed, storePath });
    expect(result.divergences[0]).toMatchObject({ kind: 'decision_field', field: 'reason' });
  });
});

// CPU-heavy: runs a full composed day
describe('replay of a spend-refused name (#1987)', { timeout: 30_000 }, () => {
  let spent: ReplayCliOptions;

  beforeAll(async () => {
    const writer = openSharedStore(join(directory, 'spent.sqlite'));
    const article = {
      id: 'bz-1',
      headline: 'UP beats estimates',
      summary: '',
      symbols: ['UP'],
      source: 'benzinga',
      url: '',
      created_at: new Date(Date.UTC(2026, 8, 17)),
      updated_at: new Date(Date.UTC(2026, 8, 17)),
      payload: '',
    };
    const news = new AlpacaNewsSource(
      { fetchNews: ([symbol]) => Promise.resolve(symbol === 'UP' ? [article] : []) },
      new SqliteNewsLedger(guardedStore(writer, 'v2')),
    );
    try {
      spent = await seedDay('spent', scripted, news, (seed) => {
        seed
          .prepare(
            `INSERT INTO llm_spend (trace_id, stage, model, input_tokens, output_tokens, cost_usd, latency_ms, timestamp)
             VALUES ('t', 'debate', 'm', 1, 1, 30, 1, '${TRADING_DATE}T00:00:00.000Z')`,
          )
          .run();
      });
    } finally {
      writer.close();
    }
  }, 30_000);

  function reasonsOf(path: string): unknown[] {
    const db = new BetterSqlite3(path, { readonly: true });
    try {
      return db
        .prepare(
          `SELECT DISTINCT d.reason FROM v2_decisions d JOIN v2_books b ON b.book_id = d.book_id
            WHERE b.sleeve_id = 'debate' AND d.instrument = 'UP'`,
        )
        .all();
    } finally {
      db.close();
    }
  }

  it('replays identical from the journalled refusal, with no logged call', async () => {
    expect(reasonsOf(spent.storePath)).toEqual([{ reason: 'llm_spend_cap:budget' }]);
    const result = await replayFromFiles(spent);
    expect(result.calls).toBe(0);
    expect(result.divergences).toEqual([]);
  });

  it('diverges once the refusal row is gone', async () => {
    const storePath = join(directory, 'spent-unjournalled.sqlite');
    copyFileSync(spent.storePath, storePath);
    const db = new BetterSqlite3(storePath);
    db.exec(
      `DROP TRIGGER v2_decisions_no_delete;
       DELETE FROM v2_decisions WHERE reason = 'llm_spend_cap:budget'`,
    );
    db.close();
    const result = await replayFromFiles({ ...spent, storePath });
    expect(result.divergences).toContainEqual(expect.objectContaining({ kind: 'llm_request' }));
  });
});

async function revisedBarStore(name: string, index: number): Promise<string> {
  const barStoreRoot = join(directory, name);
  const revised = await ParquetBarStore.open(barStoreRoot);
  const bars = rising().map((bar, at) =>
    at === index ? { ...bar, high: bar.high * 1.05, close: bar.close * 1.05 } : bar,
  );
  await revised.write('alpaca', [
    { symbol: 'UP', bars },
    { symbol: 'SPY', bars: rising() },
  ]);
  revised.close();
  return barStoreRoot;
}

function cliArgs(overrides: Partial<ReplayCliOptions> = {}): string[] {
  const chosen = { ...options, ...overrides };
  return Object.entries({
    '--date': chosen.tradingDate,
    '--store': chosen.storePath,
    '--bars': chosen.barStoreRoot,
    '--constituents': chosen.constituentsPath,
    '--fx': chosen.fxPath,
    '--cfd-catalogue': chosen.cfdCataloguePath,
    '--spreads': chosen.spreadsPath,
    '--saxo-spreads': chosen.saxoSpreadsPath,
  }).flat();
}

describe('main', () => {
  it('prints identical and exits 0 on a matching day', async () => {
    const lines: string[] = [];
    const code = await main(
      Object.entries({
        '--date': options.tradingDate,
        '--store': options.storePath,
        '--bars': options.barStoreRoot,
        '--constituents': options.constituentsPath,
        '--fx': options.fxPath,
        '--cfd-catalogue': options.cfdCataloguePath,
        '--spreads': options.spreadsPath,
        '--saxo-spreads': options.saxoSpreadsPath,
      }).flat(),
      (line) => lines.push(line),
      {},
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/identical$/);
  });

  it('exits 2 and lists every changed input before the first other divergence (#2028)', async () => {
    const barStoreRoot = await revisedBarStore('cli-revised-parquet', 250);
    const cfdCataloguePath = join(directory, 'cli-written-later.json');
    writeFileSync(cfdCataloguePath, JSON.stringify({ asOf: TRADING_DATE, instruments: [] }));
    const lines: string[] = [];
    const code = await main(
      cliArgs({ barStoreRoot, cfdCataloguePath }),
      (line) => lines.push(line),
      {},
    );
    expect(code).toBe(2);
    const printed = lines
      .join('\n')
      .split('\n')
      .filter((line) => !line.includes(': not compared, the day ran before migration'));
    expect(printed[1]).toMatch(
      /^INPUT CHANGED \(2 inputs changed since the day, \d+ divergences\)/,
    );
    expect(printed.filter((line) => /^\S+: \S+ changed since /.test(line))).toEqual([
      `UP: bars changed since ${TRADING_DATE}`,
      `saxo-cfd-catalogue: cfd_catalogue changed since ${TRADING_DATE}`,
    ]);
    const other = printed.indexOf('first other divergence:');
    expect(other).toBeGreaterThan(
      printed.indexOf(`saxo-cfd-catalogue: cfd_catalogue changed since ${TRADING_DATE}`),
    );
    expect(printed[other + 1]).toContain('inputs_hash differs');
    expect(printed.join('\n')).not.toContain('DIVERGED');
  });

  it('exits 1 and redacts known secret values from the divergence it prints', async () => {
    const lines: string[] = [];
    const code = await main(
      ['--date', TRADING_DATE],
      (line) => lines.push(line),
      { NOUS_API_KEY: 'sk-nous-0123456789' },
      () =>
        Promise.resolve({
          tradingDate: TRADING_DATE,
          decisions: 1,
          calls: 0,
          orders: 0,
          fills: 0,
          skipped: [],
          divergences: [
            {
              kind: 'decision_field',
              bookId: 'debate',
              instrument: 'UP',
              field: 'reason',
              journalled: 'judge bullish',
              replayed: 'llm_error: sk-nous-0123456789',
            },
          ],
        }),
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('reason differs');
    expect(lines.join('\n')).not.toContain('sk-nous-0123456789');
  });

  it('exits 1 with the error when the replay throws', async () => {
    const lines: string[] = [];
    const code = await main(['--date', 'yesterday'], (line) => lines.push(line), {});
    expect(code).toBe(1);
    expect(lines).toEqual(['replay failed: --date YYYY-MM-DD is required']);
  });
});

describe('parseReplayArgs', () => {
  it('fills defaults around the date', () => {
    expect(parseReplayArgs(['--date', '2026-09-30'])).toMatchObject({
      tradingDate: '2026-09-30',
      storePath: 'data/samurai-v2-paper.sqlite',
    });
  });

  it('reads the spread tables the fill model prices with', () => {
    expect(
      parseReplayArgs(['--date', '2026-09-30', '--spreads', 'a.csv', '--saxo-spreads', 'b.csv']),
    ).toMatchObject({ spreadsPath: 'a.csv', saxoSpreadsPath: 'b.csv' });
  });

  it('refuses an unknown flag and a flag without a value', () => {
    expect(() => parseReplayArgs(['--dry-run', 'x'])).toThrow(
      'unknown or valueless argument --dry-run',
    );
    expect(() => parseReplayArgs(['--date'])).toThrow('unknown or valueless argument --date');
  });
});

const ROW: JournalledDecision = {
  book_id: 'debate/primary',
  sleeve_id: 'debate',
  variant: 'primary',
  instrument: 'UP',
  venue: 'alpaca',
  inputs_hash: 'h',
  direction: 'bullish',
  confidence: 0.75,
  action: 'enter_long',
  reason: 'judge bullish',
  stop_price: 9,
  payload: '{"synthesis":"s","debate_id":"d1"}',
};

const DECISION: SleeveDecision = {
  sleeve_id: 'debate',
  instrument: 'UP',
  venue: 'alpaca',
  direction: 'bullish',
  confidence: 0.75,
  action: 'enter_long',
  reason: 'judge bullish',
  price: 10,
  atr: 0.5,
  stop_price: 9,
  inputs_hash: 'h',
  debate_id: 'd1',
  payload: { synthesis: 's' },
};

describe('compareDecision', () => {
  it('matches a replayed decision byte for byte, debate id included', () => {
    expect(compareDecision(ROW, DECISION)).toBeUndefined();
  });

  it('names a missing decision and the first differing field', () => {
    expect(compareDecision(ROW, undefined)).toEqual({
      kind: 'decision_missing',
      bookId: 'debate/primary',
      instrument: 'UP',
    });
    expect(compareDecision(ROW, { ...DECISION, stop_price: undefined })).toMatchObject({
      field: 'stop_price',
      journalled: 9,
      replayed: null,
    });
    expect(compareDecision(ROW, { ...DECISION, debate_id: 'd2' })).toMatchObject({
      field: 'payload',
    });
  });
});

describe('divergencesOf', () => {
  it('orders inputs, then requests, then outputs, then calls never requested', () => {
    const log = new ReplayLog([
      { ...NO_OUTCOME, id: 7, traceId: 'v2-x-UP', model: 'm', prompt: 'p', response: 'r' },
    ]);
    expect(() => log.serve('m', 'q')).toThrow('request_not_logged');
    const replayed = new Map([
      [
        'debate',
        [
          { ...DECISION, inputs_hash: 'other' },
          { ...DECISION, instrument: 'NEW' },
        ],
      ],
    ]);
    const kinds = divergencesOf([ROW, { ...ROW, instrument: 'GONE' }], replayed, log).map(
      (entry) => (entry.kind === 'decision_field' ? `${entry.kind}:${entry.field}` : entry.kind),
    );
    expect(kinds).toEqual([
      'decision_field:inputs_hash',
      'llm_request',
      'decision_missing',
      'decision_extra',
      'call_not_replayed',
    ]);
  });
});

describe('journalledLseRefusal', () => {
  it('reads the day SAXO_SESSION refusal back without its prefix', () => {
    const db = migratedMemoryStore();
    const insert = db.prepare(
      `INSERT INTO v2_refusals (trading_date, scope, parameter, ticket, message, recorded_at)
       VALUES (?, 'data', 'SAXO_SESSION', '#1876', ?, 'now')`,
    );
    insert.run('2026-09-29', 'LSE leg refused: token expired');
    insert.run('2026-09-30', 'other wording');
    expect(journalledLseRefusal(db, '2026-09-29')).toBe('token expired');
    expect(journalledLseRefusal(db, '2026-09-30')).toBe('other wording');
    expect(journalledLseRefusal(db, '2026-10-01')).toBeUndefined();
    db.close();
  });
});

const BARS_DIGEST: InputDigest = {
  input: 'bars',
  name: 'UP',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  first_bar_date: '2026-09-28',
  last_bar_date: '2026-09-29',
  row_count: 2,
  as_of: null,
};

const CATALOGUE_DIGEST: InputDigest = {
  input: 'cfd_catalogue',
  name: 'saxo-cfd-catalogue',
  sha256: 'd'.repeat(64),
  first_bar_date: null,
  last_bar_date: null,
  row_count: null,
  as_of: '2026-09-29',
};

describe('formatReplay', () => {
  const result = (divergences: Divergence[]): ReplayResult => ({
    tradingDate: '2026-09-30',
    decisions: 2,
    calls: 3,
    orders: 4,
    fills: 1,
    skipped: [],
    divergences,
  });
  const logged: LoggedCall = {
    ...NO_OUTCOME,
    id: 4,
    traceId: 'v2-2026-09-30-UP',
    model: 'm',
    prompt: 'abc',
    response: 'r',
  };

  const barsChange: Divergence = {
    kind: 'input_changed_since',
    tradingDate: '2026-09-30',
    journalled: BARS_DIGEST,
    current: { ...BARS_DIGEST, sha256: 'b'.repeat(64) },
  };
  const catalogueChange: Divergence = {
    kind: 'input_changed_since',
    tradingDate: '2026-09-30',
    journalled: CATALOGUE_DIGEST,
    current: { ...CATALOGUE_DIGEST, sha256: 'c'.repeat(64) },
  };
  const missing: Divergence = { kind: 'decision_missing', bookId: 'b', instrument: 'UP' };

  it('lists every changed input, then the first other divergence (#2028)', () => {
    expect(
      formatReplay(result([barsChange, catalogueChange, missing, missing]), (line) => line).split(
        '\n',
      ),
    ).toEqual([
      'replay 2026-09-30: 2 journalled decisions, 3 logged calls, 4 orders, 1 fills',
      'INPUT CHANGED (2 inputs changed since the day, 4 divergences); every changed input:',
      'UP: bars changed since 2026-09-30',
      '  journalled: sha256 e3b0c44298fc, 2 bars 2026-09-28..2026-09-29',
      '  current:    sha256 bbbbbbbbbbbb, 2 bars 2026-09-28..2026-09-29',
      'saxo-cfd-catalogue: cfd_catalogue changed since 2026-09-30',
      '  journalled: sha256 dddddddddddd, asOf 2026-09-29',
      '  current:    sha256 cccccccccccc, asOf 2026-09-29',
      'first other divergence:',
      'b UP: journalled, not replayed',
    ]);
  });

  it('prints no other divergence when only inputs changed', () => {
    expect(formatReplay(result([catalogueChange]), (line) => line)).not.toContain('first other');
  });

  it.each([
    [[], 0],
    [[missing], 1],
    [[barsChange], 2],
    [[catalogueChange, missing], 2],
    [[missing, catalogueChange], 2],
  ] as [Divergence[], number][])(
    'exits with its own code for a changed input (#2028): %o -> %i',
    (divergences, code) => {
      expect(replayExitCode(result(divergences))).toBe(code);
    },
  );

  it('names each stage a cutover skipped, identical or not', () => {
    const skipped = [
      { stage: 'rescales', migration: 87 },
      { stage: 'carry', migration: 94 },
    ] as const;
    const head = [
      'replay 2026-09-30: 2 journalled decisions, 3 logged calls, 4 orders, 1 fills',
      'rescales: not compared, the day ran before migration 0087',
      'carry: not compared, the day ran before migration 0094',
    ].join('\n');
    expect(formatReplay({ ...result([]), skipped }, (text) => text)).toBe(`${head}\nidentical`);
    expect(
      formatReplay(
        { ...result([{ kind: 'row_extra', stage: 'carry', key: 'b|UP' }]), skipped },
        (text) => text,
      ),
    ).toBe(`${head}\nDIVERGED (1 divergences); first:\ncarry: b|UP: replayed, not journalled`);
    expect(
      formatReplay({ ...result([catalogueChange]), skipped }, (text) => text).split('\n'),
    ).toEqual([
      ...head.split('\n'),
      'INPUT CHANGED (1 inputs changed since the day, 1 divergences); every changed input:',
      'saxo-cfd-catalogue: cfd_catalogue changed since 2026-09-30',
      '  journalled: sha256 dddddddddddd, asOf 2026-09-29',
      '  current:    sha256 cccccccccccc, asOf 2026-09-29',
    ]);
  });

  it('says identical when nothing diverged', () => {
    expect(formatReplay(result([]), (text) => text)).toBe(
      'replay 2026-09-30: 2 journalled decisions, 3 logged calls, 4 orders, 1 fills\nidentical',
    );
  });

  it.each([
    [
      { kind: 'nothing_to_replay', tradingDate: '2026-09-30' },
      'no debate or arm 2 decision and no mark is journalled for 2026-09-30',
    ],
    [{ kind: 'decision_missing', bookId: 'b', instrument: 'UP' }, 'b UP: journalled, not replayed'],
    [
      {
        kind: 'input_changed_since',
        tradingDate: '2026-09-30',
        journalled: { ...BARS_DIGEST, sha256: 'a'.repeat(64) },
        current: { ...BARS_DIGEST, sha256: 'b'.repeat(64) },
      },
      'UP: bars changed since 2026-09-30\n  journalled: sha256 aaaaaaaaaaaa, 2 bars 2026-09-28..2026-09-29\n  current:    sha256 bbbbbbbbbbbb, 2 bars 2026-09-28..2026-09-29',
    ],
    [
      {
        kind: 'input_changed_since',
        tradingDate: '2026-09-30',
        journalled: { ...BARS_DIGEST, row_count: 0, first_bar_date: null, last_bar_date: null },
        current: { ...CATALOGUE_DIGEST, sha256: null, as_of: null },
      },
      '  journalled: sha256 e3b0c44298fc, 0 bars -..-\n  current:    absent, asOf -',
    ],
    [
      {
        kind: 'input_changed_since',
        tradingDate: '2026-09-30',
        journalled: CATALOGUE_DIGEST,
        current: { ...CATALOGUE_DIGEST, sha256: 'c'.repeat(64) },
      },
      'saxo-cfd-catalogue: cfd_catalogue changed since 2026-09-30\n  journalled: sha256 dddddddddddd, asOf 2026-09-29',
    ],
    [
      {
        kind: 'book_state',
        stage: 'book',
        bookId: 'b',
        asOf: '2026-09-29',
        field: 'cash_gbp',
        journalled: 1,
        replayed: 2,
      },
      'book: b at the 2026-09-29 mark: cash_gbp rebuilt from the journal differs\n  journalled: 1\n  replayed:   2',
    ],
    [
      {
        kind: 'book_state',
        stage: 'gate',
        bookId: 'b',
        asOf: '2026-09-29',
        field: 'entries_blocked',
        journalled: 1,
        replayed: 0,
      },
      'gate: b loss budget at the 2026-09-29 mark: entries_blocked differs from what its equity history gives',
    ],
    [
      {
        kind: 'row_field',
        stage: 'fills',
        key: 'alpaca:sim-x',
        field: 'price_gbp',
        journalled: 1.5,
        replayed: 1.25,
      },
      'fills: alpaca:sim-x: price_gbp differs\n  journalled: 1.5\n  replayed:   1.25',
    ],
    [{ kind: 'row_missing', stage: 'orders', key: 'o1' }, 'orders: o1: journalled, not replayed'],
    [{ kind: 'row_extra', stage: 'marks', key: 'b' }, 'marks: b: replayed, not journalled'],
    [{ kind: 'decision_extra', bookId: 'b', instrument: 'UP' }, 'b UP: replayed, not journalled'],
    [
      { kind: 'call_not_replayed', call: logged },
      'logged call 4 (v2-2026-09-30-UP, m) was never requested',
    ],
    [
      { kind: 'multiple_runs', tradingDate: '2026-09-30', earlierRuns: ['run-1'] },
      '2026-09-30 ran more than once: 1 earlier run(s) acted before the run that marked it, so it is not replayed; review it by hand',
    ],
    [
      {
        kind: 'llm_request',
        miss: {
          kind: 'request_not_logged',
          model: 'm',
          prompt: 'p',
          nearest: undefined,
          offset: 0,
        },
      },
      'LLM request request_not_logged for m: no logged call for that model is left',
    ],
    [
      {
        kind: 'llm_request',
        miss: { kind: 'request_not_logged', model: 'm', prompt: 'abd', nearest: logged, offset: 2 },
      },
      'nearest logged call 4 (v2-2026-09-30-UP) differs at offset 2\n  replayed: "d"\n  logged:   "c"',
    ],
  ] as [Divergence, string][])('describes %o', (divergence, text) => {
    const printed = formatReplay(result([divergence, divergence]), (line) => line);
    expect(printed).toContain(
      divergence.kind === 'input_changed_since'
        ? 'INPUT CHANGED (2 inputs changed since the day, 2 divergences); every changed input:'
        : 'DIVERGED (2 divergences); first:',
    );
    expect(printed).toContain(text);
  });
});

describe('redactor', () => {
  it('masks known secret values of usable length in raw, JSON-escaped and URI forms', () => {
    const redact = redactor(() => [
      { name: 'A', value: 'long/secret"value' },
      { name: 'B', value: 'short' },
    ]);
    expect(
      redact('x long/secret"value y long/secret\\"value z long%2Fsecret%22value w short'),
    ).toBe('x [REDACTED] y [REDACTED] z [REDACTED] w short');
  });
});

describe('main redaction', () => {
  it('masks a secret in a printed prompt excerpt even where the excerpt window would cut it', async () => {
    const secret = 'sk-nous-0123456789abcdef';
    const lines: string[] = [];
    const prefix = 'p'.repeat(70);
    const call: LoggedCall = {
      ...NO_OUTCOME,
      id: 1,
      traceId: 'v2-2026-09-30-UP',
      model: 'm',
      prompt: `${prefix}${secret} logged`,
      response: 'r',
    };
    const code = await main(
      ['--date', '2026-09-30'],
      (line) => lines.push(line),
      { NOUS_API_KEY: secret },
      () =>
        Promise.resolve({
          tradingDate: '2026-09-30',
          decisions: 1,
          calls: 1,
          orders: 0,
          fills: 0,
          skipped: [],
          divergences: [
            {
              kind: 'llm_request',
              miss: {
                kind: 'request_not_logged',
                model: 'm',
                prompt: `${prefix}${secret} replayed`,
                nearest: call,
                offset: 95,
              },
            },
          ],
        }),
    );
    const printed = lines.join('\n');
    expect(code).toBe(1);
    expect(printed).not.toContain(secret.slice(0, 8));
    expect(printed).not.toContain(secret.slice(-8));
    expect(printed).toContain('differs at offset 81\n  replayed: "replayed"\n  logged:   "logged"');
  });
});
