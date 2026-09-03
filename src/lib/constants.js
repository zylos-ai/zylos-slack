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
});
export const SLACK_CHANNEL_TYPE_VALUES = enumValues(SLACK_CHANNEL_TYPE);

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

export const DELIVERY_STATE = Object.freeze({
  PENDING: 'pending',
  DELIVERED: 'delivered',
  DEAD_LETTER: 'dead_letter',
});
export const DELIVERY_STATE_VALUES = enumValues(DELIVERY_STATE);

export const C4_ERROR_CODE = Object.freeze({
  INVALID_ARGS: 'INVALID_ARGS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNHEALTHY_NOTIFY_FAILED: 'UNHEALTHY_NOTIFY_FAILED',
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
});
export const C4_ERROR_CODE_VALUES = enumValues(C4_ERROR_CODE);
