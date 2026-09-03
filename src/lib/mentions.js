import { GROUP_MODE } from './constants.js';

const SLACK_USER_MENTION_PATTERN = /<@([A-Z0-9]+)(?:\|([^>]+))?>/g;

/**
 * Return whether a Slack message explicitly mentions this bot user.
 */
export function isBotMentioned(text, botUserId) {
  if (!text || !botUserId) return false;

  for (const match of text.matchAll(SLACK_USER_MENTION_PATTERN)) {
    if (match[1] === botUserId) return true;
  }
  return false;
}

/**
 * Replace Slack's raw <@USER_ID> markup with readable @display-name text.
 * Each distinct user is resolved at most once per message.
 */
export async function resolveUserMentions(text, resolveUserName) {
  if (!text || typeof resolveUserName !== 'function') return text || '';

  const mentions = [...text.matchAll(SLACK_USER_MENTION_PATTERN)];
  if (mentions.length === 0) return text;

  const labels = new Map();
  for (const match of mentions) {
    const userId = match[1];
    if (labels.has(userId)) continue;

    try {
      const name = await resolveUserName(userId);
      labels.set(userId, name || match[2] || userId);
    } catch {
      labels.set(userId, match[2] || userId);
    }
  }

  return text.replace(SLACK_USER_MENTION_PATTERN, (_raw, userId) => `@${labels.get(userId) || userId}`);
}

/**
 * Mention mode is a trigger rule, not an access-control rule. Owners may bypass
 * allowlists, but they must still mention the bot in a mention-mode channel.
 */
export function shouldHandleGroupMessage(mode, isMention) {
  return mode !== GROUP_MODE.MENTION || isMention;
}

/**
 * Slack can deliver the same mention through both message and app_mention
 * subscriptions. Channel + timestamp identifies the underlying message in both.
 */
export function getMessageDedupKey(event) {
  return `${event.channel}-${event.ts}`;
}
