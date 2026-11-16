---
name: slack
version: 0.2.0
description: >
  Slack communication channel. Receives messages via Slack Events API
  (Socket Mode or webhook) and sends messages via Slack Web API.
  Use when: (1) replying to Slack messages (DM or channel),
  (2) sending proactive messages to Slack users or channels,
  (3) managing DM access control (dmPolicy: open/allowlist/owner),
  (4) managing channel access control (groupPolicy, per-channel allowFrom),
  (5) configuring the bot (admin CLI, markdown settings),
  (6) troubleshooting Slack message delivery issues.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-slack
    entry: src/index.js
  data_dir: ~/zylos/components/slack
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - .env
    - data/

upgrade:
  repo: zylos-ai/zylos-slack
  branch: main

config:
  required:
    - name: SLACK_BOT_TOKEN
      description: "Slack bot token (xoxb-...)"
      sensitive: true
    - name: SLACK_APP_TOKEN
      description: "Slack app-level token (xapp-...) for Socket Mode"
      sensitive: true
dependencies:
  - comm-bridge
---

# Slack

Slack communication channel for Zylos. Supports DM and channel messages via Socket Mode (default) or webhook.

## Connection Modes

| Mode | Requires Public URL | Setup Complexity |
|------|-------------------|-----------------|
| **Socket Mode** (default) | No | Low — just tokens |
| **Webhook** | Yes | Medium — needs Caddy route |

## Configuration

### Environment Variables (~/zylos/.env)

```bash
SLACK_BOT_TOKEN=xoxb-...        # Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...        # App-Level Token (Socket Mode)
```

### Runtime Config (~/zylos/components/slack/config.json)

```json
{
  "enabled": true,
  "connection_mode": "socket",
  "webhook_port": 3461,
  "owner": { "bound": false, "user_id": "", "name": "" },
  "dmPolicy": "owner",
  "dmAllowFrom": [],
  "groupPolicy": "allowlist",
  "groupMode": "mention",
  "groups": {},
  "message": { "context_messages": 10, "useMarkdown": true }
}
```

## Admin CLI

```bash
node ~/zylos/.claude/skills/slack/src/admin.js <command> [args]
```

| Command | Description |
|---------|-------------|
| `show` | Show full config |
| `show-owner` | Show current owner |
| `set-dm-policy <open\|allowlist\|owner>` | Set DM access policy |
| `list-dm-allow` | List DM allowlist |
| `add-dm-allow <user_id>` | Add user to DM allowlist |
| `remove-dm-allow <user_id>` | Remove from DM allowlist |
| `list-groups` | List configured channels |
| `add-group <channel_id> <name> [mode]` | Add channel (mode: mention\|smart) |
| `remove-group <channel_id>` | Remove channel |
| `set-group-policy <disabled\|allowlist\|open>` | Set channel access policy |
| `set-group-mode <mention\|smart>` | Set the default channel trigger mode |
| `set-markdown <on\|off>` | Toggle markdown formatting |
| `help` | Show all commands |

## Sending Messages

To reply, use the `reply via` path exactly as given. For a proactive send (not
a reply), use `<channel_id>|type:dm` for a DM and `<channel_id>|type:group` for a
channel, private channel or group DM. The type tells a multi-session Core which
conversation the message belongs to. A bare `<channel_id>` also still works (see
[Session Groups](#session-groups-multi-session-core)). To DM a user you only
know by user id, use the bare `<user_id>` (`U…`/`W…`): the message goes to that
user's DM with the bot. A user id is only ever a DM: `<user_id>|type:dm` also
works, but `<user_id>|type:group` is refused.

```bash
# Via C4 bridge (standard path — always use stdin form)
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "slack" "<channel_id>|type:group"
Hello!
EOF

# DM a user by user id
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "slack" "<user_id>"
Hello!
EOF

# Image / file
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "slack" "<channel_id>|type:dm"
[MEDIA:image]/path/to/img.png
EOF
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "slack" "<channel_id>|type:group"
[MEDIA:file]/path/to/doc.pdf
EOF
```

Endpoint format: `channelId|type:<dm|group>|msg:timestamp[|thread:threadTs]`.
A reply goes into the message's thread (`thread`, else `msg`), so a top-level
message gets a new thread rooted at it. Without `msg`/`thread` the message is
posted at the top level.

## Session Groups (multi-session Core)

With a zylos-core that supports multi-session, each inbound message carries a
session group, so every DM, channel and channel thread gets its own conversation
thread. Replies still go through the same `reply via` path; the endpoint format
is unchanged.

| Conversation | Endpoint | Session group | Example |
|---|---|---|---|
| DM (incl. threads inside the DM) | `<D…>\|type:dm...` | `dm-<channel>` | `dm-D0123ABCDE` |
| Channel, private channel, group DM (mpim), top level | `<C…/G…>\|type:group...` without `thread:` | `group-<channel>` | `group-C0123ABCDE` |
| Channel thread | `<C…>\|type:group...\|thread:<thread_ts>` | `group-<channel>:topic-<thread_ts>` | `group-C0123ABCDE:topic-1763280000.123456` |

Core adds the `slack:` namespace (e.g. `slack:dm-D0123ABCDE`).

- These rules are fixed. Group names are Core's memory keys, so changing them
  would need a migration together with Core.
- Every channel message inside a thread gets its own thread group. The bot
  answers a top-level channel message in a new thread, so the user's next
  message in that thread lands in the thread group, not the channel group. To
  keep the context, a channel thread message carries a `<thread-context>` block
  with the thread's root message and the most recent earlier replies (from
  `conversations.replies`, at most 1000 messages read from the oldest end; the
  in-memory channel history is the fallback when that call fails or takes over
  5s). Only a multi-session Core gets it; an older Core gets the same
  in-memory `<group-context>` as before. Threads inside a DM are not split: one
  group per DM.
- The message `ts` (`msg:`) never affects the group.
- Ids are used verbatim, never truncated or hashed. On a multi-session Core, an
  endpoint that cannot be mapped (no or unknown `type:`, unexpected characters,
  a `thread:` that is not a Slack timestamp, name over 95 characters) is not
  sent to Core; the user is asked to try again later. It never falls back to the
  overall group. On an older Core no group is derived at all, so such an
  endpoint is sent exactly as before.
- The group is passed only if the installed Core lists `--session-group` in
  `c4-receive-options.json` (re-read on every message, so no restart is needed
  after a Core upgrade). Older Cores receive the same arguments as before,
  including the message content (no channel thread fetch), with two
  exceptions: a DM thread message is sent without its `<thread-context>` block
  when the Slack fetch fails, is rate-limited or takes over 5s; and
  c4-receive is run with the current Node binary (`process.execPath`) instead
  of `node` from `PATH`.
- If Core rejects a message, Core's raw text goes only to the component log.
  For a DM, or a channel / private channel / group DM message that @-mentions
  the bot, the user gets, in the message's thread, "Sorry, I couldn't take
  this message right now. Please try again later." when Core says nothing was stored, and "Sorry,
  this message may not have reached me. If you don't get a reply in a few
  minutes, please send it again." when Core cannot say or the outcome is
  unknown. If Core reports the message as already stored, nothing is sent and
  the hourglass is cleared. A rejected message is never resent without its
  group. c4-receive is killed after 35s; a timeout counts as an unknown outcome
  (the "may not have reached me" notice, never resent). It is retried (once,
  after 2s) only when the process could not be started at all. Smart-mode
  messages without an @mention get no notice (they had no hourglass either);
  the outcome is still final (never resent) and logged. This holds for every
  case above, including an endpoint that cannot be mapped to a session group.

Look up the session group for an endpoint:

```bash
node ~/zylos/.claude/skills/slack/scripts/session-group.js "<endpoint>"
# prints e.g. group-C0123ABCDE:topic-1763280000.123456 (without "slack:"), exit 0
```

An endpoint with `|type:` (the `reply via` value, or `<channel_id>|type:dm` /
`<channel_id>|type:group` for proactive sends) is mapped directly. A bare id is
resolved, never to a thread group:

- A conversation id (`C…`/`G…`/`D…`): from a local cache,
  `~/zylos/components/slack/chat-type-cache.json`, which the service fills for
  every inbound message; on a miss from Slack `conversations.info` (`is_im` is a
  DM; `is_channel`/`is_group`/`is_mpim` is a group). The id prefix is not used
  to guess the type.
- A user id (`U…`/`W…`): the user's DM channel, from the cache (recorded for
  every inbound DM) or from `conversations.open`, mapped to `dm-<D…>`, the same
  group as the user's own DMs.
- Lookups time out after 3s with no SDK retries, so they fail cleanly before
  Core's 5s limit for this query. If a lookup fails (for example
  `channel_not_found`, `missing_scope`, a rate limit or a timeout), the script
  prints an error to stderr and exits 1 with empty stdout; nothing is guessed or
  cached, and Core does not send the message. A wrong argument count or an
  unmappable endpoint also exits 1 with empty stdout.
