import { execFile } from 'child_process';

import { C4_ERROR_CODE } from './constants.js';

const PERMANENT_C4_CODES = new Set([C4_ERROR_CODE.INVALID_ARGS]);

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
      if (response?.ok === false) {
        reject(classifyC4Failure(error, stdout));
        return;
      }
      if (!error) {
        resolve(response);
        return;
      }
      reject(classifyC4Failure(error, stdout));
    });
  });
}
