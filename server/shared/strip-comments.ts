export function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

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

function stepLineComment(source: string, i: number): number {
  const nl = source.indexOf('\n', i);
  return nl === -1 ? source.length : nl;
}

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
  return { nextIndex: end + 2, appended: newlines > 0 ? '\n'.repeat(newlines) : ' ' };
}

export function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  let i = 0;
  while (i < source.length) {
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
