import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { gallery as galleryApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { Btn, Spinner, Skeleton, Empty, Badge, Modal, ConfirmDialog, Toggle } from '../components/UI';
import { IconImage, IconMagnifier } from 'nucleo-glass';

const SOURCE_TO_PAGE = {
  'generate': 'generate',
  'batch': 'batch',
  'carousel': 'carousel',
  'scene-recreate': 'scene',
  'post-clone': 'postClone',
  'reel-copy': 'reel',
  'reel-recreate': 'reel',
  'tweak': 'generate',
};

const SOURCE_LABELS = {
  'generate': 'Generate',
  'batch': 'Batch',
  'carousel': 'Carousel',
  'scene-recreate': 'Scene',
  'post-clone': 'Post Clone',
  'reel-copy': 'Reel Copy',
  'reel-recreate': 'Reel',
  'tweak': 'Generate',
};

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'largest', label: 'Largest' },
  { value: 'smallest', label: 'Smallest' },
  { value: 'quality', label: 'Quality Score' },
];

const CATEGORY_TAGS = ['lifestyle', 'personality', 'teasing', 'engagement'];
import useImageLightbox from '../components/lightbox/useImageLightbox';

const PAGE_SIZE = 24;

function PromptDisplay({ prompt, onCopy }) {
  const [expanded, setExpanded] = useState(false);

  if (!prompt) return <p className="text-sm text-zinc-500 italic">No prompt</p>;

  const sections = prompt.split(/\n{2,}|\[(?:END\s)?[A-Z\s/—]+\]/g).map(s => s.trim()).filter(s => s && !s.startsWith('['));
  const isLong = prompt.length > 120;

  if (!expanded) {
    return (
      <div className="group/prompt">
        <p className="text-sm text-zinc-300 line-clamp-2 select-text">{sections[0] || prompt}</p>
        {isLong && (
          <button onClick={() => setExpanded(true)}
            className="text-[0.625rem] text-zinc-600 hover:text-rose-400 transition cursor-pointer mt-0.5">
            Show full prompt
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5 rounded-lg bg-zinc-800/40 border border-zinc-700/40 p-2.5 -mx-1">
      <div className="flex items-center justify-between">
        <span className="text-[0.625rem] text-zinc-500 uppercase tracking-wider">Prompt</span>
        <div className="flex gap-2">
          <button onClick={() => onCopy(prompt)} className="text-[0.625rem] text-rose-400 hover:text-rose-300 transition cursor-pointer">
            Copy all
          </button>
          <button onClick={() => setExpanded(false)} className="text-[0.625rem] text-zinc-500 hover:text-zinc-300 transition cursor-pointer">
            Collapse
          </button>
        </div>
      </div>
      <p className="text-sm text-zinc-300 select-text whitespace-pre-wrap break-words leading-relaxed">
        {prompt}
      </p>
    </div>
  );
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    return decodeURIComponent(parsed.pathname.split('/').pop() || '');
  } catch {
    return '';
  }
}

async function blobToDataUrl(blob) {
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
  return { mimeType: match[1], base64: match[2] };
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

function ContextMenuItem({ icon, label, tone = 'default', ...props }) {
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
    </button>
  );
}

/* Inline SVG icons for context menu */
const ctxIcons = {
  eye: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  clipboard: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>,
  image: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>,
  workflow: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h6v6H3z"/><path d="M15 3h6v6h-6z"/><path d="M9 15h6v6H9z"/><path d="M6 9v3a3 3 0 0 0 3 3h0"/><path d="M18 9v3a3 3 0 0 1-3 3h0"/></svg>,
  edit: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  zap: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  grid: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  download: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  trash: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
  link: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
};

function ImageContextMenu({ menu, onClose, onAction }) {
  useEffect(() => {
    if (!menu) return undefined;
    const handlePointerDown = () => onClose();
    const handleEscape = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handlePointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handlePointerDown, true);
    };
  }, [menu, onClose]);

  if (!menu) return null;

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
    menu.item.resolutionTier || menu.item.imageSize,
    menu.item.imageModel,
  ].filter(Boolean);

  return (
    <div
      className="fixed z-[80] w-60 rounded-2xl border border-zinc-700/50 bg-zinc-900/[0.97] p-1.5 shadow-2xl shadow-black/50 backdrop-blur-2xl"
      style={{
        left: Math.min(menu.x, window.innerWidth - 260),
        top: Math.min(menu.y, window.innerHeight - 420),
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
        {menu.item.sourceUrl && (
          <ContextMenuItem icon={ctxIcons.link} label="Copy source link" onClick={() => onAction('copySourceUrl')} />
        )}
        <div className="my-1 border-t border-zinc-800/80 mx-2" />
        <ContextMenuItem icon={ctxIcons.workflow} label="Open original workflow" onClick={() => onAction('recreate')} />
        <ContextMenuItem icon={ctxIcons.edit} label="Edit in Image Editor" onClick={() => onAction('imageEditor')} />
        <ContextMenuItem icon={ctxIcons.zap} label="Nano Bypass" onClick={() => onAction('nanoBypass')} />
        <ContextMenuItem icon={ctxIcons.grid} label="Go to Carousel" onClick={() => onAction('carousel')} />
        <div className="my-1 border-t border-zinc-800/80 mx-2" />
        <ContextMenuItem icon={ctxIcons.download} label="Download" onClick={() => onAction('download')} />
        <ContextMenuItem icon={ctxIcons.trash} label="Delete" tone="danger" onClick={() => onAction('delete')} />
      </div>
    </div>
  );
}

function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e) => setMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return mobile;
}

const PERSONA_LABELS = {
  'luxury': 'Luxury',
  'of': 'OF Creator',
  'fitness': 'Fitness',
  'girl_next_door': 'Girl Next Door',
  'high_fashion': 'High Fashion',
  'cosplay': 'Cosplay',
  'goth': 'Goth / Alt',
};

export default function GalleryPage() {
  const { notify, navigateTo, characters } = useApp();
  const { run } = useAsync();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const isMobile = useIsMobile();

  const [images, setImages] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadedImages, setLoadedImages] = useState(() => new Set());

  const [searchQuery, setSearchQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [ratioFilter, setRatioFilter] = useState('');
  const [characterFilter, setCharacterFilter] = useState('');
  const [personaFilter, setPersonaFilter] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [sortBy, setSortBy] = useState('newest');

  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [showFilters, setShowFilters] = useState(false);

  const [tagFilter, setTagFilter] = useState([]);
  const [allTags, setAllTags] = useState([]);
  const [groupBySession, setGroupBySession] = useState(false);
  const [editingTagsId, setEditingTagsId] = useState(null);
  const [newTagInput, setNewTagInput] = useState('');
  const [applyingLastId, setApplyingLastId] = useState(null);

  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef(null);
  const [spoofAvailable, setSpoofAvailable] = useState(false);
  const [spoofEnabled, setSpoofEnabled] = useState(true);
  const [contextMenu, setContextMenu] = useState(null);

  const availableSources = useMemo(() => {
    const s = new Set(images.map((i) => i.source).filter(Boolean));
    return [...s].sort();
  }, [images]);

  const availableRatios = useMemo(() => {
    const r = new Set(images.map((i) => i.aspectRatio).filter(Boolean));
    return [...r].sort();
  }, [images]);

  const availableCharacterIds = useMemo(() => {
    const c = new Set(images.map((i) => i.characterId).filter(Boolean));
    return [...c];
  }, [images]);

  const availablePersonas = useMemo(() => {
    const p = new Set(images.map((i) => i.personaMode).filter(Boolean));
    return [...p].sort();
  }, [images]);

  const filteredImages = useMemo(() => {
    let result = images;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((i) => i.prompt?.toLowerCase().includes(q));
    }
    if (sourceFilter) result = result.filter((i) => i.source === sourceFilter);
    if (ratioFilter) result = result.filter((i) => i.aspectRatio === ratioFilter);
    if (characterFilter) result = result.filter((i) => i.characterId === characterFilter);
    if (personaFilter) result = result.filter((i) => i.personaMode === personaFilter);
    if (favoritesOnly) result = result.filter((i) => i.isFavorite);
    if (tagFilter.length > 0) {
      result = result.filter((i) => tagFilter.some(t => Array.isArray(i.tags) && i.tags.includes(t)));
    }

    if (sortBy === 'newest') {
      result = [...result].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } else if (sortBy === 'oldest') {
      result = [...result].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    } else if (sortBy === 'largest') {
      result = [...result].sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0));
    } else if (sortBy === 'smallest') {
      result = [...result].sort((a, b) => (a.fileSize || 0) - (b.fileSize || 0));
    } else if (sortBy === 'quality') {
      result = [...result].sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));
    }
    return result;
  }, [images, searchQuery, sourceFilter, ratioFilter, characterFilter, personaFilter, favoritesOnly, tagFilter, sortBy]);

  const sessionGroups = useMemo(() => {
    if (!groupBySession) return null;
    const groups = new Map();
    for (const img of filteredImages) {
      const key = img.sessionId || `solo-${img.id}`;
      if (!groups.has(key)) groups.set(key, { sessionId: img.sessionId, images: [], source: img.source, createdAt: img.createdAt });
      groups.get(key).images.push(img);
    }
    return [...groups.values()].filter((g) => g.images.length > 0);
  }, [filteredImages, groupBySession]);

  const visibleImages = useMemo(() => filteredImages.slice(0, visibleCount), [filteredImages, visibleCount]);
  const galleryImageUrls = useMemo(() => filteredImages.map((i) => galleryApi.imageUrl(i.id)), [filteredImages]);

  const hasActiveFilters = searchQuery || sourceFilter || ratioFilter || characterFilter || personaFilter || favoritesOnly || tagFilter.length > 0;

  const load = async () => {
    setLoadingList(true);
    try {
      const res = await galleryApi.list();
      setImages(res.images || res || []);
    } catch (err) {
      notify(err?.message || 'Failed to load gallery. Check your server connection.', 'error');
    }
    setLoadingList(false);
  };

  const loadTags = () => { galleryApi.listTags().then(setAllTags).catch(() => {}); };

  useEffect(() => { load(); loadTags(); galleryApi.spoofStatus().then((r) => setSpoofAvailable(r.available)).catch(() => {}); }, []);

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [filteredImages]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visibleCount >= filteredImages.length) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisibleCount((c) => Math.min(c + PAGE_SIZE, filteredImages.length)); },
      { rootMargin: '400px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visibleCount, filteredImages.length]);

  const handleDelete = (id) => run(async () => {
    await galleryApi.remove(id);
    setImages((prev) => prev.filter((i) => i.id !== id));
    setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    notify('Image deleted', 'success');
  });

  const handleDownload = (id, filename) => {
    if (spoofAvailable && spoofEnabled) {
      const a = document.createElement('a');
      a.href = galleryApi.spoofedDownloadUrl(id);
      a.download = '';
      a.click();
    } else {
      const a = document.createElement('a');
      a.href = galleryApi.imageUrl(id);
      a.download = filename || `gallery_${id}.png`;
      a.click();
    }
  };

  const handleToggleFavorite = useCallback((id) => {
    setImages((prev) => prev.map((i) => (i.id === id ? { ...i, isFavorite: !i.isFavorite } : i)));
    galleryApi.toggleFavorite(id).catch(() => {
      setImages((prev) => prev.map((i) => (i.id === id ? { ...i, isFavorite: !i.isFavorite } : i)));
      notify('Failed to update favorite', 'error');
    });
  }, [notify]);

  function copyPromptToClipboard(text) {
    navigator.clipboard.writeText(text)
      .then(() => notify('Prompt copied', 'success'))
      .catch(() => notify('Failed to copy prompt', 'error'));
  }

  function handleRecreate(img) {
    const pageId = SOURCE_TO_PAGE[img.source] || 'generate';
    const label = SOURCE_LABELS[img.source] || 'Generate';
    navigateTo(pageId, {
      recreate: true,
      prompt: img.prompt || '',
      characterId: img.characterId || '',
      aspectRatio: img.aspectRatio || '',
      sourceImageId: img.id,
    });
    notify(`Opened ${label} with settings from this image`, 'info');
  }

  const handleApplyLastEdit = useCallback(async (id) => {
    try {
      const raw = localStorage.getItem('imageEditor_lastEdit');
      if (!raw) { notify('No previous edit found', 'error'); return; }
      const storedValues = JSON.parse(raw);
      setApplyingLastId(id);
      await galleryApi.saveEdit(id, storedValues);
      notify('Last edit applied and saved', 'success');
      load();
    } catch (err) {
      notify(err.message || 'Failed to apply last edit', 'error');
    } finally {
      setApplyingLastId(null);
    }
  }, [notify]);

  const handleContextAction = useCallback(async (action) => {
    const img = contextMenu?.item;
    if (!img) return;

    if (action === 'open') {
      const idx = filteredImages.findIndex((entry) => entry.id === img.id);
      openLightbox(galleryImageUrls, idx >= 0 ? idx : 0);
      setContextMenu(null);
      return;
    }

    if (action === 'copyPrompt') {
      copyPromptToClipboard(img.prompt || '');
      setContextMenu(null);
      return;
    }

    if (action === 'copySourceUrl') {
      if (!img.sourceUrl) { notify('No source link for this image', 'error'); setContextMenu(null); return; }
      navigator.clipboard.writeText(img.sourceUrl)
        .then(() => notify('Source link copied', 'success'))
        .catch((err) => notify(err.message || 'Failed to copy link', 'error'));
      setContextMenu(null);
      return;
    }

    if (action === 'copyImage') {
      await copyImageFromUrl(galleryApi.imageUrl(img.id), notify);
      setContextMenu(null);
      return;
    }

    if (action === 'recreate') {
      handleRecreate(img);
      setContextMenu(null);
      return;
    }

    if (action === 'imageEditor') {
      navigateTo('imageEditor', { editId: img.id });
      setContextMenu(null);
      return;
    }

    if (action === 'carousel') {
      navigateTo('carousel', {
        recreate: true,
        sourceImageId: img.id,
        characterId: img.characterId || '',
        aspectRatio: img.aspectRatio || '',
      });
      setContextMenu(null);
      return;
    }

    if (action === 'download') {
      handleDownload(img.id, img.filename);
      setContextMenu(null);
      return;
    }

    if (action === 'delete') {
      setDeleteConfirmId(img.id);
      setContextMenu(null);
      return;
    }

    if (action !== 'nanoBypass') return;

    try {
      const response = await fetch(galleryApi.imageUrl(img.id), { credentials: 'include' });
      if (!response.ok) throw new Error(`Failed to load image (${response.status})`);
      const blob = await response.blob();
      const dataUrl = await blobToDataUrl(blob);
      const parsed = parseDataUrl(dataUrl);
      if (!parsed) throw new Error('Could not prepare this image for Nano Bypass');
      navigateTo('nanoBypass', {
        sourceImageBase64: parsed.base64,
        sourceImageMimeType: parsed.mimeType,
        sourceImageName: img.filename || filenameFromUrl(galleryApi.imageUrl(img.id)) || `gallery-${img.id}.png`,
        aspectRatio: img.aspectRatio || 'auto',
      });
    } catch (err) {
      notify(err.message || 'Failed to open image in Nano Bypass', 'error');
    } finally {
      setContextMenu(null);
    }
  }, [contextMenu, filteredImages, galleryImageUrls, navigateTo, notify, openLightbox]);

  const toggleSelection = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAll = () => setSelectedIds(new Set(filteredImages.map((i) => i.id)));
  const deselectAll = () => setSelectedIds(new Set());

  const exitBulkMode = () => {
    setBulkMode(false);
    setSelectedIds(new Set());
  };

  const handleBulkDelete = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkLoading(true);
    try {
      await galleryApi.bulkRemove(ids);
      setImages((prev) => prev.filter((i) => !selectedIds.has(i.id)));
      notify(`Deleted ${ids.length} images`, 'success');
      setSelectedIds(new Set());
      setBulkDeleteConfirm(false);
    } catch (err) {
      notify(err.message || 'Bulk delete failed', 'error');
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkDownload = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkLoading(true);
    try {
      await galleryApi.bulkDownload(ids, { spoof: spoofEnabled && spoofAvailable });
      notify(`Downloading ${ids.length} images${spoofEnabled && spoofAvailable ? ' (iPhone spoofed)' : ''}`, 'success');
    } catch (err) {
      notify(err.message || 'Download failed', 'error');
    } finally {
      setBulkLoading(false);
    }
  };

  const clearFilters = () => {
    setSearchQuery('');
    setSourceFilter('');
    setRatioFilter('');
    setCharacterFilter('');
    setPersonaFilter('');
    setFavoritesOnly(false);
    setTagFilter([]);
    setSortBy('newest');
  };

  const handleAddTag = async (id, tag) => {
    if (!tag.trim()) return;
    try {
      const updated = await galleryApi.addTag(id, tag.trim());
      setImages(prev => prev.map(i => i.id === id ? { ...i, tags: updated.tags } : i));
      setNewTagInput('');
      loadTags();
    } catch (err) { notify(err.message || 'Failed to add tag', 'error'); }
  };

  const handleRemoveTag = async (id, tag) => {
    try {
      const updated = await galleryApi.removeTag(id, tag);
      setImages(prev => prev.map(i => i.id === id ? { ...i, tags: updated.tags } : i));
      loadTags();
    } catch (err) { notify(err.message || 'Failed to remove tag', 'error'); }
  };

  const formatDate = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
    <div className="space-y-4 animate-in">
      <div className="flex items-start sm:items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-zinc-500 text-xs sm:text-sm">
            {images.length} images{filteredImages.length !== images.length && ` · ${filteredImages.length} matching`}
            {visibleCount < filteredImages.length && ` · Showing ${visibleCount}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
          {bulkMode ? (
            <>
              <span className="text-xs sm:text-sm text-zinc-400">{selectedIds.size} sel</span>
              <Btn variant="secondary" onClick={selectedIds.size === filteredImages.length ? deselectAll : selectAll} disabled={bulkLoading} className="!px-2.5 !py-1.5 !text-xs sm:!px-4 sm:!py-2.5 sm:!text-sm">
                {selectedIds.size === filteredImages.length ? 'Deselect' : 'Select All'}
              </Btn>
              <Btn variant="secondary" onClick={handleBulkDownload} disabled={selectedIds.size === 0 || bulkLoading} className="!px-2.5 !py-1.5 !text-xs sm:!px-4 sm:!py-2.5 sm:!text-sm">
                DL
              </Btn>
              {spoofAvailable && (
                <Toggle checked={spoofEnabled} onChange={setSpoofEnabled} label="iPhone" />
              )}
              <Btn variant="danger" onClick={() => setBulkDeleteConfirm(true)} disabled={selectedIds.size === 0 || bulkLoading} className="!px-2.5 !py-1.5 !text-xs sm:!px-4 sm:!py-2.5 sm:!text-sm">
                Del
              </Btn>
              <Btn variant="secondary" onClick={exitBulkMode} disabled={bulkLoading} className="!px-2.5 !py-1.5 !text-xs sm:!px-4 sm:!py-2.5 sm:!text-sm">Cancel</Btn>
            </>
          ) : (
            <>
              {spoofAvailable && (
                <Toggle checked={spoofEnabled} onChange={setSpoofEnabled} label="iPhone" />
              )}
              <Btn variant="secondary" onClick={() => setBulkMode(true)} disabled={loadingList || images.length === 0}>Select</Btn>
              <Btn variant="secondary" onClick={load} disabled={loadingList}>Refresh</Btn>
            </>
          )}
        </div>
      </div>

      {images.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-sm pointer-events-none flex items-center [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor]">
                <IconMagnifier uniqueId="gallery-search" size={18} aria-hidden />
              </span>
              <input
                type="text"
                placeholder="Search prompts..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-10 rounded-lg border border-zinc-700/80 bg-zinc-900/60 pl-8 pr-3 text-sm text-zinc-200 placeholder:text-zinc-500 outline-none transition-all duration-200 hover:border-zinc-600 focus:border-rose-500/70 focus:ring-2 focus:ring-rose-500/20"
              />
            </div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`h-10 rounded-lg border px-3 text-sm transition cursor-pointer flex items-center gap-1.5 ${
                showFilters || hasActiveFilters
                  ? 'border-rose-500/50 bg-rose-500/10 text-rose-400'
                  : 'border-zinc-700/80 bg-zinc-900/60 text-zinc-400 hover:text-zinc-300 hover:border-zinc-600'
              }`}
            >
              Filters
              {hasActiveFilters && <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />}
            </button>
            <button
              onClick={() => setFavoritesOnly(!favoritesOnly)}
              className={`h-10 rounded-lg border px-3 text-sm transition cursor-pointer ${
                favoritesOnly
                  ? 'border-yellow-500/50 bg-yellow-500/15 text-yellow-400'
                  : 'border-zinc-700/80 bg-zinc-900/60 text-zinc-400 hover:text-zinc-300 hover:border-zinc-600'
              }`}
            >
              {favoritesOnly ? '★' : '☆'}
            </button>
          </div>

          {showFilters && (
            <div className="flex items-center gap-2 flex-wrap rounded-lg border border-zinc-700/50 bg-zinc-800/40 p-2.5 animate-in max-h-[40vh] overflow-y-auto">
              {availableSources.length > 1 && (
                <select
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                  className="h-8 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-2 text-sm text-zinc-300 outline-none transition-all duration-200 hover:border-zinc-600 focus:border-rose-500/70 focus:ring-2 focus:ring-rose-500/20 cursor-pointer"
                >
                  <option value="">All sources</option>
                  {availableSources.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
              {availableRatios.length > 1 && (
                <select
                  value={ratioFilter}
                  onChange={(e) => setRatioFilter(e.target.value)}
                  className="h-8 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-2 text-sm text-zinc-300 outline-none transition-all duration-200 hover:border-zinc-600 focus:border-rose-500/70 focus:ring-2 focus:ring-rose-500/20 cursor-pointer"
                >
                  <option value="">All ratios</option>
                  {availableRatios.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              )}
              {availableCharacterIds.length > 1 && (
                <select
                  value={characterFilter}
                  onChange={(e) => setCharacterFilter(e.target.value)}
                  className="h-8 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-2 text-sm text-zinc-300 outline-none transition-all duration-200 hover:border-zinc-600 focus:border-rose-500/70 focus:ring-2 focus:ring-rose-500/20 cursor-pointer"
                >
                  <option value="">All characters</option>
                  {availableCharacterIds.map((cId) => {
                    const char = characters.find((c) => c.id === cId);
                    return <option key={cId} value={cId}>{char?.name || cId}</option>;
                  })}
                </select>
              )}
              {availablePersonas.length > 0 && (
                <select
                  value={personaFilter}
                  onChange={(e) => setPersonaFilter(e.target.value)}
                  className="h-8 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-2 text-sm text-zinc-300 outline-none transition-all duration-200 hover:border-zinc-600 focus:border-rose-500/70 focus:ring-2 focus:ring-rose-500/20 cursor-pointer"
                >
                  <option value="">All themes</option>
                  {availablePersonas.map((p) => <option key={p} value={p}>{PERSONA_LABELS[p] || p}</option>)}
                </select>
              )}
              <button
                onClick={() => setGroupBySession(!groupBySession)}
                className={`h-8 rounded-lg border px-2 text-xs transition cursor-pointer ${
                  groupBySession ? 'border-rose-500/50 bg-rose-500/15 text-rose-300' : 'border-zinc-700/80 bg-zinc-900/60 text-zinc-400 hover:text-zinc-300'
                }`}
              >
                Group sessions
              </button>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-zinc-500">Sort:</span>
                <div className="flex gap-1">
                  {SORT_OPTIONS.map(opt => (
                    <button key={opt.value} onClick={() => setSortBy(opt.value)}
                      className={`rounded-md px-2 py-1 text-xs transition cursor-pointer ${
                        sortBy === opt.value ? 'bg-rose-600/30 text-rose-300' : 'bg-zinc-700/50 text-zinc-400 hover:text-zinc-300'
                      }`}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              {allTags.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs text-zinc-500">Tags:</span>
                  {allTags.map(tag => (
                    <button key={tag} onClick={() => setTagFilter(prev =>
                      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
                    )}
                      className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-medium transition cursor-pointer border ${
                        tagFilter.includes(tag)
                          ? 'bg-rose-600/30 text-rose-300 border-rose-500/50'
                          : 'bg-zinc-700/50 text-zinc-400 border-zinc-700/50 hover:text-zinc-300'
                      }`}>
                      {tag}
                    </button>
                  ))}
                </div>
              )}
              {hasActiveFilters && (
                <button onClick={clearFilters} className="ml-auto text-xs text-zinc-500 hover:text-zinc-300 transition cursor-pointer">
                  Clear all
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {loadingList ? (
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="rounded-2xl overflow-hidden bg-zinc-900">
              <Skeleton className="w-full aspect-[4/5]" />
              <div className="px-3 py-2.5 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : images.length === 0 ? (
        <Empty icon={<IconImage uniqueId="empty-gallery" size={40} aria-hidden />} title="Gallery is empty" subtitle="Generated images will appear here" />
      ) : filteredImages.length === 0 ? (
        <Empty icon={<IconMagnifier uniqueId="empty-gallery-search" size={40} aria-hidden />} title="No images match" subtitle="Try adjusting your search or filters" />
      ) : groupBySession && sessionGroups ? (
        <div className="space-y-4">
          {sessionGroups.map((group) => (
            <div key={group.sessionId || group.images[0]?.id} className="rounded-xl border border-zinc-700/50 bg-zinc-900/30 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-700/40 bg-zinc-800/30">
                <div className="flex items-center gap-2">
                  <Badge color={group.sessionId ? 'blue' : 'zinc'}>{group.images.length} images</Badge>
                  {group.source && <span className="text-xs text-zinc-400">{group.source}</span>}
                  <span className="text-[0.625rem] text-zinc-500">{new Date(group.createdAt).toLocaleString()}</span>
                </div>
                {group.sessionId && group.images.length > 1 && (
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => {
                        const ids = group.images.map((i) => i.id);
                        galleryApi.bulkDownload(ids).catch(() => notify('Download failed', 'error'));
                      }}
                      className="text-[0.625rem] text-zinc-500 hover:text-zinc-300 cursor-pointer"
                    >
                      Download all
                    </button>
                    <button
                      onClick={() => {
                        if (!window.confirm(`Delete all ${group.images.length} images in this session?`)) return;
                        galleryApi.bulkRemove(group.images.map((i) => i.id)).then(() => { load(); notify(`Deleted ${group.images.length} images`, 'success'); }).catch(() => notify('Delete failed', 'error'));
                      }}
                      className="text-[0.625rem] text-red-500/70 hover:text-red-400 cursor-pointer"
                    >
                      Delete session
                    </button>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-1 p-2">
                {group.images.map((img) => (
                  <div key={img.id} className="relative rounded-lg overflow-hidden cursor-pointer group" onClick={() => {
                    const idx = filteredImages.findIndex((i) => i.id === img.id);
                    openLightbox(galleryImageUrls, idx >= 0 ? idx : 0);
                  }}>
                  <img
                    src={isMobile ? `/api/gallery/${img.id}/thumb` : galleryApi.imageUrl(img.id)}
                    alt=""
                    className="w-full aspect-square object-cover group-hover:scale-105 transition-transform"
                    loading="lazy"
                    onContextMenu={(event) => { event.preventDefault(); setContextMenu({ item: img, x: event.clientX, y: event.clientY }); }}
                  />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
          {visibleImages.map((img, index) => {
            const isSelected = selectedIds.has(img.id);
            return (
              <div
                key={img.id}
                className={`rounded-2xl overflow-hidden bg-zinc-900 shadow-lg hover:shadow-xl transition-all duration-300 group stagger-item ${
                  isSelected ? 'ring-2 ring-rose-500' : ''
                }`}
                style={{ '--stagger-index': Math.min(index, 11), contentVisibility: 'auto', containIntrinsicSize: 'auto 400px' }}
              >
                <div className="bg-zinc-900 relative overflow-hidden" style={{ minHeight: loadedImages.has(img.id) ? undefined : 200 }}>
                  {!loadedImages.has(img.id) && <div className="skeleton absolute inset-0" />}
                  <img
                    src={isMobile ? `/api/gallery/${img.id}/thumb` : galleryApi.imageUrl(img.id)}
                    alt={img.prompt ? (img.prompt.length > 100 ? img.prompt.slice(0, 100) + '…' : img.prompt) : 'Generated image'}
                    className={`w-full h-auto object-contain transition-all duration-300 group-hover:scale-[1.01] ${loadedImages.has(img.id) ? 'opacity-100' : 'opacity-0'}`}
                    loading="lazy"
                    style={{ cursor: 'pointer' }}
                    onClick={() => bulkMode ? toggleSelection(img.id) : openLightbox(galleryImageUrls, index)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setContextMenu({ item: img, x: event.clientX, y: event.clientY });
                    }}
                    onLoad={() => setLoadedImages((prev) => { const next = new Set(prev); next.add(img.id); return next; })}
                  />

                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggleFavorite(img.id); }}
                    className={`absolute top-2 right-2 w-8 h-8 rounded-full flex items-center justify-center transition cursor-pointer ${
                      img.isFavorite
                        ? 'bg-yellow-500/20 text-yellow-400 opacity-100'
                        : 'bg-black/40 text-white/60 opacity-0 group-hover:opacity-100 hover:text-yellow-400'
                    }`}
                    aria-label={img.isFavorite ? 'Unfavorite' : 'Favorite'}
                  >
                    {img.isFavorite ? '★' : '☆'}
                  </button>

                  {img.qualityScore != null && (
                    <div className={`absolute top-2 left-2 rounded-md px-1.5 py-0.5 text-[0.625rem] font-bold backdrop-blur-sm border ${
                      img.qualityScore >= 85 ? 'bg-green-500/20 text-green-300 border-green-400/30'
                      : img.qualityScore >= 70 ? 'bg-rose-500/20 text-rose-300 border-rose-400/30'
                      : img.qualityScore >= 50 ? 'bg-yellow-500/20 text-yellow-300 border-yellow-400/30'
                      : 'bg-red-500/20 text-red-300 border-red-400/30'
                    }`} title={img.qualityReasons?.join(', ') || 'Quality score'}>
                      {img.qualityScore >= 85 ? '\u2605 ' : ''}{img.qualityScore}
                    </div>
                  )}

                  {bulkMode && (
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleSelection(img.id); }}
                      className={`absolute top-2 left-2 w-7 h-7 rounded-md border-2 flex items-center justify-center transition cursor-pointer ${
                        isSelected
                          ? 'border-rose-500 bg-rose-500 text-white'
                          : 'border-zinc-400 bg-black/40 text-transparent hover:border-rose-400'
                      }`}
                      aria-label={isSelected ? 'Deselect' : 'Select'}
                    >
                      {isSelected && '✓'}
                    </button>
                  )}

                  {!bulkMode && (
                    <>
                      {/* Desktop: hover overlay */}
                      <div className="hidden md:flex absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 flex-col justify-end p-3">
                        <div className="flex gap-1.5 pointer-events-auto">
                          <button onClick={() => handleRecreate(img)} aria-label="Recreate"
                            className="flex-1 rounded-md bg-rose-600/90 px-2 py-1.5 text-xs text-white hover:bg-rose-500 transition cursor-pointer text-center">
                            Recreate
                          </button>
                          <button onClick={() => navigateTo('imageEditor', { editId: img.id })} aria-label="Edit image"
                            className="flex-1 rounded-md bg-rose-600/90 px-2 py-1.5 text-xs text-white hover:bg-rose-500 transition cursor-pointer text-center">
                            Edit
                          </button>
                          {localStorage.getItem('imageEditor_lastEdit') && (
                            <button onClick={() => handleApplyLastEdit(img.id)} aria-label="Apply last edit" disabled={applyingLastId === img.id}
                              className="flex-1 rounded-md bg-amber-600/90 px-2 py-1.5 text-xs text-white hover:bg-amber-500 transition cursor-pointer text-center disabled:opacity-50">
                              {applyingLastId === img.id ? '...' : 'Last'}
                            </button>
                          )}
                          <button onClick={() => handleDownload(img.id, img.filename)} aria-label="Download image"
                            className="flex-1 rounded-md bg-zinc-800/90 px-2 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 transition cursor-pointer text-center">
                            Download
                          </button>
                          <button onClick={() => setDeleteConfirmId(img.id)} aria-label="Delete image"
                            className="rounded-md bg-red-600/80 px-2 py-1.5 text-xs text-white hover:bg-red-500 transition cursor-pointer">
                            Delete
                          </button>
                        </div>
                      </div>
                      {/* Mobile: always-visible bottom action bar */}
                      <div className="md:hidden absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent pt-6 pb-1.5 px-1.5">
                        <div className="flex gap-1">
                          <button onClick={() => handleRecreate(img)} className="flex-1 rounded-md bg-rose-600/90 py-1.5 text-[0.625rem] text-white active:bg-rose-500 text-center">Recreate</button>
                          <button onClick={() => navigateTo('imageEditor', { editId: img.id })} className="flex-1 rounded-md bg-rose-600/90 py-1.5 text-[0.625rem] text-white active:bg-rose-500 text-center">Edit</button>
                          {localStorage.getItem('imageEditor_lastEdit') && (
                            <button onClick={() => handleApplyLastEdit(img.id)} disabled={applyingLastId === img.id}
                              className="flex-1 rounded-md bg-amber-600/90 py-1.5 text-[0.625rem] text-white active:bg-amber-500 text-center disabled:opacity-50">
                              {applyingLastId === img.id ? '...' : 'Last'}
                            </button>
                          )}
                          <button onClick={() => handleDownload(img.id, img.filename)} className="flex-1 rounded-md bg-zinc-800/90 py-1.5 text-[0.625rem] text-zinc-200 active:bg-zinc-700 text-center">DL</button>
                          <button onClick={() => setDeleteConfirmId(img.id)} className="rounded-md bg-red-600/80 px-2 py-1.5 text-[0.625rem] text-white active:bg-red-500">✕</button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
                <div className="px-3 py-2.5 space-y-1">
                  <PromptDisplay prompt={img.prompt} onCopy={copyPromptToClipboard} />
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[0.625rem] text-zinc-500">{formatDate(img.createdAt)}</span>
                    {img.aspectRatio && <Badge color="zinc">{img.aspectRatio}</Badge>}
                    {img.source && <Badge color="blue">{img.source}</Badge>}
                    <span className="text-[0.625rem] text-zinc-600">{formatSize(img.fileSize)}</span>
                    <button onClick={(e) => { e.stopPropagation(); setEditingTagsId(editingTagsId === img.id ? null : img.id); setNewTagInput(''); }}
                      className="text-[0.625rem] text-zinc-600 hover:text-rose-400 transition cursor-pointer ml-auto">
                      Edit tags
                    </button>
                  </div>
                  {Array.isArray(img.tags) && img.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {img.tags.map(tag => (
                        <span key={tag} className={`text-[0.625rem] rounded-full px-1.5 py-0.5 inline-flex items-center gap-0.5 ${
                          CATEGORY_TAGS.includes(tag)
                            ? 'bg-rose-500/15 text-rose-400 border border-rose-500/20'
                            : 'bg-zinc-700/30 text-zinc-500 border border-zinc-600/20'
                        }`}>
                          {tag}
                          {editingTagsId === img.id && (
                            <button onClick={(e) => { e.stopPropagation(); handleRemoveTag(img.id, tag); }}
                              className="hover:text-red-400 cursor-pointer leading-none">&times;</button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  {editingTagsId === img.id && (
                    <div className="flex items-center gap-1 mt-0.5">
                      <input type="text" placeholder="Add tag..." value={newTagInput}
                        onChange={(e) => setNewTagInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { handleAddTag(img.id, newTagInput); } }}
                        className="flex-1 h-6 rounded border border-zinc-700/80 bg-zinc-900/60 px-2 text-[0.6875rem] text-zinc-300 outline-none focus:border-rose-500/70" />
                      <button onClick={() => handleAddTag(img.id, newTagInput)} disabled={!newTagInput.trim()}
                        className="text-[0.625rem] text-rose-400 hover:text-rose-300 cursor-pointer disabled:opacity-40 disabled:cursor-default">Add</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {visibleCount < filteredImages.length && <div ref={sentinelRef} className="h-px" />}

      <Modal open={bulkDeleteConfirm} onClose={() => setBulkDeleteConfirm(false)} title="Delete images">
        <p className="text-zinc-300 text-sm mb-4">
          Are you sure you want to delete <strong>{selectedIds.size}</strong> image{selectedIds.size !== 1 ? 's' : ''}? This cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Btn variant="secondary" onClick={() => setBulkDeleteConfirm(false)} disabled={bulkLoading}>Cancel</Btn>
          <Btn variant="danger" onClick={handleBulkDelete} disabled={bulkLoading}>
            {bulkLoading ? 'Deleting...' : `Delete ${selectedIds.size}`}
          </Btn>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteConfirmId}
        onClose={() => setDeleteConfirmId(null)}
        onConfirm={() => handleDelete(deleteConfirmId)}
        title="Delete image?"
        message="This will permanently remove this image from the gallery. This cannot be undone."
        confirmLabel="Delete"
      />

      <LightboxComponent />
      <ImageContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} onAction={handleContextAction} />
    </div>
  );
}
