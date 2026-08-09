# Free 5-Year Historical OHLCV — Equities Leg (SPY/QQQ/AAPL/TSLA)

> **ARCHIVED — merged into [`31-free-ohlcv-evidence.md`](../31-free-ohlcv-evidence.md).** Full probe log kept here.

Research for GitHub issue [#483](https://github.com/dd-jp/samurai-trading-system/issues/483) (child of wayfinder map [#482](https://github.com/dd-jp/samurai-trading-system/issues/482), "free 5-year historical OHLCV for the MVP universe — revisit Polygon paid decision").

Supersedes the equities half of [#155](https://github.com/dd-jp/samurai-trading-system/issues/155) / `2026-07-21-historical-data-vendor-options.md`. Crypto leg is [#484](https://github.com/dd-jp/samurai-trading-system/issues/484) — **not** covered here.

Probes run 2026-08-06 against live endpoints.

---

## Verdict (up front)

**Use the Alpaca free "Basic" tier with `feed=sip&adjustment=raw`. It is already provisioned, costs £0, and is strictly better than the Polygon Starter tier that decision #157 chose.**

The recommended source is not on the candidate list this ticket was asked to verify. It's the incumbent broker's data API, which #155 ruled out for a reason that does not survive probing.

| What #157 assumed | What the probe shows |
|---|---|
| Polygon Stocks Starter $29/mo needed for 5 years | Alpaca free gives **10.5 years** (2016-01-04 → present) |
| Alpaca free is IEX-only, too thin a tape for backtest realism | IEX-only applies to **real-time**. **Historical SIP is available on the free tier**; only the most recent 15 minutes of SIP is withheld |
| Free tiers can't do point-in-time | Alpaca returns **true unadjusted OHLC** via `adjustment=raw` — the strongest PIT position of anything tested, paid included |

**Cost impact: the $29/mo Polygon Stocks Starter line item is unnecessary.** ($49/mo Currencies Starter is #484's call, not this ticket's.)

⚠️ **One thing to confirm before building on this:** the key was shown to *behave* as free Basic (see §1), but no endpoint reports the plan name. Check the Alpaca dashboard shows Basic — a legacy/promotional plan would invalidate the "free" half of this verdict, though not the depth or PIT findings.

---

## Evidence classes

Every claim below is tagged:

- **PROBED** — I called the endpoint on 2026-08-06 and read the response. Numbers are actual.
- **DOC** — read off a vendor docs/pricing page fetched 2026-08-06; quoted.
- **UNVERIFIED** — could not test, and why.

---

## 1. Alpaca Market Data API — free "Basic" tier ✅ **RECOMMENDED**

Probed with the `ALPACA_API_KEY` already in `.env.local` (paper account, `status: ACTIVE`, $100,000 paper cash).

### Tier — behaviour matches the documented Basic profile — PROBED + DOC inference

This is the important control, because the results below look too good for a free plan. **The whole recommendation rests on this key being free-tier, so be precise about what was and wasn't established.**

What was PROBED:

```
GET /v2/stocks/AAPL/quotes/latest?feed=sip
  -> HTTP 403 {"message":"subscription does not permit querying recent SIP data"}
GET /v2/stocks/AAPL/quotes/latest?feed=iex
  -> HTTP 200 (returns a live quote)
GET https://api.alpaca.markets/v2/account       (live host)  -> HTTP 401
GET https://paper-api.alpaca.markets/v2/account (paper host) -> HTTP 200, ACTIVE, $100,000
```

None of those endpoints *names* a subscription plan. The inference is behavioural, and it's a matching argument against the DOC (`docs.alpaca.markets/docs/about-market-data-api`, fetched 2026-08-06):

- Basic is documented as **"real time IEX or 15 mins delayed SIP"**, with historical access restricted to the **"latest 15 minutes"**. Observed behaviour matches: live IEX quote served, recent SIP quote refused.
- Algo Trader Plus is documented as **"no restriction"**. Observed behaviour **contradicts** this — a paid key would not have been refused the recent SIP quote.

So the key behaves exactly as documented for Basic and cannot be on Algo Trader Plus. **Residual risk:** a legacy or promotional plan that isn't in the current pricing table would not be detected this way. Plan-level confirmation can only come from the Alpaca dashboard, which David can read and this research cannot. **Worth one glance before #241 is built on this** — everything below assumes free Basic.

The restriction is on **recent SIP**, not **historical SIP**. That distinction is the whole finding.

### Depth — PROBED

Open-ended request, `start=2000-01-01`:

```
GET /v2/stocks/bars?symbols=AAPL&timeframe=1Day
    &start=2000-01-01&end=2026-08-06&adjustment=raw&feed=sip&limit=10000
  -> 2662 bars, 2016-01-04 -> 2026-08-05, next_page_token=null
```

**10.5 years, single request, no pagination.** Requirement was 5 years (~1,260 bars). This is 2.1× the requirement.

Corroborated by DOC (`docs.alpaca.markets/docs/about-market-data-api`): both Basic and Algo Trader Plus access data **"Since 2016"** — depth is *identical* across plans; the free/paid split is recency and rate limit, not history. This confirms the #155 claim that was correct but was overridden by the IEX objection.

⚠️ **`feed=iex` has a shallow archive — this trips you up.** My first depth probes used `feed=iex` and returned **0 bars for every June from 2015 through 2020**, with 2021-06 the first month to return data. It reads exactly like a rolling ~5-year window and it is a red herring. `feed=sip` returns 2016 onward for the same symbol and date range. **Always pass `feed=sip` for backfill.**

### Full MVP equities universe in one call — PROBED

```
GET /v2/stocks/bars?symbols=SPY,QQQ,AAPL,TSLA&timeframe=1Day
    &start=2016-01-01&end=2026-08-06&adjustment=raw&feed=sip&limit=10000
  -> HTTP 200 in 1.2s
     AAPL 2662 bars  2016-01-04 -> 2026-08-05
     QQQ  2662 bars  2016-01-04 -> 2026-08-05
     SPY  2662 bars  2016-01-04 -> 2026-08-05
     TSLA 2014 bars  2016-01-04 -> 2024-01-03   <- truncated by the 10000-row cap
     next_page_token = "VFNMQXxEfDE3MDQzNDQ0MDAwMDAwMDAwMDA="
```

The 10,000 rows are the `limit` cap, not the data ending — TSLA stops mid-series and a `next_page_token` is returned. **The complete 10.5-year, 4-symbol backfill is 2 requests, ~2.4s.**

Rate-limit headers on that response: `X-Ratelimit-Limit: 200`, `X-Ratelimit-Remaining: 199` (per minute). A 2-request backfill uses 1% of one minute's budget. Incremental daily updates are 1 request/day. **Rate limits are a non-issue.**

### Point-in-time — PROBED, and this is the strongest result

The discriminating question is *not* depth, it's whether the source gives you as-of-date prices or only prices retroactively restated to today. Alpaca gives both, selected by parameter. TSLA's 3:1 split on 2022-08-25 is the test case:

```
adjustment=raw           adjustment=all
  2022-08-22  c=869.89     2022-08-22  c=289.96
  2022-08-23  c=889.30     2022-08-23  c=296.43
  2022-08-24  c=890.91     2022-08-24  c=296.97
  2022-08-25  c=296.11     2022-08-25  c=296.11
```

`raw` returns **890.91** for 2022-08-24 — the actual price printed on the tape that day, pre-split. That is genuine point-in-time data: what a backtest running on 2022-08-24 would have seen. `all` returns the retroactively split-adjusted 296.97.

`raw` and `all` are PROBED above — those two values are confirmed working on this key. The wider enum (`raw`, `split`, `dividend`, `spinoff`, `all`, comma-separable) is **DOC-inherited from #155**'s reading of `docs.alpaca.markets/reference/stockbars`; that page was *not* re-fetched this session, and `split`/`dividend`/`spinoff` were not individually probed. The recommendation only depends on `raw`, which is probed.

**This satisfies the hard PIT requirement from #155 directly, with no reconstruction step.** Note that #155 already recorded this (`adjustment` param, "Yes" in its PIT row) — it was correct and got buried under the IEX-only objection.

### Tape quality — PROBED (the #155 objection, measured)

#155's IEX-only concern was legitimate. Same three days, both feeds:

```
        2024-03-04              2024-03-05              2024-03-06
iex     c=175.09  v=1,705,811   c=170.13  v=1,462,313   c=169.11  v=  909,179
sip     c=175.10  v=81,510,101  c=170.12  v=95,432,355  c=169.12  v=68,587,707
```

IEX carries **~1.5–2% of consolidated volume**. Backtesting on that tape would badly misstate liquidity and volume-dependent logic — the #155 objection was correct on its merits. It's simply avoidable: pass `feed=sip` and the objection evaporates. Closing prices agree to within a cent; volume differs by ~50×.

### Survivorship

**Not a live axis for this ticket.** The equities universe is a fixed, hardcoded 4-ticker list (SPY/QQQ/AAPL/TSLA), and map #482 puts changing the universe out of scope. Survivorship bias is a property of *universe construction* — it arises when you select today's index members and backtest them historically. With four named, currently-listed tickers there is no selection step for a vendor to bias. No candidate distinguishes itself here, and no candidate should be eliminated on it.

It becomes a real requirement the moment the universe becomes dynamically screened. Flagged for whoever revisits universe construction — it is not a defect in this recommendation.

### Gaps

- The 2016-01-04 floor was probed for AAPL only; SPY/QQQ hit the same date in the 4-symbol call, TSLA's truncation was the row cap. Not separately probed to the floor for each symbol — low risk, all four are long-listed liquid names.
- Alpaca free-tier **data licensing for a live-money system** not reviewed. Alpaca is the execution broker and this is its own market data, so this is far more comfortable than a third-party redistribution license — but it is DOC-unverified. Worth a glance before real capital.

---

## 2. yfinance / Yahoo `chart` endpoint — ⚠️ works with caveats

Probed keylessly against `query1.finance.yahoo.com/v8/finance/chart/{sym}?range=5y&interval=1d&events=div,split` (the endpoint `yfinance` wraps — testing it directly removes the library as a variable).

**Depth — PROBED:** AAPL 1254 bars, 2021-08-09 → 2026-08-06. TSLA 1254 bars, same range. Exactly 5 years, matching the claim. ~1,260 expected trading days, so no gaps of consequence.

**Payload — PROBED:** returns `indicators.quote` (open/high/low/close/volume), a *separate* `indicators.adjclose` array, and an `events` block. AAPL carried 20 dividend events; TSLA carried the 2022-08-25 3:1 split with `numerator/denominator`.

**Point-in-time — PROBED, and the user's table understates the problem.** Yahoo's `quote` array is **not raw**. TSLA 2022-08-24 close comes back as **297.10** — that is 890.91 ÷ 3, i.e. retroactively split-adjusted. Compare Alpaca's raw 890.91 for the same bar.

So Yahoo's two arrays are *split-adjusted OHLC* and *split-and-dividend-adjusted close*. Neither is as-of-date. PIT is **reconstructible but not given**: because the split events ship with the payload, you can un-adjust to recover true as-of prices. That's real work — an adjustment-replay layer, per symbol, that must be right or it silently corrupts every backtest.

For AAPL, `close` 146.09 vs `adjclose` 142.61 on 2021-08-09 differ by dividends only (no in-window split), which is why AAPL alone would not have surfaced this. **The split case is the one that exposes it** — worth remembering if this is ever re-tested.

**Verdict: works, but strictly dominated.** Alpaca hands you `adjustment=raw` for free; Yahoo makes you rebuild it. Also: unofficial endpoint, no SLA, no terms permitting programmatic use, 429s under load. Keep as an emergency cross-check source, not the primary.

---

## 3. Tiingo — ⚠️ **UNVERIFIED (no key)**, and the licence is a likely blocker

`GET api.tiingo.com/tiingo/daily/aapl/prices` without a token → **HTTP 403 `{"detail":"Please supply a token"}`** (PROBED). No key is provisioned, so nothing about actual response shape, adjustment behaviour, or real depth could be tested.

DOC (`tiingo.com/pricing`), answering the ticket's questions directly:

| Ticket asked | Answer (DOC, verbatim where quoted) |
|---|---|
| 500 symbols/mo — real, and is it symbols or requests? | **"Unique Symbols per Month: 500"** — distinct symbols, not requests. A 4-symbol universe uses 0.8% of it. Not a constraint. |
| Rate limits | **"Max Requests Per Hour: 50"**, **"Max Requests Per Day: 1000"**, **"Max Bandwidth Per Month: 1 GB"**. The user's table cited 1,000/day but **missed the 50/hour cap — that is the binding limit.** Still ample for 4 symbols. |
| Adjusted EOD included on free? | Not established from the pricing page. **UNVERIFIED.** |
| Survivorship-free / PIT? | Not stated. **UNVERIFIED** — and this is the axis that matters. |
| Depth | **"30+ Years"** at free-tier level. |

🚩 **Licence — the finding that likely settles it.** Tiingo's free tier carries an **"Internal Use Only"** restriction: *"you may only use the data for your own personal use and you may not display or share the data with another person or organization."* Samurai is David's own system, so personal trading use is plausibly within this — but the project has a **web dashboard** as its 12th component. If that dashboard ever displays Tiingo-derived prices to anyone other than David, that clause is breached. Read it before adopting Tiingo, not after.

**No provisioning ticket is being raised for this.** Under the advisor's framing, an unprobeable strongest-candidate would justify a `wayfinder:task` to get a key. That doesn't apply: Alpaca is already probed, free, deeper (10.5y vs Tiingo's need-to-verify), and has no licence restriction — so a Tiingo key would cost David signup effort to evaluate a strictly worse option. **Revisit only if the Alpaca recommendation fails in implementation.**

---

## 4. Alpha Vantage — ❌ fails

PROBED: `TIME_SERIES_DAILY&symbol=IBM&apikey=demo` → HTTP 200 but body is a stub: *"The **demo** API key is for demo purposes only. Please claim your free API key..."*. No data. Real evaluation needs a key.

The user's table already scores it correctly: **25 requests/day** is the killer. Even at 4 symbols that is workable for a one-time backfill but leaves nothing for retries, and it's an order of magnitude below Alpaca's 200/**minute**. Dominated; not worth provisioning a key to confirm.

---

## 5. EODHD — ❌ fails

DOC (`eodhd.com/pricing`): free plan is **"20/day"** API calls, and *"you can't access certain data types."* The 30+ years of history is a paid-tier feature; free-tier depth is unstated.

20 calls/day cannot support a backfill with any retry headroom. Confirms the user's table. **Fails.**

---

## 6. Finnhub — ❓ **UNVERIFIED**

`finnhub.io/pricing` did not render its pricing table when fetched (returned only the marketing blurb). Could not confirm free-tier candle history, limits, or whether US stock candles are free-tier accessible at all.

Not pursued further: the user's table scores its history as weak, and it is dominated by a probed free option. **Recorded as unverified rather than passed or failed** — no verdict is claimed on evidence I don't have.

---

## Summary table

| Source | Depth | PIT (unadjusted available?) | Limits | Evidence | Verdict |
|---|---|---|---|---|---|
| **Alpaca free Basic (`feed=sip`)** | **10.5y** (2016-01-04→) | **Yes — `adjustment=raw`, true as-of prices** | 200/min | **PROBED** | ✅ **Recommended** |
| Polygon Starter (#157 incumbent) | 5y | Not established (#155 gap, still open) | Unlimited | DOC only | 💸 $29/mo — unnecessary |
| yfinance / Yahoo chart | 5y | Reconstructible only (split-adjusted; events shipped) | Throttled, 429s | PROBED | ⚠️ Dominated; emergency fallback |
| Tiingo free | 30+y (DOC) | Unknown | 50/hr, 1000/day, 500 sym/mo | DOC + 403 probe | ⚠️ Unverified + "Internal Use Only" licence |
| Alpha Vantage free | 20+y (DOC) | Unknown | **25/day** | PROBED (demo stub) | ❌ Rate limit |
| EODHD free | Unstated on free | Unknown | **20/day** | DOC | ❌ Rate limit |
| Finnhub free | Unknown | Unknown | Unknown | — | ❓ Unverified |
| Stooq (not on the list) | — | — | — | PROBED | ❌ JS proof-of-work bot wall, not scriptable |

---

## Recommended call pattern for Stage 2 ingestion (#241)

```
GET https://data.alpaca.markets/v2/stocks/bars
  ?symbols=SPY,QQQ,AAPL,TSLA
  &timeframe=1Day
  &start=2016-01-04T00:00:00Z
  &end=<today>
  &adjustment=raw          # true point-in-time; use 'all' only for display
  &feed=sip                # REQUIRED — 'iex' silently returns a shallow archive
  &limit=10000
Headers: APCA-API-KEY-ID, APCA-API-SECRET-KEY   (existing .env.local values)
```

Follow `next_page_token` until null — 2 pages for the full 4-symbol, 10.5-year pull.

**Implications for #241**, which currently expects Polygon/Massive:
1. Its unprovisioned-Polygon-key precondition **disappears** — the Alpaca key already exists and is already used for execution.
2. Feed must be pinned to `sip` explicitly. A default or an `iex` fallback silently yields a shallow, 2%-volume tape — a quiet correctness bug, not a loud failure.
3. `adjustment` should be an explicit parameter at the ingestion seam, defaulting to `raw`.
4. Alpaca is now both execution adapter *and* backtest data source. ADR-0001 mandates these stay separate seams — **keep them separate in code** even though they share a vendor and a key, or the abstraction that lets crypto use a different source will collapse.

---

## What this changes on map #482

- The equities leg needs **no paid tier and no new vendor**. #157's Polygon Stocks Starter ($29/mo) is superseded for equities.
- The map's "Not yet specified" bullet on PIT/survivorship status of free candidates is **resolved for equities**; the crypto half stays open for #484.
- The full paid-vs-free decision still needs #484 — Kraken's 720-candle cap makes crypto the harder leg, and the $49/mo Currencies Starter stands or falls there. **Note Alpaca also serves crypto bars** (`/v1beta3/crypto/...`, no `adjustment` param since crypto has no corporate actions) — #484 should probe it first, given the equities result. Not probed here; out of this ticket's scope.
