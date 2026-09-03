import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { C4DeliveryError } from '../src/lib/c4-delivery.js';
import { C4_ERROR_CODE, DELIVERY_STATE } from '../src/lib/constants.js';
import { createDeliveryOutbox } from '../src/lib/delivery-outbox.js';
import { createReliableDeliveryQueue } from '../src/lib/reliable-delivery-queue.js';

function setup({ deliver, retryDelaysMs = [100, 200], now: initialNow = 1000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-queue-'));
  const journalPath = path.join(dir, 'delivery.jsonl');
  const clock = { value: initialNow };
  const outbox = createDeliveryOutbox({ journalPath, now: () => clock.value });
  const scheduled = [];
  const queue = createReliableDeliveryQueue({
    outbox,
    deliver,
    retryDelaysMs,
    now: () => clock.value,
    setTimeoutImpl(fn, delay) {
      const timer = { fn, delay };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutImpl() {},
  });
  const record = {
    msgId: 'C1-1.0',
    source: 'slack',
    endpoint: 'C1|type:dm|msg:1.0',
    content: 'hello',
  };
  return { clock, journalPath, outbox, queue, record, scheduled };
}

test('retries transient failures and marks a later success delivered', async () => {
  let calls = 0;
  const state = setup({
    deliver: async () => {
      calls += 1;
      if (calls === 1) {
        throw new C4DeliveryError('database busy', {
          code: C4_ERROR_CODE.INTERNAL_ERROR,
          retryable: true,
        });
      }
    },
  });
  state.queue.enqueue(state.record);

  await state.queue.attemptNow(state.record.msgId);
  let pending = state.outbox.lookup(state.record.msgId);
  assert.equal(pending.state, DELIVERY_STATE.PENDING);
  assert.equal(pending.record.attempts, 1);

  state.clock.value += 100;
  await state.queue.attemptNow(state.record.msgId);
  assert.equal(state.outbox.lookup(state.record.msgId).state, DELIVERY_STATE.DELIVERED);
  assert.equal(calls, 2);
});

test('moves permanent INVALID_ARGS failures directly to dead letter', async () => {
  const state = setup({
    deliver: async () => {
      throw new C4DeliveryError('invalid endpoint', {
        code: C4_ERROR_CODE.INVALID_ARGS,
        retryable: false,
      });
    },
  });
  state.queue.enqueue(state.record);

  await state.queue.attemptNow(state.record.msgId);
  const terminal = state.outbox.lookup(state.record.msgId);
  assert.equal(terminal.state, DELIVERY_STATE.DEAD_LETTER);
  assert.equal(terminal.attempts, 1);
  assert.equal(terminal.error.code, C4_ERROR_CODE.INVALID_ARGS);
});

test('bounds transient retries before moving delivery to dead letter', async () => {
  const state = setup({
    retryDelaysMs: [10, 20],
    deliver: async () => {
      throw new C4DeliveryError('still unavailable', {
        code: C4_ERROR_CODE.INTERNAL_ERROR,
        retryable: true,
      });
    },
  });
  state.queue.enqueue(state.record);

  await state.queue.attemptNow(state.record.msgId);
  state.clock.value += 10;
  await state.queue.attemptNow(state.record.msgId);
  state.clock.value += 20;
  await state.queue.attemptNow(state.record.msgId);

  const terminal = state.outbox.lookup(state.record.msgId);
  assert.equal(terminal.state, DELIVERY_STATE.DEAD_LETTER);
  assert.equal(terminal.attempts, 3);
});

test('startup schedules persisted pending records for recovery', () => {
  const state = setup({ deliver: async () => {} });
  state.outbox.enqueue(state.record);

  assert.equal(state.queue.start(), 1);
  assert.equal(state.scheduled.length, 1);
  assert.equal(state.scheduled[0].delay, 0);
});

test('keeps an ambiguous C4 acknowledgement pending for at-least-once recovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-ambiguous-'));
  const journalPath = path.join(dir, 'delivery.jsonl');
  let rejectDelivered = true;
  const outbox = createDeliveryOutbox({
    journalPath,
    appendEvent(event) {
      if (event.state === DELIVERY_STATE.DELIVERED && rejectDelivered) {
        throw new Error('delivered fsync failed');
      }
      fs.appendFileSync(journalPath, `${JSON.stringify(event)}\n`);
    },
  });
  const queue = createReliableDeliveryQueue({
    outbox,
    deliver: async () => {},
    retryDelaysMs: [1],
  });
  const record = { msgId: 'ack-gap', source: 'slack', endpoint: 'C1', content: 'hello' };
  queue.enqueue(record);

  await queue.attemptNow(record.msgId);
  assert.equal(outbox.lookup(record.msgId).state, DELIVERY_STATE.PENDING);

  queue.stop();
  rejectDelivered = false;
  const restarted = createDeliveryOutbox({ journalPath });
  assert.equal(restarted.pendingRecords()[0].msgId, record.msgId);
});
