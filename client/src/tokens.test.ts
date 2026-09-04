/**
 * The stylesheet contract between `tokens.css` and `App.css` (PR #607 review
 * round 2).
 *
 * `App.css` writes its glows and washes as `rgb(var(--cyan-rgb) / 0.06)`, which
 * is only valid while `--cyan-rgb` holds SPACE-separated channels (`56 225
 * 255`). Rewrite one as `56, 225, 255` — the form every other CSS example on
 * the internet uses — and the declaration becomes invalid at computed-value
 * time: no build error, no console warning, no failing test anywhere else. The
 * colour simply vanishes from the page, on an operator surface whose whole
 * design rule is that a missing signal must never look like a present one.
 *
 * These assertions are the loud failure that CSS does not give us. They read
 * the two stylesheets as text rather than through a DOM, because the property
 * under test is what is WRITTEN — jsdom does not implement computed-value-time
 * validation, so a broken triplet would round-trip through it unnoticed.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Read relative to THIS FILE, so the suite does not depend on the cwd, and
 * strip comments: both stylesheets QUOTE the forms under test in prose — the
 * App.css header names `rgba(56, 225, 255, 0.06)` as the shape it replaced —
 * and a rule that cannot tell an example from a declaration would either fail
 * on documentation or force the documentation to stop being specific.
 */
function read(name: string): string {
  return readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

const TOKENS = read('./tokens.css');
const APP = read('./App.css');

/** `--x-rgb: <value>;` declarations, as [name, value] pairs. */
function channelDeclarations(css: string): [string, string][] {
  return [...css.matchAll(/(--[a-z-]+-rgb):\s*([^;]+);/g)].map((m) => [
    m[1] as string,
    (m[2] as string).trim(),
  ]);
}

/** Every `--x-rgb` a stylesheet REFERENCES, however it is referenced. */
function channelReferences(css: string): Set<string> {
  return new Set([...css.matchAll(/var\((--[a-z-]+-rgb)\)/g)].map((m) => m[1] as string));
}

describe('colour channel tokens', () => {
  const declared = channelDeclarations(TOKENS);

  it('declares every channel token as three space-separated 0-255 integers', () => {
    // Not a loose "contains three numbers" check: the comma form is exactly
    // the mistake this test exists to catch, so the pattern rejects it.
    expect(declared.length).toBeGreaterThan(0);
    for (const [name, value] of declared) {
      expect(`${name}: ${value}`).toMatch(/^--[a-z-]+-rgb: \d{1,3} \d{1,3} \d{1,3}$/);
      for (const channel of value.split(' ')) {
        expect(Number(channel)).toBeGreaterThanOrEqual(0);
        expect(Number(channel)).toBeLessThanOrEqual(255);
      }
    }
  });

  it('declares every channel token that either stylesheet references', () => {
    // A reference to an undeclared token is the same silent failure by another
    // route: `var(--typo-rgb)` resolves to nothing and the declaration drops.
    const names = new Set(declared.map(([name]) => name));
    for (const referenced of [...channelReferences(TOKENS), ...channelReferences(APP)]) {
      expect(names.has(referenced)).toBe(true);
    }
  });

  it('uses the slash form everywhere a channel token carries an alpha', () => {
    // `rgb(var(--cyan-rgb), 0.06)` parses as legacy rgb() with too few
    // arguments and is dropped just as quietly as a comma-separated triplet.
    for (const match of APP.matchAll(/rgb\(var\((--[a-z-]+-rgb)\)([^)]*)\)/g)) {
      const tail = (match[2] as string).trim();
      expect(tail === '' || /^\/ [0-9.]+$/.test(tail)).toBe(true);
    }
  });

  it('leaves no palette colour written as a raw rgba() triple in App.css', () => {
    // The single-sourcing this refactor bought: a palette change is one edit in
    // tokens.css. Black drop shadows and the one opaque chip background have no
    // token counterpart and are listed explicitly rather than pattern-excused,
    // so adding a new literal fails here instead of quietly growing the set.
    const literals = [...APP.matchAll(/rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}),[^)]*\)/g)].map(
      (m) => `${m[1]} ${m[2]} ${m[3]}`,
    );
    // v3 writes every colour through a token; the allow-list is what an
    // earlier stylesheet needed for shadows and is kept so a future literal
    // has to be argued in here rather than slipped in.
    for (const literal of literals) {
      expect(['0 0 0', '13 20 38']).toContain(literal);
    }
  });
});
