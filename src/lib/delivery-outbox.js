import fs from 'fs';
import path from 'path';

import { DELIVERY_STATE } from './constants.js';

export const DEFAULT_DELIVERY_TERMINAL_TTL_MS = 10 * 60 * 1000;

function appendDurably(journalPath, event, fsImpl) {
  fsImpl.mkdirSync(path.dirname(journalPath), { recursive: true });
  const fd = fsImpl.openSync(journalPath, 'a', 0o600);
  try {
    fsImpl.writeSync(fd, `${JSON.stringify(event)}\n`);
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

function terminalTimestamp(event) {
  return Date.parse(event.completedAt || event.updatedAt || event.receivedAt);
}

function pendingRecord(event) {
  return {
    ...event.record,
    attempts: event.attempts || 0,
    nextAttemptAt: event.nextAttemptAt,
    lastError: event.lastError || null,
  };
}

/**
 * Durable append-only delivery journal.
 *
 * The latest event for each msgId is authoritative. A pending record always
 * includes the complete C4 payload so it can be retried after process restart.
 */
export function createDeliveryOutbox({
  journalPath,
  terminalTtlMs = DEFAULT_DELIVERY_TERMINAL_TTL_MS,
  now = Date.now,
  fsImpl = fs,
  appendEvent = event => appendDurably(journalPath, event, fsImpl),
  onError = () => {},
  onAmbiguousDelivery = () => {},
}) {
  if (!journalPath) throw new TypeError('journalPath is required');
  if (!Number.isFinite(terminalTtlMs) || terminalTtlMs <= 0) {
    throw new TypeError('terminalTtlMs must be a positive number');
  }

  const states = new Map();

  function prune(referenceTime = now()) {
    for (const [msgId, state] of states) {
      if (![DELIVERY_STATE.DELIVERED, DELIVERY_STATE.DEAD_LETTER].includes(state.state)) continue;
      const timestamp = terminalTimestamp(state);
      if (!Number.isFinite(timestamp) || referenceTime - timestamp > terminalTtlMs) {
        states.delete(msgId);
      }
    }
  }

  function hydrate() {
    if (!fsImpl.existsSync(journalPath)) return;

    let content;
    try {
      content = fsImpl.readFileSync(journalPath, 'utf8');
    } catch (error) {
      onError(`unable to read delivery journal: ${error.message}`);
      return;
    }

    for (const [index, rawLine] of content.split('\n').entries()) {
      const line = rawLine.trim();
      if (!line) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        onError(`unable to parse delivery journal line ${index + 1}: ${error.message}`);
        continue;
      }

      if (!event?.msgId || !Object.values(DELIVERY_STATE).includes(event.state)) {
        onError(`invalid delivery journal event at line ${index + 1}`);
        continue;
      }
      if (event.state === DELIVERY_STATE.PENDING
        && (!event.record || event.record.msgId !== event.msgId)) {
        onError(`pending delivery journal event lacks its record at line ${index + 1}`);
        continue;
      }

      states.set(String(event.msgId), event);
    }

    prune();
  }

  hydrate();

  function appendAndStore(event) {
    appendEvent(event);
    states.set(event.msgId, event);
    return event;
  }

  return {
    enqueue(record) {
      if (!record?.msgId) throw new TypeError('record.msgId is required');
      const msgId = String(record.msgId);
      prune();

      const existing = states.get(msgId);
      if (existing?.state === DELIVERY_STATE.DELIVERED
        || existing?.state === DELIVERY_STATE.DEAD_LETTER) {
        return { status: 'duplicate', state: existing.state, record: existing.record || record };
      }
      if (existing?.state === DELIVERY_STATE.PENDING) {
        return { status: 'pending', record: pendingRecord(existing), retry: true };
      }

      const receivedAt = record.receivedAt || new Date(now()).toISOString();
      const storedRecord = { ...record, msgId, receivedAt };
      const event = {
        version: 1,
        state: DELIVERY_STATE.PENDING,
        msgId,
        receivedAt,
        updatedAt: receivedAt,
        attempts: 0,
        nextAttemptAt: receivedAt,
        record: storedRecord,
      };
      appendAndStore(event);
      return { status: 'pending', record: pendingRecord(event), retry: false };
    },

    markRetry(msgId, { attempts, nextAttemptAt, error }) {
      const id = String(msgId);
      const current = states.get(id);
      if (!current || current.state !== DELIVERY_STATE.PENDING) {
        throw new Error(`cannot retry non-pending delivery: ${id}`);
      }
      const event = {
        ...current,
        version: 1,
        state: DELIVERY_STATE.PENDING,
        attempts,
        nextAttemptAt: new Date(nextAttemptAt).toISOString(),
        updatedAt: new Date(now()).toISOString(),
        lastError: error,
      };
      appendAndStore(event);
      return pendingRecord(event);
    },

    markDelivered(msgId) {
      const id = String(msgId);
      const current = states.get(id);
      if (!current || current.state !== DELIVERY_STATE.PENDING) {
        throw new Error(`cannot deliver non-pending message: ${id}`);
      }
      const completedAt = new Date(now()).toISOString();
      const event = {
        version: 1,
        state: DELIVERY_STATE.DELIVERED,
        msgId: id,
        receivedAt: current.receivedAt,
        completedAt,
        updatedAt: completedAt,
        attempts: current.attempts,
        record: current.record,
      };
      try {
        appendAndStore(event);
      } catch (error) {
        onAmbiguousDelivery(id, error);
        throw error;
      }
      return event;
    },

    markDeadLetter(msgId, { attempts, error }) {
      const id = String(msgId);
      const current = states.get(id);
      if (!current || current.state !== DELIVERY_STATE.PENDING) {
        throw new Error(`cannot dead-letter non-pending delivery: ${id}`);
      }
      const completedAt = new Date(now()).toISOString();
      return appendAndStore({
        version: 1,
        state: DELIVERY_STATE.DEAD_LETTER,
        msgId: id,
        receivedAt: current.receivedAt,
        completedAt,
        updatedAt: completedAt,
        attempts,
        error,
        record: current.record,
      });
    },

    lookup(msgId) {
      if (!msgId) return null;
      prune();
      const state = states.get(String(msgId));
      if (!state) return null;
      return state.state === DELIVERY_STATE.PENDING ? {
        ...state,
        record: pendingRecord(state),
      } : state;
    },

    pendingRecords() {
      return [...states.values()]
        .filter(state => state.state === DELIVERY_STATE.PENDING)
        .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt))
        .map(pendingRecord);
    },

    prune,

    size() {
      return states.size;
    },
  };
}
