import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEndpoint } from '../src/lib/endpoint.js';
import {
  CHAT_LOOKUP_TIMEOUT_MS,
  chatTypeFromConversation,
  isSlackUserId,
  isValidSessionGroup,
  readChatTypeCache,
  recordChatType,
  recordUserDm,
  resolveSessionGroup,
  resolveUserDmChannel,
  SESSION_GROUP_MAX_LENGTH,
  sessionGroupFromEndpoint,
} from '../src/lib/session-group.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'session-group.js');

// Every script run gets its own HOME, so it never touches this host's cache,
// credentials or the Slack API.
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slack-session-group-'));
const cacheFileIn = home => path.join(home, 'zylos/components/slack/chat-type-cache.json');
const tmpCachePath = () => path.join(tmpHome(), 'chat-type-cache.json');

const DM = 'D0123ABCDE';
const CHANNEL = 'C0123ABCDE';
const PRIVATE = 'G0123ABCDE';
const USER = 'U0123ABCDE';
const THREAD = '1763280000.123456';
const MSG = '1763280001.000200';

// Mapping table: DM, DM thread, channel, channel thread, group DM
const MAPPING = [
  ['DM', buildEndpoint(DM, 'dm', MSG), `dm-${DM}`],
  ['DM thread is not split', buildEndpoint(DM, 'dm', MSG, THREAD), `dm-${DM}`],
  ['channel', buildEndpoint(CHANNEL, 'group', MSG), `group-${CHANNEL}`],
  ['channel thread', buildEndpoint(CHANNEL, 'group', MSG, THREAD), `group-${CHANNEL}:topic-${THREAD}`],
  ['private channel / group DM', buildEndpoint(PRIVATE, 'group', MSG), `group-${PRIVATE}`],
  ['thread root itself (thread_ts == ts)', buildEndpoint(CHANNEL, 'group', THREAD, THREAD), `group-${CHANNEL}:topic-${THREAD}`],
];

for (const [label, endpoint, expected] of MAPPING) {
  test(`maps ${label}`, () => {
    const name = sessionGroupFromEndpoint(endpoint);
    assert.equal(name, expected);
    assert.ok(isValidSessionGroup(name), `${name} must be valid for Core`);
    assert.ok(!name.startsWith('slack:'), 'Core adds the namespace, not the component');
  });
}

test('thread group name fits Core limits with room to spare', () => {
  assert.equal(sessionGroupFromEndpoint(`C0123ABCD|type:group|thread:1763280000.123456`).length, 39);
});

test('the per-message ts never changes the group', () => {
  assert.equal(
    sessionGroupFromEndpoint(buildEndpoint(CHANNEL, 'group', '1.1', THREAD)),
    sessionGroupFromEndpoint(buildEndpoint(CHANNEL, 'group', '2.2', THREAD)));
  assert.equal(
    sessionGroupFromEndpoint(buildEndpoint(DM, 'dm', '1.1')),
    sessionGroupFromEndpoint(buildEndpoint(DM, 'dm', '2.2', THREAD)));
});

test('different threads in one channel map to different groups', () => {
  const a = sessionGroupFromEndpoint(`${CHANNEL}|type:group|thread:1.1`);
  const b = sessionGroupFromEndpoint(`${CHANNEL}|type:group|thread:1.2`);
  assert.notEqual(a, b);
  assert.notEqual(a, sessionGroupFromEndpoint(`${CHANNEL}|type:group`));
});

test('isValidSessionGroup follows Core rules', () => {
  assert.ok(isValidSessionGroup('a'.repeat(SESSION_GROUP_MAX_LENGTH)));
  assert.ok(!isValidSessionGroup('a'.repeat(SESSION_GROUP_MAX_LENGTH + 1)));
  assert.ok(!isValidSessionGroup(''));
  assert.ok(!isValidSessionGroup('-x'));
  assert.ok(!isValidSessionGroup('a b'));
  assert.ok(!isValidSessionGroup(42));
});

test('isSlackUserId recognizes U… and W… only', () => {
  assert.ok(isSlackUserId('U0123'));
  assert.ok(isSlackUserId('W0123'));
  for (const id of ['C0123', 'D0123', 'G0123', 'u0123', 'U', '', undefined]) {
    assert.ok(!isSlackUserId(id), String(id));
  }
});

// Total length = 'group-'(6) + channel + ':topic-'(7) + '1.1'(3)
const channelForLength = total => `C${'A'.repeat(total - 6 - 7 - 3 - 1)}`;

test('a 95-character name is accepted', () => {
  const name = sessionGroupFromEndpoint(`${channelForLength(95)}|type:group|thread:1.1`);
  assert.equal(name.length, 95);
});

// Invalid input always throws - no guessing, rewriting or truncation
const INVALID = [
  ['empty endpoint', ''],
  ['bare id without type (never guessed)', CHANNEL],
  ['id with thread but no type', `${CHANNEL}|thread:${THREAD}`],
  ['unknown type', `${CHANNEL}|type:mpim`],
  ['empty type', `${CHANNEL}|type:`],
  ['empty id', '|type:dm'],
  ['lower-case id', 'c0123|type:group'],
  ['id with a dot', 'C01.23|type:group'],
  ['id with a colon', 'C01:23|type:group'],
  ['id with a space', 'C01 23|type:dm'],
  ['user id (needs a lookup)', `${USER}|type:dm`],
  ['empty thread', `${CHANNEL}|type:group|thread:`],
  ['thread that is not a Slack ts', `${CHANNEL}|type:group|thread:abc`],
  ['thread without fraction', `${CHANNEL}|type:group|thread:1763280000`],
  ['thread with a colon', `${CHANNEL}|type:group|thread:1.2:3`],
  ['96-character name (not truncated)', `${channelForLength(96)}|type:group|thread:1.1`],
];

for (const [label, endpoint] of INVALID) {
  test(`throws on ${label}`, () => {
    assert.throws(() => sessionGroupFromEndpoint(endpoint));
  });
}

test('throws on non-string input', () => {
  assert.throws(() => sessionGroupFromEndpoint(undefined));
  assert.throws(() => sessionGroupFromEndpoint(null));
});

// Query script agrees with the inbound mapping
const scriptEnv = home => ({ ...process.env, HOME: home, ZYLOS_DIR: path.join(home, 'zylos'), SLACK_BOT_TOKEN: '' });
const runScript = (...args) => spawnSync(process.execPath, [SCRIPT, ...args],
  { encoding: 'utf8', env: scriptEnv(tmpHome()) });

test('scripts/session-group.js prints the same group as the inbound mapping', () => {
  for (const [, endpoint, expected] of MAPPING) {
    const out = execFileSync(process.execPath, [SCRIPT, endpoint], { encoding: 'utf8', env: scriptEnv(tmpHome()) });
    assert.equal(out, `${sessionGroupFromEndpoint(endpoint)}\n`);
    assert.equal(out.trim(), expected);
  }
});

test('scripts/session-group.js exits 1 with empty stdout on bad usage or input', () => {
  const cases = [
    [],
    ['a', 'b'],
    [`${DM}|type:dm`, 'extra'],
    [CHANNEL], // bare id, cache miss and the lookup fails (no token): never guessed
    [USER], // bare user id, cache miss and conversations.open fails (no token)
    ['c0123'], // bare id with unexpected characters: no lookup
    [''],
    [`${CHANNEL}|type:mpim`],
    [`${USER}|type:group`],
    [`${channelForLength(96)}|type:group|thread:1.1`],
  ];
  for (const args of cases) {
    const r = runScript(...args);
    assert.equal(r.status, 1, `args ${JSON.stringify(args)}`);
    assert.equal(r.stdout, '', `args ${JSON.stringify(args)}`);
    assert.ok(r.stderr.length > 0, `args ${JSON.stringify(args)}`);
  }
});

// Bare ids (proactive sends): cache, then conversations.info / conversations.open

test('chatTypeFromConversation maps im to dm and channel/group/mpim to group only', () => {
  assert.equal(chatTypeFromConversation({ is_im: true }), 'dm');
  assert.equal(chatTypeFromConversation({ is_channel: true }), 'group');
  assert.equal(chatTypeFromConversation({ is_channel: true, is_private: true }), 'group');
  assert.equal(chatTypeFromConversation({ is_group: true }), 'group');
  assert.equal(chatTypeFromConversation({ is_mpim: true, is_group: true }), 'group');
  assert.equal(chatTypeFromConversation({}), null);
  assert.equal(chatTypeFromConversation(undefined), null);
  assert.equal(chatTypeFromConversation({ is_im: 'yes' }), null);
});

test('lookup timeout stays well under Core\'s 6.5s session-group query limit', () => {
  assert.ok(CHAT_LOOKUP_TIMEOUT_MS <= 5000);
});

const noFetch = async () => { throw new Error('API must not be called'); };
const noLookups = { fetchConversation: noFetch, openDm: noFetch };

test('endpoint with |type: is unchanged and never looks anything up', async () => {
  const cachePath = tmpCachePath();
  for (const [, endpoint, expected] of MAPPING) {
    assert.equal(await resolveSessionGroup(endpoint, { cachePath, ...noLookups }), expected);
  }
  // a typed endpoint wins over a cached type
  recordChatType(DM, 'group', cachePath);
  assert.equal(await resolveSessionGroup(`${DM}|type:dm`, { cachePath, ...noLookups }), `dm-${DM}`);
});

test('endpoint with | parts but no or unknown type still throws without a lookup', async () => {
  await assert.rejects(resolveSessionGroup(`${CHANNEL}|thread:${THREAD}`, { cachePath: tmpCachePath(), ...noLookups }));
  await assert.rejects(resolveSessionGroup(`${CHANNEL}|type:mpim`, { cachePath: tmpCachePath(), ...noLookups }));
});

test('bare conversation id: cache hit maps dm to dm- and group to group- without an API call', async () => {
  const cachePath = tmpCachePath();
  recordChatType(DM, 'dm', cachePath);
  recordChatType(CHANNEL, 'group', cachePath);
  assert.equal(await resolveSessionGroup(DM, { cachePath, ...noLookups }), `dm-${DM}`);
  assert.equal(await resolveSessionGroup(CHANNEL, { cachePath, ...noLookups }), `group-${CHANNEL}`);
});

for (const [info, expected] of [
  [{ is_im: true }, `dm-${CHANNEL}`],
  [{ is_channel: true }, `group-${CHANNEL}`],
  [{ is_group: true, is_private: true }, `group-${CHANNEL}`],
  [{ is_mpim: true }, `group-${CHANNEL}`],
]) {
  test(`bare conversation id: cache miss, conversations.info ${JSON.stringify(info)} -> ${expected.split('-')[0]}- (and cached)`, async () => {
    const cachePath = tmpCachePath();
    const calls = [];
    const fetchConversation = async id => { calls.push(id); return { id, ...info }; };
    assert.equal(await resolveSessionGroup(CHANNEL, { cachePath, fetchConversation, openDm: noFetch }), expected);
    assert.deepEqual(calls, [CHANNEL]);
    assert.equal(readChatTypeCache(cachePath)[CHANNEL], expected.startsWith('dm-') ? 'dm' : 'group');
    // second call is served from the cache
    assert.equal(await resolveSessionGroup(CHANNEL, { cachePath, fetchConversation, openDm: noFetch }), expected);
    assert.equal(calls.length, 1);
  });
}

test('bare conversation id: API failure, timeout or unknown kind throws and caches nothing', async () => {
  const failures = [
    async () => { throw new Error('An API error occurred: channel_not_found'); },
    async () => { throw new Error('An API error occurred: missing_scope'); },
    () => new Promise(() => {}), // never answers
    async () => ({ id: CHANNEL }),
    async () => undefined,
  ];
  for (const fetchConversation of failures) {
    const cachePath = tmpCachePath();
    await assert.rejects(resolveSessionGroup(CHANNEL, { cachePath, fetchConversation, openDm: noFetch, timeoutMs: 50 }),
      /cannot look up conversation type/);
    assert.deepEqual(readChatTypeCache(cachePath), {});
  }
});

test('bare id with unexpected characters throws without a lookup', async () => {
  for (const id of ['c0123', 'C01.23', 'C01 23', '-C1', '']) {
    await assert.rejects(resolveSessionGroup(id, { cachePath: tmpCachePath(), ...noLookups }));
  }
});

// User ids (proactive DM to U…)

test('bare user id: cache hit maps to the DM channel group without an API call', async () => {
  const cachePath = tmpCachePath();
  recordUserDm(USER, DM, cachePath);
  assert.equal(await resolveSessionGroup(USER, { cachePath, ...noLookups }), `dm-${DM}`);
  assert.equal(await resolveSessionGroup(`${USER}|type:dm`, { cachePath, ...noLookups }), `dm-${DM}`);
  assert.equal(await resolveUserDmChannel(USER, { cachePath, openDm: noFetch }), DM);
});

test('bare user id: cache miss, conversations.open -> dm-<D…>, same group as the inbound DM (and cached)', async () => {
  const cachePath = tmpCachePath();
  const calls = [];
  const openDm = async id => { calls.push(id); return DM; };
  const name = await resolveSessionGroup(USER, { cachePath, fetchConversation: noFetch, openDm });
  assert.equal(name, `dm-${DM}`);
  assert.equal(name, sessionGroupFromEndpoint(buildEndpoint(DM, 'dm', MSG)));
  assert.deepEqual(calls, [USER]);
  assert.deepEqual(readChatTypeCache(cachePath), { [USER]: `dm:${DM}`, [DM]: 'dm' });
  assert.equal(await resolveSessionGroup('W0123ABC', { cachePath, fetchConversation: noFetch, openDm }), `dm-${DM}`);
  assert.deepEqual(calls, [USER, 'W0123ABC']);
  await resolveSessionGroup(USER, { cachePath, fetchConversation: noFetch, openDm });
  assert.equal(calls.length, 2);
});

test('user id typed as a group is rejected without a lookup', async () => {
  await assert.rejects(resolveSessionGroup(`${USER}|type:group`, { cachePath: tmpCachePath(), ...noLookups }),
    /only be a DM/);
});

test('bare user id: open failure, timeout or a bad channel id throws and caches nothing', async () => {
  const failures = [
    async () => { throw new Error('An API error occurred: user_not_found'); },
    () => new Promise(() => {}),
    async () => undefined,
    async () => 'U999', // not a conversation id
    async () => 'd-1',
  ];
  for (const openDm of failures) {
    const cachePath = tmpCachePath();
    await assert.rejects(resolveSessionGroup(USER, { cachePath, fetchConversation: noFetch, openDm, timeoutMs: 50 }),
      /cannot open the DM/);
    assert.deepEqual(readChatTypeCache(cachePath), {});
  }
});

test('missing or corrupt cache file is tolerated (treated as empty, then rewritten)', async () => {
  assert.deepEqual(readChatTypeCache(tmpCachePath()), {});
  for (const content of ['{not json', '[1,2]', 'null', '']) {
    const cachePath = tmpCachePath();
    fs.writeFileSync(cachePath, content);
    assert.deepEqual(readChatTypeCache(cachePath), {});
    assert.equal(await resolveSessionGroup(CHANNEL, { cachePath, fetchConversation: async () => ({ is_channel: true }) }),
      `group-${CHANNEL}`);
    assert.deepEqual(readChatTypeCache(cachePath), { [CHANNEL]: 'group' });
  }
  // cached values of the wrong shape are ignored and looked up again
  const cachePath = tmpCachePath();
  fs.writeFileSync(cachePath, JSON.stringify({ [CHANNEL]: 'topic', [USER]: 'dm:U1' }));
  assert.equal(await resolveSessionGroup(CHANNEL, { cachePath, fetchConversation: async () => ({ is_im: true }) }), `dm-${CHANNEL}`);
  assert.equal(await resolveSessionGroup(USER, { cachePath, openDm: async () => DM }), `dm-${DM}`);
});

test('recordChatType writes atomically, only on change, and ignores invalid input', () => {
  const cachePath = path.join(tmpHome(), 'nested', 'chat-type-cache.json');
  assert.equal(recordChatType(DM, 'dm', cachePath), true);
  assert.equal(recordChatType(DM, 'dm', cachePath), false); // unchanged: no write
  assert.equal(recordChatType(DM, 'group', cachePath), true);
  assert.equal(recordChatType('c01', 'dm', cachePath), false);
  assert.equal(recordChatType(CHANNEL, 'mpim', cachePath), false);
  assert.equal(recordChatType(CHANNEL, undefined, cachePath), false);
  assert.equal(recordChatType(USER, 'dm', cachePath), false); // a user needs dm:<D…>
  assert.equal(recordUserDm(USER, 'U2', cachePath), false);
  assert.equal(recordUserDm(USER, undefined, cachePath), false);
  assert.equal(recordUserDm(USER, DM, cachePath), true);
  assert.deepEqual(readChatTypeCache(cachePath), { [DM]: 'group', [USER]: `dm:${DM}` });
  assert.deepEqual(fs.readdirSync(path.dirname(cachePath)), ['chat-type-cache.json']); // no tmp left
});

test('inbound handlers record the conversation type before any policy check', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  assert.match(src, /import \{ recordChatType, recordUserDm \} from '\.\/lib\/session-group\.js';/);
  const dm = src.slice(src.indexOf('async function handleDM('));
  assert.ok(dm.indexOf('recordChatType(event.channel, ENDPOINT_TYPE.DIRECT_MESSAGE);') > 0);
  assert.ok(dm.indexOf('recordUserDm(userId, event.channel);') > 0);
  assert.ok(dm.indexOf('recordUserDm(userId, event.channel);') < dm.indexOf('// Access check'));
  const group = src.slice(src.indexOf('async function handleGroupMessage('));
  const record = group.indexOf('recordChatType(channelId, ENDPOINT_TYPE.GROUP);');
  assert.ok(record > 0 && record < group.indexOf('isGroupAccessAllowed('));
});

test('scripts/session-group.js: bare ids from the cache print dm-/group-', () => {
  const home = tmpHome();
  recordChatType(DM, 'dm', cacheFileIn(home));
  recordChatType(CHANNEL, 'group', cacheFileIn(home));
  recordUserDm(USER, DM, cacheFileIn(home));
  const run = id => spawnSync(process.execPath, [SCRIPT, id], { encoding: 'utf8', env: scriptEnv(home) });
  for (const [id, expected] of [[DM, `dm-${DM}`], [CHANNEL, `group-${CHANNEL}`], [USER, `dm-${DM}`]]) {
    const r = run(id);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${expected}\n`);
  }
});

test('scripts/session-group.js: bare id whose lookup fails logs to stderr, exits 1, prints nothing', () => {
  const home = tmpHome();
  const r = spawnSync(process.execPath, [SCRIPT, CHANNEL], { encoding: 'utf8', env: scriptEnv(home) });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /cannot look up conversation type/);
  assert.ok(!fs.existsSync(cacheFileIn(home)), 'nothing cached on failure');
});
