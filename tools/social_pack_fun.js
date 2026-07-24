#!/usr/bin/env node
/**
 * 24 extra text posts in the same voice as concepts 01-03, leaning funny.
 *
 * Rendered locally rather than generated: these are pure typography, so a diffusion model adds
 * nothing but spelling risk and quota waits. Free, instant, and the words come out exactly as
 * written.
 *
 * Lands in the existing delivery folder under an 11_fun prefix so everything stays in one place
 * and still sorts together.
 *
 *   node tools/social_pack_fun.js
 */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'));
const { textPostSVG, STYLES } = require('./social_pack_text.js');

const OUT = path.join('C:/Users/asusg/Downloads', `social-pack-FINAL-${new Date().toISOString().slice(0, 10)}`);

// Same register as the originals: lowercase, dry, a bit savage, no punchline telegraphing.
// Kept short — long lines shrink the type and these read at thumbnail size.
const LINES = [
  "i'm not ignoring you i'm just horizontal",
  "my toxic trait is thinking i'll be a morning person tomorrow",
  "i have the emotional range of a wifi signal",
  "nothing humbles you like reading your own old texts",
  "i'm not lazy i'm in energy saving mode",
  "the audacity of my alarm going off at the time i set it for",
  "i romanticised my life and now i'm broke",
  "my hobby is opening the fridge and closing it again",
  "i don't need therapy i need a week off and better lighting",
  "saying no worries while absolutely having worries",
  "i peaked at pretending to be fine",
  "i keep a list of people who didn't say happy birthday",
  "i'm the problem but i'm also so fun",
  "unemployed but my skincare is consistent",
  "i survive on caffeine and unresolved plot lines",
  "me at 2am rearranging my entire life for no reason",
  "i've been meaning to reply since tuesday. it's tuesday again",
  "my love language is leaving me alone",
  "i'm not high maintenance you're just low effort",
  "crying in the club but the lighting is immaculate",
  "i said i'd start monday. which monday was unspecified",
  "the way i'd thrive with a slightly bigger budget",
  "i don't hold grudges i just have an excellent memory",
  "me needing sleep vs me watching one more episode",
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // Clear any previous fun batch so a re-run replaces rather than accumulates — the same
  // stale-file problem that pushed the main folder to 109 earlier.
  for (const f of fs.readdirSync(OUT).filter((f) => f.startsWith('11_fun_'))) {
    fs.rmSync(path.join(OUT, f), { force: true });
  }

  let n = 0;
  for (let i = 0; i < LINES.length; i += 1) {
    const svg = textPostSVG({ body: LINES[i], style: STYLES[i % STYLES.length] });
    const name = `11_fun_${String(i + 1).padStart(2, '0')}_local.png`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, name));
    n += 1;
  }

  const total = fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
  console.log(`${n} fun posts rendered -> ${OUT}`);
  console.log(`folder total: ${total}`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
