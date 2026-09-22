import { stripComments } from './strip-comments.js';

describe('stripComments', () => {
  it('drops a // line comment', () => {
    expect(stripComments('const x = 1; // not real\n')).toBe('const x = 1; \n');
  });

  it('drops a /* */ block comment, keeping its newlines', () => {
    expect(stripComments('const a = 1; /* start\nof comment */ const b = 2;')).toBe(
      'const a = 1; \n const b = 2;',
    );
  });

  it('does not treat // inside a string as a comment', () => {
    const src = "const url = 'https://example.com';";
    expect(stripComments(src)).toBe(src);
  });

  it('does not treat /* inside a string as a comment', () => {
    const src = "const s = '/* not a comment */';";
    expect(stripComments(src)).toBe(src);
  });

  it('does not treat // inside a template literal as a comment', () => {
    const src = 'const s = `//not a comment`;';
    expect(stripComments(src)).toBe(src);
  });

  it('an escaped quote inside a string does not end it early', () => {
    const src = "const s = 'it\\'s fine // still a string';";
    expect(stripComments(src)).toBe(src);
  });

  it('replaces a single-line block comment with a space so surrounding tokens do not fuse', () => {
    expect(stripComments('import/* c */type { X }')).toBe('import type { X }');
  });

  it('resets quote state at a newline, so an unterminated string does not swallow a later line', () => {
    const src = "const s = 'unterminated\n// real comment\nconst t = 2;";
    expect(stripComments(src)).toBe("const s = 'unterminated\n\nconst t = 2;");
  });

  it('throws on an unterminated block comment — real source can never have one', () => {
    expect(() => stripComments('const a = 1; /* never closed')).toThrow(/unterminated/i);
  });
});
