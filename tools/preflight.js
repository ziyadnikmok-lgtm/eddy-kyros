/**
 * Is this machine ready to run a big batch? — the checks that are worth running BEFORE spending.
 *
 *   node tools/preflight.js
 *
 * Every line either passes or says exactly what to do about it. Nothing here writes or spends; it
 * is safe to run whenever, and it exists so "it didn't work" is answered in ten seconds instead of
 * after a batch.
 *
 * Deliberately covers the things that have actually gone wrong on this project rather than a
 * generic health check: a stale build serving old code, the queue not being reached, the page
 * capped at six by the browser, a key that is present but unreadable.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };

let ok = 0; let warn = 0; let bad = 0;
const pass = (m, extra) => { ok += 1; console.log(`  OK    ${m}${extra ? `  ${extra}` : ''}`); };
const note = (m, fix) => { warn += 1; console.log(`  NOTE  ${m}\n        -> ${fix}`); };
const fail = (m, fix) => { bad += 1; console.log(`  FIX   ${m}\n        -> ${fix}`); };

console.log('\nKyros preflight\n');

// --- 1. the code you are running ------------------------------------------------------------------
try {
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT }).toString().trim();
  const head = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  pass('git repo', `${branch} @ ${head}`);
  const dirty = execSync('git status --porcelain', { cwd: ROOT }).toString().split('\n').filter((l) => l && !l.startsWith('??'));
  if (dirty.length) note(`${dirty.length} uncommitted change(s)`, 'commit or stash before pulling, so nothing of yours is lost');
} catch {
  note('not a git checkout', 'fine if you copied the folder; you just cannot pull updates');
}

// --- 2. the BUILD is what the app actually runs ------------------------------------------------------
// The single most common "my fix did nothing": source updated, dist not rebuilt.
const distDir = path.join(ROOT, 'client', 'dist', 'assets');
if (!fs.existsSync(distDir)) {
  fail('client/dist is missing', 'cd client && npm install && npx vite build');
} else {
  const newestDist = Math.max(...fs.readdirSync(distDir).map((f) => fs.statSync(path.join(distDir, f)).mtimeMs));
  const srcDir = path.join(ROOT, 'client', 'src');
  let newestSrc = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else newestSrc = Math.max(newestSrc, fs.statSync(full).mtimeMs);
    }
  };
  try { walk(srcDir); } catch { /* no src, nothing to compare */ }
  if (newestSrc > newestDist) {
    fail('the build is OLDER than the source — the app is running old code',
      'cd client && npx vite build   (then restart Kyros)');
  } else {
    pass('build is current', new Date(newestDist).toLocaleString());
  }
}

// --- 3. the queue, which is what makes a big batch possible --------------------------------------------
const rec = read('server/services/generationReconciler.js');
const lanes = Number((rec.match(/KYROS_MAX_INFLIGHT\) \|\| (\d+)/) || [])[1]);
if (!lanes) fail('cannot read the server lane ceiling', 'server/services/generationReconciler.js looks unexpected — pull again');
else if (lanes < 50) note(`server ceiling is only ${lanes}`, 'set KYROS_MAX_INFLIGHT higher, or pull the latest');
else pass('server lane ceiling', String(lanes));

const eddy = read('client/src/pages/EddyGeneratePage.jsx');
const pm = read('client/src/pages/PhotoMatchSeedreamPage.jsx');
const onQueue = (src, name) => {
  if (!src) { fail(`${name} not found`, 'pull again — the checkout looks incomplete'); return; }
  if (src.includes('seedreamApi.edit(')) {
    fail(`${name} still calls the blocking route`,
      'it will be capped at 6 by the browser no matter what the lane count says — pull the latest');
  } else if (src.includes('queuedSeedreamEdit')) {
    pass(`${name} is on the queue`);
  } else {
    note(`${name} does neither`, 'unexpected — worth a look before a big run');
  }
};
onQueue(eddy, 'Eddy Generate');
onQueue(pm, 'Photo Match SD');

const clientLanes = Number((eddy.match(/const NANO2_PARALLEL_REQUESTS = (\d+);/) || [])[1]);
if (clientLanes && lanes && clientLanes < lanes) {
  note(`client lanes (${clientLanes}) are below the server ceiling (${lanes})`, 'the client would be the bottleneck');
} else if (clientLanes) pass('client lanes match the server', String(clientLanes));

// --- 4. the key ---------------------------------------------------------------------------------------
// Present-but-unreadable is a real state: the key is stored encrypted against this install.
try {
  process.env.ELECTRON_USER_DATA = process.env.ELECTRON_USER_DATA
    || path.join(process.env.APPDATA || '', 'ai-content-studio');
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const keys = require(path.join(ROOT, 'server/services/apiKeyManager'));
  const info = keys.getWavespeedKeyInfo?.();
  if (!info?.hasWavespeedKey) {
    fail('no WaveSpeed key', 'add it in Kyros -> API Keys (nano2 and Seedream 5 both need it)');
  } else {
    try {
      keys.getWavespeedKey();
      pass('WaveSpeed key', info.maskedKey || 'set');
    } catch {
      note(`WaveSpeed key present (${info.maskedKey}) but not readable from here`,
        'normal outside the app — it is encrypted per install. Kyros itself can read it.');
    }
  }
} catch {
  note('could not read the key store from here', 'normal outside the app; check Kyros -> API Keys');
}

// --- 5. the suites -------------------------------------------------------------------------------------
const checks = fs.readdirSync(path.join(ROOT, 'tools')).filter((f) => /^check-.*\.js$/.test(f));
let red = 0;
for (const f of checks) {
  try { execSync(`node "${path.join(ROOT, 'tools', f)}"`, { cwd: ROOT, stdio: 'pipe' }); } catch { red += 1; console.log(`        red: ${f}`); }
}
if (red) fail(`${red} of ${checks.length} check suites are red`, 'run the named one to see why before generating');
else pass(`all ${checks.length} check suites green`);

console.log(`\n${bad ? 'NOT READY' : warn ? 'ready, with notes' : 'READY'} — ${ok} ok, ${warn} note(s), ${bad} to fix\n`);
process.exit(bad ? 1 : 0);
