# v2 dashboard — spec (Step 3c)

Written in the step that builds it (doc 67 Step 3c, G13). Authority: `docs/research/66-v2-grill-decisions.md` (G12, G13, D5, D8, Q6 as amended by G6, Q13, Session B (j)), then `docs/adr/0001-samurai-v2.md` for what is still open. Map: [#1706](https://github.com/dd-jp/samurai-trading-system/issues/1706); ticket [#1745](https://github.com/dd-jp/samurai-trading-system/issues/1745). Status: **approved 2026-09-26**; David's answers to §9 are rulings U1–U6 in doc 66.

## 1. What the dashboard is for

One question per visit: *is the system safe, and is it doing what the backtest or arm 2 says it should?* David reads it; he does not operate the system from it. The only write is the halt/pause control (§5). Approvals are answered on Telegram and recorded to a GitHub issue (G12, G13): **there is no sign-off screen**, no approve button and no approval queue in the UI.

Required before paper starts (G13 (3); Step 6 is blocked by this step).

## 2. What is not carried forward

The v1 dashboard (the v3 Rail, old ADR-0021) is replaced, not restyled (G13 (1)). Dropped with it:

- the Glance / Live / Review tabs and the Live/Control arm toggle (`TradingArmWire`);
- Seal, StanceStrip, Track, ColdStart and the stance/conviction displays built around the v1 six-stage pipeline and its 0.55 floor;
- momentum, crypto and intraday panels;
- `DashboardSnapshot` and the rest of the v1 wire types. v2 gets its own wire types (§6); the v1 ones are deleted in Step 5's client pass.

Kept: the hosting rule (old ADR-0019, restated in the ADR: co-located with the orchestrator, LAN-only, fail-closed bind guard, Bearer token; no tunnel, no VPN), the design tokens and fonts, the Vite build and the lint/test rules.

## 3. Layout

One page, three hash views, no router library. A status strip sits above every view.

```
┌ status strip ─────────────────────────────────────────────────────────────┐
│ PAPER · last cycle 2026-10-05 21:40Z · next due 2026-10-06 · ● heartbeat   │
│ State: RUNNING            [ Pause entries ]  [ Halt: flat at next fill ]  │
└───────────────────────────────────────────────────────────────────────────┘
  Today  |  Evidence  |  Records
```

| View | Panels (top to bottom) | Question it answers |
|---|---|---|
| **Today** (`#today`, default) | Loss-budget gauge per sleeve · positions and cash · today's decisions | Can it lose more, what does it hold, what did it do today? |
| **Evidence** (`#evidence`) | Sleeve vs benchmark (risk-adjusted) · debate G1 progress vs arm 2 · live-vs-backtest band (backtest-validated sleeves) · gate statistics | Is it doing what it was validated to do? |
| **Records** (`#records`) | Decision journal (search) · research loop · LLM spend · reconcile diffs · tax export | What happened, what did it cost, what do I owe? |

Width: one column under 720 px, two above. Every panel has three states: **fed** (data), **empty** (fed, nothing yet: "no closed trades"), **not yet fed** (the server says which step or ruling owns the data, with its ticket). A panel never reads a field nobody writes; "not yet fed" is itself a served value (§6).

Refresh: poll every 30 s. The v2 cycle runs once per trading day, so nothing faster is needed; the status strip shows the age of the data. Its "next due" and heartbeat fields come from P14; until Step 3e schedules the cycle (#1784) they read not yet fed.

## 4. Panels

Every Step 3c item and each D5 panel has a row. **Served now** = the data exists in the v2 store today. **Owned by** = another step writes it; the panel ships in the "not yet fed" state until that step lands.

| # | Panel | Shows | Source | Status |
|---|---|---|---|---|
| P1 | Loss-budget gauge | Headline: the account-wide year-to-date loss (every primary book, both venues, Q6/G6's one budget) against three marks at ⅓, ⅔ and the full configured cap, and today's loss against the daily cap (1.0% of the year's start capital). Under it, one row per sleeve's primary book: its loss, current size step (1, ½, ¼, halted) and whether entries are blocked at the next fill; shadow books' size steps listed under their sleeve. Marks are computed from the year's `loss_cap_gbp` and `start_capital_gbp`, never literals (D8); with today's config they read −£500 / −£1,000 / −£1,500. | `v2_capital_config` (the year's latest row; until the new year's row is set, the last one before it, flagged stale), `v2_book_days` (`ytd_loss_gbp`, `size_multiplier`, `entries_blocked`) | Served now. The code enforces the budget per book, each against the full cap (§9 item 6) |
| P2 | Halt/pause state and control | Current state (RUNNING / PAUSED / HALTED-manual / HALTED-loss-budget), when it was set, from where, why; the two buttons and resume; the history of controls. | New `v2_controls` (§5), `v2_book_days.size_multiplier` | New in this step |
| P3 | Positions and cash | Per venue (Alpaca, Saxo): each position's qty, entry, stop, days held, book, and mark and unrealised P&L; each book's cash; totals per venue in its currency and one total in GBP. | `v2_positions` (qty, `avg_price_gbp`, `stop_gbp`, `opened_date`, `marks_held`), `v2_books.cash_gbp`, latest `v2_book_days`. `v2_positions` stores no mark: the mark is the last close from the bar store the cycle marks with, under the same coverage invariant (postmortem §2; a stale bar shows as stale, not as a price). USD figures per §9 item 3. The mark is the last close before the latest cycle date, read afresh per request from the position's venue in the Parquet bar store; a bar older than the cycle's freshness limit is served as stale and an unreadable one as unavailable, and neither enters a total. Totals count the primary books only, as P1 does; shadow books' positions and cash are listed. Positions and cash are live, so while a cycle is between applying fills and marking the day, P3 shows the new holdings against the previous day's marks and does not reconcile with P1 until the cycle marks | Served now |
| P4 | Today's decisions | This cycle's decisions for each primary book: entered / skipped / vetoed / none, with the reason and confidence. | `v2_decisions` for the last `trading_date` | Served now |
| P5 | Sleeve vs benchmark | Per sleeve: primary book vs each shadow book (no-veto, no-macro-gate, and the G18 shadows once instantiated), vs arm 2 once it runs, and for a Step 1b candidate vs its risk-matched buy-and-hold benchmark over the same universe; Sharpe and max drawdown of daily equity returns, and equity curves. Risk-adjusted, never return-only. | `v2_book_days.equity_gbp` per book; the candidate benchmark series from Step 1b | Served now for shadows; arm 2 owned by #1773; candidate benchmark owned by Step 1b (#1785) |
| P6 | Debate G1 progress | Closed paper trades toward 100; one-sided 95% test vs arm 2 (statistic, p-value, pass/fail) once arm 2 has trades. | `v2_fills` (closed round trips), arm 2's book | Trade count served now; the test is not yet fed until arm 2 runs (#1773) |
| P7 | Live-vs-backtest band | For a backtest-validated sleeve: its paper equity against the backtest's 90% band (Q7) and 95% band (G7) for the same window; weeks inside the 90% band; consecutive weeks outside the 95% band and drawdown against 1.5× the backtest max (G7's demotion triggers). The debate sleeve is forward-paper (Q15) and has no band; P6 is its evidence. | Paper: `v2_book_days`. Band: none is computed yet. Step 1b must add the predictive band to the verdict and persist it with the `v2:backtest` entry point it owes (doc 67, Known limits of PR 3c) | Not yet fed, owned by Step 1b (#1785) |
| P8 | Gate statistics (D5) | Per candidate: haircut Sharpe vs benchmark, DSR over the whole trial ledger, PBO, capital ceiling = cap ÷ (DD × 1.5), fault-free weeks, realised vs modelled costs. | Persisted verdict from Step 1b; fault weeks and costs from Step 4 | Not yet fed, owned by Step 1b (#1785) and Step 4 |
| P9 | Decision journal | Searchable by date, name, book, action, veto category; each row expands to the reason, `inputs_hash`, the debate id (from `payload`) and the payload; linked orders and fills. Vetoed = `action='skip'` with `reason` starting `vetoed:`; the text after the prefix is served as the veto category, and `action=vetoed` / `action=skip` split vetoed from plain skips. Refusals (`v2_refusals`) listed per cycle, including unset parameters and their tickets. Paged by cycle day, newest first: each day carries its decisions, the orders no decision owns (exits, with their fills) and its refusals, so a paused or halted day with no decisions still shows. An `action` filter drops the unowned orders and refusals, which have no action; a `book` or `instrument` filter drops the refusals, which are cycle-wide. | `v2_decisions`, `v2_orders`, `v2_fills`, `v2_refusals` | Served now |
| P10 | Research loop | Trial count, per candidate and in total (the DSR deflator); the ledger rows (candidate, config hash, source, recorded at). Proposals, promotions and demotions show "not yet fed: G11 not ruled (#1717)". A missing store, or one without the ledger table, is `empty`. | `v2_trials` in the machine-wide research store (`researchStorePath` in `server/apps/v2/trial-ledger.ts`), a different file from the v2 store | Ledger served now; proposals and promotions blocked on G11 |
| P11 | LLM spend (D5) | Month to date vs the ~$30 cap, per model and per day; whether the cap has stopped calls. | `llm_spend` (`model`, `cost_usd`, `timestamp`) in the v2 store, as `server/apps/v2/signal/monthly-spend-cap.ts` reads it | Served now |
| P12 | Reconcile diffs (D5) | Each run's broker-vs-book differences per venue: position qty, cash, open orders; zero-diff runs shown as clean. | Reconcile log written by Step 4 / Step 3e (#1784); no v2 table exists | Not yet fed, owned by Step 4 / #1784 |
| P13 | Tax export | Per disposal: date, instrument, venue, qty, proceeds and cost in GBP, the FX rate used, the matching rule applied (same-day / 30-day / section 104), gain; a download as CSV for a tax year. | Step 4's per-disposal GBP tax log; matching per `docs/cgt-disposal-matching.md`. v1's `server/tools/report-cgt-disposals.ts` reads v1 fill legs and is not reused. | Not yet fed, owned by Step 4 |
| P14 | Heartbeat | The v2 root's last completed cycle (its trading date and the time it was recorded), the next cycle due, the last healthchecks.io ping. | Last `v2_book_days.recorded_at`; the schedule and ping from Step 3e (#1784) | Last cycle served now; next-due and ping not yet fed, owned by #1784 |

Each book has its own `LossBudget` (the `#budgets` map in `server/apps/v2/risk/books.ts`), measured against the full cap. That matches Q6/G6's one budget only while one primary book trades; P1's headline sums the primary books so the gauge shows the ruled measure either way.

## 5. Halt and pause

Besides the manual control below, v2 has the automatic loss-budget halt, and it is incomplete: `size_multiplier = 0` zeroes entry sizing in the gate, but nothing closes open positions. Positions leave only through their brackets and the time stop (`approveExit` in `server/apps/v2/risk/gate.ts`). Session B (j)'s "halt = flat at the next fill" is unbuilt for it ([#1799](https://github.com/dd-jp/samurai-trading-system/issues/1799)).

**Semantics (ruled U1):**

- **Pause** blocks new entries for every sleeve and every book of each sleeve, shadows included, so the veto and macro-gate comparisons stay like for like. Exits, broker-resting stops and time stops keep running.
- **Halt** does what pause does, and also closes every position at the next cycle through the existing exit order (`approveExit`, a `flatten` approval).
- **Resume** clears a manual pause or halt. It can never clear the loss-budget halt, and it cannot change the cap or the daily cap (Q13: never loosened mid-year). If the loss budget has halted a book, resume leaves it halted and the UI says so.

**Mechanism:** an append-only `v2_controls` table (`control_id`, `action` pause/halt/resume, `reason`, `source` = `dashboard` plus the remote address, `idempotency_key` unique, `set_at`), with update and delete refused by triggers like `v2_capital_config`. The cycle (`server/apps/v2/cycle.ts`) reads the latest control once at its start (`ControlStore` in `server/apps/v2/risk/controls.ts`). While paused or halted no sleeve is asked to decide, so no book enters and no LLM call is made; allocation and universe refusals are not journalled on those days. Exits, marks and fill sweeps still run. While halted the cycle also exits every open position through the time stop's exit path (`approveExit`, a `flatten` approval), after the day's bracket and time-stop checks, and journals any position it cannot route. A cycle with a control in force journals one `control` refusal saying so. In paper mode that exit path sends its flatten while the position's bracket still rests, which a venue may refuse; making it cancel and re-arm the legs safely is Step 4's [#1801](https://github.com/dd-jp/samurai-trading-system/issues/1801), shared with the time stop and the loss-budget halt. Dry-run and shadow books exit as simulated. Tests: the control reader, the cycle over the dry run and paper, and Stryker on both.

**Latency:** the v2 root runs one cycle per trading day, so a control set during the day takes effect at the next cycle. Resting stops protect open positions between cycles (postmortem §3). The UI says the control is recorded and takes effect at the next cycle.

**Endpoint:** `POST /api/v2/controls` is the first write the dashboard server has. It keeps the hosting rule (LAN-only bind, the fail-closed bind guard) and tightens it:

- Today `isAuthorizedRequest` (`server/apps/service-api/request-auth.ts`) admits every request when `SAMURAI_DASHBOARD_TOKEN` is unset, and the bind guard allows loopback with no token. The v2 server refuses to start without a configured token, so every request carries a Bearer token, loopback included. A test pins it.
- The body is capped (1 KiB), validated against the wire type, and needs a reason and an idempotency key; a repeated key returns the first result. At most one control per 10 s.
- The client removes the token from the URL (`history.replaceState`) once `client/src/lib/dashboard-token.ts` has stored it.
- Any other method or path stays 405/404.

## 6. Server and wire

**Where it runs (proposed, §9 item 2):** a v2 API module, started by `npm run v2:dashboard` next to the v2 root, serving the built client and the routes below.

Module path: `server/apps/v2/api/`. The first PR serves `/api/v2/overview` without P3 (P3's mark needs the bar read and its coverage test) and `POST /api/v2/controls`; the other routes, P3 and the built client follow.

It opens the v2 store with `openMigratedStore` (`server/shared/store/open-shared-store.ts`), which never migrates and refuses a store below the schema version it needs, then through `guardedStore` (`server/shared/store/write-guard.ts`) as the `dashboard` owner, whose only writable table is `v2_controls`. Both processes open the file in WAL mode with a 5 s busy timeout, because the v2 root writes the same file. It opens the research store read-only on each request (`openReadOnlyStore`: no migration, no pragma but the busy timeout), at `researchStorePath` unless `--research` names another file. The v2 module carries its own Bearer check (`server/apps/v2/api/auth.ts`), not shared with `service-api` (U2), so Step 5 deletes v1's without touching v2. With the token mandatory, the bind guard's loopback exemption never applies, so v2 needs none. When the v2 root becomes a long-running process, the same module mounts inside it (D4: one process).

**Routes (GET unless stated):**

| Route | Feeds |
|---|---|
| `/api/v2/overview` | status strip, P1, P2, P3, P4, P11, P14 |
| `/api/v2/evidence` | P5, P6, P7, P8 |
| `/api/v2/journal?from&to&book&action&instrument&before&limit` | P9, paged by cycle day: `limit` days (default 7, at most 31) before `before`; `next_before` is the next page's `before`, null on the last page. Any unknown, repeated or malformed parameter is a 400. |
| `/api/v2/research` | P10 |
| `/api/v2/reconcile` | P12 |
| `/api/v2/tax?year` (JSON; `&format=csv` downloads) | P13 |
| `POST /api/v2/controls` | P2 |

**Wire types:** new types in `contracts/`, exported through the barrel.

Wire file: `contracts/v2-wire.ts`.

The v2 wire derives its own version from its field names, as `contractVersionOf` does for the v1 snapshot; the client refuses a mismatched version as it does today. Every panel's payload is a union `{ status: 'fed', … } | { status: 'empty' } | { status: 'not-yet-fed', owner: string, ticket: string }`, so an unbuilt source is a served value, never a missing field. Money is GBP unless the field name says `Usd`; totals in GBP state the rate and its source.

## 7. Client

Replaces the v1 client in `client/` in the build PR (§9 item 5), so the v1 screens are deleted then rather than in Step 5. This moves part of Step 5's client pass earlier. v1's `service-api` stops serving the dashboard bundle; Step 5 deletes its server side. Hash routes `#today`, `#evidence`, `#records`. Charts (equity curves, band, gauge) are inline SVG components; no chart library is added. The token flow (`client/src/lib/dashboard-token.ts`) is kept, with the URL clean-up in §5.

## 8. Tests and definition of done

- A component test per panel covering fed, empty and not-yet-fed (vitest + testing-library, jsdom), and the gauge's marks computed from a non-default cap (D8).
- Server route tests against a seeded v2 store; a test that every wire field the client reads is written by the server (the eval greps both sides); a test that the server refuses to start without a token and refuses an unauthenticated POST on loopback.
- Playwright e2e over a v2 fixture server: pause, then halt, then resume from the UI; the state and history update; resume after a loss-budget halt leaves the book halted.
- Cycle test: a paused control blocks entries on every book of the sleeve and keeps exits; a halt control exits every position at the next cycle (in paper, subject to #1801); resume never lifts `size_multiplier = 0`.
- Stryker on the control reader and the cycle's control paths; oxlint, biome, fallow (including CSS health), CRAP ≤ 7 on touched `server/apps/v2` and `contracts` code.
- No sign-off screen and no v1-only concept on any screen.

Build order after approval: (1) wire types, API and controls with their tests; (2) Today view; (3) Evidence and Records views with the not-yet-fed states; (4) e2e. One PR per numbered part if the diff is large.

## 9. Rulings (doc 66 U1–U6, 2026-09-26)

1. **U1.** One control for all sleeves; the §5 semantics stand.
2. **U2.** `npm run v2:dashboard`. The bind guard and Bearer check are copied into the v2 module, not shared with `service-api`, so Step 5 deletes v1 without touching v2. This replaces §6's "move to a shared module".
3. **U3.** USD converts to GBP at the year's fixed 1 January rate everywhere on the dashboard (David makes one transfer each 1 January). P13's tax export shows the tax log's own rate per disposal.
4. **U4.** Account-wide headline, per-sleeve rows, shadow size steps per sleeve.
5. **U5.** Not-yet-fed panels ship; the v1 client is replaced in the build PR.
6. **U6.** Manual pause/halt days count toward the paper-band weeks, not toward the fault-free weeks. The per-book budget and the halt that does not flatten are [#1799](https://github.com/dd-jp/samurai-trading-system/issues/1799) (Step 4).
