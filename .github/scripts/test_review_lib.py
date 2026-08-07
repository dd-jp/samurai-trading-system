"""Tests for the AI-review harness.

These cover the two mechanisms recorded in #409 that stopped the Kimi reviewer
from ever posting an APPROVE: unusable (truncated / empty) model output being
posted verbatim instead of retried, and clean responses landing as zero-length
COMMENTED reviews.
"""

import json
import types

import pytest

import review_lib


def _event(content=None, finish_reason=None):
    delta = types.SimpleNamespace(content=content)
    choice = types.SimpleNamespace(delta=delta, finish_reason=finish_reason)
    return types.SimpleNamespace(choices=[choice])


class FakeCompletions:
    """Replays one scripted stream per call, so a test can express
    'first attempt truncates, second attempt succeeds'."""

    def __init__(self, streams):
        self._streams = list(streams)
        self.calls = 0

    def create(self, **_kwargs):
        self.calls += 1
        return self._streams.pop(0)


class FakeClient:
    def __init__(self, streams):
        self.completions = FakeCompletions(streams)
        self.chat = types.SimpleNamespace(completions=self.completions)


def _good_payload(verdict="APPROVE"):
    return json.dumps(
        {"summary_markdown": "", "inline_comments": [], "verdict": verdict}
    )


def _call(client, **kwargs):
    return review_lib.call_model(
        diff="diff --git a/x b/x",
        changed_files=["src/trader/x.ts"],
        model="kimi-k3",
        api_key="k",
        base_url="https://example.invalid",
        client=client,
        **kwargs,
    )


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr(review_lib.time, "sleep", lambda _s: None)


# --- mechanism 1: truncated / empty output ---------------------------------


def test_empty_content_is_retried_not_posted(monkeypatch):
    """finish_reason=length with content_chars=0 is the #409 run-31044265268
    signature. It must be retried, not turned into a raw-text review."""
    client = FakeClient(
        [
            [_event(finish_reason="length")],
            [_event(content=_good_payload()), _event(finish_reason="stop")],
        ]
    )
    result = _call(client)

    assert client.completions.calls == 2
    assert result["verdict"] == "APPROVE"


def test_truncated_json_is_retried(monkeypatch):
    """content_chars=910 with finish_reason=length (run 31043645822): partial
    JSON that can't be recovered is unusable, same as empty."""
    client = FakeClient(
        [
            [_event(content='{"summary_markdown": "hal'), _event(finish_reason="length")],
            [_event(content=_good_payload("REQUEST_CHANGES")), _event(finish_reason="stop")],
        ]
    )
    result = _call(client)

    assert client.completions.calls == 2
    assert result["verdict"] == "REQUEST_CHANGES"


def test_exhausted_retries_report_truncation_and_never_crash():
    client = FakeClient([[_event(finish_reason="length")] for _ in range(3)])
    result = _call(client)

    assert client.completions.calls == review_lib.TRANSIENT_MAX_ATTEMPTS
    assert result["verdict"] is None
    assert result["inline_comments"] == []
    assert result["summary_markdown"].strip()


def test_a_clean_first_response_is_not_retried():
    client = FakeClient([[_event(content=_good_payload()), _event(finish_reason="stop")]])
    result = _call(client)

    assert client.completions.calls == 1
    assert result["verdict"] == "APPROVE"


def test_prose_wrapped_json_is_still_recovered():
    body = "Here you go:\n```json\n" + _good_payload() + "\n```"
    client = FakeClient([[_event(content=body), _event(finish_reason="stop")]])
    result = _call(client)

    assert client.completions.calls == 1
    assert result["verdict"] == "APPROVE"


def test_transport_failure_still_retries_then_reports():
    class ExplodingCompletions(FakeCompletions):
        def create(self, **_kwargs):
            self.calls += 1
            raise RuntimeError("Cloudflare 524")

    client = FakeClient([])
    client.completions = ExplodingCompletions([])
    client.chat = types.SimpleNamespace(completions=client.completions)

    result = _call(client)

    assert client.completions.calls == review_lib.TRANSIENT_MAX_ATTEMPTS
    assert result["verdict"] is None
    assert "Cloudflare 524" in result["summary_markdown"]


# --- mechanism 2: blank reviews --------------------------------------------

DIFF = """diff --git a/src/trader/x.ts b/src/trader/x.ts
--- a/src/trader/x.ts
+++ b/src/trader/x.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 const c = 3;
"""


def test_blank_review_gets_a_body():
    """The BODYLEN=0 / COMMENTED rows on #396 and #404: inline-only prompt
    forces summary to '', no comment anchors, so GitHub gets an empty review."""
    payload = review_lib.build_review_payload(
        DIFF,
        {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"},
    )

    assert payload["summary_markdown"].strip()
    assert payload["event"] == "APPROVE"


def test_blank_summary_with_anchored_comments_still_gets_a_body():
    payload = review_lib.build_review_payload(
        DIFF,
        {
            "summary_markdown": "",
            "inline_comments": [
                {"file": "src/trader/x.ts", "line": 2, "severity": "low", "body": "nit"}
            ],
            "verdict": "APPROVE_WITH_COMMENTS",
        },
    )

    assert payload["summary_markdown"].strip()
    assert len(payload["comments"]) == 1
    assert payload["event"] == "COMMENT"


def test_a_real_summary_is_left_alone():
    payload = review_lib.build_review_payload(
        DIFF,
        {"summary_markdown": "### Performance\nNo issues found.", "inline_comments": [], "verdict": "APPROVE"},
    )

    assert payload["summary_markdown"] == "### Performance\nNo issues found."


def test_only_literal_approve_maps_to_the_approve_event():
    for verdict, expected in [
        ("APPROVE", "APPROVE"),
        ("APPROVE_WITH_COMMENTS", "COMMENT"),
        ("REQUEST_CHANGES", "COMMENT"),
        (None, "COMMENT"),
    ]:
        payload = review_lib.build_review_payload(
            DIFF, {"summary_markdown": "x", "inline_comments": [], "verdict": verdict}
        )
        assert payload["event"] == expected, verdict


def test_unanchorable_comments_are_moved_into_the_summary():
    payload = review_lib.build_review_payload(
        DIFF,
        {
            "summary_markdown": "",
            "inline_comments": [
                {"file": "src/trader/x.ts", "line": 999, "severity": "high", "body": "off-diff"}
            ],
            "verdict": "REQUEST_CHANGES",
        },
    )

    assert payload["comments"] == []
    assert "off-diff" in payload["summary_markdown"]


# --- prompts ----------------------------------------------------------------


def test_both_prompts_state_when_to_approve_positively():
    """#409 mechanism 2: the prompts said when *not* to approve but never that
    a finding-free review must be an APPROVE."""
    for prompt in (review_lib.SYSTEM_PROMPT, review_lib.SYSTEM_PROMPT_INLINE_ONLY):
        assert "must be APPROVE" in prompt


def test_commentable_lines_tracks_added_and_context_lines():
    assert review_lib.commentable_lines(DIFF) == {"src/trader/x.ts": {1, 2, 3}}


# --- mechanism 3: silent truncation of an over-cap diff (#594) --------------


def _file_diff(path: str, hunks: int = 1, lines_per_hunk: int = 3) -> str:
    out = f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n"
    start = 1
    for _ in range(hunks):
        out += f"@@ -{start},{lines_per_hunk} +{start},{lines_per_hunk} @@\n"
        out += "".join(f"+line {start + i} of {path}\n" for i in range(lines_per_hunk))
        start += lines_per_hunk
    return out


def test_over_cap_diff_is_sliced_and_every_file_is_covered():
    """The #594 defect: 162k chars of diff, 60k read, nobody told. Now every
    file must appear in some slice."""
    paths = [f"src/dashboard-web/src/c{i}.tsx" for i in range(8)]
    # Each file is comfortably under the cap, so slicing happens on FILE
    # boundaries and every file lands in exactly one slice.
    diff = "".join(_file_diff(p, hunks=1, lines_per_hunk=20) for p in paths)

    plan = review_lib.split_diff_into_slices(diff, max_chars=2000)

    assert len(plan.slices) > 1
    assert plan.skipped == []
    covered = [f for s in plan.slices for f in s.files]
    assert sorted(covered) == sorted(paths)
    assert len(covered) == len(set(covered))
    assert all(len(s.text) <= 2000 for s in plan.slices)
    # Reassembling the slices must reproduce the diff byte for byte: nothing
    # dropped, nothing duplicated.
    assert "".join(s.text for s in plan.slices) == diff


def test_a_file_larger_than_a_slice_splits_on_hunk_boundaries_only():
    diff = _file_diff("src/risk-manager/big.ts", hunks=6, lines_per_hunk=20)

    plan = review_lib.split_diff_into_slices(diff, max_chars=900)

    assert len(plan.slices) > 1
    assert plan.skipped == []
    hunks_seen = 0
    for diff_slice in plan.slices:
        lines = diff_slice.text.splitlines()
        # Each chunk repeats the file header, so it stands alone as a diff.
        assert lines[0].startswith("diff --git ")
        assert any(line.startswith("+++ ") for line in lines)
        hunk_starts = [i for i, line in enumerate(lines) if line.startswith("@@ ")]
        assert hunk_starts, "a slice with no hunk header is a mid-hunk split"
        # Nothing before the first hunk except header lines, and every body
        # line after it belongs to a hunk (no orphaned fragment).
        for line in lines[hunk_starts[0] + 1 :]:
            assert line[:1] in ("+", "-", " ", "@", "\\"), line
        hunks_seen += len(hunk_starts)
    assert hunks_seen == 6  # no hunk lost, no hunk counted twice
    # Every hunk's payload survives somewhere.
    joined = "".join(s.text for s in plan.slices)
    for n in range(1, 121):
        assert f"+line {n} of src/risk-manager/big.ts\n" in joined


def test_an_unsplittable_hunk_is_skipped_and_disclosed():
    diff = _file_diff("src/execution/huge.ts", hunks=1, lines_per_hunk=200)

    plan = review_lib.split_diff_into_slices(diff, max_chars=500)

    assert plan.slices == []
    assert len(plan.skipped) == 1
    assert "could not be split further" in plan.skipped[0]
    assert "src/execution/huge.ts" in plan.skipped[0]


def test_slices_over_the_per_run_cap_are_disclosed_not_dropped_silently():
    paths = [f"src/a{i}.ts" for i in range(6)]
    diff = "".join(_file_diff(p, hunks=1, lines_per_hunk=10) for p in paths)

    plan = review_lib.split_diff_into_slices(diff, max_chars=300, max_slices=2)

    assert len(plan.slices) == 2
    assert len(plan.skipped) == 1
    assert "NOT reviewed" in plan.skipped[0]
    covered = {f for s in plan.slices for f in s.files}
    for missing in set(paths) - covered:
        assert missing in plan.skipped[0]


def test_a_small_diff_is_a_single_slice():
    plan = review_lib.split_diff_into_slices(DIFF)

    assert len(plan.slices) == 1
    assert plan.slices[0].files == ("src/trader/x.ts",)
    assert plan.slices[0].text == DIFF


def test_changed_files_from_diff_includes_deletions():
    deletion = (
        "diff --git a/src/risk-manager/gone.ts b/src/risk-manager/gone.ts\n"
        "--- a/src/risk-manager/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-const a = 1;\n"
    )
    files = review_lib.changed_files_from_diff(DIFF + deletion)

    assert files == ["src/trader/x.ts", "src/risk-manager/gone.ts"]


# --- mechanism 4: a partial review must never read as complete (#594) -------


def test_partial_coverage_disclosure_blocks_an_approve():
    coverage = review_lib.ReviewCoverage(slices_total=3, slices_reviewed=2)
    payload = review_lib.build_review_payload(
        DIFF,
        {"summary_markdown": "### Performance\nNo issues found.", "inline_comments": [], "verdict": "APPROVE"},
        coverage=coverage,
    )

    assert payload["event"] == "COMMENT"
    assert payload["verdict"] != "APPROVE"
    assert "Partial review" in payload["summary_markdown"]
    assert "2/3" in payload["summary_markdown"]
    # Disclosure leads the body — it must not be buried under the review.
    assert payload["summary_markdown"].startswith("> [!WARNING]")


def test_skipped_content_is_named_in_the_disclosure():
    coverage = review_lib.ReviewCoverage(
        slices_total=1, slices_reviewed=1, skipped=("`src/execution/huge.ts`: hunk too big",)
    )
    payload = review_lib.build_review_payload(
        DIFF, {"summary_markdown": "x", "inline_comments": [], "verdict": "APPROVE"}, coverage=coverage
    )

    assert payload["event"] == "COMMENT"
    assert "src/execution/huge.ts" in payload["summary_markdown"]


def test_full_coverage_still_approves():
    payload = review_lib.build_review_payload(
        DIFF,
        {"summary_markdown": "x", "inline_comments": [], "verdict": "APPROVE"},
        coverage=review_lib.ReviewCoverage(slices_total=2, slices_reviewed=2),
    )

    assert payload["event"] == "APPROVE"
    assert "Partial review" not in payload["summary_markdown"]


def test_review_diff_threads_coverage_when_a_slice_call_fails():
    """A failed slice must reach build_review_payload as partial coverage —
    not just be honoured when someone remembers to pass it."""
    diff = _file_diff("src/a.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)
    results = [
        {"summary_markdown": "fine", "inline_comments": [], "verdict": "APPROVE"},
        # The shape call_model returns when its retries are exhausted.
        {"summary_markdown": "_skipped_", "inline_comments": [], "verdict": None},
    ]
    calls = []

    def fake_call(diff, changed_files, **kwargs):
        calls.append(diff)
        return results[len(calls) - 1]

    payload = review_lib.review_diff(diff, ["src/a.ts"], call=fake_call, max_chars=1200)

    assert len(calls) == 2
    assert payload["event"] == "COMMENT"
    assert payload["verdict"] != "APPROVE"
    assert "Partial review" in payload["summary_markdown"]
    assert "1/2" in payload["summary_markdown"]


def test_review_diff_approves_when_every_slice_came_back_clean():
    diff = _file_diff("src/a.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)

    def fake_call(diff, changed_files, **kwargs):
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    assert payload["event"] == "APPROVE"
    assert "Partial review" not in payload["summary_markdown"]


# --- merging comments across slices -----------------------------------------

TWO_FILE_DIFF = DIFF + """diff --git a/src/trader/y.ts b/src/trader/y.ts
--- a/src/trader/y.ts
+++ b/src/trader/y.ts
@@ -1,2 +1,3 @@
 const d = 4;
+const e = 5;
 const f = 6;
"""


def test_merging_comments_across_slices_drops_nothing_and_duplicates_nothing():
    results = [
        {
            "summary_markdown": "slice one",
            "inline_comments": [
                {"file": "src/trader/x.ts", "line": 2, "severity": "low", "body": "a"},
                # Same finding repeated inside one slice.
                {"file": "src/trader/x.ts", "line": 2, "severity": "low", "body": "a"},
            ],
            "verdict": "APPROVE_WITH_COMMENTS",
        },
        {
            "summary_markdown": "slice two",
            "inline_comments": [
                # Repeated across slices (a file split over two calls).
                {"file": "src/trader/x.ts", "line": 2, "severity": "low", "body": "a"},
                {"file": "src/trader/y.ts", "line": 2, "severity": "high", "body": "b"},
            ],
            "verdict": "APPROVE",
        },
    ]

    merged = review_lib.merge_model_results(results, [("src/trader/x.ts",), ("src/trader/y.ts",)])
    payload = review_lib.build_review_payload(
        TWO_FILE_DIFF, merged, coverage=review_lib.ReviewCoverage(2, 2)
    )

    anchors = [(c["path"], c["line"], c["body"]) for c in payload["comments"]]
    assert sorted(anchors) == [("src/trader/x.ts", 2, "a"), ("src/trader/y.ts", 2, "b")]
    assert "slice one" in payload["summary_markdown"]
    assert "slice two" in payload["summary_markdown"]


def test_merged_verdict_is_the_most_severe_across_slices():
    for verdicts, expected in [
        (["APPROVE", "APPROVE"], "APPROVE"),
        (["APPROVE", "APPROVE_WITH_COMMENTS"], "APPROVE_WITH_COMMENTS"),
        (["REQUEST_CHANGES", "APPROVE"], "REQUEST_CHANGES"),
        # An unusable slice can never be folded into an APPROVE.
        (["APPROVE", None], None),
    ]:
        merged = review_lib.merge_model_results(
            [{"summary_markdown": "", "inline_comments": [], "verdict": v} for v in verdicts],
            [("a",), ("b",)],
        )
        assert merged["verdict"] == expected, verdicts


def test_comments_from_a_later_slice_still_anchor_against_the_full_diff():
    """build_review_payload validates anchors against the WHOLE diff, so a
    finding in slice 2 isn't rejected for being outside slice 1."""
    merged = review_lib.merge_model_results(
        [
            {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"},
            {
                "summary_markdown": "",
                "inline_comments": [
                    {"file": "src/trader/y.ts", "line": 3, "severity": "low", "body": "late"}
                ],
                "verdict": "APPROVE_WITH_COMMENTS",
            },
        ],
        [("src/trader/x.ts",), ("src/trader/y.ts",)],
    )
    payload = review_lib.build_review_payload(TWO_FILE_DIFF, merged)

    assert payload["comments"] == [
        {"path": "src/trader/y.ts", "line": 3, "side": "RIGHT", "body": "late"}
    ]


# --- fail loudly on a rejected request (#594 item 3) ------------------------


def test_a_4xx_from_the_provider_fails_loudly_instead_of_retrying():
    """A rejected max_tokens must red the job with the provider's error, not
    burn three retries and post '_this reviewer was skipped_'."""

    class Rejecting(FakeCompletions):
        def create(self, **_kwargs):
            self.calls += 1
            exc = RuntimeError("max_tokens is too large: 32768")
            exc.status_code = 400
            raise exc

    client = FakeClient([])
    client.completions = Rejecting([])
    client.chat = types.SimpleNamespace(completions=client.completions)

    with pytest.raises(RuntimeError, match="max_tokens"):
        _call(client)

    assert client.completions.calls == 1


def test_a_429_is_still_treated_as_transient():
    class RateLimited(FakeCompletions):
        def create(self, **_kwargs):
            self.calls += 1
            exc = RuntimeError("rate limited")
            exc.status_code = 429
            raise exc

    client = FakeClient([])
    client.completions = RateLimited([])
    client.chat = types.SimpleNamespace(completions=client.completions)

    result = _call(client)

    assert client.completions.calls == review_lib.TRANSIENT_MAX_ATTEMPTS
    assert result["verdict"] is None
