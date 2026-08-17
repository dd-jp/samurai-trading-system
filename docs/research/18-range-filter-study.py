"""#787 — is realised-range at entry a usable SESSION FILTER?

Split out of #708. #708 asked whether the *bracket* should be conditioned on
entry time and realised range, and answered no: across 42 cells, re-solving the
stop beat the declared bracket by at most 0.56 pp with no consistent sign. But
the reason it bought nothing is that the **sessions themselves** differ, and
that difference survives on the declared bracket (doc 50's `bar` column: single
stock `t0 = 15` runs quiet 6.42 pp against busy -0.09 pp).

This script asks the different question: **does declining to trade low-realised
range sessions lower the accuracy bar the signal must clear, out of sample, by
enough to matter — after paying for the trades it gives up?**

Nothing about the bracket is re-solved. The bracket is FROZEN at ADR-0018's
declared level per subclass, truncated at the 16:25 London flatten, exactly as
doc 50 priced it. The only free parameter is one threshold on one declared
statistic, solved in-sample and scored out-of-sample.

Usage:

    SAMURAI_DATA_DIR=/tmp/adr18 python3 docs/research/18-range-filter-study.py

Reads `<SAMURAI_DATA_DIR>/bars/{SPY_5Min,TSLA_1Min}.jsonl`, as written by
`18-fetch-bars.py` — the same tape doc 50 and ADR-0018 were computed from.
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_study = __import__("18-threshold-study")
_brackets = __import__("18-entry-time-brackets")

load_sessions = _study.load_sessions
simulate = _study.simulate
stats = _study.stats
HITS = _study.HITS

range_ratios = _brackets.range_ratios
flatten_at = _brackets.flatten_at
entry_window_et = _brackets.entry_window_et
minbtl_limit = _brackets.minbtl_limit
SUBCLASSES = _brackets.SUBCLASSES

# ---------------------------------------------------------------------------
# PRE-REGISTRATION — every constant below is declared before the first run, and
# none of them is re-chosen after seeing a result. #787's own words: "pre-
# register the filter as a rule (threshold on realised range at the arming
# instant, not a tercile solved on the sample)".
# ---------------------------------------------------------------------------

# The statistic, unchanged from doc 50: realised range from the open to the
# arming instant, over the trailing 20-session mean FULL-session range. Both
# legs are percentages of that session's open, so leverage cancels and the
# number is comparable across subclasses. The denominator is strictly prior
# sessions — `range_ratios` enforces that — so the quantity is observable at
# the arming instant with no lookahead.

# The rule: TRADE iff ratio >= THETA. One threshold. A tercile solved on the
# sample is what #787 explicitly rules out, so the grid is fixed in ratio units
# rather than in sample quantiles, and the same grid serves both subclasses.
#
# Grid range is fixed by the construction of the statistic, not by looking at
# it: the numerator is the range realised in the first 15 minutes and the
# denominator a whole 390-minute session, so the ratio lives well below 1 at
# the decision offset and a grid stepping in tenths to 1.0 would spend most of
# its points on thresholds that keep nothing. Eleven points, 0.00 to 0.50.
THETA_GRID = [round(0.05 * i, 2) for i in range(11)]

# THETA is selected on the IN-SAMPLE half only (<=2022), by minimising the
# in-sample required accuracy edge on the FROZEN bracket, subject to retaining
# at least MIN_KEEP of in-sample sessions. The retention floor is declared, not
# tuned: without it the minimiser can walk to the far tail and "win" on twenty
# sessions, which is a sample-size artefact rather than a filter.
MIN_KEEP = 0.40

# The decision offset. #706 arms entries 14:30-15:45 London = 0-75 minutes past
# the US open, and doc 50's verdict is to "enter as close to 14:30 as the signal
# allows". t0 = 0 has no realised range by construction (doc 50 records it as
# not a measurable cell), so the earliest measurable armed offset is the
# decision offset. The other three are reported as ROBUSTNESS ONLY and carry no
# part of the verdict.
T0_DECISION = 15
T0_ROBUSTNESS = [30, 45, 60]

# What "enough to matter" means, declared before the result. The truncated bars
# doc 50 measured are 4.19 pp (index) and 3.85 pp (single-stock), so 1.00 pp is
# roughly a quarter of the bar — below that, the filter is not worth a code path
# and a rule that can be got wrong at the arming instant.
MATERIAL_PP = 1.00
SIGMA_BAR = 2.0  # kept-vs-dropped difference must clear 2 SE

# ---------------------------------------------------------------------------


def max_drawdown(rs):
    """Peak-to-trough of the cumulative per-trade net-% series, in % points.

    Equal-size trades, summed rather than compounded: the sizing rule (#721)
    recomputes notional off current equity per decision, so a compounded curve
    would price a sizing policy this study does not vary. Reported because
    CLAUDE.md forbids judging a filtered stream against an unfiltered one on
    return alone — the filter changes the trade mix, not just its count.
    """
    peak = 0.0
    cum = 0.0
    worst = 0.0
    for x in rs:
        cum += x
        peak = max(peak, cum)
        worst = min(worst, cum - peak)
    return -worst


def arm(sub, sessions, days, t0):
    """The frozen bracket on a given set of sessions, at a given offset.

    Returns the required accuracy edge and everything needed to judge it. The
    bracket is ADR-0018's declared pair for the subclass, truncated at 16:25 —
    doc 50 established that ADR-0018's untruncated figures are not a comparator
    for anything measured under the flatten.
    """
    lev, cost, tp, sl = sub["lev"], sub["cost"], sub["tp"], sub["recorded_sl"]
    HITS.clear()
    net = simulate(sessions, days, lev, tp, sl, cost, t0=t0, flatten=flatten_at)
    if len(net) < 2:
        return None
    h = dict(HITS)
    s = stats(net)
    width = tp + sl
    e_gross = s["exp"] + cost
    resolved = h.get("tp", 0) + h.get("sl", 0)
    entries = sum(v for k, v in h.items() if k != "no_entry")
    return {
        "n": s["n"],
        "exp": s["exp"],
        "sd": s["sd"],
        "sharpe": s["sharpe"],
        "winrate": s["winrate"],
        "edge": (cost - e_gross) / width * 100.0,
        # se(edge) = se(mean)/width. The width is treated as known — it is
        # frozen here rather than solved, so unlike doc 50's cells this is not
        # an understatement.
        "se": (s["sd"] / math.sqrt(s["n"])) / width * 100.0,
        "resolves": 100.0 * resolved / max(1, entries),
        "dd": max_drawdown(net),
        # Raw drawdown flatters any filter: a stream with half the trades has
        # less time to lose money in. Both normalisations are reported so the
        # "not worse" condition cannot be met by trade count alone.
        "dd_per_trade": max_drawdown(net) / s["n"],
        "dd_norm": (max_drawdown(net) / (s["sd"] * math.sqrt(s["n"]))
                    if s["sd"] > 0 else float("nan")),
        "e_gross": e_gross,
    }


def per_day_net(sub, sessions, days, t0):
    """`day -> net %` for the frozen bracket, one simulate call per session.

    Needed because the nested comparison (KEPT inside UNFILTERED) has no
    closed-form unpaired SE, and a bootstrap over sessions does. It is cheap
    because the required edge is a linear function of the mean:

        bar = (cost - E_gross)/width = (cost - (mean + cost))/width = -mean/width

    so resampling sessions and re-averaging reproduces the statistic exactly,
    with no re-simulation inside the loop.
    """
    lev, cost, tp, sl = sub["lev"], sub["cost"], sub["tp"], sub["recorded_sl"]
    out = {}
    for d in days:
        HITS.clear()
        net = simulate(sessions, [d], lev, tp, sl, cost, t0=t0, flatten=flatten_at)
        if net:
            out[d] = net[0]
    return out


def bootstrap_gain_se(net_by_day, kept_days, width, draws=2000, seed=787):
    """SE of (unfiltered bar - kept bar) by resampling SESSIONS with replacement.

    Sessions are the unit resampled, so the nesting is preserved inside each
    draw: a resample that happens to contain few kept sessions produces a noisy
    kept mean, which is exactly the uncertainty the nesting hides.
    """
    rnd = random.Random(seed)
    days = list(net_by_day)
    kept = set(kept_days)
    if not days:
        return None
    gains = []
    n = len(days)
    for _ in range(draws):
        vals = []
        kvals = []
        for _ in range(n):
            d = days[rnd.randrange(n)]
            v = net_by_day[d]
            vals.append(v)
            if d in kept:
                kvals.append(v)
        if len(kvals) < 2:
            continue
        mean_all = sum(vals) / len(vals)
        mean_kept = sum(kvals) / len(kvals)
        gains.append((mean_kept - mean_all) / width * 100.0)
    if len(gains) < 2:
        return None
    m = sum(gains) / len(gains)
    var = sum((g - m) ** 2 for g in gains) / (len(gains) - 1)
    return math.sqrt(var)


def split_days(days, ratios, theta):
    kept = [d for d in days if d in ratios and ratios[d] >= theta]
    dropped = [d for d in days if d in ratios and ratios[d] < theta]
    return kept, dropped


def solve_theta(sub, sessions, is_days, ratios):
    """Minimise the IN-SAMPLE required edge over the declared grid.

    Returns (theta, table). Ties break to the LOWER theta — the one that gives
    up fewer trades — declared here so a tie cannot be resolved by looking at
    the out-of-sample column.
    """
    n_is = len([d for d in is_days if d in ratios])
    table = []
    best = None
    for theta in THETA_GRID:
        kept, _ = split_days(is_days, ratios, theta)
        keep_frac = len(kept) / max(1, n_is)
        r = arm(sub, sessions, kept, T0_DECISION) if len(kept) >= 30 else None
        admissible = r is not None and keep_frac >= MIN_KEEP
        table.append({"theta": theta, "keep": keep_frac, "r": r, "ok": admissible})
        if admissible and (best is None or r["edge"] < best[1]["edge"] - 1e-12):
            best = (theta, r)
    return (best[0] if best else None), table


def report_arm(label, r):
    if r is None:
        print("      %-22s (too few trades)" % label)
        return
    print("      %-22s n=%4d  bar %6.2f pp +/- %4.2f   E_net %+7.4f%%  sd %5.3f  "
          "resolves %5.1f%%  maxDD %6.2f%% (%.4f/trade, %.2f norm)  Sharpe %+5.2f"
          % (label, r["n"], r["edge"], r["se"], r["exp"], r["sd"],
             r["resolves"], r["dd"], r["dd_per_trade"], r["dd_norm"], r["sharpe"]))


def run(sub):
    sessions = load_sessions(sub["symbol"], sub["tf"])
    days = sorted(sessions)
    is_days = [d for d in days if d.year <= 2022]
    oos_days = [d for d in days if d.year >= 2023]
    lo, hi = entry_window_et(days[-1])

    print("\n=== %s  (%s %s, %d sessions %s..%s)"
          % (sub["label"], sub["symbol"], sub["tf"], len(days), days[0], days[-1]))
    print("    frozen bracket TP %+.2f%% / SL -%.2f%%, truncated at the 16:25 London flatten"
          % (sub["tp"], sub["recorded_sl"]))
    print("    in-sample %d (<=2022)   out-of-sample %d (>=2023)   cost %.2f%%   entry window %d-%d ET"
          % (len(is_days), len(oos_days), sub["cost"], lo, hi))

    ratios = range_ratios(sessions, days, T0_DECISION)
    theta, table = solve_theta(sub, sessions, is_days, ratios)

    print("\n   -- IN-SAMPLE threshold solve at t0=%d (grid of %d, retention floor %.0f%%)"
          % (T0_DECISION, len(THETA_GRID), 100 * MIN_KEEP))
    for row in table:
        r = row["r"]
        flag = "" if row["ok"] else "   (below retention floor)" if r else "   (too few)"
        print("      theta %.2f  keeps %5.1f%%  in-sample bar %s%s"
              % (row["theta"], 100 * row["keep"],
                 ("%6.2f pp" % r["edge"]) if r else "     -",
                 flag))
    if theta is None:
        print("      NO ADMISSIBLE THRESHOLD — filter not measurable on this subclass")
        return None
    print("      SELECTED theta = %.2f  (lowest in-sample bar among admissible)" % theta)

    print("\n   -- OUT-OF-SAMPLE at t0=%d, frozen bracket, %d sessions" % (T0_DECISION, len(oos_days)))
    kept, dropped = split_days(oos_days, ratios, theta)
    all_scored = [d for d in oos_days if d in ratios]
    r_all = arm(sub, sessions, all_scored, T0_DECISION)
    r_kept = arm(sub, sessions, kept, T0_DECISION)
    r_drop = arm(sub, sessions, dropped, T0_DECISION)
    report_arm("UNFILTERED (control)", r_all)
    report_arm("KEPT (ratio >= %.2f)" % theta, r_kept)
    report_arm("DROPPED (ratio < %.2f)" % theta, r_drop)

    verdict = None
    if r_kept and r_drop and r_all:
        gain = r_all["edge"] - r_kept["edge"]
        d_diff = r_drop["edge"] - r_kept["edge"]
        d_se = math.sqrt(r_drop["se"] ** 2 + r_kept["se"] ** 2)
        t = d_diff / d_se if d_se > 0 else 0.0
        keep_frac = r_kept["n"] / max(1, r_all["n"])
        # The declared condition is on drawdown PER TRADE, not raw: raw
        # drawdown falls automatically when the filter removes half the trades,
        # so a raw comparison would pass on trade count alone.
        dd_ok = r_kept["dd_per_trade"] <= r_all["dd_per_trade"]
        width = sub["tp"] + sub["recorded_sl"]
        nets = per_day_net(sub, sessions, all_scored, T0_DECISION)
        g_se = bootstrap_gain_se(nets, kept, width)
        g_t = (gain / g_se) if g_se else 0.0
        print("\n      gain vs unfiltered  %+6.2f pp  +/- %4.2f (bootstrap over sessions,"
              % (gain, g_se if g_se else float("nan")))
        print("                                    2000 draws)   t = %+5.2f" % g_t)
        print("      kept vs dropped     %+6.2f pp  +/- %4.2f   t = %+5.2f   (disjoint sets,"
              % (d_diff, d_se, t))
        print("                                                     so this one does)")
        print("      trades kept %.0f%% of the unfiltered count (%d of %d)"
              % (100 * keep_frac, r_kept["n"], r_all["n"]))
        print("      max drawdown per trade %.4f%% kept vs %.4f%% unfiltered: %s"
              % (r_kept["dd_per_trade"], r_all["dd_per_trade"],
                 "not worse" if dd_ok else "WORSE"))
        print("      (raw maxDD %.2f%% vs %.2f%%; sd-normalised %.2f vs %.2f)"
              % (r_kept["dd"], r_all["dd"], r_kept["dd_norm"], r_all["dd_norm"]))
        material = gain >= MATERIAL_PP
        separable = t >= SIGMA_BAR
        if material and separable and dd_ok:
            verdict = "PASS"
        elif material or separable:
            verdict = "PARTIAL"
        else:
            verdict = "FAIL"
        print("      declared bars: gain >= %.2f pp [%s], t >= %.1f [%s], drawdown not worse [%s]"
              % (MATERIAL_PP, "yes" if material else "no", SIGMA_BAR,
                 "yes" if separable else "no", "yes" if dd_ok else "no"))
        print("      VERDICT (%s): %s" % (sub["label"], verdict))

    print("\n   -- ROBUSTNESS (not decision-bearing): same theta, other armed offsets")
    for t0 in T0_ROBUSTNESS:
        rr = range_ratios(sessions, days, t0)
        k, dp = split_days(oos_days, rr, theta)
        r_a = arm(sub, sessions, [d for d in oos_days if d in rr], t0)
        r_k = arm(sub, sessions, k, t0)
        r_d = arm(sub, sessions, dp, t0)
        if not (r_a and r_k and r_d):
            print("      t0=%-3d  (not measurable)" % t0)
            continue
        print("      t0=%-3d  unfiltered %6.2f pp | kept %6.2f pp (n=%d, keeps %3.0f%%) | "
              "dropped %6.2f pp | gain %+5.2f pp | maxDD %5.2f vs %5.2f"
              % (t0, r_a["edge"], r_k["edge"], r_k["n"],
                 100.0 * r_k["n"] / max(1, r_a["n"]), r_d["edge"],
                 r_a["edge"] - r_k["edge"], r_k["dd"], r_a["dd"]))

    return {"sub": sub, "theta": theta, "all": r_all, "kept": r_kept, "gain_se": g_se,
            "dropped": r_drop, "verdict": verdict,
            "oos_years": (max(oos_days).year - min(oos_days).year) + 1}


def main():
    print("#787 — realised-range session filter, pre-registered")
    print("  rule: trade iff (realised range open->t0) / (trailing 20d mean full range) >= theta")
    print("  one threshold per subclass, solved in-sample on a declared grid of %d,"
          % len(THETA_GRID))
    print("  scored out-of-sample against the SAME frozen bracket on unfiltered sessions.")
    print("  decision offset t0=%d; %s reported as robustness only." % (T0_DECISION, T0_ROBUSTNESS))
    print("  declared bars: gain >= %.2f pp AND kept-vs-dropped t >= %.1f AND drawdown not worse."
          % (MATERIAL_PP, SIGMA_BAR))

    out = [run(sub) for sub in SUBCLASSES]
    out = [o for o in out if o]

    print("\n=== SELECTION ACCOUNTING")
    trials = len(THETA_GRID)
    print("    trials that bear on the verdict: %d per subclass — the theta grid at the single"
          % trials)
    print("    decision offset. The three robustness offsets are reported, not selected on;")
    print("    including them would be %d, and no verdict is taken from them."
          % (trials * (1 + len(T0_ROBUSTNESS))))
    for o in out:
        yrs = o["oos_years"]
        lim = minbtl_limit(yrs)
        print("    %s: %.1f OOS years supports %d independent trials at MinBTL (target Sharpe 1);"
              % (o["sub"]["label"], yrs, lim))
        print("       this study spends %d. %s"
              % (trials, "Within budget." if trials <= lim else "OVER budget — discount accordingly."))

    print("\n=== SUMMARY")
    for o in out:
        print("    %-22s theta %.2f   unfiltered %6.2f pp -> kept %6.2f pp   %s"
              % (o["sub"]["label"], o["theta"], o["all"]["edge"], o["kept"]["edge"],
                 o["verdict"]))


if __name__ == "__main__":
    main()
