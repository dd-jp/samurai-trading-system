import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertDbPathExists,
  classifyRows,
  type DebateLogTerminationRow,
  formatClassificationReport,
  isCovered,
  type LogCoverage,
  parseLatencyTruncatedDebateIds,
  parseLogCoverage,
  parseLogPaths,
  summarizeClassification,
} from './classify-debate-termination.js';

describe('parseLatencyTruncatedDebateIds', () => {
  it('extracts debate_id from debate.timeout lines', () => {
    const lines = [
      JSON.stringify({
        message: 'debate.timeout',
        payload: { debate_id: 'debate-1', elapsed_ms: 60003, budget_ms: 60000 },
      }),
    ];

    expect(parseLatencyTruncatedDebateIds(lines)).toEqual(new Set(['debate-1']));
  });

  it('ignores every other message', () => {
    const lines = [
      JSON.stringify({ message: 'debate.output', payload: { debate_id: 'debate-1' } }),
      JSON.stringify({ message: 'debate.latency', payload: { debate_id: 'debate-2' } }),
    ];

    expect(parseLatencyTruncatedDebateIds(lines)).toEqual(new Set());
  });

  it('ignores malformed/non-JSON lines rather than throwing', () => {
    const lines = [
      'not json at all',
      '{"truncated": tr', // torn line, e.g. a restart mid-write
      JSON.stringify({ message: 'debate.timeout', payload: { debate_id: 'debate-1' } }),
      '',
      '   ',
    ];

    expect(parseLatencyTruncatedDebateIds(lines)).toEqual(new Set(['debate-1']));
  });

  it('collects every timeout debate_id across multiple lines', () => {
    const lines = [
      JSON.stringify({ message: 'debate.timeout', payload: { debate_id: 'debate-1' } }),
      JSON.stringify({ message: 'debate.timeout', payload: { debate_id: 'debate-2' } }),
    ];

    expect(parseLatencyTruncatedDebateIds(lines)).toEqual(new Set(['debate-1', 'debate-2']));
  });
});

function timeoutLine(debate_id: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    message: 'debate.timeout',
    payload: { debate_id, elapsed_ms: 60003, budget_ms: 60000 },
  });
}

function otherLine(timestamp: string, message = 'debate.round'): string {
  return JSON.stringify({ timestamp, message, payload: {} });
}

/** A startup-stage log line — `JsonLogger`'s `trace_id: 'startup'` convention. */
function bootLine(timestamp: string): string {
  return JSON.stringify({
    timestamp,
    trace_id: 'startup',
    message: 'orchestrator store opened',
    payload: {},
  });
}

describe('parseLogCoverage', () => {
  it('builds one span from consecutive well-formed, timestamped lines', () => {
    const lines = [
      otherLine('2026-09-03T13:00:00.000Z'),
      otherLine('2026-09-03T13:05:00.000Z'),
      timeoutLine('debate-1', '2026-09-03T13:10:00.000Z'),
    ];

    const coverage = parseLogCoverage(lines);

    expect(coverage.timeoutIds).toEqual(new Set(['debate-1']));
    expect(coverage.intervals).toEqual([
      { start: '2026-09-03T13:00:00.000Z', end: '2026-09-03T13:10:00.000Z' },
    ]);
  });

  /**
   * #1081 code review, finding 1: a torn line must not let coverage bridge
   * across the gap it represents — the debates that fell in that gap are not
   * something this log can vouch for either way.
   */
  it('closes the current span at a torn (unparseable) line rather than bridging across it', () => {
    const lines = [
      otherLine('2026-09-03T13:00:00.000Z'),
      otherLine('2026-09-03T13:05:00.000Z'),
      '{"timestamp": "2026-09-03T13:07', // torn line — a restart mid-write
      otherLine('2026-09-03T13:20:00.000Z'),
      otherLine('2026-09-03T13:25:00.000Z'),
    ];

    const coverage = parseLogCoverage(lines);

    expect(coverage.intervals).toEqual([
      { start: '2026-09-03T13:00:00.000Z', end: '2026-09-03T13:05:00.000Z' },
      { start: '2026-09-03T13:20:00.000Z', end: '2026-09-03T13:25:00.000Z' },
    ]);
  });

  /**
   * #1081 code review round 2 (the blocker): closing only on a torn line
   * missed the more common case — a clean shutdown and a much later restart
   * appending to the SAME file leaves no torn line at all, just a long
   * silent stretch between two perfectly well-formed lines. Without a
   * max-gap check this reads as ONE unbroken span across the whole
   * downtime, and every row created during it would be wrongly `isCovered`.
   */
  it('closes the span when the gap between two clean lines exceeds MAX_INTER_LINE_GAP_MS, even with no torn line', () => {
    const lines = [
      otherLine('2026-09-03T13:00:00.000Z'),
      otherLine('2026-09-03T13:05:00.000Z'),
      // Clean shutdown here, clean restart hours later — no torn line.
      otherLine('2026-09-03T20:00:00.000Z'),
      otherLine('2026-09-03T20:05:00.000Z'),
    ];

    const coverage = parseLogCoverage(lines);

    expect(coverage.intervals).toEqual([
      { start: '2026-09-03T13:00:00.000Z', end: '2026-09-03T13:05:00.000Z' },
      { start: '2026-09-03T20:00:00.000Z', end: '2026-09-03T20:05:00.000Z' },
    ]);
  });

  it('does not close the span for a gap that is well inside a healthy tick cadence', () => {
    const lines = [
      otherLine('2026-09-03T13:00:00.000Z'),
      otherLine('2026-09-03T13:12:00.000Z'), // 12 minutes — under the 15-minute threshold
    ];

    const coverage = parseLogCoverage(lines);

    expect(coverage.intervals).toEqual([
      { start: '2026-09-03T13:00:00.000Z', end: '2026-09-03T13:12:00.000Z' },
    ]);
  });

  /**
   * #1081 code review round 2, "even better": a boot line is direct evidence
   * the process just (re)started, so it closes the span unconditionally —
   * even when the elapsed gap alone would not have (a crash-and-immediate-
   * restart can leave a gap far under MAX_INTER_LINE_GAP_MS).
   */
  it('closes the span at a boot line even when the elapsed gap is small', () => {
    const lines = [
      otherLine('2026-09-03T13:00:00.000Z'),
      otherLine('2026-09-03T13:01:00.000Z'),
      bootLine('2026-09-03T13:01:30.000Z'), // crash + restart, 30s later
      otherLine('2026-09-03T13:02:00.000Z'),
    ];

    const coverage = parseLogCoverage(lines);

    expect(coverage.intervals).toEqual([
      { start: '2026-09-03T13:00:00.000Z', end: '2026-09-03T13:01:00.000Z' },
      { start: '2026-09-03T13:01:30.000Z', end: '2026-09-03T13:02:00.000Z' },
    ]);
  });

  it('still records a timeout id found on a line with no usable timestamp', () => {
    const lines = [
      JSON.stringify({ message: 'debate.timeout', payload: { debate_id: 'debate-1' } }),
    ];

    const coverage = parseLogCoverage(lines);

    expect(coverage.timeoutIds).toEqual(new Set(['debate-1']));
    // No timestamp to place it in time — it contributes no coverage span.
    expect(coverage.intervals).toEqual([]);
  });

  it('a line with no usable timestamp neither extends nor closes the current span', () => {
    const lines = [
      otherLine('2026-09-03T13:00:00.000Z'),
      JSON.stringify({ message: 'debate.round', payload: {} }), // no timestamp field
      otherLine('2026-09-03T13:05:00.000Z'),
    ];

    const coverage = parseLogCoverage(lines);

    expect(coverage.intervals).toEqual([
      { start: '2026-09-03T13:00:00.000Z', end: '2026-09-03T13:05:00.000Z' },
    ]);
  });

  /**
   * #1081 code review round 3, deepseek: the doc said a boot line closes the
   * span "unconditionally", but the code only checked `trace_id === 'startup'`
   * AFTER the "no timestamp -> continue" gate, so a boot line with no usable
   * timestamp of its own never reached that check and silently left the span
   * open. A boot line is direct evidence of a restart whether or not it also
   * carries a timestamp — it must still close the span.
   */
  it('closes the span at a boot line even when the boot line itself has no usable timestamp', () => {
    const lines = [
      otherLine('2026-09-03T13:00:00.000Z'),
      otherLine('2026-09-03T13:01:00.000Z'),
      JSON.stringify({ trace_id: 'startup', message: 'orchestrator store opened', payload: {} }),
      otherLine('2026-09-03T13:01:15.000Z'),
    ];

    const coverage = parseLogCoverage(lines);

    expect(coverage.intervals).toEqual([
      { start: '2026-09-03T13:00:00.000Z', end: '2026-09-03T13:01:00.000Z' },
      { start: '2026-09-03T13:01:15.000Z', end: '2026-09-03T13:01:15.000Z' },
    ]);
  });
});

describe('isCovered', () => {
  const intervals: LogCoverage['intervals'] = [
    { start: '2026-09-03T13:00:00.000Z', end: '2026-09-03T13:05:00.000Z' },
    { start: '2026-09-03T13:20:00.000Z', end: '2026-09-03T13:25:00.000Z' },
  ];

  it('is true inside a span, including its boundaries', () => {
    expect(isCovered('2026-09-03T13:02:00.000Z', intervals)).toBe(true);
    expect(isCovered('2026-09-03T13:00:00.000Z', intervals)).toBe(true);
    expect(isCovered('2026-09-03T13:05:00.000Z', intervals)).toBe(true);
  });

  it('is false inside the gap between two spans', () => {
    expect(isCovered('2026-09-03T13:10:00.000Z', intervals)).toBe(false);
  });

  it('is false with no intervals at all', () => {
    expect(isCovered('2026-09-03T13:02:00.000Z', [])).toBe(false);
  });
});

function makeRow(overrides: Partial<DebateLogTerminationRow> = {}): DebateLogTerminationRow {
  return {
    debate_id: 'debate-1',
    converged: 0,
    termination: null,
    created_at: '2026-09-03T13:02:00.000Z',
    ...overrides,
  };
}

/** Coverage that treats every timestamp as covered — for cases not exercising the coverage boundary itself. */
function fullCoverage(timeoutIds: Iterable<string> = []): LogCoverage {
  return {
    timeoutIds: new Set(timeoutIds),
    intervals: [{ start: '0000-01-01T00:00:00.000Z', end: '9999-12-31T23:59:59.999Z' }],
  };
}

describe('classifyRows', () => {
  it('classifies a row whose debate_id matches a timeout as latency_truncated', () => {
    const result = classifyRows([makeRow({ debate_id: 'debate-1' })], fullCoverage(['debate-1']));

    expect(result.classified).toEqual([
      { debate_id: 'debate-1', termination: 'latency_truncated' },
    ]);
    expect(result.uncovered).toEqual([]);
    expect(result.indeterminate).toEqual([]);
  });

  it('classifies a non-matching converged row as converged, when its timestamp is covered', () => {
    const result = classifyRows([makeRow({ converged: 1 })], fullCoverage());

    expect(result.classified[0]?.termination).toBe('converged');
  });

  it('classifies a non-matching, non-converged row as non_converged, when its timestamp is covered', () => {
    const result = classifyRows([makeRow({ converged: 0 })], fullCoverage());

    expect(result.classified[0]?.termination).toBe('non_converged');
  });

  /**
   * #1081 code review, finding 1 (the blocker): a row outside every covered
   * span must NOT be classified `non_converged` just because no timeout line
   * named it — absence of a match is not positive evidence of anything when
   * the logs never saw that debate in the first place.
   */
  it('leaves a row with no log coverage at all as uncovered, not non_converged', () => {
    const result = classifyRows([makeRow()], { timeoutIds: new Set(), intervals: [] });

    expect(result.classified).toEqual([]);
    expect(result.uncovered).toEqual(['debate-1']);
    expect(result.indeterminate).toEqual([]);
  });

  it("leaves a row inside a torn log's gap as uncovered", () => {
    const coverage: LogCoverage = {
      timeoutIds: new Set(),
      intervals: [
        { start: '2026-09-03T13:00:00.000Z', end: '2026-09-03T13:05:00.000Z' },
        { start: '2026-09-03T13:20:00.000Z', end: '2026-09-03T13:25:00.000Z' },
      ],
    };
    const row = makeRow({ debate_id: 'debate-in-gap', created_at: '2026-09-03T13:10:00.000Z' });

    const result = classifyRows([row], coverage);

    expect(result.classified).toEqual([]);
    expect(result.uncovered).toEqual(['debate-in-gap']);
  });

  /**
   * #1081 code review round 2 (the blocker), end-to-end: a real log — no
   * torn line, just a clean shutdown and a much later clean restart — fed
   * through `parseLogCoverage` must leave a row created in the downtime
   * uncovered, not silently classified on no evidence.
   */
  it('leaves a row created during a clean-shutdown-to-restart gap uncovered, via parseLogCoverage', () => {
    const lines = [
      otherLine('2026-09-03T13:00:00.000Z'),
      otherLine('2026-09-03T13:05:00.000Z'),
      // Process stopped here — nothing written. Restarts hours later.
      otherLine('2026-09-03T20:00:00.000Z'),
      otherLine('2026-09-03T20:05:00.000Z'),
    ];
    const coverage = parseLogCoverage(lines);
    const rowDuringDowntime = makeRow({
      debate_id: 'debate-during-downtime',
      created_at: '2026-09-03T16:00:00.000Z',
    });

    const result = classifyRows([rowDuringDowntime], coverage);

    expect(result.classified).toEqual([]);
    expect(result.uncovered).toEqual(['debate-during-downtime']);
  });

  it('classifies a row whose timestamp falls inside a covered span, even with other rows uncovered', () => {
    const coverage: LogCoverage = {
      timeoutIds: new Set(),
      intervals: [{ start: '2026-09-03T13:00:00.000Z', end: '2026-09-03T13:05:00.000Z' }],
    };
    const covered = makeRow({
      debate_id: 'debate-covered',
      converged: 0,
      created_at: '2026-09-03T13:02:00.000Z',
    });
    const uncoveredRow = makeRow({
      debate_id: 'debate-uncovered',
      created_at: '2026-09-03T18:00:00.000Z',
    });

    const result = classifyRows([covered, uncoveredRow], coverage);

    expect(result.classified).toEqual([
      { debate_id: 'debate-covered', termination: 'non_converged' },
    ]);
    expect(result.uncovered).toEqual(['debate-uncovered']);
  });

  /** A direct debate_id match is decisive even when the row's own timestamp isn't inside a span. */
  it('a timeout debate_id match overrides span coverage — direct evidence needs no span', () => {
    const coverage: LogCoverage = {
      timeoutIds: new Set(['debate-1']),
      intervals: [], // no span coverage at all
    };

    const result = classifyRows([makeRow()], coverage);

    expect(result.classified).toEqual([
      { debate_id: 'debate-1', termination: 'latency_truncated' },
    ]);
    expect(result.uncovered).toEqual([]);
  });

  /**
   * The distinguishing pin for AC4's shape at the backfill layer: the same
   * `converged: 0` row is classified DIFFERENTLY depending on whether its
   * debate_id shows up in the timeout log.
   */
  it('a latency-truncated row and a genuinely non-converged row — same converged, different termination', () => {
    const rows = [
      makeRow({ debate_id: 'debate-truncated', converged: 0 }),
      makeRow({ debate_id: 'debate-disagreed', converged: 0 }),
    ];

    const result = classifyRows(rows, fullCoverage(['debate-truncated']));

    expect(result.classified.find((r) => r.debate_id === 'debate-truncated')?.termination).toBe(
      'latency_truncated',
    );
    expect(result.classified.find((r) => r.debate_id === 'debate-disagreed')?.termination).toBe(
      'non_converged',
    );
  });

  it('never proposes a value for a row that already carries a termination', () => {
    const result = classifyRows(
      [makeRow({ termination: 'converged' })],
      fullCoverage(['debate-1']), // even a matching timeout id must not override it
    );

    expect(result.classified).toEqual([]);
    expect(result.uncovered).toEqual([]);
  });

  /**
   * #1081 code review round 3 (blocker, kimi + deepseek): `converged` is
   * `number | null` on the raw row, and NULL means the row itself never
   * recorded a value (`DebateLog.converged` is optional) — distinct from `0`
   * (an explicit, recorded non-convergence). Folding NULL into
   * `'non_converged'` asserted a fact the row does not support. A covered
   * row with `converged: null` and no timeout match must stay NULL, reported
   * as `indeterminate` — not silently written as `'non_converged'`.
   */
  it('leaves a covered, non-truncated row with converged: null (SQLite NULL) as indeterminate, not non_converged', () => {
    const result = classifyRows([makeRow({ converged: null })], fullCoverage());

    expect(result.classified).toEqual([]);
    expect(result.uncovered).toEqual([]);
    expect(result.indeterminate).toEqual(['debate-1']);
  });

  it('still classifies converged: 0 (explicit, recorded) as non_converged, distinct from NULL', () => {
    const result = classifyRows([makeRow({ converged: 0 })], fullCoverage());

    expect(result.classified[0]?.termination).toBe('non_converged');
    expect(result.indeterminate).toEqual([]);
  });

  it('a timeout match still wins over converged: null — direct evidence needs no converged value at all', () => {
    const result = classifyRows(
      [makeRow({ debate_id: 'debate-1', converged: null })],
      fullCoverage(['debate-1']),
    );

    expect(result.classified).toEqual([
      { debate_id: 'debate-1', termination: 'latency_truncated' },
    ]);
    expect(result.indeterminate).toEqual([]);
  });
});

describe('summarizeClassification', () => {
  it('counts each termination bucket', () => {
    const summary = summarizeClassification([
      { debate_id: 'a', termination: 'converged' },
      { debate_id: 'b', termination: 'latency_truncated' },
      { debate_id: 'c', termination: 'latency_truncated' },
    ]);

    expect(summary).toEqual({ converged: 1, non_converged: 0, latency_truncated: 2 });
  });
});

describe('formatClassificationReport', () => {
  it('names the dry-run mode and the apply instruction when not applied', () => {
    const report = formatClassificationReport(
      {
        classified: [{ debate_id: 'a', termination: 'latency_truncated' }],
        uncovered: [],
        indeterminate: [],
      },
      false,
    );

    expect(report).toContain('DRY RUN');
    expect(report).toContain('--apply');
  });

  it('names APPLIED and omits the apply instruction when applied', () => {
    const report = formatClassificationReport(
      {
        classified: [{ debate_id: 'a', termination: 'latency_truncated' }],
        uncovered: [],
        indeterminate: [],
      },
      true,
    );

    expect(report).toContain('APPLIED');
    expect(report).not.toContain('Re-run with --apply');
  });

  it('reports the uncovered count separately from the classified rows', () => {
    const report = formatClassificationReport(
      {
        classified: [{ debate_id: 'a', termination: 'non_converged' }],
        uncovered: ['b', 'c'],
        indeterminate: [],
      },
      false,
    );

    expect(report).toContain('classified from positive log evidence: 1');
    expect(report).toContain('left uncovered');
    expect(report).toContain('2');
  });

  it('reports the indeterminate count separately from both classified and uncovered', () => {
    const report = formatClassificationReport(
      {
        classified: [{ debate_id: 'a', termination: 'non_converged' }],
        uncovered: ['b'],
        indeterminate: ['c', 'd'],
      },
      false,
    );

    expect(report).toContain('classified from positive log evidence: 1');
    expect(report).toContain('left uncovered');
    expect(report).toContain('left indeterminate');
    expect(report).toContain('rows read (termination IS NULL): 4');
  });
});

describe('assertDbPathExists', () => {
  /**
   * #1081 code review round 3 (kimi): `better-sqlite3` opens a nonexistent
   * path by silently creating an empty database file rather than throwing —
   * an explicit `--db` pointed at a typo'd path would otherwise open (and
   * migrate!) a brand-new empty file and report a confident "0 rows".
   */
  it('throws for a path that does not exist', () => {
    const missingPath = join(
      mkdtempSync(join(tmpdir(), 'classify-debate-termination-')),
      'nope.sqlite',
    );

    expect(() => assertDbPathExists(missingPath)).toThrow(missingPath);
    expect(() => assertDbPathExists(missingPath)).toThrow('does not exist');
  });

  it('does not throw for a path that exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-debate-termination-'));
    const existingPath = join(dir, 'real.sqlite');
    writeFileSync(existingPath, '');

    expect(() => assertDbPathExists(existingPath)).not.toThrow();
  });
});

describe('parseLogPaths', () => {
  it('parses a single --log path', () => {
    expect(parseLogPaths(['--log', '/tmp/a.log'])).toEqual(['/tmp/a.log']);
  });

  it('splits a comma-separated --log value', () => {
    expect(parseLogPaths(['--log', '/tmp/a.log,/tmp/b.log'])).toEqual(['/tmp/a.log', '/tmp/b.log']);
  });

  it('accumulates repeated --log flags', () => {
    expect(parseLogPaths(['--log', '/tmp/a.log', '--log', '/tmp/b.log'])).toEqual([
      '/tmp/a.log',
      '/tmp/b.log',
    ]);
  });

  it('dedupes across repeated and comma-separated forms', () => {
    expect(parseLogPaths(['--log', '/tmp/a.log', '--log', '/tmp/a.log,/tmp/b.log'])).toEqual([
      '/tmp/a.log',
      '/tmp/b.log',
    ]);
  });

  it('returns an empty list when --log is absent', () => {
    expect(parseLogPaths([])).toEqual([]);
  });

  it('throws when --log has no following argument', () => {
    expect(() => parseLogPaths(['--log'])).toThrow('--log requires a path argument');
  });
});
