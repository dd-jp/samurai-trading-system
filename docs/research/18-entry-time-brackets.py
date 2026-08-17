"""#708 R2 — entry-time-conditional bracket schedule, and the ladder rider.

Two questions, one run.

**(1) The brackets were derived for the wrong entry time.** ADR-0018's neutral
brackets assume entry at the 09:30 ET open. The system enters mid-session on a
signal, inside the 14:30-15:45 London window recorded on #706, and flattens at
16:25 London. Doc 18 flags this as its own limitation. This script re-solves the
neutral bracket conditional on entry offset `t0` and on how much of the day's
usual range has already been realised at that instant.

**(2) The ladder's bar is unmeasured.** #704 withdrew the 4.60 pp width-formula
figure. The rider measures the 50/25/25 tranche vector over a shared stop against
the single bracket, **both under the 16:25 truncation**, which is the ladder's
actual justification and is absent from ADR-0018's derivation entirely.

Nothing is selected. The bracket rule ("stop such that take-profit and stop are
equally likely to be hit first") is declared and unchanged; only the sample it is
solved on changes. That is ADR-0018 D4's re-calibration, not re-selection.

Usage:

    SAMURAI_DATA_DIR=/tmp/adr18 python3 docs/research/18-entry-time-brackets.py

Reads `<SAMURAI_DATA_DIR>/bars/{SPY_5Min,TSLA_1Min}.jsonl`, as written by
`18-fetch-bars.py`.
"""
import math
import os
import statistics
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_study = __import__("18-threshold-study")
load_sessions = _study.load_sessions
simulate = _study.simulate
stats = _study.stats
HITS = _study.HITS
ET = _study.ET

LONDON = ZoneInfo("Europe/London")
US_OPEN = 9 * 60 + 30  # ET minutes

# #706: entries armed 14:30-15:45 London, flatten 16:25 London (the LSE close
# less #657's five minutes). Held in London wall-clock and converted per date,
# because the UK and US switch daylight saving on different weekends — for about
# three weeks a year the offset is four or six hours, not five, and a hardcoded
# ET minute would silently move the flatten inside the session on those days.
ENTRY_OPEN_LONDON = (14, 30)
ENTRY_LAST_LONDON = (15, 45)
FLATTEN_LONDON = (16, 25)

T0_GRID = [0, 15, 30, 45, 60, 90, 120]  # minutes past the US open
TERCILES = ["quiet", "normal", "busy"]  # realised range so far vs its 20-day norm
RANGE_LOOKBACK = 20

EULER_MASCHERONI = 0.5772156649015329
MINBTL_TARGET_ANNUAL_SHARPE = 1

SUBCLASSES = [
    {
        "label": "3x index ETP",
        "symbol": "SPY",
        "tf": "5Min",
        "lev": 3.0,
        "cost": 0.18,
        "tp": 2.00,
        # ADR-0018's recorded row, reproduced as the control (doc 18 Result 4).
        "recorded_sl": 2.16,
        "recorded_resolves": 48.8,
        "recorded_edge": 4.33,
    },
    {
        "label": "3x single-stock ETP",
        "symbol": "TSLA",
        "tf": "1Min",
        "lev": 3.0,
        "cost": 0.41,
        "tp": 6.00,
        "recorded_sl": 6.25,
        "recorded_resolves": 71.6,
        "recorded_edge": 3.35,
    },
]

# The ladder #704 resolved, and the single bracket that is its control. Both run
# under the same forced close: comparing a truncated ladder against ADR-0018's
# untruncated single bracket would confound the ladder with the truncation and
# could not test the claim #704 rests on.
LADDER = [(0.50, 1.00), (0.25, 2.00), (0.25, 3.00)]
LADDER_STOP = 2.16
DEAD_STOP = 0.50  # #654's -0.5% stop, whose >=8.00 pp bound was never measured


def london_minutes_in_et(d, hh, mm):
    """A London wall-clock time, as an ET minute-of-day on that date."""
    t = datetime(d.year, d.month, d.day, hh, mm, tzinfo=LONDON).astimezone(ET)
    return t.hour * 60 + t.minute


def flatten_at(d):
    return london_minutes_in_et(d, *FLATTEN_LONDON)


def entry_window_et(d):
    return (london_minutes_in_et(d, *ENTRY_OPEN_LONDON),
            london_minutes_in_et(d, *ENTRY_LAST_LONDON))


# ---------------------------------------------------------------- the control

def control(sub, sessions, days):
    """`t0 = 0` must reproduce ADR-0018 exactly. Asserted, not eyeballed.

    The check that matters is not "the numbers look similar" but that the new
    parameterised code path returns the *same list* as the old one. Passing
    `flatten=` forces the new filtering branch; `t0 = 0` with a flatten past the
    close must therefore be element-wise identical to an unparameterised call.
    """
    tp, sl = sub["tp"], sub["recorded_sl"]
    HITS.clear()
    baseline = simulate(sessions, days, sub["lev"], tp, sl, sub["cost"])
    base_hits = dict(HITS)
    HITS.clear()
    reparam = simulate(sessions, days, sub["lev"], tp, sl, sub["cost"],
                       t0=0, flatten=lambda d: 24 * 60)
    assert baseline == reparam, "t0=0 regression: the new path changed the series"
    assert dict(HITS) == base_hits, "t0=0 regression: outcome counts changed"

    s = stats(baseline)
    tot = sum(base_hits.values())
    resolves = 100.0 * (base_hits.get("tp", 0) + base_hits.get("sl", 0)) / tot
    edge = sub["cost"] / (tp + sl) * 100.0
    print("   CONTROL t0=0, no truncation, TP %+.2f / SL -%.2f" % (tp, sl))
    print("      series identical to the unparameterised call: PASS (n=%d)" % s["n"])
    print("      resolves %.1f%%  (doc 18 records %.1f%%)   closes out %.1f%%"
          % (resolves, sub["recorded_resolves"], 100.0 - resolves))
    print("      accuracy edge needed %.2f pp  (doc 18 records %.2f pp)  [ALGEBRA, not a test:"
          % (edge, sub["recorded_edge"]))
    print("      cost/(tp+sl) over three declared constants cannot disagree with the ADR]")
    print("      P(tp first) %.1f%%   P(sl first) %.1f%%   exp %+.4f%%/trade"
          % (100.0 * base_hits.get("tp", 0) / tot, 100.0 * base_hits.get("sl", 0) / tot,
             s["exp"]))
    # Be precise about what this control does and does not establish. Two of the
    # three printed lines are genuine checks; the third is arithmetic.
    #   - the reparam assert above IS a real regression test: it proves adding
    #     t0/flatten left the untruncated series byte-identical.
    #   - `resolves` IS data-dependent, and it is the only line that CAN
    #     disagree with the record. On the index it does: 48.7 measured against
    #     48.8 recorded, admitted by the 0.15 pp tolerance below.
    #   - `edge` is cost/(tp+sl) over constants. It returns the recorded figure
    #     unconditionally and verifies nothing. It is printed for the reader,
    #     and deliberately NOT counted as a reproduction.
    resolves_ok = abs(resolves - sub["recorded_resolves"]) <= 0.15
    ok = resolves_ok
    print("      resolves fraction matches the record to within 0.15 pp: %s (delta %+.2f pp)"
          % ("YES" if resolves_ok else "NO", resolves - sub["recorded_resolves"]))
    return ok


# -------------------------------------------------- conditioning on the range

def range_ratios(sessions, days, t0):
    """Realised range at entry, over the trailing 20-day mean full-session range.

    Both legs are underlying-terms percentages of that session's open, so the
    leverage factor cancels and the ratio is comparable across subclasses. The
    denominator is strictly prior sessions — a same-day or forward-looking norm
    would leak the very thing the tercile is meant to condition on.
    """
    full = {}
    for d in days:
        bars = sessions[d]
        o = bars[0][1]
        if o <= 0:
            continue
        full[d] = (max(b[2] for b in bars) - min(b[3] for b in bars)) / o * 100.0

    out = {}
    hist = []
    for d in days:
        if d not in full:
            continue
        if len(hist) >= RANGE_LOOKBACK:
            norm = sum(hist[-RANGE_LOOKBACK:]) / RANGE_LOOKBACK
            bars = sessions[d]
            o = bars[0][1]
            prior = [b for b in bars if b[0] < US_OPEN + t0]
            if norm > 0:
                sofar = ((max(b[2] for b in prior) - min(b[3] for b in prior)) / o * 100.0
                         if prior else 0.0)
                out[d] = sofar / norm
        hist.append(full[d])
    return out


def tercile_edges(ratios, is_days):
    """Boundaries frozen on the in-sample days, then applied to out-of-sample.

    Re-cutting terciles on the out-of-sample set would let the boundaries move to
    whatever the later sample happens to contain, which is a free parameter fitted
    on the data the result is meant to be judged against.
    """
    vals = sorted(ratios[d] for d in is_days if d in ratios)
    if len(vals) < 30:
        return None
    return (vals[len(vals) // 3], vals[2 * len(vals) // 3])


def bucket(ratio, edges):
    if ratio <= edges[0]:
        return "quiet"
    if ratio <= edges[1]:
        return "normal"
    return "busy"


# ------------------------------------------------------------ neutral bracket

def neutral_stop(sessions, days, lev, tp, cost, t0, flatten, lo=0.10, hi=25.0):
    """Stop at which P(take-profit first) == P(stop first). Bisection, not a grid.

    Monotone in the stop: widening it can only convert stop-first outcomes into
    take-profit-first or close-out ones, so P(tp) - P(sl) is non-decreasing and
    bisection is exact up to the resolution of the tape.
    """
    def imbalance(sl):
        HITS.clear()
        simulate(sessions, days, lev, tp, sl, cost, t0=t0, flatten=flatten)
        return HITS.get("tp", 0) - HITS.get("sl", 0), dict(HITS)

    lo_v, _ = imbalance(lo)
    hi_v, _ = imbalance(hi)
    if lo_v > 0 or hi_v < 0:
        return None, None  # not bracketed: no neutral stop exists on this sample
    for _ in range(40):
        mid = (lo + hi) / 2.0
        v, h = imbalance(mid)
        if v < 0:
            lo = mid
        else:
            hi = mid
    sl = (lo + hi) / 2.0
    _, h = imbalance(sl)
    return sl, h


# ------------------------------------------------------------------ the rider

def simulate_ladder(sessions, days, lev, tranches, sl_pct, cost_pct, t0=0, flatten=None):
    """Tranche vector over a shared stop. Returns (net % list, per-tranche gross).

    Same conventions as `simulate`: a bar spanning both levels resolves as the
    stop, and an unresolved tranche closes at market at the flatten instant. Cost
    is charged once on full notional — spread is proportional to the notional
    traded and the ISA carries no per-fill commission, so splitting the exit into
    three fills does not multiply it. That assumption favours the ladder, and is
    the one to revisit if the ladder wins narrowly.
    """
    start = US_OPEN + t0
    out = []
    per = [[] for _ in tranches]
    for d in days:
        bars = sessions[d]
        end = flatten(d) if flatten is not None else 24 * 60
        bars = [b for b in bars if start <= b[0] < end]
        if not bars:
            continue
        o = bars[0][1]
        if o <= 0:
            continue
        sl_price = o * (1 - sl_pct / lev / 100.0)
        open_idx = list(range(len(tranches)))
        res = [None] * len(tranches)
        for _, _bo, h, l, c in bars:
            if l <= sl_price:
                for i in open_idx:
                    res[i] = -sl_pct
                open_idx = []
                break
            still = []
            for i in open_idx:
                tp = tranches[i][1]
                if h >= o * (1 + tp / lev / 100.0):
                    res[i] = tp
                else:
                    still.append(i)
            open_idx = still
            if not open_idx:
                break
        if open_idx:
            mark = lev * (bars[-1][4] / o - 1) * 100.0
            for i in open_idx:
                res[i] = mark
        for i, r in enumerate(res):
            per[i].append(r)
        out.append(sum(w * r for (w, _), r in zip(tranches, res)) - cost_pct)
    return out, per


# --------------------------------------------------------------------- MinBTL

def minbtl_years(n_trials):
    """Years of data N independent trials need. Mirrors `overfitting.ts:238`."""
    if n_trials <= 1:
        return 0.0
    nd = statistics.NormalDist()
    term = ((1 - EULER_MASCHERONI) * nd.inv_cdf(1 - 1.0 / n_trials)
            + EULER_MASCHERONI * nd.inv_cdf(1 - 1.0 / (n_trials * math.e)))
    return term ** 2 / MINBTL_TARGET_ANNUAL_SHARPE ** 2


def minbtl_limit(years):
    n = 1
    while minbtl_years(n + 1) <= years:
        n += 1
    return n


# ---------------------------------------------------------------------- report

def run(sub):
    sessions = load_sessions(sub["symbol"], sub["tf"])
    days = sorted(sessions)
    is_days = [d for d in days if d.year <= 2022]
    oos_days = [d for d in days if d.year >= 2023]
    lev, cost, tp = sub["lev"], sub["cost"], sub["tp"]

    print("\n=== %s  (%s %s, %d sessions %s..%s)"
          % (sub["label"], sub["symbol"], sub["tf"], len(days), days[0], days[-1]))
    print("    in-sample %d (<=2022)   out-of-sample %d (>=2023)   cost %.2f%%"
          % (len(is_days), len(oos_days), cost))
    lo, hi = entry_window_et(days[-1])
    print("    entry window %d-%d ET, flatten %d ET (London 14:30-15:45 / 16:25 on %s)"
          % (lo, hi, flatten_at(days[-1]), days[-1]))

    ok = control(sub, sessions, days)

    print("\n   -- CELLS: neutral bracket re-solved per (t0, range tercile)")
    print("      take-profit held at the declared %+.2f%%; only the stop is re-solved."
          % tp)
    print("      `n` counts TRADES, not days: past the flatten there is no entry at all,")
    print("      and `entered` reports what fraction of the cell's sessions produced one.")
    print("      `bar` is the DECLARED bracket on that cell's own sessions at that cell's own")
    print("      offset, so `vs bar` varies only the bracket — not the slice, not truncation.")
    print("      %-4s %-7s %5s %8s %7s %8s %8s %7s %6s %7s %6s"
          % ("t0", "tercile", "n", "entered", "stop", "resolves", "edge pp", "+/- SE",
             "bar", "vs bar", "in win"))
    rows = []
    for t0 in T0_GRID:
        ratios = range_ratios(sessions, days, t0)
        edges = tercile_edges(ratios, is_days)
        in_window = t0 <= (hi - lo)
        buckets = {}
        if edges and t0 > 0:
            for t in TERCILES:
                buckets[t] = []
            for d in days:
                if d in ratios:
                    buckets[bucket(ratios[d], edges)].append(d)
        # The pooled marginal is reported alongside the terciles: it is the same
        # declared grid collapsed over one axis, and it is the only version with
        # enough trades per cell to separate anything (see the SE column).
        buckets["POOLED"] = list(days)
        if t0 == 0:
            # No bars have elapsed at the open, so realised range is identically
            # zero and the tercile is undefined by construction, not by sample.
            buckets = {"POOLED": list(days)}
        for name in list(buckets):
            ds = buckets[name]
            ds_is = [d for d in ds if d.year <= 2022]
            ds_oos = [d for d in ds if d.year >= 2023]
            sl, h = neutral_stop(sessions, ds_is, lev, tp, cost, t0, flatten_at)
            entries_is = sum(v for k, v in (h or {}).items() if k != "no_entry")
            if sl is None or entries_is < 60:
                print("      %-4d %-7s %5d   (too few in-sample entries to solve: %d of %d sessions)"
                      % (t0, name, entries_is, entries_is, len(ds_is)))
                continue
            HITS.clear()
            rs = simulate(sessions, ds_oos, lev, tp, sl, cost, t0=t0, flatten=flatten_at)
            hh = dict(HITS)
            tot = max(1, sum(v for k, v in hh.items() if k != "no_entry"))
            if not rs:
                print("      %-4d %-7s %5d   (no out-of-sample entries)" % (t0, name, 0))
                continue
            resolves = 100.0 * (hh.get("tp", 0) + hh.get("sl", 0)) / tot
            s = stats(rs)
            e_gross = s["exp"] + cost
            width = tp + sl
            edge = (cost - e_gross) / width * 100.0
            # The bar inherits the sampling error of E_gross, and nothing else in
            # it is estimated: se(edge) = se(mean) / width.
            # LOWER BOUND, deliberately. This treats `width` as known, when the stop in
            # it was solved on ~300 in-sample sessions and carries its own error into the
            # denominator. Propagating that would only widen the interval, and the cells
            # are already inseparable at this bound — so the understatement cannot flip
            # any conclusion drawn from it.
            se = (s["sd"] / math.sqrt(s["n"])) / width * 100.0
            cell_bar, _, _ = declared_bar_on(sub, sessions, ds_oos, t0)
            print("      %-4d %-7s %5d %6.0f%% %7.2f%% %7.1f%% %8.2f %7.2f %6.2f %+6.2f %6s"
                  % (t0, name, s["n"], 100.0 * s["n"] / max(1, len(ds_oos)), -sl,
                     resolves, edge, se,
                     cell_bar if cell_bar is not None else float("nan"),
                     (edge - cell_bar) if cell_bar is not None else float("nan"),
                     "yes" if in_window else "NO"))
            rows.append({"t0": t0, "cell": name, "sl": sl, "edge": edge, "se": se,
                         "resolves": resolves, "in_window": in_window,
                         "n": s["n"], "coverage": s["n"] / max(1, len(ds_oos)),
                         "exp": s["exp"], "bar": cell_bar})
    return sub, sessions, days, is_days, oos_days, rows, ok


def declared_bar_on(sub, sessions, ds_oos, t0):
    """The declared bracket's required edge, on a GIVEN slice, at a GIVEN offset.

    Factored out so the same quantity serves two jobs: the pooled comparator
    below (whole OOS, t0=0), and the per-cell comparator in the cells table
    (that cell's own sessions, that cell's own offset).

    The per-cell use is the one that decides anything. A cell can look cheap
    for two quite different reasons: because re-solving the stop on its
    conditioning slice bought a better bracket, or because its sessions travel
    further and so eat less truncation. Judging every cell against one pooled
    bar cannot tell those apart — busy sessions resolve more often, so they
    would look cheap under the second reason alone, which is just #635's
    low-range-days-don't-travel result wearing a different hat. Holding the
    slice and the offset fixed and varying only the bracket isolates the part
    the conditioning actually bought.
    """
    lev, cost, tp, sl = sub["lev"], sub["cost"], sub["tp"], sub["recorded_sl"]
    HITS.clear()
    net = simulate(sessions, ds_oos, lev, tp, sl, cost, t0=t0, flatten=flatten_at)
    if not net:
        return None, None, None
    h = dict(HITS)
    e_gross = sum(net) / len(net) + cost
    delta = (cost - e_gross) / (tp + sl) * 100.0
    resolved = 100.0 * (h.get("tp", 0) + h.get("sl", 0)) / max(1, sum(h.values()))
    return delta, resolved, e_gross


def truncated_bar(sub, sessions, days):
    """The declared bracket's required edge, re-priced under the 16:25 flatten.

    This is the ONLY honest comparator for the cells. ADR-0018's recorded figure
    is untruncated and full-sample, so judging a truncated out-of-sample cell
    against it moves truncation, sample period and conditioning all at once —
    and the index correction showed the difference is not decorative (4.33 pp
    untruncated versus 4.19 pp here). Runs per subclass, deliberately: the
    ladder below is index-only because #704 defines the ladder at index levels,
    but this comparator needs no ladder and applies to both subclasses.
    """
    tp, sl = sub["tp"], sub["recorded_sl"]
    oos = [d for d in days if d.year >= 2023]
    delta, resolved, e_gross = declared_bar_on(sub, sessions, oos, 0)
    print("\n   -- THE POOLED BAR (t0=0, whole out-of-sample)")
    print("      declared bracket TP %+.2f%% / SL -%.2f%%, truncated at 16:25, same %d OOS sessions"
          % (tp, sl, len(oos)))
    print("      resolves %.1f%% truncated (%.1f%% untruncated)  E_gross %+.4f%%  -> bar %.2f pp"
          % (resolved, sub["recorded_resolves"], e_gross, delta))
    print("      ADR-0018's recorded %.2f pp is untruncated AND full-sample: it is NOT the"
          % sub["recorded_edge"])
    print("      comparator for any cell above, and is not used as one. Nor is this pooled")
    print("      figure — each cell carries its own bar, on its own sessions, in the table.")
    return delta


def rider(sub, sessions, days, bar):
    lev, cost = sub["lev"], sub["cost"]
    if sub["symbol"] != "SPY":
        # #704 specifies the 50/25/25 ladder at INDEX bracket levels (+1/+2/+3
        # over -2.16%). Running those levels against a single-stock ETP, whose
        # declared bracket is +6.00/-6.25, would not test #704's claim — it
        # would invent a different ladder and test that. The truncated-bar
        # comparator above is what this subclass needs, and it already ran.
        print("\n   -- RIDER: skipped. #704's ladder is defined at index bracket levels")
        print("      (+1/+2/+3 over -2.16%); it is not a single-stock proposal and is not")
        print("      re-scaled here. The truncated bar above is this subclass's comparator.")
        return None
    print("\n   -- RIDER: 50/25/25 ladder vs the single bracket, BOTH truncated at 16:25")
    oos = [d for d in days if d.year >= 2023]

    net_l, per = simulate_ladder(sessions, oos, lev, LADDER, LADDER_STOP, cost,
                                 t0=0, flatten=flatten_at)
    HITS.clear()
    net_s = simulate(sessions, oos, lev, 2.00, LADDER_STOP, cost, t0=0, flatten=flatten_at)
    hs = dict(HITS)

    width_l = sum(w * (tp + LADDER_STOP) for w, tp in LADDER)
    e_gross_l = sum(net_l) / len(net_l) + cost
    e_gross_s = sum(net_s) / len(net_s) + cost
    delta_l = (cost - e_gross_l) / width_l * 100.0
    delta_s = (cost - e_gross_s) / (2.00 + LADDER_STOP) * 100.0

    print("      per-tranche gross expectancy (weight @ take-profit over -%.2f%%):"
          % LADDER_STOP)
    for (w, tp), rs in zip(LADDER, per):
        m = sum(rs) / len(rs)
        reach = 100.0 * sum(1 for r in rs if r >= tp - 1e-9) / len(rs)
        stopped = 100.0 * sum(1 for r in rs if r <= -LADDER_STOP + 1e-9) / len(rs)
        print("        %3.0f%% @ %+.2f%%   E_gross %+.4f%%   reached %.1f%%   stopped %.1f%%"
              % (w * 100, tp, m, reach, stopped))
    print("      LADDER   E_gross %+.4f%%  E_net %+.4f%%  width %.2f%%  -> bar %.2f pp"
          % (e_gross_l, sum(net_l) / len(net_l), width_l, delta_l))
    print("      CONTROL  E_gross %+.4f%%  E_net %+.4f%%  width %.2f%%  -> bar %.2f pp"
          % (e_gross_s, sum(net_s) / len(net_s), 2.00 + LADDER_STOP, delta_s))
    print("      single bracket resolves %.1f%%, closes out %.1f%% under truncation"
          % (100.0 * (hs.get("tp", 0) + hs.get("sl", 0)) / max(1, sum(hs.values())),
             100.0 * hs.get("close", 0) / max(1, sum(hs.values()))))
    # Paired, because both arms trade the same sessions under the same flatten.
    # An unpaired comparison of two ~0.15%-mean series with ~1.5% dispersion has
    # no power at all here; the pairing removes the session effect, which is the
    # entire variance.
    assert len(net_l) == len(net_s), "arms are not aligned; the pairing is invalid"
    diff = [a - b for a, b in zip(net_l, net_s)]
    dm = sum(diff) / len(diff)
    dsd = statistics.stdev(diff)
    dse = dsd / math.sqrt(len(diff))
    print("      paired difference (ladder - single), same sessions: %+.4f%%/trade"
          "  SE %.4f  t = %+.2f  n = %d" % (dm, dse, dm / dse if dse else 0.0, len(diff)))
    print("      -> %s" % ("LADDER wins: it demands the lower accuracy edge"
                           if delta_l < delta_s else
                           "SINGLE BRACKET stands: the ladder demands MORE edge"))

    HITS.clear()
    net_d = simulate(sessions, oos, lev, 2.00, DEAD_STOP, cost, t0=0, flatten=flatten_at)
    hd = dict(HITS)
    e_gross_d = sum(net_d) / len(net_d) + cost
    delta_d = (cost - e_gross_d) / (2.00 + DEAD_STOP) * 100.0
    print("      #654's dead stop  TP +2.00 / SL -0.50: stopped %.1f%%  E_gross %+.4f%%"
          "  -> bar %.2f pp (the >=8.00 pp lower bound, measured)"
          % (100.0 * hd.get("sl", 0) / max(1, sum(hd.values())), e_gross_d, delta_d))
    return {"ladder": delta_l, "single": delta_s, "dead": delta_d}


def main():
    results = []
    for sub in SUBCLASSES:
        path = os.path.join(_study.TMP, "bars", "%s_%s.jsonl" % (sub["symbol"], sub["tf"]))
        if not os.path.exists(path):
            print("== %s: %s missing - fetch with 18-fetch-bars.py first" % (sub["label"], path))
            continue
        sub, sessions, days, is_days, oos_days, rows, ok = run(sub)
        bar = truncated_bar(sub, sessions, days)
        r = rider(sub, sessions, days, bar)
        if r is not None:
            # The rider's own CONTROL arm is the same quantity by a second code
            # path (SPY's declared stop and LADDER_STOP are both 2.16). If these
            # ever disagree, one of the two is wrong and the comparison is void.
            assert abs(r["single"] - bar) < 0.005, (
                "the rider's control and the truncated bar disagree: %.4f vs %.4f"
                % (r["single"], bar))
        results.append((sub, rows, r, days))

    print("\n=== SELECTION ACCOUNTING")
    if results:
        days = results[0][3]
        years = (days[-1] - days[0]).days / 365.25
        limit = minbtl_limit(years)
        declared = len(T0_GRID) * len(TERCILES)
        # Two whole offsets cannot carry a tercile split, for opposite reasons,
        # and BOTH are pre-registration defects the measurement found rather
        # than results. They are subtracted here instead of being dropped
        # quietly, because the tables below reach 21 rows only by counting
        # POOLED marginals that were never among the 21 declared cells.
        #   t0=0   — the conditioning variable does not exist yet. Realised
        #            range since the open is identically zero AT the open, so
        #            the terciles are undefined by construction, not merely
        #            thin. Reported POOLED only.
        #   t0=120 — entry at 11:30 ET is past the 11:25 ET flatten on 2,476 of
        #            2,659 sessions. The 183 that do trade are the UK/US DST
        #            mismatch weeks, where the London-to-ET offset is 4 or 6
        #            hours rather than 5, and 35-43 in-sample entries cannot
        #            solve a stop.
        unmeasurable = 2 * len(TERCILES)
        measurable = declared - unmeasurable
        print("   declared cells per subclass: %d (7 offsets x 3 terciles)" % declared)
        print("   of which measurable: %d — t0=0 has no range yet (terciles undefined) and"
              % measurable)
        print("   t0=120 falls past the flatten; %d cells per subclass are unmeasurable"
              % unmeasurable)
        print("   subclasses: %d  ->  %d declared / %d measurable in total"
              % (len(results), declared * len(results), measurable * len(results)))
        print("   sample %.1f years  ->  MinBTL supports %d independent trials" % (years, limit))
        print("   %s" % ("within budget" if declared * len(results) <= limit
                         else "EXCEEDS the budget"))
        print("   Note: the bracket rule is declared, not searched — each cell re-solves the")
        print("   same neutrality condition on a different conditioning slice, and no cell is")
        print("   chosen for its result. The count is reported because ADR-0018 D4 requires it.")


if __name__ == "__main__":
    main()
