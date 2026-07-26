# Report structure

Model this on `docs/specs/cross-spec-contracts.md`'s existing voice: terse, load-bearing-first, every finding gets a concrete fix. Use this exact skeleton:

```markdown
# Cross-Spec Verification Pass — <date>

Specs reviewed: <list of files, folder path noted>.
<If an existing registry file was present, note it here and that contradictions with it were treated as HIGH.>

## Contradiction matrix

For each contradiction found between two (or more) specs:

- **GAP-<letter> — <one-line problem statement>.** `<spec-A>` says `<verbatim quote or exact field/type>`, but `<spec-B>` <assumes/defines/consumes> `<verbatim quote or exact field/type that conflicts>`. **Fix:** <concrete change, naming which spec should change and why it's the non-authoritative side>.

If none found: state that explicitly — "No cross-spec field/type contradictions found" — don't omit the section.

## Security findings

Ranked HIGH/MEDIUM/LOW. Each: which spec(s), the concrete risk (not "consider security here" — name the exploit or failure), and the fix.

## Design-practice findings

Missing abstractions, tight coupling, missing idempotency, missing error boundaries — and overengineering flagged with equal weight. Each gets a concrete fix, e.g. "extract X behind the Y interface `spec-Z` already assumes" rather than "consider an interface."

## Performance / maintainability / complexity / simplicity findings

Same ranked structure. Distinguish "will be slow/expensive at stated scale" from "unnecessarily complex for the problem" — both are findings, don't conflate them.

## Confirmed clean

What was checked and found consistent — proves this wasn't a skim. Reference the specific things verified (an idempotency key, a shared type, a boundary), not a vague "looks fine overall."

## Open questions

Anything that couldn't be resolved without the user's judgment call (e.g. "which spec should own X" when both plausibly could) — pose as a specific question, not a vague flag.
```

Severity definitions (keep consistent across runs so the ranking means the same thing every time):

- **HIGH** — MVP-blocking, load-bearing across ≥2 consumers, or contradicts an existing frozen registry/decision.
- **MEDIUM** — real, will cause a bug or rework later, but doesn't block moving forward today.
- **LOW** — polish: naming, minor duplication, a nice-to-have simplification.
