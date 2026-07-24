#!/usr/bin/env node
/**
 * 24 photographic posts — real generations, no typography.
 *
 * Uses the flash image model rather than Pro: none of these contain lettering, so Pro's text
 * fidelity buys nothing, and flash measured ~11s per image with no throttling while Pro was
 * stuck in 429 backoff all evening.
 *
 * Faceless by design, matching the rest of the pack — hands, backs, silhouettes and objects.
 * Faceless lifestyle content also stays reusable across accounts.
 *
 *   node tools/social_pack_real.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { GoogleAuth } = require('google-auth-library');

const CREDS = 'C:/Users/asusg/Desktop/vertex-service-account.json';
const MODEL = 'gemini-3.1-flash-image-preview';
const OUT = path.join('C:/Users/asusg/Downloads', `social-pack-FINAL-${new Date().toISOString().slice(0, 10)}`);
const CONCURRENCY = 2;
const GAP_MS = 1500;

const LOOK = ' Shot on 35mm film, natural grain, soft realistic light, shallow depth of field, '
  + 'muted warm colour grade. Photorealistic, editorial quality. No text, no watermark, no logos.';

const SCENES = [
  ['golden-hour-balcony', 'A woman seen from behind leaning on a city balcony railing at golden hour, wind in her long dark hair, warm low sun flaring across the skyline.'],
  ['coffee-hands', 'Close crop of hands with delicate gold rings wrapped around a warm ceramic mug on a linen tablecloth, steam catching morning light. Only hands visible.'],
  ['mirror-outfit', 'A full-length mirror selfie framing only the body and outfit, head cropped out of frame, soft bedroom light, phone held at waist.'],
  ['bath-candles', 'A bathtub edge with candles, foam and a glass of wine resting on the rim, warm low light, steam in the air. No person.'],
  ['car-window-arm', 'An arm hanging out of a moving car window into warm evening air, blurred road and trees behind, motion blur.'],
  ['bed-morning', 'Rumpled white bedsheets in soft morning light, a coffee cup and open book resting on them, sun stripes through blinds. No person.'],
  ['heels-stairs', 'Black strappy heels on marble stairs, hem of a black dress just entering frame, dramatic side light.'],
  ['rain-window-cafe', 'View through a rain-streaked cafe window, warm interior lights bokeh, a hand holding a cup at the edge of frame.'],
  ['perfume-vanity', 'A vanity table with perfume bottles, gold jewellery and fresh flowers, soft window light, shallow focus.'],
  ['walking-away', 'A woman in a long coat walking away down an empty city street at dusk, seen from behind, streetlights beginning to glow.'],
  ['nails-phone', 'Close crop of manicured hands holding a phone over a marble counter, gold rings, soft daylight. Screen is blank.'],
  ['sunset-beach-legs', 'Legs stretched out on warm sand facing a sunset ocean, taken from the sitting person point of view, golden light.'],
  ['wardrobe-picking', 'Hands reaching into a rail of hanging clothes in a soft-lit walk-in wardrobe, choosing an outfit. Only hands visible.'],
  ['night-city-window', 'Silhouette of a woman standing at a floor-to-ceiling window looking over a night city, seen from behind, room dark.'],
  ['breakfast-flatlay', 'Overhead flat-lay of a breakfast spread — pastries, fruit, iced coffee — on a marble table with a linen napkin.'],
  ['gym-mirror', 'Cropped mirror shot of an athletic outfit in a gym, head out of frame, moody low light, water bottle in hand.'],
  ['sunglasses-car', 'Sunglasses and car keys resting on a leather car seat, sunlight streaking across, shallow focus. No person.'],
  ['reading-corner', 'A cosy armchair by a window with a throw blanket, open book and a cup of tea, late afternoon light. No person.'],
  ['neon-alley', 'A woman seen from behind walking through a neon-lit alley at night, reflections on wet pavement, pink and teal glow.'],
  ['skincare-shelf', 'A bathroom shelf of skincare bottles and a small vase of eucalyptus, soft diffused morning light, clean minimal styling.'],
  ['hotel-window', 'An unmade hotel bed with city view through large windows, morning light, suitcase open on the floor. No person.'],
  ['picnic-blanket', 'Overhead shot of a picnic blanket in a park with fruit, wine glasses and a straw bag, dappled sunlight through leaves.'],
  ['stairs-dress', 'A woman in a flowing dress descending stone stairs, shot from behind and below, dress caught in motion, warm evening light.'],
  ['desk-evening', 'A desk lit by a warm lamp at night — laptop, notebook, candle, cup — cosy focused atmosphere. No person.'],
];

async function getToken() {
  const auth = new GoogleAuth({ keyFile: CREDS, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const { token } = await (await auth.getClient()).getAccessToken();
  if (!token) throw new Error('no access token');
  return token;
}

async function generate(token, projectId, prompt) {
  const url = `https://aiplatform.googleapis.com/v1/projects/${projectId}`
    + `/locations/global/publishers/google/models/${MODEL}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt + LOOK }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:5' } },
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
      if (!img) return { ok: false, reason: data?.candidates?.[0]?.finishReason || 'no image part' };
      return { ok: true, base64: img.inlineData.data };
    }
    if (!(res.status === 429 || res.status >= 500) || attempt === 5) {
      return { ok: false, reason: `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 160)}` };
    }
    const wait = res.status === 429 ? Math.min(12000 * attempt, 50000) : 3000 * attempt;
    console.log(`       ${res.status} — waiting ${Math.round(wait / 1000)}s (${attempt}/5)`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return { ok: false, reason: 'retries exhausted' };
}

(async () => {
  const creds = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
  const token = await getToken();
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`${MODEL} | ${SCENES.length} images -> ${OUT}\n`);

  const queue = SCENES.map(([slug, prompt], i) => ({ slug, prompt, i: i + 1 }));
  let done = 0; const failures = [];

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift(); if (!job) return;
      const name = `12_real_${String(job.i).padStart(2, '0')}_${job.slug}.png`;
      if (fs.existsSync(path.join(OUT, name))) { done += 1; continue; }   // resume
      try {
        const r = await generate(token, creds.project_id, job.prompt);
        if (!r.ok) { failures.push(`${job.slug}: ${r.reason}`); console.log(`  FAIL ${job.slug} — ${r.reason}`); }
        else { fs.writeFileSync(path.join(OUT, name), Buffer.from(r.base64, 'base64')); done += 1; console.log(`  ok   ${name}`); }
      } catch (e) { failures.push(`${job.slug}: ${e.message}`); console.log(`  FAIL ${job.slug} — ${e.message}`); }
      if (queue.length) await new Promise((r) => setTimeout(r, GAP_MS));
    }
  });
  await Promise.all(workers);

  console.log(`\n${done}/${SCENES.length} generated -> ${OUT}`);
  if (failures.length) { console.log(`${failures.length} failed:`); failures.slice(0, 10).forEach((f) => console.log('   ' + f)); }
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
