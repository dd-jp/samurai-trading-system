import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { V2_STORE_PATH } from './index.js';
import { applyCapitalCommand, CAPITAL_USAGE, main, parseCapitalArgs } from './set-capital.js';

const clock = new SimulatedClock(new Date('2026-09-25T12:00:00.000Z'));

describe('parseCapitalArgs', () => {
  it('parses set, tighten and show with the paper store as the default', () => {
    expect(parseCapitalArgs(['set', '--year', '2026', '--start', '2000', '--cap', '1500'])).toEqual(
      {
        command: { kind: 'set', year: 2026, startGbp: 2_000, capGbp: 1_500 },
        storePath: V2_STORE_PATH,
      },
    );
    expect(
      parseCapitalArgs(['tighten', '--from', '2026-10-01', '--cap', '900', '--store', 'x.sqlite']),
    ).toEqual({
      command: { kind: 'tighten', from: '2026-10-01', capGbp: 900 },
      storePath: 'x.sqlite',
    });
    expect(parseCapitalArgs(['show', '--date', '2026-09-25']).command).toEqual({
      kind: 'show',
      date: '2026-09-25',
    });
  });

  it('refuses unknown commands, missing flags and dangling values', () => {
    expect(() => parseCapitalArgs([])).toThrow(CAPITAL_USAGE);
    expect(() => parseCapitalArgs(['loosen', '--cap', '9'])).toThrow(CAPITAL_USAGE);
    expect(() => parseCapitalArgs(['set', '--year', '2026', '--cap', '1500'])).toThrow(
      /--start is required/,
    );
    expect(() => parseCapitalArgs(['set', '--year'])).toThrow(CAPITAL_USAGE);
    expect(() => parseCapitalArgs(['set', 'year', '2026'])).toThrow(CAPITAL_USAGE);
  });
});

describe('applyCapitalCommand', () => {
  it('sets, tightens and shows through the v2 write guard and refuses a loosening', () => {
    const db = openSharedStore(':memory:');
    expect(
      applyCapitalCommand({ kind: 'set', year: 2026, startGbp: 2_000, capGbp: 1_500 }, db, clock),
    ).toMatchObject({ effectiveFrom: '2026-01-01' });
    expect(() =>
      applyCapitalCommand({ kind: 'tighten', from: '2026-10-01', capGbp: 1_600 }, db, clock),
    ).toThrow(/loosening mid-year is refused/);
    applyCapitalCommand({ kind: 'tighten', from: '2026-10-01', capGbp: 1_000 }, db, clock);
    expect(applyCapitalCommand({ kind: 'show', date: '2026-10-02' }, db, clock)).toMatchObject({
      startCapitalGbp: 2_000,
      lossCapGbp: 1_000,
    });
    expect(applyCapitalCommand({ kind: 'show', date: '2027-01-04' }, db, clock)).toBeUndefined();
    expect(
      db.prepare('SELECT trading_date, scope, parameter, message FROM v2_refusals').all(),
    ).toEqual([
      {
        trading_date: '2026-09-25',
        scope: 'capital',
        parameter: 'CAPITAL_CONFIG:tighten',
        message: expect.stringMatching(/loosening mid-year is refused/),
      },
    ]);
    db.close();
  });
});

describe('main', () => {
  it('writes the row to the named store and exits non-zero when nothing is in force', () => {
    const directory = mkdtempSync(join(tmpdir(), 'v2-capital-'));
    const store = join(directory, 'paper.sqlite');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(
        main(['set', '--year', '2026', '--start', '2000', '--cap', '1500', '--store', store]),
      ).toBe(0);
      expect(main(['show', '--date', '2025-06-01', '--store', store])).toBe(1);
      expect(stdout.mock.calls.map((call) => String(call[0]))).toEqual([
        '{"year":2026,"effectiveFrom":"2026-01-01","startCapitalGbp":2000,"lossCapGbp":1500}\n',
        'null\n',
      ]);
    } finally {
      stdout.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
