# Saxo live token keep-alive (#1876)

Facts behind the keep-alive job, what a Mac sleep costs, and what is still unverified. Written 2026-09-29 while the live chain was dead (last refresh 2026-09-28T20:23Z), so the sections other than "Verified at install" were not re-measured against the live gateway in that session. The install measurements are recorded in "Verified at install" below.

## What the OAuth flow does

- The access token lasts about 1200 seconds.
- Every refresh returns a new refresh token that replaces the old one. The old one must be treated as spent: sending it again is a reuse of a rotated token.
- Every refresh response carries `refresh_token_expires_in`, and the window restarts from that response. A refresh while the Mac is awake therefore extends the chain; there is no separate "extend" call.
- Saxo's security guidance says the same (`docs/research/69-v2-facts.md`, q3). The refresh window was measured at 3600 seconds on the live app in an earlier session, and again on 2026-09-29 (see "Verified at install"). The OAuth example in Saxo's docs shows 2400 seconds, so the job's interval is set against the shorter figure: `StartInterval` 600 gives four attempts inside 2400 seconds.
- Whether Saxo caps the total session age regardless of refreshes is unverified beyond the roughly 18 hours observed at install (see "Verified at install"). If it does, `npm run saxo:login` is needed on that cadence and the alert path handles it the same way.

## What sleep costs

launchd does not fire jobs while the Mac sleeps. A sleep longer than the refresh window (40 to 60 minutes) kills the chain, and the first sign is the lost alert after wake, when the first refresh is rejected. Nothing can refresh a chain that has expired; only `npm run saxo:login` recovers it.

`pmset repeat` accepts one event and #1874 needs it for the daily wake, so the keep-alive cannot rely on scheduled wakes. It relies on the Mac not sleeping: `sudo pmset -c sleep 0` on power, and a decision on battery. The existing lid-caffeinate launchd job on David's Mac covers a closed lid. Both are David's admin steps and are not applied by this change.

## Concurrent rotation

The keep-alive, the cycle's `liveTokenSource` and the bar refresh (#1851) all rotate one file. Because a rotated refresh token is spent, two processes must not both send the same one:

- rotation takes an exclusive lock file beside the token file, with a 60 second stale takeover;
- a refresher adopts a newer record already on disk instead of spending its own;
- a 4xx on a refresh token that a peer already replaced adopts the peer's record instead of declaring the session lost.

A stale token can still be sent when the peer's access token has expired before the refresher looks (the adoption check requires a live access token). It recovers through the 4xx path. Whether Saxo revokes the whole chain on reuse of a rotated token is unverified, and no reuse was provoked at install; if it does, that residual window is the risk.

## Verified at install

Source: the comments on [#1908](https://github.com/dd-jp/samurai-trading-system/issues/1908). The comments report these results without raw logs, so they are recorded as reported.

2026-09-29 ([comment](https://github.com/dd-jp/samurai-trading-system/issues/1908#issuecomment-5893236088)), live Saxo:

- The keep-alive's `main()` ran against the real live token file through a wrapper with an explicit token path: exit 0, refreshed.
- `refreshTokenExpiresAt` moved to `obtainedAt` + 60 minutes, measured twice (15:48 to 16:11 to 16:22, times as reported), so each refresh extends the chain.
- This run did not go through the script's entrypoint, `npm run saxo:keepalive` or the plist.

2026-09-30 ([comment](https://github.com/dd-jp/samurai-trading-system/issues/1908#issuecomment-5907286519)), on David's Mac:

- `com.samurai.saxo-keepalive` is bootstrapped; `launchctl print` shows 91 runs, last exit 0.
- The program is the pinned `/Users/ddjp/.nvm/versions/node/v26.5.0/bin/node`, and that path exists.
- `data/logs/saxo-keepalive.jsonl` shows launchd-driven refreshes every 10 minutes since 2026-09-29 15:22Z with no failures. Each one rotates the token and moves the refresh expiry to obtained + 60 minutes. <!-- cite-exempt: untracked — gitignored local log on David's Mac -->
- The chain had lived about 18 hours, so Saxo applies no absolute session cap under 18 hours.

2026-10-01 ([comment](https://github.com/dd-jp/samurai-trading-system/issues/1908#issuecomment-5940228222)): a triage against main `a27fa67f` restated the same facts (bootstrapped, 91 runs, exit 0, pinned node path exists, 10-minute refreshes) without re-measuring them. Its open list was the absolute session age cap, revocation on rotated-token reuse and a manual `npm run saxo:keepalive` run.

## Still unverified

- whether Saxo caps absolute session age beyond about 18 hours, which only the running chain can answer;
- whether Saxo revokes the chain on reuse of a rotated refresh token, which has not been provoked;
- a manual `npm run saxo:keepalive` run. The launchd runs execute the same script file, so its entrypoint guard (`runWhenInvoked`) is already exercised; a manual run would add only the npm script's own command line (relative script path, cwd-relative `.env.local`, the shell's node);
- the `plutil -lint` result for the plist, which the comments do not report;
- real Telegram delivery of the alert.
