import { useState, useEffect, useCallback, useRef } from 'react';
import { seedream as seedreamApi, gallery as galleryApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import CharacterPicker from '../components/CharacterPicker';
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

const ASPECT_OPTIONS = [{ value: 'auto', label: 'Auto (match source)' }, ...SEEDREAM_ASPECT_RATIOS.map((r) => ({ value: r, label: r }))];
const RES_OPTIONS = SEEDREAM_RESOLUTIONS.map((r) => ({ value: r, label: r }));

// Each job sends exactly one source photo, so the character gets the rest of Seedream's budget.
const MAX_CHAR_IMAGES = SEEDREAM_MAX_IMAGES - 1;
const MAX_SOURCES = 12;
// Keep concurrency low — each job holds an HTTP request while Muapi renders.
const MAX_CONCURRENT_JOBS = 2;
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

function buildMatchInstruction({ characterName, refCount, masterPrompt, exactRecreate, varyBackground, allowExpressionChange, allowHairChange, allowBodyChange, wantsNude, addGenericNudeLine, sourceFaceBlurred }) {
  const who = characterName || 'the character';
  const n = Math.max(1, refCount);
  const refs = n > 1 ? `IMAGES 1-${n}` : 'IMAGE 1';
  const src = `IMAGE ${n + 1}`;

  const scene = [
    'background and location', 'body pose and position', 'hands, fingers and every prop',
    // The outfit is only inherited when she stays dressed. Leaving this in while the prompt
    // also asks for nudity cancels both, and she comes back in the source outfit.
    wantsNude ? null : 'the outfit — same type, colour, cut, fabric and coverage',
    'lighting, shadows and colour grade', 'framing, crop, camera angle and lens perspective',
  ].filter(Boolean);
  if (!allowExpressionChange) scene.push('expression, gaze and head angle');

  const identity = [
    'face, facial structure, eyes, nose, lips and jawline', 'skin tone',
    allowHairChange ? 'hair colour and texture (the style is directed below)' : 'hair colour, length and style',
    'makeup — exactly as shown, including bold or dark lipstick; never neutralised',
    allowBodyChange ? null : 'body shape, figure, curves, height, chest size and cleavage',
  ].filter(Boolean);

  const parts = [
    `${refs} = ${who}. CHARACTER IDENTITY REFERENCE, HIGHEST PRIORITY. ${src} = SOURCE SCENE BLUEPRINT, FORBIDDEN AS AN IDENTITY REFERENCE.`,
    exactRecreate
      ? (wantsNude
        ? `Reproduce ${src} with pixel-perfect fidelity. The permitted changes are that the person is ${who} and that her clothing is removed as instructed below. Same background, pose, props, crop, angle and lighting. A mirror selfie stays the same mirror selfie.`
        : `Reproduce ${src} with pixel-perfect fidelity. The ONLY permitted change is that the person is ${who}. Same background, pose, outfit, props, crop, angle and lighting. A mirror selfie stays the same mirror selfie.`)
      : `Output a new photograph of ${who} — the person in ${refs} — in ${src}'s scene. This is NOT a retouch of ${src}.`,
    `FROM ${refs} (identity, non-negotiable): ${identity.join('; ')}.`,
    `FROM ${src} (scene only): ${scene.join('; ')}.`,
    `NEVER FROM ${src}: face, facial structure, eyes, skin tone, hair, body shape, chest size, tattoos, body ink or any skin marking. That person is an anonymous stand-in — discard her appearance completely. Wherever ${src} and ${refs} disagree, ${refs} win 100%.`,
    `ONE FACE: copy ${who}'s face directly from ${refs}. Never blend, average, merge or split the difference with ${src}'s face. No hybrid. If the output does not look like ${refs}, it is wrong.`,
    // Stated last and in absolute terms: whichever face the model is leaning toward, this is the
    // final word. Naming the source image by index beats a general "keep identity" line.
    ...(sourceFaceBlurred ? [`The face in ${src} is deliberately blurred out because it must not be used. Do NOT reproduce that blur, and do NOT invent a face from it — render ${who}'s face from ${refs} sharply and completely.`] : []),
    `FINAL CHECK — THE FACE: the woman in the output must be recognisably the SAME PERSON as in ${refs}. The face of the woman in ${src} is FORBIDDEN and must not appear, in whole or in part. If you are uncertain which face to use, use ${refs}. ${refs} always win.`,
  ];

  if (allowBodyChange) {
    parts.push(`BODY: her face, skin, hair and makeup still come from ${refs}. Her FIGURE and CHEST SIZE are set by the explicit instruction at the END of this prompt — follow it literally and at full strength. It overrides both ${refs} and ${src}. Do not average it down toward either of them, and do not moderate it toward a "normal" figure. The garment stretches to fit the result; never shrink her to fit the garment.`);
  } else {
    parts.push(`CHEST: ${who}'s chest size and cleavage come from ${refs}. If ${refs} show her body, match it exactly. Never take chest size from ${src}.`);
    // Only meaningful while she is dressed — it describes how a garment sits on her.
    if (!wantsNude) parts.push(`GARMENT FITS HER: the outfit's type, colour and cut come from ${src}, but ${who} is wearing it — it stretches and drapes to fit HER body and chest. Never reshape her to fit the garment. If her chest is larger than ${src}'s person, the fabric pulls tighter and the neckline sits differently: that is correct, not an error.`);
  }

  if (!exactRecreate && varyBackground) {
    parts.push(`BACKGROUND VARIATION: same location, but shift the lighting mood and minor details so it reads as a different moment in the same place. Pose, outfit and framing still match ${src}.`);
  }
  if (addGenericNudeLine) parts.push(NUDE_LINE);
  if (masterPrompt?.trim()) parts.push(`${who} is: ${masterPrompt.trim()}`);
  parts.push(`Photorealistic: real pores, natural hair strands, fabric weave, slight asymmetry. No plastic skin, no CGI look.`);

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
];

// NSFW chips come from the shared module so every page offers the same set.
const ALL_PRESETS = [...PRESETS, ...NSFW_PRESETS];
const PRESET_GROUPS = ['Body', 'Hair', 'Scene', 'Skin', 'Mood', 'Photo'];
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

/** Fetch an in-app image URL and hand it back in the {base64, mimeType} shape the route wants. */
async function urlToImagePayload(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error('Failed to load character image');
  const blob = await resp.blob();
  const dataUrl = await fileToDataUrl(new File([blob], 'char', { type: blob.type || 'image/png' }));
  return parseDataUrl(dataUrl);
}

const _cache = { extra: '', aspectRatio: 'auto', resolution: '1K', exactRecreate: false, varyBackground: false, nsfw: false, blurSource: true };
// Images are too big for _cache/localStorage — IndexedDB so they survive a reload.
const store = createPageStore('kyros-photo-match-seedream-state');

export default function PhotoMatchSeedreamPage() {
  const { notify, characters: chars = [] } = useApp();

  const [sources, setSources] = useState([]);        // batch targets [{id, dataUrl}]
  const [characterId, setCharacterId] = useState(null);
  const [charDetails, setCharDetails] = useState({});

  const [extra, setExtra] = useState(_cache.extra);
  const [exactRecreate, setExactRecreate] = useState(_cache.exactRecreate);
  const [varyBackground, setVaryBackground] = useState(_cache.varyBackground);
  const [nsfw, setNsfw] = useState(_cache.nsfw);
  const [blurSource, setBlurSource] = useState(_cache.blurSource ?? true);
  const blurSourceRef = useRef(blurSource);
  useEffect(() => { blurSourceRef.current = blurSource; }, [blurSource]);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolution, setResolution] = useState(_cache.resolution);

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
        store.get('sources', []), store.get('characterId', null), store.get('extra', ''),
      ]);
      if (cancelled) return;
      // Never clobber: this resolves AFTER the (synchronous) source-handoff effect, so images
      // just sent from Frame Library would otherwise be overwritten by the old saved ones.
      if (Array.isArray(s) && s.length) setSources((cur) => (cur.length ? cur : s));
      if (charId) setCharacterId((cur) => cur ?? charId);
      if (ex) setExtra((cur) => (cur ? cur : ex));
      setRestored(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist only after restore, or the first empty render would wipe the save.
  useEffect(() => { if (restored) store.set('sources', sources); }, [sources, restored]);
  useEffect(() => { if (restored) store.set('characterId', characterId); }, [characterId, restored]);
  useEffect(() => { if (restored) store.set('extra', extra); }, [extra, restored]);

  useEffect(() => { _cache.extra = extra; }, [extra]);
  useEffect(() => { _cache.nsfw = nsfw; }, [nsfw]);
  useEffect(() => { _cache.blurSource = blurSource; }, [blurSource]);
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

  // Pull the full character (with its references) once selected.
  useEffect(() => {
    if (!characterId || charDetails[characterId]) return;
    let cancelled = false;
    charApi.get(characterId)
      .then((d) => { if (!cancelled) setCharDetails((prev) => ({ ...prev, [characterId]: d })); })
      .catch(() => { /* picker still works without detail; refs just won't be added */ });
    return () => { cancelled = true; };
  }, [characterId, charDetails]);

  const charDetail = characterId ? charDetails[characterId] : null;
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
  const primaryCount = Math.max(1, charDetail?.primaryImageCount || 1);
  // Character contributes every primary image + each reference.
  const charImageCount = characterId ? primaryCount + activeRefs.length : 0;
  const charImagesUsed = Math.min(charImageCount, MAX_CHAR_IMAGES);
  const charTruncated = charImageCount > MAX_CHAR_IMAGES;

  const imagesPerJob = 1 + charImagesUsed;
  const costPerJob = seedreamCost(resolution, imagesPerJob);
  const totalCost = costPerJob * Math.max(1, sources.length);

  // ── sources ────────────────────────────────────────────────────────────────
  const addSources = useCallback(async (files) => {
    const room = MAX_SOURCES - sources.length;
    if (room <= 0) { notify(`Maximum ${MAX_SOURCES} source photos`, 'error'); return; }
    const valid = Array.from(files || []).filter((f) => /^image\/(png|jpeg|jpg|webp)$/i.test(f.type)).slice(0, room);
    if (!valid.length) return;
    let missed = 0;
    const added = await Promise.all(valid.map(async (f) => {
      let dataUrl = await fileToDataUrl(f);
      if (blurSourceRef.current) {
        const out = await autoBlurFace(dataUrl);
        dataUrl = out.dataUrl;
        if (!out.blurred) missed += 1;
      }
      return { id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, dataUrl };
    }));
    if (missed) notify(`${missed} photo(s): no face found to blur — identity may drift on those`, 'error');
    setSources((prev) => [...prev, ...added]);
  }, [sources.length, notify]);

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
    setSources(items.map((it, i) => ({ id: `s-${Date.now()}-${i}`, dataUrl: it.dataUrl })));
    notify(`${items.length} source${items.length > 1 ? 's' : ''} loaded ⚡`, 'success');
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

      const data = await seedreamApi.edit({
        images: [...charRefs, sourceImg],
        prompt,
        aspectRatio: ratio,
        resolution,
      });

      const first = (data.images || [])[0];
      if (!first) throw new Error('Seedream returned no image');

      resolvePending(feedId, {
        galleryId: first.galleryId,
        imageId: first.imageId,
        prompt: 'Photo Match (Seedream)',
        imageModel: 'Seedream 5.0 Pro Edit',
        aspectRatio: ratio,
        resolutionTier: resolution,
        mimeType: first.mimeType,
        generatedAt: Date.now(),
      });
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: 'done', result: first } : j)));
      setSessionSpend((s) => s + costPerJob);
    } catch (err) {
      rejectPending(feedId);
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: 'failed', error: err.message || 'Match failed' } : j)));
    }
  };

  const handleMatch = async () => {
    if (!sources.length) { notify('Add at least one source photo', 'error'); return; }
    if (!characterId) { notify('Pick the character whose identity to use', 'error'); return; }

    // Without identity images Seedream can only fall back on the source photo's face — the exact
    // failure this page exists to prevent. Fail loudly instead of quietly producing the stand-in.
    const urls = [
      ...Array.from({ length: primaryCount }, (_, i) => charApi.primaryImageUrl(characterId, i)),
      ...activeRefs.map((r) => charApi.refImageUrl(characterId, r.id)),
    ];
    const charRefs = [];
    for (const url of urls.slice(0, MAX_CHAR_IMAGES)) {
      try {
        const img = await urlToImagePayload(url);
        if (img) charRefs.push(img);
      } catch { /* one missing reference shouldn't kill the batch */ }
    }
    if (!charRefs.length) { notify('No character identity images could be loaded — add a primary image to this character', 'error'); return; }

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

    const { wantsNude, addGenericNudeLine } = nudeState({ nsfw, instruction: extra });
    const prompt = buildMatchInstruction({
      characterName: charName,
      wantsNude,
      addGenericNudeLine,
      sourceFaceBlurred: blurSource,
      refCount: charRefs.length,
      masterPrompt: charDetail?.masterPrompt,
      exactRecreate,
      varyBackground,
      allowExpressionChange,
      allowHairChange,
      allowBodyChange,
    });
    let finalPrompt = extra.trim() ? `${prompt}\n\n${extra.trim()}` : prompt;
    if (finalPrompt.length > SEEDREAM_PROMPT_BUDGET) {
      // Seedream 422s on an over-long prompt and the whole batch dies. The base instruction is
      // what makes identity work, so the extra text is what gives.
      finalPrompt = finalPrompt.slice(0, SEEDREAM_PROMPT_BUDGET);
      notify(`Instructions trimmed to ${SEEDREAM_PROMPT_BUDGET} characters — Seedream rejects longer prompts`, 'error');
    }

    // Resolve 'auto' per source — each photo has its own ratio — before pushPending and before
    // the call. Seedream 422s on the literal string 'auto'.
    const ratios = aspectRatio === 'auto'
      ? await Promise.all(sources.map((s) => detectAspectRatio(s.dataUrl, SEEDREAM_ASPECT_RATIOS)))
      : sources.map(() => aspectRatio);
    const ratioById = new Map(sources.map((s, i) => [s.id, ratios[i]]));

    setRunning(true);
    setJobs(sources.map((s) => ({ id: s.id, thumb: s.dataUrl, status: 'queued', result: null, error: null })));

    // Simple concurrency pool — each job holds an HTTP request while Muapi renders.
    const queue = [...sources];
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_JOBS, queue.length) }, async () => {
      while (queue.length) {
        const source = queue.shift();
        if (!source) return;
        await runOne(source, charRefs, ratioById.get(source.id), finalPrompt);
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
                  <div key={s.id} className="relative">
                    <img src={s.dataUrl} alt="" className="w-full aspect-[3/4] object-cover rounded-lg border border-zinc-800/60 bg-zinc-950" />
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
              {characterId && charImagesUsed > 0 && <Badge color="green">{charImagesUsed} identity ref{charImagesUsed > 1 ? 's' : ''}</Badge>}
              {characterId && (
                <button onClick={() => setCharacterId(null)} className="text-[0.6875rem] text-zinc-500 hover:text-zinc-300 transition cursor-pointer underline">Clear</button>
              )}
            </div>
          </div>

          {chars.length === 0 ? (
            <p className="text-xs text-zinc-600">No characters yet — create one on the Characters page.</p>
          ) : (
            <>
              <CharacterPicker
                chars={chars}
                selectedIds={characterId ? [characterId] : []}
                onToggle={(id) => setCharacterId((prev) => (prev === id ? null : id))}
                charDetails={charDetails}
                label="Whose face goes into the photo"
                maxHeight="max-h-44"
              />
              {characterId && (
                <p className="text-[0.625rem] text-zinc-600 leading-relaxed">
                  Sends all {charImagesUsed} of {charName || 'this character'}'s photo{charImagesUsed === 1 ? '' : 's'} first, then the source photo — Seedream keeps whoever is in image 1, and identity comes only from those.
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
          </div>
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
          <p className="text-[0.625rem] text-zinc-600">
            {imagesPerJob} image{imagesPerJob > 1 ? 's' : ''} per match → <span className="text-zinc-400 font-mono">${costPerJob.toFixed(3)}</span> each
            {sources.length > 1 && <> · {sources.length} photos → <span className="text-zinc-400 font-mono">${totalCost.toFixed(3)}</span> total</>}
            {aspectRatio === 'auto' && <> · Auto snaps each photo to its closest Seedream ratio</>}
          </p>
        </Card>

        <Btn onClick={handleMatch} disabled={running} className="w-full">
          {running ? <Spinner size={16} /> : null}
          {running
            ? `Matching… (${doneJobs.length}/${jobs.length})`
            : `Photo Match${sources.length > 1 ? ` · ${sources.length} photos` : ''} · $${totalCost.toFixed(3)}`}
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
    </div>
  );
}
