import { DEDUP_STATE } from './constants.js';

/**
 * Deduplicate equivalent events without losing a retry when processing fails.
 *
 * Concurrent duplicates wait for the active handler. If that handler fails,
 * one waiter claims the key and retries; successful work remains suppressed
 * until its done entry expires.
 */
export class MessageDeduplicator {
  constructor({ ttlMs, now = Date.now }) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError('ttlMs must be a positive number');
    }

    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  async run(key, handler) {
    if (!key) throw new TypeError('dedup key is required');
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');

    while (true) {
      const existing = this.entries.get(key);

      if (existing?.state === DEDUP_STATE.DONE) {
        return { processed: false };
      }

      if (existing?.state === DEDUP_STATE.PROCESSING) {
        try {
          await existing.promise;
          return { processed: false };
        } catch {
          // The active owner releases its failed entry before this waiter
          // resumes. Loop so exactly one waiting delivery can claim the key.
          continue;
        }
      }

      const promise = Promise.resolve().then(handler);
      const entry = {
        state: DEDUP_STATE.PROCESSING,
        startedAt: this.now(),
        promise,
      };
      this.entries.set(key, entry);

      try {
        const result = await promise;
        if (this.entries.get(key) === entry) {
          this.entries.set(key, {
            state: DEDUP_STATE.DONE,
            completedAt: this.now(),
          });
        }
        return { processed: true, result };
      } catch (error) {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
        }
        throw error;
      }
    }
  }

  cleanup() {
    const cutoff = this.now() - this.ttlMs;
    let removed = 0;

    for (const [key, entry] of this.entries) {
      if (entry.state === DEDUP_STATE.DONE && entry.completedAt < cutoff) {
        this.entries.delete(key);
        removed += 1;
      }
    }

    return removed;
  }
}
