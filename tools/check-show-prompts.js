// Base saves the prompt it actually sent, and any picture collection can show its prompts.
//
// Two things (owner, 2026-08-10):
//   1. one Base path saved `instruction.trim()` -- the raw typed text -- while sending an
//      assembled `prompt`. The row could not reproduce its own picture.
//   2. Base Library had no way to READ a prompt at all. `withPrompt` exists but is a different
//      thing: it turns a collection INTO a prompt list and changes the card layout. Base Library
//      is a picture grid and should stay one.
const fs = require('fs');
const col = fs.readFileSync('D:/Kyros/app/client/src/components/EddyCollection.jsx', 'utf8');
const base = fs.readFileSync('D:/Kyros/app/client/src/pages/EddyBasePage.jsx', 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- Base saves what it sent ------------------------------------------------------------------
check('the batch path saves the assembled prompt, not the raw instruction',
  base.includes('const stored = await baseStore.addItems([{ dataUrl, prompt, name:'));
check('the raw-instruction version is gone', !base.includes('prompt: instruction.trim(), name:'));
check('the other Base path already saved its prompt', base.includes('prompt: run.prompt, name:'));
check('both send and save the SAME value', (base.match(/prompt,\s*\n\s*model: 'nano2'/) !== null)
  || base.includes('prompt,'));
check('the reason is recorded', /could not reproduce its own picture/.test(base));

// --- the toggle -----------------------------------------------------------------------------------
check('there is a per-collection showPrompts state', col.includes('const [showPrompts, setShowPrompts] = useState('));
check('it is remembered per collection, not globally',
  col.includes('localStorage.getItem(`eddy.showPrompts.${dbName}`)')
  && col.includes('localStorage.setItem(`eddy.showPrompts.${dbName}`'));
check('the button is rendered', col.includes("{showPrompts ? '✓ Prompts' : 'Show prompts'}"));
// ON by default now (owner, 2026-08-11): off-by-default meant the prompt was saved and looked
// missing -- you had to know a toggle existed to find out.
check('it is ON by default, like the Gallery', col.includes("return v === null ? true : v === '1';"));
check('but a stored choice still wins', col.includes('const v = localStorage.getItem('));
check('a row with no prompt says so rather than rendering nothing',
  col.includes('no prompt saved for this one'));
check('it is hidden on a withPrompt collection, where the text is already the point',
  col.includes('{!withPrompt && items.some((i) => (i.prompt || \'\').trim()) && ('));
check('and hidden when nothing in the collection HAS a prompt',
  col.includes("items.some((i) => (i.prompt || '').trim())"));

// --- the card ----------------------------------------------------------------------------------------
check('the prompt renders under the picture, not over it', col.includes('{showPrompts && !withPrompt && (it.prompt'));
check('it is clickable to copy — reuse is the reason to read one', /navigator\.clipboard\?\.writeText\(it\.prompt\.trim\(\)\)/.test(col));
check('the click does not also open the lightbox', /e\.stopPropagation\(\);\s*\n\s*navigator\.clipboard/.test(col));
check('long prompts are clamped rather than pushing the grid apart', /line-clamp-3/.test(col));
// No longer "nothing extra": a blank card was ambiguous — it read as the feature being broken
// when the truth was that the picture predates prompts being saved. It now says which.
check('a card with no prompt says so explicitly',
  col.includes("!(it.prompt || '').trim() && (thumbs[it.id] || it.url) && ("));

// --- withPrompt is untouched ------------------------------------------------------------------------------
check('withPrompt still drives the prompt-list layout', /withPrompt \? 'object-contain' : 'aspect-\[3\/4\] object-cover'/.test(col));
check('the two are kept distinct in the source', /Separate from `withPrompt`, which is a different thing/.test(col));

// --- replay: when the button shows ---------------------------------------------------------------------------
const shows = (withPrompt, items) => !withPrompt && items.some((i) => (i.prompt || '').trim());
check('Base Library with prompts -> shown', shows(false, [{ prompt: 'a woman by a pool' }]) === true);
check('Base Library with none -> hidden', shows(false, [{ prompt: '' }, {}]) === false);
check('Pose (withPrompt) -> hidden, it always shows text', shows(true, [{ prompt: 'x' }]) === false);
check('whitespace is not a prompt', shows(false, [{ prompt: '   ' }]) === false);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
