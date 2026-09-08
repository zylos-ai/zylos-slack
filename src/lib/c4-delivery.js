import { execFile } from 'child_process';

import { C4_ERROR_CODE } from './constants.js';

const PERMANENT_C4_CODES = new Set([C4_ERROR_CODE.INVALID_ARGS]);
export const DEFAULT_RETRY_DELAYS_MS = Object.freeze([2_000]);

export class C4DeliveryError extends Error {
  constructor(message, { code = C4_ERROR_CODE.TRANSPORT_ERROR, retryable = true } = {}) {
    super(message);
    this.name = 'C4DeliveryError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function parseC4Response(output) {
  if (!output) return null;
  try {
    return JSON.parse(String(output).trim());
  } catch {
    return null;
  }
}

export function classifyC4Failure(error, stdout) {
  const response = parseC4Response(error?.stdout || stdout);
  if (response?.ok === false) {
    const code = response.error?.code || C4_ERROR_CODE.TRANSPORT_ERROR;
    const message = response.error?.message || 'C4 rejected the message';
    return new C4DeliveryError(message, {
      code,
      retryable: !PERMANENT_C4_CODES.has(code),
    });
  }

  return new C4DeliveryError(error?.message || 'C4 transport failed', {
    code: C4_ERROR_CODE.TRANSPORT_ERROR,
    retryable: true,
  });
}

function invalidC4Response() {
  return new C4DeliveryError('C4 returned no valid success response', {
    code: C4_ERROR_CODE.PROTOCOL_ERROR,
    retryable: true,
  });
}

export function createC4Deliverer({ scriptPath, timeoutMs = 35_000, execFileImpl = execFile }) {
  if (!scriptPath) throw new TypeError('scriptPath is required');

  return record => new Promise((resolve, reject) => {
    const args = [
      scriptPath,
      '--channel', record.source,
      '--endpoint', record.endpoint,
      '--json',
      '--content', record.content,
    ];

    execFileImpl('node', args, { encoding: 'utf8', timeout: timeoutMs }, (error, stdout) => {
      const response = parseC4Response(stdout);
      if (!error && response?.ok === true) {
        resolve(response);
        return;
      }
      if (response?.ok === false || error) {
        reject(classifyC4Failure(error, stdout));
        return;
      }
      reject(invalidC4Response());
    });
  });
}

export async function deliverWithRetry(record, {
  deliver,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
  onRetry = () => {},
} = {}) {
  if (typeof deliver !== 'function') throw new TypeError('deliver is required');
  if (!Array.isArray(retryDelaysMs)) throw new TypeError('retryDelaysMs must be an array');
  if (retryDelaysMs.some(delay => !Number.isFinite(delay) || delay < 0)) {
    throw new TypeError('retryDelaysMs must contain only non-negative finite numbers');
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await deliver(record);
    } catch (error) {
      if (error?.retryable === false || attempt >= retryDelaysMs.length) throw error;
      const delay = retryDelaysMs[attempt];
      await onRetry(error, attempt + 1, delay);
      await wait(delay);
    }
  }
}

export function createC4MessageSender({
  deliver,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  wait,
  onDelivered = () => {},
  onRetry = () => {},
  onFailed = () => {},
}) {
  return async record => {
    try {
      const response = await deliverWithRetry(record, {
        deliver,
        retryDelaysMs,
        wait,
        onRetry: (error, retryNumber, delay) => onRetry(record, error, retryNumber, delay),
      });
      await onDelivered(record, response);
      return response;
    } catch (error) {
      await onFailed(record, error);
      throw error;
    }
  };
}
