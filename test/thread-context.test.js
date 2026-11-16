import test from 'node:test';
import assert from 'node:assert/strict';

import { compareSlackTs, fetchThreadMessages, formatThreadContext } from '../src/lib/thread-context.js';

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

test('index.js: channel thread messages get the thread context, with the in-memory history as fallback', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const handler = src.slice(src.indexOf('async function handleGroupMessage('));
  assert.match(handler, /if \(event\.thread_ts && event\.thread_ts !== event\.ts\) \{\n    groupContext = await buildChannelThreadContext\(event, contextLimit\);/);
  assert.match(handler, /if \(!groupContext\) \{/);
  const fn = src.slice(src.indexOf('async function buildChannelThreadContext('));
  assert.match(fn.slice(0, fn.indexOf('\n}\n')), /catch \(err\) \{\n    console\.warn/);
});
