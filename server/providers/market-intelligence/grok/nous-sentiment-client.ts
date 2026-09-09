/**
 * Nous-backed `GrokSentimentClient`, replacing the direct-to-xAI client (#464)
 * in the single-provider cutover — see docs/adr/0009-single-provider-nous.md.
 *
 * Asks a model for X/Twitter sentiment on one instrument and normalises the
 * answer into `IntelligenceItem[]`. Deliberately thin: the cadence, the spend
 * cap and the store write all live in `GrokAgent`, so this file's only job is
 * the wire — and now not even that, since `nousChat` owns the HTTP.
 *
 * ## What this is NOT
 *
 * It is not live retrieval. The model answers from what it was trained on;
 * nothing here searches X.
 *
 * A correction to what this comment first said, because the history decides how
 * much was given up. It read: "That was already true of the xAI client this
 * replaces — it posted to plain `/chat/completions` with no Live Search
 * parameters — so the cutover changes the provider, not the honesty of the
 * signal." That describes the ORIGINAL #464 client. It was not true of the
 * client actually replaced: #474 had already moved it to `POST /v1/responses`
 * with `tools: [{ type: 'x_search' }]`, which does retrieve, and had added a
 * FAIL-CLOSED GUARD — any response carrying no evidence of retrieval (no
 * citations, no tool step) was discarded with an `error` log rather than
 * ingested. So the cutover did change the honesty of the signal: it traded
 * working retrieval, and the guard protecting it, for single-provider
 * simplicity.
 *
 * That may still be the right call — it is one HTTP path instead of two, and
 * ADR-0009 owns that decision. But the cost should be recorded accurately:
 * xAI's Live Search rides on `POST /v1/responses` and Nous proxies
 * `chat/completions` only, so this path CANNOT retrieve, and restoring a real
 * retrieval source is separate work rather than a model swap.
 *
 * THE CONSEQUENCE, which is the part that reaches money: items parsed here
 * would be written as `source: 'twitter'` and read by the sentiment and
 * fundamental analysts, which feed the Debate Engine, which sizes trades. The
 * analysts cannot tell a model's recollection from a live crowd read. The
 * prompt below also asks for sentiment "As of" a recent date the model has no
 * data for, which is the shape that invites confident confabulation.
 *
 * RESOLVED in #485 (options 1 and 2 together; option 3 — a direct xAI
 * `/v1/responses` path — is a separate, ADR-0009-exception decision, not
 * this). `fetchSentiment` below always returns `retrievalEvidence: false`,
 * because this transport cannot carry citations or a tool step at all. That
 * makes `GrokAgent.refresh` (`grok-agent.ts`) discard every item this client
 * ever parses, unconditionally, rather than ingest it as signal — so a
 * `twitter` row that reaches the store is never this client's recall. The
 * items are still parsed and returned rather than short-circuited to `[]`
 * here, so this file stays a pure wire adapter: what happens to un-retrieved
 * items is `GrokAgent`'s policy, not this client's.
 *
 * MEASURED 2026-08-06, which NARROWS the confabulation worry above without
 * removing it. Exercised for the first time against live Nous credentials, this
 * stage returns `{"items":[]}` on every call, and empty is the CORRECT answer,
 * not a defect. Holding the production system prompt verbatim and varying only
 * the user message, the result was empty with today's date, with no date, and
 * with a date well inside the training corpus — so it is not a cutoff effect.
 * The driver is the prompt's own anti-fabrication clause, which is currently
 * doing the work the "As of" shape would otherwise undermine: delete that
 * clause and the same model immediately produces fluent invented sentiment.
 * Asked directly, it confirms it has no live X access in this API call. So
 * empty `market_intelligence` rows during the soak are expected and should not
 * be chased. The model is PINNED to `x-ai/grok-4.5` rather than the floating
 * `~x-ai/grok-latest` alias precisely because of the residual risk: while the
 * answer is empty, corpus recency buys nothing, and a future model behind a
 * floating alias could begin returning invented sentiment with no test to catch
 * it, since nothing asserts on content. ADR-0009 carries the full table.
 *
 * The `source: 'twitter'` tag and the `grok` agent id are kept as-is. An
 * earlier version of this comment claimed that was because they are
 * persisted in `market_intelligence` rows and renaming them is a migration,
 * not a rename — that is not true (`MarketIntelligenceStore` is in-memory and
 * restart-clean, per #481's research), and the real reason is simpler: with
 * `retrievalEvidence: false` guaranteeing no item from this client is ever
 * ingested, there is nothing left for the tag to mislabel.
 *
 * ## Structured output, and what happens when it isn't
 *
 * The model is asked for JSON and the response is PARSED, never trusted. A
 * malformed body yields zero items rather than a throw with a half-decoded
 * payload, and zero items reaches the analysts as `NO_DATA_MARKER` — the same
 * degradation as an outage, which is correct: an answer we cannot read is not
 * an answer.
 */

import type { Logger } from '../../../shared/index.js';
import type { NousChatResult } from '../../../shared/llm/nous-chat.js';
import { NousRefusalError, nousChat } from '../../../shared/llm/nous-chat.js';
import type { IntelligenceItem } from '../types.js';
import type { GrokSentimentClient } from './grok-agent.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Response budget. Ten themes of a sentence or two each fits comfortably; the
 * cap also has to be generous enough that the model does not run out mid-JSON,
 * because a `finish_reason: 'length'` is a hard failure by design (`nousChat`)
 * rather than something the 4-hour bucket quietly retries.
 */
const DEFAULT_MAX_TOKENS = 2048;

/** How many items one call may contribute. A prompt that returns 200 posts is spend, not signal. */
const MAX_ITEMS = 10;

/** The shape the prompt asks for. Validated field by field before it becomes an item. */
interface RawSentiment {
  headline?: unknown;
  sentiment?: unknown;
  confidence?: unknown;
  summary?: unknown;
}

export interface NousSentimentClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  logger?: Logger;
}

export class NousSentimentClient implements GrokSentimentClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxTokens: number;
  readonly #logger: Logger | undefined;

  constructor(options: NousSentimentClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl;
    this.#model = options.model;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#logger = options.logger;
  }

  async fetchSentiment(instrument: string, asOf: Date) {
    const started = Date.now();

    // Hoisted so the capture path (#1035) persists the messages that actually
    // went on the wire, rather than a re-render of them.
    const messages = [
      {
        role: 'system' as const,
        content:
          'You summarise X/Twitter sentiment for one financial instrument. Reply ' +
          'with JSON only: {"items":[{"headline":string,"sentiment":1|0|-1,' +
          '"confidence":number 0-1,"summary":string}]}. Report at most ' +
          `${MAX_ITEMS} distinct themes. If there is no meaningful discussion, reply ` +
          '{"items":[]} — an empty list is a valid and useful answer, and inventing ' +
          'sentiment to fill the list is worse than reporting none.',
      },
      {
        role: 'user' as const,
        content: `Instrument: ${instrument}. As of: ${asOf.toISOString()}.`,
      },
    ];

    let result: NousChatResult;
    try {
      result = await nousChat(
        {
          apiKey: this.#apiKey,
          baseUrl: this.#baseUrl,
          timeoutMs: this.#timeoutMs,
        },
        {
          model: this.#model,
          max_tokens: this.#maxTokens,
          messages,
        },
      );
    } catch (error) {
      if (!(error instanceof NousRefusalError)) throw error;
      // A refusal is ZERO ITEMS here, not a throw (#1391). `GrokAgent.refresh`
      // meters and marks the 4-hour bucket only on a return; a throw skips both,
      // so the refused call's tokens would go uncounted against the cap AND the
      // identical prompt would be re-issued on every tick until the bucket
      // rolled — the same unbounded re-billing the debate path's carve-out
      // exists to stop. The refusal is deterministic in the prompt: re-asking
      // buys the same answer at the same price.
      this.#logger?.log({
        trace_id: 'grok',
        stage: 'market_intelligence',
        event: 'sentiment_refused',
        level: 'warn',
        message:
          `sentiment: ${this.#model} refused the prompt for ${instrument} ` +
          `(${error.signal}); reporting zero items for this window. The call is metered — it ` +
          'cost money and produced nothing — and the bucket is marked, so the same prompt is ' +
          'not re-issued until it rolls. A refusal that persists across buckets is a prompt or ' +
          'model change, not something retrying fixes.',
        payload: { instrument, signal: error.signal },
      });

      return {
        items: [] as IntelligenceItem[],
        prompt: messages.map((message) => `[${message.role}] ${message.content}`).join('\n\n'),
        raw_text: '',
        model: this.#model,
        // The only surface carrying what the refused call billed: a throw at
        // the wire boundary never reached a meter.
        usage: error.usage,
        retrievalEvidence: false,
        latency_ms: Date.now() - started,
      };
    }

    return {
      items: this.#parseItems(result.text, instrument, asOf),
      // A RENDERED representation, not the wire bytes. `anthropic-client.ts`
      // captures the exact string it hands the transport; here the transport
      // takes a structured `messages` array and serializes it itself, so the
      // closest honest artifact is both roles joined in order. It reads back
      // faithfully — a capture holding only the user turn would omit the
      // instruction that actually shapes the answer — but it is not
      // byte-identical to the request body, and nothing should compare it as
      // though it were.
      prompt: messages.map((message) => `[${message.role}] ${message.content}`).join('\n\n'),
      raw_text: result.text,
      model: result.model,
      usage: result.usage,
      // ALWAYS false: `chat/completions` carries no citations and runs no
      // server-side tool, so there is structurally nothing this client could
      // point to as evidence of retrieval. See the module header and #485.
      retrievalEvidence: false,
      latency_ms: Date.now() - started,
    };
  }

  /**
   * Parses to zero items rather than throwing on a shape we cannot read.
   *
   * Zero reaches the analysts as `NO_DATA_MARKER`, which is the honest report:
   * an answer we cannot decode is not an answer, and it must not be
   * distinguishable from an outage by accident.
   */
  #parseItems(content: string, instrument: string, asOf: Date): IntelligenceItem[] {
    if (content.trim() === '') return [];

    let parsed: { items?: unknown };
    try {
      parsed = JSON.parse(content) as { items?: unknown };
    } catch {
      // Recover a fenced or prose-wrapped object before giving up: a model asked
      // for JSON often returns it fenced or with a sentence around it.
      const match = content.match(/\{[\s\S]*\}/);
      if (match === null) return this.#unreadable(instrument);
      try {
        parsed = JSON.parse(match[0]) as { items?: unknown };
      } catch {
        return this.#unreadable(instrument);
      }
    }

    if (!Array.isArray(parsed.items)) return this.#unreadable(instrument);

    const items: IntelligenceItem[] = [];
    for (const [index, raw] of parsed.items.slice(0, MAX_ITEMS).entries()) {
      const item = this.#toItem(raw as RawSentiment, instrument, asOf, index);
      if (item !== null) items.push(item);
    }
    return items;
  }

  #toItem(
    raw: RawSentiment,
    instrument: string,
    asOf: Date,
    index: number,
  ): IntelligenceItem | null {
    // Every field validated. A `sentiment` of 2, or a confidence of 1.4, would
    // otherwise flow straight into the analysts' arithmetic and skew a
    // direction on a value the type system says cannot exist.
    if (typeof raw.headline !== 'string' || raw.headline.trim() === '') return null;
    if (raw.sentiment !== 1 && raw.sentiment !== 0 && raw.sentiment !== -1) return null;
    if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)) return null;

    return {
      id: `grok:${instrument}:${asOf.toISOString()}:${index}`,
      source: 'twitter',
      type: 'sentiment',
      timestamp: asOf,
      entity: instrument,
      headline: raw.headline,
      sentiment: raw.sentiment,
      confidence: Math.min(1, Math.max(0, raw.confidence)),
      ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
    };
  }

  #unreadable(instrument: string): IntelligenceItem[] {
    this.#logger?.log({
      trace_id: 'grok',
      stage: 'market_intelligence',
      event: 'sentiment_response_unparseable',
      level: 'warn',
      message:
        `sentiment: could not parse the response for ${instrument}; reporting zero items. ` +
        'The call still counted against the spend cap — it cost money and produced nothing.',
      payload: { instrument },
    });
    return [];
  }
}
