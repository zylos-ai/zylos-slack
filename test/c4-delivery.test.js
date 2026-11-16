import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as realExecFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildC4ReceiveArgs,
  C4_RECEIVE_TIMEOUT_MS,
  c4ReceiveSupportsOption,
  classifyC4Rejection,
  createC4MessageSender,
  getC4ReceivePath,
  MAYBE_LOST,
  noticeForOutcome,
  parseC4Response,
  TRY_LATER,
} from '../src/lib/c4-delivery.js';
import { C4_OUTCOME } from '../src/lib/constants.js';
import { MessageDeduplicator } from '../src/lib/dedup.js';
import { getMessageDedupKey } from '../src/lib/mentions.js';

// Isolated deployment: temp HOME and ZYLOS_DIR with a fake c4-receive.js that
// records its argv and replays scripted responses. The real Core and any
// running Slack service are never touched.
let root, prevEnv, scriptsDir, callsFile, responsesFile, envFile;
const SG = { '--session-group': { takesValue: true } };
const CORE_TEXT = 'Core text meant for the agent';
const CHANNEL = 'C0123ABCDEF';
const THREAD = '1763280000.000100';
const THREAD_EP = `${CHANNEL}|type:group|msg:1763280001.000200|thread:${THREAD}`;
const THREAD_GROUP = `group-${CHANNEL}:topic-${THREAD}`;
const FAKE_TOKEN = 'xoxb-fake-token-for-tests';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-c4-'));
  prevEnv = { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR, SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN };
  process.env.HOME = path.join(root, 'home');
  process.env.ZYLOS_DIR = path.join(root, 'zylos');
  process.env.SLACK_BOT_TOKEN = FAKE_TOKEN;
  scriptsDir = path.join(process.env.ZYLOS_DIR, '.claude/skills/comm-bridge/scripts');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  callsFile = path.join(root, 'calls.jsonl');
  responsesFile = path.join(root, 'responses.json');
  envFile = path.join(root, 'env.jsonl');
  fs.writeFileSync(path.join(scriptsDir, 'c4-receive.js'), `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
fs.appendFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env.SLACK_BOT_TOKEN ?? null) + '\\n');
const list = JSON.parse(fs.readFileSync(${JSON.stringify(responsesFile)}, 'utf8'));
const r = list.length > 1 ? list.shift() : list[0];
fs.writeFileSync(${JSON.stringify(responsesFile)}, JSON.stringify(list));
if (r.hangMs) { setTimeout(() => process.exit(0), r.hangMs); return; }
if (r.signal) process.kill(process.pid, r.signal);
if (r.stdout) process.stdout.write(r.stdout);
// a large write must flush before exit, so end without process.exit()
if (r.stdoutBytes) { process.stdout.write('x'.repeat(r.stdoutBytes)); process.exitCode = r.exit; } else process.exit(r.exit);
`);
  fs.writeFileSync(path.join(scriptsDir, 'package.json'), '{"type":"commonjs"}');
});

afterEach(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const optionsPath = () => path.join(scriptsDir, 'c4-receive-options.json');
const writeOptions = options => fs.writeFileSync(optionsPath(), JSON.stringify({ options }));
const script = (...list) => fs.writeFileSync(responsesFile, JSON.stringify(list));
const recorded = () => fs.existsSync(callsFile)
  ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  : [];
const reject = (code, persisted) => {
  const error = { code, message: CORE_TEXT };
  if (persisted !== 'absent') error.persisted = persisted;
  return { exit: 1, stdout: JSON.stringify({ ok: false, error }) };
};
const OK = { exit: 0, stdout: '{"ok":true,"id":7}' };

function silentLogger() {
  const lines = [];
  const push = level => (...args) => lines.push([level, args.join(' ')]);
  return { lines, log: push('log'), warn: push('warn'), error: push('error') };
}

/**
 * Run one delivery against the fake Core.
 * spawnFailures: how many attempts run a missing executable instead (a real
 * spawn failure, so c4-receive never starts); onSpawnFail runs on each.
 */
async function send(endpoint = THREAD_EP, { spawnFailures = 0, onSpawnFail, timeoutMs, content = 'hello' } = {}) {
  const notices = [];
  const delivered = [];
  const execCalls = [];
  const waits = [];
  const logger = silentLogger();
  const missing = path.join(root, 'missing-node');
  const execFileImpl = (file, args, opts, cb) => {
    execCalls.push({ file, args, opts });
    if (spawnFailures > 0) {
      spawnFailures -= 1;
      if (onSpawnFail) onSpawnFail();
      return realExecFile(missing, args, opts, cb);
    }
    return realExecFile(file, args, opts, cb);
  };
  const sender = createC4MessageSender({
    ...(timeoutMs !== undefined && { timeoutMs }),
    execFileImpl,
    wait: async delay => { waits.push(delay); },
    onDelivered: (record, response) => delivered.push(response),
    onRejected: (record, notice, outcome) => notices.push([notice, outcome]),
    logger,
  });
  const result = await sender({ msgId: 'C1-1', source: 'slack', endpoint, content });
  return {
    outcome: result.outcome,
    result,
    notices: notices.map(([notice]) => notice),
    delivered,
    execCalls,
    waits,
    logs: logger.lines,
    calls: recorded(),
  };
}

const assertNoCoreText = notices => {
  for (const n of notices) assert.ok(n === null || !String(n).includes(CORE_TEXT), `leaked core text: ${n}`);
};

describe('option probe and argv', () => {
  const base = { source: 'slack', endpoint: 'D0123|type:dm|msg:1.2', content: 'hi', sessionGroup: 'dm-D0123' };
  // Golden sample: argv after c4-receive.js exactly as origin/main aa3d29a (v0.1.3) built it.
  const GOLDEN = ['--channel', 'slack', '--endpoint', 'D0123|type:dm|msg:1.2', '--json', '--content', 'hi'];
  const supported = () => c4ReceiveSupportsOption('--session-group');

  test('no options file (old Core): argv identical to the pre-multi-session build', () => {
    assert.equal(supported(), false);
    assert.deepEqual(buildC4ReceiveArgs({ ...base, supportsSessionGroup: supported() }), GOLDEN);
  });

  test('options file without --session-group (0.9.x shape): not passed', () => {
    writeOptions({ '--channel': { takesValue: true }, '--endpoint': { takesValue: true }, '--json': {} });
    assert.deepEqual(buildC4ReceiveArgs({ ...base, supportsSessionGroup: supported() }), GOLDEN);
  });

  test('malformed options files count as unsupported', () => {
    const bad = [
      '{not json',
      'null',
      '[]',
      JSON.stringify({ options: ['--session-group'] }),
      JSON.stringify({ options: null }),
      JSON.stringify({ options: 'x' }),
      JSON.stringify({ '--session-group': {} }),
    ];
    for (const text of bad) {
      fs.writeFileSync(optionsPath(), text);
      assert.equal(supported(), false, text);
      assert.deepEqual(buildC4ReceiveArgs({ ...base, supportsSessionGroup: supported() }), GOLDEN, text);
    }
  });

  test('inherited keys are ignored (own keys only)', () => {
    fs.writeFileSync(optionsPath(), JSON.stringify({ options: {} }));
    assert.equal(c4ReceiveSupportsOption('toString'), false);
    assert.equal(c4ReceiveSupportsOption('constructor'), false);
  });

  test('unreadable options path counts as unsupported', () => {
    fs.mkdirSync(optionsPath());
    assert.equal(supported(), false);
  });

  test('supported: group appended last', () => {
    writeOptions(SG);
    assert.deepEqual(buildC4ReceiveArgs({ ...base, supportsSessionGroup: supported() }),
      [...GOLDEN, '--session-group', 'dm-D0123']);
  });

  test('empty or missing group is never passed', () => {
    assert.deepEqual(buildC4ReceiveArgs({ ...base, sessionGroup: '', supportsSessionGroup: true }), GOLDEN);
    assert.deepEqual(buildC4ReceiveArgs({ ...base, sessionGroup: undefined, supportsSessionGroup: true }), GOLDEN);
  });

  test('options file is re-read on every call', () => {
    assert.equal(supported(), false);
    writeOptions(SG);
    assert.equal(supported(), true);
    fs.rmSync(optionsPath());
    assert.equal(supported(), false);
  });

  test('the installed Core on this machine shape: the real options manifest format is understood', () => {
    // Same shape as zylos-core 1.0.0-beta.11 comm-bridge/scripts/c4-receive-options.json
    writeOptions({
      '--channel': { takesValue: true }, '--endpoint': { takesValue: true },
      '--priority': { takesValue: true }, '--no-reply': { takesValue: false },
      '--json': { takesValue: false }, '--content': { takesValue: true },
      '--session-group': { takesValue: true }, '--core-source': { takesValue: true },
    });
    assert.equal(supported(), true);
  });

  test('c4-receive path follows ZYLOS_DIR, falling back to $HOME/zylos', () => {
    assert.equal(getC4ReceivePath(), path.join(scriptsDir, 'c4-receive.js'));
    process.env.ZYLOS_DIR = '';
    assert.equal(getC4ReceivePath(),
      path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js'));
  });

  test('parses structured C4 responses only when the whole output is JSON', () => {
    assert.deepEqual(parseC4Response('{"ok":true,"id":42}'), { ok: true, id: 42 });
    assert.equal(parseC4Response('not-json'), null);
    assert.equal(parseC4Response('diagnostic\n{"ok":true,"id":42}'), null);
    assert.equal(parseC4Response(''), null);
  });
});

describe('rejection classification and notices', () => {
  test('separates stored, not stored and uncertain', () => {
    assert.equal(classifyC4Rejection({ ok: false, error: { persisted: ['D1'] } }), 'stored');
    assert.equal(classifyC4Rejection({ ok: false, error: { persisted: [] } }), 'not_stored');
    assert.equal(classifyC4Rejection({ ok: false, error: { persisted: null } }), 'uncertain');
    assert.equal(classifyC4Rejection({ ok: false, error: {} }), 'uncertain');
    assert.equal(classifyC4Rejection({ ok: false, error: { persisted: 'D1' } }), 'uncertain');
  });

  test('notices are the same sentences as zylos-lark / zylos-feishu, verbatim', () => {
    assert.equal(TRY_LATER, "Sorry, I couldn't take this message right now. Please try again later.");
    assert.equal(MAYBE_LOST, "Sorry, this message may not have reached me. If you don't get a reply in a few minutes, please send it again.");
  });

  test('notice per outcome', () => {
    assert.equal(noticeForOutcome(C4_OUTCOME.SENT), null);
    assert.equal(noticeForOutcome(C4_OUTCOME.STORED), null);
    assert.equal(noticeForOutcome(C4_OUTCOME.EMPTY), null);
    assert.equal(noticeForOutcome(C4_OUTCOME.NOT_STORED), TRY_LATER);
    assert.equal(noticeForOutcome(C4_OUTCOME.NO_GROUP), TRY_LATER);
    assert.equal(noticeForOutcome(C4_OUTCOME.UNCERTAIN), MAYBE_LOST);
    assert.equal(noticeForOutcome(C4_OUTCOME.UNKNOWN), MAYBE_LOST);
    assert.equal(noticeForOutcome(C4_OUTCOME.FAILED), MAYBE_LOST);
  });
});

describe('delivery, rejection and retry handling', () => {
  test('new Core: sends the topic group, runs process.execPath with the 35s timeout', async () => {
    writeOptions(SG);
    script(OK);
    const r = await send();
    assert.equal(r.outcome, 'sent');
    assert.equal(r.result.sessionGroup, THREAD_GROUP);
    assert.deepEqual(r.delivered, [{ ok: true, id: 7 }]);
    assert.deepEqual(r.notices, []);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0].slice(-2), ['--session-group', THREAD_GROUP]);
    assert.equal(r.execCalls[0].file, process.execPath);
    assert.equal(r.execCalls[0].args[0], path.join(scriptsDir, 'c4-receive.js'));
    assert.equal(C4_RECEIVE_TIMEOUT_MS, 35000);
    assert.equal(r.execCalls[0].opts.timeout, 35000);
  });

  test('new Core: DM (thread not split), channel and group-DM names', async () => {
    writeOptions(SG);
    script(OK);
    let r = await send(`D0123ABC|type:dm|msg:1763280001.000200|thread:${THREAD}`);
    assert.deepEqual(r.calls[0].slice(-2), ['--session-group', 'dm-D0123ABC']);
    fs.rmSync(callsFile);
    r = await send(`${CHANNEL}|type:group|msg:1763280001.000200`);
    assert.deepEqual(r.calls[0].slice(-2), ['--session-group', `group-${CHANNEL}`]);
    fs.rmSync(callsFile);
    r = await send('G0123MPIM|type:group|msg:1763280001.000200');
    assert.deepEqual(r.calls[0].slice(-2), ['--session-group', 'group-G0123MPIM']);
  });

  test('old Core: argv identical to origin/main (golden)', async () => {
    script(OK);
    const r = await send(THREAD_EP, { content: "message with 'quotes' and $shell syntax" });
    assert.deepEqual(r.calls[0], ['--channel', 'slack', '--endpoint', THREAD_EP, '--json',
      '--content', "message with 'quotes' and $shell syntax"]);
    assert.equal(r.outcome, 'sent');
    assert.equal(r.result.sessionGroup, undefined);
  });

  test('the bot token never appears in argv or in a log line; the child env is inherited', async () => {
    for (const core of ['old', 'new']) {
      if (core === 'new') writeOptions(SG);
      script(reject('SOME_ERROR', 'absent'));
      const r = await send();
      for (const call of r.execCalls) {
        assert.ok(!call.args.join('\n').includes(FAKE_TOKEN), `${core}: token in argv`);
        assert.equal(call.opts.env, undefined, `${core}: env is inherited, not rebuilt`);
      }
      for (const [, line] of r.logs) assert.ok(!line.includes(FAKE_TOKEN), `${core}: token in log`);
    }
  });

  test('exit 0 with ok:false is a rejection, not a success', async () => {
    writeOptions(SG);
    script({ exit: 0, stdout: JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: CORE_TEXT, persisted: [] } }) });
    const r = await send();
    assert.equal(r.outcome, 'not_stored');
    assert.deepEqual(r.notices, [TRY_LATER]);
    assert.equal(r.calls.length, 1);
  });

  for (const code of ['SESSION_GROUP_INVALID', 'SESSION_GROUP_TOO_LONG', 'INVALID_ARGS']) {
    test(`${code} with persisted []: TRY_LATER, one call, never resent without the group`, async () => {
      writeOptions(SG);
      script(reject(code, []), OK);
      const r = await send();
      assert.equal(r.outcome, 'not_stored');
      assert.deepEqual(r.notices, [TRY_LATER]);
      assert.equal(r.calls.length, 1);
      assert.deepEqual(r.calls.at(-1).slice(-2), ['--session-group', THREAD_GROUP]);
      assert.deepEqual(r.delivered, []);
      assertNoCoreText(r.notices);
    });
  }

  test('stored (persisted non-empty): notice null, nothing sent, no resend', async () => {
    writeOptions(SG);
    script(reject('UNHEALTHY_NOTIFY_FAILED', ['D1']), OK);
    const r = await send();
    assert.equal(r.outcome, 'stored');
    assert.deepEqual(r.notices, [null]);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.delivered, []);
  });

  for (const persisted of [null, 'absent']) {
    test(`uncertain (persisted ${persisted}): MAYBE_LOST, no resend`, async () => {
      script(reject('INTERNAL_ERROR', persisted), OK);
      const r = await send();
      assert.equal(r.outcome, 'uncertain');
      assert.deepEqual(r.notices, [MAYBE_LOST]);
      assert.equal(r.calls.length, 1);
      assertNoCoreText(r.notices);
    });
  }

  const unknownCases = [
    ['non-zero exit without output', { exit: 1 }],
    ['non-JSON output', { exit: 2, stdout: 'boom' }],
    ['clean exit without output', { exit: 0 }],
    ['clean exit with plain text', { exit: 0, stdout: 'queued' }],
    ['clean exit with diagnostic text before JSON', { exit: 0, stdout: 'diagnostic\n{"ok":true}' }],
    ['clean exit with JSON lacking ok:true', { exit: 0, stdout: '{"id":7}' }],
    ['ok:true but non-zero exit', { exit: 1, stdout: '{"ok":true}' }],
    ['killed by SIGKILL', { signal: 'SIGKILL', exit: 0 }],
    ['output beyond maxBuffer', { stdoutBytes: 2 * 1024 * 1024, exit: 0 }],
  ];
  for (const [label, response] of unknownCases) {
    test(`unknown outcome (${label}): MAYBE_LOST, not resent`, async () => {
      writeOptions(SG);
      script(response, OK);
      const r = await send();
      assert.equal(r.outcome, 'unknown');
      assert.deepEqual(r.notices, [MAYBE_LOST]);
      assert.equal(r.calls.length, 1);
      assert.equal(r.execCalls.length, 1);
      assert.deepEqual(r.delivered, []);
      assert.deepEqual(r.waits, []);
    });
  }

  for (const core of ['new', 'old']) {
    test(`${core} Core: timeout kills c4-receive, MAYBE_LOST, not resent`, async () => {
      if (core === 'new') writeOptions(SG);
      script({ hangMs: 5000, exit: 0 }, OK);
      const r = await send(THREAD_EP, { timeoutMs: 300 });
      assert.equal(r.outcome, 'unknown');
      assert.deepEqual(r.notices, [MAYBE_LOST]);
      assert.equal(r.execCalls.length, 1);
      assert.equal(r.execCalls[0].opts.timeout, 300);
      assert.deepEqual(r.delivered, []);
    });
  }

  test('spawn failure: retried once after 2s, options re-read, same group', async () => {
    script(OK);
    // Core gets upgraded between the attempts: the retry must see the new options file.
    const r = await send(THREAD_EP, { spawnFailures: 1, onSpawnFail: () => writeOptions(SG) });
    assert.equal(r.outcome, 'sent');
    assert.deepEqual(r.waits, [2000]);
    assert.equal(r.execCalls.length, 2);
    assert.ok(!r.execCalls[0].args.includes('--session-group'));
    assert.deepEqual(r.execCalls[1].args.slice(-2), ['--session-group', THREAD_GROUP]);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.notices, []);
  });

  test('spawn failure twice: MAYBE_LOST after exactly one retry', async () => {
    writeOptions(SG);
    script(OK);
    const r = await send(THREAD_EP, { spawnFailures: 2 });
    assert.equal(r.outcome, 'failed');
    assert.equal(r.execCalls.length, 2);
    assert.deepEqual(r.execCalls[0].args, r.execCalls[1].args);
    assert.deepEqual(r.notices, [MAYBE_LOST]);
    assert.equal(r.calls.length, 0);
  });

  test('spawn failure then structured rejection: handled like the first attempt', async () => {
    writeOptions(SG);
    script(reject('SESSION_GROUP_INVALID', []));
    const r = await send(THREAD_EP, { spawnFailures: 1 });
    assert.equal(r.outcome, 'not_stored');
    assert.deepEqual(r.notices, [TRY_LATER]);
    assert.equal(r.execCalls.length, 2);
  });

  const UNMAPPABLE = ['C0123', `${CHANNEL}|type:topic`, 'c0123|type:group', `${CHANNEL}|type:group|thread:abc`, 'U0123|type:dm'];
  for (const endpoint of UNMAPPABLE) {
    test(`no session group for ${JSON.stringify(endpoint)}: TRY_LATER, Core never called`, async () => {
      writeOptions(SG);
      script(OK);
      const r = await send(endpoint);
      assert.equal(r.outcome, 'no_group');
      assert.deepEqual(r.notices, [TRY_LATER]);
      assert.equal(r.execCalls.length, 0);
      assert.equal(r.calls.length, 0);
    });
  }

  for (const endpoint of UNMAPPABLE) {
    test(`old Core: no session group is derived, ${JSON.stringify(endpoint)} is sent exactly as on main`, async () => {
      script(OK);
      const r = await send(endpoint);
      assert.equal(r.outcome, 'sent');
      assert.deepEqual(r.notices, []);
      assert.deepEqual(r.calls, [['--channel', 'slack', '--endpoint', endpoint, '--json', '--content', 'hello']]);
    });
  }

  test('spawn failure on an old Core, Core upgraded before the retry, unmappable endpoint: TRY_LATER, Core never reached', async () => {
    script(OK);
    const r = await send('C0123', { spawnFailures: 1, onSpawnFail: () => writeOptions(SG) });
    assert.equal(r.outcome, 'no_group');
    assert.deepEqual(r.notices, [TRY_LATER]);
    assert.equal(r.execCalls.length, 1);
    assert.equal(r.calls.length, 0);
  });

  test('empty content: not sent, no notice', async () => {
    const r = await send(THREAD_EP, { content: '' });
    assert.equal(r.outcome, 'empty');
    assert.equal(r.execCalls.length, 0);
    assert.deepEqual(r.notices, []);
  });

  test('a failing notice hook does not turn the outcome into an error', async () => {
    writeOptions(SG);
    script(reject('SOME_ERROR', []));
    const sender = createC4MessageSender({
      onRejected: async () => { throw new Error('chat.postMessage failed'); },
      logger: silentLogger(),
    });
    const result = await sender({ source: 'slack', endpoint: THREAD_EP, content: 'x' });
    assert.equal(result.outcome, 'not_stored');
  });
});

describe('no duplicate delivery (message + app_mention for one Slack message)', () => {
  // index.js runs every handler through MessageDeduplicator keyed by
  // channel-ts. Before 0.2.0 a C4 timeout threw, the key was released and the
  // waiting app_mention event delivered the same message again.
  const event = { channel: CHANNEL, ts: '1763280001.000200', text: 'hi <@UBOT>' };

  for (const [label, response] of [
    ['timeout', { hangMs: 5000, exit: 0 }],
    ['uncertain rejection', reject('INTERNAL_ERROR', 'absent')],
    ['not stored', reject('INTERNAL_ERROR', [])],
  ]) {
    test(`${label}: c4-receive runs once for both events`, async () => {
      writeOptions(SG);
      script(response, OK);
      const notices = [];
      const sender = createC4MessageSender({
        timeoutMs: 300,
        onRejected: (record, notice) => notices.push(notice),
        logger: silentLogger(),
      });
      const dedup = new MessageDeduplicator({ ttlMs: 60_000 });
      const key = getMessageDedupKey(event);
      const handle = () => sender({ msgId: key, source: 'slack', endpoint: THREAD_EP, content: 'hi' });
      const results = await Promise.all([dedup.run(key, handle), dedup.run(key, handle)]);
      assert.deepEqual(results.map(r => r.processed).sort(), [false, true]);
      // a later redelivery of the same event is suppressed too
      assert.equal((await dedup.run(key, handle)).processed, false);
      assert.equal(recorded().length, 1);
      assert.equal(notices.length, 1);
    });
  }
});

describe('index.js wiring (source checks)', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

  test('every inbound call goes through createC4MessageSender; index.js never spawns c4-receive', () => {
    assert.match(src, /import \{ c4ReceiveSupportsOption, createC4MessageSender \} from '\.\/lib\/c4-delivery\.js';/);
    assert.equal(src.match(/createC4MessageSender\(/g).length, 1);
    assert.ok(!/\bexecFile\b/.test(src));
    assert.ok(!src.includes('c4-receive.js'), 'path comes from getC4ReceivePath() ($ZYLOS_DIR aware)');
    assert.equal(src.match(/await sendToC4\(\{/g).length, 2, 'DM and group handlers');
  });

  test('reject handler clears the hourglass and posts the notice into the thread', () => {
    const handler = src.slice(src.indexOf('onRejected: async (record, notice) => {'));
    const body = handler.slice(0, handler.indexOf('\n  },'));
    assert.match(body, /await clearFailedTypingIndicator\(record\);/);
    assert.match(body, /if \(notice\) await sendRejectNotice\(record, notice\);/);
    const notice = src.slice(src.indexOf('async function sendRejectNotice('));
    assert.match(notice.slice(0, notice.indexOf('\n}\n')),
      /sendText\(record\.channel, notice, \{ thread_ts: record\.threadTs \|\| record\.ts \}\)/);
    assert.equal(src.match(/ts: event\.ts,\n    threadTs: event\.thread_ts,\n    hasTypingIndicator/g).length, 2);
  });
});
