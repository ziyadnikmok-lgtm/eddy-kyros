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
            className="text-[10px] text-zinc-600 hover:text-blue-400 transition cursor-pointer mt-0.5">
            Show full prompt
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5 rounded-lg bg-zinc-800/40 border border-zinc-700/40 p-2.5 -mx-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Prompt</span>
        <div className="flex gap-2">
          <button onClick={() => onCopy(prompt)} className="text-[10px] text-blue-400 hover:text-blue-300 transition cursor-pointer">
            Copy all
          </button>
          <button onClick={() => setExpanded(false)} className="text-[10px] text-zinc-500 hover:text-zinc-300 transition cursor-pointer">
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

export default function GalleryPage() {
  const { notify, navigateTo } = useApp();
  const { run } = useAsync();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const isMobile = useIsMobile();

  const [images, setImages] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadedImages, setLoadedImages] = useState(() => new Set());

  const [searchQuery, setSearchQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [ratioFilter, setRatioFilter] = useState('');
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
  const [editingTagsId, setEditingTagsId] = useState(null);
  const [newTagInput, setNewTagInput] = useState('');

  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef(null);
  const [spoofAvailable, setSpoofAvailable] = useState(false);
  const [spoofEnabled, setSpoofEnabled] = useState(true);

  const availableSources = useMemo(() => {
    const s = new Set(images.map((i) => i.source).filter(Boolean));
    return [...s].sort();
  }, [images]);

  const availableRatios = useMemo(() => {
    const r = new Set(images.map((i) => i.aspectRatio).filter(Boolean));
    return [...r].sort();
  }, [images]);

  const filteredImages = useMemo(() => {
    let result = images;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((i) => i.prompt?.toLowerCase().includes(q));
    }
    if (sourceFilter) result = result.filter((i) => i.source === sourceFilter);
    if (ratioFilter) result = result.filter((i) => i.aspectRatio === ratioFilter);
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
    }
    return result;
  }, [images, searchQuery, sourceFilter, ratioFilter, favoritesOnly, tagFilter, sortBy]);

  const visibleImages = useMemo(() => filteredImages.slice(0, visibleCount), [filteredImages, visibleCount]);
  const galleryImageUrls = useMemo(() => filteredImages.map((i) => galleryApi.imageUrl(i.id)), [filteredImages]);

  const hasActiveFilters = searchQuery || sourceFilter || ratioFilter || favoritesOnly || tagFilter.length > 0;

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
                className="w-full h-10 rounded-lg border border-zinc-700/80 bg-zinc-900/60 pl-8 pr-3 text-sm text-zinc-200 placeholder:text-zinc-500 outline-none transition-all duration-200 hover:border-zinc-600 focus:border-blue-500/70 focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`h-10 rounded-lg border px-3 text-sm transition cursor-pointer flex items-center gap-1.5 ${
                showFilters || hasActiveFilters
                  ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                  : 'border-zinc-700/80 bg-zinc-900/60 text-zinc-400 hover:text-zinc-300 hover:border-zinc-600'
              }`}
            >
              Filters
              {hasActiveFilters && <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />}
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
                  className="h-8 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-2 text-sm text-zinc-300 outline-none transition-all duration-200 hover:border-zinc-600 focus:border-blue-500/70 focus:ring-2 focus:ring-blue-500/20 cursor-pointer"
                >
                  <option value="">All sources</option>
                  {availableSources.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
              {availableRatios.length > 1 && (
                <select
                  value={ratioFilter}
                  onChange={(e) => setRatioFilter(e.target.value)}
                  className="h-8 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-2 text-sm text-zinc-300 outline-none transition-all duration-200 hover:border-zinc-600 focus:border-blue-500/70 focus:ring-2 focus:ring-blue-500/20 cursor-pointer"
                >
                  <option value="">All ratios</option>
                  {availableRatios.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              )}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-zinc-500">Sort:</span>
                <div className="flex gap-1">
                  {SORT_OPTIONS.map(opt => (
                    <button key={opt.value} onClick={() => setSortBy(opt.value)}
                      className={`rounded-md px-2 py-1 text-xs transition cursor-pointer ${
                        sortBy === opt.value ? 'bg-blue-600/30 text-blue-300' : 'bg-zinc-700/50 text-zinc-400 hover:text-zinc-300'
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
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition cursor-pointer border ${
                        tagFilter.includes(tag)
                          ? 'bg-blue-600/30 text-blue-300 border-blue-500/50'
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
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
          {visibleImages.map((img, index) => {
            const isSelected = selectedIds.has(img.id);
            return (
              <div
                key={img.id}
                className={`rounded-2xl overflow-hidden bg-zinc-900 shadow-lg hover:shadow-xl transition-all duration-300 group stagger-item ${
                  isSelected ? 'ring-2 ring-blue-500' : ''
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

                  {bulkMode && (
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleSelection(img.id); }}
                      className={`absolute top-2 left-2 w-7 h-7 rounded-md border-2 flex items-center justify-center transition cursor-pointer ${
                        isSelected
                          ? 'border-blue-500 bg-blue-500 text-white'
                          : 'border-zinc-400 bg-black/40 text-transparent hover:border-blue-400'
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
                            className="flex-1 rounded-md bg-blue-600/90 px-2 py-1.5 text-xs text-white hover:bg-blue-500 transition cursor-pointer text-center">
                            Recreate
                          </button>
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
                          <button onClick={() => handleRecreate(img)} className="flex-1 rounded-md bg-blue-600/90 py-1.5 text-[10px] text-white active:bg-blue-500 text-center">Recreate</button>
                          <button onClick={() => handleDownload(img.id, img.filename)} className="flex-1 rounded-md bg-zinc-800/90 py-1.5 text-[10px] text-zinc-200 active:bg-zinc-700 text-center">DL</button>
                          <button onClick={() => setDeleteConfirmId(img.id)} className="rounded-md bg-red-600/80 px-2 py-1.5 text-[10px] text-white active:bg-red-500">✕</button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
                <div className="px-3 py-2.5 space-y-1">
                  <PromptDisplay prompt={img.prompt} onCopy={copyPromptToClipboard} />
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] text-zinc-500">{formatDate(img.createdAt)}</span>
                    {img.aspectRatio && <Badge color="zinc">{img.aspectRatio}</Badge>}
                    {img.source && <Badge color="blue">{img.source}</Badge>}
                    <span className="text-[10px] text-zinc-600">{formatSize(img.fileSize)}</span>
                    <button onClick={(e) => { e.stopPropagation(); setEditingTagsId(editingTagsId === img.id ? null : img.id); setNewTagInput(''); }}
                      className="text-[10px] text-zinc-600 hover:text-blue-400 transition cursor-pointer ml-auto">
                      Edit tags
                    </button>
                  </div>
                  {Array.isArray(img.tags) && img.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {img.tags.map(tag => (
                        <span key={tag} className={`text-[10px] rounded-full px-1.5 py-0.5 inline-flex items-center gap-0.5 ${
                          CATEGORY_TAGS.includes(tag)
                            ? 'bg-purple-500/15 text-purple-400 border border-purple-500/20'
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
                        className="flex-1 h-6 rounded border border-zinc-700/80 bg-zinc-900/60 px-2 text-[11px] text-zinc-300 outline-none focus:border-blue-500/70" />
                      <button onClick={() => handleAddTag(img.id, newTagInput)} disabled={!newTagInput.trim()}
                        className="text-[10px] text-blue-400 hover:text-blue-300 cursor-pointer disabled:opacity-40 disabled:cursor-default">Add</button>
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
    </div>
  );
}
