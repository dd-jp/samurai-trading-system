/**
 * The registry of Market Intelligence archive sources, and what each one's
 * archived ITEMS mean at startup (#835).
 *
 * ## Why this exists
 *
 * `MiIngestAgent.hydrate()` reloads `mi_items` into the in-memory
 * `MarketIntelligenceStore` on every boot, and it used to do so
 * source-agnostically. That is correct for a wire whose items are dated
 * observations ("Benzinga published this at 09:14") and WRONG for a source
 * whose item is a trailing-window statistic: `PolymarketAgent` emits
 * `sign(24h delta)` per curated row, so replaying yesterday's deltas at boot
 * would re-serve a stale measurement as if it were current, and — because
 * `MarketIntelligenceStore.ingest` does no dedup by `id` — would compound the
 * time-axis inflation `polymarket-agent.ts`'s limitation 3 records.
 *
 * Polymarket's answer to that was to archive `write(raws, [])` — raw bytes and
 * no items at all — which bought the boot property by giving up replay: the
 * source could not be replayed as items for offline analysis, and its
 * contribution to `intel` (#1164; `news` before it) vanished on restart with
 * nothing on disk to reconstruct it from. #835 keeps BOTH: the items are
 * archived, and this table is what decides they are not re-ingested at boot.
 *
 * ## Why a Record and not a string comparison
 *
 * `MI_SOURCE_HYDRATION` is a `Record<MiSourceId, MiHydrationPolicy>`, and
 * `RawArchiveRow.source` / `ArchivedItem.source` are typed `MiSourceId` rather
 * than `string`. So a new source cannot write to the archive at all without
 * being added to `MI_SOURCES`, and it cannot be added to `MI_SOURCES` without
 * the Record failing to compile until its boot policy is stated. That is the
 * `AlertChannelSlots` property (`alert-transport.ts`) applied here: the
 * omission is a compile error at the point of omission, not a silent default.
 */

/** Every source id that may appear in the archive's `source` column */
export const MI_SOURCES = {
  /** `MiIngestAgent` — the Alpaca/Benzinga ticker wire */
  alpacaNews: 'alpaca-news',
  /** `GdeltIngestAgent` — the GKG macro batches */
  gdeltGkg: 'gdelt-gkg',
  /** `PolymarketAgent` — the curated macro/event probabilities */
  polymarket: 'polymarket',
  /**
   * `GrokAgent` + `XSearchClient` — scored X posts retrieved through the
   * provider's server-side `x_search` tool (#969).
   *
   * `reddit` is the reserved sibling: #976's access request is with Reddit's
   * App Review, and when it lands it writes the same score-plus-permalink
   * projection into `social` alongside this one. It is NOT registered here
   * yet — an unused source id would compile a hydration policy for something
   * with no writer, which is the placeholder this Record exists to prevent.
   */
  x: 'x',
} as const;

export type MiSourceId = (typeof MI_SOURCES)[keyof typeof MI_SOURCES];

/**
 * What a source's archived items mean at startup.
 *
 * - `hydrate` — the items are dated observations, so replaying everything
 *   knowable now restores exactly what a run that never restarted would hold.
 * - `archive-only` — the items are archived for replay and offline
 *   re-derivation, but must NOT be pushed into the live store at boot.
 */
export type MiHydrationPolicy = 'hydrate' | 'archive-only';

export const MI_SOURCE_HYDRATION: Record<MiSourceId, MiHydrationPolicy> = {
  // Publisher-dated articles with stored scores. A restart that dropped them
  // is the exact defect `hydrate()` was built for (#554)
  [MI_SOURCES.alpacaNews]: 'hydrate',
  // Archive-only twice over: the GKG scoring pass derives AT READ and writes
  // no `mi_items` at all, so there is nothing on disk here to hydrate — and
  // nor should there be, because its 1h-window-vs-24h-baseline score is a
  // trailing statistic in the same sense Polymarket's delta is, and re-serving
  // one at boot would carry the same staleness. This entry is a decision, not
  // a placeholder for "nothing to hydrate": a future writer that started
  // storing these items would still be wrong to replay them
  [MI_SOURCES.gdeltGkg]: 'archive-only',
  // A trailing 24h delta, replayed hourly. Boot re-ingestion would re-serve a
  // stale measurement as current AND compound the time-axis inflation recorded
  // in `polymarket-agent.ts`'s limitation 3. The archived items exist so the
  // source is replayable offline, which is what #835 restored
  [MI_SOURCES.polymarket]: 'archive-only',
  // A post is a DATED OBSERVATION in exactly the sense the `hydrate` policy
  // means: `IntelligenceItem.timestamp` is the post's own publication time
  // (snowflake-decoded from the status id), not the time we fetched it, and
  // not a trailing-window statistic like Polymarket's 24h delta. Replaying
  // yesterday's posts at boot restores what a run that never restarted would
  // hold, and `getContext`'s window filter drops the ones that have aged out
  //
  // Two things make this safe that were NOT true when this file was written
  // First, `MarketIntelligenceStore.ingest` now dedupes by item id (#969), so
  // a replay followed by a live bucket cannot double-count a post — the
  // compounding this file's header warns about. Second, the ids are stable
  // across calls (`x:<statusId>`), which is what gives that dedupe something
  // to match on
  //
  // Note this implies no vendor backfill: `hydrate()` replays `mi_items` from
  // disk. It could not do otherwise here — `x_search` is a live search tool
  // with day-granular dates and no historical fetch path
  [MI_SOURCES.x]: 'hydrate',
};

/**
 * The sources whose archived items `hydrate()` replays into the live store.
 *
 * Derived from the Record rather than listed a second time — there is exactly
 * one place a source's boot policy is stated.
 */
export const HYDRATING_MI_SOURCES: readonly MiSourceId[] = Object.entries(MI_SOURCE_HYDRATION)
  .filter(([, policy]) => policy === 'hydrate')
  .map(([source]) => source as MiSourceId);
