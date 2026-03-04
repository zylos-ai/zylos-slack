#!/usr/bin/env node

/**
 * C4 outbound interface for Slack.
 *
 * Usage:
 *   node send.js <endpoint> <message>
 *   node send.js <endpoint> "[MEDIA:image]/path/to/image.png"
 *   node send.js <endpoint> "[MEDIA:file]/path/to/doc.pdf"
 *
 * Endpoint format:
 *   channelId|type:dm|msg:timestamp|thread:threadTs
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { initClient } from '../src/lib/client.js';
import { getConfig, DATA_DIR } from '../src/lib/config.js';
import {
  sendText, sendMarkdown, sendLongMessage,
  sendImage, sendFile,
} from '../src/lib/message.js';

const TYPING_DIR = path.join(DATA_DIR, 'typing');

// Parse arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: send.js <endpoint> <message>');
  process.exit(1);
}

const endpointRaw = args[0];
const message = args.slice(1).join(' ');

// Parse endpoint
function parseEndpoint(ep) {
  const parts = ep.split('|');
  const result = { channel: parts[0] };
  for (const part of parts.slice(1)) {
    const [key, val] = part.split(':');
    result[key] = val;
  }
  return result;
}

const endpoint = parseEndpoint(endpointRaw);

// Check for [SKIP] (smart group: no response needed)
if (message.trim() === '[SKIP]') {
  markTypingDone(endpoint);
  process.exit(0);
}

// Initialize client
const botToken = process.env.SLACK_BOT_TOKEN;
if (!botToken) {
  console.error('[send] SLACK_BOT_TOKEN not set');
  process.exit(1);
}

initClient(botToken);

const config = getConfig();

// Check for media
const mediaMatch = message.match(/^\[MEDIA:(\w+)\](.+)$/);

async function send() {
  try {
    const channel = endpoint.channel;
    const threadTs = endpoint.thread || endpoint.msg;
    const opts = {};
    if (threadTs) opts.thread_ts = threadTs;

    if (mediaMatch) {
      const [, mediaType, mediaPath] = mediaMatch;
      const cleanPath = mediaPath.trim();

      if (!fs.existsSync(cleanPath)) {
        console.error(`[send] File not found: ${cleanPath}`);
        process.exit(1);
      }

      if (mediaType === 'image') {
        await sendImage(channel, cleanPath, opts);
      } else {
        await sendFile(channel, cleanPath, opts);
      }
    } else {
      // Text message
      await sendLongMessage(channel, message, {
        thread_ts: opts.thread_ts,
        useMarkdown: config.message?.useMarkdown ?? true,
      });
    }

    // Mark typing done
    markTypingDone(endpoint);
    process.exit(0);
  } catch (err) {
    console.error(`[send] Error: ${err.message}`);
    process.exit(1);
  }
}

function markTypingDone(ep) {
  const key = `${ep.channel}-${ep.msg}`;
  const doneFile = path.join(TYPING_DIR, `${key}.done`);
  try {
    fs.mkdirSync(TYPING_DIR, { recursive: true });
    fs.writeFileSync(doneFile, Date.now().toString());
  } catch {}
}

send();
