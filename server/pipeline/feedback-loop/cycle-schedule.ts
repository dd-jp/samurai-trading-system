
export function currentBoundary(now: Date, intervalMs: number): Date {
  if (intervalMs <= 0) {
    throw new Error(`currentBoundary: intervalMs must be positive, got ${intervalMs}`);
  }
  return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
}

export function nextBoundary(now: Date, intervalMs: number): Date {
  return new Date(currentBoundary(now, intervalMs).getTime() + intervalMs);
}

export function isBoundaryDue(boundary: Date, last: Date | null): boolean {
  return last === null || boundary.getTime() > last.getTime();
}
