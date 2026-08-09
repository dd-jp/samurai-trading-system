# Paper-soak readiness — 2026-08-06

> **ARCHIVED — point-in-time gate record (PASS, 2026-08-06).** No successor doc; the standing caveats are carried in [`README.md`](../README.md) under Infra.

Written at the end of the autonomy sweep, against merged `main` at `ac87c6a`.

**Verdict: the system boots, transacts end to end, and is configured to ADR-0008's budget. Three things are true that you should know before starting #238, and none of them is a build defect.**

## The gate

| Check | Result |
|---|---|
| `yarn typecheck` (both configs) | **0 errors** |
| `yarn lint` | **0** |
| `yarn build` | **0** |
| `yarn vitest run` | **2282 passed, 1 skipped** |
| `yarn smoke` | **GATE: PASS** — full 6-stage transaction, fill ingested |
| `paperStartingProfile.llmBudgetUsd` | **50** |
| `paperStartingProfile.tickIntervalMs` | **15 × 60_000** |

Budget and cadence match ADR-0008 exactly: $50 over 14 days at a 15-minute cadence, ~296 instrument-passes/day, ≈$42 projected against a $50 ceiling.

## Three things to know

### 1. The soak will measure a system whose mechanical layer has no demonstrated edge

The Stage 2 re-run (`2026-08-06-stage2-verdict-post-405.md`) came back **KILL/INCOMPLETE**, and this time not on a technicality: MinBTL now passes because the grid is sized to the sample, and it still fails PBO (0.85 stocks / 0.55 crypto against a 0.05 line) and DSR (0.36 / 0.39).

That verdict is about the **proxy** strategy — a moving-average cross that exists to exercise the cost model and replay harness — not about the LLM debate pipeline the soak actually runs. No backtest can host that pipeline (ADR-0001). So the soak is not invalidated by it.

What it does mean: **a profitable soak is evidence about the debate pipeline, and nothing else has been shown to work.** Read the result that way rather than as confirmation of the mechanical layer.

### 2. Two of the three analysts run on an empty store, and now say so

`MarketIntelligenceStore` has no writer in production. `sentiment` and `fundamental` see zero items on every tick. As of #463 they emit an explicit `NO DATA:` marker naming the absence rather than a `confidence: 0.05` neutral view, so the soak's own transcripts distinguish *"never had an input"* from *"looked and saw nothing"*.

Practically: **crypto debates run 1 real analyst of 2, equity debates 1 of 3.** The multi-agent premise is only partly exercised. #464 (Grok agent on a 4h cadence, metered into `llm_spend`) is the work that changes it, and the decisions behind it are locked on #436.

`fundamental` is `mandatory` for stocks in the spec, which is why the map flags this as blocking **live equities** — not the paper soak.

### 3. Three learning layers are built, tested, and not fed

- **Analyst weights** — written daily by attribution, read by nobody at debate time. Deliberate: #435's spec half landed, and the reader waits on the `debate_id` contract question recorded there. At this cadence attribution runs over near-empty samples anyway, so weights barely leave their seeds across a whole soak.
- **`NotifyingVerdict`** — unwired (#465). At ~296 passes/day, wiring it as specced would be ~300 Telegram messages daily.
- **Trader/Risk decision records** — do not exist. #328 resolved the shape (`trader_log` / `risk_log`, synchronous, append-forever at this cadence); it is unbuilt. **This is the one that bites during a soak:** when the run does something surprising, "why was size N" and "why did it stop at risk" are currently answerable only from ephemeral stdout.

## What changed in this sweep

19 issues closed. The ones that affect a soak directly:

- **#333** — per-class daily-loss halting, and an unknown daily figure now blocks new entries instead of reading as a flat day
- **#432 / #433** — cosine precedent and risk thresholds, both written and previously read by nobody, now wired
- **#431** — analyst retry plus a two-consecutive-skip alert
- **#429** — `flatten` / `cancel` / `getOpenPositions` on the broker port
- **#330** — the store path keys off trading mode, not `NODE_ENV`, so a live run cannot inherit paper positions
- **#393 / #426** — `debate_log` bar flooring and `trace_id`, making replay-from-log reachable
- **#434** — `TELEGRAM_ALLOWED_USER_IDS` no longer required for a gate that cannot fire; the composition root now refuses a HITL-engaging `automation_level` outright
- **#430** — the composition-root assertion test, which is what keeps the no-caller class from recurring

## Before you start #238

1. **Add the two keys** — `XAI_API_KEY` and `WORLDMONITOR_API_KEY` are placeholders in `.env.local`. Neither is read yet (#464 is the consumer), so the soak runs without them.
2. **Top up Nous credits** if you want AI review on the remaining PRs — both reviewers are currently skipping.
3. **Decide on #328.** It is the highest-value unbuilt thing for a soak specifically, because it is what makes the soak's surprises diagnosable afterwards.

Nothing above blocks starting. Items 1 and 2 are not soak inputs; item 3 changes how much you learn from it.
