import os
import subprocess

from openai import OpenAI

client = OpenAI(
    api_key=os.environ["NOUS_API_KEY"],
    base_url=os.environ["NOUS_BASE_URL"],
)

MAX_DIFF_CHARS = 60000

# Blast-radius tiers, based on this repo's src/ layout and the live-money
# constraints in CLAUDE.md (persistence, order execution, risk management).
HIGH_RISK_PREFIXES = ("src/execution/", "src/risk-manager/", "src/shared/store/")
MEDIUM_RISK_PREFIXES = ("src/orchestrator/", "src/trader/", "src/debate-engine/")

SYSTEM_PROMPT = """\
You are a strict senior reviewer for a live-money multi-agent trading system \
(crypto + stocks). Review the PR diff across exactly these five dimensions, \
in this order, using one markdown section (### heading) per dimension. If a \
dimension has nothing to flag, write "No issues found." under it rather than \
skipping it.

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

End with a one-line overall verdict: APPROVE, APPROVE WITH COMMENTS, or \
REQUEST CHANGES.
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


def get_changed_files() -> list[str]:
    base_ref = os.environ["BASE_REF"]
    result = subprocess.run(
        ["git", "diff", "--name-only", f"origin/{base_ref}...HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    return [line for line in result.stdout.splitlines() if line.strip()]


def main() -> None:
    with open("diff.txt") as f:
        diff = f.read()[:MAX_DIFF_CHARS]

    if not diff.strip():
        output = "_No diff detected — nothing to review._"
    else:
        changed_files = get_changed_files()
        blast_radius_context = classify_blast_radius(changed_files)

        user_content = (
            f"Blast-radius file classification:\n{blast_radius_context}\n\n"
            f"PR diff:\n\n{diff}"
        )

        resp = client.chat.completions.create(
            model=os.environ["NOUS_MODEL"],
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
        )
        output = resp.choices[0].message.content

    with open("review_output.md", "w") as f:
        f.write(output)


if __name__ == "__main__":
    main()
