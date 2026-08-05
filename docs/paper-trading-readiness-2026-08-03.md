# Paper-Trading Readiness Audit — 2026-08-03

**Question asked:** is there code that has diverged from spec, or is missing, to achieve the paper-trading goal?

**Short answer:** the stage logic is essentially complete and tracks its specs. What is missing is *between* the stages — nothing schedules the fill-ingestion loop, and nothing constructs the composition root's 16 required dependencies. A paper run today would submit orders and then never learn what happened to them.

**Method / limits.** Read: the composition root (`orchestrator/production.ts`, `production/direct-bind.ts`, `orchestrator/index.ts`), `execution/` in full, `ingest-fills.ts`, `reconcile.ts`, the migration set, `cross-verify-2026-07-31.md`, and a repo-wide TODO/placeholder/stub sweep. **Not read:** the 19 specs in full (~500KB) — so the divergence half of the question is answered from targeted checks against the most recent cross-verification, not from an exhaustive spec-by-spec audit. Where I did not verify something, it says so.

---

## Tier 1 — Blocks the first meaningful paper tick

### 1. `ingestFills()` and `reconcile()` have no scheduled caller — NO ISSUE EXISTS

The single most consequential gap, and the only Tier-1 item with no ticket.

Both surfaces are **fully implemented** (`src/execution/ingest-fills.ts`, `src/execution/reconcile.ts`) and exposed on `ExecutionImpl` (`execute.ts:32`, `execute.ts:43`). Nothing calls either one outside tests. The composition root says so itself, twice, in `production.ts:67-70` and `production/on-trade-close-hookup.ts:16`.

Verified three ways, since this is an absence-of-evidence claim: no textual caller outside `execution/`; no indirect dispatch through the port either — the orchestrator reaches Execution at exactly one place, `direct-bind.ts:250`, and it calls `execute()` only; and no ticket exists in **any** state (#83 and #86 built these surfaces and are closed; #224/#236/#237 did the wiring and are closed).

This is a *scheduling* gap, not missing logic — which is good news for the size of the fix, and bad news for how easy it is to miss. The tick loop runs Analysts → Debate → Trader → Risk → Verdict → Execution and submits a bracket. Then the lifecycle stops.

One gap, four silent downstream failures:

| Consequence | Mechanism |
|---|---|
| Positions never advance past `submitted` | `updatePositionFill` is only called from `ingestFills` (`ingest-fills.ts:94`) |
| Risk sizes against a portfolio that never grows | `computePortfolioView` derives exposure from `filled_size`, which stays `0` (`portfolio-view.ts`) |
| No PnL, no win rate, no feedback loop | `ClosedTrade` is only ever written by `ingestFills` (`ingest-fills.ts:102`); `withOnTradeClose` decorates a method with no live caller |
| Crash-restart guarantee unreachable | CLAUDE.md's "crash-restart must not lose open positions" depends on `reconcile()`, which never runs at startup |

Worse in combination with item 2 below: the Alpaca adapter's bracket map is in-process (`alpaca-adapter.ts:48`), so after any restart `fetchNewFills` returns nothing until `reconcile()` repopulates it via `getOrder` (`alpaca-adapter.ts:127`). **`reconcile()`-at-startup is therefore mandatory, not optional** — and a 14-day soak (#238) will restart.

The fix is a design decision, not a patch: own timer, or inside the tick, or a separate poll loop with its own cadence — plus the reconcile-before-ingest ordering that `reconcile.ts:23-24` already documents. Per Standing Pipeline Rule 1 that is a wayfinder map, not a drive-by.

### 2. Adapter bracket/fill state is in-memory only — **#295**, **#287**

Already ticketed, but its severity should be read as Tier 1 rather than a follow-up, for the reason above: combined with gap 1 it means a restarted process is blind to its own open orders until reconcile runs. `ccxt-adapter.ts:203-213` documents the same posture for its OCO emulation.

### 3. `startFromEnvironment` cannot start — partly **#276**, **#275**

`yarn orchestrator` throws immediately. `REQUIRED_INJECTED_CONFIG` (`orchestrator/index.ts:124-141`) demands 16 fields; the entrypoint passes none. Of those:

- **Now buildable but not built** — `alpacaBrokerClient`, `alpacaDataClient`. Real HTTP implementations landed in #273/#286 (`execution/adapters/alpaca-http-client.ts`, `market-data-service/sources/alpaca-http-client.ts`). Nothing constructs them from env. See divergence D1.
- **Genuinely unimplemented transports** — `heartbeatChannel`, `approvals`, `orphanAlerts` all need a `TelegramClient` that does not exist (**#275**); `ciiScoreProvider` is parked by design during paper trading (ADR-0002).
- **No in-repo implementation** — `accountState`, `volatility`. `AccountStateProvider` (`direct-bind.ts:63-70`) is a required seam with no concrete implementation anywhere (**#276**). See divergence D2 for why this one is worse than a missing adapter.
- **Config values** — the eight `*Config` fields are tuning values, correctly not checked in.

---

## Tier 2 — Blocks a *meaningful* paper run rather than the first tick

### 4. No durable `peak_equity` → the hard drawdown breaker is not crash-safe — **#276**

`cross-verify-2026-07-31.md` GAP-7 specced a new `account_state(key, peak_equity, updated_at)` table into `shared-sqlite-store-spec.md` precisely so `peak_equity` would survive restarts. **That table does not exist** — migrations stop at `0005_hot_path_indexes.sql`. `peak_equity` currently arrives only as an injected scalar (`direct-bind.ts:131`) and feeds `drawdown_pct` (`portfolio-view.ts:83`).

Consequence: whatever supplies `peak_equity` resets on restart, the high-water mark resets with it, `drawdown_pct` reads low, and the portfolio-drawdown circuit breaker silently under-trips — the exact failure GAP-7 was written to prevent. This is a **spec-vs-code divergence, not just a missing feature** (D2 below).

### 5. `daily_pnl_pct` semantics — **RESOLVED** ([#332](https://github.com/dd-jp/samurai-trading-system/issues/332), cross-verify GAP-8)

~~Open since 2026-07-31 and unchanged.~~ Resolved on the local-snapshot side. `risk-manager-spec.md` wanted session-scoped semantics (UTC day for crypto, market day for stocks); Alpaca's `GET /v2/account` gave one blended `last_equity` whose actual reset boundary was **never verified against a live account** — and with `SMOKE_TEST_UNIVERSE` set to BTC-USD (crypto, 24/7), the first paper run landed squarely on the ambiguous side.

`last_equity` is no longer read. Equity at each class's session boundary (`TradingCalendar.sessionStart`, [#331](https://github.com/dd-jp/samurai-trading-system/issues/331)) is persisted locally in `session_equity` (migration `0009`), and `PortfolioView.daily_pnl` now carries a per-class figure — crypto from 00:00 UTC, stocks from the prior 16:00 ET close, plus a UTC portfolio-level one.

**Carry-over for the soak:** a daily figure that cannot be computed (fresh store, or a restart after the boundary passed) is reported *unknown* rather than `0` in `live`, and arms an advisory `daily_pnl_unknown` breaker — but it does **not** yet halt new entries. That escalation is [#333](https://github.com/dd-jp/samurai-trading-system/issues/333). In `paper` — the soak's mode — the figure is seeded from a mid-session base with a `warn`, so the breaker stays live throughout.

### 6. `intent_type: 'exit'` dead-ends — **#74**

Trader emits it (`trader/decide.ts:225`), Risk handles it (`risk-manager/index.ts:125`), Execution refuses it (`execute.ts:66-68`). **Not a position-stranding bug** — bracket legs exit venue-side, so lots still close. It is a decision path that reaches Execution and stops, meaning discretionary exits and scale-ins are unavailable. Lower severity than its surface appearance.

---

## Divergences from spec (bounded — see Method above)

**D1. Stale required-seams error message.** `orchestrator/index.ts:192-194` tells the operator the Alpaca clients "have no implementation in this codebase yet." False since #273/#286. A first-run operator is told to write code that already exists. One-line fix; the missing env-construction path behind it is the real work.

**D2. `account_state` table specced, never migrated.** `shared-sqlite-store-spec.md` (per GAP-7) defines it; no migration creates it. See item 4.

**D3. `BrokerAdapter` is missing three specced methods — mismatch of unknown intent.** `execution-spec.md:133-137` defines `submitFlatten`, `cancel`, and `getOpenPositions`. The code interface (`execution/types.ts:121-158`) has none of them — only `submitBracket`, `getOrder`, `fetchNewFills`, `resizeProtectiveLegs`.

I did **not** establish whether this is drift or a deliberate descope. Wayfinder #224 scoped the first run to enter/hold-only, and `cross-verify-2026-07-31.md` GAP-2 records an unresolved question about exactly that phasing — so these three may have been intentionally left out, in which case the spec needs the phasing edit rather than the code needing the methods. Resolving GAP-2 settles this too.

Either way the *capability* is absent: no order cancellation, and no forced-liquidation path, which `execution-spec.md:279` contemplates as Execution's job. That matters for a kill-switch regardless of which document is wrong.

**D4. Not a code divergence — spec-vs-spec drift.** GAP-1/2/4/5/6 in `cross-verify-2026-07-31.md` remain open and are all documents disagreeing with documents, not code disagreeing with either. Listed here only so they are not mistaken for code gaps.

**Counter-evidence worth stating:** a repo-wide sweep for `TODO`/`FIXME`/`not implemented`/`placeholder` returned 11 hits, of which 8 are SQL bind-parameter variables named `placeholders` or rate-limit defaults already ticketed (#292, #299). For a codebase of this size that is genuinely clean, and it is real evidence that the *implemented* stages track their specs. The gaps above are overwhelmingly at the wiring layer, not inside the stages.

---

## Shortest path to a first real paper tick

1. Schedule `reconcile()` at startup, then `ingestFills()` on an interval — in that order. **Needs a wayfinder map; no issue exists yet.**
2. Build `AccountStateProvider` against Alpaca `GET /v2/account` + the `account_state` migration GAP-7 already specced (**#276**, resolving D2 and item 4).
3. Construct the two Alpaca HTTP clients from env in `startFromEnvironment`, and correct the stale guard message (**D1**; note **#293** wants a live-deployment guard on `baseUrl` at the same time).
4. Decide GAP-8 (`daily_pnl_pct` semantics) — **yours, needs a live-account check first**.
5. Minimum viable transports for `heartbeatChannel`/`approvals`/`orphanAlerts` (**#275**), or an explicit console-only stand-in for the smoke run.

Items 1–3 are what stand between the current code and a BTC-USD smoke tick that completes a full lifecycle.
