#!/usr/bin/env node

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { App } from '@slack/bolt';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, watchConfig, stopWatching, saveConfig, DATA_DIR } from './lib/config.js';
import { initClient, fetchBotIdentity, getBotUserId } from './lib/client.js';
import {
  addReaction, removeReaction, downloadFile, getUserName,
  fetchHistory, fetchThread,
} from './lib/message.js';
import {
  getMessageDedupKey, isBotMentioned, resolveUserMentions, shouldHandleGroupMessage,
} from './lib/mentions.js';
import {
  CONNECTION_MODE, DM_POLICY, ENDPOINT_TYPE, GROUP_MODE, SLACK_CHANNEL_TYPE,
} from './lib/constants.js';
import { createC4Deliverer } from './lib/c4-delivery.js';
import { MessageDeduplicator } from './lib/dedup.js';
import { createDeliveryOutbox } from './lib/delivery-outbox.js';
import { isGroupAccessAllowed } from './lib/policy.js';
import { createReliableDeliveryQueue } from './lib/reliable-delivery-queue.js';

// ── Constants ──

const C4_RECEIVE = path.join(process.env.HOME,
  'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const TYPING_DIR = path.join(DATA_DIR, 'typing');
const DELIVERY_JOURNAL = path.join(DATA_DIR, 'delivery.jsonl');

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

// Ensure directories exist
[LOGS_DIR, MEDIA_DIR, TYPING_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

const c4DeliveryOutbox = createDeliveryOutbox({
  journalPath: DELIVERY_JOURNAL,
  onError: message => console.error(`[slack] Delivery journal: ${message}`),
  onAmbiguousDelivery: (msgId, error) => {
    console.error(`[slack] C4 accepted ${msgId}, but delivered state was not persisted: ${error.message}`);
  },
});

const deliverToC4 = createC4Deliverer({ scriptPath: C4_RECEIVE });
const c4DeliveryQueue = createReliableDeliveryQueue({
  outbox: c4DeliveryOutbox,
  deliver: deliverToC4,
  onDelivered: record => {
    console.log(`[slack] Sent to C4: ${record.content.substring(0, 60)}...`);
  },
  onRetry: (record, error, attempts, delay) => {
    console.warn(`[slack] C4 delivery ${record.msgId} failed (${error.code}), retry ${attempts} in ${delay}ms: ${error.message}`);
  },
  onDeadLetter: async (record, error, attempts) => {
    console.error(`[slack] C4 delivery ${record.msgId} moved to dead letter after ${attempts} attempt(s) (${error.code}): ${error.message}`);
    await clearFailedTypingIndicator(record);
  },
  onAmbiguousDelivery: (record, error) => {
    console.error(`[slack] Delivery ${record.msgId} remains pending after an ambiguous C4 acknowledgement: ${error.message}`);
  },
  onPersistenceError: (record, error) => {
    console.error(`[slack] Failed to persist delivery state for ${record.msgId}: ${error.message}`);
  },
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
    // Ignore bot's own messages, subtypes (edits, joins, etc.)
    if (event.bot_id || event.subtype) return;
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

  const recoveredDeliveries = c4DeliveryQueue.start();
  if (recoveredDeliveries > 0) {
    console.warn(`[slack] Recovering ${recoveredDeliveries} pending C4 delivery record(s)`);
  }

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
      const replies = await fetchThread(event.channel, event.thread_ts, 5);
      if (replies.length > 0) {
        const lines = [];
        for (const r of replies) {
          if (r.ts === event.ts) continue;
          const rName = r.user ? await getUserName(r.user) : 'bot';
          lines.push(`${rName}: ${r.text || '(media)'}`);
        }
        if (lines.length > 0) {
          threadContext = `<thread-context>\n${lines.join('\n')}\n</thread-context>\n\n`;
        }
      }
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

  queueC4Delivery({
    msgId: getMessageDedupKey(event),
    source: 'slack',
    endpoint,
    content: c4Message,
    channel: event.channel,
    ts: event.ts,
    hasTypingIndicator: true,
    messageType: ENDPOINT_TYPE.DIRECT_MESSAGE,
    senderName: userName,
  });
}

// ── Group Message Handler ──

async function handleGroupMessage(event, isMention = false) {
  const channelId = event.channel;
  const userId = event.user;
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

  // Build group context
  const contextLimit = groupConfig?.historyLimit || config.message.context_messages;
  const contextMsgs = history.slice(-contextLimit - 1, -1); // exclude current
  let groupContext = '';
  if (contextMsgs.length > 0) {
    const lines = contextMsgs.map(m => `${m.from}: ${m.text}`);
    groupContext = `<group-context>\n${lines.join('\n')}\n</group-context>\n\n`;
  }

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

  queueC4Delivery({
    msgId: getMessageDedupKey(event),
    source: 'slack',
    endpoint,
    content: c4Message,
    channel: event.channel,
    ts: event.ts,
    hasTypingIndicator: isMention || !isSmartNoMention,
    messageType: ENDPOINT_TYPE.GROUP,
    senderName: userName,
  });
}

// ── C4 Integration ──

function queueC4Delivery(record) {
  const result = c4DeliveryQueue.enqueue(record);
  if (result.status === 'pending' && !result.retry) {
    console.log(`[slack] Persisted C4 delivery ${record.msgId}`);
  }
  return result;
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

function buildEndpoint(channel, type, msgTs, threadTs) {
  let ep = `${channel}|type:${type}|msg:${msgTs}`;
  if (threadTs) ep += `|thread:${threadTs}`;
  return ep;
}

function logMessage(channelId, entry) {
  const logFile = path.join(LOGS_DIR, `${channelId}.log`);
  const line = JSON.stringify({ ...entry, time: new Date().toISOString() });
  fs.appendFileSync(logFile, line + '\n');
}

// ── Graceful Shutdown ──

function shutdown() {
  console.log('[slack] Shutting down...');
  stopWatching();
  c4DeliveryQueue.stop();

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
