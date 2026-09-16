/**
 * The flatten split — the pure arithmetic at the heart of
 * `redistributeOneFlatten` (ingest-fills.ts): one flatten's raw venue fill(s)
 * allocated FIFO across the lots the flatten named, each lot capped at the
 * share journalled for it at write-ahead time (#571).
 *
 * No store, no broker, no clock. The caller reads the attribution row and the
 * per-lot shares, hands them in, and does the I/O around the result: pushing
 * `splits` into its per-lot buckets, warning once per over-filled raw fill
 * (`outcomes[].leftover`, #527) and writing the #549 marker for every lot
 * whose share was not consumed (`remaining`). Kept pure so the money-path
 * arithmetic is testable with a handful of literals rather than a SQLite
 * store and a scripted broker.
 */

import type { BrokerFillId } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import { chargeTopUpTo, prorateCostBreakdown } from './fill-cost.js';
import type { FlattenAttribution, NormalizedFill } from './types.js';

export interface FlattenSplitInput {
  /** The flatten's own `flatten_submissions.idempotency_key` — the bucket the raw fills arrived under */
  clientOrderId: string;
  /** The raw venue fill(s) for this flatten, in the feed's own order */
  rawFills: readonly NormalizedFill[];
  /** The lots the flatten named, in the FIFO order the write-ahead recorded */
  lotKeys: readonly string[];
  /** Each named lot's FIXED total share of this flatten — see `redistributeOneFlatten`'s doc on why only a journalled number works */
  totalShare: ReadonlyMap<string, number>;
  attribution: Pick<FlattenAttribution, 'exit_reason' | 'modelled_cost_breakdown' | 'size'>;
}

/** What one raw fill became — the dedup ids it attributed and the quantity it could not place */
interface RawFillOutcome {
  rawFill: NormalizedFill;
  attributed: readonly { idempotency_key: string; broker_fill_id: BrokerFillId }[];
  /** `> 0` means the venue filled more than the named lots held when the flatten was submitted */
  leftover: number;
}

export interface FlattenSplit {
  /** Per-lot exit fills, re-keyed to the lot, in allocation order */
  splits: ReadonlyMap<string, readonly NormalizedFill[]>;
  outcomes: readonly RawFillOutcome[];
  /** Each named lot's share still unconsumed after every raw fill — a positive value is a residual the caller must mark (#549) */
  remaining: ReadonlyMap<string, number>;
}

export function splitFlattenFills(input: FlattenSplitInput): FlattenSplit {
  const { clientOrderId, rawFills, lotKeys, totalShare, attribution } = input;
  const splits = new Map<string, NormalizedFill[]>();
  const outcomes: RawFillOutcome[] = [];
  // Processed in the feed's own order, decrementing an IN-MEMORY copy of
  // `totalShare` across `rawFills` — a flatten is modelled/observed as one
  // fill in practice (an IOC market order does not rest, so there is
  // normally exactly one raw fill per flatten to allocate), but this stays
  // general instead of assuming that: if the feed ever legitimately offers
  // more than one raw fill for the same flatten in one poll, an EARLIER
  // one in this SAME pass must still count against a lot's fixed share
  // before a LATER one is allocated, or the two would double-book it
  const remaining = new Map(totalShare);
  for (const rawFill of rawFills) {
    let leftover = rawFill.qty;
    // #527: every id this rawFill actually attributes THIS pass — the
    // dedup key for the warning below. `broker_fill_id` is deterministic
    // per (rawFill, lotKey) (see the comment on `splitFill` below), so if any
    // of these already exist in `fills`, this exact rawFill's split already
    // ran to completion in an earlier poll and its leftover was warned about
    // then — a re-offered fill (`SharedStore.hasFill`'s dedup contract)
    // must not re-fire the same warning forever
    const attributedIdsThisRawFill: { idempotency_key: string; broker_fill_id: BrokerFillId }[] =
      [];
    for (const lotKey of lotKeys) {
      if (leftover <= 0) break;
      const need = remaining.get(lotKey) ?? 0;
      if (need <= 0) continue;

      const take = Math.min(need, leftover);
      const share = take / rawFill.qty;
      // #1121: computed ahead of the object literal below because it feeds
      // BOTH `fee` (the charge) and `cost_breakdown` (the record of it) —
      // see `toFill`'s doc for why the modelled commission is charged rather
      // than left as an unspent estimate
      const flattenCostBreakdown =
        rawFill.cost_breakdown === undefined &&
        attribution.modelled_cost_breakdown !== null &&
        attribution.size > 0
          ? prorateCostBreakdown(attribution.modelled_cost_breakdown, take / attribution.size)
          : undefined;
      const splitFill: NormalizedFill = {
        ...rawFill,
        // Forced regardless of what the adapter tagged the raw fill — see
        // `redistributeFlattenFills`'s docstring (ingest-fills.ts). This is the fill-MECHANICS
        // leg ("a market order that closed the position"), not the reason it
        // was submitted — `fills.leg` keeps its four-value CHECK unchanged
        leg: 'exit',
        // #793: the REASON leg — WHY this flatten was submitted, journalled
        // on write-ahead (`FlattenSubmissionWriteAhead.exit_reason`,
        // migration 0031) and read back here so `closedTrade()` can name a
        // flatten and an early release differently in `close_reason` instead
        // of collapsing both into `leg`'s generic `'exit'`. Omitted (not set
        // to `undefined` — `exactOptionalPropertyTypes`) only for a flatten
        // row written before 0031 (legacy, reason never recorded); every
        // flatten submitted from here forward always carries one
        // (`executeExit` refuses to write ahead without it)
        ...(attribution.exit_reason === null ? {} : { exit_reason: attribution.exit_reason }),
        // #1001: the flatten's OWN key — `clientOrderId` is the
        // `flatten_submissions.idempotency_key` the caller looked this
        // attribution up by, i.e. the one that produced this raw fill,
        // before the split below re-keys the row to the LOT. Carried
        // through so the persisted row can be joined back to the specific
        // flatten submission that priced it — see `Fill.flatten_idempotency_key`
        flatten_idempotency_key: clientOrderId,
        // `fills`' row identity is `(idempotency_key, broker_fill_id)` — the
        // table's PK — so the SAME venue fill id can legitimately hold ONE
        // ROW PER LOT it is split across. That is the right scope here: a
        // multi-lot flatten's raw fill deliberately becomes several
        // accounting rows, one per named lot, so uniqueness has to be judged
        // per (lot, id) pair, not by id alone across every lot — a blanket
        // "this broker_fill_id exists somewhere, so skip it" rule would read
        // lot B's rightful share as a duplicate of lot A's the moment lot
        // A's is persisted
        //
        // `hasFill` itself now takes `idempotency_key` and scopes on the
        // full PK (#1320), so this suffix is no longer the ONLY thing
        // keeping one lot's split from shadowing another's dedup — but the
        // id shape stays as-is anyway: changing it would re-key rows this
        // system has already persisted under the suffixed form. Stable
        // across polls for the reason `totalShare` above is: the SAME
        // (id, qty) pair recomputes every time, so a repeat poll dedupes
        // cleanly instead of colliding with a differently-sized earlier
        // attempt
        broker_fill_id: toBrokerFillId(`${rawFill.broker_fill_id}:${lotKey}`),
        qty: take,
        // #1121: the venue-reported share (`rawFill.fee * share`) TOPPED UP
        // to the modelled commission share, when the flatten carries one —
        // the same per-fill "top up, never stack" rule `toFill` applies to an
        // entry fill, and for the same reason: Saxo reports a fee computed
        // from the SAME constant this fallback's estimate came from, so adding
        // rather than topping up would charge that flatten twice over
        //
        // Per fill, not per lot (#1121). A flatten the venue splits into
        // several raw fills applies `max` to each slice, and `Σ max ≥ max(Σ,
        // Σ)`, so the lot's total lands in `[max(Σvenue, Σmodelled), Σvenue +
        // Σmodelled]` rather than on the modelled figure exactly — see
        // `chargeTopUpTo`'s doc for the bound and why the overshoot is bps of
        // bps here. It is bounded on both
        // sides because the two per-slice inputs each sum to the lot's own
        // share: `share` is `take / rawFill.qty` (sums to 1 per raw fill) and
        // `flattenCostBreakdown` is prorated by `take / attribution.size`
        // (sums to the lot's fraction of the submission), so neither side is
        // re-counted across slices
        fee: chargeTopUpTo(rawFill.fee * share, flattenCostBreakdown?.commission),
        // #1001: FALLBACK only — `rawFill.cost_breakdown` is already set (and
        // left untouched by this spread) on the Simulated adapter's own
        // flatten fill, which is priced by `CostModel.fill` directly and
        // needs no modelled estimate substituted for it. On a real-broker
        // fill (`rawFill.cost_breakdown === undefined`, always, on that
        // path), this attaches the flatten's OWN submit-time modelled cost
        // breakdown instead — the venue reports no breakdown of its own
        //
        // #1014: prorated against the SUBMISSION's `size`,
        // NOT against `share`. The two denominators differ and the difference
        // is a double-count. `share` is `take / rawFill.qty` — this lot's
        // slice of THIS RAW FILL, which sums to 1.0 per raw fill, and that is
        // exactly right for the venue-reported input to `fee` above (a
        // per-raw-fill actual the venue reported) and wrong here:
        // `modelled_cost_breakdown` was priced ONCE against the whole
        // submitted `size` (`captureSubmitSnapshot` passes `order.size`). A
        // flatten the venue splits into two partial raw fills would then
        // distribute the entire snapshot across the first one's shares and
        // the entire snapshot AGAIN across the second's, so the summed
        // modelled cost over the flatten's fills would come to twice the
        // single estimate it is supposed to reconstruct — and, since #1121,
        // twice the amount actually charged
        //
        // `take / attribution.size` makes every slice a fraction of the one
        // submission instead, so the shares sum to 1.0 across the flatten
        // however many raw fills it arrives in — and to LESS than 1.0 if the
        // venue under-fills, which is the honest reading: the unfilled
        // remainder was never traded and cost nothing
        //
        // `attribution.size > 0` is guarded rather than assumed: `executeExit`
        // never writes a zero-size flatten (it refuses when the held quantity
        // is not positive), so this is a corrupted-row guard, and dividing by
        // it would silently write `Infinity`/`NaN` money onto a fill row
        ...(flattenCostBreakdown !== undefined ? { cost_breakdown: flattenCostBreakdown } : {}),
        // #842: CLEARED, not inherited from `...rawFill`. `take` is this
        // lot's ALLOCATION of the raw fill, not the venue's cumulative
        // quantity for the order, and the id it is written under is
        // lot-scoped rather than the bare order id — so neither half of
        // `qty_is_cumulative`'s contract holds any more, and leaving it set
        // would invite `advanceLot`'s top-up to take a difference against a
        // number that was never a cumulative total
        qty_is_cumulative: false,
      };

      const bucket = splits.get(lotKey);
      if (bucket === undefined) splits.set(lotKey, [splitFill]);
      else bucket.push(splitFill);

      attributedIdsThisRawFill.push({
        idempotency_key: lotKey,
        broker_fill_id: splitFill.broker_fill_id,
      });
      remaining.set(lotKey, need - take);
      leftover -= take;
    }
    outcomes.push({ rawFill, attributed: attributedIdsThisRawFill, leftover });
  }

  return { splits, outcomes, remaining };
}
