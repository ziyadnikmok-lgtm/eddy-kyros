// Two small things that both cost the owner information they needed.
//
// The credits wall was hit on 2026-08-10 with no warning it was close -- cost was shown per run and
// never cumulatively. And failedCombos lived in React state alone, so a reload lost both the Retry
// bar and any record of what had not generated; the only way to notice was counting images.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const gen = fs.readFileSync(path.join(ROOT, 'client/src/pages/EddyGeneratePage.jsx'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- spend -------------------------------------------------------------------------------------
check('today is summed from the Library, not counted in memory', gen.includes('spendToday(libItems)'));
check('and summed once per change rather than twice per render',
  gen.includes('const spentToday = useMemo(() => spendToday(libItems), [libItems]);'));
check('it is shown beside the run cost', gen.includes('today <span className="font-mono text-zinc-400">${spentToday.toFixed(2)}</span>'));
check('the run beside it is the run about to be paid for', gen.includes('this run <span className="font-mono text-zinc-400">${totalCost.toFixed(2)}</span>'));
check('nothing spent shows nothing, rather than a $0.00 that looks broken', gen.includes('{spentToday > 0 && ('));
check('it is derived, so it survives a reload', /derived, not counted/.test(gen));

// --- the price it sums ---------------------------------------------------------------------------
// The total is only as honest as the price stamped on each row, and that price was Seedream's on
// every engine -- including nano2, which is the DEFAULT.
check('one helper prices an image for whichever engine is running', gen.includes('const priceOne = (engine, resolution, perRunImages) => (engine === \'nano2\''));
check('no site prices an image by calling seedreamCost directly any more',
  (gen.match(/seedreamCost\(resolution/g) || []).length === 1);
check('the row price goes through it', gen.includes('const perImageCost = priceOne(engine, resolution, perRunImages);'));
check('so does the button', gen.includes('const perImagePrice = priceOne(engine, resolution, perRunImages);'));
check('and both confirm dialogs, which quote a bill', (gen.match(/const each = priceOne\(/g) || []).length === 2);
check('the reason is recorded', /stamped it onto every Library row/.test(gen));

// --- failed combos ----------------------------------------------------------------------------
check('failed combos are persisted', gen.includes("stateStore.set('failedCombos', failedCombos)"));
check('and restored', gen.includes("stateStore.get('failedCombos', [])"));
check('the restore cannot be erased by the initial empty state — the classic order bug',
  gen.includes('if (!failedRestored.current) return;'));
check('nor can it clobber failures collected before it lands',
  gen.includes('setFailedCombos((cur) => (cur.length ? cur : saved))'));
check('a successful retry clears its entry', gen.includes('prev.filter((f) => f.combo !== combo)'));
check('the reason is recorded', /the only way to notice was counting images/.test(gen));

// --- replay the sum -------------------------------------------------------------------------------
const srcText = fs.readFileSync(path.join(ROOT, 'client/src/lib/provenance.js'), 'utf8');
// eslint-disable-next-line no-new-func
const { spendToday } = new Function(`${srcText.replace(/^export /gm, '')}; return { spendToday };`)();
const DAY = 86400000;
const now = new Date(2026, 7, 11, 18, 0, 0).getTime();
check('two images today at 0.045 sum to 0.09',
  Math.abs(spendToday([{ createdAt: now - 1000, price: 0.045 }, { createdAt: now - 2000, price: 0.045 }], now) - 0.09) < 1e-9);
check('yesterday is excluded', spendToday([{ createdAt: now - 2 * DAY, price: 0.045 }], now) === 0);
check('an unpriced row contributes nothing rather than NaN', spendToday([{ createdAt: now - 1000 }], now) === 0);
check('a row from earlier today, before this ran, still counts',
  Math.abs(spendToday([{ createdAt: now - 12 * 3600000, price: 0.07 }], now) - 0.07) < 1e-9);
check('mixed engines add up — nano2 2K and seedream in one day',
  Math.abs(spendToday([{ createdAt: now - 100, price: 0.105 }, { createdAt: now - 200, price: 0.045 }], now) - 0.15) < 1e-9);

// --- replay the restore ordering ------------------------------------------------------------------
// The bug this guards: the write effect fires on mount with [] and wipes the store before the async
// read comes back.
const store = { failedCombos: [{ combo: 'c1' }, { combo: 'c2' }] };
let restored = false, state = [];
const writeEffect = () => { if (!restored) return; store.failedCombos = state; };
writeEffect();                                   // mount, before the read resolves
check('the mount write does not wipe the saved list', store.failedCombos.length === 2);
restored = true; state = store.failedCombos;     // read resolves
state = state.filter((f) => f.combo !== 'c1');   // a retry succeeds
writeEffect();
check('a successful retry is written through', store.failedCombos.length === 1);
state = [];
writeEffect();
check('and Clear really clears — a dismissed bar stays dismissed', store.failedCombos.length === 0);

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
