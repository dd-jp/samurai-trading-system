/**
 * `CONTRACT_VERSION` / `contractVersionOf` (#1316) — the value the client
 * compares against the server's `DashboardSnapshot.contract_version` on
 * every poll (`useSnapshot.ts`) to detect a served-client-vs-server wire
 * skew. The property under test is narrow and deliberate: the hash must be
 * CONTENT-SENSITIVE to the field list it is derived from, so that a rename
 * of a top-level `DashboardSnapshot` field is impossible to ship silently —
 * `DASHBOARD_SNAPSHOT_FIELD_NAMES`'s `as const satisfies` clause plus
 * `_assertDashboardSnapshotFieldNamesCoverAllKeys` (this file's siblings,
 * enforced at `yarn typecheck` time) are together what stop the field list
 * itself from drifting from the interface in either direction — a listed
 * name that isn't a real field, or a real field that's missing from the
 * list; this suite is what proves the value derived from that list actually
 * moves when the list does.
 */
import { CONTRACT_VERSION, contractVersionOf, DASHBOARD_SNAPSHOT_FIELD_NAMES } from './snapshot.js';

describe('contractVersionOf', () => {
  it('is deterministic for the same field list', () => {
    const fields = ['generated_at', 'as_of', 'mode'];
    expect(contractVersionOf(fields)).toBe(contractVersionOf([...fields]));
  });

  it('changes when a field is renamed', () => {
    const before = contractVersionOf(['generated_at', 'as_of', 'mode']);
    const after = contractVersionOf(['generated_at', 'as_of', 'run_mode']);
    expect(after).not.toBe(before);
  });

  it('changes when a field is added', () => {
    const before = contractVersionOf(['generated_at', 'as_of']);
    const after = contractVersionOf(['generated_at', 'as_of', 'contract_version']);
    expect(after).not.toBe(before);
  });

  it('changes when a field is removed', () => {
    const before = contractVersionOf(['generated_at', 'as_of', 'mode']);
    const after = contractVersionOf(['generated_at', 'as_of']);
    expect(after).not.toBe(before);
  });

  it('changes when field order changes, since a positional shift is still a shape change a stale reader could misparse', () => {
    const before = contractVersionOf(['a', 'b']);
    const after = contractVersionOf(['b', 'a']);
    expect(after).not.toBe(before);
  });

  it('is stable in-process across repeated reads of the real DashboardSnapshot field list', () => {
    // Guards against the constant being computed from something
    // non-deterministic (e.g. object key iteration order of a `Record`
    // rather than a fixed array) — every real client build and every real
    // server process must derive the exact same value from the exact same
    // source for the comparison in `useSnapshot.ts` to mean anything.
    // Re-derives CONTRACT_VERSION independently from the same field list
    // rather than comparing the constant to itself (a tautology that can
    // never fail) — this actually exercises `contractVersionOf` a second
    // time against the real field list, not a hand-picked one.
    expect(contractVersionOf(DASHBOARD_SNAPSHOT_FIELD_NAMES)).toBe(CONTRACT_VERSION);
    expect(typeof CONTRACT_VERSION).toBe('string');
    expect(CONTRACT_VERSION.length).toBeGreaterThan(0);
  });
});
