// @vitest-environment jsdom
//
// Smoke test proving the vitest+jsdom+RTL wiring runs under the repo's
// root `yarn test` (issue #536) — not a test of any real snapshot data,
// which App.tsx does not render yet (that's later tickets under wayfinder
// map #533). `describe`/`it`/`expect` are imported explicitly rather than
// relying on `vitest/globals` ambient types, so the app's tsconfig never
// needs to see the test globals (dashboard-spec.md's split between the
// build and test tsconfig projects follows the same reasoning).
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App.tsx';

// No `@testing-library/jest-dom` matchers (`toBeInTheDocument`,
// `toHaveClass`, ...) — it is not in this ticket's devDependency list
// (issue #536), so assertions below use plain DOM properties instead.
describe('App', () => {
  it('renders the telemetry strip, rooms hero and bento panels', () => {
    render(<App />);

    // `getByLabelText` throws if no match is found, so a successful call is
    // itself the assertion; the truthy checks make that explicit.
    expect(screen.getByLabelText('Telemetry')).toBeTruthy();
    expect(screen.getByLabelText('Pipeline rooms')).toBeTruthy();
    expect(screen.getByLabelText('Panels')).toBeTruthy();
  });

  it('draws room 04 (invalidation) lights-off with its reason', () => {
    render(<App />);

    // Anchored on the room's accessible heading rather than a bare
    // `document.querySelector` (PR #563 review); `closest` then walks up to
    // the room container, whose lights-off class is presentational and has
    // no accessible query of its own.
    const invalidationRoom = screen
      .getByRole('heading', { name: 'Invalidation' })
      .closest('[data-room="invalidation"]');
    expect(invalidationRoom).not.toBeNull();
    expect(invalidationRoom?.classList.contains('room-lights-off')).toBe(true);
    expect(screen.getByText(/specced and not built/i)).toBeTruthy();
  });
});
