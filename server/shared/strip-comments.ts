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
export function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === '\n' && quote !== '`') {
        quote = null;
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      if (ch === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 2;
      } else {
        if (ch === quote) quote = null;
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
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
      out += newlines > 0 ? '\n'.repeat(newlines) : ' ';
      i = end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
