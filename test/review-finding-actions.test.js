import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canUseReviewFindingAction,
  postReviewFindingActionThreadReply,
  respondToAction,
  resolveReviewFindingWorkflowBin,
  reviewFindingActionThreadReplyResponse,
  reviewFindingActionThreadTarget,
} from '../src/lib/review-finding-actions.js';

test('review finding action permissions allow owner and channel allowlist only', () => {
  const config = {
    owner: { user_id: 'UOWNER' },
    groups: {
      C123: { allowFrom: ['UALLOWED'] },
    },
  };

  assert.equal(canUseReviewFindingAction('UOWNER', 'C999', config), true);
  assert.equal(canUseReviewFindingAction('UALLOWED', 'C123', config), true);
  assert.equal(canUseReviewFindingAction('UALLOWED', 'C999', config), false);
  assert.equal(canUseReviewFindingAction('', 'C123', config), false);
});

test('respondToAction never replaces the original Slack card', async () => {
  let payload = null;
  await respondToAction(async (value) => {
    payload = value;
  }, {
    response_type: 'ephemeral',
    text: 'Recorded approved on the GitHub issue.',
  });

  assert.deepEqual(payload, {
    response_type: 'ephemeral',
    text: 'Recorded approved on the GitHub issue.',
    replace_original: false,
  });
});

test('postReviewFindingActionThreadReply appends success text in the card thread', async () => {
  const calls = [];
  const result = await postReviewFindingActionThreadReply({
    channel: { id: 'C123' },
    message: { ts: '1780000000.000100' },
  }, {
    text: 'Recorded approved on the GitHub issue.',
  }, async (...args) => {
    calls.push(args);
    return { ok: true, ts: '1780000001.000200' };
  });

  assert.deepEqual(calls, [[
    'C123',
    'Recorded approved on the GitHub issue.',
    { thread_ts: '1780000000.000100' },
  ]]);
  assert.deepEqual(result, { ok: true, ts: '1780000001.000200' });
});

test('postReviewFindingActionThreadReply accepts workflow slackThreadReply results', async () => {
  const calls = [];
  await postReviewFindingActionThreadReply({
    channel: { id: 'C123' },
    message: { ts: '1780000000.000100' },
  }, {
    text: 'Recorded rejected on the GitHub issue.',
    policy: 'append-thread-reply-preserve-card',
    sent: false,
  }, async (...args) => {
    calls.push(args);
    return { ok: true };
  });

  assert.deepEqual(calls, [[
    'C123',
    'Recorded rejected on the GitHub issue.',
    { thread_ts: '1780000000.000100' },
  ]]);
});

test('reviewFindingActionThreadReplyResponse skips replies already sent by workflow', () => {
  assert.equal(reviewFindingActionThreadReplyResponse({
    slackThreadReply: {
      text: 'Decision recorded: APPROVED',
      sent: true,
    },
  }, {
    action_id: 'review_finding_approve',
  }), null);
});

test('reviewFindingActionThreadReplyResponse returns unsent workflow thread replies', () => {
  assert.deepEqual(reviewFindingActionThreadReplyResponse({
    slackThreadReply: {
      text: 'Decision recorded: REJECTED',
      sent: false,
    },
  }, {
    action_id: 'review_finding_reject',
  }), {
    text: 'Decision recorded: REJECTED',
    sent: false,
  });
});

test('reviewFindingActionThreadReplyResponse keeps default fallback for old workflows', () => {
  assert.deepEqual(reviewFindingActionThreadReplyResponse({}, {
    action_id: 'review_finding_redirect',
  }), {
    response_type: 'ephemeral',
    text: 'Recorded redirect for the review finding.',
  });
});

test('reviewFindingActionThreadTarget handles attachment containers', () => {
  assert.deepEqual(reviewFindingActionThreadTarget({
    container: {
      channel_id: 'C456',
      message_ts: '1780000002.000300',
    },
  }), {
    channel: 'C456',
    threadTs: '1780000002.000300',
  });
});

test('resolveReviewFindingWorkflowBin prefers explicit env override', () => {
  const explicit = '/tmp/custom-reviewer-env';
  assert.equal(resolveReviewFindingWorkflowBin({
    env: {
      HOME: '/home/example/cl-zylos-auto-reviewer',
      REVIEW_FINDING_WORKFLOW_BIN: explicit,
    },
    existsSync: candidate => candidate === explicit,
  }), explicit);
});
