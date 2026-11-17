# Changelog

## 0.2.0 (2026-11-16)

### Upgrade notes

Slack apps created from an older README lack some scopes and events this
version uses. Add them in the Slack app settings, then **reinstall the app** to
the workspace (Slack applies new scopes only after a reinstall):

- **Proactive send to a bare channel id** (`C…`/`G…`/`D…` without `|type:`)
  looks up the channel type with Slack `conversations.info` when the id is not
  in the local cache yet (no message received from it), which needs the
  `channels:read` and `groups:read` scopes. Without them the lookup fails with
  `missing_scope`, so the id cannot be mapped to a session group and Core does
  not send the message.
- **Group DMs (mpim)** need the `mpim:history` and `mpim:read` scopes and the
  `message.mpim` bot event subscription (README, "Create Slack App" and
  "Enable Events"). Without them the bot never receives group DM messages.

### Added

- **Session groups for multi-session zylos-core.** Each inbound message is
  passed to `c4-receive` with `--session-group`, derived only from its endpoint:
  `dm-<channel>` for DMs (threads inside a DM are not split), `group-<channel>`
  for top-level messages in channels, private channels and group DMs, and
  `group-<channel>:topic-<thread_ts>` for channel messages inside a thread. Core
  adds the `slack:` namespace. The rules are fixed: group names are Core's
  memory keys. Ids are used verbatim; an endpoint that cannot be mapped is not
  sent and the user is asked to try again later (never the overall group). The
  option is passed only when the installed Core lists it in
  `c4-receive-options.json` (re-read on every message); on older Cores no session
  group is derived at all and channel thread messages get no Slack thread
  fetch, so they receive the same arguments, including `--content`, as before
  (`src/lib/session-group.js`, `src/lib/c4-delivery.js`, `src/lib/endpoint.js`).
  Exceptions, listed under "Changed": a DM thread message is sent without its
  `<thread-context>` block when the Slack fetch fails or takes over 5s, and
  c4-receive runs with `process.execPath`.
- `scripts/session-group.js <endpoint>` prints the session group for an
  endpoint (exit 0), or exits 1 with empty stdout for bad input or a failed
  lookup. Core uses it to check which thread owns an outbound address. A bare
  conversation id maps to `dm-<id>` or `group-<id>` (never a thread group); its
  type comes from a local cache (`~/zylos/components/slack/chat-type-cache.json`,
  written for every inbound message and after each successful lookup) or, on a
  miss, from Slack `conversations.info`. The id prefix is never used to guess
  DM vs channel.
- Proactive DM to a user id: a bare `U…`/`W…` endpoint is sent to the user's DM
  with the bot (`conversations.open`, also needed for file uploads) and maps to
  `dm-<D…>`, the same session group as that user's inbound DMs. Inbound DMs
  record the user's DM channel in the cache.
- On a multi-session Core, channel thread messages carry a `<thread-context>`
  block with the thread's root message and the most recent earlier replies
  (`conversations.replies`), because each thread is its own session group. If
  the call fails or takes longer than 5s, the in-memory channel history is used
  as before. Older Cores (no `--session-group`) keep the 0.1.3 content: the
  in-memory `<group-context>`, with no thread fetch. Known limitation: pages are
  read from the oldest end, up to 1000 messages, so in a longer thread the
  newest replies may be missing.
- Lookups run on a separate Web API client with no retries and fail
  rate-limited calls at once, with a 3s timeout (Core's runner kills the
  session-group query at 5s).
- README lists the `message.mpim` event and the `mpim:history` / `mpim:read`
  scopes; group DMs were already handled as channels but an app configured from
  the README never received them.

### Changed

These also apply on older Cores:

- A `c4-receive` call that exceeds the 35s timeout is killed and treated as an
  unknown outcome: the user is told the message may not have arrived (DMs and
  @-mentions only) and it is not resent. Previously timeouts, crashes and most rejections were retried
  once, which could deliver a message Core had already stored twice.
- Only a `c4-receive` that could not be started is retried (once, after 2s).
  Rejections are classified by `error.persisted`: stored (nothing sent to the
  user, hourglass cleared), not stored ("Sorry, I couldn't take this message
  right now. Please try again later."), or uncertain ("Sorry, this message may
  not have reached me. If you don't get a reply in a few minutes, please send it
  again."). The notice is posted in the message's thread, and only for
  messages addressed to the bot: every DM, and channel, private channel or group
  DM (mpim) messages that @-mention the bot. A smart-mode message without an
  @mention gets no notice; its outcome is still final and logged. Core's raw
  error text only goes to the log.
- Every delivery outcome is final for the event deduplicator, so an equivalent
  Slack event (`message` + `app_mention` for one message) can no longer deliver
  the same message again after a failed attempt.
- Only an explicit `{ "ok": true }` on a clean exit counts as delivered; any
  other output is an unknown outcome (not resent).
- Thread context (channel threads, and the existing DM thread context) is
  fetched on that bounded client (3s per call, no retries, rate limits fail at
  once) and given up after 5s overall, so a slow or rate-limited Slack API no
  longer delays the hourglass and delivery (previously up to the SDK's 10
  retries). In that case the DM message is delivered without its
  `<thread-context>` block, as it already was when the call failed.
- `scripts/send.js` refuses a user id with a type other than DM
  (`U…|type:group`), as `scripts/session-group.js` does, instead of sending to
  the user's DM.
- `c4-receive` is resolved from `$ZYLOS_DIR` (default `$HOME/zylos`) and run with
  the current Node binary (`process.execPath`) instead of `node` from `PATH`.
- `buildEndpoint` / `parseEndpoint` moved to `src/lib/endpoint.js`; the endpoint
  format is unchanged.

### Fixed

- `scripts/send.js` no longer writes a `<channel>-undefined.done` typing file for
  a proactive send without `msg:`.
- Messages a user posts with a file attached (Slack subtype `file_share`, with
  or without text) are delivered again instead of being dropped by the subtype
  filter. Their text is delivered and the files go through the existing
  download path (`[file: name]` / `[image: name]` plus a `---- file:` line).
  All other subtypes (edits, deletions, joins, bot messages, ...) are still
  ignored. A channel file whose download fails is now listed as
  `[file: name (download failed)]`, as in DMs, instead of being left out.

## 0.1.3 (2026-09-08)

### Added

- Centralize Slack configuration and message-type values as immutable enum-like constants
- Add an explicit `groupMode` default (`mention`) with CLI configuration and upgrade migration
- Add regression coverage for configuration constants and group access policies

### Changed

- Keep Slack-to-C4 retry state in memory only; delivery is not resumed after a component restart

### Fixed

- Enforce `groupPolicy=disabled` for every channel sender, including the owner
- Track deduplication as `processing`/`done`, release failed keys, and let waiting equivalent events retry
- Treat only an explicit C4 `{ "ok": true }` response as successful delivery
- Classify C4 failures so permanent input errors stop immediately while transient and invalid responses receive a bounded in-process retry

### Security

- Refresh production dependency resolutions to remove all findings from `npm audit --omit=dev`

## 0.1.2 (2026-09-02)

- Fix mention-mode channels responding to unmentioned owner messages
- Preserve Slack mentions as readable `@display-name` text instead of deleting them
- Deduplicate overlapping `message` and `app_mention` events for the same Slack message

## 0.1.1 (2026-03-20)

- Remove SLACK_SIGNING_SECRET (not needed for Socket Mode connection)

## 0.1.0 (2026-03-04)

- Initial release
- Socket Mode and webhook connection support
- DM and channel message receiving via Slack Events API
- Message sending via Slack Web API (text, markdown, files)
- DM access control (owner/allowlist/open)
- Channel access control (disabled/allowlist/open) with per-channel config
- Smart and mention modes for channels
- Typing indicator (hourglass reaction)
- Thread support (context and replies)
- Media download and upload (images, files)
- Admin CLI for configuration management
- Hot-reload config via file watcher
- Message deduplication (5-min TTL)
- Chat history context for channels
- Message logging per channel
