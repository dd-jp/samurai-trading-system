# Market Intelligence Specification

**Status:** Draft (resolved wayfinder tickets synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

## Problem Statement

Samurai's trading decisions require comprehensive market context beyond raw price — news, social sentiment, and fundamental signals. Without a unified intelligence layer that aggregates and validates multiple sources, individual analysts operate on incomplete or conflicting information, leading to poor trading decisions.

The Market Intelligence layer exists to provide real-time, validated market context through specialized agents. It aggregates data from professional news sources and social media, resolves conflicts with clear priority rules, and delivers structured intelligence to downstream analysts. It deliberately does **not** cover price/OHLCV or technical indicators — that is a separate Stage 0 concern (the Market Data Service; see Out of Scope). Market Intelligence is the news/sentiment half of Stage 0.

## Solution

The Market Intelligence layer runs two specialized agents that operate continuously:

**DeepResearch Agent** — Professional news aggregation (Bloomberg, Reuters, SEC filings, earnings reports). High credibility, regulatory compliance, fact-checked sources. Primary source for decision-making.

**Grok Agent** — Social media sentiment analysis (Twitter/X, Reddit). Real-time retail sentiment, viral narratives, market psychology. Secondary source that supplements but never overrides professional news.

**Conflict Resolution Rule:** When DeepResearch and Grok report conflicting signals, DeepResearch wins. Professional sources have priority on high-impact events. Social sentiment is supplementary context.

**Key architectural decisions:**
- **Dual-agent specialization** — each agent has domain expertise and data sources optimized for its purpose
- **Clear source priority** — professional news > social sentiment for conflicting signals
- **Real-time continuous operation** — agents run in background, not on-demand
- **Structured data output** — all intelligence is normalized to consistent schemas before delivery to analysts
- **Asset-class awareness** — different cadence and retention for crypto (24/7) vs stocks (market hours)
- **No persistence of raw data** — only structured intelligence is stored; raw feeds are ephemeral
- **Graceful degradation** — if one agent fails, the other continues operating; system doesn't block

## User Stories

### Agent Operation

1. As the Market Intelligence system, I want the DeepResearch agent to continuously monitor professional news sources, so that I have validated, high-credibility market context
2. As the Market Intelligence system, I want the Grok agent to continuously monitor social media sentiment, so that I have real-time retail sentiment and viral narratives
3. As the Market Intelligence system, I want both agents to run in parallel without blocking each other, so that one agent's delays don't impact the other
4. As the Market Intelligence system, I want to detect when agents have conflicting signals and apply priority rules automatically, so that downstream analysts receive consistent intelligence
5. As the Market Intelligence system, I want agents to handle source failures gracefully (retry, fallback, degrade), so that temporary outages don't crash the pipeline

### Data Ingestion

6. As the Market Intelligence system, I want to ingest news from multiple sources (Bloomberg, Reuters, SEC, earnings), so that I have comprehensive professional coverage
7. As the Market Intelligence system, I want to ingest social data from Twitter/X and Reddit, so that I capture retail sentiment and viral narratives
8. As the Market Intelligence system, I want to normalize all sources to a consistent timestamp format (UTC), so that cross-source correlation works correctly
9. As the Market Intelligence system, I want to tag data with asset class (crypto/stocks), so that downstream systems can filter appropriately
10. As the Market Intelligence system, I want to extract structured entities (tickers, companies, events), so that analysts can query by asset

### Conflict Resolution

11. As the Market Intelligence system, I want to detect when DeepResearch and Grok report conflicting signals on the same event, so that I can apply priority rules
12. As the Market Intelligence system, I want DeepResearch to take priority on conflicting signals, so that professional sources guide decisions
13. As the Market Intelligence system, I want to log all conflict resolutions for transparency, so that I can audit decisions and tune priority rules
14. As the Market Intelligence system, I want to pass both signals (with resolved winner) when conflicts occur, so that analysts can see the full context

### Data Delivery

15. As the Market Intelligence system, I want to deliver structured intelligence to analysts via a consistent contract, so that analysts don't need to know implementation details
16. As the Market Intelligence system, I want to support both pull (on-demand) and push (subscription) delivery patterns, so that analysts can choose based on their workflow
17. As the Market Intelligence system, I want to support time-window queries (e.g., "last 1h of crypto news"), so that analysts can get relevant context for their analysis
18. As the Market Intelligence system, I want to handle analyst failures without blocking, so that one analyst's crash doesn't stop others

### Performance & Reliability

19. As the Market Intelligence system, I want to operate within latency budgets (5s crypto, 30s stocks), so that intelligence is timely enough for trading decisions
20. As the Market Intelligence system, I want to respect rate limits and back off gracefully, so that I don't get blocked by data sources
21. As the Market Intelligence system, I want to continue operating if one agent fails, so that partial intelligence is better than no intelligence
22. As the Market Intelligence system, I want to run without state persistence, so that I can restart cleanly after crashes

### Testing & Quality

23. As the Market Intelligence system, I want to validate agent outputs (schema, required fields, value ranges), so that downstream analysts receive well-formed intelligence
24. As the Market Intelligence system, I want to track source failures and success rates, so that I can monitor system health
25. As the Market Intelligence system, I want my agents to read time from an injected clock, so that a separate backtesting replay service can drive them with historical feeds through the same live code path — without this layer owning historical storage (the store is a separate concern; see Out of Scope)

## Implementation Decisions

### Module: Market Intelligence Core

**Responsibilities**
- Orchestrate DeepResearch and Grok agents (start, stop, monitor)
- Deliver structured intelligence to analysts (pull/push interfaces)
- Apply conflict resolution rules when agents disagree
- Handle analyst delivery failures
- Track system health and metrics

**Key Interfaces**

```typescript
// Upstream contract (what agents produce)
interface AgentIntelligence {
  agent_id: 'deepresearch' | 'grok';
  timestamp: Date;
  asset_class: 'crypto' | 'stocks';
  items: IntelligenceItem[];
}

interface IntelligenceItem {
  id: string;                    // unique (agent_id + source + timestamp + entity)
  source: string;                // 'bloomberg', 'reuters', 'twitter', etc.
  type: 'news' | 'sentiment';
  timestamp: Date;
  entity: string;                // ticker, company name, event
  headline: string;              // brief summary
  sentiment: 1 | 0 | -1;         // bullish | neutral | bearish
  confidence: number;            // 0.0 - 1.0
  summary?: string;              // longer description (optional)
  url?: string;                  // source link (optional)
}

// Downstream contract (what analysts consume)
interface MarketContext {
  timestamp: Date;
  asset_class: 'crypto' | 'stocks';
  news: IntelligenceItem[];      // professional news (DeepResearch)
  social: IntelligenceItem[];    // social sentiment (Grok)
  conflicts: ConflictResolution[]; // where agents disagreed
}

interface ConflictResolution {
  entity: string;
  deepresearch_signal: { sentiment: 1 | 0 | -1; confidence: number };
  grok_signal: { sentiment: 1 | 0 | -1; confidence: number };
  resolved_winner: 'deepresearch' | 'grok';
  reason: string;               // 'high_impact_news', 'regulatory_event', etc.
}
```

**Agent Orchestration**

- Each agent runs as an independent background process
- Agents are started at system boot and run continuously
- If an agent crashes, it's restarted automatically (retry with exponential backoff)
- If an agent fails repeatedly (e.g., 3 consecutive failures), it's disabled and an alert is raised
- The core system continues operating with whichever agents are healthy

**Conflict Resolution**

- Detect conflicts by comparing `entity` + `timestamp` (within 5min window) across agents
- Apply priority rules:
  - **High-impact events** (regulatory, earnings, major news): DeepResearch always wins
  - **General market sentiment**: DeepResearch wins if confidence > 0.7, otherwise Grok wins
  - **Viral social narratives** (rapid sentiment shift on social media): Grok wins if shift is > 2 standard deviations from baseline
- When conflict detected, log resolution with reason for auditability
- Pass both signals to analysts (with resolved winner marked) so they see full context

**Delivery Patterns**

- **Pull mode**: Analyst calls `marketIntelligence.getContext(assetClass, timeWindow, trace_id)` and receives current MarketContext (`trace_id` is the cross-cutting correlation ID threaded from the Orchestrator's tick — not business data — so MI's own log lines can be joined back to the calling tick)
- **Push mode**: Analyst subscribes to `marketIntelligence.subscribe(assetClass, callback)` and receives MarketContext updates when new intelligence arrives (throttled to max 1 update per minute to avoid flooding); push updates are not scoped to a single tick's trace_id since they fire asynchronously outside any one tick's call

**Health Tracking**

- Track per-agent metrics: messages_processed, errors, latency_p50, latency_p99
- Track per-source metrics: messages_processed, errors, latency
- Expose metrics via `/metrics` endpoint for monitoring
- Alert on: agent down, error_rate > 5%, latency_p99 > budget

### Module: DeepResearch Agent

**Responsibilities**
- Continuously ingest professional news (Bloomberg, Reuters, SEC filings, earnings reports)
- Parse and structure news items (extract entities, sentiment, confidence)
- Detect high-impact events and flag them
- Handle source failures (retry, fallback to cached data)

**Key Operations**

**Data Sources**
- **Bloomberg**: Real-time news feed (API access required, paid tier)
- **Reuters**: Professional news feed (API access, paid tier)
- **SEC EDGAR**: Regulatory filings (free, public API)
- **Earnings reports**: Extracted from SEC filings + earnings call transcripts (paid data provider)

**Ingestion Cadence**
- Crypto: Every 5 seconds (markets are 24/7)
- Stocks: Every 30 seconds during market hours (9:30 AM - 4:00 PM ET), every 5 minutes outside market hours
- SEC filings: Every 1 minute (low volume, high importance)
- Earnings reports: Real-time when available (during earnings season)

**Processing**
- Fetch raw data from sources
- Parse into IntelligenceItem format (extract entities, sentiment, confidence)
- Tag with `type: 'news'` and `agent_id: 'deepresearch'`
- Detect high-impact events (regulatory actions, major earnings surprises, Fed announcements)
- Emit AgentIntelligence to core

**Failure Handling**
- Retry failed source requests with exponential backoff (1s, 2s, 4s, max 30s)
- If source is down for > 5 minutes, fall back to cached data (last known good state)
- If all sources fail, emit empty intelligence (don't block the pipeline)
- Log all failures for monitoring

### Module: Grok Agent

**Responsibilities**
- Continuously ingest social media data (Twitter/X, Reddit)
- Analyze sentiment and detect viral narratives
- Handle API rate limits gracefully
- Detect rapid sentiment shifts that warrant high-priority flagging

**Key Operations**

**Data Sources**
- **Twitter/X**: Real-time stream of market-related tweets (API access, rate-limited)
- **Reddit**: Posts from r/wallstreetbets, r/cryptocurrency, r/stocks (scraping or API)
- **Telegram**: Crypto group chats (if accessible)
- **Discord**: Trading community channels (if accessible)

**Ingestion Cadence**
- All sources: Every 10 seconds (respect API rate limits)
- Twitter/X: Respect rate limit (typically 300 requests per 15 minutes)
- Reddit: Every 30 seconds (lower rate to avoid blocking)

**Processing**
- Fetch raw data from sources
- Apply sentiment analysis (Grok model or similar)
- Extract entities (tickers, companies, events)
- Detect viral narratives (rapid mention count increase in short time window)
- Detect sentiment shifts (mean ± 2σ from 1h rolling baseline)
- Tag with `type: 'sentiment'` and `agent_id: 'grok'`
- Emit AgentIntelligence to core

**Failure Handling**
- Respect API rate limits (back off when receiving 429 responses)
- If source is blocked or rate-limited for > 5 minutes, fall back to cached sentiment
- If all sources fail, emit empty intelligence (don't block the pipeline)
- Log all failures for monitoring

### Module: Conflict Resolution Engine

**Responsibilities**
- Detect conflicts between DeepResearch and Grok signals
- Apply priority rules to resolve conflicts
- Log all resolutions with reasons for auditability
- Return resolved intelligence with both signals (winner marked)

**Key Operations**

**Conflict Detection**
- Group IntelligenceItems by `entity` + `timestamp` (within 5min window)
- If DeepResearch and Grok both have items for same entity/time with different sentiment → conflict detected
- Trigger resolution logic

**Priority Rules**

```typescript
function resolveConflict(
  deepresearch: IntelligenceItem,
  grok: IntelligenceItem
): ConflictResolution {
  const reason = determineConflictReason(deepresearch, grok);
  
  switch (reason) {
    case 'high_impact_news':
      // Regulatory, earnings, Fed → DeepResearch always wins
      return {
        entity: deepresearch.entity,
        deepresearch_signal: { sentiment: deepresearch.sentiment, confidence: deepresearch.confidence },
        grok_signal: { sentiment: grok.sentiment, confidence: grok.confidence },
        resolved_winner: 'deepresearch',
        reason: 'high_impact_news',
      };
    
    case 'general_sentiment':
      // DeepResearch wins if confidence > 0.7, otherwise Grok wins
      if (deepresearch.confidence > 0.7) {
        return { /* deepresearch wins */ };
      } else {
        return { /* grok wins */ };
      }
    
    case 'viral_social_narrative':
      // Grok wins if sentiment shift > 2σ from baseline
      // (Need to track 1h rolling baseline for sentiment)
      // For now, implement as: if grok.confidence > 0.8 and sentiment shift detected → grok wins
      return { /* grok wins */ };
    
    default:
      // Fallback: DeepResearch wins
      return { /* deepresearch wins */ };
  }
}
```

**Auditability**
- Log every conflict resolution to `/conflicts` endpoint (or log file)
- Include: entity, timestamp, Both signals, winner, reason
- This enables tuning priority rules based on historical outcomes

### Module: Data Delivery

**Responsibilities**
- Provide pull interface (on-demand queries)
- Provide push interface (subscription-based updates)
- Handle analyst delivery failures
- Throttle updates to avoid flooding

**Key Operations**

**Pull Interface**
- Analyst calls: `marketIntelligence.getContext(assetClass: 'crypto' | 'stocks', timeWindow: Duration, trace_id: string)`
- `trace_id`: cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data; not part of the query key, used only so MI's own log lines can be correlated back to the calling tick
- Returns: MarketContext with all intelligence from `now - timeWindow` to `now`
- Internally: query in-memory store (no database persistence)
- Latency target: < 10ms (in-memory query)

**Push Interface**
- Analyst calls: `marketIntelligence.subscribe(assetClass: 'crypto' | 'stocks', callback: (ctx: MarketContext) => void)`
- System stores callback and invokes when new intelligence arrives
- Throttle: max 1 update per minute per subscriber (to avoid flooding during high-activity periods)
- If callback throws, remove subscription and log error (don't block other subscribers)

**Delivery Failures**
- If analyst is slow to process (callback takes > 5s), log warning but don't block
- If analyst callback fails repeatedly (3 times), remove subscription and alert
- Core system continues operating regardless of analyst delivery failures

### Module: Health & Metrics

**Responsibilities**
- Track per-agent and per-source metrics
- Expose metrics for monitoring
- Alert on failure conditions

**Key Metrics**

```
agent_messages_processed_total{agent_id, source}
agent_errors_total{agent_id, source, error_type}
agent_latency_seconds{agent_id, source, quantile="0.5|0.99"}
conflict_resolutions_total{reason}
analyst_subscriptions_active{asset_class}
delivery_errors_total{analyst_id}
```

**Alerts**
- Agent down: `agent_messages_processed_total` rate drops to 0 for > 5 minutes
- High error rate: `agent_errors_total` / `agent_messages_processed_total` > 0.05
- Latency breach: `agent_latency_seconds{quantile="0.99"}` > budget (5s crypto, 30s stocks)
- Analyst delivery failure: `delivery_errors_total` > 0 for any analyst

### Implementation Constraint: No Persistence

**Decision: No state persistence — restart cleanly after crashes.**

The Market Intelligence layer does not persist state (no database, no checkpoint files). On crash:
- Restart all agents
- Re-ingest from current time forward
- Accept that recent intelligence is lost

**Rationale**
- Intelligence is time-sensitive (news from 10 minutes ago is stale)
- Re-ingestion is fast (agents resume from source APIs)
- Persistence adds complexity (state management, consistency, backup)
- The trade-off: losing recent intelligence is acceptable; system complexity is not

**Caveat**
- If backtesting requires replaying historical data, implement a separate replay service that stores historical feeds in a database (out of scope for this spec)
- The live system operates without persistence; replay is a separate concern

## Testing Decisions

### What Makes a Good Test

- Test external behavior (input → output), not implementation details
- Mock LLM calls (sentiment analysis) — focus on orchestration logic
- Test agent failures and recovery (ensure system doesn't block)
- Test conflict resolution rules (verify priority logic is correct)
- Test delivery patterns (pull returns correct data, push delivers updates)
- Test latency budgets (system responds within expected time)

### Modules to Test

**Market Intelligence Core**
- Agent orchestration (agents start/stop correctly, failures are handled)
- Conflict resolution (DeepResearch wins on high-impact, Grok wins on viral narratives, etc.)
- Delivery (pull returns correct data, push delivers updates, throttling works)
- Health tracking (metrics are recorded correctly, alerts fire on failures)

**DeepResearch Agent**
- Data ingestion (fetches from sources, parses into IntelligenceItem format)
- Failure handling (retries, fallbacks, degradation when sources fail)
- Entity extraction (correctly identifies tickers, companies, events)
- High-impact detection (flags regulatory actions, earnings surprises)

**Grok Agent**
- Data ingestion (fetches from social sources, parses into IntelligenceItem format)
- Sentiment analysis (correctly classifies bullish/neutral/bearish)
- Viral narrative detection (detects rapid mention count increases)
- Rate limit handling (backs off when receiving 429 responses)

**Conflict Resolution Engine**
- Conflict detection (identifies when agents disagree on entity/timestamp)
- Priority rules (DeepResearch wins on high-impact, Grok wins on viral narratives)
- Audit logging (records all resolutions with reasons)

**Data Delivery**
- Pull interface (returns correct data for time window, handles missing data)
- Push interface (delivers updates when new intelligence arrives, throttles correctly)
- Failure handling (removes subscriptions on repeated failures, doesn't block other subscribers)

### Prior Art

- Existing test infrastructure (none yet — this is pre-implementation)
- LLM mock patterns: use deterministic responses for sentiment analysis testing, randomize for integration testing
- Time-based testing: use mock clock to simulate time windows without real delays
- Agent mock patterns: simulate agent failures by injecting errors at controlled intervals

## Out of Scope

**Analyst Stage Design**

This spec covers the Market Intelligence layer, not the upstream Analyst stage. Analyst design (how many analysts, what types, how they process intelligence) is out of scope. Market Intelligence defines what it delivers (downstream contract) but not how analysts consume it.

**Debate Engine Coordination**

The Debate Engine stage consumes analyst outputs and runs structured debates. How the Debate Engine coordinates with Market Intelligence is out of scope. Market Intelligence delivers intelligence to analysts; what happens after is not this layer's concern.

**Backtesting Data Service**

This spec covers live intelligence delivery. Backtesting requires replaying historical market data through agents. A separate backtesting service (with historical data storage and replay logic) is out of scope for this spec.

**Price & Market Data**

This spec covers news and social sentiment only (`IntelligenceItem.type` is `'news' | 'sentiment'`). Price/OHLCV data and technical indicators (moving averages, RSI, etc.) are **not** provided by Market Intelligence. They are owned by a separate Stage 0-level component, the **Market Data Service**, which runs parallel to this layer and needs its own wayfinder map. Analysts read price/indicators from the Market Data Service and news/sentiment from Market Intelligence.

**Data Source Management**

This spec assumes data sources are configured externally (API keys, endpoints, rate limits). How to manage source credentials, rotate keys, or negotiate API access is out of scope.

**Sentiment Model Training**

This spec assumes sentiment analysis is provided by external models (Grok or similar). Training or fine-tuning sentiment models is out of scope. If custom sentiment models are needed, that's a separate effort.

**Persistence for Backtesting**

This spec deliberately excludes persistence (live system restarts cleanly after crashes). If backtesting requires historical data storage, that's a separate service with its own storage strategy.

## Further Notes

### Integration with Pipeline

The Market Intelligence layer sits at the edge of the pipeline, feeding intelligence to analysts:

```
Market Intelligence → Analysts → Debate Engine → Trader → Risk Manager → Verdict → Execution
(this spec)
```

Market Intelligence operates at Stage 0 (data collection), feeding into Stage 1 (analyst analysis).

### Domain Glossary Alignment

Per CONTEXT.md:
- **Market Intelligence**: "The news/sentiment half of the Stage 0 data layer. Runs specialized agents (professional news + social sentiment), resolves cross-source conflicts by priority, and delivers structured intelligence to analysts. Does not cover price/OHLCV — that is the Market Data Service."
- **Market Data Service**: "A dedicated Stage 0-level data layer, parallel to Market Intelligence, that serves price OHLCV plus precomputed technical indicators to analysts."
- **Analyst**: "An agent persona that examines market data through a specific lens (technical, fundamental, sentiment, etc.)."
- **Debate Engine**: "Mediates between conflicting analyst views before the Trader consolidates."

Market Intelligence is foundational — it provides the news/sentiment data that analysts reason about, alongside price/indicators from the Market Data Service. Without quality intelligence, analysts operate on incomplete or conflicting information.

### Latency Budget Trade-offs

The 5s/30s budgets are initial estimates based on:
- Crypto: 5s total (1s per agent + processing)
- Stocks: 30s total (10s per agent + processing)

These may need tuning in Stage 1 based on:
- Number of data sources
- API response times in practice
- Processing latency for entity extraction and sentiment analysis
- Cost constraints (more frequent polling = more API spend)

### Agent Cost Optimization

Both agents run continuously, which means ongoing API costs (data source fees, LLM inference). If costs become prohibitive:
- Reduce polling frequency (e.g., crypto from 5s to 30s)
- Use cheaper sentiment models (rule-based instead of LLM)
- Batch process (accumulate data in 1-min windows, process in bulk)

### Conflict Resolution Tuning

The priority rules (DeepResearch wins on high-impact, Grok wins on viral narratives) are initial estimates. In practice:
- May need to tune confidence thresholds (currently 0.7 for DeepResearch general sentiment)
- May need to define "high-impact" more precisely (regulatory actions, earnings surprises, Fed announcements)
- May need to track viral narrative baselines (1h rolling mean for mention count)

Log all conflicts and resolutions. Review weekly to see if priority rules need adjustment.

### Data Source Availability

Some data sources may not be available at launch:
- Bloomberg/Reuters APIs require paid subscriptions
- Twitter/X API has rate limits and may require enterprise tier
- Telegram/Discord may not be accessible (private groups)

**Fallback plan**: Start with sources that are available (SEC EDGAR is free, Reddit scraping is possible, Twitter/X basic tier may work). Add paid sources as budget allows.

### Future Extensions

Potential enhancements (not in this spec):
- **Additional agents**: Add specialized agents for options flow, insider trading, macro indicators
- **Entity linking**: Link entities across sources (e.g., "Tesla" in news = "TSLA" in social)
- **Sentiment aggregation**: Aggregate sentiment over time windows (1h, 4h, 1d) for trend analysis
- **Anomaly detection**: Flag unusual activity (sudden sentiment shifts, spike in mention count)
- **Multi-language support**: Process non-English sources (Chinese crypto news, European financial news)

## Resolved Issues (Sources)

Wayfinder decisions for this stage live in [docs/wayfinder/market-intelligence-map.md](../wayfinder/market-intelligence-map.md) (migrated from GitHub issue #12). Decisions synthesized here:

- **Data sources** — Bloomberg, Reuters, SEC, Twitter/X, Reddit.
- **Agent output / data contract** — `AgentIntelligence` / `IntelligenceItem` upstream; `MarketContext` / `ConflictResolution` downstream.
- **Data format & schema** — normalized UTC timestamps, asset-class tagging, entity extraction.
- **Update frequency & cadence** — 5s crypto, 30s stocks (market hours), per-source cadence.
- **Storage strategy & retention** — no persistence, restart cleanly, raw feeds ephemeral.
- **API contracts with analysts** — pull (`getContext`) and push (`subscribe`) delivery patterns.
- **Error handling & failure modes** — agent failures handled gracefully (retry/backoff/degrade), system never blocks.
- **Data quality & validation** — schema validation, required fields, value ranges.
- **Conflict resolution** (map-level decision) — DeepResearch wins on high-impact news; Grok wins on viral narratives > 2σ.

**Still open (deferred):** Backtesting data requirements — the live layer is only made replay-*compatible* (injected clock); the historical news/sentiment store + replay service are a separate concern (see Out of Scope), and that store is also what the Analysts layer's backtest replay depends on. Tracked as an open frontier item in the wayfinder map.

The parallel **Market Data Service** (price/OHLCV + indicators) is a separate Stage 0 component with its own map.
