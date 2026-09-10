/**
 * The key's own unit tests (#686).
 *
 * `decide.test.ts` covers the collision end to end, through the Trader, which is
 * the test that would actually have caught the overnight carry. These cover the
 * grouping RULE directly, because that rule is a deliberate trade-off rather
 * than an obvious consequence and the end-to-end test cannot express it: it only
 * ever exercises `entry` against `exit`, so nothing there would notice if
 * `scale_in` were split off too.
 */
import {
  computeFlattenIdempotencyKey,
  computeIdempotencyKey,
  intentSideFor,
} from './idempotency-key.js';

const BAR = new Date('2026-08-14T19:00:00.000Z');
/** The US close on the same day — deliberately ON the 1h bar grid (#1389). */
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
    // The #686 collision, at the unit level: same instrument, same bar, and
    // before the discriminator these were one key — so the mandatory
    // flat-by-close exit was suppressed as a duplicate of the entry.
    expect(computeIdempotencyKey('3USL', BAR, 'open')).not.toBe(
      computeIdempotencyKey('3USL', BAR, 'close'),
    );
  });

  it('keeps entry and scale_in on ONE key within a bar', () => {
    // The property #616 and #617 were protecting, and the reason the
    // discriminator is open/close rather than the full `intent_type`.
    //
    // Within a bar the first tick can produce an `entry` and a later tick a
    // `scale_in`, because by then the position exists. Under a three-way key
    // those are two keys, so a crash-replay of that bar places BOTH orders
    // instead of deduping to one — doubling exposure in exactly the scenario
    // the key exists for.
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

  /**
   * The payload shape is a `cross-spec-contracts.md` §7 contract, so a change to
   * it is a spec amendment and a migration, not a refactor. Pinning one literal
   * digest makes an accidental change fail here — where the reason is written
   * down — rather than silently in production, where it would present as every
   * dedup layer going inert at once.
   */
  it('pins the hash so the payload cannot change silently', () => {
    // sha256 of {"instrument":"3USL","bar":"2026-08-14T19:00:00.000Z","side":"open"}
    expect(computeIdempotencyKey('3USL', BAR, 'open')).toBe(
      '1ba944cf4284db34501ab2ee8bdd9f34f93448e12b2ad1179375622a84e793b3',
    );
  });
});

describe('computeFlattenIdempotencyKey (#1389)', () => {
  it('is one key per instrument per SESSION CLOSE', () => {
    // The obligation is a close, not a bar — so every tick that enforces the
    // same close, on either side of the bell, produces one key.
    expect(computeFlattenIdempotencyKey('3USL', SESSION_CLOSE)).toBe(
      computeFlattenIdempotencyKey('3USL', new Date(SESSION_CLOSE)),
    );
  });

  it('separates instruments, arms and sessions', () => {
    const base = computeFlattenIdempotencyKey('3USL', SESSION_CLOSE);

    expect(computeFlattenIdempotencyKey('3LDE', SESSION_CLOSE)).not.toBe(base);
    expect(computeFlattenIdempotencyKey('3USL', SESSION_CLOSE, 'control')).not.toBe(base);
    // The NEXT session's close: a lot carried past the grace must be targetable
    // again tomorrow rather than deduped against today's refusal.
    expect(computeFlattenIdempotencyKey('3USL', new Date('2026-08-15T20:00:00.000Z'))).not.toBe(
      base,
    );
  });

  it('cannot collide with a bar-keyed key, even when the close IS a bar boundary', () => {
    // The US close (20:00Z) sits exactly on the 1h debate-bar grid, so a
    // payload that named the field `bar` would collide with a genuine
    // 20:00 bar's own `'close'`-side key — the direction-flip exit's, which
    // still uses the bar coordinate. The field name is what keeps the two key
    // spaces apart.
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

  /** Same contract as the pin above: the payload is a §7 shape, not a detail. */
  it('pins the hash so the payload cannot change silently', () => {
    // sha256 of
    // {"instrument":"3USL","session_close":"2026-08-14T20:00:00.000Z","side":"close"}
    expect(computeFlattenIdempotencyKey('3USL', SESSION_CLOSE)).toBe(
      'c0438358292d9765c944d717fbd68501000239b74d746b47c1fc4ac57acf3ea9',
    );
  });
});
