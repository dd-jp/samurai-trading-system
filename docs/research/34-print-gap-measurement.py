"""#734 — how often does an LSE leveraged-ETP line go more than 15 minutes without printing?

Produces doc 34 §3.3's table. The question is vendor-independent: a mark taken
from the LAST TRADE is stale by `max_mark_age.stocks = 15 minutes` whenever the
instrument simply has not traded for that long, no matter how fast the vendor
delivers it. If that happens often, the mark must come from the quote midpoint
instead — which is a hard constraint on which vendors are admissible at all.

Source: Yahoo's undocumented `v8/finance/chart/<TICKER>.L`, the only free
endpoint found that covers all eleven `lse_ticker` rows in
`server/providers/universe-pool/lse-etp-pool.ts` (doc 34 §3.1). Yahoo is used
here for RESEARCH only — doc 34 §5 rules it out of the live path on both licence
and freshness grounds. Its 1-minute history window is about seven days, so this
script can only ever measure the most recent handful of sessions; re-running it
on a different day measures different sessions and will not reproduce an earlier
run's figures exactly.

Method, stated because the numbers are not interpretable without it:

* A **print** is a 1-minute bar with a non-null close AND non-zero volume.
  Yahoo emits a bar per minute of the session regardless of activity, carrying
  nulls (or a repeated close at zero volume) when nothing traded, so counting
  bars rather than prints would report no gaps at all.
* Gaps are measured **within a session only**. The overnight gap is not a print
  gap and is excluded — every line would otherwise score ~17 hours once a day.
* The session is the LSE regular continuous window, **08:00–16:30 Europe/London**,
  matching `LseRegularHoursCalendar` in `server/providers/market-data-service/`.
  The closing auction and any out-of-hours prints are dropped.
* The reported figure is the fraction of consecutive-print gaps STRICTLY greater
  than 15 minutes, pooled over all sessions returned.

Usage (no key needed; writes the raw log this doc cites):

    python3 docs/research/34-print-gap-measurement.py \
        | tee docs/research/archive/raw/<date>-34-print-gaps.txt
"""

from __future__ import annotations

import json
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

# The eleven `lse_ticker` values in server/providers/universe-pool/lse-etp-pool.ts.
TICKERS = [
    "3USL",
    "LQQ3",
    "3SPY",
    "3LTS",
    "NVD3",
    "3AAP",
    "3LNV",
    "3QQQ",
    "MST3",
    "3LPA",
    "PLT3",
]

CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}.L?interval=1m&range=5d"
BOUND = timedelta(minutes=15)
SESSION_OPEN_MIN = 8 * 60  # 08:00 London
SESSION_CLOSE_MIN = 16 * 60 + 30  # 16:30 London


def fetch(ticker: str) -> dict:
    request = urllib.request.Request(
        CHART.format(ticker=ticker), headers={"User-Agent": "Mozilla/5.0"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def prints(payload: dict) -> tuple[list[datetime], str, str]:
    """Session-local print timestamps, the exchange name, and the quoted currency."""
    result = payload["chart"]["result"][0]
    meta = result["meta"]
    offset = timedelta(seconds=meta["gmtoffset"])
    stamps = result["timestamp"]
    quote = result["indicators"]["quote"][0]
    closes, volumes = quote["close"], quote["volume"]

    kept: list[datetime] = []
    for epoch, close, volume in zip(stamps, closes, volumes):
        if close is None or not volume:
            continue
        local = datetime.fromtimestamp(epoch, tz=timezone.utc) + offset
        minute = local.hour * 60 + local.minute
        if SESSION_OPEN_MIN <= minute < SESSION_CLOSE_MIN:
            kept.append(local)
    return kept, meta.get("fullExchangeName", "?"), meta.get("currency", "?")


def gaps(stamps: list[datetime]) -> list[timedelta]:
    """Consecutive-print gaps, never crossing a session boundary."""
    by_day: dict[object, list[datetime]] = {}
    for stamp in stamps:
        by_day.setdefault(stamp.date(), []).append(stamp)
    out: list[timedelta] = []
    for day in sorted(by_day):
        ordered = sorted(by_day[day])
        out.extend(b - a for a, b in zip(ordered, ordered[1:]))
    return out


def main() -> int:
    print(f"# doc 34 §3.3 print-gap measurement — run {datetime.now(timezone.utc).isoformat()}")
    print(f"# source: Yahoo v8/finance/chart, interval=1m, range=5d, session 08:00-16:30 London")
    print(f"# a print = 1-minute bar with non-null close and non-zero volume; gaps never cross a session")
    print()
    print(f"{'ticker':<8}{'ccy':<6}{'sessions':>9}{'prints':>8}{'gaps':>7}{'>15m':>7}{'pct>15m':>9}{'median':>9}{'max':>8}")
    rows = []
    for ticker in TICKERS:
        try:
            stamps, exchange, currency = prints(fetch(ticker))
        except Exception as error:  # noqa: BLE001 - the log records the failure verbatim
            print(f"{ticker:<8}FETCH FAILED: {error!r}")
            continue
        sessions = len({stamp.date() for stamp in stamps})
        found = gaps(stamps)
        over = [gap for gap in found if gap > BOUND]
        pct = 100.0 * len(over) / len(found) if found else float("nan")
        ordered = sorted(g.total_seconds() / 60 for g in found)
        median = ordered[len(ordered) // 2] if ordered else float("nan")
        longest = ordered[-1] if ordered else float("nan")
        print(
            f"{ticker:<8}{currency:<6}{sessions:>9}{len(stamps):>8}{len(found):>7}"
            f"{len(over):>7}{pct:>8.1f}%{median:>9.1f}{longest:>8.1f}"
        )
        rows.append((ticker, currency, sessions, pct, median))

    print()
    print("# median and max are minutes between consecutive prints, within a session")
    over13 = [row[0] for row in rows if row[3] > 13]
    over15 = [row[0] for row in rows if row[3] > 15]
    print(f"# lines with >13% of gaps over the bound: {len(over13)}/{len(rows)} {over13}")
    print(f"# lines with >15% of gaps over the bound: {len(over15)}/{len(rows)} {over15}")
    print(f"# quoted currencies as the venue reports them: " + ", ".join(f"{r[0]} {r[1]}" for r in rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
