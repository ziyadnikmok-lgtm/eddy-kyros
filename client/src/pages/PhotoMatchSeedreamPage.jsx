import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { seedream as seedreamApi, gallery as galleryApi } from '../services/api';
import { createEddyCollection } from '../lib/eddyCollectionStore';
import { useApp } from '../context/AppContext';
import { Card, Btn, Select, Textarea, Toggle, Badge, Spinner } from '../components/UI';
import CompareSlider from '../components/CompareSlider';
import { SEEDREAM_ASPECT_RATIOS, SEEDREAM_RESOLUTIONS, SEEDREAM_MAX_IMAGES, seedreamCost } from '../config/photoModes';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { consumeSourceHandoff } from '../lib/sourceHandoff';
import { detectAspectRatio } from '../lib/detectAspectRatio';
import { NSFW_PRESETS, nudeState, NUDE_LINE } from '../lib/nsfwPresets';
import { createPageStore } from '../lib/pageStateStore';
import { cn } from '../lib/utils';
import { autoBlurFace } from '../lib/autoBlurFace';
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
// 50, not 12: a Pinterest send arrives as one batch of whatever you ticked, and the old ceiling
// only ever blocked the manual "add photos" path while the handoff walked straight past it.
const MAX_SOURCES = 50;

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
const LANES = { seedream: 12, nano2: 6 };
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
const resultsStore = createPageStore('photomatch-results-v1');

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

/** The persisted shape of one finished match. Anything not named here is deliberately dropped. */
function liteJob(j) {
  return {
    id: j.id,
    status: j.status === 'done' ? 'done' : j.status,
    galleryId: j.galleryId || null,
    url: j.url || '',
    doneAt: j.doneAt || 0,
    engine: j.engine || '',
    resolution: j.resolution || '',
    mode: j.mode || '',
    faceless: !!j.faceless,
    // Where this picture lives in a collection, when it was read back out of one — so Delete can
    // remove the row it actually came from rather than guessing.
    libRowId: j.libRowId || null,
    mimeType: j.result?.mimeType || j.mimeType || 'image/png',
    charName: j.charName || '',
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

export function buildMatchInstruction({ characterName, refCount, masterPrompt, exactRecreate, varyBackground, allowExpressionChange, allowHairChange, allowBodyChange, allowLightingChange, faceless, wantsNude, addGenericNudeLine, sourceFaceBlurred, outfitFromChar = false }) {
  const who = characterName || 'the character';
  const n = Math.max(1, refCount);
  const refs = n > 1 ? `images 1-${n}` : 'image 1';
  const src = `image ${n + 1}`;

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
    allowHairChange ? null : 'hair',
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
    allowExpressionChange ? null : 'expression',
    allowLightingChange ? null : 'lighting',
  ].filter(Boolean).join(', ');

  const parts = [
    // Roles by image index, stated up front and hard.
    `${refs} = ${who} = the ONLY source for the person. ${src} = a photograph of a DIFFERENT woman, used ONLY for its scene — NEVER an identity reference.`,
    /**
     * REBUILD, NOT EDIT — and it has to be said before anything else.
     *
     * The failure this exists to stop: the output keeps the stand-in's body and wears ${who}'s
     * face. Naming the wrong answer works better on these models than adding another word about
     * the right one, so the wrong answer is named.
     */
    `REBUILD, DO NOT EDIT: do not modify ${src} and do not paste a face onto the woman in it. She does not appear in the output at all. Produce a NEW photograph of ${who} that reproduces ${src}'s scene. A result where the body is hers from ${src} and only the face changed is WRONG.`,
    exactRecreate
      ? `Reproduce ${src} exactly — same background, pose, props, framing, lighting${(wantsNude || outfitFromRefs) ? '' : ', outfit'} — but the person in it is rebuilt entirely as ${who}${wantsNude ? ', and remove her clothing as instructed below' : ''}${outfitFromRefs ? `, wearing HER outfit from ${refs} rather than the one in ${src}` : ''}.`
      : `A new photo of ${who} in ${src}'s scene, not a retouch of ${src}.`,
    `From ${refs}, match exactly: ${identity}. Where ${src} disagrees, ${refs} win.`,
    `From ${src}: ${scene}.`,
    // #4 — camera as its own instruction. Seedream copies the pose but defaults to a flattering
    // eye-level portrait crop unless the SHOT itself is pinned; this is what "same camera angle"
    // in Eddy needed spelled out separately from framing.
    `CAMERA: reproduce ${src}'s exact shot — the same camera angle, the same lens height, the same distance and the same crop/framing. A low-angle, high-angle, over-the-shoulder, close-up or wide shot in ${src} stays that shot; do NOT re-frame to a standard eye-level portrait.`,
  ];

  if (sourceFaceBlurred && !faceless) parts.push(`${src}'s face is deliberately blurred — do not reproduce the blur or invent a face from it; render ${who}'s face sharply from ${refs}.`);
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
    parts.push(`MAKEUP: exactly as ${who} wears it in ${refs} — same lips, eyes, lashes, brows. If ${refs} show a bold or dark lip, keep it; do NOT soften or naturalise it. Do NOT add makeup she is not wearing, and never take her makeup from ${src}.`);
  }
  if (outfitFromRefs) {
    parts.push(`OUTFIT: she wears HER OWN clothing from ${refs} — the same garments, colours, cut, fabric and length. Do NOT dress her in what the woman in ${src} is wearing; that outfit does not appear in the output. Everything else about the scene still comes from ${src}.`);
  }
  parts.push(`FORBIDDEN from ${src}: its face, facial structure, eyes, nose, mouth, jaw, hair colour, skin tone${allowBodyChange ? '' : ', body shape'}${outfitFromRefs ? ', its clothing' : ''}, and any tattoo, ink or skin marking. ${who} has only the tattoos visible in ${refs}.`);
  parts.push(`NO BLENDING: do not mix, merge or average ${who} with the person in ${src} — not her face and not her body. Every part of the person in the output is 100% ${refs}, not a midpoint between the two women.`);

  parts.push(`Photorealistic — real pores, hair strands, fabric, slight asymmetry; no plastic or CGI look.`);

  // #3 — the hardest locks go LAST. Seedream weights the tail of the prompt most heavily (the
  // whole reason chips are appended at the very end), so the identity guarantee and the bust lock
  // — the two things whose loss reads as "the page is broken" — belong here, not buried mid-prompt.
  if (faceless) {
    // Faceless output: the face must NOT appear, so the usual "must be recognisably her" guarantee
    // is wrong here and would fight the composition. Identity rides on body/hair instead.
    parts.push(`FINAL — HIGHEST PRIORITY, overrides everything above: her face is intentionally OUT of the shot — cropped above the shoulders, turned away, or hidden by hair/hand/angle so no recognisable face is visible. Do NOT invent or show a face. Her body, hair, skin and proportions still come from ${refs}${allowBodyChange ? '' : ' at their true size — never averaged or shrunk toward ' + src}.`);
  } else {
    const finalLock = [
      `FINAL — HIGHEST PRIORITY, overrides everything above: the PERSON in the output is ${who} from ${refs} — her face, her hair, her skin and her whole body. The woman in ${src} is an anonymous stand-in: discard her completely, face and figure alike, and if in any doubt copy ${refs}. Sacrifice ${src}'s likeness entirely to keep hers.`,
      // Body/chest: pinned to the refs UNLESS a size chip is driving it (then the chip, appended
      // after this whole prompt, wins and re-pinning here would fight it).
      allowBodyChange
        ? null
        : (wantsNude
          ? `Her body, figure and chest come from ${refs} at their true size — never averaged or shrunk toward ${src}.`
          : (outfitFromRefs
            ? `Her body, figure and chest come from ${refs} at their true size, and her own outfit sits on her exactly as it does there.`
            : `Her body, figure and chest come from ${refs} at their true size; the ${src} outfit stretches to fit HER — a tighter pull from a larger chest is correct, not an error.`)),
    ].filter(Boolean);
    parts.push(finalLock.join(' '));
  }

  return parts.join('\n\n');
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


const _cache = { extra: '', aspectRatio: 'auto', resolution: '1K', exactRecreate: false, varyBackground: false, nsfw: false, blurSource: true, faceless: false };
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

const store = createPageStore('kyros-photo-match-seedream-state');

/**
 * WaveSpeed's published per-image rate for nano-banana-2, by resolution. Kept beside Seedream's
 * own pricing (seedreamCost) rather than folded into it: nano2 charges a FLAT rate per image and
 * does not bill per extra reference, so sharing one cost function would misstate both.
 */
const NANO2_COST = { '1K': 0.07, '2K': 0.105 };

// Nano Banana 2 runs long -- a measured Eddy run spent 182.8s in inference alone -- and the
// client aborting first throws away an image that has already been generated and billed.
const NANO2_CLIENT_TIMEOUT_MS = 11 * 60_000;

export default function PhotoMatchSeedreamPage() {
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
  const [chars, setChars] = useState([]);        // folders in eddy-character
  const [charItems, setCharItems] = useState([]);
  const [charThumbs, setCharThumbs] = useState({});
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [f, i] = await Promise.all([charStore.listFolders(), charStore.listItems()]);
        const map = {};
        await Promise.all(i.map(async (it) => { map[it.id] = it.url || await charStore.getImage(it.id); }));
        if (!alive) return;
        setChars(f); setCharItems(i); setCharThumbs(map);
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
  const [blurringAll, setBlurringAll] = useState(false);
  const [manualBlurId, setManualBlurId] = useState(null);  // source id being hand-blurred, or null
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolution, setResolution] = useState(_cache.resolution);
  // 'seedream' | 'nano2'. Both go through the same /api/seedream/edit route and the same
  // WaveSpeed key -- `model` is the only thing that differs -- so a result gets the same
  // imageStore write, gallery row and tagging either way.
  const [engine, setEngine] = useState(_cache.engine || 'seedream');

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

  // Persist only after restore, or the first empty render would wipe the save.
  useEffect(() => { if (restored) store.set('sources', sources); }, [sources, restored]);
  useEffect(() => { if (restored) store.set('characterIds', characterIds); }, [characterIds, restored]);
  useEffect(() => { if (restored) store.set('extra', extra); }, [extra, restored]);

  useEffect(() => { _cache.extra = extra; }, [extra]);
  useEffect(() => { _cache.engine = engine; }, [engine]);
  useEffect(() => { _cache.nsfw = nsfw; }, [nsfw]);
  useEffect(() => { _cache.blurSource = blurSource; }, [blurSource]);
  useEffect(() => { _cache.faceless = faceless; }, [faceless]);
  useEffect(() => { _cache.outfitFromChar = outfitFromChar; }, [outfitFromChar]);
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
  const refsForCharacter = useCallback((id) => {
    if (!id) return [];
    const mine = charItems.filter((i) => i.folderId === id);
    const rank = (i) => (i.role === 'base' ? 0 : i.role === 'body' ? 1 : 2);
    return [...mine].sort((a, b) => rank(a) - rank(b) || (a.createdAt || 0) - (b.createdAt || 0));
  }, [charItems]);
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
  const costPerJob = engine === 'nano2'
    ? (NANO2_COST[resolution] ?? NANO2_COST['1K'])
    : seedreamCost(resolution, imagesPerJob);
  /**
   * The run is photos x CHARACTERS. Ticking a second woman doubles the bill, and the price on the
   * button is where that has to be visible -- it is the one number agreed before spending.
   */
  const runCount = Math.max(1, sources.length) * Math.max(1, characterIds.length);
  const totalCost = costPerJob * runCount;

  // ── sources ────────────────────────────────────────────────────────────────
  const addSources = useCallback(async (files) => {
    const room = MAX_SOURCES - sources.length;
    if (room <= 0) { notify(`Maximum ${MAX_SOURCES} source photos`, 'error'); return; }
    const valid = Array.from(files || []).filter((f) => /^image\/(png|jpeg|jpg|webp)$/i.test(f.type)).slice(0, room);
    if (!valid.length) return;
    let missed = 0;
    const added = await Promise.all(valid.map(async (f) => {
      let dataUrl = await fileToDataUrl(f);
      let blurred = false;
      if (blurSourceRef.current) {
        const out = await autoBlurFace(dataUrl);
        dataUrl = out.dataUrl;
        blurred = out.blurred;
        if (!out.blurred) missed += 1;
      }
      return { id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, dataUrl, blurred };
    }));
    if (missed) notify(`${missed} photo(s): no face found to blur — use "Blur all" or click a photo to blur by hand`, 'error');
    setSources((prev) => [...prev, ...added]);
  }, [sources.length, notify]);

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
    const results = await Promise.all(targets.map(async (s) => {
      const out = await autoBlurFace(s.dataUrl, { aggressive: true });
      if (out.blurred) { blurred += 1; return { id: s.id, dataUrl: out.dataUrl, blurred: true }; }
      missed += 1; return null;
    }));
    const byId = new Map(results.filter(Boolean).map((r) => [r.id, r]));
    setSources((prev) => prev.map((s) => (byId.has(s.id) ? { ...s, ...byId.get(s.id) } : s)));
    setBlurringAll(false);
    if (blurred && !missed) notify(`Blurred ${blurred} face${blurred === 1 ? '' : 's'} ✨`, 'success');
    else if (blurred) notify(`Blurred ${blurred}; ${missed} still had no detectable face — click those to blur by hand`, 'error');
    else notify('No faces detected — click a photo to blur by hand', 'error');
  }, [sources, notify]);

  // Apply a hand-drawn blur box from the modal and mark that source blurred.
  const applyManualBlur = useCallback((id, newDataUrl) => {
    setSources((prev) => prev.map((s) => (s.id === id ? { ...s, dataUrl: newDataUrl, blurred: true } : s)));
    setManualBlurId(null);
    notify('Face blurred by hand ✨', 'success');
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

  useEffect(() => {
    const pending = consumeSourceHandoff('photoMatchSeedream');
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
    const incoming = items.map((it, i) => ({ id: `s-${Date.now()}-${i}`, dataUrl: it.dataUrl }));
    setSources((prev) => {
      if (mode === 'replace' || !prev.length) return incoming;
      // Deduped on the image itself: sending the same pin twice must not queue it twice.
      const have = new Set(prev.map((x) => x.dataUrl));
      return [...prev, ...incoming.filter((x) => !have.has(x.dataUrl))];
    });
    notify(`${items.length} source${items.length > 1 ? 's' : ''} ${mode === 'replace' ? 'loaded' : 'added'} ⚡`, 'success');
  }, [notify]);

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
  const runOne = async (source, charRefs, ratio, prompt) => {
    const jobId = source.id;
    const feedId = `photomatch-sd-${jobId}`;
    pushPending({ id: feedId, prompt: 'Photo Match (Seedream)', imageModel: 'Seedream 5.0 Pro Edit', aspectRatio: ratio, resolutionTier: resolution });
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: 'running' } : j)));

    try {
      const sourceImg = parseDataUrl(source.dataUrl);
      if (!sourceImg) throw new Error('Could not read the source photo');

      const data = await withRateLimitRetry(() => seedreamApi.edit({
        images: [...charRefs, sourceImg],
        prompt,
        aspectRatio: ratio,
        resolution,
        // Omitted entirely on the Seedream path so that request stays byte-identical to what it
        // was before this switch existed.
        ...(engine === 'nano2' ? { model: 'nano2' } : {}),
        // Her name travels with the generation so "Recover missing" can file a stranded Photo
        // Match picture into the right folder, exactly as it does for Eddy's.
        tags: charName.trim() ? ['eddy', charName.trim()] : ['eddy'],
      }, engine === 'nano2' ? { timeoutMs: NANO2_CLIENT_TIMEOUT_MS } : undefined));

      const first = (data.images || [])[0];
      if (!first) throw new Error(`${engine === 'nano2' ? 'Nano Banana 2' : 'Seedream'} returned no image`);

      resolvePending(feedId, {
        galleryId: first.galleryId,
        imageId: first.imageId,
        prompt: engine === 'nano2' ? 'Photo Match (Nano Banana 2)' : 'Photo Match (Seedream)',
        imageModel: engine === 'nano2' ? 'Nano Banana 2 (WaveSpeed)' : 'Seedream 5.0 Pro Edit',
        aspectRatio: ratio,
        resolutionTier: resolution,
        mimeType: first.mimeType,
        generatedAt: Date.now(),
      });
      // galleryId and the collection it was filed into travel with the job: the results panel below
      // moves pictures between Library and Base Library, and it cannot find a row without them.
      // A small JPEG of the source, so the before/after slider still works after a reload. Awaited
      // before the tile flips to done so the persisted row is complete the first time it is written.
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
          engine,
          resolution,
          mode: exactRecreate ? 'exact' : 'scene',
          faceless,
        }
        : j)));
      setSessionSpend((s) => s + costPerJob);

      /**
       * INTO EDDY'S LIBRARY, under her name -- the same place, and the same shape, a generation from
       * the Eddy tab lands in.
       *
       * Stored as a URL rather than bytes, exactly as Eddy does it: the server already holds the
       * file, and copying megabytes into IndexedDB per image is what that choice exists to avoid.
       *
       * NOT swallowed. Eddy had this same call inside its own catch, which is why a filing miss was
       * invisible AND silent for a day. A miss here reaches the handler below, which keeps the image
       * and says so.
       */
      if (first.galleryId) {
        const who = charName.trim();
        // Whichever collection was chosen before the run. Her folder is created in THAT collection —
        // the two are separate databases, so a "Grace" folder in one says nothing about the other.
        const dest = (await destStore.ensureFolder(who || 'Photo Match'))?.id || null;
        const filed = await destStore.addItems([{
          url: galleryApi.imageUrl(first.galleryId),
          prompt: `Photo Match - ${who || 'no character'}`,
          name: `photomatch-${Date.now()}`,
        }], dest);
        // addItems reports a storage failure by RETURNING an empty array rather than throwing.
        if (!Array.isArray(filed) || filed.length === 0) {
          throw new Error(`Browser storage is full - the picture is in the gallery but not in ${destLabel}`);
        }
      }
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

  const handleMatch = async () => {
    if (!sources.length) { notify('Add at least one source photo', 'error'); return; }
    if (!characterIds.length) { notify('Pick the character whose identity to use', 'error'); return; }

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
        const dataUrl = charThumbs[r.id] || await charStore.getImage(r.id);
        const img = dataUrl ? parseDataUrl(dataUrl) : null;
        if (img) refs.push(img);
      }
      const name = chars.find((c) => c.id === cid)?.name || '';
      if (refs.length) perChar.push({ id: cid, name, refs });
      else unloadable.push(name || cid);
    }
    if (!perChar.length) { notify('No character identity images could be loaded — add a primary image to this character', 'error'); return; }
    if (unloadable.length) notify(`Skipped ${unloadable.join(', ')} — no identity image could be loaded`, 'error');

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
    const promptFor = (who, refCount) => {
      const base = buildMatchInstruction({
        characterName: who.name,
        wantsNude,
        addGenericNudeLine,
        sourceFaceBlurred: blurSource,
        faceless,
        outfitFromChar,
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
      // Per engine: Seedream's cap is real and fatal, Nano's does not exist. Trimming a Nano prompt
      // to Seedream's limit threw away chips for nothing.
      const budget = engine === 'nano2' ? NANO2_PROMPT_BUDGET : SEEDREAM_PROMPT_BUDGET;
      if (out.length > budget) {
        // Seedream 422s on an over-long prompt and the whole batch dies. The base instruction
        // is what makes identity work, so the extra text is what gives.
        out = out.slice(0, budget);
        trimmed = true;
      }
      return out;
    };

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
    if (trimmed) notify(`Instructions trimmed to ${engine === 'nano2' ? NANO2_PROMPT_BUDGET : SEEDREAM_PROMPT_BUDGET} characters — the model rejects longer prompts`, 'error');

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
      charName: who.name || '',
    }));
    setJobs((prev) => [...fresh, ...prev]);
    runIdsRef.current = runIds;

    // Simple concurrency pool — each job holds an HTTP request while Muapi renders.
    const queue = [...work];
    const lanes = LANES[engine] || LANES.seedream;
    const workers = Array.from({ length: Math.min(lanes, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        await runOne({ ...item.src, id: `${item.src.id}::${item.who.id}::${runStamp}` },
          item.who.refs, ratioById.get(item.src.id), promptFor(item.who, item.who.refs.length));
      }
    });
    await Promise.all(workers);
    setRunning(false);
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

          <div
            className={cn('rounded-xl border-2 border-dashed p-3 transition-colors', dragging ? 'border-rose-500 bg-rose-500/[0.06]' : 'border-zinc-800/60')}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); addSources(e.dataTransfer.files); }}
          >
            {sources.length ? (
              <div className="grid [grid-template-columns:repeat(auto-fill,minmax(90px,1fr))] gap-2">
                {sources.map((s) => (
                  <div key={s.id} className="relative group">
                    {/* Click the photo to blur a region by hand — the fallback for a face the
                        detector missed. The amber ring flags exactly those un-blurred photos. */}
                    <button type="button" onClick={() => setManualBlurId(s.id)} title="Click to blur a region by hand"
                      className={cn('block w-full rounded-lg border overflow-hidden cursor-pointer',
                        blurSource && !s.blurred ? 'border-amber-500/70 ring-1 ring-amber-500/40' : 'border-zinc-800/60')}>
                      <img src={s.dataUrl} alt="" className="w-full aspect-[3/4] object-cover bg-zinc-950" />
                    </button>
                    {blurSource && (
                      s.blurred
                        ? <span className="absolute bottom-1 left-1 rounded bg-emerald-600/90 px-1.5 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wide text-white pointer-events-none">Blurred</span>
                        : <span className="absolute bottom-1 left-1 rounded bg-amber-600/90 px-1.5 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wide text-white pointer-events-none">Face — tap</span>
                    )}
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
                    const mine = charItems.filter((i) => i.folderId === c.id);
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
                        </span>
                      </button>
                    );
                  })}
                </div>
              {characterId && (
                <p className="text-[0.625rem] text-zinc-600 leading-relaxed">
                  {characterIds.length > 1
                    ? <>Each source photo is generated once per character — {characterIds.length} runs of every photo. Each run sends that character&rsquo;s own photos first, then the source.</>
                    : <>Sends all {charImagesUsed} of {charName || 'this character'}&rsquo;s photo{charImagesUsed === 1 ? '' : 's'} first, then the source photo — Seedream keeps whoever is in image 1, and identity comes only from those.</>}
                  {charImagesUsed === 1 && (
                    <span className="block mt-1 text-yellow-400/90">
                      Only one photo of her is on file. One identity image against the source photo is a weak
                      contest and her face may not carry — add more photos on the Characters page.
                    </span>
                  )}
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
            {[['seedream', 'Seedream 5.0 Pro'], ['nano2', 'Nano Banana 2']].map(([id, label]) => (
              <button key={id} type="button" onClick={() => setEngine(id)} aria-pressed={engine === id}
                className={cn('flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition cursor-pointer',
                  engine === id ? 'bg-rose-500/20 text-rose-300' : 'text-zinc-500 hover:text-zinc-300')}>
                {label}
              </button>
            ))}
          </div>
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

        <Btn onClick={handleMatch} disabled={running} className="w-full">
          {running ? <Spinner size={16} /> : null}
          {running
            ? `Matching… (${runProgress.done}/${runProgress.total})`
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
                <span className="ml-auto flex flex-wrap gap-2">
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
                    {/* WHOSE result this is. With several characters ticked the same source photo
                        appears once per woman, and the thumbnails are identical — without the name
                        the only way to tell them apart is to open each one. */}
                    {job.charName && <span className="text-[0.625rem] font-semibold text-rose-300">{job.charName}</span>}
                    {/* WHOSE result this is. With several characters ticked the same source photo
                        appears once per woman and the thumbnails are identical -- without the name
                        the only way to tell them apart is to open each one. */}
                    {job.charName && <span className="text-[0.625rem] font-semibold text-rose-300">{job.charName}</span>}
                    {job.status === 'done' && <span className="text-[0.625rem] text-zinc-600 font-mono">${costPerJob.toFixed(3)}</span>}
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
                        processedSrc={job.result
                          ? `data:${job.result.mimeType};base64,${job.result.base64Data}`
                          : urlOfJob(job)}
                        originalLabel="SOURCE"
                        processedLabel="MATCHED"
                        className="rounded-lg overflow-hidden border border-zinc-800/60"
                      />
                    ) : (
                      <img src={job.result ? `data:${job.result.mimeType};base64,${job.result.base64Data}` : urlOfJob(job)}
                        alt="" loading="lazy"
                        onClick={(e) => { e.stopPropagation(); setLightboxId(job.id); }}
                        title="Click to see it full size"
                        className="w-full cursor-zoom-in rounded-lg border border-zinc-800/60 bg-zinc-950 object-contain" />
                    )
                  ) : (
                    <div className="relative">
                      <img src={job.thumb} alt="" className={cn('w-full aspect-[3/4] object-cover rounded-lg border border-zinc-800/60 bg-zinc-950', job.status !== 'done' && 'opacity-50')} />
                      {job.status === 'running' && <div className="absolute inset-0 flex items-center justify-center"><Spinner size={22} /></div>}
                    </div>
                  )}

                  {job.status === 'failed' && <p className="text-[0.625rem] text-red-400 leading-snug">{job.error}</p>}
                  {/* Where this one currently lives, so "send to Base" has a visible before and
                      after rather than being an action with no feedback. */}
                  {job.status === 'done' && urlOfJob(job) && (
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[0.5625rem] uppercase tracking-wider text-zinc-600">
                        {job.charName ? `${job.charName} · ` : ''}in {job.filedDb === 'eddy-base' ? 'Base Library' : 'Library'}
                        {/* WHAT MADE IT. Two engines, two modes and a faceless switch produce very
                            different pictures, and a week later the tile is the only record. */}
                        {job.engine && ` · ${job.engine === 'nano2' ? 'Nano 2' : 'Seedream'}`}
                        {job.resolution && ` ${job.resolution}`}
                        {job.mode === 'exact' && ' · exact'}
                        {job.faceless && ' · faceless'}
                      </p>
                      <span className="flex items-center gap-2">
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
        const src = job.result ? `data:${job.result.mimeType};base64,${job.result.base64Data}` : urlOfJob(job);
        const i = lightboxList.findIndex((j) => j.id === lightboxId);
        return createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
            // Backdrop only: a click that started on the picture must not close it when the pointer
            // drifts off, which makes a large view feel broken.
            onClick={(e) => { if (e.target === e.currentTarget) setLightboxId(''); }}
          >
            <img src={src} alt="" draggable={false} onClick={(e) => e.stopPropagation()}
              className="max-h-full max-w-full select-none rounded-xl object-contain" />

            <div className="absolute left-4 top-4 rounded-lg bg-black/70 px-3 py-1.5 text-xs text-zinc-300">
              {job.charName || 'Photo Match'}
              {job.engine && <span className="text-zinc-500"> · {job.engine === 'nano2' ? 'Nano 2' : 'Seedream'}</span>}
              {job.resolution && <span className="text-zinc-500"> {job.resolution}</span>}
              <span className="text-zinc-500"> · {i + 1} of {lightboxList.length}</span>
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
          <ManualBlurModal
            src={sources.find((s) => s.id === manualBlurId).dataUrl}
            onApply={(newDataUrl) => applyManualBlur(manualBlurId, newDataUrl)}
            onClose={() => setManualBlurId(null)}
          />
        )}
      </div>
    </div>
  );
}
