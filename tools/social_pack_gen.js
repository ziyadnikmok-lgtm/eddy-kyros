#!/usr/bin/env node
/**
 * Generate the 10-concept social pack via Vertex Imagen, straight to a Downloads folder.
 *
 * Standalone on purpose: it borrows the request shape proven in
 * server/services/geminiVertexService.js but does not boot the app, so it needs no port, no
 * session and no better-sqlite3 (which is built for Electron's ABI and cannot load under plain
 * node on this machine).
 *
 * Usage:
 *   node tools/social_pack_gen.js --test            one image from the riskiest concept
 *   node tools/social_pack_gen.js --per 8           the full run (10 concepts x 8)
 *   node tools/social_pack_gen.js --only 1,2,3      re-run just those concepts
 */
const fs = require('node:fs');
const path = require('node:path');
const { GoogleAuth } = require('google-auth-library');

const CREDS = 'C:/Users/asusg/Desktop/vertex-service-account.json';
const LOCATION = 'us-central1';           // imagen is regional; 'global' has no regional host
const MODEL = 'imagen-3.0-generate-002';
const OUT_ROOT = 'C:/Users/asusg/Downloads';
const CONCURRENCY = 1;                    // per-minute Imagen quota: parallel calls just 429
const GAP_MS = 7000;                      // deliberate pacing between requests

// Imagen accepts only these. 4:5 is not one of them — 3:4 is the closest portrait crop and is
// what the app already falls back to, so the pack stays consistent with everything else.
const RATIO = { SQUARE: '1:1', PORTRAIT: '3:4', TALL: '9:16' };

// Shared wording. Imagen renders SHORT text far more reliably when the text is isolated in
// quotes and the surrounding scene is described plainly, so every text concept follows that
// shape rather than burying the string mid-sentence.
const UI_POST = 'Clean white social media post graphic, minimal flat design, generous white space, '
  + 'small circular blurred profile avatar top-left, small grey username line, '
  + 'thin light-grey divider, small row of simple outline icons (heart, speech bubble, arrow, bookmark) along the bottom. '
  + 'Crisp modern sans-serif typography, high contrast, perfectly legible, correctly spelled, no watermark.';

const CONCEPTS = [
  // 1, 2, 3 and 10 are typeset in social_pack_text.js — Imagen garbles exact sentences.
  { id: 4, slug: 'mannequin-outfit', ratio: RATIO.PORTRAIT,
    prompt: 'Professional product photograph of a white shimmer two-piece outfit with sheer draped sleeves '
      + 'displayed on a headless mannequin. Solid black background, soft directional side lighting, '
      + 'gentle fabric sheen, crisp detail on the sheer drape. Studio e-commerce look. No person, no face, no text.' },
  { id: 5, slug: 'flatlay-outfit', ratio: RATIO.PORTRAIT,
    prompt: 'Overhead flat-lay photograph of a black going-out dress laid flat on beige linen fabric, '
      + 'styled with gold hoop earrings, a small handbag and heels arranged beside it. '
      + 'Soft natural daylight, subtle shadows, editorial styling. No person, no text.' },
  // 6 and 7: background only. The quote box is composited afterwards so the words are correct.
  { id: 6, slug: 'anime-quote-orb', ratio: RATIO.PORTRAIT, overlay: 'the kid inside you deserves love',
    prompt: '1990s retro anime still frame of a girl, purple and pink gradient sky, a softly glowing orb, '
      + 'VHS scanlines and heavy film grain, nostalgic cel-shaded animation style, empty space in the lower third. No text.' },
  { id: 7, slug: 'anime-quote-rain', ratio: RATIO.PORTRAIT, overlay: 'i hope it finds you when you stop looking',
    prompt: '1990s retro anime still frame of a girl looking out of a rainy window, teal and violet colour palette, '
      + 'raindrops on the glass, heavy VHS grain and scanlines, melancholic cel-shaded animation style, empty space in the lower third. No text.' },
  { id: 8, slug: 'night-car', ratio: RATIO.PORTRAIT,
    prompt: 'Photograph from inside a car at night, warm dashboard glow, blurred bokeh city lights through '
      + 'the windshield, rain streaking down the glass, moody cinematic colour grade, 35mm filmic grain, '
      + 'shallow depth of field. No people, no text.' },
  { id: 9, slug: 'coffee-stilllife', ratio: RATIO.PORTRAIT,
    prompt: 'Still life photograph of an iced coffee in a clear cup on a white marble table, '
      + 'a hand with neat manicured nails and delicate gold rings resting on the cup, '
      + 'soft morning window light, warm film photography look, shallow depth of field. '
      + 'Only the hand is visible - no face, no person, no text.' },
];


const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const isTest = args.includes('--test');
const perConcept = isTest ? 1 : parseInt(flag('per', '8'), 10);
const onlyIds = flag('only', '') ? flag('only', '').split(',').map((n) => parseInt(n, 10)) : null;

async function getToken() {
  const auth = new GoogleAuth({
    keyFile: CREDS,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('No access token returned — check the service account key.');
  return token;
}

async function generate(token, projectId, concept, variation) {
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}`
    + `/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;
  const body = {
    // Variation comes from sampleCount across separate calls rather than a seed string appended
    // to the prompt: Imagen treats stray tokens as content, and "variation 7" was ending up
    // rendered inside the text posts.
    instances: [{ prompt: concept.prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: concept.ratio,
      safetyFilterLevel: 'block_few',
      personGeneration: 'allow_adult',
    },
  };

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      const p = Array.isArray(data.predictions) ? data.predictions[0] : null;
      const b64 = p?.bytesBase64Encoded || p?.image?.bytesBase64Encoded;
      // A safety block returns 200 with no image. Reporting it as "no image" rather than a
      // generic failure matters — it means the PROMPT needs changing, not a retry.
      if (!b64) return { ok: false, reason: p?.raiFilteredReason || 'no image returned (likely safety filtered)' };
      return { ok: true, base64: b64 };
    }

    const msg = JSON.stringify(data).slice(0, 300);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === 6) return { ok: false, reason: `HTTP ${res.status}: ${msg}` };
    // Quota refills per minute, so waiting seconds is pointless — climb toward a full minute.
    const waitMs = res.status === 429 ? Math.min(20000 * attempt, 75000) : 4000 * attempt;
    console.log(`       429 — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/6)`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return { ok: false, reason: 'exhausted retries' };
}

(async () => {
  const creds = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
  const token = await getToken();
  console.log(`auth ok — project ${creds.project_id}, model ${MODEL}, region ${LOCATION}\n`);

  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.join(OUT_ROOT, isTest ? `social-pack-TEST-${stamp}` : `social-pack-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  let list = CONCEPTS;
  if (onlyIds) list = list.filter((c) => onlyIds.includes(c.id));
  if (isTest) list = [CONCEPTS[0], CONCEPTS[3]];   // one text-heavy, one pure photo

  const jobs = [];
  for (const c of list) {
    for (let v = 1; v <= perConcept; v += 1) jobs.push({ c, v });
  }

  console.log(`${jobs.length} images -> ${outDir}\n`);
  const failures = [];
  let done = 0;

  const queue = [...jobs];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) return;
      const { c, v } = job;
      const label = `${String(c.id).padStart(2, '0')}_${c.slug}_v${String(v).padStart(2, '0')}`;
      const destDir = path.join(outDir, `${String(c.id).padStart(2, '0')}_${c.slug}`);
      if (fs.existsSync(path.join(destDir, `${label}.png`))) { done += 1; continue; }
      try {
        const r = await generate(token, creds.project_id, c, v);
        if (!r.ok) { failures.push(`${label}: ${r.reason}`); console.log(`  FAIL ${label} — ${r.reason}`); }
        else {
          const dir = path.join(outDir, `${String(c.id).padStart(2, '0')}_${c.slug}`);
          fs.mkdirSync(dir, { recursive: true });
          let buf = Buffer.from(r.base64, 'base64');
          if (c.overlay) {
            const sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'));
            const { quoteBoxSVG } = require('./social_pack_text.js');
            const meta = await sharp(buf).metadata();
            buf = await sharp(buf)
              .composite([{ input: quoteBoxSVG(c.overlay, meta.width, meta.height), top: 0, left: 0 }])
              .png().toBuffer();
          }
          fs.writeFileSync(path.join(dir, `${label}.png`), buf);
          done += 1;
          console.log(`  ok   ${label}`);
        }
      } catch (err) {
        failures.push(`${label}: ${err.message}`);
        console.log(`  FAIL ${label} — ${err.message}`);
      }
      if (queue.length) await new Promise((r) => setTimeout(r, GAP_MS));
    }
  });
  await Promise.all(workers);

  console.log(`\n${done}/${jobs.length} saved -> ${outDir}`);
  if (failures.length) {
    console.log(`${failures.length} failed:`);
    for (const f of failures.slice(0, 15)) console.log('   ' + f);
  }
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
