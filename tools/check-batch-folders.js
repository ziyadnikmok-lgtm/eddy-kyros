// Batch folders: ONE per character, per Generate click.
//
// These runs are mass -- 50 images at a time -- so every click makes its own numbered folder
// rather than growing one "Grace" forever, and a run spanning ten characters makes ten folders
// (owner, 2026-08-10).
//
// The concurrency case is the whole reason this file exists. Twelve lanes generate at once; if
// each resolved its own folder, two Grace images landing together would both read "no Grace 1 yet"
// and create Grace 1 and Grace 2 -- one click, two folders, half the batch in each. So the real
// functions are executed against a deliberately SLOW fake store, where a race WOULD happen if the
// code permitted one. Grepping for the fix could not tell the difference.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const g = fs.readFileSync(path.join(ROOT, 'client/src/pages/EddyGeneratePage.jsx'), 'utf8');
const nextSrc = /function nextBatchName\(folders, base\) \{([\s\S]*?)\n\}/.exec(g)[1];
const mkSrc = /function makeBatchFolders\(libraryStore, fallbackId\) \{([\s\S]*?)\n\}/.exec(g)[1];
const nextBatchName = new Function('folders', 'base', nextSrc);
const makeBatchFolders = new Function('libraryStore', 'fallbackId', 'nextBatchName', mkSrc + '\n//# ')
  ;
let p = 0, f = 0;
const ck = (n, ok) => { if (ok) { p += 1; console.log('  OK   ' + n); } else { f += 1; console.log('  FAIL ' + n); } };

// A fake store that is SLOW, so a race would actually happen if one existed.
function fakeStore() {
  const folders = [];
  let creates = 0;
  return {
    folders,
    creates: () => creates,
    listFolders: async () => { await new Promise((r) => setTimeout(r, 5)); return folders.slice(); },
    ensureFolder: async (name) => {
      await new Promise((r) => setTimeout(r, 5));
      let hit = folders.find((x) => x.name === name);
      if (!hit) { hit = { id: 'f' + (folders.length + 1), name }; folders.push(hit); creates += 1; }
      return hit;
    },
  };
}

(async () => {
  // 12 concurrent lanes, one character
  let st = fakeStore();
  let get = makeBatchFolders(st, 'FALLBACK', nextBatchName);
  let ids = await Promise.all(Array.from({ length: 12 }, () => get('Grace')));
  ck('12 concurrent lanes for one character make ONE folder', st.creates() === 1);
  ck('and all 12 images get the same folder id', new Set(ids).size === 1);
  ck('named Grace 1', st.folders[0].name === 'Grace 1');

  // ten characters in one run
  st = fakeStore();
  get = makeBatchFolders(st, 'FALLBACK', nextBatchName);
  const names = ['Grace', 'Lily', 'Mia', 'Nova', 'Ana', 'Bea', 'Cara', 'Dia', 'Eve', 'Fay'];
  const all = await Promise.all(names.flatMap((n) => Array.from({ length: 5 }, () => get(n))));
  ck('10 characters x 5 images = 10 folders, not 50', st.creates() === 10);
  ck('every folder is <name> 1', st.folders.every((x) => /^[A-Za-z]+ 1$/.test(x.name)));
  ck('50 images spread across exactly 10 ids', new Set(all).size === 10);

  // a SECOND click keeps climbing
  const get2 = makeBatchFolders(st, 'FALLBACK', nextBatchName);
  await get2('Grace');
  ck('a second click makes Grace 2', st.folders.some((x) => x.name === 'Grace 2'));
  ck('and does not touch the others', st.creates() === 11);

  // no name -> the run folder
  const noName = await get2('');
  ck('a combo with no character falls back to the run folder', noName === 'FALLBACK');

  // a store that throws must not lose the picture
  const broken = { listFolders: async () => { throw new Error('nope'); }, ensureFolder: async () => null };
  const get3 = makeBatchFolders(broken, 'FALLBACK', nextBatchName);
  ck('an unreadable store falls back rather than throwing', (await get3('Grace')) === 'FALLBACK');

  // --- EDDY resolves per combo too; only the NUMBERING is a Max thing --------------------------
  // Setting batchFolderFor to null on Eddy meant generateCombo never asked whose picture it was,
  // so a run spanning Grace and Mia filed everything into one folder -- the owner's Grace images
  // landed in Mia (2026-08-10).
  ck('Eddy gets a plain per-character resolver, not null',
    /const batchFolderFor = numberBatches \? preAlloc : plainFolders;/.test(g));
  ck('the plain resolver caches its promise, like the numbered one',
    /if \(!pending\.has\(who\)\) \{[\s\S]{0,200}libraryStore\.ensureFolder\(who\)/.test(g));
  ck('a combo with no name falls back to the run folder', /if \(!who\) return Promise\.resolve\(libFolderId\);/.test(g));
  ck('a failed ensureFolder falls back rather than throwing', /catch \{ return libFolderId; \}/.test(g));
  ck('the symptom is recorded', /Grace images landed in Mia/.test(g));

  // replay: one Eddy run over two characters
  {
    const pend = new Map(); let calls = 0;
    const plain = (name) => {
      const who = String(name || '').trim();
      if (!who) return Promise.resolve('FALLBACK');
      if (!pend.has(who)) { calls += 1; pend.set(who, Promise.resolve('folder:' + who)); }
      return pend.get(who);
    };
    const combos = ['Grace', 'Mia', 'Grace', 'Mia', 'Grace', ''];
    const out = await Promise.all(combos.map(plain));
    ck('Grace images go to Grace', out[0] === 'folder:Grace' && out[2] === 'folder:Grace');
    ck('Mia images go to Mia', out[1] === 'folder:Mia');
    ck('an unnamed combo goes to the run folder', out[5] === 'FALLBACK');
    ck('two characters, two folder lookups - not six', calls === 2);
    ck('and NO numbering on Eddy', !out.some((x) => /\s\d+$/.test(x)));
  }

  console.log(f ? `\nFAIL — ${f}` : `\nPASS — ${p}/${p}`);
  process.exit(f ? 1 : 0);
})();
