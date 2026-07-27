import os

from openai import OpenAI

client = OpenAI(
    api_key=os.environ["NOUS_API_KEY"],
    base_url=os.environ["NOUS_BASE_URL"],
)

MAX_DIFF_CHARS = 60000


def main() -> None:
    with open("diff.txt") as f:
        diff = f.read()[:MAX_DIFF_CHARS]

    if not diff.strip():
        output = "_No diff detected — nothing to review._"
    else:
        resp = client.chat.completions.create(
            model=os.environ["NOUS_MODEL"],
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a strict senior code reviewer. Review the diff for "
                        "bugs, security issues, and correctness problems only. Be "
                        "concise. Use markdown with file/line references where "
                        "possible."
                    ),
                },
                {"role": "user", "content": f"Review this PR diff:\n\n{diff}"},
            ],
        )
        output = resp.choices[0].message.content

    with open("review_output.md", "w") as f:
        f.write(output)


if __name__ == "__main__":
    main()
