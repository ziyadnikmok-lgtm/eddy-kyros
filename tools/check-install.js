#!/usr/bin/env node
/**
 * Check that an install actually produced a runnable app, and say what to run if not.
 *
 * Two different failures produce the SAME symptom — the app opens to a landing page because
 * the backend died at startup:
 *
 *   1. Install scripts were blocked, so Electron's postinstall never downloaded the binary and
 *      no native module was ever compiled.
 *   2. Scripts ran, but better-sqlite3 was built for system Node instead of Electron's ABI.
 *
 * The fix differs (`npm install` vs `npm run rebuild:electron`) and guessing wrong wastes an
 * hour, so this looks at what is actually on disk instead.
 *
 * Run: npm run verify
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const checks = [];

function check(name, relPath, fix, why) {
  const full = path.join(root, relPath);
  const ok = fs.existsSync(full);
  checks.push({ name, ok, fix, why });
  return ok;
}

const electronOk = check(
  'Electron binary',
  'node_modules/electron/dist/electron.exe',
  'npm install    (and allow install scripts if your npm blocked them)',
  'Electron postinstall downloads this. Missing means scripts never ran — rebuilding native modules will NOT fix it.',
);

check(
  'better-sqlite3 native binding',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  electronOk ? 'npm run rebuild:electron' : 'npm install first, then npm run rebuild:electron',
  'The database driver. Absent or built for the wrong runtime kills the backend at startup.',
);

check(
  'sharp',
  'node_modules/sharp/package.json',
  'npm install',
  'Used to re-encode every image before upload.',
);

check(
  'client build output',
  'client/dist/index.html',
  'cd client && npm install && npm run build',
  'The app serves from client/dist. Without it there is no UI to show.',
);

const failed = checks.filter((c) => !c.ok);

console.log('');
for (const c of checks) console.log(`  ${c.ok ? 'OK  ' : 'MISS'}  ${c.name}`);
console.log('');

if (!failed.length) {
  console.log('  Install looks complete. If the app still opens to a landing page, the backend');
  console.log('  is dying for another reason — check the log at:');
  console.log('  %APPDATA%/ai-content-studio/logs/app.log');
  console.log('');
  process.exit(0);
}

console.log('  Not runnable yet:');
for (const c of failed) {
  console.log('');
  console.log(`  ${c.name}`);
  console.log(`    why : ${c.why}`);
  console.log(`    fix : ${c.fix}`);
}
console.log('');
// Non-zero so a chained command stops here rather than continuing into a broken build.
process.exit(1);
