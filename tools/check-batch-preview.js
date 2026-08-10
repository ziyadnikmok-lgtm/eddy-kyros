// The "Saving into Library" banner must name the FOLDERS, not the character.
//
// It said "Mia" while the pictures went to "Mia 4" — the exact invisible-state problem the banner
// was built to end, reintroduced by the numbering feature above it (owner, 2026-08-10).
//
// Also covers the base-photo summary leaking onto Max Outfit: pickedBasePhotos is persisted state
// shared across tabs, so a selection made on Eddy rendered "2 base photos ticked" on a tab with no
// base-photo picker, no way to clear it, and no code path that reads it.
const fs = require('fs');
const g = fs.readFileSync('D:/Kyros/app/client/src/pages/EddyGeneratePage.jsx', 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

const previewSrc = /const batchPreview = useMemo\(\(\) => \{([\s\S]*?)\n  \}, \[/.exec(g)[1];

// --- the preview ---------------------------------------------------------------------------------
check('the preview uses the SAME nextBatchName the run uses, so it cannot drift from the result',
  previewSrc.includes('nextBatchName(libItemFolders, n)'));
check('it lists one folder per character in the run', previewSrc.includes('[...names].sort().map'));
check('Max Outfit reads the source rows', previewSrc.includes('if (maxOutfit)'));
check('Eddy/Max Nano read the base-photo pairing', previewSrc.includes('basePhotoPairs.get(id)?.name'));
check('tab buckets are never previewed as people',
  previewSrc.includes('n !== MAX_OUTFIT_FOLDER') && previewSrc.includes("n !== 'Eddy'"));
check('it falls back to the single picked character', previewSrc.includes('if (!names.size && characterName)'));
check('the banner renders the preview ahead of the bare name', g.includes('{batchPreview.length > 0 ? ('));
check('and it is a preview, not a reservation — that limit is written down',
  /It is a preview, not a reservation/.test(g));

// --- the leaked base-photo line --------------------------------------------------------------------
check('the base-photo summary is off on Max Outfit',
  g.includes('if (maxOutfit || !pickedBasePhotos.length) return null;'));
check('both slot-row memos are gated at the source, not left to the layout',
  (g.match(/\(maxOutfit \? \[\] : pickedBasePhotos\)\.map/g) || []).length === 2);
check('the reason is recorded — persisted state shared across tabs',
  /pickedBasePhotos is PERSISTED state/.test(g));

// --- replay the preview rule ------------------------------------------------------------------------
const nextBatchName = new Function('folders', 'base',
  /function nextBatchName\(folders, base\) \{([\s\S]*?)\n\}/.exec(g)[1]);
const preview = (names, folders) => [...new Set(names)].sort().map((n) => nextBatchName(folders, n));

check('one character, no history -> "Mia 1"',
  preview(['Mia'], []).join() === 'Mia 1');
check('one character with history -> "Mia 4"',
  preview(['Mia'], [{ name: 'Mia 1' }, { name: 'Mia 2' }, { name: 'Mia 3' }]).join() === 'Mia 4');
check('three characters -> three folders, each on its own count',
  preview(['Grace', 'Lily', 'Mia'], [{ name: 'Grace 2' }, { name: 'Mia 9' }]).join(' · ')
    === 'Grace 3 · Lily 1 · Mia 10');
check('the same character ticked twice is still one folder',
  preview(['Grace', 'Grace'], []).length === 1);
check('a gap in history stays retired',
  preview(['Mia'], [{ name: 'Mia 1' }, { name: 'Mia 5' }]).join() === 'Mia 6');

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
