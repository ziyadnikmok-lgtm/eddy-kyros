#!/usr/bin/env node
/**
 * Render the typography-driven concepts deterministically instead of asking Imagen to spell.
 *
 * Why this exists: a test render of concept 1 came back as
 *   "I stopped explaiining myself myself a my and my lifee quieıt quiet quet in a a good way?"
 * with a duplicated username row and nine bottom icons. Diffusion models approximate glyphs;
 * they do not typeset. Anything whose whole point is an exact sentence gets drawn here in SVG,
 * where the text is correct by construction, costs nothing, and renders instantly.
 *
 * Imagen still handles every concept that is genuinely photographic — see social_pack_gen.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'));

const W = 1080, H = 1350;   // 4:5, the ratio actually asked for (Imagen cannot do 4:5; SVG can)

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Greedy wrap by character budget — proportional fonts vary, so this errs narrow. */
function wrap(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) { line = w; continue; }
    if ((line + ' ' + w).length <= maxChars) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

// Eight typographic treatments so the eight variants are genuinely different posts rather than
// eight copies of one file. Varying weight/size/alignment/tint is what actually reads as a
// different post in a feed.
const STYLES = [
  { font: 'Segoe UI, Arial, sans-serif',        weight: 700, size: 68, align: 'middle', bg: '#ffffff', fg: '#0a0a0a', lh: 1.30 },
  { font: 'Georgia, serif',                     weight: 700, size: 64, align: 'middle', bg: '#ffffff', fg: '#111111', lh: 1.34 },
  { font: 'Segoe UI, Arial, sans-serif',        weight: 600, size: 60, align: 'start',  bg: '#ffffff', fg: '#141414', lh: 1.38 },
  { font: 'Helvetica, Arial, sans-serif',       weight: 800, size: 74, align: 'middle', bg: '#fafafa', fg: '#000000', lh: 1.26 },
  { font: 'Georgia, serif',                     weight: 400, size: 62, align: 'middle', bg: '#ffffff', fg: '#1a1a1a', lh: 1.40 },
  { font: 'Segoe UI, Arial, sans-serif',        weight: 700, size: 56, align: 'start',  bg: '#ffffff', fg: '#0a0a0a', lh: 1.42 },
  { font: 'Trebuchet MS, Arial, sans-serif',    weight: 700, size: 66, align: 'middle', bg: '#fdfdfb', fg: '#101010', lh: 1.32 },
  { font: 'Segoe UI, Arial, sans-serif',        weight: 300, size: 64, align: 'middle', bg: '#ffffff', fg: '#151515', lh: 1.36 },
];

/** The like / comment / share / save row — four icons, drawn as paths so they stay crisp. */
function iconRow(y) {
  const c = '#111';
  return `
    <g fill="none" stroke="${c}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M92 ${y} c0-14 11-25 25-25 9 0 15 5 19 10 4-5 10-10 19-10 14 0 25 11 25 25 0 22-32 39-44 47-12-8-44-25-44-47z"/>
      <path d="M232 ${y - 22} h74 a10 10 0 0 1 10 10 v34 a10 10 0 0 1 -10 10 h-46 l-20 18 v-18 h-8 a10 10 0 0 1 -10 -10 v-34 a10 10 0 0 1 10 -10z"/>
      <path d="M372 ${y - 20} l84 34 -84 34 v-24 l44 -10 -44 -10z"/>
      <path d="M968 ${y - 26} h-52 v72 l26 -22 26 22z"/>
    </g>`;
}

function textPostSVG({ body, username = 'Cshquoted · Just now', style }) {
  const s = style;
  const maxChars = Math.max(14, Math.round(2050 / s.size));
  const lines = wrap(body, maxChars);
  const blockH = lines.length * s.size * s.lh;
  const startY = (H / 2) - (blockH / 2) + s.size * 0.72;
  const x = s.align === 'middle' ? W / 2 : 92;

  const tspans = lines.map((ln, i) =>
    `<tspan x="${x}" y="${(startY + i * s.size * s.lh).toFixed(1)}">${esc(ln)}</tspan>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <filter id="soft"><feGaussianBlur stdDeviation="9"/></filter>
    <clipPath id="av"><circle cx="140" cy="118" r="44"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="${s.bg}"/>

  <!-- avatar: deliberately blurred, so it reads as a real account without being anyone -->
  <g clip-path="url(#av)" filter="url(#soft)">
    <rect x="96" y="74" width="88" height="88" fill="#c8ccd4"/>
    <circle cx="140" cy="104" r="20" fill="#9aa2ae"/>
    <ellipse cx="140" cy="168" rx="34" ry="26" fill="#9aa2ae"/>
  </g>
  <circle cx="140" cy="118" r="44" fill="none" stroke="#e6e8ec" stroke-width="2"/>
  <text x="206" y="128" font-family="Segoe UI, Arial, sans-serif" font-size="30"
        font-weight="600" fill="#333">${esc(username)}</text>
  <circle cx="962" cy="106" r="4" fill="#666"/><circle cx="978" cy="106" r="4" fill="#666"/>
  <circle cx="994" cy="106" r="4" fill="#666"/>

  <text font-family="${s.font}" font-size="${s.size}" font-weight="${s.weight}"
        fill="${s.fg}" text-anchor="${s.align}" xml:space="preserve">${tspans}</text>

  <line x1="92" y1="${H - 190}" x2="${W - 92}" y2="${H - 190}" stroke="#ebedf0" stroke-width="2"/>
  ${iconRow(H - 118)}
</svg>`;
}

/** The pastel quote box composited over an Imagen anime frame. */
function quoteBoxSVG(text, w, h) {
  const size = Math.round(w / 26);
  const lines = wrap(text, Math.round(w / (size * 0.52)));
  const padX = Math.round(w * 0.07), padY = Math.round(size * 0.95);
  const boxH = lines.length * size * 1.42 + padY * 2;
  const boxW = w - padX * 2;
  const boxY = h - boxH - Math.round(h * 0.07);
  const tspans = lines.map((ln, i) =>
    `<tspan x="${w / 2}" y="${(boxY + padY + size * (0.95 + i * 1.42)).toFixed(1)}">${esc(ln)}</tspan>`).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect x="${padX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="${Math.round(size * 0.85)}"
          fill="#fdf2f8" fill-opacity="0.94" stroke="#f9d7e8" stroke-width="3"/>
    <text font-family="Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="600"
          fill="#4a3d52" text-anchor="middle">${tspans}</text>
  </svg>`);
}

const TEXT_CONCEPTS = [
  { id: 1,  slug: 'text-dating',    body: 'i stopped explaining myself and my life got quiet in a good way' },
  { id: 2,  slug: 'text-self-worth', body: "nah i'm not hard to love you were just lazy" },
  { id: 3,  slug: 'text-tired',     body: "me pretending i'm not exhausted for the 4th day straight" },
];

// Concept 10 is a Notes screenshot, not a social post — its own dark-mode layout.
function notesSVG(style, variantIdx) {
  const bodies = [
    ['no more overthinking texts', 'no more 3am spirals', 'no more shrinking myself'],
    ['no more explaining twice', 'no more waiting up', 'no more almost-relationships'],
    ['no more free labour', 'no more guessing', 'no more chasing closure'],
    ['no more proving myself', 'no more one-sided effort', 'no more staying available'],
    ['no more apologising first', 'no more half-answers', 'no more bare minimum'],
    ['no more people-pleasing', 'no more late replies excused', 'no more shrinking'],
    ['no more second chances', 'no more mixed signals', 'no more waiting'],
    ['no more small talk', 'no more energy leaks', 'no more maybe'],
  ][variantIdx % 8];
  const lines = bodies.map((b, i) =>
    `<text x="96" y="${470 + i * 92}" font-family="Segoe UI, Arial, sans-serif" font-size="44"
       fill="#e8e8ea">${esc(b)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#0b0b0d"/>
    <rect x="56" y="150" width="${W - 112}" height="${H - 300}" rx="46" fill="#1c1c1e"/>
    <text x="96" y="300" font-family="Segoe UI, Arial, sans-serif" font-size="26" fill="#8e8e93">Notes</text>
    <text x="96" y="380" font-family="Segoe UI, Arial, sans-serif" font-size="52" font-weight="700"
          fill="#ffffff">${esc("things i'm not doing in 2026")}</text>
    <line x1="96" y1="415" x2="${W - 96}" y2="415" stroke="#2c2c2e" stroke-width="2"/>
    ${lines}
  </svg>`;
}

module.exports = { textPostSVG, notesSVG, quoteBoxSVG, STYLES, TEXT_CONCEPTS, W, H };

if (require.main === module) {
  (async () => {
    const per = parseInt((process.argv.find((a, i) => process.argv[i - 1] === '--per') || '8'), 10);
    const stamp = new Date().toISOString().slice(0, 10);
    const outRoot = path.join('C:/Users/asusg/Downloads', `social-pack-${stamp}`);
    let n = 0;

    for (const c of TEXT_CONCEPTS) {
      const dir = path.join(outRoot, `${String(c.id).padStart(2, '0')}_${c.slug}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let v = 0; v < per; v += 1) {
        const svg = textPostSVG({ body: c.body, style: STYLES[v % STYLES.length] });
        const name = `${String(c.id).padStart(2, '0')}_${c.slug}_v${String(v + 1).padStart(2, '0')}.png`;
        await sharp(Buffer.from(svg)).png().toFile(path.join(dir, name));
        n += 1;
      }
      console.log(`  ok   ${c.slug} x${per}`);
    }

    const nd = path.join(outRoot, '10_notes-app');
    fs.mkdirSync(nd, { recursive: true });
    for (let v = 0; v < per; v += 1) {
      await sharp(Buffer.from(notesSVG(STYLES[v % STYLES.length], v))).png()
        .toFile(path.join(nd, `10_notes-app_v${String(v + 1).padStart(2, '0')}.png`));
      n += 1;
    }
    console.log(`  ok   notes-app x${per}`);
    console.log(`\n${n} typography images -> ${outRoot}  ($0 — rendered locally)`);
  })().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
}
