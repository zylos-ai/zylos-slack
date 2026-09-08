import test from 'node:test';
import assert from 'node:assert/strict';

import {
  C4_ERROR_CODE,
  C4_ERROR_CODE_VALUES,
  CLI_TOGGLE,
  CLI_TOGGLE_VALUES,
  CONNECTION_MODE,
  CONNECTION_MODE_VALUES,
  DEDUP_STATE,
  DEDUP_STATE_VALUES,
  DM_POLICY,
  DM_POLICY_VALUES,
  ENDPOINT_TYPE,
  ENDPOINT_TYPE_VALUES,
  GROUP_MODE,
  GROUP_MODE_VALUES,
  GROUP_POLICY,
  GROUP_POLICY_VALUES,
  SLACK_CHANNEL_TYPE,
  SLACK_CHANNEL_TYPE_VALUES,
} from '../src/lib/constants.js';

const enumCases = [
  [C4_ERROR_CODE, C4_ERROR_CODE_VALUES, ['INVALID_ARGS', 'INTERNAL_ERROR', 'UNHEALTHY_NOTIFY_FAILED', 'TRANSPORT_ERROR', 'PROTOCOL_ERROR']],
  [CONNECTION_MODE, CONNECTION_MODE_VALUES, ['socket', 'webhook']],
  [DEDUP_STATE, DEDUP_STATE_VALUES, ['processing', 'done']],
  [DM_POLICY, DM_POLICY_VALUES, ['open', 'allowlist', 'owner']],
  [GROUP_POLICY, GROUP_POLICY_VALUES, ['disabled', 'allowlist', 'open']],
  [GROUP_MODE, GROUP_MODE_VALUES, ['mention', 'smart']],
  [SLACK_CHANNEL_TYPE, SLACK_CHANNEL_TYPE_VALUES, ['im', 'channel', 'group']],
  [ENDPOINT_TYPE, ENDPOINT_TYPE_VALUES, ['dm', 'group']],
  [CLI_TOGGLE, CLI_TOGGLE_VALUES, ['on', 'off']],
];

test('enum-like constants expose their canonical values', () => {
  for (const [enumObject, values, expected] of enumCases) {
    assert.deepEqual(values, expected);
    assert.deepEqual(Object.values(enumObject), expected);
  }
});

test('enum-like constants and validation lists are immutable', () => {
  for (const [enumObject, values] of enumCases) {
    assert.equal(Object.isFrozen(enumObject), true);
    assert.equal(Object.isFrozen(values), true);
  }
});
