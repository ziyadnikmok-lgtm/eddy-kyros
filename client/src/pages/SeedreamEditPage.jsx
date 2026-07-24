import { useState, useEffect, useCallback, useMemo } from 'react';
import { seedream as seedreamApi, gallery as galleryApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import CharacterPicker from '../components/CharacterPicker';
import { Card, Btn, Select, Textarea, Badge, Spinner, ImageCard } from '../components/UI';
import {
  SEEDREAM_ASPECT_RATIOS,
  SEEDREAM_RESOLUTIONS,
  SEEDREAM_MAX_IMAGES,
  seedreamCost,
} from '../config/photoModes';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { detectAspectRatio } from '../lib/detectAspectRatio';
import { consumeSourceHandoff } from '../lib/sourceHandoff';
import { NSFW_PRESETS, nudeState, NUDE_LINE } from '../lib/nsfwPresets';
import { createPageStore } from '../lib/pageStateStore';
import { cn } from '../lib/utils';

// 'auto' snaps to whichever supported ratio is closest to the source image — Seedream has a
// fixed enum, so there is no true passthrough.
const ASPECT_OPTIONS = [{ value: 'auto', label: 'Auto (match source)' }, ...SEEDREAM_ASPECT_RATIOS.map((r) => ({ value: r, label: r }))];
const RES_OPTIONS = SEEDREAM_RESOLUTIONS.map((r) => ({ value: r, label: r }));

// One-tap instructions. Seedream is an EDIT model with no seed/strength/mask — the prompt is
// the only lever, so each of these states what to change AND what must stay untouched
// (the model drifts on identity otherwise).
const KEEP_REST = 'Keep everything else identical to the source: same face, identity, hair, skin tone, pose, camera angle, outfit style, lighting and background.';
// KEEP_REST pins the hair, so a hair preset must revoke that clause or the two cancel and the
// model does neither — the same conflict that hit the body, expression and chest presets.
const HAIR_OVERRIDE = 'This is a deliberate hair change: it OVERRIDES any other instruction here to keep her hair identical to the source. Keep her face, identity, skin tone, pose, camera angle, outfit, lighting and background unchanged.';
const PRESETS = [
  {
    group: 'Body',
    label: 'Bigger bust',
    text: `Increase her bust size — noticeably fuller, larger breasts with a natural shape, weight and cleavage. The clothing stretches and drapes naturally over the larger bust. ${KEEP_REST}`,
  },
  {
    group: 'Body',
    label: 'Much bigger bust',
    text: `Dramatically increase her bust size — very large, full breasts with deep cleavage, natural weight and realistic shape. The clothing conforms and stretches naturally to fit them. ${KEEP_REST}`,
  },
  {
    group: 'Body',
    label: 'Bigger under same clothes',
    // The other bust presets let the clothing "conform", which the model reads as licence to
    // redraw the garment. This one changes the body underneath and pins the garment itself:
    // same piece, same cut, same fabric — only how it sits over her changes.
    text: `Increase her bust size underneath the clothing she is already wearing. Keep the EXACT same garment — same style, cut, colour, fabric, seams, straps and neckline as the source. Do not change, replace or restyle the clothing in any way. Only the fit changes: the same fabric now stretches taut over the fuller bust, with natural strain across the chest, deeper cleavage where the neckline sits, and the seams pulled slightly by the larger shape underneath. ${KEEP_REST}`,
  },
  // Skin/finish. These describe HOW light behaves on the skin rather than just naming an
  // adjective — "oily" alone tends to give a flat orange cast, while describing specular
  // highlights is what actually reads as oiled.
  {
    group: 'Skin',
    label: 'Oiled skin',
    text: `Coat her skin in a glistening layer of body oil — bright specular highlights catching the light along her shoulders, collarbones, chest, stomach and legs, with soft reflections following the contours of her body. Realistic sheen with visible depth, never flat, waxy or plastic. ${KEEP_REST}`,
  },
  {
    group: 'Skin',
    label: 'Wet look',
    text: `Her skin and hair look freshly wet — beaded water droplets, damp clumped hair strands, glossy reflective highlights and subtle rivulets running down her body. Photorealistic water, not a shiny filter. ${KEEP_REST}`,
  },
  {
    group: 'Skin',
    label: 'Sweaty glow',
    text: `Add a fine sheen of perspiration and a dewy glow across her skin — small beads at the temples, collarbone and chest, catching the light like humid heat or just after a workout. Subtle and realistic. ${KEEP_REST}`,
  },
  {
    group: 'Skin',
    label: 'Deeper tan',
    text: `Deepen her tan to a warm, even sun-kissed bronze with natural undertones. Keep it believable — no orange cast, no muddy shadows. ${KEEP_REST}`,
  },
  {
    group: 'Skin',
    label: 'Flawless skin',
    text: `Even out her skin tone and clear blemishes while keeping real pores, fine texture and natural highlights. No airbrushed plastic look, no loss of detail. ${KEEP_REST}`,
  },
  {
    group: 'Hair',
    label: 'Curly',
    text: `Restyle her hair into defined natural curls with real volume and strand separation, keeping her exact hair colour and length. ${HAIR_OVERRIDE}`,
  },
  {
    group: 'Hair',
    label: 'Wavy',
    text: `Restyle her hair into loose natural waves with soft movement, keeping her exact hair colour and length. ${HAIR_OVERRIDE}`,
  },
  {
    group: 'Hair',
    label: 'Straight',
    text: `Restyle her hair perfectly straight and sleek with a glossy finish, no curl or wave, keeping her exact hair colour and length. ${HAIR_OVERRIDE}`,
  },
  {
    group: 'Hair',
    label: 'Ponytail',
    text: `Restyle her hair pulled back into a ponytail, face framed and neck visible, keeping her exact hair colour, length and texture. ${HAIR_OVERRIDE}`,
  },
  {
    group: 'Hair',
    label: 'Messy bun',
    text: `Restyle her hair up into a loose messy bun with a few strands falling free, keeping her exact hair colour and texture. ${HAIR_OVERRIDE}`,
  },
  {
    group: 'Hair',
    label: 'Wet slicked back',
    text: `Restyle her hair wet and slicked straight back off her face, damp and glossy with visible comb lines, keeping her exact hair colour. ${HAIR_OVERRIDE}`,
  },
  {
    group: 'Hair',
    label: 'Shorter — bob',
    text: `Cut her hair into a chin-length bob with a clean blunt line, keeping her exact hair colour and texture. ${HAIR_OVERRIDE}`,
  },
  {
    group: 'Hair',
    label: 'Longer',
    text: `Extend her hair well past her chest, keeping her exact hair colour, texture and parting. ${HAIR_OVERRIDE}`,
  },
  { group: 'Photo', label: 'Keep face identical', text: 'Her face and identity must stay pixel-identical to the source — same features, expression and bone structure. Do not beautify or alter the face.' },
  { group: 'Photo', label: 'Sharper detail', text: 'Render skin, hair and fabric texture with high sharpness and realistic detail. No plastic or over-smoothed skin.' },
  { group: 'Photo', label: 'Better lighting', text: 'Improve the lighting — soft flattering key light, natural shadows and balanced exposure, while keeping the same scene and mood.' },
  { group: 'Photo', label: 'Clean background', text: 'Remove any other people and background clutter, keeping the same location, wall and overall scene.' },
];

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

// NSFW chips are shared with the other Seedream pages so wording fixes land everywhere.
const ALL_PRESETS = [...PRESETS, ...NSFW_PRESETS];
const NSFW_GROUPS = ['Sexual', 'Expression'];

const _cache = { perImage: false, prompt: '', aspectRatio: 'auto', resolution: '1K', nsfw: false };
// Images are too big for _cache/localStorage — they live in IndexedDB so they survive a reload.
const store = createPageStore('kyros-seedream-edit-state');

export default function SeedreamEditPage() {
  const { notify, characters: chars = [] } = useApp();

  // Character identity refs, appended after your own images.
  const [characterId, setCharacterId] = useState(null);
  const [charDetails, setCharDetails] = useState({});

  const [prompt, setPrompt] = useState(_cache.prompt);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolution, setResolution] = useState(_cache.resolution);

  const [images, setImages] = useState([]); // [{ id, dataUrl }]
  const [dragging, setDragging] = useState(false);

  const [galleryImages, setGalleryImages] = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [showGallery, setShowGallery] = useState(false);

  // Count, not a boolean: edits run concurrently, so a flag would let the first one to
  // finish clear the spinner while others are still running.
  const [inFlight, setInFlight] = useState(0);
  // Blend every reference into one picture, or edit each picture on its own. Different jobs,
  // not variations of each other — the second costs N times as much.
  const [perImage, setPerImage] = useState(_cache.perImage ?? false);
  const [nsfw, setNsfw] = useState(_cache.nsfw);
  const [results, setResults] = useState([]);

  // Restore what was on the page last time (images + the character you'd picked).
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [imgs, charId] = await Promise.all([store.get('images', []), store.get('characterId', null)]);
      if (cancelled) return;
      // Guarded the same way as Outfit Swap: an async restore must never overwrite whatever
      // the user (or a handoff) already put on the page while it was loading.
      if (Array.isArray(imgs) && imgs.length) setImages((cur) => (cur.length ? cur : imgs));
      if (charId) setCharacterId((cur) => cur ?? charId);
      setRestored(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Receive images sent from Library / Frame pages ("→ Seedream 5 Pro").
  useEffect(() => {
    const pending = consumeSourceHandoff('seedreamEdit').filter((it) => it?.dataUrl);
    if (!pending.length) return;
    setImages((cur) => [...cur, ...pending.map((it, i) => ({ id: `sent-${Date.now()}-${i}`, dataUrl: it.dataUrl }))]);
    notify(`${pending.length} image${pending.length > 1 ? 's' : ''} added ⚡`, 'success');
  }, [notify]);

  // Persist only after the restore has run, or the first empty render would wipe the save.
  useEffect(() => { if (restored) store.set('images', images); }, [images, restored]);
  useEffect(() => { if (restored) store.set('characterId', characterId); }, [characterId, restored]);

  useEffect(() => { _cache.prompt = prompt; }, [prompt]);
  useEffect(() => { _cache.nsfw = nsfw; }, [nsfw]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolution = resolution; }, [resolution]);
  useEffect(() => { _cache.perImage = perImage; }, [perImage]);

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
  const activeRefs = charDetail?.references?.filter((r) => r.isActive) || [];
  // Character contributes its main image + each ACTIVE reference.
  const charImageCount = characterId ? 1 + activeRefs.length : 0;
  // Seedream caps images_list at 10 total — your images + the character's must fit.
  const roomForChar = Math.max(0, SEEDREAM_MAX_IMAGES - images.length);
  const charImagesUsed = Math.min(charImageCount, roomForChar);
  const charTruncated = charImageCount > roomForChar;

  const totalImages = Math.max(1, images.length + charImagesUsed);
  const jobCount = perImage && images.length ? images.length : 1;
  // One generation per image when editing separately, so the cost multiplies.
  const estimatedCost = perImage && images.length
    ? jobCount * seedreamCost(resolution, 1 + charImagesUsed)
    : seedreamCost(resolution, totalImages);

  const addImages = useCallback(async (files) => {
    const room = SEEDREAM_MAX_IMAGES - images.length;
    if (room <= 0) { notify(`Maximum ${SEEDREAM_MAX_IMAGES} images`, 'error'); return; }
    const valid = Array.from(files).filter((f) => /^image\/(png|jpeg|jpg|webp)$/i.test(f.type));
    if (!valid.length) { notify('Please use PNG, JPG, or WebP images', 'error'); return; }
    const take = valid.slice(0, room);
    const added = await Promise.all(take.map(async (f) => ({
      id: `${f.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      dataUrl: await fileToDataUrl(f),
    })));
    setImages((prev) => [...prev, ...added]);
    if (valid.length > room) notify(`Only ${room} more image${room === 1 ? '' : 's'} fit — extras skipped`, 'info');
  }, [images.length, notify]);

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer?.files?.length) { await addImages(e.dataTransfer.files); return; }
    const url = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
    if (url && /^https?:|^data:/.test(url)) {
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        if (!/^image\//.test(blob.type)) throw new Error('not an image');
        await addImages([new File([blob], 'dropped', { type: blob.type })]);
      } catch {
        notify("Couldn't read that dragged image — try Upload instead", 'error');
      }
    }
  };

  const fetchGallery = useCallback(async () => {
    setGalleryLoading(true);
    try {
      const res = await galleryApi.list({ limit: 120 });
      setGalleryImages(res.images || res || []);
    } catch { /* gallery is optional */ }
    finally { setGalleryLoading(false); }
  }, []);

  const pickFromGallery = async (imgId) => {
    if (images.length >= SEEDREAM_MAX_IMAGES) { notify(`Maximum ${SEEDREAM_MAX_IMAGES} images`, 'error'); return; }
    try {
      const resp = await fetch(galleryApi.imageUrl(imgId), { credentials: 'include' });
      if (!resp.ok) throw new Error('Failed to load image');
      const blob = await resp.blob();
      const dataUrl = await fileToDataUrl(new File([blob], 'gallery', { type: blob.type }));
      setImages((prev) => [...prev, { id: `gal-${imgId}-${Date.now()}`, dataUrl }]);
      setShowGallery(false);
    } catch (err) {
      notify(err.message || 'Failed to load gallery image', 'error');
    }
  };

  const removeImage = (id) => setImages((prev) => prev.filter((i) => i.id !== id));

  // NSFW on with no undress chip picked still means naked — the toggle IS the instruction.
  // With a chip picked, the chip is more specific, so the generic line stands down.
  const finalPrompt = useMemo(() => {
    const { addGenericNudeLine } = nudeState({ nsfw, instruction: prompt });
    const base = prompt.trim();
    if (!addGenericNudeLine) return base;
    return base ? `${base} ${NUDE_LINE}` : NUDE_LINE;
  }, [prompt, nsfw]);

  const runOneEdit = async (job, ratio) => {
    const feedId = `seedream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pushPending({
      id: feedId,
      prompt: finalPrompt,
      imageModel: 'Seedream 5.0 Pro Edit',
      aspectRatio: ratio,
      resolutionTier: resolution,
    });

    try {
      const payload = job.map((i) => parseDataUrl(i.dataUrl)).filter(Boolean);

      // Append the character's main image + active references, trimmed to Seedream's 10-image cap.
      // Runs BEFORE the empty check — with no uploads, these ARE the images.
      if (characterId && roomForChar > 0) {
        const urls = [charApi.imageUrl(characterId), ...activeRefs.map((r) => charApi.refImageUrl(characterId, r.id))];
        for (const url of urls.slice(0, roomForChar)) {
          try {
            const img = await urlToImagePayload(url);
            if (img) payload.push(img);
          } catch {
            // A missing reference shouldn't kill the whole edit — skip it.
          }
        }
      }

      if (!payload.length) throw new Error('Could not read any source images');

      const data = await seedreamApi.edit({
        images: payload,
        prompt: finalPrompt,
        aspectRatio: ratio,
        resolution,
      });

      const out = data.images || [];
      setResults(out);
      if (out.length) {
        const first = out[0];
        resolvePending(feedId, {
          galleryId: first.galleryId,
          imageId: first.imageId,
          prompt: finalPrompt,
          imageModel: 'Seedream 5.0 Pro Edit',
          aspectRatio: ratio,
          resolutionTier: resolution,
          mimeType: first.mimeType,
          generatedAt: Date.now(),
        });
        notify('Edit complete ✨', 'success');
      } else {
        rejectPending(feedId);
        notify('Seedream returned no image', 'error');
      }
    } catch (err) {
      rejectPending(feedId);
      notify(err.message || 'Seedream edit failed', 'error');
    }
  };

  const handleGenerate = async () => {
    // A character on its own is a valid source — its images become the images_list.
    if (!images.length && !charImagesUsed) {
      notify('Add an image or pick a character', 'error');
      return;
    }
    if (!prompt.trim()) { notify('Describe the edit you want', 'error'); return; }

    // Resolve 'auto' up front so the feed card shows the real ratio, not the word "auto".
    // Measures your first image; with a character only there's nothing to measure, so 1:1.
    let ratio = aspectRatio;
    if (aspectRatio === 'auto') {
      try {
        ratio = await detectAspectRatio(images[0]?.dataUrl, SEEDREAM_ASPECT_RATIOS, '1:1');
      } catch {
        ratio = '1:1';
      }
    }

    // Two different jobs: blend every reference into ONE picture, or edit each picture on its
    // own. The second is N separate generations, which is why it costs N times as much.
    const jobs = perImage && images.length ? images.map((img) => [img]) : [images];

    setInFlight((n) => n + 1);
    let cursor = 0;
    try {
      // A small pool: sequential would make ten edits take ten minutes, and firing all at once
      // makes the backend re-encode every source image simultaneously.
      await Promise.all(
        Array.from({ length: Math.min(4, jobs.length) }, async () => {
          while (cursor < jobs.length) {
            const mine = jobs[cursor];
            cursor += 1;
            await runOneEdit(mine, ratio);
          }
        }),
      );
    } finally {
      // finally, always — a rejection here would otherwise strand the counter above zero.
      setInFlight((n) => n - 1);
    }
  };

  return (
    <div className="space-y-6 animate-in">
      <div className="space-y-4">
        {/* Source images */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
              Reference Images <span className="text-zinc-600 font-normal normal-case">(optional with a character)</span>
            </h3>
            <span className="text-[0.6875rem] text-zinc-600 font-mono tabular-nums">{images.length}/{SEEDREAM_MAX_IMAGES}</span>
          </div>

          <div
            className={cn(
              'rounded-xl border-2 border-dashed transition-colors p-3',
              dragging ? 'border-rose-500 bg-rose-500/[0.06]' : 'border-zinc-800/60',
            )}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            {images.length ? (
              <div className="grid [grid-template-columns:repeat(auto-fill,minmax(90px,1fr))] gap-2">
                {images.map((img) => (
                  <div key={img.id} className="relative">
                    <img src={img.dataUrl} alt="" className="w-full aspect-square object-cover rounded-lg border border-zinc-800/60 bg-zinc-950" />
                    <button
                      onClick={() => removeImage(img.id)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 text-xs flex items-center justify-center hover:text-white cursor-pointer"
                      aria-label="Remove image"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-zinc-600">
                {dragging ? 'Drop images' : 'Drag images here, or use the buttons below'}
                {!dragging && <span className="block mt-1 text-zinc-700">Optional if you pick a character below.</span>}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="cursor-pointer">
              <input type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />
              <span className="inline-block"><Btn variant="secondary" className="!rounded-lg pointer-events-none">Upload</Btn></span>
            </label>
            <Btn variant="secondary" className="!rounded-lg" onClick={() => {
              if (!showGallery && !galleryImages.length) fetchGallery();
              setShowGallery((v) => !v);
            }}>
              {showGallery ? 'Hide Gallery' : 'Pick from Gallery'}
            </Btn>
            {images.length > 1 && (
              <label className="ml-2 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                <input type="checkbox" checked={perImage} onChange={(e) => setPerImage(e.target.checked)}
                  className="h-4 w-4 cursor-pointer accent-rose-500" />
                <span className="text-xs leading-tight">
                  <span className={perImage ? 'font-semibold text-rose-300' : 'text-zinc-300'}>Edit each separately</span>
                  <span className="block text-[0.625rem] text-zinc-500">
                    {perImage ? `${images.length} edits, same instruction` : 'Off: all blend into one'}
                  </span>
                </span>
              </label>
            )}
            {images.length > 0 && (
              <Btn variant="ghost" className="!rounded-lg !text-xs" onClick={() => setImages([])}>Clear all</Btn>
            )}
          </div>

          {showGallery && (
            <div className="pt-1">
              {galleryLoading ? (
                <div className="flex items-center justify-center py-6 text-zinc-400 text-sm"><Spinner size={16} /> <span className="ml-2">Loading gallery...</span></div>
              ) : !galleryImages.length ? (
                <p className="text-xs text-zinc-500 py-4 text-center">No images in gallery yet.</p>
              ) : (
                <div className="grid [grid-template-columns:repeat(auto-fill,minmax(80px,1fr))] gap-2 max-h-[240px] overflow-y-auto pr-1">
                  {galleryImages.map((img) => (
                    <button key={img.id} onClick={() => pickFromGallery(img.id)}
                      className="relative aspect-square overflow-hidden rounded-lg border border-zinc-800/60 hover:border-rose-500/60 transition-all cursor-pointer hover:scale-[1.03]">
                      <img src={galleryApi.thumbUrl(img.id)} alt="" className="h-full w-full object-cover bg-zinc-950" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Character (optional identity references) */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
              Character <span className="text-zinc-600 font-normal normal-case">(optional)</span>
            </h3>
            <div className="flex items-center gap-2">
              {characterId && charImagesUsed > 0 && (
                <Badge color="green">+{charImagesUsed} ref{charImagesUsed > 1 ? 's' : ''}</Badge>
              )}
              {characterId && (
                <button onClick={() => setCharacterId(null)} className="text-[0.6875rem] text-zinc-500 hover:text-zinc-300 transition cursor-pointer underline">
                  Clear
                </button>
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
                label="Use a character's identity"
                maxHeight="max-h-44"
              />
              {characterId && (
                <p className="text-[0.625rem] text-zinc-600 leading-relaxed">
                  Sends this character's main image{activeRefs.length > 0 ? ` + ${activeRefs.length} active reference${activeRefs.length > 1 ? 's' : ''}` : ''} after your images, so the edit can match their identity. Mention them in your instruction (e.g. "make the person look like the woman in the last reference images").
                  {charTruncated && (
                    <span className="block mt-1 text-yellow-400/90">
                      Only {charImagesUsed} of {charImageCount} character images fit — Seedream caps at {SEEDREAM_MAX_IMAGES} total. Remove some of your own images to include the rest.
                    </span>
                  )}
                </p>
              )}
            </>
          )}
        </Card>

        {/* Prompt */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Edit Instruction</h3>
            {prompt && (
              <button onClick={() => setPrompt('')} className="text-[0.6875rem] text-zinc-500 hover:text-zinc-300 transition cursor-pointer underline">
                Clear
              </button>
            )}
          </div>

          {/* One-tap edits — drop an image, tap a preset, generate. Presets stack. */}
          {['Body', 'Hair', 'Skin', 'Photo'].map((group) => (
            <div key={group} className="flex flex-wrap items-center gap-1.5">
              <span className="text-[0.625rem] font-bold uppercase tracking-wider text-zinc-400 w-10 shrink-0">{group}</span>
              {PRESETS.filter((p) => p.group === group).map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setPrompt((prev) => (prev.includes(p.text) ? prev : `${prev ? `${prev.trim()} ` : ''}${p.text}`))}
                  className="rounded-full border border-zinc-800/60 bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-rose-300 hover:border-rose-500/50 transition cursor-pointer"
                >
                  + {p.label}
                </button>
              ))}
            </div>
          ))}

          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Drop an image above, then tap a preset — or describe the edit yourself."
            rows={4}
            maxLength={4000}
          />
          <div className="text-[0.625rem] text-zinc-600 text-right">{prompt.length}/4000</div>
          {images.length > 1 && (
            <p className="text-[0.625rem] text-zinc-600 leading-relaxed">
              With multiple images, refer to them in plain language — e.g. "the first image" / "the second image". They're sent in the order shown above.
            </p>
          )}
        </Card>

        {/* Settings */}
        <Card className="p-4 space-y-4">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Settings</h3>
          <div className="grid grid-cols-2 gap-4">
            <Select label="Aspect Ratio" options={ASPECT_OPTIONS} value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} />
            <Select label="Resolution" options={RES_OPTIONS} value={resolution} onChange={(e) => setResolution(e.target.value)} />
          </div>
          <p className="text-[0.625rem] text-zinc-600 leading-relaxed">
            Price scales with resolution and image count — the first image is free, each extra adds $0.003.
            {' '}<span className="text-zinc-500">1K ≈ $0.045 · 2K ≈ $0.090 (1 image).</span>
            {' '}Sending <span className="text-zinc-400 font-mono">{totalImages}</span> image{totalImages > 1 ? 's' : ''}
            {charImagesUsed > 0 && <> ({images.length} yours + {charImagesUsed} character)</>}.
          </p>
        </Card>

        {/* Generate */}
        <Btn onClick={handleGenerate} className="w-full">
          {inFlight > 0 ? <Spinner size={16} /> : null}
          {perImage && images.length > 1
            ? `Edit ${jobCount} images · $${estimatedCost.toFixed(3)}`
            : `Edit Image · $${estimatedCost.toFixed(3)}`}
          {inFlight > 0 ? ` · ${inFlight} running` : ''}
        </Btn>

        {/* Results */}
        {results.length > 0 && (
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Result</h3>
              <Badge color="green">{results.length} image{results.length > 1 ? 's' : ''}</Badge>
            </div>
            <div className="grid [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))] gap-3">
              {results.map((r) => (
                <ImageCard
                  key={r.galleryId || r.imageId}
                  base64={r.base64Data}
                  mimeType={r.mimeType}
                  meta={{ imageId: r.imageId }}
                />
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
