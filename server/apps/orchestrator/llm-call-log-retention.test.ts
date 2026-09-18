import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_LLM_CALL_ROWS } from '../../shared/store/index.js';
import {
  ENV_LLM_CALL_LOG_MAX_ROWS,
  llmCallLogMaxRowsFromEnvironment,
} from './production/environment.js';

describe('llmCallLogMaxRowsFromEnvironment', () => {
  it('defaults to the shipped ceiling when unset', () => {
    expect(llmCallLogMaxRowsFromEnvironment(undefined)).toBe(DEFAULT_MAX_LLM_CALL_ROWS);
  });

  it('accepts an operator override', () => {
    expect(llmCallLogMaxRowsFromEnvironment('250')).toBe(250);
    expect(llmCallLogMaxRowsFromEnvironment(' 250 ')).toBe(250);
  });

  it('treats whitespace as unset rather than as zero', () => {
    expect(llmCallLogMaxRowsFromEnvironment('   ')).toBe(DEFAULT_MAX_LLM_CALL_ROWS);
    expect(llmCallLogMaxRowsFromEnvironment('')).toBe(DEFAULT_MAX_LLM_CALL_ROWS);
  });

  it('refuses a malformed value instead of defaulting', () => {
    expect(() => llmCallLogMaxRowsFromEnvironment('lots')).toThrow(
      /SAMURAI_LLM_CALL_LOG_MAX_ROWS must be an integer/,
    );
    expect(() => llmCallLogMaxRowsFromEnvironment('12.5')).toThrow(/must be an integer/);
    expect(() => llmCallLogMaxRowsFromEnvironment('-1')).toThrow(/must be an integer/);
  });

  it('refuses zero, which the file sink accepts for its own setting', () => {
    expect(() => llmCallLogMaxRowsFromEnvironment('0')).toThrow(/must be an integer >= 1/);
  });

  it('names the variable an operator has to fix', () => {
    expect(ENV_LLM_CALL_LOG_MAX_ROWS).toBe('SAMURAI_LLM_CALL_LOG_MAX_ROWS');
    expect(() => llmCallLogMaxRowsFromEnvironment('nope')).toThrow(/row ceiling \(#1045\)/);
  });
});

describe('the llm_call_log prune is spelled at the composition root, in full', () => {
  const source = readFileSync(fileURLToPath(new URL('./production.ts', import.meta.url)), 'utf8');

  const callSite = (trigger: string): RegExp =>
    new RegExp(
      `pruneLlmCallLogWithLog\\(\\s*config\\.db,\\s*llmCallLogMaxRows,\\s*logger,\\s*'${trigger}',?\\s*\\)`,
    );

  it('names both triggers, startup and daily, not one place only', () => {
    expect(source).toMatch(callSite('startup'));
    expect(source).toMatch(callSite('daily'));
  });

  it('spells the sweep through the owning stage rather than a raw handle', () => {
    expect(source).toMatch(/pruneLlmCallLog\(\s*guardedStore\(db, 'debate-engine'\)/);
  });

  it('spells the daily prune ABOVE the feedback cycle try block', () => {
    const cycleStart = source.indexOf('const runFeedbackCycle =');
    expect(cycleStart).toBeGreaterThan(-1);

    const dailyPrune = source.slice(cycleStart).search(callSite('daily'));
    const firstTry = source.slice(cycleStart).indexOf('try {');

    expect(dailyPrune).toBeGreaterThan(-1);
    expect(dailyPrune).toBeLessThan(firstTry);
  });
});
