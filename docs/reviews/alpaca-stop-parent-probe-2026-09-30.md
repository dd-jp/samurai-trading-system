# Alpaca stop-parent bracket probe (paper), 2026-09-30

Ruling: David, 2026-09-30, on PR #1949's first open question
([#1941 comment](https://github.com/dd-jp/samurai-trading-system/issues/1941)): run one Alpaca **paper** probe of a
`stop` / `stop_limit` bracket parent. If Alpaca accepts it with the legs held, a buy-stop signal
(entry above the last close) enters as a stop parent instead of being refused as `entry_is_buy_stop`.

## Result

**Both parents accepted, legs held, both cancelled.** Alpaca paper took a `bracket` whose parent is
`type=stop`, and one whose parent is `type=stop_limit`. Each came back `pending_new`, then `new`,
with its take-profit (`limit`) and stop-loss (`stop`) legs `held`. Both were cancelled by id
(HTTP 204) and read back `canceled`, legs included. The two open paper orders that existed before the
probe (AAPL, NVDA) were still open afterwards with an unchanged `updated_at`. No other order was
read by id, modified or cancelled.

What was built on it (PR #1949): the `stop_limit` parent, not the plain `stop`. A `stop` parent
becomes a market order when triggered, so a gap through the trigger fills at any price. The gate
sizes 0.5% risk on (limit − stop), so a fill above the limit would break that bound. A `stop_limit`
fill never goes above its limit.

## Caveat: time in force

The probe sent `time_in_force: day`. The v2 executor sends every bracket entry as `gtc`, and gtc was
not probed. Alpaca documents brackets as day or gtc for any parent type, so the risk is small. If paper
ever answers 422 on a gtc stop-limit bracket, the entry is journalled `rejected`, and the date-free
signal order id means a later pass reads it as `already_submitted`: that signal is never retried. The
first real buy-stop signal on paper settles this.

## Method

- Host: `https://paper-api.alpaca.markets`, hard-coded and asserted before any call. Keys:
  `ALPACA_API_KEY` / `ALPACA_API_SECRET` from `.env.local`, the pair the v2 paper path reads. They
  were never printed.
- Paper check: `GET /v2/account` returned 200, account number `PA3…1B` (the `PA` prefix is Alpaca's
  paper numbering; the script stops on anything else), status `ACTIVE`.
- Market open: `GET /v2/clock` gave `is_open: true` at `2026-09-30T11:25:11-04:00`.
- Symbol: F (Ford, S&P 500). No open F order existed; the script stops if one does.
- Last trade (IEX feed): 12.17 at `2026-09-30T15:24:22Z`. Stop price 5% above it: 12.78.
- One run, two submissions (one per parent type), then a cancel of each by id and a read-back.

## Requests and responses (redacted: no keys; account number truncated)

### `type=stop` parent

Request:

```json
{
  "symbol": "F", "side": "buy", "qty": "1", "time_in_force": "day", "order_class": "bracket",
  "client_order_id": "probe-1949-stop-1790781912249",
  "type": "stop", "stop_price": "12.78",
  "take_profit": { "limit_price": "14.60" },
  "stop_loss": { "stop_price": "11.80" }
}
```

Response: HTTP 200, id `508cc33f-b06a-42aa-b727-6c507aa249e2`, `type: stop`, `order_class: bracket`,
`status: pending_new`, `stop_price: 12.78`. Legs:

| Leg id | Type | Side | Status | Price |
|---|---|---|---|---|
| `5c1d9625-d89b-42c8-b356-4824a5f90b76` | limit | sell | held | limit 14.6 |
| `f8fc0106-3c89-4cd5-99ef-5505b9445d95` | stop | sell | held | stop 11.8 |

Read back 1.5 s later: `status: new`, both legs `held`.

### `type=stop_limit` parent

Request: as above with `client_order_id: probe-1949-stop_limit-1790781912249`,
`"type": "stop_limit", "stop_price": "12.78", "limit_price": "12.90"`.

Response: HTTP 200, id `8f68b16c-120d-4173-acfa-e755df9a09b8`, `type: stop_limit`,
`order_class: bracket`, `status: pending_new`, `stop_price: 12.78`, `limit_price: 12.9`. Legs:

| Leg id | Type | Side | Status | Price |
|---|---|---|---|---|
| `2f2d0996-6fb0-4770-b9ea-ab1a841ab9cf` | limit | sell | held | limit 14.6 |
| `dd93e8b6-b284-4704-98f0-a54450ed40fc` | stop | sell | held | stop 11.8 |

Read back: `status: new`, both legs `held`.

### Cancel and verify

| Order | `DELETE /v2/orders/{id}` | Read back |
|---|---|---|
| `508cc33f-…` (stop) | 204 | `canceled`; both legs `canceled` |
| `8f68b16c-…` (stop_limit) | 204 | `canceled`; both legs `canceled` |

Open orders before and after: 2 and 2 (AAPL `bf3ad47a-f958-4976-9c06-bd60df60701b`, NVDA
`d8f01869-9a9a-4263-840d-36523522e6a6`, both `limit`, `new`, `updated_at` unchanged). No probe
order was still open afterwards.

## Script

Run once with `node --env-file=<main checkout>/.env.local probe.mjs F` from a scratch directory
outside the repo. It is recorded here and is not committed as code.

```js
const BASE = 'https://paper-api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';
const SYMBOL = process.argv[2] ?? 'F';

if (new URL(BASE).host !== 'paper-api.alpaca.markets') throw new Error('not the paper host');
const key = process.env.ALPACA_API_KEY;
const secret = process.env.ALPACA_API_SECRET;
if (!key || !secret) throw new Error('ALPACA_API_KEY / ALPACA_API_SECRET not set');
const headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'content-type': 'application/json' };

async function call(method, url, body) {
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

const account = await call('GET', `${BASE}/v2/account`);
if (account.status !== 200) throw new Error(`account check failed: ${account.status}`);
if (!String(account.body.account_number ?? '').startsWith('PA')) throw new Error('not a paper account; stopping');

const before = (await call('GET', `${BASE}/v2/orders?status=open&nested=true&limit=500`)).body;
if (before.some((o) => o.symbol === SYMBOL)) throw new Error(`an open ${SYMBOL} order exists`);

const last = Number((await call('GET', `${DATA}/v2/stocks/${SYMBOL}/trades/latest?feed=iex`)).body?.trade?.p);
const px = (x) => (Math.round(x * 100) / 100).toFixed(2);
const stamp = Date.now();
const created = [];
for (const { name, ...parent } of [
  { name: 'stop', type: 'stop', stop_price: px(last * 1.05) },
  { name: 'stop_limit', type: 'stop_limit', stop_price: px(last * 1.05), limit_price: px(last * 1.06) },
]) {
  const res = await call('POST', `${BASE}/v2/orders`, {
    symbol: SYMBOL, side: 'buy', qty: '1', time_in_force: 'day', order_class: 'bracket',
    client_order_id: `probe-1949-${name}-${stamp}`, ...parent,
    take_profit: { limit_price: px(last * 1.2) }, stop_loss: { stop_price: px(last * 0.97) },
  });
  // record res; on 200 read back GET /v2/orders/{id}?nested=true
  if (res.status === 200) created.push(res.body.id);
}
for (const id of created) await call('DELETE', `${BASE}/v2/orders/${id}`);
// read back each created id, then the open-order list, and compare against `before`
```

The recording and read-back code is left out of the listing above. The full output is summarised in
the tables.
