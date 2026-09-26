import { afterEach, describe, expect, it } from 'vitest';
import { guardedStore, openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { ControlStore } from '../risk/index.js';
import { CONTROL_MIN_INTERVAL_MS, ControlWriter, parseControlRequest } from './control-writer.js';

const T0 = new Date('2026-09-28T10:00:00.000Z');
const KEY = 'key-0001';

function at(offsetMs: number) {
  return { now: () => new Date(T0.getTime() + offsetMs) };
}

let db: StoreHandle;

function writer(offsetMs = 0): ControlWriter {
  return new ControlWriter(guardedStore(db, 'dashboard', { enabled: true }), at(offsetMs));
}

afterEach(() => db?.close());

describe('parseControlRequest', () => {
  const valid = { action: 'halt', reason: '  market chaos  ', idempotency_key: KEY };

  it('accepts a well-formed request and trims the reason', () => {
    expect(parseControlRequest(valid)).toEqual({
      ok: true,
      request: { action: 'halt', reason: 'market chaos', idempotency_key: KEY },
    });
  });

  it.each([
    [null, 'body must be a JSON object'],
    [[valid], 'body must be a JSON object'],
    ['halt', 'body must be a JSON object'],
    [{ ...valid, source: 'x' }, 'unexpected field(s): source'],
    [{ ...valid, action: 'flatten' }, 'action must be pause, halt or resume'],
    [{ ...valid, action: undefined }, 'action must be pause, halt or resume'],
    [{ ...valid, reason: '   ' }, 'reason is required'],
    [{ ...valid, reason: 7 }, 'reason is required'],
    [{ ...valid, reason: 'x'.repeat(501) }, 'reason is longer than 500 characters'],
    [
      { ...valid, idempotency_key: 'short' },
      'idempotency_key must be 8-128 letters, digits, - or _',
    ],
    [
      { ...valid, idempotency_key: 'bad key!' },
      'idempotency_key must be 8-128 letters, digits, - or _',
    ],
    [
      { ...valid, idempotency_key: 'k'.repeat(129) },
      'idempotency_key must be 8-128 letters, digits, - or _',
    ],
    [
      { ...valid, idempotency_key: 12345678 },
      'idempotency_key must be 8-128 letters, digits, - or _',
    ],
  ])('refuses %j', (body, reason) => {
    expect(parseControlRequest(body)).toEqual({ ok: false, reason });
  });

  it('accepts the boundary lengths', () => {
    const edge = { ...valid, reason: 'x'.repeat(500), idempotency_key: 'k'.repeat(128) };
    expect(parseControlRequest(edge).ok).toBe(true);
    expect(parseControlRequest({ ...valid, idempotency_key: 'k'.repeat(8) }).ok).toBe(true);
  });
});

describe('ControlWriter', () => {
  const halt = { action: 'halt', reason: 'chaos', idempotency_key: KEY } as const;

  it('writes the row with a server-set source and time, and the cycle reads it', () => {
    db = openSharedStore(':memory:');
    const result = writer().write(halt, 'dashboard 127.0.0.1');
    expect(result).toEqual({
      kind: 'created',
      control: {
        control_id: 1,
        action: 'halt',
        reason: 'chaos',
        source: 'dashboard 127.0.0.1',
        set_at: T0.toISOString(),
      },
    });
    expect(new ControlStore(db).current()).toEqual({
      state: 'halted',
      reason: 'chaos',
      setAt: T0.toISOString(),
    });
  });

  it('replays a repeated key with the first result, even inside the rate window', () => {
    db = openSharedStore(':memory:');
    const first = writer().write(halt, 'dashboard a');
    const again = writer(1).write(halt, 'dashboard b');
    expect(again).toEqual({ kind: 'replayed', control: first.kind === 'created' && first.control });
    expect(db.prepare('SELECT COUNT(*) AS n FROM v2_controls').get()).toEqual({ n: 1 });
  });

  it('refuses a repeated key carrying a different control', () => {
    db = openSharedStore(':memory:');
    writer().write(halt, 'dashboard');
    expect(writer(60_000).write({ ...halt, action: 'pause' }, 'dashboard')).toEqual({
      kind: 'conflict',
      reason: 'idempotency_key was already used for a different control',
    });
    expect(writer(60_000).write({ ...halt, reason: 'other' }, 'dashboard').kind).toBe('conflict');
  });

  it('allows one control per 10 seconds and says when to retry', () => {
    db = openSharedStore(':memory:');
    writer().write(halt, 'dashboard');
    const resume = { action: 'resume', reason: 'ok', idempotency_key: 'key-0002' } as const;
    expect(writer(1).write(resume, 'dashboard')).toEqual({
      kind: 'too-soon',
      retryAfterSeconds: 10,
    });
    expect(writer(CONTROL_MIN_INTERVAL_MS - 1_500).write(resume, 'dashboard')).toEqual({
      kind: 'too-soon',
      retryAfterSeconds: 2,
    });
    expect(writer(CONTROL_MIN_INTERVAL_MS - 1).write(resume, 'dashboard')).toEqual({
      kind: 'too-soon',
      retryAfterSeconds: 1,
    });
    expect(writer(CONTROL_MIN_INTERVAL_MS).write(resume, 'dashboard').kind).toBe('created');
    expect(new ControlStore(db).current()).toEqual({ state: 'running' });
  });

  it('never locks controls out when the clock has stepped back behind the last one', () => {
    db = openSharedStore(':memory:');
    writer().write(halt, 'dashboard');
    const resume = { action: 'resume', reason: 'ok', idempotency_key: 'key-0002' } as const;
    expect(writer(-60_000).write(resume, 'dashboard').kind).toBe('created');
  });
});
