/**
 * Prefixes the `key_points` entry an analyst emits when its intelligence
 * window is empty (#436).
 *
 * `MarketIntelligenceStore` has no writer in production, so `sentiment` and
 * `fundamental` see zero items on EVERY tick. The old wording — "0 social
 * items in window, net sentiment driving neutral" — is indistinguishable in a
 * debate transcript, or in a 14-day soak's own output, from "the analyst
 * looked and saw nothing bullish". It never looked.
 *
 * Greppable on purpose: a soak's transcripts should be filterable for "which
 * debates ran without this input at all" without parsing prose.
 */
export const NO_DATA_MARKER = 'NO DATA';
