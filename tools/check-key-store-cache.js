// The API-key store must serve the key that is ON DISK, not the one loaded at boot.
//
// Owner, 2026-08-18, minutes after saving a topped-up WaveSpeed key: "it using the wrong api key
// of wavespeed". The store was cached per userId. On the desktop that is wrong by construction --
// ELECTRON_USER_DATA pins every caller to ONE keys.enc, so a request carrying a user, a queue
// worker running a job with `userId: null` (seen in app.log 2026-08-17T19:14), and a startup
// health check each held their own copy of the same file. Whoever saved won the file; everyone
// else kept serving what they had loaded at boot, for the life of the process. A top-up that
// never takes effect, and a 401 with no explanation.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyros-keystore-'));
const env = { ...process.env, ENCRYPTION_SECRET: '0123456789012345678901234567890123456789' };
// The manager throws on a short secret, so a missing one would fail every case for the wrong reason.
const runNode = (src, extra) => execFileSync(process.execPath, ['-e', src], {
  cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8',
}).split('\n').filter((l) => l.startsWith('>')).map((l) => l.slice(1).trim());

// --- desktop: one file, therefore one store ----------------------------------------------------
const desktop = runNode(`
  const { runWithUser } = require('./server/userContext');
  const m = require('./server/services/apiKeyManager');
  const U = 'user-a';
  runWithUser(U, () => m.setWavespeedKey('OLD-KEY-1111111111'));
  console.log('>' + m.getWavespeedKey());                                  // anon loads the file
  runWithUser(U, () => m.setWavespeedKey('NEW-KEY-2222222222'));           // the user tops up
  console.log('>' + runWithUser(U, () => m.getWavespeedKey()));
  console.log('>' + m.getWavespeedKey());                                  // the queue worker
  console.log('>' + runWithUser('job-with-other-id', () => m.getWavespeedKey()));
`, { ELECTRON_USER_DATA: path.join(tmp, 'desktop') });

check('a fresh read gets the saved key', desktop[0] === 'OLD-KEY-1111111111');
check('the saver sees its own new key', desktop[1] === 'NEW-KEY-2222222222');
// This is THE regression. It returned OLD before the fix.
check('a caller with NO user context sees the new key too', desktop[2] === 'NEW-KEY-2222222222');
check('and so does a job carrying a different id', desktop[3] === 'NEW-KEY-2222222222');

// --- web: different users still must not see each other's keys ---------------------------------
const web = runNode(`
  const { runWithUser } = require('./server/userContext');
  const m = require('./server/services/apiKeyManager');
  runWithUser('alice', () => m.setWavespeedKey('ALICE-1111111111'));
  runWithUser('bob',   () => m.setWavespeedKey('BOB-22222222222'));
  console.log('>' + runWithUser('alice', () => m.getWavespeedKey()));
  console.log('>' + runWithUser('bob',   () => m.getWavespeedKey()));
`, { WEB_DATA_ROOT: path.join(tmp, 'web') });

check('alice keeps her own key', web[0] === 'ALICE-1111111111');
check('bob keeps his', web[1] === 'BOB-22222222222');

// --- a write from outside this process is picked up --------------------------------------------
const external = runNode(`
  const fs = require('fs'), path = require('path');
  const { runWithUser } = require('./server/userContext');
  const m = require('./server/services/apiKeyManager');
  const root = process.env.WEB_DATA_ROOT;
  runWithUser('alice', () => m.setWavespeedKey('ALICE-1111111111'));
  runWithUser('carol', () => m.setWavespeedKey('CAROL-333333333'));
  console.log('>' + runWithUser('alice', () => m.getWavespeedKey()));
  const af = path.join(root, 'alice', 'data', 'keys.enc');
  const a = JSON.parse(fs.readFileSync(af, 'utf8'));
  const c = JSON.parse(fs.readFileSync(path.join(root, 'carol', 'data', 'keys.enc'), 'utf8'));
  a.wavespeedKeyEncrypted = c.wavespeedKeyEncrypted;                        // somebody else's write
  fs.writeFileSync(af, JSON.stringify(a));
  console.log('>' + runWithUser('alice', () => m.getWavespeedKey()));
  console.log('>' + runWithUser('carol', () => m.getWavespeedKey()));
`, { WEB_DATA_ROOT: path.join(tmp, 'ext') });

check('the cached copy is right until the file changes', external[0] === 'ALICE-1111111111');
check('an external rewrite is noticed rather than cached over', external[1] === 'CAROL-333333333');
check('and it does not disturb anybody else', external[2] === 'CAROL-333333333');

// --- the code says what it is doing ------------------------------------------------------------
const src = fs.readFileSync(path.join(ROOT, 'server/services/apiKeyManager.js'), 'utf8');
check('the cache is keyed by file, not by user', src.includes('const held = this._userStores.get(file);'));
check('a save re-stamps, so it never costs a reload',
  src.includes('// Re-stamp so our own write does not read as somebody else\'s and force a pointless reload.'));
check('the reason is written down where the next person will look',
  /ELECTRON_USER_DATA pins every caller to one/.test(src));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
