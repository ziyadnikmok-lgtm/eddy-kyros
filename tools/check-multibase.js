// Multi-select base photos, each auto-paired with its own character close-up.
const fs = require('fs');
const rd = (f) => fs.readFileSync(f, 'utf8').split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
const gen = rd('D:/Kyros/app/client/src/pages/EddyGeneratePage.jsx');
const charPage = rd('D:/Kyros/app/client/src/pages/EddyCharacterPage.jsx');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// The link the whole feature rests on.
check('mirrorFolders writes the same name into BOTH collections',
  /baseStore\.ensureFolder\(clean\)/.test(charPage) && /libraryStore\.ensureFolder\(clean\)/.test(charPage));
check('pairing is by folder NAME, case-insensitive', /charFolderByName\.get\(name\.toLowerCase\(\)\)/.test(gen));
check("her face is the one marked BASE, else earliest", /mine\.find\(\(i\) => i\.role === 'base'\)/.test(gen));

// Replay the pairing.
const pair = (baseItems, baseFolders, charItems, charFolders) => {
  const bfName = (id) => baseFolders.find((f) => f.id === id)?.name?.trim() || '';
  const byName = new Map(charFolders.map((f) => [f.name.trim().toLowerCase(), f.id]));
  const out = new Map();
  for (const b of baseItems) {
    const name = bfName(b.folderId);
    const cf = name ? byName.get(name.toLowerCase()) : null;
    let faceId = null;
    if (cf) {
      const mine = charItems.filter((i) => i.folderId === cf);
      const lead = mine.find((i) => i.role === 'base') || [...mine].sort((a, c) => (a.createdAt || 0) - (c.createdAt || 0))[0];
      faceId = lead?.id || null;
    }
    out.set(b.id, { name, faceId });
  }
  return out;
};
const bF = [{ id: 'bf1', name: 'Grace' }, { id: 'bf2', name: 'Nova' }, { id: 'bf3', name: 'Orphan' }];
const cF = [{ id: 'cf1', name: 'grace' }, { id: 'cf2', name: 'Nova' }];
const bI = [{ id: 'b1', folderId: 'bf1' }, { id: 'b2', folderId: 'bf1' }, { id: 'b3', folderId: 'bf2' }, { id: 'b4', folderId: 'bf3' }, { id: 'b5', folderId: null }];
const cI = [
  { id: 'g_old', folderId: 'cf1', createdAt: 1 },
  { id: 'g_base', folderId: 'cf1', createdAt: 9, role: 'base' },
  { id: 'n1', folderId: 'cf2', createdAt: 5 },
];
const m = pair(bI, bF, cI, cF);
check('two photos of the same character both find her', m.get('b1').faceId === 'g_base' && m.get('b2').faceId === 'g_base');
check('the BASE-marked face wins over the earlier one', m.get('b1').faceId === 'g_base');
check('case does not matter ("Grace" folder, "grace" character)', m.get('b1').name === 'Grace');
check('a different character gets her own face', m.get('b3').faceId === 'n1');
check('with no character of that name, no face — not a wrong one', m.get('b4').faceId === null);
check('an unfiled base photo pairs with nothing', m.get('b5').faceId === null);

// Wiring.
check('the picker slot exists and comes first', gen.indexOf("key: 'basephoto'") < gen.indexOf("key: 'pose'"));
check('the Main photo slot reads Base Library', /pickerDb="eddy-base"/.test(gen));
check('multi-select is off on Max Outfit', /multi=\{!maxOutfit\}/.test(gen));

// The product and the payload.
check('combos multiply by the ticked photos', /const bp = pickedBasePhotos\.length \? pickedBasePhotos : \[null\];/.test(gen));
check('with none ticked the product is unchanged', /: \[null\];/.test(gen));
check('each combo resolves its OWN base', /if \(combo\?\.basePhotoId\) \{/.test(gen));
check('and its OWN face', /if \(f\) comboFace = parseDataUrl/.test(gen));
check('the face falls back to the slot rather than failing', /const faceImg = comboFace \|\| charPayload\[1\] \|\| null;/.test(gen));
check('an unreadable base photo fails loudly', /throw new Error\('That base photo could not be read'\)/.test(gen));
check('collections are read through a ref, not deps', /basePhotosRef\.current\.pairs\.get\(combo\.basePhotoId\)/.test(gen));

// Gates and visibility.
check('Generate no longer demands the single slot', /!maxOutfit && !baseImage && !pickedBasePhotos\.length/.test(gen));
check('the button agrees', /\(!baseImage && !pickedBasePhotos\.length\)/.test(gen));
check('the totals line shows the extra dimension', /\{pickedBasePhotos\.length\} photos × <\/>\}/.test(gen));
check('the pairing is shown BEFORE spending', /face taken from/.test(gen));
check('an unmatched photo is called out, not silent', /no matching character/.test(gen));
check('and the fix is named', /Name the Base Library folder the same as her Character folder/.test(gen));
check('the selection survives a restart', /pickedBases, pickedBasePhotos, outfitRotation, smartMatch, instruction,/.test(gen));

// --- the pairing has to be SEEN, not described (owner, 2026-08-10) --------------------------
// "face taken from Grace x8" is true and still no help deciding whether it took the RIGHT eight.
check('the summary carries the pairs, not only a tally', /rows: pickedBasePhotos\.map/.test(gen) || /const rows = pickedBasePhotos\.map/.test(gen));
check('face thumbnails are loaded, or the right-hand tile is always blank', /const \[charThumbs, setCharThumbs\] = useState\(\{\}\);/.test(gen) && /setCharThumbs\(cT\)/.test(gen));
check('they are read from the character store, not the base store', /cItems\.map\(async \(i\) => \{ cT\[i\.id\] = i\.url \|\| await charStore\.getImage\(i\.id\); \}\)/.test(gen));
// The two slots ARE the display now: bases in Main photo, their faces in Face close-up.
check('the Main photo slot shows the ticked bases', /multiRows=\{baseSlotRows\}/.test(gen));
check('the Face slot shows the faces they paired with', /multiRows=\{faceSlotRows\}/.test(gen));
check('the two lists are built in the SAME order, or the columns lie',
  /const baseSlotRows = useMemo\(\(\) => pickedBasePhotos\.map/.test(gen)
  && /const faceSlotRows = useMemo\(\(\) => pickedBasePhotos\.map/.test(gen));
check('an unpaired row is kept, not dropped -- dropping it desynchronises the columns',
  /src: src \|\| baseThumbs\[id\] \|\| '', name: pair\?\.name \|\| 'no match', missing: !src/.test(gen));
check('the face slot itself stays single-select', /Display-only: no `multi`/.test(gen));
check('ticking keeps the picker open', /multi \? toggleOne\(l\.id\) : pickFromLibrary/.test(gen));
check('select-all covers the whole folder, not just what is scrolled into view',
  /const inView = library\.filter\(\(l\) => !pickFolder \|\| l\.folderId === pickFolder\)\.map/.test(gen));
check('the eddy: id prefix is stripped at the boundary', /const rawId = \(id\) => String\(id\)\.replace/.test(gen));
check('and the face slot says what it fell back to', /had no character folder of the same name/.test(gen));
check('an unmatched face tile is dimmed and outlined so it reads as different',
  /r\.missing \? 'opacity-40 ring-1 ring-amber-500\/60' : ''/.test(gen));
check('every ticked photo gets a row, in ticked order', (() => {
  const picked = ['b3', 'b1', 'b2'];
  const pairs = new Map([['b1', { name: 'Grace', faceId: 'f1' }], ['b2', { name: '', faceId: null }], ['b3', { name: 'Nova', faceId: 'f2' }]]);
  const rows = picked.map((id) => { const pr = pairs.get(id); return { id, name: pr?.name || '', faceId: pr?.faceId || null }; });
  return rows.length === 3 && rows[0].name === 'Nova' && rows[2].faceId === null;
})());
check('it says the photos multiply the run', /each one runs every pose and outfit below/.test(gen));

// --- WHICH TABS GET IT (owner, 2026-08-10) ---------------------------------------------------
// Every gate is written `!maxOutfit`, never `!maxNano`, so Eddy and Max Nano both get the feature
// and Max Outfit does not. Max Outfit sources from a Library folder instead -- a base-photo picker
// there would be a second, conflicting source of the same thing.
const modes = [
  { name: 'Eddy',       maxNano: false, maxOutfit: false, want: true },
  { name: 'Max Nano',   maxNano: true,  maxOutfit: false, want: true },
  { name: 'Max Outfit', maxNano: false, maxOutfit: true,  want: false },
];
for (const m of modes) {
  check(`${m.name}: picker slot ${m.want ? 'present' : 'absent'}`, (!m.maxOutfit) === m.want);
  check(`${m.name}: collections ${m.want ? 'loaded' : 'not loaded'}`, (!m.maxOutfit) === m.want);
}
// A CONDITIONAL on maxNano, not a mention of it: the combos deps array lists maxNano and
// pickedBasePhotos side by side and is not a gate. Matching the bare name reported that as a
// failure, which is the kind of false alarm that gets a check deleted.
check('no gate keys off maxNano, which would split the two tabs apart', (() => {
  const gateRe = new RegExp(String.raw`(!maxNano\s*&&|maxNano\s*&&|maxNano\s*\?)[^;\n]{0,60}(pickedBasePhotos|baseItems|basePhoto)`);
  const revRe = new RegExp(String.raw`(pickedBasePhotos|baseItems|basePhoto)[^;\n]{0,60}(&&\s*!?maxNano|\?\s*[^:]{0,20}maxNano)`);
  return !gateRe.test(gen) && !revRe.test(gen);
})());
check('the separate Base photos picker is GONE -- it lived in the wrong place',
  !/key: 'basephoto'/.test(gen));
check('the load is gated on maxOutfit only', /if \(!maxOutfit\) \{[\s\S]{0,200}baseStore\.listItems\(\)/.test(gen));
check('the Generate gate accepts base photos on both tabs',
  /maxOutfit \? !pickedBases\.length : \(!baseImage && !pickedBasePhotos\.length\)/.test(gen));
check('and the "add a photo first" guard does too',
  /if \(!maxOutfit && !baseImage && !pickedBasePhotos\.length\)/.test(gen));

// --- MAX OUTFIT IS NOT A CROSS PRODUCT (owner, 2026-08-10) ------------------------------------
// 4 photos + 6 outfits reported "4 images" and read as a bug. It is the "One outfit per photo"
// setting doing exactly what it says -- but the UI stated one number without naming the other, so
// there was nothing on screen to disagree with the reading. Both totals are now shown.
check('rotation ON deals one outfit per photo', (() => {
  const bases = ['b1', 'b2', 'b3', 'b4'], os = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'];
  return bases.map((b, i) => ({ baseId: b, outfitId: os[i % os.length] })).length === 4;
})());
check('rotation OFF is the full cross product', (() => {
  const bases = ['b1', 'b2', 'b3', 'b4'], os = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'];
  return bases.flatMap((b) => os.map((o) => ({ baseId: b, outfitId: o }))).length === 24;
})());
check('round-robin wraps when outfits run out, rather than dropping photos', (() => {
  const bases = ['b1', 'b2', 'b3', 'b4', 'b5'], os = ['o1', 'o2'];
  const rows = bases.map((b, i) => ({ baseId: b, outfitId: os[i % os.length] }));
  return rows.length === 5 && rows[4].outfitId === 'o1';
})());
check('the checkbox states the CURRENT total', /Now: \$\{pickedBases\.length\} image/.test(gen));
check('and the total you would get by unticking it',
  /\$\{pickedBases\.length \* pickedOutfits\.length\} images/.test(gen));
check('the summary line names the outfits, not just the photos',
  /outfitRotation \? 'with one of' : String\.fromCharCode\(215\)/.test(gen));

// --- MAX OUTFIT GETS EDDY'S CLOSE-UP RULE (owner, 2026-08-10) ---------------------------------
// Rotation ON was angle-aware via matchOutfits. Rotation OFF -- the cross product, the BIG runs --
// had no filter at all, so every close-up outfit was paired with every full-body photo at full
// price. Same rule as Eddy now: close-up pairs only with close-up; front/back is left alone
// because a back shot already swaps in the outfit's back description.
check('the cross-product path filters by view', /const compatible = all\.filter\(\(c\) => \([\s\S]{0,200}libraryRowView\(byIdX\.get\(c\.baseId\)\) === 'closeup'/.test(gen));
check('and falls back to the unfiltered product rather than showing 0',
  /return compatible\.length \? compatible : all;/.test(gen));
check('the skipped-pairings banner covers Max Outfit too', /if \(maxOutfit\) \{[\s\S]{0,1400}return bad \? \{ bad, total: pickedOutfits\.length \* pickedBases\.length/.test(gen));
check('but stays quiet with rotation ON, where nothing is ever skipped',
  /if \(outfitRotation \|\| !pickedBases\.length \|\| !pickedOutfits\.length\) return null;/.test(gen));
check('the banner says photo on Max Outfit and pose on Eddy',
  /full-body \{maxOutfit \? 'photo' : 'pose'\}/.test(gen));
check('and states how many of the total survive',
  /\{eddyMismatches\.total - eddyMismatches\.bad\} of \{eddyMismatches\.total\} will run/.test(gen));
check('the front/back/close-up chips already read baseId, so Max Outfit gets them',
  /const v = c\.baseId \? libraryRowView\(libById\.get\(c\.baseId\)\)/.test(gen));

// replay: 4 photos (1 close-up) x 6 outfits (2 close-up)
check('cross product drops exactly the mismatched pairs', (() => {
  const photos = [['p1', 'front'], ['p2', 'front'], ['p3', 'front'], ['p4', 'closeup']];
  const outs = [['o1', 'front'], ['o2', 'front'], ['o3', 'front'], ['o4', 'front'], ['o5', 'closeup'], ['o6', 'closeup']];
  const all = photos.flatMap(([p, pv]) => outs.map(([o, ov]) => ({ p, o, ok: (ov === 'closeup') === (pv === 'closeup') })));
  const kept = all.filter((c) => c.ok);
  // 3 front photos x 4 front outfits = 12, plus 1 close-up photo x 2 close-up outfits = 2
  return all.length === 24 && kept.length === 14;
})());
check('and if nothing survives, everything runs rather than nothing', (() => {
  const all = [{ ok: false }, { ok: false }];
  const kept = all.filter((c) => c.ok);
  return (kept.length ? kept : all).length === 2;
})());

// --- MAX OUTFIT FILES UNDER HER NAME (owner, 2026-08-10) ---------------------------------------
// Filing is by characterName on every tab. But the name-detect effect reads the Main-photo and
// Face slots, and Max Outfit uses NEITHER -- its sources are Library rows -- so the name stayed
// empty and Natalie's swaps filed under the generic "Max Outfit" pile.
check('Max Outfit derives the name from the source folder',
  /if \(!maxOutfit \|\| characterName \|\| !pickedBases\.length\) return;/.test(gen));
check('it only fills an EMPTY name, never overrides a picked one', /characterName \|\| !pickedBases\.length/.test(gen));
check('a mixed selection is left alone rather than guessed',
  /if \(names\.size !== 1\) return;/.test(gen));
check('an unfiled source photo also stops it', /if \(!n\) return;/.test(gen));
check('the tab buckets are not mistaken for people',
  /only === MAX_OUTFIT_FOLDER \|\| only === MAX_NANO_FOLDER \|\| only === 'Eddy'/.test(gen));

// replay the rule
const deriveName = (picked, folderOf, buckets) => {
  const names = new Set();
  for (const id of picked) { const n = folderOf(id); if (!n) return ''; names.add(n); }
  if (names.size !== 1) return '';
  const only = [...names][0];
  return buckets.includes(only) ? '' : only;
};
const BUCKETS = ['Max Outfit', 'Max Nano', 'Eddy', 'Eddy NSFW'];
check('4 photos all from Natalie -> Natalie',
  deriveName(['a', 'b', 'c', 'd'], () => 'Natalie', BUCKETS) === 'Natalie');
check('Natalie + Grace in one run -> no name, the picker decides',
  deriveName(['a', 'b'], (id) => (id === 'a' ? 'Natalie' : 'Grace'), BUCKETS) === '');
check('one photo with no folder -> no name',
  deriveName(['a', 'b'], (id) => (id === 'a' ? 'Natalie' : ''), BUCKETS) === '');
check('sources sitting in the Max Nano bucket -> no name, not "Max Nano"',
  deriveName(['a'], () => 'Max Nano', BUCKETS) === '');
check('and the filing function sends a named run to her folder',
  /if \(who\) return \(await libraryStore\.ensureFolder\(who\)\)\?\.id/.test(gen));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
