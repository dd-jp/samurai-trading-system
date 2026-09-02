import json
import os
import sys

from review_lib import (
    changed_files_from_diff,
    existing_comment_anchors,
    get_changed_files,
    read_capped_diff,
    review_diff,
)


def load_existing_anchors(reviewer: str | None) -> set[tuple[str, int]]:
    """Lines this reviewer already commented on, from the file the workflow
    fetched before the review ran.

    Absent file means dedup is OFF for this run, and that is the intended
    state on `workflow_dispatch`: a manual re-review is a deliberate "look
    again" (the trigger exists for #594's merged-PR case), so suppressing its
    findings against the very review it was asked to redo would hand back an
    empty review and make the escape hatch useless.

    A malformed file is NOT swallowed into "no anchors": that would silently
    restore the duplicate-comment behaviour this exists to stop, and read as
    a working dedup from the outside."""
    path = os.environ.get("EXISTING_COMMENTS_FILE")
    if not reviewer or not path or not os.path.exists(path):
        return set()
    with open(path) as f:
        comments = json.load(f)
    if not isinstance(comments, list):
        raise ValueError(
            f"{path}: expected a JSON array of PR review comments, got {type(comments).__name__}"
        )
    # The ELEMENT check matters as much as the top-level one. `gh api
    # --paginate --slurp` writes an array of PAGES (`[[c1, c2]]`), which
    # passes a list check and then matches no comment at all — dedup off,
    # nothing said. Anything that is not a flat array of comment objects is a
    # bug in the fetch step, and must fail the job rather than degrade to
    # "nothing was flagged before".
    bad = next((c for c in comments if not isinstance(c, dict)), None)
    if bad is not None:
        raise ValueError(
            f"{path}: expected a FLAT array of PR review comment objects, but an element "
            f"is {type(bad).__name__} — an array of pages (gh's --slurp) reads as a valid "
            "list here and would silently disable dedup"
        )
    return existing_comment_anchors(comments, reviewer)


def main() -> None:
    # NOT truncated. The diff is sliced inside review_diff and every slice is
    # reviewed; whatever still can't be covered is disclosed in the posted
    # summary and blocks an APPROVE (#594). `read_capped_diff` bounds what is
    # read into memory at all so a huge PR can't OOM the runner — it cuts on a
    # file boundary and names every dropped file in `oversize`, which flows
    # into the same disclosure banner.
    diff, oversize = read_capped_diff("diff.txt")

    base_ref = os.environ.get("BASE_REF")
    # workflow_dispatch has no github.base_ref, so the `origin/<base>...HEAD`
    # range doesn't resolve; read the file list out of the diff instead.
    #
    # `get_changed_files` can return None when git fails. That None is passed
    # STRAIGHT THROUGH — never defaulted to [] — because review_diff needs to
    # tell "no files missing" from "we could not check", and only the second
    # of those belongs in the disclosure banner.
    changed_files = get_changed_files(base_ref) if base_ref else changed_files_from_diff(diff)

    reviewer = os.environ.get("REVIEWER") or None
    anchors = load_existing_anchors(reviewer)
    if anchors:
        print(f"info: {len(anchors)} line(s) already flagged by {reviewer} on this PR", file=sys.stderr)

    payload = review_diff(
        diff,
        changed_files,
        extra_skipped=oversize,
        reviewer=reviewer,
        existing_anchors=anchors,
        model=os.environ["REVIEW_MODEL"],
        api_key=os.environ["NOUS_API_KEY"],
        base_url=os.environ["NOUS_BASE_URL"],
        max_tokens=int(os.environ.get("REVIEW_MAX_TOKENS") or "8192"),
        inline_only=(os.environ.get("REVIEW_INLINE_ONLY") or "false").lower() == "true",
    )

    with open("review_output.json", "w") as f:
        json.dump(payload, f)


if __name__ == "__main__":
    main()
