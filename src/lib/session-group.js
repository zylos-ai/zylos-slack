/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * The group name is derived only from the reply endpoint, so the inbound
 * `--session-group` value and `scripts/session-group.js <endpoint>` always
 * agree. Rules:
 *   DM (type:dm)                          -> dm-<channel>                     (threads not split)
 *   channel / private channel / group DM
 *     (type:group), no thread             -> group-<channel>
 *   type:group with thread                -> group-<channel>:topic-<thread_ts>
 *
 * These names are Core's memory keys. The rules are FIXED once live: changing
 * them needs a migration planned together with Core, otherwise existing
 * groups lose their memory.
 *
 * The per-message part of the endpoint (msg) never takes part. Nothing is
 * guessed, rewritten, truncated or hashed: an endpoint without a known type,
 * an id with unexpected characters, or a name Core would reject throws. The
 * component never adds the `slack:` namespace; Core does.
 *
 * A bare id (no `|`, as used for proactive sends) is resolved by
 * resolveSessionGroup:
 * - a conversation id (C…/G…/D…): DM or group comes from a local cache
 *   (written by index.js for every inbound message and after each successful
 *   lookup) or, on a miss, from Slack conversations.info. The id prefix is not
 *   used to tell a DM from a channel. It maps to dm-<id> or group-<id>, never
 *   to a topic.
 * - a user id (U…/W…): the 1:1 DM channel comes from the cache (recorded for
 *   every inbound DM) or from conversations.open; it maps to dm-<D…>, the same
 *   group as the inbound DM. A user id is the only thing recognized by prefix
 *   (Slack user ids start with U or W; conversation ids never do).
 * If a lookup fails, nothing is guessed: it throws.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { ENDPOINT_TYPE } from './constants.js';
import { parseEndpoint } from './endpoint.js';
import { withTimeout } from './timeout.js';

/** Core's limits for the name a component passes (Core adds `<namespace>:`). */
export const SESSION_GROUP_MAX_LENGTH = 95;
export const SESSION_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** Slack conversation and user ids, e.g. C0123ABCD, D0123ABCD, U0123ABCD. */
const SLACK_ID = /^[A-Z0-9]+$/;
/** Slack user ids (U… or W… for Enterprise Grid). */
const SLACK_USER_ID = /^[UW][A-Z0-9]+$/;
/** Slack message timestamps, e.g. 1763280000.123456 */
const SLACK_TS = /^\d+\.\d+$/;

/**
 * Whether Core would accept this nonempty name.
 * @param {string} name
 * @returns {boolean}
 */
export function isValidSessionGroup(name) {
  return typeof name === 'string' && name.length <= SESSION_GROUP_MAX_LENGTH
    && SESSION_GROUP_PATTERN.test(name);
}

/** @returns {boolean} true for a Slack user id (U…/W…) */
export function isSlackUserId(id) {
  return typeof id === 'string' && SLACK_USER_ID.test(id);
}

const quote = (value, max = 64) => JSON.stringify(String(value ?? '').slice(0, max));

/**
 * Derive the in-group session name from an endpoint string.
 * @param {string} endpoint - e.g. "C0123ABCD|type:group|msg:1763280000.000200|thread:1763280000.000100"
 * @returns {string} group name without namespace (never '')
 * @throws {Error} when the endpoint cannot be mapped
 */
export function sessionGroupFromEndpoint(endpoint) {
  if (typeof endpoint !== 'string') {
    throw new Error(`endpoint must be a string: ${quote(endpoint)}`);
  }
  const parsed = parseEndpoint(endpoint);
  const channel = parsed.channel;
  if (!SLACK_ID.test(channel)) {
    throw new Error(`invalid Slack conversation id in endpoint: ${quote(endpoint)}`);
  }
  if (isSlackUserId(channel)) {
    throw new Error(`endpoint names a user id, not a conversation (resolve it to its DM first): ${quote(endpoint)}`);
  }

  let name;
  if (parsed.type === ENDPOINT_TYPE.DIRECT_MESSAGE) {
    name = `dm-${channel}`;
  } else if (parsed.type === ENDPOINT_TYPE.GROUP) {
    const thread = parsed.thread;
    if (thread === undefined) {
      name = `group-${channel}`;
    } else if (!SLACK_TS.test(thread)) {
      throw new Error(`invalid thread_ts in endpoint: ${quote(thread, 32)}`);
    } else {
      name = `group-${channel}:topic-${thread}`;
    }
  } else if (parsed.type === undefined) {
    throw new Error(`endpoint has no type, cannot tell DM from group: ${quote(endpoint)}`);
  } else {
    throw new Error(`unknown conversation type in endpoint: ${quote(parsed.type, 32)}`);
  }

  if (!isValidSessionGroup(name)) {
    throw new Error(`session group would be invalid for Core (length ${name.length}, max ${SESSION_GROUP_MAX_LENGTH})`);
  }
  return name;
}

// ============================================================
// Bare ids: conversation type cache + Slack lookup
// ============================================================

/**
 * id -> 'dm' | 'group' for conversations, 'dm:<D…>' for users
 * e.g. { "D1": "dm", "C1": "group", "U1": "dm:D1" }
 */
export const CHAT_TYPE_CACHE_PATH = path.join(DATA_DIR, 'chat-type-cache.json');
// Core's runner kills the session-group query after 5s; this lookup, plus Node
// and Slack SDK startup, stays well under it so a slow Slack API fails cleanly
// here instead of being cut off.
export const CHAT_LOOKUP_TIMEOUT_MS = 3000;

const CONVERSATION_TYPES = new Set([ENDPOINT_TYPE.DIRECT_MESSAGE, ENDPOINT_TYPE.GROUP]);
const USER_DM_PREFIX = `${ENDPOINT_TYPE.DIRECT_MESSAGE}:`;

function isValidCacheEntry(id, value) {
  if (!SLACK_ID.test(String(id ?? '')) || typeof value !== 'string') return false;
  if (isSlackUserId(id)) {
    const dm = value.startsWith(USER_DM_PREFIX) ? value.slice(USER_DM_PREFIX.length) : '';
    return SLACK_ID.test(dm) && !isSlackUserId(dm);
  }
  return CONVERSATION_TYPES.has(value);
}

/**
 * Conversation type for a Slack conversations.info `channel` object.
 * @param {object} channel
 * @returns {'dm'|'group'|null} null when Slack says neither
 */
export function chatTypeFromConversation(channel) {
  if (!channel || typeof channel !== 'object') return null;
  if (channel.is_im === true) return ENDPOINT_TYPE.DIRECT_MESSAGE;
  if (channel.is_mpim === true || channel.is_channel === true || channel.is_group === true) {
    return ENDPOINT_TYPE.GROUP;
  }
  return null;
}

/**
 * Read the cache. A missing, unreadable or malformed file is an empty cache.
 * @param {string} [cachePath]
 * @returns {Record<string, string>}
 */
export function readChatTypeCache(cachePath = CHAT_TYPE_CACHE_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  return {};
}

/**
 * Record a conversation's type ('dm' | 'group') or a user's DM channel
 * ('dm:<D…>'), tmp + rename. Writes only when the entry changes. Caching is an
 * optimization: invalid input or a failed write is ignored.
 * @param {string} id
 * @param {string} value
 * @param {string} [cachePath]
 * @returns {boolean} true when the file was written
 */
export function recordChatType(id, value, cachePath = CHAT_TYPE_CACHE_PATH) {
  if (!isValidCacheEntry(id, value)) return false;
  const cache = readChatTypeCache(cachePath);
  if (cache[id] === value) return false;
  cache[id] = value;
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2));
    fs.renameSync(tmpPath, cachePath);
    return true;
  } catch {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    return false;
  }
}

/** Record a user's 1:1 DM channel (inbound DMs and successful opens). */
export function recordUserDm(userId, dmChannel, cachePath = CHAT_TYPE_CACHE_PATH) {
  return recordChatType(userId, `${USER_DM_PREFIX}${dmChannel}`, cachePath);
}

let lookupClient = null;
async function getLookupClient() {
  if (lookupClient) return lookupClient;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN not set');
  // Dynamic import keeps the Slack SDK out of the module load path, so the
  // inbound mapping stays testable without credentials.
  const { createLookupClient } = await import('./client.js');
  lookupClient = createLookupClient(token, { timeoutMs: CHAT_LOOKUP_TIMEOUT_MS });
  return lookupClient;
}

async function defaultFetchConversation(channelId) {
  const client = await getLookupClient();
  const res = await client.conversations.info({ channel: channelId });
  return res.channel;
}

async function defaultOpenDm(userId) {
  const client = await getLookupClient();
  const res = await client.conversations.open({ users: userId, return_im: false });
  return res.channel?.id;
}

/**
 * The 1:1 DM channel (D…) for a Slack user id: from the cache, else from
 * conversations.open (then cached).
 * @param {string} userId - U… / W…
 * @param {object} [opts]
 * @param {string} [opts.cachePath]
 * @param {function} [opts.openDm] - userId -> Promise<D…>
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>}
 * @throws {Error} when the id is not a user id or the lookup fails
 */
export async function resolveUserDmChannel(userId, {
  cachePath = CHAT_TYPE_CACHE_PATH,
  openDm = defaultOpenDm,
  timeoutMs = CHAT_LOOKUP_TIMEOUT_MS,
} = {}) {
  if (!isSlackUserId(userId)) throw new Error(`not a Slack user id: ${quote(userId)}`);
  const cached = readChatTypeCache(cachePath)[userId];
  if (isValidCacheEntry(userId, cached)) return cached.slice(USER_DM_PREFIX.length);
  let dmChannel;
  try {
    dmChannel = await withTimeout(Promise.resolve().then(() => openDm(userId)), timeoutMs, 'conversations.open');
  } catch (err) {
    throw new Error(`cannot open the DM with ${quote(userId)}: ${err.message}`);
  }
  if (typeof dmChannel !== 'string' || !SLACK_ID.test(dmChannel) || isSlackUserId(dmChannel)) {
    throw new Error(`cannot open the DM with ${quote(userId)}: unexpected channel id ${quote(dmChannel, 32)}`);
  }
  recordUserDm(userId, dmChannel, cachePath);
  recordChatType(dmChannel, ENDPOINT_TYPE.DIRECT_MESSAGE, cachePath);
  return dmChannel;
}

/**
 * A user id (U…/W…) is only ever a DM: as an endpoint it must be bare or carry
 * `type:dm`. Shared by resolveSessionGroup and scripts/send.js so both reject
 * the same endpoints. No-op for any other endpoint.
 * @param {string} endpoint
 * @throws {Error} for a user id with `|` parts and a type other than dm
 */
export function assertUserIdEndpointIsDm(endpoint) {
  const raw = String(endpoint ?? '');
  const parsed = parseEndpoint(raw);
  if (isSlackUserId(parsed.channel) && raw.includes('|')
      && parsed.type !== ENDPOINT_TYPE.DIRECT_MESSAGE) {
    throw new Error(`a user id can only be a DM (type:dm): ${quote(raw)}`);
  }
}

/**
 * Session group for any endpoint, including a bare id.
 * - With `|type:` (or any `|` part): exactly sessionGroupFromEndpoint, except
 *   that a user id with `type:dm` is first resolved to its DM channel.
 * - Bare conversation id: type from the cache, else from conversations.info
 *   (then cached); maps to dm-<id> or group-<id>, never a topic.
 * - Bare user id: dm-<D…> of the user's DM channel.
 * @param {string} endpoint
 * @param {object} [opts]
 * @param {string} [opts.cachePath]
 * @param {function} [opts.fetchConversation] - Test hook: id -> Promise<conversation object>
 * @param {function} [opts.openDm] - Test hook: userId -> Promise<D…>
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>} group name without namespace
 * @throws {Error} when the endpoint cannot be mapped or the lookup fails
 */
export async function resolveSessionGroup(endpoint, {
  cachePath = CHAT_TYPE_CACHE_PATH,
  fetchConversation = defaultFetchConversation,
  openDm = defaultOpenDm,
  timeoutMs = CHAT_LOOKUP_TIMEOUT_MS,
} = {}) {
  if (typeof endpoint !== 'string') return sessionGroupFromEndpoint(endpoint);
  const parsed = parseEndpoint(endpoint);
  const id = parsed.channel;

  if (isSlackUserId(id)) {
    assertUserIdEndpointIsDm(endpoint);
    const dmChannel = await resolveUserDmChannel(id, { cachePath, openDm, timeoutMs });
    return sessionGroupFromEndpoint(`${dmChannel}|type:${ENDPOINT_TYPE.DIRECT_MESSAGE}`);
  }

  if (endpoint.includes('|')) return sessionGroupFromEndpoint(endpoint);

  if (!SLACK_ID.test(id)) {
    throw new Error(`invalid Slack conversation id in endpoint: ${quote(endpoint)}`);
  }
  let chatType = readChatTypeCache(cachePath)[id];
  if (!CONVERSATION_TYPES.has(chatType)) {
    let conversation;
    try {
      conversation = await withTimeout(Promise.resolve().then(() => fetchConversation(id)),
        timeoutMs, 'conversations.info');
    } catch (err) {
      throw new Error(`cannot look up conversation type for ${quote(id)}: ${err.message}`);
    }
    chatType = chatTypeFromConversation(conversation);
    if (!chatType) {
      throw new Error(`cannot look up conversation type for ${quote(id)}: conversations.info says neither DM nor channel`);
    }
    recordChatType(id, chatType, cachePath);
  }
  return sessionGroupFromEndpoint(`${id}|type:${chatType}`);
}
