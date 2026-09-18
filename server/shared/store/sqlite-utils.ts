
export function isUniqueConstraintError(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ((current as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return true;
    }
  }
  return false;
}

export type StoredTimestamp = string & { readonly __storedTimestamp: unique symbol };

const STORED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function toStoredTimestamp(value: Date): StoredTimestamp {
  const text = value.toISOString();
  if (!STORED_TIMESTAMP.test(text)) {
    throw new Error(
      `toStoredTimestamp: refusing to store ${JSON.stringify(text)} — timestamp columns must be ` +
        'fixed-width ISO-8601 UTC (YYYY-MM-DDTHH:mm:ss.sssZ), or MAX()/range queries over the ' +
        'stored TEXT stop being chronological.',
    );
  }
  return text as StoredTimestamp;
}

export function toStoredTimestampOrNull(value: Date | null): StoredTimestamp | null {
  return value === null ? null : toStoredTimestamp(value);
}

export function fromStoredTimestamp(text: string): Date {
  return new Date(text);
}

export function fromStoredTimestampOrNull(text: string | null): Date | null {
  return text === null ? null : new Date(text);
}
