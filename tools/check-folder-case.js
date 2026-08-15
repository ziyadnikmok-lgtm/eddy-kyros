// ONE FOLDER PER CHARACTER — including when the name arrives in a different case.
//
// A live Eddy run files under the character's name as typed ("Chloe"). Recovery from the gallery
// reads her name back off the generation's TAGS, and galleryManager.save() lowercases every tag.
// _ensureFolder compared names with === , so recovery asked for "chloe", missed "Chloe", and made
// a second folder next to it. Eight characters accumulated a shadow folder that way; 201 images
// were sitting in them on 2026-08-15, filed and paid for and invisible where anyone would look.
//
// This EXECUTES the real _ensureFolder against a fake store. Grepping for `.toLowerCase()` would
// pass on code that lowercased the wrong side of the comparison.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'client/src/lib/eddyCollectionStore.js');
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

let p = 0, f = 0;
const ck = (n, ok) => { if (ok) { p += 1; console.log('  OK   ' + n); } else { f += 1; console.log('  FAIL ' + n); } };

const m = /_ensureFolder: async function\(name, parentId = null\) \{\n([\s\S]*?)\n    \},/.exec(src);
if (!m) throw new Error('_ensureFolder(name, parentId) not found in eddyCollectionStore.js');
const body = m[1];

// Build the function with its closure dependencies injected.
function makeEnsureFolder(folders) {
  const impl = { listFolders: async () => folders.slice() };
  let seq = 0;
  const newId = () => `gen${seq += 1}`;
  const write = async (key, value) => { if (key === 'folders') { folders.length = 0; folders.push(...value); } };
  const fn = new Function('impl', 'write', 'newId', `return async function(name, parentId = null) {\n${body}\n};`);
  return fn(impl, write, newId);
}

(async () => {
  {
    const folders = [{ id: 'f1', name: 'Chloe', parentId: null, createdAt: 1 }];
    const ensure = makeEnsureFolder(folders);
    const hit = await ensure('chloe');
    ck('a lowercase name finds the existing capitalised folder', hit.id === 'f1');
    ck('and does NOT create a second folder', folders.length === 1);
    ck('the original capitalisation is kept', folders[0].name === 'Chloe');
  }

  {
    const folders = [{ id: 'f1', name: 'Chloe', parentId: null, createdAt: 1 }];
    const ensure = makeEnsureFolder(folders);
    ck('UPPERCASE also matches', (await ensure('CHLOE')).id === 'f1');
    ck('mixed case also matches', (await ensure('ChLoE')).id === 'f1');
    ck('surrounding whitespace still matches', (await ensure('  chloe  ')).id === 'f1');
    ck('still only one folder after all of those', folders.length === 1);
  }

  {
    // The exact shape recovery produces: gallery tags are lowercased before they are stored.
    const tag = 'Chloe'.trim().toLowerCase();
    const folders = [{ id: 'f1', name: 'Chloe', parentId: null, createdAt: 1 }];
    const ensure = makeEnsureFolder(folders);
    ck('a lowercased gallery TAG files into the character folder', (await ensure(tag)).id === 'f1');
  }

  {
    const folders = [];
    const ensure = makeEnsureFolder(folders);
    const a = await ensure('Chloe');
    ck('a genuinely new name still creates a folder', folders.length === 1 && !!a.id);
    const b = await ensure('Mia');
    ck('a different character gets its OWN folder', folders.length === 2 && b.id !== a.id);
  }

  {
    // Case-insensitivity must not merge folders that differ by PARENT.
    const folders = [
      { id: 'f1', name: 'Chloe', parentId: null, createdAt: 1 },
      { id: 'f2', name: 'Chloe', parentId: 'p9', createdAt: 2 },
    ];
    const ensure = makeEnsureFolder(folders);
    ck('the same name under a different parent stays separate', (await ensure('chloe', 'p9')).id === 'f2');
    ck('and at the root still resolves to the root one', (await ensure('CHLOE')).id === 'f1');
    ck('no new folders were made', folders.length === 2);
  }

  console.log(f ? `\nFAIL — ${f}` : `\nPASS — ${p}/${p}`);
  process.exit(f ? 1 : 0);
})();
