import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Btn, Card, Empty } from '../components/UI';
import { useApp } from '../context/AppContext';

const FRAME_LIBRARY_STORAGE_KEY = 'kyros.frameLibrary.items';
const PHOTO_MATCH_SOURCE_STORAGE_KEY = 'kyros.photoMatch.sources';
const SCENE_RECREATE_SOURCE_STORAGE_KEY = 'kyros.sceneRecreate.sources';

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
  const [items, setItems] = useState(() => readStoredItems());
  const [selectedIds, setSelectedIds] = useState([]);
  const [previewIdx, setPreviewIdx] = useState(null); // index in items
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);
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

  // Save to localStorage whenever items changes
  useEffect(() => {
    writeStoredItems(items);
  }, [items]);

  // Keyboard navigation for preview
  useEffect(() => {
    if (previewIdx === null) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setPreviewIdx(null);
      if (e.key === 'ArrowLeft' && previewIdx > 0) setPreviewIdx(previewIdx - 1);
      if (e.key === 'ArrowRight' && previewIdx < items.length - 1) setPreviewIdx(previewIdx + 1);
      if (e.key === ' ') { e.preventDefault(); toggleItem(items[previewIdx].id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewIdx, items]);

  const selectedItems = useMemo(() => items.filter((item) => selectedIds.includes(item.id)), [items, selectedIds]);

  const toggleItem = (id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const selectAll = () => {
    setSelectedIds(items.map(item => item.id));
  };

  const selectNone = () => {
    setSelectedIds([]);
  };

  const addFiles = async (incoming) => {
    const valid = [...incoming].filter((file) => file.type.startsWith('image/'));
    if (valid.length === 0) {
      notify('Only image files are supported', 'error');
      return;
    }
    const next = await Promise.all(
      valid.map(async (file) => ({
        ...makeItem(file, 'Upload'),
        dataUrl: await fileToDataUrl(file),
      }))
    );
    setItems((prev) => [...next, ...prev].slice(0, 500));
    notify(`${next.length} frame${next.length === 1 ? '' : 's'} imported to library`, 'success');
  };

  const removeItem = (id) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    setSelectedIds((prev) => prev.filter((itemId) => itemId !== id));
    if (previewIdx !== null) {
      // Adjust preview index if necessary
      const activeItem = items[previewIdx];
      if (activeItem && activeItem.id === id) {
        setPreviewIdx(null);
      } else {
        const newIdx = items.filter((item) => item.id !== id).findIndex(item => item.id === activeItem.id);
        setPreviewIdx(newIdx !== -1 ? newIdx : null);
      }
    }
  };

  const deleteSelected = () => {
    if (selectedIds.length === 0) return;
    setItems((prev) => prev.filter((item) => !selectedIds.includes(item.id)));
    setSelectedIds([]);
    setPreviewIdx(null);
    notify('Selected frames deleted', 'success');
  };

  const clearAll = () => {
    if (window.confirm('Are you sure you want to clear your entire frame library?')) {
      setItems([]);
      setSelectedIds([]);
      setPreviewIdx(null);
      notify('Library cleared', 'success');
    }
  };

  const downloadSelected = () => {
    if (selectedItems.length === 0) return;
    selectedItems.forEach((item, index) => {
      const a = document.createElement('a');
      a.href = item.dataUrl;
      a.download = item.name.includes('.') ? item.name : `${item.name}.jpg`;
      // Stagger downloads to prevent browser blocking
      setTimeout(() => a.click(), index * 100);
    });
  };

  const sendSelected = (features) => {
    if (selectedItems.length === 0) {
      notify('Select at least one frame', 'error');
      return;
    }
    const featureList = Array.isArray(features) ? features : [features];
    const targets = featureList.flatMap((feature) =>
      feature === 'scene'
        ? [{ eventName: 'kyros:use-as-scene-source', label: 'Scene Recreate', storageKey: SCENE_RECREATE_SOURCE_STORAGE_KEY, page: 'scene' }]
        : [{ eventName: 'kyros:use-as-photo-match-source', label: 'Photo Match', storageKey: PHOTO_MATCH_SOURCE_STORAGE_KEY, page: 'photoMatch' }]
    );

    const payload = selectedItems.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      size: item.size,
      createdAt: item.createdAt,
      source: item.source,
      dataUrl: item.dataUrl,
      usage: item.usage || [],
    }));

    for (const target of targets) {
      try {
        window.localStorage.setItem(target.storageKey, JSON.stringify(payload));
      } catch {
        // Ignore persistence failures
      }
      window.dispatchEvent(new CustomEvent(target.eventName, { detail: { items: selectedItems } }));
    }

    const targetLabel = targets.map((entry) => entry.label).join(' + ');
    const sentAt = Date.now();
    setItems((prev) =>
      prev.map((item) =>
        selectedIds.includes(item.id)
          ? { ...item, usage: [...new Set([...(item.usage || []), ...targets.map((entry) => entry.label)])], lastUsedAt: sentAt }
          : item
      )
    );

    if (targets.length === 1) navigateTo(targets[0].page);
    else navigateTo('photoMatch');

    notify(`Sent ${selectedItems.length} frame${selectedItems.length === 1 ? '' : 's'} to ${targetLabel} ⚡`, 'success');
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
  };

  const previewItem = previewIdx !== null ? items[previewIdx] : null;
  const previewIsSelected = previewItem ? selectedIds.includes(previewItem.id) : false;

  return (
    <div className="flex gap-6 animate-in h-full min-h-0">
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
              <div className="text-xs font-medium text-zinc-300">Drop images here or click to import frames</div>
              <div className="mt-0.5 text-[10px] text-zinc-500">Supports PNG, JPEG, WEBP</div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => { addFiles(e.target.files || []); e.target.value = ''; }}
            />
          </div>
        </div>

        {/* Toolbar & Grid */}
        {items.length > 0 ? (
          <div className="space-y-3">
            {/* Action buttons */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <button onClick={selectAll} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-400 hover:text-white transition cursor-pointer">All</button>
                <button onClick={selectNone} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-400 hover:text-white transition cursor-pointer">None</button>
                {selectedIds.length > 0 && (
                  <button onClick={deleteSelected} className="rounded-lg border border-red-900/40 bg-red-950/20 px-2 py-1 text-[11px] text-red-400 hover:text-red-300 hover:border-red-500/60 transition cursor-pointer">
                    Delete ({selectedIds.length})
                  </button>
                )}
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={() => sendSelected('photo')}
                  disabled={selectedIds.length === 0}
                  className="rounded-lg border border-blue-700/60 bg-blue-950/50 px-2.5 py-1 text-[11px] font-semibold text-blue-300 hover:text-blue-100 hover:border-blue-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  → Photo Match
                </button>
                <button
                  onClick={() => sendSelected('scene')}
                  disabled={selectedIds.length === 0}
                  className="rounded-lg border border-purple-700/60 bg-purple-950/50 px-2.5 py-1 text-[11px] font-semibold text-purple-300 hover:text-purple-100 hover:border-purple-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  → Scene
                </button>
                <button
                  onClick={downloadSelected}
                  disabled={selectedIds.length === 0}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-400 hover:text-white transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  title="Download Selected"
                >
                  ↓ Download Selected
                </button>
              </div>
            </div>

            {/* Grid */}
            <div className="grid grid-cols-4 gap-1.5">
              {items.map((item, idx) => {
                const isSelected = selectedIds.includes(item.id);
                const isPreviewing = previewIdx === idx;
                return (
                  <div
                    key={item.id}
                    data-library-item-id={item.id}
                    onClick={() => setPreviewIdx(idx === previewIdx ? null : idx)}
                    draggable="true"
                    onDragStart={(e) => handleDragStart(e, item, idx)}
                    className={`relative aspect-[9/16] overflow-hidden rounded-xl border-2 cursor-pointer transition-all duration-150 group ${
                      isPreviewing ? 'border-pink-500 ring-2 ring-pink-500/40' :
                      isSelected ? 'border-blue-500 ring-1 ring-blue-500/40' :
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
                        isSelected ? 'bg-blue-500 border-blue-500 text-white' : 'bg-black/50 border-zinc-500 hover:border-white'
                      }`}
                    >
                      {isSelected && <IconCheck size={9} />}
                    </div>

                    {/* Source label */}
                    <div className="absolute bottom-1 left-1 max-w-[90%] truncate rounded bg-black/70 px-1 py-0.5 text-[8px] font-mono text-zinc-400">
                      {item.source}
                    </div>

                    {/* Delete button on hover */}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeItem(item.id); }}
                      className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-black/60 text-zinc-400 hover:text-red-400 hover:bg-black/90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition cursor-pointer"
                      title="Delete Frame"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="pt-2 text-right">
              <button onClick={clearAll} className="text-[10px] text-zinc-600 hover:text-red-400/80 transition cursor-pointer">
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
            <p className="text-[11px] text-zinc-600 mt-1">Grab frames from Instagram or import images here</p>
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
                <span className="text-[10px] text-zinc-500">
                  Added {new Date(previewItem.createdAt).toLocaleString()} · Source: {previewItem.source}
                </span>
              </div>
              
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggleItem(previewItem.id)}
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition cursor-pointer ${
                    previewIsSelected ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
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

              <div className="flex-1 flex justify-center min-h-0">
                <img
                  src={previewItem.dataUrl}
                  alt={previewItem.name}
                  className="max-h-[calc(100vh-280px)] max-w-full rounded-2xl object-contain shadow-2xl"
                  style={{ border: previewIsSelected ? '2px solid #3b82f6' : '2px solid transparent' }}
                />
              </div>

              <button
                onClick={() => previewIdx < items.length - 1 && setPreviewIdx(previewIdx + 1)}
                disabled={previewIdx === items.length - 1}
                className="rounded-xl bg-zinc-800/80 p-2 text-zinc-300 hover:text-white disabled:opacity-20 transition cursor-pointer shrink-0"
              >
                &rarr;
              </button>
            </div>

            {/* Action buttons */}
            <div className="flex items-center justify-center gap-3 flex-wrap">
              <button
                onClick={() => {
                  const payload = [{
                    id: previewItem.id,
                    name: previewItem.name,
                    type: previewItem.type,
                    size: previewItem.size,
                    dataUrl: previewItem.dataUrl,
                  }];
                  try { window.localStorage.setItem(PHOTO_MATCH_SOURCE_STORAGE_KEY, JSON.stringify(payload)); } catch {}
                  navigateTo('photoMatch');
                  setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('kyros:use-as-photo-match-source', { detail: { items: [{ dataUrl: previewItem.dataUrl, name: previewItem.name }] } }));
                  }, 300);
                  notify('Frame sent to Photo Match ⚡', 'success');
                }}
                className="rounded-lg border border-blue-700/60 bg-blue-950/60 px-4 py-2 text-xs font-semibold text-blue-300 hover:text-blue-100 hover:border-blue-500 transition cursor-pointer"
              >
                &rarr; Photo Match
              </button>
              <button
                onClick={() => {
                  const payload = [{
                    id: previewItem.id,
                    name: previewItem.name,
                    type: previewItem.type,
                    size: previewItem.size,
                    dataUrl: previewItem.dataUrl,
                  }];
                  try { window.localStorage.setItem(SCENE_RECREATE_SOURCE_STORAGE_KEY, JSON.stringify(payload)); } catch {}
                  navigateTo('scene');
                  setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('kyros:use-as-scene-source', { detail: { items: [{ dataUrl: previewItem.dataUrl, name: previewItem.name }] } }));
                  }, 300);
                  notify('Frame sent to Scene Recreate ⚡', 'success');
                }}
                className="rounded-lg border border-purple-700/60 bg-purple-950/60 px-4 py-2 text-xs font-semibold text-purple-300 hover:text-purple-100 hover:border-purple-500 transition cursor-pointer"
              >
                &rarr; Scene Recreate
              </button>
              <button
                onClick={() => {
                  const a = document.createElement('a');
                  a.href = previewItem.dataUrl;
                  a.download = previewItem.name.includes('.') ? previewItem.name : `${previewItem.name}.jpg`;
                  a.click();
                }}
                className="rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-4 py-2 text-xs text-zinc-300 hover:text-white transition cursor-pointer"
              >
                &darr; Download
              </button>
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
            <p className="text-[11px] text-zinc-700 mt-1">Use arrow keys to navigate, Space to select, Esc to close</p>
          </div>
        )}
      </div>
      {isDragSelecting && dragBox && (
        <div
          className="fixed border border-blue-500 bg-blue-500/10 rounded pointer-events-none z-[9999]"
          style={{
            left: Math.min(dragBox.startX, dragBox.currentX),
            top: Math.min(dragBox.startY, dragBox.currentY),
            width: Math.abs(dragBox.startX - dragBox.currentX),
            height: Math.abs(dragBox.startY - dragBox.currentY),
          }}
        />
      )}
    </div>
  );
}
