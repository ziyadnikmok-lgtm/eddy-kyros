// The aspect-ratio lists, and the silent trap that makes them worth checking.
//
// A ratio the PICKER offers but a SERVER list omits does not error — it is quietly rewritten to
// 1:1. On screen that reads as the model ignoring the setting, with nothing anywhere saying why.
// There are three separate lists that have to agree, in three files, maintained by hand:
//
//   client/src/config/photoModes.js   what the dropdowns show
//   server/services/muapiService.js   the allowlist on the Muapi/Seedream path
//   server/services/wavespeedService  the ratio -> pixel-size map on the WaveSpeed paths
//
// This suite exists so adding one and forgetting the others fails loudly here rather than quietly
// in a generation you paid for (owner, 2026-08-15: "i need 21:9 ... everywhere can select").
const fs = require('fs');
const path = require('path');
// The repo root, derived — this suite has to run on whichever machine has the repo.
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

const cfg = read('client/src/config/photoModes.js');
const muapi = read('server/services/muapiService.js');
const ws = read('server/services/wavespeedService.js');

const listOf = (src, name) => {
  const m = src.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  return m ? m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : [];
};

const picker = listOf(cfg, 'SEEDREAM_ASPECT_RATIOS');
const allow = listOf(muapi, 'SEEDREAM_ASPECT_RATIOS');
const sizeKeys = (ws.match(/IMAGE_SIZE_MAP = \{([\s\S]*?)\n\};/) || ['', ''])[1]
  .split('\n').map((l) => (l.match(/'([\d:]+)'\s*:/) || [])[1]).filter(Boolean);

check(`the picker offers ${picker.length} ratios`, picker.length > 0);
check(`the Muapi allowlist has ${allow.length}`, allow.length > 0);
check(`the WaveSpeed size map has ${sizeKeys.length}`, sizeKeys.length > 0);

// --- 21:9, the one that was asked for --------------------------------------------------------------
check('21:9 is selectable', picker.includes('21:9'));
check('21:9 survives the Muapi allowlist instead of becoming 1:1', allow.includes('21:9'));
check('21:9 has a pixel size on the WaveSpeed path', sizeKeys.includes('21:9'));

const size21 = (ws.match(/'21:9':\s*'(\d+)\*(\d+)'/) || []);
check('and that size is really 21:9', size21.length === 3 && Math.abs((size21[1] / size21[2]) - (21 / 9)) < 0.001);
// Diffusion models want both edges on a multiple of 64; an off-grid size comes back subtly cropped.
check('both edges are multiples of 64', size21.length === 3 && size21[1] % 64 === 0 && size21[2] % 64 === 0);

// --- THE TRAP: every offered ratio must be honoured end to end --------------------------------------
const missingAllow = picker.filter((r) => !allow.includes(r));
check(`every offered ratio is in the Muapi allowlist${missingAllow.length ? ` — missing ${missingAllow.join(', ')}` : ''}`,
  missingAllow.length === 0);
const missingSize = picker.filter((r) => !sizeKeys.includes(r));
check(`every offered ratio has a WaveSpeed pixel size${missingSize.length ? ` — missing ${missingSize.join(', ')}` : ''}`,
  missingSize.length === 0);

// --- the fallback is at least visible when it does happen ---------------------------------------------
check('the Muapi path logs an unsupported ratio', muapi.includes("log.warn('muapi_unsupported_aspect'"));
check('the WaveSpeed path logs it too', ws.includes("log.warn('wavespeed_unsupported_aspect'"));
check('both name what was asked for and what was used',
  /asked: opts\.aspectRatio, used/.test(muapi) && /asked: opts\.aspectRatio, used/.test(ws));

// --- auto-detect can now reach it ----------------------------------------------------------------------
// detectAspectRatio snaps a source photo to the CLOSEST allowed ratio, and it is handed this same
// list — so an ultrawide source picks 21:9 on its own rather than being squeezed into 16:9.
const snap = (w, h, allowed) => {
  const target = w / h;
  let best = allowed[0]; let diff = Infinity;
  for (const cand of allowed) {
    const [cw, ch] = cand.split(':').map(Number);
    const d = Math.abs(cw / ch - target);
    if (d < diff) { diff = d; best = cand; }
  }
  return best;
};
check('a 2560x1080 ultrawide source now snaps to 21:9', snap(2560, 1080, picker) === '21:9');
check('a 1920x1080 source still snaps to 16:9', snap(1920, 1080, picker) === '16:9');
check('a 1080x1350 portrait still snaps to 4:3-family, not 21:9', snap(1080, 1350, picker) !== '21:9');
check('a square source still snaps to 1:1', snap(1000, 1000, picker) === '1:1');
check('a 9:16 phone photo is unaffected', snap(1080, 1920, picker) === '9:16');

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
