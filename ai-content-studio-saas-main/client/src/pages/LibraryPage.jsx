import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { library as libraryApi, gallery as galleryApi, video as videoApi } from '../services/api';
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
          className="text-[11px] text-blue-400 hover:text-blue-300 transition"
        >
          {copied ? 'Copied' : 'Copy prompt'}
        </button>
        {isLong ? (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 transition"
          >
            {expanded ? 'Hide' : 'Expand'}
          </button>
        ) : null}
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
  const sentinelRef = useRef(null);

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

    list.sort((a, b) => {
      if (sortBy === 'largest') return (b.metadata?.fileSize || 0) - (a.metadata?.fileSize || 0);
      if (sortBy === 'smallest') return (a.metadata?.fileSize || 0) - (b.metadata?.fileSize || 0);
      if (sortBy === 'quality') return (b.metadata?.qualityScore || 0) - (a.metadata?.qualityScore || 0);
      if (sortBy === 'oldest') return new Date(a.createdAt) - new Date(b.createdAt);
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    return list;
  }, [items, mediaFilter, searchQuery, favoritesOnly, sourceFilter, ratioFilter, characterFilter, personaFilter, tagFilter, sortBy]);

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
  const hasActiveFilters = Boolean(searchQuery || sourceFilter || ratioFilter || characterFilter || personaFilter || favoritesOnly || tagFilter.length > 0);

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
        aspectRatio: editTarget.aspectRatio || '',
      });
      setEditTarget(null);
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

  const handleImageDownload = useCallback((item) => {
    const anchor = document.createElement('a');
    anchor.href = spoofAvailable && spoofEnabled
      ? galleryApi.spoofedDownloadUrl(item.originalId)
      : item.downloadUrl;
    if (!(spoofAvailable && spoofEnabled)) {
      anchor.download = item.metadata?.filename || `image-${item.originalId}.png`;
    }
    anchor.click();
  }, [spoofAvailable, spoofEnabled]);
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

  const toggleSelection = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllVisible = () => setSelectedIds(new Set(visibleItems.map((item) => item.id)));
  const clearSelection = () => {
    setBulkMode(false);
    setSelectedIds(new Set());
  };

  const handleBulkDownload = async () => {
    const selected = items.filter((item) => selectedIds.has(item.id));
    if (selected.length === 0) return;
    setBulkBusy(true);
    try {
      if (isElectron && window.electronAPI?.chooseDownloadFolder && window.electronAPI?.saveFileToFolder) {
        const directory = await window.electronAPI.chooseDownloadFolder({
          title: 'Choose where to save selected library items',
          folderName: bulkFolderName(),
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
            const fileName = sanitizeDownloadName(contentDispositionName || buildBulkDownloadName(item, { spoofEnabled: spoof }));
            const data = new Uint8Array(await response.arrayBuffer());
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
    <div className="space-y-5 animate-in">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-zinc-500 text-sm">
            {totals.all} items in your library
            {filteredItems.length !== totals.all ? ` · ${filteredItems.length} matching` : ''}
            {!groupBySession && visibleCount < filteredItems.length ? ` · Showing ${visibleCount}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {showSpoofToggle ? <Toggle checked={spoofEnabled} onChange={setSpoofEnabled} label="iPhone" /> : null}
          {MEDIA_FILTERS.map((filter) => {
            const count = filter.value === 'all' ? totals.all : filter.value === 'image' ? totals.images : totals.videos;
            return (
              <button
                key={filter.value}
                type="button"
                onClick={() => setMediaFilter(filter.value)}
                className={`rounded-lg border px-3 py-2 text-sm transition ${
                  mediaFilter === filter.value
                    ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
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
              <Btn variant="secondary" onClick={handleBulkDownload} disabled={selectedIds.size === 0 || bulkBusy}>{isElectron ? 'Save Folder' : 'Download'}</Btn>
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
          className="h-10 min-w-[220px] flex-1 rounded-lg border border-zinc-700/70 bg-zinc-900/60 px-3 text-sm text-zinc-200 placeholder:text-zinc-500 outline-none transition hover:border-zinc-600 focus:border-blue-500/70 focus:ring-2 focus:ring-blue-500/20"
        />
        <button
          type="button"
          onClick={() => setShowFilters((prev) => !prev)}
          className={`h-10 rounded-lg border px-3 text-sm transition ${
            showFilters || hasActiveFilters
              ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
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
            <button
              type="button"
              onClick={() => canGroupSessions && setGroupBySession((prev) => !prev)}
              disabled={!canGroupSessions}
              className={`h-9 rounded-lg border px-3 text-sm transition ${
                groupBySession
                  ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
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
                    sortBy === option.value ? 'bg-blue-600/30 text-blue-300' : 'bg-zinc-800/90 text-zinc-400 hover:text-zinc-200'
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
                  className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
                    tagFilter.includes(tag) ? 'border-blue-500/50 bg-blue-500/10 text-blue-300' : 'border-zinc-700/70 bg-zinc-800/80 text-zinc-400 hover:text-zinc-200'
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
                  <span className="text-[10px] text-zinc-500">{formatDate(group.createdAt)}</span>
                </div>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2 p-2">
                {group.items.map((item) => (
                  <div key={item.id} className="relative rounded-lg overflow-hidden border border-zinc-800/60 bg-zinc-950 group">
                    <img
                      src={item.thumbnailUrl || item.previewUrl}
                      alt={item.prompt ? item.prompt.slice(0, 80) : 'Generated image'}
                      className="w-full aspect-square object-cover cursor-pointer transition-transform duration-300 group-hover:scale-[1.03]"
                      loading="lazy"
                      onClick={() => openImage(item)}
                    />
                    {bulkMode ? (
                      <button
                        type="button"
                        onClick={() => toggleSelection(item.id)}
                        className={`absolute top-2 left-2 h-7 w-7 rounded-md border-2 flex items-center justify-center text-xs ${
                          selectedIds.has(item.id) ? 'border-blue-500 bg-blue-500 text-white' : 'border-zinc-400 bg-black/40 text-transparent'
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
                onSelect={() => toggleSelection(item.id)}
                onOpen={() => openImage(item)}
                onFavorite={() => handleImageFavorite(item)}
                onDelete={() => setDeleteTarget(item)}
                onDownload={() => handleImageDownload(item)}
                onEdit={() => handleOpenEditChooser(item)}
              />
            ) : (
              <VideoLibraryCard
                key={item.id}
                item={item}
                bulkMode={bulkMode}
                selected={selectedIds.has(item.id)}
                notify={notify}
                onSelect={() => toggleSelection(item.id)}
                expanded={expandedVideoId === item.id}
                onToggle={() => setExpandedVideoId((prev) => prev === item.id ? null : item.id)}
                onDelete={() => setDeleteTarget(item)}
              />
            )
          ))}
        </div>
      )}

      {!groupBySession && visibleCount < filteredItems.length ? <div ref={sentinelRef} className="h-px" /> : null}

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
              className="rounded-xl border border-zinc-700/60 bg-zinc-900/70 p-4 text-left transition hover:border-blue-500/40 hover:bg-zinc-800/80 disabled:opacity-60"
            >
              <p className="text-sm font-semibold text-zinc-100">Carousel</p>
              <p className="mt-1 text-xs text-zinc-500">Create follow-up slides and variations from this image.</p>
            </button>
            <button
              type="button"
              onClick={() => handleEditDestination('nanoBypass')}
              disabled={editDestinationBusy}
              className="rounded-xl border border-zinc-700/60 bg-zinc-900/70 p-4 text-left transition hover:border-blue-500/40 hover:bg-zinc-800/80 disabled:opacity-60"
            >
              <p className="text-sm font-semibold text-zinc-100">Nano Bypass</p>
              <p className="mt-1 text-xs text-zinc-500">Load this image into multi-image editing and prompt-based changes.</p>
            </button>
            <button
              type="button"
              onClick={() => handleEditDestination('imageEditor')}
              disabled={editDestinationBusy}
              className="rounded-xl border border-zinc-700/60 bg-zinc-900/70 p-4 text-left transition hover:border-blue-500/40 hover:bg-zinc-800/80 disabled:opacity-60"
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

      <LightboxComponent />
    </div>
  );
}

function ImageLibraryCard({ item, bulkMode, selected, onSelect, onOpen, onFavorite, onDelete, onDownload, onEdit, notify }) {
  return (
    <div className={`rounded-2xl overflow-hidden bg-zinc-900 border shadow-lg hover:shadow-xl transition-all duration-300 group ${
      selected ? 'border-blue-500 ring-2 ring-blue-500/30' : 'border-zinc-800/60'
    }`}>
      <div className="relative bg-zinc-950 overflow-hidden">
        <img
          src={item.previewUrl}
          alt={item.prompt ? item.prompt.slice(0, 120) : 'Generated image'}
          className="w-full aspect-[4/5] object-cover cursor-pointer transition-transform duration-300 group-hover:scale-[1.02]"
          loading="lazy"
          onClick={bulkMode ? onSelect : onOpen}
        />
        {bulkMode ? (
          <button
            type="button"
            onClick={onSelect}
            className={`absolute top-2 left-2 h-8 w-8 rounded-md border-2 flex items-center justify-center ${
              selected ? 'border-blue-500 bg-blue-500 text-white' : 'border-zinc-400 bg-black/40 text-transparent'
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
          <span className="text-[10px] text-zinc-500">{formatDate(item.createdAt)}</span>
          <Badge color="blue">Image</Badge>
          {item.aspectRatio ? <Badge color="zinc">{item.aspectRatio}</Badge> : null}
          {item.source ? <Badge color="zinc">{item.source}</Badge> : null}
          {item.metadata?.fileSize ? <span className="text-[10px] text-zinc-600">{formatBytes(item.metadata.fileSize)}</span> : null}
        </div>
        {item.tags?.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {item.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="text-[10px] rounded-full px-1.5 py-0.5 bg-zinc-700/30 text-zinc-400 border border-zinc-600/20">
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

function VideoLibraryCard({ item, bulkMode, selected, onSelect, expanded, onToggle, onDelete, notify }) {
  const hasFile = !!item.previewUrl;
  const statusColor = item.status === 'completed' ? 'green' : item.status === 'failed' ? 'red' : 'blue';

  return (
    <div className={`rounded-2xl overflow-hidden bg-zinc-900 border shadow-lg hover:shadow-xl transition-all duration-300 group ${
      selected ? 'border-blue-500 ring-2 ring-blue-500/30' : 'border-zinc-800/60'
    }`}>
      <div className="relative aspect-video bg-zinc-950 flex items-center justify-center overflow-hidden">
        {hasFile ? (
          <video
            src={item.previewUrl}
            className="w-full h-full object-cover cursor-pointer"
            muted
            loop
            playsInline
            preload="metadata"
            onClick={bulkMode ? onSelect : onToggle}
            onMouseEnter={(e) => { if (!bulkMode) e.currentTarget.play().catch(() => {}); }}
            onMouseLeave={(e) => {
              if (!bulkMode) {
                e.currentTarget.pause();
                e.currentTarget.currentTime = 0;
              }
            }}
          />
        ) : (
          <div className="text-zinc-600 text-xs px-4 text-center">{item.status === 'failed' ? 'Video failed' : 'Video still processing'}</div>
        )}
        <div className="absolute top-2 left-2 flex gap-2">
          <Badge color={statusColor}>{item.status || 'processing'}</Badge>
          <Badge color="zinc">Video</Badge>
        </div>
        {bulkMode ? <button type="button" onClick={onSelect} className={`absolute top-2 right-2 h-8 w-8 rounded-md border-2 flex items-center justify-center ${selected ? 'border-blue-500 bg-blue-500 text-white' : 'border-zinc-400 bg-black/40 text-transparent'}`}>{selected ? '\u2713' : ''}</button> : null}
      </div>
      <div className="px-3 py-3 space-y-2">
        <PromptSnippet prompt={item.prompt} notify={notify} />
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-zinc-500">{formatDate(item.createdAt)}</span>
          {item.metadata?.model ? <Badge color="zinc">{item.metadata.model}</Badge> : null}
          {item.metadata?.duration ? <span className="text-[10px] text-zinc-600">{item.metadata.duration}s</span> : null}
          {item.aspectRatio ? <Badge color="zinc">{item.aspectRatio}</Badge> : null}
        </div>
        {item.metadata?.error ? <p className="text-[10px] text-red-400">{item.metadata.error}</p> : null}
        {!bulkMode ? (
          <div className="flex gap-2 flex-wrap">
            {hasFile ? <a href={item.downloadUrl} download className="inline-flex items-center justify-center rounded-lg border border-zinc-700/60 bg-zinc-800/80 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700/80 hover:border-zinc-600">Download</a> : null}
            {hasFile ? <Btn variant="secondary" className="!px-3 !py-1.5 !text-xs" onClick={onToggle}>{expanded ? 'Collapse' : 'Expand'}</Btn> : null}
            <Btn variant="danger" className="!px-3 !py-1.5 !text-xs" onClick={onDelete}>Delete</Btn>
          </div>
        ) : null}
        {expanded && hasFile && !bulkMode ? <video src={item.previewUrl} controls autoPlay loop className="w-full rounded-lg border border-zinc-700/60" /> : null}
      </div>
    </div>
  );
}
