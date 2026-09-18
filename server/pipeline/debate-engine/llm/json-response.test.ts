import { BARE_JSON_INSTRUCTION, unwrapFencedJson } from './json-response.js';

const CAPTURED_BULL_RESPONSE =
  '```json\n{\n  "stance": "bullish",\n  "rationale": "Despite mixed signals, the technical setup presents compelling bullish opportunities."\n}\n```';

const CAPTURED_MEDIATOR_RESPONSE =
  '```json\n{\n  "stance": "neutral",\n  "rationale": "Material disagreement persists.",\n  "converged": false\n}\n```\n\n**Mediator Note:** This is a classic early recovery vs. momentum persistence clash.';

describe('BARE_JSON_INSTRUCTION', () => {
  it('asks for bare JSON: no fence, no preamble, no trailing commentary', () => {
    expect(BARE_JSON_INSTRUCTION).toContain('no markdown code fence');
    expect(BARE_JSON_INSTRUCTION).toContain('```');
    expect(BARE_JSON_INSTRUCTION).toContain('no preamble');
    expect(BARE_JSON_INSTRUCTION).toContain('no commentary after the closing brace');
  });
});

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
    const inline = '```json\n{"a":"x ``` y"}\n```';
    expect(JSON.parse(unwrapFencedJson(inline))).toEqual({ a: 'x ``` y' });
  });
});
