import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getMessageDedupKey,
  isBotMentioned,
  resolveUserMentions,
  shouldHandleGroupMessage,
} from '../src/lib/mentions.js';
import { GROUP_MODE } from '../src/lib/constants.js';

test('detects only an explicit mention of the current bot', () => {
  assert.equal(isBotMentioned('<@UBOT123> please help', 'UBOT123'), true);
  assert.equal(isBotMentioned('<@UOTHER1> please help', 'UBOT123'), false);
  assert.equal(isBotMentioned('UBOT123 please help', 'UBOT123'), false);
  assert.equal(isBotMentioned('', 'UBOT123'), false);
});

test('resolves bot and human mentions to readable names', async () => {
  const names = new Map([
    ['UBOT123', 'OpenMAX Agent'],
    ['UOTHER1', 'Alice'],
  ]);

  let resolutionCount = 0;
  const result = await resolveUserMentions(
    '<@UBOT123> 请让 <@UOTHER1> 看一下，抄送 <@UOTHER1>',
    async userId => {
      resolutionCount += 1;
      return names.get(userId);
    },
  );

  assert.equal(result, '@OpenMAX Agent 请让 @Alice 看一下，抄送 @Alice');
  assert.equal(resolutionCount, 2);
});

test('falls back to a Slack user ID when name resolution fails', async () => {
  const result = await resolveUserMentions('<@UUNKNOWN> hello', async () => {
    throw new Error('users.info unavailable');
  });

  assert.equal(result, '@UUNKNOWN hello');
});

test('mention mode requires a mention for every sender', () => {
  assert.equal(shouldHandleGroupMessage(GROUP_MODE.MENTION, true), true);
  assert.equal(shouldHandleGroupMessage(GROUP_MODE.MENTION, false), false);
  assert.equal(shouldHandleGroupMessage(GROUP_MODE.SMART, false), true);
});

test('message and app_mention deliveries use the same deduplication key', () => {
  const messageEvent = { channel: 'C123', ts: '1725000000.000001', client_msg_id: 'client-1' };
  const mentionEvent = { channel: 'C123', ts: '1725000000.000001' };

  assert.equal(getMessageDedupKey(messageEvent), getMessageDedupKey(mentionEvent));
});
