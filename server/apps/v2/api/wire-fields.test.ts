import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { V2_WIRE_FIELD_NAMES, type V2OverviewWire } from '../../../../contracts/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { BarsMarketData } from '../data/index.js';
import { createFixtureStore } from './fixture-server.js';
import { OverviewReader } from './overview.js';
import { PositionsPanel } from './positions.js';

type WireType = keyof typeof V2_WIRE_FIELD_NAMES;

let dir: string;
let db: StoreHandle;
let overview: V2OverviewWire;

beforeAll(async () => {
  const fixture = createFixtureStore();
  dir = fixture.dir;
  db = openSharedStore(fixture.storePath);
  db.prepare(
    `INSERT INTO llm_spend (trace_id, stage, model, cost_usd, timestamp)
     VALUES ('t', 'debate', 'claude-sonnet-5', 0.02, '2026-10-05T21:00:00.000Z')`,
  ).run();
  const control = db.prepare(
    `INSERT INTO v2_controls (action, reason, source, idempotency_key, set_at)
     VALUES (?, 'fixture', 'dashboard 127.0.0.1', ?, ?)`,
  );
  control.run('resume', 'key-resume', '2026-10-05T12:00:00.000Z');
  control.run('pause', 'key-pause', '2026-10-06T12:00:00.000Z');
  const close = 125;
  const marks = {
    lastBarsBefore: () =>
      Promise.resolve(
        new Map([
          [
            'alpaca:AAPL',
            {
              date: '2026-10-05',
              open: close,
              high: close,
              low: close,
              close,
              volume: 1,
              rawClose: close,
            },
          ],
        ]),
      ),
  };
  overview = await new OverviewReader(
    db,
    { now: () => new Date('2026-10-06T21:40:00.000Z') },
    'paper',
    new PositionsPanel(
      marks,
      new BarsMarketData({ load: () => undefined }, [{ date: '2025-12-31', gbpUsd: 1.25 }]),
    ),
  ).read();
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function keysOf(value: unknown): string[] {
  return Object.keys(value as object).sort();
}

function fieldsOf(type: WireType, fed = false): string[] {
  return [...V2_WIRE_FIELD_NAMES[type], ...(fed ? ['status'] : [])].sort();
}

function first<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('the fixture serves no row to check');
  return row;
}

describe('the overview the client reads, served over the seeded fixture', () => {
  it('writes every field of every Today wire type', () => {
    expect(keysOf(overview)).toEqual(fieldsOf('overview'));

    const budget = overview.loss_budget;
    if (budget.status !== 'fed') throw new Error(`loss budget ${budget.status}`);
    expect(keysOf(budget)).toEqual(fieldsOf('lossBudget', true));
    expect(keysOf(first(budget.books))).toEqual(fieldsOf('lossBudgetBook'));

    const positions = overview.positions;
    if (positions.status !== 'fed') throw new Error(`positions ${positions.status}`);
    expect(keysOf(positions)).toEqual(fieldsOf('positions', true));
    const position = first(positions.positions);
    expect(keysOf(position)).toEqual(fieldsOf('position'));
    expect(position.mark.status).toBe('fresh');
    expect(keysOf(position.mark)).toEqual(fieldsOf('freshMark'));
    expect(keysOf(first(positions.venues))).toEqual(fieldsOf('venueTotal'));
    expect(keysOf(first(positions.cash))).toEqual(fieldsOf('bookCash'));
    expect(keysOf(positions.fx)).toEqual(fieldsOf('fxRate'));

    const decisions = overview.decisions;
    if (decisions.status !== 'fed') throw new Error(`decisions ${decisions.status}`);
    expect(keysOf(decisions)).toEqual(fieldsOf('decisions', true));
    expect(keysOf(first(decisions.decisions))).toEqual(fieldsOf('decision'));

    expect(keysOf(overview.control)).toEqual(fieldsOf('control'));
    expect(keysOf(overview.control.in_force)).toEqual(fieldsOf('controlRow'));
    expect(keysOf(first(overview.control.history))).toEqual(fieldsOf('controlRow'));

    const spend = overview.llm_spend;
    if (spend.status !== 'fed') throw new Error(`llm spend ${spend.status}`);
    expect(keysOf(spend)).toEqual(fieldsOf('llmSpend', true));
    expect(keysOf(first(spend.by_model))).toEqual(fieldsOf('llmSpendModel'));
    expect(keysOf(first(spend.by_day))).toEqual(fieldsOf('llmSpendDay'));

    expect(keysOf(overview.heartbeat)).toEqual(fieldsOf('heartbeat'));
    const lastCycle = overview.heartbeat.last_cycle;
    if (lastCycle.status !== 'fed') throw new Error(`last cycle ${lastCycle.status}`);
    expect(keysOf(lastCycle)).toEqual(fieldsOf('lastCycle', true));
  });

  it('serves the heartbeat fields the fixture has no cycle for as owned, never missing', () => {
    expect(overview.heartbeat.next_due).toEqual({
      status: 'not-yet-fed',
      owner: 'Step 3e',
      ticket: '#1784',
    });
    expect(keysOf(overview.heartbeat.last_ping)).toEqual(fieldsOf('panel'));
  });
});
