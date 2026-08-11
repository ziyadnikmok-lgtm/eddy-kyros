import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { seedanceOmni as omniApi, video as videoApi, gallery as galleryApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Select, Slider, Textarea, Input, Badge, Spinner } from '../components/UI';
import {
  OMNI_MODELS, OMNI_MAX_VIDEOS, OMNI_MAX_IMAGES, OMNI_TRAIN_COST, OMNI_VIDEO_MAX_SECONDS,
  MUAPI_MAX_VIDEO_BYTES, MUAPI_MAX_IMAGE_BYTES,
  SEEDANCE_ASPECT_RATIOS, SEEDANCE_DURATION_MIN, SEEDANCE_DURATION_MAX, SEEDANCE_DURATION_DEFAULT,
} from '../config/photoModes';
import { pushPending, resolvePending, rejectPending, attachTaskId, failPending } from '../lib/generationFeed';
import { loadOmniCharacters, saveOmniCharacter, removeOmniCharacter } from '../lib/omniCharacterStore';
import { createPageStore } from '../lib/pageStateStore';
import { createEddyCollection } from '../lib/eddyCollectionStore';
import { cn } from '../lib/utils';

const MODEL_MAP = Object.fromEntries(OMNI_MODELS.map((m) => [m.id, m]));
const ASPECT_OPTIONS = SEEDANCE_ASPECT_RATIOS.map((r) => ({ value: r, label: r }));
const SPEND_KEY = 'kyros.omni.sessionSpend';

// One shared base per dress state, so the three presets can't drift apart.
const NO_AUDIO = ' Silent video, no audio, no speech, no music.';
// The user's proven-working wording — leads with "Recreate @video1 exactly" and states the
// swap as "The ONLY change is WHO it is". Do NOT rephrase to "The woman in this video IS…".
const OMNI_BASE = 'Recreate @video1 exactly: same motion, timing, camera movement, framing, pacing, outfit, setting and lighting. The ONLY change is WHO it is — the person is @image1: her face, identity, body AND her hair (colour, length and style) all come from @image1, never from @video1. Everything else comes from @video1, including the clothing she wears.';
const OMNI_BASE_NUDE = 'Recreate @video1 exactly: same motion, timing, camera movement, framing, pacing, setting and lighting. The ONLY change is WHO it is — the person is @image1: her face, identity, body AND her hair (colour, length and style) all come from @image1, never from @video1. She is nude, exactly as in @video1. Everything else comes from @video1.';

const PROMPT_PRESETS = [
  { label: 'Copy video · large breast', text: `${OMNI_BASE} Also give her a large breast.${NO_AUDIO}` },
  { label: 'Copy video · bigger breast', text: `${OMNI_BASE} Also give her a very large, full breast.${NO_AUDIO}` },
  { label: 'Copy video · NSFW', text: `${OMNI_BASE_NUDE} Also give her a large breast.${NO_AUDIO}` },
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

/**
 * Preview for a reference clip.
 *
 * Decodes the base64 itself rather than going through `fetch(dataUrl)`. fetch was throwing on
 * these clips — reported as "Preview unavailable", which ruled out the codec — and it is the
 * wrong tool anyway: it runs the data through the network stack (CSP, URL-size limits, an
 * async round trip) to reach bytes that are already sitting in memory. atob + Blob cannot fail
 * for that class of reason.
 *
 * Why a blob URL at all: <video src="data:video/...;base64,..."> does not play in Chromium —
 * its media stack wants byte-range requests, which data: URLs don't serve.
 *
 * The failure states are kept distinct on purpose. A black rectangle looks the same whether
 * the bytes never arrived or the codec (H.265/MOV) can't decode, and guessing between them
 * cost real time here.
 */
function VideoThumb({ dataUrl, className }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState('');

  useEffect(() => {
    if (!dataUrl) return undefined;
    setFailed('');
    setUrl(null);

    let objectUrl;
    try {
      const comma = String(dataUrl).indexOf(',');
      const head = String(dataUrl).slice(0, comma);
      const b64 = String(dataUrl).slice(comma + 1);
      const mime = (head.match(/data:([^;]+)/) || [])[1] || 'video/mp4';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      setUrl(objectUrl);
    } catch {
      setFailed('read');
    }

    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [dataUrl]);

  if (failed) {
    return (
      <div className={cn(className, 'flex flex-col items-center justify-center gap-1 px-2 text-center')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-zinc-500">
          <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" />
        </svg>
        <span className="text-[0.5625rem] leading-tight text-zinc-400">
          {failed === 'codec' ? "Can't preview this codec (H.265/MOV)" : 'Could not read the clip'}
        </span>
        <span className="text-[0.5rem] leading-tight text-zinc-600">Uploads and generates fine</span>
      </div>
    );
  }

  return (
    <video
      src={url || undefined}
      className={className}
      muted
      loop
      autoPlay
      playsInline
      onError={() => setFailed('codec')}
    />
  );
}

/**
 * Read a video's duration client-side so we can warn before paying for a rejected job.
 *
 * Takes the File and probes a blob URL. This used to take the data URL and silently returned
 * null for every real clip — same root cause as the black preview: Chromium's media stack
 * refuses a multi-MB data: URL outright. A null here also meant the "clip is over 15s" warning
 * never fired and the duration never matched the clip.
 */
function probeVideoSeconds(file) {
  return new Promise((resolve) => {
    if (!file) { resolve(null); return; }
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    const done = (value) => { URL.revokeObjectURL(url); resolve(value); };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    v.src = url;
  });
}

const _cache = {
  model: 'omni-fast',
  prompt: '',
  duration: SEEDANCE_DURATION_DEFAULT,
  aspectRatio: '9:16',
  quality: 'high',
};
// Reference clips run to 50MB — far past _cache/localStorage. IndexedDB so an uploaded video
// survives a reload instead of having to be re-dragged.
const store = createPageStore('kyros-seedance-omni-state');

export default function SeedanceOmniPage() {
  const { notify } = useApp();

  /**
   * HER PHOTOS COME FROM EDDY, not from the server's character list (owner, 2026-08-11).
   *
   * NOTE the name clash this page already had: `characters` below is Omni's TRAINED characters
   * (omniCharacterStore) — a Muapi feature, completely unrelated. These are Eddy's, so they are
   * named for what they are and cannot be confused with them.
   */
  const charStore = useMemo(() => createEddyCollection('eddy-character'), []);
  const [eddyChars, setEddyChars] = useState([]);        // folders in eddy-character
  const [eddyCharItems, setEddyCharItems] = useState([]);
  const [eddyCharThumbs, setEddyCharThumbs] = useState({});
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [f, i] = await Promise.all([charStore.listFolders(), charStore.listItems()]);
        const map = {};
        await Promise.all(i.map(async (it) => { map[it.id] = it.url || await charStore.getImage(it.id); }));
        if (!alive) return;
        setEddyChars(f); setEddyCharItems(i); setEddyCharThumbs(map);
      } catch { /* an unreadable collection shows an empty picker, not a broken page */ }
    })();
    return () => { alive = false; };
  }, [charStore]);

  // Base face first — the leading reference is the one the model treats as the primary subject.
  // Same ranking Photo Match and the Seedance Video tab use, so she behaves the same everywhere.
  const refsForCharacter = useCallback((id) => {
    if (!id) return [];
    const mine = eddyCharItems.filter((i) => i.folderId === id);
    const rank = (i) => (i.role === 'base' ? 0 : i.role === 'body' ? 1 : 2);
    return [...mine].sort((a, b) => rank(a) - rank(b) || (a.createdAt || 0) - (b.createdAt || 0));
  }, [eddyCharItems]);

  const [model, setModel] = useState(_cache.model);
  const [prompt, setPrompt] = useState(_cache.prompt);
  const [duration, setDuration] = useState(_cache.duration);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [quality, setQuality] = useState(_cache.quality);

  const [videos, setVideos] = useState([]); // [{id, dataUrl, seconds}]
  const [images, setImages] = useState([]); // [{id, dataUrl}]
  // Character shortcut for Reference Images. Not persisted: it resets after each add so the same
  // character can be added again, and the IMAGES themselves are what the page already saves.
  const [characterId, setCharacterId] = useState('');
  const [charLoading, setCharLoading] = useState(false);
  const [dragging, setDragging] = useState(null);

  const [characters, setCharacters] = useState([]);
  const [trainOpen, setTrainOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteName, setPasteName] = useState('');
  const [pasteId, setPasteId] = useState('');
  const [trainName, setTrainName] = useState('');
  const [trainImg, setTrainImg] = useState(null);
  const [training, setTraining] = useState(false);

  const [galleryImages, setGalleryImages] = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [showGallery, setShowGallery] = useState(false);

  const [jobs, setJobs] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const jobsRef = useRef([]);
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);

  const [sessionSpend, setSessionSpend] = useState(() => {
    try { return Number(sessionStorage.getItem(SPEND_KEY)) || 0; } catch { return 0; }
  });
  useEffect(() => { try { sessionStorage.setItem(SPEND_KEY, String(sessionSpend)); } catch { /* ignore */ } }, [sessionSpend]);

  // Restore the reference media and prompt that were on the page last time.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [v, i, p] = await Promise.all([
        store.get('videos', []), store.get('images', []), store.get('prompt', ''),
      ]);
      if (cancelled) return;
      // Never clobber: this resolves asynchronously, so anything already added to the page
      // while it was loading wins.
      if (Array.isArray(v) && v.length) setVideos((cur) => (cur.length ? cur : v));
      if (Array.isArray(i) && i.length) setImages((cur) => (cur.length ? cur : i));
      if (p) setPrompt((cur) => cur || p);
      setRestored(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist only after the restore has run, or the first empty render would wipe the save.
  useEffect(() => { if (restored) store.set('videos', videos); }, [videos, restored]);
  useEffect(() => { if (restored) store.set('images', images); }, [images, restored]);
  useEffect(() => { if (restored) store.set('prompt', prompt); }, [prompt, restored]);

  useEffect(() => { _cache.model = model; }, [model]);
  useEffect(() => { _cache.prompt = prompt; }, [prompt]);
  useEffect(() => { _cache.duration = duration; }, [duration]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.quality = quality; }, [quality]);

  useEffect(() => { loadOmniCharacters().then(setCharacters); }, []);

  const modelInfo = MODEL_MAP[model] || OMNI_MODELS[0];
  // Muapi bills the ACTUAL output length, and with a reference clip the output follows the
  // CLIP, not the duration we ask for. Measured: a 5s request against a 6.8s clip was billed
  // $1.428 = 6.8 x $0.21, not the $1.05 this page quoted. Quoting the slider under-charges the
  // estimate every time the clip isn't exactly that long.
  const refSeconds = videos.find((v) => v.seconds)?.seconds || null;
  const billedSeconds = refSeconds ? Math.max(duration, refSeconds) : duration;
  const estimatedCost = billedSeconds * modelInfo.pricePerSecond;
  const clipDrivesCost = refSeconds != null && refSeconds > duration;

  const updateJob = useCallback((id, patch) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  // One ticker polls every running job via the shared video status route.
  useEffect(() => {
    const iv = setInterval(async () => {
      const running = jobsRef.current.filter((j) => j.status === 'processing' && j.taskId);
      if (!running.length) return;
      setJobs((prev) => prev.map((j) => (j.status === 'processing' ? { ...j, elapsed: Math.floor((Date.now() - j.startedAt) / 1000) } : j)));

      for (const job of running) {
        try {
          const data = await videoApi.status(job.taskId);
          if (data.status === 'completed') {
            const url = data.localFilename ? videoApi.fileUrl(data.localFilename) : (data.outputs?.[0] || data.videoUrl || '');
            updateJob(job.id, { status: 'done', videoUrl: url });
            resolvePending(job.feedId, {
              isVideo: true, videoUrl: url, prompt: job.feedPrompt, imageModel: job.modelLabel,
              aspectRatio: job.aspectRatio, resolutionTier: `${job.duration}s`, generatedAt: Date.now(),
            });
            setSessionSpend((s) => s + job.cost);
            notify('Omni video ready 🎬', 'success');
          } else if (data.status === 'failed') {
            updateJob(job.id, { status: 'failed', error: data.error || 'Generation failed' });
            failPending(job.feedId, data.error);
            notify(data.error || 'Omni generation failed', 'error');
          }
        } catch { /* transient — keep polling */ }
      }
    }, 2500);
    return () => clearInterval(iv);
  }, [updateJob, notify]);

  // ── assets ─────────────────────────────────────────────────────────────────
  const addVideos = useCallback(async (files) => {
    const room = OMNI_MAX_VIDEOS - videos.length;
    if (room <= 0) { notify(`Maximum ${OMNI_MAX_VIDEOS} reference videos`, 'error'); return; }
    const all = Array.from(files || []).filter((f) => /^video\//i.test(f.type));
    if (!all.length) { notify('Please use MP4/MOV/WebM video files', 'error'); return; }
    const oversized = all.filter((f) => f.size > MUAPI_MAX_VIDEO_BYTES);
    if (oversized.length) notify(`${oversized.length} clip${oversized.length > 1 ? 's exceed' : ' exceeds'} Muapi's 50MB upload limit — skipped`, 'error');
    const valid = all.filter((f) => f.size <= MUAPI_MAX_VIDEO_BYTES).slice(0, room);
    if (!valid.length) return;
    const added = [];
    for (const f of valid) {
      const dataUrl = await fileToDataUrl(f);
      const seconds = await probeVideoSeconds(f);
      added.push({ id: `v-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, dataUrl, seconds });
    }
    setVideos((prev) => [...prev, ...added]);
    // Omni recreates the reference clip's motion, so rendering 5s of an 8s reference would cut
    // it off. Snap the output length to the clip, clamped to what the API accepts.
    const refSeconds = added.find((a) => a.seconds)?.seconds;
    if (refSeconds) {
      const snapped = Math.min(SEEDANCE_DURATION_MAX, Math.max(SEEDANCE_DURATION_MIN, Math.round(refSeconds)));
      setDuration(snapped);
      if (snapped !== Math.round(refSeconds)) notify(`Clip is ${Math.round(refSeconds)}s — duration set to ${snapped}s (the ${SEEDANCE_DURATION_MIN}-${SEEDANCE_DURATION_MAX}s limit)`, 'info');
      else notify(`Duration matched to the clip: ${snapped}s`, 'success');
    }
    const tooLong = added.filter((a) => a.seconds && a.seconds > OMNI_VIDEO_MAX_SECONDS);
    if (tooLong.length) notify(`${tooLong.length} clip${tooLong.length > 1 ? 's are' : ' is'} over ${OMNI_VIDEO_MAX_SECONDS}s — Muapi may reject it`, 'error');
  }, [videos.length, notify]);

  const addImages = useCallback(async (files) => {
    const room = OMNI_MAX_IMAGES - images.length;
    if (room <= 0) { notify(`Maximum ${OMNI_MAX_IMAGES} reference images`, 'error'); return; }
    const all = Array.from(files || []).filter((f) => /^image\/(png|jpeg|jpg|webp)$/i.test(f.type));
    const tooBig = all.filter((f) => f.size > MUAPI_MAX_IMAGE_BYTES);
    if (tooBig.length) notify(`${tooBig.length} image${tooBig.length > 1 ? 's exceed' : ' exceeds'} Muapi's 10MB limit — skipped`, 'error');
    const valid = all.filter((f) => f.size <= MUAPI_MAX_IMAGE_BYTES).slice(0, room);
    if (!valid.length) return;
    const added = await Promise.all(valid.map(async (f) => ({
      id: `i-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      dataUrl: await fileToDataUrl(f),
    })));
    setImages((prev) => [...prev, ...added]);
  }, [images.length, notify]);

  /**
   * Load EVERY photo a Character has straight into Reference Images.
   *
   * Omni genuinely takes multiple reference images (createOmniTask uploads each and sends them all
   * as images_list), which is exactly what the Seedance 2 page cannot do — that model turns ONE
   * image into the first frame. So here "use a character" means all of her, actually sent.
   *
   * APPENDS rather than replaces, and respects the remaining room, so a character can be combined
   * with images already added by hand instead of wiping them.
   */
  const addCharacterImages = useCallback(async (id) => {
    setCharacterId(id);
    if (!id) return;
    const mine = refsForCharacter(id);
    if (!mine.length) { notify('That character has no photos yet — add some on the Eddy · Character tab', 'error'); return; }

    const room = OMNI_MAX_IMAGES - images.length;
    if (room <= 0) { notify(`Maximum ${OMNI_MAX_IMAGES} reference images`, 'error'); return; }
    const take = mine.slice(0, room);
    setCharLoading(true);
    try {
      const added = [];
      for (const it of take) {
        // Already in memory for the picker; getImage is the fallback for anything not thumbed yet.
        // eslint-disable-next-line no-await-in-loop -- reads from IndexedDB, not the network
        const dataUrl = eddyCharThumbs[it.id] || await charStore.getImage(it.id);
        if (dataUrl) added.push({ id: `i-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, dataUrl });
      }
      if (!added.length) { notify('Could not read that character’s photos', 'error'); return; }
      setImages((prev) => [...prev, ...added]);
      const skipped = mine.length - take.length;
      notify(
        `Added ${added.length} photo${added.length === 1 ? '' : 's'}${skipped ? ` — ${skipped} skipped, only ${OMNI_MAX_IMAGES} fit` : ''}`,
        skipped ? 'error' : 'success',
      );
    } finally {
      setCharLoading(false);
      setCharacterId('');   // reset so the same character can be added again if there is room
    }
  }, [refsForCharacter, eddyCharThumbs, charStore, images.length, notify]);

  // Ctrl+V → images (videos can't come off the clipboard).
  useEffect(() => {
    const onPaste = async (e) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type?.startsWith('image/'));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      e.preventDefault();
      await addImages([file]);
      notify('Pasted a reference image ✨', 'success');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addImages, notify]);

  const fetchGallery = useCallback(async () => {
    setGalleryLoading(true);
    try {
      const res = await galleryApi.list({ limit: 120 });
      setGalleryImages(res.images || res || []);
    } catch { /* optional */ }
    finally { setGalleryLoading(false); }
  }, []);

  const pickFromGallery = async (imgId) => {
    try {
      const resp = await fetch(galleryApi.imageUrl(imgId), { credentials: 'include' });
      if (!resp.ok) throw new Error('Failed to load image');
      const blob = await resp.blob();
      await addImages([new File([blob], 'gallery', { type: blob.type })]);
      setShowGallery(false);
    } catch (err) {
      notify(err.message || 'Failed to load gallery image', 'error');
    }
  };

  const insertToken = (token) => setPrompt((p) => (p ? `${p.trim()} ${token}` : token));

  // ── character training ─────────────────────────────────────────────────────
  const handleAddExisting = async () => {
    const id = pasteId.trim();
    const name = pasteName.trim();
    if (!/^char_/.test(id)) { notify('Paste the character id — it starts with char_', 'error'); return; }
    if (!name) { notify('Give the character a name', 'error'); return; }
    await saveOmniCharacter({ id: `oc-${Date.now()}`, characterId: id, name, thumb: null, createdAt: Date.now() });
    setCharacters(await loadOmniCharacters());
    setPasteOpen(false); setPasteName(''); setPasteId('');
    notify(`Added "${name}" ✨`, 'success');
  };

  const handleTrain = async () => {
    if (!trainImg) { notify('Add a clear face photo', 'error'); return; }
    if (!trainName.trim()) { notify('Give the character a name', 'error'); return; }
    const parsed = parseDataUrl(trainImg);
    if (!parsed) { notify('Could not read that photo', 'error'); return; }

    setTraining(true);
    try {
      const res = await omniApi.trainCharacter({
        imageBase64: parsed.base64,
        mimeType: parsed.mimeType,
        characterName: trainName.trim(),
      });

      let characterId = res.characterId;
      // Training is async — poll until the id lands (a few seconds, ~2min ceiling).
      if (!characterId && res.requestId) {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline && !characterId) {
          await new Promise((r) => setTimeout(r, 2500));
          try {
            const st = await omniApi.trainStatus(res.requestId);
            if (st.status === 'completed') { characterId = st.characterId; break; }
            if (st.status === 'failed') throw new Error(st.error || 'Training failed');
          } catch (e) {
            if (/failed/i.test(e.message)) throw e;
          }
        }
      }
      if (!characterId) throw new Error('Training timed out before returning a character id');

      const item = {
        id: `oc-${Date.now()}`, characterId, name: trainName.trim(),
        thumb: trainImg, createdAt: Date.now(),
      };
      await saveOmniCharacter(item);
      setCharacters(await loadOmniCharacters());
      setSessionSpend((s) => s + OMNI_TRAIN_COST);
      setTrainOpen(false);
      setTrainName('');
      setTrainImg(null);
      notify(`Character "${item.name}" trained ✨`, 'success');
    } catch (err) {
      notify(err.message || 'Character training failed', 'error');
    } finally {
      setTraining(false);
    }
  };

  // ── run ────────────────────────────────────────────────────────────────────
  // "Advanced" — Gemini watches the reference clip and writes a full structured prompt
  // (CHARACTERS/ENVIRONMENT, SETTING, CAMERA, STORY BEATS, STYLE, IMPORTANT). Identity still
  // comes from @image1; the analyser is told never to describe the woman in the clip.
  const analyzeClip = async () => {
    const v = videos[0];
    if (!v) { notify('Upload a reference video first', 'error'); return; }
    if (!images.length) notify('Tip: add her photo first so it can read her hair colour', 'info');
    const parsed = parseDataUrl(v.dataUrl);
    if (!parsed) { notify('Could not read the clip', 'error'); return; }
    setAnalyzing(true);
    try {
      // Send @image1 too — the analyser looks at HER to write the real hair colour/build into
      // the prompt, instead of leaving hair to be guessed (or taken from the clip).
      const ref = images[0] ? parseDataUrl(images[0].dataUrl) : null;
      const data = await omniApi.analyzeVideo(parsed.base64, parsed.mimeType, ref?.base64, ref?.mimeType);
      if (!data?.prompt) throw new Error('No prompt came back');
      setPrompt(data.prompt);
      notify('Clip analysed — prompt written ✨', 'success');
    } catch (err) {
      notify(err.message || 'Could not analyse the clip', 'error');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) { notify('Write a prompt — it is the only required field', 'error'); return; }
    if (!videos.length && !images.length) {
      notify('Add a reference video and a photo of your model', 'error');
      return;
    }
    // Muapi drops the trained character (@omni-character) and re-renders the video with the
    // ORIGINAL person when no reference image is sent — that wasted a paid generation. Require
    // an actual photo whenever a video is being reposed.
    if (videos.length && !images.length) {
      notify('Upload a PHOTO of your model in Reference Images — the trained character alone is unreliable and often ignored, wasting the generation.', 'error');
      return;
    }

    const jobId = `omni-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const feedId = `omni-feed-${jobId}`;
    const feedPrompt = prompt.trim().slice(0, 120);

    setJobs((prev) => [{
      id: jobId, feedId, feedPrompt, status: 'submitting',
      thumb: images[0]?.dataUrl || null, modelLabel: modelInfo.label,
      duration, aspectRatio, cost: estimatedCost, startedAt: Date.now(),
      elapsed: 0, taskId: null, videoUrl: null, error: null,
    }, ...prev]);

    pushPending({ id: feedId, prompt: feedPrompt, imageModel: modelInfo.label, aspectRatio, resolutionTier: `${duration}s`, isVideo: true });

    setSubmitting(true);
    try {
      const body = {
        model,
        prompt: prompt.trim(),
        aspectRatio,
        duration,
        images: images.map((i) => parseDataUrl(i.dataUrl)).filter(Boolean),
        videos: videos.map((v) => parseDataUrl(v.dataUrl)).filter(Boolean),
      };
      if (modelInfo.quality) body.quality = quality;

      const res = await omniApi.generate(body);
      updateJob(jobId, { status: 'processing', taskId: res.taskId, startedAt: Date.now() });
      // Give the feed the taskId so it can finish the card itself. Renders continue on the
      // server after this page unmounts; without this the card spins forever while the file
      // quietly lands in Library.
      attachTaskId(feedId, res.taskId);
      notify('Omni job queued 🎬 — you can queue another', 'success');
    } catch (err) {
      updateJob(jobId, { status: 'failed', error: err.message || 'Failed to start' });
      rejectPending(feedId);
      notify(err.message || 'Failed to start Omni generation', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const runningCount = jobs.filter((j) => j.status === 'processing' || j.status === 'submitting').length;

  return (
    <div className="space-y-6 animate-in">
      {/* Title/description now come from the app header — this row carries only what's
          unique to this page. */}
      <div className="flex items-center justify-end">
        <div className="text-right">
          <div className="text-[0.625rem] uppercase tracking-wider text-zinc-600 font-bold">Session spend</div>
          <div className="text-sm font-mono tabular-nums text-rose-300 font-semibold">${sessionSpend.toFixed(2)}</div>
        </div>
      </div>

      <div className="space-y-4">
        {/* Reference videos */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
              Reference Videos <span className="text-zinc-600 font-normal normal-case">@video1–@video{OMNI_MAX_VIDEOS}</span>
            </h3>
            <span className="text-[0.6875rem] text-zinc-600 font-mono tabular-nums">{videos.length}/{OMNI_MAX_VIDEOS}</span>
          </div>
          <div
            className={cn('rounded-xl border-2 border-dashed p-3 transition-colors', dragging === 'video' ? 'border-rose-500 bg-rose-500/[0.06]' : 'border-zinc-800/60')}
            onDragOver={(e) => { e.preventDefault(); setDragging('video'); }}
            onDragLeave={() => setDragging(null)}
            onDrop={(e) => { e.preventDefault(); setDragging(null); addVideos(e.dataTransfer.files); }}
          >
            {videos.length ? (
              <div className="grid [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] gap-2">
                {videos.map((v, i) => (
                  <div key={v.id} className="relative">
                    <VideoThumb dataUrl={v.dataUrl} className="w-full aspect-video object-cover rounded-lg border border-zinc-800/60 bg-black" />
                    <span className="absolute bottom-1 left-1 rounded bg-black/75 px-1.5 py-px text-[0.5625rem] font-mono text-rose-300">@video{i + 1}</span>
                    {v.seconds != null && (
                      <span className={cn('absolute bottom-1 right-1 rounded bg-black/75 px-1.5 py-px text-[0.5625rem] font-mono',
                        v.seconds > OMNI_VIDEO_MAX_SECONDS ? 'text-red-400' : 'text-zinc-400')}>
                        {v.seconds.toFixed(1)}s
                      </span>
                    )}
                    <button onClick={() => setVideos((prev) => prev.filter((x) => x.id !== v.id))}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 text-xs flex items-center justify-center hover:text-white cursor-pointer">×</button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-zinc-600">
                Drag reel clips here — MP4, max {OMNI_VIDEO_MAX_SECONDS}s each
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className="cursor-pointer">
              <input type="file" multiple accept="video/mp4,video/quicktime,video/webm" className="hidden"
                onChange={(e) => { addVideos(e.target.files); e.target.value = ''; }} />
              <span className="inline-block"><Btn variant="secondary" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem] pointer-events-none">Upload video</Btn></span>
            </label>
            {videos.length > 0 && <Btn variant="ghost" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem]" onClick={() => setVideos([])}>Clear</Btn>}
            <span className="text-[0.625rem] text-zinc-600">Grab a clip with Frame Grabber → Download Video</span>
          </div>
        </Card>

        {/* Reference images */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
              Reference Images <span className="text-zinc-600 font-normal normal-case">@image1–@image{OMNI_MAX_IMAGES}</span>
            </h3>
            <div className="flex items-center gap-2">
              {/* Pick a character and ALL her photos are added as real reference images — Omni sends
                  every one of them (images_list), unlike Seedance 2 which takes a single first frame.
                  Appends, so it stacks with anything already added by hand. */}
              <select
                value={characterId}
                onChange={(e) => addCharacterImages(e.target.value)}
                disabled={charLoading || images.length >= OMNI_MAX_IMAGES}
                title="Add every photo this character has as reference images"
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 focus:border-rose-500 focus:outline-none disabled:opacity-50"
              >
                <option value="">+ Character…</option>
                {/* The photo count is in the label: it is how many reference slots she will take,
                    and this select is next to the x/OMNI_MAX_IMAGES counter it eats into. */}
                {eddyChars.map((c) => {
                  const n = refsForCharacter(c.id).length;
                  return <option key={c.id} value={c.id}>{c.name || 'Unnamed'} ({n})</option>;
                })}
              </select>
              {charLoading && <Spinner size={14} />}
              <Badge color="zinc">Ctrl+V</Badge>
              <span className="text-[0.6875rem] text-zinc-600 font-mono tabular-nums">{images.length}/{OMNI_MAX_IMAGES}</span>
            </div>
          </div>
          <div
            className={cn('rounded-xl border-2 border-dashed p-3 transition-colors', dragging === 'image' ? 'border-rose-500 bg-rose-500/[0.06]' : 'border-zinc-800/60')}
            onDragOver={(e) => { e.preventDefault(); setDragging('image'); }}
            onDragLeave={() => setDragging(null)}
            onDrop={(e) => { e.preventDefault(); setDragging(null); addImages(e.dataTransfer.files); }}
          >
            {images.length ? (
              <div className="grid [grid-template-columns:repeat(auto-fill,minmax(80px,1fr))] gap-2">
                {images.map((img, i) => (
                  <div key={img.id} className="relative">
                    <img src={img.dataUrl} alt="" className="w-full aspect-[3/4] object-cover rounded-lg border border-zinc-800/60 bg-zinc-950" />
                    <span className="absolute bottom-0.5 left-0.5 rounded bg-black/75 px-1 py-px text-[0.5625rem] font-mono text-rose-300">@image{i + 1}</span>
                    <button onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 text-[0.625rem] flex items-center justify-center hover:text-white cursor-pointer">×</button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-zinc-600">Drag your model's photos here</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className="cursor-pointer">
              <input type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />
              <span className="inline-block"><Btn variant="secondary" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem] pointer-events-none">Upload</Btn></span>
            </label>
            <Btn variant="secondary" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem]" onClick={() => { if (!showGallery && !galleryImages.length) fetchGallery(); setShowGallery((v) => !v); }}>
              {showGallery ? 'Hide Gallery' : 'Gallery'}
            </Btn>
            {images.length > 0 && <Btn variant="ghost" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem]" onClick={() => setImages([])}>Clear</Btn>}
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

        {/* Trained characters */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
              Trained Characters <span className="text-zinc-600 font-normal normal-case">reusable identities</span>
            </h3>
            <div className="flex gap-1.5">
              <Btn variant="secondary" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem]" onClick={() => { setPasteOpen((v) => !v); setTrainOpen(false); }}>
                {pasteOpen ? 'Cancel' : '+ Add existing'}
              </Btn>
              <Btn variant="secondary" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem]" onClick={() => { setTrainOpen((v) => !v); setPasteOpen(false); }}>
                {trainOpen ? 'Cancel' : `+ Train (${'$'}${OMNI_TRAIN_COST.toFixed(2)})`}
              </Btn>
            </div>
          </div>

          {characters.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {characters.map((c) => (
                <div key={c.id} className="relative shrink-0 w-16">
                  <button onClick={() => insertToken(`@omni-character:${c.characterId}`)} title={`Insert @omni-character:${c.characterId}`}
                    className="block w-16 h-20 rounded-lg overflow-hidden border border-zinc-800/60 hover:border-rose-500/60 transition-all cursor-pointer hover:scale-[1.04]">
                    {c.thumb
                      ? <img src={c.thumb} alt={c.name} className="h-full w-full object-cover bg-zinc-950" />
                      : <span className="flex h-full items-center justify-center text-[0.625rem] text-zinc-600">{c.name}</span>}
                  </button>
                  <div className="mt-1 truncate text-center text-[0.5625rem] text-zinc-500" title={c.name}>{c.name}</div>
                  <button onClick={() => removeOmniCharacter(c.id).then(() => loadOmniCharacters().then(setCharacters))} title="Forget (does not refund training)"
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 text-[0.625rem] flex items-center justify-center hover:text-white cursor-pointer">×</button>
                </div>
              ))}
            </div>
          ) : !trainOpen && (
            <p className="text-[0.6875rem] text-zinc-600 leading-relaxed">
              <span className="text-amber-400/90">Unreliable: Muapi often IGNORES the trained character and re-renders the video with the original person, wasting the generation. Uploading her photo in Reference Images is the method that actually works.</span> Train once, reuse as <span className="font-mono text-zinc-400">@omni-character:…</span> — ${OMNI_TRAIN_COST.toFixed(2)}, one time.
            </p>
          )}

          {pasteOpen && (
            <div className="rounded-xl border border-zinc-800/60 bg-white/[0.02] p-3 space-y-2">
              <p className="text-[0.6875rem] text-zinc-500 leading-relaxed">
                Already trained one on the Muapi site? Paste its id here to reuse it — no charge.
              </p>
              <Input label="Character name" placeholder="e.g. Grace" value={pasteName} onChange={(e) => setPasteName(e.target.value)} />
              <Input label="Character id" placeholder="char_1784304891615_n6ocgz" value={pasteId} onChange={(e) => setPasteId(e.target.value)} />
              <Btn onClick={handleAddExisting} className="w-full !py-2 !text-xs">Add character</Btn>
            </div>
          )}

          {trainOpen && (
            <div className="rounded-xl border border-zinc-800/60 bg-white/[0.02] p-3 space-y-3">
              <div className="flex gap-3">
                <label className="relative block w-24 h-32 shrink-0 rounded-lg border-2 border-dashed border-zinc-800/60 hover:border-zinc-600 cursor-pointer overflow-hidden">
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                    onChange={async (e) => { const f = e.target.files?.[0]; if (f) setTrainImg(await fileToDataUrl(f)); e.target.value = ''; }} />
                  {trainImg
                    ? <img src={trainImg} alt="" className="absolute inset-0 h-full w-full object-cover bg-zinc-950" />
                    : <span className="absolute inset-0 flex items-center justify-center px-2 text-center text-[0.625rem] text-zinc-600">Clear face photo</span>}
                </label>
                <div className="flex-1 min-w-0 space-y-2">
                  <Input label="Character name" placeholder="e.g. Sienna" value={trainName} onChange={(e) => setTrainName(e.target.value)} />
                  <p className="text-[0.625rem] text-zinc-600 leading-relaxed">
                    One clear, front-facing portrait works best. Costs <span className="text-zinc-400">${OMNI_TRAIN_COST.toFixed(2)}</span> once — after that she's free to reuse forever.
                  </p>
                </div>
              </div>
              <Btn onClick={handleTrain} disabled={training} className="w-full !py-2 !text-xs">
                {training ? <Spinner size={14} /> : null}
                {training ? 'Training… (can take a minute)' : `Train character · $${OMNI_TRAIN_COST.toFixed(2)}`}
              </Btn>
            </div>
          )}
        </Card>

        {/* Prompt */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Prompt <span className="text-rose-400 font-normal normal-case">required</span></h3>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={analyzeClip} disabled={analyzing || !videos.length}
              title="Gemini or Vertex watches your clip and writes a full structured prompt"
              className="rounded-full border border-cyan-500/50 bg-cyan-500/10 px-2.5 py-1 text-[0.625rem] font-semibold text-cyan-300 hover:border-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer">
              {analyzing ? '⏳ Watching clip…' : '✨ Advanced — analyse video'}
            </button>
            {PROMPT_PRESETS.map((p) => (
              <button key={p.label} type="button"
                onClick={() => setPrompt((prev) => (prev.includes(p.text) ? prev : `${prev ? `${prev.trim()} ` : ''}${p.text}`))}
                className="rounded-full border border-zinc-800/60 bg-white/[0.02] px-2.5 py-1 text-[0.625rem] font-medium text-zinc-400 hover:text-rose-300 hover:border-rose-500/50 transition cursor-pointer">
                + {p.label}
              </button>
            ))}
          </div>
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} maxLength={4000}
            placeholder="@image1 performs exactly the same motion as @video1, same camera movement and framing." />
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap gap-1">
              {videos.map((_, i) => (
                <button key={`v${i}`} onClick={() => insertToken(`@video${i + 1}`)}
                  className="rounded border border-zinc-800/60 px-1.5 py-0.5 text-[0.5625rem] font-mono text-zinc-500 hover:text-rose-300 transition cursor-pointer">@video{i + 1}</button>
              ))}
              {images.map((_, i) => (
                <button key={`i${i}`} onClick={() => insertToken(`@image${i + 1}`)}
                  className="rounded border border-zinc-800/60 px-1.5 py-0.5 text-[0.5625rem] font-mono text-zinc-500 hover:text-rose-300 transition cursor-pointer">@image{i + 1}</button>
              ))}
            </div>
            <span className="text-[0.625rem] text-zinc-600">{prompt.length}/4000</span>
          </div>
        </Card>

        {/* Model */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Model</h3>
          <div className="grid [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] gap-2">
            {/* Hide imagesOnly models here — this page references a VIDEO, which they reject. */}
            {OMNI_MODELS.filter((m) => !m.imagesOnly).map((m) => (
              <button key={m.id} type="button" onClick={() => setModel(m.id)}
                className={cn('text-left rounded-xl border p-3 transition-all duration-200 cursor-pointer',
                  model === m.id ? 'border-rose-500 ring-2 ring-rose-500/25 shadow-lg shadow-rose-500/10 bg-rose-500/[0.04]' : 'border-zinc-800/60 hover:border-zinc-600 bg-white/[0.02]')}>
                <div className="text-xs font-semibold text-zinc-100">{m.label}</div>
                <div className="text-[0.625rem] text-zinc-500 mt-0.5 leading-snug">{m.desc}</div>
                <div className="text-[0.625rem] text-zinc-400 font-mono mt-1.5">${m.pricePerSecond.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}/s</div>
              </button>
            ))}
          </div>
        </Card>

        {/* Settings */}
        <Card className="p-4 space-y-4">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Settings</h3>
          <div className="grid grid-cols-2 gap-4">
            <Select label="Aspect Ratio" options={ASPECT_OPTIONS} value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} />
            {modelInfo.quality && (
              <Select label="Quality" options={[{ value: 'high', label: 'High' }, { value: 'basic', label: 'Basic' }]} value={quality} onChange={(e) => setQuality(e.target.value)} />
            )}
          </div>
          {/* Slider renders "{label}: {value}" itself — don't put the value in the label. */}
          <Slider label="Duration (seconds)" value={duration} min={SEEDANCE_DURATION_MIN} max={SEEDANCE_DURATION_MAX} step={1}
            onChange={(v) => setDuration(typeof v === 'number' ? v : Number(v?.target?.value) || duration)} />
        </Card>

        <Btn onClick={handleGenerate} disabled={submitting} className="w-full">
          {submitting ? <Spinner size={16} /> : null}
          {submitting ? 'Queueing…' : `Generate · ${billedSeconds.toFixed(1)}s · $${estimatedCost.toFixed(2)}`}
        </Btn>
        {clipDrivesCost && (
          <p className="mt-1.5 text-center text-[0.625rem] leading-tight text-amber-400/90">
            Priced on your {refSeconds.toFixed(1)}s clip, not the {duration}s setting — Muapi bills the actual output length, and Omni follows the clip.
          </p>
        )}
        {runningCount > 0 && (
          <p className="text-center text-[0.6875rem] text-zinc-500">{runningCount} rendering — you can queue another.</p>
        )}

        {/* Queue */}
        {jobs.length > 0 && (
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Queue <span className="text-zinc-600 font-normal normal-case">({jobs.length})</span></h3>
              {jobs.some((j) => j.status === 'done' || j.status === 'failed') && (
                <button onClick={() => setJobs((prev) => prev.filter((j) => j.status === 'processing' || j.status === 'submitting'))}
                  className="text-[0.6875rem] text-zinc-500 hover:text-zinc-300 transition cursor-pointer underline">Clear finished</button>
              )}
            </div>
            <div className="space-y-3">
              {jobs.map((job) => (
                <div key={job.id} className="rounded-xl border border-zinc-800/60 bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between gap-2">
                    {job.status === 'done' ? <Badge color="green">Ready</Badge>
                      : job.status === 'failed' ? <Badge color="red">Failed</Badge>
                      : <Badge color="yellow">{job.status === 'submitting' ? 'Uploading…' : `Rendering ${job.elapsed}s`}</Badge>}
                    <span className="text-[0.625rem] text-zinc-600 font-mono tabular-nums">{job.modelLabel} · {job.duration}s · ${job.cost.toFixed(2)}</span>
                  </div>
                  <p className="mt-1.5 text-[0.6875rem] text-zinc-500 line-clamp-2 leading-snug">{job.feedPrompt}</p>
                  {job.status === 'failed' && job.error && <p className="mt-1 text-[0.6875rem] text-red-400 leading-snug">{job.error}</p>}
                  {job.status === 'done' && job.videoUrl && (
                    <video src={job.videoUrl} controls className="mt-2 w-full rounded-lg border border-zinc-800/60 bg-black" />
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
