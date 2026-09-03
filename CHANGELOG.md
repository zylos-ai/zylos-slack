# Changelog

## Unreleased

### Added

- Centralize Slack configuration and message-type values as immutable enum-like constants
- Add an explicit `groupMode` default (`mention`) with CLI configuration and upgrade migration
- Add regression coverage for configuration constants and group access policies

### Fixed

- Enforce `groupPolicy=disabled` for every channel sender, including the owner
- Track deduplication as `processing`/`done`, release failed keys, and let waiting equivalent events retry
- Classify C4 structured failures so permanent input errors stop immediately while transient failures retry
- Persist Slack-to-C4 deliveries before processing, recover pending records after restart, and dead-letter exhausted retries

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
