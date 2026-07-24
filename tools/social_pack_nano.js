#!/usr/bin/env node
/**
 * Same social pack, generated with Nano Banana Pro (gemini-3-pro-image-preview) instead of Imagen.
 *
 * Three reasons this exists alongside social_pack_gen.js:
 *   1. Imagen 3 cannot typeset. It rendered "i stopped explaining myself..." as
 *      "I stopped explaiining myself myself a my and my lifee quieıt quiet quet in a a good way?"
 *      Nano Banana Pro renders text properly, so the text concepts can be real generations.
 *   2. Different endpoint (:generateContent, not :predict) means a different quota pool — the
 *      Imagen run died at 37/48 on RESOURCE_EXHAUSTED.
 *   3. It supports 4:5 natively. Imagen does not, and was silently cropping to 3:4.
 *
 *   node tools/social_pack_nano.js --test       one text concept, the acid test
 *   node tools/social_pack_nano.js --per 8      full run
 */
const fs = require('node:fs');
const path = require('node:path');
const { GoogleAuth } = require('google-auth-library');

const CREDS = 'C:/Users/asusg/Desktop/vertex-service-account.json';
const LOCATION = 'global';                 // gemini image models are served from the global host
const MODEL = process.argv.includes('--flash') ? 'gemini-3.1-flash-image-preview' : 'gemini-3-pro-image-preview';
const OUT_ROOT = 'C:/Users/asusg/Downloads';
const CONCURRENCY = process.argv.includes('--flash') ? 2 : 1;
const GAP_MS = process.argv.includes('--flash') ? 1500 : 18000;  // flash has its own, roomier quota

const POST_UI = 'Square-ish vertical social media post graphic on a plain white background. '
  + 'Top-left: a small circular profile photo, heavily blurred so no face is identifiable. '
  + 'Beside it the small grey handle text "Cshquoted · Just now". '
  + 'Centred in the middle of the frame, large bold black lowercase sans-serif text reading exactly: ';
const POST_TAIL = ' Below, a thin light-grey divider and a single row of exactly four simple black outline icons: '
  + 'heart, speech bubble, paper-plane arrow, bookmark. Nothing else. No extra text, no watermark, '
  + 'no duplicated lines, no page dots. Spelling must be exact and no word may be repeated. Render the sentence once, verbatim.';

const CONCEPTS = [
  { id: 1, slug: 'text-dating', ratio: '4:5',
    prompt: `${POST_UI}"i stopped explaining myself and my life got quiet in a good way".${POST_TAIL}` },
  { id: 2, slug: 'text-self-worth', ratio: '4:5',
    prompt: `${POST_UI}"nah i'm not hard to love you were just lazy" set on two lines.${POST_TAIL}` },
  { id: 3, slug: 'text-tired', ratio: '4:5',
    prompt: `${POST_UI}"me pretending i'm not exhausted for the 4th day straight".${POST_TAIL}` },
  { id: 4, slug: 'mannequin-outfit', ratio: '3:4',
    prompt: 'Professional product photograph of a white shimmer two-piece outfit with sheer draped sleeves '
      + 'on a headless mannequin. Solid black background, soft directional side light, gentle fabric sheen. '
      + 'Studio e-commerce look. No person, no face, no text.' },
  { id: 5, slug: 'flatlay-outfit', ratio: '3:4',
    prompt: 'Overhead flat-lay photograph of a black going-out dress laid flat on beige linen, styled with '
      + 'gold hoop earrings, a small handbag and heels beside it. Soft natural daylight, editorial styling. '
      + 'No person, no text.' },
  { id: 6, slug: 'anime-quote-orb', ratio: '4:5',
    prompt: '1990s retro anime still frame of a girl, purple and pink gradient sky, a softly glowing orb, '
      + 'VHS scanlines and heavy film grain, nostalgic cel-shaded animation. In the lower third, a small '
      + 'rounded pastel text box containing exactly the sentence: "the kid inside you deserves love". '
      + 'Clean legible lettering, exact spelling, no other text.' },
  { id: 7, slug: 'anime-quote-rain', ratio: '4:5',
    prompt: '1990s retro anime still frame of a girl looking out of a rainy window, teal and violet palette, '
      + 'raindrops on the glass, heavy VHS grain, melancholic cel-shaded animation. In the lower third, a small '
      + 'rounded pastel text box containing exactly the sentence: "i hope it finds you when you stop looking". '
      + 'Clean legible lettering, exact spelling, no other text.' },
  { id: 8, slug: 'night-car', ratio: '4:5',
    prompt: 'Photograph from inside a car at night, warm dashboard glow, blurred bokeh city lights through the '
      + 'windshield, rain streaking down the glass, moody cinematic grade, 35mm filmic grain. No people, no text.' },
  { id: 9, slug: 'coffee-stilllife', ratio: '4:5',
    prompt: 'Still life photograph of an iced coffee in a clear cup on a white marble table, a hand with neat '
      + 'manicured nails and delicate gold rings resting on the cup, soft morning window light, warm film look. '
      + 'Only the hand is visible — no face, no person, no text.' },
  { id: 10, slug: 'notes-app', ratio: '4:5',
    prompt: 'A realistic iPhone Notes app screenshot in dark mode, filling the frame on a plain dark background. '
      + 'The note title reads exactly "things i\'m not doing in 2026". Below it exactly three short lowercase '
      + 'list lines, casual and believable. Clean iOS interface typography, exact spelling, no watermark, '
      + 'no extra interface chrome.' },
];

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const isTest = args.includes('--test');
const per = isTest ? 1 : parseInt(flag('per', '8'), 10);
const onlyIds = flag('only', '') ? flag('only', '').split(',').map(Number) : null;

async function getToken() {
  const auth = new GoogleAuth({ keyFile: CREDS, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const { token } = await (await auth.getClient()).getAccessToken();
  if (!token) throw new Error('no access token');
  return token;
}

async function generate(token, projectId, c) {
  const url = `https://aiplatform.googleapis.com/v1/projects/${projectId}`
    + `/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: c.prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: c.ratio },
    },
  };

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const img = parts.find((p) => p.inlineData?.data);
      if (!img) {
        // A refusal or safety stop comes back 200 with text instead of an image — surfacing the
        // reason matters, because retrying an unchanged prompt will fail identically.
        const why = data?.candidates?.[0]?.finishReason
          || parts.find((p) => p.text)?.text?.slice(0, 120)
          || 'no image part in response';
        return { ok: false, reason: why };
      }
      return { ok: true, base64: img.inlineData.data };
    }

    const msg = JSON.stringify(data).slice(0, 220);
    if (!(res.status === 429 || res.status >= 500) || attempt === 5) {
      return { ok: false, reason: `HTTP ${res.status}: ${msg}` };
    }
    const wait = res.status === 429 ? Math.min(15000 * attempt, 60000) : 3000 * attempt;
    console.log(`       ${res.status} — waiting ${Math.round(wait / 1000)}s (${attempt}/5)`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return { ok: false, reason: 'retries exhausted' };
}

(async () => {
  const creds = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
  const token = await getToken();
  console.log(`auth ok — ${creds.project_id} | ${MODEL} | ${LOCATION}\n`);

  const stamp = new Date().toISOString().slice(0, 10);
  const flat = args.includes('--flat');
  const outDir = flat
    ? path.join(OUT_ROOT, `social-pack-FINAL-${stamp}`)
    : path.join(OUT_ROOT, isTest ? `nano-TEST-${stamp}` : `social-pack-nano-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  let list = CONCEPTS;
  if (onlyIds) list = list.filter((c) => onlyIds.includes(c.id));
  if (isTest) list = [CONCEPTS[0], CONCEPTS[9]];   // the two hardest: quoted text, and a UI screenshot

  const queue = [];
  for (const c of list) for (let v = 1; v <= per; v += 1) queue.push({ c, v });
  console.log(`${queue.length} images -> ${outDir}\n`);

  let done = 0; const failures = [];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift(); if (!job) return;
      const { c, v } = job;
      const label = `${String(c.id).padStart(2, '0')}_${c.slug}_v${String(v).padStart(2, '0')}`;
      const dir = flat ? outDir : path.join(outDir, `${String(c.id).padStart(2, '0')}_${c.slug}`);
      fs.mkdirSync(dir, { recursive: true });
      // Flat mode matches the delivery naming (concept_index_model.png) and resumes by counting
      // what already exists for this concept, whichever model produced it.
      const prefix = `${String(c.id).padStart(2, '0')}_${c.slug}`;
      const outName = flat ? `${prefix}_${String(v).padStart(2, '0')}_nano.png` : `${label}.png`;
      if (flat) {
        const have = fs.readdirSync(dir).filter((f) => f.startsWith(prefix + '_')).length;
        if (have >= per) { done += 1; continue; }
      } else if (fs.existsSync(path.join(dir, outName))) { done += 1; continue; }
      try {
        const r = await generate(token, creds.project_id, c);
        if (!r.ok) { failures.push(`${label}: ${r.reason}`); console.log(`  FAIL ${label} — ${r.reason}`); }
        else {
          fs.writeFileSync(path.join(dir, outName), Buffer.from(r.base64, 'base64'));
          done += 1; console.log(`  ok   ${label}`);
        }
      } catch (e) { failures.push(`${label}: ${e.message}`); console.log(`  FAIL ${label} — ${e.message}`); }
      if (queue.length) await new Promise((r) => setTimeout(r, GAP_MS));
    }
  });
  await Promise.all(workers);

  console.log(`\n${done} saved -> ${outDir}`);
  if (failures.length) { console.log(`${failures.length} failed:`); failures.slice(0, 12).forEach((f) => console.log('   ' + f)); }
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
