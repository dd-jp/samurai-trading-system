/**
 * The two halves of #1115's enforcement.
 *
 * PRESENCE is the compiler's job: `LogEntry` is a union on `level`, so a
 * `warn`/`error` line with no `event` does not type-check. The
 * `@ts-expect-error` block below is what makes that testable — relax the
 * union and the suppressions become unused, which `npm run typecheck` reports as
 * an error. It fails in `tsc -p tsconfig.test.json`, not in `vitest`.
 *
 * SPELLING is this file's runtime half. `LogEventCode` is deliberately not a
 * union of every code (see its doc comment), so nothing stops a call site
 * writing `event: \`refresh_${instrument}\`` or `event: 'tokenBucketWait'` —
 * both would type-check and both would break the grep the field exists for.
 * The scan below is what closes that.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogEntry } from './primitives.js';

/** A real no-op, not a `declare`: these probes are compiled AND run */
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

/**
 * Property assignments only. The leading `{` or start-of-line is what keeps
 * parameter declarations (`safeAlert(alert, event: FailoverEvent)`,
 * `on(event: 'error', …)`) out — they follow a `(` or a `, ` on the same
 * line. Two shapes survive that filter and are excluded by value: a union
 * type annotation broken onto its own line (`index.ts`'s
 * `event: 'uncaughtException' | 'unhandledRejection',`), and the `event:
 * LogEventCode` parameter of the four helpers that take a code and build the
 * entry themselves. Every OTHER non-literal — an interpolated template, a
 * variable — is meant to fail here.
 */
const EVENT_ASSIGNMENT = /(?:^[ \t]*|\{[ \t]*)event: ([^,\n]*)/gm;
const SNAKE_CASE_LITERAL = /^'[a-z][a-z0-9]*(?:_[a-z0-9]+)+'$/;

/**
 * A floor, so a scan that matched nothing (a regex broken by a formatting
 * change, a moved source root) fails loudly instead of passing vacuously.
 * 160 assignments reached the value check when #1115 landed — 165 raw
 * matches, less the excluded shapes named above.
 *
 * Codes passed as a HELPER ARGUMENT rather than written as a property —
 * `degradationLine('log_sinks_exhausted', …)` and the four helpers that take
 * a code and build the entry themselves — are outside this scan by
 * construction. The compiler still requires them (the parameter is not
 * optional); only their spelling is unchecked.
 */
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
