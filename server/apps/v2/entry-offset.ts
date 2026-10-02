export const CLOSE_LEGS_SQL = `leg NOT IN ('entry', 'cash_in_lieu')`;

export interface CloseAnchor {
  readonly bookId: string;
  readonly instrument: string;
  readonly orderId: string;
  readonly at: string;
}

// David ruled 2026-09-30 on #1815: the paper sample splits at the offset change. A bracket leg
// shares its entry's order id, so a close takes that entry; any other close takes the latest
// entry fill on its book and instrument before it. SQL expressions in, the entry's order payload out
export function entryPayloadOfClose(close: CloseAnchor): string {
  return `(SELECT eo.payload FROM v2_fills e JOIN v2_orders eo ON eo.client_order_id = e.client_order_id
            WHERE e.book_id = ${close.bookId} AND e.instrument = ${close.instrument}
              AND e.leg = 'entry' AND e.rowid < ${close.at}
            ORDER BY e.client_order_id = ${close.orderId} DESC, e.rowid DESC LIMIT 1)`;
}

// An entry journalled before the tag carries no limit: it went out at 0 bps; one with a limit and
// no offset had its limit set by its sleeve (NULL, as is a close with no entry in the journal)
export function entryOffsetOfPayload(payload: string): string {
  return `CASE WHEN ${payload} IS NULL THEN NULL ELSE
            COALESCE(json_extract(${payload}, '$.entry_offset_bps'),
                     CASE WHEN json_extract(${payload}, '$.limit') IS NULL THEN 0 END) END`;
}
