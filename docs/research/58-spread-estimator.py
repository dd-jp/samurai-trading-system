"""#881 / #882 — can a free OHLC spread estimator price the LSE leveraged-ETP pool?

Produces the tables in `docs/research/58-cost-floor-sizing-and-per-instrument-spread.md`
below the `---`. The criterion above that line was committed first; this script
does not restate it, it executes it.

The question this exists to answer
----------------------------------
#881 asks whether cost varies enough WITHIN the tradeable universe to justify a
per-instrument cost term. The tradeable universe is the eleven GBP LSE-listed
leveraged ETPs of ADR-0016, and `docs/research/34-lse-mark-source-options.md` §5
establishes there is no free real-time LSE QUOTE feed. That rules out measuring
spreads directly. It does not rule out ESTIMATING them: two published estimators
recover a bid-ask spread from daily OHLC bars alone, and doc 34 §3.1 verified
Yahoo serves daily bars for all eleven tickers for free.

Estimators
----------
* Corwin & Schultz (2012), "A Simple Way to Estimate Bid-Ask Spreads from Daily
  High and Low Prices", Journal of Finance 67(2), 719-759. Implemented as
  published, INCLUDING the overnight-return adjustment of their section I.B:
  when the previous close sits outside the following day's range, both the high
  and the low of that day are shifted by the gap before the two-day range is
  taken. Without that adjustment an overnight jump is read as spread.
* Abdi & Ranaldo (2017), "A Simple Estimation of Bid-Ask Spreads from Daily
  Close, High, and Low Prices", Review of Financial Studies 30(12), 4437-4480.
  The two-day estimator: s^2 = 4 (c_t - eta_t)(c_t - eta_{t+1}), where c is the
  log close and eta the log mid-range.

The two are not variants of one method — CS keys off the range, AR off the close
against the range — so agreement between them on a ticker is evidence, and
disagreement is a reason to distrust both on that ticker.

Degeneracy is reported, never truncated
---------------------------------------
Both estimators routinely return a negative variance term. The convention in the
literature is to truncate negatives to zero, which for our purposes is exactly
wrong: on a line that trades four times a week (doc 34 §3.3 measured 3LPA at
four prints across five whole sessions) truncation reports a THIN instrument as
a ZERO-SPREAD one. That is an error in the flattering direction, which is the
failure #875 was filed about. So negatives are counted per ticker, days with
`high == low` are counted separately, and a ticker degenerate on more than the
declared 33% of usable day-pairs is reported UNMEASURED rather than tight.

Usage (no key needed; writes the raw log the doc cites):

    python3 docs/research/58-spread-estimator.py \
        | tee docs/research/archive/raw/<date>-58-spread-estimator.txt
"""

from __future__ import annotations

import json
import math
import statistics
import sys
import time
import urllib.error
import urllib.request

# doc 53 G3 measured these from real Alpaca SIP consolidated quotes at 1m.
# The validation arm scores the estimators against this known ordering.
US_VALIDATION = {
    "SPY": 0.347,
    "QQQ": 0.546,
    "AAPL": 0.740,
    "TSLA": 4.216,
}

# The eleven `lse_ticker` rows in server/providers/universe-pool/lse-etp-pool.ts.
LSE_TICKERS = [
    "3USL",
    "LQQ3",
    "3SPY",
    "3LTS",
    "NVD3",
    "3AAP",
    "3LNV",
    "3QQQ",
    "MST3",
    "3LPA",
    "PLT3",
]

# Declared in the criterion: a ticker degenerate on more than this fraction of
# its usable day-pairs is UNMEASURED, not tight.
DEGENERACY_LIMIT = 0.33

CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=2y"

K = 3.0 - 2.0 * math.sqrt(2.0)


def fetch(symbol: str) -> tuple[list[dict[str, float]], str]:
    """Daily OHLC bars from Yahoo's free chart endpoint. RESEARCH USE ONLY —
    doc 34 §5 rules Yahoo out of the live path on licence and freshness."""
    request = urllib.request.Request(
        CHART.format(symbol=symbol), headers={"User-Agent": "Mozilla/5.0"}
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                payload = json.load(response)
            break
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == 3:
                raise RuntimeError(f"{symbol}: {exc}") from exc
            time.sleep(2 * (attempt + 1))

    result = payload["chart"]["result"][0]
    quote = result["indicators"]["quote"][0]
    currency = result["meta"].get("currency", "?")

    bars: list[dict[str, float]] = []
    for high, low, close in zip(quote["high"], quote["low"], quote["close"]):
        if high is None or low is None or close is None:
            continue
        if high <= 0 or low <= 0 or close <= 0:
            continue
        bars.append({"high": high, "low": low, "close": close})
    return bars, currency


def corwin_schultz(previous: dict[str, float], current: dict[str, float]) -> float | None:
    """CS (2012) two-day estimator with the paper's overnight adjustment.

    Returns the proportional ROUND-TRIP spread as a fraction, or None when the
    inputs are degenerate (a zero range gives log(1)=0 across the board).
    Negative estimates are RETURNED AS NEGATIVE — the caller counts them.
    """
    high_t, low_t = previous["high"], previous["low"]
    high_n, low_n = current["high"], current["low"]

    # Section I.B: shift the second day's range so an overnight gap is not read
    # as spread. If the previous close is below the next day's low, the whole
    # range moved up overnight; subtract that move before comparing ranges.
    close_t = previous["close"]
    if close_t < low_n:
        gap = low_n - close_t
        high_n -= gap
        low_n -= gap
    elif close_t > high_n:
        gap = close_t - high_n
        high_n += gap
        low_n += gap

    if low_t <= 0 or low_n <= 0 or high_t <= 0 or high_n <= 0:
        return None
    if high_t == low_t and high_n == low_n:
        # Neither day had any range at all: the estimator has no information.
        return None

    beta = math.log(high_t / low_t) ** 2 + math.log(high_n / low_n) ** 2
    high_2 = max(high_t, high_n)
    low_2 = min(low_t, low_n)
    gamma = math.log(high_2 / low_2) ** 2

    alpha = (math.sqrt(2.0 * beta) - math.sqrt(beta)) / K - math.sqrt(gamma / K)
    return 2.0 * (math.exp(alpha) - 1.0) / (1.0 + math.exp(alpha))


def abdi_ranaldo(previous: dict[str, float], current: dict[str, float]) -> float | None:
    """AR (2017) two-day estimator. Returns the proportional ROUND-TRIP spread
    as a fraction; a negative variance term is returned as a NEGATIVE number so
    the caller can count it rather than truncate it."""
    if previous["high"] <= 0 or previous["low"] <= 0 or current["high"] <= 0:
        return None
    if current["low"] <= 0:
        return None
    if previous["high"] == previous["low"] and current["high"] == current["low"]:
        return None

    c_t = math.log(previous["close"])
    eta_t = (math.log(previous["high"]) + math.log(previous["low"])) / 2.0
    eta_n = (math.log(current["high"]) + math.log(current["low"])) / 2.0

    s_squared = 4.0 * (c_t - eta_t) * (c_t - eta_n)
    if s_squared < 0:
        return -math.sqrt(-s_squared)
    return math.sqrt(s_squared)


def score(symbol: str) -> dict[str, object] | None:
    try:
        bars, currency = fetch(symbol)
    except RuntimeError as exc:
        print(f"  {symbol}: FETCH FAILED — {exc}", file=sys.stderr)
        return None

    flat_days = sum(1 for bar in bars if bar["high"] == bar["low"])

    cs_values: list[float] = []
    ar_values: list[float] = []
    cs_negative = 0
    ar_negative = 0
    cs_undefined = 0
    ar_undefined = 0

    for previous, current in zip(bars, bars[1:]):
        cs = corwin_schultz(previous, current)
        if cs is None:
            cs_undefined += 1
        elif cs < 0:
            cs_negative += 1
        else:
            cs_values.append(cs)

        ar = abdi_ranaldo(previous, current)
        if ar is None:
            ar_undefined += 1
        elif ar < 0:
            ar_negative += 1
        else:
            ar_values.append(ar)

    pairs = max(len(bars) - 1, 0)
    if pairs == 0:
        return {
            "symbol": symbol,
            "currency": currency,
            "bars": len(bars),
            "pairs": 0,
            "unmeasured": True,
            "reason": "no usable day-pairs",
        }

    cs_degenerate = (cs_negative + cs_undefined) / pairs
    ar_degenerate = (ar_negative + ar_undefined) / pairs
    unmeasured = cs_degenerate > DEGENERACY_LIMIT or ar_degenerate > DEGENERACY_LIMIT

    return {
        "symbol": symbol,
        "currency": currency,
        "bars": len(bars),
        "pairs": pairs,
        "flat_days": flat_days,
        "cs_bps": statistics.median(cs_values) * 10_000 if cs_values else None,
        "ar_bps": statistics.median(ar_values) * 10_000 if ar_values else None,
        "cs_degenerate": cs_degenerate,
        "ar_degenerate": ar_degenerate,
        "cs_negative": cs_negative,
        "ar_negative": ar_negative,
        "cs_undefined": cs_undefined,
        "ar_undefined": ar_undefined,
        "unmeasured": unmeasured,
        "reason": "degeneracy above the declared 33% limit" if unmeasured else "",
    }


def render(rows: list[dict[str, object]], title: str) -> None:
    print(f"\n{title}")
    print("-" * len(title))
    header = (
        f"{'ticker':<8} {'ccy':<5} {'bars':>5} {'pairs':>6} {'flat':>5} "
        f"{'CS bps':>9} {'AR bps':>9} {'CS deg%':>8} {'AR deg%':>8}  status"
    )
    print(header)
    for row in rows:
        if row.get("pairs") == 0:
            print(f"{row['symbol']:<8} {row['currency']:<5} {row['bars']:>5} {0:>6}      -         -         -        -  UNMEASURED ({row['reason']})")
            continue
        cs = f"{row['cs_bps']:.2f}" if row["cs_bps"] is not None else "-"
        ar = f"{row['ar_bps']:.2f}" if row["ar_bps"] is not None else "-"
        status = "UNMEASURED" if row["unmeasured"] else "ok"
        print(
            f"{row['symbol']:<8} {row['currency']:<5} {row['bars']:>5} {row['pairs']:>6} "
            f"{row['flat_days']:>5} {cs:>9} {ar:>9} "
            f"{row['cs_degenerate'] * 100:>7.1f}% {row['ar_degenerate'] * 100:>7.1f}%  {status}"
        )


def main() -> int:
    print("#881 / #882 — free OHLC spread estimators, Corwin-Schultz (2012) and Abdi-Ranaldo (2017)")
    print("Source: Yahoo v8/finance/chart, interval=1d, range=2y. RESEARCH USE ONLY (doc 34 §5).")
    print(f"Declared degeneracy limit: {DEGENERACY_LIMIT:.0%} of day-pairs. Negatives are counted, never truncated.")
    print(f"Run at: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")

    print("\n=== VALIDATION ARM — the estimators must reproduce doc 53's measured SIP ordering ===")
    us_rows = [row for row in (score(symbol) for symbol in US_VALIDATION) if row]
    render(us_rows, "US validation names (doc 53 G3 measured: SPY 0.347 < QQQ 0.546 < AAPL 0.740 << TSLA 4.216 bps, 1m half-spread)")

    measured_order = [symbol for symbol, _ in sorted(US_VALIDATION.items(), key=lambda item: item[1])]
    verdicts: dict[str, bool] = {}
    for name, key in (("Corwin-Schultz", "cs_bps"), ("Abdi-Ranaldo", "ar_bps")):
        usable = [row for row in us_rows if row.get(key) is not None]
        estimated_order = [str(row["symbol"]) for row in sorted(usable, key=lambda row: row[key])]
        ordering_ok = estimated_order == measured_order

        by_symbol = {str(row["symbol"]): row[key] for row in usable}
        ratio = None
        if by_symbol.get("TSLA") and by_symbol.get("SPY"):
            ratio = by_symbol["TSLA"] / by_symbol["SPY"]
        dispersion_ok = ratio is not None and 3.0 <= ratio <= 40.0

        print(f"\n{name}:")
        print(f"  estimated ordering : {' < '.join(estimated_order)}")
        print(f"  measured  ordering : {' < '.join(measured_order)}")
        print(f"  ORDERING BAR (exact match)      : {'PASS' if ordering_ok else 'FAIL'}")
        print(f"  TSLA/SPY ratio = {ratio:.2f}x (measured 12.15x)" if ratio else "  TSLA/SPY ratio: n/a")
        print(f"  DISPERSION BAR (3x <= r <= 40x) : {'PASS' if dispersion_ok else 'FAIL'}")
        verdicts[name] = ordering_ok and dispersion_ok

    passed = [name for name, ok in verdicts.items() if ok]
    print("\n=== VALIDATION VERDICT ===")
    for name, ok in verdicts.items():
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")

    if not passed:
        print("\nBOTH ESTIMATORS FAIL THE DECLARED VALIDATION BARS.")
        print("Per the criterion, the LSE arm is NOT run and NOT reported.")
        print("#881 stays gated on a paid LSE quote feed (open #895).")
        return 0

    print(f"\nAt least one estimator passes ({', '.join(passed)}). Running the LSE arm.")
    print("\n=== LSE ARM — the actual ADR-0016 tradeable universe ===")
    lse_rows = [row for row in (score(symbol + ".L") for symbol in LSE_TICKERS) if row]
    render(lse_rows, "LSE leveraged-ETP pool (server/providers/universe-pool/lse-etp-pool.ts)")

    measurable = [row for row in lse_rows if not row["unmeasured"] and row.get("cs_bps") is not None]
    print("\n=== #881's QUESTION: does cost vary enough WITHIN the tradeable universe? ===")
    print(f"  measurable tickers: {len(measurable)} of {len(LSE_TICKERS)}")
    unmeasured = [str(row["symbol"]) for row in lse_rows if row["unmeasured"]]
    if unmeasured:
        print(f"  UNMEASURED (degenerate, NOT tight): {', '.join(unmeasured)}")

    for name, key in (("Corwin-Schultz", "cs_bps"), ("Abdi-Ranaldo", "ar_bps")):
        values = [row[key] for row in measurable if row.get(key) is not None]
        if len(values) < 2:
            print(f"  {name}: fewer than two measurable tickers — no dispersion statistic")
            continue
        median = statistics.median(values)
        widest = max(values)
        tightest = min(values)
        print(
            f"  {name}: median {median:.2f} bps, range {tightest:.2f}-{widest:.2f} bps, "
            f"max/min {widest / tightest:.2f}x, p_max/median {widest / median:.2f}x"
        )
        print(
            f"    #875's declared 2x threshold for 'one coefficient is not defensible': "
            f"{'FIRES' if widest / median > 2.0 else 'does not fire'}"
        )

    print("\n=== #882's QUESTION: how does the 1bp structural floor compare? ===")
    print("  STRUCTURAL_MIN_HALF_SPREAD_RATE = 1.0000 bps of mid (half-spread, per side).")
    print("  The estimators produce a ROUND-TRIP proportional spread, so the comparable")
    print("  half-spread is CS/2 and AR/2. Horizon differs (daily vs 1m) — read the ordering.")
    for row in measurable:
        cs_half = row["cs_bps"] / 2 if row["cs_bps"] is not None else None
        ar_half = row["ar_bps"] / 2 if row["ar_bps"] is not None else None
        if cs_half is None:
            continue
        verdict = "UNDER-charges" if cs_half > 1.0 else "over-charges"
        print(
            f"  {row['symbol']:<8} CS half {cs_half:>8.2f} bps  AR half "
            f"{ar_half:>8.2f} bps  -> the 1bp floor {verdict} this line"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
