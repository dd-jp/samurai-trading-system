/**
 * Integer settings read from the environment, refused rather than defaulted.
 *
 * Extracted from `rotating-file-sink.ts` (#325), unchanged in behaviour, when
 * `llm_call_log`'s row ceiling (#1045) became the second setting needing it.
 * The alternative was a second validator beside the first, which is how two
 * env vars in one system come to disagree about whether `"abc"` means "abc",
 * "the default", or `0`.
 *
 * The rule both callers rely on: a malformed value is a startup error, not a
 * silent fallback. These variables are retention policy, and a retention
 * window nobody chose is worse than a refusal that names the variable.
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
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(
      `Orchestrator cannot start: ${name} must be an integer >= ${min}, not ` +
        `${JSON.stringify(value)}. It is ${purpose}; a value nobody meant is a retention ` +
        'window nobody chose, so it is refused rather than defaulted. Unset it to accept the ' +
        `default (${fallback}).`,
    );
  }
  return parsed;
}
