import json
import os

from review_lib import (
    changed_files_from_diff,
    get_changed_files,
    read_capped_diff,
    review_diff,
)


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

    payload = review_diff(
        diff,
        changed_files,
        extra_skipped=oversize,
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
