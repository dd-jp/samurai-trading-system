# Indicator characterisation — what `computeIndicator` actually computes

**Date:** 2026-08-16
**Scope:** `server/providers/market-data-service/indicators.ts` and the three live `IndicatorSpec`s
that consume it. Step **B1** of the intraday build sequence, under wayfinder map
[#703](https://github.com/dd-jp/samurai-trading-system/issues/703).
**Status:** OPEN — **F2 is CLOSED** ([#722](https://github.com/dd-jp/samurai-trading-system/issues/722), 2026-08-17): `RSI_SPEC` now asks for the converged warm-up, and the after-figures are recorded beside the before-figures in F2 below. F1 remains open for the two ATR specs, which still sit on the floor. F3 is tracked as [#725](https://github.com/dd-jp/samurai-trading-system/issues/725) and is untouched here. *(Issue filed 2026-08-16: "owned by step B2" pointed at no ticket, which made a measured defect in a live signal a silent deferral rather than a tracked one.)*

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

### F1 — The live "RSI(14)" was not Wilder's RSI. It was the seed. *(open for ATR; RSI fixed by #722)*

`RSI_SPEC` carried `lookback: 15` with `params.period: 14`, which is exactly `minimumBarsFor`. At
that width `changes.slice(period)` is empty, so **`rsi`'s smoothing loop executed zero times in
production**. The value the debate read was the simple-mean seed — Cutler's RSI — not the Wilder
RSI the surrounding doc comments describe. `RSI_SPEC` now asks for 57 bars (see F2's resolution),
so the RSI half of this is closed. The same still holds for `atrIndicatorSpec(14)` and
`DEFAULT_VOLATILITY_INDICATOR`, both `lookback: 15`, and that half stays open.

For ATR this was **already known and already pinned**: `trader/atr-equivalence.test.ts` says so in
as many words, and this review does not re-file it. For RSI nothing said so anywhere.

This is not a defect in `indicators.ts` — the arithmetic is correct for the window it is given, and
agrees with the independent reference on all 32 golden cases. It is a **warm-up** choice that lives
in the spec.

### F2 — The missing warm-up flipped the analyst's classification on ~18% of bars. *(CLOSED by #722)*

Measured over the fixture's ordinary random-walk region (the synthetic segments excluded, since
they would inflate every number), comparing RSI(14) against RSI(14) at a converged 200-bar warm-up
on the same bar. The **floor** column is the original measurement, at the `lookback: 15` the live
spec carried when this review was written; the **converged** column is the same measurement re-run
after #722 re-pointed `RSI_SPEC` at `recommendedWarmupFor` (`4 x period + 1` = 57 bars). Both are
produced by `rsi-warmup.test.ts`, which now pins both halves rather than retargeting the first.

| Quantity | Floor (`lookback: 15`) | Converged (`lookback: 57`) |
|---|---|---|
| Median shift | **4.60 RSI points** | **0.23 RSI points** |
| p90 shift | **11.97 RSI points** | **0.55 RSI points** |
| Worst bar in the region | 17.66 RSI points | 0.94 RSI points |
| Bars where the 70/30 overbought/oversold classification flips | **17.7%** (25 of 141) | **0.7%** (1 of 141) |
| Maximum swing in `confidenceFrom` | **4.52x** | **1.17x** |
| Mean `confidenceFrom` over the region | 0.240 | 0.197 (200-bar: 0.195) |

The flip rate is ~0 rather than exactly 0, and the test asserts `<= 1` rather than `=== 0`
deliberately: a bar sitting a fraction of a point from 70 can still land on the other side of the
line at 57 bars versus 200. Convergence is a claim about the distribution, not about every draw —
which is also why the converged column's worst bar (0.94) is *not* better than the floor's best
(0.056). A seed can hit the converged value by luck; what it cannot do is hit it reliably.

`directionFrom` gates on 70/30 and `confidenceFrom` is `|rsi − 50| / 50`, so this is not an
abstraction: nearly one bar in five, the analyst's `direction` and the weight the debate gives it
both depend on a history length nobody chose.

**Status after B2:** the dial exists — `recommendedWarmupFor(spec)` returns `4 × period + 1` for
the recursive kinds and `minimumBarsFor` for `sma`, which is warm-up-blind. `minimumBarsFor` was
deliberately not raised then and is not raised now: it is the fabrication floor, `decide.ts:126`
pre-checks against it, and raising it would turn "this number would be better with more history"
into "this instrument cannot trade". A cold instrument holding 20 bars still gets a (less-warm)
RSI rather than no view at all.

**Resolution (#722, 2026-08-17): adopt.** The alternative — keeping the floor and renaming the
series to Cutler's — was rejected by the owner: at `lookback: 15` the Wilder recursion has not
converged, so the number is a function of where the window happens to start. That is a warm-up
artefact, not a defensible alternative convention. Re-pointing `RSI_SPEC` reprices every technical
opinion in the system at once, and that cost was accepted knowingly.

What moved with it:

- `RSI_SPEC.lookback` is composed from `recommendedWarmupFor` rather than written as `57`, so the
  spec cannot drift away from the function that justifies it.
- `indicator-registry.test.ts`'s pinning assertion — which existed precisely so this adoption would
  be visible rather than quiet — now asserts convergence for RSI and the floor for SMA and ATR
  separately. The companion assertion that the recommendation converges within 0.5 RSI points of a
  200-bar warm-up is untouched.
- `WARM_START_WINDOWS` (`backfill-market-data.ts`) went `1h`/20 → `1h`/57. Without it the adoption
  would have been inert on the path that matters most: a warm-started store holding 20 bars serves
  20, and `computeIndicator` computes a 20-bar RSI on the first tick without throwing, since 20
  clears the floor.
- The smoke fixture's RSI moved 63.16 → 68.52 and the run still transacts end to end. The close
  cycle was **not** re-tuned to restore 63.16 — that number was the artefact this change removed —
  but the margin to the overbought gate is now 1.48 points rather than 6.84, which is recorded in
  `smoke-run.ts` rather than padded.

**ATR is out of scope and still on the floor.** `atrIndicatorSpec(14)` and
`DEFAULT_VOLATILITY_INDICATOR` carry the identical gap (F1); moving them reprices every stop in the
system rather than every opinion, and `trader/atr-equivalence.test.ts` still owns it.

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

### F5 — The A3 entry window switched flat-by-close off. *(closed in this branch)*

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

**Which calendar the tail resolves through.** `sessionEnd` is per venue — `equityCalendarFor` returns
LSE in `live` and US in `paper` — and the Trader flattens against `sessionCalendars.stocks`, built by
that same function on that same config at `production.ts:469`. They are separate *instances*: the
component root builds one, the orchestrator root another. What makes them agree is that the function
is pure and the calendars hold no mutable state, so both halves are load-bearing and neither is
visible from a test that pins the calendar. Pinned by a third assertion at 15:56 ET — past the LSE
close, inside the US session, five minutes from the US close — which is the only one of the three
that fails when the tail is given a hard-coded `LseRegularHoursCalendar`.

One limit stays open and is **not** introduced here: `sessionCalendars` is keyed on `AssetClass`, so
a single universe carrying both LSE and US equities gets one `stocks` calendar for both. The tail
inherits that exactly, no better and no worse. Splitting it needs a per-instrument calendar
dimension, which belongs with A1's `subclass` work rather than this fix.

## Prior reports not re-litigated

- `triage-2026-08-06.md` and the two 2026-08-05 audits — no indicator finding among them.
- `atr-equivalence.test.ts` (#304) already owns the ATR half of F1; this review extends it to RSI
  rather than restating it.

## What changed in this pass

**No production ARITHMETIC was touched** — every indicator returns exactly what it returned before
this pass, which is what makes F1–F3 a characterisation rather than a change. Three review passes
read the earlier wording ("tests and a fixture only") as claiming the branch carries no production
code at all, which is not true and was never the claim, so it is stated precisely here:

| Changed | What | Why it is not an arithmetic change |
| --- | --- | --- |
| Tests + fixture | `indicator-golden.test.ts`, `indicator-registry.test.ts`, `rsi-warmup.test.ts`, `__fixtures__/` | The measurement itself. |
| `technical-analyst.ts` | `RSI_SPEC` / `SMA_SPEC` / `confidenceFrom` / the 70-30 gates gained an `export` | Visibility only. The goldens pin the real spec and the real gates rather than a hand-rebuilt copy — the same reason `atrIndicatorSpec` is exported (#304). A copy would make this document's 18% a claim about the copy. |
| `indicators.ts` | The two parallel `switch`es became one `Record<IndicatorKind, IndicatorDefinition>`; `recommendedWarmupFor` added | B2. The registry's `seedBars` reproduce the old switch arity exactly and delegate to the same helpers; `recommendedWarmupFor` gives F2 a number and has no production caller by design. |
| `production/stocks-tick-window.ts` | The entry window ∪ flatten tail composition | **F5, and this one IS production.** It is a defect fix, not a characterisation — it restores flat-by-close, which the A3 entry window had switched off. Listed here rather than buried because "no production change" would be false without it. |

`minimumBarsFor` is deliberately NOT raised, so it still answers the arity question alone.

## What changed in the #722 pass (2026-08-17)

| Changed | What | Why |
| --- | --- | --- |
| `technical-analyst.ts` | `RSI_SPEC.lookback` composed from `recommendedWarmupFor` (15 → 57) | The adoption itself. **This one IS production and it moves a live number.** |
| `indicator-registry.test.ts` | The floor-pinning assertion split: RSI asserts convergence, SMA/ATR assert the floor | The assertion was built to fail here. It did. |
| `rsi-warmup.test.ts` | The three "what it costs" measurements now name `minimumBarsFor` explicitly, and a second set measures the live spec beside them | Retargeting the first set at `RSI_SPEC` would have turned the evidence for the change into a restatement of the change. |
| `backfill-market-data.ts` | `WARM_START_WINDOWS` `1h`/20 → `1h`/57, and its derivation prose | Without it a warm-started store serves 20 bars and the first tick computes a 20-bar RSI without complaint. |
| `smoke-run.ts` / `smoke-run.test.ts` | The 63.16 → 68.52 repricing recorded; the test recomputes from `RSI_SPEC`/`SMA_SPEC` rather than hand-built literals | The literals pinned `lookback: 15` while feeding 60 bars, so they agreed with the analyst only by accident. |

### Thresholds re-checked against the unbiased series

A threshold fitted to a biased input is not automatically valid against an unbiased one, so every
threshold downstream of the RSI was re-checked rather than carried forward silently.

- **`RSI_OVERBOUGHT` 70 / `RSI_OVERSOLD` 30** — conventional Wilder levels, not fitted to anything
  this system measured. They were, if anything, *mis*applied to a series that was not Wilder's;
  they are now applied to one that is. Carried forward deliberately.
- **`confidenceFrom` = `|rsi − 50| / 50`, clamped to [0.05, 0.95]** — a formula, not a fit, and
  unchanged. Its **output distribution moves**: over the measurement region the mean technical
  confidence falls from **0.240 to 0.197** (−18%), because a converged RSI sits closer to 50 than a
  seed does. The technical analyst now speaks proportionally more quietly into every debate.
- **`traderConfig.conviction_floor` 0.55 — NOT re-derived, and named rather than assumed safe.**
  Analyst confidence feeds `computeEvidenceStrength`'s `avgConfidence`, so a systematically quieter
  technical analyst lowers conviction on exactly the desk shape [#625](https://github.com/dd-jp/samurai-trading-system/issues/625)
  found pinned at a 0.5478 ceiling against this 0.55 floor. 0.55 is a spec constant rather than a
  number fitted to RSI output, so nothing here invalidates it — but the headroom above it just got
  smaller, and re-deriving it needs a soak against the converged series, not a unit test.
- **ATR-derived stops, the volatility breaker, `min_bars`, `adv_window`, the correlation window** —
  none read the RSI. Unaffected.
