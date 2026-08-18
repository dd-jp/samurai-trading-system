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
 * contribution to the `news` bucket vanished on restart with nothing on disk
 * to reconstruct it from. #835 keeps BOTH: the items are archived, and this
 * table is what decides they are not re-ingested at boot.
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

/** Every source id that may appear in the archive's `source` column. */
export const MI_SOURCES = {
  /** `MiIngestAgent` — the Alpaca/Benzinga ticker wire. */
  alpacaNews: 'alpaca-news',
  /** `GdeltIngestAgent` — the GKG macro batches. */
  gdeltGkg: 'gdelt-gkg',
  /** `PolymarketAgent` — the curated macro/event probabilities. */
  polymarket: 'polymarket',
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
  // is the exact defect `hydrate()` was built for (#554).
  [MI_SOURCES.alpacaNews]: 'hydrate',
  // Archive-only for a second reason as well as this one: the GKG scoring half
  // is deliberately unbuilt (`market-intelligence-spec.md`, "BUILT: the archive
  // half"), so this source writes no `mi_items` at all today. When the scoring
  // pass lands, its 1h-window-vs-24h-baseline score is a trailing statistic in
  // the same sense Polymarket's delta is, and re-serving it at boot would carry
  // the same staleness — so this entry is a decision, not a placeholder for
  // "nothing to hydrate".
  [MI_SOURCES.gdeltGkg]: 'archive-only',
  // A trailing 24h delta, replayed hourly. Boot re-ingestion would re-serve a
  // stale measurement as current AND compound the time-axis inflation recorded
  // in `polymarket-agent.ts`'s limitation 3. The archived items exist so the
  // source is replayable offline, which is what #835 restored.
  [MI_SOURCES.polymarket]: 'archive-only',
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
