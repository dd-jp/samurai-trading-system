# Tech Stack

The v2 stack as it stands on `main`. Rulings live in [doc 66](research/66-v2-grill-decisions.md) (design pass D1–D8) and the [ADR](adr/0001-samurai-v2.md); this register records what the tree actually uses. v1's stack (the Alpaca-only MVP and the orchestrator tick loop, plus the planned ccxt, IBKR and pybroker integrations that never shipped) is gone with the v1 teardown (#1748); v1's register is preserved at tag `v1-final`.

---

## Runtime and language

| Layer | Choice | Where |
|-------|--------|-------|
| Everything that trades | TypeScript on Node 24+ (`engines` in `package.json`), run with `tsx` | `server/` |
| Shared types | `contracts/`: the client/server wire model plus the server's internal module interfaces (D4); imports nothing from `server/` or `client/` | `contracts/v2.ts`, `contracts/v2-wire.ts`, `contracts/v2-signals.ts` |
| Structure | One-process modular monolith with typed module boundaries: data, signal, risk, execution, journal (D4), enforced by oxlint `no-restricted-imports` overrides and proven by a boundaries test; `fallow:boundaries` separately keeps `client/` and `server/` importing each other only through `contracts/` | `server/apps/v2/` (`data/`, `signal/`, `risk/`, `execution/`, `journal/`), `.oxlintrc.json`, `server/apps/v2/boundaries.test.ts`, `.fallowrc.json` |
| Composition root | `npm run v2:run`; backtest, paper and live share the code and differ in venue and clock adapters | `server/apps/v2/index.ts`, `server/apps/v2/compose.ts` |
| Research sidecar | Optional offline Python via parquet/ONNX/strategy-spec files, with a TS parity test (G3). No agent framework (no LangGraph, CrewAI or LangSmith) | doc 66 |

## Venues and market data

| Component | Choice | Where |
|-----------|--------|-------|
| US large caps (and US ETFs if UK access is confirmed) | Alpaca live account, trading USD; paper first | `server/apps/v2/execution/alpaca.ts`, `server/apps/v2/execution/alpaca/` |
| LSE 1× ETFs/ETCs, and CFDs (debate sleeve only) | Saxo Capital Markets UK GIA over OpenAPI; SIM gateway for paper; token refresh via `saxo:login` and `saxo:keepalive` | `server/apps/v2/execution/saxo/`, `server/apps/v2/execution/saxo-sim-gateway.ts` |
| Risk gate | Venue adapters accept only a `RiskApprovedOrder`, which only the risk module constructs (D6) | `contracts/v2.ts`, `server/apps/v2/risk/` |
| US daily bars | Alpaca bars API | `server/providers/bar-store/alpaca-bars-api.ts` |
| LSE daily bars | Saxo `chart/v3` puller | `server/providers/saxo-bars/` |
| FX | Bank of England daily rates | `server/apps/v2/fx-refresh.ts` |
| News | Marketaux | `server/apps/v2/data/marketaux-client.ts` |

## LLM

| Component | Choice | Where |
|-----------|--------|-------|
| Gateway | Nous, OpenAI-compatible chat completions | `server/shared/llm/`, `server/apps/v2/signal/llm-transport.ts` |
| Debate panel | Sonnet, GPT and DeepSeek debaters with an Opus judge; versions pinned, a swap is a new trial | `server/apps/v2/signal/models.ts`, `server/apps/v2/signal/llm-panel.ts` |
| Spend cap | $30/month across providers, read from `llm_spend`; a breach stops LLM calls, never exits | `server/apps/v2/signal/monthly-spend-cap.ts` |
| Secret guard | Refuses any LLM request carrying a known secret value (#1881) | `server/apps/v2/signal/secret-guard.ts` |

## State and persistence

| Component | Choice | Where |
|-----------|--------|-------|
| Live state (orders, positions, loss budget, journal, LLM spend) | SQLite via `better-sqlite3`, numbered SQL migrations (D2) | `server/shared/store/`, `server/apps/v2/journal/` |
| Bars and analytics | Parquet partitioned by venue, symbol and year, read through DuckDB (`@duckdb/node-api`, exact pin) (D2). DuckDB runs single-threaded so a rewrite of the same bars is byte-identical. The bar store under `data/bars/parquet/` is gitignored and rebuilt by a re-pull (#1929) <!-- cite-exempt: untracked — local bar store, gitignored since #1929 --> | `server/providers/bar-store/parquet-bar-store.ts` |
| Backup | Litestream continuous replication of the SQLite store (D1), `v2:backup` and `v2:restore` | `server/apps/v2/backup.ts`, `server/apps/v2/backup-cli.ts` |
| Capital and loss cap | One yearly config value David sets, journalled, never derived; no capital literal in code (D8) | `server/apps/v2/risk/capital-config.ts`, `server/apps/v2/set-capital.ts` |

## Host, monitoring and alerting

| Component | Choice | Where |
|-----------|--------|-------|
| Host | Always-on MacBook; a move to a VPS is decided at the live gate (D1) | doc 66 |
| Dead-man's switch | healthchecks.io ping (D1, D5) | `server/apps/v2/heartbeat.ts` |
| Alerts and approvals | Telegram bot over the Bot API, alerts by severity (D5) | `server/apps/v2/alerts.ts`, `server/apps/v2/api/telegram-bot.ts` |
| Dashboard | Vite + React client, served by a loopback-default HTTP server with bearer-token auth (`SAMURAI_DASHBOARD_TOKEN`); no Grafana (D5) | `client/`, `server/apps/v2/api/main.ts`, `server/apps/v2/api/server.ts`, `server/apps/v2/api/auth.ts`, `docs/specs/dashboard-spec.md` |
| Signals endpoint | Loopback-only HTTP intake for external US-long signals (#1941) | `server/apps/v2/signals/server.ts`, `docs/specs/signals-sleeve-spec.md` |

## Testing and static analysis

| Tool | Use |
|------|-----|
| Vitest, with `@vitest/coverage-v8`, jsdom and Testing Library | Unit tests, server and client |
| Playwright | Dashboard e2e (`e2e/`) |
| fast-check | Property tests on GBP money math, the loss-budget steps and sizing bounds (`server/apps/v2/money.property.test.ts`, `server/apps/v2/risk/budget-sizing.property.test.ts`) |
| Stryker | Mutation testing on risk, sizing and loss-budget code (`mutation:local`, and CI when those files change) |
| CRAP gate | `npm run crap`: threshold 7 on touched functions, `server/apps/v2/` and `contracts/` in full, 15 repo-wide (`server/tools/crap-gate.ts`, #1649) |
| oxlint and Biome | Lint and format (`npm run lint`); `eslint-plugin-no-comment-slop` runs under oxlint (`.oxlintrc.json`) |
| fallow | Dead code, unused dependencies, duplication and module boundaries (`fallow:*` scripts); replaced knip |
| Citation check | `npm run check:citations` (`server/tools/check-path-citations.ts`) |
| Smoke | `npm run smoke`: the built v2 root end to end (`server/apps/v2/smoke.ts`) |

CI runs the full set on GitHub Actions (`.github/workflows/ci.yml`).

## Runtime dependencies

`@duckdb/node-api`, `better-sqlite3`, `react`, `react-dom`, and four `@fontsource/*` faces for the dashboard. Everything else is a dev dependency. `package.json` is the source of truth, and every version in it is pinned exactly.
