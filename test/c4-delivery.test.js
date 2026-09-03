import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyC4Failure,
  createC4Deliverer,
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
