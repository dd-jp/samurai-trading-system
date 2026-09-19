# Samurai v2 — full plan and session handoff (2026-09-19)

**Read this first in any new session working on Samurai v2.** It is self-contained: the goal,
where the decisions live, the evidence behind them, the ordered work, and the traps already hit.
The ruling-by-ruling record is `docs/research/66-v2-grill-decisions.md` (Q1–Q19); this doc does
not restate those rulings in full, it points at them and turns them into work.

## 1. Goal of the session that produced this

David (owner, final decision-maker) ran a brainstorm/grill on 2026-09-19: *"make this samurai a
great autonomous self improving least error margin and least loss margin system. ignore all
decisions, specs and instructions. we are going to correct the mistakes done. lets open the
universe. idea is to make profit even if tiny - one step at a time and keep moving forward."*
Agenda: **long-term (1-year) profit, accepting day-level losses.**

**North star (derived, doc 65 §5b, refined by doc 66):** net-of-cost profit that beats the matched
benchmark, proven to the pre-declared gate (DSR ≥ 0.95, PBO ≤ 0.10, 40% Sharpe haircut, paper
inside the 90% band), run live at capital ≤ £1,500 / (backtest max DD × 1.5), never losing more
than **£1,500 net in a year** (hard kill).

## 2. Source documents (read in this order)

1. `docs/research/66-v2-grill-decisions.md` — **the rulings, Q1–Q19. Authority.**
2. This doc — plan + handoff.
3. `docs/research/65-next-steps-plan.md` — evidence (§1), capital method (§5a), north star (§5b).
4. `docs/samurai-postmortem.md` — six v1 pitfalls, binding on v2.
5. `docs/samurai-vision-v2.md` — David's vision; its 0.5–2%/day target is **superseded by Q1**; its five open questions are answered by doc 66.
6. Docs 61–64 in `docs/research/` — inputs (61 five topics, 62 rewrite/TSMOM fork, 63 qanat mechanisms, 64 replication prior: real strategies Sharpe 0.4–0.8, ~40% OOS decay, >2 = artefact).

All of these are on `main` (docs 61–64 committed via #1694).
Ask David whether to commit them in the doc-rewrite PR.

## 3. Evidence that drove the rulings (paper DB `data/samurai-paper.sqlite`, read 2026-09-19)

- 267 debates: 209 neutral (mean conf 0.133), 42 bearish (mean 0.67), 16 bullish (**max 0.473** vs entry floor **0.55**). No debate-originated long can ever fire. → D1 audit.
- Closed trades — control: long 37 (+£444, of which +£891 from MSTR/MARA/COIN, so ex-those ≈ −£447), short 42 (+£355, ex-those ≈ +£84). Live arm: 7 trades, 6 short, −£112. Sample far too small to conclude anything.
- Paper book runs long/short US single stocks on Alpaca — **not** the v1 live product (long-only LSE 3× ETPs at Saxo). Control sizing avg £1,457 (above D5); `arm_comparison_samples` (−18.8%) disagrees in sign with `closed_trades` (+£799).
- Total LLM spend $3.04 over 1,428 calls — the chassis/cost is not the constraint; the signal is.
- Every intraday research result is negative or underpowered. Momentum (doc 11) measured only +0.17 Sharpe over always-long, t = 0.15, on a different design — v2's momentum sleeve is untested.

## 4. The v2 system in one page (from doc 66)

- **Venues:** Saxo GIA → LSE 1× ETFs/ETCs. Alpaca live (GBP wired once, trade USD) → US large caps (+ US ETFs if UK access confirmed). No 3× ETPs, no UK single stocks, no CFDs.
- **Sleeves:** (1) **Momentum** — rules only, long/flat, LLM veto (Opus 5) only, 70% of live capital, benchmark = buy-and-hold of the same universe. (2) **Debate** — LLM entry (debaters Sonnet 5 + DeepSeek + GPT, judge Opus 5), swing (one debate/name/day pre-open, days–weeks hold, resting stop + time stop), may short bounded (Alpaca ETB large caps sized so +30% gap ≤ ~£150; Saxo via 1× inverse ETFs), 30%, benchmark = arm 2 no-LLM control, validated **forward only** (LLM look-ahead leak).
- **Loss budget:** net from start capital, both venues, GBP, marked-to-market. −£500 → ½ size, −£1,000 → ¼, −£1,500 → halt for the year. Daily ≈1% cap blocks entries. Profits never extend the limit. Loosening mid-year forbidden.
- **Self-improvement:** offline research loop over the trade journal/error log → walk-forward with global trial counter → gate → paper → David sign-off → live. Live frozen except pre-declared, backtested adaptation rules and risk-tightening.
- **Autonomy:** auto to paper; David signs anything touching live (one-page summary).
- **Host:** MacBook + external dead-man's switch + Saxo token-refresh/wake job; broker-resting stops. Cloud VM if any paper downtime fault.
- **Stack:** TypeScript only for everything that trades (backtest = live code). No LangGraph/CrewAI/LangSmith. Python sidecar = proposed, **not ruled**.
- **Tooling:** oxlint, biome, crap, fallow rules intact; fallow (not knip) for dead code.

## 5. Ordered work

Each step: `what => verify / kill line`. Steps 1 and 2 are £0, no LLM, and may start immediately (Q18: research, not build).

### Step 0 — Doc rewrite (David asked for this explicitly; Q18/Q18a)

Do on a **new branch off fresh `origin/main`**, one PR, David merges.

1. `git tag v1-final origin/main && git push origin v1-final` => tag visible on origin.
2. Copy `data/samurai-paper.sqlite` (main checkout) to an archive location David approves (outside git; it is data) => copy opens with `sqlite3`.
3. Delete all of `docs/specs/*` (20 files) and `docs/adr/*` (21 files) => `ls` empty.
4. Write **`docs/adr/0001-samurai-v2.md`**: all doc-66 rulings as the decision; supersedes the entire v1 ADR set; restates the still-true v1 decisions one line each — money-math precision (old 0005), daily equity return series (old 0006), client/server layout + `contracts/` wire model (old 0012), dashboard hosting (old 0019), dashboard v3 rail (old 0021). Cite `v1-final` for the originals. <!-- cite-exempt: planned — created by Step 0 -->
5. Rewrite **`CONTEXT.md`** from scratch as the v2 glossary (sleeve, loss budget, gate, band, trial counter, arm 2, veto, venue-resting stop, research loop, promotion…). No implementation detail.
6. Rewrite **`CLAUDE.md`**. **Keep verbatim:** "Code Comments" section (with the effde735 precedent), "Rate Limit Rule — HARD STOP" (with the autoContinueAtUsageLimit paragraph), "graphify" section. **Add:** lint tooling rule — all oxlint, biome, crap and fallow rules stay intact and bind v2; fallow for dead code. **Rewrite everything else** to doc 66: identity/goal/north star, venues/instruments, sleeves, loss budget, gate numbers, autonomy, host, language, process (Q18 lighter process replaces Standing Pipeline Rules 1/7), docs convention (specs/ADRs now v2-only), key constraints (resting stops, coverage invariants, per-disposal GBP tax log, paper ≠ edge).
7. Fix references to deleted docs so CI stays green. Files found 2026-09-19 (`grep -rlE 'docs/(adr|specs)/|CONTEXT\.md' server client contracts .github scripts`):
   - `server/tools/check-path-citations.ts` + `.test.ts` + `server/tools/__fixtures__/path-citations/*` — **the fixtures are deliberate test inputs; do not "fix" them** (see memory comment-stripping-pr-1688).
   - `server/shared/store/spec-schema-drift.test.ts` — **reads `docs/specs/shared-sqlite-store-spec.md`; deleting the spec breaks it.** Decide: delete the test (spec gone) or repoint at the v2 ADR / migrations. Ask David if unclear.
   - `server/shared/store/migrations/*.sql`, `server/providers/market-intelligence/archive/migrations/0001_mi_archive.sql` — **applied migrations: do not edit** (checksum/immutability risk). Leave their dangling citations; if `check-path-citations` flags them, exempt migrations in the checker.
   - `server/providers/universe-pool/lse-etp-pool.ts`, `server/shared/threshold-bounds.ts`, `server/apps/orchestrator/alert-catalogue.ts` (+ `.golden.json`), `server/apps/orchestrator/smoke-run.ts`, `server/tools/mutation-local.test.ts` — drop or repoint the citation; regenerate the golden if its text changes.
   => `yarn` lint + typecheck + test + `npm run smoke` all green locally; CI green on the PR.
8. **Rename files for maintenance/readability** (David, 2026-09-19: *"rename files if required, for maintenace and readbability concerns"*). Use `git mv` so history follows; update every reference in the same PR. Proposed:
   - `docs/samurai-postmortem.md` → docs/v1-postmortem.md; `docs/samurai-vision-v2.md` → docs/v2-vision.md (both on main). Renaming breaks CONTEXT.md's North Star link and docs 66–68 — update them in the same PR.
   - v2 docs named by what they are: `docs/adr/0001-samurai-v2.md`; specs `docs/specs/momentum-sleeve-spec.md`, `debate-sleeve-spec.md`, `loss-budget-spec.md` (written in later steps, not in the Step 0 PR). <!-- cite-exempt: planned — v2 docs not yet written -->
   - Keep the NN-slug numbering in `docs/research/` (cited by number); record any research rename in `docs/research/README.md`'s rename table.
   - Code renames that remove v1 vocabulary (intraday, flatten, ETP, D5, arm names) happen in Steps 3/5 as modules move into or out of the v2 root, not in the doc PR.
   => `grep -rn` for each old path returns nothing.
9. `graphify update .` after code edits.

### Step 1 — Momentum backtest (£0, no LLM)

Survivorship-safe universe (Q15). Walk-forward, trial counter from trial #1, DSR/PBO via `server/tools/backtest/overfitting.ts`, costs: Saxo 0.08%/side no minimum (16 bps round trip); Alpaca spread-only (~1–3 bps large caps, measure it). Pre-declare the parameter grid before running.
=> **Kill:** does not beat buy-and-hold of the same universe (risk-matched) after the 40% haircut with DSR ≥ 0.95 and PBO ≤ 0.10. Record every trial.

### Step 2 — D1 debate audit/fix (£0, no LLM)

Offline replay of `debate_log` from `data/samurai-paper.sqlite` to find why bullish conviction caps at 0.473 < 0.55 (history: #625 stocks ceiling 0.5478, debate rounds moved conviction by zero, #683 mediator tie-break).
=> If formula bug: fix, re-replay, bullish must be able to clear the floor. If no bug and long setups genuinely weak: debate sleeve becomes short-only or veto-only (David decides).

### Step 3 — v2 composition root (after 1–2)

New slim root in this repo; reuse Alpaca + Saxo adapters, providers, stores, debate core behind a real module interface (postmortem §5). Saxo **simulated paper adapter**: fills at Saxo bid/ask, live tariff 0.08%/side no min (Saxo SIM env has a 24h manual token + trial £8 tariff — don't use it for evaluation). Alpaca paper native. Wire only surviving sleeves. Stop the v1 paper soak.
=> one v2 paper cycle end-to-end green.

### Step 4 — Protection before any paper trade

Broker-resting stops on every position; loss-budget machinery (Q6); daily cap; dead-man's switch; Saxo token refresh (live refresh token lives 3600 s); per-disposal GBP tax log with FX rate; LLM trace row (prompt version, inputs, output, cost) joined to trade.
=> fault-injection: kill the process mid-position → stop still rests at broker; budget breach → entries halt.

### Step 4b — Assurance checklist (David, 2026-09-19) — **no paper trade until every item passes**

Each item needs an automated test or a recorded drill with its pass condition. Build as tests in the v2 tree, not as one-off scripts.

| Area | Item | Pass condition |
|---|---|---|
| Backtest | Look-ahead canary | Shifting the signal one bar later collapses the edge; a random-signal run lands inside the null distribution |
| Backtest | Cost stress | Result reported at 1× and 2× modelled cost; 2× must not flip the sign, or the sleeve is flagged |
| Backtest | Regime split | Per-period table (incl. 2020 crash, 2022 drawdown); no single period carries the result alone |
| Backtest | Locked final holdout | A final time slice the research loop can never read; read once, at promotion |
| Backtest | Data sanity | Coverage invariant per series (postmortem §2); adjusted-price jumps, gaps, zero-volume days flagged |
| Logging | Decision journal | Every decision incl. no-entry, veto, cap and skip, with its inputs and reason, append-only |
| Logging | Deterministic replay | Any past day re-runs from logs to identical decisions |
| Resilience | Fault matrix | Drills pass for: broker API down, partial fill, rejected order, stale data, clock/DST, holiday, duplicate run (idempotent), crash mid-order, Mac asleep |
| Resilience | Reconcile every run | Broker positions/cash vs store each run; any mismatch halts entries and alerts |
| Resilience | Loss-budget rehearsal | Simulated −£500 / −£1,000 / −£1,500 on paper → ½ size / ¼ size / halt, and the daily cap blocks entries |
| Self-learning | Trial counter | Append-only, tamper-evident; every backtest run increments it |
| Self-learning | Promotion dry run | One full proposal → gate → paper-promotion cycle on a dummy change before the first real one |
| Adaptability | Rule scenarios | Scenario tests prove each pre-declared rule fires (vol spike, trend break, sleeve slump → demotion) |
| Adaptability | Drift monitor | Live-vs-backtest distribution drift with pre-committed thresholds (#1516) |
| Engineering | CI alive | GitHub Actions billing fixed; CI enforces oxlint, biome, crap, fallow, tests |
| Engineering | Property tests | Money math, loss budget, sizing |
| Engineering | Mutation testing | Risk and loss-budget code via `server/tools/mutation-local.ts` |
| Engineering | Broker contract tests | Order/position shapes against Alpaca paper and Saxo SIM |
| Observability | v2 views | Loss budget left, live position within backtest band, sleeve vs benchmark, heartbeat, LLM spend |
| Observability | Daily report + alerting | Daily summary pushed to David; any fault alerts within minutes |

=> all rows green, then paper starts.

### Step 5 — v1 teardown (Q11, after step 3 runs)

fallow + graphify reachability from the v2 root → reviewed list → delete in per-area waves, CI green each. Rename surviving v1-named files/modules to v2 vocabulary in the same waves (Step 0 item 8). Known-dead list in doc 66 Q11.

### Step 6 — Paper soak to the gate (Q7/Q19), then research loop

8–12 weeks inside band + 4 clean plumbing weeks → one-page summary → David sign-off → live at the floor. Research loop built once a journal exists.

### Also

- Open the **wayfinder map issue "Samurai v2"** (label `wayfinder-map`) with doc 66's rulings as closed decisions; tickets per step with kill lines (Q18). Every loose end in §5a becomes a child ticket.

## 5a. Loose-ends register (must be empty before Session A starts)

**Needs David's ruling (grill, one at a time):**

1. **Debate sleeve go-live rule.** The Q7 gate assumes a backtest band; the debate sleeve cannot have one (LLM look-ahead). It needs its own rule, e.g. forward paper vs arm 2 with a pre-declared minimum trade count and significance.
2. **Intraday.** Q9 = A (no intraday) stands unless David changes it to C (a later gated third sleeve).
3. **Python research sidecar** — rule yes/no.
4. **Debate universe.** Which names are debated daily (the momentum sleeve's picks, a separate screen, or both)?
5. **Veto is a trial.** An LLM veto on momentum can erode its returns; it must be A/B-measured (veto vs no-veto) on paper, with a veto-rate cap.
6. **FX exposure on the Alpaca USD balance.** Hedge it, or count GBP/USD moves inside the £1,500 budget?
7. **Live demotion rule.** Exact thresholds that pull a live sleeve back to paper.

**Needs research (Session R in doc 68):**

- **UK tax, possibly material:** offshore-fund rules (gains on non-reporting funds taxed as income, not CGT; most US-listed ETFs are non-reporting; screen LSE ETFs for HMRC reporting-fund status); share matching (same-day and 30-day rules) under weekly rebalances, which the tax log must implement.
- **Brokers:** Alpaca margin for UK residents, US-ETF access (PRIIPs/KID), borrow fees, PDT-removal implementation date; Saxo FX conversion fee; availability of 1× inverse ETFs on LSE.
- **Data:** how many LSE ETFs have 10+ years of history; Yahoo/Stooq terms for automated use.
- **Execution timing:** rebalance at the open, the close, or the LSE closing auction, and the slippage model for each.
- **Security:** withdrawals disabled, IP allow-lists, and token storage for both venues.

Added 2026-09-19 (unknowns sweep). R1, R2 and R5 could change what gets built:

- **R1 — Trading vs investing (HMRC badges of trade).** Frequent automated trading may be taxed as trading income (income tax + NI), not CGT. Establish which applies to this pattern; likely needs an accountant's view.
- **R2 — Alpaca fractional positions cannot carry resting stops.** Stop/bracket orders are refused on fractional quantities (memory alpaca-fractional-bars-brackets). Confirm the current rules; decide between whole-share-only US positions and an alternative protection path.
- **R3 — Whole-share granularity at small capital.** At ~£3,500 across ~25 ETFs (~£140/position), share prices of £50–100+ make target weights unreachable. Find the minimum viable capital per holdings count, on both venues.
- **R4 — Do stops help momentum?** Stops often hurt trend strategies. Session B must backtest with and without the resting stop (counted as trials).
- **R5 — Evidence that an LLM news/debate signal works at a daily horizon,** from studies free of look-ahead (tested after the model's training cutoff). If there is none, the 30% debate sleeve rests on hope; report before Step 3.
- **R6 — News source for LSE ETFs** for the debate (Alpaca news is US-only; Saxo news is unreachable over OpenAPI, memory saxo-platform-oapi-vs-openapi).
- **R7 — Live end-of-day price source for LSE** that permits automated use (Yahoo terms; Saxo is 15-min delayed).
- **R8 — Dividends and corporate actions:** accumulating vs distributing ETFs, backtest vs live treatment, ex-dividend drops tripping stops.
- **R9 — Holiday calendars** for both US and UK, and their expiry.
- **R10 — LLM providers:** can GPT and DeepSeek versions be pinned via OpenRouter; data-retention/privacy terms (DeepSeek especially); rate limits.
- **R11 — Funding Alpaca from the UK:** wire fees, Wise support, conversion cost.

**Also needs David's ruling (later, not blocking Session A):**

13. **Research-loop design** — which agents, what data, how proposals are generated. Its own brainstorm before Step 5/6's research loop.
14. **David unavailable** — default behaviour when a sign-off or pause gets no answer (e.g. hold; never loosen; never go live).

**What blocks Session A:** only rulings 2, 3, 8, 9, 11 plus research R1, R2, R5, the doc fixes, and the cross-verification. The other items block the step named in the "blocks" column of their tickets: ruling 12 → Session B; rulings 4, 5, 6, 10 and R3, R6, R7, R8, R10 → Step 3; rulings 1, 7, 14 and R9, R11 → paper/live; ruling 13 → the research loop.

**Added by the Opus review (2026-09-19) — also need David's ruling:**

8. **ADRs: delete or keep?** Q11 says ADR-0014–0018 are "superseded, never deleted"; Q18 says delete all 21. The citation checker treats `docs/adr/` as an immutable record dir (`server/tools/check-path-citations.ts` `IMMUTABLE_RECORD_DIRS`). Pick one; mark the other clause superseded.
9. **PBO bar vs code.** Q19 says PBO ≤ 0.10; doc 65, CONTEXT.md body and `server/shared/threshold-bounds.ts` (`max_pbo.max = 0.05`, enforced at boot by `server/apps/orchestrator/smoke-run.ts`) say 0.05. Relax the code bound or keep 0.05.
10. **Momentum veto validation.** The LLM veto has the same look-ahead leak as the debate, so backtested momentum ≠ live momentum + veto. Proposal: run a no-veto shadow arm forward (overlaps item 5).
11. **Loss budget scope.** £1,500 per calendar year (resets) or total before stopping (doc 65's L)? Do deposits during the ramp rebase "start capital"? FX moves on US holdings count (item 6).
12. **Budget path dependence.** At the £5,000 ceiling, −£500 is a 10% drawdown — an ordinary momentum drawdown — so half-size triggers inside normal behaviour and pushes paper/live out of the backtest band. Either express the steps as % of the backtest's max DD or backtest with the budget rules included.

**Doc fixes (no ruling needed) — apply before Session A:**

- Step 0 item 7 is wrong and incomplete. What actually breaks is the `check:citations` CI step (`.github/workflows/ci.yml` "Path citations resolve"), which scans all git-indexed `.md`/`.ts` except `docs/adr/`, `docs/wayfinder/`, `docs/research/archive/`, `docs/reviews/`. `.sql` files and TS string literals are never scanned, so migrations, `lse-etp-pool.ts`, `alert-catalogue.ts`/golden, `threshold-bounds.ts`, `smoke-run.ts` need no edits. The only runtime reader of a deleted doc is `server/shared/store/spec-schema-drift.test.ts`. Backticked `docs/adr|specs` citations to fix or mark `<!-- cite-exempt: historical — … -->`: CONTEXT.md, CLAUDE.md, README.md, research docs 16, 39, 40, 42, 43, 58, 59, 60, 61 and `docs/research/README.md` (~30). Also `package.json` description. Verify with `npx tsx server/tools/check-path-citations.ts` → 0 violations.
- Session T buckets: #238, #751, #895, #900, #1054 are code-cited; #895/#900 are in `LIVE_MONEY_GATES` and a test asserts they stay open — move to fold/defer, and run `npm run check:live-gates` before closing anything.
- Session B is underspecified: make its first step "propose strategy family (time-series trend vs cross-sectional), exact ETF list, point-in-time S&P 500 dataset URL, delisted haircut size, LSE survivorship handling, DSR on excess vs absolute returns, and that the strategy is written as the module live code imports — then STOP for David".
- Step 3 must build Anthropic + OpenRouter LLM clients (only Nous clients exist today, ADR-0009).
- Doc 65's scoreboard defects (control oversizing; `arm_comparison_samples` vs `closed_trades` sign disagreement) and arm 2's undefined swing entry rule belong to Step 3 / Session C.
- Stale/inconsistent: doc 65 needs a "superseded by doc 66" banner (still plans an intraday sleeve and flat-by-close; PBO 0.05; "haircut drawdown × 1.5"); Step 0 "ls empty" vs new specs; billing blocks CI vs "CI green"; v1 soak stop is Q10 but deferred to Step 3; copy the SQLite DB with `.backup`, not `cp` (WAL); Step 3's paper cycle runs before Step 4's protection (Q17 says protection first — make Step 3's check a dry run with no orders); pin GPT/DeepSeek versions; pick 8 or 12 weeks by rule (e.g. ≥ 10 rebalances); set the daily cap exactly; name what "crap" is (no tool configured in package.json/oxlint/biome/fallow/CI — confirm with David, likely #1649's CRAP gate); Sessions B and C must not both take doc number 69; name the owner of the wayfinder map and of Session R.
- Session C caveat: v1 debates ran on hourly bars on the ETP/single-stock book; a "long setups are weak" verdict may not transfer to daily swing. The 0.55 floor is in `server/pipeline/trader/types.ts`.
- Paper band test is low-power over 8–12 weeks; add an order-level check: paper's orders match a backtest replay of the same days.

**Verification:** after the rulings above and the doc fixes land, run one final cross-verification pass over docs 65–68 + CONTEXT.md before Session A.

## 6. Traps already hit (read before touching the repo)

- **Worktree-isolation hook** refuses Bash with shell variables in sqlite paths and base64 pipes. Use literal read-only URIs: `sqlite3 "file:/Users/ddjp/Documents/projects/samurai-trading-system/data/samurai-paper.sqlite?mode=ro" "..."`. Subagent Bash is refused under worktree isolation (memory subagent-bash-refused-in-worktree).
- Paper DB lives in the **main checkout's** `data/`, not the worktree's (memory service-reads-worktree-store).
- Doc numbering collides with David's untracked docs — `ls docs/research` in the **main checkout** before picking a number. 61–68 are taken.
- `Closes #N` / "closed #N" in a PR body auto-closes issues at merge — grep the body.
- Merges are David's. No live money until David is confident. Caveman-ultra style for chat replies to David; normal prose in docs/commits. Never commit secrets (Saxo live token is in `data/saxo-tokens/live.json`).
- Rate-limit hard stop rule applies.

## 7. Where this lives

All on `main` (docs 61–68, CONTEXT.md North Star). Session prompts are in `docs/research/68-fable-handoff.md`. Session A starts only once §5a is empty.
