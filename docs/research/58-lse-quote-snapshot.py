"""#881 — the free LSE quote endpoint, and the snapshot that falsifies the ticket's blocker.

#881 states its answer "needs LSE quote data that does not currently exist for
free". That premise is FALSE. The London Stock Exchange's own website is a
JavaScript app backed by an **unauthenticated** API, and that API returns a live
bid and offer per TIDM:

    https://api.londonstockexchange.com/api/gw/lse/instruments/alldata/<TIDM>

It covers all thirty `lse_ticker` rows in
`server/providers/universe-pool/lse-etp-pool.ts` — 30/30 — and additionally
returns `marketsize` (Exchange Market Size, the quantity the quote is good for),
`segment`, `currency` and `sedol`.

READ THIS BEFORE QUOTING THE NUMBERS
------------------------------------
**This is a snapshot, not a published statistic, and the snapshot's timing is
load-bearing.** LSE continuous trading is 08:00-16:30 Europe/London. A capture
taken outside that window returns the PREVIOUS SESSION'S CLOSING quotes — the
payload carries `tradingstatuscode: "N c"` and the prior session's full volume,
and re-running minutes later returns byte-identical values.

That matters because LSE's own market-maker obligations require quotes to be
maintained "for at least 90% of continuous trading during the mandatory period"
and explicitly do NOT require them during the opening auction. A closing or
pre-open quote is therefore not the spread a fill would cross.

So: **a run of this script is only evidence about tradeable spread if
`in_session` is True in its output.** The script says so on every line rather
than leaving it to the reader.

What this is FOR
----------------
Not a one-shot answer. #881 asks whether cost varies enough across the universe
to justify a per-instrument term; answering that properly needs this sampled
repeatedly through the session, because doc 53 G3 measured a real session
profile on US names (TSLA's open median 2.7x its close median). This script is
the sampler that makes that dataset buildable at £0, and one run of it is a
single observation.

It is RESEARCH tooling. It is not a mark source for the live book — that is
open #895, and doc 34 §5's licence and freshness analysis is what governs there.

Usage:

    python3 docs/research/58-lse-quote-snapshot.py \
        | tee docs/research/archive/raw/<date>-58-lse-quotes.txt
"""

from __future__ import annotations

import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

ALLDATA = "https://api.londonstockexchange.com/api/gw/lse/instruments/alldata/{tidm}"

# All thirty `lse_ticker` rows in server/providers/universe-pool/lse-etp-pool.ts.
TICKERS = [
    "3USL", "LQQ3", "3SPY", "3LTS", "NVD3", "3AAP", "3LNV", "3QQQ", "MST3", "3LPA",
    "PLT3", "3LME", "LAM3", "3LAL", "LPP3", "3LNP", "LCO3", "LAA3", "3LMO", "3LIP",
    "3LSQ", "3AMZ", "3FB", "3UBR", "3RAC", "3ARM", "3VT", "3KOR", "3KWE", "3XLE",
]


def london_now() -> datetime:
    """Europe/London without a tz database dependency: GMT in winter, BST from
    the last Sunday in March to the last Sunday in October."""
    now = datetime.now(timezone.utc)

    def last_sunday(year: int, month: int) -> datetime:
        day = 31
        while True:
            candidate = datetime(year, month, day, 1, tzinfo=timezone.utc)
            if candidate.weekday() == 6:
                return candidate
            day -= 1

    start = last_sunday(now.year, 3)
    end = last_sunday(now.year, 10)
    return now + timedelta(hours=1) if start <= now < end else now


def in_session(when: datetime) -> bool:
    """LSE continuous trading, 08:00-16:30 Europe/London, weekdays. Holidays are
    NOT handled — a bank-holiday run will claim in-session and return stale
    quotes, so check the date if the numbers look frozen."""
    if when.weekday() >= 5:
        return False
    minutes = when.hour * 60 + when.minute
    return 8 * 60 <= minutes <= 16 * 60 + 30


def fetch(tidm: str) -> dict[str, object] | None:
    request = urllib.request.Request(
        ALLDATA.format(tidm=tidm),
        headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.load(response)
            break
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt == 2:
                print(f"  {tidm}: FETCH FAILED — {exc}", file=sys.stderr)
                return None
            time.sleep(2 * (attempt + 1))

    body = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(body, dict):
        body = payload if isinstance(payload, dict) else {}

    def find(*names: str) -> object:
        for name in names:
            if name in body:
                return body[name]
        # The payload nests some fields one level down depending on instrument.
        for value in body.values():
            if isinstance(value, dict):
                for name in names:
                    if name in value:
                        return value[name]
        return None

    bid = find("bid")
    offer = find("offer", "ask")
    try:
        bid = float(bid)
        offer = float(offer)
    except (TypeError, ValueError):
        return {"tidm": tidm, "error": "no bid/offer in payload"}

    if bid <= 0 or offer <= 0 or offer < bid:
        return {"tidm": tidm, "error": f"unusable quote bid={bid} offer={offer}"}

    mid = (bid + offer) / 2
    return {
        "tidm": tidm,
        "bid": bid,
        "offer": offer,
        "mid": mid,
        "spread_bps": (offer - bid) / mid * 10_000,
        "currency": find("currency"),
        "segment": find("segment"),
        "ems": find("marketsize", "ems"),
        "status": find("tradingstatuscode", "tradingstatus"),
    }


def main() -> int:
    when = london_now()
    live = in_session(when)

    print("#881 — LSE free quote snapshot (api.londonstockexchange.com, unauthenticated)")
    print(f"Captured: {when:%Y-%m-%d %H:%M} Europe/London")
    print(f"IN CONTINUOUS SESSION (08:00-16:30 weekdays): {live}")
    if not live:
        print()
        print("  *** OUT OF SESSION — these are the PREVIOUS SESSION'S CLOSING quotes. ***")
        print("  *** They are NOT evidence about the spread a fill would cross, because  ***")
        print("  *** market-maker quote obligations bind during continuous trading only. ***")
    print()

    rows: list[dict[str, object]] = []
    for tidm in TICKERS:
        row = fetch(tidm)
        if row:
            rows.append(row)
        time.sleep(0.4)

    good = [row for row in rows if "error" not in row]
    bad = [row for row in rows if "error" in row]

    print(f"{'tidm':<7} {'ccy':<5} {'seg':<6} {'ems':>8} {'bid':>12} {'offer':>12} {'spread bps':>11}")
    for row in sorted(good, key=lambda row: row["spread_bps"]):
        print(
            f"{row['tidm']:<7} {str(row['currency']):<5} {str(row['segment']):<6} "
            f"{str(row['ems']):>8} {row['bid']:>12.4f} {row['offer']:>12.4f} "
            f"{row['spread_bps']:>11.1f}"
        )
    for row in bad:
        print(f"{row['tidm']:<7} — {row['error']}")

    print(f"\ncovered: {len(good)}/{len(TICKERS)}")
    if len(good) >= 2:
        spreads = [row["spread_bps"] for row in good]
        median = statistics.median(spreads)
        widest = max(spreads)
        tightest = min(spreads)
        print(f"round-trip spread, bps: median {median:.1f}, range {tightest:.1f}-{widest:.1f}")
        print(f"  max/min    = {widest / tightest:.1f}x")
        print(f"  max/median = {widest / median:.2f}x   (#875's 2x shape: "
              f"{'FIRES' if widest / median > 2 else 'does not fire'})")
        print(f"\nimplied HALF-spread, bps (the quantity STRUCTURAL_MIN_HALF_SPREAD_RATE floors at 1.0):")
        print(f"  median {median / 2:.1f} bps, range {tightest / 2:.1f}-{widest / 2:.1f} bps")
        over = sum(1 for spread in spreads if spread / 2 > 1.0)
        print(f"  lines whose half-spread EXCEEDS the 1bp floor: {over}/{len(good)}")
        if not live:
            print("\n  (All of the above inherits the out-of-session caveat above.)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
