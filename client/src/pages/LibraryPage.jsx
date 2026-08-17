import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { library as libraryApi, gallery as galleryApi, video as videoApi } from '../services/api';
import { stashSourceHandoff, handoffDestination } from '../lib/sourceHandoff';
import { downloadBlob, stripMetadata, stripEnabled } from '../lib/stripMetadata';
import { cascadeDeleteFromCollections } from '../lib/galleryCascade';
import { useApp } from '../context/AppContext';
import { Btn, Badge, Spinner, Empty, ConfirmDialog, Toggle, Modal } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';

const MEDIA_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
];

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'largest', label: 'Largest' },
  { value: 'smallest', label: 'Smallest' },
  { value: 'quality', label: 'Quality Score' },
];

const PERSONA_LABELS = {
  luxury: 'Luxury',
  of: 'OF Creator',
  fitness: 'Fitness',
  girl_next_door: 'Girl Next Door',
  high_fashion: 'High Fashion',
  cosplay: 'Cosplay',
  goth: 'Goth / Alt',
};

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    base64: match[2],
  };
}

function sanitizeDownloadName(name = 'download') {
  return String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'download';
}

function extensionFromMimeType(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return '.jpg';
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.includes('gif')) return '.gif';
  if (normalized.includes('mp4')) return '.mp4';
  if (normalized.includes('quicktime')) return '.mov';
  if (normalized.includes('webm')) return '.webm';
  return '';
}

function filenameFromContentDisposition(header) {
  if (!header) return '';
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1]);
  const basicMatch = header.match(/filename="?([^";]+)"?/i);
  return basicMatch?.[1] || '';
}

function filenameFromUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url, window.location.origin);
    return decodeURIComponent(parsed.pathname.split('/').pop() || '');
  } catch {
    return '';
  }
}

function buildBulkDownloadName(item, { spoofEnabled = false } = {}) {
  const explicitName = item.metadata?.filename || filenameFromUrl(item.downloadUrl);
  if (explicitName) {
    const parsed = /^(.*?)(\.[^.]+)?$/.exec(explicitName);
    const baseName = parsed?.[1] || explicitName;
    const ext = spoofEnabled && item.mediaType === 'image'
      ? '.jpg'
      : parsed?.[2] || extensionFromMimeType(item.metadata?.mimeType) || (item.mediaType === 'video' ? '.mp4' : '.png');
    return sanitizeDownloadName(`${baseName}${ext}`);
  }

  const fallbackExt = spoofEnabled && item.mediaType === 'image'
    ? '.jpg'
    : extensionFromMimeType(item.metadata?.mimeType) || (item.mediaType === 'video' ? '.mp4' : '.png');
  return sanitizeDownloadName(`${item.mediaType}-${item.originalId}${fallbackExt}`);
}

function bulkFolderName() {
  return `Kyros Studio Library ${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}`;
}

function PromptSnippet({ prompt, notify }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!prompt) return <p className="text-sm text-zinc-500 italic">No prompt</p>;

  const isLong = prompt.length > 180;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      notify?.('Prompt copied', 'success');
      window.setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      notify?.(err?.message || 'Failed to copy prompt', 'error');
    }
  };

  return (
    <div className="space-y-1.5">
      <p
        className={`text-sm text-zinc-300 whitespace-pre-wrap break-words ${expanded ? '' : 'line-clamp-2'}`}
        title={expanded ? undefined : prompt}
      >
        {prompt}
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={handleCopy}
          className="text-[0.6875rem] text-rose-400 hover:text-rose-300 transition"
        >
          {copied ? 'Copied' : 'Copy prompt'}
        </button>
        {isLong ? (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="text-[0.6875rem] text-zinc-500 hover:text-zinc-300 transition"
          >
            {expanded ? 'Hide' : 'Expand'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

async function copyImageFromUrl(url, notify) {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      throw new Error('Copy image is not supported in this browser');
    }
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`Failed to load image (${response.status})`);
    const blob = await response.blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    notify?.('Image copied', 'success');
  } catch (err) {
    notify?.(err.message || 'Failed to copy image', 'error');
  }
}

function ContextMenuItem({ icon, label, tone = 'default', shortcut, ...props }) {
  const toneClass = tone === 'danger'
    ? 'text-red-400/80 hover:bg-red-500/10 hover:text-red-300'
    : 'text-zinc-300 hover:bg-white/[0.06] hover:text-white';
  return (
    <button
      type="button"
      className={`group/item flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[0.8125rem] font-medium transition-all duration-150 cursor-pointer ${toneClass}`}
      {...props}
    >
      {icon && <span className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500 transition-colors group-hover/item:text-inherit">{icon}</span>}
      <span className="flex-1 truncate">{label}</span>
      {shortcut && <span className="text-[0.625rem] text-zinc-600 font-mono">{shortcut}</span>}
    </button>
  );
}

const LIBRARY_CONTEXT_MENU_WIDTH = 240;
const LIBRARY_CONTEXT_MENU_GAP = 6;
const LIBRARY_CONTEXT_MENU_MARGIN = 8;

/* Inline SVG icons for context menu */
const ctxIcons = {
  eye: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  clipboard: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>,
  image: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>,
  edit: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  zap: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  grid: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  download: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  trash: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
};

function ImageContextMenu({ menu, onClose, onAction }) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!menu) return undefined;
    const handlePointerDown = () => onClose();
    const handleEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handlePointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handlePointerDown, true);
    };
  }, [menu, onClose]);

  // Reposition after render so we use the actual measured height
  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const menuH = rect.height;
    const menuW = LIBRARY_CONTEXT_MENU_WIDTH;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = menu.rawX + LIBRARY_CONTEXT_MENU_GAP;
    let y = menu.rawY + LIBRARY_CONTEXT_MENU_GAP;

    // Flip left if overflows right
    if (x + menuW > vw - LIBRARY_CONTEXT_MENU_MARGIN) {
      x = menu.rawX - menuW - LIBRARY_CONTEXT_MENU_GAP;
    }
    // Flip up if overflows bottom
    if (y + menuH > vh - LIBRARY_CONTEXT_MENU_MARGIN) {
      y = menu.rawY - menuH - LIBRARY_CONTEXT_MENU_GAP;
    }

    x = Math.max(LIBRARY_CONTEXT_MENU_MARGIN, Math.min(x, vw - menuW - LIBRARY_CONTEXT_MENU_MARGIN));
    y = Math.max(LIBRARY_CONTEXT_MENU_MARGIN, Math.min(y, vh - menuH - LIBRARY_CONTEXT_MENU_MARGIN));

    setPos({ x, y });
  }, [menu]);

  if (!menu) return null;

  /* Build a clean display name: prefer source label, then character, then a short ID. Never show a raw UUID. */
  const source = menu.item.source;
  const sourceLabel = {
    'generate': 'Generated Image',
    'batch': 'Batch Image',
    'carousel': 'Carousel Image',
    'scene-recreate': 'Scene Recreate',
    'post-clone': 'Post Clone',
    'reel-copy': 'Reel Copy',
    'reel-recreate': 'Reel Recreate',
    'tweak': 'Tweaked Image',
    'nano-bypass': 'Nano Bypass',
    'nano-bypass-experimental': 'Nano Bypass',
    'photo-match': 'Photo Match',
  }[source] || 'Image';

  const dateStr = menu.item.createdAt
    ? new Date(menu.item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

  const badges = [
    menu.item.aspectRatio,
    menu.item.metadata?.resolutionTier,
    menu.item.metadata?.imageModel,
  ].filter(Boolean);

  return (
    <div
      ref={menuRef}
      className="fixed z-[80] rounded-2xl border border-zinc-700/50 bg-zinc-900/[0.97] p-1.5 shadow-2xl shadow-black/50 backdrop-blur-2xl"
      style={{
        width: LIBRARY_CONTEXT_MENU_WIDTH,
        left: pos.x,
        top: pos.y,
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {/* Header */}
      <div className="mb-1 rounded-xl bg-zinc-800/50 px-3 py-2.5">
        <p className="text-[0.8125rem] font-semibold text-zinc-100 truncate">{sourceLabel}</p>
        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
          {dateStr && <span className="text-[0.625rem] text-zinc-500">{dateStr}</span>}
          {badges.map((b, i) => (
            <span key={i} className="rounded-md bg-zinc-700/50 px-1.5 py-0.5 text-[0.5625rem] font-medium text-zinc-400">{b}</span>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="py-0.5">
        <ContextMenuItem icon={ctxIcons.eye} label="Open preview" onClick={() => onAction('open')} />
        <ContextMenuItem icon={ctxIcons.clipboard} label="Copy prompt" onClick={() => onAction('copyPrompt')} />
        <ContextMenuItem icon={ctxIcons.image} label="Copy image" onClick={() => onAction('copyImage')} />
        <div className="my-1 border-t border-zinc-800/80 mx-2" />
        <ContextMenuItem icon={ctxIcons.edit} label="Edit in Image Editor" onClick={() => onAction('imageEditor')} />
        <ContextMenuItem icon={ctxIcons.zap} label="Nano Bypass" onClick={() => onAction('nanoBypass')} />
        <ContextMenuItem icon={ctxIcons.grid} label="Go to Carousel" onClick={() => onAction('carousel')} />
        <ContextMenuItem icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.47"/></svg>} label="Photo Match →" onClick={() => onAction('photoMatch')} />
        <ContextMenuItem icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>} label="Move to Folder" onClick={() => onAction('moveToFolder')} />
        <div className="my-1 border-t border-zinc-800/80 mx-2" />
        <ContextMenuItem icon={ctxIcons.download} label="Download" onClick={() => onAction('download')} />
        <ContextMenuItem icon={ctxIcons.trash} label="Delete" tone="danger" onClick={() => onAction('delete')} />
      </div>
    </div>
  );
}

export default function LibraryPage() {
  const { notify, navigateTo, characters } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const isElectron = Boolean(window.electronAPI?.isElectron);
  const [items, setItems] = useState([]);
  const [totals, setTotals] = useState({ all: 0, images: 0, videos: 0 });
  const [loading, setLoading] = useState(true);
  const [mediaFilter, setMediaFilter] = useState('all');
  const [sortBy, setSortBy] = useState('newest');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedVideoId, setExpandedVideoId] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('');
  const [ratioFilter, setRatioFilter] = useState('');
  const [characterFilter, setCharacterFilter] = useState('');
  const [personaFilter, setPersonaFilter] = useState('');
  const [tagFilter, setTagFilter] = useState([]);
  const [dateFilter, setDateFilter] = useState('all'); // all | today | week | month
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [folderNameInput, setFolderNameInput] = useState('');
  const [groupBySession, setGroupBySession] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [spoofAvailable, setSpoofAvailable] = useState(false);
  const [spoofEnabled, setSpoofEnabled] = useState(true);
  const [bulkDeleteTarget, setBulkDeleteTarget] = useState(false);
  const [visibleCount, setVisibleCount] = useState(24);
  const [editTarget, setEditTarget] = useState(null);
  const [editDestinationBusy, setEditDestinationBusy] = useState(false);

  // ── FOLDERS ──────────────────────────────────────────────────────────────
  const LIB_FOLDERS_KEY = 'kyros.library.collections';
  const loadFolders = () => { try { const r = window.localStorage.getItem(LIB_FOLDERS_KEY); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a : []; } catch { return []; } };
  const saveFolders = (f) => { try { window.localStorage.setItem(LIB_FOLDERS_KEY, JSON.stringify(f)); } catch {} };
  const FOLDER_COLORS = ['#a855f7','#ec4899','#3b82f6','#22c55e','#f59e0b','#ef4444','#06b6d4','#f97316'];
  const [folders, setFolders] = useState(() => loadFolders());
  const [activeFolderId, setActiveFolderId] = useState(null); // null = All
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState(null);
  const [renameFolderText, setRenameFolderText] = useState('');
  const [showFolderPicker, setShowFolderPicker] = useState(false); // bulk send-to-folder dropdown
  const folderPickerRef = useRef(null);

  const persistFolders = (updated) => { setFolders(updated); saveFolders(updated); };

  const createFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    const col = { id: `lf-${Date.now()}`, name, color: FOLDER_COLORS[Math.floor(Math.random() * FOLDER_COLORS.length)], createdAt: Date.now(), itemIds: [] };
    persistFolders([...folders, col]);
    setNewFolderName('');
    setShowNewFolderInput(false);
    setActiveFolderId(col.id);
  };

  const deleteFolder = (id) => {
    persistFolders(folders.filter(f => f.id !== id));
    if (activeFolderId === id) setActiveFolderId(null);
  };

  const renameFolder = (id) => {
    const name = renameFolderText.trim();
    if (!name) return;
    persistFolders(folders.map(f => f.id === id ? { ...f, name } : f));
    setRenamingFolderId(null);
  };

  const addItemsToFolder = (folderId, ids) => {
    persistFolders(folders.map(f => f.id === folderId ? { ...f, itemIds: Array.from(new Set([...(f.itemIds||[]), ...ids])) } : f));
    notify(`Added ${ids.length} item${ids.length===1?'':'s'} to folder`, 'success');
    setShowFolderPicker(false);
  };

  const removeItemFromFolder = (folderId, itemId) => {
    persistFolders(folders.map(f => f.id === folderId ? { ...f, itemIds: (f.itemIds||[]).filter(i => i !== itemId) } : f));
  };

  // Close folder picker on outside click
  useEffect(() => {
    if (!showFolderPicker) return;
    const handler = (e) => { if (folderPickerRef.current && !folderPickerRef.current.contains(e.target)) setShowFolderPicker(false); };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [showFolderPicker]);
  const [contextMenu, setContextMenu] = useState(null);
  const sentinelRef = useRef(null);
  const lastSelectedIdRef = useRef(null);
  const [dragBox, setDragBox] = useState(null);
  const [isDragSelecting, setIsDragSelecting] = useState(false);
  const activeDragSelectedRef = useRef(new Set());
  const initialSelectedRef = useRef(new Set());
  const [isDroppingFile, setIsDroppingFile] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const uploadInputRef = useRef(null);
  const dragCounterRef = useRef(0);

  const resolvedPathsRef = useRef({});
  const fetchingPathsRef = useRef(new Set());

  // ── File Drop / Upload ──────────────────────────────────────────────────
  const uploadFiles = useCallback(async (files) => {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) { notify('Only image files are supported', 'error'); return; }
    setIsUploading(true);
    let successCount = 0;
    try {
      for (const file of imageFiles) {
        const fd = new FormData();
        fd.append('image', file);
        fd.append('source', 'upload');
        fd.append('prompt', file.name.replace(/\.[^.]+$/, ''));
        const res = await fetch('/api/gallery/upload', { method: 'POST', credentials: 'include', body: fd });
        if (res.ok) {
          const json = await res.json();
          if (json?.success && json?.data) {
            // Prepend to items list optimistically
            const entry = json.data;
            const newItem = {
              id: entry.id,
              originalId: entry.id,
              mediaType: 'image',
              previewUrl: `/api/gallery/${entry.id}/image`,
              thumbnailUrl: `/api/gallery/${entry.id}/thumbnail`,
              downloadUrl: `/api/gallery/${entry.id}/image`,
              createdAt: entry.createdAt || new Date().toISOString(),
              prompt: entry.prompt || file.name,
              metadata: { filename: file.name, source: 'upload' },
            };
            setItems(prev => [newItem, ...prev]);
            setTotals(prev => ({ ...prev, all: prev.all + 1, images: prev.images + 1 }));
            successCount++;
          }
        }
      }
      if (successCount > 0) notify(`Imported ${successCount} photo${successCount > 1 ? 's' : ''} ✓`, 'success');
      else notify('Upload failed — check server logs', 'error');
    } catch (err) {
      notify(err.message || 'Upload failed', 'error');
    } finally {
      setIsUploading(false);
    }
  }, [notify]);

  const handlePageDragEnter = useCallback((e) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    dragCounterRef.current++;
    setIsDroppingFile(true);
    e.preventDefault();
  }, []);

  const handlePageDragLeave = useCallback(() => {
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setIsDroppingFile(false); }
  }, []);

  const handlePageDrop = useCallback((e) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDroppingFile(false);
    if (e.dataTransfer.files?.length > 0) uploadFiles(e.dataTransfer.files);
  }, [uploadFiles]);

  const prefetchPaths = useCallback(async (itemsToFetch) => {
    if (!isElectron) return;
    const missing = itemsToFetch.filter(
      (x) => !resolvedPathsRef.current[x.id] && !fetchingPathsRef.current.has(x.id)
    );
    if (missing.length === 0) return;

    for (const x of missing) {
      fetchingPathsRef.current.add(x.id);
    }

    try {
      const res = await libraryApi.bulkPaths(missing);
      if (res?.success && res.data) {
        for (const x of res.data) {
          resolvedPathsRef.current[x.id] = x.filePath;
        }
      }
    } catch (err) {
      console.error('[LibraryPage] Failed to prefetch paths', err);
    } finally {
      for (const x of missing) {
        fetchingPathsRef.current.delete(x.id);
      }
    }
  }, [isElectron]);



  const handleItemMouseEnter = useCallback((item) => {
    if (isElectron) {
      prefetchPaths([item]);
    }
  }, [isElectron, prefetchPaths]);

  const handleItemMouseDown = useCallback((item) => {
    if (isElectron) {
      prefetchPaths([item]);
    }
  }, [isElectron, prefetchPaths]);

  useEffect(() => {
    const handleMouseDown = (e) => {
      // 1. Only left click triggers drag selection
      if (e.button !== 0) return;

      // 2. Do not trigger drag select on buttons, inputs, context menu, dialogs, etc.
      const target = e.target;
      const isInteractive = target.closest('button, input, select, textarea, a, [role="button"]') ||
                            target.closest('.ConfirmDialog') ||
                            target.closest('.Modal') ||
                            target.closest('[class*="ContextMenu"]');
      if (isInteractive) return;

      // 3. Make sure we don't start dragging if we clicked directly on draggable elements
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

        // Threshold of 5px to distinguish click vs drag
        if (!hasTriggeredDrag && Math.sqrt(dx * dx + dy * dy) > 5) {
          hasTriggeredDrag = true;
          setIsDragSelecting(true);
          setBulkMode(true);
        }

        if (hasTriggeredDrag) {
          moveEvent.preventDefault();
          setDragBox({ startX, startY, currentX, currentY });

          // Calculate selection box coordinates relative to viewport
          const boxLeft = Math.min(startX, currentX);
          const boxTop = Math.min(startY, currentY);
          const boxWidth = Math.abs(currentX - startX);
          const boxHeight = Math.abs(currentY - startY);

          // Find all elements with data-library-item-id
          const elements = document.querySelectorAll('[data-library-item-id]');
          const intersectingIds = new Set();

          elements.forEach((el) => {
            const itemId = el.getAttribute('data-library-item-id');
            if (!itemId) return;

            const rect = el.getBoundingClientRect();
            // Check intersection
            const intersects = !(
              rect.right < boxLeft ||
              rect.left > boxLeft + boxWidth ||
              rect.bottom < boxTop ||
              rect.top > boxTop + boxHeight
            );

            if (intersects) {
              intersectingIds.add(itemId);
            }
          });

          // Check if intersecting IDs changed before triggering React render
          const isSetEqual = (a, b) => a.size === b.size && [...a].every(value => b.has(value));
          if (!isSetEqual(intersectingIds, activeDragSelectedRef.current)) {
            activeDragSelectedRef.current = intersectingIds;

            // Merge with initial selection if shift/ctrl is held
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
                return merged;
              } else {
                return new Set(intersectingIds);
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
  }, [selectedIds, setBulkMode]);

  const imageItems = useMemo(() => items.filter((item) => item.mediaType === 'image'), [items]);
  const imagePreviewUrls = useMemo(() => imageItems.map((item) => item.previewUrl), [imageItems]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, spoofState] = await Promise.all([
        libraryApi.list(),
        galleryApi.spoofStatus().catch(() => ({ available: false })),
      ]);
      setItems(data.items || []);
      setTotals(data.totals || { all: 0, images: 0, videos: 0 });
      setSpoofAvailable(!!spoofState?.available);
    } catch (err) {
      notify(err.message || 'Failed to load your library', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    load();
  }, [load]);

  const availableSources = useMemo(() => {
    const set = new Set(imageItems.map((item) => item.source).filter(Boolean));
    return [...set].sort();
  }, [imageItems]);

  const availableRatios = useMemo(() => {
    const set = new Set(imageItems.map((item) => item.aspectRatio).filter(Boolean));
    return [...set].sort();
  }, [imageItems]);

  const availableCharacterIds = useMemo(() => {
    const set = new Set(imageItems.map((item) => item.characterId).filter(Boolean));
    return [...set];
  }, [imageItems]);

  const availablePersonas = useMemo(() => {
    const set = new Set(imageItems.map((item) => item.metadata?.personaMode).filter(Boolean));
    return [...set].sort();
  }, [imageItems]);

  const availableTags = useMemo(() => {
    const tags = new Set();
    imageItems.forEach((item) => {
      (item.tags || []).forEach((tag) => tags.add(tag));
    });
    return [...tags].sort();
  }, [imageItems]);

  const filteredItems = useMemo(() => {
    let list = [...items];

    if (mediaFilter !== 'all') list = list.filter((item) => item.mediaType === mediaFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((item) => item.prompt?.toLowerCase().includes(q));
    }
    if (favoritesOnly) list = list.filter((item) => item.mediaType === 'image' && item.favorite);
    if (sourceFilter) list = list.filter((item) => item.mediaType !== 'image' || item.source === sourceFilter);
    if (ratioFilter) list = list.filter((item) => item.mediaType !== 'image' || item.aspectRatio === ratioFilter);
    if (characterFilter) list = list.filter((item) => item.mediaType !== 'image' || item.characterId === characterFilter);
    if (personaFilter) list = list.filter((item) => item.mediaType !== 'image' || item.metadata?.personaMode === personaFilter);
    if (tagFilter.length > 0) list = list.filter((item) => item.mediaType !== 'image' || tagFilter.some((tag) => item.tags?.includes(tag)));
    if (dateFilter !== 'all') {
      const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
      const days = dateFilter === 'week' ? 7 : dateFilter === 'month' ? 30 : 0;
      const cutoff = dateFilter === 'today' ? startOfToday.getTime() : Date.now() - days * 24 * 60 * 60 * 1000;
      list = list.filter((item) => new Date(item.createdAt).getTime() >= cutoff);
    }

    list.sort((a, b) => {
      if (sortBy === 'largest') return (b.metadata?.fileSize || 0) - (a.metadata?.fileSize || 0);
      if (sortBy === 'smallest') return (a.metadata?.fileSize || 0) - (b.metadata?.fileSize || 0);
      if (sortBy === 'quality') return (b.metadata?.qualityScore || 0) - (a.metadata?.qualityScore || 0);
      if (sortBy === 'oldest') return new Date(a.createdAt) - new Date(b.createdAt);
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    // Folder filter
    if (activeFolderId) {
      const activeFolder = folders.find(f => f.id === activeFolderId);
      const folderItemIds = new Set(activeFolder?.itemIds || []);
      list = list.filter(item => folderItemIds.has(String(item.id)) || folderItemIds.has(String(item.originalId)));
    }

    return list;
  }, [items, mediaFilter, searchQuery, favoritesOnly, sourceFilter, ratioFilter, characterFilter, personaFilter, tagFilter, dateFilter, sortBy, activeFolderId, folders]);

  useEffect(() => {
    setVisibleCount(24);
  }, [filteredItems]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visibleCount >= filteredItems.length || groupBySession) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisibleCount((count) => Math.min(count + 24, filteredItems.length));
      }
    }, { rootMargin: '400px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [visibleCount, filteredItems.length, groupBySession]);

  const visibleItems = useMemo(() => (groupBySession ? filteredItems : filteredItems.slice(0, visibleCount)), [filteredItems, groupBySession, visibleCount]);

  useEffect(() => {
    if (!isElectron || visibleItems.length === 0) return;
    prefetchPaths(visibleItems);
  }, [visibleItems, isElectron, prefetchPaths]);

  const groupedSessions = useMemo(() => {
    if (!groupBySession) return [];
    const groups = new Map();
    filteredItems.filter((item) => item.mediaType === 'image').forEach((item) => {
      const key = item.metadata?.sessionId || `solo-${item.id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          id: key,
          sessionId: item.metadata?.sessionId || null,
          source: item.source,
          createdAt: item.createdAt,
          items: [],
        });
      }
      groups.get(key).items.push(item);
    });
    return [...groups.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [filteredItems, groupBySession]);

  const hasVideoItems = filteredItems.some((item) => item.mediaType === 'video');
  const hasImageItems = filteredItems.some((item) => item.mediaType === 'image');
  const selectedHasImage = items.some((item) => selectedIds.has(item.id) && item.mediaType === 'image');
  const showSpoofToggle = spoofAvailable && (bulkMode ? selectedHasImage : hasImageItems);
  const canGroupSessions = !hasVideoItems && mediaFilter !== 'video';
  const hasActiveFilters = Boolean(searchQuery || sourceFilter || ratioFilter || characterFilter || personaFilter || favoritesOnly || tagFilter.length > 0 || dateFilter !== 'all');

  const handleImageFavorite = useCallback(async (item) => {
    setItems((prev) => prev.map((entry) => entry.id === item.id ? { ...entry, favorite: !entry.favorite } : entry));
    try {
      await galleryApi.toggleFavorite(item.originalId);
    } catch (err) {
      setItems((prev) => prev.map((entry) => entry.id === item.id ? { ...entry, favorite: !!item.favorite } : entry));
      notify(err.message || 'Failed to update favorite', 'error');
    }
  }, [notify]);

  const handleOpenEditChooser = useCallback((item) => {
    setEditTarget(item);
  }, []);

  const handleEditDestination = useCallback(async (destination) => {
    if (!editTarget) return;

    if (destination === 'imageEditor') {
      navigateTo('imageEditor', { editId: editTarget.originalId });
      setEditTarget(null);
      return;
    }

    if (destination === 'carousel') {
      navigateTo('carousel', {
        recreate: true,
        sourceImageId: editTarget.originalId,
        aspectRatio: '4:5',
      });
      setEditTarget(null);
      return;
    }

    if (destination === 'photoMatch') {
      setEditDestinationBusy(true);
      try {
        const response = await fetch(editTarget.downloadUrl || `/api/gallery/${editTarget.originalId}/image`, { credentials: 'include' });
        if (!response.ok) throw new Error(`Failed to load image (${response.status})`);
        const blob = await response.blob();
        const dataUrl = await blobToDataUrl(blob);
        const parsed = parseDataUrl(dataUrl);
        if (!parsed) throw new Error('Could not prepare image for Photo Match');
        window.dispatchEvent(new CustomEvent('kyros:use-as-source', {
          detail: {
            base64: parsed.base64,
            mimeType: parsed.mimeType,
            name: editTarget.metadata?.filename || `library-${editTarget.originalId}.png`,
            aspectRatio: editTarget.aspectRatio || undefined,
            characterId: editTarget.characterId || undefined,
          }
        }));
        navigateTo('photoMatch');
        setEditTarget(null);
      } catch (err) {
        notify(err.message || 'Failed to open in Photo Match', 'error');
      } finally {
        setEditDestinationBusy(false);
      }
      return;
    }

    if (destination !== 'nanoBypass') return;

    setEditDestinationBusy(true);
    try {
      const response = await fetch(editTarget.downloadUrl || `/api/gallery/${editTarget.originalId}/image`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(`Failed to load image (${response.status})`);
      }

      const blob = await response.blob();
      const dataUrl = await blobToDataUrl(blob);
      const parsed = parseDataUrl(dataUrl);
      if (!parsed) {
        throw new Error('Could not prepare this image for Nano Bypass');
      }

      navigateTo('nanoBypass', {
        sourceImageBase64: parsed.base64,
        sourceImageMimeType: parsed.mimeType,
        sourceImageName:
          editTarget.metadata?.filename
          || filenameFromUrl(editTarget.downloadUrl)
          || `library-${editTarget.originalId}${extensionFromMimeType(parsed.mimeType) || '.png'}`,
        aspectRatio: editTarget.aspectRatio || 'auto',
      });
      setEditTarget(null);
    } catch (err) {
      notify(err.message || 'Failed to open image in Nano Bypass', 'error');
    } finally {
      setEditDestinationBusy(false);
    }
  }, [editTarget, navigateTo, notify]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.mediaType === 'image') await galleryApi.remove(deleteTarget.originalId);
      else await videoApi.removeHistory(deleteTarget.originalId);
      // ...and out of Eddy's collections, which hold a URL to this image rather than its bytes.
      // Without this the picture is gone but the tiles pointing at it stay, rendering as broken
      // boxes you can still select and still generate from.
      if (deleteTarget.mediaType === 'image') await cascadeDeleteFromCollections([deleteTarget.originalId]);

      setItems((prev) => prev.filter((item) => item.id !== deleteTarget.id));
      setTotals((prev) => ({
        all: Math.max(0, prev.all - 1),
        images: deleteTarget.mediaType === 'image' ? Math.max(0, prev.images - 1) : prev.images,
        videos: deleteTarget.mediaType === 'video' ? Math.max(0, prev.videos - 1) : prev.videos,
      }));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget.id);
        return next;
      });
      notify(`${deleteTarget.mediaType === 'image' ? 'Image' : 'Video'} deleted`, 'success');
    } catch (err) {
      notify(err.message || 'Delete failed', 'error');
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, notify]);

  const openImage = useCallback((item) => {
    const index = imageItems.findIndex((entry) => entry.id === item.id);
    openLightbox(imagePreviewUrls, index >= 0 ? index : 0);
  }, [imageItems, imagePreviewUrls, openLightbox]);

  /**
   * Download ONE image.
   *
   * A bare `<a download>` does not save in Electron -- it navigates, so the click did nothing
   * visible and no file arrived (owner, 2026-08-10). VideoLibraryCard.handleDownload in this same
   * file already said so in a comment and already did it the other way; the image path had simply
   * never been brought across.
   *
   * Fetch the bytes and hand them to downloadBlob, which is also what strips generator metadata
   * and stamps a fresh capture time -- so a single download now gets the same treatment as a bulk
   * one instead of quietly shipping EXIF that says which model made it.
   */
  const handleImageDownload = useCallback(async (item) => {
    const spoof = spoofAvailable && spoofEnabled;
    const url = spoof
      ? galleryApi.spoofedDownloadUrl(item.originalId)
      : (item.downloadUrl || `/api/gallery/${item.originalId}/image`);
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
      const blob = await resp.blob();
      const named = filenameFromContentDisposition(resp.headers.get('content-disposition'));
      const fallback = item.metadata?.filename || `image-${item.originalId}.png`;
      await downloadBlob(blob, sanitizeDownloadName(named || fallback));
    } catch (err) {
      notify(err?.message || 'Download failed', 'error');
    }
  }, [spoofAvailable, spoofEnabled, notify]);

  const handleContextAction = useCallback(async (action) => {
    const item = contextMenu?.item;
    if (!item) return;

    if (action === 'open') {
      openImage(item);
      setContextMenu(null);
      return;
    }

    if (action === 'copyPrompt') {
      try {
        await navigator.clipboard.writeText(item.prompt || '');
        notify('Prompt copied', 'success');
      } catch (err) {
        notify(err.message || 'Failed to copy prompt', 'error');
      }
      setContextMenu(null);
      return;
    }

    if (action === 'copyImage') {
      await copyImageFromUrl(item.downloadUrl || `/api/gallery/${item.originalId}/image`, notify);
      setContextMenu(null);
      return;
    }

    if (action === 'download') {
      handleImageDownload(item);
      setContextMenu(null);
      return;
    }

    if (action === 'delete') {
      setDeleteTarget(item);
      setContextMenu(null);
      return;
    }

    if (action === 'imageEditor') {
      navigateTo('imageEditor', { editId: item.originalId });
      setContextMenu(null);
      return;
    }

    if (action === 'carousel') {
      navigateTo('carousel', {
        recreate: true,
        sourceImageId: item.originalId,
        aspectRatio: '4:5',
      });
      setContextMenu(null);
      return;
    }

    if (action === 'photoMatch') {
      setEditDestinationBusy(true);
      try {
        const response = await fetch(item.downloadUrl || `/api/gallery/${item.originalId}/image`, { credentials: 'include' });
        if (!response.ok) throw new Error(`Failed to load image (${response.status})`);
        const blob = await response.blob();
        const dataUrl = await blobToDataUrl(blob);
        const parsed = parseDataUrl(dataUrl);
        if (!parsed) throw new Error('Could not prepare image for Photo Match');
        window.dispatchEvent(new CustomEvent('kyros:use-as-source', {
          detail: {
            base64: parsed.base64,
            mimeType: parsed.mimeType,
            name: item.metadata?.filename || `library-${item.originalId}.png`,
            aspectRatio: item.aspectRatio || undefined,
            characterId: item.characterId || undefined,
          }
        }));
        navigateTo('photoMatch');
        setContextMenu(null);
      } catch (err) {
        notify(err.message || 'Failed to open in Photo Match', 'error');
      } finally {
        setEditDestinationBusy(false);
      }
      return;
    }

    if (action === 'moveToFolder') {
      // Open a mini folder picker for this single item
      setContextMenu(null);
      if (folders.length === 0) {
        notify('Create a folder first using + New Folder', 'info');
        return;
      }
      const itemId = String(item.id || item.originalId);
      // Use the bulk picker with just this item's id pre-set
      setSelectedIds(new Set([item.id]));
      setShowFolderPicker(true);
      return;
    }

    if (action !== 'nanoBypass') return;

    setEditDestinationBusy(true);
    try {
      const response = await fetch(item.downloadUrl || `/api/gallery/${item.originalId}/image`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error(`Failed to load image (${response.status})`);
      const blob = await response.blob();
      const dataUrl = await blobToDataUrl(blob);
      const parsed = parseDataUrl(dataUrl);
      if (!parsed) throw new Error('Could not prepare this image for Nano Bypass');
      navigateTo('nanoBypass', {
        sourceImageBase64: parsed.base64,
        sourceImageMimeType: parsed.mimeType,
        sourceImageName:
          item.metadata?.filename
          || filenameFromUrl(item.downloadUrl)
          || `library-${item.originalId}${extensionFromMimeType(parsed.mimeType) || '.png'}`,
        aspectRatio: item.aspectRatio || 'auto',
      });
    } catch (err) {
      notify(err.message || 'Failed to open image in Nano Bypass', 'error');
    } finally {
      setEditDestinationBusy(false);
      setContextMenu(null);
    }
  }, [contextMenu, handleImageDownload, navigateTo, notify, openImage]);

  const openContextMenu = useCallback((event, item) => {
    event.preventDefault();
    // Store the raw click coordinates — the ImageContextMenu component will
    // measure itself after rendering and reposition to stay in viewport.
    setContextMenu({ item, rawX: event.clientX, rawY: event.clientY });
  }, []);
  const clearFilters = () => {
    setSearchQuery('');
    setSourceFilter('');
    setRatioFilter('');
    setCharacterFilter('');
    setPersonaFilter('');
    setFavoritesOnly(false);
    setTagFilter([]);
    setSortBy('newest');
    setGroupBySession(false);
  };

  const toggleSelection = useCallback((id, isShift = false) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const isSelecting = !next.has(id);

      if (isShift && lastSelectedIdRef.current) {
        const idsList = visibleItems.map((item) => item.id);
        const startIdx = idsList.indexOf(lastSelectedIdRef.current);
        const endIdx = idsList.indexOf(id);

        if (startIdx !== -1 && endIdx !== -1) {
          const minIdx = Math.min(startIdx, endIdx);
          const maxIdx = Math.max(startIdx, endIdx);

          for (let i = minIdx; i <= maxIdx; i++) {
            const currentId = idsList[i];
            if (isSelecting) {
              next.add(currentId);
            } else {
              next.delete(currentId);
            }
          }
        }
      } else {
        if (isSelecting) {
          next.add(id);
        } else {
          next.delete(id);
        }
      }

      lastSelectedIdRef.current = id;
      return next;
    });
  }, [visibleItems]);

  const selectAllVisible = () => setSelectedIds(new Set(visibleItems.map((item) => item.id)));
  const clearSelection = () => {
    setBulkMode(false);
    setSelectedIds(new Set());
  };

  const handleBulkDownload = async (customFolderName) => {
    const selected = items.filter((item) => selectedIds.has(item.id));
    if (selected.length === 0) return;
    setBulkBusy(true);
    try {
      if (isElectron && window.electronAPI?.chooseDownloadFolder && window.electronAPI?.saveFileToFolder) {
        const directory = await window.electronAPI.chooseDownloadFolder({
          title: 'Choose where to save selected library items',
          folderName: (customFolderName && customFolderName.trim()) || bulkFolderName(),
        });
        if (!directory) return;

        let savedCount = 0;
        let failedCount = 0;

        for (const item of selected) {
          try {
            const spoof = item.mediaType === 'image' && spoofAvailable && spoofEnabled;
            const downloadUrl = spoof ? galleryApi.spoofedDownloadUrl(item.originalId) : item.downloadUrl;
            if (!downloadUrl) throw new Error('No download URL available');

            const response = await fetch(downloadUrl, { credentials: 'include' });
            if (!response.ok) {
              const json = await response.json().catch(() => null);
              throw new Error(json?.error?.message || `Download failed (${response.status})`);
            }

            const contentDispositionName = filenameFromContentDisposition(response.headers.get('content-disposition'));
            let fileName = sanitizeDownloadName(contentDispositionName || buildBulkDownloadName(item, { spoofEnabled: spoof }));
            let blob = await response.blob();

            /**
             * STRIP THE GENERATOR METADATA -- the single-image download always did, this did not.
             *
             * A mass download with spoofing OFF fetched the bytes and wrote them straight to disk,
             * so fifty files landed carrying the EXIF that names the model, and nothing in the
             * filename said so. One image saved from the same page was clean. That is the worst
             * shape for this: the unsafe path is the bulk one, and it looked identical to the safe
             * one (owner, 2026-08-10).
             *
             * Skipped when spoofing is on -- the server has already rebuilt that file as an iPhone
             * photo, complete with the camera EXIF it is supposed to have, and stripping would
             * throw that away. Skipped for video too: stripMetadata returns it untouched, since a
             * container rewrite is a different job.
             */
            if (!spoof && item.mediaType === 'image' && stripEnabled()) {
              const res = await stripMetadata(blob);
              blob = res.blob;
              if (res.cleaned && !/_metadatacleaned/i.test(fileName)) {
                const dot = fileName.lastIndexOf('.');
                fileName = dot > 0
                  ? `${fileName.slice(0, dot)}_metadatacleaned${fileName.slice(dot)}`
                  : `${fileName}_metadatacleaned`;
              }
            }

            const data = new Uint8Array(await blob.arrayBuffer());
            await window.electronAPI.saveFileToFolder({ directory, fileName, data });
            savedCount += 1;
          } catch (err) {
            failedCount += 1;
            console.error('[library] Failed to save selected item', item.id, err);
          }
        }

        if (savedCount > 0 && failedCount === 0) {
          notify(`Saved ${savedCount} item${savedCount === 1 ? '' : 's'} to a folder`, 'success');
        } else if (savedCount > 0) {
          notify(`Saved ${savedCount} item${savedCount === 1 ? '' : 's'}, ${failedCount} failed`, 'info');
        } else {
          throw new Error('No selected items could be saved');
        }
        return;
      }

      const imageIds = selected.filter((item) => item.mediaType === 'image').map((item) => item.originalId);
      const videoIds = selected.filter((item) => item.mediaType === 'video').map((item) => item.originalId);
      if (imageIds.length > 0) await galleryApi.bulkDownload(imageIds, { spoof: spoofAvailable && spoofEnabled });
      if (videoIds.length > 0) await videoApi.bulkDownload(videoIds);
      notify(`Downloading ${selected.length} selected item${selected.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      notify(err.message || 'Bulk download failed', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  // "Save Folder" → on desktop, prompt for a folder name first; on web, just download.
  const openFolderSave = () => {
    if (selectedIds.size === 0) { notify('Select at least one item first', 'error'); return; }
    if (isElectron && window.electronAPI?.chooseDownloadFolder) {
      setFolderNameInput(bulkFolderName());
      setShowFolderModal(true);
    } else {
      handleBulkDownload();
    }
  };

  const confirmFolderSave = () => {
    setShowFolderModal(false);
    handleBulkDownload(folderNameInput);
  };

  const handleDragStart = useCallback((e, item) => {
    const dragItems = bulkMode && selectedIds.has(item.id)
      ? items.filter((x) => selectedIds.has(x.id))
      : [item];

    if (isElectron && window.electronAPI?.startDragFiles) {
      const paths = dragItems
        .map((x) => resolvedPathsRef.current[x.id])
        .filter(Boolean);

      if (paths.length > 0) {
        e.preventDefault();
        window.electronAPI.startDragFiles({ paths });
        return;
      }
    }

    const payload = {
      type: 'kyros-library-items',
      items: dragItems.map((x) => ({
        id: x.id,
        name: x.metadata?.filename || `library-${x.originalId}.png`,
        previewUrl: x.previewUrl,
        downloadUrl: x.downloadUrl,
      })),
    };

    e.dataTransfer.setData('application/json', JSON.stringify(payload));

    const urls = dragItems.map((x) => window.location.origin + x.previewUrl).join('\n');
    e.dataTransfer.setData('text/uri-list', urls);
    e.dataTransfer.setData('text/plain', urls);
    e.dataTransfer.effectAllowed = 'copy';
  }, [bulkMode, selectedIds, items, isElectron]);

  const sendSelectedTo = useCallback(async (page) => {
    const selected = items.filter((item) => selectedIds.has(item.id) && item.mediaType === 'image');
    if (selected.length === 0) {
      notify('Select at least one image first', 'error');
      return;
    }

    setBulkBusy(true);
    try {
      const itemsPayload = [];
      for (const item of selected) {
        const response = await fetch(item.downloadUrl || `/api/gallery/${item.originalId}/image`, { credentials: 'include' });
        if (!response.ok) continue;
        const blob = await response.blob();
        const dataUrl = await blobToDataUrl(blob);
        itemsPayload.push({
          dataUrl,
          name: item.metadata?.filename || `library-${item.originalId}.png`,
        });
      }

      if (itemsPayload.length === 0) {
        throw new Error('Failed to load any of the selected images');
      }

      const sendCfg = {
        photoMatch: { event: 'kyros:use-as-photo-match-source', label: 'Photo Match' },
        scene: { event: 'kyros:use-as-scene-source', label: 'Scene Recreate' },
        poseFix: { event: 'kyros:use-as-pose-fix-source', label: 'Pose Remix' },
        // Seedream tools — the page keys match each tool's consumeSourceHandoff() key.
        seedreamEdit: { event: 'kyros:use-as-seedream-edit-source', label: 'Seedream 5 Pro' },
        outfitSwapSeedream: { event: 'kyros:use-as-outfit-swap-seedream-source', label: 'Outfit Swap · Seedream' },
        photoMatchSeedream: { event: 'kyros:use-as-photo-match-seedream-source', label: 'Photo Match · Seedream' },
        sceneRecreateSeedream: { event: 'kyros:use-as-scene-recreate-seedream-source', label: 'Scene Recreate · Seedream' },
        poseRemixSeedream: { event: 'kyros:use-as-pose-remix-seedream-source', label: 'Pose Remix · Seedream' },
      }[page] || { event: 'kyros:use-as-scene-source', label: 'Scene Recreate' };
      const eventName = sendCfg.event;

      // NOTE: we deliver the images via the event below only. We deliberately do NOT
      // also write a localStorage handoff — the destination pages persist to IndexedDB
      // and migrate any localStorage sources on mount, which would re-add these and
      // produce duplicates.

      stashSourceHandoff(page, itemsPayload.map((it) => ({ dataUrl: it.dataUrl, name: it.name })));
      navigateTo(handoffDestination(page));
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent(eventName, { detail: { items: itemsPayload } }));
      }, 200);

      notify(`${itemsPayload.length} image${itemsPayload.length === 1 ? '' : 's'} sent to ${sendCfg.label} ⚡`, 'success');
      clearSelection();
    } catch (err) {
      notify(err.message || 'Failed to send images', 'error');
    } finally {
      setBulkBusy(false);
    }
  }, [items, selectedIds, notify, navigateTo]);

  const handleBulkDelete = async () => {
    const selected = items.filter((item) => selectedIds.has(item.id));
    if (selected.length === 0) return;
    setBulkBusy(true);
    try {
      const imageIds = selected.filter((item) => item.mediaType === 'image').map((item) => item.originalId);
      const videos = selected.filter((item) => item.mediaType === 'video');
      if (imageIds.length > 0) await galleryApi.bulkRemove(imageIds);
      for (const videoItem of videos) {
        await videoApi.removeHistory(videoItem.originalId);
      }
      if (imageIds.length > 0) await cascadeDeleteFromCollections(imageIds);
      setItems((prev) => prev.filter((item) => !selectedIds.has(item.id)));
      setTotals((prev) => ({
        all: Math.max(0, prev.all - selected.length),
        images: Math.max(0, prev.images - imageIds.length),
        videos: Math.max(0, prev.videos - videos.length),
      }));
      notify(`Deleted ${selected.length} selected item${selected.length === 1 ? '' : 's'}`, 'success');
      clearSelection();
      setBulkDeleteTarget(false);
    } catch (err) {
      notify(err.message || 'Bulk delete failed', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="space-y-5 animate-in relative"
      onDragEnter={handlePageDragEnter}
      onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault(); }}
      onDragLeave={handlePageDragLeave}
      onDrop={handlePageDrop}
    >
      {/* ── FOLDER STRIP ── always visible at top */}
      <div className="flex items-center gap-2 flex-wrap pb-1 border-b border-zinc-800/50">
        <button type="button" onClick={() => setActiveFolderId(null)}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition cursor-pointer ${
            activeFolderId === null ? 'bg-rose-600/20 border border-rose-500/50 text-rose-300' : 'border border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
          }`}>📂 All items</button>

        {folders.map(f => (
          <div key={f.id} className="group relative flex items-center">
            {renamingFolderId === f.id ? (
              <input autoFocus value={renameFolderText} onChange={e => setRenameFolderText(e.target.value)}
                onBlur={() => renameFolder(f.id)}
                onKeyDown={e => { if (e.key === 'Enter') renameFolder(f.id); if (e.key === 'Escape') setRenamingFolderId(null); }}
                className="h-8 w-32 rounded-lg border border-zinc-600 bg-zinc-800 px-2 text-xs text-zinc-200 outline-none" />
            ) : (
              <button type="button" onClick={() => setActiveFolderId(f.id)}
                onDoubleClick={() => { setRenamingFolderId(f.id); setRenameFolderText(f.name); }}
                title="Click to filter · Double-click to rename"
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition cursor-pointer ${
                  activeFolderId === f.id ? 'border text-white' : 'border border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                }`}
                style={activeFolderId === f.id ? { borderColor: f.color, background: f.color + '22', color: f.color } : {}}>
                <span>📁</span>
                {f.name}
                <span className="text-[0.625rem] opacity-60">{(f.itemIds||[]).length}</span>
              </button>
            )}
            <button type="button" onClick={() => deleteFolder(f.id)} title="Delete folder"
              className="absolute -right-1.5 -top-1.5 hidden group-hover:flex h-4 w-4 items-center justify-center rounded-full bg-zinc-700 text-[0.5625rem] text-zinc-300 hover:bg-red-600 hover:text-white transition cursor-pointer">✕</button>
          </div>
        ))}

        {showNewFolderInput ? (
          <input autoFocus value={newFolderName} onChange={e => setNewFolderName(e.target.value)}
            onBlur={() => { if (newFolderName.trim()) createFolder(); else setShowNewFolderInput(false); }}
            onKeyDown={e => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') { setShowNewFolderInput(false); setNewFolderName(''); } }}
            placeholder="Folder name…"
            className="h-8 w-36 rounded-lg border border-zinc-600 bg-zinc-800 px-2 text-xs text-zinc-200 outline-none focus:border-rose-500/60" />
        ) : (
          <button type="button" onClick={() => setShowNewFolderInput(true)}
            className="flex items-center gap-1 rounded-lg border border-dashed border-zinc-700/60 px-3 py-1.5 text-sm text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 transition cursor-pointer">+ New Folder</button>
        )}

        {/* Upload button */}
        <button type="button" onClick={() => uploadInputRef.current?.click()}
          disabled={isUploading}
          title="Import photos into Library"
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-700/60 px-3 py-1.5 text-sm text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition cursor-pointer disabled:opacity-50"
        >
          {isUploading ? <span className="text-[0.6875rem] animate-pulse">Uploading…</span> : <><span>⬆</span> Import</>}
        </button>
      </div>
      <div className="sticky top-0 z-40 -mx-2 space-y-4 border-b border-zinc-800/70 bg-[#070b12]/95 px-2 py-3 backdrop-blur-xl supports-[backdrop-filter]:bg-[#070b12]/80">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-zinc-500 text-sm">
              {totals.all} items in your library
              {filteredItems.length !== totals.all ? ` · ${filteredItems.length} matching` : ''}
              {!groupBySession && visibleCount < filteredItems.length ? ` · Showing ${visibleCount}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* "iPhone" said which device, not what the switch does. It is a metadata cleaner:
                every tag the generator wrote is removed and replaced with the ordinary EXIF a phone
                photo carries -- camera, lens, capture time. Off still strips (see the bulk save),
                it just does not add the camera back. */}
            {showSpoofToggle ? (
              <Toggle
                checked={spoofEnabled}
                onChange={setSpoofEnabled}
                label="Clean metadata"
                title="Removes the generator metadata and saves as a normal iPhone 17 Pro Max photo with a recent capture time. Off: metadata is still removed, but no camera details are added."
              />
            ) : null}
            {MEDIA_FILTERS.map((filter) => {
              const count = filter.value === 'all' ? totals.all : filter.value === 'image' ? totals.images : totals.videos;
              return (
                <button
                  key={filter.value}
                  type="button"
                  onClick={() => setMediaFilter(filter.value)}
                  className={`rounded-lg border px-3 py-2 text-sm transition ${
                    mediaFilter === filter.value
                      ? 'border-rose-500/50 bg-rose-500/10 text-rose-400'
                      : 'border-zinc-700/70 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                  }`}
                >
                  {filter.label} <span className="text-zinc-500">{count}</span>
                </button>
              );
            })}
            {bulkMode ? (
              <>
                <span className="text-sm text-zinc-400">{selectedIds.size} selected</span>
                <Btn variant="secondary" onClick={selectedIds.size === visibleItems.length && visibleItems.length > 0 ? clearSelection : selectAllVisible} disabled={bulkBusy}>
                  {selectedIds.size === visibleItems.length && visibleItems.length > 0 ? 'Deselect' : 'Select All'}
                </Btn>
                <Btn variant="secondary" onClick={() => sendSelectedTo('seedreamEdit')} disabled={selectedIds.size === 0 || bulkBusy}>→ Seedream 5 Pro</Btn>
                <Btn variant="secondary" onClick={() => sendSelectedTo('outfitSwapSeedream')} disabled={selectedIds.size === 0 || bulkBusy}>→ Outfit Swap</Btn>
                <Btn variant="secondary" onClick={() => sendSelectedTo('photoMatchSeedream')} disabled={selectedIds.size === 0 || bulkBusy}>→ Photo Match (SD)</Btn>
                <Btn variant="secondary" onClick={() => sendSelectedTo('sceneRecreateSeedream')} disabled={selectedIds.size === 0 || bulkBusy}>→ Scene (SD)</Btn>
                <Btn variant="secondary" onClick={() => sendSelectedTo('poseRemixSeedream')} disabled={selectedIds.size === 0 || bulkBusy}>→ Pose (SD)</Btn>
                <Btn variant="secondary" onClick={() => sendSelectedTo('photoMatch')} disabled={selectedIds.size === 0 || bulkBusy}>→ Photo Match</Btn>
                <Btn variant="secondary" onClick={() => sendSelectedTo('poseFix')} disabled={selectedIds.size === 0 || bulkBusy}>→ Pose Remix</Btn>
                <Btn variant="secondary" onClick={() => sendSelectedTo('scene')} disabled={selectedIds.size === 0 || bulkBusy}>→ Scene Recreate</Btn>
                <Btn variant="secondary" onClick={openFolderSave} disabled={selectedIds.size === 0 || bulkBusy}>{isElectron ? 'Save Folder' : 'Download'}</Btn>
                {/* Send to Folder */}
                <div className="relative" ref={folderPickerRef}>
                  <Btn variant="secondary" onClick={() => setShowFolderPicker(p => !p)} disabled={selectedIds.size === 0 || bulkBusy}>📁 Send to Folder</Btn>
                  {showFolderPicker && (
                    <div className="absolute right-0 top-full mt-1 z-50 w-52 rounded-xl border border-zinc-700/60 bg-zinc-900/98 shadow-2xl p-1.5 backdrop-blur-xl">
                      {folders.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-zinc-500">No folders yet. Create one first.</p>
                      ) : folders.map(f => (
                        <button key={f.id} type="button" onClick={() => addItemsToFolder(f.id, Array.from(selectedIds).map(String))}
                          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[0.8125rem] text-zinc-300 hover:bg-white/[0.07] transition cursor-pointer">
                          <span style={{ color: f.color }}>📁</span>
                          <span className="truncate">{f.name}</span>
                          <span className="ml-auto text-[0.625rem] text-zinc-600">{(f.itemIds||[]).length}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Btn variant="danger" onClick={() => setBulkDeleteTarget(true)} disabled={selectedIds.size === 0 || bulkBusy}>Delete</Btn>
                <Btn variant="secondary" onClick={clearSelection} disabled={bulkBusy}>Cancel</Btn>
              </>
            ) : (
              <Btn variant="secondary" onClick={() => setBulkMode(true)} disabled={loading || filteredItems.length === 0}>Select</Btn>
            )}
            <Btn variant="secondary" onClick={load} disabled={loading}>
              {loading ? <Spinner size={14} /> : 'Refresh'}
            </Btn>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search prompts..."
            className="h-10 min-w-[220px] flex-1 rounded-lg border border-zinc-700/70 bg-zinc-900/60 px-3 text-sm text-zinc-200 placeholder:text-zinc-500 outline-none transition hover:border-zinc-600 focus:border-rose-500/70 focus:ring-2 focus:ring-rose-500/20"
          />
          <button
            type="button"
            onClick={() => setShowFilters((prev) => !prev)}
            className={`h-10 rounded-lg border px-3 text-sm transition ${
              showFilters || hasActiveFilters
                ? 'border-rose-500/50 bg-rose-500/10 text-rose-400'
                : 'border-zinc-700/70 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
            }`}
          >
            Filters
          </button>
          <button
            type="button"
            onClick={() => setFavoritesOnly((prev) => !prev)}
            className={`h-10 w-10 rounded-lg border text-lg transition ${
              favoritesOnly
                ? 'border-yellow-500/50 bg-yellow-500/10 text-yellow-400'
                : 'border-zinc-700/70 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
            }`}
            aria-label={favoritesOnly ? 'Show all items' : 'Show favorites only'}
          >
            {favoritesOnly ? '\u2605' : '\u2606'}
          </button>
        </div>
      </div>

      {showFilters ? (
        <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/50 p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="h-9 rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-3 text-sm text-zinc-300 outline-none">
              <option value="">All sources</option>
              {availableSources.map((source) => <option key={source} value={source}>{source}</option>)}
            </select>
            <select value={ratioFilter} onChange={(e) => setRatioFilter(e.target.value)} className="h-9 rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-3 text-sm text-zinc-300 outline-none">
              <option value="">All ratios</option>
              {availableRatios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
            </select>
            <select value={characterFilter} onChange={(e) => setCharacterFilter(e.target.value)} className="h-9 rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-3 text-sm text-zinc-300 outline-none">
              <option value="">All characters</option>
              {availableCharacterIds.map((characterId) => {
                const character = characters.find((entry) => entry.id === characterId);
                return <option key={characterId} value={characterId}>{character?.name || characterId}</option>;
              })}
            </select>
            <select value={personaFilter} onChange={(e) => setPersonaFilter(e.target.value)} className="h-9 rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-3 text-sm text-zinc-300 outline-none">
              <option value="">All themes</option>
              {availablePersonas.map((persona) => <option key={persona} value={persona}>{PERSONA_LABELS[persona] || persona}</option>)}
            </select>
            <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className="h-9 rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-3 text-sm text-zinc-300 outline-none">
              <option value="all">Any date</option>
              <option value="today">Today</option>
              <option value="week">Last 7 days</option>
              <option value="month">Last 30 days</option>
            </select>
            <button
              type="button"
              onClick={() => canGroupSessions && setGroupBySession((prev) => !prev)}
              disabled={!canGroupSessions}
              className={`h-9 rounded-lg border px-3 text-sm transition ${
                groupBySession
                  ? 'border-rose-500/50 bg-rose-500/10 text-rose-400'
                  : 'border-zinc-700/70 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed'
              }`}
            >
              Group sessions
            </button>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-zinc-500">Sort:</span>
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setSortBy(option.value)}
                  className={`rounded-md px-2 py-1 text-xs transition ${
                    sortBy === option.value ? 'bg-rose-600/30 text-rose-300' : 'bg-zinc-800/90 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {hasActiveFilters ? <button type="button" onClick={clearFilters} className="ml-auto text-xs text-zinc-500 hover:text-zinc-300 transition">Clear all</button> : null}
          </div>
          {availableTags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-zinc-500">Tags:</span>
              {availableTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setTagFilter((prev) => prev.includes(tag) ? prev.filter((entry) => entry !== tag) : [...prev, tag])}
                  className={`rounded-full border px-2 py-0.5 text-[0.6875rem] transition ${
                    tagFilter.includes(tag) ? 'border-rose-500/50 bg-rose-500/10 text-rose-300' : 'border-zinc-700/70 bg-zinc-800/80 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {loading ? (
        <div className="flex items-center justify-center py-20"><Spinner size={32} /></div>
      ) : filteredItems.length === 0 ? (
        <Empty
          icon={items.length === 0 ? 'image' : 'search'}
          title={items.length === 0 ? 'Library is empty' : 'No content matches'}
          subtitle={items.length === 0 ? 'Your generated images and videos will appear here' : 'Try adjusting your filters or search'}
        />
      ) : groupBySession && groupedSessions.length > 0 ? (
        <div className="space-y-4">
          {groupedSessions.map((group) => (
            <div key={group.id} className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-700/40 bg-zinc-800/30">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge color={group.sessionId ? 'blue' : 'zinc'}>{group.items.length} images</Badge>
                  {group.source ? <span className="text-xs text-zinc-400">{group.source}</span> : null}
                  <span className="text-[0.625rem] text-zinc-500">{formatDate(group.createdAt)}</span>
                </div>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2 p-2">
                {group.items.map((item) => (
                  <div
                    key={item.id}
                    data-library-item-id={item.id}
                    className="relative rounded-lg overflow-hidden border border-zinc-800/60 bg-zinc-950 group"
                    onMouseEnter={() => handleItemMouseEnter(item)}
                    onMouseDown={() => handleItemMouseDown(item)}
                  >
                    <img
                      src={item.thumbnailUrl || item.previewUrl}
                      alt={item.prompt ? item.prompt.slice(0, 80) : 'Generated image'}
                      className="w-full aspect-square object-cover cursor-pointer transition-transform duration-300 group-hover:scale-[1.03]"
                      loading="lazy"
                      onClick={(e) => bulkMode ? toggleSelection(item.id, e.shiftKey) : openImage(item)}
                      draggable="true"
                      onDragStart={(event) => handleDragStart(event, item)}
                    />
                    {bulkMode ? (
                      <button
                        type="button"
                        onClick={(e) => toggleSelection(item.id, e.shiftKey)}
                        className={`absolute top-2 left-2 h-7 w-7 rounded-md border-2 flex items-center justify-center text-xs ${
                          selectedIds.has(item.id) ? 'border-rose-500 bg-rose-500 text-white' : 'border-zinc-400 bg-black/40 text-transparent'
                        }`}
                      >
                        {selectedIds.has(item.id) ? '\u2713' : ''}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {visibleItems.map((item) => (
            item.mediaType === 'image' ? (
              <ImageLibraryCard
                key={item.id}
                item={item}
                bulkMode={bulkMode}
                selected={selectedIds.has(item.id)}
                notify={notify}
                onSelect={(e) => toggleSelection(item.id, e?.shiftKey)}
                onOpen={() => openImage(item)}
                onContextMenu={(event) => openContextMenu(event, item)}
                onFavorite={() => handleImageFavorite(item)}
                onDelete={() => setDeleteTarget(item)}
                onDownload={() => handleImageDownload(item)}
                onEdit={() => handleOpenEditChooser(item)}
                onDragStart={(event) => handleDragStart(event, item)}
                onMouseEnter={() => handleItemMouseEnter(item)}
                onMouseDown={() => handleItemMouseDown(item)}
              />
            ) : (
              <VideoLibraryCard
                key={item.id}
                item={item}
                bulkMode={bulkMode}
                selected={selectedIds.has(item.id)}
                notify={notify}
                onSelect={(e) => toggleSelection(item.id, e?.shiftKey)}
                expanded={expandedVideoId === item.id}
                onToggle={() => setExpandedVideoId((prev) => prev === item.id ? null : item.id)}
                onDelete={() => setDeleteTarget(item)}
                onEdit={() => navigateTo('videoEditor', { filename: item.metadata?.filename })}
                onDragStart={(event) => handleDragStart(event, item)}
                onMouseEnter={() => handleItemMouseEnter(item)}
                onMouseDown={() => handleItemMouseDown(item)}
              />
            )
          ))}
        </div>
      )}

      {!groupBySession && visibleCount < filteredItems.length ? <div ref={sentinelRef} className="h-px" /> : null}

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

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={`Delete ${deleteTarget?.mediaType === 'video' ? 'video' : 'image'}?`}
        message="This will permanently remove the item from your library. This cannot be undone."
        confirmLabel="Delete"
      />

      <ConfirmDialog
        open={bulkDeleteTarget}
        onClose={() => setBulkDeleteTarget(false)}
        onConfirm={handleBulkDelete}
        title="Delete selected items?"
        message={`This will permanently remove ${selectedIds.size} selected item${selectedIds.size === 1 ? '' : 's'}.`}
        confirmLabel="Delete selected"
      />

      <Modal open={!!editTarget} onClose={() => !editDestinationBusy && setEditTarget(null)} title="Edit This Image">
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">
            Choose where you want to edit this image.
          </p>
          <div className="grid gap-3">
            <button
              type="button"
              onClick={() => handleEditDestination('carousel')}
              disabled={editDestinationBusy}
              className="rounded-xl border border-zinc-700/60 bg-zinc-900/70 p-4 text-left transition hover:border-rose-500/40 hover:bg-zinc-800/80 disabled:opacity-60"
            >
              <p className="text-sm font-semibold text-zinc-100">Carousel</p>
              <p className="mt-1 text-xs text-zinc-500">Create follow-up slides and variations from this image.</p>
            </button>
            <button
              type="button"
              onClick={() => handleEditDestination('photoMatch')}
              disabled={editDestinationBusy}
              className="rounded-xl border border-zinc-700/60 bg-zinc-900/70 p-4 text-left transition hover:border-teal-500/40 hover:bg-zinc-800/80 disabled:opacity-60"
            >
              <p className="text-sm font-semibold text-zinc-100">Photo Match →</p>
              <p className="mt-1 text-xs text-zinc-500">Use this image as source in Photo Match to recreate the scene with your character.</p>
            </button>
            <button
              type="button"
              onClick={() => handleEditDestination('nanoBypass')}
              disabled={editDestinationBusy}
              className="rounded-xl border border-zinc-700/60 bg-zinc-900/70 p-4 text-left transition hover:border-rose-500/40 hover:bg-zinc-800/80 disabled:opacity-60"
            >
              <p className="text-sm font-semibold text-zinc-100">Nano Bypass</p>
              <p className="mt-1 text-xs text-zinc-500">Load this image into multi-image editing and prompt-based changes.</p>
            </button>
            <button
              type="button"
              onClick={() => handleEditDestination('imageEditor')}
              disabled={editDestinationBusy}
              className="rounded-xl border border-zinc-700/60 bg-zinc-900/70 p-4 text-left transition hover:border-rose-500/40 hover:bg-zinc-800/80 disabled:opacity-60"
            >
              <p className="text-sm font-semibold text-zinc-100">Image Editor</p>
              <p className="mt-1 text-xs text-zinc-500">Open the built-in editor for filters and saved edit presets.</p>
            </button>
          </div>
          {editDestinationBusy ? (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Spinner size={14} />
              Preparing image...
            </div>
          ) : null}
        </div>
      </Modal>

      {bulkMode ? (
        <div className="fixed bottom-4 right-4 z-[100] flex max-w-[calc(100vw-2rem)] flex-wrap items-center justify-end gap-2 rounded-2xl border border-zinc-700/60 bg-zinc-900/[0.97] px-4 py-2.5 shadow-2xl shadow-black/50 backdrop-blur-xl">
          <span className="text-sm text-zinc-400 whitespace-nowrap">{selectedIds.size} selected</span>
          <div className="h-4 w-px bg-zinc-700/60" />
          <Btn variant="secondary" className="!px-3 !py-1.5 !text-xs" onClick={selectedIds.size === visibleItems.length && visibleItems.length > 0 ? clearSelection : selectAllVisible} disabled={bulkBusy}>
            {selectedIds.size === visibleItems.length && visibleItems.length > 0 ? 'Deselect' : 'Select All'}
          </Btn>
          <Btn variant="secondary" className="!px-3 !py-1.5 !text-xs" onClick={() => sendSelectedTo('photoMatch')} disabled={selectedIds.size === 0 || bulkBusy}>→ Photo Match</Btn>
          <Btn variant="secondary" className="!px-3 !py-1.5 !text-xs" onClick={() => sendSelectedTo('poseFix')} disabled={selectedIds.size === 0 || bulkBusy}>→ Pose Remix</Btn>
          <Btn variant="secondary" className="!px-3 !py-1.5 !text-xs" onClick={() => sendSelectedTo('scene')} disabled={selectedIds.size === 0 || bulkBusy}>→ Scene Recreate</Btn>
          <Btn variant="secondary" className="!px-3 !py-1.5 !text-xs" onClick={openFolderSave} disabled={selectedIds.size === 0 || bulkBusy}>{isElectron ? 'Save Folder' : 'Download'}</Btn>
          <Btn variant="danger" className="!px-3 !py-1.5 !text-xs" onClick={() => setBulkDeleteTarget(true)} disabled={selectedIds.size === 0 || bulkBusy}>Delete</Btn>
          <Btn variant="secondary" className="!px-3 !py-1.5 !text-xs" onClick={clearSelection} disabled={bulkBusy}>Cancel</Btn>
        </div>
      ) : !loading && filteredItems.length > 0 ? (
        <button
          type="button"
          onClick={() => setBulkMode(true)}
          className="fixed bottom-4 right-4 z-[100] rounded-2xl border border-rose-500/50 bg-rose-600 px-5 py-3 text-sm font-semibold text-white shadow-2xl shadow-rose-950/50 transition hover:bg-rose-500"
        >
          Select
        </button>
      ) : null}

      <LightboxComponent />
      <ImageContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} onAction={handleContextAction} />

      {/* Drag-and-drop file import overlay */}
      {isDroppingFile && (
        <div className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-rose-500/70 bg-zinc-900/90 px-16 py-10 shadow-2xl">
            <span className="text-4xl">📥</span>
            <p className="text-lg font-semibold text-rose-300">Drop to import into Library</p>
            <p className="text-sm text-zinc-500">JPEG, PNG, WebP supported</p>
          </div>
        </div>
      )}

      {/* Hidden file input for click-to-import */}
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files?.length) { uploadFiles(e.target.files); e.target.value = ''; } }}
      />


      {showFolderModal && createPortal((
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" onClick={() => setShowFolderModal(false)}>
          <div className="w-full max-w-sm rounded-2xl border border-zinc-700/70 bg-zinc-950 p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-zinc-100">Name the folder</h3>
            <p className="mt-1 text-[0.6875rem] text-zinc-500">{selectedIds.size} item{selectedIds.size === 1 ? '' : 's'} will be saved into this folder.</p>
            <input
              autoFocus
              value={folderNameInput}
              onChange={(e) => setFolderNameInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && folderNameInput.trim()) confirmFolderSave(); if (e.key === 'Escape') setShowFolderModal(false); }}
              placeholder="Folder name"
              className="mt-3 w-full rounded-lg border border-zinc-700/60 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-rose-500/60"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setShowFolderModal(false)} className="rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:border-zinc-500">Cancel</button>
              <Btn onClick={confirmFolderSave} disabled={!folderNameInput.trim()}>Save Folder</Btn>
            </div>
          </div>
        </div>
      ), document.body)}
    </div>
  );
}

function ImageLibraryCard({ item, bulkMode, selected, onSelect, onOpen, onFavorite, onDelete, onDownload, onEdit, onContextMenu, onDragStart, onMouseEnter, onMouseDown, notify }) {
  return (
    <div data-library-item-id={item.id} className={`rounded-2xl overflow-hidden bg-zinc-900 border shadow-lg hover:shadow-xl transition-all duration-300 group ${
      selected ? 'border-rose-500 ring-2 ring-rose-500/30' : 'border-zinc-800/60'
    }`}
    onContextMenu={bulkMode ? undefined : onContextMenu}
    onMouseEnter={onMouseEnter}
    onMouseDown={onMouseDown}
    >
      <div className="relative bg-zinc-950 overflow-hidden">
        <img
          src={item.previewUrl}
          alt={item.prompt ? item.prompt.slice(0, 120) : 'Generated image'}
          className="w-full aspect-[4/5] object-cover cursor-pointer transition-transform duration-300 group-hover:scale-[1.02]"
          loading="lazy"
          onClick={bulkMode ? (e) => onSelect(e) : onOpen}
          draggable="true"
          onDragStart={onDragStart}
        />
        {bulkMode ? (
          <button
            type="button"
            onClick={(e) => onSelect(e)}
            className={`absolute top-2 left-2 h-8 w-8 rounded-md border-2 flex items-center justify-center ${
              selected ? 'border-rose-500 bg-rose-500 text-white' : 'border-zinc-400 bg-black/40 text-transparent'
            }`}
          >
            {selected ? '\u2713' : ''}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onFavorite}
          className={`absolute top-2 right-2 h-8 w-8 rounded-full flex items-center justify-center transition ${
            item.favorite ? 'bg-yellow-500/20 text-yellow-400' : 'bg-black/40 text-white/70 hover:text-yellow-400'
          }`}
          aria-label={item.favorite ? 'Unfavorite' : 'Favorite'}
        >
          {item.favorite ? '\u2605' : '\u2606'}
        </button>
      </div>
      <div className="px-3 py-3 space-y-2">
        <PromptSnippet prompt={item.prompt} notify={notify} />
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[0.625rem] text-zinc-500">{formatDate(item.createdAt)}</span>
          <Badge color="blue">Image</Badge>
          {item.aspectRatio ? <Badge color="zinc">{item.aspectRatio}</Badge> : null}
          {item.source ? <Badge color="zinc">{item.source}</Badge> : null}
          {item.metadata?.fileSize ? <span className="text-[0.625rem] text-zinc-600">{formatBytes(item.metadata.fileSize)}</span> : null}
        </div>
        {item.tags?.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {item.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="text-[0.625rem] rounded-full px-1.5 py-0.5 bg-zinc-700/30 text-zinc-400 border border-zinc-600/20">
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        {!bulkMode ? (
          <div className="flex gap-2 flex-wrap">
            <Btn variant="secondary" className="!px-3 !py-1.5 !text-xs" onClick={onEdit}>Edit</Btn>
            <button type="button" onClick={onDownload} className="inline-flex items-center justify-center rounded-lg border border-zinc-700/60 bg-zinc-800/80 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700/80 hover:border-zinc-600">Download</button>
            <Btn variant="danger" className="!px-3 !py-1.5 !text-xs" onClick={onDelete}>Delete</Btn>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function VideoLibraryCard({ item, bulkMode, selected, onSelect, expanded, onToggle, onDelete, onEdit, onDragStart, onMouseEnter, onMouseDown, notify }) {
  const hasFile = !!item.previewUrl;
  // Edit needs the LOCAL mp4 basename (the server resolves it inside the video dir). A remote-only
  // clip has no local file to edit, so the button only shows when we actually have that filename.
  const canEdit = hasFile && !!item.metadata?.filename;
  const statusColor = item.status === 'completed' ? 'green' : item.status === 'failed' ? 'red' : 'blue';

  // A bare <a download> does NOT trigger a save in Electron — it just navigates. Download the bytes
  // via fetch and hand them to downloadBlob (same robust path Video Gallery uses), through the
  // metadata-stripping /clean route when we have the local filename.
  const handleDownload = async () => {
    if (!hasFile) return;
    try {
      const filename = item.metadata?.filename;
      const url = filename ? videoApi.cleanFileUrl(filename) : item.downloadUrl;
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
      const stripped = resp.headers.get('X-Metadata-Stripped') === 'yes';
      const base = filename || `video-${item.originalId}.mp4`;
      const ext = (base.match(/\.[a-z0-9]+$/i) || ['.mp4'])[0];
      const stem = base.slice(0, base.length - ext.length) || 'video';
      const blob = await resp.blob();
      await downloadBlob(blob, `${stem}${filename && stripped ? '_metadatacleaned' : filename ? '_NOT-cleaned' : ''}${ext}`);
      if (filename && !stripped) notify('Metadata could NOT be removed from this clip — saved as _NOT-cleaned. Do not publish as-is.', 'error');
    } catch (err) {
      notify(err?.message || 'Video download failed', 'error');
    }
  };

  return (
    <div
      data-library-item-id={item.id}
      className={`rounded-2xl overflow-hidden bg-zinc-900 border shadow-lg hover:shadow-xl transition-all duration-300 group ${
        selected ? 'border-rose-500 ring-2 ring-rose-500/30' : 'border-zinc-800/60'
      }`}
      onMouseEnter={onMouseEnter}
      onMouseDown={onMouseDown}
    >
      <div className="relative aspect-[3/4] bg-zinc-950 flex items-center justify-center overflow-hidden">
        {hasFile ? (
          <video
            src={item.previewUrl}
            // contain, not cover: these are 9:16 clips in a 16:9 box, so cover cropped the
            // whole subject out. Autoplays muted so the card shows the clip without a click.
            className="w-full h-full object-contain cursor-pointer"
            muted
            loop
            autoPlay
            playsInline
            preload="metadata"
            onClick={bulkMode ? (e) => onSelect(e) : onToggle}
            onMouseEnter={(e) => { if (!bulkMode) e.currentTarget.play().catch(() => {}); }}
            onMouseLeave={(e) => {
              if (!bulkMode) {
                e.currentTarget.pause();
                e.currentTarget.currentTime = 0;
              }
            }}
            draggable="true"
            onDragStart={onDragStart}
          />
        ) : (
          <div className="text-zinc-600 text-xs px-4 text-center">{item.status === 'failed' ? 'Video failed' : 'Video still processing'}</div>
        )}
        <div className="absolute top-2 left-2 flex gap-2">
          <Badge color={statusColor}>{item.status || 'processing'}</Badge>
          <Badge color="zinc">Video</Badge>
        </div>
        {bulkMode ? <button type="button" onClick={(e) => onSelect(e)} className={`absolute top-2 right-2 h-8 w-8 rounded-md border-2 flex items-center justify-center ${selected ? 'border-rose-500 bg-rose-500 text-white' : 'border-zinc-400 bg-black/40 text-transparent'}`}>{selected ? '\u2713' : ''}</button> : null}
      </div>
      <div className="px-3 py-3 space-y-2">
        <PromptSnippet prompt={item.prompt} notify={notify} />
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[0.625rem] text-zinc-500">{formatDate(item.createdAt)}</span>
          {item.metadata?.model ? <Badge color="zinc">{item.metadata.model}</Badge> : null}
          {item.metadata?.duration ? <span className="text-[0.625rem] text-zinc-600">{item.metadata.duration}s</span> : null}
          {item.aspectRatio ? <Badge color="zinc">{item.aspectRatio}</Badge> : null}
        </div>
        {item.metadata?.error ? <p className="text-[0.625rem] text-red-400">{item.metadata.error}</p> : null}
        {!bulkMode ? (
          <div className="flex gap-2 flex-wrap">
            {hasFile ? <button type="button" onClick={handleDownload} className="inline-flex items-center justify-center rounded-lg border border-zinc-700/60 bg-zinc-800/80 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700/80 hover:border-zinc-600 cursor-pointer">Download</button> : null}
            {canEdit ? <Btn className="!px-3 !py-1.5 !text-xs" onClick={onEdit}>Edit</Btn> : null}
            {hasFile ? <Btn variant="secondary" className="!px-3 !py-1.5 !text-xs" onClick={onToggle}>{expanded ? 'Collapse' : 'Expand'}</Btn> : null}
            <Btn variant="danger" className="!px-3 !py-1.5 !text-xs" onClick={onDelete}>Delete</Btn>
          </div>
        ) : null}
        {expanded && hasFile && !bulkMode ? <video src={item.previewUrl} controls autoPlay loop className="w-full rounded-lg border border-zinc-700/60" /> : null}
      </div>
    </div>
  );
}
