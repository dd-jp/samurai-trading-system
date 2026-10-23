import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import type { BarsSource } from './data/index.js';
import { formatOutcomeRebuild } from './decision-outcomes.js';
import { main, settleOutcomes } from './decision-outcomes-cli.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function emptyStoreFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'decision-outcomes-'));
  dirs.push(dir);
  const path = join(dir, 'store.sqlite');
  const db = migratedMemoryStore();
  writeFileSync(path, db.serialize());
  db.close();
  return path;
}

const NO_BARS: BarsSource = { load: () => undefined };

describe('formatOutcomeRebuild', () => {
  it('prints the settled count, then each pending and unmatched close', () => {
    expect(
      formatOutcomeRebuild({
        written: 1,
        settled: 3,
        pending: [
          {
            bookId: 'debate/primary',
            instrument: 'AAA',
            exitOrderId: 'x-1',
            reason: 'position_open',
          },
        ],
        unmatched: ['debate/primary|x-2'],
      }),
    ).toBe(
      [
        'settled 3 closed trades (1 new)',
        'pending debate/primary AAA x-1: position_open',
        'unmatched debate/primary|x-2: no entry decision in the journal',
      ].join('\n'),
    );
  });
});

describe('settleOutcomes', () => {
  it('rebuilds the ledger on the store it is given with the bars it loads', async () => {
    const roots: string[] = [];
    const text = await settleOutcomes(emptyStoreFile(), 'bars-root', (root) => {
      roots.push(root);
      return Promise.resolve(NO_BARS);
    });
    expect(text).toBe('settled 0 closed trades (0 new)');
    expect(roots).toEqual(['bars-root']);
  });
});

describe('main', () => {
  it('passes the store and bar root through, defaulting both', async () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const settle = (store: string, bars: string) => {
      calls.push([store, bars]);
      return Promise.resolve('ok');
    };
    expect(await main(['s.sqlite', 'bars'], (line) => lines.push(line), settle)).toBe(0);
    expect(await main([], (line) => lines.push(line), settle)).toBe(0);
    expect(calls[0]).toEqual(['s.sqlite', 'bars']);
    expect(calls[1]?.[0]).toMatch(/samurai-v2-paper\.sqlite$/);
    expect(lines).toEqual(['ok', 'ok']);
  });

  it('exits 1 with the error when the rebuild fails', async () => {
    const lines: string[] = [];
    const code = await main(
      [],
      (line) => lines.push(line),
      () => Promise.reject(new Error('boom')),
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('boom');
  });
});
