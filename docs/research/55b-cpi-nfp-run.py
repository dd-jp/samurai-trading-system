"""#915 CPI/NFP arm -- extends 55-fomc-cpi-nfp-event-study.py's FOMC-arm run.

Uses the same data pipeline (Alpaca SIP 5-min bars, SPY+QQQ, frozen ADR-0018
D3 bracket, win-rate-as-accuracy-proxy statistic, rho-adjusted detectability
floor) already established there. CPI/NFP release dates pulled from FRED
(release_id=10 Consumer Price Index, release_id=50 Employment Situation),
2016-01-01 through 2026-08-26, both at 08:30 ET -- before the 09:30 open, so
the full session is inside this system's exposure window (09:30 to flatten).
"""
import math
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_arm1 = __import__("55-fomc-cpi-nfp-event-study")

load_sessions = _arm1.load_sessions
win_rate_stat = _arm1.win_rate_stat
reaction_dates = _arm1.reaction_dates
classify_release = _arm1.classify_release
pairwise_same_day_corr = _arm1.pairwise_same_day_corr
flatten_at = _arm1.flatten_at

ET = ZoneInfo("America/New_York")
TMP = os.environ.get("SAMURAI_DATA_DIR", os.getcwd())

CPI_NFP_ET_HHMM = (8, 30)


def load_release_dates(fname):
    path = os.path.join(TMP, fname)
    out = []
    for line in open(path):
        line = line.strip()
        if line:
            y, m, d = (int(x) for x in line.split("-"))
            out.append(datetime(y, m, d, *CPI_NFP_ET_HHMM, tzinfo=ET))
    return out


def pool(rows):
    n = sum(r["n"] for _, r in rows)
    if n == 0:
        return None
    wins = sum(r["p"] * r["n"] for _, r in rows)
    p = wins / n
    se = math.sqrt(p * (1 - p) / n) if 0 < p < 1 else 0.0
    return {"n": n, "p": p, "se": se}


def main():
    symbols = ["SPY", "QQQ"]
    per_symbol = {s: load_sessions(s) for s in symbols}
    cpi_events = load_release_dates("cpi_dates.txt")
    nfp_events = load_release_dates("nfp_dates.txt")

    cpi_dates_only = {t.date() for t in cpi_events}
    nfp_dates_only = {t.date() for t in nfp_events}
    overlap = cpi_dates_only & nfp_dates_only
    print("== #915 CPI/NFP arm -- index subclass (SPY, QQQ), frozen ADR-0018 D3 bracket")
    print("   CPI release dates loaded: %d (FRED release_id=10)" % len(cpi_events))
    print("   NFP release dates loaded: %d (FRED release_id=50)" % len(nfp_events))
    print("   same-day CPI/NFP overlap: %d\n" % len(overlap))

    pooled_family_days = cpi_dates_only | nfp_dates_only
    print("   pooled family event-days (union, CPI+NFP, no double-count): %d\n" % len(pooled_family_days))

    all_events = [datetime(d.year, d.month, d.day, *CPI_NFP_ET_HHMM, tzinfo=ET) for d in pooled_family_days]

    pooled_catalyst = []
    pooled_all = []

    for sym in symbols:
        sessions = per_symbol[sym]
        days = sorted(sessions)
        react, excluded, after_flatten = reaction_dates(all_events, set(days), flatten_at)
        all_days = [d for d in days]
        catalyst_days = [d for d in days if d in react]

        s_all = win_rate_stat(sessions, all_days)
        s_cat = win_rate_stat(sessions, catalyst_days)
        print("   %s: sessions=%d  cpi/nfp-days-in-sample=%d  excluded(intraday-contam)=%d  after-flatten=%d"
              % (sym, len(days), len(catalyst_days), len(excluded), len(after_flatten)))
        if s_all:
            print("        p_all-day   n=%-5d p=%.4f  SE=%.4f" % (s_all["n"], s_all["p"], s_all["se"]))
        if s_cat:
            print("        p_catalyst  n=%-5d p=%.4f  SE=%.4f" % (s_cat["n"], s_cat["p"], s_cat["se"]))
        print()

        if s_all:
            pooled_all.append((sym, s_all))
        if s_cat:
            pooled_catalyst.append((sym, s_cat))

    P_all = pool(pooled_all)
    P_cat = pool(pooled_catalyst)

    print("-- POOLED (SPY + QQQ, naive independent-N SE)")
    print("   p_all-day   n=%d  p=%.4f  SE=%.4f" % (P_all["n"], P_all["p"], P_all["se"]))
    print("   p_catalyst  n=%d  p=%.4f  SE=%.4f" % (P_cat["n"], P_cat["p"], P_cat["se"]))
    delta = P_cat["p"] - P_all["p"]
    se_d_naive = math.sqrt(P_cat["se"] ** 2 + P_all["se"] ** 2)
    t_naive = delta / se_d_naive if se_d_naive > 0 else 0.0
    print("   delta (catalyst - all-day) = %+.4f  naive-independent-N SE %.4f  naive t %.2f"
          % (delta, se_d_naive, t_naive))

    rho, n_common = pairwise_same_day_corr(per_symbol, sorted(set(per_symbol["SPY"]) & set(per_symbol["QQQ"])))
    eff_mult = 2.0 / (1.0 + rho) if rho and rho > -1 else 1.0
    # Correlation-adjusted SE: pooling SPY+QQQ buys eff_mult x the single-name N,
    # not 2x. Scale the naive-pooled variance up by 2/eff_mult to reflect that.
    scale = 2.0 / eff_mult
    se_d_adj = se_d_naive * math.sqrt(scale)
    t_adj = delta / se_d_adj if se_d_adj > 0 else 0.0
    print("\n   rho(SPY,QQQ) = %.3f -> effective pooling multiplier %.3f (naive assumes 2.0)" % (rho, eff_mult))
    print("   correlation-adjusted SE %.4f  correlation-adjusted t %.2f" % (se_d_adj, t_adj))

    print("\n-- BREAK-EVEN BAR, SWEPT ACROSS #886's DISPUTED INDEX NOTIONAL (£50-£350)")
    print("   QQQ geometry bar (doc 54): 2.96pp. LLM bill £58/yr, N=252 sessions, width=4.16.")
    print("   Delta_p(pp) = bill x 10^4 / (N x notional x width)")
    for notional in [50, 100, 150, 200, 250, 300, 350]:
        bill_pp = 58 * 1e4 / (252 * notional * 4.16)
        be = 50.0 + 2.96 + bill_pp
        print("   £%-4d notional: bill-cost %.2fpp  break-even accuracy %.2f%%" % (notional, bill_pp, be))


if __name__ == "__main__":
    main()
