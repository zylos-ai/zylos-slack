#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/slack');

const INITIAL_CONFIG = {
  enabled: true,
  connection_mode: 'socket',
  webhook_port: 3461,

  owner: { bound: false, user_id: '', name: '' },

  dmPolicy: 'owner',
  dmAllowFrom: [],

  groupPolicy: 'allowlist',
  groups: {},

  message: {
    context_messages: 10,
    useMarkdown: true
  }
};

console.log('[post-install] Running slack component setup...\n');

// 1. Create subdirectories
console.log('Creating subdirectories...');
for (const sub of ['logs', 'media', 'typing']) {
  fs.mkdirSync(path.join(DATA_DIR, sub), { recursive: true });
  console.log(`  - ${sub}/`);
}

// 2. Create default config.json
const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  console.log('\nCreating default config.json...');
  fs.writeFileSync(configPath, JSON.stringify(INITIAL_CONFIG, null, 2));
  console.log('  - config.json created');
} else {
  console.log('\nconfig.json already exists, skipping.');
}

// 3. Check environment variables
console.log('\nChecking environment variables...');
let envContent = '';
try {
  envContent = fs.readFileSync(path.join(HOME, 'zylos/.env'), 'utf8');
} catch {}

const required = [
  { name: 'SLACK_BOT_TOKEN', desc: 'Bot User OAuth Token (xoxb-...)' },
  { name: 'SLACK_APP_TOKEN', desc: 'App-Level Token (xapp-...) for Socket Mode' },
];

let missing = false;
for (const { name, desc } of required) {
  if (!envContent.includes(name + '=')) {
    console.log(`  [!] ${name} not found in .env — ${desc}`);
    missing = true;
  } else {
    console.log(`  [✓] ${name}`);
  }
}

if (missing) {
  console.log('\nTo configure, add the missing tokens to ~/zylos/.env');
  console.log('Then restart the service: pm2 restart zylos-slack');
}

console.log('\n[post-install] Complete!');
