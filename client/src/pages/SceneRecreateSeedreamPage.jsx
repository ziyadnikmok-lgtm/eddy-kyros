import { useState, useEffect, useCallback, useRef } from 'react';
import { seedream as seedreamApi, gallery as galleryApi, characters as charApi, scene as sceneApi } from '../services/api';
import { useApp } from '../context/AppContext';
import CharacterPicker from '../components/CharacterPicker';
import { Card, Btn, Select, Textarea, Toggle, Badge, Spinner, CopyBtn } from '../components/UI';
import CompareSlider from '../components/CompareSlider';
import { autoBlurFace } from '../lib/autoBlurFace';
import ManualBlurModal from '../components/BlurByHand';
import { SEEDREAM_ASPECT_RATIOS, SEEDREAM_RESOLUTIONS, SEEDREAM_MAX_IMAGES, seedreamCost } from '../config/photoModes';
import { pushPending, resolvePending, failPending } from '../lib/generationFeed';
import { consumeSourceHandoff } from '../lib/sourceHandoff';
import { detectAspectRatio } from '../lib/detectAspectRatio';
import { createPageStore } from '../lib/pageStateStore';
import { cn } from '../lib/utils';

const ASPECT_OPTIONS = [{ value: 'auto', label: 'Auto (match source)' }, ...SEEDREAM_ASPECT_RATIOS.map((r) => ({ value: r, label: r }))];
const RES_OPTIONS = SEEDREAM_RESOLUTIONS.map((r) => ({ value: r, label: r }));

// Each job sends exactly one source photo, so the character gets the rest of Seedream's budget.
const MAX_CHAR_IMAGES = SEEDREAM_MAX_IMAGES - 1;
const MAX_SOURCES = 12;
// Keep concurrency low — each job holds an HTTP request while Muapi renders.
const MAX_CONCURRENT_JOBS = 2;
const SPEND_KEY = 'kyros.sceneRecreateSeedream.sessionSpend';

// Seedream enforces an undocumented prompt-length cap ("The text length cannot exceed the
// maximum limit" — a 422 that kills the whole batch). Measured ceiling is ByteDance's and
// invisible; keep the instruction tight and trim the user's extra text before it blows past.
// This is Photo Match's exact budget and guard — the same 422 kills this route too.
const SEEDREAM_PROMPT_BUDGET = 3000;

// Photo Match reproduces the source exactly. Scene Recreate keeps the CHARACTER and the POSE
// but lets the user REMIX the scene (background, outfit, lighting, setting). So the identity
// rules are Photo Match's verbatim — the person is still image 1, never the source — but the
// scene is declared REMIXABLE and defaults to the source only when nothing is asked to change.
// Gemini's scene analysis (environment/lighting/pose/…) flattened to one line for Seedream.
function sceneDataToText(d) {
  if (!d || typeof d !== 'object') return '';
  const order = ['environment', 'pose', 'outfit', 'lighting', 'camera', 'composition', 'mood', 'expression', 'format'];
  // 'format' (e.g. 'iPhone photo, casual handheld selfie') is what makes the output read as a
  // real selfie rather than a studio shot — worth keeping.
  const label = { environment: 'Setting', pose: 'Pose', outfit: 'Outfit', lighting: 'Lighting', camera: 'Camera', composition: 'Composition', mood: 'Mood', expression: 'Expression', format: 'Shot on' };
  return order.filter((k) => d[k]).map((k) => `${label[k]}: ${String(d[k]).trim()}`).join('. ');
}

// AI-READ mode. Gemini turned the reference into text (sceneText), so the reference IMAGE is
// NEVER sent to Seedream — only the character images are. That makes identity bleed impossible:
// there is no stand-in face to leak. The scene lives entirely in words.
function buildAiSceneInstruction({ characterName, refCount, masterPrompt, sceneText, sceneChanges, allowExpressionChange, allowHairChange, allowBodyChange }) {
  const who = characterName || 'the character';
  const n = Math.max(1, refCount);
  const refs = n > 1 ? `IMAGES 1-${n}` : 'IMAGE 1';
  const identity = [
    'face, facial structure, eyes, nose, lips and jawline', 'skin tone',
    allowHairChange ? 'hair colour and texture (the style is directed below)' : 'hair colour, length and style',
    'makeup as shown',
    allowBodyChange ? null : 'body shape, figure, curves, height, chest size and cleavage',
  ].filter(Boolean);

  const parts = [
    `${refs} = ${who}, and ${refs} ${n > 1 ? 'are' : 'is'} the ONLY identity reference — her face, body and likeness come entirely from ${refs}.`,
    `Generate a NEW photorealistic photograph of ${who} in this scene — ${sceneText || 'a natural, flattering setting'}${allowExpressionChange ? '' : ''}.`,
    `IDENTITY (from ${refs}, non-negotiable): ${identity.join('; ')}. The output must clearly look like ${refs}.`,
  ];
  if (allowBodyChange) parts.push(`BODY: her figure and CHEST SIZE are set by the instruction at the END of this prompt — follow it literally and at full strength.`);
  else parts.push(`CHEST: ${who}'s chest size and cleavage come from ${refs}; match them exactly and never shrink. Any outfit stretches to fit HER body.`);
  if (sceneChanges?.trim()) parts.push(`SCENE CHANGES (highest priority — apply these): ${sceneChanges.trim()}`);
  if (masterPrompt?.trim()) parts.push(`${who} is: ${masterPrompt.trim()}`);
  parts.push('Photorealistic: real pores, natural hair strands, fabric weave, slight asymmetry. No plastic skin, no CGI look.');
  return parts.join('\n\n');
}

function buildSceneInstruction({ characterName, refCount, masterPrompt, sceneChanges, allowExpressionChange, allowHairChange, allowBodyChange }) {
  const who = characterName || 'the character';
  const n = Math.max(1, refCount);
  const refs = n > 1 ? `IMAGES 1-${n}` : 'IMAGE 1';
  const src = `IMAGE ${n + 1}`;

  // Carried from the source unless a scene change overrides it.
  const keep = ['body pose, stance and gesture', 'framing, crop, camera angle and lens perspective'];
  if (!allowExpressionChange) keep.push('expression, gaze and head angle');

  const identity = [
    'face, facial structure, eyes, nose, lips and jawline', 'skin tone',
    allowHairChange ? 'hair colour and texture (the style is directed below)' : 'hair colour, length and style',
    'makeup — exactly as shown, including bold or dark lipstick; never neutralised',
    allowBodyChange ? null : 'body shape, figure, curves, height, chest size and cleavage',
  ].filter(Boolean);

  const parts = [
    `${refs} = ${who}. CHARACTER IDENTITY REFERENCE, HIGHEST PRIORITY. ${src} = SOURCE SCENE, used only for pose and composition — FORBIDDEN AS AN IDENTITY REFERENCE.`,
    `Output a new photograph of ${who} — the person in ${refs} — holding ${src}'s pose, then remix the scene as directed below. This is NOT a retouch of ${src}.`,
    `FROM ${refs} (identity, non-negotiable): ${identity.join('; ')}.`,
    `FROM ${src} (keep unless a scene change overrides it): ${keep.join('; ')}.`,
    `SCENE (remixable): by default the background, location, outfit, lighting and colour grade come from ${src}. Change ONLY what the scene changes below ask for and keep everything else consistent with ${src}; if no scene change is given, keep ${src}'s scene as it is.`,
    `NEVER FROM ${src}: face, facial structure, eyes, skin tone, hair, body shape, chest size, tattoos, body ink or any skin marking. That person is an anonymous stand-in — discard her appearance completely. Wherever ${src} and ${refs} disagree, ${refs} win 100%.`,
    `ONE FACE: copy ${who}'s face directly from ${refs}. Never blend, average, merge or split the difference with ${src}'s face. No hybrid. If the output does not look like ${refs}, it is wrong.`,
  ];

  if (allowBodyChange) {
    parts.push(`BODY: her face, skin, hair and makeup still come from ${refs}. Her FIGURE and CHEST SIZE are set by the explicit instruction at the END of this prompt — follow it literally and at full strength. It overrides both ${refs} and ${src}. Do not average it down toward either of them.`);
  } else {
    parts.push(`CHEST: ${who}'s chest size and cleavage come from ${refs}. If ${refs} show her body, match it exactly. Never take chest size from ${src}. Any outfit stretches and drapes to fit HER body; never reshape her to fit a garment.`);
  }

  if (sceneChanges?.trim()) parts.push(`SCENE CHANGES (highest creative priority — apply these): ${sceneChanges.trim()}`);
  if (masterPrompt?.trim()) parts.push(`${who} is: ${masterPrompt.trim()}`);
  parts.push('Photorealistic: real pores, natural hair strands, fabric weave, slight asymmetry. No plastic skin, no CGI look.');

  return parts.join('\n\n');
}

// Grouped so the row stays scannable. Scene chips append to the Scene Changes box (the star
// input); every other group appends to the Fine-tune box, exactly like Photo Match. Each chip
// says only what it CHANGES — the base instruction already states what is preserved, so
// repeating "keep her face and pose" in every chip just burns prompt budget.
//
// Flags matter: a chip that changes something the base prompt pins must set its flag, or the
// two cancel and the model does neither. Only Body/Hair/Mood chips carry flags; Scene chips
// don't, because the base already declares the scene remixable.
const PRESETS = [
  { group: 'Scene', label: 'New background: bedroom', text: 'Replace the background with a luxury bedroom — soft bedding, warm bedside lamplight and tasteful modern decor.' },
  { group: 'Scene', label: 'New background: beach', text: 'Replace the background with a sunny beach — golden sand, blue sea and bright natural daylight.' },
  { group: 'Scene', label: 'New background: city night', text: 'Replace the background with a neon-lit city street at night, soft bokeh lights behind her.' },
  { group: 'Scene', label: 'Change outfit', text: 'Change her outfit to a different flattering outfit that suits the new scene. Do not copy the source outfit.' },
  { group: 'Scene', label: 'Studio lighting', text: 'Relight the scene as a clean studio portrait — soft key light, gentle fill and a seamless backdrop.' },
  { group: 'Scene', label: 'Golden hour', text: 'Relight the scene with warm golden-hour sunlight, long soft shadows and a warm colour grade.' },
  { group: 'Scene', label: 'Keep the exact pose', text: 'Keep her body pose, stance and gesture exactly as in the source photo.' },
  { group: 'Scene', label: 'Keep the outfit', text: 'Keep the outfit from the source photo — same type, colour, cut, fabric and coverage.' },
  { group: 'Scene', label: 'Keep the background', text: 'Keep the background and location from the source photo unchanged.' },

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

const SCENE_GROUP = 'Scene';
const FINE_TUNE_GROUPS = ['Body', 'Hair', 'Skin', 'Mood', 'Photo'];

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

// blurSource defaults OFF here (unlike Photo Match): this page never sends the source photo to
// the image generator at all -- Seedream only ever gets the character refs + Gemini's TEXT scene
// description (see runOne below), so the identity-leak risk blur protects against elsewhere
// literally cannot happen on this page. Blurring only cost Gemini's pose/scene read accuracy for
// no real benefit, so it's opt-in here instead of opt-out (owner, 2026-08-05).
const _cache = { sceneChanges: '', extra: '', aspectRatio: 'auto', resolution: '1K', aiReadScene: true, blurSource: false };
// Images are too big for _cache/localStorage — IndexedDB so they survive a reload.
const store = createPageStore('kyros-scene-recreate-seedream-state');

export default function SceneRecreateSeedreamPage() {
  const { notify, characters: chars = [] } = useApp();

  const [sources, setSources] = useState([]);        // batch targets [{id, dataUrl}]
  const [characterId, setCharacterId] = useState(null);
  const [charDetails, setCharDetails] = useState({});

  const [sceneChanges, setSceneChanges] = useState(_cache.sceneChanges);
  const [extra, setExtra] = useState(_cache.extra);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolution, setResolution] = useState(_cache.resolution);
  // AI-read: Gemini describes the reference to text so Seedream never sees the source person.
  const [aiReadScene, setAiReadScene] = useState(_cache.aiReadScene);
  // Even in AI-read mode, Gemini's VISION call still receives the real source photo to write
  // its scene description from -- blurring is about that input, not about Seedream (which never
  // gets the source at all, see runOne below). Same toggle/detect/manual-blur pattern as Photo
  // Match, minus the "don't reproduce the blur" prompt line -- nothing downstream ever renders
  // this image, so there's no generator that could copy the blur box.
  const [blurSource, setBlurSource] = useState(_cache.blurSource ?? true);
  const blurSourceRef = useRef(blurSource);
  useEffect(() => { blurSourceRef.current = blurSource; }, [blurSource]);
  const [blurringAll, setBlurringAll] = useState(false);
  const [manualBlurId, setManualBlurId] = useState(null);  // source id being hand-blurred, or null

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
      const [s, charId, sc, ex] = await Promise.all([
        store.get('sources', []), store.get('characterId', null),
        store.get('sceneChanges', ''), store.get('extra', ''),
      ]);
      if (cancelled) return;
      // Never clobber: this resolves AFTER the (synchronous) source-handoff effect, so images
      // just sent from Frame Library would otherwise be overwritten by the old saved ones.
      if (Array.isArray(s) && s.length) setSources((cur) => (cur.length ? cur : s));
      if (charId) setCharacterId((cur) => cur ?? charId);
      if (sc) setSceneChanges((cur) => (cur ? cur : sc));
      if (ex) setExtra((cur) => (cur ? cur : ex));
      setRestored(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist only after restore, or the first empty render would wipe the save.
  useEffect(() => { if (restored) store.set('sources', sources); }, [sources, restored]);
  useEffect(() => { if (restored) store.set('characterId', characterId); }, [characterId, restored]);
  useEffect(() => { if (restored) store.set('sceneChanges', sceneChanges); }, [sceneChanges, restored]);
  useEffect(() => { if (restored) store.set('extra', extra); }, [extra, restored]);

  useEffect(() => { _cache.sceneChanges = sceneChanges; }, [sceneChanges]);
  useEffect(() => { _cache.extra = extra; }, [extra]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolution = resolution; }, [resolution]);
  useEffect(() => { _cache.aiReadScene = aiReadScene; }, [aiReadScene]);
  useEffect(() => { _cache.blurSource = blurSource; }, [blurSource]);
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
  // the character's photos and left just her main image to carry the identity. Keep it unfiltered.
  const activeRefs = charDetail?.references || [];
  // Character contributes its main image + each reference.
  const charImageCount = characterId ? 1 + activeRefs.length : 0;
  const charImagesUsed = Math.min(charImageCount, MAX_CHAR_IMAGES);
  const charTruncated = charImageCount > MAX_CHAR_IMAGES;

  const imagesPerJob = 1 + charImagesUsed;
  const costPerJob = seedreamCost(resolution, imagesPerJob);
  const totalCost = costPerJob * Math.max(1, sources.length);

  // Flags stand down a base rule the user's preset intends to override. Presets live in either
  // box, so test both. A Body/Hair/Mood preset that changes something the base pins must flip
  // its flag, or the two cancel and the model does neither.
  const presetText = `${sceneChanges} ${extra}`;
  const allowExpressionChange = PRESETS.some((preset) => preset.expressionChange && presetText.includes(preset.text));
  const allowHairChange = PRESETS.some((preset) => preset.hairChange && presetText.includes(preset.text));
  const allowBodyChange = PRESETS.some((preset) => preset.bodyChange && presetText.includes(preset.text));

  // Live preview of the exact prompt this run would send. Must reflect the active mode — in
  // AI-read mode the source image is NOT sent and the scene comes from Gemini's description
  // (shown here as a placeholder, since analysis happens per-source at generate time).
  const previewBase = aiReadScene
    ? buildAiSceneInstruction({
        characterName: charName,
        refCount: Math.max(1, charImagesUsed),
        masterPrompt: charDetail?.masterPrompt,
        sceneText: '[Gemini will describe each reference photo here — you never send the source image]',
        sceneChanges,
        allowExpressionChange,
        allowHairChange,
        allowBodyChange,
      })
    : buildSceneInstruction({
        characterName: charName,
        refCount: Math.max(1, charImagesUsed),
        masterPrompt: charDetail?.masterPrompt,
        sceneChanges,
        allowExpressionChange,
        allowHairChange,
        allowBodyChange,
      });
  const previewPrompt = extra.trim() ? `${previewBase}\n\n${extra.trim()}` : previewBase;
  const overBudget = previewPrompt.length > SEEDREAM_PROMPT_BUDGET;

  // ── sources ────────────────────────────────────────────────────────────────
  const addSources = useCallback(async (files) => {
    const room = MAX_SOURCES - sources.length;
    if (room <= 0) { notify(`Maximum ${MAX_SOURCES} source photos`, 'error'); return; }
    const valid = Array.from(files || []).filter((f) => /^image\/(png|jpeg|jpg|webp)$/i.test(f.type)).slice(0, room);
    if (!valid.length) return;
    const added = await Promise.all(valid.map(async (f) => {
      const dataUrl = await fileToDataUrl(f);
      const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      if (!blurSourceRef.current) return { id, dataUrl, blurred: false };
      const out = await autoBlurFace(dataUrl);
      return { id, dataUrl: out.dataUrl, blurred: out.blurred };
    }));
    if (blurSourceRef.current) {
      const missed = added.filter((a) => !a.blurred).length;
      if (missed) notify(`${missed} photo(s): no face found to blur — use "Blur all" or click a photo to blur by hand`, 'error');
    }
    setSources((prev) => [...prev, ...added]);
  }, [sources.length, notify]);

  // Re-run face detection over every source that isn't already blurred, in AGGRESSIVE mode (a
  // stronger pass than the quick one at add-time). Only un-blurred sources are touched, so
  // pressing it twice is safe and it never re-blurs a face that's already gone.
  const blurAllFaces = useCallback(async () => {
    const targets = sources.filter((s) => !s.blurred);
    if (!targets.length) { notify('Every source is already blurred', 'info'); return; }
    setBlurringAll(true);
    let blurred = 0; let missed = 0;
    const updated = await Promise.all(sources.map(async (s) => {
      if (s.blurred) return s;
      const out = await autoBlurFace(s.dataUrl, { aggressive: true });
      if (out.blurred) { blurred += 1; return { ...s, dataUrl: out.dataUrl, blurred: true }; }
      missed += 1;
      return s;
    }));
    setSources(updated);
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
    const pending = consumeSourceHandoff('sceneRecreateSeedream');
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

  // Scene chips feed the Scene Changes box; every other group feeds Fine-tune.
  const applyPreset = (preset) => {
    const setter = preset.group === SCENE_GROUP ? setSceneChanges : setExtra;
    setter((prev) => (prev.includes(preset.text) ? prev : `${prev ? `${prev.trim()} ` : ''}${preset.text}`));
  };

  // ── run ────────────────────────────────────────────────────────────────────
  const runOne = async (source, charRefs, ratio, sharedPrompt, promptParams) => {
    const jobId = source.id;
    const feedId = `scenerecreate-sd-${jobId}`;
    pushPending({ id: feedId, prompt: 'Scene Recreate (Seedream)', imageModel: 'Seedream 5.0 Pro Edit', aspectRatio: ratio, resolutionTier: resolution });
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: 'running' } : j)));

    try {
      let images;
      let prompt = sharedPrompt;

      if (promptParams.aiReadScene) {
        // Gemini reads this source to text; Seedream then generates from CHARACTER IMAGES ONLY.
        // The source image is never uploaded, so the reference person cannot leak into the face.
        const src = parseDataUrl(source.dataUrl);
        if (!src) throw new Error('Could not read the source photo');
        const analyzed = await sceneApi.analyze(src.base64, src.mimeType);
        const sceneText = sceneDataToText(analyzed);
        let aiPrompt = buildAiSceneInstruction({ ...promptParams.base, sceneText });
        if (promptParams.extra) aiPrompt = `${aiPrompt}\n\n${promptParams.extra}`;
        if (aiPrompt.length > SEEDREAM_PROMPT_BUDGET) aiPrompt = aiPrompt.slice(0, SEEDREAM_PROMPT_BUDGET);
        prompt = aiPrompt;
        images = charRefs;
      } else {
        const sourceImg = parseDataUrl(source.dataUrl);
        if (!sourceImg) throw new Error('Could not read the source photo');
        images = [...charRefs, sourceImg];
      }

      const data = await seedreamApi.edit({
        images,
        prompt,
        aspectRatio: ratio,
        resolution,
      });

      const first = (data.images || [])[0];
      if (!first) throw new Error('Seedream returned no image');

      resolvePending(feedId, {
        galleryId: first.galleryId,
        imageId: first.imageId,
        prompt,
        imageModel: 'Seedream 5.0 Pro Edit',
        aspectRatio: ratio,
        resolutionTier: resolution,
        mimeType: first.mimeType,
        generatedAt: Date.now(),
      });
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: 'done', result: first, usedPrompt: prompt } : j)));
      setSessionSpend((s) => s + costPerJob);
    } catch (err) {
      // failPending (not rejectPending): keep the feed card and SHOW the error, so a 422 that
      // kills a job doesn't vanish silently from the feed.
      failPending(feedId, err.message || 'Scene recreate failed');
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: 'failed', error: err.message || 'Scene recreate failed' } : j)));
    }
  };

  const handleRecreate = async () => {
    if (!sources.length) { notify('Add at least one source photo', 'error'); return; }
    if (!characterId) { notify('Pick the character whose identity to use', 'error'); return; }

    // Without identity images Seedream can only fall back on the source photo's face — the exact
    // failure this page exists to prevent. Fail loudly instead of quietly producing the stand-in.
    const urls = [charApi.imageUrl(characterId), ...activeRefs.map((r) => charApi.refImageUrl(characterId, r.id))];
    const charRefs = [];
    for (const url of urls.slice(0, MAX_CHAR_IMAGES)) {
      try {
        const img = await urlToImagePayload(url);
        if (img) charRefs.push(img);
      } catch { /* one missing reference shouldn't kill the batch */ }
    }
    if (!charRefs.length) { notify('No character identity images could be loaded — add a primary image to this character', 'error'); return; }

    const prompt = buildSceneInstruction({
      characterName: charName,
      refCount: charRefs.length,
      masterPrompt: charDetail?.masterPrompt,
      sceneChanges,
      allowExpressionChange,
      allowHairChange,
      allowBodyChange,
    });
    let finalPrompt = extra.trim() ? `${prompt}\n\n${extra.trim()}` : prompt;
    if (finalPrompt.length > SEEDREAM_PROMPT_BUDGET) {
      // Seedream 422s on an over-long prompt and the whole batch dies. The base instruction is
      // what makes identity work, so the appended fine-tune text is what gives.
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
        await runOne(source, charRefs, ratioById.get(source.id), finalPrompt, {
          aiReadScene,
          extra: extra.trim(),
          base: {
            characterName: charName,
            refCount: charRefs.length,
            masterPrompt: charDetail?.masterPrompt,
            sceneChanges,
            allowExpressionChange,
            allowHairChange,
            allowBodyChange,
          },
        });
      }
    });
    await Promise.all(workers);
    setRunning(false);
    // Report what actually happened — a run where every job 422'd must not look like a success.
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
              1 · Source Photos <span className="text-zinc-600 font-normal normal-case">the scene &amp; pose to reimagine</span>
            </h3>
            <div className="flex items-center gap-2">
              {sources.length > 0 && <Badge color="green">{sources.length} queued</Badge>}
              <Badge color="zinc">Ctrl+V → Sources</Badge>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <Toggle checked={blurSource} onChange={setBlurSource} label="Blur source face" />
            {sources.length > 0 && blurSource && (
              <Btn variant="secondary" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem]" onClick={blurAllFaces} disabled={blurringAll || unblurredCount === 0}>
                {blurringAll ? <Spinner size={12} /> : null}
                {unblurredCount > 0 ? `Blur all faces (${unblurredCount})` : 'All blurred ✓'}
              </Btn>
            )}
          </div>
          {blurSource && (
            <p className="text-[0.625rem] leading-relaxed text-emerald-400/80 -mt-1">
              Faces are blurred as photos are added, before Gemini ever reads the scene from them.
              Turn off before adding if you want the original sent for analysis.
            </p>
          )}

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
              <p className="py-6 text-center text-xs text-zinc-600">Drag photos here — one recreation runs per photo</p>
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
                  Sends this character's main image{activeRefs.length > 0 ? ` + all ${activeRefs.length} reference${activeRefs.length > 1 ? 's' : ''}` : ''} first, then the source photo — Seedream keeps whoever is in image 1, and identity comes only from those.
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

        {/* Scene Changes — the star input */}
        <Card className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
              3 · Scene Changes <span className="text-zinc-600 font-normal normal-case">what to remix — background, outfit, lighting, setting</span>
            </h3>
            <button type="button" onClick={() => setAiReadScene((v) => !v)}
              title="Gemini reads the reference to text, so Seedream never sees the source person (no identity bleed). Needs a Gemini key."
              className={cn('shrink-0 rounded-full border px-2.5 py-1 text-[0.625rem] font-semibold transition-colors cursor-pointer',
                aiReadScene ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-300' : 'border-zinc-800/60 bg-white/[0.02] text-zinc-500 hover:text-zinc-300')}>
              {aiReadScene ? '✓ AI reads scene' : 'AI reads scene'}
            </button>
          </div>
          {aiReadScene ? (
            <p className="text-[0.625rem] leading-relaxed text-cyan-300/80">
              Gemini describes each reference to text; only your character images go to Seedream. The reference person can't leak in — but the pose/scene match is looser than pixel copy, and it needs a Gemini API key.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-12 shrink-0 text-[0.625rem] font-bold uppercase tracking-wider text-zinc-400">{SCENE_GROUP}</span>
            {PRESETS.filter((p) => p.group === SCENE_GROUP).map((p) => (
              <button key={p.label} type="button" onClick={() => applyPreset(p)}
                className="rounded-full border border-zinc-800/60 bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-rose-300 hover:border-rose-500/50 transition-colors duration-150 cursor-pointer">
                + {p.label}
              </button>
            ))}
          </div>
          <Textarea value={sceneChanges} onChange={(e) => setSceneChanges(e.target.value)} rows={3} maxLength={1500}
            placeholder="e.g. change the background to a luxury bedroom, put her in a red dress, golden-hour light..." />
          <p className="text-[0.625rem] text-zinc-600 leading-relaxed">
            {charName || 'The character'} keeps her identity and the source pose; everything you describe here is changed. Leave it blank to recreate the source scene as-is with only the identity swapped.
          </p>
        </Card>

        {/* Fine-tune — every other preset group, appended after the scene changes */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
              Fine-tune <span className="text-zinc-600 font-normal normal-case">(optional)</span>
            </h3>
            <div className="flex items-center gap-2">
              <span className={cn('text-[0.625rem] font-mono', overBudget ? 'text-red-400' : 'text-zinc-600')}>{previewPrompt.length}/{SEEDREAM_PROMPT_BUDGET}</span>
              <CopyBtn text={previewPrompt} className="!text-[0.6875rem]" />
            </div>
          </div>
          {FINE_TUNE_GROUPS.map((group) => (
            <div key={group} className="flex flex-wrap items-center gap-1.5">
              <span className="w-12 shrink-0 text-[0.625rem] font-bold uppercase tracking-wider text-zinc-400">{group}</span>
              {PRESETS.filter((p) => p.group === group).map((p) => (
                <button key={p.label} type="button" onClick={() => applyPreset(p)}
                  className="rounded-full border border-zinc-800/60 bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-rose-300 hover:border-rose-500/50 transition-colors duration-150 cursor-pointer">
                  + {p.label}
                </button>
              ))}
            </div>
          ))}
          <Textarea value={extra} onChange={(e) => setExtra(e.target.value)} rows={2} maxLength={1500}
            placeholder="e.g. keep the sunglasses, sharper skin detail..." />
          <p className="text-[0.625rem] text-zinc-600 leading-relaxed">
            {allowBodyChange && (
              <span className="block text-amber-400/90">
                A size chip is selected, so her figure comes from that chip — not from her reference photos. Use “Match her bust exactly” to copy her real size instead.
              </span>
            )}
            The identity-swap instruction is added automatically. Seedream keeps whoever is in image 1, so {charName || 'your character'} goes first: images{' '}
            <span className="font-mono text-zinc-400">1–{Math.max(1, charImagesUsed)}</span> {charName || 'character'} identity refs, then{' '}
            <span className="font-mono text-zinc-400">{Math.max(1, charImagesUsed) + 1}</span> the source scene.
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
            {imagesPerJob} image{imagesPerJob > 1 ? 's' : ''} per recreation → <span className="text-zinc-400 font-mono">${costPerJob.toFixed(3)}</span> each
            {sources.length > 1 && <> · {sources.length} photos → <span className="text-zinc-400 font-mono">${totalCost.toFixed(3)}</span> total</>}
            {aspectRatio === 'auto' && <> · Auto snaps each photo to its closest Seedream ratio</>}
          </p>
        </Card>

        <Btn onClick={handleRecreate} disabled={running} className="w-full">
          {running ? <Spinner size={16} /> : null}
          {running
            ? `Recreating… (${doneJobs.length}/${jobs.length})`
            : `Scene Recreate${sources.length > 1 ? ` · ${sources.length} photos` : ''} · $${totalCost.toFixed(3)}`}
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
                      : job.status === 'running' ? <Badge color="yellow">Recreating…</Badge>
                      : <Badge color="zinc">Queued</Badge>}
                    {job.status === 'done' && <span className="text-[0.625rem] text-zinc-600 font-mono">${costPerJob.toFixed(3)}</span>}
                  </div>

                  {job.status === 'done' && job.result ? (
                    <CompareSlider
                      originalSrc={job.thumb}
                      processedSrc={`data:${job.result.mimeType};base64,${job.result.base64Data}`}
                      originalLabel="SOURCE"
                      processedLabel="REMIXED"
                      className="rounded-lg overflow-hidden border border-zinc-800/60"
                    />
                  ) : (
                    <div className="relative">
                      <img src={job.thumb} alt="" className={cn('w-full aspect-[3/4] object-cover rounded-lg border border-zinc-800/60 bg-zinc-950', job.status !== 'done' && 'opacity-50')} />
                      {job.status === 'running' && <div className="absolute inset-0 flex items-center justify-center"><Spinner size={22} /></div>}
                    </div>
                  )}

                  {job.status === 'failed' && <p className="text-[0.625rem] text-red-400 leading-snug">{job.error}</p>}

                  {job.status === 'done' && job.usedPrompt ? (
                    <details className="group/prompt">
                      <summary className="flex items-center justify-between gap-2 cursor-pointer list-none text-[0.625rem] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300">
                        <span>Prompt used</span>
                        <CopyBtn text={job.usedPrompt} className="!text-[0.625rem]" />
                      </summary>
                      <p className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg border border-zinc-800/60 bg-black/30 p-2 text-[0.625rem] leading-relaxed text-zinc-400">{job.usedPrompt}</p>
                    </details>
                  ) : null}
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
