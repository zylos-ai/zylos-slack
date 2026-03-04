---
name: slack
version: 0.1.0
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
  optional:
    - name: SLACK_SIGNING_SECRET
      description: "Slack signing secret (required for webhook mode)"
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
SLACK_SIGNING_SECRET=...        # Signing Secret (webhook mode)
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
| `set-markdown <on\|off>` | Toggle markdown formatting |
| `help` | Show all commands |

## Sending Messages

```bash
# Text
node ~/zylos/.claude/skills/slack/scripts/send.js "<endpoint>" "Hello!"

# Image
node ~/zylos/.claude/skills/slack/scripts/send.js "<endpoint>" "[MEDIA:image]/path/to/img.png"

# File
node ~/zylos/.claude/skills/slack/scripts/send.js "<endpoint>" "[MEDIA:file]/path/to/doc.pdf"
```

Endpoint format: `channelId|type:dm|msg:timestamp|thread:threadTs`
