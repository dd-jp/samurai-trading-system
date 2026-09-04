"""#787 — is realised range at the arming instant a usable session filter?

Split out of #708. #708 asked whether the *bracket* should be conditioned on
entry time and realised range, and rejected it. This asks the different
question: holding the bracket frozen at ADR-0018 D4's declared geometry, does
**declining to arm at all** on low-realised-range sessions lower the accuracy
bar the signal has to clear, out of sample, by enough to matter?

Everything selected is selected in-sample and applied unchanged out-of-sample.
The bracket is NOT tuned — it is ADR-0018's frozen pair per subclass.

Design notes that matter for reading the output:

* **One arming instant.** #708's five entry offsets were the same ~897 sessions
  shifted by 15 minutes, which is closer to one observation than five. Here the
  pre-registered instant is a single `T0`, and every other offset is reported
  only as fenced post-hoc sensitivity that cannot flip the verdict.
* **Cost cancels from the headline.** `bar = (cost - E_gross)/W`, and both arms
  share `cost` and `W`, so the on/off *delta* is invariant to the 0.18% / 0.41%
  spread assumptions (still a single unmeasured quote each — ADR-0016 Known
  weakness; delivery owned by #1053). It is only the absolute bars that move
  with them.
* **Standard errors are clustered by ET date.** Five single-stock names on the
  same date are one market shock, not five draws. The naive `sd/sqrt(n)` is
  printed beside the clustered figure so the inflation factor is visible.

Usage — fetch once (the cache is gitignored and is never re-fetched), then run:

    export SAMURAI_ENV_FILE=/abs/path/to/.env.local
    export SAMURAI_DATA_DIR=docs/research/data
    for s in SPY QQQ; do python3 docs/research/18-fetch-bars.py $s 2016-01-01 2026-08-01 5Min; done
    for s in AAPL MSTR NVDA PLTR TSLA; do
        python3 docs/research/18-fetch-bars.py $s 2016-01-01 2026-08-01 1Min
    done
    python3 docs/research/51-realised-range-session-filter.py

Reads `<SAMURAI_DATA_DIR>/bars/<SYMBOL>_<TF>.jsonl`, defaulting to
`docs/research/data`, as written by `18-fetch-bars.py`.
"""
import math
import os
import statistics
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
# `18-threshold-study` binds its input root at IMPORT time, so this has to be
# set before the import or the study silently reads an empty directory and
# reports "no sessions loaded".
os.environ.setdefault("SAMURAI_DATA_DIR", os.path.join(HERE, "data"))
sys.path.insert(0, HERE)

_study = __import__("18-threshold-study")
_etb = __import__("18-entry-time-brackets")

simulate = _study.simulate

_SESSION_CACHE = {}


def load_sessions(symbol, tf):
    """Memoised `18-threshold-study.load_sessions` — same result, read once.

    The 1-minute files are ~1M lines each and this study loads every name at
    three arming instants; without the memo the run spends most of its time in
    `json.loads`. Nothing about the parsed result depends on the caller.
    """
    key = (symbol, tf)
    if key not in _SESSION_CACHE:
        _SESSION_CACHE[key] = _study.load_sessions(symbol, tf)
    return _SESSION_CACHE[key]
HITS = _study.HITS
flatten_at = _etb.flatten_at
entry_window_et = _etb.entry_window_et
range_ratios = _etb.range_ratios
tercile_edges = _etb.tercile_edges
minbtl_limit = _etb.minbtl_limit

# ------------------------------------------------------------ pre-registration

# The single arming instant, minutes past the 09:30 ET open. #706's window is
# 14:30-15:45 London, which is t0 in [0, 75]; 30 is its midpoint. Fixed by
# inheritance from #706, not searched.
T0 = 30
# Reported as post-hoc sensitivity ONLY. Excluded from the trial count, and
# stated in the doc as unable to flip the verdict.
T0_SENSITIVITY = [15, 60]

# The rule: arm only if realised range since the open, as a fraction of the
# trailing-20-session mean FULL-session range, is at or above the threshold.
# Candidates are the in-sample quantiles of that ratio at these three cut
# points, frozen as absolute numbers and applied unchanged out of sample.
# Three candidates per subclass, two subclasses = 6 declared trials.
CANDIDATE_QUANTILES = [1.0 / 3.0, 0.5, 2.0 / 3.0]

# Adopt/reject, declared before the result is seen. ALL FOUR must hold.
BAR_MIN_REDUCTION_PP = 1.00   # out-of-sample required-edge reduction
BAR_MIN_T = 2.0               # ... and at least 2x its date-clustered SE
BAR_MIN_TRADE_RETENTION = 0.60  # ... and keeps >=60% of unfiltered trades
# ... and out-of-sample max drawdown is not worse than filter-off.

# ADR-0018 D3/D4: frozen per subclass. NOT tuned here.
INDEX = [("SPY", "5Min"), ("QQQ", "5Min")]
SINGLE = [("AAPL", "1Min"), ("MSTR", "1Min"), ("NVDA", "1Min"),
          ("PLTR", "1Min"), ("TSLA", "1Min")]
SUBCLASSES = [
    {"label": "3x index ETP", "names": INDEX,
     "lev": 3.0, "cost": 0.18, "tp": 2.00, "sl": 2.16},
    {"label": "3x single-stock ETP", "names": SINGLE,
     "lev": 3.0, "cost": 0.41, "tp": 6.00, "sl": 6.25},
]


# ---------------------------------------------------------------- measurement

def per_day(sessions, days, lev, tp, sl, cost, t0, flatten):
    """[(date, net %, outcome)] for the days that produced an entry.

    Implemented by calling `simulate` one day at a time rather than
    reimplementing it, so the per-day series cannot drift from the series #708
    and ADR-0018 were computed on. The equality is asserted by `_self_check`.
    """
    out = []
    for d in days:
        HITS.clear()
        rs = simulate(sessions, [d], lev, tp, sl, cost, t0=t0, flatten=flatten)
        if not rs:
            continue
        h = dict(HITS)
        outcome = ("tp" if h.get("tp") else "sl" if h.get("sl") else "close")
        out.append((d, rs[0], outcome))
    return out


def _self_check(sessions, days, lev, tp, sl, cost, t0, flatten):
    HITS.clear()
    bulk = simulate(sessions, days, lev, tp, sl, cost, t0=t0, flatten=flatten)
    rows = per_day(sessions, days, lev, tp, sl, cost, t0, flatten)
    assert [r[1] for r in rows] == bulk, "per-day series diverges from simulate()"


def clustered_se(values, keys):
    """SE of the mean, clustering on `keys` (one cluster per ET date).

    Var(mean) = (1/n^2) * sum_d ( sum_{i in d} (x_i - xbar) )^2.
    """
    n = len(values)
    if n < 2:
        return float("nan")
    m = sum(values) / n
    agg = defaultdict(float)
    for v, k in zip(values, keys):
        agg[k] += v - m
    var = sum(a * a for a in agg.values()) / (n * n)
    return math.sqrt(var)


def max_drawdown(trades, calendar, drift_removed=False):
    """Max peak-to-trough of the cumulative per-session portfolio return, in pp.

    One portfolio return per calendar session — the equal-weight mean over the
    names that traded that session, and 0 on sessions the arm did not trade, so
    both arms are measured over the SAME calendar. Simple sum, not compounded:
    this is a required-edge study, not a sizing study, and D5 owns compounding.

    `drift_removed` subtracts each arm's own mean session return first. Added
    as a DIAGNOSTIC after the first run, and disclosed as such in the doc: the
    raw figure on this tape is not a dispersion measure at all. Unconditional
    entry at the declared bracket has negative expectancy by construction — the
    whole point of ADR-0018's bar is that the signal has to supply the edge — so
    the raw equity curve declines almost monotonically and its max drawdown is
    just (trades x mean loss). Any filter that trades less therefore "wins" on
    raw drawdown automatically. Adopt condition 3 is scored on the raw figure as
    pre-registered; the drift-removed figure is reported beside it so a reader
    can see that the pre-registered condition is close to vacuous here.
    """
    by_date = defaultdict(list)
    for d, net, _ in trades:
        by_date[d].append(net)
    daily = [(sum(by_date[d]) / len(by_date[d])) if d in by_date else 0.0
             for d in calendar]
    if drift_removed and daily:
        mu = sum(daily) / len(daily)
        daily = [x - mu for x in daily]
    cum = 0.0
    peak = 0.0
    dd = 0.0
    for x in daily:
        cum += x
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
    return dd


def arm_stats(trades, calendar, cost, width):
    n = len(trades)
    if n == 0:
        return None
    nets = [t[1] for t in trades]
    dates = [t[0] for t in trades]
    mean = sum(nets) / n
    e_gross = mean + cost
    bar = (cost - e_gross) / width * 100.0
    sd = statistics.stdev(nets) if n > 1 else 0.0
    se_naive = (sd / math.sqrt(n)) / width * 100.0
    se_clu = clustered_se(nets, dates) / width * 100.0
    resolved = sum(1 for t in trades if t[2] in ("tp", "sl"))
    return {
        "n": n, "sessions": len(set(dates)), "e_net": mean, "e_gross": e_gross,
        "bar": bar, "sd": sd, "se_naive": se_naive, "se_clustered": se_clu,
        "resolve": 100.0 * resolved / n,
        "dd": max_drawdown(trades, calendar),
        "dd_dr": max_drawdown(trades, calendar, drift_removed=True),
    }


def gap(armed, unarmed, width, w):
    """(bar reduction in pp, its clustered SE) from the armed-vs-unarmed gap.

    The filter-on arm is a SUBSET of filter-off, so the two bars are not
    independent and differencing their SEs is wrong. The identity

        bar_off - bar_on = (1 - w) * (E_armed - E_unarmed) / width * 100

    (w = armed fraction) reduces the headline to a two-sample gross-expectancy
    gap between disjoint sets, whose cluster-robust SE is exact arithmetic.
    """
    if not armed or not unarmed:
        return float("nan"), float("nan")
    a = [t[1] for t in armed]
    u = [t[1] for t in unarmed]
    ma, mu = sum(a) / len(a), sum(u) / len(u)
    sa = clustered_se(a, [t[0] for t in armed])
    su = clustered_se(u, [t[0] for t in unarmed])
    k = (1.0 - w) / width * 100.0
    return k * (ma - mu), k * math.sqrt(sa * sa + su * su)


# ------------------------------------------------------------------- the study

def load_subclass(sub, t0):
    """Per-name (sessions, days, ratios) plus the pooled trade table at `t0`."""
    data = {}
    for sym, tf in sub["names"]:
        sessions = load_sessions(sym, tf)
        days = sorted(sessions)
        if not days:
            raise SystemExit("no sessions for %s %s - fetch bars first" % (sym, tf))
        data[sym] = {
            "tf": tf, "sessions": sessions, "days": days,
            "ratios": range_ratios(sessions, days, t0),
        }
    return data


def trade_table(sub, data, t0):
    """[(date, net, outcome, symbol, ratio)] over every name, declared bracket."""
    rows = []
    for sym, d in data.items():
        for day, net, outcome in per_day(d["sessions"], d["days"], sub["lev"],
                                         sub["tp"], sub["sl"], sub["cost"],
                                         t0, flatten_at):
            r = d["ratios"].get(day)
            if r is None:
                continue  # inside the 20-session warm-up: the rule is undefined
            rows.append((day, net, outcome, sym, r))
    rows.sort(key=lambda r: (r[0], r[3]))
    return rows


def split(rows):
    return ([r for r in rows if r[0].year <= 2022],
            [r for r in rows if r[0].year >= 2023])


def report_arm(tag, s):
    if s is None:
        print("      %-12s (no trades)" % tag)
        return
    print("      %-12s n=%-5d sessions=%-5d  bar %6.2f pp  (clustered SE %.2f, "
          "naive %.2f)  resolves %5.1f%%  maxDD %7.2f pp (drift-removed %6.2f)  "
          "E_net %+.4f%%  sd %.2f%%"
          % (tag, s["n"], s["sessions"], s["bar"], s["se_clustered"],
             s["se_naive"], s["resolve"], s["dd"], s["dd_dr"], s["e_net"], s["sd"]))


def run(sub):
    width = sub["tp"] + sub["sl"]
    cost = sub["cost"]
    print("\n" + "=" * 78)
    print("=== %s   declared bracket TP %+.2f%% / SL -%.2f%%  (frozen, ADR-0018 D4)"
          % (sub["label"], sub["tp"], sub["sl"]))
    print("    cost %.2f%%  width %.2f%%  arming instant t0=%d min past the US open"
          % (cost, width, T0))

    data = load_subclass(sub, T0)
    for sym, d in sorted(data.items()):
        is_n = sum(1 for x in d["days"] if x.year <= 2022)
        print("    %-5s %-5s %5d sessions %s..%s   IS %4d  OOS %4d"
              % (sym, d["tf"], len(d["days"]), d["days"][0], d["days"][-1],
                 is_n, len(d["days"]) - is_n))

    # One self-check per subclass: the per-day decomposition must reproduce the
    # bulk series exactly, or every number below is measuring something else.
    first = sorted(data)[0]
    _self_check(data[first]["sessions"], data[first]["days"], sub["lev"],
                sub["tp"], sub["sl"], cost, T0, flatten_at)
    print("    per-day decomposition reproduces simulate() exactly on %s: PASS" % first)

    rows = trade_table(sub, data, T0)
    is_rows, oos_rows = split(rows)
    calendar_is = sorted({r[0] for r in is_rows})
    calendar_oos = sorted({r[0] for r in oos_rows})
    print("    trade-name-days: IS %d over %d sessions, OOS %d over %d sessions"
          % (len(is_rows), len(calendar_is), len(oos_rows), len(calendar_oos)))

    # ---- candidate thresholds, frozen on the in-sample ratio distribution
    is_ratios = sorted(r[4] for r in is_rows)
    thetas = [is_ratios[int(q * len(is_ratios))] for q in CANDIDATE_QUANTILES]
    print("\n   -- CANDIDATE THRESHOLDS (in-sample quantiles of the ratio, frozen)")
    for q, th in zip(CANDIDATE_QUANTILES, thetas):
        print("      q=%.3f -> arm when realised range >= %.4f x the trailing-20-session "
              "mean full-session range" % (q, th))

    print("\n   -- IN-SAMPLE (<=2022): the threshold is chosen here, on this criterion only")
    print("      criterion: lowest required edge (equivalently, highest E_gross). Bracket fixed.")
    off_is = [(r[0], r[1], r[2]) for r in is_rows]
    s_off_is = arm_stats(off_is, calendar_is, cost, width)
    report_arm("filter OFF", s_off_is)
    best = None
    for th in thetas:
        on = [(r[0], r[1], r[2]) for r in is_rows if r[4] >= th]
        un = [(r[0], r[1], r[2]) for r in is_rows if r[4] < th]
        s = arm_stats(on, calendar_is, cost, width)
        if s is None:
            continue
        w = len(on) / len(is_rows)
        red, se = gap(on, un, width, w)
        print("      theta %.4f  keeps %4.1f%% of trades" % (th, 100.0 * w))
        report_arm("  ON", s)
        print("        IS bar reduction %+.2f pp  clustered SE %.2f  t %+.2f"
              % (red, se, red / se if se == se and se > 0 else float("nan")))
        if best is None or s["bar"] < best[1]["bar"]:
            best = (th, s, w, red, se)
    if best is None:
        print("      no candidate produced in-sample trades - nothing to freeze")
        return None
    theta, s_on_is, w_is, red_is, se_red_is = best
    print("      -> FROZEN: theta = %.4f  (in-sample bar %.2f pp against %.2f pp unfiltered)"
          % (theta, s_on_is["bar"], s_off_is["bar"]))

    # ---- minimum detectable effect, computed BEFORE the OOS arm is scored
    # 80% power, two-sided 5%: |effect| must exceed 2.802 * SE.
    mde_is = 2.802 * se_red_is
    need_gap = BAR_MIN_REDUCTION_PP * width / 100.0 / max(1e-9, 1.0 - w_is)
    print("\n   -- MINIMUM DETECTABLE EFFECT (from the in-sample dispersion, pre-OOS)")
    print("      a %.2f pp bar reduction requires an armed-vs-unarmed gross gap of "
          "%.4f%%/trade" % (BAR_MIN_REDUCTION_PP, need_gap))
    print("      in-sample clustered SE of the reduction is %.2f pp, so the smallest "
          "reduction" % se_red_is)
    print("      this design can detect at 80%% power / 5%% two-sided is %.2f pp" % mde_is)
    if mde_is > BAR_MIN_REDUCTION_PP:
        print("      NOTE: the MDE EXCEEDS the adopt bar. A true %.2f pp effect would more "
              "often" % BAR_MIN_REDUCTION_PP)
        print("      than not fail to register, so a null result here is 'not measured', "
              "not 'nothing there'.")
    else:
        print("      the MDE sits below the adopt bar, so a true effect of adopt-bar size "
              "is detectable.")

    # ---- out of sample, threshold applied unchanged
    print("\n   -- OUT OF SAMPLE (>=2023), theta = %.4f applied unchanged" % theta)
    off_oos = [(r[0], r[1], r[2]) for r in oos_rows]
    on_oos = [(r[0], r[1], r[2]) for r in oos_rows if r[4] >= theta]
    un_oos = [(r[0], r[1], r[2]) for r in oos_rows if r[4] < theta]
    s_off = arm_stats(off_oos, calendar_oos, cost, width)
    s_on = arm_stats(on_oos, calendar_oos, cost, width)
    report_arm("filter OFF", s_off)
    report_arm("filter ON", s_on)
    w_oos = len(on_oos) / max(1, len(oos_rows))
    red, se_red = gap(on_oos, un_oos, width, w_oos)
    t = red / se_red if se_red == se_red and se_red > 0 else float("nan")
    print("      armed fraction %.1f%%   E_gross armed %+.4f%%  unarmed %+.4f%%"
          % (100.0 * w_oos,
             (sum(x[1] for x in on_oos) / len(on_oos) + cost) if on_oos else float("nan"),
             (sum(x[1] for x in un_oos) / len(un_oos) + cost) if un_oos else float("nan")))
    print("      BAR REDUCTION %+.4f pp   clustered SE %.4f   t %+.3f" % (red, se_red, t))
    if s_on and s_off:
        # Cross-check: the identity above must reproduce the differenced bars.
        assert abs((s_off["bar"] - s_on["bar"]) - red) < 1e-6, "gap identity broken"

    print("\n   -- VERDICT against the pre-declared bar")
    c1 = red >= BAR_MIN_REDUCTION_PP
    c2 = (se_red == se_red and se_red > 0 and red / se_red >= BAR_MIN_T)
    c3 = bool(s_on and s_off and s_on["dd"] <= s_off["dd"])
    c4 = w_oos >= BAR_MIN_TRADE_RETENTION
    print("      (1) reduction >= %.2f pp                : %-5s (%+.2f pp)"
          % (BAR_MIN_REDUCTION_PP, "PASS" if c1 else "FAIL", red))
    # Three decimals deliberately. The single-stock arm lands at t = +1.996 and
    # rounds to "+2.00" at two, which reads as a PASS beside a 2.0 threshold it
    # does not actually clear. A threshold that can be crossed by rounding is
    # not a threshold, and the printed figure has to show that.
    print("      (2) reduction >= %.1f x clustered SE     : %-5s (t %+.3f)"
          % (BAR_MIN_T, "PASS" if c2 else "FAIL", t))
    print("      (3) max drawdown not worse              : %-5s (%.2f on vs %.2f off pp;"
          % ("PASS" if c3 else "FAIL",
             s_on["dd"] if s_on else float("nan"), s_off["dd"] if s_off else float("nan")))
    print("          drift-removed %.2f on vs %.2f off — see the note on max_drawdown:"
          % (s_on["dd_dr"] if s_on else float("nan"),
             s_off["dd_dr"] if s_off else float("nan")))
    print("          the raw form rewards trading less on a negative-expectancy tape)")
    print("      (4) keeps >= %.0f%% of trades             : %-5s (%.1f%%)"
          % (100 * BAR_MIN_TRADE_RETENTION, "PASS" if c4 else "FAIL", 100.0 * w_oos))
    verdict = "ADOPT" if (c1 and c2 and c3 and c4) else "REJECT"
    print("      => %s" % verdict)

    return {"sub": sub, "theta": theta, "red": red, "se": se_red, "t": t,
            "on": s_on, "off": s_off, "w": w_oos, "verdict": verdict,
            "data": data, "rows": rows, "mde": mde_is,
            "years": (rows[-1][0] - rows[0][0]).days / 365.25}


# ------------------------------------------------- fenced post-hoc sensitivity

def sensitivity(sub, theta_quantile_idx):
    """Same rule at other arming instants. Post-hoc, excluded from the trials.

    Directly tests #708's unexplained collapse at t0=60: if the effect here
    moves the same way with no mechanism, that is evidence for sampling noise;
    if it does not, that is evidence #708's collapse was noise.
    """
    width = sub["tp"] + sub["sl"]
    print("\n   -- SENSITIVITY (post-hoc, NOT in the trial count, cannot flip the verdict)")
    for t0 in T0_SENSITIVITY:
        data = load_subclass(sub, t0)
        rows = trade_table(sub, data, t0)
        is_rows, oos_rows = split(rows)
        if not is_rows or not oos_rows:
            continue
        is_ratios = sorted(r[4] for r in is_rows)
        th = is_ratios[int(CANDIDATE_QUANTILES[theta_quantile_idx] * len(is_ratios))]
        on = [(r[0], r[1], r[2]) for r in oos_rows if r[4] >= th]
        un = [(r[0], r[1], r[2]) for r in oos_rows if r[4] < th]
        w = len(on) / len(oos_rows)
        red, se = gap(on, un, width, w)
        print("      t0=%-3d theta %.4f  armed %4.1f%%  OOS bar reduction %+.2f pp  "
              "clustered SE %.2f  t %+.2f"
              % (t0, th, 100.0 * w, red, se, red / se if se > 0 else float("nan")))


# ------------------------------------------------------- #708 reproduction check

def reproduce_708(sub):
    """#708's published cells, recomputed: TSLA only, declared bracket, terciles.

    The issue's table is the DECLARED bracket's required edge on each tercile's
    own out-of-sample sessions — the `bar` column of `18-entry-time-brackets.py`,
    not its re-solved-stop `edge` column. That is the quantity recomputed here,
    so the comparison is like for like.
    """
    if sub["label"] != "3x single-stock ETP":
        return
    print("\n   -- #708 REPRODUCTION (TSLA only, declared bracket, IS-frozen terciles)")
    print("      published: t0=15 quiet 6.42 / busy -0.09 | 30: 8.83 / 1.20 | "
          "45: 7.48 / 1.17 | 60: 2.75 / 1.72")
    sessions = load_sessions("TSLA", "1Min")
    days = sorted(sessions)
    is_days = [d for d in days if d.year <= 2022]
    for t0 in (15, 30, 45, 60):
        ratios = range_ratios(sessions, days, t0)
        edges = tercile_edges(ratios, is_days)
        if not edges:
            continue
        line = []
        for name, sel in (("quiet", lambda r: r <= edges[0]),
                          ("busy", lambda r: r > edges[1])):
            ds = [d for d in days if d.year >= 2023 and d in ratios and sel(ratios[d])]
            HITS.clear()
            net = simulate(sessions, ds, sub["lev"], sub["tp"], sub["sl"],
                           sub["cost"], t0=t0, flatten=flatten_at)
            if not net:
                line.append("%s n/a" % name)
                continue
            h = dict(HITS)
            e_gross = sum(net) / len(net) + sub["cost"]
            bar = (sub["cost"] - e_gross) / (sub["tp"] + sub["sl"]) * 100.0
            res = 100.0 * (h.get("tp", 0) + h.get("sl", 0)) / max(1, sum(
                v for k, v in h.items() if k != "no_entry"))
            line.append("%s %.2f pp (n=%d, resolves %.1f%%)" % (name, bar, len(net), res))
        print("      t0=%-3d %s" % (t0, "   ".join(line)))


def main():
    results = []
    for sub in SUBCLASSES:
        r = run(sub)
        if r is None:
            continue
        sensitivity(sub, CANDIDATE_QUANTILES.index(
            min(CANDIDATE_QUANTILES, key=lambda q: abs(q - 0.5))))
        reproduce_708(sub)
        results.append(r)

    print("\n" + "=" * 78)
    print("=== TRIAL ACCOUNTING")
    declared = len(CANDIDATE_QUANTILES) * len(SUBCLASSES)
    print("   declared trials: %d thresholds x %d subclasses = %d"
          % (len(CANDIDATE_QUANTILES), len(SUBCLASSES), declared))
    print("   NOT trials: the bracket (frozen, ADR-0018 D4), the arming instant")
    print("   (t0=%d, inherited from #706's window midpoint), the 20-session lookback" % T0)
    print("   (inherited from 18-entry-time-brackets.py), the IS/OOS split (inherited")
    print("   from 18-threshold-study.py), and the selection criterion (declared above).")
    print("   The t0 sensitivity rows are post-hoc and are excluded by construction.")
    if results:
        years = max(r["years"] for r in results)
        print("   sample %.1f years -> MinBTL supports %d independent trials"
              % (years, minbtl_limit(years)))
        print("   %s" % ("within budget" if declared <= minbtl_limit(years)
                         else "EXCEEDS the budget"))
    print("\n=== SUMMARY")
    for r in results:
        print("   %-22s theta %.4f  armed %4.1f%%  trades %d -> %d  bar %.2f -> %.2f pp  "
              "reduction %+.2f (clustered SE %.2f, t %+.2f)  maxDD %.1f -> %.1f pp "
              "(drift-removed %.1f -> %.1f)  MDE %.2f pp  %s"
              % (r["sub"]["label"], r["theta"], 100.0 * r["w"],
                 r["off"]["n"], r["on"]["n"],
                 r["off"]["bar"], r["on"]["bar"], r["red"], r["se"], r["t"],
                 r["off"]["dd"], r["on"]["dd"], r["off"]["dd_dr"], r["on"]["dd_dr"],
                 r["mde"], r["verdict"]))


if __name__ == "__main__":
    main()
