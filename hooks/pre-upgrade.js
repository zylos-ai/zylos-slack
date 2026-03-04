#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/slack');
const configPath = path.join(DATA_DIR, 'config.json');

console.log('[pre-upgrade] Running pre-upgrade checks...\n');

// Backup config
if (fs.existsSync(configPath)) {
  const backupPath = configPath + '.backup';
  fs.copyFileSync(configPath, backupPath);
  console.log('Config backed up to:', backupPath);
}

console.log('\n[pre-upgrade] Checks passed, proceeding with upgrade.');
