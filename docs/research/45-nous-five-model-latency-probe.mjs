import { readFileSync } from 'node:fs';

function loadEnvValue(envFilePath, key) {
  const text = readFileSync(envFilePath, 'utf8');
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  const match = text.match(re);
  if (!match) return undefined;
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

const ENV_FILE = '/Users/ddjp/Documents/projects/samurai-trading-system/.env.local';
const BASE_URL = process.env.NOUS_BASE_URL || loadEnvValue(ENV_FILE, 'NOUS_BASE_URL');
const API_KEY = process.env.NOUS_DEBATE_API_KEY || loadEnvValue(ENV_FILE, 'NOUS_DEBATE_API_KEY');

if (!BASE_URL || !API_KEY) {
  console.error('Missing NOUS_BASE_URL or NOUS_DEBATE_API_KEY in environment (values not shown).');
  process.exit(1);
}

const MODELS = [
  { id: 'anthropic/claude-haiku-4.5', priceIn: 1.0, priceOut: 5.0 },
  { id: 'deepseek/deepseek-v4-flash-0731', priceIn: 0.04, priceOut: 0.1 },
  { id: 'google/gemini-3.8-flash', priceIn: 0.75, priceOut: 3.75 },
  { id: 'z-ai/glm-5.3-flash', priceIn: 0.07, priceOut: 0.25 },
  { id: 'qwen/qwen3.8-flash', priceIn: 0.15, priceOut: 0.47 },
  { id: 'openai/gpt-5.4-mini', priceIn: 0.75, priceOut: 4.5 },
];

const MAX_SPEND_USD = 0.25;
const TIMEOUT_MS = 45_000;
const MAX_TOKENS = 300;

const SYSTEM_PROMPT = `You are the Trader agent in a multi-agent equities debate pipeline. You are given the views of three analysts (Fundamental, Technical, Sentiment) on a single LSE-listed leveraged ETP, plus recent market context. Weigh the three views, resolve disagreement, and output STRICT JSON only, matching exactly this shape:
{"stance": "long" | "short" | "flat", "rationale": string, "confidence": number between 0 and 1}
Do not include any text outside the JSON object. Do not use markdown code fences.`;

function buildFillerBars(lineCount) {
  const lines = [];
  let price = 123.45;
  for (let i = 0; i < lineCount; i++) {
    const t = new Date(Date.UTC(2026, 8, 10, 9, 0, 0) + i * 60_000).toISOString();
    const o = price;
    const h = price + Math.random() * 0.3;
    const l = price - Math.random() * 0.3;
    const c = price + (Math.random() - 0.5) * 0.2;
    const v = 8000 + Math.floor(Math.random() * 5000);
    const rsi = (40 + Math.random() * 20).toFixed(1);
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

async function callOnce(modelId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();
  let status = null;
  let usage = null;
  let jsonValid = false;
  let errorMsg = null;
  try {
    const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: USER_PROMPT },
        ],
      }),
      signal: controller.signal,
    });
    status = res.status;
    const bodyText = await res.text();
    if (res.ok) {
      let parsed;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = null;
      }
      if (parsed) {
        usage = parsed.usage || null;
        const content = parsed.choices?.[0]?.message?.content ?? '';
        try {
          const asJson = JSON.parse(stripFences(content));
          jsonValid =
            typeof asJson === 'object' &&
            asJson !== null &&
            'stance' in asJson &&
            'rationale' in asJson &&
            'confidence' in asJson;
        } catch {
          jsonValid = false;
        }
      }
    } else {
      errorMsg = bodyText.slice(0, 300);
    }
  } catch (err) {
    errorMsg = err.name === 'AbortError' ? 'timeout' : String(err.message || err);
  } finally {
    clearTimeout(timer);
  }
  const wallMs = performance.now() - start;
  return { modelId, wallMs, status, usage, jsonValid, errorMsg };
}

function stripFences(s) {
  const trimmed = s.trim();
  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```[a-zA-Z]*\n?/, '')
      .replace(/```$/, '')
      .trim();
  }
  return trimmed;
}

function estCost(usage, priceIn, priceOut) {
  if (!usage) return 0;
  const pIn = ((usage.prompt_tokens || 0) / 1_000_000) * priceIn;
  const pOut = ((usage.completion_tokens || 0) / 1_000_000) * priceOut;
  return pIn + pOut;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function stats(calls) {
  const ok = calls.filter((c) => c.status === 200);
  const latencies = ok.map((c) => c.wallMs).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const max = latencies.length ? Math.max(...latencies) : null;
  const jsonValidRate = ok.length ? ok.filter((c) => c.jsonValid).length / ok.length : null;
  return { attempted: calls.length, ok: ok.length, p50, max, jsonValidRate };
}

let totalSpend = 0;

async function run() {
  const results = [];
  for (const model of MODELS) {
    if (totalSpend >= MAX_SPEND_USD) {
      results.push({ model: model.id, skippedBudget: true });
      continue;
    }
    process.stderr.write(`\n=== ${model.id} ===\n`);
    const seqCalls = [];
    for (let i = 0; i < 3; i++) {
      const r = await callOnce(model.id);
      const cost = estCost(r.usage, model.priceIn, model.priceOut);
      totalSpend += cost;
      seqCalls.push(r);
      process.stderr.write(
        `  seq[${i}] status=${r.status ?? 'ERR'} ms=${r.wallMs.toFixed(0)} jsonValid=${r.jsonValid} err=${r.errorMsg ?? ''}\n`,
      );
    }
    const allSeqFailed = seqCalls.every((c) => c.status !== 200);
    let burstCalls = [];
    if (!allSeqFailed && totalSpend < MAX_SPEND_USD) {
      const burstPromises = Array.from({ length: 4 }, () => callOnce(model.id));
      burstCalls = await Promise.all(burstPromises);
      for (const r of burstCalls) {
        const cost = estCost(r.usage, model.priceIn, model.priceOut);
        totalSpend += cost;
        process.stderr.write(
          `  burst status=${r.status ?? 'ERR'} ms=${r.wallMs.toFixed(0)} jsonValid=${r.jsonValid} err=${r.errorMsg ?? ''}\n`,
        );
      }
    } else if (allSeqFailed) {
      process.stderr.write('  all sequential calls failed, skipping burst\n');
    }

    const seqStats = stats(seqCalls);
    const burstStats = stats(burstCalls);
    const allOkCalls = [...seqCalls, ...burstCalls].filter((c) => c.status === 200);
    const modelSpend = allOkCalls.reduce(
      (sum, c) => sum + estCost(c.usage, model.priceIn, model.priceOut),
      0,
    );
    const avgCostPerCall = allOkCalls.length ? modelSpend / allOkCalls.length : null;

    results.push({
      model: model.id,
      allSeqFailed,
      burstSkipped: allSeqFailed || burstCalls.length === 0,
      seqStats,
      burstStats,
      avgCostPerCall,
      modelSpend,
      sampleUsage: allOkCalls[0]?.usage ?? null,
      errors: [...seqCalls, ...burstCalls]
        .filter((c) => c.status !== 200)
        .map((c) => ({ status: c.status, err: c.errorMsg })),
    });
    process.stderr.write(`  running total spend: $${totalSpend.toFixed(4)}\n`);
  }
  process.stderr.write(`\nTOTAL PROBE SPEND: $${totalSpend.toFixed(4)}\n`);
  console.log(JSON.stringify({ results, totalSpend }, null, 2));
}

run().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
