import test from 'node:test';
import assert from 'node:assert/strict';

import { MessageDeduplicator } from '../src/lib/dedup.js';

const createDeduplicator = (options = {}) => new MessageDeduplicator({
  ttlMs: 5 * 60 * 1000,
  ...options,
});

test('successful processing suppresses later equivalent events', async () => {
  const dedup = createDeduplicator();
  let calls = 0;

  const first = await dedup.run('C1-1.0', async () => ++calls);
  const duplicate = await dedup.run('C1-1.0', async () => ++calls);

  assert.deepEqual(first, { processed: true, result: 1 });
  assert.deepEqual(duplicate, { processed: false });
  assert.equal(calls, 1);
});

for (const order of [
  ['message', 'app_mention'],
  ['app_mention', 'message'],
]) {
  test(`${order.join(' then ')} concurrent deliveries run the handler once`, async () => {
    const dedup = createDeduplicator();
    const calls = [];
    let finishFirst;

    const first = dedup.run('C1-2.0', () => new Promise(resolve => {
      calls.push(order[0]);
      finishFirst = resolve;
    }));
    await Promise.resolve();

    const second = dedup.run('C1-2.0', async () => {
      calls.push(order[1]);
    });
    await Promise.resolve();

    finishFirst();
    await Promise.all([first, second]);

    assert.deepEqual(calls, [order[0]]);
  });
}

test('a waiting equivalent event takes over after the active handler fails', async () => {
  const dedup = createDeduplicator();
  const calls = [];
  let failFirst;

  const first = dedup.run('C1-3.0', () => new Promise((_resolve, reject) => {
    calls.push('message');
    failFirst = reject;
  }));
  const firstFailure = assert.rejects(first, /first delivery failed/);
  await Promise.resolve();

  const second = dedup.run('C1-3.0', async () => {
    calls.push('app_mention');
  });
  await Promise.resolve();

  failFirst(new Error('first delivery failed'));
  await firstFailure;
  assert.deepEqual(await second, { processed: true, result: undefined });
  assert.deepEqual(calls, ['message', 'app_mention']);

  const laterRetry = await dedup.run('C1-3.0', async () => calls.push('retry'));
  assert.deepEqual(laterRetry, { processed: false });
});

test('failed processing releases the key for a later retry', async () => {
  const dedup = createDeduplicator();
  let calls = 0;

  await assert.rejects(
    dedup.run('C1-4.0', async () => {
      calls += 1;
      throw new Error('boom');
    }),
    /boom/,
  );

  assert.deepEqual(
    await dedup.run('C1-4.0', async () => ++calls),
    { processed: true, result: 2 },
  );
});

test('cleanup expires only completed entries after the TTL', async () => {
  let now = 1000;
  const dedup = createDeduplicator({ ttlMs: 100, now: () => now });

  await dedup.run('C1-5.0', async () => {});
  now = 1101;

  assert.equal(dedup.cleanup(), 1);
  assert.deepEqual(
    await dedup.run('C1-5.0', async () => 'again'),
    { processed: true, result: 'again' },
  );
});
