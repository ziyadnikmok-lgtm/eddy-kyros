import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { seedream as seedreamApi, gallery as galleryApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Select, Textarea, Badge, Spinner } from '../components/UI';
import CompareSlider from '../components/CompareSlider';
import { SEEDREAM_ASPECT_RATIOS, SEEDREAM_RESOLUTIONS, seedreamCost } from '../config/photoModes';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { consumeSourceHandoff } from '../lib/sourceHandoff';
import { detectAspectRatio } from '../lib/detectAspectRatio';
import { NSFW_PRESETS } from '../lib/nsfwPresets';
import { loadShelf, addToShelf, removeFromShelf } from '../lib/outfitShelfStore';
import { createPageStore } from '../lib/pageStateStore';
import { createEddyCollection } from '../lib/eddyCollectionStore';
import { cn } from '../lib/utils';

const ASPECT_OPTIONS = [{ value: 'auto', label: 'Auto (from person)' }, ...SEEDREAM_ASPECT_RATIOS.map((r) => ({ value: r, label: r }))];
const RES_OPTIONS = SEEDREAM_RESOLUTIONS.map((r) => ({ value: r, label: r }));

// Seedream accepts up to 10 images. We always send person + outfit, so refs cap at 8.
const MAX_TOTAL_IMAGES = 10;
const MAX_EXTRA_REFS = MAX_TOTAL_IMAGES - 2;
const MAX_PERSONS = 12;
// Keep concurrency low — each job holds an HTTP request while Muapi renders.
const MAX_CONCURRENT_JOBS = 2;
const SPEND_KEY = 'kyros.outfitSwapSeedream.sessionSpend';

// Failure mode this wording targets: the outfit reference contains a DIFFERENT person, and the
// model blends their build in — or "normalises" the subject's figure — while repainting clothes.
// So: (a) take only the garment from image 2, explicitly ignoring that person's body, and
// (b) state body preservation as its own emphatic instruction, not a word buried in a list.
//
// The preserve line is CONDITIONAL: it forbids enlarging, so leaving it in while the user asks
// for a bigger bust would have the base prompt fighting their own instruction — the model would
// just do nothing, which reads exactly like a broken preset.
function buildSwapInstruction(allowBodyChange) {
  const parts = [
    'Take ONLY the clothing/garment worn in the second image and put it on the person in the first image.',
    'Ignore the person in the second image completely — their body, build, proportions, face and pose are irrelevant. Copy only the garment itself: its colour, fabric, pattern and cut.',
    'The person in the first image must remain EXACTLY as they are: identical face, identity, skin tone, hair, pose, camera angle and background.',
  ];
  if (!allowBodyChange) {
    parts.push('CRITICAL: do not alter their body in any way. Preserve their exact body shape and proportions — bust/chest size, cleavage, waist, hips, build and overall figure must stay identical to the first image. Do not slim, shrink, enlarge, reshape, flatten or normalise any part of their figure.');
  }
  parts.push('The garment must stretch, drape and conform to fit THEIR body — never reshape the body to fit the garment.');
  parts.push("Match the first image's lighting, shadows and perspective. Photorealistic result.");
  return parts.join(' ');
}

// Grouped so the row stays scannable — a flat list of 13 chips is a wall.
// Skin prompts describe HOW LIGHT BEHAVES rather than naming an adjective: "make her oily"
// alone tends to read as a flat orange cast, while describing specular highlights is what
// actually looks oiled.
const PRESETS = [
  { group: 'Body', label: 'Lock body proportions', text: 'The body proportions of the person in the first image are non-negotiable: keep the exact same bust/chest size, cleavage, waist, hips and figure. The garment conforms to her body, not the reverse. Do not reduce or resize her chest under any circumstances.' },
  // Enlargement has to be explicit that the GARMENT adapts — otherwise the model tends to
  // keep the clothing rigid and shrink the body back to fit it.
  { group: 'Body', label: 'Bigger bust', bodyChange: true, text: 'Increase her bust size — noticeably fuller, larger breasts with natural shape, weight and cleavage. The garment stretches and drapes naturally over the larger bust. Keep her face, identity, pose and background identical.' },
  { group: 'Body', label: 'Much bigger bust', bodyChange: true, text: 'Dramatically increase her bust size — very large, full breasts with deep cleavage, natural weight and realistic shape. The garment conforms and stretches naturally to fit them. Keep her face, identity, pose and background identical.' },
  { group: 'Body', label: 'Curvier figure', bodyChange: true, text: 'Give her a curvier hourglass figure — fuller bust and hips with a narrower waist, natural and realistic. The garment conforms to the new shape. Keep her face, identity, pose and background identical.' },

  { group: 'Skin', label: 'Oiled skin', text: 'Coat her exposed skin in a glistening layer of body oil — bright specular highlights following the contours of her shoulders, collarbones, chest, stomach and legs, with soft reflections tracing her curves. Realistic sheen with depth, never flat, waxy or plastic.' },
  { group: 'Skin', label: 'Wet look', text: 'Her skin and hair look freshly wet — beaded water droplets, damp clumped strands, glossy reflective highlights and subtle rivulets running down her body. Photorealistic water, not a shiny filter.' },
  { group: 'Skin', label: 'Sweaty glow', text: 'Add a fine sheen of perspiration and a dewy glow across her skin — small beads at the temples, collarbone and chest catching the light, like humid heat. Subtle and realistic.' },
  { group: 'Skin', label: 'Deeper tan', text: 'Deepen her tan to a warm, even sun-kissed bronze with natural undertones. Believable — no orange cast, no muddy shadows.' },
  { group: 'Skin', label: 'Flawless skin', text: 'Even out her skin tone and clear blemishes while keeping real pores, fine texture and natural highlights. No airbrushed plastic look.' },

  { group: 'Fit', label: 'Tighter fit', text: 'The garment fits tighter against her body — clinging to her curves with realistic fabric tension, stretch and stress folds where it pulls.' },
  { group: 'Fit', label: 'Tuck the top in', text: 'Wear the top tucked in neatly.' },
  { group: 'Fit', label: 'Keep accessories', text: 'Keep any jewellery, necklace, glasses and accessories from the first image unchanged.' },

  { group: 'Photo', label: 'Full-body framing', text: 'Frame the result as a full-body shot showing the complete outfit head to toe.' },
  { group: 'Photo', label: 'Match lighting harder', text: 'Match the lighting, colour temperature and shadow direction of the first image very precisely.' },
  { group: 'Photo', label: 'Keep background', text: 'Do not alter the background at all — keep it pixel-identical to the first image.' },
  { group: 'Photo', label: 'Sharper fabric detail', text: 'Render the fabric texture, seams and material detail with high sharpness.' },
];
// Outfit Swap exists to put a garment ON, so the undress chips are deliberately excluded —
// they would contradict the swap itself. Pose and expression chips still apply.
const ALL_PRESETS = [...PRESETS, ...NSFW_PRESETS.filter((c) => !c.undress)];
const PRESET_GROUPS = ['Body', 'Skin', 'Fit', 'Photo'];
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


const _cache = { extra: '', aspectRatio: 'auto', resolution: '2K', nsfw: false };
// Images are too big for _cache/localStorage — IndexedDB so they survive a reload.
const store = createPageStore('kyros-outfit-swap-seedream-state');

export default function OutfitSwapSeedreamPage() {
  const { notify } = useApp();

  const [persons, setPersons] = useState([]);      // batch targets [{id, dataUrl}]
  const [outfit, setOutfit] = useState(null);      // the locked outfit (dataUrl)
  // Provenance for the current outfit, when it came from the real gallery: the prompt that
  // generated it + where it came from. Saved alongside the image on the shelf.
  const [outfitMeta, setOutfitMeta] = useState(null); // { prompt, galleryId, sourceUrl, createdAt }
  // Eddy's Outfit tab is a separate collection in IndexedDB; pulling from it saves re-uploading
  // a garment photo that is already saved there.
  const eddyOutfits = useMemo(() => createEddyCollection('eddy-outfit'), []);
  const [eddyPicks, setEddyPicks] = useState(null);   // null = closed
  const [extraRefs, setExtraRefs] = useState([]);  // [{id, dataUrl}]
  const [extra, setExtra] = useState(_cache.extra);
  const [nsfw, setNsfw] = useState(_cache.nsfw);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolution, setResolution] = useState(_cache.resolution);

  const [shelf, setShelf] = useState([]);
  const [galleryImages, setGalleryImages] = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [pickingFor, setPickingFor] = useState(null); // 'person' | 'outfit' | 'ref'

  const [jobs, setJobs] = useState([]);
  const [running, setRunning] = useState(false);
  const [sessionSpend, setSessionSpend] = useState(() => {
    try { return Number(sessionStorage.getItem(SPEND_KEY)) || 0; } catch { return 0; }
  });
  const [dragging, setDragging] = useState(null); // 'person' | 'outfit' | 'ref'
  const cancelRef = useRef(false);

  // Restore the people/outfit/refs that were on the page last time.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [p, o, r, om] = await Promise.all([
        store.get('persons', []), store.get('outfit', null),
        store.get('extraRefs', []), store.get('outfitMeta', null),
      ]);
      if (cancelled) return;
      // Never clobber: this resolves AFTER the (synchronous) source-handoff effect, so images
      // just sent from Frame Library would otherwise be overwritten by the old saved ones.
      if (Array.isArray(p) && p.length) setPersons((cur) => (cur.length ? cur : p));
      if (o) setOutfit((cur) => cur ?? o);
      if (Array.isArray(r) && r.length) setExtraRefs((cur) => (cur.length ? cur : r));
      if (om) setOutfitMeta((cur) => cur ?? om);
      setRestored(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist only after restore, or the first empty render would wipe the save.
  useEffect(() => { if (restored) store.set('persons', persons); }, [persons, restored]);
  useEffect(() => { if (restored) store.set('outfit', outfit); }, [outfit, restored]);
  useEffect(() => { if (restored) store.set('extraRefs', extraRefs); }, [extraRefs, restored]);
  useEffect(() => { if (restored) store.set('outfitMeta', outfitMeta); }, [outfitMeta, restored]);

  useEffect(() => { _cache.extra = extra; }, [extra]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolution = resolution; }, [resolution]);
  useEffect(() => { try { sessionStorage.setItem(SPEND_KEY, String(sessionSpend)); } catch { /* ignore */ } }, [sessionSpend]);

  useEffect(() => { loadShelf().then(setShelf); }, []);

  const imagesPerJob = 2 + extraRefs.length;
  const costPerJob = seedreamCost(resolution, imagesPerJob);
  const totalCost = costPerJob * Math.max(1, persons.length);

  // ── sources ────────────────────────────────────────────────────────────────
  const addPersons = useCallback(async (files) => {
    const room = MAX_PERSONS - persons.length;
    if (room <= 0) { notify(`Maximum ${MAX_PERSONS} people`, 'error'); return; }
    const valid = Array.from(files || []).filter((f) => /^image\/(png|jpeg|jpg|webp)$/i.test(f.type)).slice(0, room);
    if (!valid.length) return;
    const added = await Promise.all(valid.map(async (f) => ({
      id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      dataUrl: await fileToDataUrl(f),
    })));
    setPersons((prev) => [...prev, ...added]);
  }, [persons.length, notify]);

  const addRefs = useCallback(async (files) => {
    const room = MAX_EXTRA_REFS - extraRefs.length;
    if (room <= 0) { notify(`Maximum ${MAX_EXTRA_REFS} extra references`, 'error'); return; }
    const valid = Array.from(files || []).filter((f) => /^image\/(png|jpeg|jpg|webp)$/i.test(f.type)).slice(0, room);
    if (!valid.length) return;
    const added = await Promise.all(valid.map(async (f) => ({
      id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      dataUrl: await fileToDataUrl(f),
    })));
    setExtraRefs((prev) => [...prev, ...added]);
  }, [extraRefs.length, notify]);

  // Uploaded/pasted/dropped outfits have no prompt — clear any stale gallery provenance.
  const setOutfitFile = useCallback(async (files) => {
    const f = Array.from(files || []).find((x) => /^image\/(png|jpeg|jpg|webp)$/i.test(x.type));
    if (!f) return;
    setOutfit(await fileToDataUrl(f));
    setOutfitMeta(null);
  }, []);

  // Where the next Ctrl+V lands.
  const nextPasteSlot = !persons.length ? 'person' : !outfit ? 'outfit' : 'person';

  useEffect(() => {
    const onPaste = async (e) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type?.startsWith('image/'));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      e.preventDefault();
      if (nextPasteSlot === 'outfit') { await setOutfitFile([file]); notify('Pasted into Outfit ✨', 'success'); }
      else { await addPersons([file]); notify('Pasted into People ✨', 'success'); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [nextPasteSlot, addPersons, setOutfitFile, notify]);

  useEffect(() => {
    const pending = consumeSourceHandoff('outfitSwapSeedream');
    if (!pending.length) return;
    const items = pending.filter((p) => p?.dataUrl);
    if (!items.length) return;
    // 1 image → a person. 2+ → all but the last are people, the last is the outfit.
    if (items.length === 1) {
      setPersons([{ id: `p-${Date.now()}`, dataUrl: items[0].dataUrl }]);
    } else {
      setPersons(items.slice(0, -1).map((it, i) => ({ id: `p-${Date.now()}-${i}`, dataUrl: it.dataUrl })));
      setOutfit(items[items.length - 1].dataUrl);
    }
    notify(`${items.length} image${items.length > 1 ? 's' : ''} loaded ⚡`, 'success');
  }, [notify]);

  const fetchGallery = useCallback(async () => {
    setGalleryLoading(true);
    try {
      const res = await galleryApi.list({ limit: 120 });
      setGalleryImages(res.images || res || []);
    } catch { /* optional */ }
    finally { setGalleryLoading(false); }
  }, []);

  const openPicker = (slot) => { setPickingFor(slot); if (!galleryImages.length) fetchGallery(); };

  const openEddyOutfits = useCallback(async () => {
    if (eddyPicks) { setEddyPicks(null); return; }
    const items = await eddyOutfits.listItems();
    const rows = await Promise.all(items.map(async (it) => ({
      id: it.id,
      prompt: it.prompt || '',
      dataUrl: it.url || await eddyOutfits.getImage(it.id),
    })));
    // A prompt-only outfit has no garment to photograph, so it cannot drive a swap.
    setEddyPicks(rows.filter((r) => r.dataUrl));
  }, [eddyPicks, eddyOutfits]);

  // `img` is the full gallery entry — it carries the prompt that generated it, which we keep
  // as provenance so saving to the shelf stores the image AND its prompt.
  const pickFromGallery = async (img) => {
    try {
      const resp = await fetch(galleryApi.imageUrl(img.id), { credentials: 'include' });
      if (!resp.ok) throw new Error('Failed to load image');
      const blob = await resp.blob();
      const file = new File([blob], 'gallery', { type: blob.type });
      if (pickingFor === 'outfit') {
        await setOutfitFile([file]);           // clears meta…
        setOutfitMeta({                        // …then attach the real provenance
          prompt: img.prompt || '',
          galleryId: img.id,
          sourceUrl: img.sourceUrl || null,
          createdAt: img.createdAt || null,
        });
      } else if (pickingFor === 'ref') await addRefs([file]);
      else await addPersons([file]);
      setPickingFor(null);
    } catch (err) {
      notify(err.message || 'Failed to load gallery image', 'error');
    }
  };

  // ── shelf ──────────────────────────────────────────────────────────────────
  const saveOutfitToShelf = async () => {
    if (!outfit) return;
    const item = {
      id: `o-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: `Outfit ${shelf.length + 1}`,
      dataUrl: outfit,
      savedAt: Date.now(),
      // Provenance from the gallery pick — the prompt that made this outfit, and where it came from.
      prompt: outfitMeta?.prompt || '',
      galleryId: outfitMeta?.galleryId || null,
      sourceUrl: outfitMeta?.sourceUrl || null,
    };
    const ok = await addToShelf(item);
    if (!ok) { notify('Could not save to shelf', 'error'); return; }
    setShelf(await loadShelf());
    notify(item.prompt ? 'Saved to shelf with its prompt 👗' : 'Saved to outfit shelf 👗', 'success');
  };

  const applyShelfOutfit = (s) => {
    setOutfit(s.dataUrl);
    setOutfitMeta(s.prompt || s.galleryId
      ? { prompt: s.prompt || '', galleryId: s.galleryId || null, sourceUrl: s.sourceUrl || null, createdAt: null }
      : null);
  };

  const copyShelfPrompt = async (s) => {
    if (!s.prompt) { notify('No prompt saved for this outfit', 'error'); return; }
    try {
      await navigator.clipboard.writeText(s.prompt);
      notify('Outfit prompt copied 📋', 'success');
    } catch {
      notify('Failed to copy', 'error');
    }
  };

  const removeShelfItem = async (id) => {
    await removeFromShelf(id);
    setShelf(await loadShelf());
  };

  // ── run ────────────────────────────────────────────────────────────────────
  const runOne = async (person, sharedRefs, ratio) => {
    const jobId = person.id;
    const feedId = `outfitswap-sd-${jobId}`;
    pushPending({ id: feedId, prompt: 'Outfit Swap (Seedream)', imageModel: 'Seedream 5.0 Pro Edit', aspectRatio: ratio, resolutionTier: resolution });
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: 'running' } : j)));

    try {
      const personImg = parseDataUrl(person.dataUrl);
      if (!personImg) throw new Error('Could not read the person image');
      // If a body-change preset is active, drop the "never alter the body" line so the base
    // instruction doesn't contradict the user's own request.
    const allowBodyChange = PRESETS.some((p) => p.bodyChange && extra.includes(p.text));
    const base = buildSwapInstruction(allowBodyChange);
    const finalPrompt = extra.trim() ? `${base} ${extra.trim()}` : base;

      const data = await seedreamApi.edit({
        images: [personImg, ...sharedRefs],
        prompt: finalPrompt,
        aspectRatio: ratio,
        resolution,
      });

      const first = (data.images || [])[0];
      if (!first) throw new Error('Seedream returned no image');

      resolvePending(feedId, {
        galleryId: first.galleryId,
        imageId: first.imageId,
        prompt: 'Outfit Swap (Seedream)',
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
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status: 'failed', error: err.message || 'Swap failed' } : j)));
    }
  };

  const handleSwap = async () => {
    if (!persons.length) { notify('Add at least one person image', 'error'); return; }
    if (!outfit) { notify('Add the outfit image', 'error'); return; }

    const outfitImg = parseDataUrl(outfit);
    if (!outfitImg) { notify('Could not read the outfit image', 'error'); return; }
    const refImgs = extraRefs.map((r) => parseDataUrl(r.dataUrl)).filter(Boolean);
    const sharedRefs = [outfitImg, ...refImgs];

    const ratio = aspectRatio === 'auto' ? await detectAspectRatio(persons[0].dataUrl, SEEDREAM_ASPECT_RATIOS) : aspectRatio;

    cancelRef.current = false;
    setRunning(true);
    setJobs(persons.map((p) => ({ id: p.id, thumb: p.dataUrl, status: 'queued', result: null, error: null })));

    // Simple concurrency pool — each job holds an HTTP request while Muapi renders.
    const queue = [...persons];
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_JOBS, queue.length) }, async () => {
      while (queue.length) {
        if (cancelRef.current) return;
        const person = queue.shift();
        if (!person) return;
        await runOne(person, sharedRefs, ratio);
      }
    });
    await Promise.all(workers);
    setRunning(false);
    notify('Batch finished', 'success');
  };

  const doneJobs = jobs.filter((j) => j.status === 'done');

  return (
    <div className="space-y-6 animate-in">
      {/* Title/description now come from the app header — this row carries only what's
          unique to this page. */}
      <div className="flex items-center justify-end">
        <div className="text-right">
          <div className="text-[0.625rem] uppercase tracking-wider text-zinc-600 font-bold">Session spend</div>
          <div className="text-sm font-mono tabular-nums text-rose-300 font-semibold">${sessionSpend.toFixed(3)}</div>
        </div>
      </div>

      <div className="space-y-4">
        {/* People (batch) */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
              1 · People <span className="text-zinc-600 font-normal normal-case">keeps face &amp; pose</span>
            </h3>
            <div className="flex items-center gap-2">
              {persons.length > 0 && <Badge color="green">{persons.length} queued</Badge>}
              <Badge color="zinc">Ctrl+V → {nextPasteSlot === 'person' ? 'People' : 'Outfit'}</Badge>
            </div>
          </div>

          <div
            className={cn('rounded-xl border-2 border-dashed p-3 transition-colors', dragging === 'person' ? 'border-rose-500 bg-rose-500/[0.06]' : 'border-zinc-800/60')}
            onDragOver={(e) => { e.preventDefault(); setDragging('person'); }}
            onDragLeave={() => setDragging(null)}
            onDrop={(e) => { e.preventDefault(); setDragging(null); addPersons(e.dataTransfer.files); }}
          >
            {persons.length ? (
              <div className="grid [grid-template-columns:repeat(auto-fill,minmax(90px,1fr))] gap-2">
                {persons.map((p) => (
                  <div key={p.id} className="relative">
                    <img src={p.dataUrl} alt="" className="w-full aspect-[3/4] object-cover rounded-lg border border-zinc-800/60 bg-zinc-950" />
                    <button onClick={() => setPersons((prev) => prev.filter((x) => x.id !== p.id))}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 text-xs flex items-center justify-center hover:text-white cursor-pointer">×</button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-zinc-600">Drag people here — one swap runs per person</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="cursor-pointer">
              <input type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => { addPersons(e.target.files); e.target.value = ''; }} />
              <span className="inline-block"><Btn variant="secondary" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem] pointer-events-none">Upload</Btn></span>
            </label>
            <Btn variant="secondary" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem]" onClick={() => openPicker('person')}>Gallery</Btn>
            {persons.length > 0 && <Btn variant="ghost" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem]" onClick={() => setPersons([])}>Clear</Btn>}
          </div>
        </Card>

        {/* Outfit + refs + shelf */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
            2 · Outfit <span className="text-zinc-600 font-normal normal-case">the clothes to take</span>
          </h3>

          <div className="flex gap-4">
            <div className="w-36 shrink-0 space-y-2">
              <label
                className={cn('relative block aspect-[3/4] rounded-xl border-2 border-dashed cursor-pointer overflow-hidden transition-colors',
                  dragging === 'outfit' ? 'border-rose-500 bg-rose-500/[0.06]' : 'border-zinc-800/60 hover:border-zinc-600')}
                onDragOver={(e) => { e.preventDefault(); setDragging('outfit'); }}
                onDragLeave={() => setDragging(null)}
                onDrop={(e) => { e.preventDefault(); setDragging(null); setOutfitFile(e.dataTransfer.files); }}
              >
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                  onChange={(e) => { setOutfitFile(e.target.files); e.target.value = ''; }} />
                {outfit
                  ? <img src={outfit} alt="Outfit" className="absolute inset-0 h-full w-full object-cover bg-zinc-950" />
                  : <span className="absolute inset-0 flex items-center justify-center text-[0.6875rem] text-zinc-600">Drag or click</span>}
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                <Btn variant="secondary" className="!rounded-lg !py-1 !px-2 !text-[0.625rem]" onClick={() => openPicker('outfit')}>Gallery</Btn>
                <Btn variant="secondary" className="!rounded-lg !py-1 !px-2 !text-[0.625rem]" onClick={openEddyOutfits}>
                  {eddyPicks ? 'Close' : 'Eddy'}
                </Btn>
                {outfit && <Btn variant="secondary" className="!rounded-lg !py-1 !px-2 !text-[0.625rem]" onClick={saveOutfitToShelf}>★ Save</Btn>}
                {outfit && <Btn variant="ghost" className="!rounded-lg !py-1 !px-2 !text-[0.625rem]" onClick={() => { setOutfit(null); setOutfitMeta(null); }}>Clear</Btn>}
              </div>
              {eddyPicks && (
                !eddyPicks.length
                  ? <p className="py-2 text-center text-[0.6875rem] text-zinc-600">No outfit images in Eddy — prompt-only entries cannot be swapped.</p>
                  : (
                    <div className="grid [grid-template-columns:repeat(auto-fill,minmax(56px,1fr))] gap-1.5 max-h-[200px] overflow-y-auto pr-1">
                      {eddyPicks.map((e) => (
                        <button
                          key={e.id}
                          title={e.prompt || 'Eddy outfit'}
                          onClick={() => {
                            setOutfit(e.dataUrl);
                            // Carry the prompt across as provenance — the Made-with panel then
                            // shows what this garment is without another vision call.
                            setOutfitMeta(e.prompt ? { prompt: e.prompt, createdAt: Date.now() } : null);
                            setEddyPicks(null);
                          }}
                          className="aspect-square overflow-hidden rounded-md border border-zinc-800/60 transition hover:border-rose-500/60 cursor-pointer"
                        >
                          <img src={e.dataUrl} alt="" className="h-full w-full object-cover bg-zinc-950" loading="lazy" />
                        </button>
                      ))}
                    </div>
                  )
              )}
              {outfitMeta?.prompt && (
                <div className="rounded-lg border border-zinc-800/60 bg-white/[0.02] px-2 py-1.5">
                  <div className="text-[0.625rem] font-bold uppercase tracking-wider text-zinc-400">Made with</div>
                  <p className="mt-0.5 text-[0.625rem] text-zinc-400 leading-snug line-clamp-3" title={outfitMeta.prompt}>{outfitMeta.prompt}</p>
                </div>
              )}
            </div>

            {/* Extra references */}
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[0.6875rem] text-zinc-400 font-medium">
                  Extra references <span className="text-zinc-600">(optional · {extraRefs.length}/{MAX_EXTRA_REFS})</span>
                </span>
                <div className="flex items-center gap-1.5">
                  <label className="cursor-pointer">
                    <input type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden"
                      onChange={(e) => { addRefs(e.target.files); e.target.value = ''; }} />
                    <span className="inline-block"><Btn variant="secondary" className="!rounded-lg !py-1 !px-2 !text-[0.625rem] pointer-events-none">Add</Btn></span>
                  </label>
                  <Btn variant="secondary" className="!rounded-lg !py-1 !px-2 !text-[0.625rem]" onClick={() => openPicker('ref')}>Gallery</Btn>
                </div>
              </div>
              <div
                className={cn('rounded-xl border-2 border-dashed p-2 min-h-[92px] transition-colors', dragging === 'ref' ? 'border-rose-500 bg-rose-500/[0.06]' : 'border-zinc-800/60')}
                onDragOver={(e) => { e.preventDefault(); setDragging('ref'); }}
                onDragLeave={() => setDragging(null)}
                onDrop={(e) => { e.preventDefault(); setDragging(null); addRefs(e.dataTransfer.files); }}
              >
                {extraRefs.length ? (
                  <div className="grid [grid-template-columns:repeat(auto-fill,minmax(64px,1fr))] gap-2">
                    {extraRefs.map((r, i) => (
                      <div key={r.id} className="relative">
                        <img src={r.dataUrl} alt="" className="w-full aspect-square object-cover rounded-md border border-zinc-800/60 bg-zinc-950" />
                        <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 text-[0.5625rem] font-mono text-zinc-300">#{i + 3}</span>
                        <button onClick={() => setExtraRefs((prev) => prev.filter((x) => x.id !== r.id))}
                          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 text-[0.625rem] flex items-center justify-center hover:text-white cursor-pointer">×</button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-6 text-center text-[0.625rem] text-zinc-600 leading-relaxed">
                    Optional extra refs (shoes, bag, a second garment). Sent after the outfit — refer to them by position in Extra Instructions.
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Shelf */}
          {shelf.length > 0 && (
            <div className="pt-3 border-t border-zinc-800/40">
              <span className="text-[0.6875rem] text-zinc-400 font-medium">
                Saved outfits <span className="text-zinc-600">— image + the prompt that made it</span>
              </span>
              <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                {shelf.map((s) => (
                  <div key={s.id} className="relative shrink-0">
                    <button onClick={() => applyShelfOutfit(s)} title={s.prompt || 'Use this outfit (no prompt saved)'}
                      className={cn('block w-14 h-20 rounded-lg overflow-hidden border transition-all cursor-pointer hover:scale-[1.04]',
                        outfit === s.dataUrl ? 'border-rose-500 ring-2 ring-rose-500/25' : 'border-zinc-800/60 hover:border-zinc-600')}>
                      <img src={s.dataUrl} alt={s.name} className="h-full w-full object-cover bg-zinc-950" />
                    </button>
                    {s.prompt && (
                      <button onClick={() => copyShelfPrompt(s)} title="Copy the prompt that made this outfit"
                        className="absolute bottom-0.5 left-0.5 rounded bg-black/75 px-1 py-px text-[0.5rem] font-bold text-rose-300 hover:text-white transition cursor-pointer">
                        ⧉ prompt
                      </button>
                    )}
                    <button onClick={() => removeShelfItem(s.id)} title="Remove from shelf"
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 text-[0.625rem] flex items-center justify-center hover:text-white cursor-pointer">×</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Gallery picker */}
          {pickingFor && (
            <div className="pt-3 border-t border-zinc-800/40">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[0.6875rem] text-zinc-400">
                  Pick the <span className="text-rose-300 font-semibold">{pickingFor === 'person' ? 'person' : pickingFor === 'outfit' ? 'outfit' : 'extra reference'}</span> image
                </span>
                <button onClick={() => setPickingFor(null)} className="text-[0.6875rem] text-zinc-500 hover:text-zinc-300 cursor-pointer">Cancel</button>
              </div>
              {galleryLoading ? (
                <div className="flex items-center justify-center py-6 text-zinc-400 text-sm"><Spinner size={16} /> <span className="ml-2">Loading gallery...</span></div>
              ) : !galleryImages.length ? (
                <p className="text-xs text-zinc-500 py-4 text-center">No images in gallery yet.</p>
              ) : (
                <div className="grid [grid-template-columns:repeat(auto-fill,minmax(80px,1fr))] gap-2 max-h-[220px] overflow-y-auto pr-1">
                  {galleryImages.map((img) => (
                    <button key={img.id} onClick={() => pickFromGallery(img)} title={img.prompt || ''}
                      className="relative aspect-square overflow-hidden rounded-lg border border-zinc-800/60 hover:border-rose-500/60 transition-all cursor-pointer hover:scale-[1.03]">
                      <img src={galleryApi.thumbUrl(img.id)} alt="" className="h-full w-full object-cover bg-zinc-950" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Instructions + presets */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
            Extra Instructions <span className="text-zinc-600 font-normal normal-case">(optional)</span>
          </h3>
          {PRESET_GROUPS.map((group) => (
            <div key={group} className="flex flex-wrap items-center gap-1.5">
              <span className="w-9 shrink-0 text-[0.625rem] font-bold uppercase tracking-wider text-zinc-400">{group}</span>
              {PRESETS.filter((p) => p.group === group).map((p) => (
                <button key={p.label} type="button"
                  onClick={() => setExtra((prev) => (prev.includes(p.text) ? prev : `${prev ? `${prev.trim()} ` : ''}${p.text}`))}
                  className="rounded-full border border-zinc-800/60 bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-rose-300 hover:border-rose-500/50 transition-colors duration-150 cursor-pointer">
                  + {p.label}
                </button>
              ))}
            </div>
          ))}
          <Textarea value={extra} onChange={(e) => setExtra(e.target.value)} rows={2} maxLength={1500}
            placeholder="e.g. keep the necklace, make the fit slightly looser..." />
          <p className="text-[0.625rem] text-zinc-600 leading-relaxed">
            The swap instruction is added automatically. Images are sent in order: <span className="font-mono text-zinc-400">1</span> person, <span className="font-mono text-zinc-400">2</span> outfit{extraRefs.length ? `, 3–${2 + extraRefs.length} extra refs` : ''}.
          </p>
          {PRESETS.some((p) => p.bodyChange && extra.includes(p.text)) && (
            <p className="text-[0.625rem] text-rose-300/80 leading-relaxed">
              Body change requested — the automatic “keep her body identical” rule is switched off for this run so the bust can actually resize. Face, pose and background stay locked.
            </p>
          )}
        </Card>

        {/* Settings */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Settings</h3>
          <div className="grid grid-cols-2 gap-4">
            <Select label="Aspect Ratio" options={ASPECT_OPTIONS} value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} />
            <Select label="Resolution" options={RES_OPTIONS} value={resolution} onChange={(e) => setResolution(e.target.value)} />
          </div>
          <p className="text-[0.625rem] text-zinc-600">
            {imagesPerJob} image{imagesPerJob > 1 ? 's' : ''} per swap → <span className="text-zinc-400 font-mono">${costPerJob.toFixed(3)}</span> each
            {persons.length > 1 && <> · {persons.length} people → <span className="text-zinc-400 font-mono">${totalCost.toFixed(3)}</span> total</>}
          </p>
        </Card>

        <Btn onClick={handleSwap} disabled={running} className="w-full">
          {running ? <Spinner size={16} /> : null}
          {running
            ? `Swapping… (${doneJobs.length}/${jobs.length})`
            : `Swap Outfit${persons.length > 1 ? ` · ${persons.length} people` : ''} · $${totalCost.toFixed(3)}`}
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
                      : job.status === 'running' ? <Badge color="yellow">Swapping…</Badge>
                      : <Badge color="zinc">Queued</Badge>}
                    {job.status === 'done' && <span className="text-[0.625rem] text-zinc-600 font-mono">${costPerJob.toFixed(3)}</span>}
                  </div>

                  {job.status === 'done' && job.result ? (
                    <CompareSlider
                      originalSrc={job.thumb}
                      processedSrc={`data:${job.result.mimeType};base64,${job.result.base64Data}`}
                      originalLabel="BEFORE"
                      processedLabel="AFTER"
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
