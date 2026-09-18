export const BARE_JSON_INSTRUCTION = [
  'Output the raw JSON object only: no markdown code fence, no ``` characters,',
  'no preamble, and no commentary after the closing brace.',
].join('\n');

const FENCE = '```';

const BARE_INFO_STRING = /^[A-Za-z0-9_+-]*$/;

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
    return rawText;
  }

  return body.slice(0, closingFence);
}
