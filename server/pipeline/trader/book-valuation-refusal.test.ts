import { describe, expect, it } from 'vitest';
import { BookValuationError } from '../risk-manager/index.js';
import { isBookValuationRefusal } from './decide.js';

class TestValuationError extends BookValuationError {}

describe('isBookValuationRefusal', () => {
  it.each([
    ['a single valuation error', new TestValuationError('stale mark'), true],
    [
      'an aggregate of only valuation errors',
      new AggregateError([new TestValuationError('a'), new TestValuationError('b')]),
      true,
    ],
    ['an empty aggregate', new AggregateError([]), false],
    [
      'an aggregate with any other error',
      new AggregateError([new TestValuationError('a'), new Error('b')]),
      false,
    ],
    ['any other error', new Error('boom'), false],
    ['a thrown non-error', 'boom', false],
  ])('reads %s as %s', (_label, error, refused) => {
    expect(isBookValuationRefusal(error)).toBe(refused);
  });
});
