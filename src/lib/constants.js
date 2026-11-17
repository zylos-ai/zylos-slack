/**
 * Enum-like constants shared by configuration, runtime checks, hooks, and CLI.
 *
 * JavaScript has no native enum syntax. Frozen objects provide named values,
 * while the matching *_VALUES arrays are the canonical validation lists.
 */

function enumValues(enumObject) {
  return Object.freeze(Object.values(enumObject));
}

export const CONNECTION_MODE = Object.freeze({
  SOCKET: 'socket',
  WEBHOOK: 'webhook',
});
export const CONNECTION_MODE_VALUES = enumValues(CONNECTION_MODE);

export const DM_POLICY = Object.freeze({
  OPEN: 'open',
  ALLOWLIST: 'allowlist',
  OWNER: 'owner',
});
export const DM_POLICY_VALUES = enumValues(DM_POLICY);

export const GROUP_POLICY = Object.freeze({
  DISABLED: 'disabled',
  ALLOWLIST: 'allowlist',
  OPEN: 'open',
});
export const GROUP_POLICY_VALUES = enumValues(GROUP_POLICY);

export const GROUP_MODE = Object.freeze({
  MENTION: 'mention',
  SMART: 'smart',
});
export const GROUP_MODE_VALUES = enumValues(GROUP_MODE);

export const SLACK_CHANNEL_TYPE = Object.freeze({
  DIRECT_MESSAGE: 'im',
  PUBLIC_CHANNEL: 'channel',
  PRIVATE_CHANNEL: 'group',
  MULTI_PERSON_DM: 'mpim',
});
export const SLACK_CHANNEL_TYPE_VALUES = enumValues(SLACK_CHANNEL_TYPE);

/**
 * Slack `message` event subtypes delivered like a plain user message. Every
 * other subtype (edits, deletions, joins, bot messages, ...) is ignored.
 */
export const SLACK_MESSAGE_SUBTYPE = Object.freeze({
  FILE_SHARE: 'file_share',
});
export const SLACK_MESSAGE_SUBTYPE_VALUES = enumValues(SLACK_MESSAGE_SUBTYPE);

export const ENDPOINT_TYPE = Object.freeze({
  DIRECT_MESSAGE: 'dm',
  GROUP: 'group',
});
export const ENDPOINT_TYPE_VALUES = enumValues(ENDPOINT_TYPE);

export const CLI_TOGGLE = Object.freeze({
  ON: 'on',
  OFF: 'off',
});
export const CLI_TOGGLE_VALUES = enumValues(CLI_TOGGLE);

export const DEDUP_STATE = Object.freeze({
  PROCESSING: 'processing',
  DONE: 'done',
});
export const DEDUP_STATE_VALUES = enumValues(DEDUP_STATE);

export const C4_ERROR_CODE = Object.freeze({
  INVALID_ARGS: 'INVALID_ARGS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNHEALTHY_NOTIFY_FAILED: 'UNHEALTHY_NOTIFY_FAILED',
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
});
export const C4_ERROR_CODE_VALUES = enumValues(C4_ERROR_CODE);

/**
 * Final outcome of handing one inbound message to c4-receive
 * (src/lib/c4-delivery.js). No outcome is ever resent.
 */
export const C4_OUTCOME = Object.freeze({
  SENT: 'sent',              // Core accepted the message
  STORED: 'stored',          // rejected after storing (error.persisted non-empty)
  NOT_STORED: 'not_stored',  // rejected, nothing stored (error.persisted [])
  UNCERTAIN: 'uncertain',    // rejected, Core cannot tell (no persisted array)
  UNKNOWN: 'unknown',        // timeout, crash or no valid response
  FAILED: 'failed',          // c4-receive could not be started, even on the retry
  NO_GROUP: 'no_group',      // multi-session Core, but the endpoint has no session group
  EMPTY: 'empty',            // nothing to send
});
export const C4_OUTCOME_VALUES = enumValues(C4_OUTCOME);
