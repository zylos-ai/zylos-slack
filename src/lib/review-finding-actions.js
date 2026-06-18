import fs from 'fs';
import path from 'path';

export const REVIEW_FINDING_ACTION_IDS = new Set([
  'review_finding_approve',
  'review_finding_reject',
  'review_finding_redirect',
]);

export function resolveReviewFindingWorkflowBin({
  env = process.env,
  home = env.HOME || '',
  existsSync = fs.existsSync,
} = {}) {
  const candidates = [
    env.REVIEW_FINDING_WORKFLOW_BIN,
    path.join(path.dirname(home), 'bin/cl-zylos-auto-reviewer-env'),
    path.join(home, 'zylos-agents/bin/cl-zylos-auto-reviewer-env'),
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) || candidates[0];
}

export function canUseReviewFindingAction(actorId, channelId, config = {}) {
  if (!actorId) return false;
  if (config.owner?.user_id && actorId === config.owner.user_id) return true;

  const groupConfig = channelId ? config.groups?.[channelId] : null;
  if (groupConfig?.allowFrom?.includes(actorId)) return true;

  return false;
}

export async function respondToAction(respond, response, logger = console) {
  if (!respond) return;
  try {
    await respond({
      ...response,
      replace_original: false,
    });
  } catch (err) {
    logger.warn('[slack] Failed to send action response:', err.message);
  }
}

export function reviewFindingActionThreadTarget(body) {
  const channel = body?.channel?.id || body?.container?.channel_id || '';
  const threadTs = body?.message?.thread_ts || body?.message?.ts || body?.container?.message_ts || '';
  if (!channel || !threadTs) {
    throw new Error('review finding action is missing Slack channel or message timestamp for thread reply');
  }
  return { channel, threadTs };
}

export async function postReviewFindingActionThreadReply(body, response, sendText) {
  if (typeof sendText !== 'function') throw new Error('sendText function is required');
  const text = String(response?.text || 'Review finding decision recorded.').trim();
  const { channel, threadTs } = reviewFindingActionThreadTarget(body);
  return sendText(channel, text, { thread_ts: threadTs });
}

export function reviewFindingActionThreadReplyResponse(result, action) {
  if (result?.slackThreadReply?.sent === true) return null;
  return result?.slackThreadReply || result?.slackResponse || {
    response_type: 'ephemeral',
    text: `Recorded ${action.action_id.replace('review_finding_', '')} for the review finding.`,
  };
}
