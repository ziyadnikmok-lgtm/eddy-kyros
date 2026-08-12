// The Seedance tabs pick a character from EDDY, not from the old server registry.
//
// Both pages offered a dropdown fed by the SaaS-era `characters` API — a registry the owner does
// not maintain, so the list was empty or offered someone who no longer exists (owner, 2026-08-11).
// Eddy's character collection is where the models actually live: one FOLDER per character, her
// photos inside it, which is what Photo Match has always read.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');

const vid = fs.readFileSync(path.join(ROOT, 'client/src/pages/SeedanceVideoPage.jsx'), 'utf8').replace(/\r\n/g, '\n');
const omni = fs.readFileSync(path.join(ROOT, 'client/src/pages/SeedanceOmniPage.jsx'), 'utf8').replace(/\r\n/g, '\n');
const pm = fs.readFileSync(path.join(ROOT, 'client/src/pages/PhotoMatchSeedreamPage.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the old registry is gone from both -------------------------------------------------------------
for (const [name, src] of [['Seedance Video', vid], ['Seedance Omni', omni]]) {
  check(`${name}: the server character API is no longer imported`, !src.includes('characters as charApi'));
  check(`${name}: and no URL is built from it`, !src.includes('charApi.primaryImageUrl') && !src.includes('charApi.refImageUrl'));
  check(`${name}: the character list no longer comes from AppContext`, !/useApp\(\)[\s\S]{0,80}characters/.test(src));
  check(`${name}: it reads Eddy's character collection`, src.includes("createEddyCollection('eddy-character')"));
  check(`${name}: photos are read from IndexedDB, not fetched`, src.includes('charStore.getImage(it.id)'));
}

// --- her photos arrive in the order the model needs -----------------------------------------------------
// The leading image is treated as the primary subject, so the base face has to lead. All three
// pages must rank identically or the same character behaves differently depending on the tab.
const RANK = "const rank = (i) => (i.role === 'base' ? 0 : i.role === 'body' ? 1 : 2);";
check('Photo Match ranks base first', pm.includes(RANK));
check('Seedance Video ranks the same way', vid.includes(RANK));
check('Seedance Omni ranks the same way', omni.includes(RANK));
check('and each sorts by rank, then oldest first',
  [vid, omni, pm].every((s) => s.includes('rank(a) - rank(b) || (a.createdAt || 0) - (b.createdAt || 0)')));

// --- caps -------------------------------------------------------------------------------------------------
check('Seedance Video caps how many photos ride along', vid.includes('const CHAR_REF_MAX = 10;'));
check('and says why — every one is uploaded to Muapi before the job starts',
  /uploaded to Muapi individually before the job is even submitted/.test(vid));
check('and says so when it trims', vid.includes('is the cap)'));
check('Omni still respects its own reference-image ceiling', omni.includes('const room = OMNI_MAX_IMAGES - images.length;'));
check('Omni still APPENDS rather than replacing — it stacks with hand-added images',
  omni.includes('setImages((prev) => [...prev, ...added]);'));
check('Video REPLACES — picking her is "use her", not "add her"', vid.includes('setExtras(loaded.slice(1).map('));

// --- picking is visible, and reversible ----------------------------------------------------------------------
check('Video shows her face, not just a name in a dropdown', vid.includes('charThumbs[lead.id]'));
check('and how many references she brings', vid.includes("ref{mine.length === 1 ? '' : 's'}"));
check('clicking the picked one unpicks her', vid.includes("if (!id || id === characterId) { setCharacterId(''); return; }"));
check('Omni names the count in its option, next to the slot counter', omni.includes("{c.name || 'Unnamed'} ({n})"));
check('an empty collection points at the tab that fills it',
  vid.includes('Eddy · Character') && omni.includes('Eddy · Character'));

// --- replay the ordering ---------------------------------------------------------------------------------------
const rank = (i) => (i.role === 'base' ? 0 : i.role === 'body' ? 1 : 2);
const order = (items) => [...items]
  .sort((a, b) => rank(a) - rank(b) || (a.createdAt || 0) - (b.createdAt || 0))
  .map((i) => i.id);
const folder = [
  { id: 'c', role: 'ref', createdAt: 3 },
  { id: 'a', role: 'base', createdAt: 9 },
  { id: 'b', role: 'body', createdAt: 1 },
  { id: 'd', role: 'ref', createdAt: 1 },
];
check('the base face leads even when it is the newest', order(folder)[0] === 'a');
check('body comes second', order(folder)[1] === 'b');
// d was created at 1, c at 3 — so d leads the tail.
check('the rest follow oldest first', order(folder).slice(2).join('') === 'dc');
check('a folder with no base still returns everything',
  order([{ id: 'x', role: 'ref', createdAt: 1 }, { id: 'y', role: 'ref', createdAt: 2 }]).join('') === 'xy');
check('an empty folder is empty, not a crash', order([]).length === 0);

// The cap must trim the TAIL, never the base face.
const capped = order(folder).slice(0, 2);
check('trimming to the cap keeps the face', capped[0] === 'a');

// --- the layout it was first shipped with was wrong (owner screenshot, 2026-08-11) ------------------
// The picker was a third column inside the row that holds the source thumbnails, so it ran off the
// card as soon as a couple of extras were loaded: "Pick from Gallery" was cut in half and the
// character tiles disappeared past the edge.
check('the picker is its own row, not a column beside the thumbnails',
  /Its OWN full-width row, not a third column beside the thumbnails/.test(vid));
check('the tiles wrap instead of hiding in a sideways scroll',
  vid.includes('<div className="flex flex-wrap gap-2">') && !vid.includes('flex gap-2 overflow-x-auto pb-1'));
check('the actions column can shrink — a flex child will not, by default',
  vid.includes('<div className="flex min-w-0 flex-1 flex-col gap-2">'));
check('and its buttons wrap rather than overflow', vid.includes('<div className="flex flex-wrap items-center gap-2">'));
check('the reason is recorded at the fix', /was pushed past the card edge/.test(vid));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
