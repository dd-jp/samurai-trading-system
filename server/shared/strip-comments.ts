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
 * Not aware of regex literals — a `/.../ ` containing `//` or `/*` would be
 * misread as a comment starting mid-pattern. Contracts source today has no
 * regex literals; re-check this note if that ever changes.
 */
export function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
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
      const removed = end === -1 ? source.slice(i + 2) : source.slice(i + 2, end);
      // Keep only the newlines from the removed span — a caller matching a
      // `^`-anchored pattern must still see the same line breaks around the
      // comment, not code before and after it merged onto one line.
      for (const c of removed) if (c === '\n') out += '\n';
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
