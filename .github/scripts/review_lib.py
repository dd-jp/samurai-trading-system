import json
import re
import subprocess
import sys
import time

from openai import OpenAI

MAX_DIFF_CHARS = 60000

# Nous's inference proxy has been observed hard-timing-out (Cloudflare 524,
# "origin took too long to respond") on slower models like kimi-k3, well
# within GitHub Actions' step budget. Retry with backoff rather than
# treating a single timeout as fatal.
TRANSIENT_MAX_ATTEMPTS = 3
TRANSIENT_BACKOFF_SECONDS = (20, 90)

# Blast-radius tiers, based on this repo's src/ layout and the live-money
# constraints in CLAUDE.md (persistence, order execution, risk management).
HIGH_RISK_PREFIXES = ("src/execution/", "src/risk-manager/", "src/shared/store/")
MEDIUM_RISK_PREFIXES = ("src/orchestrator/", "src/trader/", "src/debate-engine/")

# Shared across both prompt variants below so the review criteria can't drift
# out of sync between them — only the closing instructions differ.
_DIMENSIONS = """\
### Performance
Look for unnecessary allocations, O(n^2)+ patterns on hot paths, blocking calls \
on the event loop, unbounded loops/retries, N+1 queries against the SQLite store.

### Code Quality
Correctness bugs, missing error handling at real boundaries (broker API, \
websocket feeds), type-safety gaps, dead code, inconsistent naming/structure \
relative to the rest of the file.

### Simplicity
Overengineering, unnecessary abstraction, premature generalization, or code \
that could be meaningfully shorter without losing clarity. Also flag the \
opposite: logic that's too clever/compressed to follow.

### Security
Secrets/keys in code or logs, injection risks, unsafe deserialization, missing \
input validation at system boundaries, broker credentials or order data handled \
unsafely, anything that could enable unintended fund movement.

### Blast Radius
You are given a classification of changed files into HIGH / MEDIUM / LOW risk \
tiers (based on whether they touch order execution, risk management, or \
persistence).\
"""

_INTRO = """\
You are a strict senior reviewer for a live-money multi-agent trading system \
(crypto + stocks). Review the PR diff across exactly these five dimensions, \
in this order: Performance, Code Quality, Simplicity, Security, Blast Radius.

"""

_RESPONSE_SHAPE = """\
Respond with a single JSON object, no markdown fences, matching exactly this shape:
{{
  "summary_markdown": {summary_markdown_field},
  "inline_comments": [
    {{"file": "<path exactly as it appears in the diff, no a/ or b/ prefix>",
     "line": <int, the line number in the NEW version of the file>,
     "severity": "high" | "medium" | "low",
     "body": "<specific, actionable comment>"}}
  ],
  "verdict": "APPROVE" | "APPROVE_WITH_COMMENTS" | "REQUEST_CHANGES"
}}
{closing}\
"""

SYSTEM_PROMPT = (
    _INTRO
    + _DIMENSIONS
    + """ State the overall blast radius tier for this PR and justify it \
using the specific files changed. For HIGH or MEDIUM tier PRs, call out what a \
failure in this diff could actually break in production (e.g. lost orders, \
double fills, corrupted state, incorrect risk limits) and whether the diff \
includes matching test coverage.

Be compact: use short bullet points, not prose paragraphs, and for any dimension \
with nothing to flag just write "No issues found." rather than padding it out. \
The response must fit within the token budget — brevity beats exhaustive \
explanation.

"""
    + _RESPONSE_SHAPE.format(
        summary_markdown_field=(
            '"<the full five-section review, one \'### <Dimension>\' '
            "heading per dimension in the order above, 'No issues found.' under any "
            'dimension with nothing to flag>"'
        ),
        closing=(
            "Only include an inline comment where you can point at a specific line — put "
            "everything else in summary_markdown. Use APPROVE only when you have no "
            "material concerns across all five dimensions; conversely, if you raised no "
            "material concern anywhere, the verdict must be APPROVE."
        ),
    )
)

# Inline-only variant: skips the prose summary entirely so the model spends
# its whole token budget on line-anchored comments. Used for reviewers whose
# upstream proxy has a hard response-time ceiling (see TRANSIENT_MAX_ATTEMPTS
# comment above) — less generated text means a better chance of finishing
# before that ceiling hits.
SYSTEM_PROMPT_INLINE_ONLY = (
    _INTRO
    + _DIMENSIONS
    + """ If a HIGH or MEDIUM tier file changes without matching test \
coverage, or a diff in one of those files risks lost orders, double fills, \
corrupted state, or incorrect risk limits, raise it as an inline comment on \
the relevant line.

Do NOT write an overall prose summary — put every finding as a separate inline \
comment anchored to a specific line. Skip a dimension entirely (no comment) \
when there is nothing to flag; do not write "No issues found." anywhere. Be \
terse: one to two sentences per comment, no padding. This keeps the response \
short enough to finish within the upstream proxy's response-time limit.

"""
    + _RESPONSE_SHAPE.format(
        summary_markdown_field='""',
        closing=(
            "Always set summary_markdown to an empty string. Only include an inline comment "
            "where you can point at a specific line — if a finding doesn't anchor to a "
            "diff line, drop it rather than writing prose elsewhere. Use APPROVE only when "
            "you have no material concerns across all five dimensions; conversely, if "
            "inline_comments is empty, the verdict must be APPROVE."
        ),
    )
)


def classify_blast_radius(changed_files: list[str]) -> str:
    high = [f for f in changed_files if f.startswith(HIGH_RISK_PREFIXES)]
    medium = [f for f in changed_files if f.startswith(MEDIUM_RISK_PREFIXES)]
    low = [f for f in changed_files if f not in high and f not in medium]

    lines = []
    if high:
        lines.append("HIGH risk files (execution/risk/persistence):")
        lines.extend(f"  - {f}" for f in high)
    if medium:
        lines.append("MEDIUM risk files (orchestrator/trader/debate-engine):")
        lines.extend(f"  - {f}" for f in medium)
    if low:
        lines.append("LOW risk files (everything else):")
        lines.extend(f"  - {f}" for f in low)
    return "\n".join(lines) if lines else "No changed files detected."


def get_changed_files(base_ref: str | None) -> list[str]:
    if not base_ref:
        print("warning: BASE_REF not set, skipping blast-radius classification", file=sys.stderr)
        return []

    result = subprocess.run(
        ["git", "diff", "--name-only", f"origin/{base_ref}...HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        print(f"warning: git diff failed, skipping blast-radius classification: {result.stderr}", file=sys.stderr)
        return []

    return [line for line in result.stdout.splitlines() if line.strip()]


_HUNK_HEADER = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def commentable_lines(diff_text: str) -> dict[str, set[int]]:
    """Map each file (as it appears in the diff's new version) to the set of
    new-file line numbers that GitHub's review API will accept a comment on
    (i.e. lines actually present in a diff hunk)."""
    result: dict[str, set[int]] = {}
    current_file = None
    new_line = None

    for raw_line in diff_text.splitlines():
        if raw_line.startswith("+++ "):
            path = raw_line[4:].strip()
            if path == "/dev/null":
                current_file = None
            else:
                current_file = path[2:] if path.startswith("b/") else path
                result.setdefault(current_file, set())
            new_line = None
            continue

        hunk_match = _HUNK_HEADER.match(raw_line)
        if hunk_match:
            new_line = int(hunk_match.group(1))
            continue

        if new_line is None or current_file is None:
            continue

        if raw_line.startswith("+") or raw_line.startswith(" "):
            result[current_file].add(new_line)
            new_line += 1
        elif raw_line.startswith("-"):
            pass  # removed line: doesn't exist in new file, don't advance new_line
        # anything else (e.g. "\ No newline at end of file") is ignored

    return result


def parse_model_output(raw: str | None) -> dict | None:
    """Normalise a model response into the review dict, or return None when the
    output is unusable (empty, or truncated past the point of recovery).

    None is the signal to retry: #409 showed both shapes — content_chars=0 and
    a half-written JSON object — arriving with finish_reason=length, and the
    old code posted each of them verbatim as a review."""
    if not raw or not raw.strip():
        return None

    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        # Model may have wrapped the JSON in prose or code fences; recover the
        # largest {...} block before giving up.
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        try:
            parsed = json.loads(match.group(0)) if match else None
        except (json.JSONDecodeError, TypeError):
            parsed = None

    if not isinstance(parsed, dict):
        return None

    if not isinstance(parsed.get("inline_comments"), list):
        parsed["inline_comments"] = []
    if "summary_markdown" not in parsed:
        parsed["summary_markdown"] = "_Model response missing summary_markdown._"
    if parsed.get("verdict") not in ("APPROVE", "APPROVE_WITH_COMMENTS", "REQUEST_CHANGES"):
        parsed["verdict"] = None

    return parsed


def call_model(
    diff: str,
    changed_files: list[str],
    model: str,
    api_key: str,
    base_url: str,
    max_tokens: int = 8192,
    inline_only: bool = False,
    client=None,
) -> dict:
    blast_radius_context = classify_blast_radius(changed_files)
    user_content = (
        f"Blast-radius file classification:\n{blast_radius_context}\n\n"
        f"PR diff:\n\n{diff}"
    )

    # max_retries=0: we own the retry/backoff loop below so failures are
    # visible and paced deliberately, instead of the SDK silently retrying
    # with its own (much shorter) backoff first.
    if client is None:
        client = OpenAI(api_key=api_key, base_url=base_url, timeout=170.0, max_retries=0)
    system_prompt = SYSTEM_PROMPT_INLINE_ONLY if inline_only else SYSTEM_PROMPT
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]

    parsed = None
    last_exc: object = None
    for attempt in range(TRANSIENT_MAX_ATTEMPTS):
        chunks: list[str] = []
        finish_reason = None
        start = time.monotonic()
        first_chunk_at = None
        try:
            # Stream rather than wait for the full completion. Cloudflare's
            # 524 fires when the origin hasn't sent a *complete* response
            # within its proxy timeout (~100s) — with stream=False, kimi-k3's
            # hidden chain-of-thought means no bytes go out until generation
            # is entirely done, so a slow-but-otherwise-healthy generation
            # looks identical to a hung origin. Streaming sends bytes as soon
            # as the first token is produced, which keeps the connection
            # under Cloudflare's idle/first-byte timeout instead of its
            # total-response one.
            # No response_format: Nous's endpoint doesn't document JSON-mode
            # support, and constrained-decoding JSON modes on self-hosted
            # backends are a common cause of exactly this kind of latency.
            # We rely on the prompt's JSON instructions plus the regex
            # extraction fallback below instead.
            stream = client.chat.completions.create(
                model=model, messages=messages, max_tokens=max_tokens, stream=True
            )
            for event in stream:
                if first_chunk_at is None:
                    first_chunk_at = time.monotonic()
                choice = event.choices[0] if event.choices else None
                if choice is None:
                    continue
                if choice.delta and choice.delta.content:
                    chunks.append(choice.delta.content)
                if choice.finish_reason:
                    finish_reason = choice.finish_reason
            raw = "".join(chunks)
            ttfc = f"{first_chunk_at - start:.1f}s" if first_chunk_at else "None"
            print(
                f"debug: finish_reason={finish_reason} content_chars={len(raw)} "
                f"time_to_first_chunk={ttfc} "
                f"total_time={time.monotonic() - start:.1f}s",
                file=sys.stderr,
            )
            parsed = parse_model_output(raw)
            if parsed is not None:
                break
            # Truncated or empty: the request itself succeeded, so the old code
            # broke out of the loop here and posted the fragment as a review.
            # Spend a retry instead — the same call has been observed finishing
            # cleanly on the next attempt (#409, runs on #404).
            last_exc = (
                f"unusable output (finish_reason={finish_reason}, content_chars={len(raw)})"
            )
        except Exception as exc:  # noqa: BLE001 - upstream 5xx/timeouts are common on this endpoint
            last_exc = exc

        if attempt < TRANSIENT_MAX_ATTEMPTS - 1:
            wait = TRANSIENT_BACKOFF_SECONDS[attempt]
            print(
                f"warning: model call failed ({last_exc}); retrying in {wait}s "
                f"(attempt {attempt + 2}/{TRANSIENT_MAX_ATTEMPTS})",
                file=sys.stderr,
            )
            time.sleep(wait)

    if parsed is None:
        return {
            "summary_markdown": (
                f"_This reviewer ({model}) produced no usable review in "
                f"{TRANSIENT_MAX_ATTEMPTS} attempts and was skipped. "
                f"Last error: {last_exc}_"
            ),
            "inline_comments": [],
            "verdict": None,
        }

    return parsed


def build_review_payload(diff_text: str, model_result: dict) -> dict:
    valid_lines = commentable_lines(diff_text)

    accepted = []
    rejected = []
    for c in model_result["inline_comments"]:
        file = c.get("file")
        line = c.get("line")
        body = c.get("body", "")
        if not file or not isinstance(line, int):
            rejected.append(c)
            continue
        if line in valid_lines.get(file, set()):
            accepted.append({"path": file, "line": line, "side": "RIGHT", "body": body})
        else:
            rejected.append(c)

    summary = model_result["summary_markdown"] or ""
    if rejected:
        summary += "\n\n---\n_Additional comments the reviewer made outside the diff's visible lines (could not be anchored inline):_\n"
        for c in rejected:
            sev = c.get("severity", "?")
            summary += f"- **{c.get('file', '?')}:{c.get('line', '?')}** ({sev}): {c.get('body', '')}\n"

    verdict = model_result["verdict"]

    # The inline-only prompt forces summary_markdown to "", so a review whose
    # findings all anchor inline — or which found nothing — used to reach
    # GitHub as a zero-length body (#409: BODYLEN=0 rows on #396 and #404).
    # A reader can't tell that apart from a broken reviewer.
    if not summary.strip():
        anchored = f"{len(accepted)} inline comment{'' if len(accepted) == 1 else 's'}"
        summary = (
            f"_No prose summary from this reviewer (inline-only mode). "
            f"Verdict: **{verdict or 'none parsed'}**; {anchored} posted._"
        )

    if verdict == "APPROVE":
        event = "APPROVE"
    else:
        # Never auto-block: REQUEST_CHANGES, APPROVE_WITH_COMMENTS, and
        # unparseable verdicts all post as a plain comment review. Merge
        # gating for "both bots must approve" comes from branch protection's
        # required-approvals count, not from this bot requesting changes.
        event = "COMMENT"

    return {
        "summary_markdown": summary,
        "comments": accepted,
        "event": event,
        "verdict": verdict,
    }
