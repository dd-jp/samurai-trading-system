# Live Transport Layer Specification

**Status:** Draft (resolved wayfinder decisions synthesized)
**Owner:** David (Deepak)
**Date:** 2026-07-31

## Problem Statement

`src/orchestrator/index.ts`'s doc comment and ADR-0004 both name the same gap: every stage, adapter, and interface the pipeline needs is built and tested, but nothing in `src/` implements the live wire clients those interfaces are injected against. Concretely: `AlpacaClient` (both the broker-order shape in `src/execution/adapters/alpaca-client.ts` and the market-data shape in `src/market-data-service/sources/alpaca-source.ts`) has no real HTTP implementation; `AnthropicMessagesClient` has no promoted production module (only a test helper); `TelegramClient` has no implementation at all, and its existing interface (`sendApprovalRequest`) doesn't match the transport `production.ts` actually wires (`SignedApprovalChannel`); `PolygonClient` (Stage 2) has no real implementation; and `AccountStateProvider`/`VolatilityReadingProvider` — required constructor dependencies for the Trader/Risk/Verdict direct-bind wiring — have zero in-repo data source, per `direct-bind.ts`'s own doc comment.

Without these five things, `startFromEnvironment` cannot start a real (non-mock) tick, and Stage 2 (#245) cannot run a real historical verdict. This is the last design gap between "all 12 components wired" (ADR-0004) and an actual paper-trading run.

## Solution

Five independent decisions, each closing one seam already named by an existing interface — no interface in the codebase changes shape except `TelegramClient`, which is narrowed (see Module: TelegramClient below):

1. **`AlpacaClient` (broker + data)** — both existing interfaces map directly onto Alpaca's real Trading API v2 / Market Data API v2. No code changes to the interfaces; only real HTTP implementations.
2. **`AnthropicMessagesClient`** — already implemented and proven (via the debate-engine integration test); this decision only promotes it from test helper to a small production module, reading its API key/model from env.
3. **`TelegramClient`** — long-polling (`getUpdates`), authenticated via Telegram's own `callback_query.from.id` against a user-id allowlist, retiring the interface's current `sendApprovalRequest` method in favor of a shape that composes with the already-decided `SignedApprovalChannel` (#207).
4. **`PolygonClient`** — a real HTTP implementation of the existing Stage 2 interface against Polygon/Massive's aggregates endpoint.
5. **`AccountStateProvider` / `VolatilityReadingProvider`** — not single new services; each splits into narrow pieces wired from data that already exists (Alpaca's account endpoint, a small new peak-equity tracker, the existing `ClosedTrade` store, and the already-shipped `MarketDataService.getIndicator`).

Cutting across all five: a shared error taxonomy, a shared (but per-client-configured) retry/backoff mechanism, and a consistent env-var naming convention — generalized from the pattern `AnthropicLlmClient`/`retry.ts`/`errors.ts` already established for the LLM client, rather than four independently-invented conventions.

## User Stories

### AlpacaClient (broker)

1. As the Execution stage, I want `AlpacaClient.submitOrder` to place a real bracket order against Alpaca's Trading API, so that a verdict's `go` decision becomes a real order.
2. As the Execution stage, I want `getOrder`/`getOrderByClientOrderId` to reflect the broker's current view of an order, so that reconciliation (#86) works against real state.
3. As the crash-restart reconciliation path, I want a 404 from `GET /v2/orders:by_client_order_id` mapped to the interface's documented `null` (not a thrown error), so that "no such order yet" and "transport failure" stay distinguishable.
4. As the system, I want bracket-order child legs (take-profit/stop-loss) recovered from each leg's own `id` + `type`, not from a `client_order_id` suffix, so that leg identity survives Alpaca's server-generated child ids.

### AlpacaClient (market data)

5. As the Market Data Service's `AlpacaDataSource`, I want `getBars`/`getLatestQuote` to hit Alpaca's real Market Data API v2, so that the MVP universe's bars/marks are real, not simulated.
6. As the data source, I want crypto vs. equity requests routed by path-root (`/v2/crypto/us/...` vs `/v2/stocks/...`), not by a query parameter, so that the client matches Alpaca's actual routing.

### AnthropicLlmClient (production wiring)

7. As the composition root, I want a production `AnthropicMessagesClient` implementation (raw `fetch`, no SDK dependency) promoted from the integration test's inline helper into a real module, so that `production.ts` can construct `AnthropicLlmClient` without depending on test code.
8. As the debate engine, I want the model pinned via an `ANTHROPIC_MODEL` env var (default `claude-haiku-4-5-20251001`), so that a model swap is a config change, not a code change.
9. As the system, I want the existing `withRetry`/timeout/error-classification/prompt-injection wiring left untouched, so that this decision only fills in the wire client, not re-decide anything already shipped.

### TelegramClient (heartbeat + HITL)

10. As the Orchestrator, I want `TelegramClient.sendMessage` for heartbeat/notify posts, unchanged from today's shape.
11. As Verdict's HITL gate, I want an approval request sent with two inline buttons (approve/reject), so that David can respond from Telegram without typing.
12. As the concrete `TelegramClient`, I want a single long-poll loop (`getUpdates`) started once at process startup, so that inbound button presses are observed without a public webhook endpoint.
13. As the inbound callback handler, I want every `callback_query.from.id` checked against a configured allowlist before anything else happens, so that only David's own Telegram account can resolve an approval.
14. As the inbound callback handler, I want the button press correlated back to its pending request via a short opaque token (not the raw `trace_id`/`idempotency_key`), so that `callback_data` fits the Bot API's 64-byte cap.
15. As the inbound callback handler, I want the recovered `trace_id`/`idempotency_key`/`outcome` locally reconstructed and HMAC-signed before being handed to `SignedApprovalChannel.handleCallback`, so that #207's authn/authz code path runs unchanged regardless of transport.
16. As the human's Telegram client, I want `answerCallbackQuery` always called after a button press, so that the button doesn't spin indefinitely.
17. As a process that restarts mid-approval, I want the correlation-token map to expire on the same `timeout_ms` as `SignedApprovalChannel`'s own pending entry, so that a crash produces the same fail-safe timeout the rest of the system already assumes.
18. As `/implement`, I want `TelegramChannel`/`TradeChannel`'s existing `requestApproval`/`sendApprovalRequest` flagged as dead code (never constructed outside their own tests, superseded by #207's `SignedApprovalChannel`), so that it isn't reimplemented instead of retired.

### PolygonClient (Stage 2)

19. As `Stage2HistoricalStore`, I want a real `PolygonClient.fetchAggregates` implementation against Polygon/Massive's daily-aggregates endpoint, so that Stage 2's trial grid runs against real historical data instead of a fake.
20. As the client, I want the `{results: [...], next_url}` envelope unwrapped and `t,o,h,l,c,v` mapped onto `PolygonAggregate`, dropping the extra `vw`/`n` fields Polygon's real response carries.
21. As the client, I want crypto symbols translated (`BTC-USD` → `X:BTCUSD`) before the request, so that the same endpoint serves both asset classes.
22. As the client, I want `next_url` pagination followed when present, so that a request spanning more than one page (unlikely at this universe's scale, but possible) doesn't silently truncate.

### AccountStateProvider

23. As `computePortfolioView`, I want `cash` and `equity` sourced from Alpaca's `GET /v2/account`, so that the broker's own authoritative ledger is the source of truth, not a reimplementation. The *daily* figure is deliberately NOT sourced there — see the `daily_basis` bullet below (GAP-8, resolved by [#332](https://github.com/dd-jp/samurai-trading-system/issues/332)).
24. As the system, I want `peak_equity` tracked as a small locally-persisted running max of equity, updated once per tick, so that an all-time high-water mark exists even though Alpaca's account endpoint has no such field.
25. As the system, I want `consecutive_losses` derived by walking the existing `ClosedTrade` store in reverse-chronological order, so that no new realized-PnL ledger is built when one already exists.

### VolatilityReadingProvider

26. As `CircuitBreakers.evaluate`, I want a `VolatilityReading` (`{crypto, stocks}`) computed via `MarketDataService.getIndicator` over the active universe, aggregated **per asset class by max** (not average), so that the breaker's worst-case-trips-it intent is preserved.
27. As the provider, I want a fixed default instrument per asset class used when no positions are currently open, so that the breaker has a reading even pre-position.

### Shared Conventions

28. As any of the four clients, I want failures classified into the same three-way taxonomy (Timeout/RateLimit/ProviderError) from HTTP status, so that retry logic is uniform across clients.
29. As any of the four clients, I want exponential-backoff retry (same algorithm as the LLM client's `retry.ts`) with client-specific `maxAttempts`/`baseDelayMs`/`maxDelayMs`, so that Alpaca's ~200 req/min and Polygon's 5 calls/min free tier are each respected without one client's config leaking into another's.
30. As a developer reading `.env.local`, I want every secret named consistently (`{PROVIDER}_API_KEY`/`_SECRET`), so that adding a new client's credentials follows an obvious pattern.

## Implementation Decisions

### Module: Shared Transport Conventions

**Error taxonomy** — each client keeps its own typed 3-way error hierarchy, mirroring `src/debate-engine/llm/errors.ts`'s shape: a `{Client}TimeoutError`, `{Client}RateLimitError` (with an optional `retryAfterMs` where the provider supplies a hint), and a `{Client}ProviderError` catch-all (auth/bad-request/5xx/network — not classified further). Classification duck-types HTTP status the same way `classifyProviderError()` does: `429` → RateLimit, `408`/`504` → Timeout, else → ProviderError. `LlmMalformedResponseError`'s retry-on-reparse is LLM-specific (a fresh sample may parse cleanly) and does not generalize — Alpaca/Polygon/Telegram get no malformed-response retry class.

**Retryable set extends beyond the LLM client's precedent: Timeout | RateLimit | ProviderError-with-5xx-status.** The LLM client's `isRetryable()` only retries Timeout/RateLimit because `LlmProviderError` in that domain is dominated by auth/bad-request failures a retry can't fix. The other three clients' `ProviderError` catch-all also covers transient upstream 5xx (Alpaca/Polygon/Telegram all being third-party HTTP services), and a transient 500/502/503 on an idempotent read (`getOrder`, `GET /v2/account`, `fetchAggregates`) must not hard-fail a reconciliation or account-state read on the first bad response. So each of the four clients' `isRetryable` predicate treats `ProviderError` as retryable **only when the underlying HTTP status is in `500`–`599`**; 4xx `ProviderError`s (auth, bad request) stay non-retryable. **`retryAfterMs` is honored when the provider supplies it:** if a `RateLimitError` carries `retryAfterMs`, that value is used as the delay for the next attempt instead of the computed exponential backoff. **No jitter** — matches the existing `retry.ts` precedent (none today); not added here, since with per-client single-process polling (not a fleet of concurrent callers) there's no thundering-herd risk to jitter against.

**Retry/backoff** — the exact algorithm already in `src/debate-engine/llm/retry.ts` (`baseDelayMs * 2 ** (attempt - 1)`, capped at `maxDelayMs`) is generalized out of `src/debate-engine/llm/` into a new shared, provider-agnostic module (`src/shared/http/retry.ts`), parameterized by a generic `RetryConfig { maxAttempts, baseDelayMs, maxDelayMs }` and an injected `isRetryable(error): boolean` predicate per call site — not a shared error-type check, since each client's error hierarchy is its own. `withRetry(fn, config, isRetryable)` replaces the LLM-specific `withRetry(fn, config)`; `AnthropicLlmClient` moves onto the generalized version with its existing `isRetryable` closed over (unchanged — the LLM client keeps its narrower Timeout|RateLimit-only retryable set, since this 5xx extension is scoped to the four transport clients described here, not a retroactive change to the LLM client's decided behavior). Config *values* are per-client constants sized to that client's own known rate limit — Alpaca's ~200 req/min tolerates a short base delay; Polygon's 5 calls/min free tier needs a much longer one — never shared constants.

**Env var naming** — extends the already-settled `.env.local` convention (existing `POLYGON_API_KEY`) with a consistent `{PROVIDER}_...` shape:
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-haiku-4-5-20251001`)
- `POLYGON_API_KEY` (already provisioned)
- `ALPACA_API_KEY`, `ALPACA_API_SECRET`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS` (comma-separated Telegram user ids — an allowlist of *who may approve*, not a destination; deliberately not a single chat id, since the trade channel is a group/channel and `chat.id` is shared by every member)
- `TELEGRAM_HEARTBEAT_CHAT_ID` (added by #342) — the destination for the dead-man's-switch heartbeat, and only that. Required under `SAMURAI_ALERTS=telegram` and refused at startup when it equals `TELEGRAM_CHAT_ID`: the heartbeat repeats forever, and sharing the escalation chat is what makes an operator mute it. A muted heartbeat chat costs nothing; a muted escalation chat costs the escalations.
- `TELEGRAM_CHAT_ID` (added by #322) — the *destination* the outbound operator **escalations** are posted to: the restart-time orphaned `go` verdict, the aged-out unpriced fill, and the kill-threshold breach. (It carried the heartbeat too until #342 moved it out.) Orthogonal to the allowlist above and never a substitute for it: this says where a message goes, the allowlist says whose button press may resolve an approval. Required only under `SAMURAI_ALERTS=telegram` (see below).
- `SAMURAI_ALERTS` (added by #322) — `telegram` or `log-only`, **required, no default**. Selects whether the four outbound operator alerts — heartbeat, orphaned `go` verdict, stuck unpriced fill, and (added by #327) kill-threshold breach — reach a phone or only the log stream. There is no default in either direction: falling back to log-only by omission is what made an "unattended" soak (#238) not unattended, and defaulting to `telegram` would fail every developer run for want of a bot token. `telegram` additionally requires all four `TELEGRAM_*` variables above — bot token, allowlist, escalation chat, heartbeat chat — and startup fails naming whichever are absent. (A caller that injects its own `heartbeatChannel` is not asked for `TELEGRAM_HEARTBEAT_CHAT_ID`, which is why the startup pre-flight splits that one out; for the shipped entrypoint it is always four.) Selection lives at the entrypoint (`src/orchestrator/alert-transport.ts`), not in the composition root, so a programmatic caller injecting its own channels never consults the environment.

**No shared HTTP client base class.** The four clients stay independent — matching `AnthropicLlmClient`'s existing standalone precedent (raw `fetch`, no SDK, no shared base) — because auth-header shape (Bearer vs. query-param), base-URL/path-root splits, response envelopes, and polling-vs-request-response differ enough per provider that forcing a common base would fight the interface more than help it. Only two pieces are extracted, because they have zero per-client variance:
1. The generalized `withRetry` loop above.
2. A small `fetchWithTimeout(url, init, timeoutMs)` `AbortController` wrapper — every client needs a request timeout and it is pure boilerplate.

Both land in `src/shared/http/`.

### Module: AlpacaClient (broker)

**No interface change.** `src/execution/adapters/alpaca-client.ts`'s `AlpacaClient` (`submitOrder`/`getOrder`/`getOrderByClientOrderId`) already matches Alpaca's Trading API v2 (`POST /v2/orders`, `GET /v2/orders/{id}`, `GET /v2/orders:by_client_order_id`) directly.

- **404 → `null` mapping is load-bearing.** `getOrderByClientOrderId` must catch a 404 from Alpaca and resolve `null`, never throw — #86's crash-restart reconciliation depends on the documented `null` contract holding for real.
- **Rate limit:** ~200 req/min per key — the tightest of the four transport clients' known limits, sized into this client's `RetryConfig` per the shared-conventions module above.
- **Auth:** credentials sourced from `ALPACA_API_KEY`/`ALPACA_API_SECRET`. **Implementation-time verification note:** #260's research had no live network access in its sandbox and explicitly flags re-verifying against current Alpaca docs before implementation — the exact header names (`APCA-API-KEY-ID`/`APCA-API-SECRET-KEY` per Alpaca's public docs, unconfirmed here) are not decided by this spec, only the env var names that hold them.
- **Pagination on `getOrder`-adjacent list endpoints:** not needed by this interface's three single-order methods; explicitly out of scope here.
- **Paper/live is an explicit constructor option, never an inferred default (#293).** The client takes `environment: 'paper' | 'live'`, defaulting to `'paper'`, and derives its base URL from it. A `baseUrl` naming one Alpaca trading host while `environment` names the other throws at construction, before any order can be placed; so does an empty or unparseable `baseUrl`. Reaching `https://api.alpaca.markets` requires typing `environment: 'live'` — it is not reachable by omission, by a defaulted constant, or by a mis-set env var, per CLAUDE.md's money-graduation ladder. Alpaca exposes no cheap "is this key paper or live" probe, so this is a consistency check between two operator-supplied facts, not a verification that the credentials belong to the named environment. The orchestrator's composition root derives `environment` from `SAMURAI_MODE` (`live` → live, `paper`/`backtest` → paper) and classifies any `ALPACA_BASE_URL` override with the same shared host classifier. Non-Alpaca hosts (mock/staging) are permitted in either environment. **The market-data client carries no such option deliberately:** `data.alpaca.markets` serves paper and live accounts alike, so it has no environment to get wrong.

### Module: AlpacaClient (market data)

**No interface change.** `src/market-data-service/sources/alpaca-source.ts`'s `AlpacaClient` (`getBars`/`getLatestQuote`) maps onto Alpaca's Market Data API v2.

- **Crypto/equity is a path-root split, not a query parameter:** `/v2/stocks/...` vs. `/v2/crypto/us/...`, selected by `AlpacaSourceOptions.asset_class`, which the data source already threads through to the client. The exact bar-endpoint path beneath each root is an **implementation-time verification note** — #260 confirmed the root split, not the full path.
- **`getBars` pagination:** Alpaca's bars endpoint can page for a long lookback; deferred to implementation-time verification (check whether the MVP universe's actual windows ever hit a page boundary before building pagination-following logic) — an implementation-time check, not a design decision, per #260's research.
- **Auth/credential-sharing with the broker client:** whether one Alpaca key pair covers both trading and market-data endpoints, or two separate pairs are needed, was not resolved by #260 and is an **implementation-time verification note**, not a decision made here.

### Module: AnthropicMessagesClient (production)

- **Promote, don't redesign.** The `createMessage` implementation already proven in `disagreement-detector.integration.test.ts` (raw `fetch` to `https://api.anthropic.com/v1/messages`, header `anthropic-version: 2023-06-01`) moves from test helper to a production module, e.g. `src/debate-engine/llm/anthropic-http-client.ts`, implementing the existing narrow `AnthropicMessagesClient` structural interface.
- **No SDK dependency** — `@anthropic-ai/sdk` is not added; the structural interface exists precisely so a raw-HTTP implementation satisfies it.
- **Non-streaming** — `AnthropicLlmClient.complete()` awaits the full response; nothing in `debate-engine-spec.md`'s latency budgets (15s crypto / 60s stocks) requires streaming.
- **Model pin:** `ANTHROPIC_MODEL` env var, defaulting to `claude-haiku-4-5-20251001` (bumped from the now-stale `claude-3-5-haiku-latest` used in the pre-existing integration test, which should be bumped alongside this module). Threaded through `AnthropicLlmClientConfig.model`.
- **Auth:** credentials sourced from `ANTHROPIC_API_KEY` in `.env.local`. The exact header name is not decided here — #261's resolution confirms `anthropic-version: 2023-06-01` and the raw-`fetch` shape but not the auth header; the pre-existing integration test this module promotes from is the concrete reference to copy at implementation time.
- **Retry/timeout/error-classification/prompt-safety** (`withRetry`, per-attempt timeout, `LlmTimeoutError`/`LlmRateLimitError`/`LlmProviderError`/`LlmMalformedResponseError`, `wrapUntrusted`) — **all already shipped in `AnthropicLlmClient`; no change.** Only its `retry.ts` internals move onto the generalized shared retry module (see Shared Transport Conventions), which is a refactor with no behavior change.
- **Composition:** `production.ts` constructs one `AnthropicLlmClient` (real `createMessage` + config) and closes each persona/detector over it — no change to `personas.ts`/`disagreement-detector.ts`.

### Module: TelegramClient

**Interface change** — `src/verdict/notifications/types.ts`'s `TelegramClient.sendApprovalRequest` is retired, since it bakes in a synchronous request/response round trip the polling transport can't offer (the response arrives on a separate inbound `callback_query`, not as this call's return value). Replacement shape, three capabilities (exact method names/signatures are an `/implement`-time detail, not decided here):
- `sendMessage` — unchanged, already used for heartbeat/notify.
- Send an approval request with two inline buttons (approve/reject), tagged with a correlation token minted at send time (see below) — does not block for the response.
- A way to register a handler for inbound `callback_query` updates, invoked after the `from.id` allowlist check below has already run.

The long-poll loop (`getUpdates`) lives inside the concrete client, started once at process startup alongside `Heartbeat`.

- **Transport: long polling (`getUpdates`), not webhook.** Matches every other client in this map — all outbound-only — and there is no inbound HTTP server anywhere in this codebase; a MacBook host with no public DNS/TLS story makes a webhook endpoint disproportionate. `getUpdates` is single-consumer per bot token (a second concurrent poller gets HTTP 409): exactly one process (the Orchestrator) may poll a given bot token; Stage 2/backtest processes must never poll it.
- **Offset handling is part of the loop contract.** The client tracks the highest `update_id` it has processed and passes `offset = last_update_id + 1` on every subsequent `getUpdates` call, per Telegram's own redelivery contract — otherwise Telegram redelivers every unacknowledged update on each poll and again after a restart, double-processing the same callback. The offset is in-memory only (not persisted across restarts): a restart may see one batch of already-actioned updates redelivered, but each is independently harmless — an already-resolved or expired correlation token is a no-op (see Correlation below), so redelivery duplicates no side effect.
- **Authenticator: `callback_query.from.id` against a config-provisioned allowlist (`TELEGRAM_ALLOWED_USER_IDS`) — not `chat.id`.** This **amended `verdict-spec.md`'s former HMAC-over-the-wire wording** (amendment landed per #272 — see its "Module: Human-in-the-Loop", now in agreement): under polling there is no public inbound endpoint, so #207's named threat (a spoofed webhook hit) is structurally impossible, and the trade channel is a group/channel, so `chat.id` is shared by every member and cannot serve as a per-user identity check.
- **Every rejected `from.id` is logged, not silently dropped.** A `callback_query` that fails the allowlist check is written to the existing audit log (`SqliteAuditLog`) before being no-op'd, with the same field set required by `verdict-spec.md`'s "Observability — allowlist failure" bullet: channel, failure reason, offending `from.id`, `chat.id`, a truncated prefix of the callback's correlation token (first 8 hex chars — never the full token, which is a live bearer capability until timeout), the `trace_id` it maps to when known, and timestamp. Because the allowlist check (step 1) runs before token recovery (step 2), populating `trace_id` requires the rejection-logging path to do a **best-effort read-only lookup** of the token map: read the entry if the token matches and populate `trace_id`, never resolve/consume/expire anything, and log the field as absent when there's no match. The allowlist is the only inbound *identity* control gating live-money approvals (the correlation token scopes which request, not who); a rejection with no trace would make a misconfigured or attacked allowlist invisible until an approval mysteriously never resolved. Repeated rejections (a plausible probing signal) should also surface on the existing heartbeat/notify channel rather than sitting silently in the audit log — exact alerting threshold is an implementation detail, not decided here.
- **The HMAC step is decorative under this transport, and that must be stated plainly.** Step 3 below has the same process construct-and-sign the payload it then verifies with the same secret — a same-process round trip through your own signature check proves nothing about the caller and can fail only via an in-process bug (see step 3), never a forgery. Under Telegram polling, **the `from.id` allowlist is the sole working access control over *who* may approve** a live-money trade (the correlation token below scopes *which* request a callback can resolve — orthogonal, not an identity check); `SignedApprovalChannel`'s HMAC (#207) is preserved only as the transport-agnostic code path (relevant if a future webhook-based channel, e.g. Discord, is added), not as a security boundary here. Consequently, a **permissive or wrong** `TELEGRAM_ALLOWED_USER_IDS` (an over-broad list or the wrong id — the permissive shapes that survive boot-time validation, which rejects wildcards and non-numeric entries) is a **critical exposure** — it is the only thing standing in front of `SignedApprovalChannel.handleCallback`; an **empty or unset** allowlist instead fails closed (nothing can ever match, so every approval times out to `no_go`) and is caught by the boot-time validation required in `verdict-spec.md`'s "Module: Human-in-the-Loop" — and both this document and the `verdict-spec.md` amendment below must say so explicitly, not imply the HMAC is still doing authorization work. Concrete inbound flow:
  1. Check `from.id` against the allowlist; log and discard (no-op) on any mismatch (see above).
  2. Recover which pending request + outcome the button represents via the correlation token (below).
  3. Locally construct + HMAC-sign the `ApprovalCallbackPayload` (`trace_id`, `idempotency_key`, outcome) using the configured secret, then call `SignedApprovalChannel.handleCallback` — preserving #207's code path and existing fail-safes (unmatched/expired entry → no-op, falls through to `SignedApprovalChannel`'s own `timeout_ms`). This step is a **dormant, transport-agnostic seam, not defense-in-depth** under this transport (see `verdict-spec.md`'s "Module: Human-in-the-Loop" for the full rationale) — the access-control decision already happened in step 1. Because this check still sits in the live resolution path, an in-process bug that changes one side of the round trip between send and callback — secret rotation/config reload while approvals are in flight, or code drift (e.g. a deploy changing payload canonicalization) — silently fails-closed every in-flight approval (verification fails → never resolves → times out) — caught by `verdict-spec.md`'s dead-gate timeout-rate alert, not by boot validation. A missing/empty secret would **not** fail this same-process round trip (HMAC with an empty key signs and verifies consistently), which is exactly why the verifier must reject an empty/missing secret at construction and the same boot-time validation required for `TELEGRAM_ALLOWED_USER_IDS` applies to this secret too (see `verdict-spec.md`'s "Module: Human-in-the-Loop" — "HMAC secret boot-time validation").
  4. Always call `answerCallbackQuery`, or the human's Telegram client spins on the pressed button indefinitely.
- **Correlation: an opaque per-button token — 32 hex chars (128 bits) from a CSPRNG, not the raw payload.** 128 bits is the floor because the token is a bearer capability on a live-money approval: its unguessability must hold on its own, not lean on the per-request `timeout_ms` window shrinking the guessing budget (the expiry is a bonus, not the security argument). `callback_data` is capped at 64 bytes by the Bot API, which 32 hex chars fits comfortably; `trace_id:idempotency_key:outcome` is already ~80+ bytes before any signature, which is why the raw payload can't ride along. `TelegramClient` keeps a local `token → {trace_id, idempotency_key, outcome}` map, one entry per button, populated when the approval request is sent and expired on the same `timeout_ms` as `SignedApprovalChannel`'s own pending entry, so the two stay in sync. A process restart drops both maps identically — the same fail-safe-to-timeout (`no_go_reason: 'timeout'`) already assumed for crash-restart elsewhere in the system, introducing no new failure mode.
- **Retire as dead code:** `TelegramChannel`/`TradeChannel`'s (#81) existing `requestApproval`, and `TelegramClient`'s current `sendApprovalRequest` — confirmed never constructed outside their own tests; `production.ts` already documents wiring `SignedApprovalChannel`, not `TelegramChannel`, as the production `ApprovalChannel`.
- **Auth:** `TELEGRAM_BOT_TOKEN`.
- **Out of scope:** BotFather bot creation (ops/setup task, per verdict-spec.md's "Channel provisioning").

### Module: PolygonClient

**No interface change.** `src/cost-model-backtest/stage2-historical-store.ts`'s `PolygonClient.fetchAggregates(symbol, window: DateRange)` maps onto Polygon/Massive's real aggregates endpoint.

- **Endpoint:** `GET /v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}` — same endpoint for stocks and crypto. Base host: `api.polygon.io` (legacy, still functional) — pick this as the constant; Polygon rebranded to Massive.com but the legacy host and `POLYGON_API_KEY` continue to work, and re-pointing to `api.massive.com` later is a config change, not a redecision.
- **Response shape:** wrapped in `{results: [...], next_url}` — not a flat array. `t,o,h,l,c,v` map 1:1 onto `PolygonAggregate`; the real response also carries `vw`/`n`, which the client drops rather than spreading through.
- **Crypto ticker translation:** `BTC-USD` → `X:BTCUSD` (same endpoint, `X:` prefix, no dash) before the request.
- **Pagination:** follow `next_url` when present. Unlikely to trigger for this MVP universe's daily bars at current lookback windows, but the client must not silently truncate if it does. Whether the API key needs manual re-appending to `next_url` is an **implementation-time verification note**, not resolved here.
- **Rate limit (stocks, confirmed):** Free tier = 5 calls/min, 2yr lookback, EOD-only — the tightest of the four clients' known limits, sized into this client's `RetryConfig`. Starter tier = unlimited calls, 5yr lookback, 15-min delayed.
- **Crypto-tier rate limits: unconfirmed** (pricing page did not render statically) — **implementation-time verification note**: check before assuming parity with the stocks tier.
- **Auth:** `Authorization: Bearer <key>` header is current guidance; the classic `?apiKey=` query param is not confirmed removed. **Implementation-time verification note**: confirm the header format empirically against a live call before finalizing.

### Module: AccountStateProvider

Not a single data source — three narrow pieces wired together, closing `src/orchestrator/production/direct-bind.ts`'s existing `AccountStateProvider` interface (`getAccountState(asOf): Promise<{cash, peak_equity, daily_basis, consecutive_losses}>`):

- **`cash`** — from Alpaca's `GET /v2/account` (`cash` field).
- **`daily_basis`** — **GAP-8 RESOLVED ([#332](https://github.com/dd-jp/samurai-trading-system/issues/332)), on the local-snapshot side.** `last_equity` is no longer read at all. One blended account figure carries ONE reset boundary for a portfolio that has two, and per #260 its actual boundary was never verified against a live account — with `SMOKE_TEST_UNIVERSE` set to BTC-USD, the first paper run sat exactly on the ambiguous side. The boundary is now one this system owns: `TradingCalendar.sessionStart` ([#331](https://github.com/dd-jp/samurai-trading-system/issues/331)), asked per class — `AlwaysOpenCalendar` (00:00 UTC) for crypto and the portfolio-level row, `UsEquityRegularHoursCalendar` (prior 16:00 ET close) for stocks. Equity at that boundary is persisted per class in `session_equity` (migration `0009`, shared-sqlite-store-spec.md), and the provider returns a `SessionBasis` per class — the `open_equity` denominator plus realized PnL from `closed_trades` since that open — rather than a finished percentage. `computePortfolioView` adds the unrealized mark-to-market term and divides, because it has already fetched the marks for its exposure math and must not fetch them twice. **Cold start is mode-gated:** in `paper`/`backtest` a missing or mid-session-sampled snapshot is used as the base with a `warn`; in `live` the figure is reported *unknown* (a tagged union, never a `0` that would read as a flat day) and stays unknown until a boundary this process is running for. Escalating that unknown into a halt on new entries is [#333](https://github.com/dd-jp/samurai-trading-system/issues/333)'s two-tier daily-loss work; this layer only makes the unknown explicit and arms an advisory `daily_pnl_unknown` breaker name.
- **`peak_equity`** — a small new locally-persisted running max of equity, updated once per tick. Alpaca's account endpoint has no all-time high-water-mark field, and no reconstruction from `ClosedTrade` gives it either (it's a function of *equity*, not realized trades). **Needs a genuinely new, durable table — not `current_tick`.** `current_tick` (`SqliteCurrentTickStore`'s table, per shared-sqlite-store-spec.md) is explicitly documented there as *"Disposable, best-effort progress state — NOT a system-of-record... deleted on tick completion"* — storing a monotonic high-water mark there would either get wiped every tick (silently disabling risk-manager-spec.md's hard portfolio-drawdown circuit breaker, since `peak_equity` is what that breaker's drawdown percentage is computed against) or require a schema that contradicts `current_tick`'s documented lifecycle. This spec instead adds one new table to the shared SQLite store, alongside (not inside) the existing tables: `account_state(key TEXT PRIMARY KEY, peak_equity REAL NOT NULL, updated_at TEXT NOT NULL)` — a single durable row (`key = 'default'`), not tied to any per-tick or per-instrument lifecycle, upserted (never deleted) once per tick. The `daily_basis` decision above landed on the local-snapshot option but did **not** extend this table: per-class snapshots need one row per class, and three rows here would each need a dummy or nullable `peak_equity`, eroding the NOT NULL invariant that keeps the drawdown breaker crash-safe. They live in `session_equity` (migration `0009`) instead.
- **`consecutive_losses`** — derived by walking the existing `ClosedTrade` store (`SharedStore.getClosedTrades()`, `src/execution/sqlite-shared-store.ts`) in reverse-chronological order, counting a losing streak (`realized_pnl_net < 0`) until a win breaks it. No new ledger; `Execution` already writes/reads these records.
- **Ruled out: `CostModel` reuse.** `CostModelImpl.fill()` is a backtest fill-*price* simulator (spread/commission/slippage/market-impact for one hypothetical fill given a `MarketState`) — it holds no cash/PnL/account-state concept and persists nothing. Not a viable source for any of the four fields.

### Module: VolatilityReadingProvider

Closes `direct-bind.ts`'s existing `VolatilityReadingProvider` interface (`getVolatilityReading(asOf): Promise<VolatilityReading>`, `VolatilityReading = {crypto: number, stocks: number}` from `src/risk-manager/breakers.ts`).

- **Reuses the already-shipped pattern** at `src/execution/simulated-adapter.ts`'s `buildMarketState` — `marketData.getIndicator(instrument, config.volatility_indicator, now)`, the same `MarketDataService.getIndicator` machinery `CostModelImpl.fill` itself already consumes as `MarketState.volatility`. No new data source.
- **Aggregation is always over the full configured universe, not open positions.** Calls `getIndicator` for every instrument in `ProductionConfig.universe` (already partitioned by `asset_class`) — the *entire configured universe*, whether or not a position is currently open in each instrument — and aggregates to one number per class via **max**, matching `CircuitBreakers.evaluate`'s conservative, worst-case-trips-it intent, not a smoothed reading. Because the universe is populated by config (not by open positions), a reading is always available; there is no "no positions open" case this provider needs to special-case, and no separate default-instrument fallback is needed. (This corrects an inconsistency in the earlier wayfinder resolution — [#264](https://github.com/dd-jp/samurai-trading-system/issues/264) — which described a positions-gated fallback that doesn't apply once aggregation is defined as universe-wide.)
- **Caching/cadence:** no new cache is built here. `getIndicator` calls land on `MarketDataService`'s existing input-hash (Tier-1) response cache (`market-data-service-spec.md`), so repeat calls within the same `asOf`/tick are already deduplicated there; this provider's call volume is one `getIndicator` call per universe instrument per breaker evaluation (i.e. per tick), not per external HTTP request — `MarketDataService` itself owns whatever external-source rate-limiting its `DataSource` needs, independent of this provider.

## Testing Decisions

### What Makes a Good Test

- Test each client against its **external HTTP contract**, not implementation details: mock the HTTP layer (fetch) at the boundary and assert on request shape (URL, headers, body) and response mapping — never assert on internal call sequencing.
- **Error-taxonomy test (shared, per client):** each of the four clients' status-code-to-error-class mapping (429→RateLimit, 408/504→Timeout, else→ProviderError) is tested with the same table-driven fixture shape already used for `AnthropicLlmClient`'s `classifyProviderError`.
- **Retry test (shared):** the generalized `withRetry` is tested once, generically, against an injected `isRetryable`; individual clients only need one test confirming their own `isRetryable` closes over the shared taxonomy correctly — not a full retry-loop re-test per client.
- **404 → null test (AlpacaClient broker):** `getOrderByClientOrderId` on a 404 response resolves `null`, never throws — the reconciliation-critical contract from #260/#86.
- **Envelope-unwrap test (PolygonClient):** a fixture response with `{results, next_url}` plus extra `vw`/`n` fields maps correctly onto `PolygonAggregate[]`, dropping the extras.
- **Crypto-ticker-translation test (PolygonClient, AlpacaClient market data):** `BTC-USD` → `X:BTCUSD` / Alpaca's crypto path root, both directions covered.
- **Telegram allowlist test:** a `callback_query` from a `from.id` not on the allowlist is silently discarded and never reaches `SignedApprovalChannel.handleCallback`; one from an allowlisted id does.
- **Telegram correlation-token expiry test:** a token past its `timeout_ms` is treated as unmatched, matching `SignedApprovalChannel`'s own timeout fail-safe.
- **AccountStateProvider field-split test:** `peak_equity` only increases across ticks (never decreases when equity dips), and `consecutive_losses` correctly stops counting at the first win walking backwards through a fixture `ClosedTrade` sequence.
- **VolatilityReadingProvider max-aggregation test:** given a fixture universe with per-instrument indicator values, the returned `{crypto, stocks}` equals the max within each class, not the average or first value.

### Modules to Test

**Shared Transport Conventions** — `src/shared/http/retry.ts` (generic retry loop), `src/shared/http/fetch-with-timeout.ts`; each client's own error-classification function.

**AlpacaClient (broker + data)** — `src/execution/adapters/` real implementation; `src/market-data-service/sources/alpaca-source.ts`'s injected client.

**AnthropicMessagesClient** — the promoted `src/debate-engine/llm/anthropic-http-client.ts`; `disagreement-detector.integration.test.ts`'s hardcoded model bumped to `claude-haiku-4-5-20251001`.

**TelegramClient** — the new implementation under `src/verdict/notifications/` (or a new `src/verdict/notifications/telegram/` module); the allowlist check and correlation-token map in isolation from the long-poll loop itself (which needs an integration/manual test against the real Bot API, not a unit test).

**PolygonClient** — the new implementation under `src/cost-model-backtest/` (or a new adapters location matching `AlpacaClient`'s pattern).

**AccountStateProvider / VolatilityReadingProvider** — new modules under `src/orchestrator/production/` (or wherever `direct-bind.ts`'s consumers expect them), each tested against a fixture `ClosedTrade` store / fixture `MarketDataService`.

### Prior Art

- `AnthropicLlmClient`/`retry.ts`/`errors.ts` (`src/debate-engine/llm/`) is the direct precedent for the shared error taxonomy and retry mechanism — already shipped, already tested, being generalized rather than redesigned.
- `AlpacaDataSource` (`src/market-data-service/sources/alpaca-source.ts`) is the precedent for "injected client, connection provisioning is an ops task" — the same pattern the broker-side `AlpacaClient`, `PolygonClient`, and `TelegramClient` all already follow structurally.
- `simulated-adapter.ts`'s `buildMarketState` is the direct precedent for `VolatilityReadingProvider`'s `getIndicator` usage.

## Out of Scope

- **ccxt/Kraken/Coinbase/IBKR broker clients** — long-term path per ADR-0001, not needed for paper-trading MVP.
- **WorldMonitor `CiiScoreProvider` live wiring** — deliberately parked during paper trading (cost); separate decision to reopen it.
- **Discord client** — `DiscordClient.sendMessage` interface exists in `src/verdict/notifications/types.ts` but has no implementation decision here; Telegram is the first live channel.
- **Bot/account provisioning** (BotFather bot creation, Alpaca/Anthropic/Polygon API key issuance) — ops/setup tasks, not design decisions.
- **`getBars` pagination implementation** (Alpaca market data) and **`next_url` key re-appending / crypto-tier limits verification** (Polygon) — flagged above as implementation-time verification notes, not resolved as design here.
- **Exact retry config numbers** (`maxAttempts`/`baseDelayMs`/`maxDelayMs` per client) — the algorithm and per-client sizing principle are decided; exact constants are an implementation/tuning detail.

## Further Notes

### verdict-spec.md amendment (done, #272)

`verdict-spec.md`'s "Module: Human-in-the-Loop" section has been amended per the TelegramClient decision above: under the polling transport, `callback_query.from.id` checked against a configured allowlist is the sole working access control over who may approve a live-money trade, `TELEGRAM_ALLOWED_USER_IDS` misconfiguration is flagged as a critical exposure (distinguishing an empty/unset allowlist, which fails closed, from an over-broad/wrong one, which doesn't; wildcards are rejected at boot), and `SignedApprovalChannel`'s HMAC check (#207) is framed as a **dormant, transport-agnostic seam — not defense-in-depth** under polling (see step 3 above, corrected to match). Both documents now agree on this framing; no outstanding divergence.

### Stale doc comments to update at implementation time

- `src/orchestrator/production/direct-bind.ts`'s doc comment ("no in-repo data source today" for `AccountStateProvider`/`VolatilityReadingProvider`) becomes stale once these are implemented.
- `src/orchestrator/production.ts`'s doc comment (no real implementation of `AlpacaClient`, `AnthropicMessagesClient`, `TelegramClient`, or `CiiScoreProvider` anywhere in `src/`) becomes partially stale — `CiiScoreProvider` stays out of scope (parked), the other three do not.
- `disagreement-detector.integration.test.ts`'s hardcoded `claude-3-5-haiku-latest` should bump to `claude-haiku-4-5-20251001` alongside the `AnthropicMessagesClient` promotion.

### Domain Glossary Alignment

Per CONTEXT.md and existing specs: this spec fills in the wire-level implementation of interfaces already named by `execution-spec.md` (Broker Abstraction Layer), `market-data-service-spec.md` (`DataSource`/Alpaca source), `debate-engine-spec.md` (`LlmClient`), `verdict-spec.md` (Human-in-the-Loop channels), `stage2-validation-execution-spec.md` (Historical Data Ingestion), and `orchestrator-spec.md`/ADR-0004 (Production Composition Root). No new domain concepts are introduced; every module above closes a seam an existing spec already named as open.

## Resolved Decisions (Sources)

Wayfinder decisions for this component live on the [Live Transport Layer map](https://github.com/dd-jp/samurai-trading-system/issues/259) (closed — all children resolved):

- [Research: Alpaca REST API surface for AlpacaClient (broker + data)](https://github.com/dd-jp/samurai-trading-system/issues/260)
- [Decide: production LlmClient (Anthropic) implementation shape](https://github.com/dd-jp/samurai-trading-system/issues/261)
- [Decide: TelegramClient design for heartbeat + HITL approval round-trip](https://github.com/dd-jp/samurai-trading-system/issues/262)
- [Research: Polygon aggregates API for real PolygonClient](https://github.com/dd-jp/samurai-trading-system/issues/263)
- [Decide: AccountStateProvider / VolatilityReadingProvider design](https://github.com/dd-jp/samurai-trading-system/issues/264)
- [Decide: shared conventions across the four transport clients](https://github.com/dd-jp/samurai-trading-system/issues/269)

**Cross-spec requirement (satisfied):** the amendment to `verdict-spec.md`'s Human-in-the-Loop module (see Further Notes) has landed (#272, PR #281); both documents now agree about what actually authorizes an approval, and this must remain true — any future change to the callback authn/authz mechanism must amend both specs in the same PR.

**Dependencies:** Alpaca (Trading API v2 + Market Data API v2, per ADR-0001), Anthropic Messages API, Telegram Bot API (`getUpdates` long polling), Polygon/Massive aggregates API. All four credentialed via `.env.local` (env var names above); connection/bot provisioning is an ops/setup task, not part of this spec's logic. Consumed by Execution (Alpaca broker), Market Data Service (Alpaca data), Debate Engine (Anthropic), Verdict (Telegram), Stage 2 (Polygon), and the Production Composition Root's `AccountStateProvider`/`VolatilityReadingProvider` (Trader/Risk/Verdict direct-bind).
