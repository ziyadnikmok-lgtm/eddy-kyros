import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Btn, Card, Empty } from '../components/UI';
import { useApp } from '../context/AppContext';
import { stashSourceHandoff, handoffDestination } from '../lib/sourceHandoff';
import { extractOneLink, runWithConcurrency, extractLinksViaApify } from '../lib/frameExtract';
import { loadFrames, saveAllFrames } from '../lib/frameLibraryStore';
import { getFailedFrameNames, clearFrameFailed } from '../lib/frameOutcomes';
import { downloadBlob } from '../lib/stripMetadata';
import {
  loadCollections, saveCollections, createCollection, deleteCollection,
  renameCollection, addFramesToCollection, removeFrameFromCollection,
  removeFrameFromAllCollections, randomColor,
} from '../lib/collectionsStore';


const FRAME_LIBRARY_STORAGE_KEY = 'kyros.frameLibrary.items';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Link-extract failures worth auto-retrying. Clearly-permanent ones aren't retried.
const isTransientExtractError = (msg) => {
  const m = String(msg || '').toLowerCase();
  if (/private|cookie|not found|404|deleted|removed|no frames/.test(m)) return false;
  return true;
};
// Where selected frames can be sent. localStorage handoff intentionally omitted — the
// destination pages migrate localStorage sources on mount, which would double-add.
const SEND_TARGETS = {
  photo: { event: 'kyros:use-as-photo-match-source', label: 'Photo Match', page: 'photoMatch' },
  photoMatchSeedream: { event: 'kyros:use-as-photo-match-seedream-source', label: 'Photo Match · Seedream', page: 'photoMatchSeedream' },
  sceneRecreateSeedream: { event: 'kyros:use-as-scene-recreate-seedream-source', label: 'Scene Recreate · Seedream', page: 'sceneRecreateSeedream' },
  poseRemixSeedream: { event: 'kyros:use-as-pose-remix-seedream-source', label: 'Pose Remix · Seedream', page: 'poseRemixSeedream' },
  poseFix: { event: 'kyros:use-as-pose-fix-source', label: 'Pose Remix', page: 'poseFix' },
  scene: { event: 'kyros:use-as-scene-source', label: 'Scene Recreate', page: 'scene' },
  outfitSwap: { event: 'kyros:use-as-outfit-swap-source', label: 'Outfit Swap', page: 'outfitSwap' },
  outfitSwapSeedream: { event: 'kyros:use-as-outfit-swap-seedream-source', label: 'Outfit Swap · Seedream', page: 'outfitSwapSeedream' },
};

// ── Helpers ────────────────────────────────────────────────────────────────
function readStoredItems() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(FRAME_LIBRARY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function writeStoredItems(items) {
  if (typeof window === 'undefined') return;
  try {
    const next = Array.isArray(items) ? items : [];
    if (next.length === 0) {
      window.localStorage.removeItem(FRAME_LIBRARY_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(FRAME_LIBRARY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage failures
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Drop a video you already have on disk (e.g. an age-gated/banned post the scraper can't
// fetch) and pull a representative frame out of it via the server's ffmpeg — no scraping.
async function extractFrameFromVideoFile(file) {
  const buf = await file.arrayBuffer();
  const res = await fetch(`/api/instagram-frames/extract-from-upload?smartPick=1&type=${encodeURIComponent(file.type || 'video/mp4')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  if (!res.ok) {
    // Surface the real reason (e.g. HTTP 404 = server not restarted, 413 = too big, 422 = ffmpeg).
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j?.error?.message || j?.error || msg; } catch { /* non-JSON body */ }
    throw new Error(msg);
  }
  const json = await res.json().catch(() => ({}));
  if (!json.success) throw new Error(json?.error?.message || json?.error || 'Frame extraction failed');
  const f = (json.data?.frames || [])[0];
  if (!f) throw new Error('No frame extracted');
  const mime = f.mimeType || 'image/jpeg';
  return { dataUrl: `data:${mime};base64,${f.base64}`, mime };
}

// Smart mode: send the video and get back the best FACE frame + one frame per distinct outfit
// (Gemini vision picks them). Returns [{ dataUrl, mime, label }].
async function extractSmartFramesFromVideoFile(file) {
  const buf = await file.arrayBuffer();
  const res = await fetch(`/api/instagram-frames/extract-smart-from-upload?type=${encodeURIComponent(file.type || 'video/mp4')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j?.error?.message || j?.error || msg; } catch { /* non-JSON */ }
    throw new Error(msg);
  }
  const json = await res.json().catch(() => ({}));
  if (!json.success) throw new Error(json?.error?.message || json?.error || 'Smart extraction failed');
  return (json.data?.frames || []).map((f) => ({
    dataUrl: `data:${f.mimeType || 'image/jpeg'};base64,${f.base64}`,
    mime: f.mimeType || 'image/jpeg',
    label: f.label || 'frame',
  }));
}

function makeItem(file, source = 'upload') {
  return {
    id: `frame-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    name: file.name || 'frame-image',
    type: file.type || 'image/png',
    size: file.size || 0,
    createdAt: Date.now(),
    source,
    dataUrl: '',
    usage: [],
  };
}

function dataUrlToFile(dataUrl, filename) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const [, mimeType, base64] = match;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const ext = mimeType.split('/')[1] || 'png';
  return new File([bytes], filename.includes('.') ? filename : `${filename}.${ext}`, { type: mimeType });
}

// ── Icons ──────────────────────────────────────────────────────────────────
function IconCheck({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconClose({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconArrowLeft({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function FrameLibraryPage() {
  const { notify, navigateTo } = useApp();
  const [items, setItems] = useState([]); // hydrated from IndexedDB on mount
  const framesHydratedRef = useRef(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [previewIdx, setPreviewIdx] = useState(null); // index into filteredItems
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);
  // Link import
  const [igLinks, setIgLinks] = useState('');
  const [failedLinks, setFailedLinks] = useState([]);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(null); // { done, total }
  const [showImport, setShowImport] = useState(false);
  // Link history — persisted in localStorage
  const [linkHistory, setLinkHistory] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem('kyros.frameLibrary.linkHistory') || '[]'); } catch { return []; }
  });
  const [showHistory, setShowHistory] = useState(false);
  const saveLinkHistory = (next) => {
    const capped = next.slice(0, 500);
    setLinkHistory(capped);
    try { window.localStorage.setItem('kyros.frameLibrary.linkHistory', JSON.stringify(capped)); } catch {}
  };
  const [proxyInput, setProxyInput] = useState('');
  // Profile Grab — pull N random reels from an IG profile URL
  const [showProfileGrab, setShowProfileGrab] = useState(true);
  const [profileUrl, setProfileUrl] = useState(() => { try { return window.localStorage.getItem('kyros.frameLibrary.profileUrl') || ''; } catch { return ''; } });
  const [profileCount, setProfileCount] = useState(10);
  const [isGrabbing, setIsGrabbing] = useState(false);
  const [grabProgress, setGrabProgress] = useState(null); // { done, total }
  const [grabPhase, setGrabPhase] = useState(null); // 'downloading' | 'extracting' | null
  const [grabDownloaded, setGrabDownloaded] = useState(0); // live count of downloaded files
  const [grabErrors, setGrabErrors] = useState([]);
  const [useApify, setUseApify] = useState(() => {
    try { const v = window.localStorage.getItem('kyros.frameLibrary.useApify'); return v === null ? true : v === '1'; } catch { return true; }
  });
  // Frame extraction mode: brain (AI picks best), quick (2nd frame at 200ms), thumb (ffmpeg thumbnail)
  const [frameMode, setFrameMode] = useState(() => {
    try { return window.localStorage.getItem('kyros.frameLibrary.frameMode') || 'brain'; } catch { return 'brain'; }
  });
  const smartVideo = frameMode === 'brain'; // backwards compat for code that reads smartVideo
  useEffect(() => {
    try { window.localStorage.setItem('kyros.frameLibrary.frameMode', frameMode); } catch { /* ignore */ }
  }, [frameMode]);

  // View filters
  const [dateFilter, setDateFilter] = useState('all'); // all | today | week
  const [statusFilter, setStatusFilter] = useState('all'); // all | new | used | failed
  const [limitCount, setLimitCount] = useState(0); // 0 = all, else newest N

  // Frames that gave up on generation (failed the retry cap), tracked by name. Refreshed on
  // mount and whenever a generator reports an outcome.
  const [failedNames, setFailedNames] = useState(() => getFailedFrameNames());
  useEffect(() => {
    const refresh = () => {
      setFailedNames(getFailedFrameNames());
      // A give-up may have ADDED a frame to the Library — reload so it appears here.
      if (framesHydratedRef.current) loadFrames().then((f) => { if (f.length) setItems(f); }).catch(() => {});
    };
    window.addEventListener('kyros:frame-outcome', refresh);
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('kyros:frame-outcome', refresh); window.removeEventListener('focus', refresh); };
  }, []);

  // A frame is "failed" if a generation gave up on it; "used/generated" once sent to a
  // generator (usage set). Failed takes precedence so it shows only under the Failed filter.
  const isFailed = (it) => failedNames.has(it.name);
  const isUsed = (it) => !isFailed(it) && Array.isArray(it.usage) && it.usage.length > 0;

  // ── Collections (Folders) ──────────────────────────────────────────────────
  const [collections, setCollections] = useState(() => loadCollections());
  const [activeCollection, setActiveCollection] = useState(null); // id or null = All
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderColor, setNewFolderColor] = useState(() => randomColor());
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [renamingCol, setRenamingCol] = useState(null); // { id, name }
  const [folderMenu, setFolderMenu] = useState(null); // { frameId, x, y } — frame right-click menu
  const folderMenuRef = useRef(null);

  const refreshCollections = () => setCollections(loadCollections());

  const handleCreateFolder = () => {
    if (!newFolderName.trim()) return;
    createCollection(newFolderName, newFolderColor);
    setNewFolderName('');
    setNewFolderColor(randomColor());
    setShowNewFolder(false);
    refreshCollections();
  };

  const handleDeleteFolder = (id) => {
    deleteCollection(id);
    if (activeCollection === id) setActiveCollection(null);
    refreshCollections();
  };

  const handleRenameFolder = (id, name) => {
    renameCollection(id, name);
    setRenamingCol(null);
    refreshCollections();
  };

  const handleAddToFolder = (colId, frameIds) => {
    addFramesToCollection(colId, frameIds);
    refreshCollections();
    notify(`Added ${frameIds.length} frame${frameIds.length === 1 ? '' : 's'} to folder`, 'success');
    setFolderMenu(null);
  };

  const handleRemoveFromFolder = (colId, frameId) => {
    removeFrameFromCollection(colId, frameId);
    refreshCollections();
    setFolderMenu(null);
  };

  // Close folder context menu on outside click
  useEffect(() => {
    if (!folderMenu) return;
    const handler = (e) => {
      if (folderMenuRef.current && !folderMenuRef.current.contains(e.target)) setFolderMenu(null);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [folderMenu]);


  // Declared early so effects below (keyboard nav, clamp) can safely depend on it.
  /**
   * Counted the way the folder is opened — see the note on removeItem. The chip used the raw id
   * array while the view filters live frames, so the number and the contents disagreed.
   */
  const liveFrameIds = useMemo(() => new Set(items.map((it) => it.id)), [items]);
  const collectionCount = useCallback(
    (col) => (col?.frameIds || []).filter((id) => liveFrameIds.has(id)).length,
    [liveFrameIds],
  );

  const filteredItems = useMemo(() => {
    let list = items;
    // Collection filter — if a folder is active only show its frames
    if (activeCollection) {
      const col = collections.find((c) => c.id === activeCollection);
      const ids = new Set(col?.frameIds || []);
      list = list.filter((it) => ids.has(it.id));
    }
    if (dateFilter !== 'all') {
      const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
      const cutoff = dateFilter === 'today' ? startOfToday.getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;
      list = list.filter((it) => (it.createdAt || 0) >= cutoff);
    }
    if (statusFilter === 'new') list = list.filter((it) => !isUsed(it) && !isFailed(it));
    else if (statusFilter === 'used') list = list.filter((it) => isUsed(it));
    else if (statusFilter === 'failed') list = list.filter((it) => isFailed(it));
    if (limitCount > 0) list = list.slice(0, limitCount);
    return list;
  }, [items, dateFilter, statusFilter, limitCount, failedNames, activeCollection, collections]);


  // Keep the preview index inside the current filtered range.
  useEffect(() => {
    if (previewIdx !== null && previewIdx >= filteredItems.length) setPreviewIdx(null);
  }, [filteredItems.length, previewIdx]);
  const [dragBox, setDragBox] = useState(null);
  const [isDragSelecting, setIsDragSelecting] = useState(false);
  const activeDragSelectedRef = useRef(new Set());
  const initialSelectedRef = useRef(new Set());

  useEffect(() => {
    const handleMouseDown = (e) => {
      if (e.button !== 0) return;
      const target = e.target;
      const isInteractive = target.closest('button, input, select, textarea, a, [role="button"]') ||
                            target.closest('.ConfirmDialog') ||
                            target.closest('.Modal') ||
                            target.closest('[class*="ContextMenu"]');
      if (isInteractive) return;
      if (target.closest('img, video, [draggable="true"]')) return;

      const startX = e.clientX;
      const startY = e.clientY;
      let hasTriggeredDrag = false;
      const initialSelected = new Set(selectedIds);
      initialSelectedRef.current = initialSelected;
      activeDragSelectedRef.current = new Set();

      const handleMouseMove = (moveEvent) => {
        const currentX = moveEvent.clientX;
        const currentY = moveEvent.clientY;
        const dx = currentX - startX;
        const dy = currentY - startY;

        if (!hasTriggeredDrag && Math.sqrt(dx * dx + dy * dy) > 5) {
          hasTriggeredDrag = true;
          setIsDragSelecting(true);
        }

        if (hasTriggeredDrag) {
          moveEvent.preventDefault();
          setDragBox({ startX, startY, currentX, currentY });

          const boxLeft = Math.min(startX, currentX);
          const boxTop = Math.min(startY, currentY);
          const boxWidth = Math.abs(currentX - startX);
          const boxHeight = Math.abs(currentY - startY);

          const elements = document.querySelectorAll('[data-library-item-id]');
          const intersectingIds = new Set();

          elements.forEach((el) => {
            const itemId = el.getAttribute('data-library-item-id');
            if (!itemId) return;
            const rect = el.getBoundingClientRect();
            const intersects = !(
              rect.right < boxLeft ||
              rect.left > boxLeft + boxWidth ||
              rect.bottom < boxTop ||
              rect.top > boxTop + boxHeight
            );
            if (intersects) intersectingIds.add(itemId);
          });

          const isSetEqual = (a, b) => a.size === b.size && [...a].every(value => b.has(value));
          if (!isSetEqual(intersectingIds, activeDragSelectedRef.current)) {
            activeDragSelectedRef.current = intersectingIds;
            const isModifierHeld = moveEvent.shiftKey || moveEvent.ctrlKey || moveEvent.metaKey;
            setSelectedIds(() => {
              if (isModifierHeld) {
                const merged = new Set(initialSelected);
                intersectingIds.forEach(id => {
                  if (initialSelected.has(id)) {
                    merged.delete(id);
                  } else {
                    merged.add(id);
                  }
                });
                return Array.from(merged);
              } else {
                return Array.from(intersectingIds);
              }
            });
          }
        }
      };

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        setIsDragSelecting(false);
        setDragBox(null);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousedown', handleMouseDown);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, [selectedIds]);

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer?.files?.length) {
      await addFiles(e.dataTransfer.files);
    }
  };

  // Hydrate frames from IndexedDB once on mount (migrates any old localStorage frames).
  useEffect(() => {
    let cancelled = false;
    loadFrames().then((loaded) => {
      if (!cancelled && loaded.length) setItems(loaded);
      framesHydratedRef.current = true;
    }).catch(() => { framesHydratedRef.current = true; });
    return () => { cancelled = true; };
  }, []);

  // Persist to IndexedDB whenever items change (after hydration, so we don't clobber
  // stored frames with the empty initial state).
  useEffect(() => {
    if (!framesHydratedRef.current) return;
    saveAllFrames(items);
  }, [items]);

  // Keyboard navigation for preview
  useEffect(() => {
    if (previewIdx === null) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setPreviewIdx(null);
      if (e.key === 'ArrowLeft' && previewIdx > 0) setPreviewIdx(previewIdx - 1);
      if (e.key === 'ArrowRight' && previewIdx < filteredItems.length - 1) setPreviewIdx(previewIdx + 1);
      if (e.key === ' ' && filteredItems[previewIdx]) { e.preventDefault(); toggleItem(filteredItems[previewIdx].id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewIdx, filteredItems]);

  const selectedItems = useMemo(() => items.filter((item) => selectedIds.includes(item.id)), [items, selectedIds]);

  const toggleItem = (id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const selectAll = () => {
    setSelectedIds(filteredItems.map(item => item.id));
  };

  const selectNone = () => {
    setSelectedIds([]);
  };

  const addFiles = async (incoming) => {
    const all = [...incoming];
    const images = all.filter((file) => file.type.startsWith('image/'));
    const videos = all.filter((file) => file.type.startsWith('video/'));
    if (images.length === 0 && videos.length === 0) {
      notify('Only image or video files are supported', 'error');
      return;
    }
    // Images: add as-is.
    const imageItems = await Promise.all(
      images.map(async (file) => ({ ...makeItem(file, 'Upload'), dataUrl: await fileToDataUrl(file) }))
    );
    if (imageItems.length) setItems((prev) => [...imageItems, ...prev].slice(0, 2000));

    // Videos: pull a frame (or frames) out of each and add as image(s).
    let vidOk = 0;
    let addedFrames = 0;
    const vidFails = [];
    let firstErr = '';
    if (videos.length) {
      notify(`Extracting frame${videos.length === 1 ? '' : 's'} from ${videos.length} video${videos.length === 1 ? '' : 's'}${frameMode === 'brain' ? ' (🧠 AI Brain)' : frameMode === 'quick' ? ' (⚡ Quick)' : ' (📸 Thumbnail)'}…`, 'info');
      for (const file of videos) {
        const base = (file.name || 'video').replace(/\.[^.]+$/, '');
        try {
          let frames;
          if (frameMode === 'brain') {
            try {
              frames = await extractSmartFramesFromVideoFile(file); // [{dataUrl, mime, label}]
            } catch (smartErr) {
              // Smart pick failed (no key / rate limit / etc.) — fall back to a single plain frame.
              if (!firstErr) firstErr = `AI Brain: ${smartErr?.message || 'failed'} (used plain frame)`;
              const one = await extractFrameFromVideoFile(file);
              frames = [{ ...one, label: '' }];
            }
          } else {
            const one = await extractFrameFromVideoFile(file);
            frames = [{ ...one, label: '' }];
          }
          for (const fr of frames) {
            const name = fr.label ? `${base}_${fr.label}.jpg` : `${base}.jpg`;
            const item = { ...makeItem(file, 'Video Frame'), name, type: fr.mime, size: 0, dataUrl: fr.dataUrl };
            setItems((prev) => [item, ...prev].slice(0, 2000));
            addedFrames += 1;
          }
          if (frames.length) vidOk += 1;
        } catch (e) {
          if (!firstErr) firstErr = e?.message || 'unknown error';
          vidFails.push(file.name || 'video');
        }
      }
    }

    const parts = [];
    if (imageItems.length) parts.push(`${imageItems.length} image${imageItems.length === 1 ? '' : 's'}`);
    if (addedFrames) parts.push(`${addedFrames} video frame${addedFrames === 1 ? '' : 's'} from ${vidOk} clip${vidOk === 1 ? '' : 's'}`);
    if (parts.length) notify(`Imported ${parts.join(' + ')} to library`, 'success');
    if (vidFails.length) notify(`Couldn't extract ${vidFails.length} video${vidFails.length === 1 ? '' : 's'} — ${firstErr}`, 'error', 8000);
  };

  // ── Import frames from Instagram / TikTok / X links ──────────────────────
  const importLinks = async (linksText = igLinks) => {
    const lines = linksText.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('http'));
    if (lines.length === 0) { notify('Paste at least one valid Instagram, TikTok, or X URL', 'error'); return; }
    setIsImporting(true);
    notify(`Importing ${lines.length} link(s)…`, 'info');
    setImportProgress({ done: 0, total: lines.length });
    const fails = [];
    let savedCount = 0;
    // Save each frame the instant it's extracted (so a crash mid-batch keeps the done ones),
    // and collect failures for Retry all.
    const onResult = (r) => {
      if (r && r.ok) {
        // Smart mode returns multiple labelled frames per link; normal returns one.
        const frames = (Array.isArray(r.frames) && r.frames.length)
          ? r.frames
          : [{ dataUrl: r.dataUrl, mimeType: r.mimeType, name: r.name }];
        for (const fr of frames) {
          if (!fr.dataUrl) continue;
          savedCount += 1;
          const item = {
            id: `frame-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            name: fr.name || r.name, type: fr.mimeType || r.mimeType, size: 0, createdAt: Date.now(),
            source: r.source, dataUrl: fr.dataUrl, usage: [],
            // The original IG/TikTok/X post link this frame came from — carried through to
            // the generator so a generated image can link back to its source video.
            sourceUrl: r.sourceUrl || r.url || null,
          };
          setItems((prev) => [item, ...prev].slice(0, 2000));
        }
      } else {
        fails.push({ url: r.url, errorMessage: r.error });
      }
    };
    if (useApify) {
      await extractLinksViaApify(lines, (done, total) => setImportProgress({ done, total }), onResult, frameMode);
    } else {
      await runWithConcurrency(lines, (url) => extractOneLink(url, frameMode), undefined, (done, total) => setImportProgress({ done, total }), onResult);
    }
    setImportProgress(null);
    if (savedCount > 0) {
      notify(`Saved ${savedCount} frame${savedCount === 1 ? '' : 's'} to Frame Library 📥`, 'success');
    }
    // Save successful links to history
    const failedUrls = new Set(fails.map((f) => f.url));
    const successUrls = lines.filter((u) => !failedUrls.has(u));
    if (successUrls.length > 0) {
      saveLinkHistory([...successUrls.map((u) => ({ url: u, date: Date.now() })), ...linkHistory]);
    }
    if (fails.length > 0) {
      setFailedLinks((prev) => {
        const seen = new Set(prev.map((f) => f.url));
        return [...prev, ...fails.filter((f) => !seen.has(f.url))];
      });
      notify(`${fails.length} link(s) failed`, 'error');
    }
    // Keep links in textarea (don't clear)
    setIsImporting(false);
  };

  const retryAllFailed = async () => {
    if (isImporting || failedLinks.length === 0) return;
    const urls = failedLinks.map((f) => f.url).join('\n');
    setFailedLinks([]);
    await importLinks(urls);
  };

  // ── Profile Grab — pull N random reels from an IG profile ────────────────
  const grabProfile = async () => {
    if (!profileUrl.trim()) { notify('Paste an Instagram profile URL first', 'error'); return; }
    setIsGrabbing(true);
    setGrabProgress(null);
    setGrabPhase(null);
    setGrabDownloaded(0);
    setGrabErrors([]);
    let savedCount = 0;
    try {
      const res = await fetch('/api/instagram-frames/grab-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileUrl: profileUrl.trim(), count: profileCount, frameMode }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j?.error?.message || j?.error || msg; } catch {}
        throw new Error(msg);
      }
      // Stream NDJSON response
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'frame') {
              savedCount++;
              const f = msg.frame;
              const item = {
                id: `frame-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
                name: f.name || `grabbed-${savedCount}.jpg`,
                type: f.mimeType || 'image/jpeg',
                size: 0,
                createdAt: Date.now(),
                source: f.sourceUrl || profileUrl.trim(),
                dataUrl: `data:${f.mimeType || 'image/jpeg'};base64,${f.base64}`,
                usage: [],
              };
              setItems((prev) => [item, ...prev].slice(0, 2000));
            } else if (msg.type === 'phase') {
              setGrabPhase(msg.phase);
            } else if (msg.type === 'download_progress') {
              setGrabDownloaded(msg.downloaded);
            } else if (msg.type === 'progress') {
              setGrabProgress({ done: msg.done, total: msg.total });
            } else if (msg.type === 'video_error') {
              setGrabErrors((prev) => [...prev, { url: msg.url, message: msg.message }]);
            } else if (msg.type === 'done') {
              setGrabPhase(null);
              setGrabProgress({ done: msg.totalAttempted, total: msg.totalAttempted });
            } else if (msg.type === 'error') {
              throw new Error(msg.message);
            }
          } catch (parseErr) {
            if (parseErr?.message && !parseErr.message.includes('JSON')) throw parseErr;
          }
        }
      }
      if (savedCount > 0) notify(`Grabbed ${savedCount} frame${savedCount === 1 ? '' : 's'} from profile 🎬`, 'success');
      else notify('No frames grabbed — check cookies or try fewer videos', 'error');
    } catch (err) {
      notify(err.message || 'Profile grab failed', 'error');
    } finally {
      setIsGrabbing(false);
      setGrabProgress(null);
      setGrabPhase(null);
      setGrabDownloaded(0);
    }
  };

  const saveProxy = async () => {
    try {
      const res = await fetch('/api/instagram-frames/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxy: proxyInput.trim() }),
      });
      const json = await res.json();
      if (!res.ok || json?.success === false) throw new Error(json?.error?.message || json?.error || 'Failed');
      notify(proxyInput.trim() ? 'Scraper proxy saved ✓' : 'Scraper proxy cleared', 'success');
    } catch (e) {
      notify(e.message || 'Failed to save proxy', 'error');
    }
  };

  /**
   * DELETING A FRAME ALSO TAKES IT OUT OF EVERY FOLDER.
   *
   * removeFrameFromAllCollections was written for exactly this, imported at the top of this file,
   * and never called once. So a deleted frame kept its place in every folder's frameIds: the chip
   * counted ids, the folder view filtered live frames, and the two drifted apart permanently —
   * worst after "Clear entire frame library", which left every folder claiming its full old count
   * over an empty library.
   *
   * The counts are now derived from live frames as well (see collectionCount), so a stale id is
   * invisible even if some other path forgets to cascade. Both, because either alone is a
   * half-fix: cascading keeps the store honest, deriving keeps the UI honest.
   */
  const removeItem = (id) => {
    removeFrameFromAllCollections(id);
    refreshCollections();
    setItems((prev) => prev.filter((item) => item.id !== id));
    setSelectedIds((prev) => prev.filter((itemId) => itemId !== id));
    if (previewIdx !== null) {
      // Adjust preview index if necessary (within the filtered view)
      const activeItem = filteredItems[previewIdx];
      if (!activeItem || activeItem.id === id) {
        setPreviewIdx(null);
      } else {
        const newIdx = filteredItems.filter((item) => item.id !== id).findIndex(item => item.id === activeItem.id);
        setPreviewIdx(newIdx !== -1 ? newIdx : null);
      }
    }
  };

  const deleteSelected = () => {
    if (selectedIds.length === 0) return;
    for (const id of selectedIds) removeFrameFromAllCollections(id);
    refreshCollections();
    setItems((prev) => prev.filter((item) => !selectedIds.includes(item.id)));
    setSelectedIds([]);
    setPreviewIdx(null);
    notify('Selected frames deleted', 'success');
  };

  const clearAll = () => {
    if (window.confirm('Are you sure you want to clear your entire frame library?')) {
      // "Library cleared" said so while leaving every folder holding the whole old library.
      for (const it of items) removeFrameFromAllCollections(it.id);
      refreshCollections();
      setItems([]);
      setSelectedIds([]);
      setPreviewIdx(null);
      notify('Library cleared', 'success');
    }
  };

  const downloadSelected = () => {
    if (selectedItems.length === 0) return;
    selectedItems.forEach((item, index) => {
      // Staggered because browsers drop rapid-fire saves; downloadBlob strips first.
      setTimeout(async () => {
        const blob = await (await fetch(item.dataUrl)).blob();
        await downloadBlob(blob, item.name.includes('.') ? item.name : `${item.name}.jpg`);
      }, index * 100);
    });
  };

  const sendSelected = (featureKey) => {
    if (selectedItems.length === 0) {
      notify('Select at least one frame', 'error');
      return;
    }
    const target = SEND_TARGETS[featureKey] || SEND_TARGETS.photo;
    const itemsPayload = selectedItems.map((item) => ({ dataUrl: item.dataUrl, name: item.name, sourceUrl: item.sourceUrl || null }));
    const sentAt = Date.now();
    const updated = items.map((item) =>
      selectedIds.includes(item.id)
        ? { ...item, usage: [...new Set([...(item.usage || []), target.label])], lastUsedAt: sentAt }
        : item
    );
    setItems(updated);
    // Persist the "Used" mark NOW — navigateTo() below unmounts this page, which would
    // otherwise happen before the [items] persist effect runs, losing the mark.
    saveAllFrames(updated);
    // Re-sending a frame = retrying it → clear any previous Failed mark.
    clearFrameFailed(selectedItems.map((it) => it.name));
    // Sending changes a frame's status (Used / no-longer-Failed) — if the CURRENT filter would
    // now hide the frames you just sent, they'd vanish from view, which reads exactly like a
    // delete even though nothing was removed. Switch to "All" so they stay visible with their
    // updated badge instead.
    if (statusFilter === 'new' || statusFilter === 'failed') setStatusFilter('all');
    // Stash for the destination to pick up on mount (reliable), then also fire the legacy
    // event (deduped by the page). Stash avoids the race where a lazily-loaded page mounts
    // after the event already fired.
    stashSourceHandoff(target.page, itemsPayload);
    navigateTo(handoffDestination(target.page));
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent(target.event, { detail: { items: itemsPayload } }));
    }, 300);
    notify(`Sent ${selectedItems.length} frame${selectedItems.length === 1 ? '' : 's'} to ${target.label} ⚡`, 'success');
  };

  const sendOne = (item, featureKey) => {
    if (!item) return;
    const target = SEND_TARGETS[featureKey] || SEND_TARGETS.photo;
    const updated = items.map((it) => (it.id === item.id
      ? { ...it, usage: [...new Set([...(it.usage || []), target.label])], lastUsedAt: Date.now() }
      : it));
    setItems(updated);
    saveAllFrames(updated); // persist before navigateTo() unmounts this page (see sendSelected)
    clearFrameFailed([item.name]); // re-sending = retrying → clear any Failed mark
    // Sending changes this frame's status — if the current filter would now hide it, it'd
    // vanish from view (reads like a delete). Switch to "All" so it stays visible.
    if (statusFilter === 'new' || statusFilter === 'failed') setStatusFilter('all');
    const one = [{ dataUrl: item.dataUrl, name: item.name, sourceUrl: item.sourceUrl || null }];
    stashSourceHandoff(target.page, one);
    navigateTo(handoffDestination(target.page));
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent(target.event, { detail: { items: one } }));
    }, 300);
    notify(`Frame sent to ${target.label} ⚡`, 'success');
  };

  const handleDragStart = (e, item, idx) => {
    if (!window.electronAPI?.startDragFiles) return;

    let dragTargets = [];
    if (selectedIds.includes(item.id)) {
      dragTargets = items.filter(i => selectedIds.includes(i.id));
    } else {
      dragTargets = [item];
    }

    const filesPayload = dragTargets.map((i, index) => {
      const parts = String(i.dataUrl || '').split(',');
      const base64 = parts[1] || '';
      const mimeMatch = parts[0]?.match(/data:(image\/[^;]+)/);
      const mime = mimeMatch ? mimeMatch[1] : i.type || 'image/jpeg';
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      
      const cleanName = i.name ? i.name.replace(/\.[a-zA-Z0-9]+$/, '') : `frame_${index + 1}`;
      const name = `${cleanName}_${index + 1}.${ext}`;
      
      return {
        name,
        base64
      };
    });

    e.preventDefault();
    window.electronAPI.startDragFiles({ files: filesPayload });

    // Dragging a frame out = it's being used to generate → mark it Used (and persist) so the
    // "Used" filter reflects it, same as the Send buttons do.
    const draggedIds = new Set(dragTargets.map((i) => i.id));
    const draggedAt = Date.now();
    const updated = items.map((it) => (draggedIds.has(it.id)
      ? { ...it, usage: [...new Set([...(it.usage || []), 'Generator'])], lastUsedAt: draggedAt }
      : it));
    setItems(updated);
    saveAllFrames(updated);
    clearFrameFailed(dragTargets.map((i) => i.name)); // dragging out = retrying → clear Failed
  };

  const previewItem = previewIdx !== null ? filteredItems[previewIdx] : null;
  const previewIsSelected = previewItem ? selectedIds.includes(previewItem.id) : false;

  return (
    <div className="flex flex-col gap-4 animate-in h-full min-h-0">

      {/* ── FOLDERS STRIP — always at top, sticky ─────────────────────────── */}
      <div className="sticky top-0 z-20 flex items-center gap-1.5 flex-wrap px-0.5 py-2 bg-[var(--bg-main,#0c0c0e)] border-b border-zinc-800/50">
        <button
          onClick={() => setActiveCollection(null)}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[0.6875rem] font-medium border transition cursor-pointer ${activeCollection === null ? 'bg-zinc-700 border-zinc-500 text-white' : 'bg-zinc-900/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}
        >
          📁 All frames
        </button>

        {collections.map((col) => {
          const isActive = activeCollection === col.id;
          const count = collectionCount(col);
          return (
            <div key={col.id} className="relative group/col flex items-center">
              {renamingCol?.id === col.id ? (
                <form onSubmit={(e) => { e.preventDefault(); handleRenameFolder(col.id, renamingCol.name); }} className="flex items-center gap-1">
                  <input autoFocus value={renamingCol.name} onChange={(e) => setRenamingCol({ ...renamingCol, name: e.target.value })} onBlur={() => handleRenameFolder(col.id, renamingCol.name)} onKeyDown={(e) => e.key === 'Escape' && setRenamingCol(null)} className="rounded-full px-2 py-0.5 text-[0.6875rem] bg-zinc-800 border border-zinc-600 text-white outline-none w-24" />
                </form>
              ) : (
                <button
                  onClick={() => setActiveCollection(isActive ? null : col.id)}
                  className={`flex items-center gap-1.5 pl-2 pr-2 py-1 rounded-full text-[0.6875rem] font-medium border transition cursor-pointer ${isActive ? 'text-white' : 'bg-zinc-900/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}
                  style={isActive ? { background: col.color + '33', borderColor: col.color + '80' } : {}}
                >
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: col.color }} />
                  {col.name}
                  {count > 0 && <span className="text-[0.5625rem] opacity-60 ml-0.5">({count})</span>}
                </button>
              )}
              {renamingCol?.id !== col.id && (
                <div className="absolute -top-1 -right-1 hidden group-hover/col:flex items-center gap-0.5 z-10">
                  <button onClick={(e) => { e.stopPropagation(); setRenamingCol({ id: col.id, name: col.name }); }} className="w-4 h-4 rounded-full bg-zinc-800 border border-zinc-600 text-[0.5rem] flex items-center justify-center cursor-pointer hover:text-white" title="Rename">✏️</button>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteFolder(col.id); }} className="w-4 h-4 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 hover:text-red-400 text-[0.625rem] flex items-center justify-center cursor-pointer" title="Delete">×</button>
                </div>
              )}
            </div>
          );
        })}

        {showNewFolder ? (
          <form onSubmit={(e) => { e.preventDefault(); handleCreateFolder(); }} className="flex items-center gap-1">
            <div className="w-4 h-4 rounded-full cursor-pointer border-2 border-white/20 flex-shrink-0" style={{ background: newFolderColor }} onClick={() => { const c = ['#a855f7','#ec4899','#3b82f6','#22c55e','#f59e0b','#ef4444','#06b6d4','#f97316']; setNewFolderColor(c[(c.indexOf(newFolderColor)+1)%c.length]); }} title="Click to change colour" />
            <input autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setShowNewFolder(false)} placeholder="Folder name…" className="rounded-full px-2 py-0.5 text-[0.6875rem] bg-zinc-800 border border-zinc-600 text-white outline-none w-28 placeholder-zinc-600" />
            <button type="submit" className="text-[0.625rem] text-emerald-400 font-semibold cursor-pointer">✓</button>
            <button type="button" onClick={() => setShowNewFolder(false)} className="text-[0.625rem] text-zinc-500 cursor-pointer">✕</button>
          </form>
        ) : (
          <button onClick={() => setShowNewFolder(true)} className="flex items-center gap-1 px-2 py-1 rounded-full text-[0.6875rem] text-zinc-500 border border-dashed border-zinc-700 hover:border-zinc-500 hover:text-zinc-300 transition cursor-pointer">
            + New Folder
          </button>
        )}

        {selectedIds.length > 0 && collections.length > 0 && (
          <div className="ml-auto relative group/addmenu">
            <button className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[0.6875rem] bg-zinc-800/80 border border-zinc-700/60 text-zinc-300 hover:border-zinc-500 transition cursor-pointer">
              📁 Save {selectedIds.length} to folder…
            </button>
            <div className="absolute right-0 top-full mt-1 bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-xl p-1 min-w-[150px] z-30 hidden group-hover/addmenu:block">
              {collections.map((col) => (
                <button key={col.id} onClick={() => handleAddToFolder(col.id, selectedIds)} className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg text-[0.6875rem] text-zinc-300 hover:bg-zinc-800 transition cursor-pointer">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: col.color }} />
                  {col.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Main content: left col + right col ─────────────────────────────── */}
      <div className="flex gap-6 flex-1 min-h-0">
      {/* ── Left column: controls + grid ────────────────────────────────── */}
      <div className="flex flex-col gap-5 w-[430px] xl:w-[460px] 2xl:w-[500px] shrink-0 overflow-y-auto pr-1">
        
        {/* Title Card */}
        <div className="rounded-2xl border border-zinc-800/70 bg-zinc-900/60 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-zinc-100">Frame Library</h2>
              <p className="text-xs text-zinc-500 mt-0.5">Manage and send your downloaded IG frames or custom scene reference images.</p>
            </div>
            <Badge color="zinc">{items.length} frames</Badge>
          </div>

          {/* Drag & Drop uploader for manual addition */}
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`flex min-h-[90px] cursor-pointer items-center justify-center rounded-xl border border-dashed px-4 py-3 transition-all duration-150 ${
              isDragging
                ? 'border-pink-500 bg-pink-500/[0.06] scale-[0.99]'
                : 'border-zinc-700/60 bg-zinc-950/20 hover:border-pink-500/55 hover:bg-pink-500/[0.02]'
            }`}
          >
            <div className="text-center">
              <div className="text-xs font-medium text-zinc-300">Drop images or videos here, or click to import</div>
              <div className="mt-0.5 text-[0.625rem] text-zinc-500">Images: PNG, JPEG, WEBP · Videos: MP4, MOV, WEBM (a frame is auto-extracted)</div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              className="hidden"
              onChange={(e) => { addFiles(e.target.files || []); e.target.value = ''; }}
            />
          </div>

          {/* Frame extraction mode selector */}
          <div className="space-y-1.5">
            <span className="text-[0.6875rem] font-medium text-zinc-300">Frame extraction mode</span>
            <div className="flex gap-1.5">
              {[
                { key: 'brain', icon: '🧠', label: 'AI Brain', desc: 'AI picks the best frame — face visible, eyes open, full body' },
                { key: 'quick', icon: '⚡', label: 'Quick', desc: '2nd frame at 200ms — fast, no API call' },
                { key: 'thumb', icon: '📸', label: 'Thumbnail', desc: 'ffmpeg picks the most representative frame' },
              ].map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setFrameMode(m.key)}
                  title={m.desc}
                  className={`flex-1 px-2 py-1.5 rounded text-[0.625rem] font-medium border transition cursor-pointer ${
                    frameMode === m.key
                      ? 'bg-rose-600/30 border-rose-500/60 text-rose-200'
                      : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300'
                  }`}
                >
                  <span className="block text-sm">{m.icon}</span>
                  {m.label}
                </button>
              ))}
            </div>
            <span className="block text-[0.625rem] text-zinc-500">
              {frameMode === 'brain' && '🧠 Uses Gemini vision to pick frames with clear face (eyes open), full body, sharp focus. Costs 1 API call per video.'}
              {frameMode === 'quick' && '⚡ Grabs the 2nd or 3rd frame from the video at ~200ms. Fast, no API call, but may miss the best face shot.'}
              {frameMode === 'thumb' && '📸 ffmpeg analyzes the video and picks the most visually distinct frame. No API call, but not face-aware.'}
            </span>
          </div>

          {/* Import from Instagram / TikTok / X links → saved to this library */}
          <div className="pt-1 border-t border-zinc-800/70">
            <button
              type="button"
              onClick={() => setShowImport((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition font-medium cursor-pointer"
            >
              <span className="text-[0.625rem] transition-transform inline-block" style={{ transform: showImport ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
              Import from Instagram / TikTok / X URL
            </button>
            {showImport && (
              <div className="mt-3 space-y-2">
                <p className="text-[0.6875rem] text-zinc-500 leading-normal">Paste links (one per line). Each extracted frame is saved here. Carousel posts support <code className="text-zinc-400 bg-zinc-800/60 px-1 py-0.5 rounded">?img_index=N</code>.</p>
                <textarea
                  value={igLinks}
                  onChange={(e) => setIgLinks(e.target.value)}
                  rows={3}
                  disabled={isImporting}
                  placeholder="https://www.instagram.com/p/...&#10;https://www.tiktok.com/@user/video/...&#10;https://x.com/user/status/..."
                  className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-3 py-2 text-xs font-mono text-zinc-300 placeholder-zinc-700 outline-none focus:border-pink-500/60 resize-none"
                />
                <label className="flex items-start gap-2 cursor-pointer select-none text-[0.6875rem] text-zinc-400">
                  <input
                    type="checkbox"
                    checked={useApify}
                    onChange={(e) => { setUseApify(e.target.checked); try { window.localStorage.setItem('kyros.frameLibrary.useApify', e.target.checked ? '1' : '0'); } catch {} }}
                    className="mt-0.5 h-3.5 w-3.5 accent-pink-500 cursor-pointer"
                  />
                  <span><span className="text-zinc-200 font-medium">Use Apify</span> — no cookies, no Instagram blocks (uses Apify credits, ~$0.30 / 100 links). Uncheck for the free yt-dlp + cookies method.</span>
                </label>
                <button
                  type="button"
                  onClick={() => importLinks()}
                  disabled={isImporting || !igLinks.trim()}
                  className="w-full rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs py-2 font-medium transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {isImporting ? (importProgress ? `Importing ${importProgress.done}/${importProgress.total}…` : 'Importing…') : 'Import Links → Save to Library'}
                </button>
                <details className="text-[0.6875rem]">
                  <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300 select-none">Scraper proxy (optional)</summary>
                  <div className="mt-2 flex gap-2">
                    <input
                      value={proxyInput}
                      onChange={(e) => setProxyInput(e.target.value)}
                      placeholder="http://user:pass@host:port"
                      className="flex-1 rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-2 py-1.5 text-[0.6875rem] font-mono text-zinc-300 placeholder-zinc-700 outline-none focus:border-pink-500/60"
                    />
                    <button type="button" onClick={saveProxy} className="rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-3 text-[0.6875rem] font-medium transition cursor-pointer">Save</button>
                  </div>
                  <p className="mt-1 text-[0.625rem] text-zinc-600">Routes yt-dlp / gallery-dl through a proxy so scraping doesn&apos;t use your real IP. Leave blank &amp; Save to clear.</p>
                </details>
                {failedLinks.length > 0 && (
                  <div className="rounded-lg border border-red-900/30 bg-red-950/10 p-2.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[0.625rem] font-semibold text-red-400 uppercase tracking-wider">Failed ({failedLinks.length})</span>
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={retryAllFailed} disabled={isImporting} className="text-[0.625rem] font-semibold text-rose-400 hover:text-rose-300 transition disabled:opacity-40 disabled:cursor-not-allowed">
                          {isImporting ? 'Retrying…' : 'Retry all'}
                        </button>
                        <span className="text-zinc-700">|</span>
                        <button type="button" onClick={() => setFailedLinks([])} className="text-[0.625rem] text-zinc-500 hover:text-zinc-300 transition">Clear</button>
                      </div>
                    </div>
                    <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                      {failedLinks.map((item, idx) => (
                        <div key={idx} className="flex flex-col gap-0.5 text-[0.6875rem] bg-red-950/20 border border-red-900/20 rounded p-1.5">
                          <span className="font-mono text-zinc-400 truncate" title={item.url}>{item.url}</span>
                          <span className="text-red-400/80 leading-tight">{item.errorMessage}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Link history */}
                {linkHistory.length > 0 && (
                  <div className="border-t border-zinc-800/40 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowHistory((v) => !v)}
                      className="flex items-center gap-1.5 text-[0.6875rem] text-zinc-500 hover:text-zinc-300 transition font-medium cursor-pointer"
                    >
                      <span className="text-[0.5625rem] transition-transform inline-block" style={{ transform: showHistory ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                      📜 Link history ({linkHistory.length})
                    </button>
                    {showHistory && (
                      <div className="mt-2 space-y-1.5">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              const text = linkHistory.map((h) => h.url).join('\n');
                              navigator.clipboard.writeText(text).then(() => notify('Copied all links', 'success'));
                            }}
                            className="text-[0.625rem] text-rose-400 hover:text-rose-300 font-medium transition cursor-pointer"
                          >📋 Copy all</button>
                          <button
                            type="button"
                            onClick={() => {
                              setIgLinks((prev) => {
                                const existing = new Set(prev.split('\n').map((l) => l.trim()).filter(Boolean));
                                const newLinks = linkHistory.map((h) => h.url).filter((u) => !existing.has(u));
                                return [...(prev.trim() ? [prev.trim()] : []), ...newLinks].join('\n');
                              });
                              notify('Pasted history to import box', 'info');
                            }}
                            className="text-[0.625rem] text-rose-400 hover:text-rose-300 font-medium transition cursor-pointer"
                          >⬆ Paste to box</button>
                          <button
                            type="button"
                            onClick={() => { saveLinkHistory([]); notify('History cleared', 'info'); }}
                            className="text-[0.625rem] text-zinc-600 hover:text-zinc-300 transition cursor-pointer"
                          >Clear</button>
                        </div>
                        <div className="max-h-[200px] overflow-y-auto rounded-lg border border-zinc-800/50 bg-zinc-950/40 p-2 space-y-0.5">
                          {linkHistory.map((h, i) => (
                            <div key={`${h.url}-${i}`} className="flex items-center gap-1.5 group">
                              <button
                                type="button"
                                onClick={() => { navigator.clipboard.writeText(h.url).then(() => notify('Copied', 'success')); }}
                                className="text-[0.625rem] text-zinc-700 hover:text-zinc-300 transition cursor-pointer shrink-0"
                                title="Copy link"
                              >📋</button>
                              <span className="text-[0.625rem] text-zinc-500 font-mono truncate flex-1" title={h.url}>{h.url}</span>
                              <span className="text-[0.5625rem] text-zinc-700 shrink-0">{new Date(h.date).toLocaleDateString()}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Profile Grab Card ──────────────────────────────────────────── */}
        <div className="rounded-2xl border border-rose-500/25 bg-zinc-900/60 overflow-hidden">
          {/* Header */}
          <button
            type="button"
            onClick={() => setShowProfileGrab(v => !v)}
            className="w-full flex items-center gap-2 px-4 py-3 bg-gradient-to-r from-rose-600/20 to-pink-600/10 hover:from-rose-600/30 transition cursor-pointer"
          >
            <span className="text-lg">🎬</span>
            <div className="text-left flex-1">
              <div className="text-sm font-semibold text-rose-200">Grab Reels from Profile</div>
              <div className="text-[0.625rem] text-zinc-500">Randomly picks reels — always different videos</div>
            </div>
            <span className="text-zinc-500 text-xs transition-transform" style={{ transform: showProfileGrab ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
          </button>

          {showProfileGrab && (
            <div className="p-4 space-y-3 border-t border-rose-500/10">
              {/* Profile URL */}
              <div>
                <label className="text-[0.6875rem] text-zinc-500 block mb-1">Instagram Profile or Reels URL</label>
                <input
                  type="url"
                  value={profileUrl}
                  onChange={e => { setProfileUrl(e.target.value); try { window.localStorage.setItem('kyros.frameLibrary.profileUrl', e.target.value); } catch {} }}
                  disabled={isGrabbing}
                  placeholder="https://www.instagram.com/username/reels/"
                  className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-3 py-2 text-xs font-mono text-zinc-300 placeholder-zinc-700 outline-none focus:border-rose-500/60 disabled:opacity-50"
                />
              </div>

              {/* Count selector */}
              <div>
                <label className="text-[0.6875rem] text-zinc-500 block mb-1.5">How many reels to grab</label>
                <div className="flex gap-2">
                  {[10, 20, 50].map(n => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setProfileCount(n)}
                      disabled={isGrabbing}
                      className={`flex-1 rounded-lg border py-2 text-xs font-semibold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                        profileCount === n
                          ? 'border-rose-500/70 bg-rose-500/15 text-rose-200'
                          : 'border-zinc-700/50 bg-zinc-900/40 text-zinc-400 hover:border-zinc-600'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {/* Frame mode selector — inline, self-contained */}
              <div>
                <label className="text-[0.6875rem] text-zinc-500 block mb-1.5">Frame extraction mode</label>
                <div className="flex gap-1.5">
                  {[
                    { key: 'brain', icon: '🧠', label: 'AI Brain', desc: 'Gemini picks best face — eyes open, full body. 1 API call per video.' },
                    { key: 'quick', icon: '⚡', label: 'Quick', desc: '2nd frame at ~200ms. Fast, free, may miss best face.' },
                    { key: 'thumb', icon: '📸', label: 'Thumbnail', desc: 'ffmpeg picks most representative frame. Free, not face-aware.' },
                  ].map(m => (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => setFrameMode(m.key)}
                      disabled={isGrabbing}
                      title={m.desc}
                      className={`flex-1 flex flex-col items-center gap-0.5 px-2 py-2 rounded-lg border text-[0.625rem] font-medium transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                        frameMode === m.key
                          ? 'bg-rose-600/25 border-rose-500/60 text-rose-200'
                          : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300'
                      }`}
                    >
                      <span className="text-base">{m.icon}</span>
                      {m.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[0.625rem] text-zinc-600 leading-relaxed">
                  {frameMode === 'brain' && '🧠 Gemini vision picks the best face frame — eyes open, full body, sharp. Costs 1 API call per reel.'}
                  {frameMode === 'quick' && '⚡ Grabs 2nd frame at ~200ms. Fast & free, but may catch a blurry or partial shot.'}
                  {frameMode === 'thumb' && '📸 ffmpeg scans the reel and picks the most visually distinct frame. Free, but not face-aware.'}
                </p>
              </div>

              {/* Shuffle guarantee */}
              <div className="flex items-center gap-2 rounded-lg border border-emerald-900/30 bg-emerald-950/10 px-3 py-2">
                <span className="text-emerald-400 text-sm">🔀</span>
                <p className="text-[0.625rem] text-emerald-300/80 leading-relaxed">
                  <span className="font-semibold">Always different.</span> Every grab shuffles ALL reels on the profile with a random seed before picking — same URL will never give the same batch twice.
                </p>
              </div>

              {/* Live progress — phase-aware */}
              {isGrabbing && (
                <div className="space-y-2 rounded-xl border border-rose-500/20 bg-rose-950/20 p-3">
                  {/* Phase: Downloading */}
                  {grabPhase === 'downloading' && (
                    <>
                      <div className="flex items-center justify-between text-[0.6875rem]">
                        <span className="text-rose-300 font-medium flex items-center gap-1.5">
                          <span className="inline-block w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
                          Downloading reels from profile…
                        </span>
                        {grabDownloaded > 0 && (
                          <span className="text-rose-200 font-semibold">{grabDownloaded} videos saved</span>
                        )}
                      </div>
                      {/* Indeterminate pulsing bar */}
                      <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden relative">
                        <div
                          className="absolute inset-0 h-full rounded-full bg-gradient-to-r from-transparent via-rose-500 to-transparent"
                          style={{ animation: 'grabPulse 1.5s ease-in-out infinite' }}
                        />
                      </div>
                      <p className="text-[0.625rem] text-zinc-600">gallery-dl is fetching videos… this takes 1-2 min for 10 reels</p>
                    </>
                  )}

                  {/* Phase: Extracting frames */}
                  {grabPhase === 'extracting' && grabProgress && (
                    <>
                      <div className="flex items-center justify-between text-[0.6875rem]">
                        <span className="text-pink-300 font-medium flex items-center gap-1.5">
                          <span className="inline-block w-2 h-2 rounded-full bg-pink-400 animate-pulse" />
                          Extracting frames…
                        </span>
                        <span className="text-zinc-400">{grabProgress.done} / {grabProgress.total}</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-rose-600 to-pink-500 transition-all duration-500"
                          style={{ width: `${grabProgress.total > 0 ? (grabProgress.done / grabProgress.total) * 100 : 0}%` }}
                        />
                      </div>
                      <p className="text-[0.625rem] text-zinc-600">Frames appear in your library live ↑</p>
                    </>
                  )}

                  {/* Fallback: connecting */}
                  {!grabPhase && (
                    <div className="flex items-center gap-2 text-[0.6875rem] text-zinc-500">
                      <span className="inline-block w-2 h-2 rounded-full bg-zinc-500 animate-pulse" />
                      Connecting to Instagram…
                    </div>
                  )}
                </div>
              )}

              {/* Grab button */}
              <button
                type="button"
                onClick={grabProfile}
                disabled={isGrabbing || !profileUrl.trim()}
                className="w-full rounded-xl bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 text-white text-sm py-3 font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shadow-lg shadow-rose-900/30"
              >
                {isGrabbing
                  ? (grabPhase === 'downloading'
                    ? `📥 Downloading… ${grabDownloaded > 0 ? `${grabDownloaded} saved` : ''}`
                    : grabPhase === 'extracting' && grabProgress
                      ? `🎬 Extracting ${grabProgress.done}/${grabProgress.total}`
                      : '⏳ Starting…')
                  : `🎬 Grab ${profileCount} Random Reels`}
              </button>

              {/* Errors */}
              {grabErrors.length > 0 && !isGrabbing && (
                <div className="rounded-lg border border-orange-900/30 bg-orange-950/10 p-2.5">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[0.625rem] font-semibold text-orange-400 uppercase tracking-wider">Skipped ({grabErrors.length})</span>
                    <button type="button" onClick={() => setGrabErrors([])} className="text-[0.625rem] text-zinc-500 hover:text-zinc-300 transition cursor-pointer">Clear</button>
                  </div>
                  <div className="space-y-1 max-h-24 overflow-y-auto">
                    {grabErrors.map((e, i) => (
                      <div key={i} className="text-[0.625rem] text-orange-300/70 truncate">{e.message || 'Unknown error'}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Toolbar & Grid */}


        {items.length > 0 ? (
          <div className="space-y-3">
            {/* Filters */}
            <div className="flex items-center gap-1.5 flex-wrap text-[0.6875rem]">
              <span className="text-zinc-600">Date:</span>
              {[['all', 'All'], ['today', 'Today'], ['week', '7 days']].map(([v, l]) => (
                <button key={v} onClick={() => setDateFilter(v)} className={`rounded-md px-2 py-0.5 transition cursor-pointer ${dateFilter === v ? 'bg-rose-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-white'}`}>{l}</button>
              ))}
              <span className="text-zinc-700 mx-0.5">·</span>
              <span className="text-zinc-600">Status:</span>
              {[['all', 'All'], ['new', 'Not generated'], ['used', 'Used']].map(([v, l]) => (
                <button key={v} onClick={() => setStatusFilter(v)} className={`rounded-md px-2 py-0.5 transition cursor-pointer ${statusFilter === v ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-white'}`}>{l}</button>
              ))}
              {(() => { const n = items.filter(isFailed).length; return (
                <button onClick={() => setStatusFilter('failed')} className={`rounded-md px-2 py-0.5 transition cursor-pointer ${statusFilter === 'failed' ? 'bg-red-600 text-white' : 'bg-zinc-800 text-red-300/80 hover:text-red-200'}`}>Failed{n > 0 ? ` (${n})` : ''}</button>
              ); })()}
              <span className="text-zinc-700 mx-0.5">·</span>
              <span className="text-zinc-600">Show:</span>
              {[[0, 'All'], [50, '50'], [100, '100']].map(([v, l]) => (
                <button key={v} onClick={() => setLimitCount(v)} className={`rounded-md px-2 py-0.5 transition cursor-pointer ${limitCount === v ? 'bg-rose-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-white'}`}>{l}</button>
              ))}
              <span className="ml-auto text-zinc-500">{filteredItems.length} shown{selectedIds.length > 0 ? ` · ${selectedIds.length} selected` : ''}</span>
            </div>
            {/* Action buttons */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <button onClick={selectAll} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-[0.6875rem] text-zinc-400 hover:text-white transition cursor-pointer">All</button>
                <button onClick={selectNone} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-[0.6875rem] text-zinc-400 hover:text-white transition cursor-pointer">None</button>
                <button
                  onClick={() => {
                    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
                    const recentIds = filteredItems.filter((it) => it.createdAt >= fiveMinAgo).map((it) => it.id);
                    setSelectedIds(recentIds);
                    if (recentIds.length) notify(`Selected ${recentIds.length} frame${recentIds.length === 1 ? '' : 's'} from last 5 min`, 'info');
                    else notify('No frames from the last 5 minutes', 'info');
                  }}
                  className="rounded-lg border border-rose-800/50 bg-rose-950/30 px-2 py-1 text-[0.6875rem] text-rose-300 hover:text-rose-200 hover:border-rose-500/60 transition cursor-pointer"
                >Last 5 min</button>
                {selectedIds.length > 0 && (
                  <button onClick={deleteSelected} className="rounded-lg border border-red-900/40 bg-red-950/20 px-2 py-1 text-[0.6875rem] text-red-400 hover:text-red-300 hover:border-red-500/60 transition cursor-pointer">
                    Delete ({selectedIds.length})
                  </button>
                )}
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={() => sendSelected('photo')}
                  disabled={selectedIds.length === 0}
                  className="rounded-lg border border-rose-700/60 bg-rose-950/50 px-2.5 py-1 text-[0.6875rem] font-semibold text-rose-300 hover:text-rose-100 hover:border-rose-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  → Photo Match
                </button>
                <button
                  onClick={() => sendSelected('poseFix')}
                  disabled={selectedIds.length === 0}
                  className="rounded-lg border border-pink-700/60 bg-pink-950/50 px-2.5 py-1 text-[0.6875rem] font-semibold text-pink-300 hover:text-pink-100 hover:border-pink-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  → Pose Remix
                </button>
                <button
                  onClick={() => sendSelected('scene')}
                  disabled={selectedIds.length === 0}
                  className="rounded-lg border border-rose-700/60 bg-rose-950/50 px-2.5 py-1 text-[0.6875rem] font-semibold text-rose-300 hover:text-rose-100 hover:border-rose-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  → Scene Recreate
                </button>
                <button
                  onClick={() => sendSelected('outfitSwap')}
                  disabled={selectedIds.length === 0}
                  title="Send as Target Person — queues one outfit swap per selected frame"
                  className="rounded-lg border border-fuchsia-700/60 bg-fuchsia-950/50 px-2.5 py-1 text-[0.6875rem] font-semibold text-fuchsia-300 hover:text-fuchsia-100 hover:border-fuchsia-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  → Outfit Swap
                </button>
                <button
                  onClick={() => sendSelected('outfitSwapSeedream')}
                  disabled={selectedIds.length === 0}
                  title="Send to Outfit Swap · Seedream — 1st frame becomes the Person, 2nd the Outfit"
                  className="rounded-lg border border-fuchsia-700/60 bg-fuchsia-950/50 px-2.5 py-1 text-[0.6875rem] font-semibold text-fuchsia-300 hover:text-fuchsia-100 hover:border-fuchsia-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  → Swap · Seedream
                </button>
                <button
                  onClick={downloadSelected}
                  disabled={selectedIds.length === 0}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-[0.6875rem] text-zinc-400 hover:text-white transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  title="Download Selected"
                >
                  ↓ Download Selected
                </button>
              </div>
            </div>


            {/* Right-click context menu */}
            {folderMenu && (
              <div ref={folderMenuRef} className="fixed bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl z-50 min-w-[160px] py-1 overflow-hidden" style={{ top: folderMenu.y, left: Math.min(folderMenu.x, window.innerWidth - 180) }}>
                <div className="px-3 py-1.5 text-[0.625rem] font-semibold text-zinc-500 uppercase tracking-wider border-b border-zinc-800">Add to folder</div>
                {collections.length === 0 && <div className="px-3 py-2 text-[0.6875rem] text-zinc-500">No folders yet — create one above</div>}
                {collections.map((col) => {
                  const inCol = col.frameIds?.includes(folderMenu.frameId);
                  return (
                    <button key={col.id} onClick={() => inCol ? handleRemoveFromFolder(col.id, folderMenu.frameId) : handleAddToFolder(col.id, [folderMenu.frameId])} className="flex items-center gap-2 w-full px-3 py-1.5 text-[0.6875rem] text-zinc-300 hover:bg-zinc-800 transition cursor-pointer">
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: col.color }} />
                      <span className="flex-1 text-left">{col.name}</span>
                      {inCol && <span className="text-emerald-400 text-[0.625rem]">✓</span>}
                    </button>
                  );
                })}
                <div className="border-t border-zinc-800 mt-1">
                  <button onClick={() => { setShowNewFolder(true); setFolderMenu(null); }} className="flex items-center gap-2 w-full px-3 py-1.5 text-[0.6875rem] text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition cursor-pointer">+ New Folder</button>
                </div>
              </div>
            )}

            {/* Grid */}
            <div className="grid grid-cols-4 gap-1.5">
              {filteredItems.map((item, idx) => {
                const isSelected = selectedIds.includes(item.id);
                const isPreviewing = previewIdx === idx;
                return (
                  <div
                    key={item.id}
                    data-library-item-id={item.id}
                    onClick={() => setPreviewIdx(idx === previewIdx ? null : idx)}
                    draggable="true"
                    onDragStart={(e) => handleDragStart(e, item, idx)}
                    onContextMenu={(e) => { e.preventDefault(); setFolderMenu({ frameId: item.id, x: e.clientX, y: e.clientY }); }}
                    className={`relative aspect-[9/16] overflow-hidden rounded-xl border-2 cursor-pointer transition-all duration-150 group ${
                      isPreviewing ? 'border-pink-500 ring-2 ring-pink-500/40' :
                      isSelected ? 'border-rose-500 ring-1 ring-rose-500/40' :
                      'border-zinc-800 hover:border-zinc-600'
                    }`}
                  >
                    <img
                      src={item.dataUrl}
                      alt={item.name}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                    
                    {/* Checkbox */}
                    <div
                      onClick={(e) => { e.stopPropagation(); toggleItem(item.id); }}
                      className={`absolute top-1.5 left-1.5 w-4.5 h-4.5 rounded-full border flex items-center justify-center transition cursor-pointer ${
                        isSelected ? 'bg-rose-500 border-rose-500 text-white' : 'bg-black/50 border-zinc-500 hover:border-white'
                      }`}
                    >
                      {isSelected && <IconCheck size={9} />}
                    </div>

                    {/* Source label */}
                    <div className="absolute bottom-1 left-1 max-w-[90%] truncate rounded bg-black/70 px-1 py-0.5 text-[0.5rem] font-mono text-zinc-400">
                      {item.source}
                    </div>

                    {/* Failed / Used badge (Failed takes precedence) */}
                    {isFailed(item) ? (
                      <div className="absolute bottom-1 right-1 rounded bg-red-600/90 px-1 py-0.5 text-[0.5rem] font-semibold text-white" title="Generation gave up after 5 tries — re-send to retry">
                        ✗ Failed
                      </div>
                    ) : isUsed(item) && (
                      <div className="absolute bottom-1 right-1 rounded bg-emerald-600/90 px-1 py-0.5 text-[0.5rem] font-semibold text-white" title={`Used in ${(item.usage || []).join(', ')}`}>
                        ✓ Used
                      </div>
                    )}

                    {/* Delete button on hover */}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeItem(item.id); }}
                      className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-black/60 text-zinc-400 hover:text-red-400 hover:bg-black/90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition cursor-pointer"
                      title="Delete Frame"
                    >
                      ×
                    </button>

                    {/* Folder dots — which collections this frame belongs to */}
                    {(() => {
                      const dots = collections.filter((c) => c.frameIds?.includes(item.id));
                      return dots.length > 0 ? (
                        <div className="absolute bottom-6 right-1 flex gap-0.5">
                          {dots.slice(0, 4).map((c) => (
                            <span key={c.id} className="w-2 h-2 rounded-full border border-black/40" style={{ background: c.color }} title={c.name} />
                          ))}
                        </div>
                      ) : null;
                    })()}
                  </div>
                );
              })}
            </div>

            <div className="pt-2 text-right">
              <button onClick={clearAll} className="text-[0.625rem] text-zinc-600 hover:text-red-400/80 transition cursor-pointer">
                Clear entire library
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center border border-zinc-800/60 rounded-2xl bg-zinc-900/10">
            <div className="w-12 h-12 rounded-xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center mb-4">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-600">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </div>
            <p className="text-xs text-zinc-500 font-medium">Your Frame Library is empty</p>
            <p className="text-[0.6875rem] text-zinc-600 mt-1">Grab frames from Instagram or import images here</p>
          </div>
        )}
      </div>

      {/* ── Right column: frame detail preview ──────────────────────────── */}
      <div className="flex-1 min-w-0">
        {previewItem ? (
          <div className="sticky top-6 flex flex-col gap-4 max-h-[calc(100vh-140px)]">
            {/* Top bar */}
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-xs text-zinc-300 font-semibold truncate max-w-[200px]">
                  {previewItem.name}
                </span>
                <span className="text-[0.625rem] text-zinc-500">
                  Added {new Date(previewItem.createdAt).toLocaleString()}
                </span>
                {previewItem.source && (
                  <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                    <a
                      href={previewItem.source}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-[0.625rem] text-rose-400/80 hover:text-rose-300 max-w-[180px]"
                      title={previewItem.source}
                    >
                      {previewItem.source}
                    </a>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(previewItem.source);
                        notify?.('Link copied!', 'success');
                      }}
                      title="Copy source link"
                      className="shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium bg-zinc-800/80 text-zinc-400 hover:text-rose-300 border border-zinc-700/50 transition cursor-pointer"
                    >
                      📋
                    </button>
                  </div>
                )}
              </div>
              
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggleItem(previewItem.id)}
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition cursor-pointer ${
                    previewIsSelected ? 'bg-rose-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                  }`}
                >
                  {previewIsSelected ? <><IconCheck size={11} /> Selected</> : 'Select'}
                </button>
                <button
                  onClick={() => setPreviewIdx(null)}
                  className="rounded-lg bg-zinc-800/80 p-1.5 text-zinc-400 hover:text-white transition cursor-pointer"
                >
                  <IconClose size={14} />
                </button>
              </div>
            </div>

            {/* Image + nav arrows */}
            <div className="flex items-center gap-3 flex-1 min-h-0">
              <button
                onClick={() => previewIdx > 0 && setPreviewIdx(previewIdx - 1)}
                disabled={previewIdx === 0}
                className="rounded-xl bg-zinc-800/80 p-2 text-zinc-300 hover:text-white disabled:opacity-20 transition cursor-pointer shrink-0"
              >
                &larr;
              </button>
              {/* nav uses filteredItems length */}

              <div className="flex-1 flex justify-center min-h-0">
                <img
                  src={previewItem.dataUrl}
                  alt={previewItem.name}
                  className="max-h-[calc(100vh-280px)] max-w-full rounded-2xl object-contain shadow-2xl"
                  style={{ border: previewIsSelected ? '2px solid #ec4899' : '2px solid transparent' }}
                />
              </div>

              <button
                onClick={() => previewIdx < filteredItems.length - 1 && setPreviewIdx(previewIdx + 1)}
                disabled={previewIdx === filteredItems.length - 1}
                className="rounded-xl bg-zinc-800/80 p-2 text-zinc-300 hover:text-white disabled:opacity-20 transition cursor-pointer shrink-0"
              >
                &rarr;
              </button>
            </div>

            {/* Action buttons */}
            <div className="flex items-center justify-center gap-3 flex-wrap">
              <button
                onClick={() => sendOne(previewItem, 'photo')}
                className="rounded-lg border border-rose-700/60 bg-rose-950/60 px-4 py-2 text-xs font-semibold text-rose-300 hover:text-rose-100 hover:border-rose-500 transition cursor-pointer"
              >
                &rarr; Photo Match
              </button>
              <button
                onClick={() => sendOne(previewItem, 'poseFix')}
                className="rounded-lg border border-pink-700/60 bg-pink-950/60 px-4 py-2 text-xs font-semibold text-pink-300 hover:text-pink-100 hover:border-pink-500 transition cursor-pointer"
              >
                &rarr; Pose Remix
              </button>
              <button
                onClick={() => sendOne(previewItem, 'scene')}
                className="rounded-lg border border-rose-700/60 bg-rose-950/60 px-4 py-2 text-xs font-semibold text-rose-300 hover:text-rose-100 hover:border-rose-500 transition cursor-pointer"
              >
                &rarr; Scene Recreate
              </button>
              <button
                onClick={() => sendOne(previewItem, 'outfitSwap')}
                className="rounded-lg border border-fuchsia-700/60 bg-fuchsia-950/60 px-4 py-2 text-xs font-semibold text-fuchsia-300 hover:text-fuchsia-100 hover:border-fuchsia-500 transition cursor-pointer"
              >
                &rarr; Outfit Swap
              </button>
              <button
                onClick={() => sendOne(previewItem, 'outfitSwapSeedream')}
                title="Send to Outfit Swap · Seedream (fills the Person slot)"
                className="rounded-lg border border-fuchsia-700/60 bg-fuchsia-950/60 px-4 py-2 text-xs font-semibold text-fuchsia-300 hover:text-fuchsia-100 hover:border-fuchsia-500 transition cursor-pointer"
              >
                &rarr; Swap · Seedream
              </button>
              <button
                onClick={async () => {
                  const blob = await (await fetch(previewItem.dataUrl)).blob();
                  await downloadBlob(blob, previewItem.name.includes('.') ? previewItem.name : `${previewItem.name}.jpg`);
                }}
                className="rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-4 py-2 text-xs text-zinc-300 hover:text-white transition cursor-pointer"
              >
                &darr; Download
              </button>
              {previewItem.source && (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(previewItem.source);
                    notify?.('Link copied!', 'success');
                  }}
                  className="rounded-lg border border-cyan-700/60 bg-cyan-950/60 px-4 py-2 text-xs font-semibold text-cyan-300 hover:text-cyan-100 hover:border-cyan-500 transition cursor-pointer"
                >
                  📋 Copy Link
                </button>
              )}
              <button
                onClick={() => removeItem(previewItem.id)}
                className="rounded-lg border border-red-900/40 bg-red-950/40 px-4 py-2 text-xs text-red-400 hover:text-red-300 hover:border-red-500/50 transition cursor-pointer"
              >
                Delete Frame
              </button>
            </div>
            
            {previewItem.usage && previewItem.usage.length > 0 && (
              <div className="flex justify-center gap-1.5 flex-wrap">
                {previewItem.usage.map((lbl) => (
                  <Badge key={lbl} color="blue">Used in {lbl}</Badge>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
            <div className="w-16 h-16 rounded-2xl bg-zinc-900/80 border border-zinc-800/60 flex items-center justify-center mb-4">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-700">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </div>
            <p className="text-xs text-zinc-600 font-medium">Click any frame to inspect details</p>
            <p className="text-[0.6875rem] text-zinc-700 mt-1">Use arrow keys to navigate, Space to select, Esc to close</p>
          </div>
        )}
      </div>
      {isDragSelecting && dragBox && (
        <div
          className="fixed border border-rose-500 bg-rose-500/10 rounded pointer-events-none z-[9999]"
          style={{
            left: Math.min(dragBox.startX, dragBox.currentX),
            top: Math.min(dragBox.startY, dragBox.currentY),
            width: Math.abs(dragBox.startX - dragBox.currentX),
            height: Math.abs(dragBox.startY - dragBox.currentY),
          }}
        />
      )}
      </div>{/* end flex gap-6 inner row */}
    </div>
  );
}
