import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';

import {
  buildChannelThreadContext, buildGroupContext, compareSlackTs, fetchThreadMessages,
  formatThreadContext, THREAD_CONTEXT_DEADLINE_MS, THREAD_CONTEXT_REQUEST_TIMEOUT_MS,
} from '../src/lib/thread-context.js';
import { createLookupClient } from '../src/lib/client.js';

const ROOT = '1763280000.000100';
const names = { U1: 'alice', U2: 'bob', UBOT: 'zylos' };
const getUserName = async id => names[id] || id;
const msg = (ts, user, text) => ({ ts, user, text });

test('compareSlackTs compares without float rounding', () => {
  assert.ok(compareSlackTs('1763280000.000100', '1763280000.000101') < 0);
  assert.ok(compareSlackTs('1763280000.999999', '1763280001.000000') < 0);
  assert.equal(compareSlackTs('1763280000.000100', '1763280000.0001'), 0);
  assert.ok(compareSlackTs('1763280001.1', '1763280000.9') > 0);
});

test('root message plus earlier replies, current and later messages excluded', async () => {
  const messages = [
    msg(ROOT, 'U1', 'root question'),
    msg('1763280001.000100', 'UBOT', 'first answer'),
    msg('1763280002.000100', 'U2', 'follow-up'),
    msg('1763280003.000100', 'U1', 'current'),
    msg('1763280004.000100', 'U2', 'later'),
  ];
  const ctx = await formatThreadContext({
    threadTs: ROOT, currentTs: '1763280003.000100', messages, limit: 10, getUserName,
  });
  assert.equal(ctx, '<thread-context>\n[thread root] alice: root question\nzylos: first answer\nbob: follow-up\n</thread-context>\n\n');
});

test('keeps only the most recent `limit` replies and says how many were omitted', async () => {
  const messages = [msg(ROOT, 'U1', 'root')];
  for (let i = 1; i <= 5; i += 1) messages.push(msg(`176328000${i}.000000`, 'U2', `r${i}`));
  const ctx = await formatThreadContext({
    threadTs: ROOT, currentTs: '1763280009.000000', messages, limit: 2, getUserName,
  });
  assert.equal(ctx, '<thread-context>\n[thread root] alice: root\n(3 earlier replies omitted)\nbob: r4\nbob: r5\n</thread-context>\n\n');
});

test('duplicates across pages, media-only and bot messages without a user', async () => {
  const messages = [
    msg(ROOT, 'U1', ''),
    { ts: '1763280001.000000', bot_id: 'B1', username: 'deploy-bot', text: 'deployed' },
    msg(ROOT, 'U1', ''),
  ];
  const ctx = await formatThreadContext({
    threadTs: ROOT, currentTs: '1763280002.000000', messages, limit: 5, getUserName,
  });
  assert.equal(ctx, '<thread-context>\n[thread root] alice: (media)\ndeploy-bot: deployed\n</thread-context>\n\n');
});

test('nothing to show: empty string', async () => {
  assert.equal(await formatThreadContext({
    threadTs: ROOT, currentTs: ROOT, messages: [msg(ROOT, 'U1', 'root')], limit: 5, getUserName,
  }), '');
  assert.equal(await formatThreadContext({
    threadTs: ROOT, currentTs: '1.0', messages: [], limit: 5, getUserName,
  }), '');
});

test('fetchThreadMessages follows the cursor, bounded by maxPages', async () => {
  const calls = [];
  const client = {
    conversations: {
      replies: async params => {
        calls.push(params);
        const page = calls.length;
        return {
          messages: [msg(`${page}.0`, 'U1', `p${page}`)],
          has_more: true,
          response_metadata: { next_cursor: `c${page}` },
        };
      },
    },
  };
  const messages = await fetchThreadMessages(client, 'C1', ROOT, { maxPages: 3 });
  assert.equal(messages.length, 3);
  assert.deepEqual(calls.map(c => c.cursor), [undefined, 'c1', 'c2']);
  assert.ok(calls.every(c => c.channel === 'C1' && c.ts === ROOT && c.limit === 200));
});

test('fetchThreadMessages stops when there are no more pages', async () => {
  let n = 0;
  const client = { conversations: { replies: async () => { n += 1; return { messages: [msg(ROOT, 'U1', 'x')], has_more: false }; } } };
  assert.equal((await fetchThreadMessages(client, 'C1', ROOT)).length, 1);
  assert.equal(n, 1);
});


// ── Group context selection (old Core vs multi-session Core) ──

// The original src/index.js group-context code (origin/main aa3d29a), verbatim.
function groupContext013(history, contextLimit) {
  const contextMsgs = history.slice(-contextLimit - 1, -1); // exclude current
  let groupContext = '';
  if (contextMsgs.length > 0) {
    const lines = contextMsgs.map(m => `${m.from}: ${m.text}`);
    groupContext = `<group-context>\n${lines.join('\n')}\n</group-context>\n\n`;
  }
  return groupContext;
}

const HISTORY = [
  { from: 'alice', text: 'one', ts: '1' },
  { from: 'bob', text: 'two', ts: '2' },
  { from: 'alice', text: 'three', ts: '3' },
  { from: 'bob', text: 'current', ts: '4' },
];
const THREAD_REPLY = { ts: '1763280003.000100', thread_ts: ROOT };
const TOP_LEVEL = { ts: '1763280003.000100' };
const THREAD_ROOT_EVENT = { ts: ROOT, thread_ts: ROOT };
const THREAD_CTX = '<thread-context>\n[thread root] alice: root\n</thread-context>\n\n';

test('old Core: channel thread content is exactly 0.1.3 and Slack is never called', async () => {
  for (const event of [THREAD_REPLY, TOP_LEVEL, THREAD_ROOT_EVENT]) {
    for (const [history, limit] of [[HISTORY, 2], [HISTORY, 10], [HISTORY.slice(-1), 5], [[], 5]]) {
      let calls = 0;
      const ctx = await buildGroupContext({
        event, history, limit, supportsSessionGroup: false,
        fetchThreadContext: async () => { calls += 1; return THREAD_CTX; },
      });
      assert.equal(ctx, groupContext013(history, limit));
      assert.equal(calls, 0);
    }
  }
});

test('multi-session Core: a thread reply gets the Slack thread context', async () => {
  let calls = 0;
  const ctx = await buildGroupContext({
    event: THREAD_REPLY, history: HISTORY, limit: 2, supportsSessionGroup: true,
    fetchThreadContext: async () => { calls += 1; return THREAD_CTX; },
  });
  assert.equal(ctx, THREAD_CTX);
  assert.equal(calls, 1);
});

test('multi-session Core: in-memory history when the thread context is empty; top level never fetches', async () => {
  const empty = await buildGroupContext({
    event: THREAD_REPLY, history: HISTORY, limit: 2, supportsSessionGroup: true,
    fetchThreadContext: async () => '',
  });
  assert.equal(empty, groupContext013(HISTORY, 2));
  for (const event of [TOP_LEVEL, THREAD_ROOT_EVENT]) {
    const ctx = await buildGroupContext({
      event, history: HISTORY, limit: 2, supportsSessionGroup: true,
      fetchThreadContext: async () => { throw new Error('must not fetch'); },
    });
    assert.equal(ctx, groupContext013(HISTORY, 2));
  }
});

// ── Bounded thread-context fetch ──

const ctxOpts = client => ({
  client, channel: 'C1', threadTs: ROOT, currentTs: '1763280009.000000', limit: 5, getUserName,
});

test('buildChannelThreadContext formats the thread', async () => {
  const client = { conversations: { replies: async () => ({ messages: [msg(ROOT, 'U1', 'root')], has_more: false }) } };
  assert.equal(await buildChannelThreadContext(ctxOpts(client)), THREAD_CTX);
});

test('buildChannelThreadContext gives up at the deadline and returns \'\'', { timeout: 2000 }, async () => {
  const hang = { conversations: { replies: () => new Promise(() => {}) } };
  const errors = [];
  const started = Date.now();
  const ctx = await buildChannelThreadContext({ ...ctxOpts(hang), deadlineMs: 50, onError: e => errors.push(e) });
  assert.equal(ctx, '');
  assert.ok(Date.now() - started < 1000);
  assert.match(errors[0].message, /timed out after 50ms/);
});

test('buildChannelThreadContext returns \'\' on an API error (e.g. rate limited)', async () => {
  const fail = { conversations: { replies: async () => { throw new Error('ratelimited'); } } };
  const errors = [];
  assert.equal(await buildChannelThreadContext({ ...ctxOpts(fail), onError: e => errors.push(e) }), '');
  assert.equal(errors[0].message, 'ratelimited');
});

test('thread context timeouts stay short', () => {
  assert.ok(THREAD_CONTEXT_REQUEST_TIMEOUT_MS <= 3000);
  assert.ok(THREAD_CONTEXT_DEADLINE_MS <= 5000);
});

test('createLookupClient: no retries, rate-limited calls fail at once, request timeout', () => {
  const client = createLookupClient('xoxb-test', { timeoutMs: 3000 });
  assert.deepEqual(client.retryConfig, { retries: 0 });
  assert.equal(client.rejectRateLimitedCalls, true);
  assert.equal(client.axios.defaults.timeout, 3000);
});

// ── index.js wiring (source checks; index.js starts the service on import) ──

test('index.js: context fetches use the bounded lookup client, gated on --session-group for channel threads', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /const contextClient = createLookupClient\(botToken, \{ timeoutMs: THREAD_CONTEXT_REQUEST_TIMEOUT_MS \}\);/);
  assert.ok(!/getClient/.test(src), 'index.js must not fetch context on the main (unbounded) client');

  const dm = src.slice(src.indexOf('async function handleDM('), src.indexOf('async function handleGroupMessage('));
  assert.match(dm, /await withTimeout\(\(async \(\) => \{\n\s+const replies = await fetchThread\(event\.channel, event\.thread_ts, 5, contextClient\);/);
  assert.match(dm, /\}\)\(\), THREAD_CONTEXT_DEADLINE_MS, 'thread context'\);/);

  const group = src.slice(src.indexOf('async function handleGroupMessage('));
  assert.match(group, /const groupContext = await buildGroupContext\(\{/);
  assert.match(group, /supportsSessionGroup: c4ReceiveSupportsOption\('--session-group'\),/);
  assert.match(group, /fetchThreadContext: \(\) => buildChannelThreadContext\(\{\n\s+client: contextClient,/);
  assert.ok(!/history\.slice\(/.test(group), 'group context is built only by buildGroupContext');
});
