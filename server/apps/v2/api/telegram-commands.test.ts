import { afterEach, describe, expect, it } from 'vitest';
import type { V2OverviewWire } from '../../../../contracts/index.js';
import { guardedStore, openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { BarsMarketData, type MarkSource } from '../data/index.js';
import { ControlStore } from '../risk/index.js';
import { CommandLog } from './command-log.js';
import { ControlWriter } from './control-writer.js';
import { OverviewReader } from './overview.js';
import { PositionsPanel } from './positions.js';
import {
  CONFIRM_WINDOW_MS,
  CommandHandler,
  STALE_AFTER_MS,
  type TelegramUpdate,
} from './telegram-commands.js';

const OWNER = 424242;
const START = new Date('2026-09-29T10:00:00.000Z');
const CODE = '4821';

let db: StoreHandle;
let nowMs: number;
let nextUpdateId: number;
let overview: () => Promise<V2OverviewWire>;

afterEach(() => db?.close());

const NO_MARKS: MarkSource = { lastBarsBefore: () => Promise.resolve(new Map()) };

function build(): CommandHandler {
  db = openSharedStore(':memory:');
  nowMs = START.getTime();
  nextUpdateId = 100;
  const clock = { now: () => new Date(nowMs) };
  const reader = new OverviewReader(
    db,
    clock,
    'paper',
    new PositionsPanel(NO_MARKS, new BarsMarketData({ load: () => undefined }, [])),
  );
  overview = () => reader.read();
  return handlerOver(clock);
}

function handlerOver(clock: { now: () => Date }): CommandHandler {
  return new CommandHandler({
    ownerChatId: OWNER,
    clock,
    controls: new ControlWriter(guardedStore(db, 'dashboard', { enabled: true }), clock),
    current: () => new ControlStore(db).current(),
    overview: () => overview(),
    log: new CommandLog(guardedStore(db, 'telegram', { enabled: true }), clock),
    newCode: () => CODE,
  });
}

function message(
  text: string,
  options: { chat?: number; type?: string; from?: number | null; ageMs?: number } = {},
): TelegramUpdate {
  nextUpdateId += 1;
  const chat = options.chat ?? OWNER;
  const from = options.from === undefined ? OWNER : options.from;
  return {
    update_id: nextUpdateId,
    message: {
      date: Math.floor((nowMs - (options.ageMs ?? 0)) / 1_000),
      text,
      chat: { id: chat, type: options.type ?? 'private' },
      ...(from === null ? {} : { from: { id: from } }),
    },
  };
}

function advance(ms: number): void {
  nowMs += ms;
}

function controlState(): string {
  return new ControlStore(db).current().state;
}

function controlRows(): { action: string; reason: string; source: string }[] {
  return db.prepare('SELECT action, reason, source FROM v2_controls ORDER BY control_id').all() as {
    action: string;
    reason: string;
    source: string;
  }[];
}

function journal(): {
  command: string;
  outcome: string;
  chat_id: string;
  control_id: number | null;
}[] {
  return db
    .prepare('SELECT command, outcome, chat_id, control_id FROM v2_commands ORDER BY command_id')
    .all() as { command: string; outcome: string; chat_id: string; control_id: number | null }[];
}

describe('authentication', () => {
  it('refuses a command from any other chat: no reply, no control, journalled', async () => {
    const handler = build();
    const reply = await handler.handle(message('halt', { chat: 999, from: 999 }));
    expect(reply).toBeUndefined();
    expect(controlRows()).toEqual([]);
    expect(journal()).toEqual([
      { command: 'halt', outcome: 'refused_unauthorized', chat_id: '999', control_id: null },
    ]);
  });

  it('refuses flatten and its confirmation from another chat', async () => {
    const handler = build();
    await handler.handle(message('flatten', { chat: 999, from: 999 }));
    await handler.handle(message(`flatten ${CODE}`, { chat: 999, from: 999 }));
    expect(controlRows()).toEqual([]);
    expect(journal().map((row) => row.outcome)).toEqual([
      'refused_unauthorized',
      'refused_unauthorized',
    ]);
  });

  it('refuses the owner id when it arrives in a group chat', async () => {
    const handler = build();
    expect(await handler.handle(message('halt', { type: 'group' }))).toBeUndefined();
    expect(controlRows()).toEqual([]);
  });

  it('refuses a message in the owner chat from another sender or with none', async () => {
    const handler = build();
    expect(await handler.handle(message('halt', { from: 7 }))).toBeUndefined();
    expect(await handler.handle(message('halt', { from: null }))).toBeUndefined();
    expect(controlRows()).toEqual([]);
    expect(journal().map((row) => row.outcome)).toEqual([
      'refused_unauthorized',
      'refused_unauthorized',
    ]);
  });

  it('ignores an update with no message text and journals nothing', async () => {
    const handler = build();
    expect(await handler.handle({ update_id: 5 })).toBeUndefined();
    const bare = message('x');
    expect(
      await handler.handle({ update_id: 6, message: { ...bare.message!, text: undefined } }),
    ).toBeUndefined();
    expect(journal()).toEqual([]);
  });
});

describe('halt', () => {
  it('blocks new entries by recording a pause and says positions keep their stops', async () => {
    const handler = build();
    const reply = await handler.handle(message('halt'));
    expect(reply).toMatch(/Paused: no new entries/);
    expect(reply).toMatch(/resting stops/);
    expect(controlRows()).toEqual([
      { action: 'pause', reason: 'Telegram halt command', source: 'telegram' },
    ]);
    expect(controlState()).toBe('paused');
    expect(journal()).toEqual([
      { command: 'halt', outcome: 'applied', chat_id: String(OWNER), control_id: 1 },
    ]);
  });

  it('takes an optional reason, and the /command@bot form', async () => {
    const handler = build();
    await handler.handle(message('/HALT@samurai_bot news risk'));
    expect(controlRows()[0]).toMatchObject({ action: 'pause', reason: 'news risk' });
  });

  it('refuses a reason longer than the control limit', async () => {
    const handler = build();
    const reply = await handler.handle(message(`halt ${'x'.repeat(251)}`));
    expect(reply).toMatch(/longer than 250/);
    expect(controlRows()).toEqual([]);
    expect(journal()[0]?.outcome).toBe('refused_invalid');
  });

  it('is a no-op when already paused', async () => {
    const handler = build();
    await handler.handle(message('halt'));
    advance(60_000);
    expect(await handler.handle(message('halt'))).toMatch(/Already paused/);
    expect(controlRows()).toHaveLength(1);
    expect(journal().map((row) => row.outcome)).toEqual(['applied', 'noop']);
  });

  it('never downgrades a flatten in force to a pause', async () => {
    const handler = build();
    await handler.handle(message('flatten'));
    await handler.handle(message(`flatten ${CODE}`));
    advance(60_000);
    expect(await handler.handle(message('halt'))).toMatch(/Already halted/);
    expect(controlState()).toBe('halted');
    expect(controlRows().map((row) => row.action)).toEqual(['halt']);
  });

  it('is refused inside the control rate limit, with the wait', async () => {
    const handler = build();
    await handler.handle(message('halt'));
    advance(1_000);
    await handler.handle(message('resume'));
    expect(controlRows()).toHaveLength(1);
    expect(journal()[1]).toMatchObject({ command: 'resume', outcome: 'refused_too_soon' });
    advance(10_000);
    expect(await handler.handle(message('resume'))).toMatch(/Resumed/);
  });
});

describe('resume', () => {
  it('lifts a manual pause', async () => {
    const handler = build();
    await handler.handle(message('halt'));
    advance(60_000);
    const reply = await handler.handle(message('resume'));
    expect(reply).toMatch(/Resumed/);
    expect(controlState()).toBe('running');
    expect(journal().map((row) => row.outcome)).toEqual(['applied', 'applied']);
  });

  it('lifts a manual flatten halt', async () => {
    const handler = build();
    await handler.handle(message('flatten'));
    await handler.handle(message(`flatten ${CODE}`));
    advance(60_000);
    await handler.handle(message('resume'));
    expect(controlState()).toBe('running');
  });

  it('is a no-op when nothing is in force', async () => {
    const handler = build();
    expect(await handler.handle(message('resume'))).toMatch(/Already running/);
    expect(controlRows()).toEqual([]);
    expect(journal()[0]?.outcome).toBe('noop');
  });

  it('never lifts a loss-budget halt (G6) and says so', async () => {
    const handler = build();
    db.prepare(
      `INSERT INTO v2_capital_config (year, effective_from, start_capital_gbp, loss_cap_gbp, recorded_at)
       VALUES (2026, '2026-01-01', 2000, 1500, '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
       VALUES ('debate/primary', 'debate', 'primary', 1000, 0, '2026-09-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO v2_book_days (book_id, trading_date, equity_gbp, cash_gbp, invested_gbp, ytd_loss_gbp,
         size_multiplier, entries_blocked, custody_accrual_gbp, recorded_at)
       VALUES ('debate/primary', '2026-09-28', 0, 0, 0, 1500, 0, 1, 0, '2026-09-28T21:40:00.000Z')`,
    ).run();
    await handler.handle(message('halt'));
    advance(60_000);
    const reply = await handler.handle(message('resume'));
    expect(reply).toMatch(
      /loss-budget halt is still in force on debate\/primary; resume never lifts it/,
    );
    expect(controlState()).toBe('running');
    expect((await overview()).control.state).toBe('halted-loss-budget');
  });

  it('still resumes when the loss-budget state cannot be read, and says to check', async () => {
    const handler = build();
    await handler.handle(message('halt'));
    advance(60_000);
    overview = () => Promise.reject(new Error('store locked'));
    const reply = await handler.handle(message('resume'));
    expect(reply).toMatch(/Resumed.*Loss-budget state could not be read/);
    expect(controlState()).toBe('running');
  });
});

describe('flatten', () => {
  it('does nothing without the confirmation', async () => {
    const handler = build();
    const reply = await handler.handle(message('flatten'));
    expect(reply).toContain(`flatten ${CODE}`);
    expect(reply).toMatch(/Nothing happens yet/);
    expect(controlRows()).toEqual([]);
    expect(controlState()).toBe('running');
    expect(journal()).toEqual([
      {
        command: 'flatten',
        outcome: 'confirmation_requested',
        chat_id: String(OWNER),
        control_id: null,
      },
    ]);
  });

  it('records a halt once the code comes back, and says entries stay blocked', async () => {
    const handler = build();
    await handler.handle(message('flatten'));
    advance(30_000);
    const reply = await handler.handle(message(`flatten ${CODE}`));
    expect(reply).toMatch(/Flatten recorded.*every open position closes at the next cycle/);
    expect(controlRows()).toEqual([
      { action: 'halt', reason: 'Telegram flatten confirmed', source: 'telegram' },
    ]);
    expect(controlState()).toBe('halted');
    expect(journal()[1]).toMatchObject({ outcome: 'applied', control_id: 1 });
  });

  it('accepts the code only once', async () => {
    const handler = build();
    await handler.handle(message('flatten'));
    await handler.handle(message(`flatten ${CODE}`));
    advance(60_000);
    await handler.handle(message('resume'));
    advance(60_000);
    expect(await handler.handle(message(`flatten ${CODE}`))).toMatch(/not confirmed/);
    expect(controlState()).toBe('running');
  });

  it('refuses a wrong code and drops the pending request', async () => {
    const handler = build();
    await handler.handle(message('flatten'));
    expect(await handler.handle(message('flatten 0000'))).toMatch(/not confirmed/);
    expect(await handler.handle(message(`flatten ${CODE}`))).toMatch(/not confirmed/);
    expect(controlRows()).toEqual([]);
    expect(journal().map((row) => row.outcome)).toEqual([
      'confirmation_requested',
      'confirmation_refused',
      'confirmation_refused',
    ]);
  });

  it('refuses a confirmation with no request', async () => {
    const handler = build();
    expect(await handler.handle(message(`flatten ${CODE}`))).toMatch(/not confirmed/);
    expect(controlRows()).toEqual([]);
  });

  it('refuses a confirmation after the window', async () => {
    const handler = build();
    await handler.handle(message('flatten'));
    advance(CONFIRM_WINDOW_MS + 1_000);
    expect(await handler.handle(message(`flatten ${CODE}`))).toMatch(/not confirmed/);
    expect(controlRows()).toEqual([]);
  });

  it('accepts a confirmation exactly at the window edge', async () => {
    const handler = build();
    await handler.handle(message('flatten'));
    advance(CONFIRM_WINDOW_MS);
    expect(await handler.handle(message(`flatten ${CODE}`))).toMatch(/Flatten recorded/);
  });

  it('drops the pending request when any other command comes in between', async () => {
    const handler = build();
    await handler.handle(message('flatten'));
    await handler.handle(message('status'));
    expect(await handler.handle(message(`flatten ${CODE}`))).toMatch(/not confirmed/);
    expect(controlRows()).toEqual([]);
  });

  it('drops the pending request when the handler restarts', async () => {
    const first = build();
    await first.handle(message('flatten'));
    const restarted = handlerOver({ now: () => new Date(nowMs) });
    expect(await restarted.handle(message(`flatten ${CODE}`))).toMatch(/not confirmed/);
    expect(controlRows()).toEqual([]);
  });

  it('is a no-op when a flatten is already in force', async () => {
    const handler = build();
    await handler.handle(message('flatten'));
    await handler.handle(message(`flatten ${CODE}`));
    advance(60_000);
    expect(await handler.handle(message('flatten'))).toMatch(/Already halted/);
    expect(controlRows()).toHaveLength(1);
  });

  it('keeps the request alive when the confirmation hits the control rate limit', async () => {
    const handler = build();
    await handler.handle(message('halt'));
    advance(1_000);
    await handler.handle(message('flatten'));
    advance(1_000);
    expect(await handler.handle(message(`flatten ${CODE}`))).toMatch(/Resend in \d+ s/);
    advance(10_000);
    expect(await handler.handle(message(`flatten ${CODE}`))).toMatch(/Flatten recorded/);
  });
});

describe('status', () => {
  it('answers with the state, equity, positions, loss budget and spend, and changes nothing', async () => {
    const handler = build();
    const reply = await handler.handle(message('status'));
    expect(reply).toContain('Samurai v2 status (paper)');
    expect(reply).toContain('State: RUNNING');
    expect(reply).toContain('LLM spend this month: $0.00 of $30.00');
    expect(controlRows()).toEqual([]);
    expect(journal()[0]?.outcome).toBe('answered');
  });

  it('reports a failure without leaking the cause beyond a sanitised message', async () => {
    const handler = build();
    overview = () =>
      Promise.reject(new Error('boom token=123456789:AAH-secret-secret-secret-secret1'));
    const reply = await handler.handle(message('status'));
    expect(reply).toMatch(/^Command failed: /);
    expect(reply).not.toContain('AAH-secret');
    expect(journal()[0]?.outcome).toBe('failed');
  });
});

describe('unknown commands', () => {
  it('answers with the command list and changes nothing', async () => {
    const handler = build();
    expect(await handler.handle(message('sell everything'))).toMatch(/Unknown command\. Commands:/);
    expect(controlRows()).toEqual([]);
    expect(journal()[0]?.outcome).toBe('refused_invalid');
  });
});

describe('stale and replayed messages', () => {
  it('refuses a command older than the cutoff', async () => {
    const handler = build();
    const reply = await handler.handle(message('flatten', { ageMs: STALE_AFTER_MS + 1_000 }));
    expect(reply).toMatch(/more than 10 minutes old/);
    expect(journal()[0]?.outcome).toBe('refused_stale');
    expect(controlRows()).toEqual([]);
  });

  it('acts on a command exactly at the cutoff', async () => {
    const handler = build();
    expect(await handler.handle(message('halt', { ageMs: STALE_AFTER_MS }))).toMatch(/Paused/);
  });

  it('handles the same update once, in this process and after a restart', async () => {
    const handler = build();
    const update = message('halt');
    expect(await handler.handle(update)).toMatch(/Paused/);
    expect(await handler.handle(update)).toBeUndefined();
    const restarted = handlerOver({ now: () => new Date(nowMs) });
    expect(await restarted.handle(update)).toBeUndefined();
    expect(controlRows()).toHaveLength(1);
    expect(journal()).toHaveLength(1);
  });

  it('writes no second control when the previous run recorded it but died before journalling', async () => {
    const handler = build();
    const update = message('halt');
    const clock = { now: () => new Date(nowMs) };
    new ControlWriter(guardedStore(db, 'dashboard', { enabled: true }), clock).write(
      {
        action: 'pause',
        reason: 'Telegram halt command',
        idempotency_key: `telegram-${update.update_id}`,
      },
      'telegram',
    );
    advance(60_000);
    expect(await handler.handle(update)).toMatch(/Already paused/);
    expect(controlRows()).toHaveLength(1);
  });
});
