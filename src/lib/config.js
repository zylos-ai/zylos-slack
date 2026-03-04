import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/slack');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  enabled: true,
  connection_mode: 'socket',       // 'socket' (Socket Mode) or 'webhook'
  webhook_port: 3461,

  owner: {
    bound: false,
    user_id: '',
    name: ''
  },

  dmPolicy: 'owner',              // 'open' | 'allowlist' | 'owner'
  dmAllowFrom: [],                // user IDs allowed to DM (when dmPolicy='allowlist')

  groupPolicy: 'allowlist',       // 'open' | 'allowlist' | 'disabled'
  groups: {},                      // per-channel config: { C0123: { name, mode, allowFrom, historyLimit } }

  message: {
    context_messages: 10,
    useMarkdown: true              // use Slack mrkdwn formatting
  }
};

let config = null;
let configWatcher = null;

export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      config = { ...DEFAULT_CONFIG, ...JSON.parse(content) };
    } else {
      console.warn('[slack] Config not found:', CONFIG_PATH);
      config = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.error('[slack] Failed to load config:', err.message);
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

export function getConfig() {
  if (!config) loadConfig();
  return config;
}

export function saveConfig(newConfig) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
    config = newConfig;
  } catch (err) {
    console.error('[slack] Failed to save config:', err.message);
    throw err;
  }
}

export function watchConfig(onChange) {
  if (configWatcher) configWatcher.close();

  const dir = path.dirname(CONFIG_PATH);
  if (fs.existsSync(dir)) {
    let debounce = null;
    configWatcher = fs.watch(dir, (eventType, filename) => {
      if (filename === 'config.json') {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          console.log('[slack] Config changed, reloading...');
          loadConfig();
          if (onChange) onChange(config);
        }, 100);
      }
    });
  }
}

export function stopWatching() {
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
}
