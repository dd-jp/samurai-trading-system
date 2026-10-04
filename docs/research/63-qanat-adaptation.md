# 63 · Qanat — What's Adaptable (fit assess)

- **Date:** 2026-09-19
- **Source:** [fidetolabs/qanat](https://github.com/fidetolabs/qanat) (MIT, Python), via https://www.fidetolabs.com/open-source
- **Parent Obsidian:** `/Users/ddjp/Documents/Obsidian/research/qanat-fidetolabs-vs-samurai-2026-09-19-report.md`
- **Bands under:** none (track-50s intraday concern) — treat as candidate mechanisms, not a product decision

## TL;DR

Do **not** import Qanat the engine (daily-rebalance DAG backlog, Python → barred by ADR-0001; produces weights-not-orders; no debate/feedback/execution). **Do** look at three mechanisms. **One** is a trial-worthy candidate on the binding constraint.

| # | Mechanism (from Qanat) | Action for Samurai | Priority |
|---|---|---|---|
| 1 | Charge cost **on turnover**; `--decay` blends last-N weights | Assess a **declared, multi-session consensus/blend** in Trader or Feedback Loop to stop paying 16 bps on single-session noise flips | **Trial candidate** |
| 2 | Step reads only tables it declared; undeclared read = error | Audit stage/step **input whitelist**; fail closed on undeclared inputs | Cheap hardening |
| 3 | Net-as-headline; fees/slippage on turnover; explicit `--split` in/OOS | Confirm + formalize backtest reporting (surface turnover + OOS per strategy) | Confirm/formaliize |

## How to access

- Repo: `git clone https://github.com/fidetolabs/qanat` — MIT, no key.
- Mechanism source-of-truth: `README.md` (§ Backtest, § The five stages), `docs/backtest.md`, `docs/contract.md` in-repo. <!-- cite-exempt: foreign — qanat's repo, not ours -->
- CLI (`qanat backtest --rebalance / --decay / --split`) for the exact numbers below.

## License boundary

MIT — free to reimplement the *mechanisms* in TypeScript. The Python is a reference fork, **not** a dependency (ADR-0001). Do not vendor their code into `server/`.

## Mechanism 1 — turnover cost + decay (the one with real content)

Qanat's own measured mechanism (their readme, synthetic `--demo`; treat as proof-of-mechanism, not alpha):

- Rebalance-only change: `--rebalance 10d` → turnover 10.8, net **+23.2%**; `--rebalance 1d` → turnover 128.5, net **−27.1%**. Trading more often turns a winner into a loser.
- `--decay off` → turnover 45.00, net −5.05%; `--decay 4` → turnover 25.32, net −2.88%. Blending the last N portfolios cuts fee bleed from noise.

**Why it maps to Samurai hard:** we are *already* turnover-exposed by construction — flat-by-close means each live session is a fresh Saxo round trip, and the binding constraint is accuracy-per-round-trip (break-even 52.6–58.5%, charged bars +4.66/+8.18 pp over coin flip). A single-session flip verdict that reverses is a paid round trip that decay could have walked back.

**What to build (candidate design, to be grilled on a wayfinder map first):**
- In the Trader (preference: beside the existing bounded sizing 0.5–1.5×) or as a Feedback-Loop input, hold a **consensus blend over the last N sessions** for the *direction/size* decision.
- `N` is a **declared constant chosen before looking at outcomes** (ADR-0018 D4 — no ranked axis, no fit). Default candidate: `N=3`; variants pre-registered, not explored post-hoc.
- Scope to entries only; do not touch the exit (ADR-0018 D3 neutral single bracket stays).
- Gate the build on measured live flip statistics (see Risks).

**Risks:**
- **Upstream unknown:** #625 still records few/no trades — selector win rate unmeasured. If there is no measured edge, decay dampens an unmeasured book. Do **not** spend a live D4 slot before Arm-2 comparison has a win rate.
- Decay may fight the Feedback Loop's threshold adaptation. Design the interaction before building.
- Qanat has **no benchmark** — do not trust its demo % ; it is synthetic with no API key and no network (`--demo`).

## Mechanism 2 — stage-input honesty

Qanat invariant: `ctx.read()` rejects any table the step did not list in `from:`; `qanat check` refuses a project that breaks the forward-only stage contract. "A missing dependency is an error instead of a wrong number."

**Action:** audit `server/pipeline/` — does each stage/step declare an **input whitelist** and fail closed on undeclared reads (`PIPELINE_STAGES`, `TickStage`)? If not, add it. Cheap, high-trust, matches the existing "no silent wrong number" instinct (D4 / falsifier discipline). <!-- cite-exempt: historical — the v1 pipeline, deleted in v1 teardown wave 3 (#1748); preserved at tag v1-final -->

## Mechanism 3 — report semantics

Already-practiced in substance (doc 53 cost calibration; D4 risk-adjusted vs control; PBO discipline). Confirm + formalize: any backtest output surfaces **turnover** and **per-strategy OOS** explicitly, with net-as-headline. Validation, not a build.

## Do-not-adapt (explicit)

- Qanat engine / DAG / DuckDB daily-rebalance scheduler → ADR-0014 horizon + ADR-0001 language.
- MCP single-agent step-writer as edge source → inverts debate-as-edge into agent-as-author.
- Shelf alphas (momentum/reversal/low_vol) as edges → monthly-signal shape + "no benchmark"; does not touch the doc-61 intraday momentum prior (Mesfin 0/14 stands).

## Source verification

- Page fetched via curl (HTTP 200, 31 KB real body), repo metadata via GitHub API (200), README via API (200, full). Repo created 2026-09-05, pushed 2026-09-14, MIT, Python. Numbers quoted are from the shipped README's own backtest output, not this assessment's runs.
- Not independently reproduced here (would need `qanat` install + a run). Treat Qanat's demo numbers as mechanism-proof, not an edge claim.