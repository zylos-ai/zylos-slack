import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { GROUP_MODE } from '../src/lib/constants.js';

test('default group mode is explicit and mention-based', () => {
  assert.equal(DEFAULT_CONFIG.groupMode, GROUP_MODE.MENTION);
});
