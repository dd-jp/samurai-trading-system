import json
import os

from review_lib import build_review_payload, call_model, get_changed_files, MAX_DIFF_CHARS


def main() -> None:
    with open("diff.txt") as f:
        diff = f.read()[:MAX_DIFF_CHARS]

    if not diff.strip():
        payload = {
            "summary_markdown": "_No diff detected — nothing to review._",
            "comments": [],
            "event": "COMMENT",
            "verdict": None,
        }
    else:
        changed_files = get_changed_files(os.environ.get("BASE_REF"))
        model_result = call_model(
            diff=diff,
            changed_files=changed_files,
            model=os.environ["REVIEW_MODEL"],
            api_key=os.environ["NOUS_API_KEY"],
            base_url=os.environ["NOUS_BASE_URL"],
            max_tokens=int(os.environ.get("REVIEW_MAX_TOKENS", "8192")),
            inline_only=os.environ.get("REVIEW_INLINE_ONLY", "false").lower() == "true",
        )
        payload = build_review_payload(diff, model_result)

    with open("review_output.json", "w") as f:
        json.dump(payload, f)


if __name__ == "__main__":
    main()
