/**
 * Structured endpoint strings passed to c4-receive and back to scripts/send.js.
 *
 * Format: channelId|type:<dm|group>|msg:<ts>[|thread:<thread_ts>]
 *
 * buildEndpoint is the inbound builder used by src/index.js; its output must
 * not change (it is the `reply via` value and scripts/send.js parses it).
 * parseEndpoint reads only the known keys (type, msg, thread); unknown keys and
 * parts without a key are ignored, and a bare id without `|` yields just
 * `{ channel }`. A value runs to the end of its part, so a colon inside a value
 * is kept (Slack ids and timestamps never contain one).
 */

const ENDPOINT_KEYS = new Set(['type', 'msg', 'thread']);

/**
 * Build the structured endpoint string for C4.
 * @param {string} channel - Slack conversation id (C…, G…, D…)
 * @param {string} type - 'dm' | 'group'
 * @param {string} msgTs - ts of the inbound message
 * @param {string} [threadTs] - thread_ts when the message is in a thread
 * @returns {string}
 */
export function buildEndpoint(channel, type, msgTs, threadTs) {
  let ep = `${channel}|type:${type}|msg:${msgTs}`;
  if (threadTs) ep += `|thread:${threadTs}`;
  return ep;
}

/**
 * Parse a structured endpoint string.
 * @param {string} endpoint
 * @returns {{channel: string, type?: string, msg?: string, thread?: string}}
 */
export function parseEndpoint(endpoint) {
  const parts = String(endpoint ?? '').split('|');
  const result = { channel: parts[0] };
  for (const part of parts.slice(1)) {
    const colonIdx = part.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = part.substring(0, colonIdx);
    if (!ENDPOINT_KEYS.has(key)) continue;
    result[key] = part.substring(colonIdx + 1);
  }
  return result;
}
