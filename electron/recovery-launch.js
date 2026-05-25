#!/usr/bin/env node

const { spawn } = require('node:child_process');
const path = require('node:path');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [path.join(__dirname, 'recovery-main.js')], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
  env,
});

child.on('close', (code) => process.exit(code ?? 0));
