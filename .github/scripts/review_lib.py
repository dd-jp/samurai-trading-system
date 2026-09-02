import json
import re
import subprocess
import sys
import time
from collections.abc import Sequence
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

# Hard ceiling on how much diff is read into memory at all. Removing the old
# 60k truncation was the point of #594, but removing it with NO ceiling trades
# a silent lie for a dead runner: the whole file is read, then multiplied by
# `splitlines(keepends=True)` and the per-block joins, so a PR carrying large
# generated files could OOM the job and post nothing.
#
# Sized well above what can actually be reviewed (MAX_SLICES * MAX_SLICE_CHARS
# = 600k) so it only ever bites content that was never going to be read
# anyway, and 12x #591's 162k. Crucially this is NOT a silent truncation: the
# cut lands on a file boundary and every dropped file is named in the banner.
MAX_TOTAL_DIFF_CHARS = 2_000_000

# Cap on how many dropped filenames to name individually in the banner.
_MAX_NAMED_DROPPED_FILES = 20

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

# Severities that earn a line-anchored comment. Everything else the model
# labels — `low`, in the schema — is still reported, but folded into the body
# rather than spent as an inline comment: the volume of low-severity inline
# comments is what makes a re-reviewed PR unreadable. NOT a drop: a gated
# finding gets its own body section, and the section says why it isn't inline.
#
# An unrecognised or missing severity is treated as inline-worthy, never as
# `low`. The model's JSON is untrusted input, and a parse miss that silently
# demoted a `high` finding into a body bullet would be the same class of quiet
# lie the coverage banner exists to prevent.
INLINE_SEVERITIES = frozenset({"high", "medium"})

# Marker appended to every inline comment body so a later run can recognise
# its own prior findings. Keyed on the REVIEWER, not the posting identity:
# the matrix runs deepseek and kimi concurrently, and matching on the bot
# login would let whichever leg posts first suppress the other leg's findings
# on the same line. HTML comment, so it renders invisibly on GitHub.
REVIEW_MARKER_TEMPLATE = "<!-- ai-review:{reviewer} -->"

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


def get_changed_files(base_ref: str | None) -> list[str] | None:
    """The PR's changed files per git, or None when git could not tell us.

    None, NOT [] — the distinction is load-bearing. This list is `review_diff`'s
    independent cross-check on the slicer, so an empty list reads as "the
    slicer missed nothing" and makes that check silently vacuous for the whole
    run. A safety net that quietly stops catching things is worse than no net,
    because the rest of the design trusts it. None says "unknown" and gets
    disclosed in the banner."""
    if not base_ref:
        print("warning: BASE_REF not set, cannot cross-check slice coverage", file=sys.stderr)
        return None

    result = subprocess.run(
        # core.quotePath=false so a non-ASCII path comes back in the same
        # (unquoted) form the diff parser produces — otherwise review_diff's
        # coverage cross-check would report it as unsliced and post a false
        # partial-coverage banner.
        ["git", "-c", "core.quotePath=false", "diff", "--name-only", f"origin/{base_ref}...HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        print(
            f"warning: git diff failed, slice coverage cannot be cross-checked: "
            f"{safe_error_text(result.stderr)}",
            file=sys.stderr,
        )
        return None

    return [line for line in result.stdout.splitlines() if line.strip()]


# git C-quotes any path with non-ASCII bytes, quotes, or control characters
# (`core.quotePath`, on by default): `diff --git "a/caf\303\251.ts" "b/..."`.
# A pattern that only knows the bare `a/... b/...` form silently fails to
# match those, and in `split_diff_into_slices` the file's whole body then
# merges into the PREVIOUS file's block — one file's content reviewed under
# another file's name, with nothing saying so. The workflow additionally sets
# `core.quotePath=false` so the quoted forms should not arise in the first
# place.
_QUOTED_PATH = r'"(?:[^"\\]|\\.)*"'
_DIFF_GIT_PREFIX = "diff --git "

# git quotes each side INDEPENDENTLY, so a rename can quote one and not the
# other: `diff --git a/plain.ts "b/caf\303\251.ts"`. All four combinations are
# matched, in most-specific-first order; the both-bare case falls through to
# the ` b/` split below.
_DIFF_GIT_FORMS = (
    re.compile(rf"^({_QUOTED_PATH}) ({_QUOTED_PATH})$"),  # both quoted
    re.compile(rf"^({_QUOTED_PATH}) (b/.+)$"),  # old quoted, new bare
    re.compile(rf"^(a/.+?) ({_QUOTED_PATH})$"),  # old bare, new quoted
)

_C_ESCAPES = {
    "a": "\a", "b": "\b", "f": "\f", "n": "\n",
    "r": "\r", "t": "\t", "v": "\v", "\\": "\\", '"': '"',
}


def _unquote_git_path(token: str, prefix: str) -> str:
    """Undo git's C-style path quoting and strip the `a/` or `b/` prefix."""
    if not (len(token) >= 2 and token.startswith('"') and token.endswith('"')):
        return token[len(prefix):] if token.startswith(prefix) else token

    body = token[1:-1]
    out = bytearray()
    i = 0
    while i < len(body):
        char = body[i]
        if char != "\\":
            out.extend(char.encode("utf-8"))
            i += 1
            continue
        nxt = body[i + 1] if i + 1 < len(body) else ""
        if nxt in _C_ESCAPES:
            out.extend(_C_ESCAPES[nxt].encode("utf-8"))
            i += 2
            continue
        # Exactly three octal digits, in range. git always emits all three
        # (`\303`), so a 1-2 digit prefix at end-of-string is malformed input,
        # not a short escape — accepting it would silently mangle the path.
        # The range check is separate from the digit check on purpose: \777
        # parses fine as octal but is not a byte, and folding both into one
        # `except ValueError` reported the second as "not valid octal".
        octal = body[i + 1 : i + 4]
        if len(octal) == 3 and all(c in "01234567" for c in octal):
            value = int(octal, 8)
            if value <= 0xFF:
                out.append(value)
                i += 4
                continue
        # Not a usable escape: keep the backslash verbatim rather than
        # dropping bytes out of a path.
        out.extend(char.encode("utf-8"))
        i += 1
    path = out.decode("utf-8", errors="replace")
    return path[len(prefix):] if path.startswith(prefix) else path


def diff_git_paths(raw_line: str) -> tuple[str, str] | None:
    """(old_path, new_path) from a `diff --git` line.

    Handles all four quoting combinations, because git quotes each side
    independently — a rename can quote only the new path.

    The both-bare form `diff --git a/X b/Y` is genuinely ambiguous when a path
    contains the literal `" b/"`; git emits it anyway. Splitting at the first
    occurrence gets it wrong (BOTH paths come out wrong, and the file is then
    tracked under a mangled name), so the equal-paths split is preferred
    first. That resolves everything except a rename where the path also
    contains `" b/"` — unresolvable from this line alone, and it fails safe:
    the coverage cross-check reports the file as unsliced."""
    if not raw_line.startswith(_DIFF_GIT_PREFIX):
        return None

    rest = raw_line[len(_DIFF_GIT_PREFIX) :]
    for form in _DIFF_GIT_FORMS:
        match = form.match(rest)
        if match:
            return (
                _unquote_git_path(match.group(1), "a/"),
                _unquote_git_path(match.group(2), "b/"),
            )

    if not rest.startswith("a/"):
        return None
    splits = [m.start() for m in re.finditer(r" b/", rest)]
    if not splits:
        return None
    # Same path both sides — the non-rename case, which is nearly all of them.
    for index in splits:
        old, new = rest[2:index], rest[index + 3 :]
        if old == new:
            return (old, new)
    return (rest[2 : splits[0]], rest[splits[0] + 3 :])


# Read granularity for the streamed tail scan in `read_capped_diff` below.
_TAIL_SCAN_READ_CHARS = 65536

# A `diff --git a/<path> b/<path>` header line is bounded by real
# path-length limits (a Linux/macOS path is capped at 4096 bytes each side),
# so a not-yet-newline-terminated line already longer than this can never
# still resolve into one. Past this point the rest of that line is dropped
# rather than held, which is what keeps `read_capped_diff`'s scan bounded
# even against a single line spanning megabytes with no embedded newline —
# a minified or generated file, the exact case MAX_TOTAL_DIFF_CHARS cites as
# the reason the read-time ceiling exists at all.
_MAX_PENDING_LINE_CHARS = 16384


def _cap_pending_line(pending: str, skipping: bool) -> tuple[str, bool]:
    """Drop `pending` once it can no longer be a `diff --git` header line.

    Returns the (possibly-cleared) buffer and whether the scan is now mid an
    overlong line it has stopped tracking."""
    if len(pending) > _MAX_PENDING_LINE_CHARS:
        return "", True
    return pending, skipping


def read_capped_diff(
    path: str, limit: int = MAX_TOTAL_DIFF_CHARS
) -> tuple[str, list[str]]:
    """Read a diff file, bounded, cutting on a file boundary.

    Returns (diff_text, skipped_reasons). The remainder past the cut is
    streamed in fixed-size chunks purely to NAME the files being dropped, so
    the banner can say what went unreviewed instead of the run silently
    reviewing a prefix. The not-yet-terminated tail line is bounded to
    `_MAX_PENDING_LINE_CHARS` rather than held in full — a single line with
    no embedded newline for megabytes (minified/generated output) would
    otherwise defeat the point of streaming past the cut at all. Peak
    retained text for this pass is therefore one read chunk plus that cap,
    not "the whole file," but it is not literally zero either.
    """
    with open(path) as handle:
        text = handle.read(limit + 1)
        if len(text) <= limit:
            return text, []

        # Cut back to the last complete file entry so no half-file is handed
        # to the slicer. Search from the end; the leading `\n` keeps us from
        # matching the string inside a diff body line.
        boundary = text.rfind("\n" + _DIFF_GIT_PREFIX)
        if boundary <= 0:
            # One file bigger than the whole cap: nothing can be safely kept.
            kept, tail_start = "", text
        else:
            kept, tail_start = text[: boundary + 1], text[boundary + 1 :]

        dropped: list[str] = []
        truncated_names = False
        # `pending` carries the trailing partial line forward across reads —
        # a `diff --git` header straddling a chunk boundary would be missed
        # by any scheme that treated reads as independent — capped by
        # `_cap_pending_line` so it never grows past one bounded line
        # regardless of how long the underlying line actually is.
        pending, skipping_overlong_line = _cap_pending_line(tail_start, False)
        for chunk in iter(lambda: handle.read(_TAIL_SCAN_READ_CHARS), ""):
            pending += chunk
            lines = pending.split("\n")
            pending = lines.pop()
            if skipping_overlong_line and lines:
                # `lines[0]` is only the TAIL of the line the cap made us
                # stop tracking — its start is already gone, so it can never
                # be parsed as a header. Everything after it is a normal,
                # fully-seen line.
                lines = lines[1:]
                skipping_overlong_line = False
            for raw in lines:
                paths = diff_git_paths(raw)
                if paths is None:
                    continue
                if len(dropped) < _MAX_NAMED_DROPPED_FILES:
                    dropped.append(paths[1])
                else:
                    truncated_names = True
            pending, skipping_overlong_line = _cap_pending_line(
                pending, skipping_overlong_line
            )
        if not skipping_overlong_line:
            paths = diff_git_paths(pending)
            if paths is not None and len(dropped) < _MAX_NAMED_DROPPED_FILES:
                dropped.append(paths[1])

    listed = ", ".join(md_code(f) for f in dropped) or "(no file headers found)"
    if truncated_names:
        listed += ", …"
    reason = (
        f"the diff is larger than the {limit}-char per-run ceiling, so "
        f"{len(text) - len(kept)}+ chars were never read and NOT reviewed, covering: {listed}"
    )
    return kept, [reason]


def md_code(text: object) -> str:
    """Wrap text as a markdown code span that it cannot escape from.

    Paths reach a posted review body, and a path is untrusted text: it comes
    from the diff, and `_unquote_git_path` can decode a backtick or even a
    newline out of a C-quoted name. Naive f"`{path}`" lets that close the
    span early and inject markdown into a durable body — the same family as
    the upstream-error leak. Fenced per CommonMark: one more backtick than
    the longest run inside, padded when it starts or ends with one."""
    flat = " ".join(str(text).split())
    longest = max((len(run) for run in re.findall(r"`+", flat)), default=0)
    fence = "`" * (longest + 1)
    pad = " " if flat.startswith("`") or flat.endswith("`") else ""
    return f"{fence}{pad}{flat}{pad}{fence}"


def changed_files_from_diff(diff_text: str) -> list[str]:
    """Changed-file list read straight out of the diff text.

    Used when BASE_REF is absent — a `workflow_dispatch` run has no
    `github.base_ref`, so `get_changed_files`' `origin/<base>...HEAD` range
    doesn't exist and blast-radius classification would silently come back
    empty. Parses `diff --git` headers rather than reusing
    `commentable_lines`, which drops `/dev/null` targets and would therefore
    hide deletions from the risk tiers."""
    files: list[str] = []
    seen: set[str] = set()  # membership set: `in files` is O(n) per header
    for raw_line in diff_text.splitlines():
        paths = diff_git_paths(raw_line)
        if paths is None:
            continue
        # b/ side is the new path; for a deletion it repeats the old path,
        # which is what we want in the classification either way.
        path = paths[1]
        if path not in seen:
            seen.add(path)
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
                # Same C-quoting as the `diff --git` line: an anchor keyed on
                # the raw `"b/caf\303\251.ts"` text matches no path GitHub
                # knows, so every comment on that file would be rejected.
                current_file = _unquote_git_path(path, "b/")
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
    #: Paths already named in `skipped`, structured so `review_diff`'s
    #: cross-check can tell "this file is missing and nobody said so" from
    #: "this file is missing and the reason is already in the banner" — a
    #: banner that lists the same file twice teaches readers to skim it.
    skipped_files: tuple[str, ...] = ()


class ReviewCoverage(NamedTuple):
    slices_total: int
    slices_reviewed: int
    skipped: tuple[str, ...] = ()
    #: Failed slices that `skipped` already explains individually. Subtracted
    #: from the generic "N slice(s) produced no usable review" line so one
    #: loss is never counted as two — same rule as `SlicePlan.skipped_files`.
    failures_explained: int = 0
    #: Inline comments carried over from slices that did NOT complete. They
    #: are kept because an anchored finding is worth more than the tidiness
    #: of dropping it, but the banner must then say the page contains
    #: findings from a slice it also calls unreviewed.
    partial_comments: int = 0
    #: The independent cross-check on the slicer could not run. Distinct from
    #: `skipped`, which is content KNOWN to be unread — here everything may
    #: well have been reviewed, we just cannot demonstrate it. Kept separate so
    #: the banner states whichever is actually true instead of claiming lost
    #: content that may not exist.
    coverage_unverified: bool = False

    @property
    def content_was_lost(self) -> bool:
        return bool(self.skipped) or self.slices_reviewed < self.slices_total

    @property
    def is_complete(self) -> bool:
        return not self.content_was_lost and not self.coverage_unverified

    @property
    def no_usable_review(self) -> bool:
        """True when the reviewer attempted at least one slice and NONE of
        them came back usable — the shape #567 reports: the check goes green
        having produced no review at all.

        Deliberately narrower than `content_was_lost`: a PR where 9/10 slices
        came back fine and one didn't is a partial-coverage disclosure, not a
        "this reviewer never ran" failure — flagging that too would turn one
        flaky slice on a large, legitimate PR into a red job, which is the
        disruption the issue itself warns against. And `slices_total == 0`
        (nothing was ever attempted — a no-op diff, or every byte skipped
        before any model call) is excluded on purpose: nothing was attempted
        there, which is a different failure mode than attempting and getting
        nothing back."""
        return self.slices_total > 0 and self.slices_reviewed == 0

    def disclosure(self) -> str:
        """Markdown banner naming exactly what went unread. Empty when the
        whole diff was reviewed and that could be verified."""
        if self.is_complete:
            return ""
        if self.content_was_lost:
            headline = (
                "> **Partial review — this is NOT a whole-PR verdict.** Part of the diff was "
                f"never read by this reviewer ({self.slices_reviewed}/{self.slices_total} "
                "slices reviewed). Treat silence about the rest as absence of evidence, not "
                "evidence of absence."
            )
        else:
            # Every slice came back, so claiming lost content here would be its
            # own false statement — the defect this banner exists to prevent.
            headline = (
                "> **Unverified coverage — this is NOT a whole-PR verdict.** Every slice was "
                f"reviewed ({self.slices_reviewed}/{self.slices_total}), but the independent "
                "check that no file was missed could not run, so full coverage cannot be "
                "demonstrated."
            )
        lines = ["> [!WARNING]", headline]
        if self.coverage_unverified:
            lines.append(
                "> - The changed-file list could not be determined, so slice coverage was "
                "NOT independently cross-checked — a file the slicer missed would not have "
                "been detected on this run."
            )
        failed = self.slices_total - self.slices_reviewed - self.failures_explained
        if failed > 0:
            lines.append(f"> - {failed} diff slice(s) produced no usable review.")
        lines.extend(f"> - {reason}" for reason in self.skipped)
        if self.partial_comments:
            plural = "" if self.partial_comments == 1 else "s"
            lines.append(
                f"> - {self.partial_comments} inline comment{plural} below came from a slice "
                f"that did not complete. They are findings from a partial pass, kept because "
                f"an anchored finding is still worth reading — not evidence that the rest of "
                f"that slice is clean."
            )
        lines.append(
            "> - The verdict is capped below APPROVE while any of the diff is unread."
            if self.content_was_lost
            else "> - The verdict is capped below APPROVE while coverage is unverified."
        )
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
            # Hoisted: this hunk is 60k+ chars by definition, so splitting it
            # twice to read one line is 60k of needless copying.
            hunk_lines = hunk.splitlines()
            first_line = hunk_lines[0] if hunk_lines else "@@"
            # State which side actually blew the cap. The condition is
            # header + hunk, so a modest hunk behind a large file header hits
            # this too — reporting that as "the hunk is too big" sends whoever
            # triages it looking at the wrong thing.
            skipped.append(
                f"hunk {md_code(first_line.strip())} ({len(hunk)} chars) plus the "
                f"{len(header)}-char file header exceeds the {max_chars} cap and could "
                f"not be split further — NOT reviewed"
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
    #
    # Lines accumulate in lists and are joined once. `s += line` on a list
    # ELEMENT (`hunks[-1] += line`) cannot use CPython's in-place string
    # concat optimisation — it copies the whole accumulated string every
    # line, so one 160k-char hunk costs hundreds of MB of memcpy.
    blocks: list[tuple[str, str, list[str]]] = []
    path = ""
    header_parts: list[str] = []
    hunk_parts: list[list[str]] = []

    def flush() -> None:
        if header_parts or hunk_parts:
            blocks.append(
                (
                    path or "<unknown>",
                    "".join(header_parts),
                    ["".join(parts) for parts in hunk_parts],
                )
            )

    for raw_line in diff_text.splitlines(keepends=True):
        git_paths = diff_git_paths(raw_line.rstrip("\n"))
        if git_paths is not None:
            flush()
            path, header_parts, hunk_parts = git_paths[1], [raw_line], []
            continue
        if _HUNK_HEADER.match(raw_line):
            hunk_parts.append([raw_line])
            continue
        if hunk_parts:
            hunk_parts[-1].append(raw_line)
        else:
            header_parts.append(raw_line)
    flush()

    slices: list[DiffSlice] = []
    skipped: list[str] = []
    skipped_files: list[str] = []
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
        skipped.extend(f"{md_code(file_path)}: {reason}" for reason in chunk_skips)
        if chunk_skips:
            skipped_files.append(file_path)
        for chunk in chunks:
            slices.append(DiffSlice(text=chunk, files=(file_path,)))

    close_slice()

    if len(slices) > max_slices:
        dropped = slices[max_slices:]
        dropped_files = sorted({f for s in dropped for f in s.files})
        skipped.append(
            f"{len(dropped)} slice(s) over the {max_slices}-slice per-run cap were NOT "
            f"reviewed, covering: {', '.join(md_code(f) for f in dropped_files)}"
        )
        skipped_files.extend(dropped_files)
        slices = slices[:max_slices]

    return SlicePlan(slices=slices, skipped=skipped, skipped_files=tuple(skipped_files))


# Everything an upstream error says ends up in a PUBLIC GitHub review body
# (and in the Actions run log, which is public on a public repo). A chatty
# proxy or gateway can echo the request it was given — URL with query string,
# Authorization header, key material — into its error text, and interpolating
# that verbatim publishes it. Nothing derived from an exception reaches a
# posted body without going through `safe_error_text` first.
MAX_ERROR_TEXT_CHARS = 200

_ERROR_REDACTIONS = (
    # URLs first: they can carry credentials in the query string or userinfo.
    (re.compile(r"https?://\S+", re.IGNORECASE), "<url-redacted>"),
    # Explicit credential-bearing fields. The separator is REQUIRED: with it
    # optional, `401: token expired` matched and ate the word that says what
    # went wrong. A bare secret with no separator is still caught by the
    # high-entropy rule below, so requiring it costs no coverage.
    (
        re.compile(
            r"(?i)\b(authorization|api[-_ ]?key|access[-_ ]?token|token|secret|password)\b"
            r"\s*[:=]\s*\S+"
        ),
        "<credential-redacted>",
    ),
    # `Bearer` is the exception: what follows it is the credential itself,
    # separator or not.
    (re.compile(r"(?i)\bbearer\s+\S+"), "bearer <credential-redacted>"),
    # Bare high-entropy blobs: sk-…, long hex digests, base64 chunks.
    (re.compile(r"\b[A-Za-z0-9_\-]{32,}\b"), "<redacted>"),
)


def safe_error_text(error: object, limit: int = MAX_ERROR_TEXT_CHARS) -> str:
    """Bound and scrub an exception's text before it can be published.

    Redacts URLs, credential-bearing fields and high-entropy blobs, collapses
    whitespace, and truncates. Redaction is deliberately over-eager: an error
    string is a diagnostic hint, and no diagnostic is worth publishing a
    credential over."""
    text = str(error)
    for pattern, replacement in _ERROR_REDACTIONS:
        text = pattern.sub(replacement, text)
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text or "(no error text)"


_VERDICT_SEVERITY = {"APPROVE": 0, "APPROVE_WITH_COMMENTS": 1, "REQUEST_CHANGES": 2}


def slice_is_usable(result: dict) -> bool:
    """Whether a slice's model result counts as a review of that slice.

    ONE definition, shared by the merge and the coverage count — they must
    never disagree. When they did, a slice with comments but no parseable
    verdict counted as reviewed while the merge called it unusable, so no
    partial-coverage banner posted at all.

    A recognised verdict is the bar: without one we cannot say the model
    finished its pass over that slice, whatever else it emitted."""
    verdict = result.get("verdict")
    # isinstance first: a malformed response can put a list or dict here, and
    # both `x in dict` and `dict.get(x)` raise TypeError on an unhashable key.
    return isinstance(verdict, str) and verdict in _VERDICT_SEVERITY


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
    partial_comments = 0

    for index, result in enumerate(results):
        usable = slice_is_usable(result)
        for comment in result.get("inline_comments") or []:
            if not isinstance(comment, dict):
                continue  # not a comment shape; build_review_payload would reject it anyway
            # str(), not the raw values: a malformed result can put a list or
            # dict in any of these fields, and an unhashable key would raise
            # here — crashing the run after every slice call has been paid
            # for. Same class of defect as the verdict lookup below.
            key = (
                str(comment.get("file")),
                str(comment.get("line")),
                str(comment.get("body")),
            )
            if key in seen:
                continue
            seen.add(key)
            comments.append(comment)
            if not usable:
                # Kept, not dropped: an anchored finding on a live-money repo
                # is worth more than the tidiness of discarding it. But the
                # banner says this slice was never reviewed, so the body has
                # to say these came from it — otherwise the page contradicts
                # itself, which is the exact failure this change exists to fix.
                partial_comments += 1

        summary = (result.get("summary_markdown") or "").strip()
        if summary:
            if len(results) > 1:
                files = slice_files[index] if index < len(slice_files) else ()
                # Named files, capped: a slice can hold a dozen paths and the
                # heading would otherwise be longer than the review under it.
                label = ", ".join(md_code(f) for f in files[:3]) or "(unknown files)"
                if len(files) > 3:
                    label += f" +{len(files) - 3} more"
                summary = f"#### Slice {index + 1} of {len(results)} — {label}\n\n{summary}"
            summaries.append(summary)

        # Guarded by `slice_is_usable`, not a bare `_VERDICT_SEVERITY[...]`:
        # `parse_model_output` does whitelist the three verdicts, but
        # `review_diff` takes an injectable `call` and this function is
        # public, so an unrecognised value ("LGTM", or a list) would otherwise
        # raise — crashing the run AFTER every slice call has already been
        # paid for. Unknowns route through the unusable path, which discloses
        # rather than guesses. Sharing the predicate with the coverage count
        # is also what stops the two definitions drifting apart again.
        if usable:
            severity = max(severity, _VERDICT_SEVERITY[result["verdict"]])
        else:
            any_unusable = True

    merged_verdict = None
    if not any_unusable and severity >= 0:
        merged_verdict = next(k for k, v in _VERDICT_SEVERITY.items() if v == severity)

    return {
        "summary_markdown": "\n\n".join(summaries),
        "inline_comments": comments,
        "verdict": merged_verdict,
        "partial_comments": partial_comments,
    }


def review_diff(
    diff_text: str,
    changed_files: list[str] | None,
    *,
    call: Callable[..., dict] | None = None,
    max_chars: int = MAX_SLICE_CHARS,
    max_slices: int = MAX_SLICES,
    extra_skipped: Sequence[str] = (),
    reviewer: str | None = None,
    existing_anchors: Sequence[tuple[str, int]] | set[tuple[str, int]] = (),
    **model_kwargs,
) -> dict:
    """Review a whole diff, in slices, and return the payload to post.

    This is the entry point `run_review.py` calls; the orchestration lives here
    rather than in the script so the tests in this directory actually exercise
    the shipped path."""
    call = call or call_model
    plan = split_diff_into_slices(diff_text, max_chars=max_chars, max_slices=max_slices)

    # Cross-check the slicer against the caller's independently derived file
    # list (git for a PR run). A file the caller sees that no slice covers is
    # unreviewed content — disclosed, never dropped. This is what catches a
    # slicer bug rather than trusting the slicer to have none.
    # Files the slicer ALREADY named a reason for are excluded: they are in
    # the banner once, with the specific reason, and listing them again under
    # the generic "matched no diff slice" line would have the banner
    # contradict itself about how much went unread.
    sliced_files = {f for s in plan.slices for f in s.files}
    already_disclosed = set(plan.skipped_files)
    unsliced = [
        f
        for f in (changed_files or ())
        if f not in sliced_files and f not in already_disclosed
    ]
    # `extra_skipped` carries losses that happened before slicing — the
    # read-time ceiling in `read_capped_diff`. They belong in the same banner
    # as everything else that went unread.
    skipped = list(extra_skipped) + list(plan.skipped)
    # None means the caller could not determine the file list (git failed).
    # Silently treating that as "nothing missing" would make the cross-check
    # vacuous for the entire run while the banner still implied full coverage
    # — a safety net that has quietly stopped catching anything is worse than
    # no net, because everything downstream trusts it.
    # Kept OUT of `skipped`: that list is content known to be unread, and this
    # is not — everything may have been reviewed, we just cannot show it. The
    # banner renders it as its own line with its own headline.
    coverage_unverified = changed_files is None and bool(plan.slices)
    if unsliced:
        skipped.append(
            f"{len(unsliced)} changed file(s) matched no diff slice and were NOT "
            f"reviewed: {', '.join(md_code(f) for f in unsliced[:10])}"
            + (" …" if len(unsliced) > 10 else "")
        )

    if not plan.slices:
        # "Nothing to review" is only true when there was nothing there. If
        # content was skipped, saying so would be the same lie this change
        # exists to kill, just told about a smaller diff.
        empty_summary = (
            "_The whole diff was skipped — none of it was reviewed. See above._"
            if skipped
            else "_No diff detected — nothing to review._"
        )
        return build_review_payload(
            diff_text,
            {"summary_markdown": empty_summary, "inline_comments": [], "verdict": None},
            coverage=ReviewCoverage(0, 0, tuple(skipped)),
            reviewer=reviewer,
            existing_anchors=existing_anchors,
        )

    results: list[dict] = []
    reviewed = 0
    fatal_errors: list[BaseException] = []
    for index, diff_slice in enumerate(plan.slices):
        print(
            f"info: reviewing slice {index + 1}/{len(plan.slices)} "
            f"({len(diff_slice.text)} chars, {len(diff_slice.files)} file(s))",
            file=sys.stderr,
        )
        # Classify only the files IN this slice. Handing every call the whole
        # PR's file list would invite findings on code the call was never
        # shown — and those anchor fine against the full diff, so they'd post
        # as real comments on unread lines. No fallback to `changed_files`: a
        # slice always names at least one file, and a fallback that "can't
        # fire" is exactly how the whole-PR list would sneak back in.
        try:
            result = call(
                diff=diff_slice.text, changed_files=list(diff_slice.files), **model_kwargs
            )
        except Exception as exc:  # noqa: BLE001 - narrowed on the next line
            # ONLY a provider refusal is absorbed. A NameError or AttributeError
            # from our own code reported as "the provider refused this slice"
            # is a lie the disclosure banner would then repeat, and the bug
            # would never surface. Anything that is not a refusal propagates.
            if not _is_fatal_request_error(exc):
                raise
            detail = safe_error_text(exc)
            # A shared-cause refusal (auth, endpoint, or a config-class 400 —
            # see `_is_shared_cause_error`) can never be slice-specific.
            # Carrying on would buy up to MAX_SLICES-1 more
            # guaranteed-identical failures at full price, so stop at the
            # first one.
            if _is_shared_cause_error(exc):
                raise RuntimeError(
                    f"reviewer credentials, endpoint, or request configuration rejected "
                    f"on slice {index + 1}/{len(plan.slices)}; no further slices "
                    f"attempted: {detail}"
                ) from None
            # A refusal about this slice's CONTENT (a provider content filter
            # tripping on one file) must not discard every other slice's
            # completed, paid-for review, so it is routed through the
            # unreviewed path: named in the banner, blocking an APPROVE.
            # A configuration fault does not single out one slice, so if EVERY
            # slice refuses there is nothing slice-local to explain and no paid
            # work to preserve — re-raised below instead.
            print(f"warning: slice {index + 1} refused: {detail}", file=sys.stderr)
            fatal_errors.append(exc)
            files = ", ".join(md_code(f) for f in diff_slice.files[:5])
            skipped.append(
                f"slice {index + 1} of {len(plan.slices)} ({files}) was refused by the "
                f"provider and NOT reviewed: {detail}"
            )
            results.append(
                {"summary_markdown": "", "inline_comments": [], "verdict": None}
            )
            continue
        results.append(result)
        if slice_is_usable(result):
            reviewed += 1

    if len(fatal_errors) == len(plan.slices):
        # Wrapped, not re-raised raw: the traceback lands in the Actions log,
        # and an upstream error is the most likely thing to have echoed
        # request details back at us. The provider's own reason survives the
        # scrub, so this is still the loud failure #594 asked for.
        # `from None` because chaining would print the unscrubbed original.
        raise RuntimeError(
            f"every slice was refused by the provider: {safe_error_text(fatal_errors[0])}"
        ) from None

    merged = merge_model_results(results, [s.files for s in plan.slices])
    coverage = ReviewCoverage(
        slices_total=len(plan.slices),
        slices_reviewed=reviewed,
        skipped=tuple(skipped),
        # Each refusal already has its own line in `skipped`; without this it
        # would also swell the generic failed-slice count and read as two
        # separate losses.
        failures_explained=len(fatal_errors),
        partial_comments=merged.get("partial_comments", 0),
        coverage_unverified=coverage_unverified,
    )
    # The FULL diff, not the slice: a comment is anchorable if the line is in
    # any hunk of the PR, and the merged comments span every slice.
    return build_review_payload(
        diff_text,
        merged,
        coverage=coverage,
        reviewer=reviewer,
        existing_anchors=existing_anchors,
    )


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


# Unambiguous refusals: the request as sent is wrong and will be wrong on
# every retry — a bad max_tokens or model name (400), a dead or unauthorised
# key (401/403), a wrong endpoint (404), a rejected payload (422).
#
# Whitelisted rather than "any 4xx except 429", because a proxied endpoint
# also emits 408 (request timeout) and 409 (conflict), and those ARE
# transient — treating them as fatal would kill a whole run over exactly the
# kind of blip the retry loop exists for. Anything not listed here stays in
# the retry loop, which is the safe default: a wrongly-retried error costs
# two retries, a wrongly-fatal one costs the entire review.
_FATAL_STATUS_CODES = frozenset({400, 401, 403, 404, 422})

# The subset that cannot possibly be about one slice's content: the key and
# the endpoint are shared by every call, so slice 2 will fail exactly as
# slice 1 did. Short-circuited rather than retried across the remaining
# slices, each of which is a paid call.
_AUTH_STATUS_CODES = frozenset({401, 403})

# The two request arguments `call_model` itself sets per call (not per
# slice) — see its signature below. A 400 whose provider-reported `param`
# names one of these is, by construction, about the REQUEST, not about
# whatever diff content that request happened to carry: every remaining
# slice sends the identical `max_tokens`/`model` and would be refused
# identically. A 400 naming anything else (or naming nothing, which is the
# common case — see `_request_param`) stays on the existing per-slice-content
# path, because #601's own reasoning for leaving 400 alone still holds for
# that case: a content filter can be slice-specific.
_CONFIG_REQUEST_PARAMS = frozenset({"max_tokens", "model"})


def _request_status(exc: BaseException) -> int | None:
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "response", None), "status_code", None)
    # isinstance: `status` comes off an arbitrary exception object and an
    # unhashable value would make the membership tests below raise.
    return status if isinstance(status, int) else None


def _request_param(exc: BaseException) -> str | None:
    """The request parameter a 400 named as its cause, when the provider's
    error body is OpenAI-shaped.

    The openai SDK's `_make_status_error` unwraps the `{"error": {...}}`
    envelope before constructing the exception, so a real `BadRequestError`
    exposes `.param` directly (`APIError.__init__` reads it off the
    already-unwrapped body). The `.body` fallback below covers a caller that
    built the exception by hand (this file's own tests, or a future one)
    rather than going through the SDK's error path, checking both the
    unwrapped and the still-enveloped shape.

    Returns None whenever `param` is absent in both shapes — which is the
    ordinary case for Nous's endpoint: nothing in this codebase has ever
    observed what shape its 4xx bodies take (see the comments elsewhere in
    this file on its undocumented behaviour), so a 400 with no recognisable
    `param` is treated as unclassifiable rather than guessed at, and falls
    through to the existing per-slice-content path."""
    param = getattr(exc, "param", None)
    if isinstance(param, str):
        return param
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        candidate = body.get("param")
        if not isinstance(candidate, str):
            nested = body.get("error")
            candidate = nested.get("param") if isinstance(nested, dict) else None
        if isinstance(candidate, str):
            return candidate
    return None


def _is_auth_request_error(exc: BaseException) -> bool:
    return _request_status(exc) in _AUTH_STATUS_CODES


def _is_config_request_error(exc: BaseException) -> bool:
    """A 400 whose named `param` is one of OUR non-content request
    arguments — see `_CONFIG_REQUEST_PARAMS`. Deliberately NOT a message
    match: this file classifies fatal-vs-transient on the status code alone
    (see `_is_fatal_request_error`), and matching text like "max_tokens" in
    an error string would misclassify a message that merely quotes it back
    without the request itself being at fault."""
    return _request_status(exc) == 400 and _request_param(exc) in _CONFIG_REQUEST_PARAMS


def _is_shared_cause_error(exc: BaseException) -> bool:
    """True for a fatal refusal that cannot be about THIS slice's content:
    the key and the endpoint (401/403/404) or a rejected non-content request
    parameter (400 config-class) are identical on every call this run makes.
    Carrying on would buy up to MAX_SLICES-1 more guaranteed-identical
    failures at full price, so `review_diff` stops at the first one instead
    of retrying across the remaining slices.

    404 is unconditional, not param-gated like 400: the endpoint URL is
    fixed for the whole run, so a 404 on slice 1 is a 404 on every slice
    regardless of what that slice's diff contains — there is no
    slice-specific reading of "wrong endpoint" the way there is for 400.

    422 is deliberately NOT included: `_FATAL_STATUS_CODES`'s own comment
    calls it "a rejected payload," which can turn on what was IN the
    request (the diff itself), so unlike 404 it is not unconditionally
    endpoint-level, and this file has no observed evidence from Nous's
    endpoint to classify it further — it stays fatal-but-not-short-circuited,
    same as an unclassifiable 400."""
    return (
        _is_auth_request_error(exc)
        or _request_status(exc) == 404
        or _is_config_request_error(exc)
    )


def _is_fatal_request_error(exc: BaseException) -> bool:
    """True for provider responses that will never succeed on retry.

    Classified on the status code, not on a message match, so a rejected
    `max_tokens` and a rejected model name are both caught."""
    return _request_status(exc) in _FATAL_STATUS_CODES


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
                f"warning: model call failed ({safe_error_text(last_exc)}); "
                f"retrying in {wait}s "
                f"(attempt {attempt + 2}/{TRANSIENT_MAX_ATTEMPTS})",
                file=sys.stderr,
            )
            time.sleep(wait)

    if parsed is None:
        return {
            "summary_markdown": (
                f"_This reviewer ({model}) produced no usable review in "
                f"{TRANSIENT_MAX_ATTEMPTS} attempts and was skipped. "
                # This string is posted publicly: the upstream error text is
                # the most likely thing here to have echoed request details.
                f"Last error: {safe_error_text(last_exc)}_"
            ),
            "inline_comments": [],
            "verdict": None,
        }

    return parsed


def comment_marker(reviewer: str) -> str:
    """The invisible tag stamped on this reviewer's inline comments."""
    return REVIEW_MARKER_TEMPLATE.format(reviewer=reviewer)


def normalise_severity(value) -> str:
    """Lower-case a model-supplied severity, or "" for anything not a string.

    The model's JSON is untrusted: `severity` has arrived as None and as
    non-string values. Everything unrecognised normalises to "", which the
    gate treats as inline-worthy rather than as `low`."""
    return value.strip().lower() if isinstance(value, str) else ""


def existing_comment_anchors(comments: Sequence[dict], reviewer: str) -> set[tuple[str, int]]:
    """`(path, line)` pairs this reviewer already commented on, and that GitHub
    can STILL anchor to the current diff.

    `line` goes null on a comment GitHub has marked outdated — the code under
    it changed, and the original position moves to `original_line`. Those are
    deliberately NOT collected: if the line has moved on, the finding deserves
    re-posting rather than silent suppression.

    Only RIGHT-side comments count, because that is the only side this script
    ever creates."""
    anchors: set[tuple[str, int]] = set()
    marker = comment_marker(reviewer)
    for c in comments:
        if not isinstance(c, dict):
            continue
        body = c.get("body")
        if not isinstance(body, str) or marker not in body:
            continue
        # Only a BOT's comment can suppress a finding. The marker is plain
        # text in a public comment thread, so a human quoting it — which is
        # exactly what happens on a PR that discusses this mechanism — would
        # otherwise mute the reviewer on whatever line they replied to.
        # Absent `user` means a hand-built comment (the tests), not a human
        # on GitHub: every real payload carries one.
        user = c.get("user")
        if isinstance(user, dict) and user.get("type") != "Bot":
            continue
        # `side` is absent on some historical comments; absent means RIGHT,
        # which is what this script posts. Only an explicit LEFT is excluded.
        if c.get("side") not in (None, "RIGHT"):
            continue
        path = c.get("path")
        line = c.get("line")
        if isinstance(path, str) and isinstance(line, int) and not isinstance(line, bool):
            anchors.add((path, line))
    return anchors


def build_review_payload(
    diff_text: str,
    model_result: dict,
    coverage: ReviewCoverage | None = None,
    *,
    reviewer: str | None = None,
    existing_anchors: Sequence[tuple[str, int]] | set[tuple[str, int]] = (),
) -> dict:
    valid_lines = commentable_lines(diff_text)
    anchors = set(existing_anchors)

    accepted = []
    rejected = []
    gated_low = []
    suppressed = []
    for c in model_result["inline_comments"]:
        file = c.get("file")
        line = c.get("line")
        body = c.get("body", "")
        if not file or not isinstance(line, int):
            rejected.append(c)
            continue
        if line not in valid_lines.get(file, set()):
            rejected.append(c)
            continue
        # Severity gate BEFORE dedup: a `low` finding never becomes an inline
        # comment, so it never earns an anchor a later run would match on.
        if normalise_severity(c.get("severity")) == "low":
            gated_low.append(c)
            continue
        if (file, line) in anchors:
            suppressed.append(c)
            continue
        marked = f"{body}\n\n{comment_marker(reviewer)}" if reviewer else body
        accepted.append({"path": file, "line": line, "side": "RIGHT", "body": marked})

    summary = model_result["summary_markdown"] or ""
    if rejected:
        summary += "\n\n---\n_Additional comments the reviewer made outside the diff's visible lines (could not be anchored inline):_\n"
        for c in rejected:
            sev = c.get("severity", "?")
            summary += f"- **{c.get('file', '?')}:{c.get('line', '?')}** ({sev}): {c.get('body', '')}\n"

    # Distinct section, distinct wording: these COULD have anchored inline and
    # were held back on severity. Filing them under the "could not be
    # anchored" heading above would misreport why they are in the body.
    if gated_low:
        summary += (
            "\n\n---\n_Low-severity findings, reported here rather than as inline "
            "comments:_\n"
        )
        for c in gated_low:
            summary += f"- **{c.get('file', '?')}:{c.get('line', '?')}**: {c.get('body', '')}\n"

    # Disclosed, never silent. A body that simply lost N findings reads exactly
    # like a broken reviewer — the #409/#567 failure shape — and an operator
    # comparing two runs of the same PR needs to see that the earlier review
    # still carries them.
    if suppressed:
        files = sorted({str(c.get("file", "?")) for c in suppressed})
        summary += (
            f"\n\n---\n_{len(suppressed)} finding(s) suppressed as already flagged on an "
            f"earlier review of this PR ({', '.join(md_code(f) for f in files[:10])}"
            + (" …" if len(files) > 10 else "")
            + "). They stand on that review; this run re-read the same lines and "
            "did not repeat them._\n"
        )

    verdict = model_result["verdict"]

    # Partial coverage caps the verdict, and does so BEFORE anything renders
    # it so the blank-summary fallback below can't quote a stale "APPROVE".
    # Every caller reaches this line — it is the single choke point for the
    # rule (#594: APPROVED posted on #591 after reading 37% of it).
    partial = coverage is not None and not coverage.is_complete
    if partial and verdict == "APPROVE":
        verdict = "APPROVE_WITH_COMMENTS"

    # The inline-only prompt forces summary_markdown to "", so a review whose
    # findings all anchor inline — or which found nothing — used to reach
    # GitHub as a zero-length body (#409: BODYLEN=0 rows on #396 and #404).
    # A reader can't tell that apart from a broken reviewer.
    #
    # Keyed on the MODEL's summary being blank, not on the accumulated body:
    # the severity and suppression sections above are appended before this
    # point, so testing `summary` would silently drop the verdict/count line
    # for exactly the inline-only reviewer that needs it as soon as one
    # low-severity or suppressed finding existed.
    if not (model_result["summary_markdown"] or "").strip():
        anchored = f"{len(accepted)} inline comment{'' if len(accepted) == 1 else 's'}"
        placeholder = (
            f"_No prose summary from this reviewer (inline-only mode). "
            f"Verdict: **{verdict or 'none parsed'}**; {anchored} posted._"
        )
        summary = f"{placeholder}{summary}" if summary.strip() else placeholder

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
        # Read by the workflow to decide whether to (a) post a standalone PR
        # comment naming the reviewer that produced nothing and (b) fail the
        # job rather than let it report `pass` with no review behind it (#567).
        # False, never absent, when there's no coverage info to check — a
        # missing key would make a `payload.get("no_usable_review")` typo
        # downstream silently mean "never fails" instead of erroring loudly.
        "no_usable_review": coverage is not None and coverage.no_usable_review,
    }
