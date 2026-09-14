import { createHash } from 'node:crypto';
import { hashPromptTemplate } from './prompt-template-hash.js';

describe('hashPromptTemplate', () => {
  it('returns the sha256 hex digest of the template text', () => {
    const template = 'You are the Bull persona.';
    expect(hashPromptTemplate(template)).toBe(
      createHash('sha256').update(template, 'utf8').digest('hex'),
    );
  });

  it('is stable across calls for the same text', () => {
    expect(hashPromptTemplate('same text')).toBe(hashPromptTemplate('same text'));
  });

  it('differs when the template text differs by even one character', () => {
    expect(hashPromptTemplate('You are the Bull persona.')).not.toBe(
      hashPromptTemplate('You are the Bull persona!'),
    );
  });
});
