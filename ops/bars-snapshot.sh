#!/bin/sh
# The last commit that tracks the bar store (#1929); smoke's fixed dates live in it.
set -eu
SNAPSHOT=ff29a7322511ac41c28a814bf3fd5b5ae97601b9
STORE=data/bars/parquet
FX=data/bars/fx/gbpusd-boe-xudluss.csv
FX_SNAPSHOT=data/bars/fx/gbpusd-boe-xudluss.snapshot.csv

# The live FX file is seeded only when absent, so a store refusal below never costs its rows.
if [ ! -e "$FX" ] && [ ! -L "$FX" ]; then
  cp "$FX_SNAPSHOT" "$FX"
  echo "bars:snapshot: seeded $FX from $FX_SNAPSHOT"
fi

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
