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
