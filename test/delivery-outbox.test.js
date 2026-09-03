import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { DELIVERY_STATE } from '../src/lib/constants.js';
import { createDeliveryOutbox } from '../src/lib/delivery-outbox.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-outbox-'));
  return { dir, journalPath: path.join(dir, 'delivery.jsonl') };
}

function record(msgId = 'C1-1.0') {
  return {
    msgId,
    source: 'slack',
    endpoint: `C1|type:dm|msg:${msgId}`,
    content: `message:${msgId}`,
    channel: 'C1',
    ts: '1.0',
  };
}

test('persists pending deliveries and recovers them after restart', () => {
  const { journalPath } = fixture();
  createDeliveryOutbox({ journalPath }).enqueue(record());

  const restarted = createDeliveryOutbox({ journalPath });
  assert.equal(restarted.lookup('C1-1.0').state, DELIVERY_STATE.PENDING);
  assert.deepEqual(restarted.pendingRecords().map(item => item.msgId), ['C1-1.0']);
});

test('persists retry metadata across restart', () => {
  const { journalPath } = fixture();
  const outbox = createDeliveryOutbox({ journalPath });
  outbox.enqueue(record());
  outbox.markRetry('C1-1.0', {
    attempts: 2,
    nextAttemptAt: Date.parse('2026-09-03T12:00:00.000Z'),
    error: { code: 'INTERNAL_ERROR', message: 'database busy', retryable: true },
  });

  const pending = createDeliveryOutbox({ journalPath }).pendingRecords()[0];
  assert.equal(pending.attempts, 2);
  assert.equal(pending.nextAttemptAt, '2026-09-03T12:00:00.000Z');
  assert.equal(pending.lastError.code, 'INTERNAL_ERROR');
});

test('suppresses duplicates after delivered or dead-letter terminal states', () => {
  const { journalPath } = fixture();
  const outbox = createDeliveryOutbox({ journalPath });

  outbox.enqueue(record('delivered'));
  outbox.markDelivered('delivered');
  const duplicate = outbox.enqueue(record('delivered'));
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.state, DELIVERY_STATE.DELIVERED);
  assert.equal(duplicate.record.msgId, 'delivered');

  outbox.enqueue(record('dead'));
  outbox.markDeadLetter('dead', {
    attempts: 1,
    error: { code: 'INVALID_ARGS', message: 'bad endpoint', retryable: false },
  });
  assert.equal(outbox.enqueue(record('dead')).state, DELIVERY_STATE.DEAD_LETTER);
});

test('keeps pending state when delivered acknowledgement cannot be persisted', () => {
  const { journalPath } = fixture();
  const events = [];
  const outbox = createDeliveryOutbox({
    journalPath,
    appendEvent(event) {
      if (event.state === DELIVERY_STATE.DELIVERED) throw new Error('disk full');
      events.push(event);
      fs.appendFileSync(journalPath, `${JSON.stringify(event)}\n`);
    },
  });
  outbox.enqueue(record());

  assert.throws(() => outbox.markDelivered('C1-1.0'), /disk full/);
  assert.equal(outbox.lookup('C1-1.0').state, DELIVERY_STATE.PENDING);
  assert.equal(events.length, 1);
});

test('reports corrupt journal lines but retains valid pending records', () => {
  const { journalPath } = fixture();
  fs.writeFileSync(journalPath, '{bad-json}\n');
  const errors = [];
  const outbox = createDeliveryOutbox({
    journalPath,
    onError: message => errors.push(message),
  });

  outbox.enqueue(record());
  assert.equal(errors.length, 1);
  assert.equal(outbox.pendingRecords().length, 1);
});
