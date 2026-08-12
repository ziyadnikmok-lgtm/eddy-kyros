// CLAUDE.md has to be TRUE, not just present.
//
// This file is the first thing every session reads and the last thing anyone re-reads. On
// 2026-08-11 it opened by telling a session to `cd /Users/admin/ai-content-studio-saas-main` -- a
// Mac path that has never existed on this machine -- listed the local port as 3001 when it is
// 18421, and pointed at a launcher and a notes file that are both gone. It had said all of that for
// months, confidently, and nothing could notice.
//
// A handoff document that lies is worse than a short one: it is trusted, so its errors are acted on
// before they are questioned. So the claims it makes are assertions now, and they run with the
// other suites before a push.
const fs = require('fs');
const path = require('path');

// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const doc = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- 1. no command from an operating system THIS machine is not ------------------------------------
// The rule is "a command the reader cannot run is a lie", and who the reader is depends on the
// laptop. This repo is shared -- the owner is on Windows, a collaborator may not be -- so the ban
// list is chosen by platform rather than hardcoded, and the doc is expected to carry both forms.
const IS_WINDOWS = process.platform === 'win32';
const MAC_ONLY = [
  ['/Users/', 'a Mac home path'],
  ['~/Library/', 'a Mac Application Support path'],
  ['pkill ', 'pkill (not a Windows command)'],
  ['open /Applications', 'open /Applications'],
  ['.command', 'a .command launcher'],
];
// Only what could be COPIED AND RUN or FOLLOWED: fenced code blocks and table cells. Prose is
// exempt on purpose -- the rule forbidding a thing has to be able to name it, and a check that
// cannot tell an instruction from a description gets worked around instead of obeyed.
const runnable = [];
let inFence = false;
for (const line of doc.split('\n')) {
  if (line.trim().startsWith('```')) { inFence = !inFence; continue; }
  if (inFence || /^\|/.test(line)) runnable.push(line);
}
check('some runnable lines were found — an empty list would pass everything', runnable.length > 10);
for (const [needle, label] of MAC_ONLY) {
  const offending = runnable.filter((l) => l.includes(needle));
  check(`no runnable line contains ${label}`, offending.length === 0);
}

// --- 2. every path the KEY PATHS table names actually exists ------------------------------------------
// The table is the map. A row pointing nowhere is the failure this whole file exists to prevent.
// Scoped to the KEY PATHS section alone. Every other table in this file (KNOWN ISSUES, env vars)
// backticks function names and settings, which are not paths and must not be looked up on disk.
const section = (/## 2\) KEY PATHS([\s\S]*?)\n## /.exec(doc) || [])[1] || '';
const paths = [];
for (const row of section.split('\n').filter((l) => /^\|\s*[^|]+\|\s*`/.test(l))) {
  const cell = row.split('|')[2] || '';
  for (const m of cell.matchAll(/`([^`]+)`/g)) {
    const raw = m[1];
    if (/^https?:\/\/|^github\.com/.test(raw)) continue;   // a URL
    if (/^[a-z][a-z0-9-]*$/.test(raw)) continue;           // a remote or branch name: origin, main
    if (/^\d+$/.test(raw)) continue;                       // a port
    if (/^[A-Z][A-Z0-9_]*$/.test(raw)) continue;           // an identifier: PREFERRED_PORT, PORT
    if (raw.includes('{') || raw.includes('*')) continue;  // a template or a glob
    paths.push(raw.replace(/%APPDATA%/i, process.env.APPDATA || ''));
  }
}
check('the KEY PATHS section was located', section.length > 0);
check('the KEY PATHS table was actually found and parsed', paths.length >= 6);
let skipped = 0;
for (const p of paths) {
  /**
   * A path can only be checked on the machine it belongs to.
   *
   * A Windows path (C:\..., %APPDATA%) cannot exist on a collaborator's Mac, and asserting it there
   * would turn a green suite red on a machine where nothing is wrong -- which is worse than not
   * checking, because a suite people learn to ignore protects nothing. Counted and reported, never
   * silently passed.
   */
  const windowsy = /^[A-Za-z]:/.test(p) || p.includes('%APPDATA%');
  if (windowsy && !IS_WINDOWS) { skipped += 1; continue; }
  const abs = path.isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : path.join(ROOT, p);
  check(`KEY PATHS: ${p} exists`, fs.existsSync(abs));
}
if (skipped) console.log(`  --   ${skipped} machine-specific path(s) not checked on ${process.platform}`);

// --- 3. the port it names is the port the app uses ------------------------------------------------------
const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8').replace(/\r\n/g, '\n');
const realPort = (/const PREFERRED_PORT = (\d+)/.exec(main) || [])[1];
check('electron/main.js still declares PREFERRED_PORT', !!realPort);
check(`the doc names the real local port (${realPort})`, doc.includes(`\`${realPort}\``));
check('and does not call the production port the local one',
  !/Local port \| `3001`/.test(doc));

// --- 4. every tools/ script it points at is really there --------------------------------------------------
const named = new Set();
for (const m of doc.matchAll(/tools[\\/]([a-zA-Z0-9._-]+\.(?:js|ps1|py))/g)) named.add(m[1]);
check('the doc points at some tooling at all', named.size > 0);
for (const f of named) {
  if (f.includes('*')) continue;
  check(`tools/${f} exists`, fs.existsSync(path.join(ROOT, 'tools', f)));
}

// --- 5. no secret ever gets written into it -----------------------------------------------------------------
// A doc is committed and shared with a collaborator; a token pasted in "just to remember it" is a
// token published. Patterns, not values, so this file carries no secret either.
const SECRETS = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/sk-[A-Za-z0-9]{20,}/, 'an OpenAI-style key'],
  [/AIza[A-Za-z0-9_-]{20,}/, 'a Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
];
for (const [re, label] of SECRETS) check(`no ${label} in the doc`, !re.test(doc));

// --- 6. the rules keep their dates and their enforcement ------------------------------------------------------
// A rule with no date cannot be judged stale, and a rule with no check will be broken again.
const ruleHeadings = doc.split('\n').filter((l) => /^### \d+\./.test(l));
check('the bug-earned rules are still numbered headings', ruleHeadings.length >= 5);
check('the standard work loop restarts the Windows way',
  doc.includes('tools\\restart-kyros.ps1') || doc.includes('tools/restart-kyros.ps1'));
check('and says to run every check before a push', /Run every `tools\/check-\*\.js` before any push/.test(doc));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
