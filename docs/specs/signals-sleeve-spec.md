# Signals sleeve — spec (v2, #1941)

Authority: David's rulings of 2026-09-30 on [#1941](https://github.com/dd-jp/samurai-trading-system/issues/1941), recorded in `docs/research/66-v2-grill-decisions.md` ("Rulings of 2026-09-30 — external signals sleeve") and `docs/adr/0001-samurai-v2.md` §2.3 and §5 item 22. The sleeve is built in two PRs: the endpoint and store (built), then the sleeve, books, processor and cycle integration (built, the second #1941 PR).

## 1. What the sleeve is

An external signal (a US long with an entry, a stop and up to 12 targets) arrives over a local HTTP endpoint, is stored, and is traded in its own `signals` sleeve. Every entry passes the risk gate plus an LLM entry veto; a `signals/no-veto` shadow book takes every signal the gate admits, and the veto is judged against it (doc 66 S6, S7, G5). It is a counted trial. Only the primary book submits to Alpaca paper; the shadow is simulated.

## 2. Endpoint (built)

`npm run v2:signals` starts an always-on HTTP server (`server/apps/v2/signals/main.ts`) on `127.0.0.1`, port 8789 (`V2_SIGNALS_PORT`), writing to the v2 paper store (`--dry-run` for the dry-run store, `--store PATH` for another). It opens the store with the same migrating opener the cycle uses, so it can start before the cycle has applied migration 0077.

| Route | Does |
|---|---|
| `POST /api/v2/signals` | Validates, stores, queues. 201 with `{ signal, replayed: false }`; a repeat of a stored payload returns 200 with the stored signal and `replayed: true`. |
| `GET /api/v2/signals?limit=N` | Newest first; `limit` 1–200, default 50. |
| `GET /api/v2/signals/{id}` | One signal with its status history. |
| `GET /openapi.json` | The OpenAPI 3.0.3 document. |
| `GET /docs` | Swagger UI over that document. |

**No authentication, loopback only.** David ruled no auth until the VPS move brings an auth service. Until then the server binds `127.0.0.1` only (a hard-coded constant, not a setting), and refuses any request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (403), so a web page cannot reach it by DNS rebinding. `POST` accepts `application/json` only (415 otherwise), so a browser form cannot send a simple cross-site request; bodies over 4,096 bytes are refused (413). Swagger UI loads its assets from jsDelivr; the API itself makes no outbound call.

## 3. Payload (built)

`{ symbol, entry: number | [lo, hi], targets: number[], stop, size?, trail_after?, source?, received_at? }`, validated strictly (`server/apps/v2/signals/payload.ts`); any other field is refused.

- `symbol`: an upper-case US ticker, optionally with a class suffix (`BRK.B`).
- Every price is a finite positive number. `stop` < `entry` (the zone's low); `targets` has 1–12 entries, strictly ascending, all above the entry (the zone's high). US longs only.
- `size` (0–1) is **recorded, not used**: paper sizes every signal at full risk (§5).
- `trail_after` is **recorded, not implemented**: there is no trailing stop.
- `source`: 1–64 characters from a fixed set (letters, digits, space, `_ . : @ / -`), so it cannot carry markup or prompt text into the veto prompt.
- `received_at`: the sender's timestamp, ISO 8601 with a zone; stored as `sent_at`. The server stamps its own receipt time.

**Idempotency.** A signal's key is a digest of the parsed payload plus the sender's timestamp, or the UTC receipt date when there is none. The same payload sent twice the same day is one signal; the second POST replays the first. The key is the column `v2_signals.payload_digest`, `UNIQUE`.

## 4. Store and timing (built)

Migration 0077 adds two append-only tables (update and delete refused by trigger), owned by the v2 stage: `v2_signals` (one row per signal, the payload and its window) and `v2_signal_events` (a status history: `queued`, `processed`, `refused`, `failed`, each with a detail and a time). A signal's status is its latest event.

At receipt the signal is classified against the US regular session from the existing market calendar (`UsEquityRegularHoursCalendar`, no hard-coded hours; half days close early): inside the session it is `in_session` and processed at once; outside it is `out_of_session` and processed at the next session open (`nextSessionOpen`). Both are stored as `session` and `process_after`, with a `queued` event. The calendar is hand-entered through 2027-12-31 and throws past its coverage, which the endpoint answers with 500.

## 5. Sleeve (built)

Code: `server/apps/v2/signals/processor.ts` (the processor), `server/apps/v2/signals/entry.ts` (entry plan and bracket target), `server/apps/v2/signals/veto.ts`, `server/apps/v2/signals/loop.ts` (the always-on trigger), `server/apps/v2/run-lease.ts` (the lock), and `SIGNALS_SLEEVE_SPEC` in `server/apps/v2/signal/parameters.ts`.

- **Capital:** the sleeve's capital share is 70%: on a £10,000 paper year that is a £7,000 book, a £1,050 loss cap and a £70 daily cap (doc 66, 2026-09-27). The figures are derived from the capital config and the share (D8), never written in code. Both books, `signals/primary` and `signals/no-veto`, start at the share. The rules-based candidates (#1785) have no idle cash while this holds.
- **Pooled budget:** `signals/primary` is a primary book, so it joins `debate/primary` in the account-wide pooled loss budget (the full yearly cap, marks at a third, two thirds and all of it). A signals loss of a third of the cap halves `debate/primary`'s sizing too, and the reverse.
- **Sizing:** full R: risk 0.5% of equity over the distance from the limit to the signal's stop, whole shares, the 10% position cap and every existing cap (gross, ADV, loss-budget tiers, daily cap). The signal's `size` is journalled as `size_hint` and ignored.
- **Exit:** one bracket. The stop is the signal's stop; the target is the first target at least 2R above the limit, else the last target (`target_price` on the decision, which the risk gate uses in place of its ATR target). No ladder (#1853 stands), no time stop.
- **Entry:** classified against the last daily close before today. A limit at or below it enters as a GTC limit-parent bracket; a zone is a limit at its high. An entry whose low is above the last close is a buy-stop and is refused (`entry_is_buy_stop`): Alpaca's documentation shows a bracket only with a market or limit parent, and the Alpaca adapter submits limit parents only, so a buy-stop would go in as a marketable limit. A whole zone above the close is treated as a buy-stop; a zone straddling the close enters at its high. The build's choice; David rules on stop parents (#1941).
- **Session:** an in-session signal is processed at once; an out-of-session one waits for the next open (§4). A signal whose own session has passed is refused (`session_missed`). An entry that does not fill that session is cancelled by the next daily cycle, as every stale entry is.
- **Veto:** the pinned judge model over the existing transport, under the secret guard (#1881) and the spend cap. The prompt carries the signal (symbol, entry, limit, stop, bracket target, targets, last close) and the last 20 daily bars at quoted prices, never account data. A veto skips the primary; the shadow enters regardless. When the veto cannot run (spend cap, call failure) the primary is skipped as `unavailable` and the shadow still enters.
- **Refusals:** each is journalled with scope `signal` and the code as its parameter, and closes the signal as `refused`: `session_missed`, `manual_control_paused`, `manual_control_halted`, `no_capital_config`, `not_in_universe` (not a current S&P 500 constituent), `stale_last_close`, `last_close_at_or_below_stop`, `entry_is_buy_stop`, `symbol_held` (held or resting in a signals book or any broker-routed Alpaca book). A primary with no clean Alpaca reconcile journalled for the day is blocked (`reconcile_not_clean`) while the shadow trades.
- **Concurrency:** one lease row (`v2_run_lease`, migration 0078) serialises the processor and the daily cycle. The processor tries once and skips the pass if the cycle holds it; the cycle waits up to 15 minutes, then fails. A lease held by a dead process, or older than 6 hours, is taken over. Entry order ids are `v2-<book>-<symbol>-<signal id>`, with no date, so a replayed signal finds its order and is closed as `already_submitted`.
- **Cycle:** the daily cycle runs the signals sleeve like any other (it decides nothing itself): it sweeps fills, reconciles, cancels stale entries and manages exits for both books.
- **Journal:** every signal event, decision (with the veto's verdict and reason in its payload), refusal, order and fill; the dashboard journal shows the signals books' decisions and the `signal` refusals.

### Known limits

- The daily cap binds at the next mark: the processor does not sweep fills intraday, so several same-day signals can together lose more than the daily cap before the cycle sees it.
- The shadow's simulated entry fills against the whole day's bar, including the part of the session before the signal arrived.
- Classification uses the prior close. A stock that gaps below the stop in-session still gets its limit, which is then marketable at the open's price.
- A stale Alpaca entry whose cancel fails keeps `symbol_held` refusing that symbol until it is cleared.
