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
6. `docs/research/61`–`64` — inputs (61 five topics, 62 rewrite/TSMOM fork, 63 qanat mechanisms, 64 replication prior: real strategies Sharpe 0.4–0.8, ~40% OOS decay, >2 = artefact).

**Caveat:** docs 61–64, the postmortem and vision-v2 are **untracked files in the main checkout**
(`/Users/ddjp/Documents/projects/samurai-trading-system/docs/...`), not on any branch. They are
David's; do not `rm`/overwrite them. Links to them from branch docs dangle until David commits them.
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
4. Write **`docs/adr/0001-samurai-v2.md`**: all doc-66 rulings as the decision; supersedes the entire v1 ADR set; restates the still-true v1 decisions one line each — money-math precision (old 0005), daily equity return series (old 0006), client/server layout + `contracts/` wire model (old 0012), dashboard hosting (old 0019), dashboard v3 rail (old 0021). Cite `v1-final` for the originals.
5. Rewrite **`CONTEXT.md`** from scratch as the v2 glossary (sleeve, loss budget, gate, band, trial counter, arm 2, veto, venue-resting stop, research loop, promotion…). No implementation detail.
6. Rewrite **`CLAUDE.md`**. **Keep verbatim:** "Code Comments" section (with the effde735 precedent), "Rate Limit Rule — HARD STOP" (with the autoContinueAtUsageLimit paragraph), "graphify" section. **Add:** lint tooling rule — all oxlint, biome, crap and fallow rules stay intact and bind v2; fallow for dead code. **Rewrite everything else** to doc 66: identity/goal/north star, venues/instruments, sleeves, loss budget, gate numbers, autonomy, host, language, process (Q18 lighter process replaces Standing Pipeline Rules 1/7), docs convention (specs/ADRs now v2-only), key constraints (resting stops, coverage invariants, per-disposal GBP tax log, paper ≠ edge).
7. Fix references to deleted docs so CI stays green. Files found 2026-09-19 (`grep -rlE 'docs/(adr|specs)/|CONTEXT\.md' server client contracts .github scripts`):
   - `server/tools/check-path-citations.ts` + `.test.ts` + `server/tools/__fixtures__/path-citations/*` — **the fixtures are deliberate test inputs; do not "fix" them** (see memory comment-stripping-pr-1688).
   - `server/shared/store/spec-schema-drift.test.ts` — **reads `docs/specs/shared-sqlite-store-spec.md`; deleting the spec breaks it.** Decide: delete the test (spec gone) or repoint at the v2 ADR / migrations. Ask David if unclear.
   - `server/shared/store/migrations/*.sql`, `server/providers/market-intelligence/archive/migrations/0001_mi_archive.sql` — **applied migrations: do not edit** (checksum/immutability risk). Leave their dangling citations; if `check-path-citations` flags them, exempt migrations in the checker.
   - `server/providers/universe-pool/lse-etp-pool.ts`, `server/shared/threshold-bounds.ts`, `server/apps/orchestrator/alert-catalogue.ts` (+ `.golden.json`), `server/apps/orchestrator/smoke-run.ts`, `server/tools/mutation-local.test.ts` — drop or repoint the citation; regenerate the golden if its text changes.
   => `yarn` lint + typecheck + test + `npm run smoke` all green locally; CI green on the PR.
8. **Rename files for maintenance/readability** (David, 2026-09-19: *"rename files if required, for maintenace and readbability concerns"*). Use `git mv` so history follows; update every reference in the same PR. Proposed:
   - `docs/samurai-postmortem.md` → `docs/v1-postmortem.md`; `docs/samurai-vision-v2.md` → `docs/v2-vision.md` (both untracked in the main checkout today — commit them first with David's OK).
   - v2 docs named by what they are: `docs/adr/0001-samurai-v2.md`; specs `docs/specs/momentum-sleeve-spec.md`, `debate-sleeve-spec.md`, `loss-budget-spec.md`.
   - Keep `docs/research/NN-slug.md` numbers (cited by number); record any research rename in `docs/research/README.md`'s rename table.
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

### Step 5 — v1 teardown (Q11, after step 3 runs)

fallow + graphify reachability from the v2 root → reviewed list → delete in per-area waves, CI green each. Rename surviving v1-named files/modules to v2 vocabulary in the same waves (Step 0 item 8). Known-dead list in doc 66 Q11.

### Step 6 — Paper soak to the gate (Q7/Q19), then research loop

8–12 weeks inside band + 4 clean plumbing weeks → one-page summary → David sign-off → live at the floor. Research loop built once a journal exists.

### Also

- Open the **wayfinder map issue "Samurai v2"** (label `wayfinder-map`) with doc 66's rulings as closed decisions; tickets per step with kill lines (Q18).
- Verify the unverified facts in doc 66 "Still open".
- Ask David to rule on the Python research sidecar.

## 6. Traps already hit (read before touching the repo)

- **Worktree-isolation hook** refuses Bash with shell variables in sqlite paths and base64 pipes. Use literal read-only URIs: `sqlite3 "file:/Users/ddjp/Documents/projects/samurai-trading-system/data/samurai-paper.sqlite?mode=ro" "..."`. Subagent Bash is refused under worktree isolation (memory subagent-bash-refused-in-worktree).
- Paper DB lives in the **main checkout's** `data/`, not the worktree's (memory service-reads-worktree-store).
- Doc numbering collides with David's untracked docs — `ls docs/research` in the **main checkout** before picking a number. 61–67 are taken.
- `Closes #N` / "closed #N" in a PR body auto-closes issues at merge — grep the body.
- Merges are David's. No live money until David is confident. Caveman-ultra style for chat replies to David; normal prose in docs/commits. Never commit secrets (Saxo live token is in `data/saxo-tokens/live.json`).
- Rate-limit hard stop rule applies.

## 7. Where this lives

Branch `worktree-doc-64-next-steps-plan` (pushed, no PR), docs 65/66/67. Start the next session with:

> Read `docs/research/67-v2-plan-and-handoff.md` and `docs/research/66-v2-grill-decisions.md` on branch `worktree-doc-64-next-steps-plan`, then do Step 0 (doc rewrite) on a new branch; Steps 1 and 2 can run in parallel as £0 research.
