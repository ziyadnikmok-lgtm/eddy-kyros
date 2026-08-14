import { useState, useEffect, useCallback } from 'react';
import { seedream as seedreamApi, poseRemix as poseApi, gallery as galleryApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Select, Badge, Spinner, ImageCard } from '../components/UI';
import { SEEDREAM_ASPECT_RATIOS, SEEDREAM_RESOLUTIONS, SEEDREAM_MAX_IMAGES, seedreamCost } from '../config/photoModes';
import { pushPending, resolvePending, failPending } from '../lib/generationFeed';
import { consumeSourceHandoff } from '../lib/sourceHandoff';
import { detectAspectRatio } from '../lib/detectAspectRatio';
import { createPageStore } from '../lib/pageStateStore';
import { useLibraryDestination, LibraryDestinationPicker, LibraryDestinationNote } from '../components/LibraryDestinationPicker';
import { fileIntoLibrary, cardName } from '../lib/libraryDestination';
import { cn } from '../lib/utils';

const ASPECT_OPTIONS = [{ value: 'auto', label: 'Auto (match photo)' }, ...SEEDREAM_ASPECT_RATIOS.map((r) => ({ value: r, label: r }))];
const RES_OPTIONS = SEEDREAM_RESOLUTIONS.map((r) => ({ value: r, label: r }));
const MAX_IMAGES = SEEDREAM_MAX_IMAGES;

// Four vibes, four buttons — that's the whole tool. Each is a set of pose descriptions; a click
// picks one (Shuffle rotates). Body-position wording only; the account enforces its own policy.
const VIBES = [
  {
    key: 'playful', label: 'Playful', emoji: '😊',
    poses: [
      'a soft smile with a slight head tilt, one finger resting near her lips',
      'a slight lip bite, twirling a strand of hair, one hip popped to the side',
      'hands clasped behind her back, looking up through her lashes',
      'one hand on her cheek, a playful wink, weight shifted onto one leg',
    ],
  },
  {
    key: 'sexy', label: 'Sexy', emoji: '🔥',
    poses: [
      'standing tall, chin lifted, a strong direct gaze, one hand on her hip and the other sweeping through her hair',
      'running one hand through her hair, head tilted back, a smouldering gaze at the camera',
      'both hands low on her hips, chest pushed forward, her body in a pronounced S-curve',
      'an over-the-shoulder sultry look, one arm crossed under her chest',
      'one hand at the back of her neck, torso gently arched, the other hand on her waist',
    ],
  },
  {
    key: 'horny', label: 'Horny', emoji: '😩',
    poses: [
      'biting her lower lip, heavy-lidded eyes on the camera, one hand sliding down her stomach',
      'flushed skin and parted lips, head tilted back, both hands running up her body',
      'kneeling with her thighs slightly apart, arching her back, a needy heavy-lidded gaze',
      'leaning against a wall, one hand between her thighs, breathing heavy, eyes half-closed',
      'lying back with knees raised, one hand on her chest and one on her hip, a wanting look',
    ],
  },
  {
    key: 'sexual', label: 'Sexual', emoji: '🍑',
    poses: [
      'kneeling upright, back arched, chest pushed forward, both hands on her thighs, looking at the camera',
      'on all fours, back arched, looking back over her shoulder toward the camera',
      'lying back with her knees raised and legs slightly parted, one hand on her stomach',
      'bent forward at the waist, hands on her knees, cleavage prominent, a sultry gaze',
      'lying on her side, top leg raised, one hand tracing the line of her hip',
      'sitting with her legs open, leaning back on her hands, a direct gaze at the camera',
    ],
  },
];
function vibeByKey(key) { return VIBES.find((v) => v.key === key) || VIBES[0]; }

// Facial expressions, picked separately from the pose. "None" keeps the face from the photo.
// Anything else CHANGES her expression, which is why buildPrompt has to stand down its
// "keep her face identical" line — otherwise the two cancel and the model does neither.
const EXPRESSIONS = [
  { key: 'none', label: 'Keep face', text: '' },
  { key: 'seductive', label: 'Seductive', text: 'a sultry, heavy-lidded seductive look straight down the lens, lips slightly parted' },
  { key: 'bite', label: 'Biting lip', text: 'biting her lower lip, heavy-lidded eyes locked on the camera' },
  { key: 'moan', label: 'Moaning', text: 'her mouth open in a soft moan, eyes half-closed, head tilted back, brows drawn together in pleasure' },
  { key: 'flushed', label: 'Flushed', text: 'flushed cheeks, breathless parted lips, aroused heavy-lidded eyes' },
  { key: 'innocent', label: 'Innocent', text: 'wide innocent doe eyes and softly parted lips, looking up at the camera' },
  { key: 'smile', label: 'Smiling', text: 'a warm genuine smile with bright, happy eyes' },
];
function exprByKey(key) { return EXPRESSIONS.find((e) => e.key === key) || EXPRESSIONS[0]; }


// Reposition the woman in the uploaded photo. Everything about HER stays; only the pose (and,
// if one is chosen, her facial expression) changes.
function buildPrompt(pose, expression) {
  const keepFace = expression
    // An expression was chosen: pin her IDENTITY but explicitly free the expression, or the
    // "keep her face identical" line would cancel the change and the model would do neither.
    ? "Keep her exact facial features and identity — same face, bone structure, eyes, nose and lips — but her EXPRESSION changes as directed below."
    : "Keep her exact face, facial features and expression identical to the photo.";
  return [
    'Repose the woman in this photo into a new pose.',
    `NEW POSE: ${pose}.`,
    expression ? `FACIAL EXPRESSION: ${expression}.` : '',
    keepFace,
    'Keep everything else about her identical to the photo: identity, skin tone, hair (colour, length, style), body shape, chest size and cleavage, and her outfit. Do NOT change who she is.',
    'Keep the same background and lighting, adjusting naturally for the new pose.',
    'Photorealistic: real skin texture with pores, natural hair, slight asymmetry. No plastic or CGI look.',
  ].filter(Boolean).join(' ');
}

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

const _cache = { vibe: 'sexy', poseIndex: 0, expression: 'none', aspectRatio: 'auto', resolution: '1K', count: 1 };
// Photos are too big for localStorage — IndexedDB so they survive a reload.
const store = createPageStore('kyros-pose-remix-seedream-state');

export default function PoseRemixSeedreamPage() {
  const { notify } = useApp();

  const [images, setImages] = useState([]); // [{ id, dataUrl }]
  const [dragging, setDragging] = useState(false);
  const [vibe, setVibe] = useState(_cache.vibe);
  const [poseIndex, setPoseIndex] = useState(_cache.poseIndex);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolution, setResolution] = useState(_cache.resolution);
  const [aiPose, setAiPose] = useState('');      // pose the AI invented from YOUR photo
  const [suggesting, setSuggesting] = useState(false);
  const [galleryImages, setGalleryImages] = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [expression, setExpression] = useState(_cache.expression);
  const [count, setCount] = useState(_cache.count);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  // Where this run lands. Its own key — choosing Base here must not redirect the other tabs.
  const dest = useLibraryDestination('kyros.poseRemix.genDest');

  const listPose = vibeByKey(vibe).poses[poseIndex % vibeByKey(vibe).poses.length];
  const pose = aiPose || listPose;

  // Restore the photos that were on the page last time.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const imgs = await store.get('images', []);
      if (cancelled) return;
      if (Array.isArray(imgs) && imgs.length) setImages((cur) => (cur.length ? cur : imgs));
      setRestored(true);
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { if (restored) store.set('images', images); }, [images, restored]);

  useEffect(() => { _cache.vibe = vibe; }, [vibe]);
  useEffect(() => { _cache.poseIndex = poseIndex; }, [poseIndex]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolution = resolution; }, [resolution]);
  useEffect(() => { _cache.count = count; }, [count]);
  useEffect(() => { _cache.expression = expression; }, [expression]);

  // Frames/images sent from Library or Frame Grabber.
  useEffect(() => {
    const pending = consumeSourceHandoff('poseRemixSeedream').filter((p) => p?.dataUrl);
    if (!pending.length) return;
    setImages((cur) => [...cur, ...pending.map((p, i) => ({ id: `sent-${Date.now()}-${i}`, dataUrl: p.dataUrl }))]);
    notify(`${pending.length} photo${pending.length > 1 ? 's' : ''} added ⚡`, 'success');
  }, [notify]);

  const addFiles = useCallback(async (files) => {
    const room = MAX_IMAGES - images.length;
    if (room <= 0) { notify(`Up to ${MAX_IMAGES} photos`, 'error'); return; }
    const valid = Array.from(files || []).filter((f) => /^image\/(png|jpe?g|webp)$/i.test(f.type)).slice(0, room);
    if (!valid.length) { notify('Use PNG, JPG or WebP', 'error'); return; }
    const added = await Promise.all(valid.map(async (f) => ({ id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, dataUrl: await fileToDataUrl(f) })));
    setImages((prev) => [...prev, ...added]);
  }, [images.length, notify]);

  const onPaste = useCallback((e) => {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  }, [addFiles]);
  useEffect(() => {
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onPaste]);

  // Ask the AI to LOOK at the uploaded photo and invent a pose for this vibe, so it suits her
  // actual outfit, body and setting. Falls back to the built-in list if the model declines.
  const suggestPose = useCallback(async (vibeKey) => {
    const first = images[0];
    if (!first) return;
    const parsed = parseDataUrl(first.dataUrl);
    if (!parsed) return;
    setSuggesting(true);
    try {
      const data = await poseApi.suggest(parsed.base64, parsed.mimeType, vibeKey);
      if (data?.pose) { setAiPose(data.pose); notify('Pose read from your photo ✨', 'success'); }
      else { setAiPose(''); notify('AI declined that vibe — using a built-in pose', 'error'); }
    } catch (err) {
      setAiPose('');
      notify(err.message || 'Could not read the photo — using a built-in pose', 'error');
    } finally {
      setSuggesting(false);
    }
  }, [images, notify]);

  const fetchGallery = useCallback(async () => {
    setGalleryLoading(true);
    try {
      const res = await galleryApi.list();
      setGalleryImages(res.images || res || []);
    } catch { /* gallery is optional */ }
    finally { setGalleryLoading(false); }
  }, []);

  const pickFromGallery = async (imgId) => {
    if (images.length >= MAX_IMAGES) { notify(`Up to ${MAX_IMAGES} photos`, 'error'); return; }
    try {
      const resp = await fetch(galleryApi.imageUrl(imgId), { credentials: 'include' });
      if (!resp.ok) throw new Error('Failed to load that image');
      const blob = await resp.blob();
      const dataUrl = await fileToDataUrl(new File([blob], 'library', { type: blob.type || 'image/png' }));
      setImages((prev) => [...prev, { id: `lib-${imgId}-${Date.now()}`, dataUrl }]);
    } catch (err) {
      notify(err.message || 'Could not load that image', 'error');
    }
  };

  const removeImage = (id) => setImages((prev) => prev.filter((i) => i.id !== id));
  const shufflePose = () => { setAiPose(''); setPoseIndex((i) => (i + 1) % vibeByKey(vibe).poses.length); };
  const pickVibe = (key) => { setVibe(key); setPoseIndex(0); setAiPose(''); suggestPose(key); };

  const costEach = seedreamCost(resolution, Math.max(1, images.length));
  // Every photo is reposed at every pose, so the bill is photos x poses.
  const jobTotal = Math.max(1, images.length) * count;
  const cost = costEach * jobTotal;

  // N generations, each a DIFFERENT pose. An AI-read pose (if any) leads, then the vibe's
  // built-in list rotates — so asking for 4 gives 4 distinct poses, not the same one 4 times.
  const posesForRun = () => {
    const list = vibeByKey(vibe).poses;
    const out = [];
    if (aiPose) out.push(aiPose);
    for (let i = 0; out.length < count; i += 1) out.push(list[(poseIndex + i) % list.length]);
    return out.slice(0, count);
  };

  const handleGenerate = async () => {
    if (!images.length) { notify('Drop a photo of your model first', 'error'); return; }

    const ratio = aspectRatio === 'auto'
      ? await detectAspectRatio(images[0]?.dataUrl, SEEDREAM_ASPECT_RATIOS, '3:4')
      : aspectRatio;

    const sources = images.map((i) => parseDataUrl(i.dataUrl)).filter(Boolean);
    if (!sources.length) { notify('Could not read the photo', 'error'); return; }

    const poses = posesForRun();
    setLoading(true);
    setResults([]);

    const runOne = async (poseText, idx, payload) => {
      const feedId = `poseremix-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`;
      const label = `Pose Remix — ${vibeByKey(vibe).label}`;
      pushPending({ id: feedId, prompt: label, imageModel: 'Seedream 5.0 Pro Edit', aspectRatio: ratio, resolutionTier: resolution });
      try {
        const data = await seedreamApi.edit({ images: payload, prompt: buildPrompt(poseText, exprByKey(expression).text), aspectRatio: ratio, resolution });
        const first = (data.images || [])[0];
        if (!first) throw new Error('Seedream returned no image');
        setResults((prev) => [...prev, first]);
        resolvePending(feedId, {
          galleryId: first.galleryId, imageId: first.imageId,
          prompt: label, imageModel: 'Seedream 5.0 Pro Edit',
          aspectRatio: ratio, resolutionTier: resolution, mimeType: first.mimeType, generatedAt: Date.now(),
        });
        // File it. A filing miss is NOT a failed remix — the picture exists, is billed and is on the
        // feed — so it is reported and the job still counts as done, rather than telling you to
        // re-run something that already succeeded.
        if (first.galleryId) {
          try {
            await fileIntoLibrary(dest.store, {
              url: galleryApi.imageUrl(first.galleryId),
              prompt: label,
              name: cardName('poseremix', idx),
            }, { folder: 'Pose Remix', label: dest.label });
          } catch (fileErr) {
            notify(fileErr.message || `Could not file into ${dest.label}`, 'error');
          }
        }
        return true;
      } catch (err) {
        failPending(feedId, err.message || 'Pose remix failed');
        return err.message || 'Pose remix failed';
      }
    };

    // Concurrency 2 — each job holds an HTTP request while Seedream renders.
    // One job per photo per pose: six photos at one pose each is six images, not one blend.
    const queue = sources.flatMap((img, imgIdx) =>
      poses.map((t, poseIdx) => ({ t, i: imgIdx * poses.length + poseIdx, payload: [img] })));
    const failures = [];
    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length) {
        const job = queue.shift();
        if (!job) return;
        const r = await runOne(job.t, job.i, job.payload);
        if (r !== true) failures.push(r);
      }
    });
    await Promise.all(workers);
    setLoading(false);

    const done = poses.length - failures.length;
    if (!failures.length) notify(`Reposed — ${done} image${done === 1 ? '' : 's'} ✨`, 'success');
    else if (!done) notify(`All ${failures.length} failed: ${failures[0]}`, 'error');
    else notify(`${done} done, ${failures.length} failed: ${failures[0]}`, 'error');
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* 1 — the photo */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">1 · Your model's photo</h3>
          <span className="text-[0.6875rem] text-zinc-600 font-mono tabular-nums">{images.length}/{MAX_IMAGES}</span>
        </div>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer?.files); }}
          className={cn('rounded-2xl border-2 border-dashed p-4 transition', dragging ? 'border-rose-500/70 bg-rose-500/10' : 'border-zinc-700/60')}
        >
          {images.length ? (
            <div className="flex flex-wrap gap-2">
              {images.map((img) => (
                <div key={img.id} className="relative w-24 h-32 rounded-lg overflow-hidden border border-zinc-700/50">
                  <img src={img.dataUrl} alt="" className="w-full h-full object-cover" />
                  <button onClick={() => removeImage(img.id)} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-zinc-300 text-xs flex items-center justify-center hover:text-white cursor-pointer">×</button>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-zinc-500">Drop / paste your model's photo here, or use the button below.</p>
          )}
        </div>
        <div className="flex gap-2">
          <label className="inline-flex cursor-pointer items-center rounded-lg border border-white/[0.06] bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-white/[0.07]">
            Upload
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          </label>
          <Btn variant="secondary" className="!rounded-lg" onClick={() => {
            if (!showGallery && !galleryImages.length) fetchGallery();
            setShowGallery((v) => !v);
          }}>
            {showGallery ? 'Hide Library' : 'Pick from Library'}
          </Btn>
          {images.length > 0 && <Btn variant="ghost" className="!rounded-lg" onClick={() => { setImages([]); setAiPose(''); }}>Clear</Btn>}
        </div>

        {showGallery && (
          <div className="pt-1">
            {galleryLoading ? (
              <div className="flex items-center justify-center py-6 text-sm text-zinc-400"><Spinner size={16} /><span className="ml-2">Loading library…</span></div>
            ) : !galleryImages.length ? (
              <p className="py-4 text-center text-xs text-zinc-500">Nothing in your Library yet.</p>
            ) : (
              <div className="grid [grid-template-columns:repeat(auto-fill,minmax(80px,1fr))] gap-2 max-h-[240px] overflow-y-auto pr-1">
                {galleryImages.map((img) => (
                  <button key={img.id} onClick={() => pickFromGallery(img.id)}
                    className="relative aspect-square overflow-hidden rounded-lg border border-zinc-800/60 transition-all hover:border-rose-500/60 hover:scale-[1.03] cursor-pointer">
                    <img src={galleryApi.thumbUrl(img.id)} alt="" className="h-full w-full object-cover bg-zinc-950" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* 2 — the vibe */}
      <Card className="p-4 space-y-3">
        <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">2 · Pick a vibe</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {VIBES.map((v) => (
            <button
              key={v.key}
              onClick={() => pickVibe(v.key)}
              className={cn('rounded-xl border py-3 text-sm font-semibold transition cursor-pointer',
                vibe === v.key ? 'border-rose-500 bg-rose-500/15 text-white' : 'border-zinc-700/60 bg-white/[0.02] text-zinc-400 hover:text-white hover:border-zinc-500')}
            >
              <span className="mr-1">{v.emoji}</span>{v.label}
            </button>
          ))}
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-zinc-800/60 bg-black/20 p-2.5">
          <div className="flex-1">
            <p className="text-[0.625rem] font-semibold uppercase tracking-wider text-zinc-600">
              {suggesting ? 'Reading your photo…' : aiPose ? 'AI read your photo' : 'Built-in pose'}
            </p>
            <p className="mt-0.5 text-[0.75rem] leading-relaxed text-zinc-400">{suggesting ? '…' : pose}</p>
          </div>
          <div className="flex shrink-0 flex-col gap-1">
            <button onClick={() => suggestPose(vibe)} disabled={!images.length || suggesting} title="Read the photo again for a new pose"
              className="rounded-md border border-cyan-700/60 bg-cyan-950/40 px-2 py-1 text-[0.6875rem] text-cyan-300 hover:text-cyan-100 disabled:opacity-40 cursor-pointer">↻ Re-read</button>
            <button onClick={shufflePose} title="Use a built-in pose instead"
              className="rounded-md border border-zinc-700/60 bg-white/[0.03] px-2 py-1 text-[0.6875rem] text-zinc-400 hover:text-white cursor-pointer">Built-in</button>
          </div>
        </div>
      </Card>

      {/* 3 — expression */}
      <Card className="p-4 space-y-3">
        <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
          3 · Facial expression <span className="text-zinc-600 font-normal normal-case">optional</span>
        </h3>
        <div className="flex flex-wrap gap-2">
          {EXPRESSIONS.map((e) => (
            <button
              key={e.key}
              onClick={() => setExpression(e.key)}
              className={cn('rounded-full border px-3 py-1.5 text-xs font-medium transition cursor-pointer',
                expression === e.key ? 'border-rose-500 bg-rose-500/15 text-white' : 'border-zinc-700/60 bg-white/[0.02] text-zinc-400 hover:text-white hover:border-zinc-500')}
            >
              {e.label}
            </button>
          ))}
        </div>
        {exprByKey(expression).text ? (
          <p className="text-[0.6875rem] leading-relaxed text-zinc-500">{exprByKey(expression).text}</p>
        ) : (
          <p className="text-[0.6875rem] text-zinc-600">Her expression stays exactly as in the photo.</p>
        )}
      </Card>

      {/* 4 — settings + go */}
      <Card className="p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Select label="Aspect Ratio" options={ASPECT_OPTIONS} value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} />
          <Select label="Resolution" options={RES_OPTIONS} value={resolution} onChange={(e) => setResolution(e.target.value)} />
        </div>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-zinc-400">How many — each a different pose</span>
          <div className="flex gap-2">
            {[1, 2, 4, 6, 8].map((n) => (
              <button key={n} onClick={() => setCount(n)}
                className={cn('flex-1 rounded-lg border py-2 text-sm font-semibold transition cursor-pointer',
                  count === n ? 'border-rose-500 bg-rose-500/15 text-white' : 'border-zinc-700/60 bg-white/[0.02] text-zinc-400 hover:text-white')}>
                {n}
              </button>
            ))}
          </div>
        </div>
        {/* Chosen before the run, beside the price — this tab used to file nowhere at all, so
            results existed only in the gallery and on the feed. */}
        <LibraryDestinationPicker value={dest.destDb} onChange={dest.setDestDb} />
        <LibraryDestinationNote value={dest.destDb} />
        <Btn onClick={handleGenerate} disabled={loading} className="w-full">
          {loading ? <Spinner size={16} /> : null}
          {loading ? `Reposing ${jobTotal}…` : `Repose ${jobTotal} image${jobTotal === 1 ? '' : 's'} · ${vibeByKey(vibe).label} · $${cost.toFixed(3)}`}
        </Btn>
      </Card>

      {results.length > 0 && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Result</h3>
            <Badge color="green">{results.length}</Badge>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {results.map((r, i) => (
              <ImageCard key={r.galleryId || r.imageId || i} src={r.galleryId ? `/api/gallery/${r.galleryId}/image` : `data:${r.mimeType};base64,${r.base64Data}`} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
