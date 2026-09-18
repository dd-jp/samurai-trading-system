
export class ProtectiveRearmUnsupportedError extends Error {
  readonly protectiveRearmUnsupported = true;
  readonly venue: string;

  constructor(venue: string, message: string) {
    super(message);
    this.name = 'ProtectiveRearmUnsupportedError';
    this.venue = venue;
  }
}

export function isProtectiveRearmUnsupported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { protectiveRearmUnsupported?: unknown }).protectiveRearmUnsupported === true;
}
