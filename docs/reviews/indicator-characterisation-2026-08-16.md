# Indicator characterisation — what `computeIndicator` actually computes

**Date:** 2026-08-16
**Scope:** `server/providers/market-data-service/indicators.ts` and the three live `IndicatorSpec`s
that consume it. Step **B1** of the intraday build sequence, under wayfinder map
[#703](https://github.com/dd-jp/samurai-trading-system/issues/703).
**Status:** OPEN — F1 and F2 are pinned by tests and are not yet acted on; F2 is owned by step B2.

## Why this review happened before anything else was built

The intraday product must clear an accuracy edge of **at least 4.33 pp**
([ADR-0018 §D3](../adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md)). Everything that
produces that edge runs through two numbers: the technical analyst's RSI, which is the entire
market read the debate ever sees (`debate-engine/personas.ts:128`), and ATR, which prices every
stop the Trader places. Step B1 exists because **nothing verified either number**.

Every numeric assertion in `indicator.test.ts` was `Number.isFinite`, a relative comparison, or —
at `technical-analyst.test.ts:172-192` — a value recomputed by calling `computeIndicator` itself.
That is a suite comparing the implementation against itself.

**This was measured, not asserted.** Mutating `ema`'s seed to the EWM-from-first-value convention
that most JavaScript TA libraries use passes **all 32** pre-existing indicator and technical-analyst
tests. Mutating `atr`'s Wilder recursion to an off-by-one passes the entire Trader suite —
**138 tests across 7 files, all green** — while every stop distance in the system moves.

> The commit message for this change (`703fd04`) puts that second number at 219. That was the
> combined indicator + technical-analyst + Trader count from a single `vitest` invocation, and it is
> misleading as phrased: a reader takes 219 for the Trader suite's own size. Re-run isolated, the
> Trader suite is 138. The finding is unchanged — the mutation is invisible to every one of them —
> and the message is not rewritten because it is already pushed. This paragraph is the correction.

## Method

An independent reference in `__fixtures__/generate-indicator-golden.py`, stdlib-only per the
`docs/research/*.py` convention, written from Wilder's published definitions.

The plan named `pandas-ta`. Neither `pandas` nor `pandas_ta` is installed and adding a numeric
stack to bless fourteen lines of arithmetic is the wrong trade, so the reference is hand-written.
The independence that substitution costs is bought back **structurally**: the reference computes a
full series by explicit per-bar recurrence and takes the last element, where `indicators.ts` seeds
over `slice(0, period)` and folds `slice(period)` to a scalar. The two shapes are not
transcriptions of one another, so agreement is evidence.

Fixture: 400 bars with varying volume (the fixture it replaces pinned `volume: 1` on every bar),
including strictly-rising, strictly-falling, dead-flat-doji and gapping segments — the degenerate
cases a random walk never produces and where seeding conventions bite.

## Findings

### F1 — The live "RSI(14)" is not Wilder's RSI. It is the seed. *(open)*

`RSI_SPEC` carries `lookback: 15` with `params.period: 14`, which is exactly `minimumBarsFor`. At
that width `changes.slice(period)` is empty, so **`rsi`'s smoothing loop executes zero times in
production**. The value the debate reads is the simple-mean seed — Cutler's RSI — not the Wilder
RSI the surrounding doc comments describe. The same holds for `atrIndicatorSpec(14)` and
`DEFAULT_VOLATILITY_INDICATOR`, both `lookback: 15`.

For ATR this was **already known and already pinned**: `trader/atr-equivalence.test.ts` says so in
as many words, and this review does not re-file it. For RSI nothing said so anywhere.

This is not a defect in `indicators.ts` — the arithmetic is correct for the window it is given, and
agrees with the independent reference on all 32 golden cases. It is a **warm-up** choice that lives
in the spec.

### F2 — The missing warm-up flips the analyst's classification on ~18% of bars. *(open, owned by B2)*

Measured over the fixture's ordinary random-walk region (the synthetic segments excluded, since
they would inflate every number), comparing RSI(14) at the live `lookback: 15` against RSI(14) at a
converged 200-bar warm-up on the same bar:

| Quantity | Value |
|---|---|
| Median shift | **4.6 RSI points** |
| p90 shift | **12.0 RSI points** |
| Bars where the 70/30 overbought/oversold classification flips | **18%** (25 of 141) |
| Maximum swing in `confidenceFrom` | **> 4x** |

`directionFrom` gates on 70/30 and `confidenceFrom` is `|rsi − 50| / 50`, so this is not an
abstraction: nearly one bar in five, the analyst's `direction` and the weight the debate gives it
both depend on a history length nobody chose. Step B2's `recommendedWarmupFor` (`4 × period + 1`)
is where this gets a deliberate answer.

Deliberately **not** fixed here. Widening the warm-up reprices every technical opinion in the
system, and a characterisation step establishes the baseline and changes nothing.

### F3 — A dead-flat window reads as maximum-confidence overbought. *(open, low frequency)*

`avgLoss === 0` returns 100 without checking whether `avgGain` is also 0. On a strictly rising
window that is the standard answer; on a halted or auction-flat instrument the analyst reports
`confidence: 0.95` on a tape that did not move. `direction` is safely `neutral` (last close equals
the SMA exactly), so this inflates certainty rather than inventing a side. Pinned, not changed.

### F4 — `atr`'s seed divisor asymmetry is unreachable, not a bug. *(closed by inspection)*

`atr` divides its seed by `seedRanges.length` where `rsi` divides by `period`. Because
`computeIndicator` throws below `period + 1` bars, `trueRanges.length >= period` always and
`seedRanges.length === period` always, so the two agree. The `0/0 → NaN` case is unreachable for
the same reason. Recorded so the guard is understood to be load-bearing: remove it and the two
kinds diverge silently.

## F5 — The A3 entry window switched flat-by-close off. *(closed in this branch)*

Not an indicator finding, and recorded here because this is the branch's live review file and the
claim it corrects is in a pushed commit message.

`bad50af` (#706) added `stocksTradingWindow` and described it as an entry narrowing, ending with
**"Exits are unaffected: the bracket is evaluated every tick."** That is true of the *price* bracket
and false of the *time* flatten, and the second half is the one that matters.

The predicate gates `TickPlan.instruments`, and `runOnce` runs the entire pipeline pass only for the
instruments in the plan — so an excluded instrument gets no Trader. `withinFlattenWindow`
(`trader/decide.ts:176`) is evaluated on a tick and nowhere else: there is no session-end job, and
`ingestFills()` runs on its own cadence. A window closing at 15:45 therefore deleted every tick that
could ever land in `[sessionEnd − flatten_before_close_ms, sessionEnd)`.

On the paper venue the entry window is 09:30–10:45 ET and `UsEquityRegularHoursCalendar` closes at
16:00 ET, so the last tick of the day fell **5h10m** before the flatten needed one. Every equity
position would have carried overnight against ADR-0014, with `trader_log` reading exactly like a
session with nothing to flatten — the same signature #691 found on a non-positive window.

Fixed by `production/stocks-tick-window.ts`: the composition root composes the tick window as the
entry window **∪** the flatten tail. The union cannot open a position — the entry path consults the
same window and returns `skip('session_closing')` at `decide.ts:361`, verified at the call site — and
the gap between the two spans needs no tick, because equity brackets rest at the venue as
`order_class: 'bracket'`, marks are fetched per call rather than accumulated per tick, and fills
ingest independently.

Verified by removing the fix: `ticks equities at 16:26, inside the flatten window` fails
`expected false to be true`. The four assertions the original change shipped with — 09:00 no,
14:35 yes, 15:45 no, `sessionEnd` still 16:30 — all pass with the flatten unreachable, which is why
none of them caught it.

## Prior reports not re-litigated

- `triage-2026-08-06.md` and the two 2026-08-05 audits — no indicator finding among them.
- `atr-equivalence.test.ts` (#304) already owns the ATR half of F1; this review extends it to RSI
  rather than restating it.

## What changed in this pass

Tests and a fixture only. No production arithmetic was touched. `RSI_SPEC` and `SMA_SPEC` gained an
`export` so the goldens can pin the real spec rather than a hand-rebuilt copy — the same reason
`atrIndicatorSpec` is exported (#304).
