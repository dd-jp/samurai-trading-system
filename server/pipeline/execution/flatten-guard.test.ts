import type { Clock } from '../../shared/index.js';
import { recordingLogger } from '../../shared/recording-logger.js';
import { boundedUnresolvedFlattens } from './flatten-guard.js';
import type {
  FlattenReconcileAlert,
  FlattenReconcileAlertChannel,
} from './flatten-reconcile-alert.js';
import { UNRESOLVABLE_FLATTEN_MAX_AGE_MS } from './reconcile.js';
import type { SharedStore, UnresolvedFlattenSubmission } from './types.js';

const NOW = new Date('2026-09-14T15:00:00Z');

function fixedClock(now: Date): Clock {
  return { now: () => now };
}

function fakeStore(
  rows: UnresolvedFlattenSubmission[],
): Pick<SharedStore, 'getUnresolvedFlattens'> {
  return { getUnresolvedFlattens: async () => rows };
}

function recordingAlerts(): FlattenReconcileAlertChannel & { alerts: FlattenReconcileAlert[] } {
  const alerts: FlattenReconcileAlert[] = [];
  return {
    alerts,
    postFlattenReconcileAlert: async (alert) => {
      alerts.push(alert);
    },
  };
}

function makeRow(
  overrides: Partial<UnresolvedFlattenSubmission> = {},
): UnresolvedFlattenSubmission {
  return {
    idempotency_key: 'flatten-1',
    instrument: 'AAPL',
    status: 'submitted',
    submitted_at: NOW,
    ...overrides,
  };
}

describe('boundedUnresolvedFlattens (#1500)', () => {
  it('returns a row still within the age bound — the #1389/#516 protection is unchanged', async () => {
    const withinBound = new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS - 1));
    const store = fakeStore([makeRow({ submitted_at: withinBound })]);
    const flattenReconcileAlerts = recordingAlerts();
    const unresolvedFlattens = boundedUnresolvedFlattens({
      store,
      clock: fixedClock(NOW),
      flattenReconcileAlerts,
      logger: recordingLogger(),
      trace_id: 'flatten-guard',
    });

    const result = await unresolvedFlattens();

    expect(result.map((row) => row.instrument)).toEqual(['AAPL']);
    expect(flattenReconcileAlerts.alerts).toEqual([]);
  });

  it('drops a row past the age bound and no longer blocks the instrument', async () => {
    const pastBound = new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1));
    const store = fakeStore([makeRow({ submitted_at: pastBound })]);
    const flattenReconcileAlerts = recordingAlerts();
    const unresolvedFlattens = boundedUnresolvedFlattens({
      store,
      clock: fixedClock(NOW),
      flattenReconcileAlerts,
      logger: recordingLogger(),
      trace_id: 'flatten-guard',
    });

    const result = await unresolvedFlattens();

    expect(result).toEqual([]);
  });

  it('posts an alert naming the instrument when the bound trips', async () => {
    const pastBound = new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1));
    const store = fakeStore([
      makeRow({ idempotency_key: 'flatten-old', instrument: 'TSLA', submitted_at: pastBound }),
    ]);
    const flattenReconcileAlerts = recordingAlerts();
    const unresolvedFlattens = boundedUnresolvedFlattens({
      store,
      clock: fixedClock(NOW),
      flattenReconcileAlerts,
      logger: recordingLogger(),
      trace_id: 'flatten-guard',
    });

    await unresolvedFlattens();

    expect(flattenReconcileAlerts.alerts).toHaveLength(1);
    expect(flattenReconcileAlerts.alerts[0]).toMatchObject({
      trace_id: 'flatten-guard',
      idempotency_key: 'flatten-old',
      instrument: 'TSLA',
      observed_at: NOW,
    });
    expect(flattenReconcileAlerts.alerts[0]?.reason).toContain('TSLA');
  });

  it('alerts once per row, not once per call, across repeated ticks', async () => {
    const pastBound = new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1));
    const store = fakeStore([makeRow({ idempotency_key: 'flatten-old', submitted_at: pastBound })]);
    const flattenReconcileAlerts = recordingAlerts();
    const unresolvedFlattens = boundedUnresolvedFlattens({
      store,
      clock: fixedClock(NOW),
      flattenReconcileAlerts,
      logger: recordingLogger(),
      trace_id: 'flatten-guard',
    });

    await unresolvedFlattens();
    await unresolvedFlattens();
    await unresolvedFlattens();

    expect(flattenReconcileAlerts.alerts).toHaveLength(1);
  });

  it('leaves a fresh row blocking alongside a dropped aged-out row on the same call', async () => {
    const withinBound = new Date(NOW.getTime() - 1000);
    const pastBound = new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1));
    const store = fakeStore([
      makeRow({ idempotency_key: 'flatten-fresh', instrument: 'AAPL', submitted_at: withinBound }),
      makeRow({ idempotency_key: 'flatten-stale', instrument: 'TSLA', submitted_at: pastBound }),
    ]);
    const unresolvedFlattens = boundedUnresolvedFlattens({
      store,
      clock: fixedClock(NOW),
      flattenReconcileAlerts: recordingAlerts(),
      logger: recordingLogger(),
      trace_id: 'flatten-guard',
    });

    const result = await unresolvedFlattens();

    expect(result.map((row) => row.idempotency_key)).toEqual(['flatten-fresh']);
  });

  it('logs, rather than throws, when the alert channel itself fails', async () => {
    const pastBound = new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1));
    const store = fakeStore([makeRow({ submitted_at: pastBound })]);
    const logger = recordingLogger();
    const unresolvedFlattens = boundedUnresolvedFlattens({
      store,
      clock: fixedClock(NOW),
      flattenReconcileAlerts: {
        postFlattenReconcileAlert: async () => {
          throw new Error('transport down');
        },
      },
      logger,
      trace_id: 'flatten-guard',
    });

    await expect(unresolvedFlattens()).resolves.toEqual([]);
    expect(logger.entries.some((e) => e.event === 'flatten_guard_bound_alert_send_failed')).toBe(
      true,
    );
  });
});
