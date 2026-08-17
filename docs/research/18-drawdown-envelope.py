"""#729 drawdown-envelope generator.

ADR-0018 D5 sizes live positions off two tables in `18-intraday-instrument-physics.md`
— a per-subclass volatility envelope (per-trade sd, annualised vol, max drawdown at
full deployment) and a ladder scaling that drawdown down by deployed fraction. No
checked-in script produced either. `18-threshold-study.py` computes `sd` and `sharpe`
and no drawdown of any kind; the only drawdown in `docs/research/` belongs to
`11-trend-signal-measurement.py`, a superseded study on a different horizon and
universe.

This script produces them, and — because the recorded figures cannot be re-derived
by hand from the row above them — it reports **every plausible drawdown definition
side by side** rather than the one that happens to match. Nothing here is searched
or fitted: the return series is fixed by `18-threshold-study.py`'s own loader, the
four definitions are declared below, and whichever ones disagree with 55.6% / 88.0%
disagree in the output.

Usage (SAMURAI_DATA_DIR holds bars/<SYMBOL>_<TF>.jsonl, as the other 18-* scripts expect):

    SAMURAI_DATA_DIR=/tmp/adr18 python3 docs/research/18-drawdown-envelope.py

Anchor first, drawdown second
-----------------------------
Before any drawdown is computed the script checks which *input series* reproduces
the published per-trade sd. Two candidates exist and doc 18 does not say which:

  (a) unbracketed open-to-close return x leverage  ("shape with zero edge assumed")
  (b) the bracketed trade outcomes `simulate()` returns

Only one can give 1.55% / 4.01%. Getting that agreement is what licenses reading
anything into the drawdown numbers below it; without it, a matching drawdown would
be a coincidence between two different series.
"""
import math
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_study = __import__("18-threshold-study")
load_sessions = _study.load_sessions
simulate = _study.simulate

TRADING_DAYS = 252

# The subclasses ADR-0018 D5 tabulates, with the proxy each was measured on and
# the neutral bracket #724 froze. Costs are ADR-0016's round trips.
SUBCLASSES = [
    {
        "label": "3x index ETP",
        "symbol": "SPY",
        "tf": "5Min",
        "lev": 3.0,
        "cost": 0.18,
        "tp": 2.00,
        "sl": 2.16,
        "grid": [(1.0, 1.03), (1.5, 1.58), (2.0, 2.16), (3.0, 3.35), (4.5, 5.75),
                 (2.0, 1.5), (2.0, 3.0), (3.0, 1.5), (4.0, 1.5), (4.0, 3.0), (6.0, 1.5), (6.0, 3.0)],
        "recorded_sd": 1.55,
        "recorded_vol": 24.6,
        "recorded_mdd": 55.6,
        "ladder": {1.00: 55.6, 0.50: 31.6, 0.35: 23.1, 0.25: 17.0},
    },
    {
        "label": "3x single-stock ETP",
        "symbol": "TSLA",
        "tf": "1Min",
        "lev": 3.0,
        "cost": 0.41,
        "tp": 6.00,
        "sl": 6.25,
        "grid": [(2.0, 2.10), (4.0, 4.14), (6.0, 6.25), (9.0, 9.38),
                 (2.0, 1.5), (2.0, 3.0), (4.0, 1.5), (4.0, 3.0), (6.0, 1.5), (6.0, 3.0)],
        "recorded_sd": 4.01,
        "recorded_vol": 63.6,
        "recorded_mdd": 88.0,
        "ladder": {1.00: 88.0, 0.50: 50.0, 0.35: 35.8, 0.25: 26.2},
    },
]


def open_to_close_returns(sessions, days, lev):
    """Unbracketed session return in ETP terms, in percent. Candidate series (a)."""
    out = []
    for d in days:
        bars = sessions[d]
        o = bars[0][1]
        if o <= 0:
            continue
        out.append(lev * (bars[-1][4] / o - 1) * 100.0)
    return out


def drift_removed(rs):
    """Zero-edge reading: subtract the sample mean, keep the shape."""
    m = sum(rs) / len(rs)
    return [x - m for x in rs]


def mdd_arithmetic(rs, f):
    """Max drawdown of a non-compounded equity curve: peak-to-trough, % of start."""
    equity = 0.0
    peak = 0.0
    worst = 0.0
    for r in rs:
        equity += f * r
        peak = max(peak, equity)
        worst = min(worst, equity - peak)
    return -worst


def mdd_simple_compound(rs, f):
    """Max drawdown compounding simple returns: equity *= (1 + f*r). % of peak."""
    equity = 1.0
    peak = 1.0
    worst = 0.0
    for r in rs:
        equity *= 1.0 + f * r / 100.0
        if equity <= 0:
            return 100.0
        peak = max(peak, equity)
        worst = min(worst, equity / peak - 1.0)
    return -worst * 100.0


def mdd_log_compound(rs, f):
    """Max drawdown treating f*r as a log return. % of peak."""
    cum = 0.0
    peak = 0.0
    worst = 0.0
    for r in rs:
        cum += f * r / 100.0
        peak = max(peak, cum)
        worst = min(worst, cum - peak)
    return (1.0 - math.exp(worst)) * 100.0


def mdd_expected_analytic(sd, f, n):
    """E[max drawdown] of a driftless arithmetic random walk over n steps.

    Closed form for driftless Brownian motion: E[MDD] = sqrt(pi/2) * sigma * sqrt(T).
    Included because a *measured* single path and an *expected* drawdown are
    different quantities, and doc 18 does not say which of the two it recorded.
    """
    return math.sqrt(math.pi / 2.0) * f * sd * math.sqrt(n)


def report(sub):
    sessions = load_sessions(sub["symbol"], sub["tf"])
    days = sorted(sessions)
    if not days:
        print("== %s: no sessions loaded - skipped" % sub["label"])
        return None

    otc = open_to_close_returns(sessions, days, sub["lev"])
    bracketed = simulate(sessions, days, sub["lev"], sub["tp"], sub["sl"], sub["cost"])

    print("== %s  (%s %s, %d sessions, %s..%s)"
          % (sub["label"], sub["symbol"], sub["tf"], len(days), days[0], days[-1]))
    print("   recorded: sd %.2f%%  vol %.1f%%  max drawdown at full deployment %.1f%%"
          % (sub["recorded_sd"], sub["recorded_vol"], sub["recorded_mdd"]))

    print("\n   -- ANCHOR 1: does an unbracketed series reproduce the recorded sd?")
    sd_otc = statistics.stdev(otc)
    print("      open-to-close x lev (unbracketed)   sd %.3f%%  annualised %.1f%%   (recorded %.2f%%)"
          % (sd_otc, sd_otc * math.sqrt(TRADING_DAYS), sub["recorded_sd"]))
    print("      -> %s" % ("agrees" if abs(sd_otc - sub["recorded_sd"]) <= 0.05
                           else "no: the envelope is measured on bracketed outcomes, not raw sessions"))

    print("\n   -- ANCHOR 2: which BRACKET reproduces the recorded sd? (declared bracket marked *)")
    provenance = None
    for tp, sl in sub["grid"]:
        rs = simulate(sessions, days, sub["lev"], tp, sl, sub["cost"])
        sd = statistics.stdev(rs)
        declared = (abs(tp - sub["tp"]) < 1e-9 and abs(sl - sub["sl"]) < 1e-9)
        match = abs(sd - sub["recorded_sd"]) <= 0.06
        if match and (provenance is None or abs(sd - sub["recorded_sd"]) < abs(provenance[2] - sub["recorded_sd"])):
            provenance = (tp, sl, sd, rs)
        print("      %s TP %+.1f%% / SL -%.2f%%   sd %.3f%%%s"
              % ("*" if declared else " ", tp, sl, sd, "   <== reproduces the recorded sd" if match else ""))

    declared_rs = simulate(sessions, days, sub["lev"], sub["tp"], sub["sl"], sub["cost"])
    variants = [("DECLARED bracket  TP %+.1f / SL -%.2f" % (sub["tp"], sub["sl"]), declared_rs)]
    if provenance and not (abs(provenance[0] - sub["tp"]) < 1e-9 and abs(provenance[1] - sub["sl"]) < 1e-9):
        variants.append(("PROVENANCE bracket TP %+.1f / SL -%.2f (reproduces the sd, but is not the declared rule)"
                         % (provenance[0], provenance[1]), provenance[3]))

    rows_by_variant = []
    for vlabel, series in variants:
        sd = statistics.stdev(series)
        zero_edge = drift_removed(series)
        n = len(zero_edge)
        print("\n   -- DRAWDOWN, drift removed | %s | sd %.3f%%" % (vlabel, sd))
        print("      %-8s %-10s %10s %10s %10s %10s" %
              ("fraction", "recorded", "arithmetic", "simple", "log", "E[MDD]"))
        rows = []
        for f in (1.00, 0.50, 0.35, 0.25):
            rec = sub["ladder"][f]
            a = mdd_arithmetic(zero_edge, f)
            s = mdd_simple_compound(zero_edge, f)
            lg = mdd_log_compound(zero_edge, f)
            e = mdd_expected_analytic(sd, f, n)
            rows.append((f, rec, a, s, lg, e))
            print("      %-8.2f %9.1f%% %9.1f%% %9.1f%% %9.1f%% %9.1f%%" % (f, rec, a, s, lg, e))
        print("      scaling exponent (drawdown ~ f^k, 1.00 vs 0.25):", end="")
        for idx, label in ((1, "recorded"), (2, "arithmetic"), (3, "simple"), (4, "log")):
            hi, lo = rows[0][idx], rows[-1][idx]
            k = math.log(hi / lo) / math.log(4.0) if lo > 0 and hi > 0 else float("nan")
            print("  %s %.3f" % (label, k), end="")
        print()
        rows_by_variant.append((vlabel, rows))

        print("      deployment that holds CONTEXT.md's tolerance under this series:", end="")
        for tol in (25.0, 20.0):
            print("  <=%.0f%% -> f = %.3f" % (tol, solve_fraction(zero_edge, tol)), end="")
        print()
    print()
    return rows_by_variant


def solve_fraction(zero_edge, tolerance, hi=1.0, lo=0.0):
    """Largest deployed fraction whose simple-compounded drawdown stays <= tolerance.

    Bisection, not a grid: the ladder rows in doc 18 are four samples of a
    continuous curve, and the question ADR-0018 D5 leaves open ("the fraction has
    to fall to roughly ~24%, which no measured row covers") is answered by solving
    it rather than by interpolating between rows.
    """
    if mdd_simple_compound(zero_edge, hi) <= tolerance:
        return hi
    for _ in range(60):
        mid = (hi + lo) / 2.0
        if mdd_simple_compound(zero_edge, mid) > tolerance:
            hi = mid
        else:
            lo = mid
    return lo


def main():
    any_run = False
    for sub in SUBCLASSES:
        path = os.path.join(_study.TMP, "bars", "%s_%s.jsonl" % (sub["symbol"], sub["tf"]))
        if not os.path.exists(path):
            print("== %s: %s missing - fetch it with 18-fetch-bars.py first\n" % (sub["label"], path))
            continue
        report(sub)
        any_run = True
    if not any_run:
        print("nothing to report: no bar files found under %s/bars" % _study.TMP)


if __name__ == "__main__":
    main()
