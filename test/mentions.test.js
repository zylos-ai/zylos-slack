import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getMessageDedupKey,
  isBotMentioned,
  resolveUserMentions,
  shouldHandleGroupMessage,
  shouldIgnoreMessageEvent,
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

// Event shapes follow @slack/types (FileShareMessageEvent, GenericMessageEvent,
// BotMessageEvent); they are not captured from a live Slack payload.
test('a user file_share message is handled like a plain user message', () => {
  const base = {
    type: 'message', channel: 'C123', channel_type: 'channel', user: 'U123',
    ts: '1725000000.000002', event_ts: '1725000000.000002',
  };

  assert.equal(shouldIgnoreMessageEvent({ ...base, text: 'hello', client_msg_id: 'c-1' }), false);
  assert.equal(shouldIgnoreMessageEvent({
    ...base,
    subtype: 'file_share',
    text: 'see attached',
    upload: false,
    display_as_bot: false,
    files: [{ id: 'F1', name: 'report.pdf', mimetype: 'application/pdf', size: 1024 }],
  }), false);
  assert.equal(shouldIgnoreMessageEvent({
    ...base,
    subtype: 'file_share',
    text: '',
    upload: false,
    display_as_bot: false,
    files: [{ id: 'F2', name: 'photo.png', mimetype: 'image/png', size: 2048 }],
  }), false);
});

test('bot messages and every other subtype are still ignored', () => {
  const base = { type: 'message', channel: 'C123', user: 'U123', ts: '1725000000.000003' };

  for (const subtype of [
    'bot_message', 'message_changed', 'message_deleted', 'message_replied',
    'channel_join', 'channel_leave', 'channel_topic', 'me_message',
  ]) {
    assert.equal(shouldIgnoreMessageEvent({ ...base, subtype }), true, subtype);
  }
});

test('a message marked as from a bot is ignored, file_share included', () => {
  const base = { type: 'message', channel: 'C123', ts: '1725000000.000004' };
  const botProfile = { id: 'B123', app_id: 'A123', name: 'other-bot' };

  // GenericMessageEvent posted by an app: bot_id + bot_profile.
  assert.equal(shouldIgnoreMessageEvent({ ...base, user: 'U999', bot_id: 'B123', bot_profile: botProfile, text: 'hi' }), true);
  assert.equal(shouldIgnoreMessageEvent({ ...base, user: 'U999', bot_profile: botProfile, text: 'hi' }), true);
  // FileShareMessageEvent has no bot_id; display_as_bot marks a bot upload.
  assert.equal(shouldIgnoreMessageEvent({
    ...base, subtype: 'file_share', user: 'U999', text: '', display_as_bot: true,
    files: [{ id: 'F3', name: 'export.csv', size: 10 }],
  }), true);
  assert.equal(shouldIgnoreMessageEvent({
    ...base, subtype: 'file_share', user: 'U999', text: '', bot_id: 'B123',
    files: [{ id: 'F4', name: 'export.csv', size: 10 }],
  }), true);
});
