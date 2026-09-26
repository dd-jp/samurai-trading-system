// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { overview } from '../test-wire.ts';
import { StatusStrip } from './StatusStrip.tsx';

const noop = () => undefined;

describe('StatusStrip (P14 and the feed state)', () => {
  it('shows the mode, the last cycle, the unfed schedule and ping, and the data time', () => {
    render(<StatusStrip overview={overview()} status="ok" error={null} token="t" onRecorded={noop} />);
    const line = screen.getByRole('banner', { name: 'Status' }).querySelector('.strip-line');
    expect(line?.textContent).toBe(
      'PAPERLast cycle 2026-10-05, recorded 2026-10-05 21:40ZNext due not yet fed (#1784)Ping not yet fed (#1784)Data as of 2026-10-06 21:40Z',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the heartbeat as fed or empty when the server says so', () => {
    render(
      <StatusStrip
        overview={overview({
          mode: 'dry-run',
          heartbeat: {
            last_cycle: { status: 'empty' },
            next_due: { status: 'fed', due_date: '2026-10-07' },
            last_ping: { status: 'fed', pinged_at: '2026-10-06T21:41:00.000Z' },
          },
        })}
        status="ok"
        error={null}
        token="t"
        onRecorded={noop}
      />,
    );
    const text = screen.getByRole('banner').textContent;
    expect(text).toContain('DRY-RUN');
    expect(text).toContain('Last cycle none yet');
    expect(text).toContain('Next due 2026-10-07');
    expect(text).toContain('Ping 2026-10-06 21:41Z');
  });

  it.each([
    ['waiting', null, 'Waiting for the first response.'],
    ['unauthorized', null, 'The dashboard token is missing or wrong.'],
    ['contract-mismatch', null, 'different contract version'],
    ['failed', 'HTTP 503', 'The last refresh failed: HTTP 503.'],
  ] as const)('warns when the feed is %s', (status, error, message) => {
    render(<StatusStrip overview={null} status={status} error={error} token={null} onRecorded={noop} />);
    expect(screen.getByRole('alert').textContent).toContain(message);
  });
});
