import fs from 'fs';
import path from 'path';
import { getClient } from './client.js';
import { DATA_DIR } from './config.js';

const MEDIA_DIR = path.join(DATA_DIR, 'media');

/**
 * Send a text message to a Slack channel.
 * @param {string} channel - Channel ID
 * @param {string} text - Message text
 * @param {object} opts - { thread_ts, reply_broadcast }
 * @returns {object} Slack API response
 */
export async function sendText(channel, text, opts = {}) {
  const client = getClient();
  const params = {
    channel,
    text,
  };
  if (opts.thread_ts) params.thread_ts = opts.thread_ts;
  if (opts.reply_broadcast) params.reply_broadcast = true;

  return client.chat.postMessage(params);
}

/**
 * Send a markdown-formatted message using Slack blocks.
 * @param {string} channel - Channel ID
 * @param {string} markdown - Markdown text (Slack mrkdwn)
 * @param {object} opts - { thread_ts }
 * @returns {object} Slack API response
 */
export async function sendMarkdown(channel, markdown, opts = {}) {
  const client = getClient();
  const params = {
    channel,
    text: markdown, // fallback for notifications
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: markdown.substring(0, 3000), // Slack block text limit
        }
      }
    ],
  };
  if (opts.thread_ts) params.thread_ts = opts.thread_ts;

  return client.chat.postMessage(params);
}

/**
 * Send a long message, chunking if necessary.
 * Slack limit: ~4000 chars for text, 3000 for mrkdwn blocks.
 * @param {string} channel - Channel ID
 * @param {string} text - Full message text
 * @param {object} opts - { thread_ts, useMarkdown }
 */
export async function sendLongMessage(channel, text, opts = {}) {
  const maxLen = opts.useMarkdown ? 2800 : 3800;
  const chunks = splitMessage(text, maxLen);
  let lastTs = opts.thread_ts;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const sendOpts = {};
    if (lastTs) sendOpts.thread_ts = lastTs;

    let res;
    if (opts.useMarkdown && hasMarkdown(chunk)) {
      res = await sendMarkdown(channel, chunk, sendOpts);
    } else {
      res = await sendText(channel, chunk, sendOpts);
    }

    // For DMs, use the first message's ts as thread for subsequent chunks
    if (i === 0 && !lastTs && res.ts) {
      lastTs = res.ts;
    }
  }
}

/**
 * Upload and send an image file.
 */
export async function sendImage(channel, filePath, opts = {}) {
  const client = getClient();
  const fileStream = fs.createReadStream(filePath);
  const filename = path.basename(filePath);

  const res = await client.filesUploadV2({
    channel_id: channel,
    file: fileStream,
    filename,
    thread_ts: opts.thread_ts,
  });
  return res;
}

/**
 * Upload and send a file.
 */
export async function sendFile(channel, filePath, opts = {}) {
  const client = getClient();
  const fileStream = fs.createReadStream(filePath);
  const filename = path.basename(filePath);

  const res = await client.filesUploadV2({
    channel_id: channel,
    file: fileStream,
    filename,
    thread_ts: opts.thread_ts,
  });
  return res;
}

/**
 * Download a Slack file to local media directory.
 * @param {string} url - Slack file URL (url_private_download)
 * @param {string} filename - Original filename
 * @returns {string} Local file path
 */
export async function downloadFile(url, filename) {
  const client = getClient();
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const localName = `slack-${timestamp}-${sanitized}`;
  const savePath = path.join(MEDIA_DIR, localName);

  // Verify path doesn't escape media dir
  const resolved = path.resolve(savePath);
  if (!resolved.startsWith(path.resolve(MEDIA_DIR))) {
    throw new Error('Path traversal detected');
  }

  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });

  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(savePath, buffer);

  return savePath;
}

/**
 * Add a reaction (emoji) to a message.
 */
export async function addReaction(channel, timestamp, emoji) {
  const client = getClient();
  try {
    await client.reactions.add({ channel, timestamp, name: emoji });
  } catch (err) {
    if (!err.data?.error?.includes('already_reacted')) {
      console.warn('[slack] Failed to add reaction:', err.message);
    }
  }
}

/**
 * Remove a reaction from a message.
 */
export async function removeReaction(channel, timestamp, emoji) {
  const client = getClient();
  try {
    await client.reactions.remove({ channel, timestamp, name: emoji });
  } catch (err) {
    // Ignore if reaction not found
  }
}

/**
 * Fetch recent messages from a channel for context.
 * @param {string} channel - Channel ID
 * @param {number} limit - Max messages to fetch
 * @param {string} [latest] - Latest timestamp bound
 * @returns {Array} Messages array (oldest first)
 */
export async function fetchHistory(channel, limit = 10, latest) {
  const client = getClient();
  const params = { channel, limit };
  if (latest) params.latest = latest;

  const res = await client.conversations.history(params);
  return (res.messages || []).reverse(); // oldest first
}

/**
 * Fetch thread replies.
 */
export async function fetchThread(channel, threadTs, limit = 10) {
  const client = getClient();
  const res = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit,
  });
  return (res.messages || []).slice(1); // exclude parent
}

/**
 * Get user info (display name).
 */
const userCache = new Map();

export async function getUserName(userId) {
  if (userCache.has(userId)) return userCache.get(userId);

  try {
    const client = getClient();
    const res = await client.users.info({ user: userId });
    const name = res.user?.profile?.display_name
      || res.user?.profile?.real_name
      || res.user?.name
      || userId;
    userCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

// ── Helpers ──

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at newline
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
}

function hasMarkdown(text) {
  return /```|^\s*#{1,3}\s|\*\*|__|\|.*\|.*\|/m.test(text);
}
