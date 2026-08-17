// Does the code actually RESOLVE — no undefined variables, no out-of-scope reads.
//
// ⚠️ WHY THIS EXISTS. Every other suite here reads the source as TEXT and asserts what it says. That
// catches a great deal and it cannot catch this: on 2026-08-17 a label builder was added to
// EddyGeneratePage that read poseIndex, faceIndex and outfitIndex — three variables declared with
// `let` inside a block it sat outside of. Valid syntax. Vite built it without a murmur. Every suite
// stayed green. And every click threw ReferenceError before a single request left the browser
// ("nzh it didint even try"), with the server log confirming not one POST while every card failed.
//
// ESLint's no-undef finds it in about a second, and eslint was already configured in this repo with
// a lint script in both package.json files. It simply was not part of the check sweep, so nobody ran
// it. That is the actual failure this file fixes.
//
// ERRORS ONLY. The client carries seven long-standing warnings (unused vars, use-before-define);
// failing on those would mean this suite is red on arrival and therefore ignored, which is how a
// gate stops being a gate.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');

let pass = 0; let fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

/** Run eslint over a directory and return its findings as JSON. */
function lint(cwd, target) {
  // The .cmd shim cannot be spawned directly on Windows (EINVAL) — run eslint's own JS entry point
  // with the node that is already running this suite, which also avoids depending on a shell.
  const bin = path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!fs.existsSync(bin)) return null;
  try {
    const out = execFileSync(process.execPath, [bin, target, '--format', 'json'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch (err) {
    // eslint exits non-zero when it finds errors; the report is still on stdout.
    if (err.stdout) { try { return JSON.parse(err.stdout); } catch { /* fall through */ } }
    return { _broken: err.message };
  }
}

/**
 * CLIENT ONLY, and that is a statement of fact rather than a preference: eslint.config.js lives in
 * client/ and there is no config at the repo root, so `eslint server` exits with "couldn't find an
 * eslint.config file" and lints nothing. The client is also where the bug that prompted this suite
 * lived — it is the React code, with the deep scopes.
 *
 * Giving the server its own config is worth doing and is not this fix; when it gets one, add it to
 * the list below and the suite covers it with no other change.
 */
for (const [name, cwd, target] of [
  ['client', path.join(ROOT, 'client'), 'src'],
]) {
  const report = lint(cwd, target);
  if (!report) { check(`${name}: eslint is installed`, false); continue; }
  if (report._broken) { check(`${name}: eslint ran (${String(report._broken).slice(0, 120)})`, false); continue; }

  const errors = report.flatMap((f) => f.messages
    .filter((m) => m.severity === 2)
    .map((m) => `${path.relative(ROOT, f.filePath)}:${m.line} ${m.message} (${m.ruleId})`));
  check(`${name}: no errors across ${report.length} files`, errors.length === 0);
  for (const e of errors.slice(0, 25)) console.log('       ' + e);
  if (errors.length > 25) console.log(`       … and ${errors.length - 25} more`);
}

// The rule that would have caught it, named — so a config change that quietly drops it is visible
// here rather than three weeks later.
const cfg = ['eslint.config.js', 'eslint.config.mjs', '.eslintrc.json', '.eslintrc.cjs']
  .map((f) => path.join(ROOT, 'client', f))
  .find((f) => fs.existsSync(f));
check('the client has an eslint config at all', !!cfg);
if (cfg) {
  const text = fs.readFileSync(cfg, 'utf8');
  // Either it is on explicitly, or it comes from a recommended set that includes it.
  check('and no-undef is not switched off',
    !/['"]no-undef['"]\s*:\s*['"]?(off|0)['"]?/.test(text));
}

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
