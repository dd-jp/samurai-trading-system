/**
 * xAI-backed `GrokSentimentClient` (#464).
 *
 * Asks Grok for live X/Twitter sentiment on one instrument and normalises the
 * answer into `IntelligenceItem[]`. Deliberately thin: the cadence, the spend
 * cap and the store write all live in `GrokAgent`, so this file's only job is
 * the wire.
 *
 * ## The Responses API, because it is the only one that can search X
 *
 * This posts to `/v1/responses`, NOT `/v1/chat/completions`. That is not a
 * style preference — it is the difference between live sentiment and the
 * model's training recall:
 *
 *   - `/v1/chat/completions` documents its `tools` field as "Currently, only
 *     FUNCTIONS are supported as a tool". Server-side tools are rejected there,
 *     so a request to that endpoint retrieves nothing and Grok answers from
 *     pre-training knowledge.
 *   - `/v1/responses` documents the same field as "functions and web search",
 *     and is where xAI's server-side `x_search` runs.
 *
 * The original #464 client posted `{ model, messages }` to chat/completions
 * with no `tools` at all. It therefore returned MODEL RECALL formatted as
 * sentiment — indistinguishable, downstream, from a genuine live read, which
 * is precisely the fabrication #464 forbids. xAI retired the older
 * `search_parameters` form of Live Search on 2026-01-12; server-side tools are
 * the replacement, so there is no way to do this on the legacy endpoint.
 *
 * The Responses API also renames the prompt field: `input`, not `messages`.
 *
 * ## Retrieval evidence is REQUIRED, and its absence is an error
 *
 * A response carrying no sign that `x_search` actually ran is discarded with an
 * `error` log rather than ingested. This is the whole safety property of the
 * file. Without it, every way this can break — the tool being rejected, the
 * endpoint 404ing into a compatibility shim, a future account without X-search
 * entitlement — degrades to "plausible sentiment from training data", which is
 * the one failure the analysts cannot detect and the debate would trade on.
 *
 * Fail-closed is deliberate: zero items reaches the analysts as
 * `NO_DATA_MARKER`, the same honest degradation as an outage. A wrong answer on
 * a money surface is worse than a visibly missing one — the same rule
 * `pricing.ts` states for unpriced models.
 *
 * ## Structured output, and what happens when it isn't
 *
 * The model is asked for JSON and the response is PARSED, never trusted. A
 * malformed body yields zero items rather than a throw with a half-decoded
 * payload.
 *
 * ## Secret handling
 *
 * The key rides in an `Authorization` header, never in a URL, and no error
 * message here interpolates the request — same rule as `telegram-errors.ts`,
 * for the same reason.
 */
import type { Logger } from '../../shared/index.js';
import type { IntelligenceItem } from '../types.js';
import type { GrokSentimentClient } from './grok-agent.js';

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
/**
 * Corrected 2026-08-06: this was `grok-4`, WHICH IS NOT A MODEL xAI OFFERS.
 * The lineup is grok-4.5 / grok-4.3 / grok-4.20-* / grok-build-0.1
 * (docs.x.ai/docs/models), so every call would have been rejected on the id
 * alone had one ever been made — and none was, because the request went to an
 * endpoint that could not search either.
 *
 * 4.5 rather than the cheaper 4.3 for a first live run: it is the flagship, so
 * it is the least likely to surprise us on server-side tool support, and the
 * difference over a 14-day soak is about $2.50 against a $50 cap. Drop to
 * `grok-4.3` (1.25/2.50 vs 2/6) if that trade stops being worth it.
 */
const DEFAULT_MODEL = 'grok-4.5';
const DEFAULT_TIMEOUT_MS = 30_000;

/** How many items one call may contribute. A prompt that returns 200 posts is spend, not signal. */
const MAX_ITEMS = 10;

/**
 * The Responses API's output envelope, typed only as far as this file reads it.
 *
 * Loose on purpose. xAI does not publish a full REST response schema for
 * `/v1/responses`, so every field here is optional and every read is guarded —
 * `#extractText` walks three known shapes rather than assuming one. Tightening
 * this to a shape we have not seen would turn a cosmetic wire change into an
 * outage.
 */
interface XaiOutputContent {
  type?: string;
  text?: string;
}

interface XaiOutputItem {
  type?: string;
  content?: XaiOutputContent[];
}

interface XaiResponse {
  /** Convenience field on the Responses API: the concatenated assistant text. */
  output_text?: string;
  output?: XaiOutputItem[];
  /** The legacy chat/completions shape, read only so a compatibility shim cannot go unnoticed. */
  choices?: { message?: { content?: string } }[];
  citations?: unknown[];
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
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
      const response = await fetch(`${this.#baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.#model,
          // `input`, not `messages` — the Responses API's name for the prompt.
          input: [
            {
              role: 'system',
              content:
                'You summarise live X/Twitter sentiment for one financial instrument. Use the ' +
                'x_search tool to read actual recent posts — do not answer from memory. Reply ' +
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
          // The whole reason this client exists. Without it Grok answers from
          // training data and the analysts consume recall as live sentiment.
          tools: [{ type: 'x_search' }],
        }),
      });

      if (!response.ok) {
        // Status only — the body can echo the request, and the request carries
        // the key.
        throw new Error(`xAI responded ${response.status}`);
      }

      const body = (await response.json()) as XaiResponse;
      const toolSteps = this.#countToolSteps(body);
      const items =
        this.#retrieved(body, instrument, toolSteps)
          ? this.#parseItems(body, instrument, asOf)
          : [];

      return {
        items,
        model: body.model ?? this.#model,
        usage: {
          input_tokens: body.usage?.input_tokens ?? body.usage?.prompt_tokens ?? 0,
          output_tokens: body.usage?.output_tokens ?? body.usage?.completion_tokens ?? 0,
        },
        // Reported so the meter can price the tool half of the bill (#476).
        // Counted, not assumed to be one: the Responses API runs an agentic
        // loop, so a single request may search several times and xAI bills
        // each invocation.
        server_tool_calls: toolSteps,
        latency_ms: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Whether this response shows evidence that `x_search` actually ran.
   *
   * Two accepted signals, because xAI publishes no response schema and either
   * one alone would be brittle:
   *
   *   - a non-empty `citations` array — the documented carrier for what the
   *     search returned;
   *   - an output item whose `type` names a search/tool step, which is how the
   *     Responses API reports server-side tool invocations inline.
   *
   * Everything else counts as unretrieved. The cost of being wrong in that
   * direction is one window of `NO_DATA_MARKER`; the cost of being wrong in the
   * other is the debate trading on fabricated sentiment, so the asymmetry
   * decides which way this errs.
   */
  #retrieved(body: XaiResponse, instrument: string, toolSteps: number): boolean {
    if (Array.isArray(body.citations) && body.citations.length > 0) return true;
    if (toolSteps > 0) return true;

    this.#logger?.log({
      trace_id: 'grok',
      stage: 'market_intelligence',
      level: 'error',
      message:
        `grok: the response for ${instrument} carried NO evidence that x_search ran — no ` +
        'citations and no tool step in the output. Discarding it rather than ingesting it: ' +
        'without retrieval this is the model answering from training data, which would reach ' +
        'the analysts as live sentiment and is exactly the fabrication #464 forbids. Check that ' +
        'the account is entitled to server-side x_search and that the request reached ' +
        '/v1/responses (chat/completions accepts function tools ONLY and silently retrieves ' +
        'nothing). The call still counted against the spend cap.',
      payload: { instrument },
    });
    return false;
  }

  /**
   * How many server-side tool invocations this response reports.
   *
   * Serves two callers with one walk: `#retrieved` needs to know whether ANY
   * ran, and the meter needs to know HOW MANY, because xAI bills per
   * invocation and the Responses API's agentic loop may search more than once
   * for a single request (#476).
   */
  #countToolSteps(body: XaiResponse): number {
    return (body.output ?? []).filter(
      (item) => typeof item.type === 'string' && /search|tool|web/i.test(item.type),
    ).length;
  }

  /**
   * Parses to zero items rather than throwing on a shape we cannot read.
   *
   * Zero reaches the analysts as `NO_DATA_MARKER`, which is the honest report:
   * an answer we cannot decode is not an answer, and it must not be
   * distinguishable from an outage by accident.
   */
  #parseItems(body: XaiResponse, instrument: string, asOf: Date): IntelligenceItem[] {
    const content = this.#extractText(body);
    if (content === null || content.trim() === '') return [];

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

  /**
   * The assistant text, from whichever of the three shapes carries it.
   *
   * `output_text` is the Responses API's convenience field; `output[].content[]`
   * is its structured form; `choices[]` is the legacy chat/completions shape,
   * read last so that a compatibility shim in front of the endpoint still
   * yields data instead of silently reporting nothing.
   */
  #extractText(body: XaiResponse): string | null {
    if (typeof body.output_text === 'string' && body.output_text !== '') return body.output_text;

    const fromOutput = (body.output ?? [])
      .flatMap((item) => item.content ?? [])
      .map((part) => part.text)
      .filter((text): text is string => typeof text === 'string' && text !== '')
      .join('');
    if (fromOutput !== '') return fromOutput;

    const legacy = body.choices?.[0]?.message?.content;
    return typeof legacy === 'string' && legacy !== '' ? legacy : null;
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
