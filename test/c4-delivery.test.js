import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyC4Failure,
  createC4Deliverer,
  createC4MessageSender,
  deliverWithRetry,
  parseC4Response,
} from '../src/lib/c4-delivery.js';
import { C4_ERROR_CODE } from '../src/lib/constants.js';

function processError(response) {
  const error = new Error('process exited with code 1');
  error.stdout = JSON.stringify(response);
  return error;
}

test('parses structured C4 responses', () => {
  assert.deepEqual(parseC4Response('{"ok":true,"id":42}'), { ok: true, id: 42 });
  assert.equal(parseC4Response('not-json'), null);
  assert.equal(parseC4Response('diagnostic\n{"ok":true,"id":42}'), null);
});

test('classifies only INVALID_ARGS as a permanent C4 rejection', () => {
  const failure = classifyC4Failure(processError({
    ok: false,
    error: { code: C4_ERROR_CODE.INVALID_ARGS, message: 'invalid endpoint' },
  }));

  assert.equal(failure.code, C4_ERROR_CODE.INVALID_ARGS);
  assert.equal(failure.retryable, false);
});

for (const code of [
  C4_ERROR_CODE.INTERNAL_ERROR,
  C4_ERROR_CODE.UNHEALTHY_NOTIFY_FAILED,
  'FUTURE_TRANSIENT_CODE',
]) {
  test(`classifies ${code} as retryable`, () => {
    const failure = classifyC4Failure(processError({
      ok: false,
      error: { code, message: 'temporary failure' },
    }));

    assert.equal(failure.code, code);
    assert.equal(failure.retryable, true);
  });
}

test('classifies unstructured process errors as retryable transport failures', () => {
  const failure = classifyC4Failure(new Error('timeout'));

  assert.equal(failure.code, C4_ERROR_CODE.TRANSPORT_ERROR);
  assert.equal(failure.retryable, true);
});

test('uses execFile arguments without shell interpolation', async () => {
  let invocation;
  const deliver = createC4Deliverer({
    scriptPath: '/tmp/c4-receive.js',
    execFileImpl(command, args, options, callback) {
      invocation = { command, args, options };
      callback(null, '{"ok":true,"id":7}');
    },
  });

  const response = await deliver({
    source: 'slack',
    endpoint: 'C1|type:dm|msg:1.0',
    content: "message with 'quotes' and $shell syntax",
  });

  assert.equal(invocation.command, 'node');
  assert.deepEqual(invocation.args, [
    '/tmp/c4-receive.js',
    '--channel', 'slack',
    '--endpoint', 'C1|type:dm|msg:1.0',
    '--json',
    '--content', "message with 'quotes' and $shell syntax",
  ]);
  assert.equal(invocation.options.timeout, 35_000);
  assert.deepEqual(response, { ok: true, id: 7 });
});

test('rejects a structured failure even if the child exits successfully', async () => {
  const deliver = createC4Deliverer({
    scriptPath: '/tmp/c4-receive.js',
    execFileImpl(command, args, options, callback) {
      callback(null, JSON.stringify({
        ok: false,
        error: { code: C4_ERROR_CODE.INTERNAL_ERROR, message: 'database busy' },
      }));
    },
  });

  await assert.rejects(
    deliver({ source: 'slack', endpoint: 'C1', content: 'hello' }),
    error => error.code === C4_ERROR_CODE.INTERNAL_ERROR && error.retryable === true,
  );
});

for (const [name, stdout] of [
  ['empty stdout', ''],
  ['plain text', 'queued'],
  ['diagnostic text followed by JSON', 'diagnostic\n{"ok":true,"id":7}'],
  ['JSON without an explicit success flag', '{"id":7}'],
]) {
  test(`fails closed for ${name}`, async () => {
    const deliver = createC4Deliverer({
      scriptPath: '/tmp/c4-receive.js',
      execFileImpl(command, args, options, callback) {
        callback(null, stdout);
      },
    });

    await assert.rejects(
      deliver({ source: 'slack', endpoint: 'C1', content: 'hello' }),
      error => error.code === C4_ERROR_CODE.PROTOCOL_ERROR && error.retryable === true,
    );
  });
}

test('does not trust ok=true when the child process reports failure', async () => {
  const deliver = createC4Deliverer({
    scriptPath: '/tmp/c4-receive.js',
    execFileImpl(command, args, options, callback) {
      callback(new Error('process exited with code 1'), '{"ok":true,"id":7}');
    },
  });

  await assert.rejects(
    deliver({ source: 'slack', endpoint: 'C1', content: 'hello' }),
    error => error.code === C4_ERROR_CODE.TRANSPORT_ERROR && error.retryable === true,
  );
});

test('retries a transient failure once and returns the later success', async () => {
  let calls = 0;
  const waits = [];
  const retries = [];
  const response = await deliverWithRetry({ msgId: 'message-1' }, {
    deliver: async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('temporary failure'), { retryable: true });
      }
      return { ok: true, id: 7 };
    },
    retryDelaysMs: [25],
    wait: async delay => waits.push(delay),
    onRetry: async (error, retryNumber, delay) => retries.push({ retryNumber, delay }),
  });

  assert.deepEqual(response, { ok: true, id: 7 });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [25]);
  assert.deepEqual(retries, [{ retryNumber: 1, delay: 25 }]);
});

test('does not retry a permanent C4 rejection', async () => {
  let calls = 0;
  await assert.rejects(
    deliverWithRetry({ msgId: 'message-1' }, {
      deliver: async () => {
        calls += 1;
        throw Object.assign(new Error('invalid args'), { retryable: false });
      },
      retryDelaysMs: [1, 2, 3],
      wait: async () => {},
    }),
    /invalid args/,
  );
  assert.equal(calls, 1);
});

test('stops after the configured in-process retry budget is exhausted', async () => {
  let calls = 0;
  await assert.rejects(
    deliverWithRetry({ msgId: 'message-1' }, {
      deliver: async () => {
        calls += 1;
        throw Object.assign(new Error('still unavailable'), { retryable: true });
      },
      retryDelaysMs: [1, 2],
      wait: async () => {},
    }),
    /still unavailable/,
  );
  assert.equal(calls, 3, 'one initial attempt plus two configured retries');
});

for (const messageType of ['dm', 'group']) {
  test(`${messageType} records use the same success/failure delivery contract`, async () => {
    const record = { msgId: `${messageType}-1`, messageType, content: 'hello' };
    const delivered = [];
    const failed = [];
    const sender = createC4MessageSender({
      deliver: async entry => ({ ok: true, id: entry.msgId }),
      retryDelaysMs: [],
      onDelivered: entry => delivered.push(entry.msgId),
      onFailed: entry => failed.push(entry.msgId),
    });

    assert.deepEqual(await sender(record), { ok: true, id: record.msgId });
    assert.deepEqual(delivered, [record.msgId]);
    assert.deepEqual(failed, []);

    const rejection = createC4MessageSender({
      deliver: async () => {
        throw Object.assign(new Error('C4 rejected'), { retryable: false });
      },
      retryDelaysMs: [],
      onFailed: entry => failed.push(entry.msgId),
    });
    await assert.rejects(rejection(record), /C4 rejected/);
    assert.deepEqual(failed, [record.msgId]);
  });
}
