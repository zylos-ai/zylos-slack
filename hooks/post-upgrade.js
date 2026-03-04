#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/slack');
const configPath = path.join(DATA_DIR, 'config.json');

console.log('[post-upgrade] Running migrations...\n');

if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let migrated = false;
    const migrations = [];

    // Migration: ensure enabled field exists
    if (config.enabled === undefined) {
      config.enabled = true;
      migrated = true;
      migrations.push('Added enabled field');
    }

    // Migration: ensure message section exists
    if (!config.message) {
      config.message = { context_messages: 10, useMarkdown: true };
      migrated = true;
      migrations.push('Added message config section');
    }

    // Migration: ensure groups object exists
    if (!config.groups) {
      config.groups = {};
      migrated = true;
      migrations.push('Added groups config');
    }

    // Migration: ensure typing dir exists
    const typingDir = path.join(DATA_DIR, 'typing');
    if (!fs.existsSync(typingDir)) {
      fs.mkdirSync(typingDir, { recursive: true });
      migrations.push('Created typing directory');
    }

    if (migrated) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('Config migrations applied:');
      migrations.forEach(m => console.log('  - ' + m));
    } else {
      console.log('No migrations needed.');
    }
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
} else {
  console.log('No config.json found, skipping migrations.');
}

console.log('\n[post-upgrade] Complete!');
