import {
  breachLogMessage,
  breachStage,
  classifyBreach,
  formatBreachAlert,
  LLM_SPEND_CAP_BREACH,
} from './breach-text.js';

const ALERT = {
  breaches: [LLM_SPEND_CAP_BREACH],
  reported_at: new Date('2026-09-08T09:00:00Z'),
};

const KILL_LINE_ALERT = {
  breaches: ['pbo_over_max'],
  reported_at: new Date('2026-09-08T09:00:00Z'),
};

const BOTH_ALERT = {
  breaches: [LLM_SPEND_CAP_BREACH, 'pbo_over_max'],
  reported_at: new Date('2026-09-08T09:00:00Z'),
};

const NONE_ALERT = {
  breaches: [] as string[],
  reported_at: new Date('2026-09-08T09:00:00Z'),
};

const KILL_LINE_MARKER = 'auto-tightened';
function hasSpendCapMarker(text: string): boolean {
  return /spend[- ]cap/i.test(text);
}

describe('breachStage (#1280)', () => {
  it('files a breach under the stage of the caller that raised it', () => {
    expect(breachStage(ALERT)).toBe('debate');
    expect(breachStage(KILL_LINE_ALERT)).toBe('feedback-loop');
    expect(breachStage(BOTH_ALERT)).toBe('feedback-loop');
  });
});

describe('classifyBreach (#1343)', () => {
  it('is total over the four shapes breaches can take', () => {
    expect(classifyBreach(KILL_LINE_ALERT.breaches)).toBe('kill-line');
    expect(classifyBreach(ALERT.breaches)).toBe('spend-cap');
    expect(classifyBreach(BOTH_ALERT.breaches)).toBe('both');
    expect(classifyBreach(NONE_ALERT.breaches)).toBe('none');
  });

  it('treats any non-spend-cap id as kill-line, matching breachStage', () => {
    expect(classifyBreach(['oos_sharpe_under_min'])).toBe('kill-line');
    expect(classifyBreach(['dsr_insignificant'])).toBe('kill-line');
    expect(classifyBreach(['live_backtest_divergence_over_max'])).toBe('kill-line');
  });
});

describe('formatBreachAlert (#1343)', () => {
  it('describes auto-tighten on the kill-line caller, and nothing else', () => {
    const text = formatBreachAlert(KILL_LINE_ALERT);

    expect(text).toContain('Samurai KILL-THRESHOLD BREACH');
    expect(text).toContain(KILL_LINE_MARKER);
    expect(hasSpendCapMarker(text)).toBe(false);
    expect(text).toBe(
      'Samurai KILL-THRESHOLD BREACH (1): pbo_over_max.\n' +
        'Detected 2026-09-08T09:00:00.000Z.\n' +
        'Every risk threshold has been defensively auto-tightened. No kill has been applied ' +
        'and none will be — kill or rework is your decision. Review the strategy before the ' +
        'next session.',
    );
  });

  it('describes the spend-cap refusal, and claims no threshold was tightened', () => {
    const text = formatBreachAlert(ALERT);

    expect(text).toContain('Samurai LLM SPEND-CAP BREACH');
    expect(hasSpendCapMarker(text)).toBe(true);
    expect(text).not.toContain(KILL_LINE_MARKER);
    expect(text).toContain('debates, market-intelligence refreshes and risk-critic checks');
    expect(text).not.toContain('clear on its own');
    expect(text).not.toContain('unreadable');
    expect(text).toContain('the refusal log line, where one was written, names which');
  });

  it('describes both when both breach kinds are present', () => {
    const text = formatBreachAlert(BOTH_ALERT);

    expect(text).toContain('Samurai KILL-THRESHOLD BREACH + LLM SPEND-CAP BREACH');
    expect(text).toContain(KILL_LINE_MARKER);
    expect(hasSpendCapMarker(text)).toBe(true);
  });

  it('claims neither outcome when no recognized breach id is present', () => {
    const text = formatBreachAlert(NONE_ALERT);

    expect(text).toContain('Samurai BREACH (0): none.');
    expect(text).not.toContain(KILL_LINE_MARKER);
    expect(hasSpendCapMarker(text)).toBe(false);
    expect(text).toContain('No recognized breach id was reported');
  });
});

describe('breachLogMessage (#1343)', () => {
  it("matches formatBreachAlert's discrimination for the log line", () => {
    expect(breachLogMessage(KILL_LINE_ALERT.breaches)).toContain(KILL_LINE_MARKER);
    expect(hasSpendCapMarker(breachLogMessage(KILL_LINE_ALERT.breaches))).toBe(false);
    expect(breachLogMessage(KILL_LINE_ALERT.breaches)).toBe(
      'kill-threshold breach — risk thresholds auto-tightened; review the strategy and ' +
        'decide kill or rework (no automatic kill is ever applied)',
    );

    expect(hasSpendCapMarker(breachLogMessage(ALERT.breaches))).toBe(true);
    expect(breachLogMessage(ALERT.breaches)).not.toContain(KILL_LINE_MARKER);
    expect(breachLogMessage(ALERT.breaches)).not.toContain('clear on its own');
    expect(breachLogMessage(ALERT.breaches)).toContain(
      'debates, market-intelligence refreshes, risk-critic checks',
    );

    expect(breachLogMessage(BOTH_ALERT.breaches)).toContain(KILL_LINE_MARKER);
    expect(hasSpendCapMarker(breachLogMessage(BOTH_ALERT.breaches))).toBe(true);

    expect(breachLogMessage(NONE_ALERT.breaches)).not.toContain(KILL_LINE_MARKER);
    expect(hasSpendCapMarker(breachLogMessage(NONE_ALERT.breaches))).toBe(false);
  });
});
