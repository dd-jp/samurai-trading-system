/**
 * Integer settings read from the environment, refused rather than defaulted.
 *
 * Extracted from `rotating-file-sink.ts` (#325), unchanged in behaviour, when
 * `llm_call_log`'s row ceiling (#1045) became the second setting needing it.
 * The alternative was a second validator beside the first, which is how two
 * env vars in one system come to disagree about whether `"abc"` means "abc",
 * "the default", or `0`.
 *
 * The rule every caller relies on: a malformed value is a startup error, not
 * a silent fallback. These variables are operational policy — a retention
 * window, a byte ceiling, a row cap, a search-result cap — and one nobody
 * chose is worse than a refusal that names the variable.
 */

/**
 * Whitespace-only is treated as *unset*, not as an error, matching the
 * established rule that an empty value counts as absent
 * (`missingCredentialEnvVars` in index.ts takes the same line). Incidental
 * surrounding whitespace on a real value is trimmed and accepted: `' 3 '` is
 * unambiguous.
 */
export function nonEmpty(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** The one bound definition both entry points below hold a value to */
function isIntegerAtLeast(value: number, min: number): boolean {
  return Number.isSafeInteger(value) && value >= min;
}

/**
 * Holds an already-parsed integer to the same `>= min` bound
 * `positiveIntegerFromEnv` applies to a raw string, throwing the same shape
 * of startup error.
 *
 * Extracted so a value that reaches a setting by a path OTHER than
 * environment-string parsing — a `ProductionConfig` field a programmatic
 * caller set directly (#1161) — is held to the identical rule rather than
 * skipping it and reaching whatever a downstream consumer does with an
 * out-of-range number (for `SAMURAI_X_MAX_RESULTS`, `XSearchClient` clamps
 * instead of refusing, which is the right behaviour for an operator's
 * excessive value and the wrong one for a nonsensical injected value).
 */
export function requireIntegerAtLeast(
  value: number,
  name: string,
  min: number,
  purpose: string,
): number {
  if (!isIntegerAtLeast(value, min)) {
    throw new Error(
      `Orchestrator cannot start: ${name} must be an integer >= ${min}, not ` +
        `${JSON.stringify(value)}. It is ${purpose}; refused rather than defaulted, the same rule ` +
        'a malformed environment value is held to.',
    );
  }
  return value;
}

/**
 * Parses `raw` as an integer >= `min`, or throws naming the variable.
 *
 * `purpose` is the clause explaining WHAT the caller's setting governs; it is
 * required rather than defaulted, because the whole value of the message is
 * telling an operator which policy they just failed to set. A shared default
 * here would confidently misattribute one variable's failure to another's
 * feature — the specific defect that made this function worth extracting
 * rather than exporting in place.
 *
 * The `nonEmpty` guard above is load-bearing and not decoration: `Number(' ')`
 * is `0`, so without it a stray space in a deployment script would parse as a
 * real, in-range zero and silently switch retention off.
 */
export function positiveIntegerFromEnv(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  purpose: string,
): number {
  const value = nonEmpty(raw);
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!isIntegerAtLeast(parsed, min)) {
    throw new Error(
      `Orchestrator cannot start: ${name} must be an integer >= ${min}, not ` +
        `${JSON.stringify(value)}. It is ${purpose}; a value nobody meant is a setting nobody ` +
        'chose, so it is refused rather than defaulted. Unset it to accept the ' +
        `default (${fallback}).`,
    );
  }
  return parsed;
}
