/**
 * SQLite-backed durable record of a Telegram alert send that exhausted
 * retries (#1108) — see migration 0043 for why this is a dedicated table
 * rather than a row in `audit_log`
 */

import { sanitizeLogText } from '../../shared/sanitize-log-text.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';

export interface AlertDeliveryFailure {
  chat_id: string;
  method: string;
  body: string;
  error: string;
  timestamp: Date;
}

/**
 * How far back `countFailures` looks — #1131: an unbounded-below `COUNT(*)`
 * is monotonic, so one transient failure makes the dashboard tile read
 * "degraded" forever with no way to tell "down now" from "one blip last
 * month". Chosen against the mechanism, not by copying another table's
 * window: a row here is written only when an escalation-chat send exhausts
 * retries, and escalations are event-driven across roughly twenty pipeline
 * channels with no rate floor between them, so the window has to outlast the
 * expected gap between escalations or a live outage's only evidence ages out
 * during a quiet stretch and the tile flickers off while the channel is
 * still dead. 24 hours covers that gap; the price is that a single resolved
 * blip can stay visible for up to a day, which is the deliberate trade
 * against the old "forever" behaviour.
 *
 * Fixed, not env-configurable like the prune retention below: this constant
 * is what the tile MEANS, not a deployment knob about disk — a tile whose
 * meaning shifted with an environment variable would be worse than one whose
 * meaning is fixed and documented.
 */
export const ALERT_DELIVERY_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Default retention for `pruneOlderThan` (#1131) — how long a failure row
 * survives on disk after it has already aged out of the count above.
 *
 * 30 days: long enough to reconstruct an incident from raw rows days after
 * the tile itself has gone quiet, short enough that the table does not grow
 * without bound on a system that runs for years. Env-overridable (deployment
 * disk policy), unlike the fixed count window above.
 */
export const DEFAULT_ALERT_DELIVERY_FAILURE_RETENTION_DAYS = 30;

export class SqliteAlertDeliveryLog {
  constructor(private readonly db: StoreHandle) {}

  /**
   * `body`/`error` are attacker/upstream-influenced free text (an alert's
   * rendered content, a thrown error's message) reaching a durable table
   * outside `formatLogLine`'s central redaction (#1035) — masked here so a
   * misconfigured `baseUrl` that puts the bot token in a `TypeError`'s
   * message (see `classifyTelegramThrown`) cannot leave it on disk.
   *
   * `sanitizeLogText` (mask-then-cap), not a caller-side truncate before this
   * call: `sanitize-log-text.ts` is explicit that truncating before masking
   * can bisect a token mid-string and leave an unmasked remainder that no
   * longer matches the credential patterns — this method is the one place
   * both decisions happen, in the order that avoids that.
   */
  recordFailure(entry: AlertDeliveryFailure): void {
    this.db
      .prepare(
        `INSERT INTO alert_delivery_failures (chat_id, method, body, error, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.chat_id,
        entry.method,
        sanitizeLogText(entry.body),
        sanitizeLogText(entry.error),
        toStoredTimestamp(entry.timestamp),
      );
  }

  /**
   * Permanently-undeliverable alerts recorded FOR `chatId` in the trailing
   * `ALERT_DELIVERY_FAILURE_WINDOW_MS` as of `asOf` — #1108's "count…
   * answerable after the fact", scoped by the third review pass's finding:
   * `alert_delivery_failures` holds rows for every chat a send targeted,
   * heartbeat included (#342's isolation only stops a heartbeat failure from
   * advancing or triggering the escalation-chat alert in
   * `telegram-bot-api-client.ts` — it does not stop the row being written
   * here). An unfiltered `COUNT(*)` would answer "how many sends failed
   * anywhere", not "is the alert channel down", so `chatId` is a required
   * parameter rather than a default: the caller (the one place that knows
   * which chat IS the alert/escalation channel) must say so explicitly, the
   * same way `getMarks`/`getFillsForTrades` take their scope as a parameter
   * rather than this store inventing one.
   *
   * WHICH END IS OPEN (#1313). The window is half-open —
   * `(asOf - ALERT_DELIVERY_FAILURE_WINDOW_MS, asOf]`. A row stamped at
   * exactly the lower edge is NOT counted; one stamped at exactly `asOf` is.
   * Stated because nothing else in the shape says it: the constant names a
   * duration, not an inclusivity, and both edges are pinned by their own
   * cases in `alert-delivery-log.test.ts` rather than only by rows a
   * millisecond either side. `pruneOlderThan` below deletes strictly older
   * than its cutoff, so a row at the cutoff instant survives there too.
   *
   * WINDOWED, NOT ALL-TIME (#1131). The old unfiltered-below query made a
   * single transient failure read as "degraded" forever with no way to tell
   * it apart from a live outage. Bounding below by
   * `ALERT_DELIVERY_FAILURE_WINDOW_MS` makes the count self-clear once the
   * channel has been quiet for a day, so a nonzero answer is close to "still
   * failing recently" rather than "failed at some point in this table's
   * history".
   *
   * WHAT A ZERO DOES NOT PROVE. A row is written only when a send is
   * attempted AND exhausts retries — no attempt means no row, windowed or
   * not. A quiet system with nothing worth escalating produces zero rows
   * from a channel that may in fact be completely dead, because nothing has
   * tried to use it recently. Zero here means "no failed attempt observed in
   * the last day", not "the channel is confirmed reachable" — the same gap
   * `types.ts`'s `getAlertDeliveryFailureCount` doc enumerates alongside the
   * log-only and chat-mismatch readings of a zero/absent tile.
   */
  countFailures(asOf: Date, chatId: string): number {
    const windowStart = new Date(asOf.getTime() - ALERT_DELIVERY_FAILURE_WINDOW_MS);
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM alert_delivery_failures ' +
          'WHERE timestamp > ? AND timestamp <= ? AND chat_id = ?',
      )
      .get(toStoredTimestamp(windowStart), toStoredTimestamp(asOf), chatId) as { n: number };
    return row.n;
  }

  /**
   * Deletes rows older than `cutoff`. Returns how many were removed, so a
   * caller can log a prune that took a meaningful number of rows rather than
   * letting it happen silently — the same contract as
   * `MiArchiveStore.purgeOlderThan`, which this mirrors.
   *
   * Age-based, not a row ceiling like `pruneLlmCallLog`: this table has no
   * `id`/PK column to support that pattern's offset-based delete (migration
   * 0043 leaves it off deliberately, "nothing here is looked up by row
   * identity"), and its growth tracks outage/event frequency rather than a
   * debate/tick cadence, so a day window bounds it correctly rather than
   * under- or over-shooting the way it would for a cadence-bound table.
   *
   * `cutoff` should be chosen so `pruneOlderThan` does not remove a row
   * still inside `countFailures`'s window. Nothing here can enforce that:
   * this method sees only the cutoff it is handed, and never the window the
   * cutoff has to clear.
   * `alertDeliveryFailureRetentionDaysFromEnvironment` in `production.ts`
   * refuses a retention below 2 days for that reason — its doc carries the
   * full argument, including which reading of that risk the floor is
   * actually sized against and which one is not.
   */
  pruneOlderThan(cutoff: Date): number {
    return this.db
      .prepare('DELETE FROM alert_delivery_failures WHERE timestamp < ?')
      .run(toStoredTimestamp(cutoff)).changes;
  }
}
