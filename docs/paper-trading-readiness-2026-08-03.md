# Paper-Trading Readiness Audit — 2026-08-03 · Updated 2026-08-05

**Question asked:** is there code that has diverged from spec, or is missing, to achieve the paper-trading goal?

**Short answer (2026-08-05, superseding the 08-03 verdict):** the wiring layer is closed. Every Tier-1 item in the original audit has landed, and an offline end-to-end run transacts the full lifecycle in a real process — Analysts → Debate → Trader → Risk → Verdict → Execution → **fill ingested**. The original headline ("a paper run today would submit orders and then never learn what happened to them") is no longer true; `startFillSync` and a startup `reconcile()` exist and are called from the composition root.

What remains is a different class of problem: **soak-quality defects** (mechanisms that run but learn nothing) and **live-mode gating** (two live-money blockers that do not touch the paper soak). The 14-day soak ([#238](https://github.com/dd-jp/samurai-trading-system/issues/238)) is startable; the open question is whether it would *produce useful learning*, not whether it would tick.

**Evidence for the flip, this pass:**

```
$ yarn smoke
=== Samurai offline end-to-end smoke run (#350) ===
mode=paper  broker=SimulatedBrokerAdapter  data=FixtureDataSource  llm=ConstantResponseLlmClient
ticks completed: 3
  tick 1 [3dc35577…] analysts:quorum_met -> debate:bullish -> trader:entry -> risk:approved -> verdict:go -> execution:submitted
lots submitted to the broker: 1   fills ingested: 1
GATE: PASS — the pipeline transacted end to end in a real process.
```

`closed trades: 0` is expected and not a gate failure: `SimulatedBrokerAdapter` models only the entry fill, so `ingestFills()` never reaches round-trip-to-flat.

**Method / limits, this pass.** Read: `orchestrator/fill-sync.ts`, the `start()` path in `production.ts` (1640–1720), `production/direct-bind.ts`, the Alpaca adapter's state rehydration, `execution/types.ts`, the migration set, `orchestrator/index.ts`'s required-seams guard; checked every issue cited by the 08-03 audit for state via `gh`; ran `yarn smoke` on `9d67044`. **Not read:** the 19 specs in full (~500KB) — same limit as the original pass, so the divergence half is still answered from targeted checks, not an exhaustive spec-by-spec audit. **Not run:** `yarn orchestrator` against Alpaca paper (places real paper orders), and no soak has been run, so nothing here is evidence about multi-day behaviour. Per a prior session's notes and **not verified here**, a real `yarn orchestrator` run against Alpaca paper over the full ADR-0001 universe (SPY, QQQ, AAPL, TSLA, BTC-USD, ETH-USD) was reported clean earlier on 2026-08-05. Independently checkable in `orchestrator/index.ts`: the run needs `SAMURAI_ALERTS` set explicitly, which has no default. The newest cross-verification is still `cross-verify-2026-07-31.md`; nothing has re-verified the specs against each other since.

---

## Tier 0 — Blocks any LIVE run (does not block paper)

> This tier is about **real money**, not the paper soak. Nothing here blocks a paper tick; everything here must be closed before the first live capital goes in.

### 0a. Daily-loss limit can be unenforced for a whole live session — **[#333](https://github.com/dd-jp/samurai-trading-system/issues/333) IS A LIVE-GO BLOCKER** (still OPEN)

**Do not run live capital until #333 lands, or until an explicit no-live-go gate refuses to start in `live` mode while any class's daily figure is unknown.**

[#332](https://github.com/dd-jp/samurai-trading-system/issues/332) made the daily PnL figure honest: when it cannot be computed, it says so instead of returning a `0` that reads as a flat day. What it does **not** yet do is act on that.

- **What changed.** Before #332, `daily_pnl_pct` came from Alpaca's `last_equity` and always produced *some* number, which could trip the daily-loss breaker. After #332, a figure that cannot be computed is a typed unknown. `CircuitBreakers.evaluate` arms an **advisory** `daily_pnl_unknown` name — visible in `armed_breakers` and the audit trail — but does **not** set `portfolio_tripped`.
- **Consequence.** In `live`, an unknown daily figure **permits new entries**. The daily-loss limit is then unenforced for the remainder of that session.
- **When it happens.** Whenever no equity was observed at the session boundary: a fresh store, or — far more likely in practice — **a process restart after the boundary has already passed**. CLAUDE.md lists crash-restart as a Key Constraint, and the deployment target is a MacBook subject to auto-updates, power and WiFi drops. This is an expected event, not an exotic one.
- **Blast radius.** A full session (a UTC day for crypto; a close-to-close day for stocks) trading real money with no daily-loss circuit breaker.
- **Why it was left this way.** Escalating unknown into a halt is #333's two-tier daily-loss work, which owns the re-arm semantics. Arming a halt that this breaker cannot itself clear would strand the system halted with no path back, so the breaker half was deliberately not fabricated in #332.
- **Why it is acceptable *now*.** Live is not running, and the 14-day soak (#238) runs in `paper`, where the figure is seeded from a mid-session base with a `warn` and the breaker stays live throughout. The exposure is strictly a live-mode one.

**Closing condition:** #333 escalates `daily_pnl_unknown` into a block on new entries in `live` (exits must stay ungated, as with every other breaker) — or a startup gate refuses `live` while the figure is unknown.

### 0b. A live run can inherit the paper store's open positions — **[#330](https://github.com/dd-jp/samurai-trading-system/issues/330)** (OPEN) *(new since 2026-08-03)*

`sharedStorePath()` keys the SQLite file off `NODE_ENV`, not off trading mode. A `live` run started under the same `NODE_ENV` as the paper soak opens **the paper soak's database** — inheriting its open positions, its fills and its broker bracket index, and then reconciling them against a live account that never placed them. This violates spec #168 and became reachable once the orchestrator became bootable.

The code says so out loud rather than pretending otherwise: `warnIfStorePathIgnoresMode` logs a startup `warn` naming the mode and the file actually being written (`orchestrator/index.ts`). That warning is the current mitigation, and per #330 it retires itself when the real fix lands. A warn is not a gate.

**Why it was not fixed in place:** `mode` resolves from `injected.mode ?? SAMURAI_MODE`, and an injected mode is invisible to the dashboard, which calls `sharedStorePath()` with no argument precisely so writer and reader cannot derive different paths. Re-keying needs a decision about how the *reader* derives mode plus a migration story — #330's scope, not a template-string change.

**Closing condition:** the store path encodes trading mode, or `live` refuses to start against a store file it did not create in `live`.

---

## Tier 1 — Blocked the first meaningful paper tick — **ALL RESOLVED**

### 1. `ingestFills()` and `reconcile()` had no scheduled caller — **RESOLVED** (PR [#301](https://github.com/dd-jp/samurai-trading-system/pull/301), commit `933eebe`)

The 08-03 audit's single most consequential gap, and the only one that had no ticket. It now has a module: `src/orchestrator/fill-sync.ts`.

- `runStartupReconcile()` is **awaited** before the tick loop and before the first ingest (`production.ts:1653`). A failure propagates out of `start()` rather than being logged and stepped over — deliberately, since trading against a store that disagrees with the venue is what reconcile exists to prevent.
- `startFillSync()` then polls `ingestFills()` on `fillPollIntervalMs` (`production.ts:1707`), as a self-re-arming `setTimeout` rather than `setInterval`, so a poll slower than its own period cannot re-enter and race `resizeProtectiveLegs` on a mid-fill lot. It is stopped on shutdown alongside the tick loop (`production.ts:1879-1888`).
- Both surfaces are bound from the same object the tick step uses, with distinct trace ids (`FILL_SYNC_TRACE_ID` / `RECONCILE_TRACE_ID`) so a reconcile and an ingest are separable in the audit trail.

The four silent downstream failures the 08-03 audit listed — positions stuck at `submitted`, Risk sizing against a portfolio that never grows, no `ClosedTrade`/no feedback loop, unreachable crash-restart guarantee — are all closed by this one caller. The smoke run above is the end-to-end evidence.

**Residual, named by the module itself:** `reconcile()` only visits `IN_FLIGHT` states (`pending`/`submitted`). A lot already `partially_filled` or `filled` at restart is never passed to `getOrder`. That residual is what item 2 closes.

### 2. Adapter bracket/fill state was in-memory only — **RESOLVED** ([#287](https://github.com/dd-jp/samurai-trading-system/issues/287), [#295](https://github.com/dd-jp/samurai-trading-system/issues/295), commit `558175b`)

Migration `0007_broker_adapter_state.sql` plus `execution/broker-state-store.ts` give the adapters a durable bracket journal. The Alpaca adapter rehydrates its `brackets` map **synchronously in its constructor** from `state.loadBrackets('alpaca')` (`alpaca-adapter.ts:182-186`) — because the first `fetchNewFills` sweep after a restart iterates that map, and an empty one is indistinguishable above the adapter from a quiet market.

**Verified wired, not merely built:** `SqliteBrokerStateStore(config.db)` is injected at the composition root (`production.ts:1174`). The adapters default to `InMemoryBrokerStateStore` when nothing is injected, so this check mattered — it is the repo's dominant defect shape and it is not present here.

**Residual:** [#312](https://github.com/dd-jp/samurai-trading-system/issues/312) (OPEN) — ccxt writes its bracket journal *after* `createOrder`, leaving a crash window. Not on the paper path (Alpaca), so it does not gate the soak.

### 3. `startFromEnvironment` could not start — **RESOLVED** (PR [#301](https://github.com/dd-jp/samurai-trading-system/pull/301), [#276](https://github.com/dd-jp/samurai-trading-system/issues/276), [#275](https://github.com/dd-jp/samurai-trading-system/issues/275), [#322](https://github.com/dd-jp/samurai-trading-system/issues/322), [#323](https://github.com/dd-jp/samurai-trading-system/issues/323))

`yarn orchestrator` now runs `startFromEnvironment(paperStartingProfile(mode))` against a checked-in paper profile (`orchestrator/paper-profile.ts`), with `--env-file=.env.local`. `REQUIRED_INJECTED_CONFIG` has shrunk to the per-stage tuning values only:

- **Built from the environment now** — the Alpaca broker and market-data clients (#273/#286), the LLM client (#274), the account-state provider (#276).
- **Alert transports** — selected by `SAMURAI_ALERTS` (#322): `telegram` builds #275's `TelegramBotApiClient`; `log-only` keeps the composition root's log-only stand-ins.
- **`ciiScoreProvider`** — still parked by design during paper trading (ADR-0002), unchanged.

---

## Tier 2 — Blocked a *meaningful* paper run

### 4. No durable `peak_equity` → hard drawdown breaker not crash-safe — **RESOLVED** ([#276](https://github.com/dd-jp/samurai-trading-system/issues/276))

GAP-7's `account_state` table exists: migration `0006_account_state.sql`, with `orchestrator/sqlite-account-state-store.ts` behind the `AccountStateProvider` seam. `peak_equity` is no longer an injected scalar that resets on restart, so the drawdown breaker's high-water mark survives the restarts a 14-day soak will see. This also closes divergence D2.

### 5. `daily_pnl_pct` semantics — **RESOLVED** ([#332](https://github.com/dd-jp/samurai-trading-system/issues/332), cross-verify GAP-8)

`last_equity` is no longer read. Equity at each class's session boundary (`TradingCalendar.sessionStart`, [#331](https://github.com/dd-jp/samurai-trading-system/issues/331)) is persisted locally in `session_equity` (migration `0009`), and `PortfolioView.daily_pnl` carries a per-class figure — crypto from 00:00 UTC, stocks from the prior 16:00 ET close, plus a UTC portfolio-level one.

⚠️ Its carry-over — unknown-does-not-halt — is a **live-go blocker**, tracked as Tier 0 item 0a. In `paper` the figure is seeded from a mid-session base with a `warn` and the breaker stays live throughout, so the soak is unaffected.

### 6. `intent_type: 'exit'` dead-ends — **[#74](https://github.com/dd-jp/samurai-trading-system/issues/74)** (still OPEN)

Unchanged since 08-03. Trader emits it, Risk handles it, Execution refuses it. **Not a position-stranding bug** — bracket legs exit venue-side, so lots still close. It means discretionary exits and scale-ins are unavailable for the soak. Lower severity than its surface appearance, but it caps what the soak can teach about exit quality.

---

## Tier 3 — Soak-quality: the run would tick, but learn less than it should *(new section, 2026-08-05)*

These landed on the board after the 08-03 audit, mostly from wiring work that exposed mechanisms with no producer. They do not stop a tick; they blunt what 14 days of paper trading is worth. Cited by title — not individually re-derived against code this pass.

| Issue | What it costs the soak |
|---|---|
| [#370](https://github.com/dd-jp/samurai-trading-system/issues/370) `influence_score` is always 0 — debate personas never change stance between rounds | Feedback-loop attribution has no signal to weight analysts by. **Visible in the smoke output above:** every contribution logs `influence_score: 0`. |
| [#374](https://github.com/dd-jp/samurai-trading-system/issues/374) `enforceLatencyBudget` has no production caller | The debate latency budget is never enforced in the live tick — the classic no-caller shape, same as the fill-sync gap. |
| [#384](https://github.com/dd-jp/samurai-trading-system/issues/384) three of four kill-lines can never fire — nothing produces `DailyMetricsSample.revalidation` | The soak's own abort criteria are inert. |
| [#375](https://github.com/dd-jp/samurai-trading-system/issues/375) `backtest_reference_sharpe` has no persisted source | The fourth kill-line (divergence) stays inert until Stage 2 runs against a real strategy. |
| [#346](https://github.com/dd-jp/samurai-trading-system/issues/346) debate-engine-spec latency arithmetic | Crypto's 15s budget implies ≤1.67s/call at max rounds — spec-level, but it decides whether #374's enforcement would strangle the debate once wired. |
| [#391](https://github.com/dd-jp/samurai-trading-system/issues/391) market-data client is unpaced | Shares Alpaca's per-account rate budget with the paced broker client; a widened universe (#381) raises the odds of self-inflicted 429s over a long run. |
| [#313](https://github.com/dd-jp/samurai-trading-system/issues/313) `broker_observed_fills` has no retention rule | Unbounded growth over 14 days. |
| [#305](https://github.com/dd-jp/samurai-trading-system/issues/305) `analyst_weights` / `current_tick` have no indexes | Hot-path reads on a table the daily cycle now writes every day. |
| [#377](https://github.com/dd-jp/samurai-trading-system/issues/377) wayfinder: how (and whether) the Debate Engine applies `analyst_weights` | The daily cycle now writes weights (#371/#379) that nothing reads — the loop closes only when this decision lands. |

**One structural limitation of the soak itself, recorded on #238 (from PR #383):** `CorrelationConfig.min_bars` is 20 on a `1d` timeframe, and 14 calendar days is ~10 trading days — **no pair reaches `min_bars` inside the run**. The Risk Manager's concentration check sees an empty `correlations` map for the entire soak and treats SPY/QQQ and AAPL/TSLA as mutually uncorrelated. #303 made that visible (`insufficient_history` names the dropped pairs) rather than silent; it did not make the limits bind. Any post-soak claim that "correlation limits behaved correctly" is unsupported — they are never exercised.

**#370 and #374 appear to be in flight** — there is a `soak-prep-374-370` worktree in this repo, though it currently sits on `main` with no work committed. Confirm before picking either up.

---

## Divergences from spec (bounded — see Method above)

**D1. Stale required-seams error message — RESOLVED.** `orchestrator/index.ts:458-472` now names what is built from the environment and points the operator at `paperStartingProfile(mode)`, which is what `yarn orchestrator` does.

**D2. `account_state` table specced, never migrated — RESOLVED.** Migration `0006_account_state.sql` (#276). See item 4.

**D3. `BrokerAdapter` is missing three specced methods — STILL OPEN, AND STILL HAS NO ISSUE.** `execution-spec.md:133-137` defines `submitFlatten`, `cancel` and `getOpenPositions`. The code interface (`execution/types.ts:120-159`) has none of them — only `submitBracket`, `getOrder`, `fetchNewFills`, `resizeProtectiveLegs`. The interface's own doc comment says these "still arrive with the tickets that call them"; **no such ticket exists in any state.** (The `getOpenPositions` at `types.ts:190` is on `SharedStore`, a different seam — easy to misread as this being closed.)

This is now the only gap in this document with no ticket behind it — the position the fill-sync gap held on 08-03, and it deserves the same treatment: file it, or record the descope in the spec.

Still unestablished whether this is drift or deliberate descope. Wayfinder #224 scoped the first run to enter/hold-only, and `cross-verify-2026-07-31.md` GAP-2 records an unresolved question about exactly that phasing — in which case the spec needs the phasing edit rather than the code needing the methods. Resolving GAP-2 settles it.

Either way the *capability* is absent: **no order cancellation and no forced-liquidation path**, which `execution-spec.md:279` contemplates as Execution's job. That is a missing kill-switch regardless of which document is wrong, and it matters more now that the system can actually place orders unattended for 14 days.

**D4. Not a code divergence — spec-vs-spec drift.** GAP-1/2/4/5/6 in `cross-verify-2026-07-31.md` remain open and are all documents disagreeing with documents. `cross-verify-2026-07-31.md` is still the newest cross-verification; the ~40 commits since have not been cross-verified against the specs at all, which is itself worth noting before the next `/to-tickets` pass.

**Counter-evidence, re-checked posture:** the 08-03 sweep for `TODO`/`FIXME`/`not implemented`/`placeholder` returned 11 hits, 8 of them benign. Not re-run this pass. The gaps above remain overwhelmingly at the wiring and product-quality layers, not inside the stage logic.

---

## Shortest path from here

The 08-03 list (items 1–3: schedule fill sync, build `AccountStateProvider`, construct the Alpaca clients) is **done**. What replaces it:

1. **Decide D3** — file the `submitFlatten`/`cancel` ticket, or record the enter/hold-only descope in `execution-spec.md`. An unattended 14-day run with no kill-switch is the strongest argument for the former. *(No issue exists — this is the one item nothing is tracking.)*
2. **Close the learning-blockers before starting the soak, not during it** — #370 (attribution has no signal), #374 (latency budget unenforced), #384 (kill-lines inert). A soak that runs 14 days and learns nothing has to be re-run.
3. **Start the soak (#238)** once 2 is done. `yarn smoke` is the pre-soak gate and currently passes; the soak needs `SAMURAI_ALERTS=telegram` to be unattended. Budget the LLM spend before starting — a per-day figure was estimated in an earlier session but is not verified in this document.
4. **Live gates, before any real capital** — #333 (Tier 0a) and #330 (Tier 0b). Neither blocks the soak; both block the money.
5. **Re-run cross-verification** against the specs — the last pass predates ~40 commits of composition-root work.
