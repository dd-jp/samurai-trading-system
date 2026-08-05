/**
 * Markdown-fence tolerance for LLM JSON responses (issue #361).
 *
 * Every debate persona asks the model for JSON and then calls `JSON.parse`
 * on the raw text. Against the pinned `claude-haiku-4-5-20251001` the model
 * reliably wraps that JSON in a markdown code fence, so the parse threw
 * `LlmMalformedResponseError` on every quorum-met tick and the pipeline
 * halted at `stage=debate`. Captured verbatim from a live one-shot call with
 * the exact Bull-persona prompt (`stop_reason: "end_turn"`, 247/1024 output
 * tokens — a complete response, not a truncation):
 *
 *     ```json
 *     {
 *       "stance": "bullish",
 *       "rationale": "..."
 *     }
 *     ```
 *
 * `personas.ts` now also tells the model not to fence, but a prompt
 * instruction is a request, not a guarantee — this is the deterministic half
 * of the fix.
 *
 * Scope is deliberately narrow: this tolerates ONE shape — a response that
 * *begins* with a fence and contains a closing fence at the start of a later
 * line. It is not a "find some JSON in this prose" extractor. That boundary
 * is the whole point: a refusal, a preamble, or a response truncated mid-emit
 * must stay a loud `LlmMalformedResponseError` rather than degrade into a
 * fabricated debate position feeding a live-money pipeline (the #288/#319
 * failure family). Specifically:
 *
 * - Preamble before the fence  -> returned unchanged -> parse throws.
 * - Opening fence, no closing  -> returned unchanged -> parse throws. This is
 *   exactly what a `max_tokens` truncation looks like.
 * - Anything not starting with a fence -> returned unchanged.
 *
 * Content *after* the closing fence is discarded. That is not incidental: the
 * mediator was observed appending a free-text "Mediator Note:" paragraph
 * after the closing fence. The JSON object is complete and self-delimiting at
 * that point, and the trailing commentary is outside the requested schema, so
 * dropping it loses nothing the callers model.
 */

/**
 * The cooperative half of the #361 fix: the instruction every prompt that
 * expects a JSON reply appends, asking the model not to emit the fence (or the
 * trailing commentary the mediator was observed adding after it).
 *
 * It lives here, next to `unwrapFencedJson`, because the two are one fix seen
 * from both ends — this asks the model not to fence, that one copes when it
 * fences anyway. Same posture as `prompt-safety.ts`'s `wrapUntrusted`: shared
 * prompt text belongs in `llm/`, not hand-copied into each caller.
 *
 * Single definition on purpose (PR #363 review). It was briefly duplicated
 * across `personas.ts`, `disagreement-detector.ts`, and the persona test; only
 * one of those copies was pinned by an assertion, so the others could have
 * drifted silently — and a prompt that quietly stops asking for bare JSON
 * reintroduces the very halt this module exists to prevent.
 */
export const BARE_JSON_INSTRUCTION = [
  'Output the raw JSON object only: no markdown code fence, no ``` characters,',
  'no preamble, and no commentary after the closing brace.',
].join('\n');

const FENCE = '```';

/** Bare info strings only (```json, ```JSON, ```). Anything else isn't a plain fenced block. */
const BARE_INFO_STRING = /^[A-Za-z0-9_+-]*$/;

/**
 * Index of the first `FENCE` that begins a line, or -1. Requiring a line
 * start means a literal ``` inside a JSON string value cannot terminate the
 * payload early.
 */
function findClosingFence(body: string): number {
  let searchFrom = 0;
  while (searchFrom <= body.length) {
    const index = body.indexOf(FENCE, searchFrom);
    if (index === -1) {
      return -1;
    }
    if (index === 0 || body[index - 1] === '\n') {
      return index;
    }
    searchFrom = index + FENCE.length;
  }
  return -1;
}

/**
 * Returns the JSON payload of a markdown-fenced response, or `rawText`
 * unchanged when it is not a well-formed fenced block. Never throws — the
 * caller's `JSON.parse` remains the single place a malformed response fails.
 */
export function unwrapFencedJson(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith(FENCE)) {
    return rawText;
  }

  const openingLineEnd = trimmed.indexOf('\n');
  if (openingLineEnd === -1) {
    return rawText;
  }

  const infoString = trimmed.slice(FENCE.length, openingLineEnd).trim();
  if (!BARE_INFO_STRING.test(infoString)) {
    return rawText;
  }

  const body = trimmed.slice(openingLineEnd + 1);
  const closingFence = findClosingFence(body);
  if (closingFence === -1) {
    // Unterminated fence — a truncated response. Hand back the original so it
    // fails loudly rather than parsing a half-emitted object.
    return rawText;
  }

  return body.slice(0, closingFence);
}
