import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Btn, Card, Empty } from '../components/UI';
import { useApp } from '../context/AppContext';

const PASTE_INBOX_STORAGE_KEY = 'kyros.pasteInbox.items';
const PHOTO_MATCH_SOURCE_STORAGE_KEY = 'kyros.photoMatch.sources';
const SCENE_RECREATE_SOURCE_STORAGE_KEY = 'kyros.sceneRecreate.sources';

function readStoredItems() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PASTE_INBOX_STORAGE_KEY);
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
      window.localStorage.removeItem(PASTE_INBOX_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(PASTE_INBOX_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage failures.
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
  const [items, setItems] = useState(() => readStoredItems());
  const [selectedIds, setSelectedIds] = useState([]);
  const fileInputRef = useRef(null);

  useEffect(() => writeStoredItems(items), [items]);

  useEffect(() => {
    const onPaste = async (event) => {
      const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'));
      if (!item) return;
      event.preventDefault();
      const file = item.getAsFile();
      if (!file) return;
      const dataUrl = await fileToDataUrl(file);
      setItems((prev) => [{ ...makeItem(file), dataUrl }, ...prev].slice(0, 500));
      notify('Pasted image saved to inbox', 'success');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [notify]);

  const selectedItems = useMemo(() => items.filter((item) => selectedIds.includes(item.id)), [items, selectedIds]);

  const toggleItem = (id) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const addFiles = async (incoming) => {
    const valid = [...incoming].filter((file) => file.type.startsWith('image/'));
    if (valid.length === 0) {
      notify('Only image files are supported', 'error');
      return;
    }
    const next = await Promise.all(valid.map(async (file) => ({ ...makeItem(file, 'upload'), dataUrl: await fileToDataUrl(file) })));
    setItems((prev) => [...next, ...prev].slice(0, 500));
    notify(`${next.length} image${next.length === 1 ? '' : 's'} saved to inbox`, 'success');
  };

  const removeItem = (id) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    setSelectedIds((prev) => prev.filter((itemId) => itemId !== id));
  };

  const copyToInbox = (item) => {
    const copyId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const copyName = item.name.includes('.')
      ? `${item.name.replace(/\.[^.]+$/, '')} copy${item.name.match(/\.[^.]+$/)?.[0] || ''}`
      : `${item.name} copy`;
    setItems((prev) => [{
      ...item,
      id: copyId,
      name: copyName,
      createdAt: Date.now(),
      usage: [],
      lastUsedAt: undefined,
    }, ...prev]);
    notify('Image copied in inbox', 'success');
  };

  const copyImageToClipboard = async (item) => {
    try {
      const file = dataUrlToFile(item.dataUrl, item.name);
      if (!file || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('Clipboard copy not supported');
      }
      await navigator.clipboard.write([new ClipboardItem({ [file.type]: file })]);
      notify('Image copied to clipboard', 'success');
    } catch (err) {
      notify(err.message || 'Failed to copy image', 'error');
    }
  };

  const clearAll = () => {
    setItems([]);
    setSelectedIds([]);
  };

  const sendSelected = (features) => {
    if (selectedItems.length === 0) {
      notify('Select at least one image', 'error');
      return;
    }
    const featureList = Array.isArray(features) ? features : [features];
    const targets = featureList.flatMap((feature) => feature === 'scene'
      ? [{ eventName: 'kyros:use-as-scene-source', label: 'Scene Recreate', storageKey: SCENE_RECREATE_SOURCE_STORAGE_KEY, page: 'scene' }]
      : [{ eventName: 'kyros:use-as-photo-match-source', label: 'Photo Match', storageKey: PHOTO_MATCH_SOURCE_STORAGE_KEY, page: 'photoMatch' }]);
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
        // Ignore persistence failures.
      }
      window.dispatchEvent(new CustomEvent(target.eventName, { detail: { items: selectedItems } }));
    }
    const targetLabel = targets.map((entry) => entry.label).join(' + ');
    const sentAt = Date.now();
    setItems((prev) => prev.map((item) => (
      selectedIds.includes(item.id)
        ? { ...item, usage: [...new Set([...(item.usage || []), ...targets.map((entry) => entry.label)])], lastUsedAt: sentAt }
        : item
    )));
    if (targets.length === 1) navigateTo(targets[0].page);
    else navigateTo('photoMatch');
    notify(`Saved ${selectedItems.length} image${selectedItems.length === 1 ? '' : 's'} and opened ${targetLabel}`, 'success');
  };

  return (
    <div className="space-y-6 animate-in">
      <div className="max-w-5xl space-y-4">
        <Card className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">Paste Inbox</h2>
              <p className="text-sm text-zinc-500">Paste or upload images here. They stay saved in your browser for quick reuse.</p>
            </div>
            <Badge color="zinc">{items.length} saved</Badge>
          </div>

          <div
            onClick={() => fileInputRef.current?.click()}
            className="flex min-h-[140px] cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-zinc-700/60 bg-zinc-900/30 px-4 py-4 transition hover:border-zinc-500 hover:bg-zinc-800/20"
          >
            <div className="text-center">
              <div className="text-sm font-medium text-zinc-300">Drop images here or click to upload</div>
              <div className="mt-1 text-xs text-zinc-600">Ctrl+V works too</div>
            </div>
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="hidden" onChange={(e) => { addFiles(e.target.files || []); e.target.value = ''; }} />
          </div>
        </Card>

        <Card className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Btn onClick={() => sendSelected('photo')} disabled={selectedItems.length === 0}>Use for Photo Match</Btn>
            <Btn variant="secondary" onClick={() => sendSelected('scene')} disabled={selectedItems.length === 0}>Use for Scene Recreate</Btn>
            <Btn variant="ghost" onClick={() => sendSelected(['photo', 'scene'])} disabled={selectedItems.length === 0}>Use for Both</Btn>
            <Btn variant="ghost" onClick={clearAll} disabled={items.length === 0}>Clear inbox</Btn>
            {selectedIds.length > 0 && <Badge color="blue">{selectedIds.length} selected</Badge>}
          </div>

          {items.length === 0 ? (
            <Empty icon="image" title="No saved images yet" subtitle="Paste or upload an image to keep it here." />
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => toggleItem(item.id)}
                  className={`group relative overflow-hidden rounded-xl border text-left transition ${selectedIds.includes(item.id) ? 'border-blue-500/60 ring-2 ring-blue-500/20' : 'border-zinc-800/70 hover:border-zinc-600'}`}
                >
                  <img src={item.dataUrl} alt={item.name} className="aspect-square w-full object-cover" />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                    <div className="truncate text-[11px] font-medium text-zinc-100">{item.name}</div>
                    <div className="text-[10px] text-zinc-400">{new Date(item.createdAt).toLocaleString()}</div>
                    {Array.isArray(item.usage) && item.usage.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {item.usage.map((usageLabel) => (
                          <Badge key={`${item.id}-${usageLabel}`} color="blue">Used in {usageLabel}</Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); copyToInbox(item); }}
                      className="rounded-full bg-black/70 px-2 py-1 text-[10px] font-semibold text-zinc-200 hover:text-blue-300"
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); copyImageToClipboard(item); }}
                      className="rounded-full bg-black/70 px-2 py-1 text-[10px] font-semibold text-zinc-200 hover:text-blue-300"
                    >
                      Copy to clipboard
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeItem(item.id); }}
                      className="rounded-full bg-black/70 px-2 py-1 text-[10px] font-semibold text-zinc-200 hover:text-red-300"
                    >
                      Remove
                    </button>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
