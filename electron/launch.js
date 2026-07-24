#!/usr/bin/env node
// electron/launch.js
// Launcher that clears ELECTRON_RUN_AS_NODE (set by VS Code terminals)
// before spawning the real Electron process.

const { spawn } = require('node:child_process');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  cwd: require('node:path').join(__dirname, '..'),
  env,
});

child.on('close', (code) => process.exit(code ?? 0));
