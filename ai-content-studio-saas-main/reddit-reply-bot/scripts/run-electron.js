'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');

const candidates = [
  path.join(rootDir, 'node_modules', 'electron', 'cli.js'),
  path.join(rootDir, '..', 'node_modules', 'electron', 'cli.js'),
];

const cliPath = candidates.find((candidate) => fs.existsSync(candidate));

if (!cliPath) {
  console.error('Electron CLI not found. Run "npm install" inside reddit-post-studio or from the parent workspace.');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [cliPath, rootDir], {
  stdio: 'inherit',
  cwd: rootDir,
  env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
