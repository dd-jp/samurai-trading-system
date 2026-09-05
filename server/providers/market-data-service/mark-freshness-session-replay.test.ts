/**
 * #1111 AC7 — the 2026-09-04 paper session's own refusals, replayed.
 *
 * Every `(instrument, observed_at, forward_offset_ms)` triple below is lifted
 * verbatim from the `StaleMarkError` messages in that session's
 * `logs/orchestrator.log` (and the 2026-09-03 one before it): 67 distinct
 * refusals, 5020ms to 144576ms "ahead" of the tick's `asOf`. Not one carries a
 * POSITIVE age — the whole population is the artifact, none of it an aged
 * mark, which is why the count attributable to forward offset is the count
 * itself.
 *
 * The reconstruction makes one assumption and only one: the mark was in hand
 * when the refusal was built, so the instant it was RECEIVED is at or after
 * `observed_at`. `ARRIVAL_LAG_MS` stands in for the network leg the log does
 * not record. The result does not depend on its value — what matters is that
 * `readAt` lies on the far side of `observed_at`, where the offset the old
 * coordinate measured cannot exist at all.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyMarkFreshness,
  MARK_CLOCK_SKEW_TOLERANCE_MS,
  markAgeMs,
} from './mark-freshness.js';
import type { Mark } from './types.js';

/** `max_mark_age.stocks` (paper-profile.ts) — the bound these marks were judged against. */
const STOCKS_BOUND_MS = 15 * 60_000;

/** Unlogged: the leg between the venue's stamp and our receipt. */
const ARRIVAL_LAG_MS = 100;

const SESSION_REFUSALS: [instrument: string, observedAt: string, forwardOffsetMs: number][] = [
  ['COIN', '2026-09-04T19:57:00.053Z', 89625],
  ['COIN', '2026-09-04T19:57:00.053Z', 89718],
  ['COIN', '2026-09-04T19:57:06.187Z', 8372],
  ['COIN', '2026-09-04T19:57:22.045Z', 81825],
  ['GOOGL', '2026-09-04T19:56:39.707Z', 69279],
  ['GOOGL', '2026-09-04T19:56:39.707Z', 69372],
  ['GOOGL', '2026-09-04T19:57:02.837Z', 5022],
  ['GOOGL', '2026-09-04T19:57:20.001Z', 79781],
  ['GOOGL', '2026-09-04T19:57:36.221Z', 6006],
  ['MARA', '2026-09-03T19:58:15.256Z', 129560],
  ['MARA', '2026-09-03T19:58:15.256Z', 137124],
  ['MARA', '2026-09-03T19:58:19.024Z', 137852],
  ['MARA', '2026-09-03T19:58:19.024Z', 140864],
  ['MARA', '2026-09-03T19:58:24.287Z', 113183],
  ['MARA', '2026-09-04T19:57:07.101Z', 9286],
  ['MARA', '2026-09-04T19:57:08.341Z', 98006],
  ['MARA', '2026-09-04T19:57:10.050Z', 99622],
  ['MARA', '2026-09-04T19:57:22.950Z', 82730],
  ['META', '2026-09-03T19:57:03.026Z', 57330],
  ['META', '2026-09-03T19:57:03.026Z', 61854],
  ['META', '2026-09-03T19:57:03.026Z', 64894],
  ['META', '2026-09-03T19:58:20.697Z', 109593],
  ['META', '2026-09-03T19:58:20.697Z', 142537],
  ['META', '2026-09-03T19:58:20.697Z', 6087],
  ['META', '2026-09-04T13:32:13.627Z', 39058],
  ['META', '2026-09-04T13:32:13.627Z', 43156],
  ['META', '2026-09-04T14:02:27.940Z', 30974],
  ['META', '2026-09-04T14:02:27.940Z', 55815],
  ['META', '2026-09-04T14:02:30.645Z', 14462],
  ['META', '2026-09-04T14:02:30.645Z', 55977],
  ['META', '2026-09-04T19:56:13.616Z', 43188],
  ['META', '2026-09-04T19:56:13.616Z', 43281],
  ['META', '2026-09-04T19:57:02.835Z', 5020],
  ['META', '2026-09-04T19:57:19.479Z', 79259],
  ['MSTR', '2026-09-03T19:58:19.363Z', 138191],
  ['MSTR', '2026-09-03T19:58:21.606Z', 110502],
  ['MSTR', '2026-09-03T19:58:21.606Z', 143446],
  ['MSTR', '2026-09-03T19:58:21.606Z', 6996],
  ['MSTR', '2026-09-03T19:58:22.708Z', 137012],
  ['MSTR', '2026-09-03T19:58:22.708Z', 144576],
  ['MU', '2026-09-04T19:56:58.534Z', 88106],
  ['MU', '2026-09-04T19:56:58.534Z', 88199],
  ['MU', '2026-09-04T19:57:04.231Z', 6416],
  ['MU', '2026-09-04T19:57:19.530Z', 79310],
  ['PLTR', '2026-09-04T19:56:59.717Z', 89289],
  ['PLTR', '2026-09-04T19:56:59.717Z', 89382],
  ['PLTR', '2026-09-04T19:57:05.556Z', 7741],
  ['PLTR', '2026-09-04T19:57:22.125Z', 81905],
  ['QQQ', '2026-09-03T19:56:31.034Z', 25338],
  ['QQQ', '2026-09-03T19:56:31.034Z', 29862],
  ['QQQ', '2026-09-03T19:56:31.034Z', 32902],
  ['QQQ', '2026-09-03T19:58:21.490Z', 110386],
  ['QQQ', '2026-09-03T19:58:21.490Z', 143330],
  ['QQQ', '2026-09-03T19:58:21.490Z', 6880],
  ['RIOT', '2026-09-04T19:57:00.692Z', 90264],
  ['RIOT', '2026-09-04T19:57:00.692Z', 90357],
  ['RIOT', '2026-09-04T19:57:07.643Z', 9828],
  ['RIOT', '2026-09-04T19:57:23.686Z', 83466],
  ['RIOT', '2026-09-04T19:57:34.665Z', 5436],
  ['SMCI', '2026-09-04T19:56:59.013Z', 88585],
  ['SMCI', '2026-09-04T19:56:59.013Z', 88678],
  ['SMCI', '2026-09-04T19:57:05.201Z', 7386],
  ['SMCI', '2026-09-04T19:57:21.069Z', 80849],
  ['SOFI', '2026-09-04T19:57:00.124Z', 89696],
  ['SOFI', '2026-09-04T19:57:00.124Z', 89789],
  ['SOFI', '2026-09-04T19:57:07.666Z', 9851],
  ['SOFI', '2026-09-04T19:57:24.213Z', 83993],
];

function markObservedAt(iso: string): Mark {
  return { price: 100, observed_at: new Date(iso), source: 'alpaca', asset_class: 'stocks' };
}

describe('the 2026-09-04 session’s valuation refusals, replayed (#1111)', () => {
  it('every one of them was a forward offset past the old tolerance, not an aged mark', () => {
    // Non-vacuity for the case below: each row really did refuse under the
    // pre-#1111 coordinate, and refused for being AHEAD rather than for being
    // old.
    for (const [, observedAt, forwardOffsetMs] of SESSION_REFUSALS) {
      const asOf = new Date(new Date(observedAt).getTime() - forwardOffsetMs);
      expect(markAgeMs(markObservedAt(observedAt), asOf)).toBe(-forwardOffsetMs);
      expect(forwardOffsetMs).toBeGreaterThan(MARK_CLOCK_SKEW_TOLERANCE_MS);
    }
  });

  it('none of them refuses once freshness is judged at the read instant', () => {
    const stillRefused = SESSION_REFUSALS.filter(([, observedAt]) => {
      const readAt = new Date(new Date(observedAt).getTime() + ARRIVAL_LAG_MS);
      const freshness = classifyMarkFreshness(markObservedAt(observedAt), readAt, STOCKS_BOUND_MS);
      return freshness.status !== 'fresh';
    });

    expect(stillRefused).toEqual([]);
    expect(SESSION_REFUSALS).toHaveLength(67);
  });
});
