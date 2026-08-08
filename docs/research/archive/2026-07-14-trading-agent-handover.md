# Trading Agent — Handover Brief

**Owner:** Deepak (Lead Web Developer, React/TypeScript)
**Status:** Scoping complete, no code written yet
**Goal:** Build a live-money trading agent covering both crypto and stocks

---

## Decisions Made

| Question | Answer |
|---|---|
| Primary goal | Live trading with real money |
| Markets | Both crypto AND stocks |
| Hosting | MacBook (always-on, doesn't sleep) — **not** a VPS |
| Success criteria | Working demo + runs unattended + measurable performance |

## Key Constraints & Risks Flagged

- **Crypto is the only truly 24/7 market.** Stocks trade during market hours only (LSE 8am–4:30pm, NYSE 2:30pm–9pm UK time). The agent process should run continuously, but stock strategies need a market-hours scheduler so they don't fire into a closed market.
- **MacBook-as-server risk accepted by owner.** Flagged risks: macOS auto-updates causing reboots, power cuts, Wi-Fi drops, accidental lid-close during an open position. Mitigations recommended if proceeding: UPS, wired ethernet, disable auto-updates, heartbeat/dead-man's-switch alerting (e.g. Telegram bot) so silence itself triggers an alert.
- **Real money = graduation pipeline required:** backtest → paper trading → tiny live capital. Bugs, not bad strategies, are the primary cause of account drain.
- **Not financial advice.** Strategy profitability is the owner's responsibility to prove; treat first live allocation as "tuition money."
- **UK tax:** crypto disposals and stock trades are both CGT events (stocks also incur stamp duty on buys); every trade needs records for HMRC.

## Required Architecture

**Brokers/exchanges**
- Crypto: Kraken or Coinbase Advanced, via `ccxt` (unified API library)
- Stocks: Interactive Brokers (IBKR) — only serious UK-accessible option with API access, via TWS API or Client Portal REST
- Needs a **broker abstraction layer** so strategy code doesn't care which exchange/broker it's hitting

**Core components**
- Market data feed (WebSocket for crypto, IBKR streaming for stocks) with auto-reconnect
- Strategy/decision engine — isolated module, swappable/backtestable
- Risk manager — position size caps, max daily drawdown circuit breaker, manual kill switch
- Execution layer — idempotent order IDs, partial-fill and rate-limit handling
- Persistent state (SQLite/Postgres) so crash-restart doesn't lose open positions
- Logging for every signal and fill; track PnL, max drawdown, win rate vs buy-and-hold baseline

**Security**
- API keys: trade-only permissions, **withdrawals disabled**, IP-whitelisted

## Recommended Build Order

1. Scaffold TypeScript project with broker abstraction layer
2. Build risk manager first (before any strategy logic)
3. Wire up Kraken in **paper-trading mode** (crypto first — simpler API, faster feedback loop, no market-hours complexity)
4. Prove architecture end-to-end in paper mode
5. Bolt on IBKR for stocks once crypto path is validated
6. Only then consider small live capital allocation

## Open / Next Steps

- Not yet started: project scaffolding
- Awaiting decision: which crypto exchange (Kraken vs Coinbase) and confirmation to proceed with scaffold
- Default output path for generated code: `/Users/ddjp/Documents/Claude/Coworkspace`
