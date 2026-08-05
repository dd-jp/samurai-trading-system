import { unwrapFencedJson } from './json-response.js';

/**
 * Captured verbatim from a live `claude-haiku-4-5-20251001` call using the
 * exact Bull-persona prompt `personas.ts` sends (issue #361 diagnostic,
 * `stop_reason: "end_turn"`, 247/1024 output tokens — a complete response,
 * not a truncation). This is the shape that halted every quorum-met tick.
 */
const CAPTURED_BULL_RESPONSE =
  '```json\n{\n  "stance": "bullish",\n  "rationale": "Despite mixed signals, the technical setup presents compelling bullish opportunities."\n}\n```';

/**
 * Captured verbatim from the same diagnostic, Mediator prompt. Note the
 * trailing prose *after* the closing fence — the mediator appends commentary
 * the schema never asked for, which is why the payload is delimited by the
 * first closing fence rather than by the end of the response.
 */
const CAPTURED_MEDIATOR_RESPONSE =
  '```json\n{\n  "stance": "neutral",\n  "rationale": "Material disagreement persists.",\n  "converged": false\n}\n```\n\n**Mediator Note:** This is a classic early recovery vs. momentum persistence clash.';

describe('unwrapFencedJson', () => {
  it('returns bare JSON unchanged', () => {
    const bare = '{"stance":"bullish","rationale":"ok"}';
    expect(unwrapFencedJson(bare)).toBe(bare);
  });

  it('unwraps the captured Bull-persona fenced block (issue #361)', () => {
    expect(JSON.parse(unwrapFencedJson(CAPTURED_BULL_RESPONSE))).toEqual({
      stance: 'bullish',
      rationale:
        'Despite mixed signals, the technical setup presents compelling bullish opportunities.',
    });
  });

  it('unwraps the captured Mediator fenced block, discarding the trailing prose (issue #361)', () => {
    expect(JSON.parse(unwrapFencedJson(CAPTURED_MEDIATOR_RESPONSE))).toEqual({
      stance: 'neutral',
      rationale: 'Material disagreement persists.',
      converged: false,
    });
  });

  it('unwraps a fence with no language tag', () => {
    expect(JSON.parse(unwrapFencedJson('```\n{"a":1}\n```'))).toEqual({ a: 1 });
  });

  it('tolerates leading/trailing whitespace around the fence', () => {
    expect(JSON.parse(unwrapFencedJson('\n  ```json\n{"a":1}\n```  \n'))).toEqual({ a: 1 });
  });

  it('leaves an UNTERMINATED fence untouched so a truncated response stays a loud failure', () => {
    // max_tokens hit mid-emit: opening fence present, closing fence never
    // arrives. Unwrapping here would hand a half-object to JSON.parse and, in
    // a laxer parser, could become a fabricated position (#288/#319).
    const truncated = '```json\n{\n  "stance": "bullish",\n  "rationale": "Momentum favo';
    expect(unwrapFencedJson(truncated)).toBe(truncated);
    expect(() => JSON.parse(unwrapFencedJson(truncated))).toThrow();
  });

  it('leaves a preamble-then-fence response untouched (only an anchored fence is tolerated)', () => {
    const preamble = 'Sure! Here is my analysis:\n```json\n{"stance":"bullish"}\n```';
    expect(unwrapFencedJson(preamble)).toBe(preamble);
    expect(() => JSON.parse(unwrapFencedJson(preamble))).toThrow();
  });

  it('leaves arbitrary prose untouched', () => {
    expect(unwrapFencedJson('I cannot help with that request.')).toBe(
      'I cannot help with that request.',
    );
  });

  it('leaves a fence whose info string is not a bare language token untouched', () => {
    const weird = '```json here is the thing\n{"a":1}\n```';
    expect(unwrapFencedJson(weird)).toBe(weird);
  });

  it('leaves a single-line fence-only response untouched', () => {
    expect(unwrapFencedJson('```')).toBe('```');
  });

  it('ignores a backtick run that is not at the start of a line when finding the close', () => {
    // The closing delimiter must begin a line; an inline ``` inside a string
    // value must not terminate the payload early.
    const inline = '```json\n{"a":"x ``` y"}\n```';
    expect(JSON.parse(unwrapFencedJson(inline))).toEqual({ a: 'x ``` y' });
  });
});
