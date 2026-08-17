// A backslash that went missing on the way into the file.
//
// WHY THIS SUITE EXISTS. Edits written through a shell heredoc lose backslashes: the shell eats them
// before node ever sees the text, so `/^image\//i` is written to disk as `/^image//i`. That is still
// VALID JavaScript — a regex, a division, and an identifier — so the bundler builds it happily and
// nothing complains until the line runs and throws `i is not defined`.
//
// It has already shipped once. The window drop handler on Photo Match, added specifically to fix
// "i drag and it dont work but i copy paste it work", contained exactly this and threw on every
// drop — so the fix for dragging was broken by the way the fix was typed (2026-08-17).
//
// Cheap to check, invisible otherwise, and it has cost about six debugging sessions.
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');

let pass = 0; let fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

/** Every .js/.jsx under a directory, skipping build output and dependencies. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'vendor' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const FILES = [
  ...walk(path.join(ROOT, 'client/src')),
  ...walk(path.join(ROOT, 'server')),
  ...walk(path.join(ROOT, 'tools')),
];
check('there are source files to scan', FILES.length > 50);

/**
 * The signatures of an eaten backslash, as they actually appear.
 *
 * Narrow on purpose: each one is meaningless as real code, so a hit is a bug rather than a style
 * opinion. `//i.test(`, `//.test(` and friends are an empty regex where a `\/` should be; `/^image//`
 * is the exact shape that shipped.
 */
// The lookbehind is load-bearing: `/^https?:\/\//.test(x)` ends in `\/` + `/` + `.test(`, which is
// correct code and would match otherwise. A backslash immediately before means the slash is escaped
// and the pattern is intact — the bug is an UNESCAPED slash closing the regex early.
const SIGNATURES = [
  [/(?<!\\)\/\/[a-z]*\.test\(/, 'an empty regex followed by .test( — a `\\/` lost its backslash'],
  [/(?<!\\)\/\/[a-z]*\.exec\(/, 'an empty regex followed by .exec( — a `\\/` lost its backslash'],
  [/\.replace\((?<!\\)\/\/[gimsuy]*,/, '.replace() with an empty regex — a `\\/` lost its backslash'],
  [/(?<!\\)\/\/[gimsuy]*\.source/, 'an empty regex used as a pattern'],
];

const hits = [];
for (const file of FILES) {
  const text = fs.readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    // A `//` that begins a comment is not a regex. Only look at `//` with a regex START before it,
    // which is what the signatures encode; a line that is only a comment is skipped outright.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const [re, why] of SIGNATURES) {
      if (re.test(line)) hits.push(`${path.relative(ROOT, file)}:${i + 1} — ${why}\n      ${line.trim().slice(0, 120)}`);
    }
  });
}
check('no eaten backslashes anywhere in the source', hits.length === 0);
for (const h of hits) console.log('       ' + h);

// The line that shipped broken, pinned so it cannot regress quietly.
const page = fs.readFileSync(path.join(ROOT, 'client/src/pages/PhotoMatchSeedreamPage.jsx'), 'utf8');
check('the Photo Match drop filter is a real image test',
  page.includes('.filter((f) => /^image\\//i.test(f.type))'));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
