import { describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '../../../shared/index.js';
import { ALL_PINS } from './models.js';
import { verifyNousPins } from './nous-pin-check.js';

const KEY = 'nous-secret-key';

const LISTED = [
  { id: 'anthropic/claude-sonnet-5', canonical_slug: 'anthropic/claude-sonnet-5' },
  { id: 'openai/gpt-5.5', canonical_slug: 'openai/gpt-5.5-20260423' },
  { id: 'deepseek/deepseek-v4-pro-0813', canonical_slug: 'deepseek/deepseek-v4-pro-20260813' },
  { id: 'anthropic/claude-opus-5', canonical_slug: 'anthropic/claude-opus-5-20260723' },
  { id: 'other/model', canonical_slug: 'other/model-20260101' },
];

function answering(response: () => Promise<Response>) {
  return vi.fn((_url: string | URL | Request, _init?: RequestInit) => response());
}

function json(body: unknown, status = 200) {
  return answering(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

async function check(fetchImpl: typeof fetch, dryRun = false, apiKey: string | undefined = KEY) {
  const entries: LogEntry[] = [];
  const outcome = await verifyNousPins({
    dryRun,
    baseUrl: 'https://nous.test/v1',
    apiKey,
    pins: ALL_PINS,
    logger: { log: (entry) => entries.push(entry) },
    fetch: fetchImpl,
  }).then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  return { entries, error: outcome };
}

describe('verifyNousPins', () => {
  it('passes and logs every verified slug when the catalogue matches the pins', async () => {
    const fetchImpl = json({ data: LISTED });
    const { entries, error } = await check(fetchImpl);
    expect(error).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://nous.test/v1/models');
    expect(init?.headers).toEqual({ authorization: `Bearer ${KEY}` });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      trace_id: 'v2-root',
      stage: 'v2',
      event: 'v2_llm_pins_verified',
      level: 'info',
      message:
        'anthropic/claude-sonnet-5 = anthropic/claude-sonnet-5 (slug unverified), openai/gpt-5.5 = openai/gpt-5.5-20260423, deepseek/deepseek-v4-pro-0813 = deepseek/deepseek-v4-pro-20260813, anthropic/claude-opus-5 = anthropic/claude-opus-5-20260723',
      payload: [
        {
          seat: 'sonnet',
          wire: 'anthropic/claude-sonnet-5',
          canonical_slug: 'anthropic/claude-sonnet-5',
          slug_verified: false,
        },
        {
          seat: 'gpt',
          wire: 'openai/gpt-5.5',
          canonical_slug: 'openai/gpt-5.5-20260423',
          slug_verified: true,
        },
        {
          seat: 'deepseek',
          wire: 'deepseek/deepseek-v4-pro-0813',
          canonical_slug: 'deepseek/deepseek-v4-pro-20260813',
          slug_verified: true,
        },
        {
          seat: 'judge',
          wire: 'anthropic/claude-opus-5',
          canonical_slug: 'anthropic/claude-opus-5-20260723',
          slug_verified: true,
        },
      ],
    });
    expect(JSON.stringify(entries)).not.toContain(KEY);
  });

  it.each([
    ['the dated shape', 'anthropic/claude-sonnet-5-20260630'],
    ['a slug-less row', undefined],
  ])('accepts Sonnet 5 listed with %s and logs the slug it observed', async (_label, slug) => {
    const rows = LISTED.map((row) =>
      row.id === 'anthropic/claude-sonnet-5' ? { id: row.id, canonical_slug: slug } : row,
    );
    const { entries, error } = await check(json({ data: rows }));
    expect(error).toBeUndefined();
    expect(entries[0]?.message).toContain(
      `anthropic/claude-sonnet-5 = ${String(slug)} (slug unverified), openai/gpt-5.5`,
    );
    expect(entries[0]?.payload).toContainEqual({
      seat: 'sonnet',
      wire: 'anthropic/claude-sonnet-5',
      canonical_slug: slug,
      slug_verified: false,
    });
  });

  it('refuses when Sonnet 5 is not listed at all', async () => {
    const rows = LISTED.filter((row) => row.id !== 'anthropic/claude-sonnet-5');
    const { entries, error } = await check(json({ data: rows }));
    expect(error?.message).toBe(
      'v2 refuses the paper run: Nous GET /models: sonnet anthropic/claude-sonnet-5 is not listed — a changed snapshot is a new trial',
    );
    expect(entries).toEqual([]);
  });

  it.each([
    ['gpt', 'openai/gpt-5.5', 'openai/gpt-5.5-20260423'],
    ['deepseek', 'deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4-pro-20260813'],
    ['judge', 'anthropic/claude-opus-5', 'anthropic/claude-opus-5-20260723'],
  ])('stays strict on the %s seat: an undated slug refuses', async (seat, wire, pinned) => {
    const rows = LISTED.map((row) => (row.id === wire ? { id: wire, canonical_slug: wire } : row));
    const { entries, error } = await check(json({ data: rows }));
    expect(error?.message).toBe(
      `v2 refuses the paper run: Nous GET /models: ${seat} ${wire} resolves to ${wire}, pinned ${pinned} — a changed snapshot is a new trial`,
    );
    expect(entries).toEqual([]);
  });

  it('never calls Nous on a dry run', async () => {
    const fetchImpl = json({ data: LISTED });
    const { entries, error } = await check(fetchImpl, true);
    expect(error).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
  });

  it('refuses when a pin resolves to a different snapshot', async () => {
    const swapped = LISTED.map((row) =>
      row.id === 'anthropic/claude-opus-5'
        ? { ...row, canonical_slug: 'anthropic/claude-opus-5-20261101' }
        : row,
    );
    const { entries, error } = await check(json({ data: swapped }));
    expect(error?.message).toBe(
      'v2 refuses the paper run: Nous GET /models: judge anthropic/claude-opus-5 resolves to anthropic/claude-opus-5-20261101, pinned anthropic/claude-opus-5-20260723 — a changed snapshot is a new trial',
    );
    expect(entries).toEqual([]);
  });

  it('refuses when a pin is missing or its slug is absent, naming every failing seat', async () => {
    const rows = [
      ...LISTED.filter((row) => row.id !== 'openai/gpt-5.5').map((row) =>
        row.id === 'deepseek/deepseek-v4-pro-0813' ? { id: row.id } : row,
      ),
      null,
      'not-a-row',
    ];
    const { error } = await check(json({ data: rows }));
    expect(error?.message).toBe(
      'v2 refuses the paper run: Nous GET /models: gpt openai/gpt-5.5 is not listed; deepseek deepseek/deepseek-v4-pro-0813 resolves to undefined, pinned deepseek/deepseek-v4-pro-20260813 — a changed snapshot is a new trial',
    );
  });

  it.each([401, 500])('fails closed on HTTP %i without echoing the key', async (status) => {
    const { error } = await check(json({ error: { message: `bad key ${KEY}` } }, status));
    expect(error?.message).toBe(
      `v2 refuses the paper run: Nous GET /models answered HTTP ${status}`,
    );
  });

  it.each([
    ['a non-JSON body', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['a JSON null body', () => Promise.resolve(new Response('null', { status: 200 }))],
    ['a body without data', () => Promise.resolve(new Response('{"models":[]}', { status: 200 }))],
  ])('fails closed on %s', async (_label, response) => {
    const { error } = await check(answering(response));
    expect(error?.message).toBe(
      'v2 refuses the paper run: Nous GET /models returned no "data" array',
    );
  });

  it('fails closed when the request itself fails, redacting the key from the cause', async () => {
    const { error } = await check(
      answering(() => Promise.reject(new TypeError(`connect failed for ${KEY}`))),
    );
    expect(error?.message).toBe(
      'v2 refuses the paper run: Nous GET /models failed: connect failed for [redacted]',
    );
  });

  it.each([
    ['a key', KEY],
    ['an empty key', ''],
    ['no key', undefined],
  ])('fails closed on a non-Error rejection with %s', async (_label, apiKey) => {
    const { error } = await check(
      answering(() => Promise.reject('socket hang up')),
      false,
      apiKey,
    );
    expect(error?.message).toBe(
      'v2 refuses the paper run: Nous GET /models failed: socket hang up',
    );
  });

  it('uses the global fetch and a bounded timeout when none is injected', async () => {
    const global = json({ data: LISTED });
    vi.stubGlobal('fetch', global);
    try {
      await verifyNousPins({
        dryRun: false,
        baseUrl: 'https://nous.test/v1',
        apiKey: '',
        pins: ALL_PINS,
        logger: { log: () => {} },
        timeoutMs: 5,
      });
      expect(global).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
