/**
 * Alert-transport selection at the composition root (ticket #322) — the thing
 * that makes the 14-day **unattended** paper soak (#238) actually unattended.
 *
 * ## The bug this closes
 *
 * Three operator-facing escalations existed with real transports available and
 * none of them wired: the dead-man's-switch heartbeat (#96), the orphaned
 * go-verdict alert (#209), and the permanently-unpriced-fill alert (#298). All
 * three fell through to `console-channels.ts`'s log-only stand-ins **by
 * omission** — the composition root simply never constructed a
 * `TelegramClient`. That satisfies each ticket's acceptance criteria and none
 * of their intent: the failures they exist to surface (the bot silently
 * stopping, a lot stuck unpriced, a `go` verdict with no execution record) are
 * exactly the ones nobody notices for days when the only record is a log line
 * on an unattended MacBook.
 *
 * ## `SAMURAI_ALERTS` is required, with no default
 *
 * The degraded mode has to be **named**, never reached by omission — the
 * precedent #293/#320 set for the Alpaca paper/live environment, where the
 * dangerous configuration is refused rather than defaulted. So:
 *
 * - `SAMURAI_ALERTS=telegram` — push notifications. The posture an unattended
 *   run requires. Demands `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
 *   `TELEGRAM_ALLOWED_USER_IDS` and `TELEGRAM_HEARTBEAT_CHAT_ID` (#342, below);
 *   startup fails naming whichever are absent.
 * - `SAMURAI_ALERTS=log-only` — the log-only stand-ins. A legitimate, and
 *   explicitly acknowledged, choice for an **attended** run: a local dev run, a
 *   supervised smoke test, a backtest. It is logged at `warn` every time,
 *   because a process in this mode cannot tell anyone it has stopped.
 * - unset, or anything else — a startup failure naming the variable and both
 *   values. There is deliberately no default: a default of `log-only` is the
 *   bug being fixed, and a default of `telegram` would fail every dev run for
 *   want of a bot token.
 *
 * A caller that injected every channel itself is not asked for the
 * variable at all (`resolveAlertsMode` returns `undefined`), mirroring
 * `missingCredentialEnvVars`' `satisfiedByInjection` in index.ts: it has
 * already made the decision explicitly. Injecting *some* of them does not
 * exempt the rest — that would be the same silent-by-omission hole one level
 * down.
 *
 * ## The heartbeat gets its own chat (#342)
 *
 * The heartbeat is not an escalation and must not share a destination with
 * one. At the 60s cadence #96 shipped, the dead-man's-switch alone puts ~20,000
 * messages into the alert chat over the 14-day soak (#238) — and the
 * predictable response to 20,000 notifications is to mute the chat. That mutes
 * the orphaned go verdict (#209), the stuck unpriced lot (#298) and the
 * kill-threshold breach (#93) with it: the exact failure #322 exists to
 * prevent, reintroduced as alert fatigue instead of as missing wiring.
 *
 * So `TELEGRAM_HEARTBEAT_CHAT_ID` is required alongside the other three under
 * `telegram`, and must NOT equal `TELEGRAM_CHAT_ID` — both are refused at boot
 * rather than warned about, since a warning about a chat the operator is about
 * to mute is a warning in the wrong chat. The property this buys, which
 * alert-transport.test.ts asserts directly: **muting or losing the heartbeat
 * stream cannot silence an escalation**, because the two share no destination.
 * A caller that injected its own `heartbeatChannel` is asked for neither — it
 * has already chosen where heartbeats go.
 *
 * The other half of #342 is cadence, and it lives in production.ts:
 * `DEFAULT_HEARTBEAT_INTERVAL_MS` is 15 minutes, an external watchdog's
 * staleness threshold rather than a tick.
 *
 * What this is NOT is the right long-run shape. A dead-man's switch properly
 * inverts: an external watchdog alerts on the ABSENCE of a beat, and steady-
 * state volume is zero. That watchdog cannot live in this process — the thing
 * it must detect is this process dying — so it stays out of scope here, and
 * the separate chat is what makes the current shape survivable meanwhile.
 *
 * ## Why the allowlist is required for outbound-only alerts
 *
 * `TELEGRAM_ALLOWED_USER_IDS` is on the required list even though nothing here
 * receives anything. That is a consequence of construction, not a claim that
 * this ticket arms the HITL gate: `TelegramBotApiClient` is the only in-repo
 * `TelegramClient`, and it validates the allowlist in its constructor
 * (allowlist.ts) — deliberately, since an unset or wildcard allowlist is either
 * a silently fail-closed gate or a critical exposure, and verdict-spec.md
 * requires that to be caught at boot rather than discovered at runtime.
 *
 * To be unambiguous about what this file does NOT do: no poll loop is started
 * (`client.start()` is never called — `getUpdates` is single-consumer per bot
 * token, and starting one here would make a *second* process' approval poll
 * impossible), no approval handler is registered, and
 * `ProductionConfig.approvals` still falls back to `ConsoleApprovalChannel`.
 * Wiring HITL approvals through Telegram is #275's remaining half. Validating
 * the allowlist now rather than then is the same fail-at-boot posture the spec
 * asks for: an unattended soak must not discover a broken allowlist on the day
 * approvals go live.
 *
 * ## Why here and not in `production.ts`
 *
 * #322 asks for the client to be built in `production.ts`. It is built here and
 * called from `startFromEnvironment` (index.ts) instead, for one reason:
 * `buildProductionOrchestrator` is called directly by a large number of tests
 * and by any programmatic composition root, and none of them should have to set
 * a process-wide environment variable to construct an orchestrator with stubbed
 * channels. The *deployment* decision belongs where the other deployment
 * decisions already live — alongside `assertCredentialsPresent` and
 * `parseMode`, on the path the shipped entrypoint takes. `production.ts` keeps
 * its log-only defaults, which is what `log-only` mode resolves to.
 */
import type { SharedStore as SqliteHandle } from '../shared/store/index.js';
import { TelegramBotApiClient, TelegramChannel } from '../verdict/index.js';
import { TradeChannelAnalystSkipAlert } from './analyst-skip-alert-channel.js';
import { TradeChannelBreachAlert } from './breach-alert-channel.js';
import { TradeChannelHeartbeat } from './heartbeat-channel.js';
import { TradeChannelLoosenApproval } from './loosen-approval-channel.js';
import { TradeChannelOcoDoubleFillAlert } from './oco-double-fill-channel.js';
import { TradeChannelOrphanAlert } from './orphan-alert-channel.js';
import type { AlertChannelSlots, ProductionConfig } from './production.js';
import { TradeChannelResidualExposureAlert } from './residual-exposure-alert-channel.js';
import { SqliteAuditLog } from './sqlite-audit-log.js';
import type { Logger } from './types.js';
import { TradeChannelUnpricedFillAlert } from './unpriced-fill-channel.js';

const ENV_VAR = 'SAMURAI_ALERTS';

export const ALERTS_MODES = ['telegram', 'log-only'] as const;

export type AlertsMode = (typeof ALERTS_MODES)[number];

/**
 * The `AlertChannelSlots` fields this module owns — the outbound operator
 * escalations, and nothing else. Verdict's `approvals` is deliberately absent
 * from `AlertChannelSlots` itself: it is an inbound round trip
 * (`requestApproval` returns an *answer*), not an alert, and wiring it is
 * #275's remaining half.
 *
 * `breachAlerts` joined the list in #327: a kill-threshold breach is the
 * fourth outbound escalation, and it had the same shape of hole as the
 * original three — a real channel type with no transport selected for it.
 *
 * `loosenApprovals` joined in #366, and belongs here despite the name for the
 * reason `approvals` does not: `LoosenApprovalChannel.requestLoosenApproval`
 * returns `void`. It is a one-way push telling a human that the Feedback Loop
 * refused to relax a risk threshold on its own — no answer is collected, no
 * poll is started, and nothing this process does depends on a reply. That makes
 * it the fifth outbound escalation, not a second HITL round trip.
 *
 * **This list used to be hand-maintained against `ProductionConfig` directly,
 * and the same hole — a real channel type with no transport selected for it —
 * was found and patched by hand eight times running: the original three, then
 * #431 (sixth), #465 (seventh), and #551 (eighth, `residualExposureAlerts`,
 * below).** `satisfies readonly (keyof AlertChannelSlots)[]` only ever caught
 * a field that does NOT belong here; it could not catch one that was missing.
 * `ALL_ALERT_CHANNEL_FIELDS_COVERED` below is what closes that direction: a
 * ninth channel added to `AlertChannelSlots` (production/config.ts) without a
 * matching entry here now fails `yarn typecheck` instead of waiting for a
 * ninth human to notice.
 */
export const ALERT_CHANNEL_FIELDS = [
  'heartbeatChannel',
  'orphanAlerts',
  'unpricedFillAlerts',
  // #551 — the eighth. `ResidualExposureAlertChannel` existed since #525 with
  // only `LoggingResidualExposureAlertChannel` behind it — the same hole as
  // every entry on this list: a real channel type with no transport selected
  // for it, so an unprotected residual position after a failed re-arm reached
  // only the log stream during an unattended soak.
  'residualExposureAlerts',
  // #586 — the ninth, and the first added AFTER `ALL_ALERT_CHANNEL_FIELDS_COVERED`
  // below started enforcing this list: an emulated crypto OCO's double fill
  // (both protective legs filled inside one poll window — the accepted-risk
  // window of #586's emulation) leaves the lot over-closed and a reverse
  // position possibly open at the venue.
  'ocoDoubleFillAlerts',
  'breachAlerts',
  'loosenApprovals',
  // #431 — the sixth. Same hole as the original three: a real channel type
  // (analysts-spec.md story 25) with no transport selected for it, and the
  // failure it reports (the analyst stage skipping every tick) is invisible in
  // an unattended run precisely because nothing else changes when it happens.
  'analystSkipAlerts',
  // #465 — the seventh. `NotifyingVerdict` existed and was constructed
  // nowhere, so a `go` verdict reached the operator only if something
  // downstream happened to alert. Filtered at the decorator so wiring it does
  // not buy ~300 messages a day.
  'verdictAlerts',
] as const satisfies readonly (keyof AlertChannelSlots)[];

/**
 * The other half of the exhaustiveness check (#551) — the direction
 * `satisfies (keyof AlertChannelSlots)[]` above cannot cover. Fully covered,
 * `Exclude<keyof AlertChannelSlots, (typeof ALERT_CHANNEL_FIELDS)[number]>`
 * is `never`, the mapped type below has no keys, and `{}` satisfies it. Miss
 * one — say a ninth channel lands on `AlertChannelSlots` with nothing added
 * here — and the mapped type gains a required key for the missing field, so
 * `{}` no longer satisfies it and `yarn typecheck` fails naming that key.
 *
 * Exported, not a throwaway local: the entire point of this binding lives in
 * its TYPE, not in anything read from it at runtime, and an unused local
 * would be exactly the kind of thing a linter flags and a future edit
 * "cleans up" — taking the guard with it. Proven in the #551 PR description
 * by temporarily adding a dummy field to `AlertChannelSlots` and confirming
 * `yarn typecheck` fails on this line, naming the field.
 */
export const ALL_ALERT_CHANNEL_FIELDS_COVERED: {
  [K in Exclude<keyof AlertChannelSlots, (typeof ALERT_CHANNEL_FIELDS)[number]>]: never;
} = {};

/**
 * The heartbeat's own chat (#342) — named separately because it is the one
 * variable on the list below that a caller can be exempted from: injecting a
 * `heartbeatChannel` means nothing here posts a heartbeat, so nothing here
 * needs a chat to post it to. `missingCredentialEnvVars` (index.ts) keys its
 * exemption off this constant.
 */
export const TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR = 'TELEGRAM_HEARTBEAT_CHAT_ID';

/** What `SAMURAI_ALERTS=telegram` needs in the environment. See the module doc for the allowlist. */
export const TELEGRAM_ALERT_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR,
] as const;

/** The alert channels, as `buildProductionOrchestrator` takes them. */
export type AlertChannels = Pick<ProductionConfig, (typeof ALERT_CHANNEL_FIELDS)[number]>;

/**
 * The alerts posture for this run, or `undefined` when the caller supplied
 * every channel itself and there is nothing left to decide.
 *
 * Throws — before anything is constructed, and before any store is opened —
 * when the variable is absent or unrecognised.
 */
export function resolveAlertsMode(injected: Partial<ProductionConfig>): AlertsMode | undefined {
  if (ALERT_CHANNEL_FIELDS.every((field) => injected[field] !== undefined)) return undefined;

  // Trimmed for the same reason the chat ids below are: `SAMURAI_ALERTS=telegram\n`
  // out of an env file is the mode the operator typed, and refusing it produced
  // "must be one of telegram|log-only" about a value that reads as `telegram`
  // on screen — fail-loud, but not actionable. Nothing dangerous is reachable
  // by this trim: both post-trim outcomes are still values the operator wrote,
  // and a whitespace-only value trims to `''`, matches neither mode, and is
  // refused exactly as before. (`SAMURAI_MODE` deliberately does NOT trim —
  // see `parseMode` in index.ts.)
  const raw = process.env[ENV_VAR]?.trim();
  const mode = ALERTS_MODES.find((candidate) => candidate === raw);
  if (mode !== undefined) return mode;

  throw new Error(
    `Orchestrator cannot start: ${ENV_VAR} must be one of ${ALERTS_MODES.join('|')}` +
      `${raw === undefined ? ' and is not set' : ''}. It selects where operator alerts go — the ` +
      "dead-man's-switch heartbeat, orphaned go-verdicts and stuck unpriced lots — and has no " +
      'default on purpose: an unattended run (#238) whose alerts quietly fall back to the log ' +
      'stream is exactly the failure this variable exists to prevent. Use ' +
      `${ENV_VAR}=telegram for an unattended run (also needs ` +
      `${TELEGRAM_ALERT_ENV_VARS.join(', ')}), or ${ENV_VAR}=log-only to accept log-only ` +
      'alerting for an attended one — a local dev run or a supervised smoke test, where ' +
      'somebody is reading stdout.',
  );
}

/**
 * The channels for `alertsMode`, omitting any the caller already injected.
 *
 * `log-only` returns nothing at all, deliberately: `production.ts` already
 * documents and constructs `LoggingHeartbeatChannel` /
 * `LoggingOrphanAlertChannel` / `LoggingUnpricedFillAlertChannel` as its
 * defaults, and a second set built here would be two places to keep in sync
 * for no behavioural difference. The `warn` is the point of the branch.
 *
 * `telegram` builds ONE `TelegramBotApiClient` shared by every adapter this
 * branch constructs (eight as of #551) — not one each: they share a bot
 * token, a retry budget and Telegram's ~30 messages/second ceiling, and
 * separate clients would each believe they owned the whole allowance.
 */
export function buildAlertChannels(deps: {
  alertsMode: AlertsMode;
  injected: Partial<ProductionConfig>;
  db: SqliteHandle;
  logger: Logger;
}): AlertChannels {
  if (deps.alertsMode === 'log-only') {
    deps.logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      level: 'warn',
      message:
        `${ENV_VAR}=log-only — every operator alert (heartbeat, orphaned go verdict, stuck ` +
        'unpriced fill, unprotected residual position, kill-threshold breach, proposed ' +
        'risk-threshold loosening) is a log line, and nothing will reach a phone. Correct for ' +
        `an ATTENDED run only; an unattended soak (#238) needs ${ENV_VAR}=telegram.`,
      payload: { alerts: 'log-only' },
    });
    return {};
  }

  const chatId = requireEnv('TELEGRAM_CHAT_ID');
  // #342. Resolved before the client is constructed, so a misconfigured pair
  // fails with nothing built. `undefined` only when the caller supplied its own
  // heartbeat channel — then no chat id is read, and the equality refusal below
  // does not apply to a decision this module did not make.
  const heartbeatChatId =
    deps.injected.heartbeatChannel === undefined ? requireHeartbeatChatId(chatId) : undefined;

  // The bot token and the allowlist are read by the client itself, from the
  // same variables — not re-read here, so there is exactly one place that
  // touches the token and exactly one that validates the allowlist.
  const telegram = new TelegramBotApiClient({
    // Where the client posts its own repeated-allowlist-rejection security
    // alert. The same chat the alerts go to: it is the channel the operator is
    // already watching, and a security signal with nowhere to go is the
    // failure mode this whole ticket is about.
    alertChatId: chatId,
    // Written to on an inbound allowlist rejection. Unused while nothing polls
    // (see the module doc), and supplied anyway rather than stubbed: the store
    // is the durable one every other component here writes to, so the day
    // approvals are wired there is no second decision to get wrong.
    auditLog: new SqliteAuditLog(deps.db),
    logger: deps.logger,
  });

  // The heartbeat clause is branched, not boilerplate: on the injected path
  // this module reads no heartbeat chat id and builds no adapter, so claiming
  // the beat goes to `TELEGRAM_HEARTBEAT_CHAT_ID` would name a destination no
  // heartbeat reaches. This line is what an operator checks their alerting
  // against before an unattended soak, and a confidently wrong destination is
  // worse than no claim at all.
  const heartbeatClause =
    heartbeatChatId === undefined
      ? 'The heartbeat is not routed here at all: ProductionConfig.heartbeatChannel was ' +
        `supplied by the caller, so where the beat goes is that channel's decision and ` +
        `${TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR} is neither read nor required (#342).`
      : `The heartbeat goes to ${TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR} instead (#342), so that ` +
        'muting the beat cannot mute an escalation.';

  deps.logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    level: 'info',
    message:
      `${ENV_VAR}=telegram — orphaned go verdicts, stuck unpriced fills, unprotected residual ` +
      'positions, kill-threshold breaches and proposed risk-threshold loosenings will be ' +
      `pushed to the escalation chat (TELEGRAM_CHAT_ID). ${heartbeatClause} ` +
      'Keep the escalation chat unmuted. No approval poll is started here: HITL approvals ' +
      'still resolve through ProductionConfig.approvals (#275), and a loosening request is ' +
      'outbound-only — replying to it approves nothing, and the threshold stays put (#366).',
    // Never the token, and never either chat id: none is a secret worth a log
    // line, and the token is a bearer credential for the entire bot. The
    // heartbeat field is the machine-readable form of the clause above — two
    // values, because there are two real paths.
    payload: {
      alerts: 'telegram',
      heartbeat: heartbeatChatId === undefined ? 'caller-supplied' : 'separate-chat',
    },
  });

  return {
    ...(heartbeatChatId === undefined
      ? {}
      : { heartbeatChannel: new TradeChannelHeartbeat(telegram, heartbeatChatId) }),
    ...(deps.injected.orphanAlerts === undefined
      ? { orphanAlerts: new TradeChannelOrphanAlert(telegram, chatId) }
      : {}),
    ...(deps.injected.unpricedFillAlerts === undefined
      ? { unpricedFillAlerts: new TradeChannelUnpricedFillAlert(telegram, chatId) }
      : {}),
    // #551. The escalation chat, not the heartbeat chat: an unprotected
    // residual position sitting at the venue with no stop or target is an
    // event an operator must act on, not a beat (#342's split).
    ...(deps.injected.residualExposureAlerts === undefined
      ? { residualExposureAlerts: new TradeChannelResidualExposureAlert(telegram, chatId) }
      : {}),
    // #586. The escalation chat: a lot over-closed into a possible reverse
    // position is a decision waiting on the operator, not a beat (#342).
    ...(deps.injected.ocoDoubleFillAlerts === undefined
      ? { ocoDoubleFillAlerts: new TradeChannelOcoDoubleFillAlert(telegram, chatId) }
      : {}),
    ...(deps.injected.breachAlerts === undefined
      ? { breachAlerts: new TradeChannelBreachAlert(telegram, chatId, deps.logger) }
      : {}),
    // #366. The escalation chat, not the heartbeat chat: a proposed loosening
    // is a decision waiting on the operator, and the whole point of #342's
    // split is that decisions do not share a destination with the beat.
    ...(deps.injected.loosenApprovals === undefined
      ? { loosenApprovals: new TradeChannelLoosenApproval(telegram, chatId, deps.logger) }
      : {}),
    // #465. The escalation chat rather than the heartbeat's: a trade that
    // executed, or the system halting itself, is an event — not a beat.
    ...(deps.injected.verdictAlerts === undefined
      ? { verdictAlerts: new TelegramChannel(telegram, chatId) }
      : {}),
    // #431. The escalation chat: "no decision is being produced at all" is the
    // most consequential thing this process can report, and it must not sit in
    // the chat #342 expects the operator to mute.
    ...(deps.injected.analystSkipAlerts === undefined
      ? { analystSkipAlerts: new TradeChannelAnalystSkipAlert(telegram, chatId) }
      : {}),
  };
}

/**
 * The heartbeat's destination (#342), refused when it is absent or when it is
 * the escalation chat.
 *
 * The equality case is refused rather than warned about for the same reason the
 * ticket exists: the warning would be delivered to the chat the operator is
 * about to mute. There is no default to fall back to either — the only chat id
 * this process could invent is `TELEGRAM_CHAT_ID`, which is precisely the
 * configuration being rejected.
 *
 * Names variables, never values: a chat id is not a bearer credential, but it
 * identifies the operator's private channel and has no business in a startup
 * error that goes to stderr.
 */
function requireHeartbeatChatId(escalationChatId: string): string {
  const heartbeatChatId = requireEnv(TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR);
  if (heartbeatChatId === escalationChatId) {
    throw new Error(
      `Orchestrator cannot start: ${TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR} is the same chat as ` +
        'TELEGRAM_CHAT_ID. The heartbeat needs a destination of its own: it posts on a fixed ' +
        'interval forever (~1,300 messages over a 14-day soak, #238), and pointed at the ' +
        'escalation chat it drives the operator to mute the one channel that carries orphaned ' +
        'go verdicts, stuck unpriced fills and kill-threshold breaches (#342). Create a second ' +
        `chat for the beat and set ${TELEGRAM_HEARTBEAT_CHAT_ID_ENV_VAR} to it, or re-run with ` +
        `${ENV_VAR}=log-only to accept log-only alerting for an attended run.`,
    );
  }
  return heartbeatChatId;
}

/**
 * A backstop, not the primary check: `missingCredentialEnvVars` (index.ts)
 * names every absent variable at once, before this module is reached. This
 * exists so that a programmatic caller reaching `buildAlertChannels` directly
 * still fails with a legible message instead of posting to `chat_id: undefined`.
 * Names the variable only — never its value.
 *
 * **Trims, and that is load-bearing** (kimi-3-review on #353). This is the one
 * place both chat ids are read, so normalizing here is what makes the
 * same-chat refusal above compare like with like: with a raw `===`, a single
 * trailing newline out of an env file — `TELEGRAM_HEARTBEAT_CHAT_ID=-100…\n` —
 * slipped past the guard while still addressing the escalation chat, silently
 * recreating #342 with the guard reporting safe. Same class of bug as
 * #293/#320, where a whitespace-sensitive `startsWith` let
 * `' https://api.alpaca.markets'` walk past a live-host guard; same
 * resolution: normalize once, compare normalized, hand the normalized value
 * onward. The second half matters on its own — a `chat_id` carrying a newline
 * is a Bot API 400 on every send, discovered days into an unattended soak.
 *
 * Whitespace-only counts as unset rather than as an error, the rule
 * `rotating-file-sink.ts`'s `nonEmpty` and `missingCredentialEnvVars` also
 * apply. Not shared code with either: this is one `.trim()` at a single read
 * point, and importing a credential rule out of the log-sink module would be
 * the wrong dependency edge for the sake of three characters.
 */
function requireEnv(name: (typeof TELEGRAM_ALERT_ENV_VARS)[number]): string {
  const value = (process.env[name] ?? '').trim();
  if (value.length === 0) {
    throw new Error(
      `Orchestrator cannot start: ${ENV_VAR}=telegram was selected but ${name} is not set ` +
        '(an empty or whitespace-only value counts as missing). Set it, or re-run with ' +
        `${ENV_VAR}=log-only to accept log-only alerting for an attended run.`,
    );
  }
  return value;
}
