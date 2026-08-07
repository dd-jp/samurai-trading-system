/**
 * Tests for the Pipeline view's render layer.
 *
 * Three things carry most of the weight here:
 *
 *  - **`skipped` never reads as `stopped`.** An `exit` intent legitimately
 *    skips Invalidation; reporting that as a halted pipeline would have an
 *    operator chasing a breaker that never tripped. Under the stage rail a
 *    chip is one point, so this distinction lives entirely in the drawer's
 *    stage strip — which is why the strip is tested as a load-bearing surface
 *    rather than as decoration.
 *  - **A live debate shows its reason, not a placeholder.** Round state is not
 *    persisted (Debate Engine decision #10), so the expansion must say so
 *    rather than imply detail is loading.
 *  - **The browser runs the code these tests ran.** `PIPELINE_VIEW_CLIENT_SOURCE`
 *    is evaluated here and its output compared byte-for-byte against the
 *    imported functions — the serialisation seam is the one part of this design
 *    that could rot silently, so it is asserted rather than trusted.
 */

import { DASHBOARD_HTML } from './html.js';
import {
  PIPELINE_STAGES,
  type PipelineCell,
  type PipelineLane,
  type PipelineStage,
  type PipelineView,
} from './pipeline-types.js';
import {
  diffPipelineCells,
  escapePipelineText,
  findPipelineCell,
  findPipelineLane,
  formatStageDuration,
  PIPELINE_VIEW_CLIENT_SOURCE,
  type PipelineDebateSummary,
  type PipelineRenderOptions,
  pipelineCellKey,
  pipelineLaneChanged,
  pipelineStationFor,
  renderDebateSection,
  renderPipelineChip,
  renderPipelineDrawer,
  renderPipelineOutcome,
  renderPipelineRail,
  renderReservedSlot,
  renderStageStrip,
  selectDebateForLane,
} from './pipeline-view.js';

const NOW = Date.parse('2026-08-05T12:00:10.000Z');

/** A full seven-cell lane, all `not_reached`, that each test overrides in place. */
function cells(
  overrides: Partial<Record<PipelineStage, Partial<PipelineCell>>> = {},
): PipelineCell[] {
  return PIPELINE_STAGES.map((stage) => ({
    stage,
    state: 'not_reached',
    duration_ms: null,
    decision: null,
    recorded_at: null,
    attempts: 1,
    ...(overrides[stage] ?? {}),
  }));
}

function lane(overrides: Partial<PipelineLane> = {}): PipelineLane {
  return {
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    trace_id: 't-9f3a21',
    cells: cells(),
    outcome: 'go',
    final_stage: 'execution',
    started_at: '2026-08-05T12:00:00.000Z',
    total_ms: 12225,
    ...overrides,
  };
}

/**
 * A lane that actually reached every stage up to and including `upTo`.
 *
 * The bare `lane()` fixture has all seven cells `not_reached`, which under the
 * rail means "no trace in this window" — correct for an idle ticker, useless
 * for testing placement. Station tests need cells, because cells are the only
 * evidence `pipelineStationFor` accepts.
 */
function reachedThrough(upTo: PipelineStage, overrides: Partial<PipelineLane> = {}): PipelineLane {
  const limit = PIPELINE_STAGES.indexOf(upTo);
  const overridesByStage: Partial<Record<PipelineStage, Partial<PipelineCell>>> = {};
  for (const [index, stage] of PIPELINE_STAGES.entries()) {
    if (index <= limit) overridesByStage[stage] = { state: 'done', duration_ms: 500 };
  }
  return lane({ cells: cells(overridesByStage), final_stage: upTo, ...overrides });
}

function view(overrides: Partial<PipelineView> = {}): PipelineView {
  return { lanes: [lane()], live_trace_id: null, live_entered_at: null, ...overrides };
}

function options(overrides: Partial<PipelineRenderOptions> = {}): PipelineRenderOptions {
  return { selectedInstrument: null, nowMs: NOW, changedCells: [], ...overrides };
}

function debate(overrides: Partial<PipelineDebateSummary> = {}): PipelineDebateSummary {
  return {
    instrument: 'BTC-USD',
    direction: 'bullish',
    rounds: 3,
    created_at: '2026-08-05T12:00:09.000Z',
    contributions: [
      {
        analyst_id: 'technical',
        analyst_type: 'mandatory',
        final_position: 'bullish',
        influence_score: 0.41,
      },
      {
        analyst_id: 'sentiment',
        analyst_type: 'optional',
        final_position: 'bearish',
        influence_score: 0.22,
      },
    ],
    ...overrides,
  };
}

describe('formatStageDuration', () => {
  it('keeps sub-second stages in milliseconds', () => {
    // Verdict is ~95ms against a ~9s Debate; rounding it to '0.1s' would erase
    // the only difference between the three sub-second stages.
    expect(formatStageDuration(95)).toBe('95ms');
    expect(formatStageDuration(999)).toBe('999ms');
  });

  it('switches to seconds at one second and to minutes at sixty', () => {
    expect(formatStageDuration(1000)).toBe('1.0s');
    expect(formatStageDuration(9240)).toBe('9.2s');
    expect(formatStageDuration(63000)).toBe('1m 3s');
  });

  it('renders a null duration as a placeholder, never as zero', () => {
    // A not-reached stage took no time; '0ms' would claim it ran instantly.
    expect(formatStageDuration(null)).toBe('·');
    expect(formatStageDuration(Number.NaN)).toBe('·');
  });
});

describe('escapePipelineText', () => {
  it('escapes every value that came out of the database', () => {
    expect(escapePipelineText('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;');
  });
});

describe('lane lookups', () => {
  it('finds a cell by stage rather than by position', () => {
    // `cells` is contract-ordered, but nothing enforces the order at runtime.
    const l = lane({ cells: [...cells()].reverse() });
    expect(findPipelineCell(l, 'verdict')?.stage).toBe('verdict');
  });

  it('returns null for an unknown instrument and for a null selection', () => {
    expect(findPipelineLane(view(), 'NVDA')).toBeNull();
    expect(findPipelineLane(view(), null)).toBeNull();
  });

  it('keys cells by instrument and stage', () => {
    expect(pipelineCellKey('BTC-USD', 'debate')).toBe('BTC-USD|debate');
  });
});

describe('pipelineStationFor', () => {
  // The whole placement rule of the rail lives in this function, so it is
  // tested directly rather than only through the rendered markup.
  it('parks a chip on the live stage, whatever it reached before', () => {
    const l = lane({
      outcome: 'in_flight',
      cells: cells({ analysts: { state: 'done' }, debate: { state: 'live' } }),
    });
    expect(pipelineStationFor(l)).toBe('debate');
  });

  it('parks a settled chip on the furthest stage it actually reached', () => {
    const l = lane({
      cells: cells({
        analysts: { state: 'done' },
        debate: { state: 'done' },
        trader: { state: 'stopped', decision: 'no_trade' },
      }),
    });
    expect(pipelineStationFor(l)).toBe('trader');
  });

  it('never parks a chip on a stage the tick skipped', () => {
    // A skipped Invalidation did not run. A chip sitting there would claim work
    // that never happened, and would also read as the tick having halted there.
    const l = lane({
      cells: cells({
        trader: { state: 'done' },
        invalidation: { state: 'skipped' },
        risk: { state: 'done' },
      }),
    });
    expect(pipelineStationFor(l)).toBe('risk');
  });

  it('returns null for a ticker with no trace in the window', () => {
    // Null means "idle group", never "drop it" — see the gutter test below.
    expect(pipelineStationFor(lane({ outcome: 'idle', trace_id: null }))).toBeNull();
  });
});

describe('renderPipelineRail', () => {
  it('renders all seven stations including the unbuilt invalidation one', () => {
    const html = renderPipelineRail(view(), options());
    expect(html).toContain('Invalid.');
    expect(html).toContain('specced, not built');
    expect(html.match(/class="pl-station"/g)).toHaveLength(PIPELINE_STAGES.length);
  });

  it('keeps every station present even when nothing is parked on it', () => {
    // The frame has to stay still: a rail that collapsed empty stations would
    // move the remaining chips under the operator between polls. One ticker
    // parked on Debate leaves the other six stations rendered and empty.
    const html = renderPipelineRail(view({ lanes: [reachedThrough('debate')] }), options());
    expect(html.match(/class="pl-none"/g)).toHaveLength(PIPELINE_STAGES.length - 1);
  });

  it('clusters chips on the station each ticker stopped at', () => {
    // The diagnostic the rail exists for: three tickers dying at Risk is a
    // pile-up you can see without reading a single row.
    const stuck = (instrument: string) =>
      lane({
        instrument,
        outcome: 'stopped',
        final_stage: 'risk',
        cells: cells({
          analysts: { state: 'done' },
          debate: { state: 'done' },
          trader: { state: 'done' },
          risk: { state: 'stopped', decision: 'breaker_daily_loss' },
        }),
      });
    const html = renderPipelineRail(
      view({ lanes: [stuck('BTC-USD'), stuck('ETH-USD'), stuck('SPY')] }),
      options(),
    );
    const risk = html.slice(
      html.indexOf('data-stage="risk"'),
      html.indexOf('data-stage="verdict"'),
    );
    expect(risk.match(/class="pl-chip /g)).toHaveLength(3);
    expect(risk).toContain('<span class="pl-n">3</span>');
  });

  it('marks the stations that persist no decision record', () => {
    // #328's territory. A chip parked on Trader otherwise looks like it has
    // detail waiting behind it.
    const html = renderPipelineRail(view(), options());
    expect(html.match(/pl-lock/g)).toHaveLength(3);
  });

  it('lights only the station that actually holds an in-flight ticker', () => {
    const html = renderPipelineRail(
      view({
        lanes: [lane({ outcome: 'in_flight', cells: cells({ debate: { state: 'live' } }) })],
        live_trace_id: 't-9f3a21',
        live_entered_at: '2026-08-05T12:00:04.000Z',
      }),
      options(),
    );
    expect(html.match(/pl-station pl-hot/g)).toHaveLength(1);
  });

  it('computes the live chip elapsed from live_entered_at and the poll clock', () => {
    const html = renderPipelineRail(
      view({
        lanes: [lane({ outcome: 'in_flight', cells: cells({ debate: { state: 'live' } }) })],
        live_trace_id: 't-9f3a21',
        live_entered_at: '2026-08-05T12:00:04.000Z',
      }),
      options(),
    );
    expect(html).toContain('6.0s');
  });

  it('falls back to a bare live marker when the entered-at timestamp is unusable', () => {
    // A clock skew that made elapsed negative would otherwise print '-3.0s'.
    const html = renderPipelineRail(
      view({
        lanes: [lane({ outcome: 'in_flight', cells: cells({ debate: { state: 'live' } }) })],
        live_trace_id: 't-9f3a21',
        live_entered_at: '2026-08-05T12:00:13.000Z',
      }),
      options(),
    );
    expect(html).toContain('>live<');
  });

  it('gives the elapsed reading only to the ticker that owns the live trace', () => {
    // `live_entered_at` is singular. A second in-flight chip must not print
    // another instrument's stage duration as if it were measured.
    const html = renderPipelineRail(
      view({
        lanes: [
          lane({
            trace_id: 't-9f3a21',
            outcome: 'in_flight',
            cells: cells({ debate: { state: 'live' } }),
          }),
          lane({
            instrument: 'ETH-USD',
            trace_id: 't-other',
            outcome: 'in_flight',
            cells: cells({ analysts: { state: 'live' } }),
          }),
        ],
        live_trace_id: 't-9f3a21',
        live_entered_at: '2026-08-05T12:00:04.000Z',
      }),
      options(),
    );
    expect(html.match(/6\.0s/g)).toHaveLength(1);
    expect(html).toContain('>live<');
  });

  it('stops calling Invalidation unbuilt once a ticker reaches it', () => {
    // The day the stage ships, the caveat must retire itself.
    expect(renderPipelineRail(view(), options())).toContain('specced, not built');
    const shipped = renderPipelineRail(
      view({
        lanes: [lane({ cells: cells({ invalidation: { state: 'done', duration_ms: 130 } }) })],
      }),
      options(),
    );
    expect(shipped).not.toContain('specced, not built');
  });

  it('settles only the chips whose ticker the diff reported as changed', () => {
    // #421 restated for the rail: a chip that moved appears at the new station
    // already settled. Nothing travels, because the poll never saw the transit.
    const html = renderPipelineRail(
      view({
        lanes: [
          lane({ cells: cells({ debate: { state: 'done', duration_ms: 9240 } }) }),
          lane({
            instrument: 'ETH-USD',
            cells: cells({ analysts: { state: 'done', duration_ms: 700 } }),
          }),
        ],
      }),
      options({ changedCells: ['BTC-USD|debate'] }),
    );
    // Twice: settled tickers appear on their station and again in the gutter.
    expect(html.match(/pl-settle/g)).toHaveLength(2);
    expect(html).toContain('pl-chip pl-chip-go pl-settle');
  });

  it('renders an honest empty rail when no instrument has ticked', () => {
    expect(renderPipelineRail(view({ lanes: [] }), options())).toContain(
      'No instrument has ticked in this window.',
    );
  });

  it('marks the selected ticker and reports it on the chip', () => {
    const html = renderPipelineRail(view(), options({ selectedInstrument: 'BTC-USD' }));
    expect(html).toContain('pl-selected');
    expect(html).toContain('aria-expanded="true"');
  });

  it('gives every chip a typed button and an outcome named in words', () => {
    // Colour is never the only signal — the dot carries the outcome visually,
    // the label carries it for a screen reader and for anyone who cannot
    // separate the greens from the reds.
    const html = renderPipelineRail(
      view({ lanes: [lane({ outcome: 'stopped', final_stage: 'risk' })] }),
      options(),
    );
    expect(html).toContain('<button type="button" class="pl-chip pl-chip-stopped');
    expect(html).toContain('aria-label="BTC-USD · ');
    expect(html).toContain('stopped');
  });
});

describe('renderPipelineGutter — settled and idle', () => {
  it('keeps an idle ticker visible instead of dropping it off the rail', () => {
    // #413's decision, transposed: an instrument outside market hours must read
    // as idle. A ticker that simply vanished would be indistinguishable from
    // one nobody is watching.
    const html = renderPipelineRail(
      view({
        lanes: [
          lane({
            instrument: 'SPY',
            asset_class: 'stocks',
            outcome: 'idle',
            trace_id: null,
            started_at: null,
            total_ms: null,
            final_stage: null,
          }),
        ],
      }),
      options(),
    );
    expect(html).toContain('pl-group-idle');
    expect(html).toContain('pl-chip-idle');
    expect(html).toContain('SPY');
  });

  it('shows a settled ticker on its station and again in the gutter', () => {
    // Deliberate duplication: the station answers "where are ticks dying", the
    // gutter answers "what has happened lately". Collapsing them loses one.
    const html = renderPipelineRail(view({ lanes: [reachedThrough('execution')] }), options());
    expect(html.match(/data-instrument="BTC-USD"/g)).toHaveLength(2);
    expect(html).toContain('>settled<');
  });

  it('leaves an in-flight ticker out of the settled group', () => {
    const html = renderPipelineRail(
      view({
        lanes: [lane({ outcome: 'in_flight', cells: cells({ debate: { state: 'live' } }) })],
        live_trace_id: 't-9f3a21',
        live_entered_at: '2026-08-05T12:00:04.000Z',
      }),
      options(),
    );
    expect(html).not.toContain('>settled<');
    expect(html.match(/data-instrument="BTC-USD"/g)).toHaveLength(1);
  });

  it('renders no gutter at all when nothing has settled and nothing is idle', () => {
    const html = renderPipelineRail(
      view({
        lanes: [lane({ outcome: 'in_flight', cells: cells({ debate: { state: 'live' } }) })],
      }),
      options(),
    );
    expect(html).not.toContain('pl-gutter');
  });
});

describe('renderPipelineChip', () => {
  it('reports the total for a settled ticker and the elapsed for a live one', () => {
    expect(renderPipelineChip(lane(), options(), null)).toContain('12.2s');
    expect(
      renderPipelineChip(
        lane({ outcome: 'in_flight', cells: cells({ debate: { state: 'live' } }) }),
        options(),
        6000,
      ),
    ).toContain('6.0s');
  });

  it('carries the asset class on the chip face, not only in the tooltip', () => {
    // Crypto ticks around the clock and stocks do not, so an idle chip means
    // "market closed" for one and "something is wrong" for the other. Without
    // the marker the two are indistinguishable — the failure #413 exists to
    // prevent. This had no test under lanes, which is how it nearly went.
    const html = renderPipelineChip(
      lane({ instrument: 'SPY', asset_class: 'stocks', outcome: 'idle', trace_id: null }),
      options(),
      null,
    );
    expect(html).toContain('<span class="pl-class">stocks</span>');
    expect(html).toContain('aria-label="SPY · stocks · ');
  });

  it('escapes an instrument name rather than trusting what was stored', () => {
    const html = renderPipelineChip(lane({ instrument: '<img src=x>' }), options(), null);
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img');
  });
});

describe('renderPipelineOutcome', () => {
  it('names the stage a stopped trace stopped at', () => {
    expect(renderPipelineOutcome(lane({ outcome: 'stopped', final_stage: 'risk' }))).toContain(
      'stopped · risk',
    );
  });

  it('renders quorum_skip as neutral, not as a failure', () => {
    // Quorum skip is normal traffic; a red badge would read as a fault.
    expect(renderPipelineOutcome(lane({ outcome: 'quorum_skip' }))).toContain('badge-neutral');
  });

  it('renders an idle lane without a badge at all', () => {
    expect(renderPipelineOutcome(lane({ outcome: 'idle' }))).toContain('no tick in window');
  });
});

describe('diffPipelineCells', () => {
  it('reports nothing on a first paint', () => {
    // Everything is new on arrival; flashing the whole table would signal
    // change where there is only a page load.
    expect(diffPipelineCells(null, view())).toEqual([]);
  });

  it('reports a cell whose state moved between polls', () => {
    const before = view({ lanes: [lane({ cells: cells({ debate: { state: 'live' } }) })] });
    const after = view({
      lanes: [lane({ cells: cells({ debate: { state: 'done', duration_ms: 9240 } }) })],
    });
    expect(diffPipelineCells(before, after)).toEqual(['BTC-USD|debate']);
  });

  it('reports a retry as a change even when the state is unmoved', () => {
    const before = view({
      lanes: [lane({ cells: cells({ debate: { state: 'done', attempts: 1 } }) })],
    });
    const after = view({
      lanes: [lane({ cells: cells({ debate: { state: 'done', attempts: 2 } }) })],
    });
    expect(diffPipelineCells(before, after)).toEqual(['BTC-USD|debate']);
  });

  it('reports every reached cell when the lane starts a new trace', () => {
    // analysts→analysts across two different ticks is new information, not a
    // stationary cell.
    const before = view({
      lanes: [lane({ trace_id: 't-old', cells: cells({ analysts: { state: 'done' } }) })],
    });
    const after = view({
      lanes: [lane({ trace_id: 't-new', cells: cells({ analysts: { state: 'done' } }) })],
    });
    expect(diffPipelineCells(before, after)).toEqual(['BTC-USD|analysts']);
  });

  it('stays quiet when nothing moved', () => {
    expect(diffPipelineCells(view(), view())).toEqual([]);
  });

  it('ignores a lane that was not in the previous snapshot', () => {
    const after = view({ lanes: [lane({ instrument: 'ETH-USD' })] });
    expect(diffPipelineCells(view(), after)).toEqual([]);
  });
});

describe('pipelineLaneChanged', () => {
  // The diff is cell-keyed because the wire contract is, but a chip is one
  // point: the rail cannot ring "the Risk cell" of a chip parked on Verdict.
  it('settles a ticker when any of its cells moved', () => {
    expect(pipelineLaneChanged('BTC-USD', ['BTC-USD|risk'])).toBe(true);
  });

  it('does not settle a ticker on another instrument’s change', () => {
    expect(pipelineLaneChanged('BTC-USD', ['ETH-USD|risk'])).toBe(false);
  });

  it('does not match an instrument that merely shares a prefix', () => {
    // 'BTC' must not be settled by 'BTC-USD' moving — the separator is part of
    // the key for exactly this reason.
    expect(pipelineLaneChanged('BTC', ['BTC-USD|risk'])).toBe(false);
  });

  it('stays quiet on an empty diff', () => {
    expect(pipelineLaneChanged('BTC-USD', [])).toBe(false);
  });
});

describe('selectDebateForLane', () => {
  it('takes the most recent debate that closed after the trace began', () => {
    const older = debate({ created_at: '2026-08-05T12:00:05.000Z', rounds: 1 });
    const newer = debate({ created_at: '2026-08-05T12:00:09.000Z', rounds: 3 });
    expect(selectDebateForLane(lane(), [older, newer])?.rounds).toBe(3);
  });

  it('refuses a debate that closed before this trace started', () => {
    // The join is by instrument only — `DebateRow` has no trace_id — so the
    // start-time guard is the only thing keeping a previous tick's debate off
    // this lane.
    const stale = debate({ created_at: '2026-08-05T11:59:00.000Z' });
    expect(selectDebateForLane(lane(), [stale])).toBeNull();
  });

  it('refuses another instrument entirely, and an idle lane', () => {
    expect(selectDebateForLane(lane(), [debate({ instrument: 'ETH-USD' })])).toBeNull();
    expect(selectDebateForLane(lane({ started_at: null }), [debate()])).toBeNull();
  });

  it('refuses an unparsable timestamp rather than guessing', () => {
    expect(selectDebateForLane(lane({ started_at: 'not-a-date' }), [debate()])).toBeNull();
    expect(selectDebateForLane(lane(), [debate({ created_at: 'not-a-date' })])).toBeNull();
  });
});

/**
 * #427 — the per-round stance strip.
 *
 * `debate_log.contributions_json` always carried `stance_during_debate`; the
 * wire shape projected only where each analyst ENDED UP, so an analyst that
 * started bearish and was talked around rendered identically to one that never
 * moved. That is the interesting part of a debate.
 */
describe('renderDebateSection — the stance strip (#427)', () => {
  function done() {
    return lane({ cells: cells({ debate: { state: 'done', duration_ms: 9240 } }) });
  }

  it('draws one cell per round, in round order', () => {
    const html = renderDebateSection(done(), [
      debate({
        contributions: [
          {
            analyst_id: 'technical',
            analyst_type: 'mandatory',
            final_position: 'bullish',
            influence_score: 0.41,
            stance_during_debate: ['bearish', 'neutral', 'bullish'],
          },
        ],
      }),
    ]);

    expect(html).toContain('pl-stance-bearish');
    expect(html).toContain('pl-stance-neutral');
    expect(html).toContain('pl-stance-bullish');
    // The round each cell belongs to is on the cell, so a strip is readable
    // without counting positions.
    expect(html).toContain('round 1: bearish');
    expect(html).toContain('round 3: bullish');
  });

  it('renders no strip at all when no per-round stance was recorded', () => {
    // Not a flat strip: a debate that logged no stances did not hold a steady
    // position, it reported nothing, and drawing a confident-looking line for
    // that is the dashboard inventing evidence.
    const html = renderDebateSection(done(), [debate()]);

    expect(html).toContain('pl-agent');
    expect(html).not.toContain('pl-stance');
  });

  it('renders no strip for an empty round array', () => {
    const html = renderDebateSection(done(), [
      debate({
        contributions: [
          {
            analyst_id: 'technical',
            analyst_type: 'mandatory',
            final_position: 'bullish',
            influence_score: 0.41,
            stance_during_debate: [],
          },
        ],
      }),
    ]);

    expect(html).not.toContain('pl-stance');
  });

  it('escapes a stance before putting it in a class name or a label', () => {
    // `final_position` and the stances are LLM-derived strings the system
    // stored rather than wrote — the same reason `escapePipelineText` exists.
    const html = renderDebateSection(done(), [
      debate({
        contributions: [
          {
            analyst_id: 'technical',
            analyst_type: 'mandatory',
            final_position: 'bullish',
            influence_score: 0.41,
            stance_during_debate: ['<script>alert(1)</script>'],
          },
        ],
      }),
    ]);

    expect(html).not.toContain('<script>');
  });
});

describe('renderDebateSection', () => {
  it('says why a running debate shows nothing, and shows no cards', () => {
    const html = renderDebateSection(lane({ cells: cells({ debate: { state: 'live' } }) }), [
      debate(),
    ]);
    expect(html).toContain('Nothing is recorded while a debate runs');
    expect(html).toContain('decision #10');
    expect(html).not.toContain('pl-agent');
  });

  it('renders per-analyst cards for a completed debate', () => {
    const html = renderDebateSection(
      lane({ cells: cells({ debate: { state: 'done', duration_ms: 9240 } }) }),
      [debate()],
    );
    expect(html).toContain('technical');
    expect(html).toContain('mandatory');
    expect(html).toContain('influence 0.41');
    expect(html).toContain('badge-bullish');
    expect(html).toContain('3 round(s)');
  });

  it('states that the debate match is not a proven join', () => {
    const html = renderDebateSection(lane({ cells: cells({ debate: { state: 'done' } }) }), [
      debate(),
    ]);
    expect(html).toContain('carries no <code>trace_id</code>');
  });

  it('does not repeat analyst weights, which the Overview panel owns', () => {
    // #377 may change what a weight means; two surfaces disagreeing about it
    // is worse than one surface staying silent.
    const html = renderDebateSection(lane({ cells: cells({ debate: { state: 'done' } }) }), [
      debate(),
    ]);
    expect(html).toContain('Analyst Performance panel owns them');
    expect(html).not.toContain('rolling');
  });

  it('separates a missing row from a not-reached and a skipped stage', () => {
    expect(
      renderDebateSection(lane({ cells: cells({ debate: { state: 'done' } }) }), []),
    ).toContain('No completed debate row matches this trace');
    expect(renderDebateSection(lane(), [debate()])).toContain('Not reached');
    expect(
      renderDebateSection(lane({ cells: cells({ debate: { state: 'skipped' } }) }), [debate()]),
    ).toContain('Skipped');
  });

  it('handles a debate row that recorded no contributions', () => {
    const html = renderDebateSection(lane({ cells: cells({ debate: { state: 'done' } }) }), [
      debate({ contributions: [] }),
    ]);
    expect(html).toContain('No contributions recorded');
  });
});

describe('renderReservedSlot', () => {
  it('names the reserved stages the trace actually reached', () => {
    const html = renderReservedSlot(
      lane({ cells: cells({ trader: { state: 'done' }, risk: { state: 'done' } }) }),
    );
    expect(html).toContain('Trader, Risk');
    expect(html).toContain('#328');
    expect(html).not.toContain('Invalid.');
  });

  it('renders nothing when no reserved stage was reached', () => {
    expect(renderReservedSlot(lane())).toBe('');
  });

  it('leaves out a reserved stage that was skipped', () => {
    // Invalidation skipped on an exit intent never ran, so it has no record to
    // reserve a slot for.
    const html = renderReservedSlot(
      lane({ cells: cells({ trader: { state: 'done' }, invalidation: { state: 'skipped' } }) }),
    );
    expect(html).toContain('Trader');
    expect(html).not.toContain('Invalid.');
  });
});

/**
 * Under the stage rail this strip is the **sole** per-stage record — a chip is
 * one point, so a skipped stage and a retried one cannot be shown on the rail
 * at all. Both #414 decisions therefore land here, and if these tests go so
 * does the requirement.
 */
describe('renderStageStrip', () => {
  it('lists every stage with its decision word, including the unreached ones', () => {
    const html = renderStageStrip(
      lane({
        cells: cells({ analysts: { state: 'done', duration_ms: 820, decision: 'quorum_met' } }),
      }),
    );
    expect(html).toContain('quorum_met');
    expect(html).toContain('820ms');
    expect(html).toContain('not reached');
    expect(html.match(/<tr>/g)).toHaveLength(PIPELINE_STAGES.length + 1);
  });

  it('distinguishes skipped from stopped from not-reached', () => {
    // The whole reason all three states exist: an exit intent skips
    // Invalidation and the tick carries on, which is not a halted pipeline —
    // and neither is a stage the tick simply never got to.
    const html = renderStageStrip(
      lane({
        cells: cells({
          invalidation: { state: 'skipped' },
          risk: { state: 'stopped', duration_ms: 210, decision: 'breaker_daily_loss' },
        }),
      }),
    );
    expect(html).toContain('pl-state pl-skipped');
    expect(html).toContain('pl-state pl-stopped');
    expect(html).toContain('pl-state pl-not_reached');
    expect(html).toContain('breaker_daily_loss');
  });

  it('reports a stage that was reached more than once', () => {
    const html = renderStageStrip(
      lane({ cells: cells({ debate: { state: 'done', duration_ms: 11890, attempts: 2 } }) }),
    );
    expect(html).toContain('×2');
    expect(html).toContain('reached 2 times');
  });
});

describe('renderPipelineDrawer', () => {
  it('prompts for a selection and states the view is read-only', () => {
    const html = renderPipelineDrawer(null, []);
    expect(html).toContain('Select a ticker');
    expect(html).toContain('nothing here acts on a trade');
  });

  it('renders an idle lane without inventing a trace', () => {
    const html = renderPipelineDrawer(
      lane({ trace_id: null, outcome: 'idle', started_at: null, total_ms: null }),
      [],
    );
    expect(html).toContain('the market is closed');
    expect(html).not.toContain('pl-strip');
  });

  it('carries the trace id, the totals, the strip and the debate section', () => {
    const html = renderPipelineDrawer(lane({ cells: cells({ debate: { state: 'done' } }) }), [
      debate(),
    ]);
    expect(html).toContain('t-9f3a21');
    expect(html).toContain('12.2s total');
    expect(html).toContain('pl-strip');
    expect(html).toContain('pl-agent');
  });

  it('says it is the current trace, not the instrument history', () => {
    // #422: history is audit_log grouped by trace_id — a different query and a
    // different payload. The Verdict History table already gives it.
    expect(renderPipelineDrawer(lane(), [])).toContain('current trace, not its history');
  });

  it('uses a typed button for its only control', () => {
    // A bare <button> inside a form-less page still defaults to submit in some
    // engines; the codebase lints for this.
    expect(renderPipelineDrawer(lane(), [])).toContain('<button type="button" class="pl-close"');
  });
});

describe('PIPELINE_VIEW_CLIENT_SOURCE', () => {
  /**
   * Evaluates the serialised source the page inlines and hands back the same
   * function names. `new Function` rather than `eval` so the source is compiled
   * in its own scope, exactly as the browser compiles the `<script>` — and so
   * the test cannot accidentally close over the imported implementations and
   * assert against itself.
   */
  function evaluateClientSource(): Record<string, (...args: never[]) => string> {
    const factory = new Function(
      `${PIPELINE_VIEW_CLIENT_SOURCE}\nreturn { renderPipelineRail, renderPipelineDrawer, renderDebateSection, renderStageStrip };`,
    );
    return factory() as Record<string, (...args: never[]) => string>;
  }

  it('compiles as standalone browser source', () => {
    expect(() => evaluateClientSource()).not.toThrow();
  });

  it('renders the same rail the imported function renders', () => {
    // The seam this whole design rests on: the page is not running a second,
    // untested copy of these rules.
    const v = view({
      lanes: [
        lane({
          cells: cells({
            analysts: { state: 'done', duration_ms: 820, decision: 'quorum_met' },
            debate: { state: 'live', attempts: 2 },
          }),
        }),
        lane({
          instrument: 'SPY',
          asset_class: 'stocks',
          outcome: 'idle',
          trace_id: null,
          started_at: null,
          total_ms: null,
          final_stage: null,
        }),
      ],
      live_trace_id: 't-9f3a21',
      live_entered_at: '2026-08-05T12:00:04.000Z',
    });
    const client = evaluateClientSource();
    const opts = options({ selectedInstrument: 'BTC-USD', changedCells: ['BTC-USD|debate'] });
    expect(client.renderPipelineRail?.(v as never, opts as never)).toBe(
      renderPipelineRail(v, opts),
    );
  });

  it('renders the same drawer the imported function renders', () => {
    const l = lane({
      cells: cells({ debate: { state: 'done', duration_ms: 9240 }, trader: { state: 'done' } }),
    });
    const client = evaluateClientSource();
    expect(client.renderPipelineDrawer?.(l as never, [debate()] as never)).toBe(
      renderPipelineDrawer(l, [debate()]),
    );
  });

  it('carries no module-system artefacts into the browser', () => {
    // The failure this guards is silent: a toolchain that rewrites an imported
    // identifier inside a function body ships `__vite_ssr_import_0__.X` to a
    // page that has no such object. Hence the local rebinding in the module.
    expect(PIPELINE_VIEW_CLIENT_SOURCE).not.toContain('__vite');
    expect(PIPELINE_VIEW_CLIENT_SOURCE).not.toMatch(/\brequire\(|\bimport\b/);
  });

  it('carries every renderer the page mounts', () => {
    for (const name of [
      'renderPipelineRail',
      'renderPipelineDrawer',
      'renderPipelineChip',
      'renderPipelineStation',
      'renderPipelineGutter',
      'diffPipelineCells',
      'pipelineLaneChanged',
      'pipelineStationFor',
      'findPipelineLane',
    ]) {
      expect(PIPELINE_VIEW_CLIENT_SOURCE).toContain(`function ${name}(`);
    }
  });
});

/**
 * `html.ts` has no build step and no test of its own — a syntax error inside
 * its template literal is a blank dashboard discovered by opening it. These
 * assertions are the cheapest guard that exists: they parse the page's script
 * and check that what the mounting code reaches for is actually in the markup.
 */
describe('DASHBOARD_HTML', () => {
  function pageScript(): string {
    const start = DASHBOARD_HTML.lastIndexOf('<script>');
    const end = DASHBOARD_HTML.lastIndexOf('</script>');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return DASHBOARD_HTML.slice(start + '<script>'.length, end);
  }

  it('inlines a syntactically valid script', () => {
    // `new Function` parses without executing — no DOM needed to catch the
    // failure mode that matters (an unbalanced brace in a 400-line literal).
    expect(() => new Function(pageScript())).not.toThrow();
  });

  it('carries the render rules rather than a second copy of them', () => {
    expect(pageScript()).toContain(PIPELINE_VIEW_CLIENT_SOURCE);
  });

  it('mounts every element the pipeline code addresses', () => {
    for (const id of ['pl-panel', 'pl-rail', 'pl-drawer', 'pl-count', 'tabs', 'view-pipeline']) {
      expect(DASHBOARD_HTML).toContain(`id="${id}"`);
    }
  });

  it('lands on Overview and keeps the existing panels', () => {
    // The tables stay exactly as they were, and stay the default view.
    expect(DASHBOARD_HTML).toContain('id="tab-overview" role="tab" data-tab="overview"');
    const overview = DASHBOARD_HTML.match(/<div[^>]*id="view-overview"[^>]*>/)?.[0] ?? '';
    const pipeline = DASHBOARD_HTML.match(/<div[^>]*id="view-pipeline"[^>]*>/)?.[0] ?? '';
    expect(overview).not.toContain('hidden');
    expect(pipeline).toContain('hidden');
    for (const id of ['positions', 'metrics', 'debates', 'verdicts', 'analysts', 'providers']) {
      expect(DASHBOARD_HTML).toContain(`id="${id}"`);
    }
  });

  it('gives every control an explicit button type', () => {
    // Biome's a11y rules cannot see inside a template literal, so this is the
    // only thing standing between a bare <button> and a submit-by-default.
    // Quotes appear escaped in the buttons the serialised renderers emit, so
    // both spellings count.
    const buttons = DASHBOARD_HTML.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button).toMatch(/type=\\?"button\\?"/);
  });

  it('respects prefers-reduced-motion', () => {
    expect(DASHBOARD_HTML).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
