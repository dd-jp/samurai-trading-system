import { parseAllowedUserIds } from './allowlist.js';

describe('parseAllowedUserIds', () => {
  it('parses a comma-separated list of numeric Telegram user ids', () => {
    expect([...parseAllowedUserIds('123,456')]).toEqual([123, 456]);
  });

  it('tolerates surrounding whitespace and duplicate entries', () => {
    expect([...parseAllowedUserIds(' 123 , 456 , 123 ')]).toEqual([123, 456]);
  });

  it('rejects an unset allowlist', () => {
    expect(() => parseAllowedUserIds(undefined)).toThrow(/TELEGRAM_ALLOWED_USER_IDS/);
  });

  it('rejects an empty or whitespace-only allowlist', () => {
    expect(() => parseAllowedUserIds('')).toThrow(/TELEGRAM_ALLOWED_USER_IDS/);
    expect(() => parseAllowedUserIds('   ')).toThrow(/TELEGRAM_ALLOWED_USER_IDS/);
  });

  it('rejects a wildcard with a wildcard-specific message', () => {
    expect(() => parseAllowedUserIds('*')).toThrow(/wildcard/i);
    expect(() => parseAllowedUserIds('123,*')).toThrow(/wildcard/i);
    expect(() => parseAllowedUserIds('all')).toThrow(/wildcard/i);
  });

  it('rejects non-numeric entries', () => {
    expect(() => parseAllowedUserIds('123,david')).toThrow(/non-numeric/i);
    expect(() => parseAllowedUserIds('12.5')).toThrow(/non-numeric/i);
    expect(() => parseAllowedUserIds('0x7b')).toThrow(/non-numeric/i);
  });

  it('rejects an empty entry rather than silently skipping it', () => {
    expect(() => parseAllowedUserIds('123,,456')).toThrow(/empty entry/i);
    expect(() => parseAllowedUserIds('123,')).toThrow(/empty entry/i);
  });

  it('rejects negative ids — a negative id is a chat id, not a per-user identity', () => {
    expect(() => parseAllowedUserIds('-1001234567890')).toThrow(/chat id/i);
  });

  it('rejects zero and ids beyond the safe integer range', () => {
    expect(() => parseAllowedUserIds('0')).toThrow(/positive/i);
    expect(() => parseAllowedUserIds('9007199254740993')).toThrow(/safe integer/i);
  });
});
