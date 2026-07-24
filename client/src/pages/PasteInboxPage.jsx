import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Btn, Card, Empty } from '../components/UI';
import { useApp } from '../context/AppContext';
import {
  loadCollections, saveCollections, createCollection, deleteCollection,
  renameCollection, addFramesToCollection, removeFrameFromCollection,
  randomColor,
} from '../lib/collectionsStore';

const PASTE_INBOX_STORAGE_KEY = 'kyros.pasteInbox.items';
const PHOTO_MATCH_SOURCE_STORAGE_KEY = 'kyros.photoMatch.sources';
const SCENE_RECREATE_SOURCE_STORAGE_KEY = 'kyros.sceneRecreate.sources';

// ── IndexedDB helpers for image data (no size cap unlike localStorage) ───────
const IDB_NAME = 'kyros-paste-inbox';
const IDB_STORE = 'images';
let _idbPromise = null;

function openIdb() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
  return _idbPromise;
}

async function idbPut(id, dataUrl) {
  try {
    const db = await openIdb();
    return new Promise((res) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(dataUrl, id);
      tx.oncomplete = res;
    });
  } catch {}
}

async function idbGet(id) {
  try {
    const db = await openIdb();
    return new Promise((res) => {
      const req = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(id);
      req.onsuccess = () => res(req.result || '');
      req.onerror = () => res('');
    });
  } catch { return ''; }
}

async function idbDelete(id) {
  try {
    const db = await openIdb();
    return new Promise((res) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = res;
    });
  } catch {}
}

async function idbDeleteMany(ids) {
  for (const id of ids) await idbDelete(id);
}

// Metadata only (no dataUrl) in localStorage
function readStoredMeta() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PASTE_INBOX_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch { return []; }
}

function writeStoredMeta(items) {
  if (typeof window === 'undefined') return;
  try {
    // Strip dataUrl before saving to localStorage — it lives in IDB
    const stripped = items.map(({ dataUrl: _d, ...rest }) => rest);
    if (stripped.length === 0) { window.localStorage.removeItem(PASTE_INBOX_STORAGE_KEY); return; }
    window.localStorage.setItem(PASTE_INBOX_STORAGE_KEY, JSON.stringify(stripped));
  } catch {}
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function makeItem(file, source = 'paste') {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    name: file.name || 'pasted-image',
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

export default function PasteInboxPage() {
  const { notify, navigateTo } = useApp();
  // Load metadata from localStorage, then hydrate dataUrls from IDB
  const [items, setItems] = useState(() => readStoredMeta());

  const [selectedIds, setSelectedIds] = useState([]);
  const fileInputRef = useRef(null);

  // ── Collections ────────────────────────────────────────────────────────────
  const [collections, setCollections] = useState(() => loadCollections());
  const [activeCollection, setActiveCollection] = useState(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderColor, setNewFolderColor] = useState(() => randomColor());
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [renamingCol, setRenamingCol] = useState(null);
  const [folderMenu, setFolderMenu] = useState(null);
  const [droppingIntoCol, setDroppingIntoCol] = useState(null); // colId being dragged into
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

  const handleAddToFolder = (colId, itemIds) => {
    addFramesToCollection(colId, itemIds);
    refreshCollections();
    notify(`Added ${itemIds.length} image${itemIds.length === 1 ? '' : 's'} to folder`, 'success');
    setFolderMenu(null);
  };

  const handleRemoveFromFolder = (colId, itemId) => {
    removeFrameFromCollection(colId, itemId);
    refreshCollections();
    setFolderMenu(null);
  };

  useEffect(() => {
    if (!folderMenu) return;
    const handler = (e) => { if (folderMenuRef.current && !folderMenuRef.current.contains(e.target)) setFolderMenu(null); };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [folderMenu]);

  // ── Paste & storage ────────────────────────────────────────────────────────
  // Persist metadata to localStorage whenever items change (dataUrl stripped)
  useEffect(() => writeStoredMeta(items), [items]);

  // Hydrate dataUrls from IDB on first mount
  useEffect(() => {
    const meta = readStoredMeta();
    if (meta.length === 0) return;
    Promise.all(meta.map(async (item) => ({ ...item, dataUrl: await idbGet(item.id) })))
      .then((hydrated) => setItems(hydrated));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPaste = async (event) => {
      const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'));
      if (!item) return;
      event.preventDefault();
      const file = item.getAsFile();
      if (!file) return;
      const dataUrl = await fileToDataUrl(file);
      const newItem = { ...makeItem(file), dataUrl };
      await idbPut(newItem.id, dataUrl);
      setItems((prev) => [newItem, ...prev].slice(0, 500));
      notify('Pasted image saved to inbox', 'success');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [notify]);

  const filteredItems = useMemo(() => {
    if (!activeCollection) return items;
    const col = collections.find((c) => c.id === activeCollection);
    const ids = new Set(col?.frameIds || []);
    return items.filter((it) => ids.has(it.id));
  }, [items, activeCollection, collections]);

  const selectedItems = useMemo(() => filteredItems.filter((item) => selectedIds.includes(item.id)), [filteredItems, selectedIds]);

  const toggleItem = (id) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const addFiles = async (incoming, colId = activeCollection) => {
    const valid = [...incoming].filter((file) => file.type.startsWith('image/'));
    if (valid.length === 0) { notify('Only image files are supported', 'error'); return; }
    const next = await Promise.all(valid.map(async (file) => {
      const item = { ...makeItem(file, 'upload'), dataUrl: await fileToDataUrl(file) };
      await idbPut(item.id, item.dataUrl);
      return item;
    }));
    setItems((prev) => [...next, ...prev].slice(0, 500));
    // If dropped into a specific folder, auto-add them
    if (colId) {
      const newIds = next.map((it) => it.id);
      addFramesToCollection(colId, newIds);
      refreshCollections();
    }
    notify(`${next.length} image${next.length === 1 ? '' : 's'} saved to inbox${colId ? ' & folder' : ''}`, 'success');
  };

  const removeItem = (id) => {
    idbDelete(id);
    setItems((prev) => prev.filter((item) => item.id !== id));
    setSelectedIds((prev) => prev.filter((itemId) => itemId !== id));
  };

  const copyToInbox = (item) => {
    const copyId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const copyName = item.name.includes('.') ? `${item.name.replace(/\.[^.]+$/, '')} copy${item.name.match(/\.[^.]+$/)?.[0] || ''}` : `${item.name} copy`;
    setItems((prev) => [{ ...item, id: copyId, name: copyName, createdAt: Date.now(), usage: [], lastUsedAt: undefined }, ...prev]);
    notify('Image copied in inbox', 'success');
  };

  const copyImageToClipboard = async (item) => {
    try {
      const file = dataUrlToFile(item.dataUrl, item.name);
      if (!file || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Clipboard copy not supported');
      await navigator.clipboard.write([new ClipboardItem({ [file.type]: file })]);
      notify('Image copied to clipboard', 'success');
    } catch (err) { notify(err.message || 'Failed to copy image', 'error'); }
  };

  const clearAll = () => { idbDeleteMany(items.map(i => i.id)); setItems([]); setSelectedIds([]); };

  const sendSelected = (features) => {
    if (selectedItems.length === 0) { notify('Select at least one image', 'error'); return; }
    const featureList = Array.isArray(features) ? features : [features];
    const targets = featureList.flatMap((feature) => feature === 'scene'
      ? [{ eventName: 'kyros:use-as-scene-source', label: 'Scene Recreate', storageKey: SCENE_RECREATE_SOURCE_STORAGE_KEY, page: 'scene' }]
      : [{ eventName: 'kyros:use-as-photo-match-source', label: 'Photo Match', storageKey: PHOTO_MATCH_SOURCE_STORAGE_KEY, page: 'photoMatch' }]);
    const payload = selectedItems.map((item) => ({ id: item.id, name: item.name, type: item.type, size: item.size, createdAt: item.createdAt, source: item.source, dataUrl: item.dataUrl, usage: item.usage || [] }));
    for (const target of targets) {
      try { window.localStorage.setItem(target.storageKey, JSON.stringify(payload)); } catch {}
      window.dispatchEvent(new CustomEvent(target.eventName, { detail: { items: selectedItems } }));
    }
    const targetLabel = targets.map((entry) => entry.label).join(' + ');
    const sentAt = Date.now();
    setItems((prev) => prev.map((item) => selectedIds.includes(item.id) ? { ...item, usage: [...new Set([...(item.usage || []), ...targets.map((entry) => entry.label)])], lastUsedAt: sentAt } : item));
    if (targets.length === 1) navigateTo(targets[0].page);
    else navigateTo('photoMatch');
    notify(`Saved ${selectedItems.length} image${selectedItems.length === 1 ? '' : 's'} and opened ${targetLabel}`, 'success');
  };

  const COLORS = ['#a855f7','#ec4899','#3b82f6','#22c55e','#f59e0b','#ef4444','#06b6d4','#f97316'];

  return (
    <div className="space-y-4 animate-in">
      <div className="max-w-5xl space-y-4">

        {/* ── FOLDERS STRIP — always at top ─────────────────────────────────── */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setActiveCollection(null)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[0.6875rem] font-medium border transition cursor-pointer ${activeCollection === null ? 'bg-zinc-700 border-zinc-500 text-white' : 'bg-zinc-900/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}
          >
            📁 All images
          </button>

          {collections.map((col) => {
            const isActive = activeCollection === col.id;
            const count = col.frameIds?.filter(id => items.some(it => it.id === id)).length || 0;
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
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteFolder(col.id); }} className="w-4 h-4 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 hover:text-red-400 text-[0.625rem] flex items-center justify-center cursor-pointer" title="Delete folder">×</button>
                  </div>
                )}
              </div>
            );
          })}

          {showNewFolder ? (
            <form onSubmit={(e) => { e.preventDefault(); handleCreateFolder(); }} className="flex items-center gap-1">
              <div className="w-4 h-4 rounded-full cursor-pointer border-2 border-white/20 flex-shrink-0" style={{ background: newFolderColor }} onClick={() => setNewFolderColor(COLORS[(COLORS.indexOf(newFolderColor)+1)%COLORS.length])} title="Click to change colour" />
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

        {/* ── Per-folder drop zones ─────────────────────────────────────────── */}
        {collections.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {collections.map((col) => {
              const isDroppingHere = droppingIntoCol === col.id;
              const count = col.frameIds?.filter(id => items.some(it => it.id === id)).length || 0;
              return (
                <div
                  key={col.id}
                  onDragOver={(e) => { e.preventDefault(); setDroppingIntoCol(col.id); }}
                  onDragEnter={(e) => { e.preventDefault(); setDroppingIntoCol(col.id); }}
                  onDragLeave={() => setDroppingIntoCol(null)}
                  onDrop={(e) => { e.preventDefault(); setDroppingIntoCol(null); if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files, col.id); }}
                  onClick={() => setActiveCollection(activeCollection === col.id ? null : col.id)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl border-2 border-dashed cursor-pointer transition-all duration-150 min-w-[120px] ${
                    isDroppingHere
                      ? 'scale-[0.98] border-opacity-100'
                      : 'border-zinc-700/50 hover:border-zinc-500/70'
                  } ${activeCollection === col.id ? 'bg-zinc-800/60' : 'bg-zinc-900/40'}`}
                  style={isDroppingHere ? { borderColor: col.color, background: col.color + '18' } : activeCollection === col.id ? { borderColor: col.color + '60' } : {}}
                >
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: col.color }} />
                  <div>
                    <div className="text-[0.6875rem] font-semibold text-zinc-300">{col.name}</div>
                    <div className="text-[0.5625rem] text-zinc-600">{isDroppingHere ? 'Drop here' : `${count} image${count !== 1 ? 's' : ''}`}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Main upload card ──────────────────────────────────────────────── */}
        <Card className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">Paste Inbox</h2>
              <p className="text-sm text-zinc-500">
                {activeCollection
                  ? `Showing folder: ${collections.find(c => c.id === activeCollection)?.name}`
                  : 'Paste or upload images here. They stay saved in your browser for quick reuse.'}
              </p>
            </div>
            <Badge color="zinc">{filteredItems.length} {activeCollection ? 'in folder' : 'saved'}</Badge>
          </div>

          <div
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.dataset.dragging = '1'; }}
            onDragLeave={(e) => { delete e.currentTarget.dataset.dragging; }}
            onDrop={(e) => { e.preventDefault(); delete e.currentTarget.dataset.dragging; addFiles(e.dataTransfer.files); }}
            onClick={() => fileInputRef.current?.click()}
            className="flex min-h-[120px] cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-zinc-700/60 bg-zinc-900/30 px-4 py-4 transition hover:border-zinc-500 hover:bg-zinc-800/20 active:scale-[0.99]"
          >
            <div className="text-center">
              <div className="text-sm font-medium text-zinc-300">
                {activeCollection ? `Drop images to add to "${collections.find(c => c.id === activeCollection)?.name}"` : 'Drop images here or click to upload'}
              </div>
              <div className="mt-1 text-xs text-zinc-600">Ctrl+V works too</div>
            </div>
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="hidden" onChange={(e) => { addFiles(e.target.files || []); e.target.value = ''; }} />
          </div>
        </Card>

        {/* ── Actions + grid ────────────────────────────────────────────────── */}
        <Card className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Btn onClick={() => sendSelected('photo')} disabled={selectedItems.length === 0}>Use for Photo Match</Btn>
            <Btn variant="secondary" onClick={() => sendSelected('scene')} disabled={selectedItems.length === 0}>Use for Scene Recreate</Btn>
            <Btn variant="ghost" onClick={() => sendSelected(['photo', 'scene'])} disabled={selectedItems.length === 0}>Use for Both</Btn>
            <Btn variant="ghost" onClick={clearAll} disabled={items.length === 0}>Clear inbox</Btn>
            {selectedIds.length > 0 && <Badge color="blue">{selectedIds.length} selected</Badge>}
          </div>

          {/* Right-click context menu */}
          {folderMenu && (
            <div ref={folderMenuRef} className="fixed bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl z-50 min-w-[160px] py-1 overflow-hidden" style={{ top: folderMenu.y, left: Math.min(folderMenu.x, window.innerWidth - 180) }}>
              <div className="px-3 py-1.5 text-[0.625rem] font-semibold text-zinc-500 uppercase tracking-wider border-b border-zinc-800">Add to folder</div>
              {collections.length === 0 && <div className="px-3 py-2 text-[0.6875rem] text-zinc-500">No folders yet — create one above</div>}
              {collections.map((col) => {
                const inCol = col.frameIds?.includes(folderMenu.itemId);
                return (
                  <button key={col.id} onClick={() => inCol ? handleRemoveFromFolder(col.id, folderMenu.itemId) : handleAddToFolder(col.id, [folderMenu.itemId])} className="flex items-center gap-2 w-full px-3 py-1.5 text-[0.6875rem] text-zinc-300 hover:bg-zinc-800 transition cursor-pointer">
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

          {filteredItems.length === 0 ? (
            <Empty icon="image" title={activeCollection ? 'No images in this folder' : 'No saved images yet'} subtitle={activeCollection ? 'Drop images onto the folder card above, or right-click an image and add it.' : 'Paste or upload an image to keep it here.'} />
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {filteredItems.map((item) => {
                const folderDots = collections.filter((c) => c.frameIds?.includes(item.id));
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => toggleItem(item.id)}
                    onContextMenu={(e) => { e.preventDefault(); setFolderMenu({ itemId: item.id, x: e.clientX, y: e.clientY }); }}
                    className={`group relative overflow-hidden rounded-xl border text-left transition ${selectedIds.includes(item.id) ? 'border-rose-500/60 ring-2 ring-rose-500/20' : 'border-zinc-800/70 hover:border-zinc-600'}`}
                  >
                    <img src={item.dataUrl} alt={item.name} className="aspect-square w-full object-cover" />

                    {/* Folder dots */}
                    {folderDots.length > 0 && (
                      <div className="absolute top-1.5 right-1.5 flex gap-0.5">
                        {folderDots.slice(0, 4).map((c) => (
                          <span key={c.id} className="w-2 h-2 rounded-full border border-black/40" style={{ background: c.color }} title={c.name} />
                        ))}
                      </div>
                    )}

                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                      <div className="truncate text-[0.6875rem] font-medium text-zinc-100">{item.name}</div>
                      <div className="text-[0.625rem] text-zinc-400">{new Date(item.createdAt).toLocaleString()}</div>
                      {Array.isArray(item.usage) && item.usage.length > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {item.usage.map((usageLabel) => (
                            <Badge key={`${item.id}-${usageLabel}`} color="blue">Used in {usageLabel}</Badge>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
                      <button type="button" onClick={(e) => { e.stopPropagation(); copyToInbox(item); }} className="rounded-full bg-black/70 px-2 py-1 text-[0.625rem] font-semibold text-zinc-200 hover:text-rose-300">Copy</button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); copyImageToClipboard(item); }} className="rounded-full bg-black/70 px-2 py-1 text-[0.625rem] font-semibold text-zinc-200 hover:text-rose-300">📋</button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); removeItem(item.id); }} className="rounded-full bg-black/70 px-2 py-1 text-[0.625rem] font-semibold text-zinc-200 hover:text-red-300">✕</button>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
