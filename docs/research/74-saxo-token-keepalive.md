# Saxo live token keep-alive (#1876)

Facts behind the keep-alive job, what a Mac sleep costs, and what is still unverified. Written 2026-09-29 while the live chain was dead (last refresh 2026-09-28T20:23Z), so nothing here was re-measured against the live gateway in this session.

## What the OAuth flow does

- The access token lasts about 1200 seconds.
- Every refresh returns a new refresh token that replaces the old one. The old one must be treated as spent: sending it again is a reuse of a rotated token.
- Every refresh response carries `refresh_token_expires_in`, and the window restarts from that response. A refresh while the Mac is awake therefore extends the chain; there is no separate "extend" call.
- Saxo's security guidance says the same (`docs/research/69-v2-facts.md`, q3). The refresh window was measured at 3600 seconds on the live app in an earlier session and not re-measured here. The OAuth example in Saxo's docs shows 2400 seconds, so the job's interval is set against the shorter figure: `StartInterval` 600 gives four attempts inside 2400 seconds.
- Whether Saxo caps the total session age regardless of refreshes is unverified. If it does, `npm run saxo:login` is needed on that cadence and the alert path handles it the same way.

## What sleep costs

launchd does not fire jobs while the Mac sleeps. A sleep longer than the refresh window (40 to 60 minutes) kills the chain, and the first sign is the lost alert after wake, when the first refresh is rejected. Nothing can refresh a chain that has expired; only `npm run saxo:login` recovers it.

`pmset repeat` accepts one event and #1874 needs it for the daily wake, so the keep-alive cannot rely on scheduled wakes. It relies on the Mac not sleeping: `sudo pmset -c sleep 0` on power, and a decision on battery. The existing lid-caffeinate launchd job on David's Mac covers a closed lid. Both are David's admin steps and are not applied by this change.

## Concurrent rotation

The keep-alive, the cycle's `liveTokenSource` and the bar refresh (#1851) all rotate one file. Because a rotated refresh token is spent, two processes must not both send the same one:

- rotation takes an exclusive lock file beside the token file, with a 60 second stale takeover;
- a refresher adopts a newer record already on disk instead of spending its own;
- a 4xx on a refresh token that a peer already replaced adopts the peer's record instead of declaring the session lost.

A stale token can still be sent when the peer's access token has expired before the refresher looks (the adoption check requires a live access token). It recovers through the 4xx path. Whether Saxo revokes the whole chain on reuse of a rotated token is unverified; if it does, that residual window is the risk.

## Unverifiable without a live chain

- a real refresh through the keep-alive job;
- launchd installation and firing;
- real Telegram delivery of the alert;
- whether Saxo caps absolute session age;
- whether Saxo revokes the chain on reuse of a rotated refresh token.
