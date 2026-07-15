/**
 * In-memory `SetupStore` for ticket #75 — a concrete implementation of the
 * store port (not a test-only mock), mirroring
 * src/market-data-service/fixture-data-source.ts. The Feedback Loop
 * (Stage 6, still unbuilt) will own the real SQLite-backed store against
 * the same `SetupStore` port.
 */
import type { SetupNeighbor, SetupStore, SetupVector } from '../shared/types.js';

export class FixtureSetupStore implements SetupStore {
  private readonly neighbors: SetupNeighbor[];
  private readonly written: Array<{ debateId: string; vector: SetupVector; decidedAt: Date }> = [];

  constructor(neighbors: SetupNeighbor[] = []) {
    this.neighbors = neighbors;
  }

  findNeighbors(_vector: SetupVector, asOf: Date): SetupNeighbor[] {
    return this.neighbors.filter((neighbor) => neighbor.closed_at.getTime() <= asOf.getTime());
  }

  writeSetup(debateId: string, vector: SetupVector, decidedAt: Date): void {
    this.written.push({ debateId, vector, decidedAt });
  }

  /** Test-only accessor for asserting on writes. */
  getWritten(): ReadonlyArray<{ debateId: string; vector: SetupVector; decidedAt: Date }> {
    return this.written;
  }
}
