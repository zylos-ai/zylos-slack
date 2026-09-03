import { DELIVERY_STATE } from './constants.js';

export const DEFAULT_RETRY_DELAYS_MS = Object.freeze([2_000, 10_000, 30_000, 120_000, 300_000]);

function serializedError(error) {
  return {
    code: error?.code || 'UNKNOWN',
    message: error?.message || String(error),
    retryable: error?.retryable !== false,
  };
}

/**
 * Bounded retry scheduler backed by a durable outbox.
 */
export function createReliableDeliveryQueue({
  outbox,
  deliver,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  onDelivered = () => {},
  onRetry = () => {},
  onDeadLetter = () => {},
  onAmbiguousDelivery = () => {},
  onPersistenceError = () => {},
}) {
  if (!outbox) throw new TypeError('outbox is required');
  if (typeof deliver !== 'function') throw new TypeError('deliver is required');
  if (!Array.isArray(retryDelaysMs) || retryDelaysMs.length === 0) {
    throw new TypeError('retryDelaysMs must be a non-empty array');
  }

  const timers = new Map();
  const inFlight = new Set();
  let stopped = false;

  async function reportPersistenceError(record, error) {
    try {
      await onPersistenceError(record, error);
    } catch {
      // Observability hooks must never change delivery state or retry behavior.
    }
  }

  async function notify(callback, record, ...args) {
    try {
      await callback(record, ...args);
    } catch (error) {
      await reportPersistenceError(record, error);
    }
  }

  function schedule(msgId, delayMs) {
    const id = String(msgId);
    if (stopped || timers.has(id) || inFlight.has(id)) return false;
    const timer = setTimeoutImpl(() => {
      timers.delete(id);
      void attempt(id).catch(error => reportPersistenceError({ msgId: id }, error));
    }, Math.max(0, delayMs));
    timers.set(id, timer);
    return true;
  }

  function scheduleRecord(record) {
    const nextAttempt = Date.parse(record.nextAttemptAt);
    const delay = Number.isFinite(nextAttempt) ? Math.max(0, nextAttempt - now()) : 0;
    return schedule(record.msgId, delay);
  }

  async function attempt(msgId) {
    const id = String(msgId);
    if (stopped || inFlight.has(id)) return false;

    const state = outbox.lookup(id);
    if (!state || state.state !== DELIVERY_STATE.PENDING) return false;

    const record = state.record;
    const dueAt = Date.parse(record.nextAttemptAt);
    if (Number.isFinite(dueAt) && dueAt > now()) {
      schedule(id, dueAt - now());
      return false;
    }

    inFlight.add(id);
    let rescheduleDelay = null;

    try {
      let deliveryError = null;
      try {
        await deliver(record);
      } catch (error) {
        deliveryError = error;
      }

      if (!deliveryError) {
        try {
          outbox.markDelivered(id);
        } catch (error) {
          // C4 may already have accepted the message. Keep the durable pending
          // record so restart recovery prefers duplication over silent loss.
          await notify(onAmbiguousDelivery, record, error);
          rescheduleDelay = retryDelaysMs[0];
          return false;
        }
        await notify(onDelivered, record);
        return true;
      }

      const error = deliveryError;
      const attempts = (record.attempts || 0) + 1;
      const detail = serializedError(error);
      const exhausted = attempts > retryDelaysMs.length;

      if (error?.retryable === false || exhausted) {
        try {
          outbox.markDeadLetter(id, { attempts, error: detail });
        } catch (persistenceError) {
          await reportPersistenceError(record, persistenceError);
          rescheduleDelay = retryDelaysMs.at(-1);
          return false;
        }
        await notify(onDeadLetter, record, detail, attempts);
        return false;
      }

      const delay = retryDelaysMs[attempts - 1];
      try {
        const pending = outbox.markRetry(id, {
          attempts,
          nextAttemptAt: now() + delay,
          error: detail,
        });
        rescheduleDelay = delay;
        await notify(onRetry, pending, detail, attempts, delay);
      } catch (persistenceError) {
        await reportPersistenceError(record, persistenceError);
        rescheduleDelay = delay;
      }
      return false;
    } finally {
      inFlight.delete(id);
      if (rescheduleDelay !== null) schedule(id, rescheduleDelay);
    }
  }

  return {
    enqueue(record) {
      const result = outbox.enqueue(record);
      if (result.status === 'pending') scheduleRecord(result.record);
      return result;
    },

    start() {
      stopped = false;
      const pending = outbox.pendingRecords();
      for (const record of pending) scheduleRecord(record);
      return pending.length;
    },

    stop() {
      stopped = true;
      for (const timer of timers.values()) clearTimeoutImpl(timer);
      timers.clear();
    },

    attemptNow(msgId) {
      const id = String(msgId);
      const timer = timers.get(id);
      if (timer) {
        clearTimeoutImpl(timer);
        timers.delete(id);
      }
      return attempt(id);
    },

    pendingCount() {
      return outbox.pendingRecords().length;
    },
  };
}
