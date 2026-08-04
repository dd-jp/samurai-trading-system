# Prototype: Devil's Advocate invalidation checklist vs. the Bear persona

**Ticket:** [Prototype: an invalidation checklist against a real BTC-USD thesis](https://github.com/dd-jp/samurai-trading-system/issues/334)
**Map:** [Wayfinder: Devil's Advocate — thesis invalidation layer placement](https://github.com/dd-jp/samurai-trading-system/issues/291)
**Date:** 2026-08-04

Throwaway artifact to react to. Not a spec, not a design, not committed to.

## Scope, and what is missing from it

Generated at **one model tier only** (Opus). The ticket asked for a Sonnet/Opus side-by-side; producing a fake "Sonnet-style" output would be fabricated evidence flowing straight into the model-tier decision, so it was descoped deliberately rather than faked. [Decide: model tier for the invalidation pass](https://github.com/dd-jp/samurai-trading-system/issues/340) stays blocked.

Both outputs below are generated. Neither is from a live API call — there is no wired client to call — so treat them as *plausible* output shapes, not measured behaviour. The Bear output uses the verbatim prompt from `src/debate-engine/personas.ts:142`.

---

## The input, and the first thing it shows

Built from what the **real** analysts actually emit — `technical-analyst.ts:96`, `sentiment-analyst.ts:84`, `fundamental-analyst.ts:74` — not from an invented narrative thesis.

```json
[
  {
    "analyst_id": "technical",
    "analyst_type": "technical",
    "direction": "bullish",
    "confidence": 0.72,
    "key_points": [
      "Last close 63120.5 vs SMA(14)=61804.2",
      "RSI(14)=68.4",
      "Context: 60 candles, avg volume 1284.6",
      "MI context: 7 news, 23 social items in window"
    ]
  },
  {
    "analyst_id": "sentiment",
    "analyst_type": "sentiment",
    "direction": "bullish",
    "confidence": 0.61,
    "key_points": [
      "23 social items in window, net sentiment driving bullish",
      "Context: 60 candles, avg volume 1284.6"
    ]
  },
  {
    "analyst_id": "fundamental",
    "analyst_type": "fundamental",
    "direction": "neutral",
    "confidence": 0.44,
    "key_points": [
      "7 news/filing items in window, net sentiment driving neutral",
      "Price reaction context: mark=63120.5 observed 2026-08-04T14:00:00.000Z"
    ]
  }
]
```

**This is the finding that matters most, and it is structural rather than generated.** `key_points` are mechanical telemetry strings — an indicator reading, a count of items in a window. Nothing at the analyst layer states a causal claim ("BTC breaks out because ETF inflows are accelerating"). What reaches the debate is a direction, a confidence, and a handful of numeric observations.

**But a thesis object does exist — one stage later.** `DebateResult` (`debate-engine/types.ts:62`) carries `synthesis` ("Coherent position statement synthesized by the mediator") and `position` ("Actionable recommendation in prose"), plus `disagreement_summary` and `open_items`. That is a stated thesis, in prose, produced by the mediator.

So the input a Devil's Advocate gets is not one question but two, and they differ by placement:

- **At Stage 1 (analyst role)** there is no thesis. The pass would have to infer one from telemetry before attacking it — an inference layer the proposal didn't account for, and the most likely place a cheaper model goes wrong, since a misread thesis yields confident, well-formed, irrelevant conditions.
- **After Debate** the thesis is handed to it directly in `synthesis`/`position`, and `open_items` already names what the debate itself failed to resolve.

This constrains placement more than the map assumed: the component's central input only exists downstream of Debate.

*(Corrected after first draft — the initial version of this section claimed the system produces no thesis object at all. That is true at the analyst layer and false at `DebateResult`.)*

---

## Output A — Bear persona, verbatim prompt from `personas.ts:142`

Prompt used (exact):

> You are the Bear persona in a trading debate. Argue for the pessimistic interpretation of the following analyst views, emphasizing risks and downside. Respond as JSON: `{"stance": "bullish"|"bearish"|"neutral", "rationale": string}`.

```json
{
  "stance": "bearish",
  "rationale": "The bullish case rests on thin evidence. RSI(14)=68.4 is approaching overbought, so the very indicator cited as strength is closer to exhaustion than to confirmation — price is 2.1% above its own SMA(14), which is stretched rather than trending. Sentiment is 23 social items: a volume of chatter, not a direction, and social sentiment is the most reflexive of the three inputs, tending to peak at local tops rather than lead them. Fundamental is neutral at 0.44 confidence with only 7 news items, which is closer to no signal than to support. Two correlated momentum reads and one abstention is a weaker consensus than a 2-1 count suggests, because technical and sentiment are both downstream of the same recent price action. Downside: a reversion to SMA is ~2% against the position before any thesis is disproven."
}
```

## Output B — Devil's Advocate, invalidation checklist

Prompt used (drafted for this prototype, not from the repo):

> You are the Devil's Advocate in a trading system. You are not arguing the bearish case. Your job is to state the conditions under which the proposed position is **wrong** — specific, checkable conditions that would falsify it. For each, give the observable, the threshold, and the data source. Respond as JSON.

```json
{
  "thesis_restated": "Long BTC-USD on momentum: price above SMA(14) with RSI confirming, supported by positive social sentiment.",
  "invalidation_conditions": [
    {
      "id": "reclaim_fail",
      "observable": "close",
      "comparator": "<",
      "threshold": 61804.2,
      "source": "market_data.getIndicator(SMA_14)",
      "rationale": "The entire technical premise is 'close above SMA(14)'. Below it, the stated reason for the position no longer holds — this is not a stop, it is the premise failing."
    },
    {
      "id": "momentum_divergence",
      "observable": "RSI(14)",
      "comparator": "<",
      "threshold": 50,
      "source": "market_data.getIndicator(RSI_14)",
      "rationale": "RSI at 68.4 was cited as confirmation. A cross below 50 means the cited confirmation has inverted, not merely weakened."
    },
    {
      "id": "volume_hollow",
      "observable": "24h volume vs 60-candle average",
      "comparator": "<",
      "threshold": 0.6,
      "source": "market_data.getBars(60)",
      "rationale": "Momentum on declining volume is the specific failure mode of this setup. avg volume 1284.6 is the baseline."
    },
    {
      "id": "sentiment_was_the_top",
      "observable": "social item count in window",
      "comparator": ">",
      "threshold": 46,
      "source": "market_intelligence.getContext",
      "rationale": "Reflexivity check: 23 items drove the bullish read. A doubling without price follow-through indicates chatter peaking at a local top, which is the inverse of the signal it was taken as."
    },
    {
      "id": "consensus_was_one_signal",
      "observable": "technical and sentiment direction agreement while fundamental abstains",
      "comparator": "persists",
      "threshold": "3 consecutive ticks",
      "source": "debate_log.contributions",
      "rationale": "Technical and sentiment are both downstream of recent price. If fundamental never leaves neutral, the '2 of 3 agree' consensus is one signal counted twice."
    }
  ],
  "thesis_holds": true,
  "conditions_currently_breached": []
}
```

---

## Observations

Facts about the two outputs. The verdicts on these are the ticket's job, not this document's.

1. **The Bear and the Devil's Advocate reached the same substantive points.** Overbought RSI, stretched-from-SMA, social sentiment as reflexive, correlated technical/sentiment inputs, neutral fundamental as weak support — every one appears in both. The overlap is near-total in content.

2. **They differ in form, not in insight.** The Bear returns a stance and prose. The Devil's Advocate returns named conditions with observables, thresholds and data sources. Same observations, one addressable by code.

3. **Four of five conditions are checkable against data the system already has** — `getIndicator`, `getBars`, `getContext` are all live services with existing call sites. The fifth (`consensus_was_one_signal`) needs `debate_log` across ticks, which is persisted but not currently read this way.

4. **A boolean fell out naturally here, but trivially.** `thesis_holds: true` with an empty breach list is just "no condition is currently breached" — the boolean is derived from the list, carrying no information the list doesn't. Whether that stays true when conditions conflict, or when one is breached and four aren't, is untested by a single example.

5. **The thresholds are anchored to entry-time values.** `61804.2` is SMA at the moment of generation. Whether conditions re-anchor as the position ages is unspecified here and is a live design question — though note that watching them *after* entry is ruled out of scope on the map.

6. **The DA restated the thesis before attacking it**, because no thesis reaches Stage 1. Placed after Debate it would not need to — `DebateResult.synthesis` and `position` hand it one, and `open_items` names what the debate left unresolved. The restatement is therefore an artifact of placement, not an inherent property of the component.

## For the ticket's four questions

Not answered here — these are yours:

- Are the conditions falsifiable, or narrative dressed as structure?
- Does this differ materially from what `runBearPersona` already produces?
- Is there a natural boolean, or is collapsing to one lossy?
- How many conditions before it stops being actionable? (Five shown; the fifth is the weakest.)
