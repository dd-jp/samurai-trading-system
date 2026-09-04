import { describe, expect, it } from 'vitest';
import { capOutboundText, TELEGRAM_MAX_MESSAGE_CHARS } from './telegram-bot-api-client.js';

describe('capOutboundText (#1087 follow-up: 400 "message is too long")', () => {
  it('leaves a message that already fits completely untouched', () => {
    const text = 'Samurai TRADER DEGRADED: NFLX reported atr_not_finite.';
    expect(capOutboundText(text)).toBe(text);
  });

  it('leaves a message of exactly the limit untouched', () => {
    const text = 'x'.repeat(TELEGRAM_MAX_MESSAGE_CHARS);
    expect(capOutboundText(text)).toBe(text);
  });

  /**
   * The whole defect in one assertion: a cap that slices to the limit and
   * then appends a suffix still exceeds the limit, still 400s, and still
   * never delivers.
   */
  it('produces a result within the limit, suffix included', () => {
    const capped = capOutboundText('x'.repeat(10_000));
    expect(capped.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
  });

  it('says how much was dropped, so the reader knows to go to the log', () => {
    const capped = capOutboundText('x'.repeat(10_000));
    expect(capped).toContain('truncated, 10000 chars total');
  });

  it('keeps the head, where the alert states what happened', () => {
    const capped = capOutboundText(`Samurai TRADER DEGRADED: NFLX${'x'.repeat(10_000)}`);
    expect(capped.startsWith('Samurai TRADER DEGRADED: NFLX')).toBe(true);
  });

  it('never splits a surrogate pair — a lone high surrogate is not valid UTF-8 on the wire', () => {
    // '📈' is one astral code point, two UTF-16 code units. Repeating it to
    // straddle the cut point lands the boundary mid-pair on some offsets.
    for (let pad = 0; pad < 4; pad += 1) {
      const capped = capOutboundText(`${'a'.repeat(pad)}${'📈'.repeat(6000)}`);
      expect(capped.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
      expect(Buffer.from(capped, 'utf8').toString('utf8')).toBe(capped);
    }
  });

  it('degrades to a hard slice when the limit cannot even hold the suffix', () => {
    const capped = capOutboundText('x'.repeat(500), 10);
    expect(capped).toHaveLength(10);
  });
});
