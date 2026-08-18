import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { gallery as galleryApi, jobs as jobsApi } from '../services/api';
import { createEddyCollection } from '../lib/eddyCollectionStore';
import { useApp } from '../context/AppContext';
import { Card, Btn, Select, Textarea, Toggle, Badge, Spinner } from '../components/UI';
import CompareSlider from '../components/CompareSlider';
import { SEEDREAM_ASPECT_RATIOS, SEEDREAM_RESOLUTIONS, SEEDREAM_MAX_IMAGES, seedreamCost } from '../config/photoModes';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { consumeSourceHandoff, rememberPhotoMatchTab, PHOTO_MATCH_HANDOFF_KEY } from '../lib/sourceHandoff';
import { detectAspectRatio } from '../lib/detectAspectRatio';
import { NSFW_PRESETS, nudeState, NUDE_LINE } from '../lib/nsfwPresets';
import { createPageStore } from '../lib/pageStateStore';
import { queuedSeedreamEdit, waitForQueuedJob, reconcileUnfiled } from '../lib/generationQueue';
import { cn } from '../lib/utils';
import { autoBlurFace, findFace, blurFound } from '../lib/autoBlurFace';
import { poolAvailable, poolSize, runBatch } from '../lib/facePool';
import ManualBlurModal from '../components/ManualBlurModal';

const ASPECT_OPTIONS = [{ value: 'auto', label: 'Auto (match source)' }, ...SEEDREAM_ASPECT_RATIOS.map((r) => ({ value: r, label: r }))];
const RES_OPTIONS = SEEDREAM_RESOLUTIONS.map((r) => ({ value: r, label: r }));

/**
 * Where a finished match is filed.
 *
 * The two collections behind the tabs of the same name: Library is `eddy-library`, Base Library is
 * `eddy-base`. Chosen BEFORE generating rather than moved afterwards, because a batch of thirty
 * that lands in the wrong tab is thirty drags.
 */
const DESTINATIONS = [
  { value: 'eddy-library', label: 'Library' },
  { value: 'eddy-base', label: 'Base Library' },
];

// Each job sends exactly one source photo, so the character gets the rest of Seedream's budget.
const MAX_CHAR_IMAGES = SEEDREAM_MAX_IMAGES - 1;
/**
 * 500. Raised from 50 (owner, 2026-08-17: "more 500 can get blurred at once"), and from 12 before
 * that — a Pinterest send arrives as one batch of whatever you ticked.
 *
 * MEASURED before raising it, because the two obvious worries pull in opposite directions:
 *   memory  — 500 photos at a typical 239 KB is ~0.16 GB of base64 in state. Fine.
 *   time    — ~945ms of cascade sweep each, which on the main thread is EIGHT MINUTES frozen.
 * So the cap was never the real limit; the single thread was. Detection and blurring now run on a
 * worker pool (lib/facePool.js), which is what makes this number honest — about eighty seconds for
 * five hundred, with the page still usable and a counter running.
 */
const MAX_SOURCES = 500;

/**
 * HOW MANY RENDER AT ONCE. Raised 4 -> 12 / 6 (owner asked for "whatever WaveSpeed allows",
 * 2026-08-11).
 *
 * ⚠️ THE REAL CEILING IS 6, AND IT IS NOT OURS TO SET. Each job holds one HTTP request open for the
 * whole render, and Chromium allows 6 sockets per host over HTTP/1.1 -- everything above that waits
 * in the browser's network queue, invisible to us. Measured, not assumed: 38,105 generation
 * requests in app.log, max concurrent overlap **6**, even though Eddy has been configured for 12
 * lanes all along.
 *
 * So these numbers set this page's SHARE of those 6 when something else is running, and let it use
 * all 6 when it is alone. Going higher buys nothing. The only way past 6 is to stop holding the
 * request open: submit -> job id -> poll, which turns one 45-second socket into a handful of
 * millisecond ones. That is a server change, and it is the thing to build when 6 is the wall.
 *
 * Matched to Eddy's lanes per engine rather than kept deliberately smaller: the owner runs this
 * page on its own, and starving it to protect a batch that is not running cost half the throughput.
 */
// Both were pinned to Chromium's six-sockets-per-host, because a render held one for its whole
// duration. On the queue an enqueue is a short POST and the wait is a cheap poll, so these match the
// server's MAX_INFLIGHT and the server does the real limiting.
const LANES = { seedream: 300, nano2: 300 };
const SPEND_KEY = 'kyros.photoMatchSeedream.sessionSpend';

// Seedream enforces an undocumented prompt-length cap ("The text length cannot exceed the
// maximum limit" — a 422 that kills the whole batch). The OpenAPI spec declares no maxLength
// on `prompt`, so the ceiling is ByteDance's and invisible. Measured: 420 chars works, 5,386
// fails. Ported wholesale, the Gemini route's rule list blew straight past it and every
// generation failed before it started — so this carries Gemini's SUBSTANCE, not its length.
//
// What survived the cut, and why:
//  - Roles addressed by image POSITION. The model has no idea who "Grace" is; it sees images.
//  - Identity FIRST, scene LAST — Seedream keeps whoever is in image 1 (Outfit Swap proves it).
//  - Body/chest named explicitly. Gemini states these as base rules; leaving them to an opt-in
//    chip is why the figure was ignored.
//  - The garment yields to her body. "Copy the outfit exactly" otherwise re-imposes the
//    stand-in's chest, because the garment is cut to it.
// Dropped: Gemini's four near-identical REQUIRED lines, and the scene list that was being
// spelled out twice.
const SEEDREAM_PROMPT_BUDGET = 3000;

/**
 * NANO BANANA 2 DOES NOT HAVE SEEDREAM'S CAP.
 *
 * The 3,000 above exists because ByteDance 422s on a long prompt — "The text length cannot exceed
 * the maximum limit", which kills the whole batch before an image exists. It was being applied to
 * BOTH engines, so a Nano run got a prompt amputated for a limitation Nano does not have:
 * wavespeedService.js says outright that WaveSpeed documents no prompt-length cap for
 * `google/nano-banana-2/edit`.
 *
 * 8,000 is a safety rail, not a measured ceiling — nothing has been observed failing. It exists so
 * a runaway prompt cannot be sent unbounded; the real prompt is a third of it.
 */
const NANO2_PROMPT_BUDGET = 8000;

/**
 * ONE PHOTOGRAPH, NOT A CONTACT SHEET.
 *
 * Measured on a real result (gallery 52cd1c0c, 2026-08-18): a run with THREE identity references
 * came back as one wide image holding THREE near-identical panels of her, side by side. The source
 * photo has one woman in it and every instruction in the prompt is written about one photograph —
 * but nothing anywhere SAYS "one frame", so the model mirrored the reference count into the layout.
 * The owner's word for it: "check last 3 images generated please fix the prompt wtf".
 *
 * The lever is the last sentence. Both engines take several images as identity evidence, and both
 * will happily read "here are three pictures" as "make three pictures" unless told otherwise.
 *
 * It goes at the very tail, after the chips, because that is where both engines weight hardest —
 * the same reason the identity lock sits where it does.
 */
function singleFrameLock(people) {
  const n = people > 1 ? people : 1;
  const who = n > 1 ? `exactly ${['', 'one', 'two', 'three', 'four', 'five'][n] || n} women` : 'exactly ONE woman';
  return `ONE PHOTOGRAPH: a SINGLE frame containing ${who}, shot in one take. `
    + 'No grid, collage, contact sheet, split screen, side-by-side panels, before/after, film strip '
    + 'or repeated figures. The number of reference images is NOT a number of people or panels.';
}

/**
 * RETRY WITH A DIFFERENT PROMPT — the re-roll behind "Retry" (owner, 2026-08-18: "when i select
 * the result from the picture that are not good i need a retry bottum … but it try a differnet
 * prompt").
 *
 * Regenerate sends the identical request, which is right for a REFUSAL — that is a roll, not a
 * verdict. It is the wrong tool for a picture that came back ugly: the same words get you the same
 * kind of ugly, and you pay for it again. So a retry keeps every instruction and adds a block at
 * the very tail — where both engines weight hardest — that says the last attempt was rejected and
 * names the thing to do better.
 *
 * FOUR of them, cycled by attempt number, each aimed at a different way these pictures go wrong:
 * her face drifting off the references, plastic skin, mangled hands, and flat phone-flash light.
 * Pressing retry four times therefore asks four different questions instead of shouting the same
 * one, which is the entire point of a retry button.
 */
const RETRY_NUDGES = [
  'RETRY — the previous attempt at this exact request was rejected. Every instruction above still '
  + 'applies; do not reproduce that attempt. Her face must match the reference photos more closely '
  + 'than it did: bone structure, eye shape and spacing, nose, lip shape and jawline. Render the '
  + 'face sharply and in full detail.',
  'RETRY — the previous attempt at this exact request was rejected for looking artificial. Every '
  + 'instruction above still applies. Render skin as real photographed skin: visible pores, fine '
  + 'texture, natural oil and sheen, real subsurface tone variation, faint imperfections. No '
  + 'plastic, waxy, smoothed, airbrushed or beauty-filtered surfaces.',
  'RETRY — the previous attempt at this exact request was rejected for broken anatomy. Every '
  + 'instruction above still applies. Give particular care to hands and fingers (five per hand, '
  + 'correct length and joints), to how limbs connect at shoulder and hip, and to the way the '
  + 'garment sits on the body where it meets and folds.',
  'RETRY — the previous attempt at this exact request was rejected for looking flat. Every '
  + 'instruction above still applies. Photograph it properly: directional light with real falloff '
  + 'and shadow shape, believable depth of field, natural lens character. No flat on-camera flash '
  + 'and no evenly-lit CGI render.',
];

/**
 * Bolt a retry block onto a finished prompt without blowing the engine's cap.
 *
 * Seedream 422s on an over-long prompt and the whole job dies, so when there is no room the BASE
 * text gives, not the nudge — a retry whose retry instruction got trimmed off is just a repeat.
 */
function withRetryNudge(prompt, attempt, budget) {
  const nudge = RETRY_NUDGES[(Math.max(1, attempt) - 1) % RETRY_NUDGES.length];
  const room = budget - nudge.length - 2;
  const base = prompt.length > room ? prompt.slice(0, Math.max(0, room)) : prompt;
  return `${base}\n\n${nudge}`;
}

/**
 * A SOURCE SHOT FROM BEHIND, and the failure it exists to stop.
 *
 * The rest of this prompt demands a face: "match exactly: face, head shape, jaw", "render her face
 * sharply", "faces, hair, skin and whole body". Against a back-facing photo that is an instruction
 * to produce something the photo does not contain, and the model resolves it the only way it can —
 * it turns her around. The pose the photo was chosen for is gone.
 *
 * Owner, 2026-08-16: "sometimes face won't appear in the source image and we want that, or model
 * face don't appear too." No face in, no face out.
 *
 * SHORTER THAN EDDY'S ON PURPOSE. EddyGeneratePage's BACK_VIEW_BODY_SCOPE says the same thing at
 * ~700 characters, most of it scoping bust and outfit wording that belongs to Eddy's prompt and
 * does not exist here. Photo Match runs against ByteDance's ~3,000-character cap with a pair
 * already at 2,989, so importing that paragraph would push the identity lock out of the prompt to
 * restate rules this page never wrote. The load-bearing sentence — do not rotate her — is kept
 * verbatim in spirit, and the opening marker matches Eddy's so both read as one rule.
 */
const BACK_VIEW_LINE = (src) => `BACK VIEW — HER FACING DIRECTION IS FIXED: ${src} is shot from BEHIND. Her back and shoulders face the camera, exactly as it shows. Do NOT turn, twist, rotate or re-angle her toward the camera, do NOT bring her face or chest into frame, and do NOT change the pose to make either visible.`;

/**
 * The house lighting, on every Photo Match prompt (owner, 2026-08-13). Verbatim, because it was
 * given verbatim — the wording is the request, not a paraphrase of one.
 */
/**
 * HER BUILD — a standing fact about the character, NOT a change to her.
 *
 * Ported from Eddy, and the distinction from the BODY chips is the whole point. A chip is a
 * deliberate enlargement, so it sets allowBodyChange and STANDS DOWN the bust-preservation locks —
 * right for 'make her bigger than her photos', wrong for 'this is what she looks like'. A character
 * whose references ALREADY show the target build was losing her strongest protection just to state
 * a size she already had (owner, 2026-08-06: Grace is large, another model is medium, and each
 * wants her own build HELD, not altered).
 *
 * So these never touch allowBodyChange. They ride WITH the locks, naming the size the locks are
 * holding — which is exactly what a lock cannot do on its own, because 'the size in her references'
 * is unfalsifiable to a model that also has a different woman's body in the payload.
 *
 * 'auto' emits nothing: the locks alone, i.e. the behaviour before this existed.
 *
 * BACK-VIEW VARIANTS, not the same sentence. Every front line names the bust and, at the larger
 * sizes, 'deep natural cleavage' — none of which a shot from behind can show. Feeding it anyway
 * recreates the exact failure the back-view lock exists to stop: the only way to satisfy cleavage
 * wording is to twist her toward the camera, destroying the pose. Suppressing it entirely is worse,
 * because hips, waist and back width DO read from behind and are precisely what drifts toward the
 * stand-in — so the back variants keep the anchoring job using only what the camera can see.
 */
const BUILD_OPTIONS = [
  { value: 'auto', label: 'From her photos', text: '', backText: '' },
  { value: 'petite', label: 'Petite',
    text: 'She is petite and slim with a small bust — that is her natural build, exactly as in her reference images, and it is preserved, not changed.',
    backText: 'She is petite and slim with narrow hips and a slender back — that is her natural build, exactly as in her reference images, and it is preserved, not changed.' },
  { value: 'medium', label: 'Medium',
    text: 'She has a medium, natural bust and an average build — that is her natural figure, exactly as in her reference images, and it is preserved, not changed.',
    backText: 'She has an average, natural build with proportionate hips and waist — that is her natural figure, exactly as in her reference images, and it is preserved, not changed.' },
  { value: 'full', label: 'Full',
    text: 'She has a full, shapely bust and curvy figure — that is her natural build, exactly as in her reference images, and it is preserved, not changed.',
    backText: 'She has a full, curvy figure with shapely hips and a narrow waist — that is her natural build, exactly as in her reference images, and it is preserved, not changed.' },
  { value: 'large', label: 'Large',
    text: 'She has a LARGE, heavy, full bust with deep natural cleavage and a curvy figure — that is her natural build, exactly as in her reference images, and it is preserved, not changed. Never render her smaller, flatter or more athletic than this.',
    backText: 'She has a full, curvy figure with wide shapely hips and a narrow waist — that is her natural build, exactly as in her reference images, and it is preserved, not changed. Never render her slimmer or more athletic than this.' },
  { value: 'verylarge', label: 'Very large',
    text: 'She has a VERY LARGE, heavy, extremely full bust — big, weighty and rounded, sitting wide on her chest with deep natural cleavage between them — and a strongly curvy figure. That is her natural build, exactly as in her reference images, and it is preserved, not changed. Never render her smaller, flatter, perkier or more athletic than this.',
    backText: 'She has a strongly curvy figure with wide shapely hips and a narrow waist — that is her natural build, exactly as in her reference images, and it is preserved, not changed. Never render her slimmer or more athletic than this.' },
];

/**
 * A BUST INSTRUCTION WITH NSFW OFF MUST HAPPEN UNDER THE CLOTHES.
 *
 * Ported from Eddy's CLOTHED_FIGURE_LOCK. The Body chips say 'deep cleavage' and 'straining the
 * garment', and a model asked for a bigger bust in a dressed photo will very often satisfy it by
 * opening, lowering or removing the top — which is not what was asked and, with NSFW off, not what
 * anyone wanted. Photo Match had the chips and none of this lock.
 *
 * Appended AFTER the chips by the caller, because the chips are appended after the base prompt and
 * Seedream weights the tail hardest — stated before them, the lock loses to the very text it exists
 * to bound.
 */
const CLOTHED_FIGURE_LOCK = 'CLOTHED — OVERRIDES THE BUST INSTRUCTION ABOVE: she stays FULLY DRESSED. The garment covers her breasts and torso exactly as much as it already does — neckline and coverage unchanged. Any fuller bust or figure shows ONLY as fabric stretching and straining over a fuller shape underneath. Do NOT open, lower, lift, unzip, pull aside or remove any clothing, and do NOT expose breasts, nipples or areola. Read "cleavage" as the silhouette THROUGH the clothing, never as bare skin.';
const LIGHTING_LINE = 'Lighting: Lighting is soft and diffused lighting, glowing naturally on her skin';

/**
 * THE RESULTS PANEL IS A PERSISTENT WORKING QUEUE, not run state.
 *
 * Eddy's has been one for months: a picture stays on screen through reloads and navigation until it
 * is removed. Photo Match's lived in React state alone, so leaving the tab threw the whole run away
 * and the column was empty again on return (owner, 2026-08-13: "make it save the images there
 * unless I delete").
 *
 * WHAT IS PERSISTED, and nothing else: the light fields needed to redraw a tile. The picture is
 * read back from the SAVED server copy via galleryId — never the base64, which would blow
 * IndexedDB the way it once blew localStorage. The source photo is kept only as a small JPEG for
 * the before/after slider, because the full-size source is the biggest thing on the page.
 */
const RESULT_STORES = {
  // The SD tab keeps the original key, so nobody's existing panel empties on upgrade.
  sd: createPageStore('photomatch-results-v1'),
  nb2: createPageStore('photomatch-nb2-results-v1'),
};

/**
 * The picture behind a tile, wherever the tile came from.
 *
 * A tile from THIS run knows its galleryId; one loaded back out of a library knows its url. Both
 * are the same server file, so everything downstream — the slider, the move, the dedupe — asks
 * here rather than checking which kind it is.
 */
function urlOfJob(j) {
  return j.url || (j.galleryId ? galleryApi.imageUrl(j.galleryId) : '');
}

/**
 * The picture to SHOW for a job — server copy first, raw bytes only as a fallback.
 *
 * The two render sites used to branch on `job.result` being truthy and then read
 * result.base64Data from it. That held while every result arrived inline, and broke the moment a
 * render came back through the queue: the result object is there, base64Data is not, and the tile
 * renders `data:undefined;base64,undefined` — a broken image for a picture that generated fine.
 *
 * Asking for the server copy first is also simply better: it is the same file, it is already on
 * disk, and it does not hold megabytes of base64 in memory per tile.
 */
function resultSrc(j) {
  const server = urlOfJob(j);
  if (server) return server;
  return j.result?.base64Data ? `data:${j.result.mimeType || 'image/png'};base64,${j.result.base64Data}` : '';
}

/** The persisted shape of one finished match. Anything not named here is deliberately dropped. */
function liteJob(j) {
  return {
    id: j.id,
    status: j.status === 'done' ? 'done' : j.status,
    galleryId: j.galleryId || null,
    url: j.url || '',
    doneAt: j.doneAt || 0,
    engine: j.engine || '',
    // Survives a reload. Dropped here, the '(fallback)' marker lasted only until the panel was
    // restored, and a Seedream picture then sat on the NB2 tab looking like an ordinary run —
    // exactly the silence the marker exists to break.
    fellBack: !!j.fellBack,
    cost: typeof j.cost === 'number' ? j.cost : null,
    resolution: j.resolution || '',
    mode: j.mode || '',
    faceless: !!j.faceless,
    // Where this picture lives in a collection, when it was read back out of one — so Delete can
    // remove the row it actually came from rather than guessing.
    libRowId: j.libRowId || null,
    mimeType: j.result?.mimeType || j.mimeType || 'image/png',
    charName: j.charName || '',
    // Carried through the reload so a restored tile can still be regenerated — without them the
    // buttons would be dead on everything from the previous session.
    whoId: j.whoId || null,
    srcId: j.srcId || null,
    // How many times this one has been retried. Dropped, a reload sent the next press back to the
    // first retry text — the one that had already failed to fix it.
    retryN: j.retryN || 0,
    // NOT the full-size `thumb`. That is the whole source photo as a data URL, and persisting one
    // per finished tile is exactly the storage bloat thumbSmall exists to avoid. A restored tile
    // regenerates from the live source when the photo is still on the page, and from thumbSmall
    // when it is not — see rerunJob.
    filedDb: j.filedDb || 'eddy-library',
    thumbSmall: j.thumbSmall || null,
    error: j.error || '',
  };
}

/**
 * A small JPEG of the source, for the slider after a reload.
 *
 * ~40KB instead of the several megabytes a phone photo runs to. Failure is non-fatal: without it
 * the tile still shows the RESULT, which is the half that matters.
 */
/**
 * IDENTITY REFERENCES, SHRUNK FOR THE WIRE.
 *
 * A character reference straight out of the collection is a full-size PNG — measured at ~2 MB
 * each here. Three of them is 6 MB of base64 going to the provider on EVERY image in a batch, and
 * it is most of the wait: a measured 3-reference run took 31.5s, of which the render itself was
 * about 8.
 *
 * 1024px on the long edge at high quality is far more detail than any of these models uses for a
 * face — they downsample on arrival regardless — and it takes that 6 MB to roughly 0.6.
 *
 * DELIBERATELY NOT APPLIED TO THE SOURCE PHOTO. The references are evidence of WHO she is and are
 * never reproduced pixel-for-pixel; the source is the thing Exact recreate copies, so its detail
 * is the output's detail. Shrinking that would trade scene fidelity for upload time, which is the
 * wrong trade on the one page whose job is reproducing a photograph.
 */
function shrinkForUpload(dataUrl, max = 1024, quality = 0.92) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        // Already small enough: hand it back untouched rather than re-encoding it lossily.
        if (Math.max(img.naturalWidth, img.naturalHeight) <= max) { resolve(dataUrl); return; }
        const scale = max / Math.max(img.naturalWidth, img.naturalHeight);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      // A reference that will not decode is sent as it came: slower, but never dropped.
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    } catch { resolve(dataUrl); }
  });
}

function shrinkForStorage(dataUrl, max = 360) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    } catch { resolve(null); }
  });
}

/**
 * A PAIR CHARACTER puts two named women in ONE photograph.
 *
 * `cast` is [{ name, from, to }] — who, and which image indexes are hers. One entry is the ordinary
 * single-character prompt and every string below renders exactly as it always has; the plural forms
 * only appear at two. That equality is pinned by check-photomatch-twins.js against hashes taken
 * before this existed, because the single path is what every run uses and it must not drift.
 *
 * The pronouns are not cosmetic. This prompt says "she" and "her" about fifteen times, and leaving
 * them singular while naming two women is the most direct way to get ONE woman out — the model
 * follows the grammar, which outnumbers the names. So `she`/`her` switch with the count.
 */
export function buildMatchInstruction({ characterName, refCount, masterPrompt, exactRecreate, varyBackground, allowExpressionChange, allowHairChange, allowBodyChange, allowLightingChange, faceless, wantsNude, addGenericNudeLine, sourceFaceBlurred, outfitFromChar = false, lookAtCamera = false, budget = 0, cast = null, backView = false, buildText = '' }) {
  const who = (cast && cast.length > 1)
    ? cast.map((c) => c.name).slice(0, -1).join(', ') + ' and ' + cast[cast.length - 1].name
    : (characterName || 'the character');
  const pair = !!(cast && cast.length > 1);
  // Verb-agreeing pairs, so a sentence reads correctly either way rather than being two sentences.
  const she = pair ? 'they' : 'she';
  const her = pair ? 'their' : 'her';
  const hers = pair ? 'them' : 'her';
  const person = pair ? 'the people' : 'the person';
  const count = cast ? cast.length : 1;
  const countWord = ['', 'one', 'two', 'three', 'four', 'five'][count] || String(count);
  const woman = pair ? 'the women' : 'the woman';
  const n = Math.max(1, refCount);
  const refs = n > 1 ? `images 1-${n}` : 'image 1';
  const src = `image ${n + 1}`;
  // Per-woman where it must be per-woman, plural everywhere else. 'her own reference images' in a
  // sentence whose subject is two women reads as ONE woman's images and invites exactly the
  // averaging the pair rules exist to stop.
  //
  // Declared HERE, below `refs`, not with the other pronouns above: `const` is not hoisted, so
  // reading refs from up there throws at call time, not at build time — the page would load and
  // every generate would fail. This is what tools/check-tdz-deps.js exists for.
  const ownRefs = pair ? 'their own reference images' : refs;

  // Identity comes from the refs. Each allow* flag drops its clause so a preset that overrides
  // that attribute (hair/body) doesn't fight the base prompt. Hair/body default ON = from refs.
  // When faceless, the face is intentionally hidden — don't ask the model to match it here (the
  // final lock handles the faceless case), but skin/hair/body still come from the refs.
  /**
   * THE WHOLE PERSON, named part by part.
   *
   * This read "face, skin tone, makeup, hair, body/figure/chest" and the prompt around it said
   * FACE five more times — so the model did what it was asked and swapped a face onto the
   * stand-in's body (owner, 2026-08-13: "it's like a faceswap but we want to recreate the same
   * image with our model"). A body is not one word at the end of a list about a face.
   */
  /**
   * WHOSE CLOTHES. Default: the source photo's, because Photo Match exists to put her into a scene
   * that already has an outfit in it. But a base photo of her in her own outfit is the other half
   * of the job — keeping the scene and the pose while she wears what SHE is wearing (owner,
   * 2026-08-13). Nude overrides both: there is no garment either way.
   */
  const outfitFromRefs = outfitFromChar && !wantsNude;
  const identity = [
    faceless ? 'skin tone' : 'face, head shape, jaw, skin tone, her makeup',
    /**
     * HAIR IS NOT ONE WORD EITHER.
     *
     * The comment above says a body is not one word at the end of a list about a face; hair had
     * exactly the same problem and it showed. Gallery 1c2e8850 (2026-08-18) came back with long
     * straight blonde ombre hair for a character whose every reference is dark and wavy — colour,
     * length and texture all drifted at once, from a prompt that asked for "hair" and nothing more
     * (owner: "it didint use hair our model fo face good etc"). Naming the attributes is what made
     * the body list hold, so hair gets the same treatment.
     */
    allowHairChange ? null : 'hair — its exact colour, length and texture',
    allowBodyChange ? null : 'neck, shoulders, arms, hands, torso, waist, hips, legs, height and build',
    outfitFromRefs ? 'the exact clothing she is wearing — every garment, its colour, cut, fabric and length' : null,
  ].filter(Boolean).join(', ');

  // Scene comes from the source. Outfit only when dressed; expression only when no Mood preset
  // has taken it over (else the two cancel); lighting only when no Lighting preset overrides it.
  // 'framing/camera' is pulled OUT into its own emphasised line below — folded into this list it
  // was one word among eight and the model re-framed to a stock portrait anyway.
  const scene = [
    'background', 'pose', 'hands/props',
    (wantsNude || outfitFromRefs) ? null : 'outfit',
    (allowExpressionChange || lookAtCamera) ? null : 'expression',
    allowLightingChange ? null : 'lighting',
  ].filter(Boolean).join(', ');

  const parts = [
    // Roles by image index, stated up front and hard.
    pair
      // Which images are WHOSE. Without this the model has one undifferentiated pile of faces and
      // averages them into a single woman used twice — the exact failure NO BLENDING guards, but
      // between the two characters rather than against the stand-in.
      ? `${cast.map((c) => `${c.from === c.to ? `image ${c.from}` : `images ${c.from}-${c.to}`} = ${c.name}`).join('. ')}. Those are the ONLY source for the people. ${src} = a photograph of DIFFERENT people, used ONLY for its scene — NEVER an identity reference.`
      : `${refs} = ${who} = the ONLY source for the person. ${src} = a photograph of a DIFFERENT woman, used ONLY for its scene — NEVER an identity reference.`,
    /**
     * HOW MANY COME OUT, WHO THEY ARE, AND THAT THEY ARE NOT EACH OTHER — one paragraph.
     *
     * Two failures, one root: the model takes the count from the scene (one woman in, one woman
     * out, the second character silently dropped) and, given two piles of reference faces, averages
     * them into one look worn twice. Both are "it ignored the twins" to anyone looking at the
     * result.
     *
     * The source is sometimes one woman and sometimes two (owner, 2026-08-16). Stating the count as
     * a fixed fact and covering both shapes in one sentence means no counting, no detection, and no
     * second code path.
     *
     * Written tight ON PURPOSE. It is not droppable — it IS the feature — so every character it
     * spends is one the identity lock in the tail cannot have, against ByteDance's ~3,000 cap.
     */
    ...(pair ? [`EXACTLY ${countWord.toUpperCase()} WOMEN IN THE OUTPUT: ${who} — ${countWord} different people, never one face used twice. If ${src} shows one woman, she is removed and ${count === 2 ? 'both' : 'all ' + countWord} of them stand in that scene, widening the crop to fit them; if it shows ${countWord}, each becomes a different one of ${hers}.`] : []),
    /**
     * REBUILD, NOT EDIT — and it has to be said before anything else.
     *
     * The failure this exists to stop: the output keeps the stand-in's body and wears ${who}'s
     * face. Naming the wrong answer works better on these models than adding another word about
     * the right one, so the wrong answer is named.
     */
    /**
     * Still the failure being fought, and it survived the first rewrite: the owner reports it
     * "sometimes just faceswaps in place" (2026-08-13). So the instruction now names the MECHANISM
     * rather than only the outcome — an edit model's default move is to keep the pixels it was
     * given and repaint a region, and "do not reuse the pixels" is the one phrasing that speaks to
     * that directly.
     */
    `REBUILD, DO NOT EDIT: produce a NEW photograph of ${who} in ${src}'s scene. Do NOT reuse the pixels of ${pair ? 'anyone' : 'the woman'} in ${src} or repaint a face onto ${hers} — ${pair ? 'they are' : 'she is'} not in the output. A body from ${src} with only the face changed is WRONG.`,
    exactRecreate
      // Exact recreate and a pair pull against each other: two bodies do not fit one body's
      // silhouette, so demanding the identical framing while adding a second woman is a
      // contradiction and the model resolves it by dropping one of them. For a pair the lock holds
      // the scene, and lets the frame move.
      ? (pair
        ? `Reproduce ${src}'s scene exactly — same background, props, lighting, mood, camera angle and style${(wantsNude || outfitFromRefs) ? '' : ', and the same kind of outfit'} — but the people in it are rebuilt entirely as ${who}${wantsNude ? ', and remove their clothing as instructed below' : ''}${outfitFromRefs ? `, each wearing HER OWN outfit from her own reference images rather than anything in ${src}` : ''}. Framing and pose may adjust only as far as fitting ${countWord} women into the shot requires.`
        : `Reproduce ${src} exactly — same background, pose, props, framing, lighting${(wantsNude || outfitFromRefs) ? '' : ', outfit'} — but the person in it is rebuilt entirely as ${who}${wantsNude ? ', and remove her clothing as instructed below' : ''}${outfitFromRefs ? `, wearing HER outfit from ${refs} rather than the one in ${src}` : ''}.`)
      : `A new photo of ${who} in ${src}'s scene, not a retouch of ${src}.`,
    // For a pair this must say HER OWN images, not the pooled range: "match from images 1-8" invites
    // the model to average eight photos of two different women into one look worn by both.
    pair
      ? `Match each woman to HER OWN reference images — never the other's, never an average of the two: ${identity}. Where ${src} disagrees, the reference images win.`
      : `From ${refs}, match exactly: ${identity}. Where ${src} disagrees, ${refs} win.`,
    `From ${src}: ${scene}.`,
    // #4 — camera as its own instruction. Seedream copies the pose but defaults to a flattering
    // eye-level portrait crop unless the SHOT itself is pinned; this is what "same camera angle"
    // in Eddy needed spelled out separately from framing.
    pair
      ? `CAMERA: same angle, lens height and shot type as ${src} — low stays low, over-the-shoulder stays over-the-shoulder. Only the crop may widen, and only as far as fitting ${countWord} women requires; never re-frame to a standard eye-level portrait.`
      : `CAMERA: reproduce ${src}'s exact shot — same angle, lens height, distance and crop. Whatever shot it is (low, high, over-the-shoulder, close-up, wide) it stays that shot; do NOT re-frame to a standard eye-level portrait.`,
  ];

  if (sourceFaceBlurred && !faceless) parts.push(`${src}'s face is deliberately blurred — do not reproduce the blur or invent a face from it; render ${pair ? 'each of their faces' : who + "'s face"} sharply from ${ownRefs}.`);
  /**
   * AN UNBLURRED SOURCE HAS A RIVAL FACE IN IT.
   *
   * Blurring is best-effort — the detector misses turned and partly-hidden faces — so a run with
   * the switch on still ships sharp faces regularly. Those are the photos where identity fails,
   * because the model has a complete, well-lit face right there and every reason to keep it.
   * Naming it as the wrong woman's costs one sentence and speaks to the exact temptation.
   */
  if (!sourceFaceBlurred && !faceless) parts.push(`The face visible in ${src} belongs to a DIFFERENT woman. It is the one thing in that photograph you must NOT keep — not its shape, not its features, not a softened version of it.`);
  if (!exactRecreate && varyBackground) parts.push(`Shift the lighting and mood slightly — same place, a different moment.`);
  if (addGenericNudeLine) parts.push(NUDE_LINE);
  if (masterPrompt?.trim()) parts.push(`${who}: ${masterPrompt.trim()}`);

  /**
   * THE FOUR RULES PORTED BACK FROM THE GEMINI ROUTE (owner, 2026-08-11: "it copies the face of the
   * source photo and adds makeup").
   *
   * The Seedream prompt was cut to fit ByteDance's length cap and these went with the trim. Each one
   * is load-bearing and each maps to a symptom that was actually seen:
   *
   *  - NO BLENDING. Without it the model AVERAGES the two faces, which is precisely what "it copies
   *    the source face" looks like -- not a straight copy, a blend that drifts away from her.
   *  - FORBIDDEN, itemised. "Scene only" is a description; a list of the parts that may not travel
   *    is an instruction.
   *  - MAKEUP FROM THE REFS. The old line said `makeup (keep bold/dark lips)` -- an unconditional
   *    order to paint on dark lipstick whether or not she wears any. That WAS the "adds makeup"
   *    bug: we were asking for it. Makeup now comes from her references, and the only thing said
   *    about bold shades is that they must not be softened away IF she is wearing them.
   *  - TATTOOS. The stand-in's ink transfers otherwise; Gemini's route has carried this rule for
   *    months.
   */
  if (!faceless) {
    parts.push(`MAKEUP: ${pair ? 'each exactly as in her own reference images' : 'exactly as in ' + refs} — lips, eyes, lashes, brows. Keep a bold or dark lip if ${she} ${pair ? 'wear' : 'wears'} one; do not soften it, do not ADD makeup ${she} ${pair ? 'are' : 'is'} not wearing, and never take it from ${src}.`);
  }
  if (outfitFromRefs) {
    parts.push(`OUTFIT: ${she} ${pair ? 'each wear their' : 'wears HER'} OWN clothing from ${ownRefs} — same garments, colours, cut, fabric, length. Do NOT dress ${hers} in what ${pair ? 'anyone' : 'the woman'} in ${src} wears; that outfit is not in the output. Everything else still comes from ${src}.`);
  }
  /**
   * NO TATTOOS. NOT THE SOURCE'S, NOT INVENTED, NOT ANY.
   *
   * This said "she has only the tattoos visible in her reference images", which is a permission: it
   * tells the model tattoos are part of her whenever a reference happens to show one, and leaves the
   * door open to inventing a plausible one. The owner does not want them at all (2026-08-16: 'it did
   * the tattos we never wanna have tattos'), so the rule is now absolute rather than conditional —
   * an absolute is also far harder to talk a model out of than a comparison between two photographs.
   */
  parts.push(`FORBIDDEN from ${src}: its face, facial structure, eyes, nose, mouth, jaw, hair colour, skin tone${allowBodyChange ? '' : ', body shape'}${outfitFromRefs ? ', its clothing' : ''}, and any tattoo, ink or skin marking.`);
  // Kept tight on purpose: it is not droppable — the owner wants it on every render — so every
  // character it spends is one the identity lock in the tail cannot have.
  parts.push(`NO TATTOOS: ${who} ${pair ? 'have' : 'has'} clean unmarked skin — no ink, lettering or symbols anywhere. Never copy one from ${src}, carry one over from ${ownRefs}, or invent one.`);
  parts.push(`NO BLENDING: do not mix, merge or average ${who} with ${person} in ${src} — not ${her} ${pair ? 'faces' : 'face'} and not ${her} ${pair ? 'bodies' : 'body'}. Every part of ${person} in the output is 100% ${pair ? 'from ' + ownRefs : refs}, not a midpoint between the ${pair ? 'women in the two photographs' : 'two women'}.`);
  if (pair) {
    /**
     * The pair's own blending rule, restated where it counts.
     *
     * NO BLENDING above guards each woman against the STAND-IN. Nothing guards them against EACH
     * OTHER — two sets of reference faces in one request is precisely the input that makes an edit
     * model average them into one look worn twice, which reads as "it ignored the twins".
     *
     * The full rule is stated in the count paragraph at the top; this is the tail reminder, and it
     * is here because Seedream weights the tail hardest — the same reason the identity lock lives
     * down here. Short by necessity: the pair prompt runs close to the length cap, and a long
     * restatement would push the FINAL lock out.
     */
    parts.push(`${who} are ${countWord} DIFFERENT women — different faces, never one face used twice.`);
  }

  /**
   * EYES TO CAMERA. Off by default — the source's gaze is part of the shot being reproduced, and
   * overriding it every time would quietly change every candid into a portrait. On, it replaces the
   * gaze rather than fighting it: 'expression' leaves the from-the-scene list above, or the two
   * instructions cancel and the model does neither (owner, 2026-08-13).
   */
  if (lookAtCamera && !faceless) {
    parts.push(`EYES TO CAMERA: ${she} ${pair ? 'look' : 'looks'} straight into the lens, both eyes visible and meeting the viewer. Keep the pose and body angle from ${src} — only the ${pair ? 'heads and gazes turn' : 'head and gaze turn'} to the camera.`);
  }

  // Late, and NOT droppable: it is a composition lock, so it belongs near the tail where Seedream
  // weights hardest — same reasoning as the identity lock below it.
  if (backView) parts.push(BACK_VIEW_LINE(src));

  /**
   * THE LIGHTING LINE, on every prompt (owner, 2026-08-13) — EXCEPT an exact recreate.
   *
   * Deliberately placed BEFORE the chips, which are appended after this whole instruction. Seedream
   * weights the tail most heavily, so a Lighting chip — "Moody low-key", "Red neon" — still wins by
   * position. That is the intended relationship: this is the house default, not a lock.
   *
   * BUT IT IS A FLAT CONTRADICTION OF EXACT RECREATE. "Reproduce image 5 exactly — same lighting"
   * and "lighting is soft and diffused" cannot both be obeyed, and this one sits later, where the
   * weight is. Handed a harsh, contrasty or neon-lit source, the model was being told in the same
   * breath to keep that lighting and to soften it — and softening is also the safer, more default
   * thing to do, so that is what came back (owner, 2026-08-17: "i selected exact recreate it doesnt
   * do the exact recreate at all").
   *
   * The house default still applies everywhere it is not being overruled by an explicit request for
   * the source's own light.
   */
  if (!exactRecreate) parts.push(LIGHTING_LINE);

  /**
   * WHAT A REAL PHOTOGRAPH OF SKIN LOOKS LIKE, named rather than gestured at.
   *
   * This was 'Photorealistic — real pores, hair strands, fabric, slight asymmetry; no plastic or
   * CGI look', which is mostly a list of things NOT to do. A negative leaves the model to choose
   * what to do instead, and what it chooses is the smooth, evenly-lit, retouched look that reads
   * as AI at a glance (owner, 2026-08-16: 'scale up the quality of skin and image').
   *
   * So it now names the things a camera actually records — pore texture that varies by area,
   * fine hairs, the shine of real oil rather than an even sheen, and the small asymmetries a
   * retoucher would remove. Those are positive targets, and they are what separates a photograph
   * from a render.
   *
   * Still the FIRST thing dropped at the length cap: it improves a picture that is already of the
   * right woman, and the identity lock decides whether she is. Ordinary runs never reach that.
   */
  /**
   * ROOM TO SAY MORE THAN THE MINIMUM.
   *
   * Nano Banana's cap is 8000 and its heaviest measured run is ~4.8k; Seedream's is 3000 and its
   * plainest run already spends 2,900 of it. So the two long quality paragraphs below exist only
   * where they FIT. On Seedream they were not merely tight — measured, they were dropped by the trim
   * loop on every single configuration, which is worse than absent: text that looks present in the
   * source and never reaches the model.
   *
   * Seedream is not left without one. The skin instruction that matters most rides inside the FINAL
   * lock further down, on both tabs — see SKIN_IN_LOCK.
   *
   * A budget of 0 means "no cap stated" — treated as the SMALL shape, deliberately. The harnesses
   * call it that way to prove the prompt fits 3000 unaided, and a caller that forgets to pass a
   * budget should get the conservative prompt rather than one sized for a cap it never declared.
   */
  const roomy = budget >= 5000;
  parts.push(roomy
    ? `SKIN AND DETAIL: real pore texture at the nose, cheeks and forehead, fine vellus hair catching the light along the jaw and hairline, uneven specular — shiny where skin is oily, matte elsewhere, never one even sheen. Slight redness around the nose and eyes, faint translucency at the ears and eyelids, lips with visible lines rather than a smooth fill. Keep freckles, moles, fine lines and uneven tone. Sharp micro-contrast; no smoothing, no wax skin, no airbrush.`
    : `SKIN AND DETAIL: real pore texture, stray hairs, uneven specular — shiny where oily, matte elsewhere, never one even sheen. Keep freckles, moles and uneven tone. Sharp micro-contrast; no smoothing, no wax skin, no airbrush.`);

  /**
   * THE REST OF THE FRAME, not just her skin.
   *
   * SKIN AND DETAIL fixed the woman and left everything around her alone, so a correct, textured
   * face kept arriving inside a scene that still looked rendered — flat even light, plastic
   * surfaces, a background as sharp as the subject. That is what reads as AI at a glance, and it
   * is not the skin (owner, 2026-08-17: "it auto the prompt upscale the skin and enviroment").
   *
   * AUTOMATIC, like the skin line. Both are what a photograph IS, not an effect somebody opts into,
   * and a quality that has to be ticked is a quality most runs go without.
   *
   * THE TRAP THIS AVOIDS: the prompt above orders the scene reproduced EXACTLY — same background,
   * lighting, props. An instruction to improve the environment fights that directly and will start
   * adding light sources and set dressing. So every clause here is about RENDERING — optics, light
   * behaviour, material texture, sensor character — and it closes by saying so outright.
   *
   * NANO BANANA ONLY, and that is a measurement rather than a preference. Seedream's cap is 3000
   * and the prompt already spends 2,921 of it on the plainest run and 3,200 on the worst — the drop
   * list exists because of that. There is no room on that tab for another automatic paragraph: a
   * short one still lands the worst case over the cap, where ByteDance 422s the whole batch. Nano
   * Banana's cap is 8000 and its heaviest measured run is ~4.5k, so there it is free.
   *
   * 5000 is the test because it sits above one cap and below the other. A Nano Banana run carrying
   * 3000+ characters of its own instructions falls back under it and loses this paragraph, which is
   * correct — at that point room really is short.
   */
  if (roomy) {
    /**
     * AND IN EXACT RECREATE IT MUST NOT RESTYLE EITHER.
     *
     * The general version asks for natural depth of field, one consistent light direction and
     * highlights that roll off. Every one of those is a change to how the source LOOKS, which is
     * the one thing an exact recreate forbids — a source shot flat and sharp to the back wall would
     * come back with a soft background and different contrast, and read as "it ignored exact
     * recreate" even though the person was right.
     *
     * So in exact mode the same paragraph asks only for material texture and honest sensor
     * character, and explicitly hands the optics and the light back to the source photo.
     */
    parts.push(exactRecreate
      ? `SCENE AND CAMERA: keep ${src}'s own optics, depth of field, contrast and colour exactly as they are — this does NOT restyle the photograph. Render its materials truthfully within them: fabric weave, hair strands, skin, wood, metal, wall and floor surfaces each keeping their own texture, with fine sensor grain. No over-sharpening, no plastic or waxy surfaces, no CGI gloss, no smoothed or cleaned-up look.`
      : `SCENE AND CAMERA: render the scene with real photographic optics — natural depth of field with the background falling off softly behind her, light with one consistent direction and soft-edged shadows that match it, and true material texture: fabric weave, hair strands, wood, metal, wall and floor surfaces each keeping their own grain. Highlights roll off instead of clipping, shadows hold detail and colour instead of going flat black, and fine sensor grain sits evenly over the whole frame. No HDR halos, no over-sharpening, no plastic or waxy surfaces, no CGI gloss, no uniform edge-to-edge sharpness. This governs how the scene is RENDERED, not what is in it — do NOT add, remove, relight or rearrange anything.`);
  }

  /**
   * HER BUILD, immediately before the identity lock.
   *
   * It states the size the lock is about to hold. Placed anywhere earlier it is one sentence
   * among fifteen; here the two read as a single statement, which is the arrangement Eddy
   * arrived at for the same reason.
   */
  if (buildText) parts.push(buildText);

  // #3 — the hardest locks go LAST. Seedream weights the tail of the prompt most heavily (the
  // whole reason chips are appended at the very end), so the identity guarantee and the bust lock
  // — the two things whose loss reads as "the page is broken" — belong here, not buried mid-prompt.
  if (faceless) {
    // Faceless output: the face must NOT appear, so the usual "must be recognisably her" guarantee
    // is wrong here and would fight the composition. Identity rides on body/hair instead.
    parts.push(`FINAL — HIGHEST PRIORITY, overrides everything above: ${her} ${pair ? 'faces are' : 'face is'} intentionally OUT of the shot — ${backView ? 'she is facing away and stays that way' : 'cropped above the shoulders, turned away, or hidden by hair/hand/angle'} so no recognisable face is visible. Do NOT invent or show a face. ${pair ? 'Their bodies, hair, skin and proportions' : 'Her body, hair, skin and proportions'} still come from ${ownRefs}${allowBodyChange ? '' : ' at their true size — never averaged or shrunk toward ' + src}.`);
  } else {
    const finalLock = [
      `FINAL — HIGHEST PRIORITY, overrides everything above: render ${person} from scratch as ${who} from ${ownRefs} — ${pair ? 'faces' : 'face'}, hair at her own colour and length, skin and whole ${pair ? 'bodies' : 'body'}${pair ? `, ${countWord} distinct women in the frame` : ''}. ${pair ? 'The women' : 'The woman'} in ${src} ${pair ? 'are anonymous stand-ins: discard them' : 'is an anonymous stand-in: discard her'} entirely, ${pair ? 'faces' : 'face'} and ${pair ? 'figures' : 'figure'} alike, and when in doubt copy ${pair ? 'the reference images' : refs}.`,
      // Body/chest: pinned to the refs UNLESS a size chip is driving it (then the chip, appended
      // after this whole prompt, wins and re-pinning here would fight it).
      allowBodyChange
        ? null
        : (wantsNude
          ? `${pair ? 'Each of their bodies, figures and chests come from her own reference images' : 'Her body, figure and chest come from ' + refs} at their true ${pair ? 'sizes' : 'size'} — never averaged${pair ? ', never matched to each other' : ''} or shrunk toward ${src}.`
          : (outfitFromRefs
            ? `${pair ? 'Each of their bodies, figures and chests come from her own reference images' : 'Her body, figure and chest come from ' + refs} at their true ${pair ? 'sizes' : 'size'}, and ${pair ? 'each of their own outfits sits on her' : 'her own outfit sits on her'} exactly as it does there.`
            : `${pair ? 'Each of their bodies, figures and chests come from her own reference images' : 'Her body, figure and chest come from ' + refs} at their true ${pair ? 'sizes' : 'size'}; the ${src} outfit stretches to fit ${pair ? 'EACH OF THEM' : 'HER'} — a tighter pull from a larger chest is correct, not an error.`)),
    ].filter(Boolean);
    parts.push(finalLock.join(' '));
  }

  /**
   * FIT BY DROPPING, NEVER BY SLICING.
   *
   * The caller cut the finished string at the cap. That takes it off the TAIL — which is where the
   * identity lock lives, and where Seedream weights most heavily. The longest possible prompt
   * (exact recreate + her outfit + eyes to camera + a 200-character master prompt) measured 3,094
   * against a 3,000 cap, so its most important paragraph would have been cut in half (2026-08-13).
   *
   * Optional paragraphs come out WHOLE instead, cheapest first, until it fits. The caller's slice
   * stays as a backstop, but everything load-bearing has already been protected.
   *
   * Droppable, in order: the skin/detail paragraph, the blur note, the master prompt, the camera
   * paragraph. Never droppable: who is who, REBUILD, the two lists, MAKEUP, OUTFIT, FORBIDDEN,
   * NO BLENDING, EYES TO CAMERA, the lighting line, and the FINAL lock.
   *
   * A PAIR NEEDS TWO MORE, because it starts ~700 characters up on a single character: it names two
   * women, splits the image ranges between them, and states the count. Measured with everything on
   * — exact recreate + her outfit + eyes to camera + a blurred source + a 200-character master
   * prompt — a pair lands at 3,280 with every droppable above already gone.
   *
   * So EYES TO CAMERA and then MAKEUP become droppable, but ONLY for a pair and ONLY after the four
   * above. Both are real losses and neither is chosen lightly: eyes-to-camera is a chip the user
   * ticked, and MAKEUP guards a bug that was actually shipped ("it adds makeup"). They lose to the
   * FINAL lock because a sliced identity guarantee means the wrong women come out of every image in
   * the batch, which is not recoverable by a retry. Ordinary pair runs never reach this — exact
   * recreate on a pair measures 2,989 and drops nothing.
   */
  /**
   * SKIN, SAID AGAIN IN THE ONE PLACE THAT OUTRANKS EVERYTHING — and said differently.
   *
   * Owner, 2026-08-17: "the face skin still look like plastic". SKIN AND DETAIL was already in the
   * prompt, so more adjectives in the same spot were not going to fix it. Two structural reasons it
   * loses:
   *
   *   1. POSITION. It sits mid-prompt and the FINAL lock comes after it, re-anchoring everything to
   *      the reference photos. Both engines weight the tail hardest — that is why the identity lock
   *      lives there and why the chips are appended after the whole instruction.
   *
   *   2. THE REFERENCES THEMSELVES. "Match exactly: skin tone" and "render her as Grace from her
   *      references" are orders to COPY those photos, and a character's references are very often
   *      generated or retouched images with smooth, poreless skin. The model is then reproducing
   *      the plastic finish faithfully — obeying the prompt, not ignoring it. Nothing anywhere told
   *      it to take her identity from the references and NOT their finish.
   *
   * So this rides inside the final paragraph, and its real work is the second sentence.
   *
   * NANO BANANA ONLY, measured — and this one hurt to conclude. Seedream has no room whatsoever:
   * adding even a 60-character version means the trim loop reaches the "her face is deliberately
   * blurred — render it sharply" line on an ordinary nude, pair or extra-instruction run, and that
   * line guards a bug that actually shipped. Paying for skin texture with a wrong face is a bad
   * trade at any length, so Seedream's prompt is left exactly as it was and every version of this
   * lands on the tab that can hold it.
   */
  if (!faceless && roomy) {
    parts[parts.length - 1] += ` Her skin is PHOTOGRAPHED, not retouched: visible pores, fine facial hair, natural unevenness, shine only where skin is oily. If her reference photos look smoothed or airbrushed, take her IDENTITY from them and not that finish.`;
  }

  /**
   * EXACT RECREATE, IN THE ONE PLACE THAT OUTRANKS EVERYTHING.
   *
   * Owner, 2026-08-17: "i selected exact recreate it doesnt do the exact recreate at all". Diffing
   * the two prompts explains it — the switch changed ONE sentence out of fifteen paragraphs:
   *
   *     on:  "Reproduce image 5 exactly — same background, pose, props, framing, lighting, outfit"
   *     off: "A new photo of Grace in image 5's scene, not a retouch of image 5."
   *
   * and BOTH modes already carry "From image 5: background, pose, hands/props, outfit, expression,
   * lighting" and the CAMERA paragraph. So the model was reading nearly the same instruction either
   * way, with the exact-recreate sentence sitting fifth from the top where the weight is lowest,
   * while the tail was busy talking about the person.
   *
   * The fix is the one that already works for identity and for the bust: say it LAST. Everything
   * above is about who she is; this is the one line about what the photograph is.
   *
   * Two lengths for the usual reason — Seedream has no spare room. The short one costs it nothing,
   * because turning exact recreate on now also removes the lighting line that was contradicting it.
   */
  if (exactRecreate) {
    parts.push(roomy
      ? `EXACT RECREATE — the photograph itself is FIXED: ${src}'s framing, crop, camera angle, pose, background, props, lighting, contrast and colour all stay exactly as they are. Do not re-frame, re-pose, relight, restyle, tidy, recolour or "improve" any of it. The ONLY thing that changes in that photograph is who the woman is.`
      // Measured to the character. Turning exact recreate on removes the 81-character lighting line
      // it contradicts, and this is sized to fit in that gap — so Seedream gains the lock without
      // losing the skin paragraph to the trim loop. Anything longer costs one.
      : `EXACT RECREATE: ${src}'s framing, pose, lighting and colour stay EXACTLY as they are — never restyled.`);
  }

  const SEP = '\n\n';
  const joined = () => parts.join(SEP);
  if (budget > 0) {
    // SCENE AND CAMERA goes first, ahead of SKIN AND DETAIL: at the cap the woman matters more than
    // the room she is standing in, and hers is the smaller line of the two.
    const droppable = ['SCENE AND CAMERA:', 'SKIN AND DETAIL', `${src}'s face is deliberately blurred`, `${who}: `, 'CAMERA:',
      ...(pair ? ['EYES TO CAMERA:', 'MAKEUP:'] : []),
      // HER BUILD, then the rival-face warning — in that order, because they are not worth the
      // same. Asked to keep only one, 'do not copy the stand-in's face' beats 'she has a very
      // large bust': a build line without identity is a correctly-proportioned stranger, while
      // an identity that holds at whatever size her references show is the default behaviour
      // anyway. Both survive every ordinary run; only a pair with every flag on reaches here.
      ...(buildText ? [buildText.slice(0, 24)] : []),
      // Then NO TATTOOS, then the rival-face warning last. Ranked by what a picture loses: a
      // stray tattoo is a visible defect on an otherwise correct woman, while keeping the
      // stand-in's face is the wrong woman entirely.
      //
      // Only one combination ever reaches this far — a PAIR with a back-facing source and every
      // flag on — because faceless mode does not emit MAKEUP or EYES TO CAMERA, so the pair
      // loses the two droppables it would otherwise spend first.
      'NO TATTOOS:',
      'The face visible in'];
    for (const marker of droppable) {
      if (joined().length <= budget) break;
      const i = parts.findIndex((t) => typeof t === 'string' && t.startsWith(marker));
      if (i > -1) parts.splice(i, 1);
    }
  }
  return joined();
}

// Grouped so the row stays scannable. Each states what to change AND what stays put —
// Seedream drifts on identity when only given the change.
// Deliberately terse. These are APPENDED to the base instruction, which already states that
// identity, pose, scene and framing are preserved — so repeating "keep her face and pose
// unchanged" in every chip just burned prompt budget and got the whole lot trimmed once two
// were stacked. Each chip says only what it CHANGES.
//
// Flags matter: a chip that changes something the base prompt pins must set its flag, or the
// two cancel and the model does neither.
const PRESETS = [
  { group: 'Body', label: 'Match her bust exactly', text: 'Her chest size, volume, weight and cleavage come from the character reference images — read her actual proportions from them and reproduce them exactly. Do not shrink, average or normalise her toward a smaller or more typical size.' },
  { group: 'Body', bodyChange: true, label: 'Large bust', text: 'She has a LARGE bust — large, full, heavy breasts with deep cleavage. Not medium, not "slightly fuller". The garment stretches tight over them: correct, not an error.' },
  { group: 'Body', bodyChange: true, label: 'Very large bust', text: 'She has a VERY LARGE bust — heavy, full breasts with pronounced weight and deep cleavage, straining the garment. Do not moderate toward average.' },
  { group: 'Body', bodyChange: true, label: 'Huge bust', text: 'She has a HUGE bust — extremely large, heavy breasts with dramatic weight and cleavage, clearly straining the garment. Render at full size; do not tone down.' },
  { group: 'Body', bodyChange: true, label: 'Curvier figure', text: 'Curvy hourglass figure — full bust, full hips, narrow waist. The garment conforms to that shape.' },

  { group: 'Hair', hairChange: true, label: 'Curly', text: 'Her hair is curly — defined natural curls with volume. Keep her hair colour.' },
  { group: 'Hair', hairChange: true, label: 'Wavy', text: 'Her hair is loose and wavy with soft movement. Keep her hair colour.' },
  { group: 'Hair', hairChange: true, label: 'Straight', text: 'Her hair is straight and sleek, no curl. Keep her hair colour.' },
  { group: 'Hair', hairChange: true, label: 'Ponytail', text: 'Her hair is in a ponytail, face framed and neck visible. Keep her hair colour and texture.' },
  { group: 'Hair', hairChange: true, label: 'Messy bun', text: 'Her hair is in a loose messy bun, a few strands falling free. Keep her hair colour and texture.' },
  { group: 'Hair', hairChange: true, label: 'Wet slicked back', text: 'Her hair is wet and slicked straight back, damp and glossy. Keep her hair colour.' },
  { group: 'Hair', hairChange: true, label: 'Shorter — bob', text: 'Her hair is cut to a chin-length bob. Keep her hair colour and texture.' },

  { group: 'Scene', label: 'Keep background exact', text: 'The background is pixel-identical to the scene photo.' },
  { group: 'Scene', label: 'Keep the props', text: 'Every prop from the scene photo stays — same position, size and orientation, held the same way.' },
  // dressedOnly: this directly contradicts the removal instruction, so the toggle hides it.
  { group: 'Scene', dressedOnly: true, label: 'Keep the outfit exact', text: 'The outfit matches the scene photo exactly — same type, colour, cut, fabric and coverage.' },
  { group: 'Scene', label: 'Remove other people', text: 'Remove any other people; keep the location and framing.' },

  { group: 'Skin', label: 'Oiled skin', text: 'Her skin glistens with body oil — bright specular highlights on shoulders, collarbones, chest, stomach and legs. Real sheen with depth, never flat or waxy.' },
  { group: 'Skin', label: 'Wet look', text: 'Her skin and hair are freshly wet — beaded droplets, damp clumped strands, glossy highlights. Photorealistic water, not a filter.' },
  { group: 'Skin', label: 'Sweaty glow', text: 'A fine sheen of sweat and a dewy glow — small beads at the temples, collarbone and chest.' },
  { group: 'Skin', label: 'Flushed skin', text: 'A warm natural flush across her cheeks, chest and collarbone, as if her body is hot.' },

  { group: 'Mood', expressionChange: true, label: 'Biting her lip', text: 'She is biting her lower lip, heavy-lidded eyes on the camera. Only her face changes.' },
  { group: 'Mood', expressionChange: true, label: 'Seductive gaze', text: 'A sultry heavy-lidded look straight down the lens, chin slightly lowered, faint knowing smile. Only her face changes.' },
  { group: 'Mood', expressionChange: true, label: 'Parted lips', text: 'Lips softly parted, relaxed jaw, gaze on the camera — breathy, not smiling. Only her face changes.' },
  { group: 'Mood', expressionChange: true, label: 'Over-the-shoulder look', text: 'She looks back over her shoulder at the camera, heavy-lidded. Only her head and gaze change.' },

  { group: 'Photo', label: 'Match lighting harder', text: 'Match the scene photo\'s lighting, colour temperature and shadow direction precisely.' },
  { group: 'Photo', label: 'Candid phone look', text: 'A RAW handheld phone photo — candid framing, high ISO grain in the shadows, slight natural softness. Not a studio shot.' },
  { group: 'Photo', label: 'Sharper detail', text: 'Render skin, hair and fabric texture sharply. No plastic or over-smoothed skin.' },

  // Lighting chips OVERRIDE the source's lighting, so each sets lightingChange — otherwise the base
  // prompt's "lighting comes from the scene photo" clause cancels it, same failure as the Mood/Hair
  // chips. Ported from Eddy's moody/natural set to match her darker aesthetic.
  { group: 'Lighting', lightingChange: true, label: 'Moody low-key', text: 'Low-key moody lighting — deep shadows, a single soft source, most of the frame falling into darkness. Cinematic, intimate, high contrast.' },
  { group: 'Lighting', lightingChange: true, label: 'Dramatic side light', text: 'Hard directional light from one side — one half of her lit, the other in shadow, a sharp shadow line down the face and body.' },
  { group: 'Lighting', lightingChange: true, label: 'Candlelit warm', text: 'Warm low candlelight — flickering orange glow, soft falloff, deep warm shadows. An intimate after-dark feel.' },
  { group: 'Lighting', lightingChange: true, label: 'Cool night', text: 'Cool blue night lighting — moonlight or a screen\'s glow, low and directional, cold shadows. Nocturnal and quiet.' },
  { group: 'Lighting', lightingChange: true, label: 'Red neon', text: 'Saturated red/magenta neon light raking across her skin, hard coloured shadows, a late-night bar or bedroom glow.' },
  { group: 'Lighting', lightingChange: true, label: 'Soft window daylight', text: 'Soft diffused daylight from a nearby window — gentle wraparound light, soft shadows, natural and flattering.' },
  { group: 'Lighting', lightingChange: true, label: 'Golden hour', text: 'Warm golden-hour sun low in frame — long soft shadows, a warm rim of light on her edges, hazy glow.' },
];

// NSFW chips come from the shared module so every page offers the same set.
const ALL_PRESETS = [...PRESETS, ...NSFW_PRESETS];
const PRESET_GROUPS = ['Body', 'Hair', 'Scene', 'Skin', 'Mood', 'Photo', 'Lighting'];
const NSFW_GROUPS = ['Sexual', 'Expression'];

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  return m ? { mimeType: m[1], base64: m[2] } : null;
}


/**
 * exactRecreate defaults ON (owner, 2026-08-15: "exact recreate always toggle on").
 *
 * WHY IT MATTERS MORE THAN IT LOOKS: off, the prompt says "a new photo of Grace in image N's scene,
 * NOT a retouch" — deliberately loose, because that looseness is what stops a faceswap. The cost is
 * that the scene gets rebuilt rather than preserved, which reads as "it did not recreate the same
 * photo". On, that one line is replaced by "Reproduce image N exactly — same background, pose,
 * props, framing, lighting, outfit — but the person in it is rebuilt entirely as Grace", which
 * keeps the anti-faceswap rebuild of the PERSON while pinning everything around her.
 *
 * Lives here rather than in the page's disk snapshot (which holds only sources, characterIds and
 * extra), so this default is what every fresh start actually gets — there is no stored `false` to
 * override it.
 */
/**
 * Job ids this tab is already waiting on — MODULE level, deliberately.
 *
 * Unmounting a React component does not cancel its promises. Leave Photo Match mid-run and
 * runOne's await keeps polling in the background and still files its picture when it lands. So
 * the resume-on-open, which is a NEW component instance with a fresh closure, cannot see that the
 * old one is still on the case — it adopted the same job, waited on it too, and both filed. One
 * render, two rows in the library (owner, 2026-08-16: 'it duplicate the image').
 *
 * A ref would not work: refs die with the component, which is exactly the thing that is not
 * happening to the promise. Ids are removed when their waiter settles, so this cannot grow.
 */
const _awaiting = new Set();

const _cache = { extra: '', aspectRatio: 'auto', resolution: '2K', build: 'verylarge', exactRecreate: true, varyBackground: false, nsfw: false, blurSource: true, faceless: false };
// Images are too big for _cache/localStorage — IndexedDB so they survive a reload.
/**
 * Retry a generation that came back rate-limited.
 *
 * This page had NO retry at all: a 429 lost the image outright. That was survivable at 2 concurrent
 * jobs; at 4, running alongside Eddy at 12 against a shared 60-per-minute server limit, it is not.
 * Raising the lane count without this would have traded wall-clock for images (owner, 2026-08-09).
 *
 * ONLY 429 / RATE_LIMITED is retried. Everything else fails the same way on attempt four as on
 * attempt one, and retrying a bad prompt or a missing key just spends three more calls to reach the
 * same place. Linear backoff, not exponential: this quota refills on a clock.
 */
async function withRateLimitRetry(fn, { attempts = 4, baseDelayMs = 4000 } = {}) {
  for (let i = 0; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      const limited = err?.status === 429 || err?.code === 'RATE_LIMITED';
      if (!limited || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
}

/**
 * One store per variant. NB2 is a second tab of the SAME page, and sharing this key would mean the
 * two tabs fought over one set of sources, characters and chips — pick a character on one and it
 * moves on the other.
 */
const STORES = {
  sd: createPageStore('kyros-photo-match-seedream-state'),
  nb2: createPageStore('kyros-photo-match-nb2-state'),
};

/**
 * WaveSpeed's published per-image rate for nano-banana-2, by resolution. Kept beside Seedream's
 * own pricing (seedreamCost) rather than folded into it: nano2 charges a FLAT rate per image and
 * does not bill per extra reference, so sharing one cost function would misstate both.
 */
const NANO2_COST = { '1K': 0.07, '2K': 0.105 };

// Nano Banana 2 runs long -- a measured Eddy run spent 182.8s in inference alone -- and the
// client aborting first throws away an image that has already been generated and billed.
const NANO2_CLIENT_TIMEOUT_MS = 11 * 60_000;

/**
 * Google's own rate for gemini-3.1-flash-image. Separate from NANO2_COST because it is the same
 * model bought from a different counter: WaveSpeed resells it with a margin, this is direct.
 */
const NB2_COST = { '1K': 0.04, '2K': 0.06 };

/**
 * Tries on the bypass before the queue hands the job to Seedream 5 Pro.
 *
 * MIRRORS generationReconciler.NB2_ATTEMPTS, which is where the decision is actually made — this
 * copy exists only so the message can say a number. check-photomatch-nb2.js asserts the two
 * match, because a message that states the wrong count is worse than one that states none.
 */
const NB2_ATTEMPTS = 5;

/**
 * PHOTO MATCH, TWICE — one component, two tabs.
 *
 *   variant 'sd'  -> Photo Match SD, Seedream 5.0 Pro or Nano Banana 2, both via WaveSpeed
 *   variant 'nb2' -> Photo Match NB2, Nano Banana 2 through OUR BYPASS on Google's own API
 *
 * NB2 exists because the model is the same but the gatekeeper is not: bought through a reseller you
 * inherit the reseller's refusals on top of Google's, and this page's whole job is rebuilding a
 * photo with a specific woman in it. The bypass goes straight to generativelanguage.googleapis.com
 * with the Gemini key, safety at BLOCK_ONLY_HIGH, and a retry ladder that drops safetySettings
 * altogether on the last attempt.
 *
 * A PROP RATHER THAN A COPIED FILE, deliberately. This page is the twins cast, the back-view
 * detection, the pose/mood/lighting chips, the blur pipeline, the library destinations and a prompt
 * builder tuned over months against real failures. Duplicating it would mean every one of those
 * fixed twice from now on, and the copies quietly disagreeing about which is right. The differences
 * between the two tabs are genuinely small — which engine, which budget, which price — so they are
 * conditionals, not a second file.
 */
export default function PhotoMatchSeedreamPage({ variant = 'sd' }) {
  const isNB2 = variant === 'nb2';
  // Tell the senders which Photo Match tab is in use — see photoMatchTarget().
  useEffect(() => { rememberPhotoMatchTab(isNB2 ? 'photoMatchNB2' : 'photoMatchSeedream'); }, [isNB2]);
  /**
   * What this tab's jobs are called on the queue.
   *
   * Per tab, because resuming asks the server 'what of mine is still running' and the two tabs
   * would otherwise adopt each other's work. The model cannot be used to tell them apart: an NB2
   * job that falls back runs on seedream5 and would then look like an SD job.
   */
  const FEATURE = variant === 'nb2' ? 'photoMatchNB2' : 'photoMatchSeedream';
  const store = STORES[isNB2 ? 'nb2' : 'sd'];
  // Its own panel too. Shared, the NB2 tab opened showing Seedream and Nano 2 pictures it had
  // never made — and every one of them priced at the bypass's rate.
  const resultsStore = RESULT_STORES[isNB2 ? 'nb2' : 'sd'];
  const { notify } = useApp();

  /**
   * THE CHARACTERS ARE EDDY'S, not the server's.
   *
   * This page listed server-side characters while every character the owner actually builds and
   * uses lives in Eddy's Character tab, where a FOLDER IS A CHARACTER and its images are her
   * reference photos. So the picker showed names from a different system and the identity you
   * chose was not the identity you had been working with (owner, 2026-08-09).
   *
   * Reading the collection directly also means her photos are already bytes: no primaryImageUrl
   * round-trip, no fetch per reference, no server call that can 404 mid-batch.
   */
  const charStore = useMemo(() => createEddyCollection('eddy-character'), []);
  // Eddy's Library is where EVERYTHING generated goes. The owner uses Eddy and this page and
  // nothing else, so a Photo Match result that only reached the server gallery was a result they
  // had to go somewhere else to find (owner, 2026-08-09).
  /**
   * The destination, remembered — whoever files into Base Library tends to do it for a run of work,
   * not once. Defaults to Library, which is where every previous match went.
   */
  const [destDb, setDestDb] = useState(() => {
    try {
      const saved = localStorage.getItem('kyros.photoMatch.dest');
      return DESTINATIONS.some((d) => d.value === saved) ? saved : 'eddy-library';
    } catch { return 'eddy-library'; }
  });
  useEffect(() => {
    try { localStorage.setItem('kyros.photoMatch.dest', destDb); } catch { /* private mode */ }
  }, [destDb]);
  // Both handles are created once and kept: createEddyCollection caches per database, so asking for
  // the same name twice returns the same instance and the same write queue.
  const libraryStore = useMemo(() => createEddyCollection('eddy-library'), []);
  const baseStore = useMemo(() => createEddyCollection('eddy-base'), []);
  const destStore = destDb === 'eddy-base' ? baseStore : libraryStore;
  const destLabel = DESTINATIONS.find((d) => d.value === destDb)?.label || 'Library';
  // Read at await time by the queued call, so a destination changed mid-run cannot be captured
  // stale by a job that was enqueued earlier.
  const destDbRef = useRef(destDb);
  destDbRef.current = destDb;
  const [chars, setChars] = useState([]);        // folders in eddy-character
  const [charItems, setCharItems] = useState([]);
  const [charThumbs, setCharThumbs] = useState({});
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [f, i] = await Promise.all([charStore.listFolders(), charStore.listItems()]);
        if (!alive) return;
        /**
         * THE LIST FIRST, THE PICTURES AFTER — and only the ones actually on screen.
         *
         * This loaded EVERY image of EVERY character as a full data URL before rendering anything,
         * and character references are multi-megabyte photos. Six characters with a few each is
         * tens of megabytes decoded into base64 in the browser, on a page that shows one small
         * tile per character (owner, 2026-08-16: the character section takes ages on his MacBook).
         *
         * The tiles need ONE picture each — her base photo, or her earliest. The rest are identity
         * evidence, needed only when a run actually starts, and handleMatch already falls back to
         * charStore.getImage for anything not in this map. So they are fetched at the moment they
         * are used instead of at page open.
         *
         * Names and folders are set BEFORE the pictures are read, so the picker draws immediately
         * and fills in, rather than showing nothing until the slowest image has decoded.
         */
        setChars(f); setCharItems(i);

        const leadOf = (folderId) => {
          const mine = i.filter((it) => it.folderId === folderId && it.role !== 'scene');
          return mine.find((it) => it.role === 'base')
            || [...mine].sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0))[0];
        };
        // A pair character has no images of its own — its tile shows one of its members'.
        const leads = f.map((folder) => {
          const kids = f.filter((c) => (c.parentId || null) === folder.id);
          return leadOf(kids.length ? kids[0].id : folder.id);
        }).filter(Boolean);

        const map = {};
        await Promise.all(leads.map(async (it) => {
          map[it.id] = it.url || await charStore.getImage(it.id);
        }));
        if (!alive) return;
        setCharThumbs(map);
      } catch { /* an unreadable collection shows the empty state, not a broken page */ }
    })();
    return () => { alive = false; };
  }, [charStore]);

  const [sources, setSources] = useState([]);        // batch targets [{id, dataUrl}]
  /**
   * SEVERAL CHARACTERS, not one.
   *
   * Every source photo is recreated once per ticked character, so one scene can be compared
   * across models in a single run instead of one run each with a manual re-pick between them
   * (owner, 2026-08-10).
   *
   * characterId stays as the HEAD of the list rather than being replaced: it feeds eddyRefs,
   * charName, the cost line and the identity badge, and every one of those is correct for a
   * single-character run. Keeping it means the existing behaviour is untouched when one is
   * ticked, and the list is what the run loop iterates.
   */
  const [characterIds, setCharacterIds] = useState([]);
  const characterId = characterIds[0] ?? null;
  const setCharacterId = useCallback((id) => setCharacterIds(id ? [id] : []), []);
  const toggleCharacter = useCallback((id) => {
    setCharacterIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }, []);

  const [extra, setExtra] = useState(_cache.extra);
  const [exactRecreate, setExactRecreate] = useState(_cache.exactRecreate);
  const [varyBackground, setVaryBackground] = useState(_cache.varyBackground);
  const [nsfw, setNsfw] = useState(_cache.nsfw);
  const [blurSource, setBlurSource] = useState(_cache.blurSource ?? true);
  const blurSourceRef = useRef(blurSource);
  useEffect(() => { blurSourceRef.current = blurSource; }, [blurSource]);
  const [faceless, setFaceless] = useState(_cache.faceless ?? false);
  /**
   * WHOSE OUTFIT. false = the scene's (the default, and what Photo Match has always done);
   * true = hers, from her reference photos. Cached with the rest of Match Mode so it survives a
   * reload like every other switch on this card.
   */
  const [outfitFromChar, setOutfitFromChar] = useState(_cache.outfitFromChar ?? false);
  /**
   * EYES TO CAMERA. Off by default: the source's gaze is part of the shot being reproduced, and
   * forcing it every time turns every candid into a portrait. A toggle, because it is a switch that
   * adds an instruction — unlike the outfit choice, which picks between two sources.
   */
  const [lookAtCamera, setLookAtCamera] = useState(_cache.lookAtCamera ?? false);
  const [blurringAll, setBlurringAll] = useState(false);
  // {done, total} while a batch is being scanned, null otherwise. Five hundred photos take about a
  // minute and a half; without a count that is indistinguishable from the page having hung.
  const [scanning, setScanning] = useState(null);
  // Show only the photos that came back without a blur, so a handful out of hundreds can be found.
  const [showUnblurredOnly, setShowUnblurredOnly] = useState(false);
  const [manualBlurId, setManualBlurId] = useState(null);  // source id being hand-blurred, or null
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolution, setResolution] = useState(_cache.resolution);
  /**
   * DEFAULTS TO 'Very large' (owner, 2026-08-16), not to 'From her photos'.
   *
   * A default is a statement about the usual case, and here the usual case is a character who IS
   * built that way — starting neutral meant re-picking it on every run and losing it on every
   * restart. It changes nothing about how the option behaves: it still names the size the
   * preservation locks are holding rather than asking for a change, so it does not stand them
   * down the way a Body chip does, and a back-facing source still gets the variant that only
   * describes what the camera can see.
   *
   * 'From her photos' remains one click away and still emits nothing at all.
   */
  const [build, setBuild] = useState(_cache.build || 'verylarge');
  // 'seedream' | 'nano2'. Both go through the same /api/seedream/edit route and the same
  // WaveSpeed key -- `model` is the only thing that differs -- so a result gets the same
  // imageStore write, gallery row and tagging either way.
  const [engineSD, setEngine] = useState(_cache.engine || 'seedream');
  // NB2's tab has exactly one engine -- the bypass -- so its toggle is not a choice there. The SD
  // tab keeps its Seedream / Nano Banana 2 pair. Everything downstream still reads one `engine`.
  const engine = isNB2 ? 'nb2' : engineSD;

  const [galleryImages, setGalleryImages] = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [showGallery, setShowGallery] = useState(false);

  const [jobs, setJobs] = useState([]);
  const [running, setRunning] = useState(false);
  const [sessionSpend, setSessionSpend] = useState(() => {
    try { return Number(sessionStorage.getItem(SPEND_KEY)) || 0; } catch { return 0; }
  });
  const [dragging, setDragging] = useState(false);

  // Restore the sources / character / prompt that were on the page last time.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s, charId, ex] = await Promise.all([
        store.get('sources', []), store.get('characterIds', null), store.get('extra', ''),
      ]);
      if (cancelled) return;
      // Never clobber: this resolves AFTER the (synchronous) source-handoff effect, so images
      // just sent from Frame Library would otherwise be overwritten by the old saved ones.
      if (Array.isArray(s) && s.length) setSources((cur) => (cur.length ? cur : s));
      // Restores the LIST. A stored single id from before this change still loads, so an
      // in-progress selection is not thrown away by the upgrade.
      if (charId) {
        const ids = Array.isArray(charId) ? charId : [charId];
        setCharacterIds((cur) => (cur.length ? cur : ids.filter(Boolean)));
      }
      if (ex) setExtra((cur) => (cur ? cur : ex));
      setRestored(true);
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * Persist only after restore, or the first empty render would wipe the save.
   *
   * DEBOUNCED since the cap went to 500: this serialises every source photo, and at that size the
   * snapshot is ~160 MB. Writing it on each individual state change — which is what happened while
   * a batch was landing — is a second freeze right behind the one the workers just removed. A
   * second of quiet is long past the end of any burst and far short of anything that could be lost.
   */
  useEffect(() => {
    if (!restored) return undefined;
    const t = setTimeout(() => store.set('sources', sources), 1000);
    return () => clearTimeout(t);
  }, [sources, restored]);
  useEffect(() => { if (restored) store.set('characterIds', characterIds); }, [characterIds, restored]);
  useEffect(() => { if (restored) store.set('extra', extra); }, [extra, restored]);

  useEffect(() => { _cache.extra = extra; }, [extra]);
  useEffect(() => { _cache.engine = engineSD; }, [engineSD]);
  useEffect(() => { _cache.build = build; }, [build]);
  useEffect(() => { _cache.nsfw = nsfw; }, [nsfw]);
  useEffect(() => { _cache.blurSource = blurSource; }, [blurSource]);
  useEffect(() => { _cache.faceless = faceless; }, [faceless]);
  useEffect(() => { _cache.outfitFromChar = outfitFromChar; }, [outfitFromChar]);
  useEffect(() => { _cache.lookAtCamera = lookAtCamera; }, [lookAtCamera]);
  // Turning NSFW on removes any already-typed outfit-keeping chip. Left in, it would contradict
  // the removal line and the model would do neither — the exact failure this toggle had before.
  useEffect(() => {
    if (!nsfw) return;
    const keepOutfit = PRESETS.find((preset) => preset.dressedOnly);
    if (keepOutfit) setExtra((prev) => (prev.includes(keepOutfit.text) ? prev.replace(keepOutfit.text, '').replace(/\s+/g, ' ').trim() : prev));
  }, [nsfw]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolution = resolution; }, [resolution]);
  useEffect(() => { _cache.exactRecreate = exactRecreate; }, [exactRecreate]);
  useEffect(() => { _cache.varyBackground = varyBackground; }, [varyBackground]);
  useEffect(() => { try { sessionStorage.setItem(SPEND_KEY, String(sessionSpend)); } catch { /* ignore */ } }, [sessionSpend]);

  /**
   * No server fetch any more. `characterId` is now an Eddy FOLDER id, and asking the characters API
   * for it would 404 on every selection — a failing request per click, for a detail record that
   * cannot exist. Her photos come straight out of the collection below.
   *
   * charDetail stays null as a result, so `masterPrompt` is simply absent: it is a field of the
   * server's character records and an Eddy character never had one.
   */
  const charDetail = null;
  /**
   * Her photos, with the one marked BASE in the Character tab FIRST.
   *
   * Order is not cosmetic: the model treats the leading image as the primary subject, and the
   * Character tab already lets you mark which photo is the base face. Sorting purely by date
   * would hand it whichever photo happened to be uploaded first. Same rule as the Base tab.
   */
  // Pulled out so the run loop can resolve refs for EVERY ticked character, not just the head.
  // Same ordering rule for all of them -- base face first -- because the model treats the leading
  // image as the primary subject.
  /** The photos filed directly in one folder, best identity image first. */
  const ownItems = useCallback((id) => {
    /**
     * A SCENE image is not identity, and was being sent as if it were.
     *
     * The Characters page lets an image be tagged SCENE — 'the picture whose background and
     * setting should be reused'. It is a location, and it may not contain her at all. Photo Match
     * was passing it in with her face photos, telling the model 'this is also her', which is
     * evidence pointing away from the character on the one page whose whole job is holding one.
     *
     * Photo Match takes its scene from the SOURCE photo, so it has no use for a scene reference
     * at all.
     */
    const mine = charItems.filter((i) => i.folderId === id && i.role !== 'scene');
    const rank = (i) => (i.role === 'base' ? 0 : i.role === 'body' ? 1 : 2);
    return [...mine].sort((a, b) => rank(a) - rank(b) || (a.createdAt || 0) - (b.createdAt || 0));
  }, [charItems]);

  /**
   * A CHARACTER WITH SUBFOLDERS IS A PAIR — two named women who come out in ONE photograph.
   *
   * Nothing new is stored to say so. Character folders have had `parentId` since subfolders
   * existed, the picker already lists every folder, and a parent holding only subfolders was
   * previously DEAD here — refsForCharacter read images filed directly in the folder, found none,
   * and the run stopped with "no identity image could be loaded". So this claims a shape that was
   * broken rather than overriding anything anyone uses.
   *
   *   Arya & Rosary        <- tick this, get both women in one photo
   *      +- Arya           <- tick alone, ordinary single-character run, unchanged
   *      +- Rosary
   *
   * Ticking two separate top-level characters still makes two SEPARATE photos, which is the
   * compare-a-scene-across-characters behaviour this page was built with.
   */
  const membersOf = useCallback((id) => (id ? chars.filter((c) => (c.parentId || null) === id) : []), [chars]);

  /**
   * The identity images, flattened in member order so each woman occupies a contiguous run of
   * image slots — which is what lets the prompt say "images 1-4 = Arya, images 5-8 = Rosary".
   *
   * The nine slots (Seedream takes ten images and the source claims one) are split evenly. Four
   * photos each is fewer than a single character gets, and that is the trade: two identities in
   * one request cost half the evidence apiece.
   */
  const refsForCharacter = useCallback((id) => {
    if (!id) return [];
    const members = membersOf(id);
    if (!members.length) return ownItems(id);
    const per = Math.max(1, Math.floor(MAX_CHAR_IMAGES / members.length));
    return members.flatMap((m) => ownItems(m.id).slice(0, per));
  }, [ownItems, membersOf]);

  /**
   * Who is in the frame and which image indexes are hers — null for an ordinary character, so the
   * prompt builder takes its single-character path and every existing run is untouched.
   *
   * Counted from the images that will ACTUALLY be sent, not from the split, because a member whose
   * folder holds two photos contributes two — assuming the even split here would mislabel every
   * range after the first and hand Rosary's images to Arya.
   */
  const castOf = useCallback((id) => {
    const members = membersOf(id);
    if (members.length < 2) return null;
    const per = Math.max(1, Math.floor(MAX_CHAR_IMAGES / members.length));
    const cast = [];
    let at = 1;
    for (const m of members) {
      const n = ownItems(m.id).slice(0, per).length;
      if (!n) continue;                       // an empty member is skipped, not left naming nothing
      cast.push({ name: m.name, from: at, to: at + n - 1 });
      at += n;
    }
    return cast.length > 1 ? cast : null;     // one usable member is just that character
  }, [membersOf, ownItems]);
  const eddyRefs = useMemo(() => refsForCharacter(characterId), [refsForCharacter, characterId]);
  const charName = chars.find((c) => c.id === characterId)?.name || '';
  // NOT filtered by isActive: references are created with isActive:false by default
  // (server/services/referenceManager.js), so filtering on it silently discarded every one of
  // the character's photos and left just her main image to carry the identity. The Gemini
  // route reads character.references with no such filter (server/routes/photoMatch.js) — that
  // is why it sees the whole character and this page did not.
  const activeRefs = charDetail?.references || [];
  // Characters here store their photos as PRIMARY images, not references — every character in
  // this install has 0 references. Reading only `references` meant one lone identity image went
  // up against the source photo, and Seedream took the source's face about as often as not.
  const primaryCount = eddyRefs.length;
  // Character contributes every primary image + each reference.
  const charImageCount = characterId ? eddyRefs.length : 0;
  const charImagesUsed = Math.min(charImageCount, MAX_CHAR_IMAGES);
  const charTruncated = charImageCount > MAX_CHAR_IMAGES;

  const imagesPerJob = 1 + charImagesUsed;
  // Priced per ENGINE. Showing Seedream's rate while Nano Banana 2 runs would misstate the bill
  // on the one control where spend is agreed.
  const costPerJob = isNB2
    ? (NB2_COST[resolution] ?? NB2_COST['1K'])
    : engine === 'nano2'
      ? (NANO2_COST[resolution] ?? NANO2_COST['1K'])
      : seedreamCost(resolution, imagesPerJob);
  /**
   * The run is photos x CHARACTERS. Ticking a second woman doubles the bill, and the price on the
   * button is where that has to be visible -- it is the one number agreed before spending.
   */
  const runCount = Math.max(1, sources.length) * Math.max(1, characterIds.length);
  const totalCost = costPerJob * runCount;

  // ── sources ────────────────────────────────────────────────────────────────
  /**
   * EVERY PHOTO ENTERS THE PAGE THROUGH HERE.
   *
   * Dropping a file and sending from the Library used to be two separate intakes. The drop path
   * detected the face, blurred it and flagged back views; the Library path pushed the picture
   * straight into state. So a batch sent from the Library arrived UNBLURRED with auto-blur switched
   * on, counted as front-facing whatever it showed, and ignored the 50-photo cap entirely — three
   * bugs that only existed because the same job was written twice (owner, 2026-08-17: "and it can
   * support mass draging or send from library or anything ye").
   *
   * One intake, so anything that can put a picture on this page gets the same treatment. Returns
   * how many were actually taken.
   */
  const intakeUrls = useCallback(async (urls, { mode = 'add' } = {}) => {
    const replace = mode === 'replace';
    // Deduped on the image itself: sending the same pin twice must not queue it twice. A replace
    // starts from an empty page, so only the incoming batch can collide with itself.
    const have = new Set(replace ? [] : sources.map((s) => s.dataUrl));
    const fresh = [];
    for (const url of urls || []) {
      if (!url || have.has(url)) continue;
      have.add(url);
      fresh.push(url);
    }
    /**
     * A BATCH THAT DOES NOT FIT MUST SAY SO.
     *
     * Dropping eighty photos with room for fifty silently kept fifty. That looks identical to "it
     * worked" — you only find out by counting tiles, which nobody does before pressing Generate.
     */
    const room = replace ? MAX_SOURCES : MAX_SOURCES - sources.length;
    if (room <= 0) { notify(`Already at the ${MAX_SOURCES}-photo limit — clear some first`, 'error'); return 0; }
    const take = fresh.slice(0, room);
    const dupes = (urls || []).length - fresh.length;
    const overflow = fresh.length - take.length;
    if (dupes) notify(`${dupes} photo${dupes === 1 ? ' is' : 's are'} already here`, 'info');
    if (overflow) notify(`${overflow} photo${overflow === 1 ? '' : 's'} left out — the limit is ${MAX_SOURCES}`, 'error');
    if (!take.length) return 0;
    let missed = 0;
    const wantBlur = blurSourceRef.current;
    /**
     * DETECTION RUNS ON WORKERS, and that is the difference between usable and not.
     *
     * One photo costs ~945ms of cascade sweep — benchmarked over 25 real photos at these exact
     * parameters. JavaScript is single-threaded, so this Promise.all does NOT run them at the same
     * time: on the main thread 500 photos is about eight minutes with the window frozen solid. A
     * pool of workers turns that into roughly eighty seconds with the page still alive.
     *
     * The worker does the blur too. Sending only the box back would mean every full-size photo is
     * decoded and re-encoded on the UI thread anyway, which is its own freeze at this scale.
     *
     * The main-thread path stays as the fallback for any photo a worker could not take — no
     * environment gets a silently unprocessed photo.
     */
    const onMainThread = async (incoming) => {
      // Detected on the ORIGINAL, before any blur: reading a blurred-out face as "no face" would
      // flip every face-blurred front photo to a back view.
      const face = await findFace(incoming).catch(() => ({ box: null, present: false }));
      if (!wantBlur) return { dataUrl: incoming, blurred: false, present: face.present };
      const out = await blurFound(incoming, face);
      return { dataUrl: out.dataUrl, blurred: out.blurred, present: face.present };
    };
    const useWorkers = poolAvailable() && take.length > 1;
    if (useWorkers) setScanning({ done: 0, total: take.length });
    const results = useWorkers
      ? await runBatch(take, {
        blur: wantBlur,
        fallback: onMainThread,
        onProgress: (done, total) => setScanning({ done, total }),
      })
      : await Promise.all(take.map(onMainThread));
    setScanning(null);
    const added = take.map((incoming, i) => {
      const r = results[i] || { dataUrl: incoming, blurred: false, present: false };
      if (wantBlur && !r.blurred) missed += 1;
      // `present`, not the box: a loose match the gate refused still means a face is probably
      // there, so the shot is not a back view even though nothing was blurred.
      return {
        id: `s-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
        dataUrl: r.dataUrl,
        blurred: r.blurred,
        backView: !r.present,
        /**
         * The photo as it arrived, kept ONLY when the blur changed it — so the blur can be undone.
         *
         * Detection is not perfect and never will be: it sometimes paints over a chest instead of a
         * face, and until now the original was gone the moment that happened, leaving no way back
         * except deleting the tile and dropping the file again (owner, 2026-08-17: "i want have a
         * undo blur for i chose the blur place myself").
         *
         * Only for blurred photos, so an unblurred batch costs nothing extra, and dropped again as
         * soon as it is used.
         */
        ...(r.blurred ? { orig: incoming } : {}),
      };
    });
    if (missed) notify(`${missed} photo${missed === 1 ? '' : 's'}: no face found even on the second pass — use the "no face" filter to blur them by hand`, 'error');
    setSources((prev) => (replace ? added : [...prev, ...added]));
    return added.length;
  }, [sources, notify]);

  /** Files — a drop, a paste, the file picker, the gallery. Everything else is intakeUrls' job. */
  const addSources = useCallback(async (files) => {
    const all = Array.from(files || []);
    const images = all.filter((f) => /^image\/(png|jpeg|jpg|webp)$/i.test(f.type));
    // Silently dropping the odd HEIC or PDF out of a drag reads as "it worked" too.
    const skipped = all.length - images.length;
    if (skipped) notify(`${skipped} file${skipped === 1 ? '' : 's'} skipped — only PNG, JPEG and WEBP can be used`, 'error');
    if (!images.length) return;
    const urls = (await Promise.all(images.map((f) => fileToDataUrl(f).catch(() => null)))).filter(Boolean);
    const unreadable = images.length - urls.length;
    if (unreadable) notify(`${unreadable} file${unreadable === 1 ? '' : 's'} could not be read`, 'error');
    await intakeUrls(urls);
  }, [intakeUrls, notify]);

  // Re-run face detection over every source that isn't already blurred, in AGGRESSIVE mode (a
  // looser threshold that catches the profile/tilted faces pico misses on its first, conservative
  // pass at paste time). Only un-blurred sources are touched, so pressing it twice is safe and it
  // never re-blurs a face that's already gone. Whatever it still can't find is reported so you
  // know to hand-blur those.
  const blurAllFaces = useCallback(async () => {
    const targets = sources.filter((s) => !s.blurred);
    if (!targets.length) { notify('Every source is already blurred', 'info'); return; }
    setBlurringAll(true);
    let blurred = 0; let missed = 0;
    // On the workers, same as intake — this is the button most likely to be pressed on 500 photos,
    // and on the main thread that is eight minutes of frozen window.
    const useWorkers = poolAvailable() && targets.length > 1;
    if (useWorkers) setScanning({ done: 0, total: targets.length });
    const out = useWorkers
      ? await runBatch(targets.map((s) => s.dataUrl), {
        blur: true,
        fallback: (url) => autoBlurFace(url),
        onProgress: (done, total) => setScanning({ done, total }),
      })
      : await Promise.all(targets.map((s) => autoBlurFace(s.dataUrl)));
    setScanning(null);
    const results = targets.map((s, i) => {
      const r = out[i];
      // Keep whatever original this source already had; if it had none, this run is what changed it.
      if (r?.blurred) { blurred += 1; return { id: s.id, dataUrl: r.dataUrl, blurred: true, orig: s.orig || s.dataUrl }; }
      missed += 1; return null;
    });
    const byId = new Map(results.filter(Boolean).map((r) => [r.id, r]));
    setSources((prev) => prev.map((s) => (byId.has(s.id) ? { ...s, ...byId.get(s.id) } : s)));
    setBlurringAll(false);
    if (blurred && !missed) notify(`Blurred ${blurred} face${blurred === 1 ? '' : 's'} ✨`, 'success');
    else if (blurred) notify(`Blurred ${blurred}; ${missed} still had no detectable face — click those to blur by hand`, 'error');
    else notify('No faces detected — click a photo to blur by hand', 'error');
  }, [sources, notify]);

  // Apply a hand-drawn blur box from the modal and mark that source blurred. The original is kept
  // if this is the first blur on that photo, so undo works on a hand-drawn box too.
  const applyManualBlur = useCallback((id, newDataUrl) => {
    setSources((prev) => prev.map((s) => (s.id === id
      ? { ...s, dataUrl: newDataUrl, blurred: true, orig: s.orig || s.dataUrl }
      : s)));
    setManualBlurId(null);
    notify('Face blurred by hand ✨', 'success');
  }, [notify]);

  /**
   * PUT THE PHOTO BACK THE WAY IT ARRIVED.
   *
   * Detection is right most of the time and wrong some of the time, and when it is wrong it has
   * painted over a chest or a hip. Until now that was permanent: the original was replaced in place,
   * so the only way back was deleting the tile and finding the file again — and the hand-blur tool
   * was useless, because it could only draw on top of the smear (owner, 2026-08-17).
   *
   * Undo restores the untouched photo and clears the blurred flag, which is exactly the state where
   * clicking the tile lets you draw the box yourself.
   */
  const undoBlur = useCallback((id) => {
    setSources((prev) => prev.map((s) => (s.id === id && s.orig
      // `orig` is dropped, not kept: the photo IS the original again, and holding a second copy of
      // every restored photo is real memory at five hundred sources.
      ? { id: s.id, dataUrl: s.orig, blurred: false, backView: s.backView }
      : s)));
    notify('Blur undone — click the photo to draw the blur yourself', 'info');
  }, [notify]);

  const unblurredCount = sources.filter((s) => !s.blurred).length;

  useEffect(() => {
    const onPaste = async (e) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type?.startsWith('image/'));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      e.preventDefault();
      await addSources([file]);
      notify('Pasted into Source Photos ✨', 'success');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addSources, notify]);

  /**
   * DROPPING ANYWHERE ON THE PAGE, not just on the dashed box.
   *
   * Paste was bound to the WINDOW and drop only to the drop-zone div, so pasting worked everywhere
   * and dragging worked only if you happened to release the mouse inside one small rectangle —
   * which is scrolled out of view as soon as the page has any content. Dropped anywhere else the
   * file hit Electron's default handler and nothing happened at all (owner, 2026-08-17: 'i drag
   * and it dont work but i copy paste it work').
   *
   * dragover must preventDefault too, or the drop event never fires — the browser only offers a
   * drop target to a handler that has said it will take one.
   */
  useEffect(() => {
    const onDragOver = (e) => { e.preventDefault(); };
    const onDrop = async (e) => {
      const files = Array.from(e.dataTransfer?.files || []).filter((f) => /^image\//i.test(f.type));
      if (files.length) {
        e.preventDefault();
        await addSources(files);
        notify(`Dropped ${files.length} photo${files.length === 1 ? '' : 's'} into Source Photos ✨`, 'success');
        return;
      }
      /**
       * An image dragged out of a BROWSER carries a URL, not a file — dataTransfer.files is empty.
       * Fetching it here is blocked by CORS on most image hosts, so rather than appear broken it
       * says what happened and names the two things that do work.
       */
      const url = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
      if (url && /^https?:/i.test(url)) {
        e.preventDefault();
        notify('That came from a browser as a link, not a file — right-click and save it first, or copy the image and paste it here with Ctrl+V.', 'error');
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [addSources, notify]);

  useEffect(() => {
    const pending = consumeSourceHandoff(PHOTO_MATCH_HANDOFF_KEY);
    const items = pending.filter((p) => p?.dataUrl);
    if (!items.length) return;
    /**
     * REPLACE or ADD, as the sender asked.
     *
     * This always replaced, so sending a second batch from Pinterest silently discarded the first
     * -- fine when you meant a new scene, wrong when you were building one set out of several
     * searches. The sender writes its intent alongside the stash; absent means ADD, because losing
     * work is the worse mistake of the two (owner, 2026-08-10).
     */
    let mode = 'add';
    try { mode = window.sessionStorage.getItem('kyros.pendingSourceMode.photoMatchSeedream') || 'add'; } catch { /* private mode */ }
    try { window.sessionStorage.removeItem('kyros.pendingSourceMode.photoMatchSeedream'); } catch { /* ignore */ }
    /**
     * Through the SAME intake as a dropped file — see intakeUrls.
     *
     * This used to build the tiles itself, which meant a picture sent from the Library was never
     * face-blurred, never checked for a back view, and never counted against the cap.
     */
    (async () => {
      const took = await intakeUrls(items.map((it) => it.dataUrl), { mode });
      if (took) notify(`${took} source${took > 1 ? 's' : ''} ${mode === 'replace' ? 'loaded' : 'added'} ⚡`, 'success');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchGallery = useCallback(async () => {
    setGalleryLoading(true);
    try {
      const res = await galleryApi.list();
      setGalleryImages(res.images || res || []);
    } catch { /* gallery is optional */ }
    finally { setGalleryLoading(false); }
  }, []);

  const pickFromGallery = async (imgId) => {
    try {
      const resp = await fetch(galleryApi.imageUrl(imgId), { credentials: 'include' });
      if (!resp.ok) throw new Error('Failed to load image');
      const blob = await resp.blob();
      await addSources([new File([blob], 'gallery', { type: blob.type })]);
      setShowGallery(false);
    } catch (err) {
      notify(err.message || 'Failed to load gallery image', 'error');
    }
  };

  // ── run ────────────────────────────────────────────────────────────────────
  /**
   * Said ONCE per run, not once per picture. On a 200-image batch with the bypass refusing
   * everything, one notification per image is two hundred toasts carrying one fact.
   *
   * Declared ABOVE runOne, which reads it — the same use-before-define this file carries a
   * warning about on runIdsRef.
   */
  const warnedFallback = useRef(false);

  /**
   * Put a finished picture into the chosen collection, under her name.
   *
   * Stored as a URL rather than bytes, exactly as Eddy does it: the server already holds the
   * file, and copying megabytes into IndexedDB per image is what that choice exists to avoid.
   *
   * Shared by the live run, the resume-on-open and the retry. One copy, so a picture recovered
   * after a page change is filed identically to one watched all the way through.
   */
  const filePicture = useCallback(async (first, who, usedPrompt) => {
    if (!first?.galleryId) return;
    const name = (who || '').trim();
    // Her folder is created in THAT collection — the two are separate databases, so a 'Grace'
    // folder in one says nothing about the other.
    const dest = (await destStore.ensureFolder(name || 'Photo Match'))?.id || null;
    const filed = await destStore.addItems([{
      url: galleryApi.imageUrl(first.galleryId),
      /**
       * THE PROMPT THAT ACTUALLY MADE IT, so the Library's Copy button has something to copy.
       *
       * This was the label `Photo Match - <her>` and nothing more, so the instruction the picture
       * was built from — every chip, every lock, the identity rules — vanished the moment the run
       * ended and there was no way to reproduce a result you liked (owner, 2026-08-16).
       *
       * The label is kept as the FIRST line so the panel and the collection filters still read
       * 'Photo Match …' exactly as they did, with the full text below it.
       */
      prompt: usedPrompt
        ? `Photo Match - ${name || 'no character'}\n\n${usedPrompt}`
        : `Photo Match - ${name || 'no character'}`,
      name: `photomatch-${Date.now()}`,
      // WHOSE PICTURE, on the row itself — not only in the folder name.
      //
      // The bulk 'Send to Library' button has always written this; the live run never did, so a
      // picture filed as it was made carried no character and one moved by hand did. A folder can
      // be renamed or the row dragged elsewhere, and then the only record of who she is has gone.
      // charName is in the collection's allowlist, so it survives the write.
      ...(name ? { charName: name } : {}),
    }], dest);
    // addItems reports a storage failure by RETURNING an empty array rather than throwing.
    if (!Array.isArray(filed) || filed.length === 0) {
      throw new Error(`Browser storage is full - the picture is in the gallery but not in ${destLabel}`);
    }
  }, [destStore, destLabel]);

  /**
   * WHOSE PICTURE THIS IS — passed in, not read off the page.
   *
   * runOne is called once per SOURCE x CHARACTER, but it was reading the component-level
   * charName, which is the HEAD of the ticked list. So a run with Grace, Mia and Chloe tagged
   * every picture 'Grace' and filed all three into Grace's folder — the other two women's work
   * landed under her name, and the only way to find it was by eye.
   *
   * Falls back to charName so a single-character run behaves exactly as before.
   */
  /**
   * A REFUSAL, told apart from a fault. Google declines to draw an image and answers with no
   * picture; that is worth handing to Seedream, and a missing key or an empty balance is not.
   */
  const isRefusal = (msg) => /content filter|IMAGE_OTHER|IMAGE_SAFETY|PROHIBITED_CONTENT|BLOCKLIST|refused this image|returned no image/i.test(String(msg || ''));
  const isTerminalForRetry = (msg) => /API key|out of credits|top up|Insufficient credits|balance/i.test(String(msg || ''));

  /**
   * `forceEngine` runs this one job on a named engine regardless of the page's selection — used by
   * the automatic Seedream fallback below and by the per-tile "Retry on WaveSpeed" button.
   */
  const runOne = async (source, charRefs, ratio, prompt, who, { forceEngine = null } = {}) => {
    const whoName = String(who?.name || charName || '').trim();
    const jobId = source.id;
    const feedId = `photomatch-sd-${jobId}`;
    pushPending({ id: feedId, prompt: 'Photo Match (Seedream)', imageModel: 'Seedream 5.0 Pro Edit', aspectRatio: ratio, resolutionTier: resolution });
    /**
     * WHICH ENGINE, said out loud while it is still running.
     *
     * The finished tile has named its engine for a while, but a tile that is still going said only
     * "Matching…" — and with an automatic fallback in the middle, "is this Google or WaveSpeed?" is
     * exactly the question you have while you are waiting, not after (owner, 2026-08-18: "it not
     * showing if it is gemini no wavespeed u get me"). It updates when the fallback fires.
     */
    const asked = forceEngine || (isNB2 ? 'nb2' : engine === 'nano2' ? 'nano2' : 'seedream5');
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: 'running', runningOn: asked } : j)));

    try {
      const sourceImg = parseDataUrl(source.dataUrl);
      if (!sourceImg) throw new Error('Could not read the source photo');

      /**
       * Through the durable queue, same as Eddy.
       *
       * The return shape is unchanged — { images, provider } — so everything below that reads
       * data.images[0] is untouched. What changes is that the SERVER holds the render rather than
       * this page holding an HTTP connection for three minutes, which is what capped this at six
       * regardless of the lane count.
       *
       * destDb and the character folder ride along so that a run interrupted by the app closing is
       * filed into the same place it would have gone, rather than needing to be found by hand.
       */
      let claimedJobId = null;
      /**
       * THE AUTOMATIC SEEDREAM FALLBACK, on this side of the wire.
       *
       * The QUEUE is the primary fallback and the better one: five tries, server-side, able to tell
       * a refusal from a rate limit. This is the second line, and it cannot race it — it runs only
       * in the catch, i.e. only once the queue has already failed the job and finished with it. A
       * job the queue swapped successfully never reaches it, so nothing is paid for twice.
       *
       * It exists because the queue's fallback was silently disabled twice in one day — by a bug
       * that lost the API keys, and by a sentence containing the words "out of credits" — and both
       * times the symptom was the same: a red tile, a Retry button, and a person clicking it. The
       * owner's ask was plain: "the fall back should be automatic to wavespeed".
       *
       * Not for key or credit failures. Seedream bills a DIFFERENT account, so silently moving a
       * dead-key job there is exactly the substitution the queue refuses to make.
       */
      let usedClientFallback = false;
      const send = (model) => withRateLimitRetry(() => queuedSeedreamEdit({
        feature: FEATURE,
        images: [...charRefs, sourceImg],
        // Her photos come first and the scene last — this says where the boundary is, so the
        // bypass can label each group in place rather than handing Gemini one anonymous pile.
        identityCount: charRefs.length,
        prompt,
        aspectRatio: ratio,
        resolution,
        model,
        provider: 'wavespeed',
        // Her name travels with the generation so "Recover missing" can file a stranded Photo
        // Match picture into the right folder, exactly as it does for Eddy's.
        tags: whoName ? ['eddy', whoName] : ['eddy'],
        destDb: destDbRef.current,
        destFolder: whoName || 'Photo Match',
        cardPrompt: `Photo Match - ${whoName || 'no character'}`,
        onJobId: (id) => { claimedJobId = id; _awaiting.add(id); },
      })).finally(() => { if (claimedJobId) _awaiting.delete(claimedJobId); });

      let data;
      try {
        data = await send(asked);
      } catch (sendErr) {
        const msg = String(sendErr?.message || '');
        // Only a bypass job has anywhere better to go, and only a refusal is worth moving.
        if (asked !== 'nb2' || !isRefusal(msg) || isTerminalForRetry(msg)) throw sendErr;
        setJobs((prev) => prev.map((j) => (j.id === jobId
          ? { ...j, status: 'running', runningOn: 'seedream5', error: 'Google refused it — trying Seedream 5 Pro…' } : j)));
        data = await send('seedream5');
        usedClientFallback = true;
      }

      /**
       * The engine that actually produced it, read back from the queue rather than assumed.
       *
       * An NB2 job the bypass could not finish is handed to Seedream 5 Pro by the reconciler
       * (NB2_ATTEMPTS). Keeping the requested engine on the tile would leave a Seedream picture
       * claiming to be NB2 — the same shape of quiet lie as a tick with no proof behind it.
       */
      const ranOn = data.model === 'seedream5' ? 'seedream' : data.model === 'nano2' ? 'nano2' : data.model === 'nb2' ? 'nb2' : engine;
      const fellBack = !!data.fellBack || usedClientFallback || (isNB2 && ranOn !== 'nb2');
      const engineLabel = ranOn === 'nb2' ? 'Nano Banana 2 (Gemini bypass)'
        : ranOn === 'nano2' ? 'Nano Banana 2 (WaveSpeed)' : 'Seedream 5.0 Pro Edit';

      const first = (data.images || [])[0];
      if (!first) throw new Error(`${isNB2 ? 'Nano Banana 2 (bypass)' : engine === 'nano2' ? 'Nano Banana 2' : 'Seedream'} returned no image`);

      resolvePending(feedId, {
        galleryId: first.galleryId,
        imageId: first.imageId,
        prompt: isNB2 ? 'Photo Match NB2 (bypass)' : engine === 'nano2' ? 'Photo Match (Nano Banana 2)' : 'Photo Match (Seedream)',
        imageModel: fellBack ? `${engineLabel} (fallback)` : engineLabel,
        aspectRatio: ratio,
        resolutionTier: resolution,
        mimeType: first.mimeType,
        generatedAt: Date.now(),
      });
      // galleryId and the collection it was filed into travel with the job: the results panel below
      // moves pictures between Library and Base Library, and it cannot find a row without them.
      // A small JPEG of the source, so the before/after slider still works after a reload. Awaited
      // before the tile flips to done so the persisted row is complete the first time it is written.
      if (fellBack && !warnedFallback.current) {
        warnedFallback.current = true;
        notify(`Nano Banana 2 could not finish an image after ${NB2_ATTEMPTS} tries — Seedream 5.0 Pro did it instead. Those are marked "fallback".`, 'error');
      }
      const thumbSmall = await shrinkForStorage(source.dataUrl);
      setJobs((prev) => prev.map((j) => (j.id === jobId
        ? {
          ...j,
          status: 'done',
          result: first,
          galleryId: first.galleryId || null,
          filedDb: destDb,
          thumbSmall,
          // WHEN and HOW, so "the last 30" and "the last hour" mean something after a reload, and
          // so a tile can say what made it rather than leaving you to remember.
          doneAt: Date.now(),
          // What THIS picture cost, recorded once. Read off the live controls instead, a tile
          // quoted whatever the engine and resolution are now — so a Seedream fallback showed
          // the bypass's price, and nudging the resolution toggle repriced finished work.
          cost: spent,
          engine: ranOn,
          fellBack,
          resolution,
          mode: exactRecreate ? 'exact' : 'scene',
          faceless,
        }
        : j)));
      /**
       * Priced by what RAN, not by what was asked for. A fallen-back image is a Seedream render
       * on the WaveSpeed key, and charging it at the bypass's rate under-reports the session by
       * roughly forty percent — on the one readout that is supposed to be the honest total.
       */
      const spent = ranOn === 'nb2'
        ? (NB2_COST[resolution] ?? NB2_COST['1K'])
        : ranOn === 'nano2'
          ? (NANO2_COST[resolution] ?? NANO2_COST['1K'])
          : seedreamCost(resolution, imagesPerJob);
      setSessionSpend((s) => s + spent);

      /**
       * INTO EDDY'S LIBRARY, under her name -- the same place, and the same shape, a generation from
       * the Eddy tab lands in.
       *
       * NOT swallowed. Eddy had this same call inside its own catch, which is why a filing miss was
       * invisible AND silent for a day. A miss here reaches the handler below, which keeps the image
       * and says so.
       *
       * Shared with the resume-on-open and the retry, so a picture recovered after a page change is
       * filed identically to one watched all the way through.
       */
      await filePicture(first, whoName, prompt);
    } catch (err) {
      // A FILING miss is not a failed match: the picture exists, is billed, and is on the feed.
      // Marking the job failed would tell the owner to re-run something that already succeeded.
      if (String(err?.message || '').includes('is in the gallery but not in ')) {
        notify(err.message, 'error');
        return;
      }
      rejectPending(feedId);
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: 'failed', error: err.message || 'Match failed' } : j)));
    }
  };

  /**
   * The ids of the run in progress. A ref because writing it must not re-render, and it is only
   * ever read to count. Declared here, above the run that fills it and the memo that reads it —
   * naming it further down is the use-before-define this file has been bitten by.
   */
  const runIdsRef = useRef(new Set());

  /**
   * HOW MANY RUNS ARE IN FLIGHT, so a second Generate is allowed while the first is still going
   * (owner, 2026-08-18: "i wanna be able generated again evne if i i click generated").
   *
   * `running` was a plain boolean set true at the start of a run and false at the end. With two runs
   * overlapping, whichever finished FIRST cleared it — the button would go idle and the progress
   * counter would stop while a dozen images were still rendering. A count is the honest version of
   * the same flag: the page is busy while any run is.
   */
  const runsInFlight = useRef(0);

  /**
   * THE PROMPT BUILDER, HOISTED — because two things build prompts now, not one.
   *
   * All of this lived inside handleMatch, which was fine while a run was the only way to generate.
   * Regenerate and "Retry on WaveSpeed" need exactly the same prompt for exactly the same reasons,
   * and the alternative was a second copy that would drift from this one within a week.
   *
   * Returns a FRESH pair each call: the builder, and a reader for whether anything had to be
   * trimmed to fit the engine's cap. That flag is per-call state — shared across runs it would
   * report a previous batch's trimming.
   */
  const buildPromptFactory = useCallback(() => {
    // A Mood preset deliberately overrides the scene's expression. The base prompt must stop
    // demanding the expression be preserved, or the two instructions cancel and the model does
    // neither — which reads exactly like a broken preset.
    const allowExpressionChange = ALL_PRESETS.some((preset) => preset.expressionChange && extra.includes(preset.text));
    // A Hair preset overrides the references, but the IDENTITY line insists hair comes from
    // them — same cancelling conflict as the expression presets.
    const allowHairChange = ALL_PRESETS.some((preset) => preset.hairChange && extra.includes(preset.text));
    // A Body preset intentionally overrides her real figure, so the "chest size comes from the
    // references" rules must stand down or they cancel it out.
    const allowBodyChange = ALL_PRESETS.some((preset) => preset.bodyChange && extra.includes(preset.text));
    // A Lighting preset overrides the source's lighting, so the "lighting comes from the scene
    // photo" clause must drop or the two cancel — same pattern as expression/hair/body.
    const allowLightingChange = ALL_PRESETS.some((preset) => preset.lightingChange && extra.includes(preset.text));

    const { wantsNude, addGenericNudeLine } = nudeState({ nsfw, instruction: extra });
    /**
     * A prompt PER CHARACTER. It carries her name and her reference count, so one prompt reused
     * across two women would name the wrong one and state the wrong number of identity images.
     *
     * masterPrompt is the head character's only: charDetail is fetched for the selected id, and
     * fetching one per character would be a request each on every run. A master prompt is an
     * optional refinement, so the honest behaviour is to apply it where it is known rather than
     * guess it for the others — noted here because a silently-missing master prompt would look
     * like the preset had stopped working.
     */
    let trimmed = false;
    const promptFor = (who, refCount, source) => {
      /**
       * PER PHOTO, not per run. The page's Faceless switch is one setting for the whole batch, so a
       * batch of twenty where six are shot from behind meant wrecking six or wrecking fourteen.
       * A detected back view turns face-matching off for THAT photo only; the global switch still
       * forces it on for everything.
       */
      const backView = !!source?.backView;
      const base = buildMatchInstruction({
        characterName: who.name,
        // Set only for a pair. The builder names the women from this and ignores characterName —
        // which is the FOLDER's name ("Arya & Rosary", or whatever it was called) and is not
        // something to put in a prompt.
        cast: who.cast,
        // A standing fact about her, not a change — so it does NOT set allowBodyChange and the
        // preservation locks stay up. Back-facing sources get the variant that names only what
        // a shot from behind can actually show.
        buildText: (BUILD_OPTIONS.find((b) => b.value === build) || {})[backView ? 'backText' : 'text'] || '',
        wantsNude,
        addGenericNudeLine,
        // The flag is whether THIS photo's face actually got blurred, not whether the switch is
        // on. The detector misses faces — the amber 'FACE - TAP' badge is exactly that case — and
        // reading the switch announced a blur that was not there while saying nothing about the
        // real face still in the frame.
        sourceFaceBlurred: !!source?.blurred,
        // A back shot IS a faceless shot — there is no face to match and inventing one is the
        // failure. backView adds what faceless alone does not say: which way she is facing, and
        // that she stays that way.
        faceless: faceless || backView,
        backView,
        outfitFromChar,
        lookAtCamera,
        /**
         * The room the base instruction may take, so it can drop a paragraph whole rather than
         * having its tail sliced off. The chips are appended AFTER it and are what the remaining
         * space is for — `extra` is measured here rather than guessed, and so is the one-frame
         * lock, which is appended after everything. Guessing either would cost the builder the
         * graceful degradation it is written to do.
         */
        budget: Math.max(600, (engine === 'seedream' ? SEEDREAM_PROMPT_BUDGET : NANO2_PROMPT_BUDGET)
          - extra.trim().length - singleFrameLock(Array.isArray(who?.cast) ? who.cast.length : 1).length - 10),
        refCount,
        masterPrompt: who.id === characterId ? charDetail?.masterPrompt : undefined,
        exactRecreate,
        varyBackground,
        allowExpressionChange,
        allowHairChange,
        allowBodyChange,
        allowLightingChange,
      });
      let out = extra.trim() ? `${base}\n\n${extra.trim()}` : base;
      /**
       * The clothed lock goes AFTER the chips, which is the whole reason it works.
       *
       * The chips are appended after the base prompt and Seedream weights the tail hardest, so a
       * lock stated before them loses to the very "deep cleavage, straining the garment" text it
       * exists to bound. Only when a bust/figure chip is actually on, and never when the request is
       * nude — there is no garment to keep closed.
       */
      if (allowBodyChange && !wantsNude) out = `${out}\n\n${CLOTHED_FIGURE_LOCK}`;
      // Per engine: Seedream cap is real and fatal, Nano has none. Trimming a Nano prompt to
      // Seedream's limit threw away chips for nothing.
      const budget = engine === 'seedream' ? SEEDREAM_PROMPT_BUDGET : NANO2_PROMPT_BUDGET;
      /**
       * THE ONE-FRAME LOCK IS APPENDED LAST AND SURVIVES THE TRIM.
       *
       * Appending it and then slicing to the budget would cut the very thing just appended —
       * the trim takes from the END, and on a full Seedream prompt that is the lock. So room is
       * made for it FIRST, out of the base text, exactly as the retry nudge does it. A lock that
       * gets trimmed off is worse than no lock: it reads as done and changes nothing.
       */
      const frameLock = singleFrameLock(Array.isArray(who?.cast) ? who.cast.length : 1);
      const room = budget - frameLock.length - 2;
      if (out.length > room) {
        // Seedream 422s on an over-long prompt and the whole batch dies. The base instruction is
        // what makes identity work, so the extra text is what gives.
        out = out.slice(0, Math.max(0, room));
        trimmed = true;
      }
      out = `${out}\n\n${frameLock}`;
      return out;
    };
    return { promptFor, wasTrimmed: () => trimmed };
  // Every value read below is component state; the deps list is deliberately the whole set so a
  // changed chip is picked up by the very next Regenerate.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extra, nsfw, exactRecreate, varyBackground, faceless, build, charDetail, characterId, engine, chars]);

  /**
   * RUN ONE TILE AGAIN — the engine behind Regenerate and "Retry on WaveSpeed".
   *
   * Photo Match had neither (owner, 2026-08-18: "fix the photo match nb2 to be able regenerated …
   * add a retry bottom with wavespeed"). A picture you did not like, or one that failed, could only
   * be redone by re-running the whole batch — every other photo included, at full price.
   *
   * It rebuilds the request from the tile plus the page's CURRENT settings, which is deliberate:
   * pressing Regenerate after changing a chip should use the chip. What it must NOT do is guess who
   * she is, so the character comes from the id stored on the tile rather than from whatever is
   * ticked now.
   *
   * THE SOURCE PHOTO, in order of preference: the live one still on the page (full size), then the
   * tile's own copy from this session, then the small JPEG kept for the slider. The last is a
   * degraded input and says so rather than silently producing a softer picture.
   */
  const rerunJob = useCallback(async (job, { forceEngine = null, vary = false } = {}) => {
    /**
     * WHOSE picture this is, from the tile.
     *
     * The id is the reliable answer, but tiles filed before it was persisted carry only her NAME —
     * and pressing Retry on those said "this result predates re-running" and did nothing, which is
     * every tile from an earlier session (owner, 2026-08-18). The name is on the tile and character
     * names are unique in the picker, so look her up by it rather than refusing. Only if BOTH are
     * missing is there genuinely nothing to go on.
     */
    const byName = job.charName
      ? chars.find((c) => (c.name || '').trim().toLowerCase() === job.charName.trim().toLowerCase())
      : null;
    const who = { id: job.whoId || byName?.id || null, name: job.charName || byName?.name || '' };
    if (!who.id) {
      notify(job.charName
        ? `${job.charName} is no longer in your characters — re-run this one from a fresh match`
        : 'This result predates re-running — regenerate from a fresh match', 'error');
      return;
    }

    const live = sources.find((x) => x.id === job.srcId);
    const dataUrl = live?.dataUrl || job.thumb || job.thumbSmall;
    if (!dataUrl) { notify('The source photo for this result is gone — add it again to re-run it', 'error'); return; }
    if (!live && !job.thumb) notify('Re-running from the small stored copy — the source photo is no longer on the page', 'info');

    const refs = [];
    for (const r of refsForCharacter(who.id).slice(0, MAX_CHAR_IMAGES)) {
      // eslint-disable-next-line no-await-in-loop
      const full = charThumbs[r.id] || await charStore.getImage(r.id);
      // eslint-disable-next-line no-await-in-loop
      const shrunk = full ? await shrinkForUpload(full) : null;
      const img = shrunk ? parseDataUrl(shrunk) : null;
      if (img) refs.push(img);
    }
    if (!refs.length) { notify(`No identity image could be loaded for ${who.name || 'this character'}`, 'error'); return; }
    who.refs = refs;
    who.cast = castOf(who.id);

    const ratio = aspectRatio === 'auto'
      ? await detectAspectRatio(dataUrl, SEEDREAM_ASPECT_RATIOS)
      : aspectRatio;
    const src = { id: job.id, dataUrl, backView: live?.backView, blurred: live?.blurred };

    runsInFlight.current += 1;
    setRunning(true);
    runIdsRef.current = new Set([...runIdsRef.current, job.id]);
    // The attempt count lives on the tile so the FIFTH retry asks a different question from the
    // first. Kept per tile, not per page: two pictures fail for different reasons.
    const attempt = (job.retryN || 0) + 1;
    // Cleared so the tile does not show the previous failure while it is running again.
    setJobs((prev) => prev.map((j) => (j.id === job.id
      ? { ...j, status: 'queued', error: null, retryN: vary ? attempt : (j.retryN || 0) } : j)));
    try {
      const { promptFor } = buildPromptFactory();
      const budget = engine === 'seedream' ? SEEDREAM_PROMPT_BUDGET : NANO2_PROMPT_BUDGET;
      const built = promptFor(who, refs.length, src);
      const prompt = vary ? withRetryNudge(built, attempt, budget) : built;
      await runOne(src, refs, ratio, prompt, who, { forceEngine });
    } finally {
      runIdsRef.current = new Set([...runIdsRef.current].filter((id) => id !== job.id));
      runsInFlight.current = Math.max(0, runsInFlight.current - 1);
      if (runsInFlight.current === 0) setRunning(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, aspectRatio, charThumbs, notify, buildPromptFactory, engine, chars]);

  const handleMatch = async () => {
    if (!sources.length) { notify('Add at least one source photo', 'error'); return; }
    if (!characterIds.length) { notify('Pick the character whose identity to use', 'error'); return; }
    // Once per RUN, which means clearing it when a run starts. A ref set once and never reset is
    // once per page LOAD — the second batch of the session would fall back in silence.
    warnedFallback.current = false;

    // Without identity images Seedream can only fall back on the source photo's face — the exact
    // failure this page exists to prevent. Fail loudly instead of quietly producing the stand-in.
    // Straight from the collection: these are already data URLs, so there is no fetch to fail
    // and no server round-trip per reference.
    /**
     * Identity images for EACH ticked character, resolved once up front.
     *
     * Loaded before anything is dispatched so a character with no usable photo is caught here
     * rather than failing partway through a paid batch. One that cannot load is dropped and
     * named; the run continues with the rest instead of being abandoned.
     */
    const perChar = [];
    const unloadable = [];
    for (const cid of characterIds) {
      const refs = [];
      for (const r of refsForCharacter(cid).slice(0, MAX_CHAR_IMAGES)) {
        const full = charThumbs[r.id] || await charStore.getImage(r.id);
        // Shrunk before it goes anywhere — see shrinkForUpload. This is the single biggest lever
        // on how long a run takes, and it costs nothing an identity reference needs.
        const dataUrl = full ? await shrinkForUpload(full) : null;
        const img = dataUrl ? parseDataUrl(dataUrl) : null;
        if (img) refs.push(img);
      }
      const name = chars.find((c) => c.id === cid)?.name || '';
      // `cast` set = this ticked character is a pair, and it stays ONE entry here. That is the whole
      // change to the run: the cross product below is untouched, so a pair produces one job per
      // source photo (both women in it) instead of one per woman.
      if (refs.length) perChar.push({ id: cid, name, refs, cast: castOf(cid) });
      else unloadable.push(name || cid);
    }
    if (!perChar.length) { notify('No character identity images could be loaded — add a primary image to this character', 'error'); return; }
    if (unloadable.length) notify(`Skipped ${unloadable.join(', ')} — no identity image could be loaded`, 'error');

    const { promptFor, wasTrimmed } = buildPromptFactory();

    // Resolve 'auto' per source — each photo has its own ratio — before pushPending and before
    // the call. Seedream 422s on the literal string 'auto'.
    const ratios = aspectRatio === 'auto'
      ? await Promise.all(sources.map((s) => detectAspectRatio(s.dataUrl, SEEDREAM_ASPECT_RATIOS)))
      : sources.map(() => aspectRatio);
    const ratioById = new Map(sources.map((s, i) => [s.id, ratios[i]]));

    /**
     * THE CROSS PRODUCT: every source photo, once per ticked character.
     *
     * Job ids gain the character id because a job is keyed by source id, and the same photo now
     * appears once per woman — without it three characters would write into one tile and you
     * would see whichever finished last rather than all three.
     */
    const work = perChar.flatMap((who) => sources.map((src) => ({ src, who })));
    if (wasTrimmed()) notify(`Instructions trimmed to ${engine === 'seedream' ? SEEDREAM_PROMPT_BUDGET : NANO2_PROMPT_BUDGET} characters — the model rejects longer prompts`, 'error');

    runsInFlight.current += 1;
    setRunning(true);
    /**
     * A NEW RUN IS ADDED TO THE PANEL, NOT SWAPPED IN.
     *
     * This called setJobs(work.map(...)), which REPLACED the array — so pressing Generate wiped
     * every result already on screen, including the ones just restored from disk and read back out
     * of the libraries. Eleven finished pictures vanished the moment a twelfth was asked for
     * (owner, 2026-08-13). The panel is a persistent queue; a run appends to it.
     *
     * The run stamp is what makes that safe. The id was `${src.id}::${who.id}`, which is stable
     * across runs — so re-running the same photo for the same character produced a second tile with
     * the FIRST tile's id, and the update would land on whichever React found first.
     */
    const runStamp = Date.now().toString(36);
    // Which tiles belong to THIS run. The panel now holds finished work from before it, so
    // "Matching… (3/12)" and "Batch finished — 12 images" would both be counting other people's
    // pictures without this.
    const runIds = new Set();
    const fresh = work.map(({ src, who }) => ({
      id: (() => { const id = `${src.id}::${who.id}::${runStamp}`; runIds.add(id); return id; })(),
      thumb: src.dataUrl, status: 'queued', result: null, error: null,
      // Shown on the tile so a mixed batch says WHOSE result each one is. Recorded for EVERY run,
      // not just a multi-character one: it decides which folder the picture is filed under later,
      // and a blank name there is how a batch ends up in the wrong woman's folder.
      // Deliberately the FOLDER's name, for a pair as much as for one woman: this is not only a
      // label, it decides which library folder the picture is filed under. Joining the members into
      // "Arya + Rosary" would file a pair's results into a folder the user never created, sitting
      // beside the one they did.
      charName: who.name || '',
      // WHICH character, by id. charName alone cannot be resolved back to a set of identity photos
      // — two characters can share a name and a rename orphans it — and re-running one tile needs
      // exactly those photos. Kept on the job so Regenerate and Retry work from the tile alone.
      whoId: who.id,
      // The source photo id, so a re-run can find the live source (full resolution) rather than
      // making do with the shrunken copy kept for the before/after slider.
      srcId: src.id,
    }));
    setJobs((prev) => [...fresh, ...prev]);
    // UNION, not assignment: assigning dropped the first run's ids the moment a second started, so
    // the progress counter jumped to the new run and the older one's images vanished from the count
    // while they were still rendering.
    runIdsRef.current = new Set([...runIdsRef.current, ...runIds]);

    // Simple concurrency pool — each job holds an HTTP request while Muapi renders.
    const queue = [...work];
    const lanes = LANES[engine] || LANES.seedream;
    const workers = Array.from({ length: Math.min(lanes, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        await runOne({ ...item.src, id: `${item.src.id}::${item.who.id}::${runStamp}` },
          item.who.refs, ratioById.get(item.src.id), promptFor(item.who, item.who.refs.length, item.src), item.who);
      }
    });
    await Promise.all(workers);
    // This run's ids leave the progress set; the flag clears only when nothing else is running.
    runIdsRef.current = new Set([...runIdsRef.current].filter((id) => !runIds.has(id)));
    runsInFlight.current = Math.max(0, runsInFlight.current - 1);
    if (runsInFlight.current === 0) setRunning(false);
    // Report what actually happened. This said "Batch finished" unconditionally, so a run where
    // every job 422'd still looked like a success and the failures were invisible.
    setJobs((prev) => {
      // THIS run only — the panel is full of earlier work now.
      const mine = prev.filter((j) => runIds.has(j.id));
      const failed = mine.filter((j) => j.status === 'failed');
      const done = mine.filter((j) => j.status === 'done').length;
      if (!failed.length) notify(`Batch finished — ${done} image${done === 1 ? '' : 's'} ✨`, 'success');
      else if (!done) notify(`All ${failed.length} failed: ${failed[0].error || 'unknown error'}`, 'error');
      else notify(`${done} done, ${failed.length} failed: ${failed[0].error || 'unknown error'}`, 'error');
      return prev;
    });
  };

  const doneJobs = jobs.filter((j) => j.status === 'done');
  /**
   * Progress for the RUN, not for the panel.
   *
   * The button read doneJobs.length / jobs.length, which was the whole panel — so with eleven
   * finished pictures already on screen a one-image run opened at "Matching… (11/12)".
   */
  const runProgress = useMemo(() => {
    const ids = runIdsRef.current;
    const mine = jobs.filter((j) => ids.has(j.id));
    return { done: mine.filter((j) => j.status === 'done').length, total: mine.length };
  }, [jobs, running]);

  /**
   * THE RESULTS PANEL'S OWN SELECTION.
   *
   * Photo Match had no selection at all: the only way to act on a finished picture was to leave for
   * the Library tab and find it there. Eddy's results panel has had tick-and-send for months, and
   * this is the same idea with the same words (owner, 2026-08-13).
   */
  /**
   * REHYDRATE the panel, once, on open — and only then start persisting.
   *
   * The write must not run before the read comes back or the first empty render would erase the
   * saved queue. Same order Eddy's failedCombos restore uses, and for the same reason.
   */
  const [jobsRestored, setJobsRestored] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = await resultsStore.get('queue', []);
      if (!alive) { return; }
      if (Array.isArray(saved) && saved.length) {
        // A row with no galleryId cannot be redrawn or sent anywhere, so it is dropped rather than
        // restored as a tile with nothing behind it.
        setJobs((prev) => (prev.length ? prev : saved.filter((j) => urlOfJob(j))));
      }
      /**
       * WHAT WAS ALREADY MADE, before this panel existed.
       *
       * Every Photo Match result has been filed into a library since long before the panel did —
       * as `photomatch-<n>` under her name. So the panel reads those back rather than starting
       * empty and pretending the work never happened (owner, 2026-08-13: "show some image I
       * already generated, so I can select them too or delete").
       *
       * Newest 60. This is a working panel, not an archive — the Library tab is the archive, and it
       * has the folders and the filters for it.
       */
      try {
        const [libRows, baseRows, libFolders, baseFolders] = await Promise.all([
          libraryStore.listItems(), baseStore.listItems(),
          libraryStore.listFolders(), baseStore.listFolders(),
        ]);
        if (!alive) return;
        const folderName = (list, id) => list.find((f) => f.id === id)?.name || '';
        const mine = [
          ...libRows.map((r) => ({ r, db: 'eddy-library', folder: folderName(libFolders, r.folderId) })),
          ...baseRows.map((r) => ({ r, db: 'eddy-base', folder: folderName(baseFolders, r.folderId) })),
        ]
          // A Photo Match row is named by the run that made it. Checked on BOTH the name and the
          // prompt, because early rows were written before the name carried the prefix.
          .filter(({ r }) => r.url && (String(r.name || '').startsWith('photomatch-') || String(r.prompt || '').startsWith('Photo Match')))
          .sort((a2, b2) => (b2.r.createdAt || 0) - (a2.r.createdAt || 0))
          .slice(0, 60);
        setJobs((prev) => {
          const seen = new Set(prev.map((j) => urlOfJob(j)));
          const extra = mine
            .filter(({ r }) => !seen.has(r.url))
            .map(({ r, db, folder }) => ({
              id: `lib-${db}-${r.id}`,
              status: 'done',
              url: r.url,
              galleryId: null,
              libRowId: r.id,
              filedDb: db,
              charName: folder || r.charName || '',
              doneAt: r.createdAt || 0,
              fromLibrary: true,
            }));
          return [...prev, ...extra];
        });
      } catch { /* an unreadable collection just means an emptier panel, not a broken page */ }
      setJobsRestored(true);
    })();
    return () => { alive = false; };
  }, [libraryStore, baseStore]);
  useEffect(() => {
    if (!jobsRestored) return;
    // Only finished, filed pictures are worth keeping: a queued or running job belongs to a run
    // that no longer exists once the page is closed.
    resultsStore.set('queue', jobs.filter((j) => j.status === 'done' && urlOfJob(j)).map(liteJob));
  }, [jobs, jobsRestored]);


  /**
   * PICK BACK UP WHAT THE SERVER IS STILL DOING.
   *
   * Leaving the page unmounts the component, and every promise awaiting a render goes with it. The
   * work does not stop — it is on the durable queue and the server finishes and bills it — but the
   * panel forgot it existed, so coming back showed an empty page while paid pictures completed
   * invisibly (owner, 2026-08-16: 'when leave page it stop showing the generated').
   *
   * The server has always been able to answer this: GET /api/jobs returns active, failed and
   * unfiled for the signed-in user. Nothing new was needed on that side — the client just never
   * asked. Runs once the restore has finished, so it cannot race the saved panel.
   */
  useEffect(() => {
    if (!jobsRestored) return;
    let alive = true;
    (async () => {
      let list;
      try {
        const r = await jobsApi.list();
        list = r?.data ?? r;
      } catch { return; }              // signed out or offline is not an error worth shouting about
      if (!alive || !list) return;
      // Skip what an earlier, still-running waiter already owns — otherwise both file it.
      const mineOnly = (arr) => (arr || []).filter((j) => j.feature === FEATURE && !_awaiting.has(j.id));
      const active = mineOnly(list.active);
      const failed = mineOnly(list.failed);
      if (!active.length && !failed.length) return;

      // Shown straight away, before any of them finish, so the panel is honest about what is
      // outstanding rather than looking idle while the server works.
      setJobs((prev) => {
        const known = new Set(prev.map((j) => j.jobId).filter(Boolean));
        const rows = [...active, ...failed]
          .filter((j) => !known.has(j.id))
          .map((j) => ({
            id: `resumed-${j.id}`,
            jobId: j.id,
            status: j.status === 'failed' ? 'failed' : 'running',
            error: j.error || '',
            charName: j.destFolder || '',
            engine: j.model === 'nb2' ? 'nb2' : j.model === 'nano2' ? 'nano2' : 'seedream',
            fellBack: (j.tags || []).includes('fallback'),
            resumed: true,
          }));
        return rows.length ? [...rows, ...prev] : prev;
      });
      if (active.length) notify(`Picking up ${active.length} still running from before`, 'info');

      // Rejoin each one. filePicture is the same code a fresh run uses, so a resumed picture lands
      // in the same collection, the same folder and the same shape.
      for (const j of active) {
        _awaiting.add(j.id);
        waitForQueuedJob(j.id)
          .finally(() => _awaiting.delete(j.id))
          .then(async (data) => {
            if (!alive) return;
            const first = (data.images || [])[0];
            if (!first) throw new Error('finished with no image');
            await filePicture(first, j.destFolder || '', j.cardPrompt || '');
            setJobs((prev) => prev.map((x) => (x.jobId === j.id
              ? { ...x, status: 'done', result: first, galleryId: first.galleryId || null, url: data.url || '', doneAt: Date.now(), filedDb: j.destDb || destDb }
              : x)));
          })
          .catch((err) => {
            if (!alive) return;
            setJobs((prev) => prev.map((x) => (x.jobId === j.id
              ? { ...x, status: 'failed', error: err?.message || 'Failed' } : x)));
          });
      }
    })();
    return () => { alive = false; };
  }, [jobsRestored, FEATURE, filePicture, notify, destDb]);

  /**
   * Run the failed ones again — the server already had the endpoint, the page just never offered it.
   *
   * A retry is a POST a human makes on purpose: a job that failed as an orphan may already have
   * been rendered and billed, so the automatic path refuses to make that call and a person looking
   * at a missing picture can.
   */
  /**
   * PULL BACK WHAT FINISHED WHILE THE APP WAS AWAY.
   *
   * A render that completes while Kyros is closed, updating or reloading reaches `done` on the
   * server with a gallery id, and waits there UNFILED — the libraries are IndexedDB in this
   * browser, so only the client can put it in one. reconcileUnfiled files exactly those, and has
   * run at app boot for a while, which is no help at all if the app is already open when you
   * notice something missing (owner, 2026-08-16: 'u updated app and i lost grace one').
   *
   * Nothing is ever lost to this — the picture is in the gallery and paid for either way. What was
   * missing was a way to ask for it without restarting.
   */
  const [recovering, setRecovering] = useState(false);
  const [unfiledCount, setUnfiledCount] = useState(0);
  const refreshUnfiled = useCallback(async () => {
    try {
      const r = await jobsApi.list();
      const list = r?.data ?? r;
      setUnfiledCount((list?.unfiled || []).length);
    } catch { /* signed out or offline — the button simply does not appear */ }
  }, []);
  useEffect(() => { if (jobsRestored) refreshUnfiled(); }, [jobsRestored, refreshUnfiled]);
  const recoverLost = useCallback(async () => {
    setRecovering(true);
    try {
      // Files EVERY unfiled job, whichever page made it, each into the destination its own run
      // chose — the same call the app makes at boot.
      const { filed, failed } = await reconcileUnfiled();
      if (filed) notify(`Recovered ${filed} picture${filed === 1 ? '' : 's'} into ${destLabel} ✨`, 'success');
      else if (failed) notify(`${failed} could not be filed — browser storage may be full`, 'error');
      else notify('Nothing was waiting — everything already landed', 'info');
      await refreshUnfiled();
    } catch (err) {
      notify(err?.message || 'Could not recover', 'error');
    } finally { setRecovering(false); }
  }, [notify, destLabel, refreshUnfiled]);

  /**
   * Retryable and dismissible are NOT the same set.
   *
   * Retry needs a jobId — it re-runs the job the server already has. A job that fell over before it
   * got one (a submit that was refused, a config error) has nothing to retry, but it is still a red
   * tile in the way, so it must still be removable.
   */
  const failedJobs = jobs.filter((j) => j.status === 'failed' && j.jobId);
  const allFailed = jobs.filter((j) => j.status === 'failed');

  /**
   * Throwing away a failed tile — one, or the lot.
   *
   * Seventy results with seven "WaveSpeed is out of credits" tiles scattered through them is a wall
   * to scroll past, and "Clear" throws away the finished pictures with them (owner, 2026-08-17).
   * Dismissing only drops the tile from this page; nothing on the server or in the library moves.
   */
  const dismissJob = useCallback((id) => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
    setPickedJobs((cur) => { const next = new Set(cur); next.delete(id); return next; });
  }, []);
  const dismissAllFailed = useCallback(async () => {
    const n = jobs.filter((j) => j.status === 'failed').length;
    if (!n) return;
    setJobs((prev) => prev.filter((j) => j.status !== 'failed'));
    /**
     * The SERVER rows go too, not just the tiles.
     *
     * Leaving them behind means a "retry all failed" from anywhere else brings them back and runs
     * them — spending money on jobs that were explicitly thrown away. jobQueue.deleteAllFailed is
     * scoped to status = failed by the same WHERE clause retryAllFailed uses, so it cannot touch
     * queued, running or finished work, and a failed job never reached a provider that billed it.
     *
     * Best effort: if the call fails the tiles are still gone from the page, which is what was
     * asked for. Worth knowing it is account-wide rather than this tab's rows — there is no
     * per-job delete endpoint, and the single-tile × below is therefore page-only.
     */
    try { await jobsApi.deleteAllFailed(); } catch { /* the tiles are gone either way */ }
    notify(`${n} failed result${n === 1 ? '' : 's'} dismissed — finished pictures untouched`, 'info');
  }, [jobs, notify]);
  const retryFailed = useCallback(async () => {
    const targets = jobs.filter((j) => j.status === 'failed' && j.jobId);
    if (!targets.length) return;
    setJobs((prev) => prev.map((x) => (targets.some((t) => t.jobId === x.jobId) ? { ...x, status: 'running', error: '' } : x)));
    for (const t of targets) {
      try {
        await jobsApi.retry(t.jobId);
        waitForQueuedJob(t.jobId)
          .then(async (data) => {
            const first = (data.images || [])[0];
            if (!first) throw new Error('finished with no image');
            await filePicture(first, t.charName || '', '');
            setJobs((prev) => prev.map((x) => (x.jobId === t.jobId
              ? { ...x, status: 'done', result: first, galleryId: first.galleryId || null, url: data.url || '', doneAt: Date.now(), filedDb: destDb }
              : x)));
          })
          .catch((err) => setJobs((prev) => prev.map((x) => (x.jobId === t.jobId
            ? { ...x, status: 'failed', error: err?.message || 'Failed again' } : x))));
      } catch (err) {
        setJobs((prev) => prev.map((x) => (x.jobId === t.jobId
          ? { ...x, status: 'failed', error: err?.message || 'Could not retry' } : x)));
      }
    }
    notify(`Retrying ${targets.length} failed`, 'info');
  }, [jobs, filePicture, notify, destDb]);

  const [pickedJobs, setPickedJobs] = useState(() => new Set());
  const toggleJob = useCallback((id) => {
    setPickedJobs((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const filedJobs = useMemo(() => doneJobs.filter((j) => urlOfJob(j)), [doneJobs]);
  const actionable = useMemo(
    () => (pickedJobs.size ? filedJobs.filter((j) => pickedJobs.has(j.id)) : filedJobs),
    [filedJobs, pickedJobs],
  );
  const [movingTo, setMovingTo] = useState('');

  /**
   * RETRY THE TICKED ONES, with a different instruction each time.
   *
   * Owner, 2026-08-18: "when i select the result from the picture that are not good i need a retry
   * bottum". Looking down a grid of twenty and marking the four duds is how you actually judge a
   * batch, and until now the only thing you could do with that selection was file it.
   *
   * It acts ONLY on what is ticked — unlike Send, which falls back to everything filed. "Send them
   * all" is a sane default; "spend money on all of them again" is not, so with nothing ticked this
   * button is not there to press.
   *
   * allSettled, not all: one retry that throws must not abandon the other three, and each tile
   * already shows its own outcome.
   */
  const [retrying, setRetrying] = useState(false);
  const retryPicked = useCallback(async () => {
    const picked = filedJobs.filter((j) => pickedJobs.has(j.id));
    if (!picked.length) { notify('Tick the results that came out badly first', 'error'); return; }
    setRetrying(true);
    try {
      await Promise.allSettled(picked.map((job) => rerunJob(job, { vary: true })));
    } finally {
      setRetrying(false);
    }
  }, [filedJobs, pickedJobs, rerunJob, notify]);

  /**
   * SMART SELECTING — by count and by age, the same two questions the Library answers.
   *
   * "The last 30" and "everything from the last hour" are how a batch is actually thought about;
   * ticking thirty tiles by hand is not (owner, 2026-08-13). Newest first, and both act on what is
   * SENDABLE, so a count never silently includes a tile that cannot move.
   */
  const [pickCount, setPickCount] = useState(30);
  const newestFirst = useMemo(
    () => [...filedJobs].sort((a2, b2) => (b2.doneAt || 0) - (a2.doneAt || 0)),
    [filedJobs],
  );
  const selectNewest = useCallback((n) => {
    setPickedJobs(new Set(newestFirst.slice(0, Math.max(1, n)).map((j) => j.id)));
  }, [newestFirst]);
  const selectSince = useCallback((ms) => {
    const cut = Date.now() - ms;
    const hits = newestFirst.filter((j) => (j.doneAt || 0) >= cut);
    // A row with no timestamp — an old library import — is not silently swept in by an age filter.
    setPickedJobs(new Set(hits.map((j) => j.id)));
    if (!hits.length) notify('Nothing in that window', 'info');
  }, [newestFirst, notify]);
  const countSince = useCallback((ms) => {
    const cut = Date.now() - ms;
    return filedJobs.filter((j) => (j.doneAt || 0) >= cut).length;
  }, [filedJobs]);

  /**
   * The before/after slider is OFF by default and remembered.
   *
   * Comparing is a deliberate act — most of the time the result is the only half worth looking at,
   * and a slider on every tile means every tile is showing half a picture of someone else.
   */
  /**
   * THE LARGE VIEW — click the picture to open it, Esc or the backdrop to close, arrows to step.
   *
   * The same lightbox the Library has had for months, and for the same reason: a 240px tile is
   * enough to pick from and not enough to judge. Clicking the PICTURE opens it; clicking anywhere
   * else on the tile ticks it, so selecting and looking are different gestures rather than one
   * ambiguous one (owner, 2026-08-13).
   */
  const [lightboxId, setLightboxId] = useState('');
  const lightboxList = useMemo(() => jobs.filter((j) => j.status === 'done' && (j.result || urlOfJob(j))), [jobs]);
  const stepLightbox = useCallback((delta) => {
    setLightboxId((cur) => {
      const i = lightboxList.findIndex((j) => j.id === cur);
      if (i < 0) return cur;
      const next = lightboxList[i + delta];
      return next ? next.id : cur;
    });
  }, [lightboxList]);
  useEffect(() => {
    if (!lightboxId) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setLightboxId('');
      else if (e.key === 'ArrowLeft') stepLightbox(-1);
      else if (e.key === 'ArrowRight') stepLightbox(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxId, stepLightbox]);
  // A tile that leaves the panel must not leave the overlay open on nothing.
  useEffect(() => {
    if (lightboxId && !lightboxList.some((j) => j.id === lightboxId)) setLightboxId('');
  }, [lightboxId, lightboxList]);

  /**
   * ZOOM, in the large view (owner, 2026-08-18: "and make it possible to zoom").
   *
   * A 2K render shown at "fits on screen" is the one thing this page cannot be judged on: whether
   * the skin has pores, whether the hands are right, whether her face is actually hers. All of that
   * lives at 1:1, and the overlay was capped at max-h-full.
   *
   * Wheel zooms AT THE POINTER, which is the only version that feels right — zooming to the centre
   * means chasing the detail you were looking at back across the screen. Drag pans, double-click
   * toggles between fit and 2x at the point you hit, and +/-/0 do the same from the keyboard.
   *
   * Reset on every picture change: carrying a 4x zoom into the next image opens it on somebody's
   * elbow.
   */
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panRef = useRef(null);
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 8;
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [lightboxId]);

  /**
   * Zoom about a point. The maths is the whole trick: to keep the pixel under the cursor still, the
   * pan has to move by how far that point would otherwise drift, which is the offset from centre
   * scaled by the change in zoom.
   */
  const zoomAt = useCallback((factor, clientX, clientY, rect) => {
    setZoom((z) => {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * factor));
      if (next === z) return z;
      if (next === 1) { setPan({ x: 0, y: 0 }); return next; }
      const cx = rect ? clientX - (rect.left + rect.width / 2) : 0;
      const cy = rect ? clientY - (rect.top + rect.height / 2) : 0;
      const ratio = next / z;
      setPan((prev) => ({ x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio }));
      return next;
    });
  }, []);

  // Keyboard, alongside the existing Esc / arrows. Bound in the same effect so there is one
  // listener and one place that decides what a key means while the overlay is open.
  useEffect(() => {
    if (!lightboxId) return undefined;
    const onKey = (e) => {
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(1.4, 0, 0, null); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAt(1 / 1.4, 0, 0, null); }
      else if (e.key === '0') { e.preventDefault(); setZoom(1); setPan({ x: 0, y: 0 }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxId, zoomAt]);

  const [showCompare, setShowCompare] = useState(() => {
    try { return localStorage.getItem('kyros.photoMatch.compare') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('kyros.photoMatch.compare', showCompare ? '1' : '0'); } catch { /* private mode */ }
  }, [showCompare]);

  /**
   * DELETE — take the picture out of the library it is in.
   *
   * Distinct from Remove, which only clears the tile. Confirmed, because the two sit next to each
   * other and only one of them is undoable by re-running the panel.
   *
   * The row id is known for a tile read back out of a collection; for one from this run it is found
   * by url, which is the same key the move uses. The server copy is left alone — the gallery is the
   * place a picture is actually deleted from, and this is not that page.
   */
  const deleteJobRow = useCallback(async (job) => {
    const label = job.filedDb === 'eddy-base' ? 'Base Library' : 'Library';
    // eslint-disable-next-line no-alert -- one destructive action, one plain question
    if (!window.confirm(`Delete this picture from ${label}? It stays in the gallery.`)) return;
    const store = job.filedDb === 'eddy-base' ? baseStore : libraryStore;
    try {
      let rowId = job.libRowId;
      if (!rowId) {
        const url = urlOfJob(job);
        rowId = (await store.listItems()).find((i) => i.url === url)?.id || null;
      }
      if (rowId) await store.removeItem(rowId);
      setJobs((prev) => prev.filter((x) => x.id !== job.id));
      setPickedJobs((cur) => { const n = new Set(cur); n.delete(job.id); return n; });
      notify(rowId ? `Deleted from ${label}` : 'Taken off the panel — it was not in that library', rowId ? 'success' : 'info');
    } catch (err) {
      notify(err?.message || 'Could not delete that', 'error');
    }
  }, [baseStore, libraryStore, notify]);

  /**
   * Move finished pictures between the two libraries, after the fact.
   *
   * They are already filed — the run put them in whichever collection the dropdown named — so this
   * is a MOVE, and the same careful order the Library's own button uses: write the destination row
   * first, drop the source row only once that succeeded. A picture is never in neither place.
   *
   * A picture already in the target is left alone rather than duplicated.
   */
  const moveResultsTo = useCallback(async (targetDb) => {
    const list = actionable;
    if (!list.length) { notify('Nothing to send yet', 'error'); return; }
    const target = targetDb === 'eddy-base' ? baseStore : libraryStore;
    const targetLabel = targetDb === 'eddy-base' ? 'Base Library' : 'Library';
    setMovingTo(targetDb);
    let moved = 0, already = 0;
    let failure = '';
    try {
      /**
       * EACH PICTURE UNDER ITS OWN WOMAN — not under whoever is selected right now.
       *
       * This read the page's current charName for every job in the batch, so a panel holding
       * Grace's and Chloe's results (which it does the moment two characters are ticked, and it
       * survives a reload) filed the whole lot into whichever name happened to be selected. The job
       * knows whose it is; that is what decides the folder. The page's selection is only a fallback
       * for an old row that never recorded one (owner, 2026-08-13).
       *
       * One ensureFolder per NAME, not per picture.
       */
      const folderIdFor = new Map();
      const targetRows = new Map((await target.listItems()).filter((i) => i.url).map((i) => [i.url, i]));
      for (const job of list) {
        const url = urlOfJob(job);
        if (targetRows.has(url)) { already += 1; continue; }
        const who = (job.charName || charName || '').trim();
        const folderKey = who || 'Photo Match';
        if (!folderIdFor.has(folderKey)) {
          // eslint-disable-next-line no-await-in-loop
          folderIdFor.set(folderKey, (await target.ensureFolder(folderKey))?.id || null);
        }
        const destFolder = folderIdFor.get(folderKey);
        const sourceStore = job.filedDb === 'eddy-base' ? baseStore : libraryStore;
        try {
          // eslint-disable-next-line no-await-in-loop
          const landed = await target.addItems([{
            url,
            prompt: `Photo Match - ${who || 'no character'}`,
            name: `photomatch-${job.id}`,
            ...(who ? { charName: who } : {}),
          }], destFolder);
          if (!Array.isArray(landed) || !landed.length) { failure = 'storage is full'; continue; }
          if (job.filedDb !== targetDb) {
            // eslint-disable-next-line no-await-in-loop
            const stale = (await sourceStore.listItems()).find((i) => i.url === url);
            // eslint-disable-next-line no-await-in-loop
            if (stale) await sourceStore.removeItem(stale.id);
          }
          moved += 1;
        } catch (err) { failure = err.message; }
      }
    } finally {
      setMovingTo('');
    }
    // The jobs stay on screen — they are this run's record. Their filedDb is updated so pressing
    // the other button afterwards moves them back rather than duplicating.
    const ids = new Set(list.map((j) => j.id));
    setJobs((prev) => prev.map((j) => (ids.has(j.id) ? { ...j, filedDb: targetDb } : j)));
    setPickedJobs(new Set());
    if (moved && !failure) notify(`${moved} sent to ${targetLabel}${already ? ` (${already} already there)` : ''}`, 'success');
    else if (moved) notify(`${moved} of ${list.length} sent to ${targetLabel} — ${failure}`, 'error');
    else if (already) notify(`Already in ${targetLabel}`, 'info');
    else notify(`Could not send those — ${failure || 'nothing was filed'}`, 'error');
  }, [actionable, baseStore, libraryStore, charName, notify]);

  return (
    /**
     * TWO COLUMNS, the same shell Eddy Generate uses: setup left, results right.
     *
     * It was one scrolling document with the results in a card at the bottom, so watching a match
     * land meant scrolling the form away — and next to Eddy it simply looked like a different app
     * (owner, 2026-08-13: "the one of Eddy is different to the one of Photo Match"). `main` stops
     * scrolling for this page (SELF_SCROLL_PAGES in App.jsx) and each column scrolls on its own.
     */
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto animate-in lg:flex-row lg:gap-5 lg:overflow-hidden">
      <div className="w-full shrink-0 space-y-6 lg:w-[560px] lg:min-h-0 lg:overflow-y-auto lg:pr-2">
      <div className="flex items-center justify-end">
        <div className="text-right">
          <div className="text-[0.625rem] uppercase tracking-wider text-zinc-600 font-bold">Session spend</div>
          <div className="text-sm font-mono tabular-nums text-rose-300 font-semibold">${sessionSpend.toFixed(3)}</div>
        </div>
      </div>

      <div className="space-y-4">
        {/* Source photos (batch) */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
              1 · Source Photos <span className="text-zinc-600 font-normal normal-case">the scene, pose &amp; outfit to keep</span>
            </h3>
            <div className="flex items-center gap-2">
              {sources.length > 0 && <Badge color="green">{sources.length} queued</Badge>}
              <Badge color="zinc">Ctrl+V → Sources</Badge>
            </div>
          </div>

          {/**
            * DID EVERY FACE GET BLURRED — answerable at a glance, at any batch size.
            *
            * With fifty photos you could count the amber rings. With five hundred you cannot, and
            * "it show if all face blurred" is the whole question (owner, 2026-08-17). So the count
            * is stated, and the ones that failed can be isolated in one click instead of hunted
            * through a wall of thumbnails.
            */}
          {scanning ? (
            <div className="rounded-lg border border-sky-700/40 bg-sky-950/30 px-3 py-2">
              <div className="flex items-center justify-between text-[0.6875rem] font-semibold text-sky-200">
                <span>Scanning faces — {scanning.done} of {scanning.total}</span>
                <span className="font-mono tabular-nums text-sky-400/70">{poolSize()} workers</span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-sky-950">
                <span className="block h-full rounded-full bg-sky-500 transition-[width] duration-200"
                  style={{ width: `${Math.round((scanning.done / Math.max(1, scanning.total)) * 100)}%` }} />
              </div>
            </div>
          ) : sources.length > 0 && blurSource && (
            <div className={cn('flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[0.6875rem] font-semibold',
              unblurredCount ? 'border-amber-700/40 bg-amber-950/25 text-amber-200' : 'border-emerald-700/40 bg-emerald-950/25 text-emerald-200')}>
              <span>
                {unblurredCount
                  ? `${sources.length - unblurredCount} of ${sources.length} blurred · ${unblurredCount} with no face found`
                  : `All ${sources.length} face${sources.length === 1 ? '' : 's'} blurred`}
              </span>
              {unblurredCount > 0 && (
                <button type="button" onClick={() => setShowUnblurredOnly((v) => !v)}
                  className="shrink-0 rounded border border-amber-600/50 px-2 py-0.5 text-[0.625rem] uppercase tracking-wide text-amber-100 hover:bg-amber-900/40 cursor-pointer">
                  {showUnblurredOnly ? 'Show all' : `Show the ${unblurredCount}`}
                </button>
              )}
            </div>
          )}

          <div
            className={cn('rounded-xl border-2 border-dashed p-3 transition-colors', dragging ? 'border-rose-500 bg-rose-500/[0.06]' : 'border-zinc-800/60')}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            /**
             * The box shows the highlight; the WINDOW handler does the adding.
             *
             * This used to call addSources itself. Once dropping was also bound to the window — so
             * that releasing anywhere on the page works — a drop inside the box ran both, and every
             * photo went in twice. It never showed up because the window handler was throwing on a
             * broken regex at the time, so only the box path ever ran (see check-eaten-escapes).
             *
             * Deliberately no preventDefault and no stopPropagation here: the event has to reach the
             * window, which is where the file/URL handling lives.
             */
            onDrop={() => setDragging(false)}
          >
            {sources.length ? (
              <div className="grid [grid-template-columns:repeat(auto-fill,minmax(90px,1fr))] gap-2">
                {/* The filter narrows what is DRAWN, never what is queued — every source still
                    generates. Turning it on with nothing left to fix shows the lot again rather
                    than an empty box. */}
                {(showUnblurredOnly && unblurredCount ? sources.filter((s) => !s.blurred) : sources).map((s) => (
                  <div key={s.id} className="relative group">
                    {/* Click the photo to blur a region by hand — the fallback for a face the
                        detector missed. The amber ring flags exactly those un-blurred photos. */}
                    <button type="button" onClick={() => setManualBlurId(s.id)}
                      title={s.orig
                        ? 'Blur landed in the wrong place? Click to redraw it — this opens the ORIGINAL photo, not the blurred copy.'
                        : 'Click to blur a region by hand'}
                      className={cn('block w-full rounded-lg border overflow-hidden cursor-pointer',
                        blurSource && !s.blurred ? 'border-amber-500/70 ring-1 ring-amber-500/40' : 'border-zinc-800/60')}>
                      <img src={s.dataUrl} alt="" className="w-full aspect-[3/4] object-cover bg-zinc-950" />
                    </button>
                    {blurSource && (
                      s.blurred
                        // The badge IS the undo button when there is an original to go back to —
                        // the blur landing in the wrong place is exactly when you look at this
                        // corner of the tile, so the way out belongs here rather than in a menu.
                        ? (s.orig
                          ? <button type="button" onClick={(e) => { e.stopPropagation(); undoBlur(s.id); }}
                            title="Wrong spot? Put the original photo back, then click the photo to draw the blur yourself."
                            className="absolute bottom-1 left-1 rounded bg-emerald-600/90 px-1.5 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wide text-white hover:bg-red-600/90 cursor-pointer">Blurred · undo</button>
                          : <span className="absolute bottom-1 left-1 rounded bg-emerald-600/90 px-1.5 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wide text-white pointer-events-none">Blurred</span>)
                        : <span className="absolute bottom-1 left-1 rounded bg-amber-600/90 px-1.5 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wide text-white pointer-events-none">Face — tap</span>
                    )}
                    {/* The back-view call, shown before it is paid for and one click to flip.
                        Detection is right most of the time, not always — a profile or a face turned
                        far enough can read as no-face — and calling a front photo a back view
                        strips the face rules out of its prompt. So it is never silent. */}
                    <button type="button"
                      onClick={() => setSources((prev) => prev.map((x) => (x.id === s.id ? { ...x, backView: !x.backView } : x)))}
                      title={s.backView
                        ? 'Treated as shot from behind: no face is matched or invented, and she is not turned toward the camera. Click if she is actually facing the camera.'
                        : 'Treated as facing the camera. Click if this shot is from behind.'}
                      className={cn('absolute top-1 left-1 rounded px-1.5 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wide cursor-pointer',
                        s.backView ? 'bg-sky-600/90 text-white' : 'bg-black/50 text-zinc-400 opacity-0 group-hover:opacity-100')}>
                      {s.backView ? 'Back view' : 'Front'}
                    </button>
                    <button onClick={() => setSources((prev) => prev.filter((x) => x.id !== s.id))}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 text-xs flex items-center justify-center hover:text-white cursor-pointer">×</button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-zinc-600">Drag photos here — one match runs per photo</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="cursor-pointer">
              <input type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => { addSources(e.target.files); e.target.value = ''; }} />
              <span className="inline-block"><Btn variant="secondary" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem] pointer-events-none">Upload</Btn></span>
            </label>
            <Btn variant="secondary" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem]" onClick={() => {
              if (!showGallery && !galleryImages.length) fetchGallery();
              setShowGallery((v) => !v);
            }}>
              {showGallery ? 'Hide Gallery' : 'Gallery'}
            </Btn>
            {sources.length > 0 && blurSource && (
              <Btn variant="secondary" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem]" onClick={blurAllFaces} disabled={blurringAll || unblurredCount === 0}>
                {blurringAll ? <Spinner size={12} /> : null}
                {unblurredCount > 0 ? `Blur all faces (${unblurredCount})` : 'All blurred ✓'}
              </Btn>
            )}
            {sources.length > 0 && <Btn variant="ghost" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem]" onClick={() => setSources([])}>Clear</Btn>}
          </div>

          {showGallery && (
            <div className="pt-1">
              {galleryLoading ? (
                <div className="flex items-center justify-center py-6 text-zinc-400 text-sm"><Spinner size={16} /> <span className="ml-2">Loading gallery...</span></div>
              ) : !galleryImages.length ? (
                <p className="text-xs text-zinc-500 py-4 text-center">No images in gallery yet.</p>
              ) : (
                <div className="grid [grid-template-columns:repeat(auto-fill,minmax(80px,1fr))] gap-2 max-h-[220px] overflow-y-auto pr-1">
                  {galleryImages.map((img) => (
                    <button key={img.id} onClick={() => pickFromGallery(img.id)} title={img.prompt || ''}
                      className="relative aspect-square overflow-hidden rounded-lg border border-zinc-800/60 hover:border-rose-500/60 transition-all cursor-pointer hover:scale-[1.03]">
                      <img src={galleryApi.thumbUrl(img.id)} alt="" className="h-full w-full object-cover bg-zinc-950" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Character — the identity */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
              2 · Character <span className="text-zinc-600 font-normal normal-case">the identity to put in</span>
            </h3>
            <div className="flex items-center gap-2">
              {/* With several ticked the ref count belongs to the FIRST one only, so saying
                  "5 identity refs" would misdescribe the run. Say how many women instead. */}
              {characterIds.length > 1
                ? <Badge color="green">{characterIds.length} characters</Badge>
                : characterId && charImagesUsed > 0 && <Badge color="green">{charImagesUsed} identity ref{charImagesUsed > 1 ? 's' : ''}</Badge>}
              {characterIds.length > 0 && (
                <button onClick={() => setCharacterIds([])} className="text-[0.6875rem] text-zinc-500 hover:text-zinc-300 transition cursor-pointer underline">Clear</button>
              )}
            </div>
          </div>

          {chars.length === 0 ? (
            <p className="text-xs text-zinc-600">No characters yet — add one in Eddy's Character tab first.</p>
          ) : (
            <>
              {/* Her own face BEFORE you pick her, same tiles as the Base tab. A name-only list
                    meant choosing between people by reading labels, when the whole point is that you
                    recognise her on sight. The tile is her BASE photo when one is marked, else her
                    earliest — the same image that leads the reference payload. */}
                <p className="text-xs text-zinc-500">Her saved reference photos are sent as the identity to hold.</p>
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                  {chars.map((c) => {
                    // A pair folder holds no images itself — its women are its subfolders. Reading
                    // only its own items showed "No photo" on a character that works perfectly,
                    // which reads as broken. refsForCharacter already resolves either shape.
                    const members = membersOf(c.id);
                    const mine = members.length ? refsForCharacter(c.id) : charItems.filter((i) => i.folderId === c.id);
                    const lead = mine.find((i) => i.role === 'base') || [...mine].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
                    return (
                      <button key={c.id} type="button"
                        // Toggles into a LIST. Clicking a second character adds her rather than
                        // replacing the first, so one scene can be run across several models.
                        onClick={() => toggleCharacter(c.id)}
                        className={cn('relative overflow-hidden rounded-xl border-2 text-left transition cursor-pointer',
                          characterIds.includes(c.id) ? 'border-rose-500' : 'border-white/[0.07] hover:border-zinc-600')}>
                        {characterIds.length > 1 && characterIds.includes(c.id) && (
                          // The ORDER, not just that it is ticked: results come back per character
                          // and the number is how a tile is matched to a face at a glance.
                          <span className="absolute left-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[0.625rem] font-bold text-white">
                            {characterIds.indexOf(c.id) + 1}
                          </span>
                        )}
                        {lead && charThumbs[lead.id]
                          ? <img src={charThumbs[lead.id]} alt="" loading="lazy" className="aspect-[3/4] w-full object-cover bg-zinc-950" />
                          : <span className="flex aspect-[3/4] w-full items-center justify-center bg-white/[0.03] text-xs text-zinc-600">No photo</span>}
                        <span className={cn('block px-2 py-1.5 text-xs font-semibold',
                          characterIds.includes(c.id) ? 'bg-rose-500/15 text-rose-300' : 'bg-white/[0.02] text-zinc-400')}>
                          {c.name} <span className="text-zinc-600">{mine.length}</span>
                          {members.length > 1 && (
                            // Says what will happen before it is paid for: this tile is more than
                            // one woman, and the names are the ones the prompt will use.
                            <span className="block truncate font-normal text-emerald-400/90">
                              {members.length} in one photo · {members.map((m) => m.name).join(' + ')}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              {characterId && (
                <p className="text-[0.625rem] text-zinc-600 leading-relaxed">
                  {membersOf(characterId).length > 1
                    ? <>{membersOf(characterId).map((m) => m.name).join(' and ')} come out TOGETHER in one photo — one render per source, not one each. A source with one woman is re-staged to fit them both; a source that already has two gives one to each.</>
                    : characterIds.length > 1
                      ? <>Each source photo is generated once per character — {characterIds.length} runs of every photo. Each run sends that character&rsquo;s own photos first, then the source.</>
                      : <>Sends all {charImagesUsed} of {charName || 'this character'}&rsquo;s photo{charImagesUsed === 1 ? '' : 's'} first, then the source photo — Seedream keeps whoever is in image 1, and identity comes only from those.</>}
                  {charImagesUsed === 1 && (
                    <span className="block mt-1 text-yellow-400/90">
                      Only one photo of her is on file. One identity image against the source photo is a weak
                      contest and her face may not carry — add more photos on the Characters page.
                    </span>
                  )}
                  {/* HER FIGURE IS EVIDENCE, NOT INSTRUCTIONS — measured, not assumed.
                      Tested on 2026-08-16 against a slim character and a fuller-figured source: the
                      output kept the SOURCE's build through Exact recreate on, Exact recreate off,
                      a 520-character body lock, and Her build set explicitly. Three renders, no
                      change. What the model had was a clear body in the source and none in her
                      references — and no amount of text beats that. The one thing that does is a
                      reference photo showing her figure. */}
                  <span className="block mt-1 text-zinc-500">
                    For her FIGURE to carry, at least one of her reference photos has to show her
                    body — a face-only set gives the model nothing to hold against the source, and no
                    wording makes up for it.
                  </span>
                  {charTruncated && (
                    <span className="block mt-1 text-yellow-400/90">
                      Only {charImagesUsed} of {charImageCount} character images fit — Seedream caps at {SEEDREAM_MAX_IMAGES} total and the source takes one slot.
                    </span>
                  )}
                </p>
              )}
            </>
          )}
        </Card>

        {/* Match controls */}
        <Card className="p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Match Mode</h3>
            <button type="button" onClick={() => setNsfw((v) => !v)} aria-pressed={nsfw}
              className={cn('group flex items-center gap-3 rounded-xl border px-3 py-2 transition cursor-pointer',
                nsfw ? 'border-rose-500/60 bg-rose-500/10 shadow-[0_0_22px_-6px] shadow-rose-500/70'
                     : 'border-white/[0.07] bg-white/[0.02] hover:border-zinc-600')}>
              <span className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', nsfw ? 'bg-rose-500' : 'bg-zinc-700')}>
                <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', nsfw ? 'left-[22px]' : 'left-0.5')} />
              </span>
              <span className="text-left leading-tight">
                <span className={cn('block text-sm font-bold tracking-wide', nsfw ? 'text-rose-300' : 'text-zinc-400')}>
                  NSFW {nsfw ? 'ON' : 'OFF'}
                </span>
                <span className="block text-[0.625rem] text-zinc-500">
                  {nsfw ? 'She is NUDE · the source outfit is removed' : 'The source outfit is kept'}
                </span>
              </span>
            </button>
          </div>
          {/* Seedream exposes no seed, strength or mask — these change prompt wording, not a
              numeric knob, so the Gemini page's strength sliders can't be ported here. */}
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <Toggle checked={exactRecreate} onChange={setExactRecreate} label="Exact recreate" />
            <Toggle checked={varyBackground && !exactRecreate} onChange={setVaryBackground} label="Vary background" />
            <Toggle checked={blurSource} onChange={setBlurSource} label="Blur source face" />
            <Toggle checked={faceless} onChange={setFaceless} label="Faceless result" />
            {/* No point offering it on a faceless result — there is no face to point at the lens. */}
            {!faceless && <Toggle checked={lookAtCamera} onChange={setLookAtCamera} label="Look at camera" />}
            {/* WHOSE OUTFIT. Not a Toggle like its neighbours: this is a choice between two things
                rather than a switch that turns one off, and a toggle labelled "her outfit" leaves
                you guessing what OFF means. Hidden while NSFW is on — there is no garment either
                way, and offering the choice there would be a control that does nothing.

                `nsfw`, not `wantsNude`: the latter is derived inside handleMatch (it also reads the
                instruction box for an undress request) and does not exist at render time. The
                builder still guards on wantsNude, so an undress typed into the box wins there. */}
            {!nsfw && (
              <span className="flex items-center gap-2">
                <span className="text-[0.6875rem] uppercase tracking-wider text-zinc-500">Outfit from</span>
                <span className="flex rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
                  {[[false, 'Scene photo'], [true, 'Her photos']].map(([val, label]) => (
                    <button key={label} type="button" onClick={() => setOutfitFromChar(val)}
                      aria-pressed={outfitFromChar === val}
                      className={cn('rounded-md px-2.5 py-1 text-xs font-semibold transition cursor-pointer',
                        outfitFromChar === val ? 'bg-rose-500/20 text-rose-300' : 'text-zinc-500 hover:text-zinc-300')}>
                      {label}
                    </button>
                  ))}
                </span>
              </span>
            )}
          </div>
          {faceless && (
            <p className="text-[0.625rem] leading-relaxed text-fuchsia-400/80">
              The output is composed with her face OUT of the shot — cropped, turned away or hidden.
              Her body, hair and skin still come from the character; only the face is withheld.
            </p>
          )}
          {blurSource && (
            <p className="text-[0.625rem] leading-relaxed text-emerald-400/80">
              Faces are blurred as photos are added, so what you see is what gets sent and Seedream
              has no rival face to copy. Turn off before adding if you want the original.
            </p>
          )}
          <p className="text-[0.625rem] text-zinc-600 leading-relaxed">
            {exactRecreate
              ? (nsfw
                ? 'Exact recreate — the photo is reproduced pixel-for-pixel, the identity changes AND her clothing is removed. Background variation is off while this is on.'
                : 'Exact recreate — the photo is reproduced pixel-for-pixel and only the identity changes. Background variation is off while this is on.')
              : varyBackground
                ? (nsfw
                  ? 'Same location, but the lighting mood and minor background details shift — a different moment in the same place. She is nude; the source outfit is not carried over.'
                  : 'Same location, but the lighting mood and minor background details shift — a different moment in the same place.')
                : (nsfw
                  ? 'Scene, pose and framing are preserved from each source photo. The identity is replaced and the outfit is REMOVED — she is nude.'
                  : (outfitFromChar
                    ? 'Scene, pose and framing come from each source photo — but she wears HER outfit from her reference photos, not the one in the scene.'
                    : 'Scene, pose, outfit and framing are preserved from each source photo; only the identity is replaced.'))}
          </p>
        </Card>

        {/* Instructions + presets */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
            Extra Instructions <span className="text-zinc-600 font-normal normal-case">(optional)</span>
          </h3>
          {(nsfw ? [...PRESET_GROUPS, ...NSFW_GROUPS] : PRESET_GROUPS).map((group) => (
            <div key={group} className="flex flex-wrap items-center gap-1.5">
              <span className="w-12 shrink-0 text-[0.625rem] font-bold uppercase tracking-wider text-zinc-400">{group}</span>
              {ALL_PRESETS.filter((p) => p.group === group && (nsfw ? !p.dressedOnly : !p.nsfwOnly)).map((p) => (
                <button key={p.label} type="button"
                  onClick={() => setExtra((prev) => (prev.includes(p.text) ? prev : `${prev ? `${prev.trim()} ` : ''}${p.text}`))}
                  className="rounded-full border border-zinc-800/60 bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-rose-300 hover:border-rose-500/50 transition-colors duration-150 cursor-pointer">
                  + {p.label}
                </button>
              ))}
            </div>
          ))}
          <Textarea value={extra} onChange={(e) => setExtra(e.target.value)} rows={2} maxLength={1500}
            placeholder="e.g. keep the sunglasses, warmer sunset light..." />
          <p className="text-[0.625rem] text-zinc-600 leading-relaxed">
            {ALL_PRESETS.some((preset) => preset.bodyChange && extra.includes(preset.text)) && (
              <span className="block text-amber-400/90">
                A size chip is selected, so her figure comes from that chip — not from her reference photos. Use “Match her bust exactly” to copy her real size instead.
              </span>
            )}
            {nsfw && (
              <span className="block text-rose-400/90">
                NSFW is on, so the whole prompt changes: the scene, pose and framing are still copied, but every rule that
                preserved the source outfit is dropped and an explicit undress instruction is sent instead.
              </span>
            )}
            The identity-swap instruction is added automatically. Seedream keeps whoever is in image 1, so {charName || 'your character'} goes first: images{' '}
            <span className="font-mono text-zinc-400">1–{Math.max(1, charImagesUsed)}</span> {charName || 'character'} identity refs, then{' '}
            <span className="font-mono text-zinc-400">{Math.max(1, charImagesUsed) + 1}</span> the scene photo.
            {charDetail?.masterPrompt ? " The character's own description is included too." : ''}
          </p>
        </Card>

        {/* Settings */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Settings</h3>
          <div className="grid grid-cols-2 gap-4">
            <Select label="Aspect Ratio" options={ASPECT_OPTIONS} value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} />
            <Select label="Resolution" options={RES_OPTIONS} value={resolution} onChange={(e) => setResolution(e.target.value)} />
          </div>
          {/* HER BUILD — the same control, and the same brain, as Eddy's.
              Deliberately NOT one of the Body chips: a chip is a change and stands the
              bust-preservation locks down, while this is a standing fact about her that rides WITH
              them, naming the size they are holding. "From her photos" is the default and emits
              nothing at all. */}
          <div>
            <Select label="Her build"
              options={BUILD_OPTIONS.map((b) => ({ value: b.value, label: b.label }))}
              value={build} onChange={(e) => setBuild(e.target.value)} />
            <p className="mt-1 text-[0.625rem] leading-relaxed text-zinc-600">
              {build === 'auto'
                ? 'Her figure comes from her reference photos alone, with nothing said about it.'
                : 'Names the build the identity lock is holding — this is what she looks like, not a change to her. A back-facing source gets the version that only describes what the camera can see. It still needs a reference photo showing her body to hold against the source.'}
            </p>
          </div>
          {/* WHERE THE RESULTS GO. Set before Generate, because moving a batch of thirty after the
              fact is thirty drags. Remembered between runs. */}
          <Select label="Send results to" options={DESTINATIONS} value={destDb} onChange={(e) => setDestDb(e.target.value)} />
          <p className="text-[0.6875rem] text-zinc-500">
            Files into <span className="text-zinc-300">{destLabel}</span>
            {charName.trim() ? <> &rarr; <span className="text-zinc-300">{charName.trim()}</span></> : ' → Photo Match'}
          </p>
          {/* ENGINE. Both models sit behind the same WaveSpeed key and the same route, so this
              changes one field in the request and the price quoted above it -- nothing else. */}
          <div className="mb-2 flex gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
            {(isNB2 ? [['nb2', 'Nano Banana 2 — bypass']] : [['seedream', 'Seedream 5.0 Pro'], ['nano2', 'Nano Banana 2']]).map(([id, label]) => (
              <button key={id} type="button" onClick={() => setEngine(id)} aria-pressed={engine === id}
                className={cn('flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition cursor-pointer',
                  engine === id ? 'bg-rose-500/20 text-rose-300' : 'text-zinc-500 hover:text-zinc-300')}>
                {label}
              </button>
            ))}
          </div>
          {/* The fallback, stated BEFORE the run rather than discovered afterwards.
              A picture on this tab can come back from a different engine at a different price, and
              the engine row is where that belongs — the badge on a finished tile only tells you
              once the money is spent (owner, 2026-08-16). */}
          {isNB2 && (
            <p className="mb-2 text-[0.625rem] leading-relaxed text-amber-300/80">
              Fails over to <span className="font-semibold">Seedream 5.0 Pro (WaveSpeed)</span> after {NB2_ATTEMPTS} failed
              tries — so a picture the bypass refuses still gets made. Those render at
              <span className="font-semibold">2K</span> whatever is set above, come back marked
              <span className="font-semibold"> (fallback)</span>, and are billed at Seedream&rsquo;s 2K rate
              (<span className="font-mono">${seedreamCost('2K', imagesPerJob).toFixed(3)}</span>), not this one.
            </p>
          )}
          <p className="text-[0.625rem] text-zinc-600">
            {imagesPerJob} image{imagesPerJob > 1 ? 's' : ''} per match → <span className="text-zinc-400 font-mono">${costPerJob.toFixed(3)}</span> each
            {runCount > 1 && (
              <> · {sources.length} photo{sources.length === 1 ? '' : 's'}
                {characterIds.length > 1 && <> × {characterIds.length} characters</>}
                {' = '}{runCount} image{runCount === 1 ? '' : 's'} → <span className="text-zinc-400 font-mono">${totalCost.toFixed(3)}</span> total
              </>
            )}
            {aspectRatio === 'auto' && <> · Auto snaps each photo to its closest Seedream ratio</>}
          </p>
        </Card>

        {/**
          * NOT disabled while running (owner, 2026-08-18). A batch here can take many minutes, and
          * refusing a second one meant sitting and watching rather than queueing the next set of
          * photos. Nothing about a run is exclusive: each has its own ids, its own lanes and its own
          * completion summary, and the queue behind it is built for concurrency.
          *
          * The label still shows live progress across every run in flight, so pressing it again is
          * an addition rather than a replacement — which is exactly what the panel does with the
          * tiles.
          */}
        <Btn onClick={handleMatch} className="w-full">
          {running ? <Spinner size={16} /> : null}
          {running
            ? `Matching… (${runProgress.done}/${runProgress.total}) · press again to add ${runCount}`
            : `Photo Match${runCount > 1 ? ` · ${runCount} images` : ''} · $${totalCost.toFixed(3)}`}
        </Btn>

      </div>
      </div>

      {/* THE RESULTS COLUMN. Always present, so the panel has a home before the first run rather
          than appearing from nowhere — the empty state says what will fill it.

          A SIBLING of the setup column, not a child. It was nested inside it — the close above was
          added in the wrong place and shut an inner space-y-4 wrapper instead of the column — so
          the results rendered in the left 560px strip while the right two thirds of the window sat
          empty (owner, 2026-08-13). A brace count says "balanced" either way; only the DEPTH says
          which of the two it is. */}
      <div className="min-w-0 flex-1 space-y-3 lg:min-h-0 lg:overflow-y-auto lg:pl-1">
        {jobs.length === 0 && (
          <div className="flex h-full min-h-[240px] flex-col items-center justify-center rounded-2xl border border-white/[0.06] bg-white/[0.02] p-8 text-center">
            <p className="text-sm font-semibold text-zinc-400">No matches yet</p>
            <p className="mt-1 text-xs text-zinc-600">Run one and the results land here — tick any of them to send to Library or Base Library.</p>
          </div>
        )}
        {jobs.length > 0 && (
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
                Results <span className="text-zinc-600 font-normal normal-case">({doneJobs.length}/{jobs.length})</span>
              </h3>
              {!running && <button onClick={() => setJobs([])} className="text-[0.6875rem] text-zinc-500 hover:text-zinc-300 transition cursor-pointer underline">Clear</button>}
            </div>

            {/**
              * THE FAILED ROW, on its own and OUTSIDE the finished-results toolbar.
              *
              * Retry used to live in that toolbar, which only renders when something has finished
              * and been filed. So a run where everything failed — the exact case you most want to
              * retry, and what "WaveSpeed is out of credits" does to a whole batch — showed no
              * retry button at all. Topping the account up on another machine then left no way back
              * into those jobs from this page.
              *
              * Dismiss sits beside it because the other half of the problem is the tiles: seven red
              * cards spread through seventy good ones, and the only broom was "Clear", which throws
              * away the finished pictures too (owner, 2026-08-17).
              */}
            {allFailed.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/[0.07] px-3 py-2">
                <span className="text-xs font-semibold text-red-300">{allFailed.length} failed</span>
                {/* The reason, once, instead of reading it off each card — they are nearly always
                    the same reason, and the fix is usually one thing (top up, add a key). */}
                {allFailed[0]?.error && (
                  <span className="min-w-0 flex-1 truncate text-[0.625rem] text-zinc-500" title={allFailed[0].error}>{allFailed[0].error}</span>
                )}
                {failedJobs.length > 0 && (
                  <button type="button" onClick={retryFailed}
                    title="Re-runs them on the server. Use this after topping up credits or adding a key."
                    className="rounded-full border border-red-500/50 bg-red-500/10 px-2.5 py-0.5 text-[0.625rem] font-semibold text-red-300 hover:border-red-400 cursor-pointer">
                    Retry {failedJobs.length} failed
                  </button>
                )}
                <button type="button" onClick={dismissAllFailed}
                  title="Removes the failed tiles from this page only. Finished pictures and anything already in your library are untouched."
                  className="rounded-full border border-white/[0.12] px-2.5 py-0.5 text-[0.625rem] font-semibold text-zinc-300 hover:border-zinc-400 cursor-pointer">
                  Dismiss {allFailed.length} failed
                </button>
              </div>
            )}

            {/* TICK AND SEND, the same idea Eddy's results panel has had for months.
                Without it the only way to act on a finished picture was to leave for the Library
                tab and find it again (owner, 2026-08-13). With nothing ticked the buttons act on
                everything filed, because "send them all" is the common case and making you tick
                twenty tiles to say it is not an improvement. */}
            {filedJobs.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2">
                <span className="text-xs text-zinc-300">
                  {pickedJobs.size ? `${pickedJobs.size} selected` : `${filedJobs.length} finished`}
                </span>
                <button type="button"
                  onClick={() => setPickedJobs(pickedJobs.size === filedJobs.length ? new Set() : new Set(filedJobs.map((j) => j.id)))}
                  className="text-[0.6875rem] text-zinc-400 underline hover:text-zinc-200 cursor-pointer">
                  {pickedJobs.size === filedJobs.length ? 'Clear selection' : `Select all ${filedJobs.length}`}
                </button>

                {/* SMART SELECTING. By count — type any number — and by age, newest first. */}
                <span className="flex items-center gap-1">
                  <input
                    type="number"
                    min="1"
                    value={pickCount}
                    onChange={(e) => setPickCount(Math.max(1, Number(e.target.value) || 1))}
                    className="w-14 rounded border border-white/[0.08] bg-black/30 px-1.5 py-0.5 text-[0.6875rem] text-zinc-200 outline-none"
                  />
                  <button type="button" onClick={() => selectNewest(pickCount)}
                    className="rounded-full border border-white/[0.08] px-2 py-0.5 text-[0.625rem] text-zinc-300 hover:border-zinc-500 cursor-pointer">
                    newest
                  </button>
                </span>
                <button type="button" onClick={() => selectSince(60 * 60 * 1000)}
                  className="rounded-full border border-white/[0.08] px-2 py-0.5 text-[0.625rem] text-zinc-300 hover:border-zinc-500 cursor-pointer">
                  Last hour ({countSince(60 * 60 * 1000)})
                </button>
                <button type="button" onClick={() => selectSince(24 * 60 * 60 * 1000)}
                  className="rounded-full border border-white/[0.08] px-2 py-0.5 text-[0.625rem] text-zinc-300 hover:border-zinc-500 cursor-pointer">
                  Last 24h ({countSince(24 * 60 * 60 * 1000)})
                </button>

                {/* The comparison, off by default — see the note on showCompare. */}
                <label className="flex cursor-pointer items-center gap-1 text-[0.625rem] text-zinc-400">
                  <input type="checkbox" checked={showCompare} onChange={(e) => setShowCompare(e.target.checked)}
                    className="cursor-pointer accent-rose-500" />
                  Before / after
                </label>
                {unfiledCount > 0 && (
                  <button type="button" onClick={recoverLost} disabled={recovering}
                    title="Pictures that finished while the app was closed or reloading. They are in the gallery already — this puts them into your library."
                    className="rounded-full border border-emerald-500/50 bg-emerald-500/10 px-2.5 py-0.5 text-[0.625rem] font-semibold text-emerald-300 hover:border-emerald-400 cursor-pointer disabled:opacity-50">
                    {recovering ? 'Recovering…' : `Recover ${unfiledCount} lost`}
                  </button>
                )}
                <span className="ml-auto flex flex-wrap gap-2">
                  {/* Only with a selection — see retryPicked for why this one does not default to
                      everything the way the Send buttons do. */}
                  {pickedJobs.size > 0 && (
                    <Btn variant="secondary" className="!rounded-lg !py-1 !px-3 !text-xs !border-sky-500/40 !text-sky-200"
                      disabled={retrying}
                      title="Make these again with a different instruction — the same photos and the same character. Each press asks for something different: face, skin, hands, light."
                      onClick={retryPicked}>
                      {retrying ? 'Retrying…' : `Retry ${pickedJobs.size}`}
                    </Btn>
                  )}
                  <Btn variant="secondary" className="!rounded-lg !py-1 !px-3 !text-xs"
                    disabled={!!movingTo}
                    onClick={() => moveResultsTo('eddy-library')}>
                    {movingTo === 'eddy-library' ? 'Sending…' : `Send ${actionable.length} to Library`}
                  </Btn>
                  <Btn variant="secondary" className="!rounded-lg !py-1 !px-3 !text-xs !border-emerald-500/40 !text-emerald-200"
                    disabled={!!movingTo}
                    onClick={() => moveResultsTo('eddy-base')}>
                    {movingTo === 'eddy-base' ? 'Sending…' : `Send ${actionable.length} to Base Library`}
                  </Btn>
                </span>
              </div>
            )}

            <div className="grid [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {jobs.map((job) => (
                <div key={job.id}
                  // The tile body is the SELECT target; the picture below stops the click so it can
                  // open the large view instead. Two gestures, no ambiguity.
                  onClick={() => { if (job.status === 'done' && urlOfJob(job)) toggleJob(job.id); }}
                  className={cn('rounded-xl border bg-white/[0.02] p-2.5 space-y-2 cursor-pointer',
                    pickedJobs.has(job.id) ? 'border-rose-500' : 'border-zinc-800/60')}>
                  <div className="flex items-center justify-between gap-2">
                    {/* Only a FILED picture can be sent anywhere, so only those get a tick. */}
                    {/* urlOfJob, NOT galleryId: a tile read back out of a library has a url and no
                        galleryId, so this rendered a checkbox on THIS run's tiles only — every
                        older picture looked unselectable (owner, 2026-08-13: "I can select only
                        one"). Same mistake as the filter above, which was already fixed. */}
                    {job.status === 'done' && urlOfJob(job) && (
                      <input type="checkbox" checked={pickedJobs.has(job.id)} onChange={() => toggleJob(job.id)}
                        onClick={(e) => e.stopPropagation()}
                        title="Tick to send just these"
                        className="cursor-pointer accent-rose-500" />
                    )}
                    {job.status === 'done' ? <Badge color="green">Done</Badge>
                      : job.status === 'failed' ? <Badge color="red">Failed</Badge>
                      : job.status === 'running' ? <Badge color="yellow">Matching…</Badge>
                      : <Badge color="zinc">Queued</Badge>}
                    {/**
                      * GOOGLE OR WAVESPEED, on every tile including the ones still going.
                      *
                      * It was one grey word in the small print under a finished picture, and
                      * nothing at all while it rendered — so with an automatic fallback in the
                      * middle there was no way to answer "is this Google or WaveSpeed?" at the
                      * moment you were asking it (owner, 2026-08-18: "it not showing if it is
                      * gemini no wavespeed u get me"). Blue is Google, amber is WaveSpeed, and a
                      * fallback says so.
                      */}
                    {(() => {
                      const on = job.status === 'done' ? job.engine : job.runningOn;
                      if (!on) return null;
                      const ws = on === 'seedream5' || on === 'seedream';
                      return (
                        <span className={cn('rounded px-1.5 py-px text-[0.5625rem] font-semibold uppercase tracking-wider',
                          ws ? 'bg-amber-500/15 text-amber-300' : 'bg-sky-500/15 text-sky-300')}>
                          {on === 'nb2' ? 'NB2 · Google' : on === 'nano2' ? 'Nano 2' : 'Seedream · WaveSpeed'}
                          {job.status === 'done' && job.fellBack ? ' · fell back' : ''}
                        </span>
                      );
                    })()}
                    {/* WHOSE result this is. With several characters ticked the same source photo
                        appears once per woman, and the thumbnails are identical — without the name
                        the only way to tell them apart is to open each one. */}
                    {job.charName && <span className="text-[0.625rem] font-semibold text-rose-300">{job.charName}</span>}
                    {job.status === 'done' && typeof job.cost === 'number' && <span className="text-[0.625rem] text-zinc-600 font-mono">${job.cost.toFixed(3)}</span>}
                    {/* One failed tile, gone. Only on failed ones: a finished picture is removed by
                        clearing, and a running one would come back on the next poll anyway. */}
                    {job.status === 'failed' && (
                      <button type="button"
                        onClick={(e) => { e.stopPropagation(); dismissJob(job.id); }}
                        title="Remove this failed result from the page"
                        className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-xs text-zinc-500 hover:border-red-500 hover:text-red-300 cursor-pointer">×</button>
                    )}
                  </div>

                  {job.status === 'done' && (job.result || urlOfJob(job)) ? (
                    /**
                     * After a reload there is no base64 — the bytes were never persisted. The
                     * picture comes back from the server copy via galleryId, and the slider's
                     * SOURCE side from the small JPEG kept beside it. A restored tile with no
                     * source thumb shows the result alone rather than a broken slider.
                     */
                    showCompare && (job.result ? job.thumb : job.thumbSmall) ? (
                      <CompareSlider
                        originalSrc={job.result ? job.thumb : job.thumbSmall}
                        processedSrc={resultSrc(job)}
                        originalLabel="SOURCE"
                        processedLabel="MATCHED"
                        className="rounded-lg overflow-hidden border border-zinc-800/60"
                      />
                    ) : (
                      <img src={resultSrc(job)}
                        alt="" loading="lazy"
                        onClick={(e) => { e.stopPropagation(); setLightboxId(job.id); }}
                        title="Click to see it full size"
                        className="w-full cursor-zoom-in rounded-lg border border-zinc-800/60 bg-zinc-950 object-contain" />
                    )
                  ) : (
                    <div className="relative">
                      {/* An unfinished tile shows the SOURCE photo, which reads as a finished result
                          that came back unchanged — with a blurred face, it reads as "it returned
                          exactly what I sent" (owner, 2026-08-16). Dimmed harder and labelled, so
                          there is no mistaking the placeholder for the output. */}
                      <img src={job.thumb} alt="" className={cn('w-full aspect-[3/4] object-cover rounded-lg border border-zinc-800/60 bg-zinc-950', job.status !== 'done' && 'opacity-30')} />
                      {job.status === 'running' && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                          <Spinner size={22} />
                          <span className="rounded bg-black/70 px-2 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wide text-amber-300">
                            Your source · rendering
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {job.status === 'failed' && <p className="text-[0.625rem] text-red-400 leading-snug">{job.error}</p>}
                  {/**
                    * ONE TILE, RUN AGAIN — the two ways you actually want it.
                    *
                    * "Try again" repeats it exactly as asked, which is the right move for a refusal:
                    * a refusal is a roll, not a verdict, and the same request often passes next time.
                    * "On WaveSpeed" skips the argument entirely and runs it on Seedream 5 Pro, which
                    * is where a job the bypass will never accept has to go.
                    *
                    * Both are per-tile on purpose. Before this the only way to redo one picture was
                    * to re-run the whole batch, paying for every other photo again.
                    */}
                  {job.status === 'failed' && (
                    <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <button type="button" onClick={() => rerunJob(job)}
                        title="Run this one again, exactly as it was asked for"
                        className="rounded-md border border-white/[0.12] px-2 py-1 text-[0.625rem] font-semibold text-zinc-300 hover:border-zinc-400 cursor-pointer">
                        Try again
                      </button>
                      <button type="button" onClick={() => rerunJob(job, { forceEngine: 'seedream5' })}
                        title="Run this one on Seedream 5 Pro (WaveSpeed) instead — where a picture Google will not make still gets made"
                        className="rounded-md border border-amber-600/50 bg-amber-500/10 px-2 py-1 text-[0.625rem] font-semibold text-amber-200 hover:border-amber-400 cursor-pointer">
                        On WaveSpeed
                      </button>
                    </div>
                  )}
                  {/* Where this one currently lives, so "send to Base" has a visible before and
                      after rather than being an action with no feedback. */}
                  {job.status === 'done' && urlOfJob(job) && (
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[0.5625rem] uppercase tracking-wider text-zinc-600">
                        {job.charName ? `${job.charName} · ` : ''}in {job.filedDb === 'eddy-base' ? 'Base Library' : 'Library'}
                        {/* WHAT MADE IT. Two engines, two modes and a faceless switch produce very
                            different pictures, and a week later the tile is the only record. */}
                        {job.engine && ` · ${job.engine === 'nb2' ? 'NB2' : job.engine === 'nano2' ? 'Nano 2' : 'Seedream'}${job.fellBack ? ' (fallback)' : ''}`}
                        {job.resolution && ` ${job.resolution}`}
                        {job.mode === 'exact' && ' · exact'}
                        {job.faceless && ' · faceless'}
                      </p>
                      <span className="flex items-center gap-2">
                        {/**
                          * REGENERATE — make this one again.
                          *
                          * Rebuilt from the tile plus the page's CURRENT settings, so changing a
                          * chip and pressing this does what you would expect. The character comes
                          * from the id stored on the tile, never from whatever happens to be ticked
                          * now, or a regenerate would quietly swap the woman.
                          *
                          * It REPLACES this tile rather than adding one: it is the same picture,
                          * made again. Sending it to a library first and regenerating after leaves
                          * the filed copy alone — this only changes what is on the panel.
                          */}
                        <button type="button"
                          onClick={(e) => { e.stopPropagation(); rerunJob(job); }}
                          title="Make this one again with the current settings — the same source photo and the same character"
                          className="text-[0.625rem] text-zinc-400 underline hover:text-zinc-200 cursor-pointer">
                          Regenerate
                        </button>
                        {/* RETRY — the same picture, asked for differently. Regenerate repeats the
                            request word for word, which gets you the same kind of picture; this
                            adds a line at the tail naming what to do better, and a different one
                            on each press. One bad tile is the common case, so it is here as well
                            as on the selection bar. */}
                        <button type="button"
                          onClick={(e) => { e.stopPropagation(); rerunJob(job, { vary: true }); }}
                          title="Not good? Make it again with a different instruction — same photo, same character. Each press changes what it asks for: face, skin, hands, light."
                          className="text-[0.625rem] text-sky-300/80 underline hover:text-sky-200 cursor-pointer">
                          Retry{job.retryN ? ` ${job.retryN + 1}` : ''}
                        </button>
                        {/* REMOVE takes it off this panel only. The picture stays in the gallery and
                            in whichever library it was filed into — this is the queue's exit, not a
                            delete. Same meaning as Eddy's Remove. */}
                        <button type="button"
                          onClick={(e) => { e.stopPropagation(); setJobs((prev) => prev.filter((x) => x.id !== job.id)); setPickedJobs((cur) => { const n = new Set(cur); n.delete(job.id); return n; }); }}
                          title="Take this off the panel — the picture stays in the gallery and the library"
                          className="text-[0.625rem] text-zinc-500 underline hover:text-zinc-300 cursor-pointer">
                          Remove
                        </button>
                        {/* DELETE is the real one: it takes the row out of the library it is in, so
                            the picture stops appearing in that tab. Separated from Remove and
                            confirmed, because the two words are one letter apart in meaning and a
                            long way apart in consequence. */}
                        <button type="button"
                          onClick={(e) => { e.stopPropagation(); deleteJobRow(job); }}
                          title={`Delete from ${job.filedDb === 'eddy-base' ? 'Base Library' : 'Library'} — this one removes the picture from that tab`}
                          className="text-[0.625rem] text-red-400/80 underline hover:text-red-300 cursor-pointer">
                          Delete
                        </button>
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* THE LARGE VIEW. Portalled to <body> like the Library's: `position: fixed` anchors to the
          nearest ancestor with a transform or backdrop-filter rather than the viewport, and this
          page sits inside one — without the portal the overlay opens somewhere down the column and
          has to be scrolled to. */}
      {lightboxId && (() => {
        const job = lightboxList.find((j) => j.id === lightboxId);
        if (!job) return null;
        const src = resultSrc(job);
        const i = lightboxList.findIndex((j) => j.id === lightboxId);
        return createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
            // Backdrop only: a click that started on the picture must not close it when the pointer
            // drifts off, which makes a large view feel broken.
            onClick={(e) => { if (e.target === e.currentTarget && zoom === 1) setLightboxId(''); }}
            /**
             * The wheel is bound on the BACKDROP, not the picture: once zoomed in, the image can be
             * panned past the edge of the window, and a wheel over the empty area beside it should
             * still zoom rather than do nothing.
             *
             * passive is not an option here — preventDefault is what stops the page behind the
             * overlay scrolling — so this uses onWheel with an explicit preventDefault.
             */
            onWheel={(e) => {
              e.preventDefault();
              zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
            }}
            onDoubleClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              if (zoom > 1) { setZoom(1); setPan({ x: 0, y: 0 }); } else zoomAt(2, e.clientX, e.clientY, rect);
            }}
            // Pointer events rather than mouse: one code path covers a trackpad, a mouse and a pen,
            // and setPointerCapture keeps the drag alive when the pointer leaves the window.
            onPointerDown={(e) => {
              if (zoom === 1 || e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              // Where the pointer started, and where the picture was when it did. Panning is the
              // sum of the two — tracking only the delta since the last move accumulates rounding
              // and the image slowly drifts away from the cursor.
              panRef.current = { fromX: e.clientX, fromY: e.clientY, panX: pan.x, panY: pan.y };
            }}
            onPointerMove={(e) => {
              const g = panRef.current;
              if (!g) return;
              setPan({ x: g.panX + (e.clientX - g.fromX), y: g.panY + (e.clientY - g.fromY) });
            }}
            onPointerUp={() => { panRef.current = null; }}
            onPointerCancel={() => { panRef.current = null; }}
          >
            <img src={src} alt="" draggable={false} onClick={(e) => e.stopPropagation()}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, cursor: zoom > 1 ? 'grab' : 'zoom-in' }}
              className="max-h-full max-w-full select-none rounded-xl object-contain transition-transform duration-75 will-change-transform" />

            <div className="absolute left-4 top-4 rounded-lg bg-black/70 px-3 py-1.5 text-xs text-zinc-300">
              {job.charName || 'Photo Match'}
              {job.engine && <span className="text-zinc-500"> · {job.engine === 'nb2' ? 'NB2' : job.engine === 'nano2' ? 'Nano 2' : 'Seedream'}{job.fellBack ? ' (fallback)' : ''}</span>}
              {job.resolution && <span className="text-zinc-500"> {job.resolution}</span>}
              <span className="text-zinc-500"> · {i + 1} of {lightboxList.length}</span>
              {/* The zoom level, and — while it is 1 — how to change it. A gesture nobody is told
                  about is a gesture nobody uses, and it stops being worth saying the moment you
                  have used it once. */}
              {zoom > 1
                ? <span className="text-zinc-400"> · {zoom.toFixed(1)}× <button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} className="underline hover:text-white cursor-pointer">reset</button></span>
                : <span className="text-zinc-600"> · scroll or double-click to zoom</span>}
            </div>

            <button type="button" onClick={() => setLightboxId('')} aria-label="Close"
              className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-lg text-white hover:bg-white/20 cursor-pointer">×</button>
            {i > 0 && (
              <button type="button" onClick={() => stepLightbox(-1)} aria-label="Previous"
                className="absolute left-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-xl text-white hover:bg-white/20 cursor-pointer">‹</button>
            )}
            {i < lightboxList.length - 1 && (
              <button type="button" onClick={() => stepLightbox(1)} aria-label="Next"
                className="absolute right-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-xl text-white hover:bg-white/20 cursor-pointer">›</button>
            )}
          </div>,
          document.body,
        );
      })()}

      {manualBlurId && sources.some((s) => s.id === manualBlurId) && (
          /**
           * DRAW ON THE ORIGINAL, not on the smear.
           *
           * Opening this on an auto-blurred photo used to show the blurred copy, so the only thing
           * you could do was paint a second box on top of the wrong one — the misplaced blur stayed
           * in the picture that gets sent. You had to undo on the tile first and then come back,
           * which nobody would guess.
           *
           * The original is what it edits whenever there is one, so "the blur landed on her chest"
           * is fixed in one place: open it, draw the box on her face, apply. applyManualBlur keeps
           * `orig`, so this stays reversible however many times it is redrawn.
           */
          <ManualBlurModal
            src={sources.find((s) => s.id === manualBlurId).orig || sources.find((s) => s.id === manualBlurId).dataUrl}
            onApply={(newDataUrl) => applyManualBlur(manualBlurId, newDataUrl)}
            onClose={() => setManualBlurId(null)}
          />
        )}
      </div>
    </div>
  );
}
