import test from 'node:test';
import assert from 'node:assert/strict';

import { GROUP_POLICY } from '../src/lib/constants.js';
import { isGroupAccessAllowed } from '../src/lib/policy.js';

const access = (overrides = {}) => isGroupAccessAllowed({
  groupPolicy: GROUP_POLICY.OPEN,
  groupConfig: undefined,
  userId: 'U_MEMBER',
  isOwner: false,
  ...overrides,
});

test('disabled group policy blocks owner and non-owner messages', () => {
  assert.equal(access({ groupPolicy: GROUP_POLICY.DISABLED, isOwner: true }), false);
  assert.equal(access({ groupPolicy: GROUP_POLICY.DISABLED, isOwner: false }), false);
});

test('allowlist group policy preserves the owner bypass', () => {
  assert.equal(access({ groupPolicy: GROUP_POLICY.ALLOWLIST, isOwner: true }), true);
  assert.equal(access({ groupPolicy: GROUP_POLICY.ALLOWLIST, isOwner: false }), false);
  assert.equal(access({
    groupPolicy: GROUP_POLICY.ALLOWLIST,
    groupConfig: {},
    isOwner: false,
  }), true);
});

test('per-group sender allowlist preserves the owner bypass', () => {
  const groupConfig = { allowFrom: ['U_ALLOWED'] };

  assert.equal(access({ groupConfig, userId: 'U_ALLOWED' }), true);
  assert.equal(access({ groupConfig, userId: 'U_MEMBER' }), false);
  assert.equal(access({ groupConfig, userId: 'U_OWNER', isOwner: true }), true);
});

test('open group policy allows messages without a sender allowlist', () => {
  assert.equal(access({ groupPolicy: GROUP_POLICY.OPEN }), true);
});
