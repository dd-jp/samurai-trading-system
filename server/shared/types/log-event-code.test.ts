import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogEntry } from './primitives.js';

const log = (_entry: LogEntry): void => undefined;
const dynamic: boolean = true;

describe('LogEntry requires an event code wherever the level can be warn or error', () => {
  it('accepts an info or debug line with no event', () => {
    const accepted: LogEntry[] = [
      { trace_id: 't', stage: 'orchestrator', level: 'info', message: 'started' },
      { trace_id: 't', stage: 'orchestrator', level: 'debug', message: 'considered' },
    ];
    expect(accepted).toHaveLength(2);
  });

  it('rejects a warn or error line with no event, and a computed level with no event', () => {
    // @ts-expect-error a `warn` line must carry an event code (#1115)
    log({ trace_id: 't', stage: 'orchestrator', level: 'warn', message: 'degraded' });
    // @ts-expect-error an `error` line must carry an event code (#1115)
    log({ trace_id: 't', stage: 'orchestrator', level: 'error', message: 'failed' });
    // @ts-expect-error a level that MAY come out `warn` must carry an event code (#1115)
    log({
      trace_id: 't',
      stage: 'orchestrator',
      level: dynamic ? 'warn' : 'info',
      message: 'maybe degraded',
    });

    log({
      trace_id: 't',
      stage: 'orchestrator',
      event: 'tick_failed',
      level: dynamic ? 'warn' : 'info',
      message: 'maybe degraded',
    });
    expect(true).toBe(true);
  });
});

const SERVER_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, child.name);
    if (child.isDirectory()) {
      if (child.name === 'node_modules') continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (child.name.endsWith('.ts') && !child.name.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

const EVENT_ASSIGNMENT = /(?:^[ \t]*|\{[ \t]*)event: ([^,\n]*)/gm;
const SNAKE_CASE_LITERAL = /^'[a-z][a-z0-9]*(?:_[a-z0-9]+)+'$/;

const MINIMUM_EVENT_ASSIGNMENTS = 140;

describe('every logged event code is a stable snake_case literal', () => {
  const assignments = sourceFiles(SERVER_ROOT).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(EVENT_ASSIGNMENT)]
      .map((match) => ({ file, value: (match[1] ?? '').trim() }))
      .filter(
        (assignment) => !assignment.value.includes('|') && assignment.value !== 'LogEventCode',
      );
  });

  it('finds the event assignments at all', () => {
    expect(assignments.length).toBeGreaterThanOrEqual(MINIMUM_EVENT_ASSIGNMENTS);
  });

  it('spells every one as a snake_case string literal of two or more segments', () => {
    const malformed = assignments
      .filter((assignment) => !SNAKE_CASE_LITERAL.test(assignment.value))
      .map((assignment) => `${assignment.file}: ${assignment.value}`);
    expect(malformed).toEqual([]);
  });
});
