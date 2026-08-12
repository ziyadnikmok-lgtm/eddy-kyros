// A change must take effect without the owner reloading by hand.
//
// This was the real cost of 2026-08-10, and it was invisible: every fix shipped correctly and then
// appeared not to work. Measured from the Electron HTTP cache that day -- app started 11:16:34,
// build finished 11:50:33, new chunk not fetched until 11:54, i.e. only when the window was
// reloaded manually. Four minutes of chasing a fix that had already landed, repeated all day.
//
// Two separate staleness paths, because the app is two processes:
//   RENDERER — Express serves client/dist from disk per request, so a build is live instantly, but
//              the booted window keeps the bundle it started with.
//   SERVER   — routes are require()d once at boot, so a route file change needs a process restart.
//              Reloading the window can never help: the window is not the server.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the renderer reloads itself -----------------------------------------------------------------
check('a build watcher exists', main.includes('function watchBuildForReload()'));
check('it is started on ready', /createWindow\(\);\s*\n\s*watchBuildForReload\(\);/.test(main));
check('it watches index.html, which Vite rewrites on every build',
  main.includes("path.join(__dirname, '..', 'client', 'dist', 'index.html')"));
check('NOT client/src — that would fire on every keystroke', !/fs\.watch\([^)]*client['"],\s*['"]src/.test(main));
check('it reloads ignoring cache, so a stale entry cannot survive',
  main.includes('mainWindow.webContents.reloadIgnoringCache()'));
check('debounced — a build rewrites several files in a burst', /clearTimeout\(timer\);\s*\n\s*timer = setTimeout/.test(main));
check('dev only; a packaged dist never changes underneath itself',
  /function watchBuildForReload\(\) \{\s*\n\s*if \(app\.isPackaged\) return;/.test(main));
check('a missing watcher cannot stop the app booting', /could not watch the build/.test(main));
check('a destroyed window is not reloaded', main.includes('if (mainWindow && !mainWindow.isDestroyed())'));

// --- the server does NOT auto-restart, and that is deliberate ---------------------------------
// --watch looked right here, but fork() sets up an IPC channel and --watch restarts the child out
// from under it: Electron launched, the window opened, and the backend never answered. Caught in
// testing, reverted, and the reason recorded so nobody re-adds it.
check('no --watch on the server fork', !/execArgv/.test(main));
check('and the reason is written down, so it is not re-added',
  main.includes('fork() sets up an IPC channel and --watch restarts the child out from'));
check('the restart script is named as the answer instead', main.includes('tools/restart-kyros.ps1'));

// --- the reasoning is written down where the next person will look ------------------------------------
check('the renderer-vs-server split is explained', main.includes('the window is not the server'));
check('the measured evidence is kept', /11:50/.test(main) && /11:54/.test(main));

// --- replay: which change needs what ------------------------------------------------------------------
const needs = (file) => {
  if (/^client\/src\//.test(file)) return 'build + auto-reload';
  if (/^server\//.test(file)) return 'server --watch restart';
  if (/^electron\//.test(file)) return 'full app restart';
  return 'nothing';
};
check('a React edit is covered by the build watcher', needs('client/src/pages/EddyGeneratePage.jsx') === 'build + auto-reload');
check('a route edit is covered by --watch', needs('server/routes/pinterestFeed.js') === 'server --watch restart');
check('an electron/main edit still needs a full restart — nothing can watch its own bootstrap',
  needs('electron/main.js') === 'full app restart');

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
