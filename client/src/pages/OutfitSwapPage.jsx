import { useState, useEffect, useCallback, useRef } from 'react';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { outfitSwap as api, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Badge, Spinner } from '../components/UI';
import { makePersistentJobId } from '../lib/persistentPageState';
import { outfitSwapStore, setQueuePageActive } from '../lib/generationQueues';
import { markFrameFailed, clearFrameFailed } from '../lib/frameOutcomes';
import * as outfitSourceStore from '../lib/outfitSourceStore';
import * as targetSourceStore from '../lib/outfitSwapTargetSourceStore';
import { consumeSourceHandoff } from '../lib/sourceHandoff';

const ASPECT_RATIOS = ['9:16', '1:1', '16:9', '4:5', '3:4'];
const IMAGE_SIZES = ['1K', '2K'];
const AUTORETRY_KEY = 'kyros.outfitSwap.autoRetryAll';
// Keep concurrency low to stay under Vertex/GCP per-minute image quota.
const MAX_RUNNING_OUTFIT_SWAP_JOBS = 2;
// Stagger dispatch so two jobs don't burst the API at the same instant.
const DISPATCH_STAGGER_MS = 1500;
const RATE_LIMIT_COOLDOWN_BASE_MS = 8000;
const RATE_LIMIT_COOLDOWN_MAX_MS = 45000;
const rateLimitCooldown = (attempts) => Math.min(RATE_LIMIT_COOLDOWN_BASE_MS * (2 ** Math.max(0, (attempts || 1) - 1)), RATE_LIMIT_COOLDOWN_MAX_MS);
// After this many failed attempts, give up auto-retrying and mark the target frame Failed
// (surfaced in the Frame Library's "Failed" filter). A manual Retry resets the count.
const GIVE_UP_AFTER_ATTEMPTS = 5;
// Cooldown before a non-rate-limit error is auto-retried (when "keep retrying" is on).
const AUTO_RETRY_COOLDOWN_MS = 8000;
const isRateLimitMessage = (msg) => /rate limit|quota|resource[_ ]exhausted|\b429\b/i.test(String(msg || ''));
// Errors that can never succeed on retry — never auto-loop these.
const isPermanentFailure = (msg) => /was removed|no character identity|add it again/i.test(String(msg || ''));
// Auto-retry is fully governed by the "Keep retrying" toggle: on = retry every non-permanent
// failure (incl. rate-limits) until it succeeds; off = fully manual (nothing auto-retries).
function isAutoRetryReady(job, now, autoRetryAll) {
  if (!autoRetryAll) return false;
  if (job.status !== 'error' || job.permanent) return false;
  if (!job.retryAt || now < job.retryAt) return false;
  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function dataUrlToBase64Obj(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { base64: m[2], mimeType: m[1] };
}

function resizeAndCompressImage(file, maxDimension = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    if (file.size <= 500 * 1024) { resolve(file); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) { height = Math.round((height * maxDimension) / width); width = maxDimension; }
          else { width = Math.round((width * maxDimension) / height); height = maxDimension; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (!blob) { resolve(file); return; }
          resolve(new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() }));
        }, 'image/jpeg', quality);
      };
      img.onerror = () => resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl, filename = 'source.png') {
  const match = dataUrl?.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const [, mimeType, base64] = match;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const ext = mimeType.split('/')[1] || 'png';
  return new File([bytes], filename.includes('.') ? filename : `${filename}.${ext}`, { type: mimeType });
}

// ── Gallery Picker Modal ────────────────────────────────────────────────────
function GalleryPickerModal({ open, onClose, onPick, title = 'Pick from Gallery' }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const BASE = import.meta.env.VITE_API_BASE || '/api';

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    import('../services/api').then(({ gallery }) => {
      gallery.list().then((res) => {
        const d = res?.data;
        const list = Array.isArray(d) ? d : (Array.isArray(d?.images) ? d.images : (Array.isArray(d?.items) ? d.items : []));
        setItems(list);
      }).catch(() => setItems([])).finally(() => setLoading(false));
    });
  }, [open]);

  if (!open) return null;

  const filtered = search.trim()
    ? items.filter((it) => {
        const s = search.toLowerCase();
        return (it.prompt || '').toLowerCase().includes(s) ||
               (it.source || '').toLowerCase().includes(s) ||
               (it.tags || []).some(t => t.toLowerCase().includes(s));
      })
    : items;

  const handleSelect = async (item) => {
    try {
      const url = `${BASE}/gallery/${item.id}/image`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('Failed to fetch');
      const blob = await resp.blob();
      const reader = new FileReader();
      reader.onload = () => { onPick(reader.result); onClose(); };
      reader.readAsDataURL(blob);
    } catch {
      // Fallback: try thumb
      const thumbUrl = `${BASE}/gallery/${item.id}/thumb`;
      const resp = await fetch(thumbUrl);
      if (resp.ok) {
        const blob = await resp.blob();
        const reader = new FileReader();
        reader.onload = () => { onPick(reader.result); onClose(); };
        reader.readAsDataURL(blob);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700/60 rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <h3 className="text-sm font-bold text-zinc-200">{title}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg cursor-pointer">✕</button>
        </div>
        {/* Search */}
        <div className="px-4 py-2">
          <input
            type="text"
            placeholder="Search by prompt, source, or tag..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg bg-zinc-800/80 border border-zinc-700/60 text-sm text-zinc-200 px-3 py-2 outline-none focus:border-rose-500/50 placeholder-zinc-600"
          />
        </div>
        {/* Grid */}
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-zinc-500 text-sm">Loading gallery...</div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-zinc-600 text-sm">
              {search ? 'No matching images' : 'Gallery is empty'}
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2 mt-1">
              {filtered.slice(0, 100).map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleSelect(item)}
                  className="relative rounded-lg overflow-hidden border border-zinc-800 hover:border-rose-500/60 transition group cursor-pointer aspect-square"
                >
                  <img
                    src={`${BASE}/gallery/${item.id}/thumb`}
                    alt=""
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                  <div className="absolute inset-0 bg-rose-600/0 group-hover:bg-rose-600/20 transition" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Outfit Source drop zone (single image) ──────────────────────────────────
function OutfitDropZone({ image, onFile, onClear, onPickDataUrl }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  const handleDrop = useCallback(async (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file?.type?.startsWith('image/')) onFile(file);
  }, [onFile]);

  const handlePaste = useCallback((e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imgItem = items.find((i) => i.type.startsWith('image/'));
    if (imgItem) { const file = imgItem.getAsFile(); if (file) onFile(file); }
  }, [onFile]);

  const handleFile = useCallback((e) => {
    const file = e.target?.files?.[0];
    if (file) onFile(file);
  }, [onFile]);

  useEffect(() => {
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  if (image) {
    return (
      <div className="relative group rounded-xl overflow-hidden border border-white/10 bg-zinc-900/60">
        <img src={image} alt="Outfit source" className="w-full h-48 object-cover" />
        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-2">
          <button onClick={() => setShowPicker(true)} className="rounded-lg bg-rose-600/80 hover:bg-rose-500 text-white text-xs px-3 py-1.5 font-medium cursor-pointer">Change</button>
          <button onClick={onClear} className="rounded-lg bg-red-600/80 hover:bg-red-500 text-white text-xs px-3 py-1.5 font-medium cursor-pointer">Remove</button>
        </div>
        <div className="absolute bottom-0 left-0 right-0 px-3 py-1.5 text-[0.625rem] font-bold uppercase tracking-wider text-white bg-gradient-to-r from-pink-500 to-rose-500">
          Outfit Source
        </div>
        <GalleryPickerModal
          open={showPicker}
          onClose={() => setShowPicker(false)}
          onPick={(dataUrl) => onPickDataUrl(dataUrl)}
          title="Pick Outfit from Gallery"
        />
      </div>
    );
  }

  return (
    <>
      <div
        className={`relative rounded-xl border-2 border-dashed transition-colors flex flex-col items-center justify-center h-48 ${
          dragOver ? 'border-rose-400 bg-rose-500/10' : 'border-zinc-700 bg-zinc-900/40 hover:border-zinc-500'
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
        <div className="text-2xl mb-2 bg-gradient-to-r from-pink-500 to-rose-500 bg-clip-text text-transparent">👗</div>
        <div className="text-sm font-semibold text-zinc-300">Outfit Source</div>
        <div className="text-[0.6875rem] text-zinc-500 mt-1">Image with the outfit you want</div>
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => inputRef.current?.click()}
            className="rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs px-3 py-1.5 font-medium cursor-pointer transition"
          >
            📁 Upload
          </button>
          <button
            onClick={() => setShowPicker(true)}
            className="rounded-lg bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 text-xs px-3 py-1.5 font-medium cursor-pointer transition border border-rose-500/30"
          >
            🖼️ Browse Library
          </button>
        </div>
      </div>
      <GalleryPickerModal
        open={showPicker}
        onClose={() => setShowPicker(false)}
        onPick={(dataUrl) => onPickDataUrl(dataUrl)}
        title="Pick Outfit from Gallery"
      />
    </>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function OutfitSwapPage() {
  const { notify } = useApp();

  // Outfit source (single image, persisted on IndexedDB so it survives reload/crash).
  const [outfitEntry, setOutfitEntry] = useState(null); // { id, name, type, dataUrl }
  const outfitHydratedRef = useRef(false);

  // Target person batch (multi, same source-store pattern as Photo Match's `files`).
  const [files, setFiles] = useState([]); // [{ id, file, previewUrl, sourceUrl }]
  const filesRef = useRef([]);
  const targetHydratedRef = useRef(false);
  const [sourcesHydrated, setSourcesHydrated] = useState(false);
  const dropRef = useRef(null);
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  const [characterId, setCharacterId] = useState('');
  const [characters, setCharacters] = useState([]);
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [imageSize, setImageSize] = useState('2K');
  const [copiedJobId, setCopiedJobId] = useState(null);

  const runningJobsRef = useRef(new Set());
  const [queuePaused, setQueuePaused] = useState(false);
  const [autoRetryAll, setAutoRetryAll] = useState(() => {
    try { const v = window.localStorage.getItem(AUTORETRY_KEY); return v === null ? true : v === '1'; } catch { return true; }
  });
  const autoRetryAllRef = useRef(autoRetryAll);
  useEffect(() => {
    autoRetryAllRef.current = autoRetryAll;
    try { window.localStorage.setItem(AUTORETRY_KEY, autoRetryAll ? '1' : '0'); } catch { /* ignore */ }
  }, [autoRetryAll]);

  const [pageState, setPageState] = useState(() => outfitSwapStore.getSnapshot());
  useEffect(() => outfitSwapStore.subscribe(setPageState), []);
  const queueItems = pageState.queueItems || [];

  // While mounted this page drives its own queue; when unmounted the background worker
  // continues pending/retry jobs so they keep going after you navigate away.
  useEffect(() => {
    setQueuePageActive('outfit-swap', true);
    return () => setQueuePageActive('outfit-swap', false);
  }, []);

  useEffect(() => { filesRef.current = files; }, [files]);

  // Load characters
  useEffect(() => {
    charApi.list().then((res) => {
      if (res?.data?.characters) setCharacters(res.data.characters);
    }).catch(() => {});
  }, []);

  // ── Hydrate outfit source + target batch from IndexedDB on mount ─────────
  useEffect(() => {
    let cancelled = false;
    outfitSourceStore.loadSources().then((records) => {
      if (!cancelled && records.length) setOutfitEntry(records[0]);
      outfitHydratedRef.current = true;
      if (targetHydratedRef.current) setSourcesHydrated(true);
    }).catch(() => { outfitHydratedRef.current = true; });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    targetSourceStore.loadSources().then((records) => {
      if (!cancelled && records.length) {
        const restored = records
          .map((item) => ({ file: dataUrlToFile(item.dataUrl, item.name), previewUrl: item.dataUrl, id: item.id, sourceUrl: item.sourceUrl || null }))
          .filter((entry) => entry.file);
        if (restored.length) setFiles((prev) => (prev.length === 0 ? restored : prev));
      }
      targetHydratedRef.current = true;
      if (outfitHydratedRef.current) setSourcesHydrated(true);
    }).catch(() => { targetHydratedRef.current = true; });
    return () => { cancelled = true; };
  }, []);

  // Persist outfit source whenever it changes (after hydration).
  useEffect(() => {
    if (!outfitHydratedRef.current) return;
    if (!outfitEntry) { outfitSourceStore.clearSources(); return; }
    outfitSourceStore.saveSources([outfitEntry]);
  }, [outfitEntry]);

  // Persist target batch whenever it changes (after hydration).
  useEffect(() => {
    if (!targetHydratedRef.current) return;
    const serialized = files
      .filter((entry) => entry.file)
      .map((entry) => ({ id: entry.id, name: entry.file.name, type: entry.file.type, size: entry.file.size, dataUrl: entry.previewUrl, sourceUrl: entry.sourceUrl || null }));
    if (serialized.length === 0) targetSourceStore.clearSources();
    else targetSourceStore.saveSources(serialized);
  }, [files]);

  // Backfill: surface jobs that already gave up (failed ≥5×) as Failed in the Library.
  useEffect(() => {
    if (!sourcesHydrated) return;
    for (const j of (outfitSwapStore.getSnapshot().queueItems || [])) {
      if (j.status !== 'error' || (j.rlAttempts || 0) < GIVE_UP_AFTER_ATTEMPTS) continue;
      const entry = filesRef.current.find(f => f.id === j.fileId);
      markFrameFailed(j.sourceName || j.summary || entry?.file?.name, entry?.previewUrl, 'Outfit Swap');
    }
  }, [sourcesHydrated]);

  const setOutfitFile = useCallback(async (file) => {
    const compressed = await resizeAndCompressImage(file);
    const dataUrl = await fileToDataUrl(compressed);
    setOutfitEntry({ id: `outfit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: compressed.name, type: compressed.type, dataUrl });
  }, []);

  const addTargetFiles = useCallback(async (incoming, sourceUrls) => {
    const incomingArr = [...incoming];
    const valid = [];
    const validSourceUrls = [];
    incomingArr.forEach((f, i) => {
      if (f.type.startsWith('image/')) { valid.push(f); validSourceUrls.push(sourceUrls?.[i] || null); }
    });
    if (valid.length === 0) { notify('Only PNG, JPEG, WebP allowed', 'error'); return; }
    const compressed = await Promise.all(valid.map(f => resizeAndCompressImage(f)));
    const next = await Promise.all(compressed.map(async (f, i) => ({
      file: f,
      previewUrl: await fileToDataUrl(f),
      id: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`,
      sourceUrl: validSourceUrls[i] || null,
    })));
    setFiles(prev => {
      const seen = new Set(prev.map(e => `${e.file?.name}::${e.file?.size}`));
      const deduped = next.filter(e => !seen.has(`${e.file.name}::${e.file.size}`));
      return [...prev, ...deduped];
    });
  }, [notify]);

  const removeFile = (id) => setFiles(prev => prev.filter(f => f.id !== id));
  const clearAllTargets = () => setFiles([]);

  // ── Frame Library handoff (both the mount-time stash and the legacy event) ─
  useEffect(() => {
    const pending = consumeSourceHandoff('outfitSwap');
    if (pending.length) {
      const converted = pending
        .map((it) => ({ file: dataUrlToFile(it.dataUrl, it.name), sourceUrl: it.sourceUrl || null }))
        .filter((c) => c.file);
      if (converted.length) addTargetFiles(converted.map((c) => c.file), converted.map((c) => c.sourceUrl));
    }
  }, [addTargetFiles]);

  useEffect(() => {
    const onInboxSource = (e) => {
      const items = Array.isArray(e.detail?.items) ? e.detail.items : [];
      if (items.length === 0) return;
      const converted = items
        .map((item) => ({ file: dataUrlToFile(item.dataUrl, item.name), sourceUrl: item.sourceUrl || null }))
        .filter((c) => c.file);
      if (converted.length === 0) return;
      addTargetFiles(converted.map((c) => c.file), converted.map((c) => c.sourceUrl));
      notify(`Loaded ${converted.length} image${converted.length === 1 ? '' : 's'} into Outfit Swap`, 'success');
    };
    window.addEventListener('kyros:use-as-outfit-swap-source', onInboxSource);
    return () => window.removeEventListener('kyros:use-as-outfit-swap-source', onInboxSource);
  }, [addTargetFiles, notify]);

  const onDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e) => { e.preventDefault(); setIsDragging(false); addTargetFiles(e.dataTransfer.files); };
  const handleFileInput = (e) => { addTargetFiles(e.target.files || []); e.target.value = ''; };

  const activeQueueCount = queueItems.filter(j => j.status === 'running').length;
  const pendingQueueCount = queueItems.filter(j => j.status === 'pending').length;
  const failedQueueCount = queueItems.filter(j => j.status === 'error').length;
  const completedQueueCount = queueItems.filter(j => j.status === 'completed').length;

  const handleGenerate = () => {
    if (!outfitEntry) { notify('Add an outfit source image', 'error'); return; }
    if (files.length === 0) { notify('Add at least one target person image', 'error'); return; }
    const charName = characters.find(c => c.id === characterId)?.name;
    const opts = { ar: aspectRatio, imgSize: imageSize };
    const jobs = files.map(({ file: f, id: fileId, sourceUrl }) => ({
      id: makePersistentJobId('outfit-swap'), kind: 'outfit-swap', status: 'pending',
      fileId, outfitSourceId: outfitEntry.id, characterId: characterId || null, opts, sourceUrl,
      sourceName: f.name || null,
      label: 'Outfit Swap',
      summary: f.name || 'Outfit swap',
      meta: `${aspectRatio} · ${imageSize}`,
      badges: [charName ? { label: charName, color: 'zinc' } : null].filter(Boolean),
    }));
    outfitSwapStore.setValue('queueItems', prev => [...prev, ...jobs]);
    notify(`${jobs.length} job${jobs.length === 1 ? '' : 's'} added to queue`, 'success');
  };

  const runQueueJob = useCallback((job) => {
    if (!job?.id || runningJobsRef.current.has(job.id)) return;
    runningJobsRef.current.add(job.id);

    const targetSnap = filesRef.current.find(f => f.id === job.fileId);
    const opts = job.opts || {};
    const { ar, imgSize } = opts;

    outfitSourceStore.loadSources().then((records) => {
      const outfitSnap = records.find(o => o.id === job.outfitSourceId);
      if (!targetSnap || !outfitSnap) {
        runningJobsRef.current.delete(job.id);
        outfitSwapStore.setValue('queueItems', prev => prev.map(j => j.id === job.id
          ? { ...j, status: 'error', errorMessage: !targetSnap ? 'Target image was removed. Add it again to retry.' : 'Outfit source image was removed. Add it again to retry.' }
          : j));
        return;
      }

      pushPending({ id: job.id, prompt: 'Outfit Swap', imageModel: '', aspectRatio: ar, resolutionTier: imgSize });

      fileToDataUrl(targetSnap.file).then((targetDataUrl) => {
        const outfitObj = dataUrlToBase64Obj(outfitSnap.dataUrl);
        const targetObj = dataUrlToBase64Obj(targetDataUrl);
        return api.swap({
          outfitImage: { base64: outfitObj.base64, mimeType: outfitObj.mimeType },
          targetImage: { base64: targetObj.base64, mimeType: targetObj.mimeType },
          characterId: job.characterId || undefined,
          aspectRatio: ar,
          imageSize: imgSize,
          sourceUrl: job.sourceUrl || undefined,
        });
      }).then((res) => {
        const data = res?.data;
        if (!data?.base64Data) throw new Error('No image returned');
        const resultUrl = `data:${data.mimeType || 'image/png'};base64,${data.base64Data}`;
        const outfitDesc = data.outfitDescription || null;

        outfitSwapStore.setValue('result', { imageUrl: resultUrl, galleryId: data.galleryId, outfitDescription: outfitDesc });
        outfitSwapStore.setValue('history', prev => [{ imageUrl: resultUrl, galleryId: data.galleryId, outfitDescription: outfitDesc, ts: Date.now() }, ...(prev || [])].slice(0, 24));
        outfitSwapStore.setValue('queueItems', prev => prev.filter(j => j.id !== job.id));
        if (!(outfitSwapStore.getSnapshot().queueItems || []).some(j => j.fileId === job.fileId)) {
          setFiles(prev => prev.filter(f => f.id !== job.fileId));
        }
        if (job.sourceName) clearFrameFailed([job.sourceName]);

        resolvePending(job.id, {
          galleryId: data.galleryId,
          mimeType: data.mimeType || 'image/png',
          prompt: outfitDesc ? `[Outfit Swap] ${outfitDesc}` : 'Outfit Swap',
          aspectRatio: ar, resolutionTier: imgSize,
          generatedAt: Date.now(), characterId: job.characterId || null,
          sourceUrl: job.sourceUrl || data.sourceUrl || null,
        });
        notify('Outfit swapped! ✨', 'success');
      }).catch((err) => {
        rejectPending(job.id);
        const msg = err?.message || 'Outfit swap failed';
        const rateLimited = isRateLimitMessage(msg);
        const permanent = isPermanentFailure(msg);
        const autoOn = autoRetryAllRef.current;
        const attempts = ((outfitSwapStore.getSnapshot().queueItems || []).find(x => x.id === job.id)?.rlAttempts || 0) + 1;
        const gaveUp = attempts >= GIVE_UP_AFTER_ATTEMPTS;
        const willAutoRetry = !permanent && !gaveUp && autoOn;
        outfitSwapStore.setValue('queueItems', prev => prev.map(j => {
          if (j.id !== job.id) return j;
          const cooldown = rateLimited ? rateLimitCooldown(attempts) : AUTO_RETRY_COOLDOWN_MS;
          return {
            ...j, status: 'error', rateLimited, permanent: permanent || gaveUp, rlAttempts: attempts,
            retryAt: willAutoRetry ? Date.now() + cooldown : null,
            errorMessage: gaveUp ? `${msg} — failed ${attempts}× (marked Failed in Library; retry manually if you want)` : (willAutoRetry ? `${msg} — retrying in ${Math.round((rateLimited ? rateLimitCooldown(attempts) : AUTO_RETRY_COOLDOWN_MS) / 1000)}s…` : msg),
          };
        }));
        if (gaveUp) markFrameFailed(job.sourceName || job.summary || targetSnap?.file?.name, targetSnap?.previewUrl, 'Outfit Swap');
        if (!willAutoRetry) notify(gaveUp ? `Gave up after ${attempts} tries — marked Failed in Library` : msg, 'error');
      }).finally(() => {
        runningJobsRef.current.delete(job.id);
      });
    });
  }, [notify]);

  // Manual retry — always a fresh attempt (reset counters), same outfit + target + character.
  const retryJob = (id) => {
    outfitSwapStore.setValue('queueItems', prev => prev.map(j => j.id === id ? { ...j, status: 'pending', rateLimited: false, permanent: false, rlAttempts: 0, retryAt: null, errorMessage: '' } : j));
  };
  const retryAllJobs = () => {
    outfitSwapStore.setValue('queueItems', prev => prev.map(j => j.status === 'error' ? { ...j, status: 'pending', rateLimited: false, permanent: false, rlAttempts: 0, retryAt: null, errorMessage: '' } : j));
  };
  const clearFailedJobs = () => outfitSwapStore.setValue('queueItems', prev => prev.filter(j => j.status !== 'error'));
  const clearCompletedJobs = () => outfitSwapStore.setValue('queueItems', prev => prev.filter(j => j.status !== 'completed'));
  const cancelPendingJobs = () => outfitSwapStore.setValue('queueItems', prev => prev.filter(j => j.status !== 'pending'));

  // ── Dispatch loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (queuePaused || !sourcesHydrated) return;
    const runningCount = queueItems.filter(j => j.status === 'running').length;
    const slots = MAX_RUNNING_OUTFIT_SWAP_JOBS - runningCount;
    if (slots <= 0) return;
    const nextJobs = queueItems.filter(j => j.status === 'pending').slice(0, slots);
    if (nextJobs.length === 0) return;
    outfitSwapStore.setValue('queueItems', prev => prev.map(j => (
      nextJobs.some(nextJob => nextJob.id === j.id) ? { ...j, status: 'running', errorMessage: '' } : j
    )));
    nextJobs.forEach((job, i) => {
      if (i === 0) runQueueJob(job);
      else setTimeout(() => runQueueJob(job), i * DISPATCH_STAGGER_MS);
    });
  }, [queueItems, queuePaused, runQueueJob, sourcesHydrated]);

  // Auto-retry ticker.
  useEffect(() => {
    if (queuePaused) return undefined;
    const timer = setInterval(() => {
      const now = Date.now();
      const snap = outfitSwapStore.getSnapshot();
      const hasReady = (snap.queueItems || []).some(j => isAutoRetryReady(j, now, autoRetryAll));
      if (!hasReady) return;
      outfitSwapStore.setValue('queueItems', prev => prev.map(j => (
        isAutoRetryReady(j, now, autoRetryAll) ? { ...j, status: 'pending', rateLimited: false, retryAt: null, errorMessage: '' } : j
      )));
    }, 2500);
    return () => clearInterval(timer);
  }, [queuePaused, autoRetryAll]);

  // When "keep retrying" is switched on, arm any already-failed (non-permanent) jobs.
  useEffect(() => {
    if (!autoRetryAll) return;
    const snap = outfitSwapStore.getSnapshot();
    const needsArming = (snap.queueItems || []).some(j => j.status === 'error' && !j.permanent && !j.retryAt);
    if (!needsArming) return;
    outfitSwapStore.setValue('queueItems', prev => prev.map(j => (
      j.status === 'error' && !j.permanent && !j.retryAt ? { ...j, retryAt: Date.now() + AUTO_RETRY_COOLDOWN_MS } : j
    )));
  }, [autoRetryAll]);

  return (
    <div className="space-y-6 animate-in">
      <div className="max-w-md">
        <div className="space-y-4">

          <OutfitDropZone
            image={outfitEntry?.dataUrl}
            onFile={setOutfitFile}
            onClear={() => setOutfitEntry(null)}
            onPickDataUrl={(dataUrl) => setOutfitEntry({ id: `outfit-gallery-${Date.now()}`, name: 'gallery-outfit', type: 'image/jpeg', dataUrl })}
          />

          {/* Target Person — multi-drop zone (batch: one swap per target) */}
          <Card className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-medium text-zinc-200">Target Person</h3>
              <div className="flex items-center gap-2">
                {files.length > 0 && <Badge color="blue">{files.length} photo{files.length > 1 ? 's' : ''}</Badge>}
                <Badge color="zinc">Ctrl+V to paste</Badge>
              </div>
            </div>

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
              <div className="text-center flex flex-col items-center gap-1.5">
                <span className="text-2xl">🧑</span>
                <p className="text-sm text-zinc-400 font-medium">Drop photos here or click to browse</p>
                <p className="text-xs text-zinc-600">One outfit swap is queued per target photo</p>
              </div>
              <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={handleFileInput} />
            </div>

            {files.length > 0 && (
              <div>
                <div className="grid grid-cols-4 gap-2">
                  {files.map(({ id, previewUrl, file: f }) => (
                    <div key={id} className="relative group aspect-square rounded-lg overflow-hidden border border-zinc-700/60 bg-zinc-900">
                      <img src={previewUrl} alt={f.name} className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeFile(id); }}
                        className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/70 text-zinc-300 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-xs font-bold hover:bg-red-500/80 hover:text-white cursor-pointer"
                      >×</button>
                    </div>
                  ))}
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="aspect-square rounded-lg border-2 border-dashed border-zinc-700/60 hover:border-zinc-500 bg-zinc-900/40 flex items-center justify-center cursor-pointer transition"
                  >
                    <span className="text-zinc-600 text-xl font-light">+</span>
                  </div>
                </div>
                <button type="button" onClick={clearAllTargets} className="mt-2 text-xs text-zinc-600 hover:text-red-400 transition cursor-pointer">Clear all</button>
              </div>
            )}
          </Card>

          {/* Character picker */}
          <Card className="p-3">
            <label className="text-[0.6875rem] font-semibold text-zinc-400 uppercase tracking-wider mb-1.5 block">
              Identity Lock (optional)
            </label>
            <select
              value={characterId}
              onChange={(e) => setCharacterId(e.target.value)}
              className="w-full rounded-lg bg-zinc-800/80 border border-zinc-700/60 text-sm text-zinc-200 px-3 py-2 outline-none focus:border-rose-500/50 cursor-pointer"
            >
              <option value="">No identity lock</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <p className="text-[0.625rem] text-zinc-600 mt-1">Lock the output face to a character</p>
          </Card>

          {/* Settings row */}
          <div className="flex gap-3">
            <Card className="flex-1 p-3">
              <label className="text-[0.625rem] font-semibold text-zinc-500 uppercase tracking-wider mb-1.5 block">Aspect Ratio</label>
              <div className="flex flex-wrap gap-1.5">
                {ASPECT_RATIOS.map((r) => (
                  <button
                    key={r}
                    onClick={() => setAspectRatio(r)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition cursor-pointer ${
                      aspectRatio === r ? 'bg-rose-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </Card>
            <Card className="w-24 p-3">
              <label className="text-[0.625rem] font-semibold text-zinc-500 uppercase tracking-wider mb-1.5 block">Size</label>
              <div className="flex flex-col gap-1.5">
                {IMAGE_SIZES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setImageSize(s)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition cursor-pointer ${
                      imageSize === s ? 'bg-rose-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </Card>
          </div>

          {/* Job count summary */}
          {files.length > 1 && outfitEntry && (
            <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 px-3 py-2 text-xs text-rose-300">
              1 outfit × {files.length} target photos = <span className="font-bold">{files.length} jobs</span>
            </div>
          )}

          <Btn
            onClick={handleGenerate}
            disabled={!outfitEntry || files.length === 0}
            className="w-full py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-pink-500 via-rose-500 to-rose-500 text-white hover:opacity-90"
          >
            {activeQueueCount > 0
              ? <>Queue More · {activeQueueCount}/{MAX_RUNNING_OUTFIT_SWAP_JOBS} running</>
              : files.length > 1
                ? <>👗 Swap Outfit ×{files.length}</>
                : <>👗 Swap Outfit</>
            }
          </Btn>

          {queueItems.length > 0 && (
            <div className="space-y-2 rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-zinc-200">Queue</div>
                  <div className="text-[0.6875rem] text-zinc-500">Runs max {MAX_RUNNING_OUTFIT_SWAP_JOBS} jobs at a time. Finished jobs auto-clear.</div>
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
                  <div className="text-[0.625rem] text-zinc-500">{autoRetryAll ? 'On: auto re-queues each failed job on a cooldown; after 5 tries it gives up and marks the target Failed in the Library.' : 'Off: failed jobs just stop and wait — hit "Retry all" to re-run them by hand (same outfit + target + character).'}</div>
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
                            <Badge color={job.status === 'running' ? 'blue' : willRetry ? 'yellow' : job.status === 'error' ? 'red' : job.status === 'completed' ? 'green' : 'zinc'}>
                              {job.status === 'running' ? 'Running' : willRetry ? 'Retrying' : job.status === 'error' ? 'Error' : job.status === 'completed' ? 'Done' : 'Pending'}
                            </Badge>
                            {Array.isArray(job.badges) && job.badges.map((badge, index) => (
                              <Badge key={`${job.id}-${badge?.label || badge}-${index}`} color={badge?.color || 'zinc'}>
                                {badge?.label || badge}
                              </Badge>
                            ))}
                          </div>
                          <div className="truncate text-sm text-zinc-200">{job.summary || 'Outfit swap'}</div>
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
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
