import type { SetupNeighbor, SetupStore, SetupVector } from '../../shared/index.js';

export class FixtureSetupStore implements SetupStore {
  private readonly neighbors: SetupNeighbor[];
  private readonly written: Array<{ debateId: string; vector: SetupVector; decidedAt: Date }> = [];
  private readonly pending = new Map<string, { vector: SetupVector; decidedAt: Date }>();

  constructor(neighbors: SetupNeighbor[] = []) {
    this.neighbors = neighbors;
  }

  findNeighbors(_vector: SetupVector, asOf: Date): SetupNeighbor[] {
    return this.neighbors.filter((neighbor) => neighbor.closed_at.getTime() <= asOf.getTime());
  }

  writeSetup(debateId: string, vector: SetupVector, decidedAt: Date): void {
    if (this.written.some((entry) => entry.debateId === debateId)) return;
    this.written.push({ debateId, vector, decidedAt });
    this.pending.set(debateId, { vector, decidedAt });
  }

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

  getWritten(): ReadonlyArray<{ debateId: string; vector: SetupVector; decidedAt: Date }> {
    return this.written;
  }
}
