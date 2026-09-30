# Keys and egress checklist (#1881)

The Step 4b security row (doc 67): broker keys trade-only, withdrawals disabled, IP-restricted where the venue offers it, and a test that no account data or key leaves in any LLM request (doc 66 Q16, `CONTEXT.md` invariant 8). Written 2026-09-29. The test half is automated; the venue half is a checklist only David can tick, because every item is a setting on his accounts.

## The test

`server/apps/v2/egress.test.ts` runs the composed paper root (`composeV2Root` with `rootOptionsFor`, the same wiring `main` uses) over two trading days, US and LSE names both debated, on the real Nous transport chain (`NousPinnedTransport` → `NousMessagesClient` → `nousChat` → global `fetch`). Only `fetch` is stubbed, and it records every request.

Seeded with sentinels:

- the secret-shaped environment variables found by a grep of the server code on 2026-09-29 (Alpaca paper and live key and secret, Saxo SIM and live app keys, secrets and access tokens, Telegram bot token, dashboard token, healthchecks ping URL, Litestream SSE-C key, R2 access key, Polygon, Tiingo, Marketaux, the other Nous keys). A variable added later is not seeded until it is added to the test;
- Saxo SIM and live token files holding sentinel access and refresh tokens;
- the Alpaca account (account number, id, cash, equity, buying power, portfolio value). No v2 code calls `getAccount` today and the fake's `getPositions` returns nothing, so these guard a future reader (for example the reconcile in #1872) rather than a path that runs now;
- the year's start capital and loss cap;
- the broker order identifiers (`alp-1`, the `v2-debate-primary-` client order id prefix);
- the day-1 position as the book holds it on day 2 (quantity in shares, GBP average price, GBP stop).

Pass condition: every request goes to the Nous base URL's chat completions endpoint and nowhere else; no URL or body contains any sentinel; the headers are exactly the content type and `Bearer <debate Nous key>`. Day 2 runs with an open position in the book and still debates that name. The test fails if fewer than three calls per debated name are captured, and asserts a fixture headline reached a prompt, so it cannot pass on an empty capture. Injecting an environment secret into the news view, and separately the held position's quantity, price and stop into a day-2 headline, each turned it red before commit.

Structural backing: `server/apps/v2/boundaries.test.ts` already refuses a `signal/` import of `execution/`, and `DebateSleeveDeps` carries bars, constituents, news and the LLM panel only, so the sleeve that builds prompts has no handle on a broker client or the capital config.

Limits:

- The Alpaca broker client and the news source are injected fakes, so the test does not exercise their own HTTP calls. Neither sends to an LLM.
- The only other v2 Nous caller is the start-up pin check (`server/apps/v2/signal/nous-pin-check.ts`), which sends a models listing request with the key and no body.
- The test attaches at the transport. An LLM client added later that bypasses `NousPinnedTransport` and global `fetch` is not covered. No v2 veto LLM exists yet; when one lands it should reuse the panel.
- The runtime guard (below) matches exact secret values only; account data such as cash, positions and the loss cap is not a secret value and rests on this test.

## The runtime guard

Ruled by David 2026-09-29 and built under #1881: `server/apps/v2/signal/secret-guard.ts`. Before `NousPinnedTransport` sends a chat request, and before the start-up pin check sends its models request, the request's URL, body and headers are checked against every secret the server knows: the environment variables in `SECRET_ENV_NAMES` (the same list this test seeds, asserted equal by the test) and the access and refresh tokens in the Saxo SIM and live token files, re-read on each request because the access token rotates. Values under `MIN_SECRET_LENGTH` (8) are ignored. A value is matched raw, URL-encoded and JSON-escaped. The provider's own key is allowed only in its own `authorization` header. A match is not sent: the transport logs `v2_llm_secret_refused` at error level naming the variable or token file, never the value, and throws an `LlmProviderError` naming it, so the debated name is skipped as `llm_error` like any other LLM failure; the pin check instead refuses the paper run. The transport rebuilds the wire request that `nousChat` sends, so a change to that shape must be mirrored in the transport.

## Venue checklist — David to confirm

Doc 69 R16 found that neither venue documents per-key withdrawal control or IP allow-lists, so "withdrawals disabled, IP-restricted" is a target to confirm per account, not a setting known to exist. Nothing below is ticked; each box is David's.

**Alpaca (paper and live keys)**

- [ ] Crypto trading is not enabled on the account. Crypto-wallet withdrawal is the only API-reachable withdrawal path doc 69 found; fiat withdrawal has no Trading API endpoint.
- [ ] Asked Alpaca whether a Trading API key can be restricted to trading, or have withdrawals disabled; answer recorded.
- [ ] Asked Alpaca whether IP allow-listing exists for Trading API keys; enabled if offered.

**Saxo (OpenAPI app, live GIA)**

- [ ] The app's claims include no write access to cash management (the cash management service: withdrawals, beneficiaries); confirmed with Saxo.
- [ ] Asked Saxo whether IP restriction exists for the OpenAPI app; enabled if offered.

**Both venues**

- [ ] Secrets are held outside the repository. Today they are in the gitignored env file and the gitignored token directory (`data/saxo-tokens/`, mode 0700, files 0600); doc 69 R16 proposed the macOS Keychain instead. <!-- cite-exempt: untracked — gitignored local secrets directory -->
- [ ] No key appears in logs, the journal or an LLM prompt: the test above covers LLM prompts.
- [ ] The rotating Saxo refresh token is written atomically (temp file, fsync, rename): done in code, `server/pipeline/execution/adapters/saxo-token-file.ts`.

## Decisions for David

1. Tick the venue boxes, or record which cannot be done at a venue.
2. ~~R16 found the "trade-only, withdrawals disabled, IP-restricted" line is not documented at either venue. Does the briefing keep it as a requirement, or become "where the venue offers it"?~~ **Ruled 2026-09-29:** "trade-only, withdrawals disabled, IP-restricted where the venue offers it" (doc 66).
3. ~~Does moving the secrets into the Keychain bind the paper start?~~ **Ruled 2026-09-29:** secrets stay in the gitignored env file and token directory for paper and live; no Keychain move.
4. ~~A runtime egress guard in `NousPinnedTransport`: build it, or rest on the test?~~ **Ruled 2026-09-29:** build it; see The runtime guard above.
