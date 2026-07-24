import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { photoMatch as photoMatchApi, characters as charApi, library as libraryApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Badge, Spinner } from '../components/UI';
import CharacterPicker from '../components/CharacterPicker';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { ASPECT_RATIOS, RESOLUTION_TIERS, IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL } from '../config/photoModes';
import { makePersistentJobId } from '../lib/persistentPageState';
import { poseFixStore, setQueuePageActive } from '../lib/generationQueues';
import { moveFailedJobsToTool, crossToolLabel } from '../lib/crossToolRetry';
import { markFrameFailed, clearFrameFailed } from '../lib/frameOutcomes';
import { loadSources, saveSources, clearSources } from '../lib/poseFixSourceStore';
import { addFramesToLibrary } from '../lib/frameLibrary';
import { consumeSourceHandoff } from '../lib/sourceHandoff';
import { extractOneLink, runWithConcurrency } from '../lib/frameExtract';
import { IconImage } from 'nucleo-glass';

const PHOTO_MATCH_HANDOFF_KEY = 'kyros.poseFix.handoff';
const PHOTO_MATCH_SOURCE_STORAGE_KEY = 'kyros.poseFix.sources';
const PHOTO_MATCH_PROVIDER_KEY = 'kyros.poseFix.provider';
const PHOTO_MATCH_AUTORETRY_KEY = 'kyros.poseFix.autoRetryAll';
const PHOTO_MATCH_POSESTYLE_KEY = 'kyros.poseFix.poseStyle';

// Pose presets shown in the UI — values must match POSE_STYLES on the server.
const POSE_STYLE_OPTIONS = [
  { value: 'sexy_confident', label: 'Sexy & Confident', hint: 'chin up, strong gaze, hand on hip / in hair' },
  { value: 'flirty_playful', label: 'Flirty & Playful', hint: 'soft smile, head tilt, playful hands' },
  { value: 'elegant_alluring', label: 'Elegant & Alluring', hint: 'graceful posture, soft seductive gaze' },
  { value: 'natural_candid', label: 'Natural & Candid', hint: 'relaxed, effortless, caught-in-the-moment' },
];
// Keep concurrency low to stay under Vertex/GCP per-minute image quota.
const MAX_RUNNING_PHOTO_MATCH_JOBS = 2;
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

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl, filename = 'photo-match-source.png') {
  const match = dataUrl?.match(/^data:([^;]+);base64,(.+)$/);
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

function readPhotoMatchHandoff() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(PHOTO_MATCH_HANDOFF_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(PHOTO_MATCH_HANDOFF_KEY);
    return JSON.parse(raw);
  } catch { return null; }
}

function readStoredSourceFiles() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PHOTO_MATCH_SOURCE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object' && item.dataUrl) : [];
  } catch { return []; }
}

const _cache = {
  selectedCharIds: [], aspectRatio: '4:5', resolutionTier: '1K',
  imageModel: DEFAULT_IMAGE_MODEL, poseStyle: localStorage.getItem(PHOTO_MATCH_POSESTYLE_KEY) || 'flirty_playful',
  poseMode: localStorage.getItem('kyros.poseFix.poseMode') || 'direct',
  provider: localStorage.getItem(PHOTO_MATCH_PROVIDER_KEY) || 'auto',
};

export default function PoseFixPage() {
  const { notify, characters: chars, consumePageParams, navigateTo } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const dropRef = useRef(null);
  const fileInputRef = useRef(null);
  const filesRef = useRef([]);
  const runningJobsRef = useRef(new Set());
  const initialStoreState = poseFixStore.getSnapshot();

  // Multiple source files — hydrated from IndexedDB on mount (see hydrate effect below).
  const [files, setFiles] = useState([]); // [{ file, previewUrl, id }]
  const hydratedRef = useRef(false);
  // Gate job dispatch until sources have loaded from IndexedDB (see PhotoMatch note).
  const [sourcesHydrated, setSourcesHydrated] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedCharIds, setSelectedCharIds] = useState(_cache.selectedCharIds);
  const [poseMode, setPoseMode] = useState(_cache.poseMode);
  const [charDetails, setCharDetails] = useState({});
  const [poseStyle, setPoseStyle] = useState(() => {
    try { return window.localStorage.getItem(PHOTO_MATCH_POSESTYLE_KEY) || _cache.poseStyle; } catch { return _cache.poseStyle; }
  });
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolutionTier, setResolutionTier] = useState(_cache.resolutionTier);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [provider, setProvider] = useState(() => {
    try { return window.localStorage.getItem(PHOTO_MATCH_PROVIDER_KEY) || _cache.provider; } catch { return _cache.provider; }
  });
  const [queueItems, setQueueItems] = useState(initialStoreState.queueItems);
  const [queuePaused, setQueuePaused] = useState(false);
  const [autoRetryAll, setAutoRetryAll] = useState(() => {
    try { const v = window.localStorage.getItem(PHOTO_MATCH_AUTORETRY_KEY); return v === null ? true : v === '1'; } catch { return true; }
  });
  const autoRetryAllRef = useRef(autoRetryAll);

  const [instagramLinks, setInstagramLinks] = useState('');
  const [failedInstagramLinks, setFailedInstagramLinks] = useState([]);
  const [isExtractingInstagram, setIsExtractingInstagram] = useState(false);
  const [showInstagramImport, setShowInstagramImport] = useState(false);

  // In-page Library picker
  const [showLibraryPicker, setShowLibraryPicker] = useState(false);
  const [libItems, setLibItems] = useState([]);
  const [libLoading, setLibLoading] = useState(false);
  const [libSelected, setLibSelected] = useState(() => new Set());
  const [libSearch, setLibSearch] = useState('');
  const [libVisible, setLibVisible] = useState(200);
  const [libBusy, setLibBusy] = useState(false);

  // While mounted this page drives its own queue; when unmounted the background worker
  // continues pending/retry jobs so they keep going after you navigate away.
  useEffect(() => {
    setQueuePageActive('pose-fix', true);
    return () => setQueuePageActive('pose-fix', false);
  }, []);
  useEffect(() => { _cache.selectedCharIds = selectedCharIds; }, [selectedCharIds]);
  useEffect(() => { _cache.poseMode = poseMode; localStorage.setItem('kyros.poseFix.poseMode', poseMode); }, [poseMode]);
  useEffect(() => {
    _cache.provider = provider;
    try { window.localStorage.setItem(PHOTO_MATCH_PROVIDER_KEY, provider); } catch { /* ignore */ }
  }, [provider]);
  useEffect(() => {
    _cache.poseStyle = poseStyle;
    try { window.localStorage.setItem(PHOTO_MATCH_POSESTYLE_KEY, poseStyle); } catch { /* ignore */ }
  }, [poseStyle]);
  useEffect(() => {
    autoRetryAllRef.current = autoRetryAll;
    try { window.localStorage.setItem(PHOTO_MATCH_AUTORETRY_KEY, autoRetryAll ? '1' : '0'); } catch { /* ignore */ }
  }, [autoRetryAll]);
  useEffect(() => poseFixStore.subscribe((s) => setQueueItems(s.queueItems)), []);
  useEffect(() => { filesRef.current = files; }, [files]);

  // Hydrate source images from IndexedDB once on mount (with one-time migration
  // from the old localStorage key). IndexedDB survives reloads for any batch size,
  // so queued/failed jobs can always find their source image to retry.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let records = await loadSources();
      if (!records.length) {
        // Migrate any previously-persisted (≤20) localStorage sources into IndexedDB.
        const legacy = readStoredSourceFiles();
        if (legacy.length) {
          records = legacy;
          saveSources(legacy);
          try { window.localStorage.removeItem(PHOTO_MATCH_SOURCE_STORAGE_KEY); } catch { /* ignore */ }
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
    for (const j of (poseFixStore.getSnapshot().queueItems || [])) {
      if (j.status !== 'error' || (j.rlAttempts || 0) < GIVE_UP_AFTER_ATTEMPTS) continue;
      const entry = filesRef.current.find(f => f.id === j.fileId);
      markFrameFailed(j.sourceName || j.summary || entry?.file?.name, entry?.previewUrl, 'Pose Remix');
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


  // Fetch details for selected characters
  useEffect(() => {
    const nd = {};
    Promise.all(selectedCharIds.map(id => charApi.get(id).then(d => { nd[id] = d; }).catch(() => {}))).then(() => setCharDetails(nd));
  }, [selectedCharIds]);



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
      poseFixStore.setValue('result', null);
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
    if (valid.length === 0) { notify('Only PNG, JPEG, WebP allowed', 'error'); return; }

    // Compress large images first
    const compressed = await Promise.all(valid.map(f => resizeAndCompressImage(f)));

    const next = await Promise.all(compressed.map(async (f, i) => ({
      file: f,
      previewUrl: await fileToBase64(f),
      id: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`,
      sourceUrl: validSourceUrls[i] || null,
    })));
    // Skip images already present (same name + size) so re-sending from the Library
    // or picking the same image twice doesn't create duplicates.
    setFiles(prev => {
      const seen = new Set(prev.map(e => `${e.file?.name}::${e.file?.size}`));
      const deduped = next.filter(e => !seen.has(`${e.file.name}::${e.file.size}`));
      return [...prev, ...deduped];
    });
    poseFixStore.setValue('result', null);
  }, [notify]);

  const removeFile = (id) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const clearAll = () => {
    setFiles([]);
  };

  // Single-file handoff (from other pages / extensions)
  const applyFile = useCallback((f) => addFiles([f]), [addFiles]);

  useEffect(() => {
    const params = consumePageParams();
    const handoff = params?.sourceImageBase64 ? params : readPhotoMatchHandoff();
    if (!handoff?.sourceImageBase64) return;
    const mimeType = handoff.sourceImageMimeType || 'image/png';
    const filename = handoff.sourceImageName || 'nsfw-generate';
    const sourceFile = dataUrlToFile(`data:${mimeType};base64,${handoff.sourceImageBase64}`, filename);
    if (!sourceFile) { notify('Could not load source image', 'error'); return; }
    applyFile(sourceFile);
    if (handoff.characterId) setSelectedCharIds([handoff.characterId]);
    if (typeof handoff.aspectRatio === 'string' && ASPECT_RATIOS.includes(handoff.aspectRatio)) setAspectRatio(handoff.aspectRatio);
    if (typeof handoff.resolutionTier === 'string' && RESOLUTION_TIERS.includes(handoff.resolutionTier)) setResolutionTier(handoff.resolutionTier);
    notify('Loaded image into Pose Remix', 'success');
  }, [applyFile, consumePageParams, notify]);

  useEffect(() => {
    async function consumeHandoff() {
      try {
        const raw = localStorage.getItem('kyros_handoff');
        if (!raw) return;
        const handoff = JSON.parse(raw);
        if (handoff.feature !== 'pose-fix') return;
        if (Date.now() - handoff.ts > 60000) return;
        localStorage.removeItem('kyros_handoff');
        const imageUrl = handoff.pinImage;
        if (!imageUrl) return;
        notify('Loading pin image…', 'info');
        const resp = await fetch(`/api/pinterest/proxy?url=${encodeURIComponent(imageUrl)}`);
        if (!resp.ok) throw new Error(`Proxy ${resp.status}`);
        const blob = await resp.blob();
        const ext = blob.type.split('/')[1] || 'jpg';
        applyFile(new File([blob], `pin.${ext}`, { type: blob.type }));
        notify('Pin image auto-loaded ⚡', 'success');
      } catch (err) { notify(`Could not load pin: ${err.message}`, 'error'); }
    }
    consumeHandoff();
    window.addEventListener('kyros:handoff', consumeHandoff);
    return () => window.removeEventListener('kyros:handoff', consumeHandoff);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onPaste = (e) => {
      // Windows Explorer multi-file copy puts files in clipboardData.files
      const clipFiles = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
      if (clipFiles.length > 0) {
        e.preventDefault();
        addFiles(clipFiles);
        notify(`Pasted ${clipFiles.length} image${clipFiles.length > 1 ? 's' : ''} from clipboard`, 'success');
        return;
      }
      // Fallback: single screenshot pasted directly as image data
      const items = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/'));
      if (items.length === 0) return;
      e.preventDefault();
      const pastedFiles = items.map(i => i.getAsFile()).filter(Boolean);
      if (pastedFiles.length > 0) {
        addFiles(pastedFiles);
        notify(`Pasted ${pastedFiles.length} image${pastedFiles.length > 1 ? 's' : ''} from clipboard`, 'success');
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles, notify]);

  useEffect(() => {
    const onUseAsSource = (e) => {
      const { base64, mimeType, name } = e.detail || {};
      if (!base64 || !mimeType) return;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const ext = mimeType.split('/')[1] || 'png';
      applyFile(new File([bytes], name || `source.${ext}`, { type: mimeType }));
    };
    window.addEventListener('kyros:use-as-source', onUseAsSource);
    return () => window.removeEventListener('kyros:use-as-source', onUseAsSource);
  }, [applyFile]);

  useEffect(() => {
    const onInboxSource = (e) => {
      const items = Array.isArray(e.detail?.items) ? e.detail.items : [];
      if (items.length === 0) return;
      const converted = items
        .map((item) => ({ file: dataUrlToFile(item.dataUrl, item.name), sourceUrl: item.sourceUrl || null }))
        .filter((c) => c.file);
      if (converted.length === 0) return;
      addFiles(converted.map((c) => c.file), converted.map((c) => c.sourceUrl));
      notify(`Loaded ${converted.length} image${converted.length === 1 ? '' : 's'} from Paste Inbox into Pose Remix`, 'success');
    };
    window.addEventListener('kyros:use-as-pose-fix-source', onInboxSource);
    return () => window.removeEventListener('kyros:use-as-pose-fix-source', onInboxSource);
  }, [addFiles, notify]);

  // Reliable pickup: consume frames a sender stashed for us, on mount (survives the
  // lazy-load race the dispatched event can lose). addFiles dedup avoids doubles.
  useEffect(() => {
    const pending = consumeSourceHandoff('poseFix');
    if (pending.length) {
      const converted = pending
        .map((it) => ({ file: dataUrlToFile(it.dataUrl, it.name), sourceUrl: it.sourceUrl || null }))
        .filter((c) => c.file);
      if (converted.length) addFiles(converted.map((c) => c.file), converted.map((c) => c.sourceUrl));
    }
  }, [addFiles]);

  const onDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = async (e) => {
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
  const handleFileInput = (e) => { addFiles(e.target.files || []); e.target.value = ''; };

  const activeQueueCount = queueItems.filter(j => j.status === 'running').length;
  const pendingQueueCount = queueItems.filter(j => j.status === 'pending').length;
  const failedQueueCount = queueItems.filter(j => j.status === 'error').length;
  const directPoseMode = poseMode === 'direct';
  const completedQueueCount = queueItems.filter(j => j.status === 'completed').length;
  const totalJobs = directPoseMode ? files.length : files.length * selectedCharIds.length;

  const toggleCharacter = (id) => setSelectedCharIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const runQueueJob = useCallback((job) => {
    if (!job?.id || runningJobsRef.current.has(job.id)) return;
    runningJobsRef.current.add(job.id);

    const fileSnap = filesRef.current.find(f => f.id === job.fileId)?.file;
    const charIdSnap = job.characterId;
    const activeReferenceIds = Array.isArray(job.activeReferenceIds) ? job.activeReferenceIds : [];
    const opts = job.opts || {};
    const { poseStyle: ps, ar, resTier, imgModel, prov } = opts;

    if (!fileSnap) {
      runningJobsRef.current.delete(job.id);
      poseFixStore.setValue('queueItems', prev => prev.map(j => j.id === job.id ? { ...j, status: 'error', errorMessage: 'Source image was removed. Add it again to retry.' } : j));
      return;
    }

    pushPending({ id: job.id, prompt: 'Pose Remix', imageModel: imgModel || '', aspectRatio: ar, resolutionTier: resTier });

    fileToBase64(fileSnap).then(dataUri => {
      const base64 = dataUri.split(',')[1];
      return photoMatchApi.recreate({
        image: base64, mimeType: fileSnap.type, characterId: charIdSnap,
        activeReferenceIds: activeReferenceIds.length > 0 ? activeReferenceIds : undefined,
        poseFix: true, poseStyle: ps,
        aspectRatio: ar, resolutionTier: resTier, imageModel: imgModel,
        provider: prov, sourceUrl: job.sourceUrl || undefined,
      });
    }).then(data => {
      poseFixStore.setValue('result', data);
      poseFixStore.setValue('history', prev => [data, ...prev].slice(0, 12));
      poseFixStore.setValue('queueItems', prev => prev.filter(j => j.id !== job.id));
      // Auto-clear this source frame once nothing else needs it (see PhotoMatch note).
      if (!(poseFixStore.getSnapshot().queueItems || []).some(j => j.fileId === job.fileId)) {
        setFiles(prev => prev.filter(f => f.id !== job.fileId));
      }
      if (job.sourceName) clearFrameFailed([job.sourceName]); // succeeded → no longer Failed
      resolvePending(job.id, {
        imageId: data.imageId, galleryId: data.galleryId || data.imageId,
        mimeType: data.image?.mimeType,
        prompt: 'Pose Remix',
        imageModel: imgModel || '', aspectRatio: ar, resolutionTier: resTier,
        generatedAt: Date.now(), characterId: charIdSnap || null,
        sourceUrl: job.sourceUrl || data.sourceUrl || null,
      });
      notify('Pose remixed!', 'success');
    }).catch(err => {
      rejectPending(job.id);
      const msg = err?.message || 'Failed';
      const rateLimited = isRateLimitMessage(msg);
      const permanent = isPermanentFailure(msg);
      const autoOn = autoRetryAllRef.current;
      const attempts = ((poseFixStore.getSnapshot().queueItems || []).find(x => x.id === job.id)?.rlAttempts || 0) + 1;
      const gaveUp = attempts >= GIVE_UP_AFTER_ATTEMPTS;
      const willAutoRetry = !permanent && !gaveUp && autoOn;
      poseFixStore.setValue('queueItems', prev => prev.map(j => {
        if (j.id !== job.id) return j;
        const cooldown = rateLimited ? rateLimitCooldown(attempts) : AUTO_RETRY_COOLDOWN_MS;
        return {
          ...j,
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
        const srcEntry = filesRef.current.find(f => f.id === job.fileId);
        markFrameFailed(job.sourceName || job.summary || srcEntry?.file?.name, srcEntry?.previewUrl, 'Pose Remix');
      }
      // Only toast errors the user must act on (permanent, given-up, or not being auto-retried).
      if (!willAutoRetry) notify(gaveUp ? `Gave up after ${attempts} tries — marked Failed in Library` : msg, 'error');
    }).finally(() => {
      runningJobsRef.current.delete(job.id);
    });
  }, [notify]);

  useEffect(() => {
    if (queuePaused || !sourcesHydrated) return;
    const runningCount = queueItems.filter(j => j.status === 'running').length;
    const slots = MAX_RUNNING_PHOTO_MATCH_JOBS - runningCount;
    if (slots <= 0) return;

    const nextJobs = queueItems.filter(j => j.status === 'pending').slice(0, slots);
    if (nextJobs.length === 0) return;

    poseFixStore.setValue('queueItems', prev => prev.map(j => (
      nextJobs.some(nextJob => nextJob.id === j.id) ? { ...j, status: 'running', errorMessage: '' } : j
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
      const snap = poseFixStore.getSnapshot();
      const hasReady = (snap.queueItems || []).some(j => isAutoRetryReady(j, now, autoRetryAll));
      if (!hasReady) return;
      poseFixStore.setValue('queueItems', prev => prev.map(j => (
        isAutoRetryReady(j, now, autoRetryAll)
          ? { ...j, status: 'pending', rateLimited: false, retryAt: null, errorMessage: '' }
          : j
      )));
    }, 2500);
    return () => clearInterval(timer);
  }, [queuePaused, autoRetryAll]);

  // When "keep retrying" is switched on, arm any already-failed (non-permanent) jobs
  // so they resume — otherwise jobs that failed while it was off would sit there.
  useEffect(() => {
    if (!autoRetryAll) return;
    const snap = poseFixStore.getSnapshot();
    const needsArming = (snap.queueItems || []).some(j => j.status === 'error' && !j.permanent && !j.retryAt);
    if (!needsArming) return;
    poseFixStore.setValue('queueItems', prev => prev.map(j => (
      j.status === 'error' && !j.permanent && !j.retryAt
        ? { ...j, retryAt: Date.now() + AUTO_RETRY_COOLDOWN_MS }
        : j
    )));
  }, [autoRetryAll]);

  const handleGenerate = () => {
    if (files.length === 0) { notify('Add at least one source image', 'error'); return; }
    if (!directPoseMode && selectedCharIds.length === 0) { notify('Select at least one character', 'error'); return; }
    const poseLabel = POSE_STYLE_OPTIONS.find(p => p.value === poseStyle)?.label || 'Pose';
    const opts = { poseStyle, ar: aspectRatio, resTier: resolutionTier, imgModel: imageModel, prov: provider };
    const jobs = [];

    if (directPoseMode) {
      // Direct pose: one job per source image, no character
      for (const { file: f, id: fileId, sourceUrl } of files) {
        jobs.push({
          id: makePersistentJobId('pose-fix'), kind: 'pose-fix', status: 'pending',
          fileId, characterId: null, activeReferenceIds: [], opts, sourceUrl,
          sourceName: f.name || null,
          label: 'Pose Remix (Direct)',
          summary: f.name || 'Direct pose remix',
          meta: `${aspectRatio} · ${resolutionTier}`,
          badges: [{ label: poseLabel, color: 'purple' }, { label: 'Direct', color: 'zinc' }],
        });
      }
    } else {
      for (const { file: f, id: fileId, sourceUrl } of files) {
        for (const charIdSnap of selectedCharIds) {
          const charDetailSnap = charDetails[charIdSnap] || null;
          const activeReferenceIds = charDetailSnap?.references?.filter(r => r.isActive).map(r => r.id) || [];
          jobs.push({
            id: makePersistentJobId('pose-fix'), kind: 'pose-fix', status: 'pending',
            fileId, characterId: charIdSnap, activeReferenceIds, opts, sourceUrl,
            sourceName: f.name || null,
            label: 'Pose Remix',
            summary: f.name || 'Pose remix',
            meta: `${aspectRatio} · ${resolutionTier}`,
            badges: [
              charDetailSnap?.name ? { label: charDetailSnap.name, color: 'zinc' } : null,
              { label: poseLabel, color: 'blue' },
            ].filter(Boolean),
          });
        }
      }
    }

    poseFixStore.setValue('queueItems', prev => [...prev, ...jobs]);
    notify(`${jobs.length} job${jobs.length === 1 ? '' : 's'} added to queue`, 'success');
  };

  // Manual retry — always a fresh attempt (reset counters) reusing the job's original
  // character + frame reference + source image. Works whether auto-retry is on or off.
  const retryJob = (id) => {
    poseFixStore.setValue('queueItems', prev => prev.map(j => j.id === id ? { ...j, status: 'pending', rateLimited: false, permanent: false, rlAttempts: 0, retryAt: null, errorMessage: '' } : j));
  };

  const retryAllInTool = async (toKey) => {
    const { moved, skipped, page } = await moveFailedJobsToTool('poseFix', toKey);
    if (!moved) { notify(skipped ? 'Source frames were removed — can’t move' : 'No failed jobs to move', 'error'); return; }
    notify(`Moved ${moved} job${moved === 1 ? '' : 's'} to ${crossToolLabel(toKey)}${skipped ? ` (${skipped} skipped)` : ''} ⚡`, 'success');
    navigateTo(page);
  };

  const retryAllJobs = () => {
    poseFixStore.setValue('queueItems', prev => prev.map(j => j.status === 'error' ? { ...j, status: 'pending', rateLimited: false, permanent: false, rlAttempts: 0, retryAt: null, errorMessage: '' } : j));
  };

  const clearFailedJobs = () => {
    poseFixStore.setValue('queueItems', prev => prev.filter(j => j.status !== 'error'));
  };

  const clearCompletedJobs = () => {
    poseFixStore.setValue('queueItems', prev => prev.filter(j => j.status !== 'completed'));
  };

  const cancelPendingJobs = () => {
    poseFixStore.setValue('queueItems', prev => prev.filter(j => j.status !== 'pending'));
  };

  // ── In-page Library picker ──────────────────────────────────────────────
  const openLibraryPicker = useCallback(async () => {
    setShowLibraryPicker(true);
    setLibVisible(200);
    if (libItems.length === 0) {
      setLibLoading(true);
      try {
        const data = await libraryApi.list();
        setLibItems((data?.items || []).filter((it) => it.mediaType === 'image'));
      } catch (err) {
        notify(err?.message || 'Failed to load library', 'error');
      } finally {
        setLibLoading(false);
      }
    }
  }, [libItems.length, notify]);

  const toggleLibSelect = (id) => setLibSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const addSelectedFromLibrary = useCallback(async () => {
    const chosen = libItems.filter((it) => libSelected.has(it.id));
    if (chosen.length === 0) { notify('Select at least one image', 'error'); return; }
    setLibBusy(true);
    try {
      const toAdd = [];
      for (const it of chosen) {
        try {
          const resp = await fetch(it.downloadUrl || `/api/gallery/${it.originalId}/image`, { credentials: 'include' });
          if (!resp.ok) continue;
          const blob = await resp.blob();
          const name = it.metadata?.filename || `library-${it.originalId}.png`;
          toAdd.push(new File([blob], name, { type: blob.type || 'image/png' }));
        } catch { /* skip this one */ }
      }
      if (toAdd.length === 0) { notify('Could not load the selected images', 'error'); return; }
      await addFiles(toAdd);
      notify(`Added ${toAdd.length} image${toAdd.length === 1 ? '' : 's'} from Library`, 'success');
      setLibSelected(new Set());
      setShowLibraryPicker(false);
    } finally {
      setLibBusy(false);
    }
  }, [libItems, libSelected, addFiles, notify]);

  const filteredLib = (() => {
    const q = libSearch.trim().toLowerCase();
    if (!q) return libItems;
    return libItems.filter((it) => {
      const name = (it.metadata?.filename || '').toLowerCase();
      const prompt = String(it.prompt || it.basePrompt || '').toLowerCase();
      return name.includes(q) || prompt.includes(q);
    });
  })();

  return (
    <div className="space-y-6 animate-in">
      <div className="max-w-md">
        <div className="space-y-4">

          {/* Source Images — multi-drop zone */}
          <Card className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-medium text-zinc-200">Source Images</h3>
              <div className="flex items-center gap-2">
                {files.length > 0 && <Badge color="blue">{files.length} photo{files.length > 1 ? 's' : ''}</Badge>}
                <Badge color="zinc">Ctrl+V to paste</Badge>
              </div>
            </div>

            {/* Drop zone */}
            <div
              ref={dropRef}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`flex items-center justify-center border-2 border-dashed rounded-xl cursor-pointer transition-all min-h-[80px] px-4 py-4 ${
                isDragging ? 'border-rose-500/80 bg-rose-500/10' : 'border-zinc-700/80 hover:border-zinc-500'
              }`}
            >
              <div className="text-center flex flex-col items-center gap-1.5 [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor]">
                <IconImage uniqueId="pm-upload" size={24} className="text-zinc-600" aria-hidden />
                <p className="text-sm text-zinc-400 font-medium">Drop photos here or click to browse</p>
                <p className="text-xs text-zinc-600">PNG, JPEG, WebP · no image limit</p>
              </div>
              <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={handleFileInput} />
            </div>

            {/* Pick from Library */}
            <button type="button" onClick={openLibraryPicker}
              className="w-full flex items-center justify-center gap-2 rounded-lg border border-zinc-700/70 bg-zinc-900/50 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 cursor-pointer">
              <IconImage uniqueId="pf-lib" size={14} aria-hidden /> Choose from Library
            </button>

            {/* Thumbnail grid */}
            {files.length > 0 && (
              <div>
                <div className="grid grid-cols-4 gap-2">
                  {files.map(({ id, previewUrl, file: f }) => (
                    <div key={id} className="relative group aspect-square rounded-lg overflow-hidden border border-zinc-700/60 bg-zinc-900">
                      <img src={previewUrl} alt={f.name} className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeFile(id); }}
                        className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/70 text-zinc-300 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-xs font-bold hover:bg-red-500/80 hover:text-white"
                      >×</button>
                    </div>
                  ))}
                  {/* Add more tile */}
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="aspect-square rounded-lg border-2 border-dashed border-zinc-700/60 hover:border-zinc-500 bg-zinc-900/40 flex items-center justify-center cursor-pointer transition"
                  >
                    <span className="text-zinc-600 text-xl font-light">+</span>
                  </div>
                </div>
                <button type="button" onClick={clearAll} className="mt-2 text-xs text-zinc-600 hover:text-red-400 transition">Clear all</button>
              </div>
            )}

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

          {/* Pose Style */}
          <Card className="space-y-3">
            <h3 className="text-base font-medium text-zinc-200">Pose Style</h3>
            <p className="text-[0.6875rem] leading-relaxed text-zinc-500">
              Keeps the same person, outfit, and location from your photo, then re-poses them — hands, body, and facial expression — into a flattering Instagram pose, reframed to your chosen aspect ratio.
            </p>
            <div className="grid grid-cols-1 gap-2">
              {POSE_STYLE_OPTIONS.map((p) => (
                <button key={p.value} type="button" onClick={() => setPoseStyle(p.value)}
                  className={`rounded-lg border px-3 py-2 text-left transition cursor-pointer ${poseStyle === p.value ? 'border-rose-500/60 bg-rose-500/15' : 'border-zinc-700/70 bg-zinc-900/50 hover:border-zinc-600'}`}>
                  <div className={`text-sm font-medium ${poseStyle === p.value ? 'text-rose-100' : 'text-zinc-300'}`}>{p.label}</div>
                  <div className="text-[0.6875rem] text-zinc-500">{p.hint}</div>
                </button>
              ))}
            </div>
          </Card>

          {/* Character / Mode card */}
          <Card className="space-y-4">
            {/* Mode toggle */}
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-2">Mode</span>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { value: 'direct', icon: '⚡', label: 'Direct Pose', hint: 'Reposes the exact person in the photo — no character needed' },
                  { value: 'character', icon: '👤', label: 'Use Character', hint: 'Replaces identity with a saved character' },
                ].map(m => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setPoseMode(m.value)}
                    className={`rounded-xl border px-3 py-2.5 text-left transition cursor-pointer ${
                      poseMode === m.value
                        ? m.value === 'direct'
                          ? 'border-rose-500/70 bg-rose-500/15 text-rose-100'
                          : 'border-rose-500/70 bg-rose-500/15 text-rose-100'
                        : 'border-zinc-700/50 bg-zinc-900/40 text-zinc-400 hover:border-zinc-600'
                    }`}
                  >
                    <div className="text-base mb-0.5">{m.icon} <span className="text-[0.75rem] font-semibold align-middle">{m.label}</span></div>
                    <div className="text-[0.625rem] text-zinc-500 leading-tight">{m.hint}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Direct pose info OR character list */}
            {poseMode === 'direct' ? (
              <div className="rounded-xl border border-rose-500/20 bg-rose-500/8 px-3 py-2.5">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-rose-400 text-sm">⚡</span>
                  <span className="text-xs font-semibold text-rose-300">Direct Pose Active</span>
                </div>
                <p className="text-[0.6875rem] text-zinc-400 leading-relaxed">
                  Sends your source photo directly to AI — keeps the same person, face, outfit, and background. Only changes the pose.
                </p>
              </div>
            ) : (
              <CharacterPicker
                chars={chars}
                selectedIds={selectedCharIds}
                onToggle={toggleCharacter}
                charDetails={charDetails}
                label="Character"
              />
            )}

            {/* Image Model */}
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Image Model</span>
              <select value={imageModel} onChange={e => setImageModel(e.target.value)}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-rose-500/70 cursor-pointer">
                {IMAGE_MODEL_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
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

            {/* Aspect Ratio */}
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-2">Aspect Ratio</span>
              <div className="flex flex-wrap gap-1.5">
                {ASPECT_RATIOS.map(ar => (
                  <button key={ar} onClick={() => setAspectRatio(ar)}
                    className={`rounded-md px-2 py-1 text-xs font-medium transition cursor-pointer ${aspectRatio === ar ? 'bg-rose-600 text-white' : 'bg-zinc-700/60 text-zinc-400 hover:bg-zinc-600'}`}>
                    {ar}
                  </button>
                ))}
              </div>
            </div>

            {/* Resolution */}
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-2">Resolution</span>
              <div className="flex gap-2">
                {RESOLUTION_TIERS.map(tier => (
                  <button key={tier} onClick={() => setResolutionTier(tier)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${resolutionTier === tier ? 'bg-rose-500 text-white' : 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600'}`}>
                    {tier}
                  </button>
                ))}
              </div>
            </div>

            {/* Job count summary */}
            {totalJobs > 1 && files.length > 0 && (!directPoseMode ? selectedCharIds.length > 0 : true) && (
              <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 px-3 py-2 text-xs text-rose-300">
                {directPoseMode
                  ? <>{files.length} photo{files.length > 1 ? 's' : ''} = <span className="font-bold">{totalJobs} job{totalJobs > 1 ? 's' : ''}</span></>
                  : <>{files.length} photo{files.length > 1 ? 's' : ''} × {selectedCharIds.length} character{selectedCharIds.length > 1 ? 's' : ''} = <span className="font-bold">{totalJobs} jobs</span></>
                }
              </div>
            )}

            <Btn onClick={handleGenerate} disabled={files.length === 0 || (!directPoseMode && selectedCharIds.length === 0)} className="w-full">
              {activeQueueCount > 0
                ? <>Queue More · {activeQueueCount}/2 running</>
                : totalJobs > 1
                  ? <>Pose Remix ×{totalJobs}</>
                  : <>Pose Remix</>
              }
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
                  <button type="button" onClick={cancelPendingJobs} disabled={pendingQueueCount === 0} className="rounded-md border border-red-800/60 bg-red-950/40 px-2.5 py-1 text-xs font-medium text-red-400 transition hover:border-red-600 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer">
                    Cancel pending ({pendingQueueCount})
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
                              <Badge key={`${job.id}-${badge?.label || badge}-${index}`} color={badge?.color || 'zinc'}>
                                {badge?.label || badge}
                              </Badge>
                            ))}
                          </div>
                          <div className="truncate text-sm text-zinc-200">{job.summary || 'Pose remix'}</div>
                          {job.meta && <div className="text-[0.625rem] font-mono text-zinc-600">{job.meta}</div>}
                          {job.status === 'error' && <div className={`text-xs line-clamp-3 ${willRetry ? 'text-yellow-300/80' : 'text-red-300'}`}>{job.errorMessage || 'Failed'}</div>}
                        </div>
                        {job.status === 'running' ? (
                          <Spinner size={16} />
                        ) : job.status === 'error' ? (
                          <button type="button" onClick={() => retryJob(job.id)} className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-200 transition hover:bg-red-500/20 cursor-pointer">
                            Retry
                          </button>
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

      {/* Library picker modal — portaled to <body> so `fixed` escapes the page's
          transformed (animate-in) ancestor and truly fills the viewport. */}
      {showLibraryPicker && createPortal((
        <div className="fixed inset-0 z-[100] flex bg-black/80 p-3" onClick={() => !libBusy && setShowLibraryPicker(false)}>
          <div className="flex h-full w-full flex-col rounded-2xl border border-zinc-700/70 bg-zinc-950 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">Choose from Library</h3>
                <p className="text-[0.6875rem] text-zinc-500">{libSelected.size} selected · {libItems.length} images</p>
              </div>
              <button type="button" onClick={() => setShowLibraryPicker(false)} className="text-2xl leading-none text-zinc-400 hover:text-zinc-200">×</button>
            </div>
            <div className="border-b border-zinc-800 px-4 py-2">
              <input value={libSearch} onChange={(e) => { setLibSearch(e.target.value); setLibVisible(200); }} placeholder="Search by filename or prompt…"
                className="w-full rounded-lg border border-zinc-700/60 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-rose-500/60" />
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {libLoading ? (
                <div className="flex items-center justify-center py-16"><Spinner size={28} /></div>
              ) : filteredLib.length === 0 ? (
                <p className="py-16 text-center text-sm text-zinc-500">No images found.</p>
              ) : (
                <>
                  <div className="grid grid-cols-4 gap-3 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-8">
                    {filteredLib.slice(0, libVisible).map((it) => {
                      const sel = libSelected.has(it.id);
                      return (
                        <button key={it.id} type="button" onClick={() => toggleLibSelect(it.id)}
                          className={`relative aspect-square overflow-hidden rounded-lg border transition ${sel ? 'border-rose-500 ring-2 ring-rose-500/50' : 'border-zinc-700/60 hover:border-zinc-500'}`}>
                          <img src={it.previewUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                          {sel && <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[0.6875rem] font-bold text-white">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                  {filteredLib.length > libVisible && (
                    <div className="mt-3 flex justify-center">
                      <button type="button" onClick={() => setLibVisible((v) => v + 120)} className="rounded-md border border-zinc-700/70 bg-zinc-900/70 px-4 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500">
                        Load more ({filteredLib.length - libVisible} left)
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-4 py-3">
              <button type="button" onClick={() => setLibSelected(new Set())} disabled={libSelected.size === 0} className="text-xs text-zinc-500 transition hover:text-zinc-300 disabled:opacity-40">Clear selection</button>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setShowLibraryPicker(false)} className="rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:border-zinc-500">Cancel</button>
                <Btn onClick={addSelectedFromLibrary} disabled={libSelected.size === 0 || libBusy}>
                  {libBusy ? 'Adding…' : `Add ${libSelected.size || ''} to sources`}
                </Btn>
              </div>
            </div>
          </div>
        </div>
      ), document.body)}

      <LightboxComponent />
    </div>
  );
}
