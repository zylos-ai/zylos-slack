# zylos-slack

Slack communication channel for [Zylos](https://github.com/zylos-ai).

## Features

- **Socket Mode** (default) — no public URL needed
- **Webhook mode** — for environments with public endpoints
- DM and channel message handling
- Thread-aware replies
- File/image upload and download
- Access control (DM policy + per-channel allowlists)
- Smart mode (receive all channel messages) and mention mode
- Markdown formatting via Slack blocks
- Typing indicators
- Admin CLI for runtime configuration

## Setup

### 1. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App
2. Choose "From scratch", name your app, select workspace
3. Under **OAuth & Permissions**, add these Bot Token Scopes:
   - `app_mentions:read`
   - `channels:history`
   - `channels:read`
   - `chat:write`
   - `files:read`
   - `files:write`
   - `groups:history`
   - `groups:read`
   - `im:history`
   - `im:read`
   - `im:write`
   - `reactions:read`
   - `reactions:write`
   - `users:read`
4. Install the app to your workspace
5. Copy the **Bot User OAuth Token** (`xoxb-...`)

### 2. Enable Socket Mode

1. Under **Settings → Socket Mode**, enable Socket Mode
2. Generate an **App-Level Token** with `connections:write` scope (`xapp-...`)

### 3. Enable Events

1. Under **Event Subscriptions**, enable events
2. Subscribe to bot events:
   - `message.im`
   - `message.channels`
   - `message.groups`
   - `app_mention`

### 4. Configure Environment

Add to `~/zylos/.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

### 5. Install Component

```bash
zylos add slack
```

## License

MIT
