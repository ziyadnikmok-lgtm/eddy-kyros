// Every page in the nav must be reachable from a real workspace.
//
// WHAT HAPPENED (owner, 2026-08-14: "in video library it doesnt show the one i generate with
// seedance video"). Gemini was removed on 2026-08-09 and all three workspaces became
// engines:['seedream']. The nav section tagged engine:'gemini' then rendered in NO workspace — and
// everything left inside it went dark. Nobody noticed, because the section is still there in the
// source and reads as live.
//
// The item that mattered was Video Gallery: the ONLY page that lists generated videos. 100 videos,
// 292 MB, all downloaded to disk, with no route to them from anywhere in the app. The report
// arrived as "the video library doesn't show my videos" — which was true but not the bug, because
// Video Library is the eddy-video INPUT collection and never held renders.
//
// This suite makes an orphaned page fail loudly instead of quietly.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const app = read('client/src/App.jsx');
const ws = read('client/src/lib/workspace.js');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- what engines actually exist across the workspaces --------------------------------------------
const liveEngines = new Set();
for (const m of ws.matchAll(/engines:\s*\[([^\]]*)\]/g)) {
  for (const e of m[1].split(',')) {
    const v = e.trim().replace(/['"]/g, '');
    if (v) liveEngines.add(v);
  }
}
check(`at least one workspace exists (${[...liveEngines].join(', ')})`, liveEngines.size > 0);

// --- the nav sections, and which engine gates each ---------------------------------------------------
// Parsed from the SECTIONS literal rather than imported: App.jsx is a React module and this suite
// has no renderer.
const secStart = app.indexOf('const NAV_SECTIONS');
const secEnd = app.indexOf('\n];', secStart);
check('the NAV_SECTIONS list was found', secStart > -1 && secEnd > secStart);
const sections = app.slice(secStart, secEnd);

// Split on each "{ engine?: ..., label: ..., items: [...] }" block.
const blocks = [...sections.matchAll(/\{\s*(?:\/\/[^\n]*\n\s*)*(?:engine:\s*'([^']+)',\s*)?(?:\/\/[^\n]*\n\s*)*label:\s*'([^']+)',\s*items:\s*\[([\s\S]*?)\n\s*\],\s*\}/g)];
check(`the sections parsed (${blocks.length} found)`, blocks.length >= 4);

const dead = [];
const reachable = new Set();
for (const [, engine, label, items] of blocks) {
  const ids = [...items.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
  const live = !engine || liveEngines.has(engine);
  if (live) ids.forEach((id) => reachable.add(id));
  else dead.push({ label, engine, ids });
}

// --- THE ONE THAT MATTERS -----------------------------------------------------------------------------
check('Video Gallery is reachable — it is the only page listing generated videos',
  reachable.has('videoGallery'));
check('and it sits in the Video section, beside the pages that make videos',
  /label: 'Video',\s*items:\s*\[[\s\S]{0,1400}id: 'videoGallery'/.test(sections));
check('above Video Library, so the output is found before the input library',
  sections.indexOf("id: 'videoGallery'") < sections.indexOf("id: 'videoLibrary'"));
check('and it is not ALSO left in a dead section — one id, one entry',
  (sections.match(/id: 'videoGallery'/g) || []).length === 1);

// The pages the owner actually works in, each one reachable.
for (const id of ['eddy', 'eddyMaxNano', 'eddyMaxOutfit', 'photoMatchSeedream', 'seedanceVideo',
  'seedanceOmni', 'videoLibrary', 'videoGallery', 'sceneRecreateSeedream', 'poseRemixSeedream',
  'seedreamEdit', 'outfitSwapSeedream', 'pinterestFeed', 'pinterestLibrary']) {
  check(`reachable: ${id}`, reachable.has(id));
}

// --- the dead section is reported, not silently tolerated ------------------------------------------------
// Not a failure on its own: a section may be parked deliberately. But anything in it is invisible,
// so it gets printed — that is the whole point, since the last time this happened nobody saw it.
if (dead.length) {
  console.log('');
  for (const d of dead) {
    const orphans = d.ids.filter((id) => !reachable.has(id));
    console.log(`  NOTE  section '${d.label}' is gated on engine '${d.engine}', which no workspace offers.`);
    console.log(`        ${orphans.length} page(s) unreachable: ${orphans.join(', ') || '(none — all also live elsewhere)'}`);
  }
  console.log('');
}

// --- every nav id resolves to a component ------------------------------------------------------------------
// A nav entry pointing at nothing is the other way to make a page unreachable.
const pageMapStart = app.indexOf('const PAGES');
const pageMap = pageMapStart > -1 ? app.slice(pageMapStart, app.indexOf('\n};', pageMapStart)) : '';
const missing = [...reachable].filter((id) => !new RegExp(`\\b${id}:`).test(pageMap));
check(`every reachable nav id maps to a component${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`,
  missing.length === 0);

// --- Pinterest Library sits under the tab that fills it ------------------------------------------
// Saved pins are the OUTPUT of the Pinterest tab. Anywhere else is a detour, and the last time a
// library ended up far from its source (Video Library vs Video Gallery) it cost a bug report.
check('Pinterest Library is directly below Pinterest',
  sections.indexOf("id: 'pinterestFeed'") < sections.indexOf("id: 'pinterestLibrary'")
  && sections.indexOf("id: 'pinterestLibrary'") - sections.indexOf("id: 'pinterestFeed'") < 400);

// --- EVERY nav id must be navigable ------------------------------------------------------------
// navigateTo() checks the id against VALID_PAGE_IDS and falls back to `generate` when it is not
// there — silently, apart from a console warning nobody is watching. AppContext says so in its own
// comment: "An id missing from it lands on Generate with no error, which looks exactly like a
// broken page." That is exactly what happened to Pinterest Library: the button was there, it was
// clickable, and clicking it bounced you to Generate (owner, 2026-08-15: "cannot click the
// pinterest library").
//
// The earlier checks compared NAV_SECTIONS against the PAGES map and missed it, because the entry
// existed in both. THIS is the list that decides whether a click goes anywhere.
const ctx = read('client/src/context/AppContext.jsx');
const validIds = new Set(
  ((ctx.match(/VALID_PAGE_IDS = new Set\(\[([\s\S]*?)\]\)/) || [])[1] || '')
    .split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean),
);
check(`VALID_PAGE_IDS was parsed (${validIds.size} ids)`, validIds.size > 10);
const unnavigable = [...reachable].filter((id) => !validIds.has(id));
check(`every nav item can actually be navigated to${unnavigable.length ? ` — DEAD: ${unnavigable.join(', ')}` : ''}`,
  unnavigable.length === 0);
check('Pinterest Library specifically', validIds.has('pinterestLibrary'));

// An item with no icon renders as bare text and reads as a section heading rather than a button —
// which is how this one looked in the sidebar even before the click failed.
const iconsStart = app.indexOf('const NAV_ICONS = {');
const NL = String.fromCharCode(10);
const icons = iconsStart > -1 ? app.slice(iconsStart, app.indexOf(NL + '};', iconsStart)) : '';
const noIcon = [...reachable].filter((id) => !icons.includes(' ' + id + ':'));
check(`every nav item has an icon${noIcon.length ? ` — missing: ${noIcon.join(', ')}` : ''}`, noIcon.length === 0);

// --- Pinterest Library: no feed, and a working send ------------------------------------------------
const eddyTabs = read('client/src/pages/EddyTabs.jsx');
const coll = read('client/src/components/EddyCollection.jsx');

// It holds saved pins; it generates nothing. The feed beside it is unrelated results eating a
// third of the window from the grid you came to look at.
check('the generation feed is hidden on Pinterest Library',
  /FEED_HIDDEN_PAGES = new Set\(\[[\s\S]*?'pinterestLibrary'/.test(app));

// The send reuses the sequence that already works on the Pinterest tab. Order is the whole thing:
// stash -> navigate -> event. Dispatching first arrives before the lazy chunk mounts and is
// dropped silently, which is how the original version of this lost everything.
check('Pinterest Library opts into the send', eddyTabs.includes('sendToPhotoMatch'));
check('it is opt-in, not on for every collection', coll.includes('sendToPhotoMatch = false,'));
const stash = coll.indexOf("stashSourceHandoff('photoMatchSeedream'");
const nav = coll.indexOf("navigateTo('photoMatchSeedream')");
const evt = coll.indexOf("'kyros:use-as-photo-match-seedream-source'");
check('it stashes BEFORE navigating', stash > -1 && nav > stash);
check('and fires the event LAST, after the destination can be mounted', evt > nav);
check('the payload key is `items`, which is what the listeners read', /detail: \{ items: payload \}/.test(coll));
check('it COPIES rather than moves — a source pin is still worth keeping', !/removeItem[\s\S]{0,200}photoMatchSeedream/.test(coll));
check('nothing readable means nothing sent, said out loud',
  coll.includes("notify('None of those could be read — nothing was sent', 'error')"));
check('a partial send reports what was missed', coll.includes('could not be read`'));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
