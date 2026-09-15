# ADR-0005: Money math stays IEEE-754 float64 through paper trading — bound measured, revisit gated on the soak

**Status:** Accepted (provisional — expires at the #238 soak review)
**Date:** 2026-08-04
**Owner:** David (Deepak)

## Context

Code review 2026-08-01 (M1) and the security review of the same day (duplicate issue [#296](../../issues/296)) both flagged that every monetary quantity in this system is a TypeScript `number`, i.e. IEEE-754 binary64. Nothing in any spec mandates otherwise — this is a domain risk, not a spec violation. The named call sites:

- `server/pipeline/execution/ingest-fills.ts` — `weightedAvgPrice()` (Σ price×qty ÷ Σ qty), `totalQty()`, and the `ClosedTrade` money fields (`gross`, `fees_total`, `realized_pnl_net`).
- `server/pipeline/risk-manager/portfolio-view.ts` — per-position notional (`filled_size × mark`), `gross_exposure`, `equity`, `drawdown_pct`.
- `server/pipeline/risk-manager/index.ts:168,243` — the sizing round trip `notional = size × entry` … `finalSize = notional ÷ entry`.
- `server/pipeline/feedback-loop/attribution.ts` — `realizedR()` = `realized_pnl_net ÷ (|entry − stop| × filled_size)`, which #288 correctly identifies as the amplifier: the denominator is a subtraction of two near-equal prices, so a tight stop multiplies any absolute price error by `entry ÷ |entry − stop|`.

Persistence is not a second precision layer: every money column in `server/shared/store/migrations/0001_init.sql` (`price`, `qty`, `fee`, `filled_size`, `avg_entry_price`, `entry`, `stop`, `realized_pnl_net`, `fees_total`, `r_multiple`) is SQLite `REAL`, which is float64 — an exact round trip, no digits lost at the store boundary.

#288 offers three options: (A) a decimal library at the accounting boundary only, (B) integer minor units in the store, (C) keep float64, document the bound, and pin it with an invariant test. It also notes the paper-trading soak ([#238](../../issues/238)) can quantify real drift before choosing.

## Decision

**Option C, provisionally: money math stays float64 through paper trading. Options A and B stay open, and the #238 soak is the gate that decides between them.**

No new dependency (`decimal.js`, `big.js`) is added, and no store migration to integer minor units happens now. The bound below is derived from the real code, then measured against it, and the measurement is pinned as an executable invariant in `server/pipeline/execution/money-math-precision.test.ts`.

### 1. The derived bound

`u` = float64 unit roundoff = 2^-53 ≈ **1.11e-16**.

**Per average price** (`weightedAvgPrice`, n fills): n products (u each), a naive summation of n terms (≤ n·u relative, worst case), and one division (u). Worst case relative error ≈ **(n+2)·u**. At n = 250 tranches — a deliberately extreme count; the realistic figure for an Alpaca paper lot is under 10 — that is 252 × 1.11e-16 ≈ **2.8e-14 relative**, i.e. **3.4e-9 USD** on a $119,873 BTC price. In practice errors partially cancel rather than accumulating linearly, so the realistic estimate is √n·u ≈ 1.8e-15 relative ≈ 2.1e-10 USD.

**Per closed trade** (`realized_pnl_net = (avgExit − avgEntry) × filledSize − Σ fee`): the subtraction is exact in the operands' own error terms, so the absolute error is ≈ `filledSize × (ε_exit + ε_entry)` plus a fee-summation term. On the 0.442 BTC / 250-tranches-per-leg workload: 0.442 × 2 × 3.4e-9 ≈ **3.0e-9 USD** worst case.

**Across a paper-trading horizon.** Error does **not** compound poll to poll: `advanceLot()` recomputes `filledSize` and `avgEntryPrice` from the persisted `Fill` rows on every poll rather than carrying a running total (`ingest-fills.ts`, "never from a running total"), and `computePortfolioView()` rebuilds exposure and equity from scratch each tick. The only accumulation is *within* one lot's fill count and *across* closed trades in downstream sums. ADR-0004's paper-trading gate is a sustained 14-day run; at a generous 20 closed trades/day that is 280 trades, so the horizon bound is 280 × 3.0e-9 ≈ **8.4e-7 USD** — a millionth of a dollar, or one ten-thousandth of a cent.

**R.** Relative error in R ≈ (n+2)·u × (1 + `entry ÷ |entry − stop|`). At a 0.1% stop the amplification factor is ~1000, giving **2.8e-11 relative** worst case (statistical estimate ~1.8e-12).

**Against broker rounding.** *Assumption, not a repo fact* — this codebase holds no venue precision table (the only rounding constant anywhere is `market-data-service/indicators.ts`'s 8-dp indicator rounding, which is not money): the coarsest realistic settlement increment is the US-equity cent, **1e-2 USD**; crypto venues quote finer, which only widens the margin. The horizon bound 8.4e-7 USD is **~12,000x** under a single cent, and a single trade's 3.0e-9 USD is **~3.3 million x** under it. The bound does not exceed broker rounding for any case examined, including the sub-cent one.

### 2. The measured bound

`server/pipeline/execution/money-math-precision.test.ts` drives the real `ExecutionImpl.ingestFills()` against the real SQLite store with 250 partial fills per leg, released 37 per poll across ~14 polls (so the recompute-from-persisted-rows convergence above is exercised, not bypassed by one all-at-once ingest), then compares the persisted `ClosedTrade` against an exact BigInt fixed-point oracle at scale 1e-24 (differences are taken in exact space and only then converted to `Number`, because `ulp(1e5)` ≈ 1.5e-11 would otherwise swallow the quantity being measured).

| Quantity | Magnitude | Measured drift |
| --- | --- | --- |
| `entry` (avg entry price), BTC lot | $119,873.41 | 5.1e-11 USD (4.3e-16 relative) |
| `fees_total`, 500 fills | $233.90 | 1.9e-12 USD |
| `realized_pnl_net`, BTC lot | $664.42 | 6.8e-11 USD |
| `filled_size`, BTC lot | 0.44233 BTC | 2.8e-16 |
| `entry`, sub-cent lot | $0.0000123398 | 6.0e-21 USD |
| `realized_pnl_net`, sub-cent lot | $557.74 | 1.2e-13 USD |
| `filled_size`, sub-cent lot | 778,750,311.5 units | 0 |
| `realizedR()` at a 0.1% stop | R = 12.53 | 7.0e-12 absolute, **5.6e-13 relative** |
| `equity` (BTC + sub-cent book) | $1,259,701.67 | 8.8e-11 USD |

Worst observed drift anywhere: **8.8e-11 USD**. The derived worst case sits 40–70x above it, and the statistical (√n) estimate lands within ~3x — the derivation and the measurement agree.

Thresholds the test asserts: `MAX_TOLERATED_DRIFT_USD = 1e-9` (≈11x the worst measurement, and itself asserted to be under `BROKER_ROUNDING_USD / 1e6`), `MAX_TOLERATED_R_RELATIVE_DRIFT = 1e-11` (≈18x), `MAX_TOLERATED_QTY_DRIFT_UNITS = 1e-6` (a quantity threshold is held separately because the sub-cent lot's size is ~7.8e8 units, where one ulp is already ~1.2e-7). The suite was mutation-checked: rounding `weightedAvgPrice` to **8** decimal places — a mutation far milder than rounding to the cent — turns three of the six tests red, one of them by $0.45 of real PnL error.

### 3. Universe caveat, stated plainly

ADR-0001's default universe is SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD, and ADR-0004 narrows the first paper run further. **There is no sub-cent instrument in the configured universe today** — #288's "SHIB → BTC, 7+ orders of magnitude" is a hypothetical about a future universe, not a present condition, and the live spread is roughly $100 (SPY-class) to $120k (BTC). The test covers the sub-cent leg anyway, because the issue names it as the risk and because adding such an instrument must not silently invalidate this ADR.

### 4. One real defect found and fixed

Reading the call sites surfaced a genuine float defect — not in a *reported number*, but in *control flow*, which is why the bound above never covered it.

`ingest-fills.ts` decided round-trip-to-flat with a bare `totalQty(exitFills) >= filledSize`. Both sides are float64 sums of decimal quantities, and two sums of the same true total differ unless the tranches share a summation order: entry tranches of `0.3 + 0.3 + 0.4` total exactly `1`, while exit tranches of `0.7 + 0.2 + 0.1` total `0.9999999999999999`. A fully-exited lot whose exit tranches were shaped differently from its entries therefore **never reads flat** — no `ClosedTrade` for the Feedback Loop, and a phantom position sitting in `getOpenPositions()` consuming Risk's exposure caps, permanently, since no further fill is coming. Confirmed by a failing test before the fix (BTC-plausible tranche sizes; no contrived values needed).

Fixed with rounding-at-boundary discipline and no dependency: `coversQty(actual, target)` compares with a relative epsilon of **1e-12**, applied both to the flat test and to `nextState`'s `filled` vs `partially_filled` comparison (same defect class, cosmetic consequence). The two margins are asymmetric and worth stating precisely rather than rounding to "orders of magnitude". **Above float noise: 88x** at n = 100 fills and **36x** at the 250-fills-per-leg worst case — both measured against the same `(n+2)·u` bound §1 derives (1.13e-14 and 2.80e-14 respectively), not a mix of conventions. Comfortable but finite: a leg past ~9,000 fills is where `(n+2)·u` reaches 1e-12 and the constant would need revisiting. **Below a real remainder: orders of magnitude** — a residue of 1e-12 of a lot is far below any venue's minimum quantity increment, so it does not exist at the broker either and a lot reading flat here is flat there. The one-sided guard is pinned by test (`leaves a lot open when the exit shortfall is above the tolerance`), so the tolerance cannot silently widen. That argument has to stand on its own, because `reconcile()` (#86) filters to `pending`/`submitted` lots (`IN_FLIGHT_ORDER_STATES`) and therefore never revisits a lot this code has marked terminal — it is not a backstop for closing one early.

### 5. Sites examined and left alone

- **`risk-manager/index.ts:168,243`** — `notional = size × entry` then `finalSize = notional ÷ entry` is a two-operation round trip bounded by ~2u ≈ 2.2e-16 relative, ~7 orders under any lot granularity. Examined, within bound, unchanged. No rounding helper added.
- **`portfolio-view.ts:75-83`** — recomputed from scratch every tick; measured equity drift 8.8e-11 USD on a $1.26M book.
- **`adapters/alpaca-adapter.ts:127-133`** — serializes size and prices to the wire with bare `String(...)`, so a float artefact reaches the venue as up to 17 significant digits (`String(0.1 + 0.2)` → `'0.30000000000000004'`). No arithmetic error, but it is the one place float representation becomes externally visible, and whether Alpaca rounds or rejects over-precise values is a venue fact this repo does not encode. Left unchanged deliberately (fixing it needs the venue's precision table, not a precision decision) and listed as a soak observable in §6.

## Revisit trigger

This ADR is provisional and is reviewed at the **#238 paper-trading soak** review (ADR-0004's 14-day sustained run). Any one of the following forces the decision to Option A (decimal library at the accounting boundary: `ingest-fills`, `portfolio-view`, `realizedR`) or Option B (integer minor units in the store):

1. **Observed money drift > 1e-4 USD** (one hundredth of a cent) on any instrument-day, comparing the store's `realized_pnl_net`/`equity` against the broker's own reported figures recomputed exactly. That is 1e6x the worst drift measured here — anything near it means the model in §1 is wrong, not merely conservative.
2. **Observed R drift > 1e-6 relative** on any closed trade, recomputed exactly from its `Fill` rows.
3. **Any float-driven control-flow anomaly** — a lot failing to close, an exposure cap tripping on a phantom quantity, or a broker rejecting an order for an over-precise size/price string (the §5 `String(...)` site).
4. **A sub-cent instrument entering the configured universe** — that changes §3 from hypothetical to live and requires re-running the bound against real fills, not synthetic ones.

Absent all four, Option C carries into live money with the same invariant test as its guard, and this ADR is re-marked Accepted (non-provisional) at that review.

## Consequences

- **Accepted:** monetary values are approximations, exact to ~1e-10 USD per trade rather than exact by construction. Comparisons of money for equality are unsafe anywhere in this codebase, and the `coversQty` epsilon in `server/shared/held-quantity.ts` (moved there from `ingest-fills.ts` 2026-09-10 so the Trader, Execution and the residual sweep share one tolerance) is the pattern for any future quantity comparison. Nothing here makes float64 *correct* — it makes it demonstrably below the noise floor of the thing being measured.
- **Bought:** no dependency, no store migration, no serialization boundary between decimal objects and SQLite `REAL`, and no risk of a half-migrated codebase where some paths are decimal and others are not — which is the realistic failure mode of adopting Option A under time pressure before the soak has produced any evidence.
- **`docs/specs/execution-spec.md`** gains the float-tolerant restatement of round-trip-to-flat (Module: Order State Machine & Partial Fills).
- **`server/pipeline/execution/money-math-precision.test.ts`** is the executable half of this ADR. If it is deleted or its thresholds loosened, this decision loses its justification — the numbers in §2 are only true while that test runs green.
- **#238's soak instrumentation** must record the four observables above; without them the revisit trigger cannot fire and this ADR silently becomes permanent by default.
- Closes [#288](../../issues/288) and its duplicate [#296](../../issues/296).

## Superseded documents

None — additive to [ADR-0001](0001-technical-foundation-hybrid.md) (technical foundation) and [ADR-0004](0004-production-composition-root.md) (which sets the 14-day paper-trading gate this ADR's revisit trigger hangs off).
