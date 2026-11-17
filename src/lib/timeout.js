/**
 * Reject when a promise has not settled within timeoutMs. The underlying work
 * is not cancelled; its late result is ignored.
 * @param {Promise} promise
 * @param {number} timeoutMs
 * @param {string} label - used in the timeout error message
 * @returns {Promise}
 */
export async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
