import { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense } from 'react';
import { gallery as galleryApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { cn } from '../lib/utils';
import { Card, Btn, Spinner, Empty, Badge } from '../components/UI';

const ImageEditor = lazy(() => import('../components/ImageEditor'));

import { EDITOR_PRESETS, loadCustomPresets } from '../lib/editorPresets';

export default function ImageEditorPage() {
  const { notify, consumePageParams } = useApp();
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const [isDraggingImport, setIsDraggingImport] = useState(false);
  const importInputRef = useRef(null);

  // Batch edit
  const [batchMode, setBatchMode] = useState(false);
  const [batchSelected, setBatchSelected] = useState(() => new Set());
  const [batchPreset, setBatchPreset] = useState(null);
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ done: 0, total: 0 });

  useEffect(() => {
    const params = consumePageParams();
    if (params?.editId) setSelectedId(params.editId);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await galleryApi.list();
      setImages(res.images || res || []);
    } catch {
      notify('Failed to load gallery', 'error');
    }
    setLoading(false);
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    let result = images;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((i) => i.prompt?.toLowerCase().includes(q) || i.source?.toLowerCase().includes(q));
    }
    return result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [images, searchQuery]);

  const toggleBatchItem = useCallback((id) => {
    setBatchSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const allPresets = useMemo(() => [...EDITOR_PRESETS, ...loadCustomPresets()], []);

  const importFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []).filter((file) => file.type?.startsWith('image/'));
    if (files.length === 0) {
      notify('Drop or choose PNG, JPEG, or WebP images', 'error');
      return;
    }
    setImporting(true);
    try {
      const uploaded = [];
      for (const file of files) {
        const entry = await galleryApi.upload(file, {
          prompt: file.name || 'Computer upload',
          source: 'upload',
        });
        if (entry?.id) uploaded.push(entry);
      }
      await load();
      if (uploaded[0]?.id) setSelectedId(uploaded[0].id);
      notify(files.length === 1 ? 'Image imported into editor' : `${uploaded.length} images imported`, 'success');
    } catch (err) {
      notify(err?.message || 'Failed to import image', 'error');
    } finally {
      setImporting(false);
    }
  }, [load, notify]);

  const handleBatchApply = useCallback(async () => {
    if (!batchPreset || batchSelected.size === 0) return;
    setBatchProcessing(true);
    const ids = [...batchSelected];
    setBatchProgress({ done: 0, total: ids.length });

    let success = 0;
    for (const id of ids) {
      try {
        await galleryApi.saveEdit(id, batchPreset.values);
        success++;
        setBatchProgress((p) => ({ ...p, done: p.done + 1 }));
      } catch { /* continue with next */ }
    }

    notify(`Applied "${batchPreset.name}" to ${success}/${ids.length} images`, 'success');
    setBatchProcessing(false);
    setBatchSelected(new Set());
    setBatchPreset(null);
    load();
  }, [batchPreset, batchSelected, load, notify]);

  if (selectedId) {
    return (
      <Suspense fallback={<div className="flex items-center justify-center py-24"><Spinner size={32} /></div>}>
        <ImageEditor
          imageId={selectedId}
          imageUrl={galleryApi.imageUrl(selectedId)}
          onClose={() => setSelectedId(null)}
          onSaved={() => {
            load();
            setSelectedId(null);
            notify('Edited image saved to gallery', 'success');
          }}
        />
      </Suspense>
    );
  }

  return (
    <div className="space-y-4 animate-in">
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
            {batchMode ? 'Batch Edit' : 'Select an image to edit'}
          </h3>
          <div className="flex items-center gap-2">
            <Btn
              variant={batchMode ? 'primary' : 'secondary'}
              className="!py-1.5 !px-3 !text-xs"
              onClick={() => { setBatchMode(!batchMode); setBatchSelected(new Set()); setBatchPreset(null); }}
            >
              {batchMode ? 'Exit Batch' : 'Batch Edit'}
            </Btn>
          </div>
        </div>

        <input
          type="text"
          placeholder="Search by prompt or source..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full h-9 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 text-sm text-zinc-200 placeholder:text-zinc-500 outline-none focus:border-blue-500/70 focus:ring-2 focus:ring-blue-500/20"
        />

        <div
          onDragOver={(event) => { event.preventDefault(); setIsDraggingImport(true); }}
          onDragLeave={() => setIsDraggingImport(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDraggingImport(false);
            importFiles(event.dataTransfer?.files);
          }}
          className={cn(
            'rounded-lg border border-dashed px-3 py-3 transition-colors',
            isDraggingImport
              ? 'border-blue-400 bg-blue-500/10'
              : 'border-zinc-700/70 bg-zinc-950/35 hover:border-zinc-500',
          )}
        >
          <input
            ref={importInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            onChange={(event) => {
              importFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-zinc-200">Add images from computer</div>
              <div className="text-xs text-zinc-500">Drag here or choose files. Imported images open in the editor.</div>
            </div>
            <Btn
              variant="secondary"
              onClick={() => importInputRef.current?.click()}
              disabled={importing}
              className="!py-1.5 !px-3 !text-xs shrink-0"
            >
              {importing ? <><Spinner size={14} /> Importing</> : 'Choose'}
            </Btn>
          </div>
        </div>

        {/* Batch controls */}
        {batchMode && (
          <div className="flex items-center gap-3 flex-wrap pt-1">
            <span className="text-xs text-zinc-500">{batchSelected.size} selected</span>
            {batchSelected.size > 0 && (
              <>
                <select
                  value={batchPreset?.name || ''}
                  onChange={(e) => {
                    const p = allPresets.find((p) => p.name === e.target.value);
                    setBatchPreset(p || null);
                  }}
                  className="h-8 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-2 text-sm text-zinc-300 outline-none cursor-pointer"
                >
                  <option value="">Choose preset...</option>
                  {allPresets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
                <Btn
                  onClick={handleBatchApply}
                  disabled={!batchPreset || batchProcessing}
                  className="!py-1.5 !px-3 !text-xs"
                >
                  {batchProcessing
                    ? <><Spinner size={14} /> {batchProgress.done}/{batchProgress.total}</>
                    : `Apply to ${batchSelected.size}`}
                </Btn>
                <button
                  onClick={() => setBatchSelected(new Set(filtered.map((i) => i.id)))}
                  className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
                >
                  Select all
                </button>
                <button
                  onClick={() => setBatchSelected(new Set())}
                  className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
                >
                  Clear
                </button>
              </>
            )}
          </div>
        )}
      </Card>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Spinner size={28} /></div>
      ) : filtered.length === 0 ? (
        <Empty title="No images" subtitle={searchQuery ? 'No images match your search' : 'Generate some images first'} />
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
          {filtered.map((img) => {
            const isSelected = batchSelected.has(img.id);
            return (
              <button
                key={img.id}
                onClick={() => batchMode ? toggleBatchItem(img.id) : setSelectedId(img.id)}
                className={cn(
                  'group relative rounded-lg overflow-hidden border transition cursor-pointer bg-zinc-900',
                  batchMode && isSelected
                    ? 'border-blue-500 ring-2 ring-blue-500/30'
                    : 'border-zinc-700/50 hover:border-blue-500/50',
                )}
              >
                <img
                  src={galleryApi.thumbUrl(img.id)}
                  alt={img.prompt?.slice(0, 50) || 'Image'}
                  className="w-full aspect-square object-cover group-hover:scale-105 transition-transform duration-200"
                  loading="lazy"
                />
                {batchMode && (
                  <div className={cn(
                    'absolute top-1.5 left-1.5 w-5 h-5 rounded border-2 flex items-center justify-center text-[10px] transition',
                    isSelected
                      ? 'border-blue-500 bg-blue-500 text-white'
                      : 'border-zinc-400 bg-black/50 text-transparent',
                  )}>
                    {isSelected && '✓'}
                  </div>
                )}
                {!batchMode && (
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-1.5">
                    <span className="text-[9px] text-zinc-300 truncate w-full">{img.source || 'image'}</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
