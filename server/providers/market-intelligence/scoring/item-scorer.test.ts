import {
  LlmProviderError,
  LlmTimeoutError,
  MockLlmClient,
} from '../../../pipeline/debate-engine/index.js';
import type { LogEntry, Logger } from '../../../shared/index.js';
import { type ScorableItem, scoreItems, UNSCORED } from './item-scorer.js';

function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

// `ScoreItemsDeps.logger` is required (#1392 review round 1, F5) — every call
// below that isn't asserting on logged entries passes this instead of a
// `recordingLogger()`.
const NOOP_LOGGER: Logger = { log: () => {} };

const ITEMS: ScorableItem[] = [
  { entity: 'AAPL', headline: 'Apple beats on revenue', summary: 'Q3 revenue above consensus.' },
  { entity: 'AAPL', headline: 'Apple faces antitrust probe', summary: 'EU opens inquiry.' },
];

describe('scoreItems', () => {
  it('returns [] and degraded: false for an empty batch, without calling the client', async () => {
    const client = new MockLlmClient();
    const result = await scoreItems([], { llmClient: client, logger: NOOP_LOGGER });
    expect(result).toEqual({ scores: [], degraded: false });
    expect(client.requests).toHaveLength(0);
  });

  it('scores every item in input order on a well-formed response, degraded: false', async () => {
    const client = new MockLlmClient();
    client.enqueueText(
      JSON.stringify({
        scores: [
          { index: 0, sentiment: 1, confidence: 0.8 },
          { index: 1, sentiment: -1, confidence: 0.6 },
        ],
      }),
    );

    const result = await scoreItems(ITEMS, { llmClient: client, logger: NOOP_LOGGER });

    expect(result.degraded).toBe(false);
    expect(result.scores).toEqual([
      { index: 0, sentiment: 1, confidence: 0.8 },
      { index: 1, sentiment: -1, confidence: 0.6 },
    ]);
  });

  it('tolerates a markdown-fenced response the way the rest of the debate stack does', async () => {
    const client = new MockLlmClient();
    client.enqueueText(
      '```json\n' +
        JSON.stringify({ scores: [{ index: 0, sentiment: 1, confidence: 0.8 }] }) +
        '\n```',
    );

    const result = await scoreItems([ITEMS[0] as ScorableItem], {
      llmClient: client,
      logger: NOOP_LOGGER,
    });

    expect(result.degraded).toBe(false);
    expect(result.scores).toEqual([{ index: 0, sentiment: 1, confidence: 0.8 }]);
  });

  // Narrower than #1392's batch-wide scope, not an endorsement: this item is
  // indistinguishable from a genuine unanimous-neutral read (`degraded:
  // false`), the same gap #1392 fixed at the batch level. Tracked as #1420
  // rather than fixed here — the fix is a per-item degraded marker through
  // `ArchivedItem`, which is out of this ticket's scope.
  it('an item the model omitted falls back to UNSCORED, currently indistinguishable from a genuine neutral read (tracked follow-up, not fixed here)', async () => {
    const client = new MockLlmClient();
    client.enqueueText(JSON.stringify({ scores: [{ index: 0, sentiment: 1, confidence: 0.8 }] }));

    const result = await scoreItems(ITEMS, { llmClient: client, logger: NOOP_LOGGER });

    expect(result.degraded).toBe(false);
    expect(result.scores).toEqual([
      { index: 0, sentiment: 1, confidence: 0.8 },
      { index: 1, ...UNSCORED },
    ]);
  });

  describe('a batch-wide failure', () => {
    it('falls back to UNSCORED for every item and sets degraded: true on a transport failure', async () => {
      const client = new MockLlmClient();
      client.enqueueError(new LlmTimeoutError('boom'));

      const result = await scoreItems(ITEMS, { llmClient: client, logger: NOOP_LOGGER });

      expect(result).toEqual({
        degraded: true,
        scores: [
          { index: 0, ...UNSCORED },
          { index: 1, ...UNSCORED },
        ],
      });
    });

    it('falls back to UNSCORED and sets degraded: true when the model answers with prose, not JSON', async () => {
      const client = new MockLlmClient();
      client.enqueueText("I can't help with that request.");

      const result = await scoreItems(ITEMS, { llmClient: client, logger: NOOP_LOGGER });

      expect(result.degraded).toBe(true);
      expect(result.scores).toEqual([
        { index: 0, ...UNSCORED },
        { index: 1, ...UNSCORED },
      ]);
    });

    it('reports invalid, rather than a successful empty parse, when every scored entry fails validation', async () => {
      const client = new MockLlmClient();
      // Well-formed JSON, `scores` is an array, but nothing in it matches the
      // expected shape — the old `scores.filter(isScore)` reported this as
      // `valid: true` with `data: { scores: [] }`.
      client.enqueueText(JSON.stringify({ scores: [{ note: 'no directional read' }] }));

      const result = await scoreItems(ITEMS, { llmClient: client, logger: NOOP_LOGGER });

      expect(result.degraded).toBe(true);
      expect(result.scores).toEqual([
        { index: 0, ...UNSCORED },
        { index: 1, ...UNSCORED },
      ]);
    });

    it('reports invalid when the model returns an explicitly empty scores array', async () => {
      const client = new MockLlmClient();
      client.enqueueText(JSON.stringify({ scores: [] }));

      const result = await scoreItems(ITEMS, { llmClient: client, logger: NOOP_LOGGER });

      expect(result.degraded).toBe(true);
    });

    it('never throws — a provider failure resolves rather than rejects', async () => {
      const client = new MockLlmClient();
      client.enqueueError(new LlmProviderError('503'));

      await expect(
        scoreItems(ITEMS, { llmClient: client, logger: NOOP_LOGGER }),
      ).resolves.toMatchObject({
        degraded: true,
      });
    });

    it('logs one warn record naming a transport/provider failure before returning', async () => {
      const client = new MockLlmClient();
      client.enqueueError(new LlmTimeoutError('upstream timed out'));
      const logger = recordingLogger();

      await scoreItems(ITEMS, { llmClient: client, logger, trace_id: 'trace-1' });

      expect(logger.entries).toHaveLength(1);
      const [entry] = logger.entries;
      expect(entry?.level).toBe('warn');
      expect(entry?.event).toBe('mi_scoring_provider_failure');
      expect(entry?.trace_id).toBe('trace-1');
      expect(entry?.payload).toMatchObject({ items: 2, error_kind: 'transport' });
    });

    it('logs a DIFFERENT event for an unparseable answer than for a transport failure', async () => {
      const client = new MockLlmClient();
      client.enqueueText('not json at all');
      const logger = recordingLogger();

      await scoreItems(ITEMS, { llmClient: client, logger, trace_id: 'trace-2' });

      expect(logger.entries).toHaveLength(1);
      const [entry] = logger.entries;
      expect(entry?.level).toBe('warn');
      expect(entry?.event).toBe('mi_scoring_malformed_response');
      expect(entry?.event).not.toBe('mi_scoring_provider_failure');
      expect(entry?.payload).toMatchObject({ items: 2, error_kind: 'malformed_response' });
    });

    it('falls back to "unattributed" as the log trace_id when none was supplied', async () => {
      const client = new MockLlmClient();
      client.enqueueError(new LlmTimeoutError('boom'));
      const logger = recordingLogger();

      await scoreItems(ITEMS, { llmClient: client, logger });

      expect(logger.entries[0]?.trace_id).toBe('unattributed');
    });
  });

  it('sends BARE_JSON_INSTRUCTION so the model is asked not to fence, matching the rest of the debate stack', async () => {
    const client = new MockLlmClient();
    client.enqueueText(JSON.stringify({ scores: [{ index: 0, sentiment: 1, confidence: 0.8 }] }));

    await scoreItems([ITEMS[0] as ScorableItem], { llmClient: client, logger: NOOP_LOGGER });

    expect(client.requests[0]?.prompt).toContain('no markdown code fence');
  });

  it('never throws on a malformed response — resolves with the fallback instead of rejecting', async () => {
    const client = new MockLlmClient();
    client.enqueueText('```\nunterminated fence');

    await expect(
      scoreItems(ITEMS, { llmClient: client, logger: NOOP_LOGGER }),
    ).resolves.toMatchObject({
      degraded: true,
    });
  });
});
