// How a photo gets onto Photo Match — dropped, pasted, picked, or sent from the Library.
//
// Owner, 2026-08-17: "and it can support mass draging or send from library or anything ye".
// Verifying that turned up three ways a photo could arrive WRONG, all from the same cause: adding
// a source was written twice, once for files and once for the Library handoff.
//
//   1. A Library send never ran face detection. Auto-blur is on by default and is the single most
//      reliable way to stop a rival face capturing the character — and it silently did not apply to
//      anything sent from the Library, Frames, Instagram Frames or Pinterest.
//   2. A Library send never set backView, so a photo shot from behind was treated as front-facing
//      and the prompt ordered up a face the photo does not contain.
//   3. A Library send ignored the 50-photo cap entirely.
//
// Plus one that hit the drop path: a batch bigger than the remaining room was truncated in silence.
//
// And one destination bug: every sender navigates to 'photoMatchSeedream' because they were written
// before NB2 existed, so a send while working in NB2 moved you to the other tab.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const page = read('client/src/pages/PhotoMatchSeedreamPage.jsx');
const handoff = read('client/src/lib/sourceHandoff.js');

let pass = 0; let fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- ONE intake, so a photo cannot arrive half-processed -------------------------------------------
check('there is a single intake for source photos', page.includes('const intakeUrls = useCallback(async (urls, { mode = \'add\' } = {}) => {'));
check('files go through it', page.includes('await intakeUrls(urls);'));
check('and so does the Library/Pinterest/Frames handoff',
  page.includes('const took = await intakeUrls(items.map((it) => it.dataUrl), { mode });'));
// The old handoff built tiles by hand. If that ever comes back, everything below is bypassed again.
check('the handoff no longer builds source tiles itself',
  !page.includes('const incoming = items.map((it, i) => ({ id: `s-${Date.now()}-${i}`, dataUrl: it.dataUrl }));'));
check('every arrival is face-detected', page.includes('const face = await findFace(dataUrl)'));
check('every arrival gets a back-view verdict', page.includes('backView: !face.present'));
check('and the reason the two paths were merged is written down',
  /Dropping a file and sending from the Library used to be two separate intakes/.test(page));

// --- nothing is discarded in silence -----------------------------------------------------------------
check('a full page says so rather than ignoring the drop',
  page.includes('Already at the ${MAX_SOURCES}-photo limit — clear some first'));
check('photos that do not fit are counted and reported',
  page.includes('const overflow = fresh.length - take.length;')
  && page.includes('left out — the limit is ${MAX_SOURCES}'));
check('files that are not images are counted and reported',
  page.includes('const skipped = all.length - images.length;')
  && page.includes('skipped — only PNG, JPEG and WEBP can be used'));
check('a file that cannot be read is reported too, not dropped as a blank',
  page.includes('const unreadable = images.length - urls.length;'));
check('duplicates are mentioned rather than vanishing', page.includes('already here`, \'info\''));
// The count in the toast comes from what was TAKEN, not from what was sent — otherwise a truncated
// send cheerfully reports the full number.
check('the confirmation counts what actually landed', page.includes('if (took) notify(`${took} source'));

// --- the cap is real on both paths -------------------------------------------------------------------
const intake = page.slice(page.indexOf('const intakeUrls = useCallback'), page.indexOf('const addSources = useCallback'));
check('the cap is applied inside the shared intake', intake.includes('const room = replace ? MAX_SOURCES : MAX_SOURCES - sources.length;'));
check('a replace starts from a clean page, so the whole cap is available', intake.includes('const replace = mode === \'replace\';'));
check('and dedupe only skips what is already on the page', intake.includes('const have = new Set(replace ? [] : sources.map((s) => s.dataUrl));'));

// --- the REAL arithmetic, lifted out and run ---------------------------------------------------------
// Source-text assertions prove the lines exist; this proves they compute the right thing. The block
// from `const replace` to `const overflow` is pure JS — no React, no DOM — so it can be sliced out of
// the page and executed against stub state, and it stays honest because it IS the shipped code.
const MAX_SOURCES = Number(/const MAX_SOURCES = (\d+);/.exec(page)?.[1]);
check('the cap is a declared constant', MAX_SOURCES > 0);
const mathStart = intake.indexOf('    const replace = mode ===');
const mathEnd = intake.indexOf('const overflow = fresh.length - take.length;') + 'const overflow = fresh.length - take.length;'.length;
const BODY = intake.slice(mathStart, mathEnd)
  // notify() is React state; the room guard returns early from a function this slice is not inside.
  .replace(/if \(room <= 0\) \{[\s\S]*?return 0; \}/, 'if (room <= 0) return { full: true };')
  .replace(/if \(dupes\) notify\([^\n]*\n/, '')
  .replace(/if \(overflow\) notify\([^\n]*\n/, '');
// eslint-disable-next-line no-new-func
const runIntake = new Function('urls', 'sources', 'mode', 'MAX_SOURCES',
  `${BODY}\n return { taken: take.length, dupes, overflow };`);

const url = (n) => `data:image/png;base64,AAA${n}`;
const have = (n) => Array.from({ length: n }, (_, i) => ({ dataUrl: url(i) }));

// The reported bug: a batch bigger than the room is truncated. It must be COUNTED, not swallowed.
const big = runIntake(Array.from({ length: 80 }, (_, i) => url(1000 + i)), [], 'add', MAX_SOURCES);
check(`80 dropped onto an empty page takes ${MAX_SOURCES} and reports the rest`,
  big.taken === MAX_SOURCES && big.overflow === 80 - MAX_SOURCES);
const partial = runIntake([url(2001), url(2002), url(2003)], have(MAX_SOURCES - 1), 'add', MAX_SOURCES);
check('with one slot left, one goes in and two are reported', partial.taken === 1 && partial.overflow === 2);
check('a full page reports full rather than adding nothing quietly',
  runIntake([url(3001)], have(MAX_SOURCES), 'add', MAX_SOURCES).full === true);
// A send that arrives twice, or the same pin ticked twice, must not queue the photo twice.
const dup = runIntake([url(1), url(2), url(1)], have(3), 'add', MAX_SOURCES);
check('duplicates of what is already there are skipped and counted', dup.taken === 0 && dup.dupes === 3);
const halfDup = runIntake([url(0), url(9001)], have(1), 'add', MAX_SOURCES);
check('a mixed batch keeps the new one', halfDup.taken === 1 && halfDup.dupes === 1);
// Replace clears the page, so the full cap is available and existing photos cannot collide.
const rep = runIntake([url(0), url(1)], have(MAX_SOURCES), 'replace', MAX_SOURCES);
check('a replace onto a full page still takes everything', rep.taken === 2 && rep.dupes === 0);
const repBig = runIntake(Array.from({ length: 80 }, (_, i) => url(4000 + i)), have(10), 'replace', MAX_SOURCES);
check('and a replace is still capped', repBig.taken === MAX_SOURCES && repBig.overflow === 80 - MAX_SOURCES);
check('a batch that is entirely duplicates of itself collapses to one',
  runIntake([url(7), url(7), url(7)], [], 'add', MAX_SOURCES).taken === 1);
check('empty in, nothing out', runIntake([], [], 'add', MAX_SOURCES).taken === 0);

// --- mass drag ---------------------------------------------------------------------------------------
// Dropping is bound to the window, not the dashed box — the box scrolls off as soon as the page has
// content, which is exactly when you have a batch to add.
check('drop is handled at the window', page.includes("window.addEventListener('drop', onDrop)"));
check('a multi-file drop is taken whole',
  page.includes('const files = Array.from(e.dataTransfer?.files || []).filter((f) => /^image\\//i.test(f.type));'));
// TWO handlers, ONE intake. The dashed box and the window both used to add, so a drop inside the box
// went in twice — hidden only because the window handler was throwing on a broken regex at the time.
check('the dashed box only paints the highlight; the window does the adding',
  page.includes('onDrop={() => setDragging(false)}'));
check('and it does not stop the event reaching the window',
  !page.includes('onDrop={(e) => { e.preventDefault(); setDragging(false); addSources(e.dataTransfer.files); }}'));

// --- a send lands on the tab you are using ------------------------------------------------------------
check('the destination is resolved, not hardcoded', handoff.includes('export function photoMatchTarget()'));
check('it reads the tab that was last open', handoff.includes("window.localStorage.getItem('kyros.lastPhotoMatchTab')"));
check('only the two real tab ids are accepted from storage',
  handoff.includes("if (last === 'photoMatchNB2' || last === 'photoMatchSeedream') return last;"));
check('an unreadable localStorage falls back to SD — the behaviour this replaces',
  handoff.includes("return 'photoMatchSeedream';"));
check('the Photo Match tab records itself as it opens',
  page.includes("rememberPhotoMatchTab(isNB2 ? 'photoMatchNB2' : 'photoMatchSeedream')"));
// The PAYLOAD key stays single. Only one Photo Match page is mounted at a time (App.jsx renders one
// PageComponent), so one key is enough — and sharing it means either tab picks up either stash.
check('the stash key is shared and named once', handoff.includes("export const PHOTO_MATCH_HANDOFF_KEY = 'photoMatchSeedream';"));
check('and the page consumes that same named key', page.includes('consumeSourceHandoff(PHOTO_MATCH_HANDOFF_KEY)'));

// Every sender. Missing one means that one still drags you to SD.
const SENDERS = [
  ['client/src/components/EddyCollection.jsx', 'navigateTo(photoMatchTarget());'],
  ['client/src/pages/LibraryPage.jsx', 'navigateTo(handoffDestination(page));'],
  ['client/src/pages/InstagramFramesPage.jsx', 'navigateTo(handoffDestination(page));'],
  ['client/src/pages/FrameLibraryPage.jsx', 'navigateTo(handoffDestination(target.page));'],
  ['client/src/pages/PinterestFeedPage.jsx', 'navigateTo(handoffDestination(target.id));'],
];
for (const [file, call] of SENDERS) {
  const s = read(file);
  check(`${path.basename(file)} sends to the resolved tab`, s.includes(call));
  check(`${path.basename(file)} imports the resolver`, /from '\.\.\/lib\/sourceHandoff'/.test(s)
    && (s.includes('photoMatchTarget') || s.includes('handoffDestination')));
}
// Non-Photo-Match destinations must be untouched: they have one page each.
check('a send to any other page is passed through unchanged',
  handoff.includes('return page === PHOTO_MATCH_HANDOFF_KEY ? photoMatchTarget() : page;'));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
