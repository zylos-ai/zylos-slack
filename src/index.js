#!/usr/bin/env node

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { App } from '@slack/bolt';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, watchConfig, stopWatching, saveConfig, DATA_DIR } from './lib/config.js';
import { initClient, createLookupClient, fetchBotIdentity, getBotUserId } from './lib/client.js';
import {
  addReaction, removeReaction, downloadFile, getUserName,
  fetchHistory, fetchThread, sendText,
} from './lib/message.js';
import {
  getMessageDedupKey, isBotMentioned, resolveUserMentions, shouldHandleGroupMessage,
  shouldIgnoreMessageEvent,
} from './lib/mentions.js';
import {
  CONNECTION_MODE, DM_POLICY, ENDPOINT_TYPE, GROUP_MODE, SLACK_CHANNEL_TYPE,
} from './lib/constants.js';
import {
  c4ReceiveSupportsOption, createC4MessageSender, createRejectHandler,
} from './lib/c4-delivery.js';
import { buildEndpoint } from './lib/endpoint.js';
import { recordChatType, recordUserDm } from './lib/session-group.js';
import {
  buildChannelThreadContext, buildGroupContext,
  THREAD_CONTEXT_DEADLINE_MS, THREAD_CONTEXT_REQUEST_TIMEOUT_MS,
} from './lib/thread-context.js';
import { withTimeout } from './lib/timeout.js';
import { MessageDeduplicator } from './lib/dedup.js';
import { isGroupAccessAllowed } from './lib/policy.js';

// ── Constants ──

const LOGS_DIR = path.join(DATA_DIR, 'logs');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const TYPING_DIR = path.join(DATA_DIR, 'typing');

const DEDUP_TTL = 5 * 60 * 1000; // 5 minutes
const messageDeduplicator = new MessageDeduplicator({ ttlMs: DEDUP_TTL });

// In-memory chat histories for context
const chatHistories = new Map();

let config = null;
let app = null;

// ── Startup ──

console.log('[slack] Starting...');
console.log('[slack] Data directory:', DATA_DIR);

config = getConfig();

if (!config.enabled) {
  console.log('[slack] Component disabled, exiting.');
  process.exit(0);
}

// Validate credentials
const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
if (!botToken) {
  console.error('[slack] SLACK_BOT_TOKEN not set in .env');
  process.exit(1);
}

if (config.connection_mode === CONNECTION_MODE.SOCKET && !appToken) {
  console.error('[slack] SLACK_APP_TOKEN not set in .env (required for Socket Mode)');
  process.exit(1);
}

// Initialize client
initClient(botToken);
// Thread context is fetched before delivery: use a bounded client (no
// retries, short timeout, rate limits fail at once) so a slow Slack API only
// drops the context instead of stalling the message.
const contextClient = createLookupClient(botToken, { timeoutMs: THREAD_CONTEXT_REQUEST_TIMEOUT_MS });

// Ensure directories exist
[LOGS_DIR, MEDIA_DIR, TYPING_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

// c4-receive is resolved from $ZYLOS_DIR (default $HOME/zylos) on every call;
// --session-group is passed only when the installed Core declares it.
const sendToC4 = createC4MessageSender({
  onDelivered: record => {
    console.log(`[slack] Sent to C4: ${record.content.substring(0, 60)}...`);
  },
  // Every outcome is final (never resent). The hourglass is always cleared;
  // the notice (null when Core already stored the message) is posted only for
  // DMs and channel messages that @-mention the bot.
  onRejected: createRejectHandler({
    clearTypingIndicator: clearFailedTypingIndicator,
    postNotice: sendRejectNotice,
  }),
});

// ── Main ──

async function main() {
  // Fetch bot identity
  const bot = await fetchBotIdentity();

  // Build Bolt app options
  const appOpts = {
    token: botToken,
    appToken: config.connection_mode === CONNECTION_MODE.SOCKET ? appToken : undefined,
    socketMode: config.connection_mode === CONNECTION_MODE.SOCKET,
    port: config.connection_mode === CONNECTION_MODE.WEBHOOK ? config.webhook_port : undefined,
  };

  app = new App(appOpts);

  // ── Event: Direct Message ──
  app.event('message', async ({ event, say }) => {
    // Ignore bot messages and subtypes (edits, joins, etc.), except file_share
    if (shouldIgnoreMessageEvent(event)) return;
    if (event.user === getBotUserId()) return;

    const msgKey = getMessageDedupKey(event);
    await messageDeduplicator.run(msgKey, async () => {
      const channelType = event.channel_type; // 'im' for DM, 'channel'/'group' for channels

      if (channelType === SLACK_CHANNEL_TYPE.DIRECT_MESSAGE) {
        await handleDM(event);
      } else {
        await handleGroupMessage(event, isBotMentioned(event.text, getBotUserId()));
      }
    });
  });

  // ── Event: App Mention (in channels) ──
  app.event('app_mention', async ({ event }) => {
    if (event.bot_id || event.user === getBotUserId()) return;

    const msgKey = getMessageDedupKey(event);
    await messageDeduplicator.run(msgKey, () => handleGroupMessage(event, true));
  });

  // Start the app
  await app.start();
  console.log(`[slack] Running (${config.connection_mode} mode)`);

  // Watch config for hot-reload
  watchConfig((newConfig) => {
    console.log('[slack] Config reloaded');
    config = newConfig;
    if (!newConfig.enabled) {
      console.log('[slack] Component disabled, stopping...');
      shutdown();
    }
  });

  // Cleanup completed dedup entries periodically. Processing entries remain
  // owned by their active handler and are released immediately on failure.
  setInterval(() => messageDeduplicator.cleanup(), 60_000);

  // Typing indicator check (every 2s)
  setInterval(checkTypingDone, 2000);
}

// ── DM Handler ──

async function handleDM(event) {
  const userId = event.user;
  // Remember DM vs group (and the user's DM channel) so a bare id used for a
  // proactive send maps to its session group without an API call.
  recordChatType(event.channel, ENDPOINT_TYPE.DIRECT_MESSAGE);
  recordUserDm(userId, event.channel);
  const userName = await getUserName(userId);

  // Owner auto-binding
  if (!config.owner.bound) {
    config.owner = { bound: true, user_id: userId, name: userName };
    saveConfig(config);
    console.log(`[slack] Owner bound: ${userName} (${userId})`);
  }

  const isOwner = userId === config.owner.user_id;

  // Access check
  if (!isOwner) {
    if (config.dmPolicy === DM_POLICY.OWNER) {
      console.log(`[slack] DM rejected (owner-only): ${userName}`);
      return;
    }
    if (config.dmPolicy === DM_POLICY.ALLOWLIST && !config.dmAllowFrom.includes(userId)) {
      console.log(`[slack] DM rejected (not in allowlist): ${userName}`);
      return;
    }
  }

  // Build message content
  let content = '';
  let fileLine = '';

  // Handle file attachments
  if (event.files && event.files.length > 0) {
    for (const file of event.files) {
      try {
        const localPath = await downloadFile(file.url_private_download, file.name);
        const isImage = file.mimetype?.startsWith('image/');
        if (isImage) {
          content += `[image: ${file.name}]\n`;
        } else {
          content += `[file: ${file.name}]\n`;
        }
        fileLine += `\n---- file: ${localPath}`;
      } catch (err) {
        console.warn('[slack] File download failed:', err.message);
        content += `[file: ${file.name} (download failed)]\n`;
      }
    }
  }

  // Text content
  const text = event.text || '';
  if (text) content += text;
  if (!content.trim()) return;

  // Thread context
  let threadContext = '';
  if (event.thread_ts && event.thread_ts !== event.ts) {
    try {
      threadContext = await withTimeout((async () => {
        const replies = await fetchThread(event.channel, event.thread_ts, 5, contextClient);
        const lines = [];
        for (const r of replies) {
          if (r.ts === event.ts) continue;
          const rName = r.user ? await getUserName(r.user) : 'bot';
          lines.push(`${rName}: ${r.text || '(media)'}`);
        }
        return lines.length > 0 ? `<thread-context>\n${lines.join('\n')}\n</thread-context>\n\n` : '';
      })(), THREAD_CONTEXT_DEADLINE_MS, 'thread context');
    } catch (err) {
      console.warn('[slack] Failed to fetch thread context:', err.message);
    }
  }

  // Add typing indicator
  await addReaction(event.channel, event.ts, 'hourglass_flowing_sand');
  trackTyping(event.channel, event.ts);

  // Build endpoint
  const endpoint = buildEndpoint(event.channel, ENDPOINT_TYPE.DIRECT_MESSAGE, event.ts, event.thread_ts);

  // Log
  logMessage(event.channel, { from: userName, userId, text: content, ts: event.ts });

  // Format for C4
  const fullContent = `<current-message>\n${threadContext}${content}\n</current-message>${fileLine}`;
  const c4Message = `[Slack DM] ${userName} said: ${fullContent}`;

  await sendToC4({
    msgId: getMessageDedupKey(event),
    source: 'slack',
    endpoint,
    content: c4Message,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    hasTypingIndicator: true,
    messageType: ENDPOINT_TYPE.DIRECT_MESSAGE,
    senderName: userName,
  });
}

// ── Group Message Handler ──

async function handleGroupMessage(event, isMention = false) {
  const channelId = event.channel;
  const userId = event.user;
  // Channels, private channels and group DMs (mpim) are all groups.
  recordChatType(channelId, ENDPOINT_TYPE.GROUP);
  const isOwner = userId === config.owner?.user_id;
  const groupConfig = config.groups?.[channelId];

  // Check group policy
  if (!isGroupAccessAllowed({
    groupPolicy: config.groupPolicy,
    groupConfig,
    userId,
    isOwner,
  })) return;

  const userName = await getUserName(userId);

  const mode = groupConfig?.mode || config.groupMode || GROUP_MODE.MENTION;
  const groupName = groupConfig?.name || channelId;

  // Owner bypass applies to access control, not to the channel's trigger mode.
  if (!shouldHandleGroupMessage(mode, isMention)) return;

  // Smart mode: receive all but flag non-mentions
  const isSmartNoMention = mode === GROUP_MODE.SMART && !isMention;

  // Build message content
  let content = '';
  let fileLine = '';

  if (event.files && event.files.length > 0) {
    for (const file of event.files) {
      try {
        const localPath = await downloadFile(file.url_private_download, file.name);
        const isImage = file.mimetype?.startsWith('image/');
        content += isImage ? `[image: ${file.name}]\n` : `[file: ${file.name}]\n`;
        fileLine += `\n---- file: ${localPath}`;
      } catch (err) {
        console.warn('[slack] File download failed:', err.message);
        content += `[file: ${file.name} (download failed)]\n`;
      }
    }
  }

  // Slack sends mentions as <@USER_ID>. Keep their readable names in the
  // prompt instead of deleting every mentioned person (including the bot).
  const text = (await resolveUserMentions(event.text || '', getUserName)).trim();
  if (text) content += text;
  if (!content.trim() && !fileLine) return;

  // Record in history
  const historyKey = event.thread_ts || channelId;
  if (!chatHistories.has(historyKey)) chatHistories.set(historyKey, []);
  const history = chatHistories.get(historyKey);
  history.push({ from: userName, text: content.substring(0, 500), ts: event.ts });
  const maxHistory = (groupConfig?.historyLimit || config.message.context_messages) * 2;
  if (history.length > maxHistory) history.splice(0, history.length - maxHistory);

  // Build group context. On a multi-session Core a message inside a thread is
  // its own session group (group-<channel>:topic-<thread_ts>), so it gets the
  // thread root and recent replies from Slack (bounded; the in-memory history
  // is the fallback). An older Core gets the in-memory history as in 0.1.3.
  const contextLimit = groupConfig?.historyLimit || config.message.context_messages;
  const groupContext = await buildGroupContext({
    event,
    history,
    limit: contextLimit,
    supportsSessionGroup: c4ReceiveSupportsOption('--session-group'),
    fetchThreadContext: () => buildChannelThreadContext({
      client: contextClient,
      channel: event.channel,
      threadTs: event.thread_ts,
      currentTs: event.ts,
      limit: contextLimit,
      getUserName,
      onError: err => console.warn('[slack] Failed to fetch channel thread context:', err.message),
    }),
  });

  // Typing indicator (only for mentions or smart with mention)
  if (isMention || !isSmartNoMention) {
    await addReaction(event.channel, event.ts, 'hourglass_flowing_sand');
    trackTyping(event.channel, event.ts);
  }

  // Build endpoint
  const endpoint = buildEndpoint(channelId, ENDPOINT_TYPE.GROUP, event.ts, event.thread_ts);

  // Log
  logMessage(channelId, { from: userName, userId, text: content, ts: event.ts });

  // Smart mode hint
  let smartHint = '';
  if (isSmartNoMention) {
    smartHint = '\n(Smart mode: no @mention. Reply with [SKIP] if not relevant.)';
  }

  const fullContent = `<current-message>\n${groupContext}${content}\n</current-message>${fileLine}`;
  const c4Message = `[Slack GROUP:${groupName}] ${userName} said: ${fullContent}${smartHint}`;

  await sendToC4({
    msgId: getMessageDedupKey(event),
    source: 'slack',
    endpoint,
    content: c4Message,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    hasTypingIndicator: isMention || !isSmartNoMention,
    isMention,
    messageType: ENDPOINT_TYPE.GROUP,
    senderName: userName,
  });
}

/**
 * Tell the user the agent will not answer this message (TRY_LATER /
 * MAYBE_LOST). Posted where a reply would go: the message's thread, as
 * scripts/send.js does. Only called for DMs and @-mentions
 * (shouldPostRejectNotice).
 */
async function sendRejectNotice(record, notice) {
  if (!record.channel) return;
  try {
    await sendText(record.channel, notice, { thread_ts: record.threadTs || record.ts });
  } catch (err) {
    console.error(`[slack] Reject notice for ${record.msgId} failed: ${err.message}`);
  }
}

async function clearFailedTypingIndicator(record) {
  if (!record.hasTypingIndicator || !record.channel || !record.ts) return;
  typingTrackers.delete(`${record.channel}-${record.ts}`);
  try {
    await removeReaction(record.channel, record.ts, 'hourglass_flowing_sand');
  } catch (error) {
    console.warn(`[slack] Failed to clear typing indicator for ${record.msgId}: ${error.message}`);
  }
}

// ── Typing Indicator ──

const typingTrackers = new Map(); // key: "channel-ts" -> { channel, ts, startTime }

function trackTyping(channel, ts) {
  const key = `${channel}-${ts}`;
  typingTrackers.set(key, { channel, ts, startTime: Date.now() });
}

function checkTypingDone() {
  const now = Date.now();
  for (const [key, tracker] of typingTrackers) {
    // Check for .done file
    const doneFile = path.join(TYPING_DIR, `${key}.done`);
    if (fs.existsSync(doneFile)) {
      removeReaction(tracker.channel, tracker.ts, 'hourglass_flowing_sand');
      typingTrackers.delete(key);
      try { fs.unlinkSync(doneFile); } catch {}
      continue;
    }

    // Timeout after 120s
    if (now - tracker.startTime > 120_000) {
      removeReaction(tracker.channel, tracker.ts, 'hourglass_flowing_sand');
      typingTrackers.delete(key);
    }
  }
}

// ── Helpers ──

function logMessage(channelId, entry) {
  const logFile = path.join(LOGS_DIR, `${channelId}.log`);
  const line = JSON.stringify({ ...entry, time: new Date().toISOString() });
  fs.appendFileSync(logFile, line + '\n');
}

// ── Graceful Shutdown ──

function shutdown() {
  console.log('[slack] Shutting down...');
  stopWatching();

  // Remove all typing indicators
  for (const [, tracker] of typingTrackers) {
    removeReaction(tracker.channel, tracker.ts, 'hourglass_flowing_sand').catch(() => {});
  }

  if (app) {
    app.stop().then(() => process.exit(0)).catch(() => process.exit(0));
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(err => {
  console.error('[slack] Fatal error:', err);
  process.exit(1);
});
