import json
import re
import subprocess
import sys
import time
from typing import Callable, NamedTuple

from openai import OpenAI

# Per-CALL cap, not a per-PR cap. The diff used to be hard-truncated to this
# many characters (`f.read()[:MAX_DIFF_CHARS]`) with nothing said about it:
# #591's diff is 162 123 chars, so both reviewers read ~37% of it and one of
# them posted APPROVE on the strength of that (#594). The diff is now SLICED
# to this size and every slice is reviewed; anything that still can't be
# covered is disclosed and blocks an APPROVE.
MAX_SLICE_CHARS = 60000

# Ceiling on model calls per reviewer per run: each slice is a separate call
# with its own retry budget, so an unbounded count is an unbounded bill and an
# unbounded runtime. Exceeding it is NOT a silent truncation — the leftover
# files route through the same partial-coverage disclosure as any other
# unreviewed content, which is what makes the cap safe to have at all.
MAX_SLICES = 10

# GitHub rejects a review body over 65536 chars with a 422, and the workflow's
# fallback only retries a 422 whose message matches /could not be resolved/ —
# an oversized body re-raises and the job goes red with NO review posted.
# Slicing made that reachable: the prose prompt writes a five-section review
# PER SLICE. Clamp below the limit, with visible headroom for the note.
MAX_REVIEW_BODY_CHARS = 63000

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


_DIFF_GIT_HEADER = re.compile(r"^diff --git a/(.+?) b/(.+)$")


def changed_files_from_diff(diff_text: str) -> list[str]:
    """Changed-file list read straight out of the diff text.

    Used when BASE_REF is absent — a `workflow_dispatch` run has no
    `github.base_ref`, so `get_changed_files`' `origin/<base>...HEAD` range
    doesn't exist and blast-radius classification would silently come back
    empty. Parses `diff --git` headers rather than reusing
    `commentable_lines`, which drops `/dev/null` targets and would therefore
    hide deletions from the risk tiers."""
    files: list[str] = []
    for raw_line in diff_text.splitlines():
        match = _DIFF_GIT_HEADER.match(raw_line)
        if not match:
            continue
        # b/ side is the new path; for a deletion it repeats the old path,
        # which is what we want in the classification either way.
        path = match.group(2)
        if path not in files:
            files.append(path)
    return files


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


class DiffSlice(NamedTuple):
    text: str
    files: tuple[str, ...]


class SlicePlan(NamedTuple):
    slices: list[DiffSlice]
    #: Human-readable reasons for diff content that no slice covers. Non-empty
    #: means the review CANNOT be presented as whole-PR (see ReviewCoverage).
    skipped: list[str]


class ReviewCoverage(NamedTuple):
    slices_total: int
    slices_reviewed: int
    skipped: tuple[str, ...] = ()

    @property
    def is_complete(self) -> bool:
        return not self.skipped and self.slices_reviewed >= self.slices_total

    def disclosure(self) -> str:
        """Markdown banner naming exactly what went unread. Empty when the
        whole diff was reviewed."""
        if self.is_complete:
            return ""
        lines = [
            "> [!WARNING]",
            "> **Partial review — this is NOT a whole-PR verdict.** Part of the diff was "
            f"never read by this reviewer ({self.slices_reviewed}/{self.slices_total} "
            "slices reviewed). Treat silence about the rest as absence of evidence, not "
            "evidence of absence.",
        ]
        failed = self.slices_total - self.slices_reviewed
        if failed > 0:
            lines.append(f"> - {failed} diff slice(s) produced no usable review.")
        lines.extend(f"> - {reason}" for reason in self.skipped)
        lines.append("> - The verdict is capped below APPROVE while any of the diff is unread.")
        return "\n".join(lines)


def _split_file_block(header: str, hunks: list[str], max_chars: int) -> tuple[list[str], list[str]]:
    """Split one file's diff into per-call chunks on HUNK boundaries.

    Every chunk repeats the file header (`diff --git` / `---` / `+++`) so each
    one is a valid, self-contained diff — `commentable_lines` and the model
    both need the `+++ b/<path>` line to know what file they're looking at.
    Never splits inside a hunk: a half-hunk has no `@@` anchor, so any comment
    on it would be rejected by the line-anchoring filter downstream anyway.

    Returns (chunks, skipped_reasons)."""
    chunks: list[str] = []
    skipped: list[str] = []
    current = ""

    for hunk in hunks:
        if len(header) + len(hunk) > max_chars:
            # A single hunk that doesn't fit even on its own. Sending it would
            # mean silently cutting mid-hunk; skipping it is disclosed.
            first_line = hunk.splitlines()[0] if hunk.splitlines() else "@@"
            skipped.append(
                f"hunk `{first_line.strip()}` is {len(hunk)} chars on its own "
                f"(> {max_chars} cap) and could not be split further — NOT reviewed"
            )
            continue
        if current and len(header) + len(current) + len(hunk) > max_chars:
            chunks.append(header + current)
            current = ""
        current += hunk

    if current:
        chunks.append(header + current)
    if not chunks and not skipped:
        # An over-cap file block with no hunks at all (e.g. a huge header-only
        # entry). Dropping it silently is the exact failure this ticket exists
        # to kill, so it is disclosed like any other unreviewed content.
        skipped.append(f"file header is {len(header)} chars with no hunks — NOT reviewed")
    return chunks, skipped


def split_diff_into_slices(
    diff_text: str,
    max_chars: int = MAX_SLICE_CHARS,
    max_slices: int = MAX_SLICES,
) -> SlicePlan:
    """Slice a unified diff into per-call pieces, on file boundaries first and
    hunk boundaries only when a single file is larger than the cap."""
    if not diff_text.strip():
        return SlicePlan(slices=[], skipped=[])

    # Group the raw text into (path, header, hunks) per file.
    blocks: list[tuple[str, str, list[str]]] = []
    path = ""
    header = ""
    hunks: list[str] = []

    def flush() -> None:
        if header or hunks:
            blocks.append((path or "<unknown>", header, list(hunks)))

    for raw_line in diff_text.splitlines(keepends=True):
        git_match = _DIFF_GIT_HEADER.match(raw_line.rstrip("\n"))
        if git_match:
            flush()
            path, header, hunks = git_match.group(2), raw_line, []
            continue
        if _HUNK_HEADER.match(raw_line):
            hunks.append(raw_line)
            continue
        if hunks:
            hunks[-1] += raw_line
        else:
            header += raw_line
    flush()

    slices: list[DiffSlice] = []
    skipped: list[str] = []
    current_text = ""
    current_files: list[str] = []

    def close_slice() -> None:
        nonlocal current_text, current_files
        if current_text:
            slices.append(DiffSlice(text=current_text, files=tuple(current_files)))
        current_text, current_files = "", []

    for file_path, file_header, file_hunks in blocks:
        block_text = file_header + "".join(file_hunks)
        if len(block_text) <= max_chars:
            if current_text and len(current_text) + len(block_text) > max_chars:
                close_slice()
            current_text += block_text
            current_files.append(file_path)
            continue

        # Oversized file: it gets its own slices, split on hunk boundaries.
        close_slice()
        chunks, chunk_skips = _split_file_block(file_header, file_hunks, max_chars)
        skipped.extend(f"`{file_path}`: {reason}" for reason in chunk_skips)
        for chunk in chunks:
            slices.append(DiffSlice(text=chunk, files=(file_path,)))

    close_slice()

    if len(slices) > max_slices:
        dropped = slices[max_slices:]
        dropped_files = sorted({f for s in dropped for f in s.files})
        skipped.append(
            f"{len(dropped)} slice(s) over the {max_slices}-slice per-run cap were NOT "
            f"reviewed, covering: {', '.join(f'`{f}`' for f in dropped_files)}"
        )
        slices = slices[:max_slices]

    return SlicePlan(slices=slices, skipped=skipped)


_VERDICT_SEVERITY = {"APPROVE": 0, "APPROVE_WITH_COMMENTS": 1, "REQUEST_CHANGES": 2}


def merge_model_results(results: list[dict], slice_files: list[tuple[str, ...]]) -> dict:
    """Fold one model result per slice into a single review.

    Comments are concatenated and de-duplicated on (file, line, body) — the
    same finding can legitimately surface in two slices when a file was split.
    The verdict is the most severe across slices; a slice that produced no
    usable verdict yields None, which `build_review_payload` refuses to treat
    as an APPROVE."""
    comments: list[dict] = []
    seen: set[tuple] = set()
    summaries: list[str] = []
    severity = -1
    any_unusable = False

    for index, result in enumerate(results):
        for comment in result.get("inline_comments") or []:
            key = (comment.get("file"), comment.get("line"), comment.get("body"))
            if key in seen:
                continue
            seen.add(key)
            comments.append(comment)

        summary = (result.get("summary_markdown") or "").strip()
        if summary:
            if len(results) > 1:
                files = slice_files[index] if index < len(slice_files) else ()
                # Named files, capped: a slice can hold a dozen paths and the
                # heading would otherwise be longer than the review under it.
                label = ", ".join(f"`{f}`" for f in files[:3]) or "(unknown files)"
                if len(files) > 3:
                    label += f" +{len(files) - 3} more"
                summary = f"#### Slice {index + 1} of {len(results)} — {label}\n\n{summary}"
            summaries.append(summary)

        verdict = result.get("verdict")
        if verdict is None:
            any_unusable = True
        else:
            severity = max(severity, _VERDICT_SEVERITY[verdict])

    merged_verdict = None
    if not any_unusable and severity >= 0:
        merged_verdict = next(k for k, v in _VERDICT_SEVERITY.items() if v == severity)

    return {
        "summary_markdown": "\n\n".join(summaries),
        "inline_comments": comments,
        "verdict": merged_verdict,
    }


def review_diff(
    diff_text: str,
    changed_files: list[str],
    *,
    call: Callable[..., dict] | None = None,
    max_chars: int = MAX_SLICE_CHARS,
    max_slices: int = MAX_SLICES,
    **model_kwargs,
) -> dict:
    """Review a whole diff, in slices, and return the payload to post.

    This is the entry point `run_review.py` calls; the orchestration lives here
    rather than in the script so the tests in this directory actually exercise
    the shipped path."""
    call = call or call_model
    plan = split_diff_into_slices(diff_text, max_chars=max_chars, max_slices=max_slices)

    if not plan.slices:
        return build_review_payload(
            diff_text,
            {
                "summary_markdown": "_No diff detected — nothing to review._",
                "inline_comments": [],
                "verdict": None,
            },
            coverage=ReviewCoverage(0, 0, tuple(plan.skipped)),
        )

    results: list[dict] = []
    reviewed = 0
    for index, diff_slice in enumerate(plan.slices):
        print(
            f"info: reviewing slice {index + 1}/{len(plan.slices)} "
            f"({len(diff_slice.text)} chars, {len(diff_slice.files)} file(s))",
            file=sys.stderr,
        )
        # Classify only the files IN this slice. Handing every call the whole
        # PR's file list would invite findings on code the call was never
        # shown — and those anchor fine against the full diff, so they'd post
        # as real comments on unread lines.
        slice_files = list(diff_slice.files) or changed_files
        result = call(diff=diff_slice.text, changed_files=slice_files, **model_kwargs)
        results.append(result)
        if result.get("verdict") is not None or result.get("inline_comments"):
            reviewed += 1

    merged = merge_model_results(results, [s.files for s in plan.slices])
    coverage = ReviewCoverage(
        slices_total=len(plan.slices),
        slices_reviewed=reviewed,
        skipped=tuple(plan.skipped),
    )
    # The FULL diff, not the slice: a comment is anchorable if the line is in
    # any hunk of the PR, and the merged comments span every slice.
    return build_review_payload(diff_text, merged, coverage=coverage)


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


def _is_fatal_request_error(exc: BaseException) -> bool:
    """True for provider responses that will never succeed on retry: any 4xx
    except 429. Classified on the status code, not on a message match, so a
    rejected `max_tokens` and a rejected model name are both caught."""
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "response", None), "status_code", None)
    return isinstance(status, int) and 400 <= status < 500 and status != 429


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
            # A 4xx is the provider REFUSING the request as sent — an over-cap
            # max_tokens, a bad model name, a dead key. Retrying it three times
            # and then posting "_this reviewer produced no usable review_"
            # dresses a configuration fault up as a flaky endpoint, which is
            # how #594's kimi budget stayed broken. Fail the job with the
            # provider's own error instead. 429 stays in the retry loop: rate
            # limiting IS transient.
            if _is_fatal_request_error(exc):
                raise
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


def build_review_payload(
    diff_text: str, model_result: dict, coverage: ReviewCoverage | None = None
) -> dict:
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

    # Partial coverage downgrades the verdict BEFORE anything renders it, so
    # the blank-summary fallback below can't quote a stale "Verdict: APPROVE".
    # #594: `deepseek-review` posted APPROVED on #591 having read 37% of it,
    # and nothing in the review said so — a silently-partial APPROVE is worse
    # than no review, because it manufactures confidence exactly where a large
    # change most needs scrutiny. This is the single choke point for that rule:
    # every caller reaches it.
    partial = coverage is not None and not coverage.is_complete
    if partial and verdict == "APPROVE":
        verdict = "APPROVE_WITH_COMMENTS"

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

    # The disclosure leads the body — buried at the bottom it would be read
    # after the reader has already formed a view from the findings above it.
    if partial:
        summary = f"{coverage.disclosure()}\n\n{summary}".strip()

    # Clamp AFTER the disclosure is prepended, so an oversized body can never
    # cost us the partial-coverage warning. The cut is stated in the body, not
    # silent — same rule as everything else here.
    if len(summary) > MAX_REVIEW_BODY_CHARS:
        note = (
            f"\n\n_…review body truncated at {MAX_REVIEW_BODY_CHARS} characters "
            "(GitHub's limit is 65536); the text above is complete, the text below it "
            "was cut._"
        )
        summary = summary[: MAX_REVIEW_BODY_CHARS - len(note)] + note

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
