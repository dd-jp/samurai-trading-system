/**
 * Comment stripping for two source-text scanners that must not trip on
 * commentary: `spec-schema-drift.test.ts` (SQL `--` comments in the spec's
 * fenced DDL) and `contracts/boundary.test.ts` (JS/TS `//` and `/* *\/`
 * comments in wire-model source)
 */

/** Drops everything from `--` to end of line. No block-comment form in SQL DDL. */
export function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * Drops `//...` and `/* ... *\/` outside of string/template literals, so a
 * quoted value containing either sequence (a URL, say) survives intact.
 *
 * Not aware of regex literals: `/a\/*b/` opens a phantom block comment (its
 * `\/*` reads as the block-comment start), and an unescaped quote character
 * inside a regex opens phantom string state. Mitigated, not fixed:
 *  - `'`/`"` quote state resets at every newline (real JS syntax: those forms
 *    cannot span a raw newline), so a phantom string bounds to the one line
 *    it started on. `` ` `` is exempt — a template literal legitimately
 *    spans lines. `stripToComments` (`server/tools/check-path-citations.ts`)
 *    resets on every line including backtick; the two differ because neither
 *    scanner's callers need the other's behavior.
 *  - An unterminated block comment throws — but only when the source has no
 *    later `*\/` at all. A phantom `/*` that reaches an unrelated, real `*\/`
 *    further down (the next JSDoc block, say) closes "successfully" and
 *    silently swallows everything in between, including a real import; this
 *    throw does not catch that, only the rarer no-later-`*\/` case. Closing
 *    that gap needs a real tokenizer. `specifiersOf` in
 *    `contracts/boundary.test.ts` instead checks the property it actually
 *    depends on directly, on its own output — see the comment there.
 */
/** One step inside a `'`/`"`/`` ` `` literal: how much of `source` to consume and append */
function stepQuoted(
  source: string,
  i: number,
  ch: string,
  quote: string,
): { nextIndex: number; appended: string; quoteAfter: string | null } {
  if (ch === '\n' && quote !== '`') {
    return { nextIndex: i + 1, appended: ch, quoteAfter: null };
  }
  if (ch === '\\' && i + 1 < source.length) {
    return { nextIndex: i + 2, appended: ch + source[i + 1], quoteAfter: quote };
  }
  return { nextIndex: i + 1, appended: ch, quoteAfter: ch === quote ? null : quote };
}

/** `//` runs to end of line (or end of source); nothing here is appended to the output */
function stepLineComment(source: string, i: number): number {
  const nl = source.indexOf('\n', i);
  return nl === -1 ? source.length : nl;
}

/**
 * `/* ... *\/`, throwing on the unterminated case — see `stripComments`'s doc
 * comment for what this throw does and does not catch.
 */
function stepBlockComment(source: string, i: number): { nextIndex: number; appended: string } {
  const end = source.indexOf('*/', i + 2);
  if (end === -1) {
    throw new Error(
      "stripComments: unterminated '/*' — valid source can't have one, so this is almost " +
        'certainly a regex literal (or similar) mis-parsed as a comment opener.',
    );
  }
  const removed = source.slice(i + 2, end);
  const newlines = removed.split('\n').length - 1;
  // A comment spanning lines leaves its newlines in place, so a `^`-anchored
  // pattern still sees the same line breaks around it; a single-line comment
  // leaves a space instead of nothing, so the tokens on either side of it
  // (`import`/*c*/`type`) don't fuse into one word
  return { nextIndex: end + 2, appended: newlines > 0 ? '\n'.repeat(newlines) : ' ' };
}

export function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  let i = 0;
  while (i < source.length) {
    // `noUncheckedIndexedAccess` types this `string | undefined`; the loop
    // bound above guarantees it's defined
    const ch = source[i] as string;
    if (quote) {
      const step = stepQuoted(source, i, ch, quote);
      out += step.appended;
      i = step.nextIndex;
      quote = step.quoteAfter;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i = stepLineComment(source, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const step = stepBlockComment(source, i);
      out += step.appended;
      i = step.nextIndex;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
