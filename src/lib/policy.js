import { GROUP_POLICY } from './constants.js';

/**
 * Decide whether a Slack user may send a message from a group channel.
 *
 * A disabled group policy is absolute: it blocks every sender, including the
 * owner. Owner bypass applies only to allowlist-based access controls.
 */
export function isGroupAccessAllowed({ groupPolicy, groupConfig, userId, isOwner }) {
  if (groupPolicy === GROUP_POLICY.DISABLED) return false;

  if (groupPolicy === GROUP_POLICY.ALLOWLIST && !groupConfig && !isOwner) {
    return false;
  }

  if (groupConfig?.allowFrom?.length > 0 && !isOwner) {
    return groupConfig.allowFrom.includes(userId);
  }

  return true;
}
