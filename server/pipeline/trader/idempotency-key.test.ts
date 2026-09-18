import {
  computeFlattenIdempotencyKey,
  computeIdempotencyKey,
  intentSideFor,
} from './idempotency-key.js';

const BAR = new Date('2026-08-14T19:00:00.000Z');
const SESSION_CLOSE = new Date('2026-08-14T20:00:00.000Z');

describe('intentSideFor', () => {
  it('groups the opening intents and separates the closing one', () => {
    expect(intentSideFor('entry')).toBe('open');
    expect(intentSideFor('scale_in')).toBe('open');
    expect(intentSideFor('exit')).toBe('close');
  });
});

describe('computeIdempotencyKey', () => {
  it('separates an opening intent from a closing one in the same bar', () => {
    expect(computeIdempotencyKey('3USL', BAR, 'open')).not.toBe(
      computeIdempotencyKey('3USL', BAR, 'close'),
    );
  });

  it('keeps entry and scale_in on ONE key within a bar', () => {
    expect(computeIdempotencyKey('3USL', BAR, intentSideFor('entry'))).toBe(
      computeIdempotencyKey('3USL', BAR, intentSideFor('scale_in')),
    );
  });

  it('is stable across calls — the whole point of the key', () => {
    expect(computeIdempotencyKey('3USL', BAR, 'open')).toBe(
      computeIdempotencyKey('3USL', new Date(BAR), 'open'),
    );
  });

  it('separates instruments and bars', () => {
    const base = computeIdempotencyKey('3USL', BAR, 'open');

    expect(computeIdempotencyKey('3LDE', BAR, 'open')).not.toBe(base);
    expect(computeIdempotencyKey('3USL', new Date('2026-08-14T20:00:00.000Z'), 'open')).not.toBe(
      base,
    );
  });

  it('pins the hash so the payload cannot change silently', () => {
    expect(computeIdempotencyKey('3USL', BAR, 'open')).toBe(
      '1ba944cf4284db34501ab2ee8bdd9f34f93448e12b2ad1179375622a84e793b3',
    );
  });
});

describe('computeFlattenIdempotencyKey (#1389)', () => {
  it('is one key per instrument per SESSION CLOSE', () => {
    expect(computeFlattenIdempotencyKey('3USL', SESSION_CLOSE)).toBe(
      computeFlattenIdempotencyKey('3USL', new Date(SESSION_CLOSE)),
    );
  });

  it('separates instruments, arms and sessions', () => {
    const base = computeFlattenIdempotencyKey('3USL', SESSION_CLOSE);

    expect(computeFlattenIdempotencyKey('3LDE', SESSION_CLOSE)).not.toBe(base);
    expect(computeFlattenIdempotencyKey('3USL', SESSION_CLOSE, 'control')).not.toBe(base);
    expect(computeFlattenIdempotencyKey('3USL', new Date('2026-08-15T20:00:00.000Z'))).not.toBe(
      base,
    );
  });

  it('cannot collide with a bar-keyed key, even when the close IS a bar boundary', () => {
    expect(computeFlattenIdempotencyKey('3USL', SESSION_CLOSE)).not.toBe(
      computeIdempotencyKey('3USL', SESSION_CLOSE, 'close'),
    );
    expect(computeFlattenIdempotencyKey('3USL', SESSION_CLOSE)).not.toBe(
      computeIdempotencyKey('3USL', SESSION_CLOSE, 'early_close'),
    );
  });

  it('omits the arm for the live arm, exactly as the bar-keyed payload does', () => {
    expect(computeFlattenIdempotencyKey('3USL', SESSION_CLOSE, 'live')).toBe(
      computeFlattenIdempotencyKey('3USL', SESSION_CLOSE),
    );
  });

  it('pins the hash so the payload cannot change silently', () => {
    expect(computeFlattenIdempotencyKey('3USL', SESSION_CLOSE)).toBe(
      'c0438358292d9765c944d717fbd68501000239b74d746b47c1fc4ac57acf3ea9',
    );
  });
});
