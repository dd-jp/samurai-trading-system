#!/bin/sh
# The last commit that tracks the bar store (#1929); smoke's fixed dates live in it.
set -eu
SNAPSHOT=ff29a7322511ac41c28a814bf3fd5b5ae97601b9
STORE=data/bars/parquet

# rmdir succeeds only on an empty directory, so a store that cannot be listed fails closed;
# git restore would replace a symlink or a file at this path rather than write through it.
if [ -L "$STORE" ] || { [ -e "$STORE" ] && ! rmdir "$STORE" 2>/dev/null; }; then
  echo "bars:snapshot: $STORE exists and is not an empty directory; refusing to overwrite a live store (move it aside, then rerun)" >&2
  exit 1
fi
# A shallow CI checkout lacks the snapshot; GitHub serves a reachable commit by full SHA.
git cat-file -e "$SNAPSHOT^{commit}" 2>/dev/null || git fetch --quiet --depth=1 origin "$SNAPSHOT"
git restore --source="$SNAPSHOT" --worktree -- "$STORE"
echo "bars:snapshot: restored $STORE from $SNAPSHOT ($(find "$STORE" -name '*.parquet' | wc -l | tr -d ' ') files)"
