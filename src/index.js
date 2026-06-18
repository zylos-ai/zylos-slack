#!/usr/bin/env node

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { exec, execFile } from 'child_process';
import { App } from '@slack/bolt';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, watchConfig, stopWatching, saveConfig, DATA_DIR } from './lib/config.js';
import { initClient, fetchBotIdentity, getBotUserId } from './lib/client.js';
import {
  addReaction, removeReaction, downloadFile, getUserName,
  fetchHistory, fetchThread, sendText,
} from './lib/message.js';
import {
  REVIEW_FINDING_ACTION_IDS,
  canUseReviewFindingAction,
  postReviewFindingActionThreadReply,
  respondToAction,
  resolveReviewFindingWorkflowBin,
  reviewFindingActionThreadReplyResponse,
} from './lib/review-finding-actions.js';

// ── Constants ──

const C4_RECEIVE = path.join(process.env.HOME,
  'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const TYPING_DIR = path.join(DATA_DIR, 'typing');
const REVIEW_FINDING_ACTION_DIR = path.join(DATA_DIR, 'review-finding-actions');
const REVIEW_FINDING_WORKFLOW_BIN = resolveReviewFindingWorkflowBin();
const REVIEW_FINDING_WORKFLOW_COMMAND = process.env.REVIEW_FINDING_WORKFLOW_COMMAND
  || 'computelabs-agent-workflow';

const DEDUP_TTL = 5 * 60 * 1000; // 5 minutes
const dedupMap = new Map();

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

if (config.connection_mode === 'socket' && !appToken) {
  console.error('[slack] SLACK_APP_TOKEN not set in .env (required for Socket Mode)');
  process.exit(1);
}

// Initialize client
initClient(botToken);

// Ensure directories exist
[LOGS_DIR, MEDIA_DIR, TYPING_DIR, REVIEW_FINDING_ACTION_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

// Matches an explicit @mention of the bot, tolerating Slack's optional
// `<@U123|displayname>` piped form. Used by BOTH the message and app_mention
// handlers so their detection can never drift apart — divergence would silently
// break the shared-dedup exactly-once guarantee.
function isExplicitMention(text, botId) {
  if (!botId || !text) return false;
  return new RegExp(`<@${botId}(\\|[^>]+)?>`).test(text);
}

// ── Main ──

async function main() {
  // Fetch bot identity
  const bot = await fetchBotIdentity();

  // Build Bolt app options
  const appOpts = {
    token: botToken,
    appToken: config.connection_mode === 'socket' ? appToken : undefined,
    socketMode: config.connection_mode === 'socket',
    port: config.connection_mode === 'webhook' ? config.webhook_port : undefined,
  };

  app = new App(appOpts);

  for (const actionId of REVIEW_FINDING_ACTION_IDS) {
    app.action(actionId, handleReviewFindingAction);
  }

  // ── Event: Direct Message ──
  app.event('message', async ({ event, say }) => {
    // Ignore bot's own messages and noisy subtypes (edits, joins, etc.).
    // IMPORTANT: file uploads arrive with subtype === 'file_share' — must let them through.
    if (event.bot_id) return;
    if (event.subtype && event.subtype !== 'file_share') return;
    if (event.user === getBotUserId()) return;

    // Dedup
    const msgKey = event.client_msg_id || `${event.channel}-${event.ts}`;
    if (dedupMap.has(msgKey)) return;
    dedupMap.set(msgKey, Date.now());

    const channelType = event.channel_type; // 'im' for DM, 'channel'/'group' for channels

    if (channelType === 'im') {
      await handleDM(event);
    } else {
      // Detect @mentions from the always-delivered `message` event instead of relying
      // solely on the `app_mention` event. app_mention can silently stop being delivered
      // after a socket reconnect; deferring to it would then drop every mention here.
      // The app_mention handler dedups on the same `mention-` key; each handler sets that
      // key synchronously before its first await, so whichever runs first wins and the
      // other no-ops — exactly once, no double-dispatch / ghost [SKIP]. Keep the
      // dedupMap.set above any await.
      const isMention = isExplicitMention(event.text, getBotUserId());
      if (isMention) {
        const mentionKey = `mention-${event.channel}-${event.ts}`;
        if (dedupMap.has(mentionKey)) return;
        dedupMap.set(mentionKey, Date.now());
        console.log(`[slack] @mention via message event (ts=${event.ts})`);
        await handleGroupMessage(event, true);
      } else {
        await handleGroupMessage(event, false);
      }
    }
  });

  // ── Event: App Mention (in channels) ──
  app.event('app_mention', async ({ event }) => {
    if (event.bot_id || event.user === getBotUserId()) return;

    // Slack fires app_mention for thread replies where the bot was previously mentioned,
    // even without a new explicit @mention. Only process true @mentions.
    if (!isExplicitMention(event.text, getBotUserId())) return;

    const msgKey = `mention-${event.channel}-${event.ts}`;
    if (dedupMap.has(msgKey)) return;
    dedupMap.set(msgKey, Date.now());

    console.log(`[slack] app_mention event fired (ts=${event.ts})`);
    await handleGroupMessage(event, true);
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

  // Cleanup dedup map periodically
  setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of dedupMap) {
      if (now - ts > DEDUP_TTL) dedupMap.delete(key);
    }
  }, 60_000);

  // Typing indicator check (every 2s)
  setInterval(checkTypingDone, 2000);
}

// ── Review Finding Button Handler ──

async function handleReviewFindingAction({ ack, body, respond }) {
  await ack();

  const action = body?.actions?.find(item => REVIEW_FINDING_ACTION_IDS.has(item.action_id));
  if (!action) return;

  const actorId = body?.user?.id || '';
  const channelId = body?.channel?.id || body?.container?.channel_id || '';
  if (!canUseReviewFindingAction(actorId, channelId, config)) {
    console.warn(`[slack] Review finding action rejected for ${actorId || 'unknown'} in ${channelId || 'unknown-channel'}`);
    await respondToAction(respond, {
      response_type: 'ephemeral',
      text: 'You are not configured to approve or reject auto-review findings from this Slack card.',
    });
    return;
  }

  try {
    const result = await runReviewFindingWorkflowAction(body);
    const threadReply = reviewFindingActionThreadReplyResponse(result, action);
    if (threadReply) {
      await postReviewFindingActionThreadReply(body, threadReply, sendText);
    }
  } catch (err) {
    console.error('[slack] Review finding action failed:', err.message);
    if (err.stderr) console.error(err.stderr);
    await respondToAction(respond, {
      response_type: 'ephemeral',
      text: `Review finding action failed: ${err.message}`,
    });
  }
}

async function runReviewFindingWorkflowAction(payload) {
  const payloadFile = path.join(
    REVIEW_FINDING_ACTION_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(payloadFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });

  const args = [
    REVIEW_FINDING_WORKFLOW_COMMAND,
    'handle-review-finding-action',
    '--agent',
    'cl-zylos-auto-reviewer',
    '--payload-file',
    payloadFile,
  ];

  const stdout = await execFileAsync(REVIEW_FINDING_WORKFLOW_BIN, args, {
    encoding: 'utf8',
    timeout: 120_000,
  });
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`review finding workflow returned invalid JSON: ${err.message}`);
  }
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
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
    if (config.dmPolicy === 'owner') {
      console.log(`[slack] DM rejected (owner-only): ${userName}`);
      return;
    }
    if (config.dmPolicy === 'allowlist' && !config.dmAllowFrom.includes(userId)) {
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
  const endpoint = buildEndpoint(event.channel, 'dm', event.ts, event.thread_ts);

  // Log
  logMessage(event.channel, { from: userName, userId, text: content, ts: event.ts });

  // Format for C4
  const attachmentBlock = fileLine
    ? `\n\n<attachments>\nUser attached file(s). Use the Read tool on each absolute path below to view the contents:${fileLine}\n</attachments>`
    : '';
  const fullContent = `<current-message>\n${threadContext}${content}\n</current-message>${attachmentBlock}`;
  const c4Message = `[Slack DM] ${userName} said: ${fullContent}`;

  // Send to C4
  sendToC4('slack', endpoint, c4Message, (rejectMsg) => {
    removeReaction(event.channel, event.ts, 'hourglass_flowing_sand');
    console.warn(`[slack] C4 rejected DM from ${userName}: ${rejectMsg}`);
  });
}

// ── Group Message Handler ──

async function handleGroupMessage(event, isMention = false) {
  const channelId = event.channel;
  const userId = event.user;
  const userName = await getUserName(userId);
  const isOwner = userId === config.owner?.user_id;

  // Check group policy
  if (config.groupPolicy === 'disabled' && !isOwner) {
    return;
  }

  const groupConfig = config.groups?.[channelId];

  if (config.groupPolicy === 'allowlist') {
    if (!groupConfig && !isOwner) return;
  }

  // Per-group sender check
  if (groupConfig?.allowFrom?.length > 0 && !isOwner) {
    if (!groupConfig.allowFrom.includes(userId)) return;
  }

  const mode = groupConfig?.mode || 'mention';
  const groupName = groupConfig?.name || channelId;

  // In mention mode, only respond to @mentions
  if (mode === 'mention' && !isMention && !isOwner) return;

  // Smart mode: receive all but flag non-mentions
  const isSmartNoMention = mode === 'smart' && !isMention;

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

  const text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim(); // strip @mentions
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
  const endpoint = buildEndpoint(channelId, 'group', event.ts, event.thread_ts);

  // Log
  logMessage(channelId, { from: userName, userId, text: content, ts: event.ts });

  // Response directive: a direct @mention is mandatory to answer; a smart-mode
  // non-mention is optional — the agent reads it and decides whether it can help.
  let smartHint = '';
  if (isMention) {
    smartHint = '\n(You were directly @mentioned — you MUST reply. Do not respond with [SKIP].)';
  } else if (isSmartNoMention) {
    smartHint = '\n(No @mention. Read the message and decide: reply only if you can genuinely help, otherwise reply with exactly [SKIP].)';
  }

  const attachmentBlock = fileLine
    ? `\n\n<attachments>\nUser attached file(s). Use the Read tool on each absolute path below to view the contents:${fileLine}\n</attachments>`
    : '';
  const fullContent = `<current-message>\n${groupContext}${content}\n</current-message>${attachmentBlock}`;
  const c4Message = `[Slack GROUP:${groupName}] ${userName} said: ${fullContent}${smartHint}`;

  sendToC4('slack', endpoint, c4Message, (rejectMsg) => {
    if (isMention || !isSmartNoMention) {
      removeReaction(event.channel, event.ts, 'hourglass_flowing_sand');
    }
    console.warn(`[slack] C4 rejected group msg from ${userName}: ${rejectMsg}`);
  });
}

// ── C4 Integration ──

function sendToC4(source, endpoint, content, onReject) {
  const safeContent = content.replace(/'/g, "'\\''");
  const cmd = `node "${C4_RECEIVE}" --channel "${source}" --endpoint "${endpoint}" --json --content '${safeContent}'`;

  const timeout = 35_000;

  exec(cmd, { encoding: 'utf8', timeout }, (error, stdout) => {
    if (!error) {
      console.log(`[slack] Sent to C4: ${content.substring(0, 60)}...`);
      return;
    }

    // Handle rejection
    try {
      const response = JSON.parse(error.stdout || stdout);
      if (response?.ok === false) {
        console.warn(`[slack] C4 rejected: ${response.error?.message}`);
        if (onReject) onReject(response.error?.message);
        return;
      }
    } catch {}

    // Retry once after 2s
    console.warn(`[slack] C4 send failed, retrying: ${error.message}`);
    setTimeout(() => {
      exec(cmd, { encoding: 'utf8', timeout }, (retryError) => {
        if (!retryError) return;
        try {
          const response = JSON.parse(retryError.stdout);
          if (response?.ok === false && onReject) {
            onReject(response.error?.message);
          }
        } catch {}
      });
    }, 2000);
  });
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
