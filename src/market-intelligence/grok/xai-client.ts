/**
 * xAI-backed `GrokSentimentClient` (#464).
 *
 * Asks Grok for live X/Twitter sentiment on one instrument and normalises the
 * answer into `IntelligenceItem[]`. Deliberately thin: the cadence, the spend
 * cap and the store write all live in `GrokAgent`, so this file's only job is
 * the wire.
 *
 * ## Structured output, and what happens when it isn't
 *
 * The model is asked for JSON and the response is PARSED, never trusted. A
 * malformed body yields zero items rather than a throw with a half-decoded
 * payload, and zero items reaches the analysts as `NO_DATA_MARKER` — the same
 * degradation as an outage, which is correct: an answer we cannot read is not
 * an answer.
 *
 * ## Secret handling
 *
 * The key rides in an `Authorization` header, never in a URL, and no error
 * message here interpolates the request — same rule as
 * `telegram-errors.ts`, for the same reason.
 */
import type { Logger } from '../../shared/index.js';
import type { IntelligenceItem } from '../types.js';
import type { GrokSentimentClient } from './grok-agent.js';

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_MODEL = 'grok-4';
const DEFAULT_TIMEOUT_MS = 30_000;

/** How many items one call may contribute. A prompt that returns 200 posts is spend, not signal. */
const MAX_ITEMS = 10;

interface XaiChoice {
  message?: { content?: string };
}

interface XaiResponse {
  choices?: XaiChoice[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** The shape the prompt asks for. Validated field by field before it becomes an item. */
interface RawSentiment {
  headline?: unknown;
  sentiment?: unknown;
  confidence?: unknown;
  summary?: unknown;
}

export interface XaiGrokClientOptions {
  /** Defaults to `process.env.XAI_API_KEY`. Never logged. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  logger?: Logger;
}

export class XaiGrokClient implements GrokSentimentClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #logger: Logger | undefined;

  constructor(options: XaiGrokClientOptions = {}) {
    const apiKey = (options.apiKey ?? process.env.XAI_API_KEY)?.trim();
    if (apiKey === undefined || apiKey === '') {
      // Refuses at CONSTRUCTION, not at the first call. The composition root
      // only builds this when the key is present, so reaching here means the
      // key vanished between the check and the build — better to fail the boot
      // than to fail every fourth hour with an outage that looks like xAI's.
      throw new Error(
        'XaiGrokClient: XAI_API_KEY is not set. Provide it via the environment (.env.local) ' +
          'or pass { apiKey } explicitly.',
      );
    }
    this.#apiKey = apiKey;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#logger = options.logger;
  }

  async fetchSentiment(instrument: string, asOf: Date) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.#model,
          messages: [
            {
              role: 'system',
              content:
                'You summarise live X/Twitter sentiment for one financial instrument. Reply ' +
                'with JSON only: {"items":[{"headline":string,"sentiment":1|0|-1,' +
                '"confidence":number 0-1,"summary":string}]}. Report at most ' +
                `${MAX_ITEMS} distinct themes. If there is no meaningful discussion, reply ` +
                '{"items":[]} — an empty list is a valid and useful answer, and inventing ' +
                'sentiment to fill the list is worse than reporting none.',
            },
            {
              role: 'user',
              content: `Instrument: ${instrument}. As of: ${asOf.toISOString()}.`,
            },
          ],
        }),
      });

      if (!response.ok) {
        // Status only — the body can echo the request, and the request carries
        // the key.
        throw new Error(`xAI responded ${response.status}`);
      }

      const body = (await response.json()) as XaiResponse;
      const items = this.#parseItems(body, instrument, asOf);

      return {
        items,
        model: body.model ?? this.#model,
        usage: {
          input_tokens: body.usage?.prompt_tokens ?? 0,
          output_tokens: body.usage?.completion_tokens ?? 0,
        },
        latency_ms: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parses to zero items rather than throwing on a shape we cannot read.
   *
   * Zero reaches the analysts as `NO_DATA_MARKER`, which is the honest report:
   * an answer we cannot decode is not an answer, and it must not be
   * distinguishable from an outage by accident.
   */
  #parseItems(body: XaiResponse, instrument: string, asOf: Date): IntelligenceItem[] {
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') return [];

    let parsed: { items?: unknown };
    try {
      parsed = JSON.parse(content) as { items?: unknown };
    } catch {
      // Recover a fenced or prose-wrapped object before giving up — the same
      // salvage `review_lib.py` does, and for the same reason.
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
      level: 'warn',
      message:
        `grok: could not parse the sentiment response for ${instrument}; reporting zero items. ` +
        'The call still counted against the spend cap — it cost money and produced nothing.',
      payload: { instrument },
    });
    return [];
  }
}
