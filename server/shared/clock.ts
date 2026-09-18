export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class SimulatedClock implements Clock {
  private current: number;

  constructor(start: Date) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceTo(next: Date): void {
    const target = next.getTime();
    if (target < this.current) {
      throw new Error(
        `SimulatedClock.advanceTo: refusing to step backwards from ${new Date(
          this.current,
        ).toISOString()} to ${next.toISOString()}`,
      );
    }
    this.current = target;
  }
}
