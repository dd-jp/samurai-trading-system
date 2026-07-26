# Per-spec extraction format

Ask each Step 2 subagent to return exactly this shape (as markdown, one section per heading — not JSON, this gets read by a human doing the cross-referencing, not parsed by a script):

```markdown
## <spec-file-name>

### Defines (owns)
- `TypeName.field: type` — one line per field that matters cross-spec. Note units/semantics if non-obvious (e.g. "net of fees", "close_time not open_time").
- `functionOrMethod(args): returnType` — for interfaces/contracts other specs are expected to call.

### Consumes (assumes from elsewhere)
- `TypeName.field` — used how, and which upstream stage it's assumed to come from (name the stage even if the spec doesn't — infer from context and flag if you had to infer).
- Anything referenced but never defined in this spec at all — flag explicitly, these are the orphaned-dependency candidates.

### Security notes
- Secrets/API-key handling as written (or absence of any mention, if a secret clearly needs handling here).
- Injection surfaces — anything constructed from external/untrusted input.
- Authn/authz boundaries — present, missing, or delegated (to whom, and is that ever confirmed).
- Unsafe defaults — fail-open vs fail-closed, permissive parsing, missing validation at trust boundaries.

### Design-practice notes
- Missing abstraction/seam (name what's implied elsewhere that this spec should honor but doesn't).
- Coupling concerns (tight coupling to a concrete implementation where an interface is expected).
- Idempotency — present where retries/restarts are possible, or missing.
- Error/failure-mode handling — present for partial-failure scenarios, or missing.

### Performance / complexity / simplicity notes
- Overengineering candidates — complexity not justified by stated scale/frequency.
- Underengineering / likely-slow-at-scale candidates.
- Maintainability concerns — anything doing too much, named ambiguously, or duplicating logic that should live in one place.

### Verbatim quotes for anything load-bearing
Pull the exact sentence/field definition for anything you flag as a potential cross-spec contradiction — the cross-referencing pass needs to diff exact wording, not your paraphrase.
```

The last section matters more than it looks: a false contradiction from paraphrase drift wastes the cross-referencing pass's time, and a missed one from paraphrase drift is worse. When in doubt, quote.
