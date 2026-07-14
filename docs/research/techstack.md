# Tech Stack

Locked-in choices, versions, and rationale. Update as stack crystallizes.

---

## Runtime / Language

| Layer | Choice | Why |
|-------|--------|-----|
| Primary | TypeScript | Owner's main language (React/TS). Ecosystem for websockets, ccxt, IBKR wrappers all mature. |
| Alternative considered | Python | Strong quant ecosystem (pandas, numpy, TA-lib), but owner's stack is TS. Would force language switch for a solo project. |
| Alternative considered | Rust/Go | Performance gain marginal vs complexity cost for 50-100 trades/day. Not justified here. |

## Market Data

| Component | Choice | Why |
|-----------|--------|-----|
| MVP source | Alpaca (historical bars + streaming quotes) | ADR-0001: first end-to-end path, covers the default universe (SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD) in one account. |
| Crypto feed (long-term) | ccxt + WebSocket | Unified API across exchanges. Swap from Kraken to Coinbase = config change, not code rewrite. |
| Stock feed (long-term) | IBKR TWS streaming | Only UK-accessible broker with API + streaming. |
| Scheduling | Orchestrator tick loop (fixed interval crypto; market-hours-gated stocks) | See orchestrator-spec.md — resolved, not TBD. |

## Brokers / Execution

| Layer | Choice | Why |
|-------|--------|-----|
| MVP | Alpaca (paper first) | ADR-0001: simplest paper setup, native bracket/OCO support, proves the architecture end-to-end before bolting on ccxt/IBKR. |
| Crypto (long-term) | Kraken or Coinbase Advanced via ccxt | Simpler API, 24/7, fastest feedback loop once the architecture is proven. |
| Stocks (long-term) | Interactive Brokers (IBKR); Freetrade/Trading212 for live equities later | Only serious UK-accessible broker with API access. |
| Abstraction | Mandatory, dual-target from day one | `BrokerAdapter` = Alpaca + ccxt + IBKR + Simulated, one interface (execution-spec.md). Strategy code must not know which broker it's hitting. |

## State / Persistence

| Component | Choice | Why |
|-----------|--------|-----|
| Open positions / trade log | SQLite (initial) → Postgres (scale) | Crash safety, query flexibility. SQLite gets us to V1. Postgres when concurrent agents need ACID at scale. |
| Config / params | YAML or JSON | Human-editable, git-trackable. |

## Messaging / Alerting

| Component | Choice | Why |
|-----------|--------|-----|
| Dead-man's switch | Telegram bot | Owner's primary messaging channel. Silence itself = alert. |
| Trade notifications | Telegram bot | Same channel, same reason. |

## Testing / Validation

| Tool | Why |
|------|-----|
| pybroker (mined, no hard dependency) | ADR-0001: backtest/eval executor — walkforward-split + eval-metric patterns mined, not depended on. Cannot host live LLM debate (sync per-bar `exec_fn`), so it never runs the live tick loop. |
| Walk-forward analysis | Defends against overfitting |
| Combinatorial Purged Cross-Validation (CPCV) | Distribution of out-of-sample Sharpe |
| Deflated Sharpe Ratio (DSR) | Correct for trial count |
| PBO threshold (0.05) | Kill criterion for suspect strategies |
| MinBTL check | Cap independent trials by data length |
| Custom cost model (ours, not pybroker's) | pybroker's built-in fill model isn't pessimistic enough for the √-law market-impact requirement; injected into pybroker's eval path instead. |

## CLI (operator view)

| Component | Choice | Why |
|-----------|--------|-----|
| Rendering | Simple structured tables (no full TUI framework) | Lower build cost; output stays pipeable/grep-able. Library TBD at implementation time (e.g. a lightweight TS table/prompt package) — not load-bearing enough to lock now. |
| Read path | Direct SQLite queries via `QueryStore` | No new message bus; CLI is a pure read-only consumer of the shared store (cli-spec.md). |

---

## Resolved (previously "Open Decisions")

- **TypeScript subagent framework: custom, not LangChain.js/LangGraph.** ADR-0001: reuse posture is "mine the Python repos for patterns, no hard dependency" — ruled out a cross-language framework dependency. The adversarial bull/bear/moderator pattern is reimplemented as a TS state machine / lightweight agent-loop.
- **Debate engine protocol: structured JSON rounds.** debate-engine-spec.md — `DebateResult`/`DebateLog` are typed structures (direction, conviction, per-analyst contributions), not free-form LLM output.
- **Feedback loop: bounded parameter/weight adaptation, not model retraining.** feedback-loop-spec.md — daily batch, capped step changes, asymmetric guardrails. No online learning, no retraining.

## Open Decisions (implementation-detail, do not block `/to-tickets`)

- [ ] Analyst persona registry (static config vs dynamic LLM-generated)
- [ ] Monitoring / observability stack beyond structured logs + Telegram (Grafana/Prometheus, or logs+Telegram is sufficient for v1?)
- [ ] Multi-strategy support: shared broker abstraction per-strategy, or unified? (post-MVP question)
- [ ] Terminal UI library for the CLI (see CLI row above)
