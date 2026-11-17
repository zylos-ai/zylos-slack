/**
 * Inbound Slack file handling shared by the DM and channel handlers: size and
 * time limits for downloads, and the `[file: …]` labels plus `---- file:` lines
 * added to the message delivered to Core.
 */

// Defaults follow the wecom component (`media.max_download_size_mb`, 50MB).
export const DEFAULT_MAX_DOWNLOAD_SIZE_MB = 50;
export const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 30;

export class FileTooLargeError extends Error {
  constructor(maxBytes) {
    super(`File exceeds the ${maxBytes}-byte download limit`);
    this.name = 'FileTooLargeError';
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Download limits from the `media` config section, with defaults for a
 * missing section, missing keys or invalid values.
 * @returns {{ maxBytes: number, timeoutMs: number }}
 */
export function getMediaLimits(config) {
  const media = config?.media || {};
  const maxMb = positiveNumber(media.max_download_size_mb, DEFAULT_MAX_DOWNLOAD_SIZE_MB);
  const timeoutSeconds = positiveNumber(media.download_timeout_seconds, DEFAULT_DOWNLOAD_TIMEOUT_SECONDS);
  return {
    maxBytes: Math.floor(maxMb * 1024 * 1024),
    timeoutMs: Math.floor(timeoutSeconds * 1000),
  };
}

/**
 * Read a fetch Response body, failing with FileTooLargeError as soon as more
 * than maxBytes arrive (the declared size may be missing or wrong).
 * @returns {Promise<Buffer>}
 */
export async function readBodyWithinLimit(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > maxBytes) throw new FileTooLargeError(maxBytes);
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FileTooLargeError(maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Download the files of one Slack message and build its labels.
 * A file larger than maxBytes (by Slack's `size`, checked before fetching, or
 * by the bytes received) is labeled `(too large)`; any other failure,
 * including a timeout, is labeled `(download failed)`. The message is still
 * delivered with its text.
 * @param {object[]} files - event.files
 * @param {object} opts - { download(file) → local path, maxBytes, log }
 * @returns {Promise<{ content: string, fileLine: string }>}
 */
export async function describeMessageFiles(files, { download, maxBytes, log = console }) {
  let content = '';
  let fileLine = '';

  for (const file of files || []) {
    const name = file.name || file.title || file.id || 'file';
    if (Number(file.size) > maxBytes) {
      log.warn(`[slack] File not downloaded (${file.size} bytes, limit ${maxBytes}): ${name}`);
      content += `[file: ${name} (too large)]\n`;
      continue;
    }
    try {
      const localPath = await download(file);
      const isImage = file.mimetype?.startsWith('image/');
      content += isImage ? `[image: ${name}]\n` : `[file: ${name}]\n`;
      fileLine += `\n---- file: ${localPath}`;
    } catch (err) {
      if (err instanceof FileTooLargeError) {
        log.warn(`[slack] File not downloaded (over ${maxBytes} bytes): ${name}`);
        content += `[file: ${name} (too large)]\n`;
      } else {
        log.warn('[slack] File download failed:', err.message);
        content += `[file: ${name} (download failed)]\n`;
      }
    }
  }

  return { content, fileLine };
}
