/**
 * Comment stripping for two source-text scanners that must not trip on
 * commentary: `spec-schema-drift.test.ts` (SQL `--` comments in the spec's
 * fenced DDL) and `contracts/boundary.test.ts` (JS/TS `//` and `/* *\/`
 * comments in wire-model source).
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
 * inside a regex opens phantom string state. Two mitigations, not a fix:
 *  - `'`/`"` quote state resets at every newline (real JS syntax: those forms
 *    cannot span a raw newline), so a phantom string bounds to the one line
 *    it started on. `` ` `` is exempt — a template literal legitimately
 *    spans lines.
 *  - An unterminated block comment throws instead of silently consuming to
 *    end of input. Real, `tsc`-valid source can never have a genuinely
 *    unterminated `/*`, so reaching one here means a phantom `/*` opened on
 *    something else — surfacing it beats the alternative of a scanner that
 *    goes quiet exactly when it should be loudest.
 * A phantom block comment that happens to reach an unrelated, real `*\/`
 * later in the same file is still a silent miss — closing that needs a real
 * tokenizer. A regex-based "does this file contain a regex literal" guard
 * was tried and dropped: on this repo's own prose it flags `metrics.ts`'s
 * "Annualized return / max drawdown." (a plain doc comment) as one, which is
 * worse than the hazard it would catch. `check-path-citations.ts`'s
 * `stripToComments` (`server/tools/check-path-citations.ts`) accepts the
 * identical residual gap for the same reason, rather than building one.
 * That scanner resets quote state on every line including backtick, unlike
 * this one — noted here, not reconciled, since neither scanner's callers
 * need the other's behavior; a future edit to either should check this note
 * before assuming the two are interchangeable.
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
      // (`import`/*c*/`type`) don't fuse into one word.
      out += newlines > 0 ? '\n'.repeat(newlines) : ' ';
      i = end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
