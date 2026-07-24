import { useState, useEffect, useCallback, useRef } from 'react';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { scene as sceneApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Textarea, Badge, Spinner } from '../components/UI';
import CharacterPicker from '../components/CharacterPicker';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { ASPECT_RATIOS, RESOLUTION_TIERS, IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL, DEFAULT_RESOLUTION_TIER } from '../config/photoModes';
import { makePersistentJobId } from '../lib/persistentPageState';
import { scenePageStore, setQueuePageActive } from '../lib/generationQueues';
import { moveFailedJobsToTool, crossToolLabel } from '../lib/crossToolRetry';
import { markFrameFailed, clearFrameFailed } from '../lib/frameOutcomes';
import { loadSources, saveSources, clearSources } from '../lib/sceneSourceStore';
import { addFramesToLibrary } from '../lib/frameLibrary';
import { consumeSourceHandoff } from '../lib/sourceHandoff';
import { extractOneLink, runWithConcurrency } from '../lib/frameExtract';
import { IconCamera } from 'nucleo-glass';

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

const _cache = {
  sceneData: null,
  editableScene: '',
  selectedCharIds: [],
  aspectRatio: '4:5',
  resolutionTier: DEFAULT_RESOLUTION_TIER,
  imageModel: DEFAULT_IMAGE_MODEL,
  sameBackground: false,
  samePose: false,
  sameHair: false,
  sameTattoos: false,
  provider: 'auto',
  result: null,
  history: [],
};

// Keep concurrency low to stay under Vertex/GCP per-minute image quota.
const MAX_RUNNING_SCENE_JOBS = 2;
// Stagger dispatch so two jobs don't burst the API at the same instant.
const DISPATCH_STAGGER_MS = 1500;
// Rate-limited jobs auto-retry on a backoff: short first (the GCP quota usually frees
// within seconds), then longer if it keeps failing. Far snappier than a flat wait.
const RATE_LIMIT_COOLDOWN_BASE_MS = 8000;
const RATE_LIMIT_COOLDOWN_MAX_MS = 45000;
const rateLimitCooldown = (attempts) => Math.min(RATE_LIMIT_COOLDOWN_BASE_MS * (2 ** Math.max(0, (attempts || 1) - 1)), RATE_LIMIT_COOLDOWN_MAX_MS);
const MAX_RATE_LIMIT_RETRIES = 12;
// After this many failed attempts, give up and mark the frame Failed (Frame Library filter).
const GIVE_UP_AFTER_ATTEMPTS = 5;
// Cooldown before a non-rate-limit error is auto-retried (when "keep retrying" is on).
const AUTO_RETRY_COOLDOWN_MS = 8000;
const isRateLimitMessage = (msg) => /rate limit|quota|resource[_ ]exhausted|\b429\b/i.test(String(msg || ''));
// Errors that can never succeed on retry — never auto-loop these.
const isPermanentFailure = (msg) => /source image was removed|no character identity|add it again/i.test(String(msg || ''));
// A job is eligible for automatic re-queue when its cooldown has elapsed.
// Auto-retry is fully governed by the "Keep retrying" toggle: on = retry every non-permanent
// failure (incl. rate-limits) until it succeeds; off = fully manual (nothing auto-retries).
function isAutoRetryReady(job, now, autoRetryAll) {
  if (!autoRetryAll) return false;
  if (job.status !== 'error' || job.permanent) return false;
  if (!job.retryAt || now < job.retryAt) return false;
  return true;
}
const SCENE_RECREATE_SOURCE_STORAGE_KEY = 'kyros.sceneRecreate.sources';
const SCENE_RECREATE_PROVIDER_KEY = 'kyros.sceneRecreate.provider';
const SCENE_RECREATE_AUTORETRY_KEY = 'kyros.sceneRecreate.autoRetryAll';

function readStoredSourceFiles() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SCENE_RECREATE_SOURCE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object' && item.dataUrl) : [];
  } catch { return []; }
}

function dataUrlToFile(dataUrl, filename = 'scene-recreate-source.png') {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const [, mimeType, base64] = match;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const ext = mimeType.split('/')[1] || 'png';
  return new File([bytes], filename.includes('.') ? filename : `${filename}.${ext}`, { type: mimeType });
}

function resizeAndCompressImage(file, maxDimension = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    // Only compress images larger than 500KB
    if (file.size <= 500 * 1024) {
      resolve(file);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
        canvas.toBlob((blob) => {
          if (!blob) {
            resolve(file);
            return;
          }
          const compressedFile = new File([blob], file.name, {
            type: 'image/jpeg',
            lastModified: Date.now()
          });
          resolve(compressedFile);
        }, 'image/jpeg', quality);
      };
      img.onerror = () => resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

export default function SceneRecreatePage() {
  const { notify, characters: chars, navigateTo } = useApp();
  const { LightboxComponent } = useImageLightbox();
  const initialStoreState = scenePageStore.getSnapshot();
  const fileInputRef = useRef(null);
  const filesRef = useRef([]);
  const runningJobsRef = useRef(new Set());
  // Source images are hydrated from IndexedDB on mount (see hydrate effect below).
  const [files, setFiles] = useState([]);
  const hydratedRef = useRef(false);
  // Gate job dispatch until sources have loaded from IndexedDB (see PhotoMatch note).
  const [sourcesHydrated, setSourcesHydrated] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [sceneData, setSceneData] = useState(initialStoreState.sceneData);
  const [editableScene, setEditableScene] = useState(initialStoreState.editableScene);
  const [selectedCharIds, setSelectedCharIds] = useState(_cache.selectedCharIds);
  const [charDetails, setCharDetails] = useState({});
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolutionTier, setResolutionTier] = useState(_cache.resolutionTier);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [sameBackground, setSameBackground] = useState(_cache.sameBackground);
  const [samePose, setSamePose] = useState(_cache.samePose);
  const [sameHair, setSameHair] = useState(_cache.sameHair);
  const [sameTattoos, setSameTattoos] = useState(_cache.sameTattoos);
  const [provider, setProvider] = useState(() => {
    try { return window.localStorage.getItem(SCENE_RECREATE_PROVIDER_KEY) || _cache.provider; } catch { return _cache.provider; }
  });
  const [result, setResult] = useState(initialStoreState.result);
  const [queueItems, setQueueItems] = useState(initialStoreState.queueItems);
  const [queuePaused, setQueuePaused] = useState(false);
  const [autoRetryAll, setAutoRetryAll] = useState(() => {
    try { const v = window.localStorage.getItem(SCENE_RECREATE_AUTORETRY_KEY); return v === null ? true : v === '1'; } catch { return true; }
  });
  const autoRetryAllRef = useRef(autoRetryAll);

  const [instagramLinks, setInstagramLinks] = useState('');
  const [failedInstagramLinks, setFailedInstagramLinks] = useState([]);
  const [isExtractingInstagram, setIsExtractingInstagram] = useState(false);
  const [showInstagramImport, setShowInstagramImport] = useState(false);
  const firstSelectedChar = selectedCharIds[0] ? charDetails[selectedCharIds[0]] : null;
  const characterPromptPreview = String(firstSelectedChar?.masterPrompt || '').trim();

  // While mounted this page drives its own queue; when unmounted the background worker
  // continues pending/retry jobs so they keep going after you navigate away.
  useEffect(() => {
    setQueuePageActive('scene-recreate', true);
    return () => setQueuePageActive('scene-recreate', false);
  }, []);
  useEffect(() => { _cache.sceneData = sceneData; }, [sceneData]);
  useEffect(() => { _cache.editableScene = editableScene; }, [editableScene]);
  useEffect(() => { _cache.selectedCharIds = selectedCharIds; }, [selectedCharIds]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolutionTier = resolutionTier; }, [resolutionTier]);
  useEffect(() => { _cache.imageModel = imageModel; }, [imageModel]);
  useEffect(() => { _cache.sameBackground = sameBackground; }, [sameBackground]);
  useEffect(() => { _cache.samePose = samePose; }, [samePose]);
  useEffect(() => { _cache.sameHair = sameHair; }, [sameHair]);
  useEffect(() => { _cache.sameTattoos = sameTattoos; }, [sameTattoos]);
  useEffect(() => {
    _cache.provider = provider;
    try { window.localStorage.setItem(SCENE_RECREATE_PROVIDER_KEY, provider); } catch { /* ignore */ }
  }, [provider]);
  useEffect(() => {
    autoRetryAllRef.current = autoRetryAll;
    try { window.localStorage.setItem(SCENE_RECREATE_AUTORETRY_KEY, autoRetryAll ? '1' : '0'); } catch { /* ignore */ }
  }, [autoRetryAll]);
  useEffect(() => scenePageStore.subscribe((snapshot) => {
    setSceneData(snapshot.sceneData);
    setEditableScene(snapshot.editableScene);
    setResult(snapshot.result);
    setQueueItems(snapshot.queueItems);
  }), []);

  useEffect(() => { filesRef.current = files; }, [files]);

  useEffect(() => {
    const next = {};
    Promise.all(selectedCharIds.map(id => charApi.get(id).then(d => { next[id] = d; }).catch(() => {}))).then(() => setCharDetails(next));
  }, [selectedCharIds]);

  // Hydrate source images from IndexedDB once on mount (with one-time migration
  // from the old localStorage key). IndexedDB survives reloads for any batch size,
  // so queued/failed jobs can always find their source image to retry.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let records = await loadSources();
      if (!records.length) {
        const legacy = readStoredSourceFiles();
        if (legacy.length) {
          records = legacy;
          saveSources(legacy);
          try { window.localStorage.removeItem(SCENE_RECREATE_SOURCE_STORAGE_KEY); } catch { /* ignore */ }
        }
      }
      if (cancelled) { hydratedRef.current = true; setSourcesHydrated(true); return; }
      const restored = records
        .map((item) => ({ file: dataUrlToFile(item.dataUrl, item.name), previewUrl: item.dataUrl, id: item.id }))
        .filter((entry) => entry.file);
      // MERGE (don't overwrite): a handoff event may add files before this async load
      // finishes; clobbering them would lose a just-sent frame.
      if (restored.length) setFiles((prev) => {
        if (prev.length === 0) return restored;
        const seen = new Set(prev.map((e) => `${e.file?.name}::${e.file?.size}`));
        return [...prev, ...restored.filter((e) => !seen.has(`${e.file?.name}::${e.file?.size}`))];
      });
      hydratedRef.current = true;
      setSourcesHydrated(true);
    })().catch(() => { hydratedRef.current = true; setSourcesHydrated(true); });
    return () => { cancelled = true; };
  }, []);

  // Backfill already-given-up jobs (failed ≥5×) as Failed in the Library. Idempotent.
  useEffect(() => {
    if (!sourcesHydrated) return;
    for (const j of (scenePageStore.getSnapshot().queueItems || [])) {
      if (j.status !== 'error' || (j.rlAttempts || 0) < GIVE_UP_AFTER_ATTEMPTS) continue;
      const entry = filesRef.current.find((f) => f.id === j.fileId);
      markFrameFailed(j.sourceName || j.summary || entry?.file?.name, entry?.previewUrl, 'Scene Recreate');
    }
  }, [sourcesHydrated]);

  // Persist source images to IndexedDB whenever they change (after hydration so we
  // never clobber stored sources with the empty initial state).
  useEffect(() => {
    if (!hydratedRef.current) return;
    const serialized = files
      .filter((entry) => entry.file)
      .map((entry) => ({
        id: entry.id,
        name: entry.file.name,
        type: entry.file.type,
        size: entry.file.size,
        dataUrl: entry.previewUrl,
      }));
    if (serialized.length === 0) clearSources();
    else saveSources(serialized);
  }, [files]);

  const handleInstagramImport = async (linksText = instagramLinks) => {
    const lines = linksText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('http'));

    if (lines.length === 0) {
      notify('Please enter at least one valid Instagram, TikTok, or X URL', 'error');
      return;
    }

    setIsExtractingInstagram(true);
    notify(`Starting import for ${lines.length} link(s)…`, 'info');

    const newFailures = [];
    const successfulFiles = [];

    // Extract all links in parallel (concurrency-limited) — far faster for big batches.
    const results = await runWithConcurrency(lines, (url) => extractOneLink(url));
    for (const r of results) {
      if (r.ok) {
        const file = dataUrlToFile(r.dataUrl, r.name);
        if (file) successfulFiles.push({ file, previewUrl: r.dataUrl, id: `${r.name}-${Date.now()}-${Math.random()}`, source: r.source, sourceUrl: r.sourceUrl });
        else newFailures.push({ url: r.url, errorMessage: 'Could not build image from frame' });
      } else {
        newFailures.push({ url: r.url, errorMessage: r.error });
      }
    }

    if (successfulFiles.length > 0) {
      setFiles(prev => [...prev, ...successfulFiles]);
      notify(`Successfully imported ${successfulFiles.length} image(s)`, 'success');
      scenePageStore.patch({ sceneData: null, editableScene: '', result: null });
      const savedCount = await addFramesToLibrary(successfulFiles.map(sf => ({
        dataUrl: sf.previewUrl, name: sf.file?.name, type: sf.file?.type, source: sf.source || 'Imported Frames',
      })));
      if (savedCount > 0) notify(`${savedCount} frame${savedCount > 1 ? 's' : ''} saved to Frame Library 📥`, 'success');
    }

    if (newFailures.length > 0) {
      setFailedInstagramLinks(prev => {
        const existingUrls = prev.map(f => f.url);
        const merged = [...prev];
        for (const failure of newFailures) {
          if (!existingUrls.includes(failure.url)) {
            merged.push(failure);
          } else {
            const idx = merged.findIndex(f => f.url === failure.url);
            if (idx >= 0) merged[idx] = failure;
          }
        }
        return merged;
      });
      notify(`Failed to import ${newFailures.length} link(s)`, 'error');
    }

    const failedUrls = newFailures.map(f => f.url);
    const remainingText = lines
      .filter(url => failedUrls.includes(url))
      .join('\n');
    setInstagramLinks(remainingText);
    setIsExtractingInstagram(false);
  };

  const handleRetryFailedLink = async (failedItem) => {
    setFailedInstagramLinks(prev => prev.filter(f => f.url !== failedItem.url));
    await handleInstagramImport(failedItem.url);
  };

  // sourceUrls (optional): array parallel to `incoming` — the originating post link per file.
  const addFiles = useCallback(async (incoming, sourceUrls) => {
    const incomingArr = [...incoming];
    const valid = [];
    const validSourceUrls = [];
    incomingArr.forEach((f, i) => {
      if (f.type.startsWith('image/')) { valid.push(f); validSourceUrls.push(sourceUrls?.[i] || null); }
    });
    if (valid.length === 0) { notify('Please use image files (PNG, JPEG, WebP)', 'error'); return; }

    // Compress large images first
    const compressed = await Promise.all(valid.map(f => resizeAndCompressImage(f)));

    const next = await Promise.all(compressed.map(async (f, i) => ({
      file: f,
      previewUrl: await fileToBase64(f),
      id: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`,
      sourceUrl: validSourceUrls[i] || null,
    })));
    // Skip images already present (same name + size) so re-sending the same frame
    // from Frame Grabber / Library doesn't create duplicates.
    setFiles(prev => {
      const seen = new Set(prev.map(e => `${e.file?.name}::${e.file?.size}`));
      const deduped = next.filter(e => !seen.has(`${e.file.name}::${e.file.size}`));
      return [...prev, ...deduped];
    });
    scenePageStore.patch({ sceneData: null, editableScene: '', result: null });
  }, [notify]);

  const removeFile = (id) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const clearFiles = () => {
    setFiles([]);
  };

  const toggleCharacter = (id) => setSelectedCharIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  useEffect(() => {
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'));
      if (!item) return;
      e.preventDefault();
      const pastedFile = item.getAsFile();
      if (pastedFile) {
        addFiles([pastedFile]);
        notify('Pasted scene image from clipboard', 'success');
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles, notify]);

  // ── Extension handoff (localStorage written before this page loads) ──────
  useEffect(() => {
    async function consumeHandoff() {
      try {
        const raw = localStorage.getItem('kyros_handoff');
        if (!raw) return;
        const handoff = JSON.parse(raw);
        if (handoff.feature !== 'scene-recreate') return;
        if (Date.now() - handoff.ts > 60000) return;
        localStorage.removeItem('kyros_handoff');

        const imageUrl = handoff.pinImage;
        if (!imageUrl) return;

        notify('Loading pin image…', 'info');
        const proxyUrl = `/api/pinterest/proxy?url=${encodeURIComponent(imageUrl)}`;
        const resp = await fetch(proxyUrl);
        if (!resp.ok) throw new Error(`Proxy ${resp.status}`);
        const blob = await resp.blob();
        const ext  = blob.type.split('/')[1] || 'jpg';
        addFiles([new File([blob], `pin.${ext}`, { type: blob.type })]);
        notify('Pin image auto-loaded ⚡ Choose a character and generate!', 'success');
      } catch (err) {
        notify(`Could not load pin: ${err.message}`, 'error');
      }
    }

    consumeHandoff();
    window.addEventListener('kyros:handoff', consumeHandoff);
    return () => window.removeEventListener('kyros:handoff', consumeHandoff);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFile = (e) => {
    addFiles(e.target.files || []);
    e.target.value = '';
  };

  const handleDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = () => setIsDragging(false);
  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragging(false);

    // 1. Check if dropped custom Kyros library items
    const rawData = e.dataTransfer?.getData('application/json');
    if (rawData) {
      try {
        const payload = JSON.parse(rawData);
        if (payload?.type === 'kyros-library-items' && Array.isArray(payload.items)) {
          const filesToAdd = [];
          for (const item of payload.items) {
            const response = await fetch(item.previewUrl, { credentials: 'include' });
            if (response.ok) {
              const blob = await response.blob();
              filesToAdd.push(new File([blob], item.name, { type: blob.type }));
            }
          }
          if (filesToAdd.length > 0) {
            addFiles(filesToAdd);
            notify(`Loaded ${filesToAdd.length} image${filesToAdd.length === 1 ? '' : 's'} from Library`, 'success');
          }
          return;
        }
      } catch (err) {
        console.error('Failed to parse dropped library items', err);
      }
    }

    // 2. Fallback to normal files drop
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  const handlePasteFromClipboard = async () => {
    if (!navigator.clipboard?.read) {
      notify('Clipboard image paste is not supported in this browser. Try Ctrl+V instead.', 'error');
      return;
    }
    const clipboardItems = await navigator.clipboard.read();
    const imageItem = clipboardItems.find((entry) => entry.types.some((type) => type.startsWith('image/')));
    if (!imageItem) { notify('No image found in clipboard', 'error'); return; }
    const imageType = imageItem.types.find((type) => type.startsWith('image/'));
    const blob = await imageItem.getType(imageType);
    const pastedFile = new File([blob], `scene-paste-${Date.now()}.${imageType.split('/')[1] || 'png'}`, { type: imageType });
    addFiles([pastedFile]);
    notify('Pasted scene image from clipboard', 'success');
  };

  const activeQueueCount = queueItems.filter((job) => job.status === 'running').length;
  const pendingQueueCount = queueItems.filter((job) => job.status === 'pending').length;
  const failedQueueCount = queueItems.filter((job) => job.status === 'error').length;
  const completedQueueCount = queueItems.filter((job) => job.status === 'completed').length;
  const isRecreating = queueItems.some((job) => job.status === 'running' && job.kind === 'recreate');
  const totalJobs = files.length * selectedCharIds.length;

  const runQueueJob = useCallback(async (job) => {
    if (!job?.id || runningJobsRef.current.has(job.id)) return;
    runningJobsRef.current.add(job.id);

    const fileEntry = filesRef.current.find(f => f.id === job.fileId);
    const fileSnap = fileEntry?.file;
    const opts = job.opts || {};

    if (!fileSnap) {
      runningJobsRef.current.delete(job.id);
      scenePageStore.setValue('queueItems', (prev) => prev.map((item) => (
        item.id === job.id ? { ...item, status: 'error', errorMessage: 'Source image was removed. Add it again to retry.' } : item
      )));
      return;
    }

    pushPending({ id: job.id, prompt: 'Scene Recreate', imageModel: opts.imageModel || '', aspectRatio: opts.aspectRatio, resolutionTier: opts.resolutionTier });

    try {
      const dataUri = await fileToBase64(fileSnap);
      const base64 = dataUri.split(',')[1];
      const analyzed = await sceneApi.analyze(base64, fileSnap.type);
      const text = Object.entries(analyzed).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
      scenePageStore.patch({ sceneData: analyzed, editableScene: text });
      const parsed = {};
      (opts.editableScene || text).split('\n').forEach((line) => {
        const idx = line.indexOf(':');
        if (idx > 0) parsed[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
      const data = await sceneApi.recreate({
        sceneData: { ...analyzed, ...parsed },
        characterId: job.characterId,
        activeReferenceIds: job.activeReferenceIds?.length > 0 ? job.activeReferenceIds : undefined,
        masterPromptOverride: job.masterPromptOverride || undefined,
        aspectRatio: opts.aspectRatio,
        resolutionTier: opts.resolutionTier,
        imageModel: opts.imageModel,
        sameBackground: opts.sameBackground,
        samePose: opts.samePose,
        sameHair: opts.sameHair,
        sameTattoos: opts.sameTattoos,
        provider: opts.provider,
        sourceUrl: job.sourceUrl || undefined,
      });
      scenePageStore.setValue('result', data);
      scenePageStore.setValue('history', (prev) => [data, ...prev].slice(0, 10));
      scenePageStore.setValue('queueItems', (prev) => prev.filter((item) => item.id !== job.id));
      // Auto-clear this source frame once nothing else needs it (see PhotoMatch note).
      if (!(scenePageStore.getSnapshot().queueItems || []).some((item) => item.fileId === job.fileId)) {
        setFiles((prev) => prev.filter((f) => f.id !== job.fileId));
      }
      if (job.sourceName) clearFrameFailed([job.sourceName]); // succeeded → no longer Failed
      resolvePending(job.id, {
        imageId: data.imageId,
        galleryId: data.galleryId || data.imageId,
        mimeType: data.image?.mimeType,
        prompt: job.masterPromptOverride || 'Scene Recreate',
        imageModel: opts.imageModel || '',
        aspectRatio: opts.aspectRatio,
        resolutionTier: opts.resolutionTier,
        generatedAt: Date.now(),
        characterId: job.characterId || null,
        sourceUrl: job.sourceUrl || data.sourceUrl || null,
      });
      notify('Scene recreated!', 'success');
    } catch (err) {
      rejectPending(job.id);
      const msg = err?.message || 'Failed to recreate scene';
      const rateLimited = isRateLimitMessage(msg);
      const permanent = isPermanentFailure(msg);
      const autoOn = autoRetryAllRef.current;
      const attempts = ((scenePageStore.getSnapshot().queueItems || []).find((x) => x.id === job.id)?.rlAttempts || 0) + 1;
      const gaveUp = attempts >= GIVE_UP_AFTER_ATTEMPTS;
      const willAutoRetry = !permanent && !gaveUp && autoOn;
      scenePageStore.setValue('queueItems', (prev) => prev.map((item) => {
        if (item.id !== job.id) return item;
        const cooldown = rateLimited ? rateLimitCooldown(attempts) : AUTO_RETRY_COOLDOWN_MS;
        return {
          ...item,
          status: 'error',
          rateLimited,
          permanent: permanent || gaveUp,
          rlAttempts: attempts,
          retryAt: willAutoRetry ? Date.now() + cooldown : null,
          errorMessage: gaveUp
            ? `${msg} — failed ${attempts}× (marked Failed in Library; retry manually if you want)`
            : (willAutoRetry ? `${msg} — retrying in ${Math.round(cooldown / 1000)}s…` : msg),
        };
      }));
      if (gaveUp) {
        const srcEntry = filesRef.current.find((f) => f.id === job.fileId);
        markFrameFailed(job.sourceName || job.summary || srcEntry?.file?.name, srcEntry?.previewUrl, 'Scene Recreate');
      }
      if (!willAutoRetry) notify(gaveUp ? `Gave up after ${attempts} tries — marked Failed in Library` : msg, 'error');
    } finally {
      runningJobsRef.current.delete(job.id);
    }
  }, [notify]);

  useEffect(() => {
    if (queuePaused || !sourcesHydrated) return;
    const runningCount = queueItems.filter((job) => job.status === 'running').length;
    const slots = MAX_RUNNING_SCENE_JOBS - runningCount;
    if (slots <= 0) return;
    const nextJobs = queueItems.filter((job) => job.status === 'pending').slice(0, slots);
    if (nextJobs.length === 0) return;
    scenePageStore.setValue('queueItems', (prev) => prev.map((job) => (
      nextJobs.some((nextJob) => nextJob.id === job.id) ? { ...job, status: 'running', errorMessage: '' } : job
    )));
    // Stagger so we don't fire multiple requests at the exact same instant.
    nextJobs.forEach((job, i) => {
      if (i === 0) runQueueJob(job);
      else setTimeout(() => runQueueJob(job), i * DISPATCH_STAGGER_MS);
    });
  }, [queueItems, queuePaused, runQueueJob, sourcesHydrated]);

  // Auto-retry ticker: re-queue eligible error jobs once their cooldown elapses.
  // Rate-limited jobs always self-heal; with "keep retrying" on, ALL non-permanent
  // errors re-queue too, so the batch drains itself with no manual Retry clicks.
  useEffect(() => {
    if (queuePaused) return undefined;
    const timer = setInterval(() => {
      const now = Date.now();
      const snap = scenePageStore.getSnapshot();
      const hasReady = (snap.queueItems || []).some((job) => isAutoRetryReady(job, now, autoRetryAll));
      if (!hasReady) return;
      scenePageStore.setValue('queueItems', (prev) => prev.map((job) => (
        isAutoRetryReady(job, now, autoRetryAll)
          ? { ...job, status: 'pending', rateLimited: false, retryAt: null, errorMessage: '' }
          : job
      )));
    }, 2500);
    return () => clearInterval(timer);
  }, [queuePaused, autoRetryAll]);

  // When "keep retrying" is switched on, arm any already-failed (non-permanent) jobs
  // so they resume — otherwise jobs that failed while it was off would sit there.
  useEffect(() => {
    if (!autoRetryAll) return;
    const snap = scenePageStore.getSnapshot();
    const needsArming = (snap.queueItems || []).some((job) => job.status === 'error' && !job.permanent && !job.retryAt);
    if (!needsArming) return;
    scenePageStore.setValue('queueItems', (prev) => prev.map((job) => (
      job.status === 'error' && !job.permanent && !job.retryAt
        ? { ...job, retryAt: Date.now() + AUTO_RETRY_COOLDOWN_MS }
        : job
    )));
  }, [autoRetryAll]);

  const handleGenerate = () => {
    if (files.length === 0) { notify('Upload at least one image first', 'error'); return; }
    if (selectedCharIds.length === 0) { notify('Select at least one character', 'error'); return; }
    const opts = { aspectRatio, resolutionTier, imageModel, sameBackground, samePose, sameHair, sameTattoos, provider, editableScene };
    const jobs = [];
    for (const { file: f, id: fileId, sourceUrl } of files) {
      for (const characterId of selectedCharIds) {
        const detail = charDetails[characterId] || null;
        const activeReferenceIds = detail?.references?.filter((r) => r.isActive).map((r) => r.id) || [];
        jobs.push({
          id: makePersistentJobId('scene-recreate'), kind: 'recreate', status: 'pending', label: 'Recreating Scene',
          fileId, characterId, activeReferenceIds, masterPromptOverride: String(detail?.masterPrompt || '').trim(), opts, sourceUrl,
          sourceName: f.name || null,
          summary: f.name || 'Scene image',
          meta: `${aspectRatio} · ${resolutionTier}`,
          badges: [detail?.name ? { label: detail.name, color: 'zinc' } : null, { label: imageModel, color: 'zinc' }].filter(Boolean),
        });
      }
    }
    scenePageStore.setValue('queueItems', (prev) => [...prev, ...jobs]);
    notify(`${jobs.length} job${jobs.length === 1 ? '' : 's'} added to queue`, 'success');
  };

  useEffect(() => {
    const onInboxSource = (e) => {
      const items = Array.isArray(e.detail?.items) ? e.detail.items : [];
      if (items.length === 0) return;
      const converted = items
        .map((item) => ({ file: dataUrlToFile(item.dataUrl, item.name), sourceUrl: item.sourceUrl || null }))
        .filter((c) => c.file);
      if (converted.length === 0) return;
      addFiles(converted.map((c) => c.file), converted.map((c) => c.sourceUrl));
      notify(`Loaded ${converted.length} image${converted.length === 1 ? '' : 's'} from Paste Inbox into Scene Recreate`, 'success');
    };
    window.addEventListener('kyros:use-as-scene-source', onInboxSource);
    return () => window.removeEventListener('kyros:use-as-scene-source', onInboxSource);
  }, [addFiles, notify]);

  // Reliable pickup: consume frames a sender stashed for us, on mount (survives the
  // lazy-load race the dispatched event can lose). addFiles dedup avoids doubles.
  useEffect(() => {
    const pending = consumeSourceHandoff('scene');
    if (pending.length) {
      const converted = pending
        .map((it) => ({ file: dataUrlToFile(it.dataUrl, it.name), sourceUrl: it.sourceUrl || null }))
        .filter((c) => c.file);
      if (converted.length) addFiles(converted.map((c) => c.file), converted.map((c) => c.sourceUrl));
    }
  }, [addFiles]);

  // Manual retry — always a fresh attempt (reset counters) reusing the job's original
  // character + frame reference + source image. Works whether auto-retry is on or off.
  const retryJob = (id) => {
    scenePageStore.setValue('queueItems', (prev) => prev.map((job) => job.id === id ? { ...job, status: 'pending', rateLimited: false, permanent: false, rlAttempts: 0, retryAt: null, errorMessage: '' } : job));
  };

  const retryAllJobs = () => {
    scenePageStore.setValue('queueItems', (prev) => prev.map((job) => job.status === 'error' ? { ...job, status: 'pending', rateLimited: false, permanent: false, rlAttempts: 0, retryAt: null, errorMessage: '' } : job));
  };

  // Move all failed jobs to another tool (Photo Match / Pose Remix), reusing the same
  // character + source frame, and jump there to watch them run.
  const retryAllInTool = async (toKey) => {
    const { moved, skipped, page } = await moveFailedJobsToTool('scene', toKey);
    if (!moved) { notify(skipped ? 'Source frames were removed — can’t move' : 'No failed jobs to move', 'error'); return; }
    notify(`Moved ${moved} job${moved === 1 ? '' : 's'} to ${crossToolLabel(toKey)}${skipped ? ` (${skipped} skipped)` : ''} ⚡`, 'success');
    navigateTo(page);
  };

  const clearFailedJobs = () => {
    scenePageStore.setValue('queueItems', (prev) => prev.filter((job) => job.status !== 'error'));
  };

  const clearCompletedJobs = () => {
    scenePageStore.setValue('queueItems', (prev) => prev.filter((job) => job.status !== 'completed'));
  };

  return (
    <div className="space-y-6 animate-in">
      <div className="max-w-md">

        {/* ── CONTROLS ── */}
        <div className="space-y-3">

          {/* Upload card */}
          <Card className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Scene Images</span>
              <div className="flex items-center gap-2">
                {files.length > 0 && <Badge color="blue">{files.length} photo{files.length > 1 ? 's' : ''}</Badge>}
                <Badge color="zinc">Ctrl+V</Badge>
              </div>
            </div>
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`flex items-center justify-center border-2 border-dashed rounded-xl cursor-pointer transition-all min-h-[160px] px-4 py-4 ${isDragging ? 'border-rose-500/80 bg-rose-500/10' : 'border-zinc-700/60 hover:border-zinc-500/60 hover:bg-zinc-800/20'}`}
            >
              <div className="text-center flex flex-col items-center gap-2 py-6 [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor]">
                <div className="w-10 h-10 rounded-xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center">
                  <IconCamera uniqueId="scene-upload" size={20} className="text-zinc-400" aria-hidden />
                </div>
                <div>
                  <p className="text-sm text-zinc-400 font-medium">Drop images here or click to browse</p>
                  <p className="text-xs text-zinc-600 mt-0.5">PNG, JPEG, WebP · no image limit</p>
                </div>
              </div>
              <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={handleFile} />
            </div>

            {files.length > 0 && (
              <div>
                <div className="grid grid-cols-4 gap-2">
                  {files.map(({ id, previewUrl, file: sourceFile }) => (
                    <div key={id} className="relative aspect-square overflow-hidden rounded-lg border border-zinc-700/60 bg-zinc-900 group">
                      <img src={previewUrl} alt={sourceFile.name} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeFile(id); }}
                        className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-xs font-bold text-zinc-300 opacity-0 transition group-hover:opacity-100 hover:bg-red-500/80 hover:text-white"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="flex aspect-square cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-zinc-700/60 bg-zinc-900/40 text-zinc-600 transition hover:border-zinc-500 hover:text-zinc-400"
                  >
                    <span className="text-xl font-light">+</span>
                  </div>
                </div>
                <button type="button" onClick={clearFiles} className="mt-2 text-xs text-zinc-600 transition hover:text-red-400">Clear all</button>
              </div>
            )}

            <Btn variant="secondary" onClick={handlePasteFromClipboard} className="w-full text-xs py-2 mb-3">
              Paste from Clipboard
            </Btn>

            <div className="pt-2 border-t border-zinc-800/80">
              <button
                type="button"
                onClick={() => setShowInstagramImport(prev => !prev)}
                className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition font-medium cursor-pointer"
              >
                <span className="text-[0.625rem] transform transition-transform duration-200 inline-block" style={{ transform: showInstagramImport ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                Import from Instagram / TikTok / X URL
              </button>

              {showInstagramImport && (
                <div className="mt-3 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
                  <p className="text-[0.6875rem] text-zinc-500 leading-normal">
                    Paste Instagram, TikTok, or X URLs (one per line). Carousel posts support <code className="text-zinc-400 bg-zinc-850 px-1 py-0.5 rounded">?img_index=N</code>.
                  </p>
                  <textarea
                    value={instagramLinks}
                    onChange={e => setInstagramLinks(e.target.value)}
                    placeholder="https://www.instagram.com/p/...&#10;https://www.tiktok.com/@username/video/...&#10;https://x.com/username/status/..."
                    rows={3}
                    className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-3 py-2 text-xs font-mono text-zinc-300 placeholder-zinc-700 outline-none focus:border-rose-500/60 resize-none"
                    disabled={isExtractingInstagram}
                  />
                  <button
                    type="button"
                    onClick={() => handleInstagramImport()}
                    disabled={isExtractingInstagram || !instagramLinks.trim()}
                    className="w-full rounded-lg bg-zinc-800 hover:bg-zinc-750 text-zinc-200 text-xs py-2 font-medium transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
                  >
                    {isExtractingInstagram ? (
                      <>
                        <Spinner size="xs" />
                        <span>Extracting...</span>
                      </>
                    ) : (
                      <span>Import Links</span>
                    )}
                  </button>

                  {/* Failed Links Panel */}
                  {failedInstagramLinks.length > 0 && (
                    <div className="mt-3 rounded-lg border border-red-900/30 bg-red-950/10 p-2.5 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[0.625rem] font-semibold text-red-400 uppercase tracking-wider">Failed Downloads</span>
                        <button
                          type="button"
                          onClick={() => setFailedInstagramLinks([])}
                          className="text-[0.625rem] text-zinc-500 hover:text-zinc-300 transition"
                        >
                          Clear All
                        </button>
                      </div>
                      <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                        {failedInstagramLinks.map((item, idx) => (
                          <div key={idx} className="flex flex-col gap-1 text-[0.6875rem] bg-red-950/20 border border-red-900/20 rounded p-1.5">
                            <span className="font-mono text-zinc-400 truncate" title={item.url}>{item.url}</span>
                            <span className="text-red-400/80 leading-normal">{item.errorMessage}</span>
                            <div className="flex items-center gap-2 mt-1">
                              <button
                                type="button"
                                onClick={() => handleRetryFailedLink(item)}
                                className="text-[0.625rem] text-rose-400 hover:text-rose-300 font-semibold"
                              >
                                Retry
                              </button>
                              <span className="text-zinc-700">|</span>
                              <button
                                type="button"
                                onClick={() => setFailedInstagramLinks(prev => prev.filter(f => f.url !== item.url))}
                                className="text-[0.625rem] text-zinc-500 hover:text-zinc-400"
                              >
                                Dismiss
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>

          {/* Scene details — shown after first generate */}
          {sceneData && (
            <Card className="space-y-3 animate-in">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Scene Details</span>
                <Badge color="green">Analyzed</Badge>
              </div>
              <div className="grid grid-cols-1 gap-1 max-h-44 overflow-y-auto pr-1">
                {Object.entries(sceneData).filter(([, v]) => v).map(([key, val]) => (
                  <div key={key} className="flex gap-2 py-0.5">
                    <span className="text-[0.625rem] text-zinc-500 uppercase tracking-wide shrink-0 w-20 pt-0.5">{key}</span>
                    <span className="text-xs text-zinc-300 leading-relaxed">{val}</span>
                  </div>
                ))}
              </div>
              <Textarea
                label="Edit description (used on next generate)"
                value={editableScene}
                onChange={(e) => scenePageStore.setValue('editableScene', e.target.value)}
                className="!min-h-[64px] !text-xs"
              />
            </Card>
          )}

          {/* Settings card — always visible */}
          <Card className="space-y-4">
            <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Settings</span>

            {/* Character */}
            <div>
              <CharacterPicker
                chars={chars}
                selectedIds={selectedCharIds}
                onToggle={toggleCharacter}
                charDetails={charDetails}
                label="Character"
              />
              {characterPromptPreview && (
                <div className="mt-3 rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.18em] text-zinc-500">Character Prompt</span>
                    <Badge color="blue">Auto applied</Badge>
                  </div>
                  <p className="mt-2 line-clamp-4 text-xs leading-5 text-zinc-300">
                    {characterPromptPreview}
                  </p>
                </div>
              )}
            </div>

            {/* Model */}
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Image Model</span>
              <select
                value={imageModel}
                onChange={(e) => setImageModel(e.target.value)}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-rose-500/70 focus:ring-1 focus:ring-rose-500/20 cursor-pointer"
              >
                {IMAGE_MODEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Provider */}
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Provider</span>
              <div className="flex gap-2">
                {[
                  { value: 'auto', label: 'Auto' },
                  { value: 'gemini', label: 'Gemini' },
                  { value: 'vertex', label: 'Vertex' },
                ].map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setProvider(p.value)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition cursor-pointer ${
                      provider === p.value
                        ? 'border-rose-500/60 bg-rose-500/15 text-rose-100'
                        : 'border-zinc-700/70 bg-zinc-900/50 text-zinc-400 hover:border-zinc-600'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="text-[0.625rem] text-zinc-600 mt-1">Gemini = direct API (better bypass). Vertex = GCP account.</p>
            </div>

            {/* Aspect ratio + resolution */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-xs text-zinc-400 font-medium block mb-1.5">Aspect Ratio</span>
                <div className="flex flex-wrap gap-1">
                  {ASPECT_RATIOS.map((ar) => (
                    <button
                      key={ar}
                      onClick={() => setAspectRatio(ar)}
                      className={`rounded-md px-2 py-1 text-[0.6875rem] font-medium transition cursor-pointer ${aspectRatio === ar ? 'bg-rose-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
                    >
                      {ar}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className="text-xs text-zinc-400 font-medium block mb-1.5">Resolution</span>
                <div className="flex flex-wrap gap-1">
                  {RESOLUTION_TIERS.map((tier) => (
                    <button
                      key={tier}
                      onClick={() => setResolutionTier(tier)}
                      className={`rounded-md px-2 py-1 text-[0.6875rem] font-medium transition cursor-pointer ${resolutionTier === tier ? 'bg-rose-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
                    >
                      {tier}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Lock options */}
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Lock</span>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setSameBackground(v => !v)} className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition cursor-pointer border ${sameBackground ? 'bg-rose-600/20 text-rose-300 border-rose-500/60' : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/60 hover:bg-zinc-700/60 hover:text-zinc-300'}`}>
                  {sameBackground ? '🔒' : '🔓'} Background
                </button>
                <button type="button" onClick={() => setSamePose(v => !v)} className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition cursor-pointer border ${samePose ? 'bg-rose-600/20 text-rose-300 border-rose-500/60' : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/60 hover:bg-zinc-700/60 hover:text-zinc-300'}`}>
                  {samePose ? '🔒' : '🔓'} Pose
                </button>
                <button type="button" onClick={() => setSameHair(v => !v)} className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition cursor-pointer border ${sameHair ? 'bg-emerald-600/20 text-emerald-300 border-emerald-500/60' : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/60 hover:bg-zinc-700/60 hover:text-zinc-300'}`}>
                  {sameHair ? '🔒' : '🔓'} Hair
                </button>
                <button type="button" onClick={() => setSameTattoos(v => !v)} className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition cursor-pointer border ${sameTattoos ? 'bg-amber-600/20 text-amber-300 border-amber-500/60' : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/60 hover:bg-zinc-700/60 hover:text-zinc-300'}`}>
                  {sameTattoos ? '🔒' : '🔓'} Tattoos
                </button>
              </div>
              <p className="mt-2 text-[0.6875rem] leading-relaxed text-zinc-500">
                Hair and tattoos stay off by default. Turn them on only when you want to copy those details from the source scene.
              </p>
            </div>

            {/* Generate button */}
            {totalJobs > 1 && files.length > 0 && selectedCharIds.length > 0 && (
              <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 px-3 py-2 text-xs text-rose-300">
                {files.length} photo{files.length > 1 ? 's' : ''} × {selectedCharIds.length} character{selectedCharIds.length > 1 ? 's' : ''} = <span className="font-bold">{totalJobs} jobs</span>
              </div>
            )}

            <Btn onClick={handleGenerate} disabled={files.length === 0 || selectedCharIds.length === 0} className="w-full py-3 text-sm font-semibold">
              {activeQueueCount > 0 ? `Queue More · ${activeQueueCount}/2 running` : totalJobs > 1 ? `Scene Recreate ×${totalJobs}` : 'Generate Scene'}
            </Btn>

            {queueItems.length > 0 && (
              <div className="space-y-2 rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-zinc-200">Queue</div>
                    <div className="text-[0.6875rem] text-zinc-500">Runs max 2 jobs at a time. Finished jobs auto-clear.</div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {pendingQueueCount > 0 && <Badge color="zinc">{pendingQueueCount} pending</Badge>}
                    {activeQueueCount > 0 && <Badge color="blue">{activeQueueCount} running</Badge>}
                    {failedQueueCount > 0 && <Badge color="red">{failedQueueCount} error</Badge>}
                    {completedQueueCount > 0 && <Badge color="green">{completedQueueCount} done</Badge>}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setQueuePaused(v => !v)} className="rounded-md border border-zinc-700/70 bg-zinc-900/70 px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 cursor-pointer">
                    {queuePaused ? 'Resume' : 'Pause all'}
                  </button>
                  <button type="button" onClick={retryAllJobs} disabled={failedQueueCount === 0} className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-200 transition hover:border-rose-400 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer">
                    Retry all ({failedQueueCount})
                  </button>
                  <button type="button" onClick={() => retryAllInTool('photoMatch')} disabled={failedQueueCount === 0} title="Move all failed jobs to Photo Match (same character + frame)" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-200 transition hover:border-rose-400 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer">
                    Retry all in Photo Match ({failedQueueCount})
                  </button>
                  <button type="button" onClick={clearFailedJobs} disabled={failedQueueCount === 0} className="rounded-md border border-zinc-700/70 bg-zinc-900/70 px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer">
                    Clear failed
                  </button>
                  <button type="button" onClick={clearCompletedJobs} disabled={completedQueueCount === 0} className="rounded-md border border-zinc-700/70 bg-zinc-900/70 px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer">
                    Clear completed
                  </button>
                </div>

                <label className={`flex items-center gap-2.5 cursor-pointer select-none rounded-lg border px-3 py-2 transition ${autoRetryAll ? 'border-rose-500/50 bg-rose-500/10' : 'border-zinc-800/70 bg-zinc-900/40 hover:border-zinc-700'}`}>
                  <input type="checkbox" checked={autoRetryAll} onChange={(e) => setAutoRetryAll(e.target.checked)} className="h-4 w-4 accent-rose-500 cursor-pointer" />
                  <div className="min-w-0">
                    <div className={`text-xs font-medium ${autoRetryAll ? 'text-rose-200' : 'text-zinc-300'}`}>Keep retrying until all finish</div>
                    <div className="text-[0.625rem] text-zinc-500">{autoRetryAll ? 'On: auto re-queues each failed job on a cooldown; after 5 tries it gives up and marks the frame Failed in the Library.' : 'Off: failed jobs just stop and wait — hit “Retry all” to re-run them by hand (same character + frame reference).'}</div>
                  </div>
                </label>

                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {queueItems.map((job) => {
                    const willRetry = job.status === 'error' && !job.permanent && job.retryAt && (job.rateLimited || autoRetryAll);
                    return (
                    <div key={job.id} className="rounded-lg border border-zinc-800/70 bg-zinc-900/50 px-3 py-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge color={job.status === 'running' ? 'blue' : willRetry ? 'yellow' : job.status === 'error' ? 'red' : 'zinc'}>
                              {job.status === 'running' ? 'Running' : willRetry ? 'Retrying' : job.status === 'error' ? 'Error' : 'Pending'}
                            </Badge>
                            {Array.isArray(job.badges) && job.badges.map((badge, index) => (
                              <Badge key={`${job.id}-${badge?.label || badge}-${index}`} color={badge?.color || 'zinc'}>{badge?.label || badge}</Badge>
                            ))}
                          </div>
                          <div className="truncate text-sm text-zinc-200">{job.summary || 'Scene image'}</div>
                          {job.meta && <div className="text-[0.625rem] font-mono text-zinc-600">{job.meta}</div>}
                          {job.status === 'error' && <div className={`text-xs line-clamp-3 ${willRetry ? 'text-yellow-300/80' : 'text-red-300'}`}>{job.errorMessage || 'Failed'}</div>}
                        </div>
                        {job.status === 'running' ? (
                          <span className="w-4 h-4 rounded-full border border-t-white border-white/20 animate-spin" />
                        ) : job.status === 'error' ? (
                          <button type="button" onClick={() => retryJob(job.id)} className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-200 transition hover:bg-red-500/20 cursor-pointer">Retry</button>
                        ) : null}
                      </div>
                    </div>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>

        </div>
      </div>
      <LightboxComponent />
    </div>
  );
}
