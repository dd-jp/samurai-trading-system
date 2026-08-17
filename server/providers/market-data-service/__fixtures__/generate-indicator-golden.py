#!/usr/bin/env python3
"""Generates `indicator-golden.json` — the characterisation baseline for
`indicators.ts` (step B1 of the plan under wayfinder map #703).

## Why this file exists

Every numeric assertion in `indicator.test.ts` today is `Number.isFinite`, a
relative comparison, or — at `technical-analyst.test.ts:172-192` — a value
recomputed by calling `computeIndicator` itself. That is circular: a
mis-seeded Wilder RSI or an off-by-one ATR passes the whole suite. The system
must clear an accuracy bar of at least 4.33 pp (ADR-0018 D3) while every stop
it places is priced off ATR and every technical opinion it forms is one RSI,
so "the indicator is arithmetically what it claims to be" is not a detail.

## Why a hand-written reference and not pandas-ta

The plan named `pandas-ta` as the reference. Neither `pandas` nor `pandas_ta`
is installed here, and every checked-in research script in this repo is
stdlib-only (`docs/research/18-fetch-bars.py`, `18-threshold-study.py`,
`11-trend-signal-measurement.py` import nothing outside json/math/os/sys/
urllib/collections/datetime/zoneinfo). Adding a numeric stack to the machine
to bless fourteen lines of arithmetic is the wrong trade, and the plan's own
sentence asks this to match "the repo's existing docs/research/*.py culture".
So the reference is written here from Wilder's published definitions.

That substitution costs the one thing pandas-ta would have bought: genuine
independence from `indicators.ts`. The mitigation is STRUCTURAL rather than a
promise not to peek. `indicators.ts` computes a SINGLE value by seeding over
`slice(0, period)` and folding `slice(period)`. The functions below compute a
FULL SERIES by explicit per-bar recurrence, emitting a value at every index
from the warm-up onward, and the golden is the last element. The two shapes
cannot be transcriptions of one another; where they agree the agreement is
evidence, and where they disagree the disagreement is locatable to a bar.

## The conventions being pinned

`indicators.ts` seeds Wilder's smoothing with a SIMPLE MEAN of the first
`period` observations and then smooths forward — the convention Wilder
published and the one this reference reproduces. Most JS TA libraries instead
EWM from the first value and will disagree, which is exactly why the baseline
has to name its convention rather than trust a library.

Three behaviours here are conventions, not mathematics, and the goldens exist
to make a change to any of them a failing test rather than a silent reprice:

  1. `avgLoss == 0` returns 100, UNLESS `avgGain` is also 0, in which case it
     returns 50 (#725). On a strictly rising window (`avgGain > 0`) 100 is
     the standard answer. On a DEAD FLAT window — every change zero, both
     averages 0 — `0/0` is not "maximum strength going up", it is "no
     information", so it takes 50, the neutral midpoint — see the `flat_*`
     cases, which are in the fixture on purpose.
  2. Recursive kinds (`ema`, `rsi`, `atr`) depend on the WHOLE window, not
     just the last `period` bars, so `lookback` is a real input: the same
     `period` over a longer warm-up is a different number. The
     `warmup_sensitivity_*` cases pin the size of that difference.
  3. `sma` reads only the trailing `period` closes and ignores the rest of
     the window.

## Usage

    python3 server/providers/market-data-service/__fixtures__/generate-indicator-golden.py

Writes `indicator-golden.json` beside this script. Deterministic — the bar
series comes from an LCG written out below rather than from `random`, so the
output does not depend on the Python version, and re-running must produce a
byte-identical file. A diff on that file in a PR means an intended change to
the fixture or an unintended change to this script; there is no third case.

**That guarantee is enforced, not merely asserted.** CI re-runs this script and
fails on `git diff --exit-code` against the checked-in JSON (`.github/workflows/
ci.yml`, "Indicator golden fixture is generated, not hand-edited"). It has to
be: the fixture is the INDEPENDENT reference the golden tests check
`indicators.ts` against, so a hand-edited JSON would make every case agree with
whatever it was edited to say and turn the suite green on the bug it exists to
catch. Stdlib only (`json`, `os`) precisely so that check stays free to run.
"""

import json
import os

# --- bar series -------------------------------------------------------------

BAR_COUNT = 400
HOUR_MS = 60 * 60 * 1000
# 2026-01-05T00:00:00Z in epoch ms. A Monday; nothing here is calendar-aware,
# the timestamps only have to ascend for `assertAscending`.
START_MS = 1767571200000


def lcg(seed):
    """A written-out linear congruential generator.

    Deliberately not `random` — `random.seed` promises reproducibility across
    runs, not across Python versions, and this fixture is checked in.
    """
    x = seed
    while True:
        x = (1103515245 * x + 12345) % (2**31)
        yield x / float(2**31)


def q(value):
    """Four decimal places, so the JSON is an exact decimal and Python and
    JavaScript parse the same double from it."""
    return float("%.4f" % value)


def build_bars():
    """Four segments, each present for a reason the goldens depend on.

    - 0-199 random walk: the ordinary case, with varying volume.
    - 200-219 strictly rising: `avgLoss == 0`, the RSI 100 branch.
    - 220-239 strictly falling: `avgGain == 0`, RSI 0. Not the same code path.
    - 240-259 dead flat dojis: `high == low == open == close`, so ATR is 0 and
      RSI takes the 100 branch on a market that has not moved at all.
    - 260-399 gapping walk: opens jump away from the prior close, so the true
      range is `abs(high - prevClose)` or `abs(low - prevClose)` rather than
      `high - low`. Without this segment the ATR goldens would never exercise
      two of the three legs of the max.
    """
    rand = lcg(20260816)
    bars = []
    close = 100.0

    def push(index, open_, high, low, close_, volume):
        close_time = START_MS + (index + 1) * HOUR_MS
        bars.append(
            {
                "open_time": close_time - HOUR_MS,
                "close_time": close_time,
                "open": q(open_),
                "high": q(high),
                "low": q(low),
                "close": q(close_),
                "volume": volume,
            }
        )

    for i in range(BAR_COUNT):
        open_ = close

        if 200 <= i < 220:
            close = open_ + 0.35 + 0.15 * next(rand)
        elif 220 <= i < 240:
            close = open_ - 0.35 - 0.15 * next(rand)
        elif 240 <= i < 260:
            close = open_
        elif 260 <= i:
            # Gap the open away from the prior close before moving.
            open_ = close + (next(rand) - 0.5) * 3.0
            close = open_ + (next(rand) - 0.5) * 1.2
        else:
            close = open_ + (next(rand) - 0.5) * 2.0

        if 240 <= i < 260:
            high = low = open_ = close
        else:
            body_high = max(open_, close)
            body_low = min(open_, close)
            high = body_high + next(rand) * 0.6
            low = body_low - next(rand) * 0.6

        # Varying volume, and one zero: `volume` feeds no indicator kind today,
        # but the current fixture pins it to 1 everywhere, which would make the
        # first volume-derived kind (RVOL, step B8) untestable against this
        # baseline. A zero bar is a real halt-or-auction bar and is the value
        # a ratio must not divide by.
        volume = 0 if i == 137 else int(1000 + 9000 * next(rand))

        push(i, open_, high, low, close, volume)

    return bars


# --- reference implementations ----------------------------------------------
#
# Written as explicit per-bar recurrences emitting one value per index. This
# shape is the independence guarantee: `indicators.ts` seeds over a slice and
# folds the tail to produce a single scalar, and a transcription of it would
# not look like this.


def sma_series(closes, period):
    out = [None] * len(closes)
    for i in range(period - 1, len(closes)):
        total = 0.0
        for j in range(i - period + 1, i + 1):
            total += closes[j]
        out[i] = total / period
    return out


def ema_series(closes, period):
    """Wilder-era convention as `indicators.ts` uses it: seed with the simple
    mean of the first `period` closes, then apply the 2/(period+1) smoothing
    one bar at a time. NOT `alpha` from the first value, which is what most JS
    TA libraries do and is the disagreement this baseline exists to catch."""
    out = [None] * len(closes)
    if len(closes) < period:
        return out
    alpha = 2.0 / (period + 1)
    seed = 0.0
    for j in range(period):
        seed += closes[j]
    out[period - 1] = seed / period
    for i in range(period, len(closes)):
        out[i] = closes[i] * alpha + out[i - 1] * (1.0 - alpha)
    return out


def _rsi_from(avg_gain, avg_loss):
    # The convention, stated where it happens (#725, `indicators.ts`'s `rsi`).
    # `avg_gain == 0 and avg_loss == 0` is checked FIRST and separately: a
    # dead-flat window — every change zero — is "no information", not
    # "maximally overbought", so it answers the neutral midpoint 50 rather
    # than falling into the `avg_loss == 0` branch below. That branch still
    # answers 100 for a strictly rising window, where `avg_gain > 0`.
    if avg_gain == 0 and avg_loss == 0:
        return 50.0
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def rsi_series(closes, period):
    """Wilder's RSI. `gains[k]`/`losses[k]` is the move from bar k to bar k+1,
    so the first value lands at index `period` — `period` closes yield only
    `period - 1` changes, which is why `minimumBarsFor` is `period + 1`."""
    out = [None] * len(closes)
    if len(closes) < period + 1:
        return out

    gains = []
    losses = []
    for i in range(1, len(closes)):
        delta = closes[i] - closes[i - 1]
        gains.append(delta if delta > 0 else 0.0)
        losses.append(-delta if delta < 0 else 0.0)

    avg_gain = 0.0
    avg_loss = 0.0
    for k in range(period):
        avg_gain += gains[k]
        avg_loss += losses[k]
    avg_gain /= period
    avg_loss /= period
    out[period] = _rsi_from(avg_gain, avg_loss)

    for i in range(period + 1, len(closes)):
        gain = gains[i - 1]
        loss = losses[i - 1]
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        out[i] = _rsi_from(avg_gain, avg_loss)

    return out


def atr_series(bars, period):
    """Wilder's ATR. True range needs a predecessor close, so `trs[i]` is only
    defined for i >= 1 and the first ATR lands at index `period`."""
    out = [None] * len(bars)
    trs = [None]
    for i in range(1, len(bars)):
        high = bars[i]["high"]
        low = bars[i]["low"]
        prev_close = bars[i - 1]["close"]
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))

    if len(bars) < period + 1:
        return out

    total = 0.0
    for k in range(1, period + 1):
        total += trs[k]
    value = total / period
    out[period] = value

    for i in range(period + 1, len(bars)):
        value = (value * (period - 1) + trs[i]) / period
        out[i] = value

    return out


def reference(bars, indicator, period):
    """The value `computeIndicator(bars, spec)` must return for this window:
    the last element of the series, i.e. the value at the newest bar."""
    closes = [b["close"] for b in bars]
    if indicator == "sma":
        series = sma_series(closes, period)
    elif indicator == "ema":
        series = ema_series(closes, period)
    elif indicator == "rsi":
        series = rsi_series(closes, period)
    elif indicator == "atr":
        series = atr_series(bars, period)
    else:
        raise ValueError("unsupported indicator: %s" % indicator)

    value = series[-1]
    if value is None:
        raise ValueError(
            "window of %d bars is too short for %s(%d) — a case must not ask for "
            "a value the reference itself declines to produce" % (len(bars), indicator, period)
        )
    return value


# --- cases ------------------------------------------------------------------
#
# A case is a window (`from`:`to`, half-open, over the fixture bars) plus a
# spec. `to` is exclusive so `to - from` reads as the window length, which is
# what `minimumBarsFor` is compared against.


def minimum_bars_for(indicator, period):
    """Mirrors `minimumBarsFor` in indicators.ts. Duplicated deliberately: the
    boundary cases below must be built from the DECLARED arity so that a change
    to it shows up as a golden that no longer sits on the boundary."""
    return period if indicator in ("sma", "ema") else period + 1


def build_cases():
    cases = []

    def case(name, indicator, period, frm, to, note):
        cases.append(
            {
                "name": name,
                "indicator": indicator,
                "period": period,
                "from": frm,
                "to": to,
                "note": note,
            }
        )

    # The ordinary case: a full 400-bar window at the period the system
    # actually runs (`technical-analyst.ts` uses 14, `atrIndicatorSpec` 14).
    for kind in ("sma", "ema", "rsi", "atr"):
        case(
            "full_window_%s_14" % kind,
            kind,
            14,
            0,
            BAR_COUNT,
            "the shipped period over a fully warmed window",
        )

    # Exactly `minimumBarsFor`. The comfortable case is where every seeding
    # convention agrees; the boundary is where they diverge, and it is the one
    # the circular tests could never assert. `atr` divides its seed by
    # `seedRanges.length` while `rsi` divides by `period` — an asymmetry that
    # is only harmless because `computeIndicator` throws below this length, so
    # `seedRanges.length == period` always. These cases pin that.
    for kind in ("sma", "ema", "rsi", "atr"):
        need = minimum_bars_for(kind, 14)
        case(
            "boundary_%s_14" % kind,
            kind,
            14,
            BAR_COUNT - need,
            BAR_COUNT,
            "exactly minimumBarsFor(%s, 14) = %d bars — one fewer must throw" % (kind, need),
        )

    # Smallest and a long period, both at the boundary and warmed.
    case("short_period_rsi_2", "rsi", 2, 0, BAR_COUNT, "period 2, the smallest meaningful Wilder")
    case("short_period_atr_2", "atr", 2, 0, BAR_COUNT, "period 2")
    case("long_period_ema_50", "ema", 50, 0, BAR_COUNT, "period 50 over 400 bars")
    case("long_period_rsi_50", "rsi", 50, 0, BAR_COUNT, "period 50 over 400 bars")

    # Warm-up sensitivity: the SAME period and the SAME final bar over three
    # window lengths. For `sma` all three must agree (it reads the trailing
    # `period` closes and nothing else); for `ema`/`rsi`/`atr` they must NOT,
    # and the spread between them is what `lookback` buys. This is the pair of
    # facts that makes `lookback` part of the cache key.
    for kind in ("sma", "ema", "rsi", "atr"):
        for length in (minimum_bars_for(kind, 14), 60, 400):
            case(
                "warmup_sensitivity_%s_14_%d" % (kind, length),
                kind,
                14,
                BAR_COUNT - length,
                BAR_COUNT,
                "same period and same final bar over a %d-bar window" % length,
            )

    # Degenerate segments. A random walk never produces these and they are
    # where the conventions bite.
    case(
        "rising_run_rsi_14",
        "rsi",
        14,
        200,
        220,
        "strictly rising: avgLoss == 0, the RSI 100 branch",
    )
    case(
        "falling_run_rsi_14",
        "rsi",
        14,
        220,
        240,
        "strictly falling: avgGain == 0, RSI 0 — a different branch from the above",
    )
    case(
        "flat_dojis_rsi_14",
        "rsi",
        14,
        240,
        260,
        "high == low == open == close: avgGain == avgLoss == 0, RSI reads the "
        "neutral midpoint 50 rather than the 100 a strictly rising window gets (#725)",
    )
    case(
        "flat_dojis_rsi_5",
        "rsi",
        5,
        240,
        260,
        "same dead-flat segment, a different period: RSI 50 on a halted/auction "
        "tape does not depend on which period asked for it (#725)",
    )
    case(
        "flat_dojis_atr_14",
        "atr",
        14,
        240,
        260,
        "zero true range throughout: ATR is exactly 0, which every ATR-derived stop divides by",
    )
    case(
        "flat_dojis_sma_14",
        "sma",
        14,
        240,
        260,
        "flat closes: SMA is the close itself",
    )
    case(
        "gapping_atr_14",
        "atr",
        14,
        260,
        BAR_COUNT,
        "opens gap past the prior close, so TR is |high - prevClose| or |low - prevClose|",
    )
    case(
        "gapping_rsi_14",
        "rsi",
        14,
        260,
        BAR_COUNT,
        "gapping series — RSI sees only closes, so gaps are ordinary moves to it",
    )

    # `sma` over a window far longer than its period, which is the shape every
    # real spec has (`lookback` is the warm-up, `params.period` the window).
    case(
        "sma_ignores_the_warmup_14_over_120",
        "sma",
        14,
        BAR_COUNT - 120,
        BAR_COUNT,
        "period 14 inside a 120-bar window — only the trailing 14 closes may matter",
    )

    return cases


def main():
    bars = build_bars()
    cases = build_cases()

    for case in cases:
        window = bars[case["from"] : case["to"]]
        need = minimum_bars_for(case["indicator"], case["period"])
        if len(window) < need:
            raise ValueError(
                "case %s asks for %s(%d) over %d bars but needs %d"
                % (case["name"], case["indicator"], case["period"], len(window), need)
            )
        # 8 decimal places, matching ROUNDING_PRECISION in indicators.ts. The
        # TypeScript side compares with a tolerance of half a unit in that last
        # place rather than for equality: the reference accumulates in a
        # different order by design, so a last-bit difference is expected and a
        # difference above the rounding precision is the finding.
        case["expected"] = float("%.8f" % reference(window, case["indicator"], case["period"]))

    out = {
        "_comment": (
            "GENERATED by generate-indicator-golden.py — do not hand-edit. Expected values come "
            "from an independent stdlib reference written from Wilder's definitions as per-bar "
            "recurrences, not from indicators.ts. A disagreement is a finding about the live "
            "signal, not a reason to edit this file."
        ),
        "_generator": "server/providers/market-data-service/__fixtures__/generate-indicator-golden.py",
        "rounding_precision": 8,
        "bar_count": BAR_COUNT,
        "bars": bars,
        "cases": cases,
    }

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "indicator-golden.json")
    with open(path, "w") as handle:
        json.dump(out, handle, indent=2)
        handle.write("\n")

    print("wrote %s: %d bars, %d cases" % (path, len(bars), len(cases)))


if __name__ == "__main__":
    main()
