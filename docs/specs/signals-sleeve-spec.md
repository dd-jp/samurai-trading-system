# Signals sleeve — spec (v2, #1941)

Authority: David's rulings of 2026-09-30 on [#1941](https://github.com/dd-jp/samurai-trading-system/issues/1941), recorded in `docs/research/66-v2-grill-decisions.md` ("Rulings of 2026-09-30 — external signals sleeve") and `docs/adr/0001-samurai-v2.md` §2.3 and §5 item 22. The sleeve is built in two PRs: the endpoint and store (built), then the sleeve, books, processor and cycle integration (planned, the second #1941 PR). Sections say which.

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

**No authentication, loopback only.** David ruled no auth until the VPS move brings an auth service. Until then the server binds `127.0.0.1` only (a hard-coded constant, not a setting), and refuses any request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (403), so a web page cannot reach it by DNS rebinding. `POST` accepts `application/json` only (415 otherwise), so a browser form cannot send a simple cross-site request; bodies over 4,096 bytes are refused (413). Swagger UI loads its version-pinned assets from jsDelivr under Subresource Integrity hashes; the API itself makes no outbound call.

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

## 5. Sleeve (planned, second #1941 PR)

- **Capital:** a £7,000 paper book, the whole idle 70% share of the £10,000 paper start; the loss cap and daily cap follow the 70% share (doc 66, 2026-09-27). The figure is derived from the capital config and the sleeve share (D8), never written in code. The rules-based candidates (#1785) have no idle cash while this holds.
- **Sizing:** full R: risk 0.5% of equity over the distance from entry to the signal's stop, whole shares, the 10% position cap and every existing cap (gross, loss-budget tiers, daily cap).
- **Exit:** one bracket. The stop is the signal's stop; the target is the first target at least 2R above the entry, else the last target. No ladder (#1853 stands).
- **Entry:** a limit at or below the last close; a zone is a limit at its high. An entry above the last close would be a buy-stop; whether Alpaca accepts a stop parent in a bracket order is not stated in its documentation, so the build treats that as unverified.
- **Veto:** the pinned judge model over the existing transport, under the secret guard (#1881) and the spend cap; the prompt carries the signal and market data only, never account data.
- **Concurrency:** the always-on processor and the daily cycle take one lock, and every order carries an idempotent id per signal, so they never race on orders or books. The daily cycle sweeps fills, reconciles and manages exits for both signals books.
- **Journal:** every signal, verdict (with the veto's reason), refusal, order and fill; the dashboard journal shows signals.
