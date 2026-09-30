#!/bin/sh
# The last commit that tracks the bar store (#1929); smoke's fixed dates live in it.
set -eu
SNAPSHOT=ff29a7322511ac41c28a814bf3fd5b5ae97601b9
STORE=data/bars/parquet

if [ -d "$STORE" ] && [ -n "$(ls -A "$STORE")" ]; then
  echo "bars:snapshot: $STORE is not empty; refusing to overwrite a live store" >&2
  exit 1
fi
# A shallow CI checkout lacks the snapshot; GitHub serves a reachable commit by full SHA.
git cat-file -e "$SNAPSHOT^{commit}" 2>/dev/null || git fetch --quiet --depth=1 origin "$SNAPSHOT"
git restore --source="$SNAPSHOT" --worktree -- "$STORE"
echo "bars:snapshot: restored $STORE from $SNAPSHOT ($(find "$STORE" -name '*.parquet' | wc -l | tr -d ' ') files)"
