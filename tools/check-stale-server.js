// The app must SAY when the running server is older than the code on disk.
//
// 2026-08-19, the most expensive bug of the project so far — and it was not in any feature.
// Electron watches client/dist and reloads the window on every rebuild, so the CLIENT is always
// current. The server is not: server/*.js is read once at boot. The owner spent a day testing
// fixes against a process that had booted 25 hours earlier. A newly added route 404'd, the
// caller's catch swallowed it, and three separate bugs all read as "still same".
//
// Nothing in the app said so. This suite is here so nothing ever removes the thing that does.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const idx = read('server/index.js');
const panel = read('client/src/components/GenerationQueuePanel.jsx');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the server knows when it went stale ----------------------------------------------------------
check('boot time is stamped once, not read per request', idx.includes('const BOOT_MS = Date.now();'));
check('there is a staleness check', idx.includes('function serverCodeChangedAfterBoot()'));
check('it compares the newest server .js mtime against boot',
  idx.includes("e.name.endsWith('.js')") && idx.includes('newest > BOOT_MS'));
check('node_modules is skipped, or the walk is pointless',
  idx.includes("e.name === 'node_modules'"));
check('the walk is depth-limited so health stays cheap', idx.includes('if (depth > 3) return;'));
// An unreadable directory must not take the health endpoint down with it.
check('it never throws — an unreadable tree just reports nothing',
  idx.includes('try { walk(dir, 0); } catch { return null; }'));
check('a second of slack, so clock skew is not reported as staleness', idx.includes('BOOT_MS + 1000'));
check('health exposes it', idx.includes('staleServer: stale,'));
check('and says when it booted, so the age is checkable', idx.includes('bootedAt: new Date(BOOT_MS).toISOString(),'));
// null when fresh: verified live on 2026-08-19 — fresh boot reported null, and touching
// server/routes/jobs.js flipped it to a staleSinceMs of ~11s.
check('absent when fresh is the normal case, and documented', /Present ONLY when server code on disk is newer/.test(idx));

// --- the UI shows it, on a bar that is on every page ----------------------------------------------
check('the panel reads health', panel.includes("fetch('/api/health')"));
check('on the poll that already runs — no second timer', panel.indexOf("fetch('/api/health')") > panel.indexOf('const load = useCallback'));
check('a failed health check says nothing rather than crying wolf',
  panel.includes('/* offline or restarting: say nothing rather than cry wolf */'));
check('there is a banner', panel.includes('Server code changed since it started'));
// THE thing that made this expensive: the bar hides itself when the queue is empty, and a quiet
// page is exactly where a silent 404 goes unnoticed longest.
check('the banner survives the empty-queue early return',
  panel.includes('if (!counts || (!counts.active && !counts.failed && !counts.unfiled)) return staleBanner;'));
check('and it tells the owner what to actually DO', /Quit Kyros completely and reopen it/.test(panel));
check('naming the asymmetry, so the advice makes sense',
  /The window reloads itself on a rebuild; the server does not/.test(panel));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
