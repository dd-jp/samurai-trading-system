const REDACTED = '[redacted]';

export function redactEvidence(
  value: unknown,
  secrets: readonly string[],
  identityKeys: ReadonlySet<string>,
): unknown {
  const live = secrets.filter((secret) => secret.length > 0);
  if (typeof value === 'string') {
    return live.reduce((text, secret) => text.split(secret).join(REDACTED), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item, live, identityKeys));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      identityKeys.has(key) ? REDACTED : redactEvidence(item, live, identityKeys),
    ]),
  );
}
