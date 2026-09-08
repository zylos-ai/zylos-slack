#!/usr/bin/env node

/**
 * Admin CLI for zylos-slack configuration.
 *
 * Usage: node admin.js <command> [args]
 */

import { getConfig, saveConfig, loadConfig } from './lib/config.js';
import {
  CLI_TOGGLE,
  CLI_TOGGLE_VALUES,
  CONNECTION_MODE_VALUES,
  DM_POLICY_VALUES,
  GROUP_MODE,
  GROUP_MODE_VALUES,
  GROUP_POLICY_VALUES,
} from './lib/constants.js';

const choices = values => values.join('|');

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === 'help') {
  console.log(`
zylos-slack admin CLI

Usage: node admin.js <command> [args]

Commands:
  show                              Show full config
  show-owner                        Show current owner

  set-dm-policy <${choices(DM_POLICY_VALUES)}>   Set DM access policy
  list-dm-allow                     List DM allowlist
  add-dm-allow <user_id>            Add user to DM allowlist
  remove-dm-allow <user_id>         Remove from DM allowlist

  list-groups                       List configured channels
  add-group <channel_id> <name> [mode]   Add channel (mode: ${choices(GROUP_MODE_VALUES)})
  remove-group <channel_id>         Remove channel
  set-group-policy <${choices(GROUP_POLICY_VALUES)}>  Set channel access policy
  set-group-mode <${choices(GROUP_MODE_VALUES)}>      Set default channel trigger mode
  set-group-allowfrom <channel_id> <id1,id2>  Per-channel sender whitelist
  set-group-history-limit <channel_id> <n>    Per-channel context limit

  set-markdown <${choices(CLI_TOGGLE_VALUES)}>             Toggle markdown formatting
  set-connection <${choices(CONNECTION_MODE_VALUES)}>   Set connection mode (requires restart)

  help                              Show this help
  `);
  process.exit(0);
}

const config = getConfig();

switch (command) {
  case 'show': {
    console.log(JSON.stringify(config, null, 2));
    break;
  }

  case 'show-owner': {
    if (config.owner?.bound) {
      console.log(`Owner: ${config.owner.name} (${config.owner.user_id})`);
    } else {
      console.log('No owner bound yet.');
    }
    break;
  }

  case 'set-dm-policy': {
    const policy = args[1];
    if (!DM_POLICY_VALUES.includes(policy)) {
      console.error(`Usage: set-dm-policy <${choices(DM_POLICY_VALUES)}>`);
      process.exit(1);
    }
    config.dmPolicy = policy;
    saveConfig(config);
    console.log(`DM policy set to: ${policy}`);
    break;
  }

  case 'list-dm-allow': {
    console.log(`DM Policy: ${config.dmPolicy}`);
    if (config.dmAllowFrom.length === 0) {
      console.log('Allowlist: (empty)');
    } else {
      console.log('Allowlist:');
      config.dmAllowFrom.forEach(id => console.log(`  - ${id}`));
    }
    break;
  }

  case 'add-dm-allow': {
    const uid = args[1];
    if (!uid) { console.error('Usage: add-dm-allow <user_id>'); process.exit(1); }
    if (!config.dmAllowFrom.includes(uid)) {
      config.dmAllowFrom.push(uid);
      saveConfig(config);
      console.log(`Added ${uid} to DM allowlist.`);
    } else {
      console.log(`${uid} already in allowlist.`);
    }
    break;
  }

  case 'remove-dm-allow': {
    const uid = args[1];
    if (!uid) { console.error('Usage: remove-dm-allow <user_id>'); process.exit(1); }
    const idx = config.dmAllowFrom.indexOf(uid);
    if (idx >= 0) {
      config.dmAllowFrom.splice(idx, 1);
      saveConfig(config);
      console.log(`Removed ${uid} from DM allowlist.`);
    } else {
      console.log(`${uid} not in allowlist.`);
    }
    break;
  }

  case 'list-groups': {
    console.log(`Group Policy: ${config.groupPolicy}`);
    console.log(`Default Group Mode: ${config.groupMode || GROUP_MODE.MENTION}`);
    const groups = config.groups || {};
    const keys = Object.keys(groups);
    if (keys.length === 0) {
      console.log('Groups: (none configured)');
    } else {
      console.log('Groups:');
      for (const id of keys) {
        const g = groups[id];
        console.log(`  ${id}: ${g.name} (mode: ${g.mode || config.groupMode || GROUP_MODE.MENTION}, allowFrom: ${g.allowFrom?.length || 0})`);
      }
    }
    break;
  }

  case 'add-group': {
    const channelId = args[1];
    const name = args[2];
    const mode = args[3] || config.groupMode || GROUP_MODE.MENTION;
    if (!channelId || !name) {
      console.error(`Usage: add-group <channel_id> <name> [${choices(GROUP_MODE_VALUES)}]`);
      process.exit(1);
    }
    if (!GROUP_MODE_VALUES.includes(mode)) {
      console.error(`Mode must be one of: ${choices(GROUP_MODE_VALUES)}`);
      process.exit(1);
    }
    if (!config.groups) config.groups = {};
    config.groups[channelId] = {
      name,
      mode,
      allowFrom: [],
      historyLimit: config.message?.context_messages || 10,
      added_at: new Date().toISOString(),
    };
    saveConfig(config);
    console.log(`Added group ${name} (${channelId}) in ${mode} mode.`);
    break;
  }

  case 'remove-group': {
    const channelId = args[1];
    if (!channelId) { console.error('Usage: remove-group <channel_id>'); process.exit(1); }
    if (config.groups?.[channelId]) {
      const name = config.groups[channelId].name;
      delete config.groups[channelId];
      saveConfig(config);
      console.log(`Removed group ${name} (${channelId}).`);
    } else {
      console.log(`Group ${channelId} not found.`);
    }
    break;
  }

  case 'set-group-policy': {
    const policy = args[1];
    if (!GROUP_POLICY_VALUES.includes(policy)) {
      console.error(`Usage: set-group-policy <${choices(GROUP_POLICY_VALUES)}>`);
      process.exit(1);
    }
    config.groupPolicy = policy;
    saveConfig(config);
    console.log(`Group policy set to: ${policy}`);
    break;
  }

  case 'set-group-mode': {
    const mode = args[1];
    if (!GROUP_MODE_VALUES.includes(mode)) {
      console.error(`Usage: set-group-mode <${choices(GROUP_MODE_VALUES)}>`);
      process.exit(1);
    }
    config.groupMode = mode;
    saveConfig(config);
    console.log(`Default group mode set to: ${mode}`);
    break;
  }

  case 'set-group-allowfrom': {
    const channelId = args[1];
    const ids = args[2];
    if (!channelId || !ids) {
      console.error('Usage: set-group-allowfrom <channel_id> <id1,id2,...>');
      process.exit(1);
    }
    if (!config.groups?.[channelId]) {
      console.error(`Group ${channelId} not found.`);
      process.exit(1);
    }
    config.groups[channelId].allowFrom = ids.split(',').map(s => s.trim()).filter(Boolean);
    saveConfig(config);
    console.log(`Updated allowFrom for ${channelId}: ${config.groups[channelId].allowFrom.join(', ')}`);
    break;
  }

  case 'set-group-history-limit': {
    const channelId = args[1];
    const n = parseInt(args[2], 10);
    if (!channelId || isNaN(n)) {
      console.error('Usage: set-group-history-limit <channel_id> <n>');
      process.exit(1);
    }
    if (!config.groups?.[channelId]) {
      console.error(`Group ${channelId} not found.`);
      process.exit(1);
    }
    config.groups[channelId].historyLimit = n;
    saveConfig(config);
    console.log(`History limit for ${channelId} set to ${n}.`);
    break;
  }

  case 'set-markdown': {
    const val = args[1];
    if (!CLI_TOGGLE_VALUES.includes(val)) {
      console.error(`Usage: set-markdown <${choices(CLI_TOGGLE_VALUES)}>`);
      process.exit(1);
    }
    if (!config.message) config.message = {};
    config.message.useMarkdown = val === CLI_TOGGLE.ON;
    saveConfig(config);
    console.log(`Markdown ${val === CLI_TOGGLE.ON ? 'enabled' : 'disabled'}.`);
    break;
  }

  case 'set-connection': {
    const mode = args[1];
    if (!CONNECTION_MODE_VALUES.includes(mode)) {
      console.error(`Usage: set-connection <${choices(CONNECTION_MODE_VALUES)}>`);
      process.exit(1);
    }
    config.connection_mode = mode;
    saveConfig(config);
    console.log(`Connection mode set to: ${mode}. Restart the service for changes to take effect.`);
    break;
  }

  default: {
    console.error(`Unknown command: ${command}. Run "node admin.js help" for usage.`);
    process.exit(1);
  }
}
