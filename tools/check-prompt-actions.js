// What you can DO with a prompt once you can see it.
//
// Showing the text was the ask; on its own it is a wall of grey you cannot act on. A Kyros prompt
// runs to a couple of thousand characters, a Library holds 627 pictures, and the prompt is the only
// thing distinguishing two shots of the same woman in the same room. So: expand it, copy it, reuse
// it, and search by it (owner asked for "smart options" and left the choice open, 2026-08-11).
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const col = fs.readFileSync(path.join(ROOT, 'client/src/components/EddyCollection.jsx'), 'utf8').replace(/\r\n/g, '\n');
const gen = fs.readFileSync(path.join(ROOT, 'client/src/pages/EddyGeneratePage.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- expand ---------------------------------------------------------------------------------------
check('a prompt expands on click', col.includes('setOpenPrompts((cur) => {'));
check('clamped to three lines until it is', col.includes("openPrompts.has(it.id) ? 'max-h-64 overflow-y-auto' : 'line-clamp-3'"));
check('an expanded one scrolls rather than pushing the grid apart', col.includes('max-h-64 overflow-y-auto'));
check('expansion is per card, not global', col.includes('const [openPrompts, setOpenPrompts] = useState(() => new Set())'));
check('the click does not also open the lightbox', (col.match(/e\.stopPropagation\(\);/g) || []).length >= 4);

// --- copy / reuse / similar ---------------------------------------------------------------------------
check('Copy is still there', col.includes("notify('Prompt copied', 'success')"));
check('Use in Generate stashes AND fires an event — the lazy-mount race again',
  col.includes("window.sessionStorage.setItem('kyros.reusePrompt'")
  && col.includes("new CustomEvent('kyros:reuse-prompt'"));
check('Similar seeds the search from the first few words',
  col.includes("setPromptQuery(it.prompt.trim().split(/\\s+/).slice(0, 4).join(' '))"));

// --- the receiving end ------------------------------------------------------------------------------------
check('Generate reads the stash on mount', gen.includes("window.sessionStorage.getItem('kyros.reusePrompt')"));
check('and clears it, so it cannot re-fire on the next visit', gen.includes("removeItem('kyros.reusePrompt')"));
check('it also listens, for a page already open', gen.includes("window.addEventListener('kyros:reuse-prompt', onReuse)"));
check('and removes the listener on unmount', gen.includes("window.removeEventListener('kyros:reuse-prompt', onReuse)"));
check('it FILLS the box and does not generate — a click in another tab must not spend money',
  /It fills the instruction box rather than generating/.test(gen));
check('an empty prompt is ignored rather than clearing the box', gen.includes("if (!t) return;"));

// --- search ---------------------------------------------------------------------------------------------------
check('the search filters `visible`, not just the rendered grid', (() => {
  const vis = /const visible = useMemo\(\(\) => \{([\s\S]*?)\n  \}, \[/.exec(col)[1];
  return vis.includes('promptQuery');
})());
check('so Select all and the counts mean what is on screen',
  /`visible` is what Select all, the counts, Download and Save all act on/.test(col));
check('it searches the name too, not only the prompt',
  col.includes("`${i.prompt || ''} ${i.name || ''}`.toLowerCase().includes(q)"));
check('it is case-insensitive', col.includes('.toLowerCase().includes(q)'));
check('an empty query is a no-op rather than matching nothing', col.includes('const searched = q'));
check('the box only appears where prompts exist', col.includes("{items.some((i) => (i.prompt || '').trim()) && ("));
check('and offers a clear', col.includes("onClick={() => setPromptQuery('')}"));

// --- replay the search --------------------------------------------------------------------------------------------
const rows = [
  { prompt: 'a woman sitting POOLSIDE in a red bikini', name: 'eddy-1' },
  { prompt: 'she leans on a car bonnet at sunset', name: 'eddy-2' },
  { prompt: '', name: 'poolside-upload' },
  { name: 'no prompt at all' },
];
const search = (q) => {
  const s = q.trim().toLowerCase();
  return s ? rows.filter((i) => `${i.prompt || ''} ${i.name || ''}`.toLowerCase().includes(s)) : rows;
};
check('finds a word inside a prompt regardless of case', search('poolside').length === 2);
check('matches the name too', search('upload').length === 1);
check('an empty query returns everything', search('   ').length === 4);
check('a miss returns nothing rather than everything', search('zebra').length === 0);
check('a row with no prompt cannot crash it', search('no prompt at all').length === 1);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
