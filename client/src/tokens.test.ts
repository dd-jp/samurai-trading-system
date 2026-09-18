
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(name: string): string {
  return readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

const TOKENS = read('./tokens.css');
const APP = read('./App.css');

function channelDeclarations(css: string): [string, string][] {
  return [...css.matchAll(/(--[a-z-]+-rgb):\s*([^;]+);/g)].map((m) => [
    m[1] as string,
    (m[2] as string).trim(),
  ]);
}

function channelReferences(css: string): Set<string> {
  return new Set([...css.matchAll(/var\((--[a-z-]+-rgb)\)/g)].map((m) => m[1] as string));
}

describe('colour channel tokens', () => {
  const declared = channelDeclarations(TOKENS);

  it('declares every channel token as three space-separated 0-255 integers', () => {
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
    const names = new Set(declared.map(([name]) => name));
    for (const referenced of [...channelReferences(TOKENS), ...channelReferences(APP)]) {
      expect(names.has(referenced)).toBe(true);
    }
  });

  it('uses the slash form everywhere a channel token carries an alpha', () => {
    for (const match of APP.matchAll(/rgb\(var\((--[a-z-]+-rgb)\)([^)]*)\)/g)) {
      const tail = (match[2] as string).trim();
      expect(tail === '' || /^\/ [0-9.]+$/.test(tail)).toBe(true);
    }
  });

  it('leaves no palette colour written as a raw rgba() triple in App.css', () => {
    const literals = [...APP.matchAll(/rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}),[^)]*\)/g)].map(
      (m) => `${m[1]} ${m[2]} ${m[3]}`,
    );
    for (const literal of literals) {
      expect(['0 0 0', '13 20 38']).toContain(literal);
    }
  });
});
