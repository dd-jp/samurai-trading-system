# 73 — Litestream to R2: encryption proof and restore drill (#1784)

**Status 2026-09-27.** Step 3e PR 2. The paper store and the research store now replicate to Cloudflare R2 (doc 66, Litestream target), encrypted with SSE-C, once after every paper cycle. Three live checks against David's bucket, all passed:
1. The data is unreadable without the key.
2. Incremental replication restores the latest state.
3. A deleted store restores exactly, and the next cycle runs the same.

Every drill object was deleted afterwards; the bucket was left empty.

## 1. How it runs

- **Binary.** Litestream **0.5.17**, pinned. Each run checks `litestream version` and refuses any other version. It is installed at `~/.local/bin/litestream` <!-- cite-exempt: untracked — host binary outside the repo --> (binary sha256 `205b4c315d61a7f5709c4ab9001084eadfa8c9d36e1c198f9887417c2d88bb73`, from the release archive whose checksum matched `checksums.txt`). `LITESTREAM_BIN` overrides the path.
- **Schedule.** No daemon and no launchd job. Around each paper cycle, `server/apps/v2/index.ts` does two things:
  - **Before:** it restores any store missing locally from its replica. A lost `data/` directory therefore comes back before the cycle can create an empty store and replicate it over the real history. The first-ever run has no replica and simply proceeds.
  - **After:** once the cycle has closed its store, and before the healthchecks.io ping, it runs `litestream replicate -once`. This happens even when the cycle throws, so a crashed cycle's journal rows still leave the Mac. A failed backup sends the `/fail` ping and exits 1.

  The stores change only when a command writes them, so a backup after each writer is continuous in effect. Dry runs never back up.
- **Before the cycle.** A paper run refuses to start without `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET` and `LITESTREAM_SSE_C_KEY`. The error names the missing variables and nothing else.
- **Config.** `server/apps/v2/backup.ts` writes a fresh config file with mode 0600 into a temporary directory for each run and deletes it afterwards. The file holds only `${VAR}` references, which Litestream expands from the environment, so no secret is ever written to disk.
  - Paths are quoted. The replica root may hold only letters, digits, `_`, `-` and `/`, and a store path containing `$` is refused, since Litestream would expand it.
  - Litestream gets only `PATH`, `HOME` and the five backup variables, not the LLM or broker keys.
  - Its output is scrubbed before it reaches a log or an error: every backup variable's value, plus the endpoint's host and account-id label on their own.
- **Layout.** Replicas live at `v2/paper` and `v2/research` in the bucket. `LITESTREAM_REPLICA_ROOT` moves both; the drills used it to stay out of `v2/`.
- **Research store.** Replicated when it exists (`SAMURAI_RESEARCH_STORE`, else `~/samurai-research/samurai-v2-research.sqlite`), per doc 67's note on Step 3e.
- **Commands outside the cycle.** `npm run v2:capital` and `npm run v2:trials` also write, but they do not back up themselves. The next paper cycle's backup carries their changes, or run `npm run v2:backup` straight after them.
- **Restore.** `npm run v2:restore` restores each store that is missing locally and has a replica, and logs `restored` or `no replica to restore` for each one. It never touches an existing file: present stores are skipped before Litestream is called, and `-if-db-not-exists` backs that up. A store with no replica is skipped (`-if-replica-exists`).
- **Not measured.** How 0.5.17 treats a new database replicated onto a replica path that already holds a higher transaction ID. The restore-before-cycle step keeps a paper run from doing that.

## 2. SSE-C proof

One replicate of a 1,000-row WAL-mode database, then three restores:

| Restore | Result |
|---|---|
| With the key | exit 0, 1,000 rows, last row `row-999` |
| Without a key | exit 1, R2 `400 InvalidRequest`: the object was stored using server-side encryption |
| With a wrong key | exit 1, R2 `403 AccessDenied` |

Neither failed restore wrote an output file. Litestream 0.5.17 does not support age encryption ("age encryption is not currently supported"), so SSE-C is the only encryption layer.

## 3. Incremental replication

Five rounds, each of which opens the database, writes, closes, and runs `replicate -once`. Round 3 also deletes and updates rows.

- Each round added exactly one LTX file: 1 to 5 objects in total, about 35 KB to 145 KB each.
- Restoring after round 5 gave a full `iterdump` identical to the source (8,000 rows).

`-once` does not compact, so a year of daily cycles leaves about 250 small LTX files, and a restore replays all of them. That is acceptable at this size. Revisit it, or add a periodic `-force-snapshot`, if restore time grows.

## 4. Restore drill

Script: `docs/research/73-restore-drill.mts`. It works in a fresh temporary directory and was run twice, before and after the review fixes, with the same results. Run it with `node --env-file=.env.local --import tsx docs/research/73-restore-drill.mts` <!-- cite-exempt: untracked — gitignored local env file -->.

The drill runs four dry-run cycles (2026-09-17 to 2026-09-22, scripted LLM panel, committed bars) on a file store seeded with the 2026 capital year, plus a research store, calling the production `replicateOnce` after each cycle. Then it:
1. Copies the paper store as a control.
2. Deletes both stores, with their `-wal` and `-shm` files.
3. Runs the production `restoreMissing`.

| Check | Result |
|---|---|
| Paper store before deletion | 160 decisions, 35 orders, 240 LLM spend rows |
| Restored paper store, every table and row | identical |
| Restored research store | identical |
| Second restore over the restored files | stores untouched |
| Next cycle (2026-09-23) report, restored vs control | identical (20 decisions) |
| Stores after that cycle | identical apart from random UUIDs, wall-clock `llm_spend.timestamp`, measured `latency_ms`, and Litestream's own `_litestream_seq` |
| Replicate after the restore | succeeds |

## 5. Not covered here

- **"The next cycle reconciles clean against the brokers" (doc 67 Step 3e).** The v2 cycle has no broker reconcile step yet; it arrives with Step 4. The real-broker half of the drill is Step 4b's "Backup restore drill" row.
- **"A skipped cycle raises the healthchecks.io alert."** The check is paused (David, 2026-09-27), and no session pings David's real check. Proving the alert needs David to unpause it.
- **Key custody.** The SSE-C key's only copy is in `.env.local` on the Mac. If the Mac is lost, the replica cannot be decrypted. Where the off-Mac copy lives is David's to supply (doc 66, Litestream target); it is asked on #1784.
