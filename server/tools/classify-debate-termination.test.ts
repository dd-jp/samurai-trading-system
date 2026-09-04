import {
  classifyRows,
  type DebateLogTerminationRow,
  formatClassificationReport,
  parseLatencyTruncatedDebateIds,
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

function makeRow(overrides: Partial<DebateLogTerminationRow> = {}): DebateLogTerminationRow {
  return { debate_id: 'debate-1', converged: 0, termination: null, ...overrides };
}

describe('classifyRows', () => {
  it('classifies a row whose debate_id matches a timeout as latency_truncated', () => {
    const classified = classifyRows([makeRow({ debate_id: 'debate-1' })], new Set(['debate-1']));

    expect(classified).toEqual([{ debate_id: 'debate-1', termination: 'latency_truncated' }]);
  });

  it('classifies a non-matching converged row as converged', () => {
    const classified = classifyRows([makeRow({ converged: 1 })], new Set());

    expect(classified[0]?.termination).toBe('converged');
  });

  it('classifies a non-matching, non-converged row as non_converged', () => {
    const classified = classifyRows([makeRow({ converged: 0 })], new Set());

    expect(classified[0]?.termination).toBe('non_converged');
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

    const classified = classifyRows(rows, new Set(['debate-truncated']));

    expect(classified.find((r) => r.debate_id === 'debate-truncated')?.termination).toBe(
      'latency_truncated',
    );
    expect(classified.find((r) => r.debate_id === 'debate-disagreed')?.termination).toBe(
      'non_converged',
    );
  });

  it('never proposes a value for a row that already carries a termination', () => {
    const classified = classifyRows(
      [makeRow({ termination: 'converged' })],
      new Set(['debate-1']), // even a matching timeout id must not override it
    );

    expect(classified).toEqual([]);
  });

  it('treats converged: null (SQLite NULL) as non_converged when not truncated', () => {
    const classified = classifyRows([makeRow({ converged: null })], new Set());

    expect(classified[0]?.termination).toBe('non_converged');
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
      [{ debate_id: 'a', termination: 'latency_truncated' }],
      false,
    );

    expect(report).toContain('DRY RUN');
    expect(report).toContain('--apply');
  });

  it('names APPLIED and omits the apply instruction when applied', () => {
    const report = formatClassificationReport(
      [{ debate_id: 'a', termination: 'latency_truncated' }],
      true,
    );

    expect(report).toContain('APPLIED');
    expect(report).not.toContain('Re-run with --apply');
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
