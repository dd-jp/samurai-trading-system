"""#707 (R1) — does the open-low/close-high property persist across instruments?

Pre-registered study. The method is NOT chosen here — it is copied from
issue #707's body, which was written and locked before any bar was fetched:

* **Statistic.** Trailing 12-month mean of the daily open-to-close return
  `(close - open) / open`, strictly trailing: no bar from the month being
  scored may enter the ranking that scores it.
* **Cross-section.** Monthly cross-sectional quintile rank over the 26 distinct
  `screening_instrument` values in `server/providers/universe-pool/lse-etp-pool.ts`,
  top-minus-bottom spread.
* **Entry rule** (resolved on the ticket 2026-08-27, and counted as a trial):
  rank within the names available that month, with a minimum-names-per-month
  floor of 20. Months below the floor are dropped rather than ranked on a
  too-thin cross-section.
* **Split.** Inherited from `18-threshold-study.py` (in sample <= 2022, out of
  sample >= 2023) — the lines are 272-273 today, not the 169-170 the ticket
  body cites; the content is unchanged.
* **Trial count: 2.** (1) the quintile statistic, (2) the availability/floor
  entry rule. Nothing else may be chosen after seeing a result. This script
  therefore offers exactly one lookback, one cut, one floor, and no options.

Two mechanical readings of the declared method, stated here rather than
decided at the keyboard, because a declared rule has to be executable:

* A name is **available** in month `m` when its full 12-month trailing window
  is populated (at least one bar in each of the 12 preceding months) and it has
  at least one bar in `m` to score. "Trailing 12-month mean" over a window with
  holes is not the declared statistic, so this is its consequence, not a choice.
* At `N` not a multiple of 5 the quintiles are `ceil(N/5)` names each end.

Deliberate ordering — the reason this has stages. `is` computes the in-sample
dispersion and the minimum detectable effect; `oos` scores the out-of-sample
arm. They are separate entry points so the write-up's declaration sections can
be committed against the `is` output, before any out-of-sample number exists.

Usage — fetch once (the cache is gitignored and never re-fetched), then run:

    export SAMURAI_ENV_FILE=/abs/path/to/.env.local
    export SAMURAI_DATA_DIR=/tmp/samurai-707
    for s in AAPL AMD AMZN ARM BABA COIN EWY GOOG KWEB META MRNA MSFT MSTR \
             NFLX NIO NVDA PLTR PYPL QQQ RACE SPY TSLA UBER VT XLE XYZ; do
        python3 docs/research/18-fetch-bars.py $s 2016-01-04 2026-08-01 1Day
    done
    python3 docs/research/57-open-low-close-high-persistence.py data
    python3 docs/research/57-open-low-close-high-persistence.py is
    python3 docs/research/57-open-low-close-high-persistence.py oos

Reads `<SAMURAI_DATA_DIR>/bars/<SYMBOL>_1Day.jsonl` as written by
`18-fetch-bars.py`. The end date passed to the fetcher is exclusive-ish at the
API, so 2026-08-01 is used and everything after 2026-07-31 is dropped here.
"""
import json
import math
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("SAMURAI_DATA_DIR", os.path.join(HERE, "data"))
BARS = os.path.join(DATA_DIR, "bars")

# The 26 distinct `screening_instrument` values in
# server/providers/universe-pool/lse-etp-pool.ts (30 ETP lines, 26 underlyings).
# This ticket ranks underlyings, not ETP lines: two 3x SPY trackers are one name
# held through either of two routes, not two places in a cross-section.
POOL = [
    "AAPL", "AMD", "AMZN", "ARM", "BABA", "COIN", "EWY", "GOOG", "KWEB",
    "META", "MRNA", "MSFT", "MSTR", "NFLX", "NIO", "NVDA", "PLTR", "PYPL",
    "QQQ", "RACE", "SPY", "TSLA", "UBER", "VT", "XLE", "XYZ",
]

START = "2016-01-04"
END = "2026-07-31"
LOOKBACK_MONTHS = 12
NAME_FLOOR = 20            # declared 2026-08-27; applied to BOTH arms
IS_LAST_YEAR = 2022        # 18-threshold-study.py:272
OOS_FIRST_YEAR = 2023      # 18-threshold-study.py:273
# 80% power, 5% two-sided: 1.96 + 0.8416. Doc 51's MDE convention, unchanged.
MDE_Z = 1.959964 + 0.841621


def month_key(day):
    return day[:7]


def add_months(key, n):
    y, m = int(key[:4]), int(key[5:7])
    t = (y * 12 + (m - 1)) + n
    return "%04d-%02d" % (t // 12, t % 12 + 1)


def load():
    """symbol -> {month -> [daily (c-o)/o in percent]}, plus a per-symbol span."""
    per_symbol = {}
    span = {}
    for sym in POOL:
        path = os.path.join(BARS, "%s_1Day.jsonl" % sym)
        if not os.path.exists(path):
            raise SystemExit("missing %s — run the fetch loop in this file's docstring" % path)
        months = {}
        days = []
        extreme = 0
        with open(path) as fh:
            for line in fh:
                b = json.loads(line)
                day = b["t"][:10]
                if day < START or day > END:
                    continue
                if not b["o"]:
                    continue
                r = (b["c"] - b["o"]) / b["o"] * 100.0
                if abs(r) > 30.0:
                    extreme += 1
                months.setdefault(month_key(day), []).append(r)
                days.append(day)
        if not days:
            raise SystemExit("%s: no bars in window" % sym)
        per_symbol[sym] = months
        span[sym] = (len(days), min(days), max(days), extreme)
    return per_symbol, span


def all_months():
    out, k = [], month_key(START)
    last = month_key(END)
    while k <= last:
        out.append(k)
        k = add_months(k, 1)
    return out


def score(months, m):
    """Strictly-trailing 12-month mean of the daily open-to-close return.

    None unless every one of the 12 preceding months carries at least one bar.
    """
    window = []
    for i in range(LOOKBACK_MONTHS, 0, -1):
        prev = months.get(add_months(m, -i))
        if not prev:
            return None
        window.extend(prev)
    return statistics.fmean(window)


def cross_section(per_symbol, m):
    """[(symbol, trailing score, realised mean for month m)] for available names."""
    rows = []
    for sym, months in per_symbol.items():
        this = months.get(m)
        if not this:
            continue
        s = score(months, m)
        if s is None:
            continue
        rows.append((sym, s, statistics.fmean(this)))
    return rows


def spreads(per_symbol, months):
    """month -> (n_available, top mean, bottom mean, spread), floor applied."""
    out = {}
    for m in months:
        rows = cross_section(per_symbol, m)
        if len(rows) < NAME_FLOOR:
            continue
        rows.sort(key=lambda r: r[1], reverse=True)
        k = int(math.ceil(len(rows) / 5.0))
        top = statistics.fmean([r[2] for r in rows[:k]])
        bot = statistics.fmean([r[2] for r in rows[-k:]])
        out[m] = (len(rows), k, top, bot, top - bot)
    return out


def summary(series):
    n = len(series)
    mean = statistics.fmean(series)
    sd = statistics.stdev(series) if n > 1 else float("nan")
    se = sd / math.sqrt(n) if n > 1 else float("nan")
    return n, mean, sd, se, (mean / se if se else float("nan"))


def main():
    stage = sys.argv[1] if len(sys.argv) > 1 else "data"
    per_symbol, span = load()
    months = all_months()

    if stage == "data":
        print("== per-symbol daily bars, %s .. %s (adjustment=all, feed=sip)" % (START, END))
        print("%-6s %6s  %-10s %-10s %s" % ("sym", "bars", "first", "last", "|r|>30%"))
        for sym in POOL:
            n, lo, hi, ex = span[sym]
            print("%-6s %6d  %-10s %-10s %d" % (sym, n, lo, hi, ex))
        print("\n== availability per month (floor = %d)" % NAME_FLOOR)
        first_scored = None
        for m in months:
            rows = cross_section(per_symbol, m)
            if rows and first_scored is None:
                first_scored = m
            flag = "" if len(rows) >= NAME_FLOOR else "  BELOW FLOOR"
            if m.endswith("-01") or flag:
                print("  %s  n=%2d%s" % (m, len(rows), flag))
        print("first scoreable month: %s" % first_scored)
        return

    arm = [m for m in months if int(m[:4]) <= IS_LAST_YEAR] if stage == "is" \
        else [m for m in months if int(m[:4]) >= OOS_FIRST_YEAR]
    sp = spreads(per_symbol, arm)
    keys = sorted(sp)
    series = [sp[m][4] for m in keys]
    tops = [sp[m][2] for m in keys]
    bots = [sp[m][3] for m in keys]

    label = "IN-SAMPLE (<=%d)" % IS_LAST_YEAR if stage == "is" else "OUT-OF-SAMPLE (>=%d)" % OOS_FIRST_YEAR
    print("== %s  months scored: %d  (of %d in the arm; the rest are below the %d-name floor)"
          % (label, len(keys), len(arm), NAME_FLOOR))
    if keys:
        print("   first %s  last %s   names/month %d..%d"
              % (keys[0], keys[-1], min(sp[m][0] for m in keys), max(sp[m][0] for m in keys)))

    n, mean, sd, se, t = summary(series)
    print("\n   top-minus-bottom spread, %/session")
    print("   n=%d  mean %+.4f  sd %.4f  se %.4f  t %+.3f" % (n, mean, sd, se, t))
    tn, tmean, tsd, tse, tt = summary(tops)
    bn, bmean, bsd, bse, bt = summary(bots)
    print("   top quintile   mean %+.4f  se %.4f  t %+.3f" % (tmean, tse, tt))
    print("   bottom quintile mean %+.4f  se %.4f  t %+.3f" % (bmean, bse, bt))

    if stage == "is":
        # MDE: dispersion from THIS arm, sample size from the arm actually
        # tested. Using the in-sample month count would report the power of a
        # test that is not being run.
        oos_months = [m for m in months if int(m[:4]) >= OOS_FIRST_YEAR]
        m_oos = len(spreads(per_symbol, oos_months))
        print("\n   MDE for the out-of-sample arm:")
        print("   %.4f x %.4f / sqrt(%d) = %+.4f %%/session"
              % (MDE_Z, sd, m_oos, MDE_Z * sd / math.sqrt(m_oos)))
        print("   (z = 1.96 + 0.84, 80%% power at 5%% two-sided; sd in-sample, M = %d OOS months)" % m_oos)
        return

    print("\n   per-month spreads:")
    for m in keys:
        nn, k, top, bot, s = sp[m]
        print("     %s  n=%2d k=%d  top %+.4f  bot %+.4f  spread %+.4f" % (m, nn, k, top, bot, s))


if __name__ == "__main__":
    main()
