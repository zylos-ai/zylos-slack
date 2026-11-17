/**
 * Inbound bridge to zylos-core: calls comm-bridge c4-receive.
 *
 * - The session group is derived from the endpoint (src/lib/session-group.js)
 *   and passed as `--session-group` only when the installed Core lists that
 *   option in c4-receive-options.json (re-read on every call, never inferred
 *   from a version). On an older Core the argv is exactly what it was before
 *   and no session group is derived at all.
 * - Core's error text is written for the agent, never for the Slack user: users
 *   only ever see TRY_LATER or MAYBE_LOST; the raw text stays in the logs.
 * - Only an explicit `{ "ok": true }` on a clean exit counts as delivered.
 * - c4-receive is killed after C4_RECEIVE_TIMEOUT_MS (35s). A timeout is an
 *   unknown outcome: the user gets MAYBE_LOST and nothing is resent. Only a
 *   call that never started (spawn failure) is retried, once; a stored or
 *   unknown outcome is never resent, and a rejected group is never resent
 *   without the group.
 * - The returned promise always resolves with the final outcome (C4_OUTCOME),
 *   so the event deduplicator treats every attempt as final and an equivalent
 *   Slack event (message + app_mention) never delivers the same message again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { C4_OUTCOME, ENDPOINT_TYPE } from './constants.js';
import { sessionGroupFromEndpoint } from './session-group.js';

export const TRY_LATER = "Sorry, I couldn't take this message right now. Please try again later.";
export const MAYBE_LOST = "Sorry, this message may not have reached me. If you don't get a reply in a few minutes, please send it again.";
export const C4_RECEIVE_TIMEOUT_MS = 35_000;
export const SPAWN_RETRY_DELAY_MS = 2_000;

/**
 * c4-receive.js of the deployment this component runs in.
 * @returns {string}
 */
export function getC4ReceivePath() {
  return path.join(process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos'),
    '.claude/skills/comm-bridge/scripts/c4-receive.js');
}

/**
 * Whether the installed c4-receive declares an option. Re-reads
 * c4-receive-options.json next to c4-receive.js on every call; a missing,
 * unreadable or malformed file means "not supported".
 * @param {string} name - e.g. '--session-group'
 * @param {string} [scriptPath] - c4-receive.js (default: getC4ReceivePath())
 * @returns {boolean}
 */
export function c4ReceiveSupportsOption(name, scriptPath = getC4ReceivePath()) {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(path.dirname(scriptPath), 'c4-receive-options.json'), 'utf8'));
    return manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
      && manifest.options !== null && typeof manifest.options === 'object'
      && !Array.isArray(manifest.options) && Object.hasOwn(manifest.options, name);
  } catch {
    return false;
  }
}

/**
 * Arguments after the c4-receive.js path.
 * @returns {string[]}
 */
export function buildC4ReceiveArgs({ source, endpoint, content, sessionGroup, supportsSessionGroup }) {
  const args = ['--channel', source, '--endpoint', endpoint, '--json', '--content', content];
  if (sessionGroup != null && sessionGroup !== '' && supportsSessionGroup) {
    args.push('--session-group', sessionGroup);
  }
  return args;
}

/**
 * Parse c4-receive JSON response from stdout.
 * @returns {object|null}
 */
export function parseC4Response(output) {
  if (!output) return null;
  try {
    return JSON.parse(String(output).trim());
  } catch {
    return null;
  }
}

/**
 * Classify a structured c4-receive rejection by `error.persisted`:
 * - non-empty array: the inbound row was stored - send nothing, never resend
 * - empty array: nothing was stored - ask the user to try later
 * - null / absent (older Cores): Core cannot tell
 * @param {object} response - parsed `{ ok: false, error }` JSON
 * @returns {'stored'|'not_stored'|'uncertain'}
 */
export function classifyC4Rejection(response) {
  const persisted = response?.error?.persisted;
  if (!Array.isArray(persisted)) return C4_OUTCOME.UNCERTAIN;
  return persisted.length > 0 ? C4_OUTCOME.STORED : C4_OUTCOME.NOT_STORED;
}

function isStructuredRejection(response) {
  return response !== null && typeof response === 'object' && response.ok === false
    && response.error !== null && typeof response.error === 'object';
}

/**
 * True when c4-receive never started (spawn itself failed), so Core cannot
 * have stored anything. Any other failure without a structured result
 * (non-zero exit, signal, timeout, maxBuffer) has an unknown outcome.
 */
function neverStarted(error) {
  return typeof error?.syscall === 'string' && error.syscall.startsWith('spawn');
}

/** Notice shown to the user for each outcome; null = clean up, send nothing. */
export function noticeForOutcome(outcome) {
  switch (outcome) {
    case C4_OUTCOME.NOT_STORED:
    case C4_OUTCOME.NO_GROUP:
      return TRY_LATER;
    case C4_OUTCOME.UNCERTAIN:
    case C4_OUTCOME.UNKNOWN:
    case C4_OUTCOME.FAILED:
      return MAYBE_LOST;
    default:
      return null;
  }
}

/**
 * Whether the user is told that the agent will not answer (TRY_LATER /
 * MAYBE_LOST). Only messages addressed to the bot get a notice: every DM, and a
 * channel, private channel or group DM (mpim) message only when it @-mentions
 * the bot (`record.isMention`: an app_mention event, or isBotMentioned on the
 * message text). A smart-mode message without an @mention gets none.
 * @param {{messageType?: string, isMention?: boolean}} record
 * @returns {boolean}
 */
export function shouldPostRejectNotice(record) {
  return record?.messageType === ENDPOINT_TYPE.DIRECT_MESSAGE || record?.isMention === true;
}

/**
 * The onRejected handler for createC4MessageSender: always clears the
 * hourglass, then posts the notice if there is one and the message was
 * addressed to the bot (shouldPostRejectNotice).
 * @param {object} opts
 * @param {function} opts.clearTypingIndicator - async (record) => void
 * @param {function} opts.postNotice - async (record, notice) => void
 * @returns {function} async (record, notice) => void
 */
export function createRejectHandler({ clearTypingIndicator, postNotice }) {
  return async (record, notice) => {
    await clearTypingIndicator(record);
    if (notice && shouldPostRejectNotice(record)) await postNotice(record, notice);
  };
}

/**
 * Create the function that hands one inbound record to c4-receive.
 *
 * @param {object} [opts]
 * @param {string} [opts.scriptPath] - c4-receive.js; default getC4ReceivePath() per call
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retryDelayMs] - delay before the single spawn-failure retry
 * @param {function} [opts.execFileImpl] - Test hook: replaces child_process.execFile
 * @param {function} [opts.wait] - Test hook: delay -> Promise
 * @param {function} [opts.onDelivered] - (record, response)
 * @param {function} [opts.onRejected] - (record, notice, outcome): called once when the
 *   agent will not answer; notice is TRY_LATER / MAYBE_LOST, or null when Core
 *   already stored the message (clean up only, send nothing)
 * @param {object} [opts.logger] - console-like
 * @returns {(record: {msgId?: string, source: string, endpoint: string, content: string}) => Promise<{outcome: string, sessionGroup?: string, response?: object}>}
 */
export function createC4MessageSender({
  scriptPath,
  timeoutMs = C4_RECEIVE_TIMEOUT_MS,
  retryDelayMs = SPAWN_RETRY_DELAY_MS,
  execFileImpl = execFile,
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
  onDelivered = () => {},
  onRejected = () => {},
  logger = console,
} = {}) {
  const invoke = (file, args) => new Promise(resolve => {
    execFileImpl(file, args, { encoding: 'utf8', timeout: timeoutMs },
      (error, stdout) => resolve({ error, stdout }));
  });

  return async record => {
    const label = record.msgId || record.endpoint;
    if (!record.content) {
      logger.error(`[slack] C4 delivery ${label}: empty content, not sent`);
      return { outcome: C4_OUTCOME.EMPTY };
    }

    // The options file is re-read on every attempt (including the retry). The
    // session group is derived only when the installed Core supports it, and
    // once derived it stays the same for the retry.
    let sessionGroup;
    const attempt = async () => {
      const receivePath = scriptPath || getC4ReceivePath();
      const supportsSessionGroup = c4ReceiveSupportsOption('--session-group', receivePath);
      if (supportsSessionGroup && sessionGroup === undefined) {
        try {
          sessionGroup = sessionGroupFromEndpoint(record.endpoint);
        } catch (err) {
          // Never fall back to the overall group: that would mix this conversation into it.
          logger.error(`[slack] No session group for ${label}, not sending to C4: ${err.message}`);
          return { noGroup: true };
        }
      }
      const args = buildC4ReceiveArgs({ ...record, sessionGroup, supportsSessionGroup });
      return invoke(process.execPath, [receivePath, ...args]);
    };

    const finish = async (outcome, response) => {
      // A failing hook (e.g. the notice could not be posted) must not turn a
      // final outcome into an error: that would let a duplicate event resend.
      try {
        if (outcome === C4_OUTCOME.SENT) {
          await onDelivered(record, response);
        } else {
          await onRejected(record, noticeForOutcome(outcome), outcome);
        }
      } catch (err) {
        logger.error(`[slack] C4 delivery ${label}: ${outcome} handler failed: ${err.message}`);
      }
      return { outcome, ...(sessionGroup !== undefined && { sessionGroup }), ...(response && { response }) };
    };

    // Returns an outcome, or null when c4-receive never started.
    const evaluate = ({ error, stdout }, suffix) => {
      const response = parseC4Response(stdout ?? error?.stdout);
      if (!error && response?.ok === true) {
        return { outcome: C4_OUTCOME.SENT, response };
      }
      const group = `[group=${sessionGroup ?? 'none'}]`;
      if (isStructuredRejection(response)) {
        const { code, message } = response.error;
        const kind = classifyC4Rejection(response);
        if (kind === C4_OUTCOME.STORED) {
          logger.warn(`[slack] C4 rejected${suffix} ${label} after storing (${code}) ${group}, not resending: ${message}`);
        } else {
          logger.warn(`[slack] C4 rejected${suffix} ${label} (${code}, ${kind}) ${group}: ${message}`);
        }
        return { outcome: kind };
      }
      if (error && neverStarted(error)) return null;
      const reason = error ? error.message : 'no valid success response';
      logger.error(`[slack] C4 delivery${suffix} ${label} failed, outcome unknown, not resending ${group}: ${reason}`);
      return { outcome: C4_OUTCOME.UNKNOWN };
    };

    const first = await attempt();
    if (first.noGroup) return finish(C4_OUTCOME.NO_GROUP);
    const result = evaluate(first, '');
    if (result) return finish(result.outcome, result.response);

    // c4-receive never started, so nothing was stored - retry once.
    logger.warn(`[slack] C4 receive did not start for ${label}, retrying in ${retryDelayMs}ms: ${first.error.message}`);
    await wait(retryDelayMs);
    const second = await attempt();
    if (second.noGroup) return finish(C4_OUTCOME.NO_GROUP);
    const retried = evaluate(second, ' (retry)');
    if (retried) return finish(retried.outcome, retried.response);
    logger.error(`[slack] C4 receive did not start for ${label} after retry, not resending: ${second.error.message}`);
    return finish(C4_OUTCOME.FAILED);
  };
}
