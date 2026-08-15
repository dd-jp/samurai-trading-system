"""#653 threshold study.

Measures the instrument physics of an intraday long, entered at the session open,
exited on the first of take-profit / stop / session close. Underlying US tape,
scaled by the ETP leverage factor. Costs subtracted per round trip.

No selection signal: this is the unconditional baseline the thresholds are fitted
to. A real system adds an entry signal on top, which shifts P_win but not the
shape of the distribution.
"""
import json, math, os, re, sys
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
_TF_PATTERN = re.compile(r"^(\d*)\s*(min|minute|hour)s?$", re.I)
# Input directory, overridable so the ADR-0018 evidence reproduces off this machine.
# Expects <TMP>/bars/<SYMBOL>_<TF>.jsonl and <TMP>/news_<SYMBOL>.jsonl, which is what
# 18-fetch-bars.py and 18-fetch-earnings.py write when pointed at the same directory.
TMP = os.environ.get("SAMURAI_BARS_DIR", os.getcwd())
OPTIMISTIC = os.environ.get("SAME_BAR") == "tp"
HITS = defaultdict(int)


SESSION_MINUTES = 6 * 60 + 30  # 09:30-16:00 ET


def timeframe_minutes(tf):
    """Bar length in minutes for an Alpaca timeframe string ("5Min", "1Hour")."""
    m = _TF_PATTERN.match(tf.strip())
    if not m:
        raise ValueError("unrecognised timeframe %r" % tf)
    n = int(m.group(1) or 1)
    unit = m.group(2).lower()
    return n * (60 if unit.startswith("hour") else 1)


def load_sessions(symbol, tf=os.environ.get("TF", "5Min")):
    """Regular-hours bars grouped by ET trading date, in order.

    Sessions shorter than half a full day are dropped. The bar count that
    represents "half a day" is derived from the timeframe, so 1Min and 5Min runs
    are filtered on the same effective criterion — a fixed 60-bar floor is not
    comparable across timeframes (it is a whole session at 5Min but an hour at
    1Min, which silently kept half-days in one run and dropped them in another).
    """
    path = os.path.join(TMP, "bars", "%s_%s.jsonl" % (symbol, tf))
    min_bars = max(1, int(SESSION_MINUTES / timeframe_minutes(tf) * 0.5))
    sessions = defaultdict(list)
    for line in open(path):
        b = json.loads(line)
        t = datetime.fromisoformat(b["t"].replace("Z", "+00:00")).astimezone(ET)
        mins = t.hour * 60 + t.minute
        if mins < 9 * 60 + 30 or mins >= 16 * 60:
            continue
        sessions[t.date()].append((mins, b["o"], b["h"], b["l"], b["c"]))
    for d in sessions:
        sessions[d].sort()
    return {d: v for d, v in sessions.items() if len(v) >= min_bars}


def earnings_dates(symbol):
    """ET trading date on which the market first reacts to the release."""
    path = os.path.join(TMP, "news_%s.jsonl" % symbol)
    if not os.path.exists(path):
        return set()
    name = {"TSLA": "tesla", "AAPL": "apple"}.get(symbol, symbol.lower())
    # Benzinga's release headline changed format in 2023:
    #   <=2022  "Tesla Reports Q4 Adj. EPS $(0.87), Deliveries ~17.478K"
    #   >=2023  "Tesla Q4 Adj. EPS $0.50 Beats $0.45 Estimate, Sales $24.901B Beats ..."
    # Both start with the company name and carry a quarter token plus EPS.
    quarter = re.compile(r"\bq[1-4]\b")
    eps = re.compile(r"\beps\b")
    out = set()
    for line in open(path):
        n = json.loads(line)
        h = n["h"].lower()
        if not (h.startswith(name) and quarter.search(h) and eps.search(h)):
            continue
        t = datetime.fromisoformat(n["t"].replace("Z", "+00:00")).astimezone(ET)
        mins = t.hour * 60 + t.minute
        d = t.date()
        # released at/after 16:00 ET -> next session reacts; before 09:30 -> same session
        out.add((d, "next" if mins >= 16 * 60 else "same"))
    return out


def reaction_dates(symbol, session_days):
    days = sorted(session_days)
    idx = {d: i for i, d in enumerate(days)}
    react = set()
    for d, when in earnings_dates(symbol):
        if when == "same":
            if d in idx:
                react.add(d)
        else:
            # first session strictly after d
            for cand in days:
                if cand > d:
                    react.add(cand)
                    break
    return react


def simulate(sessions, days, lev, tp_pct, sl_pct, cost_pct):
    """Long at open, TP/SL on ETP terms, else flat at close. Returns net % list."""
    tp_u = tp_pct / lev / 100.0
    sl_u = sl_pct / lev / 100.0
    out = []
    for d in days:
        bars = sessions[d]
        o = bars[0][1]
        if o <= 0:
            continue
        tp_price = o * (1 + tp_u)
        sl_price = o * (1 - sl_u)
        res = None
        for _, _bo, h, l, c in bars:
            hit_sl = l <= sl_price
            hit_tp = h >= tp_price
            if hit_sl and hit_tp:
                res = tp_pct if OPTIMISTIC else -sl_pct
                break
            if hit_sl:
                res = -sl_pct
                break
            if hit_tp:
                res = tp_pct
                break
        if res is None:
            res = lev * (bars[-1][4] / o - 1) * 100.0
            HITS["close"] += 1
        elif res > 0:
            HITS["tp"] += 1
        else:
            HITS["sl"] += 1
        out.append(res - cost_pct)
    return out


def stats(rs):
    n = len(rs)
    if n == 0:
        return None
    m = sum(rs) / n
    var = sum((x - m) ** 2 for x in rs) / (n - 1) if n > 1 else 0.0
    sd = math.sqrt(var)
    wins = [x for x in rs if x > 0]
    return {
        "n": n,
        "exp": m,
        "sd": sd,
        "winrate": len(wins) / n,
        "sharpe": (m / sd * math.sqrt(252)) if sd > 0 else 0.0,
    }


def main():
    symbol = sys.argv[1]
    lev = float(sys.argv[2])
    cost = float(sys.argv[3])
    sessions = load_sessions(symbol)
    days = sorted(sessions)
    react = reaction_dates(symbol, set(days))
    split = [d for d in days if d.year <= 2022]
    oos = [d for d in days if d.year >= 2023]

    print("== %s  lev=%gx  cost=%.2f%%  sessions=%d (%s..%s)  earnings-reaction days=%d"
          % (symbol, lev, cost, len(days), days[0], days[-1], len(react & set(days))))
    print("   in-sample %d (<=2022)   out-of-sample %d (>=2023)" % (len(split), len(oos)))

    TPS = [float(x) for x in os.environ.get("TPS", "2,4,6").split(",")]
    SLS = [float(x) for x in os.environ.get("SLS", "1.5,3").split(",")]

    def best(dayset, label):
        rows = []
        for tp in TPS:
            for sl in SLS:
                HITS.clear()
                s = stats(simulate(sessions, dayset, lev, tp, sl, cost))
                if s:
                    s["hits"] = dict(HITS)
                    rows.append((tp, sl, s))
        if not rows:
            print("   [%s] no sessions in this split - skipped" % label)
            return None
        rows.sort(key=lambda r: -r[2]["exp"])
        print("   [%s] n=%d" % (label, rows[0][2]["n"]))
        for tp, sl, s in rows:
            h = s["hits"]
            tot = max(1, sum(h.values()))
            print("      TP %+.1f%% / SL -%.1f%%   exp %+.4f%%/trade  win %.1f%%  Sharpe %5.2f"
                  "   | TP hit %.1f%%  SL hit %.1f%%  closed out %.1f%%"
                  % (tp, sl, s["exp"], s["winrate"] * 100, s["sharpe"],
                     100 * h.get("tp", 0) / tot, 100 * h.get("sl", 0) / tot, 100 * h.get("close", 0) / tot))
        return rows[0]

    ev_is = [d for d in split if d in react]
    ord_is = [d for d in split if d not in react]
    ev_oos = [d for d in oos if d in react]
    ord_oos = [d for d in oos if d not in react]

    print("\n-- IN-SAMPLE FITS (<=2022)")
    b_pool = best(split, "pooled, all days")
    print()
    b_ord = best(ord_is, "ordinary days only")
    print()
    b_ev = best(ev_is, "earnings-reaction days only") if len(ev_is) >= 8 else None

    if b_pool is None:
        print("\nno in-sample sessions - nothing to freeze, stopping")
        return

    print("\n-- OUT-OF-SAMPLE (>=2023), levels frozen from the fits above")
    res = {}
    s = stats(simulate(sessions, oos, lev, b_pool[0], b_pool[1], cost))
    res["grid_pooled"] = s
    print("   GRID (one level pair, every day): TP %+.1f/SL -%.1f -> exp %+.4f%%  n=%d  win %.1f%%  Sharpe %.2f"
          % (b_pool[0], b_pool[1], s["exp"], s["n"], s["winrate"] * 100, s["sharpe"]))

    if b_ev and b_ord:
        s2 = stats(simulate(sessions, ev_oos, lev, b_ev[0], b_ev[1], cost))
        res["event_only"] = s2
        if s2:
            print("   EVENT-ONLY (trade only earnings days): TP %+.1f/SL -%.1f -> exp %+.4f%%  n=%d  win %.1f%%"
                  % (b_ev[0], b_ev[1], s2["exp"], s2["n"], s2["winrate"] * 100))
        combo = (simulate(sessions, ord_oos, lev, b_ord[0], b_ord[1], cost)
                 + simulate(sessions, ev_oos, lev, b_ev[0], b_ev[1], cost))
        s3 = stats(combo)
        res["combination"] = s3
        print("   COMBINATION (ordinary levels + earnings levels): exp %+.4f%%  n=%d  win %.1f%%  Sharpe %.2f"
              % (s3["exp"], s3["n"], s3["winrate"] * 100, s3["sharpe"]))

    print("\n-- ANNUALISED on GBP 750, at the out-of-sample trade rate")
    for k, s in res.items():
        if not s:
            continue
        per_yr = s["n"] / (len(oos) / 252.0)
        print("   %-14s  %+.4f%%/trade x GBP750 x %.0f trades/yr = GBP %+.0f/yr"
              % (k, s["exp"], per_yr, s["exp"] / 100.0 * 750 * per_yr))


if __name__ == "__main__":
    main()
