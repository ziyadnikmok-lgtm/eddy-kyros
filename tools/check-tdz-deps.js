// A hook dependency array that names a `const` declared LATER in the same component.
//
// This is a blank page, not a warning. The deps array is evaluated DURING render, so reading a
// const above its declaration is a TDZ ReferenceError that unmounts everything. It happened twice on
// 2026-08-09 — `poseView` and `viewBreakdown` reading `combos` — and neither the build nor eslint's
// no-undef can see it: the name IS defined, just later, and the syntax is perfectly valid.
//
// no-use-before-define flags 16 harmless cases too (a const arrow called by a handler that runs
// after mount), so this checks the precise shape instead: hook deps only.
const fs = require('fs');
const FILES = [
  'D:/Kyros/app/client/src/pages/EddyGeneratePage.jsx',
  'D:/Kyros/app/client/src/components/EddyCollection.jsx',
  'D:/Kyros/app/client/src/pages/PhotoMatchSeedreamPage.jsx',
  'D:/Kyros/app/client/src/pages/EddyBasePage.jsx',
  'D:/Kyros/app/client/src/pages/EddyTabs.jsx',
];

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

const scan = (src) => {
  const text = src.split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
  // Where each top-level-ish const is declared, by first occurrence.
  // COMPONENT-BODY LEVEL ONLY (exactly two spaces of indent), and the EARLIEST such declaration.
  //
  // Without both of those this reported two false alarms: `items` matched a `const items` inside a
  // drop handler rather than the useState at the top, and `src` matched a const in a different
  // function entirely. A checker that cries wolf gets ignored, which costs more than it saves.
  const declared = new Map();
  const note = (name, at) => {
    const prev = declared.get(name);
    if (prev === undefined || at < prev) declared.set(name, at);
  };
  let m;
  const declRe = /^  const\s+([A-Za-z_$][\w$]*)\s*=/gm;
  while ((m = declRe.exec(text))) note(m[1], m.index);
  // Destructured state: const [x, setX] = useState()
  const arrRe = /^  const\s*\[\s*([A-Za-z_$][\w$]*)\s*,/gm;
  while ((m = arrRe.exec(text))) note(m[1], m.index);

  const bad = [];
  // The deps array of a hook: `}, [ ... ]);`
  // Component-level hooks close at two spaces too; a nested one is a different scope.
  const depRe = /^  \}\s*,\s*\[([^\]]*)\]\s*\)\s*;/gm;
  while ((m = depRe.exec(text))) {
    const at = m.index;
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/[.?[]/)[0];
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const declAt = declared.get(name);
      if (declAt !== undefined && declAt > at) {
        bad.push({ name, line: text.slice(0, at).split('\n').length, declLine: text.slice(0, declAt).split('\n').length });
      }
    }
  }
  return bad;
};

// Prove the scanner catches the real bug before trusting it on clean files.
const broken = [
  '  const viewBreakdown = useMemo(() => {',
  '    return combos.length;',
  '  }, [combos, poses]);',
  '  const combos = useMemo(() => [], [x]);',
].join(String.fromCharCode(10));
const caught = scan(broken);
check('the scanner catches the crash it was written for',
  caught.length === 1 && caught[0].name === 'combos');

for (const f of FILES) {
  const bad = scan(fs.readFileSync(f, 'utf8'));
  const short = f.split('/').pop();
  if (bad.length) for (const b of bad) console.log(`        ${short}: deps at line ${b.line} name "${b.name}", declared at ${b.declLine}`);
  check(`${short}: no hook reads a const declared later`, bad.length === 0);
}

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
