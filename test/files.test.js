import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_DOWNLOAD_TIMEOUT_SECONDS,
  DEFAULT_MAX_DOWNLOAD_SIZE_MB,
  FileTooLargeError,
  describeMessageFiles,
  getMediaLimits,
  readBodyWithinLimit,
} from '../src/lib/files.js';

// message.js resolves its media directory from HOME when it is imported.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-files-'));
process.env.HOME = home;
const { downloadFile } = await import('../src/lib/message.js');
const { DEFAULT_CONFIG } = await import('../src/lib/config.js');

const quietLog = { warn() {} };
const MB = 1024 * 1024;

function streamResponse(chunks, headers = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, headers });
}

test('media limits default to 50MB and 30s and follow the config', () => {
  assert.deepEqual(getMediaLimits(DEFAULT_CONFIG), { maxBytes: 50 * MB, timeoutMs: 30_000 });
  assert.deepEqual(getMediaLimits({}), {
    maxBytes: DEFAULT_MAX_DOWNLOAD_SIZE_MB * MB,
    timeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_SECONDS * 1000,
  });
  assert.deepEqual(
    getMediaLimits({ media: { max_download_size_mb: 2, download_timeout_seconds: 5 } }),
    { maxBytes: 2 * MB, timeoutMs: 5000 },
  );
  assert.deepEqual(
    getMediaLimits({ media: { max_download_size_mb: -1, download_timeout_seconds: 'x' } }),
    { maxBytes: 50 * MB, timeoutMs: 30_000 },
  );
});

test('files are labeled and their local paths listed', async () => {
  const result = await describeMessageFiles([
    { name: 'photo.png', mimetype: 'image/png', size: 10 },
    { name: 'report.pdf', mimetype: 'application/pdf', size: 10 },
  ], { maxBytes: 100, download: async file => `/media/${file.name}`, log: quietLog });

  assert.equal(result.content, '[image: photo.png]\n[file: report.pdf]\n');
  assert.equal(result.fileLine, '\n---- file: /media/photo.png\n---- file: /media/report.pdf');
});

test('a file over the size cap is not fetched and is labeled too large', async () => {
  let downloads = 0;
  const result = await describeMessageFiles([
    { name: 'huge.zip', mimetype: 'application/zip', size: 101 },
    { name: 'ok.txt', mimetype: 'text/plain', size: 100 },
  ], { maxBytes: 100, download: async file => { downloads += 1; return `/media/${file.name}`; }, log: quietLog });

  assert.equal(downloads, 1);
  assert.equal(result.content, '[file: huge.zip (too large)]\n[file: ok.txt]\n');
  assert.equal(result.fileLine, '\n---- file: /media/ok.txt');
});

test('a failed download is labeled and the other files are kept', async () => {
  const result = await describeMessageFiles([
    { name: 'broken.pdf', size: 10 },
    { name: 'liar.bin' },
    { name: 'fine.txt', size: 10 },
  ], {
    maxBytes: 100,
    download: async file => {
      if (file.name === 'broken.pdf') throw new Error('Download failed: 403');
      if (file.name === 'liar.bin') throw new FileTooLargeError(100);
      return `/media/${file.name}`;
    },
    log: quietLog,
  });

  assert.equal(result.content, '[file: broken.pdf (download failed)]\n[file: liar.bin (too large)]\n[file: fine.txt]\n');
  assert.equal(result.fileLine, '\n---- file: /media/fine.txt');
});

test('the body read stops once it exceeds the cap, whatever the declared size', async () => {
  const chunk = new Uint8Array(60);
  await assert.rejects(readBodyWithinLimit(streamResponse([chunk, chunk]), 100), FileTooLargeError);
  await assert.rejects(
    readBodyWithinLimit(streamResponse([chunk], { 'content-length': '101' }), 100),
    FileTooLargeError,
  );
  assert.equal((await readBodyWithinLimit(streamResponse([chunk]), 100)).length, 60);
});

// A streamed response that records whether its body was cancelled.
function trackedResponse(init) {
  const state = { cancelled: false };
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(10)); },
    cancel() { state.cancelled = true; },
  });
  return { state, response: new Response(body, init) };
}

test('an unread body is released when the download is refused', async () => {
  const tooLarge = trackedResponse({ status: 200, headers: { 'content-length': '1000' } });
  await assert.rejects(downloadFile('https://files.slack.test/declared', 'd.bin', {
    maxBytes: 100, timeoutMs: 1000, fetchImpl: async () => tooLarge.response,
  }), FileTooLargeError);
  assert.equal(tooLarge.state.cancelled, true);

  const notOk = trackedResponse({ status: 403 });
  await assert.rejects(downloadFile('https://files.slack.test/denied', 'e.bin', {
    maxBytes: 100, timeoutMs: 1000, fetchImpl: async () => notOk.response,
  }), /Download failed: 403/);
  assert.equal(notOk.state.cancelled, true);
});

test('downloadFile saves a body within the cap to the media directory', async () => {
  const savedPath = await downloadFile('https://files.slack.test/a', 'a b.txt', {
    maxBytes: 100,
    timeoutMs: 1000,
    fetchImpl: async () => streamResponse([new TextEncoder().encode('hello')]),
  });

  assert.equal(path.dirname(savedPath), path.join(home, 'zylos/components/slack/media'));
  assert.match(path.basename(savedPath), /^slack-.*-a_b\.txt$/);
  assert.equal(fs.readFileSync(savedPath, 'utf8'), 'hello');
});

test('downloadFile refuses a body over the cap without writing it', async () => {
  const before = fs.existsSync(path.join(home, 'zylos/components/slack/media'))
    ? fs.readdirSync(path.join(home, 'zylos/components/slack/media')).length : 0;
  await assert.rejects(downloadFile('https://files.slack.test/big', 'big.bin', {
    maxBytes: 100,
    timeoutMs: 1000,
    fetchImpl: async () => streamResponse([new Uint8Array(80), new Uint8Array(80)]),
  }), FileTooLargeError);
  const after = fs.existsSync(path.join(home, 'zylos/components/slack/media'))
    ? fs.readdirSync(path.join(home, 'zylos/components/slack/media')).length : 0;
  assert.equal(after, before);
});

test('a download that does not finish in time is aborted and labeled download failed', async () => {
  let aborted = false;
  // Waits until the request signal aborts, as fetch does.
  const hangingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); });
  });

  // AbortSignal.timeout does not keep the event loop alive (the service always
  // is); hold it open for the test.
  const keepAlive = setTimeout(() => {}, 5000);
  const started = Date.now();
  const result = await describeMessageFiles([{ name: 'slow.pdf', size: 10, url_private_download: 'https://files.slack.test/slow' }], {
    maxBytes: 100,
    download: file => downloadFile(file.url_private_download, file.name, { maxBytes: 100, timeoutMs: 50, fetchImpl: hangingFetch }),
    log: quietLog,
  });
  clearTimeout(keepAlive);

  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.content, '[file: slow.pdf (download failed)]\n');
  assert.equal(result.fileLine, '');
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
