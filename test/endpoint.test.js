import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEndpoint, parseEndpoint } from '../src/lib/endpoint.js';

// buildEndpoint was moved out of src/index.js unchanged and parseEndpoint out
// of scripts/send.js; the endpoint is the `reply via` value, so its exact
// format is pinned here.

// The original src/index.js builder (origin/main aa3d29a), verbatim.
function originalBuildEndpoint(channel, type, msgTs, threadTs) {
  let ep = `${channel}|type:${type}|msg:${msgTs}`;
  if (threadTs) ep += `|thread:${threadTs}`;
  return ep;
}

// The original scripts/send.js parser (origin/main aa3d29a), verbatim.
function originalParseEndpoint(ep) {
  const parts = ep.split('|');
  const result = { channel: parts[0] };
  for (const part of parts.slice(1)) {
    const [key, val] = part.split(':');
    result[key] = val;
  }
  return result;
}

const SAMPLES = [
  ['D0123ABC', 'dm', '1763280000.000100', undefined],
  ['D0123ABC', 'dm', '1763280001.000200', '1763280000.000100'],
  ['C0123ABC', 'group', '1763280000.000100', undefined],
  ['C0123ABC', 'group', '1763280001.000200', '1763280000.000100'],
  ['G0123MPIM', 'group', '1763280000.000100', ''],
];

test('buildEndpoint output is byte-identical to the original builder', () => {
  for (const sample of SAMPLES) {
    assert.equal(buildEndpoint(...sample), originalBuildEndpoint(...sample));
  }
  assert.equal(buildEndpoint('C1', 'group', '1.2', '0.1'), 'C1|type:group|msg:1.2|thread:0.1');
  assert.equal(buildEndpoint('D1', 'dm', '1.2'), 'D1|type:dm|msg:1.2');
});

test('parseEndpoint agrees with the original send.js parser on every real endpoint and on bare ids', () => {
  for (const sample of SAMPLES) {
    const ep = buildEndpoint(...sample);
    assert.deepEqual(parseEndpoint(ep), originalParseEndpoint(ep));
  }
  for (const bare of ['C0123ABC', 'U0123ABC', 'D0123ABC']) {
    assert.deepEqual(parseEndpoint(bare), originalParseEndpoint(bare));
  }
});

test('parseEndpoint round-trips buildEndpoint', () => {
  assert.deepEqual(parseEndpoint(buildEndpoint('C1', 'group', '1.2', '0.1')),
    { channel: 'C1', type: 'group', msg: '1.2', thread: '0.1' });
});

test('parseEndpoint ignores unknown keys and parts without a key', () => {
  assert.deepEqual(parseEndpoint('C1|type:group|root:x|novalue|:empty|msg:1.2'),
    { channel: 'C1', type: 'group', msg: '1.2' });
});

test('parseEndpoint handles non-string input', () => {
  assert.deepEqual(parseEndpoint(undefined), { channel: '' });
});
