import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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

export function buildMatchInstruction({ characterName, refCount, masterPrompt, exactRecreate, varyBackground, allowExpressionChange, allowHairChange, allowBodyChange, allowLightingChange, faceless, wantsNude, addGenericNudeLine, sourceFaceBlurred }) {
  const who = characterName || 'the character';
  const n = Math.max(1, refCount);
  const refs = n > 1 ? `images 1-${n}` : 'image 1';
  const src = `image ${n + 1}`;

  // Identity comes from the refs. Each allow* flag drops its clause so a preset that overrides
  // that attribute (hair/body) doesn't fight the base prompt. Hair/body default ON = from refs.
  // When faceless, the face is intentionally hidden — don't ask the model to match it here (the
  // final lock handles the faceless case), but skin/hair/body still come from the refs.
  const identity = [
    faceless ? 'skin tone' : 'face, skin tone, her makeup',
    allowHairChange ? null : 'hair',
    allowBodyChange ? null : 'body/figure/chest',
  ].filter(Boolean).join(', ');

  // Scene comes from the source. Outfit only when dressed; expression only when no Mood preset
  // has taken it over (else the two cancel); lighting only when no Lighting preset overrides it.
  // 'framing/camera' is pulled OUT into its own emphasised line below — folded into this list it
  // was one word among eight and the model re-framed to a stock portrait anyway.
  const scene = [
    'background', 'pose', 'hands/props',
    wantsNude ? null : 'outfit',
    allowExpressionChange ? null : 'expression',
    allowLightingChange ? null : 'lighting',
  ].filter(Boolean).join(', ');

  const parts = [
    // Roles by image index, stated up front and hard.
    `${refs} = ${who} = the ONLY face/body source. ${src} = scene only — NEVER an identity reference.`,
    exactRecreate
      ? `Reproduce ${src} exactly — same background, pose, props, framing, lighting${wantsNude ? '' : ', outfit'} — changing only the person to ${who}${wantsNude ? ', and remove her clothing as instructed below' : ''}.`
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
  parts.push(`FORBIDDEN from ${src}: its face, facial structure, eyes, nose, mouth, jaw, hair colour, skin tone${allowBodyChange ? '' : ', body shape'}, and any tattoo, ink or skin marking. ${who} has only the tattoos visible in ${refs}.`);
  parts.push(`NO BLENDING: do not mix, merge or average ${who}'s face with the person in ${src}. The output face is 100% ${refs}, not a midpoint between the two.`);

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
      `FINAL — HIGHEST PRIORITY, overrides everything above: the face, skin and hair in the output MUST be recognisably ${refs}. ${src}'s face is an anonymous stand-in — discard it completely; if in any doubt, copy ${refs}. Sacrifice ${src}'s likeness entirely to keep hers.`,
      // Body/chest: pinned to the refs UNLESS a size chip is driving it (then the chip, appended
      // after this whole prompt, wins and re-pinning here would fight it).
      allowBodyChange
        ? null
        : (wantsNude
          ? `Her body, figure and chest come from ${refs} at their true size — never averaged or shrunk toward ${src}.`
          : `Her body, figure and chest come from ${refs} at their true size; the ${src} outfit stretches to fit HER — a tighter pull from a larger chest is correct, not an error.`),
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
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: 'done', result: first } : j)));
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
      if (out.length > SEEDREAM_PROMPT_BUDGET) {
        // Seedream 422s on an over-long prompt and the whole batch dies. The base instruction
        // is what makes identity work, so the extra text is what gives.
        out = out.slice(0, SEEDREAM_PROMPT_BUDGET);
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
    if (trimmed) notify(`Instructions trimmed to ${SEEDREAM_PROMPT_BUDGET} characters — Seedream rejects longer prompts`, 'error');

    setRunning(true);
    setJobs(work.map(({ src, who }) => ({
      id: `${src.id}::${who.id}`, thumb: src.dataUrl, status: 'queued', result: null, error: null,
      // Shown on the tile so a mixed batch says WHOSE result each one is.
      charName: perChar.length > 1 ? who.name : '',
    })));

    // Simple concurrency pool — each job holds an HTTP request while Muapi renders.
    const queue = [...work];
    const lanes = LANES[engine] || LANES.seedream;
    const workers = Array.from({ length: Math.min(lanes, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        await runOne({ ...item.src, id: `${item.src.id}::${item.who.id}` },
          item.who.refs, ratioById.get(item.src.id), promptFor(item.who, item.who.refs.length));
      }
    });
    await Promise.all(workers);
    setRunning(false);
    // Report what actually happened. This said "Batch finished" unconditionally, so a run where
    // every job 422'd still looked like a success and the failures were invisible.
    setJobs((prev) => {
      const failed = prev.filter((j) => j.status === 'failed');
      const done = prev.filter((j) => j.status === 'done').length;
      if (!failed.length) notify(`Batch finished — ${done} image${done === 1 ? '' : 's'} ✨`, 'success');
      else if (!done) notify(`All ${failed.length} failed: ${failed[0].error || 'unknown error'}`, 'error');
      else notify(`${done} done, ${failed.length} failed: ${failed[0].error || 'unknown error'}`, 'error');
      return prev;
    });
  };

  const doneJobs = jobs.filter((j) => j.status === 'done');

  return (
    <div className="space-y-6 animate-in">
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
                  : 'Scene, pose, outfit and framing are preserved from each source photo; only the identity is replaced.')}
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
            ? `Matching… (${doneJobs.length}/${jobs.length})`
            : `Photo Match${runCount > 1 ? ` · ${runCount} images` : ''} · $${totalCost.toFixed(3)}`}
        </Btn>

        {/* Results */}
        {jobs.length > 0 && (
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
                Results <span className="text-zinc-600 font-normal normal-case">({doneJobs.length}/{jobs.length})</span>
              </h3>
              {!running && <button onClick={() => setJobs([])} className="text-[0.6875rem] text-zinc-500 hover:text-zinc-300 transition cursor-pointer underline">Clear</button>}
            </div>

            <div className="grid [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {jobs.map((job) => (
                <div key={job.id} className="rounded-xl border border-zinc-800/60 bg-white/[0.02] p-2.5 space-y-2">
                  <div className="flex items-center justify-between gap-2">
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

                  {job.status === 'done' && job.result ? (
                    <CompareSlider
                      originalSrc={job.thumb}
                      processedSrc={`data:${job.result.mimeType};base64,${job.result.base64Data}`}
                      originalLabel="SOURCE"
                      processedLabel="MATCHED"
                      className="rounded-lg overflow-hidden border border-zinc-800/60"
                    />
                  ) : (
                    <div className="relative">
                      <img src={job.thumb} alt="" className={cn('w-full aspect-[3/4] object-cover rounded-lg border border-zinc-800/60 bg-zinc-950', job.status !== 'done' && 'opacity-50')} />
                      {job.status === 'running' && <div className="absolute inset-0 flex items-center justify-center"><Spinner size={22} /></div>}
                    </div>
                  )}

                  {job.status === 'failed' && <p className="text-[0.625rem] text-red-400 leading-snug">{job.error}</p>}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {manualBlurId && sources.some((s) => s.id === manualBlurId) && (
        <ManualBlurModal
          src={sources.find((s) => s.id === manualBlurId).dataUrl}
          onApply={(newDataUrl) => applyManualBlur(manualBlurId, newDataUrl)}
          onClose={() => setManualBlurId(null)}
        />
      )}
    </div>
  );
}
