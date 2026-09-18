
const MODEL = 'anthropic/claude-haiku-4.5';
const TIMEOUT_MS = 45_000;
const MAX_TOKENS = 300;
const SEQUENTIAL_CALLS = 5;
const BURST_CALLS = 3;
const HEADERS_ONLY = process.argv.includes('--headers-only');
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie']);

const BASE_URL = process.env.NOUS_BASE_URL;
const API_KEY = process.env.NOUS_DEBATE_API_KEY;

if (!BASE_URL) {
  console.error('Missing NOUS_BASE_URL in process.env (value not shown).');
  process.exit(1);
}
if (!API_KEY) {
  console.error('Missing NOUS_DEBATE_API_KEY in process.env (value not shown).');
  process.exit(1);
}
process.stderr.write(
  `NOUS_BASE_URL present (len=${BASE_URL.length}), NOUS_DEBATE_API_KEY present (len=${API_KEY.length}).\n`,
);

const SYSTEM_PROMPT = `You are the Trader agent in a multi-agent equities debate pipeline. You are given the views of three analysts (Fundamental, Technical, Sentiment) on a single LSE-listed leveraged ETP, plus recent market context. Weigh the three views, resolve disagreement, and output STRICT JSON only, matching exactly this shape:
{"stance": "long" | "short" | "flat", "rationale": string, "confidence": number between 0 and 1}
Do not include any text outside the JSON object. Do not use markdown code fences.`;

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildFillerBars(lineCount) {
  const rand = mulberry32(1023);
  const lines = [];
  let price = 123.45;
  for (let i = 0; i < lineCount; i++) {
    const t = new Date(Date.UTC(2026, 8, 10, 9, 0, 0) + i * 60_000).toISOString();
    const o = price;
    const h = price + rand() * 0.3;
    const l = price - rand() * 0.3;
    const c = price + (rand() - 0.5) * 0.2;
    const v = 8000 + Math.floor(rand() * 5000);
    const rsi = (40 + rand() * 20).toFixed(1);
    const ema20 = (price - 0.3).toFixed(2);
    const ema50 = (price - 0.6).toFixed(2);
    lines.push(
      `Bar ${t} O:${o.toFixed(2)} H:${h.toFixed(2)} L:${l.toFixed(2)} C:${c.toFixed(2)} V:${v} RSI14:${rsi} EMA20:${ema20} EMA50:${ema50}`,
    );
    price = c;
  }
  return lines.join('\n');
}

const ANALYST_VIEWS = `Fundamental analyst: Underlying index constituents show broad-based earnings beats this quarter (68% beat rate vs 62% trailing average), but forward guidance is mixed and two large-cap constituents flagged margin compression from input costs. Macro backdrop: rates on hold, no scheduled central bank decisions in the next 48 hours. Net read: mildly constructive, low conviction.

Technical analyst: Price is consolidating just above the 20-period EMA after a failed breakout attempt two sessions ago. RSI14 is range-bound between 45 and 58, no clear momentum signal. Volume on the last three up-bars is below the 20-bar average, suggesting weak buying pressure. A break below the prior session low would open a retest of the EMA50. Net read: neutral to mildly bearish, wait for confirmation.

Sentiment analyst: News flow is quiet, no material headlines in the last 24 hours for this name or its sector. Social mention volume is at its 30-day median, tone slightly positive but low-signal. No scheduled catalysts (earnings, macro prints) inside the current session. Net read: neutral, low information content.`;

function buildUserPrompt() {
  const filler = buildFillerBars(44);
  return `${ANALYST_VIEWS}\n\nRecent 1-minute bar context (most recent last):\n${filler}\n\nGiven the three analyst views and the bar context above, resolve to a single stance for the current session. Respond with the JSON object only.`;
}

const USER_PROMPT = buildUserPrompt();

function applySseEvent(rawEvent, dispatchedAt, state) {
  for (const line of rawEvent.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    state.chunkCount++;
    try {
      const parsed = JSON.parse(payload);
      const delta = parsed.choices?.[0]?.delta;
      const fr = parsed.choices?.[0]?.finish_reason;
      if (fr) state.finishReason = fr;
      if (delta?.content) {
        state.contentLength += delta.content.length;
        if (state.ttftMs === null) state.ttftMs = performance.now() - dispatchedAt;
      }
    } catch {
    }
  }
}

async function readSseBody(res, dispatchedAt) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const state = { chunkCount: 0, contentLength: 0, finishReason: null, ttftMs: null };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (let idx = buf.indexOf('\n\n'); idx !== -1; idx = buf.indexOf('\n\n')) {
      const rawEvent = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      applySseEvent(rawEvent, dispatchedAt, state);
    }
  }
  return state;
}

async function callOnceStreaming() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const dispatchedAt = performance.now();
  let ttfbMs = null;
  let ttftMs = null;
  let totalMs = null;
  let status = null;
  let chunkCount = 0;
  let contentLength = 0;
  let errorMsg = null;
  let finishReason = null;

  try {
    const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: MAX_TOKENS,
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: USER_PROMPT },
        ],
      }),
      signal: controller.signal,
    });
    status = res.status;
    ttfbMs = performance.now() - dispatchedAt;

    if (!res.ok) {
      errorMsg = (await res.text()).slice(0, 300);
    } else if (!res.body) {
      errorMsg = 'response ok but no readable body (non-streaming fallback?)';
    } else {
      const streamed = await readSseBody(res, dispatchedAt);
      chunkCount = streamed.chunkCount;
      contentLength = streamed.contentLength;
      finishReason = streamed.finishReason;
      ttftMs = streamed.ttftMs;
      totalMs = performance.now() - dispatchedAt;
    }
  } catch (err) {
    errorMsg = err.name === 'AbortError' ? 'timeout' : String(err.message || err);
    totalMs = performance.now() - dispatchedAt;
  } finally {
    clearTimeout(timer);
  }

  return { status, ttfbMs, ttftMs, totalMs, chunkCount, contentLength, finishReason, errorMsg };
}

function summarize(label, calls) {
  const ok = calls.filter((c) => c.status === 200 && c.ttftMs !== null);
  const ttft = ok.map((c) => c.ttftMs).sort((a, b) => a - b);
  const total = ok.map((c) => c.totalMs).sort((a, b) => a - b);
  const ttfb = ok.map((c) => c.ttfbMs).sort((a, b) => a - b);
  const genOnly = ok.map((c) => c.totalMs - c.ttftMs).sort((a, b) => a - b);
  return {
    label,
    n: calls.length,
    ok: ok.length,
    ttfb_ms: ttfb,
    ttft_ms: ttft,
    total_ms: total,
    generation_only_ms: genOnly,
  };
}

async function probeResponseHeaders() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: USER_PROMPT },
        ],
      }),
      signal: controller.signal,
    });
    await res.text();
    const headerEntries = [];
    for (const [name, value] of res.headers.entries()) {
      headerEntries.push([name, SENSITIVE_HEADERS.has(name.toLowerCase()) ? '[redacted]' : value]);
    }
    return { status: res.status, headers: headerEntries };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (HEADERS_ONLY) {
    const result = await probeResponseHeaders();
    for (const [name, value] of result.headers) {
      process.stderr.write(`  ${name}: ${value}\n`);
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const sequential = [];
  process.stderr.write(`\n=== sequential (n=${SEQUENTIAL_CALLS}, concurrency 1) ===\n`);
  for (let i = 0; i < SEQUENTIAL_CALLS; i++) {
    const r = await callOnceStreaming();
    sequential.push(r);
    process.stderr.write(
      `  seq[${i}] status=${r.status ?? 'ERR'} ttfb=${r.ttfbMs?.toFixed(0)}ms ttft=${r.ttftMs?.toFixed(0)}ms total=${r.totalMs?.toFixed(0)}ms chunks=${r.chunkCount} err=${r.errorMsg ?? ''}\n`,
    );
  }

  process.stderr.write(`\n=== burst (n=${BURST_CALLS}, concurrent) ===\n`);
  const burst = await Promise.all(Array.from({ length: BURST_CALLS }, () => callOnceStreaming()));
  for (const r of burst) {
    process.stderr.write(
      `  burst status=${r.status ?? 'ERR'} ttfb=${r.ttfbMs?.toFixed(0)}ms ttft=${r.ttftMs?.toFixed(0)}ms total=${r.totalMs?.toFixed(0)}ms chunks=${r.chunkCount} err=${r.errorMsg ?? ''}\n`,
    );
  }

  const summary = {
    sequential: summarize('sequential (concurrency 1)', sequential),
    burst: summarize('burst (concurrency 3)', burst),
  };

  console.log(JSON.stringify({ raw: { sequential, burst }, summary }, null, 2));
}

main().catch((err) => {
  console.error('streaming probe failed:', err?.message ? err.message : String(err));
  process.exit(1);
});
