// @vitest-environment jsdom
//
// #981. Three properties, and the last two are the ones that matter:
//
//  1. every benchmark renders return AND drawdown together, on every branch
//     (`docs/research/12-edge-hypothesis-critique.md` D4, which CLAUDE.md
//     applies to the outside benchmarks by name);
//  2. the panel is laid out as SECONDARY — no verdict, no alert styling, and it
//     says so in words rather than only in colour;
//  3. a benchmark FL could not measure is named as unmeasured, never drawn as
//     0.00%.

import { render, screen, within } from '@testing-library/react';
// Explicit, for `ArmComparisonPanel.test.tsx`'s reason: `vitest/globals` is not
// on `client/tsconfig.test.json`'s `types`.
import { describe, expect, it } from 'vitest';
import { makeOutsideBenchmark } from '../../test-fixtures.ts';
import { OutsideBenchmarkPanel } from './OutsideBenchmarkPanel.tsx';

const SPY = makeOutsideBenchmark({
  benchmark: 'spy',
  buy_and_hold_return_pct: 0.0241,
  max_drawdown_pct: 0.0473,
  observation_count: 21,
});

const SIXTY_FORTY = makeOutsideBenchmark({
  benchmark: 'sixty_forty',
  buy_and_hold_return_pct: 0.0158,
  max_drawdown_pct: 0.0289,
  observation_count: 21,
});

describe('OutsideBenchmarkPanel (#981)', () => {
  it('renders both benchmarks with return AND drawdown together', () => {
    render(<OutsideBenchmarkPanel benchmarks={[SPY, SIXTY_FORTY]} />);

    const panel = screen.getByLabelText('Outside benchmarks');
    const rows = within(panel).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    // Each row carries BOTH columns. A row with a return and no drawdown is the
    // shape D4 rules out, and the wire type makes it unconstructible — this
    // asserts the panel does not then drop one on the floor.
    for (const row of rows) {
      expect(row.textContent).toMatch(/return\s+[-+]?[\d.]+%/);
      expect(row.textContent).toMatch(/max drawdown\s+[\d.]+%/);
    }

    expect(rows[0]?.textContent).toContain('SPY');
    expect(rows[0]?.textContent).toContain('2.41%');
    expect(rows[0]?.textContent).toContain('4.73%');
    expect(rows[1]?.textContent).toContain('60/40');
  });

  it('names the bond leg so "60/40" is not left to the reader to guess', () => {
    render(<OutsideBenchmarkPanel benchmarks={[SIXTY_FORTY]} />);
    expect(screen.getByText(/60\/40 \(SPY\/AGG\)/)).toBeTruthy();
  });

  it('states the window as the arm comparison’s own', () => {
    render(<OutsideBenchmarkPanel benchmarks={[SPY, SIXTY_FORTY]} />);
    // #636: an approximate window is noise, not a comparison. The page says the
    // windows match rather than leaving a reader to assume it.
    expect(screen.getByText(/the same window the arm comparison used/)).toBeTruthy();
  });

  it('renders an honest empty state, never zeros', () => {
    render(<OutsideBenchmarkPanel benchmarks={[]} />);

    expect(screen.getByText(/has not measured an outside benchmark yet/)).toBeTruthy();
    // Zeros would read as "the benchmark was flat" — a claim about the market
    // rather than about the measurement.
    expect(screen.queryByText(/0\.00%/)).toBeNull();
  });
});

describe('OutsideBenchmarkPanel — secondary, structurally and visibly', () => {
  it('carries the secondary class and says so in words, not only in styling', () => {
    const { container } = render(<OutsideBenchmarkPanel benchmarks={[SPY, SIXTY_FORTY]} />);

    const panel = container.querySelector('.panel-outside-benchmark');
    expect(panel).toBeTruthy();
    // The class the design system de-emphasises on — but colour and weight are
    // never the sole carrier of a signal on this page, so the words are checked
    // too.
    expect(panel?.classList.contains('panel-secondary')).toBe(true);
    expect(screen.getByText(/secondary context, not the control/)).toBeTruthy();
    expect(screen.getByText(/falsifier arm 2 is the\s+matched control/)).toBeTruthy();
  });

  it('renders NO divergence verdict and no alert styling', () => {
    const { container } = render(<OutsideBenchmarkPanel benchmarks={[SPY, SIXTY_FORTY]} />);

    // The arm panel's loudest element is `.arm-divergence`, sometimes in alert
    // colour. This panel has no equivalent and can never grow one without a
    // contract change: `OutsideBenchmarkRow` carries no `diverged` field.
    expect(container.querySelector('.arm-divergence')).toBeNull();
    expect(container.querySelector('.benchmark-divergence')).toBeNull();
    expect(container.textContent).not.toMatch(/DIVERGED/);
  });

  it('never renders the arms, so the two returns cannot be read as one column', () => {
    const { container } = render(<OutsideBenchmarkPanel benchmarks={[SPY, SIXTY_FORTY]} />);

    // The denominators differ — a benchmark is fully invested through every
    // night, the book is flat by close — so a side-by-side would invite exactly
    // the comparison #636 names as the failure mode.
    expect(container.textContent).not.toMatch(/live \(debate\)/);
    expect(container.textContent).not.toMatch(/control \(arm 2\)/);
    expect(screen.getByText(/share their units but not their denominator/)).toBeTruthy();
  });
});

describe('OutsideBenchmarkPanel — an unmeasured benchmark is absent, not zero', () => {
  it('names a benchmark missing from the latest cycle', () => {
    render(<OutsideBenchmarkPanel benchmarks={[SPY]} />);

    // FL persists nothing for a benchmark whose series it could not fetch, so
    // this state is real. The panel names it rather than dropping it silently.
    expect(screen.getByText(/Not measured this cycle: 60\/40 \(SPY\/AGG\)/)).toBeTruthy();
    expect(screen.getByText(/Absent, not zero/)).toBeTruthy();
    // And it is emphatically not drawn as a zero row.
    expect(
      within(screen.getByLabelText('Outside benchmarks')).getAllByRole('listitem'),
    ).toHaveLength(1);
  });

  it('says nothing about missing benchmarks when the cycle measured them all', () => {
    render(<OutsideBenchmarkPanel benchmarks={[SPY, SIXTY_FORTY]} />);
    expect(screen.queryByText(/Not measured this cycle/)).toBeNull();
  });

  it('shows only the latest cycle’s rows, never mixing windows', () => {
    const older = makeOutsideBenchmark({
      benchmark: 'sixty_forty',
      computed_at: '2026-07-18T12:00:00.000Z',
      window_from: '2026-06-18T12:00:00.000Z',
      window_to: '2026-07-18T12:00:00.000Z',
    });

    render(<OutsideBenchmarkPanel benchmarks={[SPY, older]} />);

    // Two benchmarks arrived, but from DIFFERENT cycles over different windows.
    // Listing them together would present two periods as one reading — the
    // thing #636 calls noise. Only the newest cycle's row is rendered, and the
    // other benchmark is correctly reported as unmeasured THIS cycle.
    const rows = within(screen.getByLabelText('Outside benchmarks')).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('SPY');
    expect(screen.getByText(/Not measured this cycle: 60\/40 \(SPY\/AGG\)/)).toBeTruthy();
  });
});
