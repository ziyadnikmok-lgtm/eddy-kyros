import { useState, useEffect, useCallback, useRef } from 'react';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { photoMatch as photoMatchApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Badge, Spinner } from '../components/UI';
import CharacterPicker from '../components/CharacterPicker';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { ASPECT_RATIOS, RESOLUTION_TIERS, IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL } from '../config/photoModes';
import { makePersistentJobId } from '../lib/persistentPageState';
import { photoMatchStore, setQueuePageActive } from '../lib/generationQueues';
import { moveFailedJobsToTool, crossToolLabel } from '../lib/crossToolRetry';
import { markFrameFailed, clearFrameFailed } from '../lib/frameOutcomes';
import { loadSources, saveSources, clearSources } from '../lib/photoMatchSourceStore';
import { addFramesToLibrary } from '../lib/frameLibrary';
import { consumeSourceHandoff } from '../lib/sourceHandoff';
import { extractOneLink, runWithConcurrency } from '../lib/frameExtract';
import { autoBlurFace } from '../lib/autoBlurFace';
import ManualBlurModal from '../components/ManualBlurModal';
import { IconImage } from 'nucleo-glass';

const PHOTO_MATCH_HANDOFF_KEY = 'kyros.photoMatch.handoff';
const PHOTO_MATCH_SOURCE_STORAGE_KEY = 'kyros.photoMatch.sources';
const PHOTO_MATCH_PROVIDER_KEY = 'kyros.photoMatch.provider';
const PHOTO_MATCH_AUTORETRY_KEY = 'kyros.photoMatch.autoRetryAll';
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
// After this many failed attempts, give up auto-retrying and mark the source frame Failed
// (surfaced in the Frame Library's "Failed" filter). A manual Retry resets the count.
const GIVE_UP_AFTER_ATTEMPTS = 5;
// Cooldown before a non-rate-limit error is auto-retried (when "keep retrying" is on).
const AUTO_RETRY_COOLDOWN_MS = 8000;
const isRateLimitMessage = (msg) => /rate limit|quota|resource[_ ]exhausted|\b429\b/i.test(String(msg || ''));
// Errors that can never succeed on retry — never auto-loop these.
const isPermanentFailure = (msg) => /source image was removed|no character identity|add it again/i.test(String(msg || ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Link-extract failures worth auto-retrying (network / rate / timeout / unknown).
// Clearly-permanent ones (private post, bad cookies, deleted, 404) are NOT retried.
const isTransientExtractError = (msg) => {
  const m = String(msg || '').toLowerCase();
  if (/private|cookie|not found|404|deleted|removed|no frames/.test(m)) return false;
  return true;
};
// Extract a short post id from an IG/TikTok/X link (for traceable filenames + labels).
function linkShortId(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const known = ['p', 'reel', 'reels', 'tv', 'video', 'status'];
    const idx = parts.findIndex((p) => known.includes(p.toLowerCase()));
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1].slice(0, 24);
    return (parts[parts.length - 1] || '').slice(0, 24);
  } catch { return ''; }
}
// A job is eligible for automatic re-queue when its cooldown has elapsed.
// Auto-retry is now FULLY governed by the "Keep retrying" toggle: on = retry every
// non-permanent failure (incl. rate-limits) until it succeeds; off = fully manual — nothing
// auto-retries, so failures pile up as errors for you to "Retry all" by hand.
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

function StrengthSlider({ label, sublabel, value, onChange, color = '#6366f1', disabled = false }) {
  const low = value < 35;
  const mid = value >= 35 && value < 70;
  const levelLabel = low ? 'Loose' : mid ? 'Close' : value >= 85 ? 'Exact' : 'Strong';
  const levelColor = low ? '#f59e0b' : mid ? '#3b82f6' : '#22c55e';
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="text-sm font-medium text-zinc-200">{label}</span>
          {sublabel && <span className="text-xs text-zinc-500 ml-2">{sublabel}</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-zinc-400">{value}%</span>
          <span className="text-[0.625rem] font-semibold rounded-full px-2 py-0.5" style={{ background: levelColor + '22', color: levelColor, border: `1px solid ${levelColor}44` }}>{levelLabel}</span>
        </div>
      </div>
      <div className="relative h-7 flex items-center">
        <div className="absolute inset-x-0 h-1.5 rounded-full bg-zinc-800" />
        <div className="absolute left-0 h-1.5 rounded-full transition-all" style={{ width: `${value}%`, background: `linear-gradient(90deg, ${color}88, ${color})` }} />
        <input type="range" min="0" max="100" step="5" value={value}
          onChange={e => onChange(Number(e.target.value))} disabled={disabled}
          className={`absolute inset-x-0 w-full opacity-0 h-7 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
          style={{ zIndex: 2 }} />
        <div className="absolute h-4 w-4 rounded-full shadow-lg border-2 border-white/20 pointer-events-none transition-all"
          style={{ left: `calc(${value}% - 8px)`, background: color, boxShadow: `0 0 8px ${color}66` }} />
      </div>
      <div className="flex justify-between text-[0.625rem] text-zinc-600 mt-1 px-0.5">
        <span>Loose</span><span>Close</span><span>Exact</span>
      </div>
    </div>
  );
}

const MATCH_PRESETS = [
  { id: 'portrait',  label: '🧍 Portrait',  desc: 'New background, keep character look',    bg: 40,  pose: 30,  exact: false, vary: false },
  { id: 'scene',     label: '🌆 Scene',     desc: 'Same environment, fresh character pose',  bg: 85,  pose: 40,  exact: false, vary: true  },
  { id: 'pose',      label: '🤸 Pose',      desc: 'Follow the pose closely',                 bg: 50,  pose: 85,  exact: false, vary: false },
  { id: 'creative',  label: '✨ Creative',  desc: 'Loose interpretation, max variation',     bg: 20,  pose: 15,  exact: false, vary: true  },
  { id: 'exact',     label: '🎯 Exact',     desc: 'Lock everything — same outfit & scene',   bg: 100, pose: 100, exact: true,  vary: false },
];
const PM_LAST_CHAR_KEY = 'kyros.photoMatch.lastCharId';

const _cache = {
  selectedCharIds: [], bgStrength: 85, poseStrength: 85,
  exactRecreate: false, varyBackground: false, aspectRatio: '9:16', resolutionTier: '1K',
  blurSource: true,
  imageModel: DEFAULT_IMAGE_MODEL,
  provider: 'gemini',
};

export default function PhotoMatchPage() {
  const { notify, characters: chars, consumePageParams, navigateTo } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const dropRef = useRef(null);
  const fileInputRef = useRef(null);
  const filesRef = useRef([]);
  const runningJobsRef = useRef(new Set());
  const initialStoreState = photoMatchStore.getSnapshot();

  // Multiple source files — hydrated from IndexedDB on mount (see hydrate effect below).
  const [files, setFiles] = useState([]); // [{ file, previewUrl, id }]
  const hydratedRef = useRef(false);
  // Gate job dispatch until sources have loaded from IndexedDB — otherwise jobs handed in
  // from another tool would fire before their source frame is in memory and instantly fail.
  const [sourcesHydrated, setSourcesHydrated] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedCharIds, setSelectedCharIds] = useState(_cache.selectedCharIds);
  const [charDetails, setCharDetails] = useState({});
  const [bgStrength, setBgStrength] = useState(_cache.bgStrength);
  const [poseStrength, setPoseStrength] = useState(_cache.poseStrength);
  const [exactRecreate, setExactRecreate] = useState(_cache.exactRecreate);
  const [varyBackground, setVaryBackground] = useState(_cache.varyBackground);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolutionTier, setResolutionTier] = useState(_cache.resolutionTier);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [provider, setProvider] = useState(() => {
    try { return window.localStorage.getItem(PHOTO_MATCH_PROVIDER_KEY) || _cache.provider; } catch { return _cache.provider; }
  });
  const [queueItems, setQueueItems] = useState(initialStoreState.queueItems);
  const [queuePaused, setQueuePaused] = useState(false);
  // Auto-blur every source face as it's added (paste/drop/upload/handoff — addFiles is the one
  // choke point all of them funnel through), because Gemini anchors on ANY face it's shown and no
  // prompt wording reliably beats a visible one. blurSourceRef mirrors it for addFiles, which is a
  // stable useCallback and must read the CURRENT toggle without retriggering on every flip.
  const [blurSource, setBlurSource] = useState(_cache.blurSource ?? true);
  const blurSourceRef = useRef(blurSource);
  useEffect(() => { blurSourceRef.current = blurSource; _cache.blurSource = blurSource; }, [blurSource]);
  const [blurringAll, setBlurringAll] = useState(false);
  const [manualBlurId, setManualBlurId] = useState(null);   // source file id being hand-blurred, or null
  const [autoRetryAll, setAutoRetryAll] = useState(() => {
    try { const v = window.localStorage.getItem(PHOTO_MATCH_AUTORETRY_KEY); return v === null ? true : v === '1'; } catch { return true; }
  });
  const autoRetryAllRef = useRef(autoRetryAll);

  const [instagramLinks, setInstagramLinks] = useState('');
  const [failedInstagramLinks, setFailedInstagramLinks] = useState([]);
  const [isExtractingInstagram, setIsExtractingInstagram] = useState(false);
  const [showInstagramImport, setShowInstagramImport] = useState(false);
  const [copiedJobId, setCopiedJobId] = useState(null);
  const [previewSrc, setPreviewSrc] = useState(null);
  const [activePreset, setActivePreset] = useState('pose');

  // While this page is mounted it drives its own queue; when unmounted the background
  // worker takes over so pending/retry jobs keep going after you navigate away.
  useEffect(() => {
    setQueuePageActive('photo-match', true);
    return () => setQueuePageActive('photo-match', false);
  }, []);
  useEffect(() => { _cache.selectedCharIds = selectedCharIds; }, [selectedCharIds]);
  useEffect(() => {
    _cache.provider = provider;
    try { window.localStorage.setItem(PHOTO_MATCH_PROVIDER_KEY, provider); } catch { /* ignore */ }
  }, [provider]);
  useEffect(() => {
    autoRetryAllRef.current = autoRetryAll;
    try { window.localStorage.setItem(PHOTO_MATCH_AUTORETRY_KEY, autoRetryAll ? '1' : '0'); } catch { /* ignore */ }
  }, [autoRetryAll]);
  useEffect(() => photoMatchStore.subscribe((s) => setQueueItems(s.queueItems)), []);
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
      // MERGE (don't overwrite): a handoff event (e.g. a frame sent from Frame Grabber)
      // may add files before this async load finishes — clobbering them would lose the
      // just-sent image. Keep whatever's there and add restored items not already present.
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

  // Backfill: surface jobs that already gave up (failed ≥5×) as Failed in the Library — e.g.
  // ones that hit the cap before this existed, or before a restart. Idempotent (deduped).
  useEffect(() => {
    if (!sourcesHydrated) return;
    for (const j of (photoMatchStore.getSnapshot().queueItems || [])) {
      if (j.status !== 'error' || (j.rlAttempts || 0) < GIVE_UP_AFTER_ATTEMPTS) continue;
      const entry = filesRef.current.find(f => f.id === j.fileId);
      markFrameFailed(j.sourceName || j.summary || entry?.file?.name, entry?.previewUrl, 'Photo Match');
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

  // Auto-remember last used character
  useEffect(() => {
    if (selectedCharIds.length > 0) {
      try { window.localStorage.setItem(PM_LAST_CHAR_KEY, selectedCharIds[0]); } catch {}
    }
  }, [selectedCharIds]);

  // Auto-select last used character on first load if none selected
  useEffect(() => {
    if (selectedCharIds.length === 0 && chars.length > 0) {
      try {
        const lastId = window.localStorage.getItem(PM_LAST_CHAR_KEY);
        if (lastId && chars.find(c => c.id === lastId)) setSelectedCharIds([lastId]);
      } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chars]);



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
      photoMatchStore.setValue('result', null);
      // Auto-save every extracted frame to the Frame Library.
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

  const handleRetryAllFailed = async () => {
    if (isExtractingInstagram || failedInstagramLinks.length === 0) return;
    const urls = failedInstagramLinks.map(f => f.url).join('\n');
    setFailedInstagramLinks([]);
    await handleInstagramImport(urls);
  };

  // sourceUrls (optional): array parallel to `incoming` — the originating IG/TikTok/X post
  // link for each file, if any. Carried through to the job so a generated image can link
  // back to its source video (see the queue card's "copy source link" button).
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

    let missedBlur = 0;
    const next = await Promise.all(compressed.map(async (f, i) => {
      let previewUrl = await fileToBase64(f);
      let file = f;
      let blurred = false;
      // Blurred BEFORE this becomes the file that's actually dispatched — runQueueJob reads
      // .file, never .previewUrl, so a blur that only touched the preview would leave the real
      // upload to Gemini unblurred.
      if (blurSourceRef.current) {
        const out = await autoBlurFace(previewUrl);
        if (out.blurred) {
          previewUrl = out.dataUrl;
          const rebuilt = dataUrlToFile(out.dataUrl, f.name);
          if (rebuilt) file = rebuilt;
          blurred = true;
        } else {
          missedBlur += 1;
        }
      }
      return {
        file,
        previewUrl,
        blurred,
        // The PRE-blur name+size, kept stable across a later re-blur (retry face blur below changes
        // file.size again via its own re-encode). This is the dedupe/identity key — comparing on
        // file.size directly would treat the same source photo as "different" after any blur pass.
        origKey: `${f.name}::${f.size}`,
        id: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`,
        sourceUrl: validSourceUrls[i] || null,
      };
    }));
    if (missedBlur) notify(`${missedBlur} photo(s): no face found to blur — use "Retry face blur" below`, 'error');
    // Skip images already present (same ORIGINAL name+size) so re-sending the same frame from Frame
    // Grabber / Library doesn't create duplicates — keyed off origKey, not file.size, since blurring
    // re-encodes the file and changes its byte size even for the exact same source image.
    setFiles(prev => {
      const seen = new Set(prev.map(e => e.origKey || `${e.file?.name}::${e.file?.size}`));
      const deduped = next.filter((e) => !seen.has(e.origKey));
      return [...prev, ...deduped];
    });
    photoMatchStore.setValue('result', null);
  }, [notify]);

  const removeFile = (id) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const clearAll = () => {
    setFiles([]);
  };

  // Re-run face detection in AGGRESSIVE mode over every source not already blurred — catches the
  // profile/tilted faces the conservative pass at add-time misses. Rebuilds BOTH previewUrl and the
  // actual dispatched .file (runQueueJob reads .file, never .previewUrl), same as addFiles above.
  // Safe to press repeatedly: only un-blurred entries are ever touched.
  const blurAllFaces = useCallback(async () => {
    const targets = files.filter((f) => !f.blurred);
    if (!targets.length) { notify('Every source is already blurred', 'info'); return; }
    setBlurringAll(true);
    let blurred = 0; let missed = 0;
    const results = await Promise.all(targets.map(async (entry) => {
      const out = await autoBlurFace(entry.previewUrl, { aggressive: true });
      if (!out.blurred) { missed += 1; return null; }
      const rebuilt = dataUrlToFile(out.dataUrl, entry.file?.name);
      blurred += 1;
      return { id: entry.id, previewUrl: out.dataUrl, file: rebuilt || entry.file, blurred: true };
    }));
    const byId = new Map(results.filter(Boolean).map((r) => [r.id, r]));
    setFiles((prev) => prev.map((f) => (byId.has(f.id) ? { ...f, ...byId.get(f.id) } : f)));
    setBlurringAll(false);
    if (blurred && !missed) notify(`Blurred ${blurred} face${blurred === 1 ? '' : 's'} ✨`, 'success');
    else if (blurred) notify(`Blurred ${blurred}; ${missed} still had no detectable face — click those to blur by hand`, 'error');
    else notify('No faces detected — click a photo to blur by hand', 'error');
  }, [files, notify]);

  // Apply a hand-drawn blur box from the modal, mirroring blurAllFaces' file rebuild.
  const applyManualBlur = useCallback((id, newDataUrl) => {
    setFiles((prev) => prev.map((f) => {
      if (f.id !== id) return f;
      const rebuilt = dataUrlToFile(newDataUrl, f.file?.name);
      return { ...f, previewUrl: newDataUrl, file: rebuilt || f.file, blurred: true };
    }));
    setManualBlurId(null);
    notify('Face blurred by hand ✨', 'success');
  }, [notify]);

  const unblurredCount = files.filter((f) => !f.blurred).length;

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
    if (handoff.exactRecreate === true) { setExactRecreate(true); setBgStrength(100); setPoseStrength(100); }
    if (typeof handoff.aspectRatio === 'string' && ASPECT_RATIOS.includes(handoff.aspectRatio)) setAspectRatio(handoff.aspectRatio);
    if (typeof handoff.resolutionTier === 'string' && RESOLUTION_TIERS.includes(handoff.resolutionTier)) setResolutionTier(handoff.resolutionTier);
    notify('Loaded image from NSFW Generate', 'success');
  }, [applyFile, consumePageParams, notify]);

  useEffect(() => {
    async function consumeHandoff() {
      try {
        const raw = localStorage.getItem('kyros_handoff');
        if (!raw) return;
        const handoff = JSON.parse(raw);
        if (handoff.feature !== 'photo-match') return;
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
      notify(`Loaded ${converted.length} image${converted.length === 1 ? '' : 's'} from Paste Inbox into Photo Match`, 'success');
    };
    window.addEventListener('kyros:use-as-photo-match-source', onInboxSource);
    return () => window.removeEventListener('kyros:use-as-photo-match-source', onInboxSource);
  }, [addFiles, notify]);

  // Reliable pickup: consume any frames a sender stashed for us, on mount (survives the
  // lazy-load race that the dispatched event can lose). Dedup in addFiles avoids doubles.
  useEffect(() => {
    const pending = consumeSourceHandoff('photoMatch');
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
  const completedQueueCount = queueItems.filter(j => j.status === 'completed').length;
  const totalJobs = files.length * selectedCharIds.length;

  const toggleCharacter = (id) => setSelectedCharIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const runQueueJob = useCallback((job) => {
    if (!job?.id || runningJobsRef.current.has(job.id)) return;
    runningJobsRef.current.add(job.id);

    const fileSnap = filesRef.current.find(f => f.id === job.fileId)?.file;
    const charIdSnap = job.characterId;
    const activeReferenceIds = Array.isArray(job.activeReferenceIds) ? job.activeReferenceIds : [];
    const opts = job.opts || {};
    const { bgStr, poseStr, exact, varyBg, ar, resTier, imgModel, prov } = opts;

    if (!fileSnap) {
      runningJobsRef.current.delete(job.id);
      photoMatchStore.setValue('queueItems', prev => prev.map(j => j.id === job.id ? { ...j, status: 'error', errorMessage: 'Source image was removed. Add it again to retry.' } : j));
      return;
    }

    pushPending({ id: job.id, prompt: exact ? 'Exact Recreate' : 'Photo Match', imageModel: imgModel || '', aspectRatio: ar, resolutionTier: resTier });

    fileToBase64(fileSnap).then(dataUri => {
      const base64 = dataUri.split(',')[1];
      return photoMatchApi.recreate({
        image: base64, mimeType: fileSnap.type, characterId: charIdSnap,
        activeReferenceIds: activeReferenceIds.length > 0 ? activeReferenceIds : undefined,
        bgStrength: bgStr, poseStrength: poseStr,
        matchMode: exact ? 'exact' : 'match',
        varyBackground: varyBg,
        aspectRatio: ar, resolutionTier: resTier, imageModel: imgModel,
        provider: prov, sourceUrl: job.sourceUrl || undefined,
      });
    }).then(data => {
      photoMatchStore.setValue('result', data);
      photoMatchStore.setValue('history', prev => [data, ...prev].slice(0, 12));
      photoMatchStore.setValue('queueItems', prev => prev.filter(j => j.id !== job.id));
      // Auto-clear this source frame once nothing else needs it (mirrors "finished jobs
      // auto-clear"), so the picker doesn't pile up with already-generated frames.
      if (!(photoMatchStore.getSnapshot().queueItems || []).some(j => j.fileId === job.fileId)) {
        setFiles(prev => prev.filter(f => f.id !== job.fileId));
      }
      if (job.sourceName) clearFrameFailed([job.sourceName]); // succeeded → no longer Failed
      resolvePending(job.id, {
        imageId: data.imageId, galleryId: data.galleryId || data.imageId,
        mimeType: data.image?.mimeType,
        prompt: exact ? 'Exact Recreate' : 'Photo Match',
        imageModel: imgModel || '', aspectRatio: ar, resolutionTier: resTier,
        generatedAt: Date.now(), characterId: charIdSnap || null,
        sourceUrl: job.sourceUrl || data.sourceUrl || null,
      });
      notify(exact ? 'Exact recreate done!' : 'Photo matched!', 'success');
    }).catch(err => {
      rejectPending(job.id);
      const msg = err?.message || 'Failed';
      const rateLimited = isRateLimitMessage(msg);
      const permanent = isPermanentFailure(msg);
      const autoOn = autoRetryAllRef.current;
      const attempts = ((photoMatchStore.getSnapshot().queueItems || []).find(x => x.id === job.id)?.rlAttempts || 0) + 1;
      // Failed too many times → give up (stop auto-retrying, mark the frame Failed in the Library).
      const gaveUp = attempts >= GIVE_UP_AFTER_ATTEMPTS;
      // Auto-retry only while under the cap, not permanent, and the "Keep retrying" toggle on.
      const willAutoRetry = !permanent && !gaveUp && autoOn;
      photoMatchStore.setValue('queueItems', prev => prev.map(j => {
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
        markFrameFailed(job.sourceName || job.summary || srcEntry?.file?.name, srcEntry?.previewUrl, 'Photo Match');
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

    photoMatchStore.setValue('queueItems', prev => prev.map(j => (
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
      const snap = photoMatchStore.getSnapshot();
      const hasReady = (snap.queueItems || []).some(j => isAutoRetryReady(j, now, autoRetryAll));
      if (!hasReady) return;
      photoMatchStore.setValue('queueItems', prev => prev.map(j => (
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
    const snap = photoMatchStore.getSnapshot();
    const needsArming = (snap.queueItems || []).some(j => j.status === 'error' && !j.permanent && !j.retryAt);
    if (!needsArming) return;
    photoMatchStore.setValue('queueItems', prev => prev.map(j => (
      j.status === 'error' && !j.permanent && !j.retryAt
        ? { ...j, retryAt: Date.now() + AUTO_RETRY_COOLDOWN_MS }
        : j
    )));
  }, [autoRetryAll]);

  const handleGenerate = () => {
    if (files.length === 0) { notify('Add at least one source image', 'error'); return; }
    if (selectedCharIds.length === 0) { notify('Select at least one character', 'error'); return; }
    const opts = { bgStr: bgStrength, poseStr: poseStrength, exact: exactRecreate, varyBg: varyBackground, ar: aspectRatio, resTier: resolutionTier, imgModel: imageModel, prov: provider };
    const jobs = [];
    for (const { file: f, id: fileId, sourceUrl } of files) {
      for (const charIdSnap of selectedCharIds) {
        const charDetailSnap = charDetails[charIdSnap] || null;
        const activeReferenceIds = charDetailSnap?.references?.filter(r => r.isActive).map(r => r.id) || [];
        jobs.push({
          id: makePersistentJobId('photo-match'), kind: 'match', status: 'pending',
          fileId, characterId: charIdSnap, activeReferenceIds, opts, sourceUrl,
          sourceName: f.name || null,
          label: exactRecreate ? 'Exact Recreate' : 'Photo Match',
          summary: f.name || 'Reference photo match',
          meta: `${aspectRatio} · ${resolutionTier}`,
          badges: [
            charDetailSnap?.name ? { label: charDetailSnap.name, color: 'zinc' } : null,
            exactRecreate ? { label: 'Exact', color: 'blue' } : null,
            { label: `${bgStrength}/${poseStrength}`, color: 'zinc' },
          ].filter(Boolean),
        });
      }
    }
    photoMatchStore.setValue('queueItems', prev => [...prev, ...jobs]);
    notify(`${jobs.length} job${jobs.length === 1 ? '' : 's'} added to queue`, 'success');
  };

  // Manual retry — always a fresh attempt (reset counters) reusing the job's original
  // character + frame reference + source image. Works whether auto-retry is on or off.
  const retryJob = (id) => {
    photoMatchStore.setValue('queueItems', prev => prev.map(j => j.id === id ? { ...j, status: 'pending', rateLimited: false, permanent: false, rlAttempts: 0, retryAt: null, errorMessage: '' } : j));
  };

  const retryAllJobs = () => {
    photoMatchStore.setValue('queueItems', prev => prev.map(j => j.status === 'error' ? { ...j, status: 'pending', rateLimited: false, permanent: false, rlAttempts: 0, retryAt: null, errorMessage: '' } : j));
  };

  // Move all failed jobs to another tool (Scene Recreate / Pose Remix), reusing the same
  // character + source frame, and jump there to watch them run.
  const retryAllInTool = async (toKey) => {
    const { moved, skipped, page } = await moveFailedJobsToTool('photoMatch', toKey);
    if (!moved) { notify(skipped ? 'Source frames were removed — can’t move' : 'No failed jobs to move', 'error'); return; }
    notify(`Moved ${moved} job${moved === 1 ? '' : 's'} to ${crossToolLabel(toKey)}${skipped ? ` (${skipped} skipped)` : ''} ⚡`, 'success');
    navigateTo(page);
  };

  const clearFailedJobs = () => {
    photoMatchStore.setValue('queueItems', prev => prev.filter(j => j.status !== 'error'));
  };

  const clearCompletedJobs = () => {
    photoMatchStore.setValue('queueItems', prev => prev.filter(j => j.status !== 'completed'));
  };

  const cancelPendingJobs = () => {
    photoMatchStore.setValue('queueItems', prev => prev.filter(j => j.status !== 'pending'));
  };

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

            {/* Thumbnail grid */}
            {files.length > 0 && (
              <div>
                <div className="grid grid-cols-4 gap-2">
                  {files.map(({ id, previewUrl, file: f, blurred }) => (
                    <div key={id} className={`relative group aspect-square rounded-lg overflow-hidden border bg-zinc-900 cursor-pointer ${
                      blurSource && !blurred ? 'border-amber-500/70 ring-1 ring-amber-500/40' : 'border-zinc-700/60'
                    }`}
                      onClick={(e) => { e.stopPropagation(); setPreviewSrc(previewUrl); }}>
                      <img src={previewUrl} alt={f.name} className="w-full h-full object-cover hover:scale-105 transition-transform duration-200" />
                      {blurSource && (
                        blurred
                          ? <span className="absolute bottom-0.5 left-0.5 rounded bg-emerald-600/90 px-1 py-0.5 text-[0.5rem] font-bold uppercase tracking-wide text-white pointer-events-none">Blurred</span>
                          : (
                            <button type="button" onClick={(e) => { e.stopPropagation(); setManualBlurId(id); }}
                              title="No face detected — click to blur it by hand"
                              className="absolute bottom-0.5 left-0.5 rounded bg-amber-600/90 px-1 py-0.5 text-[0.5rem] font-bold uppercase tracking-wide text-white hover:bg-amber-500">
                              Blur by hand
                            </button>
                          )
                      )}
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

            {/* Auto-blur toggle + the bottom "retry" button — faces are blurred as photos are added
                (paste, drop, upload, handoff — addFiles is the one path all of them go through), so
                Gemini has no rival face to anchor on. Retry re-runs detection in AGGRESSIVE mode over
                whatever the first pass missed; safe to press repeatedly. */}
            <div className="flex items-center justify-between gap-2 pt-1">
              <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
                <input type="checkbox" checked={blurSource} onChange={(e) => setBlurSource(e.target.checked)} className="accent-rose-500" />
                Blur source faces
              </label>
              {files.length > 0 && blurSource && (
                <button type="button" onClick={blurAllFaces} disabled={blurringAll || unblurredCount === 0}
                  className="rounded-lg border border-zinc-700/60 bg-zinc-800/80 px-2.5 py-1 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700/80 disabled:opacity-50 disabled:cursor-not-allowed">
                  {blurringAll ? 'Blurring…' : unblurredCount > 0 ? `Retry face blur (${unblurredCount})` : 'All blurred ✓'}
                </button>
              )}
            </div>
            {blurSource && (
              <p className="text-[0.625rem] leading-relaxed text-emerald-400/80">
                Faces are blurred as photos are added, so Gemini has no rival face to copy. Turn off before adding if you want the original.
              </p>
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
                        <span className="text-[0.625rem] font-semibold text-red-400 uppercase tracking-wider">Failed Downloads ({failedInstagramLinks.length})</span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={handleRetryAllFailed}
                            disabled={isExtractingInstagram}
                            className="text-[0.625rem] font-semibold text-rose-400 hover:text-rose-300 transition disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {isExtractingInstagram ? 'Retrying…' : 'Retry all'}
                          </button>
                          <span className="text-zinc-700">|</span>
                          <button
                            type="button"
                            onClick={() => setFailedInstagramLinks([])}
                            className="text-[0.625rem] text-zinc-500 hover:text-zinc-300 transition"
                          >
                            Clear All
                          </button>
                        </div>
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

          {/* Match Mode — Presets */}
          <Card className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-base font-medium text-zinc-200">Match Mode</h3>
              {activePreset && <span className="text-[0.6875rem] text-zinc-500">{MATCH_PRESETS.find(p => p.id === activePreset)?.desc}</span>}
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {MATCH_PRESETS.map(preset => (
                <button key={preset.id} type="button"
                  onClick={() => {
                    setActivePreset(preset.id);
                    setBgStrength(preset.bg);
                    setPoseStrength(preset.pose);
                    setExactRecreate(preset.exact);
                    setVaryBackground(preset.vary);
                  }}
                  className={`flex flex-col items-center gap-1 rounded-xl border px-1 py-2.5 text-center transition cursor-pointer ${
                    activePreset === preset.id
                      ? 'border-rose-500/60 bg-rose-500/15 text-rose-100 shadow-sm shadow-rose-500/10'
                      : 'border-zinc-700/60 bg-zinc-900/40 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                  }`}
                >
                  <span className="text-base leading-none">{preset.label.split(' ')[0]}</span>
                  <span className="text-[0.625rem] font-medium leading-tight">{preset.label.split(' ').slice(1).join(' ')}</span>
                </button>
              ))}
            </div>
            {/* Fine-tune sliders collapsed */}
            <details className="group">
              <summary className="flex cursor-pointer items-center gap-1.5 text-[0.6875rem] text-zinc-500 hover:text-zinc-300 transition list-none select-none">
                <span className="transition-transform group-open:rotate-90 inline-block">▶</span> Fine-tune
                <span className="ml-auto font-mono text-zinc-600">BG {bgStrength}% · Pose {poseStrength}%</span>
              </summary>
              <div className="mt-3 space-y-4">
                <StrengthSlider label="Background Match" sublabel="environment & lighting" value={bgStrength} onChange={(v) => { setBgStrength(v); setActivePreset(null); }} color="#3b82f6" disabled={exactRecreate} />
                <StrengthSlider label="Pose Match" sublabel="body position & stance" value={poseStrength} onChange={(v) => { setPoseStrength(v); setActivePreset(null); }} color="#8b5cf6" disabled={exactRecreate} />
              </div>
            </details>

            {/* Vary Background toggle */}
            <button
              type="button"
              disabled={exactRecreate}
              onClick={() => !exactRecreate && setVaryBackground(v => !v)}
              className={`w-full flex items-center justify-between rounded-lg border px-3 py-2.5 transition ${
                exactRecreate ? 'opacity-40 cursor-not-allowed border-zinc-800 bg-zinc-900/30' :
                varyBackground ? 'border-emerald-500/60 bg-emerald-500/10 cursor-pointer' : 'border-zinc-700/60 bg-zinc-900/40 hover:border-zinc-600 cursor-pointer'
              }`}
            >
              <div className="text-left">
                <span className={`text-sm font-medium ${varyBackground ? 'text-emerald-300' : 'text-zinc-300'}`}>Vary Background</span>
                <p className="text-[0.6875rem] text-zinc-500 mt-0.5">Same environment, changed lighting & extra background details</p>
              </div>
              <div className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${ varyBackground ? 'bg-emerald-500' : 'bg-zinc-700'}`}>
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${ varyBackground ? 'left-[18px]' : 'left-0.5'}`} />
              </div>
            </button>
          </Card>


          {/* Character multi-select */}
          <Card className="space-y-4">
            <CharacterPicker
              chars={chars}
              selectedIds={selectedCharIds}
              onToggle={toggleCharacter}
              charDetails={charDetails}
              label="Character"
            />

            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Image Model</span>
              <select value={imageModel} onChange={e => setImageModel(e.target.value)}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-rose-500/70 cursor-pointer">
                {IMAGE_MODEL_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
            </div>

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
            {totalJobs > 1 && files.length > 0 && selectedCharIds.length > 0 && (
              <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 px-3 py-2 text-xs text-rose-300">
                {files.length} photo{files.length > 1 ? 's' : ''} × {selectedCharIds.length} character{selectedCharIds.length > 1 ? 's' : ''} = <span className="font-bold">{totalJobs} jobs</span>
              </div>
            )}

            <Btn onClick={handleGenerate} disabled={files.length === 0 || selectedCharIds.length === 0} className="w-full">
              {activeQueueCount > 0
                ? <>Queue More · {activeQueueCount}/2 running</>
                : totalJobs > 1
                  ? <>Photo Match ×{totalJobs}</>
                  : <>Photo Match</>
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
                  <button type="button" onClick={() => retryAllInTool('scene')} disabled={failedQueueCount === 0} title="Move all failed jobs to Scene Recreate (same character + frame)" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-200 transition hover:border-rose-400 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer">
                    Retry all in Scene ({failedQueueCount})
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
                  {(() => {
                    const renderJob = (job) => {
                      const willRetry = job.status === 'error' && !job.permanent && job.retryAt && (job.rateLimited || autoRetryAll);
                      return (
                        <div key={job.id} className="rounded-lg border border-zinc-800/70 bg-zinc-900/50 px-3 py-2.5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Badge color={job.status === 'running' ? 'blue' : willRetry ? 'yellow' : job.status === 'error' ? 'red' : job.status === 'completed' ? 'green' : 'zinc'}>
                                  {job.status === 'running' ? 'Running' : willRetry ? 'Retrying' : job.status === 'error' ? 'Error' : job.status === 'completed' ? 'Done' : 'Pending'}
                                </Badge>
                                {Array.isArray(job.badges) && job.badges.map((badge, index) => (
                                  <Badge key={`${job.id}-${badge?.label || badge}-${index}`} color={badge?.color || 'zinc'}>
                                    {badge?.label || badge}
                                  </Badge>
                                ))}
                              </div>
                              <div className="truncate text-sm text-zinc-200">{job.summary || 'Reference photo match'}</div>
                              {job.sourceUrl && (
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <a href={job.sourceUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title={job.sourceUrl}
                                    className="block truncate text-[0.625rem] text-rose-400/80 hover:text-rose-300">{job.sourceUrl}</a>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigator.clipboard.writeText(job.sourceUrl).then(() => {
                                        setCopiedJobId(job.id);
                                        setTimeout(() => setCopiedJobId(null), 2000);
                                      });
                                    }}
                                    title="Copy source link"
                                    className={`shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium transition cursor-pointer ${
                                      copiedJobId === job.id
                                        ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-600/40'
                                        : 'bg-zinc-800/80 text-zinc-400 hover:text-rose-300 border border-zinc-700/50'
                                    }`}
                                  >
                                    {copiedJobId === job.id ? '✓' : '📋'}
                                  </button>
                                </div>
                              )}
                              {job.meta && <div className="text-[0.625rem] font-mono text-zinc-600">{job.meta}</div>}
                              {job.status === 'error' && <div className={`text-xs line-clamp-3 ${willRetry ? 'text-yellow-300/80' : 'text-red-300'}`}>{job.errorMessage || 'Failed'}</div>}
                            </div>
                            <div className="flex flex-col items-end gap-1.5 shrink-0">
                              {job.status === 'running' ? (
                                <Spinner size={16} />
                              ) : job.status === 'error' ? (
                                <button type="button" onClick={() => retryJob(job.id)} className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-200 transition hover:bg-red-500/20 cursor-pointer">
                                  Retry
                                </button>
                              ) : job.status === 'completed' && job.fileId ? (
                                <button type="button" title="Use this result as new source (iterate)"
                                  onClick={() => {
                                    const entry = files.find(f => f.id === job.fileId);
                                    if (entry) setPreviewSrc(entry.previewUrl);
                                  }}
                                  className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[0.625rem] font-medium text-emerald-300 transition hover:bg-emerald-500/20 cursor-pointer">
                                  🔄 Source
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    };
                    // Group by character
                    const grouped = {};
                    const ungrouped = [];
                    for (const job of queueItems) {
                      if (job.characterId) {
                        if (!grouped[job.characterId]) grouped[job.characterId] = [];
                        grouped[job.characterId].push(job);
                      } else ungrouped.push(job);
                    }
                    return (
                      <>
                        {Object.entries(grouped).map(([charId, jobs]) => {
                          const charName = charDetails[charId]?.name || chars.find(c => c.id === charId)?.name || charId;
                          return (
                            <div key={charId}>
                              <div className="flex items-center gap-1.5 px-1 pb-1">
                                <span className="text-[0.5625rem] uppercase tracking-widest font-semibold text-zinc-600">👤 {charName}</span>
                                <span className="text-[0.5625rem] text-zinc-700">({jobs.length})</span>
                              </div>
                              {jobs.map(renderJob)}
                            </div>
                          );
                        })}
                        {ungrouped.map(renderJob)}
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
      <LightboxComponent />
      {/* Full-size source preview modal */}
      {previewSrc && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/85 backdrop-blur-sm p-4"
          onClick={() => setPreviewSrc(null)}>
          <div className="relative max-w-2xl w-full" onClick={e => e.stopPropagation()}>
            <img src={previewSrc} alt="Source preview" className="w-full rounded-2xl shadow-2xl object-contain max-h-[85vh]" />
            <button type="button" onClick={() => setPreviewSrc(null)}
              className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-300 hover:bg-zinc-700 hover:text-white transition text-sm font-bold cursor-pointer">
              ✕
            </button>
          </div>
        </div>
      )}
      {manualBlurId && files.some((f) => f.id === manualBlurId) && (
        <ManualBlurModal
          src={files.find((f) => f.id === manualBlurId).previewUrl}
          onApply={(newDataUrl) => applyManualBlur(manualBlurId, newDataUrl)}
          onClose={() => setManualBlurId(null)}
        />
      )}
    </div>
  );
}
