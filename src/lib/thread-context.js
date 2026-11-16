/**
 * Thread context for a channel message inside a Slack thread.
 *
 * In multi-session mode every channel thread is its own session group
 * (group-<channel>:topic-<thread_ts>), so the first message there would not
 * see the thread's root or earlier replies. This builds a <thread-context>
 * block from conversations.replies: the root message plus the most recent
 * replies before the current message.
 */

const MAX_PAGES = 5;
const PAGE_SIZE = 200;

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
