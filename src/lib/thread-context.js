/**
 * Thread context for a channel message inside a Slack thread.
 *
 * In multi-session mode every channel thread is its own session group
 * (group-<channel>:topic-<thread_ts>), so the first message there would not
 * see the thread's root or earlier replies. This builds a <thread-context>
 * block from conversations.replies: the root message plus the most recent
 * replies before the current message. Pages are read from the oldest end and
 * capped at MAX_PAGES (1000 messages), so in a longer thread the newest replies
 * may be missing (known limitation).
 *
 * Only a multi-session Core gets it (buildGroupContext): on an older Core the
 * content stays exactly what 0.1.3 sent (the in-memory <group-context>).
 */

import { withTimeout } from './timeout.js';

const MAX_PAGES = 5;
const PAGE_SIZE = 200;

/**
 * Thread context is fetched before the message is delivered, so it is bounded:
 * each Slack call times out after THREAD_CONTEXT_REQUEST_TIMEOUT_MS (on a
 * createLookupClient client: no retries, rate limits fail at once) and the whole
 * fetch-and-format step gives up after THREAD_CONTEXT_DEADLINE_MS. On failure
 * the caller falls back to its in-memory context.
 */
export const THREAD_CONTEXT_REQUEST_TIMEOUT_MS = 3000;
export const THREAD_CONTEXT_DEADLINE_MS = 5000;

/**
 * Compare two Slack timestamps ("1763280000.123456") without float rounding.
 * @returns {number} <0, 0 or >0
 */
export function compareSlackTs(a, b) {
  const [aSec = '0', aFrac = ''] = String(a).split('.');
  const [bSec = '0', bFrac = ''] = String(b).split('.');
  const width = Math.max(aFrac.length, bFrac.length);
  const left = BigInt(aSec + aFrac.padEnd(width, '0'));
  const right = BigInt(bSec + bFrac.padEnd(width, '0'));
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Fetch all messages of a thread (root first), bounded to MAX_PAGES pages.
 * @param {object} client - Slack WebClient
 * @returns {Promise<object[]>}
 */
export async function fetchThreadMessages(client, channel, threadTs, { maxPages = MAX_PAGES } = {}) {
  const messages = [];
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await client.conversations.replies({
      channel, ts: threadTs, limit: PAGE_SIZE, ...(cursor && { cursor }),
    });
    messages.push(...(res.messages || []));
    cursor = res.response_metadata?.next_cursor;
    if (!res.has_more || !cursor) break;
  }
  return messages;
}

/**
 * Build the <thread-context> block for a message in a thread.
 * @param {object} opts
 * @param {string} opts.threadTs
 * @param {string} opts.currentTs - ts of the message being delivered (excluded)
 * @param {object[]} opts.messages - conversations.replies messages
 * @param {number} opts.limit - number of earlier replies to keep
 * @param {function} opts.getUserName - userId -> Promise<string>
 * @returns {Promise<string>} '' when there is nothing to show
 */
export async function formatThreadContext({ threadTs, currentTs, messages, limit, getUserName }) {
  const seen = new Set();
  let root = null;
  const replies = [];
  for (const m of messages || []) {
    if (!m?.ts || seen.has(m.ts)) continue;
    seen.add(m.ts);
    if (m.ts === threadTs) root = m;
    else if (m.ts !== currentTs && compareSlackTs(m.ts, currentTs) < 0) replies.push(m);
  }
  replies.sort((a, b) => compareSlackTs(a.ts, b.ts));
  const recent = limit > 0 ? replies.slice(-limit) : [];

  const nameOf = async m => (m.user ? await getUserName(m.user) : (m.username || 'bot'));
  const lines = [];
  if (root && root.ts !== currentTs) {
    lines.push(`[thread root] ${await nameOf(root)}: ${root.text || '(media)'}`);
  }
  if (replies.length > recent.length) {
    lines.push(`(${replies.length - recent.length} earlier replies omitted)`);
  }
  for (const m of recent) lines.push(`${await nameOf(m)}: ${m.text || '(media)'}`);
  if (lines.length === 0) return '';
  return `<thread-context>\n${lines.join('\n')}\n</thread-context>\n\n`;
}

/**
 * Fetch and format the <thread-context> for a channel thread message, bounded
 * by `deadlineMs`. Never throws.
 * @param {object} opts
 * @param {object} opts.client - Slack WebClient (use createLookupClient)
 * @param {string} opts.channel
 * @param {string} opts.threadTs
 * @param {string} opts.currentTs
 * @param {number} opts.limit
 * @param {function} opts.getUserName
 * @param {number} [opts.deadlineMs]
 * @param {function} [opts.onError] - (err) => void
 * @returns {Promise<string>} '' on failure, timeout or nothing to show
 */
export async function buildChannelThreadContext({
  client, channel, threadTs, currentTs, limit, getUserName,
  deadlineMs = THREAD_CONTEXT_DEADLINE_MS, onError,
}) {
  try {
    return await withTimeout((async () => {
      const messages = await fetchThreadMessages(client, channel, threadTs);
      return formatThreadContext({ threadTs, currentTs, messages, limit, getUserName });
    })(), deadlineMs, 'thread context');
  } catch (err) {
    onError?.(err);
    return '';
  }
}

/**
 * The context block of a channel message.
 * - Multi-session Core (`supportsSessionGroup`) and a message inside a thread:
 *   the thread is its own session group, so use the Slack thread context
 *   (`fetchThreadContext()`), falling back to the in-memory history when that
 *   returns ''.
 * - Otherwise (older Core, or a top-level message): the in-memory history
 *   exactly as in 0.1.3; `fetchThreadContext` is not called.
 * @param {object} opts
 * @param {object} opts.event - Slack message event (ts, thread_ts)
 * @param {object[]} opts.history - in-memory history incl. the current message
 * @param {number} opts.limit
 * @param {boolean} opts.supportsSessionGroup
 * @param {function} opts.fetchThreadContext - () => Promise<string>
 * @returns {Promise<string>}
 */
export async function buildGroupContext({ event, history, limit, supportsSessionGroup, fetchThreadContext }) {
  if (supportsSessionGroup && event.thread_ts && event.thread_ts !== event.ts) {
    const threadContext = await fetchThreadContext();
    if (threadContext) return threadContext;
  }
  const contextMsgs = history.slice(-limit - 1, -1); // exclude current
  if (contextMsgs.length === 0) return '';
  const lines = contextMsgs.map(m => `${m.from}: ${m.text}`);
  return `<group-context>\n${lines.join('\n')}\n</group-context>\n\n`;
}
