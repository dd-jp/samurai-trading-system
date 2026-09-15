// Longer Jetstream sample: rate + qualitative check on whether hits are finance-related
const SECONDS = Number(process.argv[2] || 600);
const TICKERS =
  'AAPL AMD AMZN ARM BABA COIN EWY GOOG KWEB META MRNA MSFT MSTR NFLX NIO NVDA PLTR PYPL QQQ RACE SPY TSLA UBER VT XLE XYZ'.split(
    ' ',
  );
const AMBIGUOUS = new Set([
  'ARM',
  'RACE',
  'VT',
  'XYZ',
  'NIO',
  'META',
  'GOOG',
  'COIN',
  'SPY',
  'EWY',
  'UBER',
]);
// Words that suggest an actual markets post rather than incidental use of the word
const FIN =
  /\b(STOCK|STOCKS|SHARES|TICKER|EARNINGS|NASDAQ|NYSE|BULLISH|BEARISH|PORTFOLIO|INVEST|INVESTING|TRADED|TRADING|MARKET CAP|SHORT SELL|CALLS|PUTS|DIVIDEND|VALUATION|SP500|S&P)\b/;

const url = 'wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post';
const ws = new WebSocket(url);

let posts = 0;
let cashtagHits = 0;
let bareHits = 0;
let bareFinHits = 0;
const samples = [];
const byTicker = new Map();
const started = Date.now();

ws.onmessage = (ev) => {
  let d;
  try {
    d = JSON.parse(ev.data);
  } catch {
    return;
  }
  const rec = d?.commit?.record;
  if (d?.commit?.operation !== 'create' || !rec || rec.$type !== 'app.bsky.feed.post') return;
  posts++;
  const text = rec.text || '';
  const upper = text.toUpperCase();
  const fin = FIN.test(upper);
  for (const t of TICKERS) {
    const hasCash = new RegExp('\\$' + t + '\\b').test(upper);
    const hasBare = new RegExp('(?<![A-Z$])' + t + '(?![A-Z])').test(upper);
    if (!hasCash && !hasBare) continue;
    if (hasCash) cashtagHits++;
    if (hasBare) bareHits++;
    if (hasBare && fin) bareFinHits++;
    byTicker.set(t, (byTicker.get(t) || 0) + 1);
    if ((hasCash || fin) && samples.length < 25) {
      samples.push({ t, cash: hasCash, fin, text: text.slice(0, 140).replace(/\n/g, ' ') });
    }
  }
};
ws.onerror = (e) => console.error('WS ERROR', e.message || String(e));

setTimeout(() => {
  const secs = (Date.now() - started) / 1000;
  const perDay = Math.round((posts / secs) * 86400);
  // Rule of three: with k observed in n, 95% upper bound on rate ~ (k+3)/n for small k
  const ub = (k) => ((k + 3) / posts) * perDay;
  console.log(
    JSON.stringify(
      {
        window_utc: [new Date(started).toISOString(), new Date().toISOString()],
        sample_seconds: Math.round(secs),
        posts_observed: posts,
        posts_per_sec: +(posts / secs).toFixed(1),
        est_network_posts_per_day: perDay,
        cashtag_hits: cashtagHits,
        bare_hits: bareHits,
        bare_hits_ALSO_finance_worded: bareFinHits,
        est_cashtag_posts_per_day_95pct_UPPER_BOUND: Math.round(ub(cashtagHits)),
        est_finance_worded_posts_per_day_95pct_UPPER_BOUND: Math.round(ub(bareFinHits)),
        by_ticker: [...byTicker.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}=${v}${AMBIGUOUS.has(k) ? '*' : ''}`)
          .join(' '),
        samples,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}, SECONDS * 1000);
