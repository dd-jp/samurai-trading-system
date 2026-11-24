import { MEDIATOR_LESSONS_TEMPLATE_HASH } from '../../shared/debate/index.js';
import { digest } from '../../shared/index.js';
import { hashPromptTemplate } from '../../shared/llm/index.js';

export const LESSON_BOOK_ID = 'debate/primary';
export const LESSONS_SCHEMA_VERSION = 1;
export const MAX_CLAIM_CHARS = 280;
export const LESSONS_PER_PROMPT = 3;

export const LESSON_PROMPT_TEMPLATE = `You write short lessons for a daily swing-trading debate from statistics over its settled trades. Each bucket groups the trades that share one tag. mean_excess is the mean return against the venue's index, net of the trade's direction; ci is a bootstrap 95% interval on that mean; hit_rate is the share of trades that beat the index; arm2_mean_excess is the no-LLM control's mean on the same tag, or on all its trades for a tag it does not have.

Write at most one lesson per bucket, and only for a bucket whose interval excludes zero or whose mean differs clearly from arm 2's. Each claim is one plain sentence of at most ${MAX_CLAIM_CHARS} characters that states only what the numbers show and quotes no number that is not in its bucket. Answer with JSON only, in the form {"lessons":[{"bucket":"<the bucket exactly as given>","claim":"<sentence>"}]}. An empty list is a valid answer.

Buckets:
`;

export function newsBand(headlines: unknown): string {
  if (typeof headlines !== 'number' || headlines === 0) return '0';
  return headlines < 5 ? '1-4' : '5+';
}

// G11 ruling 8 (David 2026-11-24): a change to how lessons are written or shown to the judge is a
// new trial for the lessons book, so this joins its pin digest
export const LESSONS_RECIPE_HASH = digest({
  distil_prompt: hashPromptTemplate(LESSON_PROMPT_TEMPLATE),
  judge_prompt: MEDIATOR_LESSONS_TEMPLATE_HASH,
  schema_version: LESSONS_SCHEMA_VERSION,
  per_prompt: LESSONS_PER_PROMPT,
});
