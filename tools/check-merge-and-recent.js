// Folding numbered batch folders back into the plain one, and selecting by age.
//
// The Max tabs open a numbered folder per click, which is right while a batch is fresh and wrong a
// week later: twelve folders holding one picture each (owner, 2026-08-10). Merge moves the
// pictures into the plain folder of the same name and removes the empties.
//
// THE DANGEROUS PART: deleteFolder alone orphans rows to folderId null, which looks exactly like
// losing them -- the Library lists by folder, so an orphan is visible under "All" and nowhere
// else. So the move happens first and is VERIFIED before any folder is removed.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const col = fs.readFileSync(path.join(ROOT, 'client/src/components/EddyCollection.jsx'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the merge is safe --------------------------------------------------------------------------
check('the move happens before any delete', (() => {
  const body = /const mergeNumberedFolders = async \(\) => \{([\s\S]*?)\n  \};/.exec(col)[1];
  return body.indexOf('store.updateItems(patches)') < body.indexOf('store.deleteFolder(f.id)');
})());
check('and is verified — a folder with rows left is skipped, not deleted',
  col.includes('if (left) continue;'));
check('the orphaning risk is written down', /orphan the pictures to no folder at all/.test(col));
check('it confirms first, naming the targets', /Merge \$\{total\} numbered folder/.test(col));
check('the confirm promises nothing is deleted', /Nothing is deleted\./.test(col));
check('it refuses politely when there is nothing to merge', col.includes("notify('No numbered folders to merge'"));
check('the button only shows when a numbered folder exists',
  /folders\.some\(\(f\) => \/\\\\s\[0-9\]\+\$\/\.test/.test(col) || col.includes('folders.some((f) => /\\s[0-9]+$/.test'));

// --- executed: which folders fold, and into what -------------------------------------------------
const parentOf = new Function('name', /const parentOf = \(name\) => \{([\s\S]*?)\n    \};/.exec(col)[1]);
const cases = [
  ['Grace 1', 'Grace'], ['Grace 12', 'Grace'], ['Mia 6', 'Mia'],
  ['Grace Outfit 3', 'Grace'], ['Mia 3 Outfit 2', 'Mia 3'],
  ['Grace', null], ['Eddy', null], ['Eddy NSFW', null], ['Max Nano', null],
  ['Grace cosplay', null], ['Grace cosplay 2', 'Grace cosplay'],
];
for (const [name, want] of cases) {
  check(`"${name}" -> ${want === null ? 'left alone' : `"${want}"`}`, parentOf(name) === want);
}
check('a folder that is only a number is left alone', parentOf('3') === null);
check('trailing spaces do not fool it', parentOf('Grace 2  ') === 'Grace');

// --- select by age -------------------------------------------------------------------------------
check('selectSince exists', col.includes('const selectSince = useCallback((ms) => {'));
check('an hour and a day are both offered',
  col.includes('selectSince(3_600_000)') && col.includes('selectSince(86_400_000)'));
check('it counts from the CURRENT VIEW, so inside a folder it means that folder',
  /const ids = visible\.filter\(\(i\) => Number\(i\.createdAt\) > cutoff\)/.test(col));
check('a row with no createdAt is excluded, not swept in', /Number\(i\.createdAt\) > cutoff/.test(col));
check('it says so rather than silently selecting nothing', col.includes("notify('Nothing that recent in this view'"));
check('the buttons show a count', /Last hour \(\{recentCounts\.hour\}\)/.test(col) && /Last 24h \(\{recentCounts\.day\}\)/.test(col));
check('they hide when they would select everything — same as Select all',
  /recentCounts\.hour > 0 && recentCounts\.hour < visible\.length/.test(col));
check('and 24h hides when it equals the hour count', /recentCounts\.day !== recentCounts\.hour/.test(col));

// --- replay the age filter ---------------------------------------------------------------------------
const now = Date.now();
const rows = [
  { id: 'a', createdAt: now - 60_000 },        // a minute ago
  { id: 'b', createdAt: now - 40 * 60_000 },   // 40 min
  { id: 'c', createdAt: now - 5 * 3_600_000 }, // 5 hours
  { id: 'd', createdAt: now - 3 * 86_400_000 },// 3 days
  { id: 'e' },                                  // no timestamp
];
const since = (ms) => rows.filter((i) => Number(i.createdAt) > now - ms).map((i) => i.id);
check('last hour picks the two recent ones', since(3_600_000).join() === 'a,b');
check('last 24h adds the 5-hour-old one', since(86_400_000).join() === 'a,b,c');
check('neither picks the 3-day-old one', !since(86_400_000).includes('d'));
check('neither picks the row with no timestamp', !since(86_400_000).includes('e'));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
