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
