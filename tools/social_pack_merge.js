#!/usr/bin/env node
/**
 * Collapse every generated folder into ONE deliverable of exactly 8 images per concept.
 *
 * Three runs produced overlapping partial output — the Imagen run (quota-capped at 14), the
 * locally typeset text posts (32), and the Nano Banana Pro run (best quality, still filling in).
 * This picks the best available copy of each slot rather than leaving the pack spread across
 * folders with different quality bars.
 *
 * Preference order per concept, best first:
 *   1. nano   — correct text, true 4:5, most consistent
 *   2. local  — perfect typography, but only exists for the text concepts
 *   3. imagen — good photos, cannot spell
 *
 * Prints exactly which slots are still short so the top-up run only generates what's missing.
 */
const fs = require('node:fs');
const path = require('node:path');

const DL = 'C:/Users/asusg/Downloads';
const STAMP = new Date().toISOString().slice(0, 10);
const OUT = path.join(DL, `social-pack-FINAL-${STAMP}`);
const PER = 8;

const SOURCES = [
  { tag: 'nano',   dir: path.join(DL, `social-pack-nano-${STAMP}`) },
  { tag: 'local',  dir: path.join(DL, `social-pack-${STAMP}`), only: [1, 2, 3, 10] },
  { tag: 'imagen', dir: path.join(DL, `social-pack-${STAMP}`), only: [4, 5, 6, 7, 8, 9] },
];

const CONCEPTS = [
  [1, 'text-dating'], [2, 'text-self-worth'], [3, 'text-tired'], [4, 'mannequin-outfit'],
  [5, 'flatlay-outfit'], [6, 'anime-quote-orb'], [7, 'anime-quote-rain'], [8, 'night-car'],
  [9, 'coffee-stilllife'], [10, 'notes-app'],
];

const pngsIn = (dir) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png'))
    .map((f) => path.join(dir, f));
};

// Rebuild from scratch each run: filenames carry the source model, so an upgraded slot would
// otherwise leave its old imagen copy sitting next to the new nano one.
if (fs.existsSync(OUT)) for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let total = 0;
const gaps = [];

for (const [id, slug] of CONCEPTS) {
  const folder = `${String(id).padStart(2, '0')}_${slug}`;
  const destDir = OUT;

  const picked = [];
  for (const src of SOURCES) {
    if (picked.length >= PER) break;
    if (src.only && !src.only.includes(id)) continue;
    for (const file of pngsIn(path.join(src.dir, folder))) {
      if (picked.length >= PER) break;
      picked.push({ file, tag: src.tag });
    }
  }

  picked.forEach((p, i) => {
    const name = `${folder}_${String(i + 1).padStart(2, '0')}_${p.tag}.png`;
    fs.copyFileSync(p.file, path.join(destDir, name));
  });
  total += picked.length;

  const short = PER - picked.length;
  const by = picked.reduce((a, p) => { a[p.tag] = (a[p.tag] || 0) + 1; return a; }, {});
  const mix = Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
  console.log(`  ${folder.padEnd(24)} ${String(picked.length).padStart(2)}/8  (${mix})${short ? `   NEEDS ${short}` : ''}`);
  if (short) gaps.push({ id, slug, short });
}

console.log(`\n${total}/80 in ${OUT}`);
if (gaps.length) {
  console.log(`\nstill short — top up with:`);
  console.log(`  node tools/social_pack_nano.js --only ${gaps.map((g) => g.id).join(',')} --per 8`);
  console.log(`  (then re-run this merge)`);
} else {
  console.log('complete — 80/80');
}
