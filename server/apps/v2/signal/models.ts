import { createHash } from 'node:crypto';

export type DebaterSeat = 'sonnet' | 'gpt' | 'deepseek';

export interface ModelPin {
  readonly seat: DebaterSeat | 'judge';
  readonly wire: string;
  readonly priced: string;
  readonly canonicalSlug: string | undefined;
}

export const SONNET_5_PIN: ModelPin = {
  seat: 'sonnet',
  wire: 'anthropic/claude-sonnet-5',
  priced: 'anthropic/claude-sonnet-5',
  // Nous lists this id under a dated or an undated canonical_slug from one fetch to the next; David accepted the undetected-swap gap (doc 66, #1787)
  canonicalSlug: undefined,
};

const GPT_5_5_PIN: ModelPin = {
  seat: 'gpt',
  wire: 'openai/gpt-5.5',
  priced: 'openai/gpt-5.5',
  canonicalSlug: 'openai/gpt-5.5-20260423',
};

export const DEEPSEEK_V4_PRO_PIN: ModelPin = {
  seat: 'deepseek',
  wire: 'deepseek/deepseek-v4-pro-0813',
  priced: 'deepseek/deepseek-v4-pro-0813',
  canonicalSlug: 'deepseek/deepseek-v4-pro-20260813',
};

export const JUDGE_PIN: ModelPin = {
  seat: 'judge',
  wire: 'anthropic/claude-opus-5.5',
  priced: 'anthropic/claude-opus-5.5',
  canonicalSlug: 'anthropic/claude-opus-5.5-20260921',
};

export const DEBATER_PINS: readonly ModelPin[] = [SONNET_5_PIN, GPT_5_5_PIN, DEEPSEEK_V4_PRO_PIN];

export const ALL_PINS: readonly ModelPin[] = [...DEBATER_PINS, JUDGE_PIN];

// David 2026-10-10 (#1747): the configured slug only, since an observed one flips (#1787)
export function pinDigest(pins: readonly ModelPin[]): string {
  const keyed = [...pins]
    .sort((a, b) => a.seat.localeCompare(b.seat))
    .map(({ seat, wire, canonicalSlug }) => ({ seat, wire, canonicalSlug: canonicalSlug ?? null }));
  return createHash('sha256').update(JSON.stringify(keyed)).digest('hex').slice(0, 16);
}

export const DEBATER_MAX_TOKENS = 1024;
export const JUDGE_MAX_TOKENS = 2048;
