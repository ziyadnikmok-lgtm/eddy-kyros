// The durable generation queue — the state machine that decides whether a paid picture survives
// the app closing.
//
// The rule this file exists to defend: A JOB THAT REACHED MUAPI IS NEVER RE-SENT.
//
// Muapi is submit-then-poll. Once it hands back a request_id it is rendering, and it has charged
// for that render. Re-sending on restart would buy the same picture twice, silently, every time the
// app is closed mid-run — the failure would look like nothing at all until the bill arrived. So
// `submitted` jobs are re-POLLED and only `queued` ones (which reached nobody, and cost nothing)
// are re-sent.
//
// Second rule: `done` is not `filed`. The libraries are IndexedDB in the browser, so the server
// cannot put a picture in one. It gets the job to `done` with a gallery_id and the CLIENT files it.
// Collapsing those two would let a job read as complete while its picture reached no library.
//
// better-sqlite3 is compiled for Electron's ABI and will not load under plain node, so this drives
// the queue against node's built-in sqlite instead — the same API surface for everything the queue
// uses — and against the REAL schema, lifted out of db.js so a change there cannot pass unnoticed.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const dbSrc = fs.readFileSync(path.join(ROOT, 'server/db.js'), 'utf8').replace(/\r\n/g, '\n');

// The real CREATE TABLE + its indexes, not a copy that could drift from it.
const start = dbSrc.indexOf('CREATE TABLE IF NOT EXISTS generation_jobs');
const end = dbSrc.indexOf('ON generation_jobs(user_id, filed, status);', start);
if (start < 0 || end < 0) { console.log('  FAIL could not find the generation_jobs schema in server/db.js\n\nFAIL — 1'); process.exit(1); }
const schema = dbSrc.slice(start, end + 'ON generation_jobs(user_id, filed, status);'.length);

const mem = new DatabaseSync(':memory:');
// generation_jobs.user_id is a real foreign key, and node:sqlite enforces those by default where
// better-sqlite3 does not. Creating the referenced table keeps the constraint live here rather
// than quietly disabling it — the CASCADE is part of the behaviour worth testing.
mem.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)');
mem.exec(schema);
mem.prepare('INSERT INTO users (id) VALUES (?), (?)').run('user-1', 'user-2');

// Stand in for server/db.js so jobQueue talks to the in-memory database.
const dbPath = require.resolve(path.join(ROOT, 'server/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mem, children: [], paths: [] };
const q = require(path.join(ROOT, 'server/services/jobQueue.js'));

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };
const USER = 'user-1';
const add = (over = {}) => q.enqueue({ userId: USER, feature: 'seedreamEdit', payload: { prompt: 'p' }, destDb: 'eddy-base', destFolder: 'Grace', cardPrompt: 'Scene', cardName: 'scene-1', ...over });

// --- 1. enqueue writes BEFORE anything is sent -----------------------------------------------------
const id1 = add();
const j1 = q.get(id1);
check('a job starts queued', j1.status === q.STATUS.QUEUED);
check('with no task id — nothing has been sent', j1.task_id === null);
check('the payload round-trips as an object', j1.payload.prompt === 'p');
check('the destination is captured at enqueue', j1.dest_db === 'eddy-base' && j1.dest_folder === 'Grace');
check('and so is the card text', j1.card_prompt === 'Scene' && j1.card_name === 'scene-1');
check('it is not filed', j1.filed === false);
check('enqueue refuses a job with no user', (() => { try { q.enqueue({ feature: 'x' }); return false; } catch { return true; } })());
check('enqueue refuses a job with no feature', (() => { try { q.enqueue({ userId: USER }); return false; } catch { return true; } })());

// --- 2. claiming is atomic ---------------------------------------------------------------------------
const c1 = q.claimNext();
check('claimNext returns the queued job', c1.id === id1);
check('and counts the attempt', c1.attempts === 1);
// Without this the next tick hands the SAME job to a second sender and Muapi renders it twice.
check('claiming moves it out of the queued pool', c1.status === q.STATUS.SUBMITTING);
check('so claiming again returns nothing', q.claimNext() === null);

// Two ticks racing must not both get the same row.
const idR = add();
const a = q.claimNext();
const b = q.claimNext();
check('a second claim on the same row returns null, not a duplicate', a && a.id === idR && b === null);
// Park the racer so later FIFO assertions see a clean queue.
q.markSubmitted(idR, 'muapi-racer');

// --- 3. THE RULE: a submitted job is never re-sent -------------------------------------------------------
q.markSubmitted(id1, 'muapi-req-abc');
const s1 = q.get(id1);
check('submitting records the task id', s1.status === q.STATUS.SUBMITTED && s1.task_id === 'muapi-req-abc');
check('markSubmitted REFUSES a missing task id — the job would be unrecoverable',
  (() => { try { q.markSubmitted(id1, ''); return false; } catch { return true; } })());
check('requeueUnsent refuses a job that reached Muapi', q.requeueUnsent(id1) === false);
check('and it is still submitted afterwards', q.get(id1).status === q.STATUS.SUBMITTED);
check('a submitted job is never handed back by claimNext', q.claimNext() === null || q.claimNext().id !== id1);

// A job that never reached Muapi cost nothing and IS safe to resend.
const idUnsent = add();
q.claimNext();
check('requeueUnsent accepts a job with no task id', q.requeueUnsent(idUnsent) === true);
check('and it goes back to queued', q.get(idUnsent).status === q.STATUS.QUEUED);

// --- 4. the boot sweep sees exactly the recoverable jobs ---------------------------------------------------
const resumable = q.listResumable();
check('the sweep finds the submitted job', resumable.some((r) => r.id === id1));
check('it carries the task id needed to poll it', resumable.find((r) => r.id === id1).task_id === 'muapi-req-abc');
check('it does NOT include queued jobs — the worker gets those anyway',
  !resumable.some((r) => r.status === q.STATUS.QUEUED));
check('and it carries the destination the run was STARTED with',
  resumable.find((r) => r.id === id1).dest_db === 'eddy-base');

// --- 5. done is not filed --------------------------------------------------------------------------------
q.markDone(id1, 'gal-123');
const d1 = q.get(id1);
check('done records the gallery id', d1.status === q.STATUS.DONE && d1.gallery_id === 'gal-123');
check('but it is still NOT filed', d1.filed === false);
check('so the client sees it as outstanding work', q.listUnfiled(USER).some((r) => r.id === id1));
check('and it is no longer resumable', !q.listResumable().some((r) => r.id === id1));

check('filing it flips the flag', q.markFiled(id1, USER) === true);
check('and it drops out of the unfiled list', !q.listUnfiled(USER).some((r) => r.id === id1));

// One account must never be able to mark another's work filed — that would hide a picture from
// the person who paid for it.
const idOther = q.enqueue({ userId: 'user-2', feature: 'seedreamEdit', payload: {} });
q.claimNext(); q.markSubmitted(idOther, 't2'); q.markDone(idOther, 'gal-2');
check('another user cannot mark it filed', q.markFiled(idOther, USER) === false);
check('it stays unfiled for its real owner', q.listUnfiled('user-2').some((r) => r.id === idOther));
check('and never appears in the first user\'s list', !q.listUnfiled(USER).some((r) => r.id === idOther));

// --- 6. a done job with no image is not offered for filing -------------------------------------------------
const idNoImg = add();
q.claimNext(); q.markSubmitted(idNoImg, 't3'); q.markDone(idNoImg, null);
check('a done job with no gallery id is not offered to the client', !q.listUnfiled(USER).some((r) => r.id === idNoImg));

// --- 7. failure is terminal and carries the reason ---------------------------------------------------------
const idFail = add();
q.claimNext(); q.markFailed(idFail, 'Seedream returned no image');
const f1 = q.get(idFail);
check('failed records the reason', f1.status === q.STATUS.FAILED && f1.error === 'Seedream returned no image');
check('a failed job is not resumable', !q.listResumable().some((r) => r.id === idFail));
check('and is not offered for filing', !q.listUnfiled(USER).some((r) => r.id === idFail));
check('a very long error is truncated rather than rejected',
  (() => { const i = add(); q.markFailed(i, 'x'.repeat(2000)); return q.get(i).error.length === 500; })());

// --- 8. THE ORPHAN WINDOW: interrupted mid-send is failed, never resent -----------------------------------
// A `submitting` row with no task_id may already be rendering and billed. Guessing wrong costs a
// silent double charge, so it fails closed. Same principle as the posting side: fail toward the
// miss, never toward the duplicate.
const idOrphan = add();
q.claimNext();
check('mid-send, it sits in submitting with no task id',
  q.get(idOrphan).status === q.STATUS.SUBMITTING && q.get(idOrphan).task_id === null);
const closed = q.resolveOrphans();
check('the boot sweep closes it', closed >= 1 && q.get(idOrphan).status === q.STATUS.FAILED);
check('and it is NOT put back on the queue to be paid for twice', q.get(idOrphan).status !== q.STATUS.QUEUED);
check('the reason says it may already have been charged', /may already have been charged/.test(q.get(idOrphan).error || ''));
check('a job that DID record its task id is untouched by the sweep', q.get(idR).status === q.STATUS.SUBMITTED);

// --- 9. retries are bounded ---------------------------------------------------------------------------------
// A payload Muapi rejects will be rejected identically next time; an endless retry loop against a
// paid API is worse than a visible failure.
const idRetry = add();
for (let i = 0; i < q.MAX_SUBMIT_ATTEMPTS; i += 1) {
  const c = q.claimNext();
  if (c && c.id === idRetry) q.requeueUnsent(idRetry);   // a definite send failure, safe to resend
}
q.claimNext();
check(`a job is failed after ${q.MAX_SUBMIT_ATTEMPTS} submit attempts, not retried forever`,
  q.get(idRetry).status === q.STATUS.FAILED);
check('and says why', /Gave up after/.test(q.get(idRetry).error || ''));

// --- 10. FIFO, and the active list ------------------------------------------------------------------------------
const q1 = add(); const q2 = add();
const firstOut = q.claimNext();
check('the queue is first in, first out', firstOut.id === q1 && q.get(q2).status === q.STATUS.QUEUED);

const active = q.listActive(USER);
check('active covers everything still moving — queued, submitting and submitted',
  active.every((r) => [q.STATUS.QUEUED, q.STATUS.SUBMITTING, q.STATUS.SUBMITTED].includes(r.status)));
check('and excludes finished work', !active.some((r) => r.id === id1));

// --- 11. a corrupt payload must not take the queue down ----------------------------------------------------------
mem.prepare("UPDATE generation_jobs SET payload = '{not json' WHERE id = ?").run(q2);
check('a corrupt payload hydrates to {} instead of throwing',
  (() => { try { return JSON.stringify(q.get(q2).payload) === '{}'; } catch { return false; } })());
check('and the job is still claimable', (() => { const c = q.claimNext(); return c && c.id === q2; })());

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
