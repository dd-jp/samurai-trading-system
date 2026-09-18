import { createHash } from 'node:crypto';

export function hashPromptTemplate(template: string): string {
  return createHash('sha256').update(template, 'utf8').digest('hex');
}
