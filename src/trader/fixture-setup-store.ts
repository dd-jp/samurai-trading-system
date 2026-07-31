/**
 * In-memory `SetupStore` for ticket #75 — a concrete implementation of the
 * store port (not a test-only mock), mirroring
 * src/market-data-service/fixture-data-source.ts. The Feedback Loop (#92)
 * owns the `labelSetup` side of this same port; the real SQLite-backed store
 * is still deferred.
 */
import type { SetupNeighbor, SetupStore, SetupVector } from '../shared/index.js';

export class FixtureSetupStore implements SetupStore {
  private readonly neighbors: SetupNeighbor[];
  private readonly written: Array<{ debateId: string; vector: SetupVector; decidedAt: Date }> = [];
  /** Setups written but not yet labelled — findNeighbors cannot see these (point-in-time). */
  private readonly pending = new Map<string, { vector: SetupVector; decidedAt: Date }>();

  constructor(neighbors: SetupNeighbor[] = []) {
    this.neighbors = neighbors;
  }

  findNeighbors(_vector: SetupVector, asOf: Date): SetupNeighbor[] {
    return this.neighbors.filter((neighbor) => neighbor.closed_at.getTime() <= asOf.getTime());
  }

  writeSetup(debateId: string, vector: SetupVector, decidedAt: Date): void {
    this.written.push({ debateId, vector, decidedAt });
    this.pending.set(debateId, { vector, decidedAt });
  }

  /**
   * Moves a pending write into `neighbors` once its outcome is known, so it
   * becomes visible to `findNeighbors` from `closed_at` onward. Throws on an
   * unknown `debate_id` (unjoinable — no matching `writeSetup`) or a repeat
   * label on the same `debate_id` (exactly-once, per `SetupStore.labelSetup`).
   */
  labelSetup(debateId: string, rMultiple: number, closedAt: Date): void {
    const entry = this.pending.get(debateId);
    if (entry === undefined) {
      throw new Error(
        `FixtureSetupStore.labelSetup: no pending setup for debate_id '${debateId}' — ` +
          'either it was never written or has already been labelled.',
      );
    }

    this.pending.delete(debateId);
    this.neighbors.push({ vector: entry.vector, r_multiple: rMultiple, closed_at: closedAt });
  }

  /** Test-only accessor for asserting on writes. */
  getWritten(): ReadonlyArray<{ debateId: string; vector: SetupVector; decidedAt: Date }> {
    return this.written;
  }
}
