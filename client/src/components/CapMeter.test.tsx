// @vitest-environment jsdom
/**
 * The shared shape behind the rail's spend and drawdown meters. Fraction and
 * tone-threshold behaviour is asserted here, once, so neither caller has to
 * re-prove it.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CapMeter } from './CapMeter.tsx';

const format = (n: number) => `$${n.toFixed(2)}`;

function renderMeter(overrides: Partial<Parameters<typeof CapMeter>[0]> = {}) {
  return render(
    <CapMeter
      dataField="test-meter"
      heading="Test meter"
      value={50}
      cap={200}
      format={format}
      tone="cyan"
      emptyState="not drawable"
      trackLabel={(fraction, value, cap) => `used ${fraction} of ${value}/${cap}`}
      footnote={(over) => <span data-testid="footnote">{over ? 'over' : 'under'}</span>}
      {...overrides}
    />,
  );
}

describe('CapMeter', () => {
  it('renders the value and cap through the caller-supplied formatter', () => {
    renderMeter();
    expect(screen.getByText('$50.00 / $200.00')).toBeTruthy();
  });

  it('shows UNKNOWN for a missing value and an uncapped denominator', () => {
    renderMeter({ value: undefined, cap: null });
    expect(screen.getByText('— / —')).toBeTruthy();
  });

  it('draws the fill at value/cap and asks the caller for the accessible label', () => {
    renderMeter({ value: 50, cap: 200 });
    expect(screen.getByRole('img', { name: 'used 0.25 of 50/200' })).toBeTruthy();
  });

  it('uses the caller tone below the threshold', () => {
    renderMeter({ value: 50, cap: 200, tone: 'amber' });
    const fill = document.querySelector('.track-fill');
    expect(fill?.className).toContain('track-amber');
    expect(fill?.className).not.toContain('track-bad');
  });

  it('turns bad exactly at the threshold, regardless of the caller tone', () => {
    renderMeter({ value: 200, cap: 200, tone: 'amber' });
    const fill = document.querySelector('.track-fill');
    expect(fill?.className).toContain('track-bad');
  });

  it('turns bad once the value exceeds the cap', () => {
    renderMeter({ value: 250, cap: 200 });
    const fill = document.querySelector('.track-fill');
    expect(fill?.className).toContain('track-bad');
  });

  it('tells the footnote whether the meter is over, via the same threshold', () => {
    renderMeter({ value: 250, cap: 200 });
    expect(screen.getByTestId('footnote').textContent).toBe('over');
  });

  it('renders the caller empty state and no meter when the value is missing', () => {
    renderMeter({ value: undefined });
    expect(screen.getByText('not drawable')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders the caller empty state and no meter when the cap is null', () => {
    renderMeter({ cap: null });
    expect(screen.getByText('not drawable')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('is not drawable, and reports not-over, for a non-finite value', () => {
    renderMeter({ value: Number.NaN });
    expect(screen.getByText('not drawable')).toBeTruthy();
    expect(screen.getByTestId('footnote').textContent).toBe('under');
  });

  it('is not drawable against a non-positive cap', () => {
    renderMeter({ cap: 0 });
    expect(screen.getByText('not drawable')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('is not drawable when a finite value and a finite positive cap divide to a non-finite quotient', () => {
    renderMeter({ value: Number.MAX_VALUE, cap: Number.MIN_VALUE });
    expect(screen.getByText('not drawable')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders the footnote in both the drawable and empty-state cases', () => {
    const { rerender } = renderMeter({ value: 50, cap: 200 });
    expect(screen.getByTestId('footnote')).toBeTruthy();
    rerender(
      <CapMeter
        dataField="test-meter"
        heading="Test meter"
        value={undefined}
        cap={200}
        format={format}
        tone="cyan"
        emptyState="not drawable"
        trackLabel={(fraction, value, cap) => `used ${fraction} of ${value}/${cap}`}
        footnote={(over) => <span data-testid="footnote">{over ? 'over' : 'under'}</span>}
      />,
    );
    expect(screen.getByTestId('footnote')).toBeTruthy();
  });

  it('sets the data-field attribute the caller supplies', () => {
    renderMeter({ dataField: 'llm-cap' });
    expect(document.querySelector('[data-field="llm-cap"]')).toBeTruthy();
  });
});
