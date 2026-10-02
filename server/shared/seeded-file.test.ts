import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSeededFile, seedFromSnapshot, snapshotPathFor } from './seeded-file.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'seeded-file-'));
  dirs.push(dir);
  return dir;
}

describe('snapshotPathFor', () => {
  it('puts .snapshot before the extension', () => {
    expect(snapshotPathFor('data/bars/fx/gbpusd-boe-xudluss.csv')).toBe(
      'data/bars/fx/gbpusd-boe-xudluss.snapshot.csv',
    );
    expect(snapshotPathFor('a.b/file')).toBe('a.b/file.snapshot');
  });
});

describe('seedFromSnapshot', () => {
  it('copies the snapshot only when the live file is absent and never overwrites it', () => {
    const dir = scratch();
    const live = join(dir, 'fx.csv');
    writeFileSync(join(dir, 'fx.snapshot.csv'), 'snapshot\n');
    expect(seedFromSnapshot(live)).toBe(true);
    expect(readFileSync(live, 'utf8')).toBe('snapshot\n');
    writeFileSync(live, 'live\n');
    expect(seedFromSnapshot(live)).toBe(false);
    expect(readFileSync(live, 'utf8')).toBe('live\n');
  });

  it('leaves the live file absent when there is no snapshot either', () => {
    const live = join(scratch(), 'fx.csv');
    expect(seedFromSnapshot(live)).toBe(false);
    expect(existsSync(live)).toBe(false);
  });

  it('throws on any other copy failure', () => {
    const dir = scratch();
    const snapshot = join(dir, 'fx.snapshot.csv');
    writeFileSync(snapshot, 'snapshot\n');
    expect(() => seedFromSnapshot(join(snapshot, 'live.csv'), snapshot)).toThrow(/ENOTDIR/);
  });
});

describe('readSeededFile', () => {
  it('restores a deleted live file from its snapshot before reading it', () => {
    const dir = scratch();
    const live = join(dir, 'fx.csv');
    writeFileSync(join(dir, 'fx.snapshot.csv'), 'snapshot\n');
    expect(readSeededFile(live)).toBe('snapshot\n');
    expect(existsSync(live)).toBe(true);
  });

  it('reads a present live file as it is and refuses a missing one with no snapshot', () => {
    const dir = scratch();
    const live = join(dir, 'fx.csv');
    writeFileSync(join(dir, 'fx.snapshot.csv'), 'snapshot\n');
    writeFileSync(live, 'live\n');
    expect(readSeededFile(live)).toBe('live\n');
    expect(() => readSeededFile(join(dir, 'other.csv'))).toThrow(/ENOENT/);
  });
});
