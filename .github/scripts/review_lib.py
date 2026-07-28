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

SYSTEM_PROMPT = """\
You are a strict senior reviewer for a live-money multi-agent trading system \
(crypto + stocks). Review the PR diff across exactly these five dimensions, \
in this order: Performance, Code Quality, Simplicity, Security, Blast Radius.

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
persistence). State the overall blast radius tier for this PR and justify it \
using the specific files changed. For HIGH or MEDIUM tier PRs, call out what a \
failure in this diff could actually break in production (e.g. lost orders, \
double fills, corrupted state, incorrect risk limits) and whether the diff \
includes matching test coverage.

Respond with a single JSON object, no markdown fences, matching exactly this shape:
{
  "summary_markdown": "<the full five-section review, one '### <Dimension>' \
heading per dimension in the order above, 'No issues found.' under any \
dimension with nothing to flag>",
  "inline_comments": [
    {"file": "<path exactly as it appears in the diff, no a/ or b/ prefix>",
     "line": <int, the line number in the NEW version of the file>,
     "severity": "high" | "medium" | "low",
     "body": "<specific, actionable comment>"}
  ],
  "verdict": "APPROVE" | "APPROVE_WITH_COMMENTS" | "REQUEST_CHANGES"
}
Only include an inline comment where you can point at a specific line — put \
everything else in summary_markdown. Use APPROVE only when you have no \
material concerns across all five dimensions.
"""


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


def call_model(diff: str, changed_files: list[str], model: str, api_key: str, base_url: str) -> dict:
    blast_radius_context = classify_blast_radius(changed_files)
    user_content = (
        f"Blast-radius file classification:\n{blast_radius_context}\n\n"
        f"PR diff:\n\n{diff}"
    )

    # max_retries=0: we own the retry/backoff loop below so failures are
    # visible and paced deliberately, instead of the SDK silently retrying
    # with its own (much shorter) backoff first.
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=170.0, max_retries=0)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]

    raw = None
    last_exc = None
    for attempt in range(TRANSIENT_MAX_ATTEMPTS):
        try:
            try:
                resp = client.chat.completions.create(
                    model=model, response_format={"type": "json_object"}, messages=messages
                )
            except Exception as exc:  # noqa: BLE001 - proxy may reject response_format for this model
                print(f"warning: request with response_format failed ({exc}); retrying without it", file=sys.stderr)
                resp = client.chat.completions.create(model=model, messages=messages)
            raw = resp.choices[0].message.content or ""
            break
        except Exception as exc:  # noqa: BLE001 - upstream 5xx/timeouts are common on this endpoint
            last_exc = exc
            if attempt < TRANSIENT_MAX_ATTEMPTS - 1:
                wait = TRANSIENT_BACKOFF_SECONDS[attempt]
                print(
                    f"warning: model call failed ({exc}); retrying in {wait}s "
                    f"(attempt {attempt + 2}/{TRANSIENT_MAX_ATTEMPTS})",
                    file=sys.stderr,
                )
                time.sleep(wait)

    if raw is None:
        return {
            "summary_markdown": (
                f"_This reviewer ({model}) could not be reached after {TRANSIENT_MAX_ATTEMPTS} "
                f"attempts and was skipped. Last error: {last_exc}_"
            ),
            "inline_comments": [],
            "verdict": None,
        }

    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        # Model may have wrapped the JSON in prose or code fences; try to
        # recover the largest {...} block before giving up.
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        try:
            parsed = json.loads(match.group(0)) if match else None
        except (json.JSONDecodeError, TypeError):
            parsed = None

        if parsed is None:
            return {
                "summary_markdown": f"_Review model returned non-JSON output; posting raw text._\n\n{raw}",
                "inline_comments": [],
                "verdict": None,
            }

    if not isinstance(parsed.get("inline_comments"), list):
        parsed["inline_comments"] = []
    if "summary_markdown" not in parsed:
        parsed["summary_markdown"] = "_Model response missing summary_markdown._"
    if parsed.get("verdict") not in ("APPROVE", "APPROVE_WITH_COMMENTS", "REQUEST_CHANGES"):
        parsed["verdict"] = None

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

    summary = model_result["summary_markdown"]
    if rejected:
        summary += "\n\n---\n_Additional comments the reviewer made outside the diff's visible lines (could not be anchored inline):_\n"
        for c in rejected:
            sev = c.get("severity", "?")
            summary += f"- **{c.get('file', '?')}:{c.get('line', '?')}** ({sev}): {c.get('body', '')}\n"

    verdict = model_result["verdict"]
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
