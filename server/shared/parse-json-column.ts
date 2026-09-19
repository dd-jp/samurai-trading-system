export function parseJsonColumnAsObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  return parsed as Record<string, unknown>;
}
