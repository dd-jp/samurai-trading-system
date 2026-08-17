"""#814 follow-up — where the intraday odds actually sit: exit geometry, bracket
width, and the two live subclasses.

**This is descriptive measurement. It selects nothing.** ADR-0018 Decision 4
fixes a selection budget of two configurations, chosen once, and freezes *the
rule* rather than the percentages. Everything below re-prices the declared rule
on the live tape and reports what the tape says; a lower bar at some other width
is a fact about the tape, not a proposal. Changing any percentage needs a fresh
amendment carrying its own trial accounting, which this run supplies by counting
and printing every configuration it touches.

Three questions, one run, all on the doc 50 regime so the numbers sit directly
alongside the existing comparators (4.19 pp index, 3.85 pp single-stock):

- **Q4 — the two live subclasses, and the seven underlyings inside them.** The
  LSE pool (`server/providers/universe-pool/lse-etp-pool.ts`, #749) is eleven
  tickers over seven underlyings and exactly TWO subclasses. `crypto` is the
  third value of `InstrumentSubclass` and is out of scope since 2026-08-16, so
  there is no third live subclass and there never were four.
- **Q3 — the width curve.** The neutral stop is re-solved at each take-profit
  and the required accuracy edge reported per width. The declared +2.00% (index)
  and +6.00% (single-stock) are points on this curve, not its argmin, and are
  marked as such.
- **Q2 — the design axes.** Neutral versus skewed; frozen versus ATR-floating;
  bracket versus time-exit-only. Single-versus-ladder is NOT re-run — #708
  measured it at t = -0.20 over n = 897 and it is cited, not repeated.

Metric throughout is the **required accuracy edge in percentage points**:

    edge_pp = (cost - E_gross) / width * 100

the directional accuracy the signal must supply above a coin for the geometry to
break even. Lower is an easier job for the signal. It is reported instead of
expectancy or return because ADR-0018 D1 forbids a return number as a target and
CLAUDE.md forbids return-only comparison; where a configuration has no bracket
(time-exit-only) the bar is undefined and is reported as such rather than faked.

Usage:

    SAMURAI_DATA_DIR=<root> python3 docs/research/52-exit-geometry-and-subclass-odds.py

Reads `<root>/bars/{SPY,QQQ}_5Min.jsonl` and `<root>/bars/{TSLA,NVDA,AAPL,MSTR,PLTR}_1Min.jsonl`,
as written by `18-fetch-bars.py`. Granularity per subclass matches doc 18 / doc 50
precedent so the figures are comparable rather than merely similar.
"""
import math
import os
import sys
from collections import defaultdict
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_study = __import__("18-threshold-study")
_entry = __import__("18-entry-time-brackets")

load_sessions = _study.load_sessions
simulate = _study.simulate
stats = _study.stats
HITS = _study.HITS
neutral_stop = _entry.neutral_stop
flatten_at = _entry.flatten_at
US_OPEN = _entry.US_OPEN

# ---------------------------------------------------------------- the universe
#
# Seven underlyings, two subclasses, from the #749 pool file. The ETP tickers
# (3USL, LQQ3, 3SPY, 3QQQ / 3LTS, NVD3, 3AAP, 3LNV, MST3, 3LPA, PLT3) are LSE-
# listed and no specced DataSource serves the LSE, so the tape measured here is
# the US underlying scaled by the leverage factor -- exactly ADR-0018's own
# method, and its own limitation.
INDEX = [("SPY", "5Min"), ("QQQ", "5Min")]
SINGLE = [("TSLA", "1Min"), ("NVDA", "1Min"), ("AAPL", "1Min"),
          ("MSTR", "1Min"), ("PLTR", "1Min")]

LEV = 3.0
# ADR-0018 D3's round trips. These are SUBCLASS figures: #666 owns the measured
# per-instrument spreads and they are not applied per name here, so a per-name
# ranking inherits its subclass's cost. Stated because it is the main reason a
# per-name figure below is weaker evidence than a per-subclass one.
COST = {"index": 0.18, "single": 0.41}
DECLARED_TP = {"index": 2.00, "single": 6.00}
DECLARED_SL = {"index": 2.16, "single": 6.25}

# doc 50 / doc 51's split. Every neutral stop below is SOLVED on the in-sample
# slice and SCORED on the out-of-sample one. Solving and scoring on the same
# sessions fits the stop to the sample it is then graded on, which would make
# every "neutral" column optimistic by construction and every width look better
# than it is -- the same in-sample-fitting error doc 13's PBO chain exists to
# catch. The DECLARED brackets need no split: they are constants from ADR-0018,
# fitted to neither slice.
OOS_FROM = date(2023, 1, 1)
WIDTH_GRID = [1.0, 2.0, 3.0, 4.0, 6.0, 8.0]

TRIALS = []  # every configuration this run prices, for the selection accounting


def trial(label):
    TRIALS.append(label)


def edge_pp(e_gross, cost, width):
    return (cost - e_gross) / width * 100.0


def oos_days(sessions):
    return sorted(d for d in sessions if d >= OOS_FROM)


def is_days(sessions):
    return sorted(d for d in sessions if d < OOS_FROM)


def solved_neutral(sessions, tp, cost):
    """Neutral stop SOLVED IN SAMPLE. Returns None if the sample does not
    bracket a neutral stop at this take-profit."""
    sl, _ = neutral_stop(sessions, is_days(sessions), LEV, tp, cost, 0, flatten_at)
    return sl


def gross(sessions, days, tp, sl, cost, t0=0):
    """E_gross and the hit split for one bracket, under the 16:25 truncation."""
    HITS.clear()
    net = simulate(sessions, days, LEV, tp, sl, cost, t0=t0, flatten=flatten_at)
    if not net:
        return None
    s = stats(net)
    return {
        "n": s["n"],
        "e_net": s["exp"],
        "e_gross": s["exp"] + cost,
        "sd": s["sd"],
        "tp": HITS.get("tp", 0),
        "sl": HITS.get("sl", 0),
        "close": HITS.get("close", 0),
    }


def priced(sessions, days, tp, sl, cost, t0=0):
    g = gross(sessions, days, tp, sl, cost, t0=t0)
    if g is None:
        return None
    width = tp + sl
    g["width"] = width
    g["bar"] = edge_pp(g["e_gross"], cost, width)
    # se(bar), treating width as known -- a LOWER bound on the true uncertainty,
    # since a re-solved stop is itself estimated. Same convention as doc 50.
    g["bar_se"] = (g["sd"] / math.sqrt(g["n"])) / width * 100.0
    g["resolves"] = (g["tp"] + g["sl"]) / g["n"] if g["n"] else 0.0
    return g


# ------------------------------------------------------- ATR-floating variant

def atr_by_day(sessions, days, lookback=14):
    """Prior-`lookback`-session mean high-low range, in ETP percent terms.

    Session range rather than true range: these are regular-hours-only sessions
    and the overnight gap is not tradeable by a flat-by-close system, so folding
    it into the stop would size the stop off risk the system never carries.
    """
    ordered = sorted(sessions)
    rng = {}
    for d in ordered:
        bars = sessions[d]
        hi = max(b[2] for b in bars)
        lo = min(b[3] for b in bars)
        o = bars[0][1]
        rng[d] = (hi - lo) / o * 100.0 * LEV if o > 0 else None
    out = {}
    for i, d in enumerate(ordered):
        prior = [rng[x] for x in ordered[max(0, i - lookback):i] if rng[x] is not None]
        if len(prior) >= lookback:
            out[d] = sum(prior) / len(prior)
    return {d: out[d] for d in days if d in out}


def simulate_floating(sessions, days, stop_for_day, tp_pct, cost_pct, t0=0):
    """`simulate`, but the stop is a per-session number instead of a constant.

    Mirrors `simulate`'s conventions exactly -- same-bar ambiguity resolves as
    the stop, an unresolved position closes at the flatten instant paying the
    full round trip -- so the two are comparable. The take-profit stays fixed:
    the axis under test is the STOP's derivation, and floating both would
    confound them.
    """
    start = US_OPEN + t0
    out, widths = [], []
    hits = defaultdict(int)
    for d in days:
        sl_pct = stop_for_day.get(d)
        if sl_pct is None or sl_pct <= 0:
            continue
        bars = [b for b in sessions[d] if start <= b[0] < flatten_at(d)]
        if not bars:
            continue
        o = bars[0][1]
        if o <= 0:
            continue
        tp_price = o * (1 + tp_pct / LEV / 100.0)
        sl_price = o * (1 - sl_pct / LEV / 100.0)
        res = None
        for _, _bo, h, l, c in bars:
            if l <= sl_price:
                res = -sl_pct
                break
            if h >= tp_price:
                res = tp_pct
                break
        if res is None:
            res = LEV * (bars[-1][4] / o - 1) * 100.0
            hits["close"] += 1
        elif res > 0:
            hits["tp"] += 1
        else:
            hits["sl"] += 1
        out.append(res - cost_pct)
        widths.append(tp_pct + sl_pct)
    return out, widths, dict(hits)


# --------------------------------------------------------------------- report

def load(symbols):
    out = {}
    for sym, tf in symbols:
        try:
            out[sym] = load_sessions(sym, tf)
        except FileNotFoundError:
            sys.stderr.write("missing bars for %s %s -- skipping\n" % (sym, tf))
    return out


def pooled_days(loaded):
    """Per-symbol OOS day lists. Pooling is per-symbol-then-averaged, never a
    merged timeline: #420 recorded what merging two instruments' calendars does
    to every Sharpe it touches."""
    return {s: oos_days(v) for s, v in loaded.items()}


def q4(idx, sng):
    print("\n" + "=" * 78)
    print("Q4 -- THE LIVE SUBCLASSES, AND THE SEVEN UNDERLYINGS INSIDE THEM")
    print("=" * 78)
    print("There are TWO live subclasses, not four. `crypto` is the third value of")
    print("InstrumentSubclass and left scope 2026-08-16 (ADR-0015 amendment).\n")
    for label, loaded, kind in (("index_etp_3x", idx, "index"),
                                ("single_stock_etp_3x", sng, "single")):
        tp, sl, cost = DECLARED_TP[kind], DECLARED_SL[kind], COST[kind]
        print("-- %s   declared bracket +%.2f%% / -%.2f%%   round trip %.2f%%"
              % (label, tp, sl, cost))
        print("   %-6s %5s  %7s  %7s  %6s %6s %6s   %s"
              % ("name", "n", "E_gross", "E_net", "tp%", "sl%", "close%", "bar (pp)"))
        for sym, sessions in loaded.items():
            days = oos_days(sessions)
            g = priced(sessions, days, tp, sl, cost)
            trial("Q4 declared bracket / %s" % sym)
            if g is None:
                print("   %-6s  no sessions" % sym)
                continue
            print("   %-6s %5d  %+7.4f  %+7.4f  %5.1f%% %5.1f%% %5.1f%%   %6.2f +/- %.2f"
                  % (sym, g["n"], g["e_gross"], g["e_net"],
                     100 * g["tp"] / g["n"], 100 * g["sl"] / g["n"],
                     100 * g["close"] / g["n"], g["bar"], g["bar_se"]))
        print()


def q3(idx, sng):
    print("\n" + "=" * 78)
    print("Q3 -- THE WIDTH CURVE (neutral stop RE-SOLVED at each take-profit)")
    print("=" * 78)
    print("Descriptive. The declared widths are marked; the argmin is NOT a proposal.")
    print("")
    print("READ THE `resolves` COLUMN BEFORE THE `bar` COLUMN. Width is the bar's own")
    print("denominator, so the bar falls monotonically as the bracket widens -- all the")
    print("way to a bracket that never fires. At the wide end the position is closed at")
    print("market on essentially every session, which is time-exit-only wearing a bracket:")
    print("the signal's directional accuracy no longer acts on the levels at all, so the")
    print("bar stops describing the job the signal is being asked to do. A low bar at a")
    print("2% resolve rate is not a better configuration, it is a degenerate one -- and it")
    print("is ADR-0018 D3's own recorded reason for not choosing the widest bracket.\n")
    for label, loaded, kind in (("index_etp_3x", idx, "index"),
                                ("single_stock_etp_3x", sng, "single")):
        cost = COST[kind]
        print("-- %s   round trip %.2f%%" % (label, cost))
        print("   %-6s %5s %8s %7s %8s %8s %9s"
              % ("tp%", "n", "neut.sl", "width", "E_gross", "resolves", "bar (pp)"))
        for sym, sessions in loaded.items():
            days = oos_days(sessions)
            print("   [%s]  neutral stop solved in sample (n=%d), scored out of sample"
                  % (sym, len(is_days(sessions))))
            for tp in WIDTH_GRID:
                sl = solved_neutral(sessions, tp, cost)
                trial("Q3 width sweep / %s / tp=%.1f" % (sym, tp))
                if sl is None:
                    print("   %-6.2f    -- no neutral stop on this sample" % tp)
                    continue
                g = priced(sessions, days, tp, sl, cost)
                mark = "  <- DECLARED" if abs(tp - DECLARED_TP[kind]) < 1e-9 else ""
                print("   %-6.2f %5d %8.2f %7.2f %+8.4f %7.1f%% %9.2f%s"
                      % (tp, g["n"], sl, g["width"], g["e_gross"],
                         100 * g["resolves"], g["bar"], mark))
            print()


def q2(idx, sng):
    print("\n" + "=" * 78)
    print("Q2 -- THE DESIGN AXES")
    print("=" * 78)
    print("single-vs-ladder is NOT re-run: #708 measured it at t = -0.20 over n = 897")
    print("(docs/research/50-entry-time-conditional-brackets.md). Cited, not repeated.\n")

    for label, loaded, kind in (("index_etp_3x", idx, "index"),
                                ("single_stock_etp_3x", sng, "single")):
        cost = COST[kind]
        tp = DECLARED_TP[kind]
        print("-- %s   take-profit held at +%.2f%%, round trip %.2f%%" % (label, tp, cost))

        # (a) neutral vs skewed, AT MATCHED WIDTH -----------------------------
        #
        # Width is the bar's denominator, so widening anything lowers the bar
        # mechanically. Comparing a neutral bracket against a skewed one by
        # moving only the stop therefore compares WIDTHS, not skews, and the
        # wider arm always "wins" for a reason that has nothing to do with skew.
        # Total width is held at the declared bracket's and only the SPLIT
        # moves, so the axis under test is the one named.
        W = DECLARED_TP[kind] + DECLARED_SL[kind]
        print("   (a) NEUTRAL vs SKEWED -- AT MATCHED TOTAL WIDTH %.2f%%" % W)
        print("       Only the split moves. A comparison that widened the stop instead")
        print("       would be measuring width, which is the bar's own denominator.")
        print("       %-6s %-12s %5s %6s %6s %8s %9s %9s"
              % ("name", "split tp/sl", "n", "tp%", "sl%", "E_gross", "resolves", "bar (pp)"))
        for sym, sessions in loaded.items():
            days = oos_days(sessions)
            neut = solved_neutral(sessions, tp, cost)  # in sample, scored on OOS
            splits = [("25/75", 0.25 * W, 0.75 * W),
                      ("50/50", 0.50 * W, 0.50 * W),
                      ("declared", DECLARED_TP[kind], DECLARED_SL[kind]),
                      ("75/25", 0.75 * W, 0.25 * W)]
            if neut is not None and neut + tp > 0:
                # the in-sample neutral pair, rescaled to the same total width
                scale = W / (tp + neut)
                splits.append(("neutral*", tp * scale, neut * scale))
            for name, t, s_ in splits:
                g = priced(sessions, days, t, s_, cost)
                trial("Q2a %s / %s / %s" % (label, sym, name))
                if g is None:
                    continue
                print("       %-6s %-12s %5d %6.2f %6.2f %+8.4f %8.1f%% %9.2f"
                      % (sym, name, g["n"], t, s_, g["e_gross"],
                         100 * g["resolves"], g["bar"]))
        print("       * neutral pair rescaled to the matched width, so it is comparable")
        print()

        # (b) frozen vs ATR-floating ------------------------------------------
        print("   (b) FROZEN percentage stop vs ATR-FLOATING stop  (k x 14-session range)")
        print("       NOTE: D2 rejected per-instrument fitting on a STRUCTURAL argument --")
        print("       the universe is scanned daily (#635), so there is no fixed instrument")
        print("       list to fit to. Measuring this axis characterises its cost; it cannot")
        print("       overturn the decision.")
        print("       %-6s %-12s %5s %8s %7s %8s %9s %9s"
              % ("name", "stop", "n", "mean sl%", "width", "E_gross", "resolves", "bar (pp)"))
        for sym, sessions in loaded.items():
            days = oos_days(sessions)
            frozen = priced(sessions, days, tp, DECLARED_SL[kind], cost)
            trial("Q2b %s / %s / frozen" % (label, sym))
            if frozen:
                print("       %-6s %-12s %5d %8.2f %7.2f %+8.4f %8.1f%% %9.2f"
                      % (sym, "frozen", frozen["n"], DECLARED_SL[kind],
                         frozen["width"], frozen["e_gross"],
                         100 * frozen["resolves"], frozen["bar"]))
            atr = atr_by_day(sessions, days)
            # k chosen so the FLOATING stop has the same MEAN width as the frozen
            # one. Without this the comparison is width-versus-width again: an
            # ATR stop that happens to sit wider scores a lower bar for the same
            # denominator reason, and the derivation under test never gets
            # measured. k_matched isolates "where does the stop come from" from
            # "how wide is it".
            mean_atr = (sum(atr.values()) / len(atr)) if atr else None
            ks = [0.5, 1.0]
            if mean_atr:
                ks.append(DECLARED_SL[kind] / mean_atr)
            for k in ks:
                stop_for_day = {d: k * v for d, v in atr.items()}
                net, widths, hits = simulate_floating(sessions, days, stop_for_day, tp, cost)
                trial("Q2b %s / %s / atr k=%.1f" % (label, sym, k))
                if not net:
                    continue
                s = stats(net)
                e_gross = s["exp"] + cost
                mean_sl = sum(stop_for_day[d] for d in days if d in stop_for_day) / max(1, len(atr))
                mean_w = sum(widths) / len(widths)
                resolves = (hits.get("tp", 0) + hits.get("sl", 0)) / max(1, s["n"])
                matched = mean_atr and abs(k - DECLARED_SL[kind] / mean_atr) < 1e-9
                print("       %-6s %-12s %5d %8.2f %7.2f %+8.4f %8.1f%% %9.2f%s"
                      % (sym, "atr k=%.2f" % k, s["n"], mean_sl, mean_w,
                         e_gross, 100 * resolves, edge_pp(e_gross, cost, mean_w),
                         "  <- WIDTH-MATCHED" if matched else ""))
        print()

        # (c) bracket vs time-exit-only ---------------------------------------
        print("   (c) BRACKET vs TIME-EXIT-ONLY (flatten at 16:25, no levels)")
        print("       A bar is UNDEFINED without a bracket -- there is no width to amortise")
        print("       cost over -- so expectancy and dispersion are reported instead, and")
        print("       the two columns are NOT ranked against the bracket's pp figure.")
        print("       %-6s %-14s %5s %9s %8s %8s"
              % ("name", "exit", "n", "E_net", "sd", "bar (pp)"))
        for sym, sessions in loaded.items():
            days = oos_days(sessions)
            br = priced(sessions, days, tp, DECLARED_SL[kind], cost)
            trial("Q2c %s / %s / bracket" % (label, sym))
            if br:
                print("       %-6s %-14s %5d %+9.4f %8.4f %8.2f"
                      % (sym, "bracket", br["n"], br["e_net"], br["sd"], br["bar"]))
            # 999% levels are unreachable, so every session closes at the flatten.
            HITS.clear()
            net = simulate(sessions, days, LEV, 999.0, 999.0, cost, t0=0, flatten=flatten_at)
            trial("Q2c %s / %s / time-exit-only" % (label, sym))
            if net:
                s = stats(net)
                print("       %-6s %-14s %5d %+9.4f %8.4f %8s"
                      % (sym, "time-exit-only", s["n"], s["exp"], s["sd"], "n/a"))
        print()


def main():
    idx = load(INDEX)
    sng = load(SINGLE)
    if not idx and not sng:
        sys.exit("no bars found under %s/bars -- run 18-fetch-bars.py first" % _study.TMP)
    print("Regime: t0 = 0 (US open), truncated at the 16:25 London flatten,")
    print("out-of-sample from %s. Same regime as doc 50, so the figures compare" % OOS_FROM)
    print("directly against its 4.19 pp index / 3.85 pp single-stock comparators.")
    print("Every re-solved neutral stop is fitted IN SAMPLE and scored OUT OF SAMPLE.")
    print("\nSessions loaded (in sample / out of sample):")
    for label, loaded in (("index", idx), ("single", sng)):
        for sym, s in loaded.items():
            print("   %-6s %-7s %5d / %5d   %s .. %s"
                  % (sym, label, len(is_days(s)), len(oos_days(s)),
                     min(s) if s else "-", max(s) if s else "-"))
    q4(idx, sng)
    q3(idx, sng)
    q2(idx, sng)
    print("\n" + "=" * 78)
    print("SELECTION ACCOUNTING")
    print("=" * 78)
    print("Configurations priced by this run: %d" % len(TRIALS))
    print("This is a measurement sweep, NOT a selection. ADR-0018 D4's budget of two")
    print("configurations-chosen-once is untouched, because nothing here is adopted.")
    print("Any figure below the declared bracket's is a fact about the tape; adopting")
    print("it would spend trials that this count is here to make payable.")


if __name__ == "__main__":
    main()
