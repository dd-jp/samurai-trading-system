"""#653 threshold study.

Measures the instrument physics of an intraday long, entered at the session open,
exited on the first of take-profit / stop / session close. Underlying US tape,
scaled by the ETP leverage factor. Costs subtracted per round trip.

No selection signal: this is the unconditional baseline the thresholds are fitted
to. A real system adds an entry signal on top, which shifts P_win but not the
shape of the distribution.

Corrected 2026-08-18 for #685. The earnings labelling had two defects: a release
at any time before 16:00 ET was called a same-session reaction, so an 11:00
release labelled a session whose 09:30 entry PRECEDED it (look-ahead), and
headlines were not deduped per event, so a same-date pre-market/post-close pair
marked two reaction days for one event. See `earnings_events`, `classify` and
`reaction_dates`. Set DUMP_EVENTS=1 to print every matched event with its label.
"""
import json, math, os, re, sys
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
_TF_PATTERN = re.compile(r"^(\d*)\s*(min|minute|hour)s?$", re.I)
# Input ROOT, overridable so the ADR-0018 evidence reproduces off this machine.
# Expects <TMP>/bars/<SYMBOL>_<TF>.jsonl and <TMP>/news_<SYMBOL>.jsonl, which is what
# 18-fetch-bars.py and 18-fetch-earnings.py write when pointed at the same directory.
TMP = os.environ.get("SAMURAI_DATA_DIR", os.getcwd())
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


# Two matched headlines closer together than this belong to the same release.
# Earnings are ~90 days apart, so the threshold cannot merge two real events,
# and it comfortably spans the common shape: a post-close release at 16:05
# followed by pre-market recaps the next morning.
EVENT_CLUSTER_DAYS = 5


def earnings_events(symbol):
    """One (release datetime ET, headline) per earnings event, in time order.

    Deduped per event. The wire publishes several headlines per release — a
    post-close print plus pre-market recaps the following morning — and the
    earlier revision of this function added one marker per *headline*, so a
    same-date pre-market/post-close pair marked BOTH that session and the next
    one. One event now contributes exactly one release time, the earliest
    matched headline in its cluster (#685).
    """
    path = os.path.join(TMP, "news_%s.jsonl" % symbol)
    if not os.path.exists(path):
        return []
    name = {"TSLA": "tesla", "AAPL": "apple"}.get(symbol, symbol.lower())
    # Benzinga's release headline changed format in 2023:
    #   <=2022  "Tesla Reports Q4 Adj. EPS $(0.87), Deliveries ~17.478K"
    #   >=2023  "Tesla Q4 Adj. EPS $0.50 Beats $0.45 Estimate, Sales $24.901B Beats ..."
    # Both start with the company name and carry a quarter token plus EPS.
    quarter = re.compile(r"\bq[1-4]\b")
    # A REPORTED figure, not a mention of the letters EPS: the release headline
    # always carries the number, "EPS $0.50" / "Adj. EPS $(0.87)". Requiring it
    # is what separates the print from the commentary around it — a bare
    # `\beps\b` also matched four previews and roundups ("Analyst Predicts 6%
    # Beat On Q2 EPS", "Q3 Earnings Preview: ... Expects EPS To Fall Below
    # Estimates"), each of which then marked a reaction day of its own. Those
    # four are the whole of the difference between the 46 days ADR-0018
    # published and the 42 measured here (#685).
    eps = re.compile(r"\beps\b[^$]{0,12}\$")
    hits = []
    for line in open(path):
        n = json.loads(line)
        h = n["h"]
        low = h.lower()
        if not (low.startswith(name) and quarter.search(low) and eps.search(low)):
            continue
        hits.append((datetime.fromisoformat(n["t"].replace("Z", "+00:00")).astimezone(ET), h))
    hits.sort(key=lambda r: r[0])
    events = []
    for t, h in hits:
        if events and (t - events[-1][-1][0]).total_seconds() <= EVENT_CLUSTER_DAYS * 86400:
            events[-1].append((t, h))
        else:
            events.append([(t, h)])
    return [c[0] for c in events]


def classify(t):
    """Which session first reacts to a release at ET datetime `t`.

    The study enters at the 09:30 open, so only a release that lands BEFORE the
    open is reacted to by that session from the entry onwards. A release during
    the session sits after the entry, and labelling that session as the reaction
    is look-ahead — it was the defect this replaces (#685).
    """
    mins = t.hour * 60 + t.minute
    if mins >= 16 * 60:
        return "next"
    if mins >= 9 * 60 + 30:
        return "intraday"
    return "same"


def reaction_dates(symbol, session_days):
    """(reaction sessions, sessions excluded as contaminated by an intraday release).

    An intraday release contaminates its own session and nothing else: the
    market has already reacted by that session's close, so the following session
    is an ordinary post-reaction session. The excluded set is removed from the
    event arm AND the ordinary arm, so both sides of the comparison are built on
    the same rule.
    """
    days = sorted(session_days)
    have = set(days)
    react = set()
    excluded = set()
    for t, _h in earnings_events(symbol):
        d = t.date()
        when = classify(t)
        if when == "same":
            if d in have:
                react.add(d)
        elif when == "intraday":
            if d in have:
                excluded.add(d)
        else:
            for cand in days:  # first session strictly after d
                if cand > d:
                    react.add(cand)
                    break
    return react, excluded


def simulate(sessions, days, lev, tp_pct, sl_pct, cost_pct, t0=0, flatten=None):
    """Long at open, TP/SL on ETP terms, else flat at close. Returns net % list.

    `t0` offsets the entry by whole minutes past the 09:30 ET open: the position
    is opened at the OPEN of the first bar at or after 09:30 + t0. `t0 = 0` is
    therefore `bars[0][1]`, byte-for-byte the entry ADR-0018 was computed on —
    which is what makes it usable as the regression control (#708).

    `flatten` is an optional `date -> ET minute-of-day` at which a position that
    has reached neither level is closed at market, paying the full round trip.
    `None` keeps ADR-0018's behaviour of holding to the session close. The two
    defaults together mean an unparameterised call is unchanged by this addition.
    """
    tp_u = tp_pct / lev / 100.0
    sl_u = sl_pct / lev / 100.0
    start = 9 * 60 + 30 + t0
    out = []
    for d in days:
        bars = sessions[d]
        if t0 or flatten is not None:
            end = flatten(d) if flatten is not None else 24 * 60
            bars = [b for b in bars if start <= b[0] < end]
            if not bars:
                HITS["no_entry"] += 1
                continue
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
    se = sd / math.sqrt(n) if n > 1 else 0.0
    return {
        "n": n,
        "exp": m,
        "sd": sd,
        "se": se,
        "t": (m / se) if se > 0 else 0.0,
        "winrate": len(wins) / n,
        "sharpe": (m / sd * math.sqrt(252)) if sd > 0 else 0.0,
    }


# Below this many out-of-sample trades an arm's t-statistic is not reported.
# Declared before the corrected run (#685), not chosen after seeing it.
T_REPORT_FLOOR = 10


def t_str(s):
    """t-statistic, or an explicit refusal when the arm is under the floor."""
    if s is None:
        return "n/a"
    if s["n"] < T_REPORT_FLOOR:
        return "n=%d < %d, no t reported" % (s["n"], T_REPORT_FLOOR)
    return "SE %.3f  t %+.2f" % (s["se"], s["t"])


def main():
    symbol = sys.argv[1]
    lev = float(sys.argv[2])
    cost = float(sys.argv[3])
    sessions = load_sessions(symbol)
    days = sorted(sessions)
    if not days:
        print("== %s  no sessions loaded from %s - nothing to study" % (symbol, TMP))
        return
    react, excluded = reaction_dates(symbol, set(days))
    split = [d for d in days if d.year <= 2022]
    oos = [d for d in days if d.year >= 2023]

    events = earnings_events(symbol)
    if os.environ.get("DUMP_EVENTS"):
        # Only ~46 clusters, so every one is eyeballed rather than trusted.
        print("-- MATCHED EARNINGS EVENTS (deduped, one row per event)")
        for i, (t, h) in enumerate(events, 1):
            print("   %2d  %s ET  %-8s  %s" % (i, t.strftime("%Y-%m-%d %H:%M"), classify(t), h[:100]))
        print()

    by = defaultdict(int)
    for t, _h in events:
        by[classify(t)] += 1
    print("== %s  lev=%gx  cost=%.2f%%  sessions=%d (%s..%s)  earnings-reaction days=%d"
          % (symbol, lev, cost, len(days), days[0], days[-1], len(react & set(days))))
    print("   in-sample %d (<=2022)   out-of-sample %d (>=2023)" % (len(split), len(oos)))
    print("   events %d (pre-open %d, intraday %d, post-close %d); sessions excluded as "
          "intraday-contaminated: %d" % (len(events), by["same"], by["intraday"], by["next"],
                                         len(excluded & set(days))))

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

    # The intraday-contaminated sessions are dropped from BOTH the event arm and
    # the ordinary arm — the same rule on both sides of the comparison, which is
    # what makes the event-minus-ordinary difference meaningful (#685). They are
    # NOT dropped from the pooled grid row: that row does not partition on
    # events at all, it is the unconditional baseline over every session, and it
    # is cited as reproducing to the digit by docs 50, 51 and 52.
    ev_is = [d for d in split if d in react and d not in excluded]
    ord_is = [d for d in split if d not in react and d not in excluded]
    ev_oos = [d for d in oos if d in react and d not in excluded]
    ord_oos = [d for d in oos if d not in react and d not in excluded]

    print("\n-- IN-SAMPLE FITS (<=2022)")
    b_pool = best(split, "pooled, all days")
    print()
    b_ord = best(ord_is, "ordinary days only")
    print()
    if len(ev_is) >= 8:
        b_ev = best(ev_is, "earnings-reaction days only")
    else:
        b_ev = None
        print("   [earnings-reaction days only] n=%d < 8 in-sample - the event arm cannot be "
              "fitted, so no event row is produced" % len(ev_is))

    if b_pool is None:
        print("\nno in-sample sessions - nothing to freeze, stopping")
        return

    print("\n-- OUT-OF-SAMPLE (>=2023), levels frozen from the fits above")
    res = {}
    s = stats(simulate(sessions, oos, lev, b_pool[0], b_pool[1], cost))
    if s is None:
        print("   no out-of-sample sessions - the frozen levels cannot be scored")
        return
    res["grid_pooled"] = s
    print("   GRID (one level pair, every day): TP %+.1f/SL -%.1f -> exp %+.4f%%  n=%d  win %.1f%%  Sharpe %.2f  %s"
          % (b_pool[0], b_pool[1], s["exp"], s["n"], s["winrate"] * 100, s["sharpe"], t_str(s)))

    if b_ev and b_ord:
        s_ord = stats(simulate(sessions, ord_oos, lev, b_ord[0], b_ord[1], cost))
        res["ordinary_only"] = s_ord
        if s_ord:
            print("   ORDINARY-ONLY (non-event, intraday-contaminated excluded): TP %+.1f/SL -%.1f -> "
                  "exp %+.4f%%  n=%d  win %.1f%%  %s"
                  % (b_ord[0], b_ord[1], s_ord["exp"], s_ord["n"], s_ord["winrate"] * 100, t_str(s_ord)))
        s2 = stats(simulate(sessions, ev_oos, lev, b_ev[0], b_ev[1], cost))
        res["event_only"] = s2
        if s2:
            print("   EVENT-ONLY (trade only earnings days): TP %+.1f/SL -%.1f -> exp %+.4f%%  n=%d  win %.1f%%  %s"
                  % (b_ev[0], b_ev[1], s2["exp"], s2["n"], s2["winrate"] * 100, t_str(s2)))
        if s2 and s_ord:
            diff = s2["exp"] - s_ord["exp"]
            se_d = math.sqrt(s2["se"] ** 2 + s_ord["se"] ** 2)
            if s2["n"] < T_REPORT_FLOOR or s_ord["n"] < T_REPORT_FLOOR:
                print("   EVENT MINUS ORDINARY: %+.4f%%/trade  SE %.3f  -- n=%d/%d, below the declared "
                      "floor of %d, so no t is reported" % (diff, se_d, s2["n"], s_ord["n"], T_REPORT_FLOOR))
            else:
                print("   EVENT MINUS ORDINARY: %+.4f%%/trade  SE %.3f  t %+.2f (Welch, unpaired)"
                      % (diff, se_d, diff / se_d if se_d > 0 else 0.0))
        combo = (simulate(sessions, ord_oos, lev, b_ord[0], b_ord[1], cost)
                 + simulate(sessions, ev_oos, lev, b_ev[0], b_ev[1], cost))
        s3 = stats(combo)
        res["combination"] = s3
        if s3 is not None:
            print("   COMBINATION (ordinary levels + earnings levels): exp %+.4f%%  n=%d  win %.1f%%  Sharpe %.2f  %s"
                  % (s3["exp"], s3["n"], s3["winrate"] * 100, s3["sharpe"], t_str(s3)))

    print("\n-- ANNUALISED on GBP 750, at the out-of-sample trade rate")
    for k, s in res.items():
        if not s:
            continue
        per_yr = s["n"] / (len(oos) / 252.0)
        print("   %-14s  %+.4f%%/trade x GBP750 x %.0f trades/yr = GBP %+.0f/yr"
              % (k, s["exp"], per_yr, s["exp"] / 100.0 * 750 * per_yr))


if __name__ == "__main__":
    main()
