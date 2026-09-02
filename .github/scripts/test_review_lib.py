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
                {"file": "src/trader/x.ts", "line": 2, "severity": "high", "body": "nit"}
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


def test_each_slice_is_classified_on_its_own_files_only():
    """Handing every call the whole PR's file list invites findings on code
    that call was never shown — and they'd anchor fine against the full diff."""
    diff = _file_diff("src/a.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)
    seen = []

    def fake_call(diff, changed_files, **kwargs):
        seen.append(list(changed_files))
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    review_lib.review_diff(diff, ["src/a.ts", "src/b.ts"], call=fake_call, max_chars=1200)

    assert seen == [["src/a.ts"], ["src/b.ts"]]


def test_an_oversized_merged_body_is_clamped_visibly():
    """GitHub 422s over 65536 chars and the workflow's fallback only retries a
    'could not be resolved' 422 — an oversized body would post NO review."""
    payload = review_lib.build_review_payload(
        DIFF,
        {"summary_markdown": "x" * 100000, "inline_comments": [], "verdict": "APPROVE"},
    )

    assert len(payload["summary_markdown"]) <= review_lib.MAX_REVIEW_BODY_CHARS < 65536
    assert "truncated" in payload["summary_markdown"]


def test_the_partial_coverage_banner_survives_the_clamp():
    payload = review_lib.build_review_payload(
        DIFF,
        {"summary_markdown": "x" * 100000, "inline_comments": [], "verdict": "APPROVE"},
        coverage=review_lib.ReviewCoverage(slices_total=3, slices_reviewed=1),
    )

    assert payload["summary_markdown"].startswith("> [!WARNING]")
    assert payload["event"] == "COMMENT"


def test_an_over_cap_file_with_no_hunks_is_disclosed_not_dropped():
    header_only = "diff --git a/src/blob.bin b/src/blob.bin\n" + "# padding\n" * 200

    plan = review_lib.split_diff_into_slices(header_only, max_chars=300)

    assert plan.slices == []
    assert len(plan.skipped) == 1
    assert "no hunks" in plan.skipped[0]


def test_a_slice_with_comments_but_no_verdict_is_not_counted_as_reviewed():
    """Round-1 review finding: the coverage count said 'reviewed' while the
    merge said 'unusable', so no banner posted and the verdict was quietly
    capped — a silent partial. One definition now governs both."""
    diff = _file_diff("src/a.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)
    results = [
        {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"},
        # Parsed JSON, real comments, but the verdict field was garbage —
        # parse_model_output nulls it.
        {
            "summary_markdown": "",
            "inline_comments": [{"file": "src/b.ts", "line": 1, "body": "x"}],
            "verdict": None,
        },
    ]
    calls = []

    def fake_call(diff, changed_files, **kwargs):
        calls.append(diff)
        return results[len(calls) - 1]

    payload = review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    assert "Partial review" in payload["summary_markdown"]
    assert "1/2" in payload["summary_markdown"]
    assert payload["verdict"] != "APPROVE"
    # The same rule both places.
    assert review_lib.slice_is_usable(results[0]) is True
    assert review_lib.slice_is_usable(results[1]) is False


def test_an_unrecognised_verdict_string_does_not_crash_the_run():
    """`_VERDICT_SEVERITY[verdict]` used to KeyError on anything outside the
    three strings — after every slice call had already been paid for."""
    merged = review_lib.merge_model_results(
        [
            {"summary_markdown": "", "inline_comments": [], "verdict": "LGTM"},
            {"summary_markdown": "", "inline_comments": [], "verdict": "approve"},
        ],
        [("a",), ("b",)],
    )

    assert merged["verdict"] is None
    assert review_lib.slice_is_usable({"verdict": "LGTM"}) is False
    # An unhashable verdict would raise on `in dict` / `dict.get` alike.
    assert review_lib.slice_is_usable({"verdict": ["APPROVE"]}) is False
    assert (
        review_lib.merge_model_results(
            [{"summary_markdown": "", "inline_comments": [], "verdict": {"a": 1}}], [("a",)]
        )["verdict"]
        is None
    )


def test_parse_model_output_already_whitelists_verdicts():
    """The `.get` above is defence in depth: the normal path can't produce an
    unrecognised verdict, but review_diff takes an injectable `call`."""
    parsed = review_lib.parse_model_output(
        json.dumps({"summary_markdown": "", "inline_comments": [], "verdict": "LGTM"})
    )

    assert parsed["verdict"] is None


def test_an_all_skipped_diff_does_not_claim_there_was_nothing_to_review():
    """plan.slices empty because every hunk was oversized is not the same as
    an empty diff, and must not print the empty-diff line."""
    diff = _file_diff("src/execution/huge.ts", hunks=1, lines_per_hunk=200)

    def fake_call(diff, changed_files, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("no slice should be reviewable here")

    payload = review_lib.review_diff(diff, [], call=fake_call, max_chars=500)

    assert "No diff detected" not in payload["summary_markdown"]
    assert "Partial review" in payload["summary_markdown"]
    assert "src/execution/huge.ts" in payload["summary_markdown"]
    assert payload["event"] == "COMMENT"


def test_a_genuinely_empty_diff_still_says_nothing_to_review():
    payload = review_lib.review_diff("", [], call=lambda **_k: None)

    assert "No diff detected" in payload["summary_markdown"]
    assert "Partial review" not in payload["summary_markdown"]


def test_a_changed_file_that_matched_no_slice_is_disclosed():
    """The caller's file list is an independent check on the slicer: a file it
    knows about that no slice covers is unreviewed content."""

    def fake_call(diff, changed_files, **kwargs):
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(
        DIFF, ["src/trader/x.ts", "src/risk-manager/ghost.ts"], call=fake_call
    )

    assert "Partial review" in payload["summary_markdown"]
    assert "src/risk-manager/ghost.ts" in payload["summary_markdown"]
    assert payload["event"] == "COMMENT"


def test_one_refused_slice_keeps_the_other_slices_paid_for_reviews():
    """A refusal aimed at one slice's CONTENT (a provider content filter, say)
    must not discard every other slice's completed, paid-for review."""
    diff = _file_diff("src/a.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)
    calls = []

    def fake_call(diff, changed_files, **kwargs):
        calls.append(changed_files)
        if changed_files == ["src/b.ts"]:
            exc = RuntimeError("content filter tripped")
            exc.status_code = 400
            raise exc
        return {
            "summary_markdown": "slice one findings",
            "inline_comments": [{"file": "src/a.ts", "line": 1, "body": "keep me"}],
            "verdict": "REQUEST_CHANGES",
        }

    payload = review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    assert len(calls) == 2
    # The surviving slice's work is still posted.
    assert "slice one findings" in payload["summary_markdown"]
    assert [c["body"] for c in payload["comments"]] == ["keep me"]
    # And the loss is disclosed, not glossed.
    assert "Partial review" in payload["summary_markdown"]
    assert "content filter tripped" in payload["summary_markdown"]
    assert "src/b.ts" in payload["summary_markdown"]
    assert payload["verdict"] != "APPROVE"
    assert payload["event"] == "COMMENT"
    # The refusal has its own line; it must not ALSO swell the generic
    # failed-slice count and read as two separate losses.
    assert "produced no usable review" not in payload["summary_markdown"]
    assert "1/2" in payload["summary_markdown"]


def test_a_malformed_comment_does_not_crash_the_merge():
    """An unhashable value in file/line/body would raise building the dedup
    key — crashing the run after every slice call has been paid for."""
    merged = review_lib.merge_model_results(
        [
            {
                "summary_markdown": "",
                "inline_comments": [
                    {"file": ["src/a.ts"], "line": {"n": 1}, "body": ["x"]},
                    {"file": "src/a.ts", "line": 1, "body": "real"},
                    # Not a dict at all.
                    "not-a-comment",
                ],
                "verdict": "APPROVE_WITH_COMMENTS",
            }
        ],
        [("src/a.ts",)],
    )

    assert merged["verdict"] == "APPROVE_WITH_COMMENTS"
    bodies = [c.get("body") for c in merged["inline_comments"]]
    assert "real" in bodies
    # And the malformed ones still can't reach GitHub as anchors.
    payload = review_lib.build_review_payload(DIFF, merged)
    assert all(isinstance(c["line"], int) for c in payload["comments"])


def test_duplicate_detection_survives_the_string_coercion():
    merged = review_lib.merge_model_results(
        [
            {
                "summary_markdown": "",
                "inline_comments": [{"file": "a.ts", "line": 1, "body": "x"}],
                "verdict": "APPROVE",
            },
            {
                "summary_markdown": "",
                "inline_comments": [{"file": "a.ts", "line": 1, "body": "x"}],
                "verdict": "APPROVE",
            },
        ],
        [("a.ts",), ("a.ts",)],
    )

    assert len(merged["inline_comments"]) == 1


# --- nothing from an upstream error reaches a public body unscrubbed --------


def test_error_text_is_scrubbed_before_it_can_be_published():
    # `sk-FAKE…` — not a realistic key shape, so it can't trip secret
    # scanning or push protection, while staying >=32 chars so the
    # high-entropy redaction rule still fires on it (#610 item 4).
    leaky = (
        "502 from https://gw.internal/v1/chat?api_key=sk-FAKEabcd1234efgh5678ijkl9012mnop3456 "
        "(Authorization: Bearer sk-FAKElive9f8e7d6c5b4a3210zyxwvutsrqponmlk) upstream refused"
    )
    scrubbed = review_lib.safe_error_text(RuntimeError(leaky))

    for secret in (
        "sk-FAKEabcd1234efgh5678ijkl9012mnop3456",
        "sk-FAKElive9f8e7d6c5b4a3210zyxwvutsrqponmlk",
    ):
        assert secret not in scrubbed
    assert "gw.internal" not in scrubbed
    assert "api_key=" not in scrubbed
    assert len(scrubbed) <= review_lib.MAX_ERROR_TEXT_CHARS
    # Still diagnostic: the non-sensitive part survives.
    assert "502" in scrubbed


def test_redaction_does_not_eat_the_diagnostic():
    """Over-redaction is its own failure: with the separator optional,
    `401: token expired` matched the credential rule and lost the word that
    says what went wrong, leaving a scrubbed body with no signal in it."""
    for intact in [
        "401: token expired",
        "403: secret not configured",
        "api key quota exceeded",
        "Authorization failed for this model",
        "password rotation required",
        "Cloudflare 524: origin took too long to respond",
    ]:
        assert review_lib.safe_error_text(RuntimeError(intact)) == intact

    # …while a secret in any of those same shapes is still redacted, because
    # the high-entropy and URL rules catch what the separator rule now skips.
    for leaky, secret in [
        ("HTTP 401: invalid api-key aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        ("token: sk-FAKE9f8e7d6c5b4a3210zyxwvutsrqponmlk", "sk-FAKE9f8e7d6c5b4a3210zyxwvutsrqponmlk"),
        (
            "Authorization: Bearer sk-FAKElive9f8e7d6c5b4a3210zyxwvutsrqponml",
            "sk-FAKElive9f8e7d6c5b4a3210zyxwvutsrqponml",
        ),
    ]:
        assert secret not in review_lib.safe_error_text(RuntimeError(leaky))


def test_error_text_is_bounded_and_flattened():
    long_error = ("boom " * 500) + "\n\ttrailing"
    scrubbed = review_lib.safe_error_text(RuntimeError(long_error))

    assert len(scrubbed) <= review_lib.MAX_ERROR_TEXT_CHARS
    assert "\n" not in scrubbed and "\t" not in scrubbed
    assert scrubbed.endswith("…")
    assert review_lib.safe_error_text(RuntimeError("")) == "(no error text)"


def test_a_leaky_refusal_does_not_publish_the_secret_in_the_review_body():
    diff = _file_diff("src/a.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)

    def fake_call(diff, changed_files, **kwargs):
        if changed_files == ["src/b.ts"]:
            exc = RuntimeError(
                "400 https://gw.internal/v1?token=sk-FAKEtopsecret0123456789abcdefghij rejected"
            )
            exc.status_code = 400
            raise exc
        return {"summary_markdown": "ok", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    assert "sk-FAKEtopsecret0123456789abcdefghij" not in payload["summary_markdown"]
    assert "gw.internal" not in payload["summary_markdown"]
    assert "was refused by the provider" in payload["summary_markdown"]


def test_the_exhausted_retries_body_is_scrubbed_too():
    """The likeliest leak: `Last error:` is posted publicly on every reviewer
    that runs out of retries."""

    class Leaky(FakeCompletions):
        def create(self, **_kwargs):
            self.calls += 1
            raise RuntimeError(
                "524 from https://gw.internal/v1?key=sk-FAKEleak0123456789abcdefghijkl"
            )

    client = FakeClient([])
    client.completions = Leaky([])
    client.chat = types.SimpleNamespace(completions=client.completions)

    result = _call(client)

    assert "sk-FAKEleak0123456789abcdefghijkl" not in result["summary_markdown"]
    assert "gw.internal" not in result["summary_markdown"]
    assert "524" in result["summary_markdown"]


# --- only provider refusals are absorbed ------------------------------------


def test_a_bug_in_our_own_code_is_not_reported_as_a_provider_refusal():
    """A NameError surfacing as 'the provider refused this slice' is a lie the
    banner would then repeat, and the bug would never surface."""
    diff = _file_diff("src/a.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)

    def fake_call(diff, changed_files, **kwargs):
        raise AttributeError("'NoneType' object has no attribute 'choices'")

    with pytest.raises(AttributeError, match="choices"):
        review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)


def test_a_non_status_exception_still_propagates_even_when_later_slices_are_fine():
    diff = _file_diff("src/a.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)

    def fake_call(diff, changed_files, **kwargs):
        if changed_files == ["src/a.ts"]:
            raise KeyError("typo_in_our_dict")
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    with pytest.raises(KeyError):
        review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)


def test_findings_kept_from_an_incomplete_slice_are_declared_as_such():
    """The banner said a slice went unreviewed while that slice's findings sat
    on the same page. They are kept — an anchored finding is worth reading —
    but the body now says where they came from."""
    diff = _file_diff("src/trader/x.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)
    results = [
        {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"},
        {
            "summary_markdown": "",
            "inline_comments": [
                {"file": "src/trader/x.ts", "line": 1, "body": "half-read finding"}
            ],
            "verdict": None,  # slice never completed
        },
    ]
    calls = []

    def fake_call(diff, changed_files, **kwargs):
        calls.append(1)
        return results[len(calls) - 1]

    # 1500, not 1200: at 1200 the first file exceeds the cap on its own and is
    # skipped before any call happens, which tests a different thing.
    payload = review_lib.review_diff(diff, [], call=fake_call, max_chars=1500)
    summary = payload["summary_markdown"]

    # Kept…
    assert [c["body"] for c in payload["comments"]] == ["half-read finding"]
    # …and declared.
    assert "1 inline comment below came from a slice that did not complete" in summary
    assert "Partial review" in summary
    assert payload["verdict"] != "APPROVE"


def test_no_partial_findings_note_when_every_slice_completed():
    def fake_call(diff, changed_files, **kwargs):
        return {
            "summary_markdown": "",
            "inline_comments": [{"file": "src/trader/x.ts", "line": 1, "body": "x"}],
            "verdict": "APPROVE_WITH_COMMENTS",
        }

    payload = review_lib.review_diff(DIFF, [], call=fake_call)

    assert payload["comments"]
    assert "did not complete" not in payload["summary_markdown"]


def test_an_auth_refusal_stops_immediately_instead_of_paying_for_the_rest():
    """401/403 is about the shared key or endpoint, never one slice's content,
    so every remaining slice would fail identically at full price."""
    diff = "".join(
        _file_diff(p, lines_per_hunk=40) for p in ("src/a.ts", "src/b.ts", "src/c.ts")
    )
    calls = []

    def fake_call(diff, changed_files, **kwargs):
        calls.append(changed_files[0])
        exc = RuntimeError("401 Unauthorized")
        exc.status_code = 401
        raise exc

    with pytest.raises(RuntimeError, match="credentials, endpoint, or request configuration"):
        review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    assert calls == ["src/a.ts"], "must not pay for slices 2 and 3"


def test_a_404_stops_immediately_too():
    """The endpoint URL is fixed for the whole run, so a 404 on slice 1 is a
    404 on every remaining slice regardless of that slice's content — same
    reasoning as the 401/403 short-circuit, just for a different code."""
    diff = "".join(
        _file_diff(p, lines_per_hunk=40) for p in ("src/a.ts", "src/b.ts", "src/c.ts")
    )
    calls = []

    def fake_call(diff, changed_files, **kwargs):
        calls.append(changed_files[0])
        exc = RuntimeError("404 Not Found")
        exc.status_code = 404
        raise exc

    with pytest.raises(RuntimeError, match="credentials, endpoint, or request configuration"):
        review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    assert calls == ["src/a.ts"], "must not pay for slices 2 and 3"


def test_a_config_class_400_stops_immediately():
    """A 400 naming `max_tokens` or `model` as its `param` is about the
    REQUEST we sent, not this slice's diff — every remaining slice sends the
    identical value and would be refused identically."""
    diff = "".join(
        _file_diff(p, lines_per_hunk=40) for p in ("src/a.ts", "src/b.ts", "src/c.ts")
    )
    calls = []

    def fake_call(diff, changed_files, **kwargs):
        calls.append(changed_files[0])
        exc = RuntimeError("max_tokens is too large: 32768")
        exc.status_code = 400
        exc.param = "max_tokens"
        raise exc

    with pytest.raises(RuntimeError, match="credentials, endpoint, or request configuration"):
        review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    assert calls == ["src/a.ts"], "must not pay for slices 2 and 3"


def test_a_config_class_400_short_circuits_via_the_body_shape_too():
    """A hand-built exception (or one not routed through the openai SDK's
    unwrapping) may carry the OpenAI-shaped error as `.body` instead of a
    bare `.param` attribute — `_request_param` must read either shape."""
    diff = "".join(
        _file_diff(p, lines_per_hunk=40) for p in ("src/a.ts", "src/b.ts", "src/c.ts")
    )
    calls = []

    def fake_call(diff, changed_files, **kwargs):
        calls.append(changed_files[0])
        exc = RuntimeError("model not found")
        exc.status_code = 400
        exc.body = {"error": {"message": "model not found", "param": "model"}}
        raise exc

    with pytest.raises(RuntimeError, match="credentials, endpoint, or request configuration"):
        review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    assert calls == ["src/a.ts"]


def test_a_400_naming_an_unrecognised_param_does_not_short_circuit():
    """Only `max_tokens`/`model` are OUR non-content request arguments. A 400
    naming something else — e.g. a field the provider derived from the diff
    content itself — has no basis for being treated as request-wide."""
    diff = "".join(
        _file_diff(p, lines_per_hunk=40) for p in ("src/a.ts", "src/b.ts", "src/c.ts")
    )
    calls = []

    def fake_call(diff, changed_files, **kwargs):
        calls.append(changed_files[0])
        if changed_files == ["src/a.ts"]:
            exc = RuntimeError("messages content rejected")
            exc.status_code = 400
            exc.param = "messages"
            raise exc
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    assert calls == ["src/a.ts", "src/b.ts", "src/c.ts"]
    assert "Partial review" in payload["summary_markdown"]


def test_a_400_naming_max_tokens_in_the_message_but_not_as_param_does_not_short_circuit():
    """Classification is on the status code and the structured `param` field,
    never a message match — matching "max_tokens" as text would misclassify
    a message that merely quotes it back without the request being at fault
    (and would break the two all-refused tests below, which set no param)."""
    diff = "".join(
        _file_diff(p, lines_per_hunk=40) for p in ("src/a.ts", "src/b.ts", "src/c.ts")
    )
    calls = []

    def fake_call(diff, changed_files, **kwargs):
        calls.append(changed_files[0])
        if changed_files == ["src/a.ts"]:
            exc = RuntimeError("content mentions max_tokens in a code sample")
            exc.status_code = 400
            raise exc
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    assert calls == ["src/a.ts", "src/b.ts", "src/c.ts"]
    assert "Partial review" in payload["summary_markdown"]


def test_a_422_does_not_short_circuit():
    """422 ("a rejected payload," per `_FATAL_STATUS_CODES`'s own comment)
    can turn on what was IN the request — the diff itself — so unlike 404 it
    is not unconditionally endpoint-level, and stays on the per-slice path."""
    diff = "".join(
        _file_diff(p, lines_per_hunk=40) for p in ("src/a.ts", "src/b.ts", "src/c.ts")
    )
    calls = []

    def fake_call(diff, changed_files, **kwargs):
        calls.append(changed_files[0])
        if changed_files == ["src/a.ts"]:
            exc = RuntimeError("422 Unprocessable Entity")
            exc.status_code = 422
            raise exc
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    assert calls == ["src/a.ts", "src/b.ts", "src/c.ts"]
    assert "Partial review" in payload["summary_markdown"]


def test_request_param_reads_both_the_attribute_and_the_body_shapes():
    attr_only = RuntimeError("x")
    attr_only.param = "max_tokens"
    assert review_lib._request_param(attr_only) == "max_tokens"

    unwrapped_body = RuntimeError("x")
    unwrapped_body.body = {"param": "model"}
    assert review_lib._request_param(unwrapped_body) == "model"

    enveloped_body = RuntimeError("x")
    enveloped_body.body = {"error": {"param": "model"}}
    assert review_lib._request_param(enveloped_body) == "model"

    nothing = RuntimeError("x")
    assert review_lib._request_param(nothing) is None

    not_a_string = RuntimeError("x")
    not_a_string.param = ["max_tokens"]
    not_a_string.body = {"param": 123}
    assert review_lib._request_param(not_a_string) is None


def test_a_content_refusal_does_not_short_circuit():
    """400 CAN be slice-specific, so the remaining slices are still attempted."""
    diff = "".join(
        _file_diff(p, lines_per_hunk=40) for p in ("src/a.ts", "src/b.ts", "src/c.ts")
    )
    calls = []

    def fake_call(diff, changed_files, **kwargs):
        calls.append(changed_files[0])
        if changed_files == ["src/a.ts"]:
            exc = RuntimeError("400 content filter")
            exc.status_code = 400
            raise exc
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    assert calls == ["src/a.ts", "src/b.ts", "src/c.ts"]
    assert "Partial review" in payload["summary_markdown"]


def test_the_all_refused_error_is_scrubbed():
    """It dies loudly, but the Actions log gets the scrubbed reason, not a
    gateway's echo of the request."""
    diff = _file_diff("src/a.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)

    def fake_call(diff, changed_files, **kwargs):
        exc = RuntimeError(
            "400 max_tokens is too large: 32768 "
            "(https://gw.internal/v1?key=sk-FAKEleak0123456789abcdefghijkl)"
        )
        exc.status_code = 400
        raise exc

    with pytest.raises(RuntimeError) as caught:
        review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    message = str(caught.value)
    assert "sk-FAKEleak0123456789abcdefghijkl" not in message
    assert "gw.internal" not in message
    # The provider's actual reason still survives — that is the whole point.
    assert "max_tokens is too large: 32768" in message
    # No chained original, which would print the unscrubbed text anyway.
    assert caught.value.__cause__ is None and caught.value.__context__ is None


def test_the_auth_short_circuit_error_is_scrubbed_too():
    diff = _file_diff("src/a.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)

    def fake_call(diff, changed_files, **kwargs):
        exc = RuntimeError("403 forbidden for token: sk-FAKEsecret0123456789abcdefghijklmn")
        exc.status_code = 403
        raise exc

    with pytest.raises(RuntimeError) as caught:
        review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    assert "sk-FAKEsecret0123456789abcdefghijklmn" not in str(caught.value)
    # Raised inside the `except`, so __context__ still holds the original —
    # `from None` sets __suppress_context__, which is what stops the traceback
    # printing the unscrubbed text.
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__ is True


# --- read-time ceiling ------------------------------------------------------


def test_a_diff_under_the_ceiling_is_read_whole(tmp_path):
    path = tmp_path / "diff.txt"
    path.write_text(DIFF)

    text, skipped = review_lib.read_capped_diff(str(path))

    assert text == DIFF
    assert skipped == []


def test_an_oversized_diff_is_cut_on_a_file_boundary_and_the_rest_named(tmp_path):
    """Removing the 60k truncation was the ticket; removing it with no ceiling
    at all trades a silent lie for a dead runner. The ceiling discloses."""
    paths = [f"src/gen/f{i}.ts" for i in range(6)]
    diff = "".join(_file_diff(p, hunks=1, lines_per_hunk=30) for p in paths)
    path = tmp_path / "diff.txt"
    path.write_text(diff)

    text, skipped = review_lib.read_capped_diff(str(path), limit=1500)

    assert len(text) <= 1500
    # Cut on a boundary: whatever was kept is a whole number of file entries.
    assert text.startswith("diff --git ")
    kept = review_lib.changed_files_from_diff(text)
    assert kept and all(diff.count(f"+++ b/{f}\n") == 1 for f in kept)
    plan = review_lib.split_diff_into_slices(text)
    assert "".join(s.text for s in plan.slices) == text

    # Everything dropped is named.
    assert len(skipped) == 1
    for missing in set(paths) - set(kept):
        assert missing in skipped[0]
    assert "NOT reviewed" in skipped[0]


def test_the_read_ceiling_disclosure_reaches_the_banner_and_blocks_approve():
    def fake_call(diff, changed_files, **kwargs):
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(
        DIFF,
        ["src/trader/x.ts"],
        call=fake_call,
        extra_skipped=["the diff is larger than the ceiling … `src/gen/huge.ts`"],
    )

    assert payload["event"] == "COMMENT"
    assert payload["verdict"] != "APPROVE"
    assert "src/gen/huge.ts" in payload["summary_markdown"]


def test_a_single_file_bigger_than_the_whole_ceiling_keeps_nothing_and_says_so(tmp_path):
    diff = _file_diff("src/gen/huge.ts", hunks=1, lines_per_hunk=400)
    path = tmp_path / "diff.txt"
    path.write_text(diff)

    text, skipped = review_lib.read_capped_diff(str(path), limit=200)

    assert text == ""
    assert "src/gen/huge.ts" in skipped[0]


def test_a_giant_single_line_file_past_the_cut_does_not_block_the_scan(tmp_path):
    """The exact case MAX_TOTAL_DIFF_CHARS's docstring cites: a minified or
    generated file that is one line with no embedded newline. Before the
    bound, `pending += chunk` would accumulate the WHOLE remainder of that
    line — megabytes — before the scan could resume. The file after the
    blob must still be found and named."""
    blob_line = "x" * (3 * review_lib._MAX_PENDING_LINE_CHARS)
    diff = (
        _file_diff("src/gen/before.ts", hunks=1, lines_per_hunk=30)
        + f"diff --git a/src/gen/blob.min.js b/src/gen/blob.min.js\n"
        f"--- a/src/gen/blob.min.js\n+++ b/src/gen/blob.min.js\n"
        f"@@ -1,1 +1,1 @@\n-old\n+{blob_line}\n"
        + _file_diff("src/gen/after.ts", hunks=1, lines_per_hunk=30)
    )
    path = tmp_path / "diff.txt"
    path.write_text(diff)

    # Large enough that BOTH before.ts's and blob.min.js's headers land in
    # the initial bounded read (so the cut boundary lands after before.ts,
    # not mid-file), small enough that most of the giant blob line is still
    # read by the streamed scan below, not the initial read.
    text, skipped = review_lib.read_capped_diff(str(path), limit=2000)

    assert text.startswith("diff --git ")
    assert "src/gen/before.ts" in text
    assert "src/gen/blob.min.js" not in text
    assert "src/gen/blob.min.js" in skipped[0]
    # The scan must have resumed past the blob: the file AFTER it is named.
    assert "src/gen/after.ts" in skipped[0]


def test_a_blob_containing_a_fake_header_does_not_produce_a_false_name(tmp_path):
    """Trimming `pending` to a tail window (instead of dropping it and
    tracking only THAT a line is overlong) would let a `diff --git` string
    that merely appears inside the blob's content get parsed as if it were a
    real header — naming a file that was never actually dropped, which is
    the one thing this banner must never do."""
    ghost_header = "diff --git a/ghost.ts b/ghost.ts"
    padding = "z" * (2 * review_lib._MAX_PENDING_LINE_CHARS)
    blob_line = padding + " " + ghost_header + " " + padding
    diff = (
        _file_diff("src/gen/before.ts", hunks=1, lines_per_hunk=30)
        + "diff --git a/src/gen/blob.min.js b/src/gen/blob.min.js\n"
        "--- a/src/gen/blob.min.js\n+++ b/src/gen/blob.min.js\n"
        f"@@ -1,1 +1,1 @@\n-old\n+{blob_line}\n"
    )
    path = tmp_path / "diff.txt"
    path.write_text(diff)

    text, skipped = review_lib.read_capped_diff(str(path), limit=2000)

    assert text.startswith("diff --git ")
    assert "ghost.ts" not in skipped[0]
    assert "src/gen/blob.min.js" in skipped[0]


# --- markdown injection via a path ------------------------------------------


def test_a_path_cannot_break_out_of_its_code_span():
    assert review_lib.md_code("src/a.ts") == "`src/a.ts`"
    # A backtick in the path would close the span early and inject markdown.
    fenced = review_lib.md_code("src/we`ird.ts")
    assert "we`ird" in fenced and fenced.startswith("``") and fenced.endswith("``")
    assert review_lib.md_code("`lead.ts") == "`` `lead.ts ``"
    # Newlines (decodable out of a C-quoted path) can't break the banner line.
    assert "\n" not in review_lib.md_code("a\nb.ts")


def test_a_hostile_path_does_not_inject_markdown_into_the_posted_banner():
    hostile = "src/x`.ts](javascript:alert(1))"
    diff = _file_diff(hostile, hunks=1, lines_per_hunk=200)

    plan = review_lib.split_diff_into_slices(diff, max_chars=500)
    payload = review_lib.review_diff(diff, [], call=lambda **_k: None, max_chars=500)
    summary = payload["summary_markdown"]

    assert plan.skipped_files == (hostile,)
    # The path is present but fenced so its backtick can't close the span.
    assert hostile in summary
    assert "``" in summary


def test_a_refused_slices_filenames_are_fenced_too():
    hostile = "src/a`b.ts"
    diff = _file_diff(hostile, lines_per_hunk=40) + _file_diff("src/c.ts", lines_per_hunk=40)

    def fake_call(diff, changed_files, **kwargs):
        if changed_files == [hostile]:
            exc = RuntimeError("400 refused")
            exc.status_code = 400
            raise exc
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)

    assert f"``{hostile}``" in payload["summary_markdown"]


def test_a_refused_slice_still_contributes_exactly_one_result():
    """`merge_model_results` labels summaries by index against
    `[s.files for s in plan.slices]`. If a refusal ever skipped appending a
    result, every heading after it would silently name the wrong files."""
    diff = "".join(
        _file_diff(p, lines_per_hunk=40) for p in ("src/a.ts", "src/b.ts", "src/c.ts")
    )
    seen = []

    def fake_call(diff, changed_files, **kwargs):
        seen.append(changed_files[0])
        if changed_files == ["src/b.ts"]:
            exc = RuntimeError("refused")
            exc.status_code = 400
            raise exc
        return {
            "summary_markdown": f"findings for {changed_files[0]}",
            "inline_comments": [],
            "verdict": "APPROVE",
        }

    payload = review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)
    summary = payload["summary_markdown"]

    assert seen == ["src/a.ts", "src/b.ts", "src/c.ts"]
    # Headings still line up with the slice that produced them.
    assert "Slice 1 of 3 — `src/a.ts`" in summary
    assert "findings for src/a.ts" in summary
    assert "Slice 3 of 3 — `src/c.ts`" in summary
    assert "findings for src/c.ts" in summary


def test_an_explained_and_an_unexplained_failure_are_both_reported():
    """`failed = total - reviewed - failures_explained`. With one of each kind
    of failure the generic line must still fire for the unexplained one — an
    arithmetic slip here would zero it out and drop the disclosure."""
    diff = "".join(
        _file_diff(p, lines_per_hunk=40) for p in ("src/a.ts", "src/b.ts", "src/c.ts")
    )

    def fake_call(diff, changed_files, **kwargs):
        if changed_files == ["src/b.ts"]:
            exc = RuntimeError("refused")
            exc.status_code = 400
            raise exc
        if changed_files == ["src/c.ts"]:
            # The exhausted-retries shape: a result, but no usable verdict.
            return {"summary_markdown": "_skipped_", "inline_comments": [], "verdict": None}
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)
    summary = payload["summary_markdown"]

    assert "1/3" in summary
    assert "1 diff slice(s) produced no usable review." in summary  # the unexplained one
    assert "was refused by the provider" in summary  # the explained one
    assert payload["verdict"] != "APPROVE"


def test_a_refusal_on_every_slice_still_fails_the_job_loudly():
    """A configuration fault — a rejected max_tokens, a dead key — does not
    discriminate between slices. There is no paid work to preserve, so it must
    surface as the provider's error rather than a review saying 'partial'."""
    diff = _file_diff("src/a.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)

    def fake_call(diff, changed_files, **kwargs):
        exc = RuntimeError("max_tokens is too large: 32768")
        exc.status_code = 400
        raise exc

    with pytest.raises(RuntimeError, match="max_tokens"):
        review_lib.review_diff(diff, [], call=fake_call, max_chars=1200)


def test_transient_4xx_codes_stay_in_the_retry_loop():
    """408 and 409 are transient on a proxied endpoint; treating every non-429
    4xx as fatal would kill a run over exactly the blip the retries exist for.
    Unlisted codes default to retrying — the cheaper mistake."""
    for status, fatal in [
        (400, True), (401, True), (403, True), (404, True), (422, True),
        (408, False), (409, False), (425, False), (429, False), (500, False),
    ]:
        exc = RuntimeError("boom")
        exc.status_code = status
        assert review_lib._is_fatal_request_error(exc) is fatal, status

    # And end to end: a 408 is retried, not raised.
    class Timing(FakeCompletions):
        def create(self, **_kwargs):
            self.calls += 1
            exc = RuntimeError("request timeout")
            exc.status_code = 408
            raise exc

    client = FakeClient([])
    client.completions = Timing([])
    client.chat = types.SimpleNamespace(completions=client.completions)
    result = _call(client)

    assert client.completions.calls == review_lib.TRANSIENT_MAX_ATTEMPTS
    assert result["verdict"] is None


def test_a_file_the_slicer_already_explained_is_not_listed_twice():
    """The cross-check must not re-report files `plan.skipped` already names
    with a specific reason — a banner that lists the same file twice reads as
    two separate losses and teaches readers to skim it."""
    diff = _file_diff("src/execution/huge.ts", hunks=1, lines_per_hunk=200)

    plan = review_lib.split_diff_into_slices(diff, max_chars=500)
    assert plan.skipped_files == ("src/execution/huge.ts",)

    def fake_call(diff, changed_files, **kwargs):  # pragma: no cover - nothing reviewable
        raise AssertionError("no slice should be reviewable here")

    payload = review_lib.review_diff(
        diff, ["src/execution/huge.ts"], call=fake_call, max_chars=500
    )
    summary = payload["summary_markdown"]

    assert summary.count("src/execution/huge.ts") == 1
    assert "matched no diff slice" not in summary
    assert "could not be split further" in summary


def test_the_slice_cap_also_suppresses_the_duplicate_listing():
    paths = [f"src/a{i}.ts" for i in range(6)]
    diff = "".join(_file_diff(p, hunks=1, lines_per_hunk=10) for p in paths)

    plan = review_lib.split_diff_into_slices(diff, max_chars=300, max_slices=2)
    covered = {f for s in plan.slices for f in s.files}
    assert set(plan.skipped_files) == set(paths) - covered

    def fake_call(diff, changed_files, **kwargs):
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(diff, paths, call=fake_call, max_chars=300, max_slices=2)
    summary = payload["summary_markdown"]

    assert "matched no diff slice" not in summary
    for path in set(paths) - covered:
        assert summary.count(path) == 1


def test_git_failure_makes_the_file_list_unknown_not_empty(monkeypatch):
    """[] would read as 'the slicer missed nothing' and make the cross-check
    silently vacuous for the whole run.

    `review_lib.subprocess` is the real stdlib module, so assigning to
    `.run` directly patches it process-wide for anything else importing
    `subprocess` in the same interpreter. `monkeypatch.setattr` makes both
    the intent (this is a patch, scoped to this test) and the teardown
    (restored automatically, even on failure) explicit — a manual
    try/finally restores correctly but reads as an ordinary attribute write
    until you notice what module it's on (#610 item 5)."""

    class Failed:
        returncode = 1
        stdout = ""
        stderr = "fatal: bad revision 'origin/main...HEAD'"

    monkeypatch.setattr(review_lib.subprocess, "run", lambda *a, **k: Failed())
    assert review_lib.get_changed_files("main") is None

    # And the no-base-ref case is 'unknown' for the same reason.
    assert review_lib.get_changed_files("") is None


def test_an_unknown_file_list_is_disclosed_rather_than_trusted():
    """The cross-check is the net the rest of the design leans on. A net that
    has quietly stopped catching things is worse than no net."""

    def fake_call(diff, changed_files, **kwargs):
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(DIFF, None, call=fake_call)
    summary = payload["summary_markdown"]

    assert "NOT independently cross-checked" in summary
    assert payload["verdict"] != "APPROVE"
    assert payload["event"] == "COMMENT"
    # The headline must state THIS failure, not invent a different one: every
    # slice was in fact reviewed, so "part of the diff was never read" would
    # be its own false claim — the exact defect this banner exists to prevent.
    assert "Unverified coverage" in summary
    assert "Partial review" not in summary
    assert "1/1" in summary


def test_real_content_loss_still_gets_the_partial_headline():
    """The two headlines must not blur: when content really was unread, the
    banner has to say so rather than downgrade to 'unverified'."""
    diff = _file_diff("src/a.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)
    calls = []

    def fake_call(diff, changed_files, **kwargs):
        calls.append(1)
        if len(calls) == 2:
            return {"summary_markdown": "", "inline_comments": [], "verdict": None}
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(diff, None, call=fake_call, max_chars=1200)
    summary = payload["summary_markdown"]

    assert "Partial review" in summary
    assert "Unverified coverage" not in summary
    # …and the unverified cross-check is still listed as its own line.
    assert "NOT independently cross-checked" in summary


def test_a_known_empty_file_list_is_not_treated_as_a_git_failure():
    """[] from a caller that genuinely has no list to offer is not the same
    signal, and must not raise a false alarm on every dispatch run."""

    def fake_call(diff, changed_files, **kwargs):
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(DIFF, [], call=fake_call)

    assert "cross-checked" not in payload["summary_markdown"]
    assert payload["event"] == "APPROVE"


def test_an_unknown_file_list_on_an_empty_diff_says_nothing_extra():
    payload = review_lib.review_diff("", None, call=lambda **_k: None)

    assert "cross-checked" not in payload["summary_markdown"]
    assert "No diff detected" in payload["summary_markdown"]


def test_a_genuinely_unexplained_missing_file_is_still_reported():
    """Suppressing duplicates must not suppress the case the cross-check
    exists for: a file missing with no reason given."""

    def fake_call(diff, changed_files, **kwargs):
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    payload = review_lib.review_diff(
        DIFF, ["src/trader/x.ts", "src/risk-manager/ghost.ts"], call=fake_call
    )

    assert "matched no diff slice" in payload["summary_markdown"]
    assert "src/risk-manager/ghost.ts" in payload["summary_markdown"]


def test_the_cross_check_does_not_fire_on_renames_or_submodules():
    """The cross-check blocks APPROVE, so a false positive on an ordinary PR
    would teach every reviewer to ignore the banner. These are the two shapes
    where `git diff --name-only` and the diff headers could disagree: a rename
    (name-only prints the NEW path; the header is `a/old b/new`) and a
    submodule bump (a hunk of `Subproject commit` lines). Both diffs below are
    real `git diff` output, reduced."""
    rename = (
        "diff --git a/old.ts b/new.ts\nsimilarity index 83%\nrename from old.ts\n"
        "rename to new.ts\nindex 6f195b4..cbe236c 100644\n--- a/old.ts\n+++ b/new.ts\n"
        "@@ -3,3 +3,4 @@ bbb\n ccc\n ddd\n eee\n+fff\n"
    )
    pure_rename = (
        "diff --git a/new.ts b/final.ts\nsimilarity index 100%\n"
        "rename from new.ts\nrename to final.ts\n"
    )
    submodule = (
        "diff --git a/sub b/sub\nindex c85df84..f781a9a 160000\n--- a/sub\n+++ b/sub\n"
        "@@ -1 +1 @@\n-Subproject commit c85df847eef57bc08a3552f65380d3f20adaded6\n"
        "+Subproject commit f781a9afb8a6d8d5efa2d953363b57def1e881c0\n"
    )

    def fake_call(diff, changed_files, **kwargs):
        return {"summary_markdown": "", "inline_comments": [], "verdict": "APPROVE"}

    for diff, name_only in [
        (rename, ["new.ts"]),
        (pure_rename, ["final.ts"]),
        (submodule, ["sub"]),
    ]:
        # What `git diff --name-only` reports must match what the slicer covers.
        assert review_lib.changed_files_from_diff(diff) == name_only
        payload = review_lib.review_diff(diff, name_only, call=fake_call)
        assert "Partial review" not in payload["summary_markdown"], name_only
        assert payload["event"] == "APPROVE", name_only


# --- git C-quoted paths -----------------------------------------------------

QUOTED_DIFF = (
    'diff --git "a/src/trader/caf\\303\\251.ts" "b/src/trader/caf\\303\\251.ts"\n'
    '--- "a/src/trader/caf\\303\\251.ts"\n'
    '+++ "b/src/trader/caf\\303\\251.ts"\n'
    "@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;\n"
)


def test_c_quoted_paths_are_decoded_not_dropped():
    assert review_lib.changed_files_from_diff(QUOTED_DIFF) == ["src/trader/café.ts"]
    assert review_lib.commentable_lines(QUOTED_DIFF) == {"src/trader/café.ts": {1, 2}}


def test_a_c_quoted_file_does_not_merge_into_the_previous_files_slice():
    """The regex used to miss the quoted header, so this file's body was
    appended to the PREVIOUS file's block — one file's content reviewed under
    another file's name, with nothing saying so."""
    plan = review_lib.split_diff_into_slices(DIFF + QUOTED_DIFF)

    assert len(plan.slices) == 1
    assert plan.slices[0].files == ("src/trader/x.ts", "src/trader/café.ts")
    assert plan.skipped == []


def test_all_four_quoting_combinations_parse():
    """git quotes each side INDEPENDENTLY, so a rename can quote only one of
    them. Every line below is real `git diff` output, reduced."""
    cases = [
        # both bare
        ("diff --git a/src/x.ts b/src/x.ts", ("src/x.ts", "src/x.ts")),
        ("diff --git a/old.ts b/new.ts", ("old.ts", "new.ts")),
        # both quoted
        (
            'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
            ("café.ts", "café.ts"),
        ),
        # bare -> quoted rename (git mv plain.ts café.ts)
        ('diff --git a/plain.ts "b/caf\\303\\251.ts"', ("plain.ts", "café.ts")),
        # quoted -> bare rename (git mv café.ts plain2.ts)
        ('diff --git "a/caf\\303\\251.ts" b/plain2.ts', ("café.ts", "plain2.ts")),
    ]
    for line, expected in cases:
        assert review_lib.diff_git_paths(line) == expected, line


def test_a_mixed_quoted_rename_does_not_merge_into_the_previous_file():
    """The failure the both-quoted-only pattern left open: the header matched
    nothing, so this file's whole body was appended to the PREVIOUS file's
    block and reviewed under that file's name."""
    mixed = (
        'diff --git a/plain.ts "b/caf\\303\\251.ts"\n'
        "--- a/plain.ts\n"
        '+++ "b/caf\\303\\251.ts"\n'
        "@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;\n"
    )

    plan = review_lib.split_diff_into_slices(DIFF + mixed)

    assert plan.slices[0].files == ("src/trader/x.ts", "café.ts")
    assert review_lib.changed_files_from_diff(DIFF + mixed) == [
        "src/trader/x.ts",
        "café.ts",
    ]
    assert plan.skipped == []


def test_quoted_path_escapes_are_decoded_faithfully():
    assert review_lib._unquote_git_path('"a/a\\tb.ts"', "a/") == "a\tb.ts"
    assert review_lib._unquote_git_path('"a/say \\"hi\\".ts"', "a/") == 'say "hi".ts'
    assert review_lib._unquote_git_path('"a/back\\\\slash.ts"', "a/") == "back\\slash.ts"
    # Unquoted paths, including ones containing a space, are untouched.
    assert review_lib._unquote_git_path("a/plain path.ts", "a/") == "plain path.ts"


def test_unquoted_paths_containing_spaces_still_split_correctly():
    line = "diff --git a/src/my file.ts b/src/my file.ts"

    assert review_lib.diff_git_paths(line) == ("src/my file.ts", "src/my file.ts")


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
                {"file": "src/trader/x.ts", "line": 2, "severity": "high", "body": "a"},
                # Same finding repeated inside one slice.
                {"file": "src/trader/x.ts", "line": 2, "severity": "high", "body": "a"},
            ],
            "verdict": "APPROVE_WITH_COMMENTS",
        },
        {
            "summary_markdown": "slice two",
            "inline_comments": [
                # Repeated across slices (a file split over two calls).
                {"file": "src/trader/x.ts", "line": 2, "severity": "high", "body": "a"},
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
                    {"file": "src/trader/y.ts", "line": 3, "severity": "high", "body": "late"}
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


# --- mechanism 5: a reviewer that produced nothing must not read as `pass` (#567) --


def test_no_usable_review_is_true_when_every_attempted_slice_is_unusable():
    diff = _file_diff("src/a.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)

    def fake_call(diff, changed_files, **kwargs):
        # The exact shape `call_model` returns once its retries are exhausted.
        return {"summary_markdown": "_skipped_", "inline_comments": [], "verdict": None}

    payload = review_lib.review_diff(diff, ["src/a.ts", "src/b.ts"], call=fake_call, max_chars=1200)

    assert payload["no_usable_review"] is True
    assert payload["event"] == "COMMENT"


def test_no_usable_review_is_false_when_even_one_slice_comes_back_usable():
    """The #567 defect is 'never reviewed', not 'partial coverage' — those
    already get a disclosure banner and a capped verdict, and must not also
    trip the harder failure this ticket adds, or one flaky slice on an
    otherwise-fine large PR turns red for no new reason."""
    diff = _file_diff("src/a.ts", lines_per_hunk=40) + _file_diff("src/b.ts", lines_per_hunk=40)
    results = [
        {"summary_markdown": "fine", "inline_comments": [], "verdict": "APPROVE"},
        {"summary_markdown": "_skipped_", "inline_comments": [], "verdict": None},
    ]
    calls = []

    def fake_call(diff, changed_files, **kwargs):
        calls.append(diff)
        return results[len(calls) - 1]

    payload = review_lib.review_diff(diff, ["src/a.ts"], call=fake_call, max_chars=1200)

    assert payload["no_usable_review"] is False
    assert "Partial review" in payload["summary_markdown"]  # still disclosed, just not fatal


def test_no_usable_review_is_false_on_a_genuinely_empty_diff():
    """Nothing was ever attempted on a no-op diff — that's not the 'attempted
    and got nothing back' failure this flag exists to catch, and flagging it
    would turn every no-op PR into a hard failure."""
    payload = review_lib.review_diff("", [], call=lambda **_k: None)

    assert payload["no_usable_review"] is False


def test_no_usable_review_defaults_false_without_coverage():
    payload = review_lib.build_review_payload(
        DIFF, {"summary_markdown": "x", "inline_comments": [], "verdict": "APPROVE"}
    )

    assert payload["no_usable_review"] is False


def test_review_coverage_no_usable_review_property():
    assert review_lib.ReviewCoverage(slices_total=2, slices_reviewed=0).no_usable_review is True
    assert review_lib.ReviewCoverage(slices_total=2, slices_reviewed=1).no_usable_review is False
    assert review_lib.ReviewCoverage(slices_total=0, slices_reviewed=0).no_usable_review is False


# --- severity gate ----------------------------------------------------------


def _comment(line=2, severity="high", body="finding", file="src/trader/x.ts"):
    return {"file": file, "line": line, "severity": severity, "body": body}


def _result(comments, summary="", verdict="REQUEST_CHANGES"):
    return {
        "summary_markdown": summary,
        "inline_comments": list(comments),
        "verdict": verdict,
    }


def test_low_severity_findings_do_not_anchor_inline():
    payload = review_lib.build_review_payload(
        DIFF, _result([_comment(severity="low", body="rename this")])
    )

    assert payload["comments"] == []
    assert "rename this" in payload["summary_markdown"]
    assert "Low-severity findings" in payload["summary_markdown"]


def test_low_severity_is_not_filed_under_the_unanchorable_heading():
    """A gated `low` COULD have anchored — saying it could not be anchored
    would misreport why it is in the body."""
    payload = review_lib.build_review_payload(
        DIFF, _result([_comment(severity="low", body="nit")])
    )
    body = payload["summary_markdown"]

    heading = "could not be anchored inline"
    assert heading not in body


@pytest.mark.parametrize("severity", ["high", "medium", "HIGH", " Medium ", None, "", "bogus", 3])
def test_everything_not_low_still_anchors_inline(severity):
    """The model's JSON is untrusted: an unparseable severity must never
    silently demote a finding into a body bullet."""
    payload = review_lib.build_review_payload(DIFF, _result([_comment(severity=severity)]))

    assert len(payload["comments"]) == 1


@pytest.mark.parametrize("severity", ["low", "LOW", " low "])
def test_low_is_matched_case_and_whitespace_insensitively(severity):
    payload = review_lib.build_review_payload(DIFF, _result([_comment(severity=severity)]))

    assert payload["comments"] == []


# --- cross-run dedup --------------------------------------------------------


def test_a_previously_flagged_line_is_not_commented_again():
    prior = [
        {
            "path": "src/trader/x.ts",
            "line": 2,
            "side": "RIGHT",
            "body": "old finding\n\n" + review_lib.comment_marker("nous-kimi"),
        }
    ]
    anchors = review_lib.existing_comment_anchors(prior, "nous-kimi")

    payload = review_lib.build_review_payload(
        DIFF, _result([_comment(body="same line, reworded")]),
        reviewer="nous-kimi",
        existing_anchors=anchors,
    )

    assert payload["comments"] == []
    assert "1 finding(s) suppressed" in payload["summary_markdown"]


def test_suppression_is_disclosed_not_silent():
    """A body that simply lost its findings reads exactly like a broken
    reviewer — the #409/#567 shape."""
    payload = review_lib.build_review_payload(
        DIFF, _result([_comment()]),
        reviewer="nous-kimi",
        existing_anchors={("src/trader/x.ts", 2)},
    )

    assert "suppressed" in payload["summary_markdown"]
    assert "src/trader/x.ts" in payload["summary_markdown"]


def test_the_other_reviewers_comments_do_not_suppress_this_ones():
    """deepseek and kimi run concurrently on the same lines; matching on the
    posting identity would let whichever posted first mute the other."""
    prior = [
        {
            "path": "src/trader/x.ts",
            "line": 2,
            "side": "RIGHT",
            "body": "deepseek's take\n\n" + review_lib.comment_marker("nous-deepseek"),
        }
    ]

    anchors = review_lib.existing_comment_anchors(prior, "nous-kimi")

    assert anchors == set()


def test_a_human_comment_on_the_same_line_does_not_suppress_the_reviewer():
    prior = [{"path": "src/trader/x.ts", "line": 2, "side": "RIGHT", "body": "why this?"}]

    assert review_lib.existing_comment_anchors(prior, "nous-kimi") == set()


def test_a_human_quoting_the_marker_cannot_mute_the_reviewer():
    """The marker is plain text in a public thread. A human discussing this
    very mechanism on a PR would otherwise suppress the reviewer on whatever
    line they replied to."""
    prior = [
        {
            "path": "src/trader/x.ts",
            "line": 2,
            "side": "RIGHT",
            "user": {"login": "dd-jp", "type": "User"},
            "body": "why does it stamp " + review_lib.comment_marker("nous-kimi") + "?",
        }
    ]

    assert review_lib.existing_comment_anchors(prior, "nous-kimi") == set()


def test_a_bot_comment_still_suppresses():
    prior = [
        {
            "path": "src/trader/x.ts",
            "line": 2,
            "side": "RIGHT",
            "user": {"login": "kimi-3-review[bot]", "type": "Bot"},
            "body": "prior\n\n" + review_lib.comment_marker("nous-kimi"),
        }
    ]

    assert review_lib.existing_comment_anchors(prior, "nous-kimi") == {("src/trader/x.ts", 2)}


def test_an_outdated_comment_does_not_suppress_a_fresh_finding():
    """GitHub nulls `line` once the code under a comment changes and moves the
    old value to `original_line`. The line has moved on; the finding deserves
    re-posting rather than silent suppression."""
    prior = [
        {
            "path": "src/trader/x.ts",
            "line": None,
            "original_line": 2,
            "side": "RIGHT",
            "body": "stale\n\n" + review_lib.comment_marker("nous-kimi"),
        }
    ]

    assert review_lib.existing_comment_anchors(prior, "nous-kimi") == set()


def test_a_left_side_comment_is_ignored():
    prior = [
        {
            "path": "src/trader/x.ts",
            "line": 2,
            "side": "LEFT",
            "body": "on the old side\n\n" + review_lib.comment_marker("nous-kimi"),
        }
    ]

    assert review_lib.existing_comment_anchors(prior, "nous-kimi") == set()


def test_posted_comments_carry_the_reviewer_marker():
    payload = review_lib.build_review_payload(
        DIFF, _result([_comment(body="finding")]), reviewer="nous-kimi"
    )

    assert payload["comments"][0]["body"].endswith(review_lib.comment_marker("nous-kimi"))
    assert "finding" in payload["comments"][0]["body"]


def test_no_reviewer_means_no_marker_and_no_dedup():
    """`workflow_dispatch` runs with dedup off — a deliberate re-review must
    not be muted by the review it was asked to redo."""
    payload = review_lib.build_review_payload(DIFF, _result([_comment()]))

    assert len(payload["comments"]) == 1
    assert "<!--" not in payload["comments"][0]["body"]


def test_a_fully_suppressed_run_is_not_reported_as_no_usable_review():
    """`no_usable_review` fails the job (#567). A reviewer whose findings were
    all deduped away DID produce a review."""
    payload = review_lib.build_review_payload(
        DIFF,
        _result([_comment()]),
        coverage=review_lib.ReviewCoverage(slices_total=1, slices_reviewed=1),
        reviewer="nous-kimi",
        existing_anchors={("src/trader/x.ts", 2)},
    )

    assert payload["no_usable_review"] is False


def test_inline_only_keeps_its_verdict_line_when_findings_are_suppressed():
    """The placeholder body is keyed on the MODEL's summary being blank, not
    on the accumulated one — otherwise one suppressed finding costs the
    inline-only reviewer its verdict/count line."""
    payload = review_lib.build_review_payload(
        DIFF,
        _result([_comment()], summary="", verdict="REQUEST_CHANGES"),
        reviewer="nous-kimi",
        existing_anchors={("src/trader/x.ts", 2)},
    )
    body = payload["summary_markdown"]

    assert "REQUEST_CHANGES" in body
    assert "0 inline comments posted" in body
    assert "suppressed" in body


def test_dedup_and_severity_compose():
    """A `low` never anchors, so it never earns an anchor a later run matches
    on: it must land in the low section, not the suppressed one."""
    payload = review_lib.build_review_payload(
        DIFF,
        _result([_comment(severity="low", body="nit"), _comment(severity="high", body="real")]),
        reviewer="nous-kimi",
        existing_anchors={("src/trader/x.ts", 2)},
    )
    body = payload["summary_markdown"]

    assert payload["comments"] == []
    assert "Low-severity findings" in body
    assert "nit" in body
    assert "1 finding(s) suppressed" in body


# --- the fetched-comments file --------------------------------------------


def _write(tmp_path, payload):
    path = tmp_path / "existing_comments.json"
    path.write_text(json.dumps(payload))
    return str(path)


def test_an_array_of_pages_fails_loudly(tmp_path, monkeypatch):
    """`gh api --paginate --slurp` writes `[[c1, c2]]`, not `[c1, c2]`. That
    passes a top-level list check and then matches no comment at all — dedup
    silently off. Caught on PR #996 by the kimi reviewer this change touches."""
    import run_review

    page = [{"path": "src/trader/x.ts", "line": 2, "side": "RIGHT", "body": "x"}]
    monkeypatch.setenv("EXISTING_COMMENTS_FILE", _write(tmp_path, [page]))

    with pytest.raises(ValueError, match="FLAT array"):
        run_review.load_existing_anchors("nous-kimi")


def test_a_non_array_file_fails_loudly(tmp_path, monkeypatch):
    import run_review

    monkeypatch.setenv("EXISTING_COMMENTS_FILE", _write(tmp_path, {"message": "Not Found"}))

    with pytest.raises(ValueError, match="expected a JSON array"):
        run_review.load_existing_anchors("nous-kimi")


def test_a_flat_array_loads(tmp_path, monkeypatch):
    import run_review

    comments = [
        {
            "path": "src/trader/x.ts",
            "line": 2,
            "side": "RIGHT",
            "body": "prior\n\n" + review_lib.comment_marker("nous-kimi"),
        }
    ]
    monkeypatch.setenv("EXISTING_COMMENTS_FILE", _write(tmp_path, comments))

    assert run_review.load_existing_anchors("nous-kimi") == {("src/trader/x.ts", 2)}


def test_a_missing_file_means_dedup_off_not_an_error(tmp_path, monkeypatch):
    """`workflow_dispatch` writes no file — a deliberate re-review must not be
    muted, and must not crash either."""
    import run_review

    monkeypatch.setenv("EXISTING_COMMENTS_FILE", str(tmp_path / "nope.json"))

    assert run_review.load_existing_anchors("nous-kimi") == set()


def test_no_reviewer_skips_the_file_entirely(tmp_path, monkeypatch):
    import run_review

    monkeypatch.setenv("EXISTING_COMMENTS_FILE", _write(tmp_path, [["bad shape"]]))

    assert run_review.load_existing_anchors(None) == set()


def test_review_diff_threads_reviewer_and_anchors_through():
    """The wiring, not just the leaf: #567's class of defect in this repo is a
    tested mechanism nothing calls."""
    call = lambda **_k: _result([_comment(body="from the model")])  # noqa: E731

    payload = review_lib.review_diff(
        DIFF, ["src/trader/x.ts"], call=call, reviewer="nous-kimi"
    )
    assert payload["comments"][0]["body"].endswith(review_lib.comment_marker("nous-kimi"))

    suppressed = review_lib.review_diff(
        DIFF,
        ["src/trader/x.ts"],
        call=call,
        reviewer="nous-kimi",
        existing_anchors={("src/trader/x.ts", 2)},
    )
    assert suppressed["comments"] == []
