import {
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

  it('treats converged: null (SQLite NULL) as non_converged when covered and not truncated', () => {
    const result = classifyRows([makeRow({ converged: null })], fullCoverage());

    expect(result.classified[0]?.termination).toBe('non_converged');
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
      { classified: [{ debate_id: 'a', termination: 'latency_truncated' }], uncovered: [] },
      false,
    );

    expect(report).toContain('DRY RUN');
    expect(report).toContain('--apply');
  });

  it('names APPLIED and omits the apply instruction when applied', () => {
    const report = formatClassificationReport(
      { classified: [{ debate_id: 'a', termination: 'latency_truncated' }], uncovered: [] },
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
      },
      false,
    );

    expect(report).toContain('classified from positive log evidence: 1');
    expect(report).toContain('left uncovered');
    expect(report).toContain('2');
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
