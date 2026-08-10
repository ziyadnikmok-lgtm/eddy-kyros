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
check('it reads Base Library', /items: baseItems, thumbs: baseThumbs, folders: baseFolders, store: baseStore/.test(gen));
check('Select-all writes to the right list', /slot\.key === 'basephoto' \? setPickedBasePhotos/.test(gen));
check('it is hidden on Max Outfit', /\.\.\.\(maxOutfit \? \[\] : \[\{ key: 'basephoto'/.test(gen));
check('favSets has a basephoto key', /basephoto: new Set\(\)/.test(gen));

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
check('base renders on the left', /src=\{baseThumbs\[row\.id\] \|\| ''\}/.test(gen));
check('her face renders on the right', /src=\{charThumbs\[row\.faceId\]\}/.test(gen));
check('an unpaired photo shows a placeholder rather than a broken image', /face slot above/.test(gen));
check('and is outlined in amber so it reads as different', /border-amber-500\/40 bg-amber-500\/\[0\.06\]/.test(gen));
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
  const gateRe = /(!maxNano\s*&&|maxNano\s*&&|maxNano\s*\?)[^;
]{0,60}(pickedBasePhotos|baseItems|basePhoto)/g;
  const revRe = /(pickedBasePhotos|baseItems|basePhoto)[^;
]{0,60}(&&\s*!?maxNano|\?\s*[^:]{0,20}maxNano)/g;
  return !gateRe.test(gen) && !revRe.test(gen);
})());
check('the picker slot itself is gated on maxOutfit only',
  /\.\.\.\(maxOutfit \? \[\] : \[\{ key: 'basephoto'/.test(gen));
check('the load is gated on maxOutfit only', /if \(!maxOutfit\) \{[\s\S]{0,200}baseStore\.listItems\(\)/.test(gen));
check('the Generate gate accepts base photos on both tabs',
  /maxOutfit \? !pickedBases\.length : \(!baseImage && !pickedBasePhotos\.length\)/.test(gen));
check('and the "add a photo first" guard does too',
  /if \(!maxOutfit && !baseImage && !pickedBasePhotos\.length\)/.test(gen));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
