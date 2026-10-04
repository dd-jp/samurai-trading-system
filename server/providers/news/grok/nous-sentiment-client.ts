import type { Logger } from '../../../shared/index.js';
import type { LlmInFlightGate, NousChatResult } from '../../../shared/llm/index.js';
import { NousRefusalError, nousChat } from '../../../shared/llm/index.js';
import type { IntelligenceItem } from '../types.js';
import type { GrokSentimentClient } from './grok-agent.js';

const DEFAULT_TIMEOUT_MS = 30_000;

const DEFAULT_MAX_TOKENS = 2048;

const MAX_ITEMS = 10;

interface RawSentiment {
  headline?: unknown;
  sentiment?: unknown;
  confidence?: unknown;
  summary?: unknown;
}

interface ScorableSentiment extends RawSentiment {
  headline: string;
  sentiment: 1 | 0 | -1;
  confidence: number;
}

function isScorable(raw: RawSentiment): raw is ScorableSentiment {
  return (
    typeof raw.headline === 'string' &&
    raw.headline.trim() !== '' &&
    (raw.sentiment === 1 || raw.sentiment === 0 || raw.sentiment === -1) &&
    typeof raw.confidence === 'number' &&
    Number.isFinite(raw.confidence)
  );
}

function parseLenientJson(content: string): { items?: unknown } | undefined {
  try {
    return JSON.parse(content) as { items?: unknown };
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match === null) return undefined;
    try {
      return JSON.parse(match[0]) as { items?: unknown };
    } catch {
      return undefined;
    }
  }
}

export interface NousSentimentClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  logger?: Logger;
  gate: LlmInFlightGate;
}

export class NousSentimentClient implements GrokSentimentClient {
  readonly #options: NousSentimentClientOptions & { timeoutMs: number; maxTokens: number };

  constructor(options: NousSentimentClientOptions) {
    this.#options = {
      ...options,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  }

  async fetchSentiment(instrument: string, asOf: Date) {
    const started = Date.now();

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
          apiKey: this.#options.apiKey,
          baseUrl: this.#options.baseUrl,
          timeoutMs: this.#options.timeoutMs,
          gate: this.#options.gate,
          gateBudgetMs: this.#options.timeoutMs,
          clampCallToBudget: true,
          llmStage: 'market_intelligence_sentiment',
        },
        {
          model: this.#options.model,
          max_tokens: this.#options.maxTokens,
          messages,
        },
      );
    } catch (error) {
      if (!(error instanceof NousRefusalError)) throw error;
      this.#options.logger?.log({
        trace_id: 'grok',
        stage: 'market_intelligence',
        event: 'sentiment_refused',
        level: 'warn',
        message:
          `sentiment: ${this.#options.model} refused the prompt for ${instrument} ` +
          `(${error.signal}); reporting zero items for this window. The call is metered — it ` +
          'cost money and produced nothing — and the bucket is marked, so the same prompt is ' +
          'not re-issued until it rolls. A refusal that persists across buckets is a prompt or ' +
          'model change, not something retrying fixes.',
        payload: { instrument, signal: error.signal, failure_cause: 'refusal' },
      });

      return {
        items: [] as IntelligenceItem[],
        prompt: messages.map((message) => `[${message.role}] ${message.content}`).join('\n\n'),
        raw_text: '',
        model: this.#options.model,
        usage: error.usage,
        retrievalEvidence: false,
        latency_ms: Date.now() - started,
      };
    }

    return {
      items: this.#parseItems(result.text, instrument, asOf),
      prompt: messages.map((message) => `[${message.role}] ${message.content}`).join('\n\n'),
      raw_text: result.text,
      model: result.model,
      usage: result.usage,
      retrievalEvidence: false,
      latency_ms: Date.now() - started,
    };
  }

  #parseItems(content: string, instrument: string, asOf: Date): IntelligenceItem[] {
    if (content.trim() === '') return [];

    const parsed = parseLenientJson(content);
    if (parsed === undefined || !Array.isArray(parsed.items)) return this.#unreadable(instrument);

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
    if (!isScorable(raw)) return null;

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
    this.#options.logger?.log({
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
