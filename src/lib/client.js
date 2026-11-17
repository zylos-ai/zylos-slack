import { WebClient } from '@slack/web-api';

let webClient = null;
let botUserId = null;
let botName = null;

/**
 * Initialize the Slack Web API client.
 */
export function initClient(token) {
  webClient = new WebClient(token);
  return webClient;
}

/**
 * A separate Web API client for short, bounded lookups: the session-group
 * query (scripts/session-group.js, which Core kills after 5s) and the thread
 * context fetched before an inbound message is delivered. The SDK default
 * retries up to 10 times over 30 minutes and waits out rate limits; this
 * client never retries and fails a rate-limited call at once, so a slow or
 * throttled Slack API fails fast instead of stalling the caller.
 */
export function createLookupClient(token, { timeoutMs } = {}) {
  return new WebClient(token, {
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
}

export function getClient() {
  if (!webClient) throw new Error('Slack client not initialized');
  return webClient;
}

/**
 * Fetch and cache bot identity.
 */
export async function fetchBotIdentity() {
  const client = getClient();
  const res = await client.auth.test();
  botUserId = res.user_id;
  botName = res.user;
  console.log(`[slack] Bot identity: @${botName} (${botUserId})`);
  return { userId: botUserId, name: botName };
}

export function getBotUserId() {
  return botUserId;
}

export function getBotName() {
  return botName;
}
