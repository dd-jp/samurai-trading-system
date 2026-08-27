"""#915 event-study — FOMC arm only. CPI/NFP could not be compiled this run.

Declared trial (#655's resolution, pinned on #915): FOMC/CPI/NFP pooled as ONE
family statistic, release-session population per #685's corrected methodology,
index subclass only, statistic = p_catalyst vs p_all-day directional accuracy
(not average move), bracket frozen at ADR-0018 D3's neutral single bracket,
pooled across the index-subclass underlyings.

**This run measures the FOMC arm only.** CPI and NFP release-date compilation
was attempted against bls.gov, alfred.stlouisfed.org and fred.stlouisfed.org —
all three returned HTTP 403 to the available fetch tool on every path tried
(schedule pages, archived-release pages, and the ALFRED/FRED release-dates
download endpoints). FOMC meeting dates were obtained from
federalreserve.gov's own historical calendar pages, which were not blocked.
No FRED/BLS API key is provisioned in this environment (doc 21's proposed
calendar-spine ingestion was never built — see #915's body). Fabricating
CPI/NFP dates from training recall was ruled out per #915's own instruction
("do not fabricate dates ... reduce the sample window").

Consequence: this is NOT the declared trial as pinned (family = three event
types pooled as one). It is a partial measurement of one of the three, run
so the ticket does not close with zero signal. The full pooled statistic
needs a follow-up with real CPI/NFP dates (manual compilation or a FRED API
key) before #658 or ADR-0016 can cite a result against the actual declaration.

Index subclass = SPY, QQQ only (doc 52 §3's 7-underlying pool: 2 index,
5 single-stock — not 7 index names; #915's body cites "7" in error, inherited
from the pool-size figure without checking the subclass split).

Usage:
    SAMURAI_DATA_DIR=<root> python3 55-fomc-cpi-nfp-event-study.py
Reads <root>/bars/{SPY,QQQ}_5Min.jsonl (18-fetch-bars.py) and
<root>/fomc_dates.txt (one ISO date per line, FOMC statement-release day).
"""
import math
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.environ.get(
    "SAMURAI_SCRIPT_DIR",
    "/Users/ddjp/Documents/projects/samurai-trading-system/.claude/worktrees/wayfinder-915/docs/research"))
_study = __import__("18-threshold-study")
_entry = __import__("18-entry-time-brackets")

load_sessions = _study.load_sessions
simulate = _study.simulate
stats = _study.stats
flatten_at = _entry.flatten_at

ET = ZoneInfo("America/New_York")
TMP = os.environ.get("SAMURAI_DATA_DIR", os.getcwd())

# ADR-0018 D3's declared neutral single bracket, index subclass.
LEV = 3.0
TP = 2.00
SL = 2.16
COST = 0.18

# FOMC statement release time, ET, constant across the sample.
FOMC_ET_HHMM = (14, 0)


def load_fomc_dates():
    path = os.path.join(TMP, "fomc_dates.txt")
    out = []
    for line in open(path):
        line = line.strip()
        if line:
            y, m, d = (int(x) for x in line.split("-"))
            out.append(datetime(y, m, d, *FOMC_ET_HHMM, tzinfo=ET))
    return out


def classify_release(t, flatten_min):
    """Which session (if any) has the frozen bracket's exposure window overlap
    the release. Unlike 18-threshold-study.classify() (which uses the 09:30-
    16:00 session boundary), this uses the ACTUAL exposure window this
    system trades: 09:30 open to the London flatten (~11:25-12:25 ET). FOMC
    releases at 14:00 ET, always after flatten -- so for FOMC the bracket's
    exposure window never overlaps the release, on every date in the sample.
    """
    mins = t.hour * 60 + t.minute
    if mins >= flatten_min:
        return "after_flatten"  # release lands after this system's exposure window closes
    if mins >= 9 * 60 + 30:
        return "intraday"       # release lands inside the exposure window
    return "same"                # release lands before the open -- full-session exposure


def reaction_dates(event_times, session_days, flatten_fn):
    """(days whose bracket exposure overlaps the release, days excluded as
    contaminated by an intraday-but-inside-window release, days confirmed
    structurally UNAFFECTED because the release lands after flatten).
    """
    days = sorted(session_days)
    have = set(days)
    react, excluded, after_flatten = set(), set(), set()
    for t in event_times:
        d = t.date()
        if d not in have:
            continue
        when = classify_release(t, flatten_fn(d))
        if when == "same":
            react.add(d)
        elif when == "intraday":
            excluded.add(d)
        else:
            after_flatten.add(d)
    return react, excluded, after_flatten


def win_rate_stat(sessions, days):
    """p = fraction of trades that hit TP before SL, under the frozen bracket."""
    from collections import defaultdict
    hits = defaultdict(int)
    out = []
    for d in days:
        bars = sessions.get(d)
        if not bars:
            continue
        start = 9 * 60 + 30
        end = flatten_at(d)
        window = [b for b in bars if start <= b[0] < end]
        if not window:
            continue
        o = window[0][1]
        if o <= 0:
            continue
        tp_u = TP / LEV / 100.0
        sl_u = SL / LEV / 100.0
        tp_price = o * (1 + tp_u)
        sl_price = o * (1 - sl_u)
        res = None
        for _, _bo, h, l, c in window:
            hit_sl = l <= sl_price
            hit_tp = h >= tp_price
            if hit_sl and hit_tp:
                res = "sl"  # conservative: simultaneous hit counts as a loss
                break
            if hit_sl:
                res = "sl"
                break
            if hit_tp:
                res = "tp"
                break
        if res is None:
            res = "tp" if window[-1][4] > o else "sl"
        out.append(1 if res == "tp" else 0)
    n = len(out)
    if n == 0:
        return None
    p = sum(out) / n
    se = math.sqrt(p * (1 - p) / n) if 0 < p < 1 else 0.0
    return {"n": n, "p": p, "se": se}


def pairwise_same_day_corr(all_sessions_by_symbol, days):
    """Same-day close-to-close return correlation across the pooled symbols,
    on the flattened window, as the cross-sectional-correlation estimate the
    ticket requires before reading power off a naive independent-N formula.
    """
    syms = list(all_sessions_by_symbol)
    if len(syms) < 2:
        return None
    rets = {}
    for sym, sessions in all_sessions_by_symbol.items():
        r = {}
        for d in days:
            bars = sessions.get(d)
            if not bars:
                continue
            start = 9 * 60 + 30
            end = flatten_at(d)
            window = [b for b in bars if start <= b[0] < end]
            if not window:
                continue
            o = window[0][1]
            c = window[-1][4]
            if o > 0:
                r[d] = c / o - 1
        rets[sym] = r
    common = set.intersection(*(set(r) for r in rets.values()))
    if len(common) < 10:
        return None, len(common)
    a, b = syms[0], syms[1]
    xs = [rets[a][d] for d in common]
    ys = [rets[b][d] for d in common]
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (n - 1)
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs) / (n - 1))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys) / (n - 1))
    if sx == 0 or sy == 0:
        return None, n
    return cov / (sx * sy), n


def main():
    symbols = ["SPY", "QQQ"]
    per_symbol = {s: load_sessions(s) for s in symbols}
    fomc_events = load_fomc_dates()

    print("== #915 FOMC arm — index subclass (SPY, QQQ), frozen ADR-0018 D3 bracket")
    print("   TP +%.2f%% / SL -%.2f%% / lev %gx / cost %.2f%%, 16:25 London flatten"
          % (TP, SL, LEV, COST))
    print("   FOMC events loaded: %d (2016-01-27 .. 2026-07-29)\n" % len(fomc_events))

    pooled_catalyst = []
    pooled_placebo = []
    pooled_all = []
    per_name = {}

    for sym in symbols:
        sessions = per_symbol[sym]
        days = sorted(sessions)
        react, excluded, after_flatten = reaction_dates(fomc_events, set(days), flatten_at)
        all_days = [d for d in days]
        catalyst_days = [d for d in days if d in react]

        s_all = win_rate_stat(sessions, all_days)
        s_cat = win_rate_stat(sessions, catalyst_days)
        per_name[sym] = (s_all, s_cat, len(excluded))
        print("   %s: sessions=%d  fomc-days-inside-exposure-window=%d  "
              "fomc-days-AFTER-flatten(structurally unaffected)=%d  intraday-excluded=%d"
              % (sym, len(days), len(catalyst_days), len(after_flatten), len(excluded)))
        if s_all:
            print("        p_all-day  n=%-5d p=%.4f  SE=%.4f" % (s_all["n"], s_all["p"], s_all["se"]))
        if s_cat:
            print("        p_catalyst (true exposure overlap) n=%-5d p=%.4f  SE=%.4f"
                  % (s_cat["n"], s_cat["p"], s_cat["se"]))
        else:
            print("        p_catalyst (true exposure overlap): n=0 -- no FOMC date in the sample "
                  "has its release before this system's flatten time")
        s_placebo = win_rate_stat(sessions, sorted(after_flatten))
        if s_placebo:
            print("        p_fomc-calendar-day (placebo, release AFTER flatten -- no true exposure) "
                  "n=%-5d p=%.4f  SE=%.4f" % (s_placebo["n"], s_placebo["p"], s_placebo["se"]))
        print()

        if s_all:
            pooled_all.append((sym, s_all))
        if s_cat:
            pooled_catalyst.append((sym, s_cat))
        if s_placebo:
            pooled_placebo.append((sym, s_placebo))

    def pool(rows):
        n = sum(r["n"] for _, r in rows)
        if n == 0:
            return None
        wins = sum(r["p"] * r["n"] for _, r in rows)
        p = wins / n
        se = math.sqrt(p * (1 - p) / n) if 0 < p < 1 else 0.0
        return {"n": n, "p": p, "se": se}

    P_all = pool(pooled_all)
    P_cat = pool(pooled_catalyst)
    P_placebo = pool(pooled_placebo)

    print("-- POOLED (SPY + QQQ, naive independent-N SE)")
    print("   p_all-day  n=%d  p=%.4f  SE=%.4f" % (P_all["n"], P_all["p"], P_all["se"]))
    if P_cat is None:
        print("   p_catalyst: UNDEFINED -- n=0 true-exposure FOMC sessions in the whole sample.")
        print("   Every one of the 84 FOMC releases lands after this system's flatten time")
        print("   (release 14:00 ET vs flatten ~11:25-12:25 ET). The frozen bracket's exposure")
        print("   window structurally never overlaps an FOMC announcement -- this is not a")
        print("   power problem, it is definitional: there is no catalyst arm to measure.")
    if P_placebo:
        print("   p_fomc-calendar-day (placebo) n=%d  p=%.4f  SE=%.4f"
              % (P_placebo["n"], P_placebo["p"], P_placebo["se"]))
        delta = P_placebo["p"] - P_all["p"]
        se_d_naive = math.sqrt(P_placebo["se"] ** 2 + P_all["se"] ** 2)
        print("   placebo delta (fomc-day - all-day) = %+.4f  naive SE %.4f  naive t %.2f"
              " (expected ~0 -- sanity check, not the declared statistic)"
              % (delta, se_d_naive, delta / se_d_naive if se_d_naive > 0 else 0.0))

    print("\n-- CROSS-SECTIONAL CORRELATION (same-session SPY/QQQ return, all days)")
    all_days_common = sorted(set(per_symbol["SPY"]) & set(per_symbol["QQQ"]))
    rho, n_common = pairwise_same_day_corr(per_symbol, all_days_common)
    if rho is None:
        print("   could not compute (n=%d common sessions)" % n_common)
    else:
        print("   rho(SPY, QQQ same-session return) = %.3f  (n=%d common sessions)" % (rho, n_common))
        # Effective N under equal-correlation pooling of 2 series:
        # var(mean of 2 correlated series) = (1+rho)/2 * var(single series)
        # so effective independent N per event-day = 2 / (1+rho), not 2.
        eff_mult = 2.0 / (1.0 + rho) if rho > -1 else 2.0
        print("   effective per-event-day N multiplier vs treating SPY/QQQ as independent: %.3f"
              " (naive assumes 2.0)" % eff_mult)
        print("   This is the detectability-floor correction #915 requires before reading power")
        print("   off an independent-N formula. It is reported for the record; it does not")
        print("   rescue a true-catalyst delta here, because that arm has n=0 by construction.")


if __name__ == "__main__":
    main()
