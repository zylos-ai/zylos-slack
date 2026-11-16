import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEND = path.join(ROOT, 'scripts', 'send.js');

// [SKIP] exits before any Slack call, so these runs need no token or network.
function runSkip(endpoint) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-send-'));
  const r = spawnSync(process.execPath, [SEND, endpoint, '[SKIP]'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ZYLOS_DIR: path.join(home, 'zylos'), SLACK_BOT_TOKEN: '' },
  });
  const typingDir = path.join(home, 'zylos/components/slack/typing');
  const files = fs.existsSync(typingDir) ? fs.readdirSync(typingDir) : [];
  return { r, files };
}

test('[SKIP] on a reply endpoint clears the typing indicator of that message', () => {
  const { r, files } = runSkip('C0123|type:group|msg:1763280001.000200|thread:1763280000.000100');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(files, ['C0123-1763280001.000200.done']);
});

for (const endpoint of ['C0123', 'U0123', 'C0123|type:group']) {
  test(`no msg in ${JSON.stringify(endpoint)}: no "-undefined.done" file is written`, () => {
    const { r, files } = runSkip(endpoint);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(files, []);
  });
}

test('send.js uses the shared endpoint parser and sends a user id to its DM channel', () => {
  const src = fs.readFileSync(SEND, 'utf8');
  assert.match(src, /import \{ parseEndpoint \} from '\.\.\/src\/lib\/endpoint\.js';/);
  assert.ok(!src.includes('function parseEndpoint('));
  assert.match(src, /isSlackUserId\(endpoint\.channel\)\n\s+\? await resolveUserDmChannel\(endpoint\.channel, \{ openDm: openDmChannel \}\)/);
  assert.match(src, /conversations\.open\(\{ users: userId, return_im: false \}\)/);
});
