import { useState, useEffect, useCallback } from 'react';
import { video as videoApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Badge, Spinner, Empty, ConfirmDialog } from '../components/UI';
import { VIDEO_MODELS } from '../config/photoModes';
import { downloadBlob } from '../lib/stripMetadata';

const MODEL_MAP = Object.fromEntries(VIDEO_MODELS.map((m) => [m.id, m]));

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
];

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function VideoGalleryPage() {
  const { notify } = useApp();

  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState('newest');
  const [modelFilter, setModelFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await videoApi.history();
      setVideos(data || []);
    } catch {
      notify('Failed to load video history', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const filtered = (() => {
    let list = [...videos];

    if (modelFilter !== 'all') {
      list = list.filter((v) => v.model === modelFilter);
    }
    if (statusFilter !== 'all') {
      list = list.filter((v) => v.status === statusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((v) => v.prompt?.toLowerCase().includes(q));
    }

    list.sort((a, b) => {
      if (sortBy === 'oldest') return new Date(a.createdAt) - new Date(b.createdAt);
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    return list;
  })();

  const usedModels = [...new Set(videos.map((v) => v.model).filter(Boolean))];
  const usedStatuses = [...new Set(videos.map((v) => v.status).filter(Boolean))];

  const toggleSelection = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    const downloadable = filtered.filter((v) => v.filename);
    setSelectedIds(new Set(downloadable.map((v) => v.id)));
  };

  const handleBulkDownload = async () => {
    if (selectedIds.size === 0) return;
    setDownloading(true);
    try {
      await videoApi.bulkDownload([...selectedIds]);
      notify(`Downloading ${selectedIds.size} video(s)`, 'success');
    } catch (err) {
      notify(err.message || 'Bulk download failed', 'error');
    } finally {
      setDownloading(false);
    }
  };

  const handleBulkDelete = () => {
    if (selectedIds.size === 0) return;
    setDeleteTarget('__bulk__');
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;

    if (deleteTarget === '__bulk__') {
      const ids = [...selectedIds];
      let removed = 0;
      for (const id of ids) {
        try {
          await videoApi.removeHistory(id);
          removed++;
        } catch {}
      }
      setVideos((prev) => prev.filter((v) => !selectedIds.has(v.id)));
      setSelectedIds(new Set());
      notify(`Deleted ${removed} video(s)`, 'info');
    } else {
      try {
        await videoApi.removeHistory(deleteTarget);
        setVideos((prev) => prev.filter((v) => v.id !== deleteTarget));
        notify('Video deleted', 'info');
      } catch (err) {
        notify(err.message || 'Failed to delete', 'error');
      }
    }
    setDeleteTarget(null);
  };

  const exitBulk = () => { setBulkMode(false); setSelectedIds(new Set()); };

  const completedCount = videos.filter((v) => v.status === 'completed').length;

  return (
    <div className="space-y-5 animate-in">
      {/* Stats bar */}
      <div className="flex items-center gap-4 text-xs text-zinc-500">
        <span>{videos.length} total</span>
        <span>{completedCount} completed</span>
        <span className="ml-auto flex items-center gap-2">
          {!bulkMode ? (
            <Btn variant="ghost" onClick={() => setBulkMode(true)} className="text-xs" disabled={completedCount === 0}>
              Select
            </Btn>
          ) : (
            <>
              <span className="text-zinc-400">{selectedIds.size} selected</span>
              <Btn variant="ghost" onClick={selectAllVisible} className="text-xs">Select All</Btn>
              <Btn variant="ghost" onClick={handleBulkDownload} disabled={selectedIds.size === 0 || downloading} className="text-xs">
                {downloading ? <Spinner size={14} /> : 'Download ZIP'}
              </Btn>
              <Btn variant="ghost" onClick={handleBulkDelete} disabled={selectedIds.size === 0} className="text-xs text-red-400 hover:text-red-300">
                Delete
              </Btn>
              <Btn variant="ghost" onClick={exitBulk} className="text-xs">Cancel</Btn>
            </>
          )}
          <Btn variant="ghost" onClick={load} disabled={loading} className="text-xs">
            {loading ? <Spinner size={14} /> : 'Refresh'}
          </Btn>
        </span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search prompts..."
          className="h-8 w-48 rounded-lg border border-zinc-700/60 bg-zinc-800/60 px-3 text-xs text-zinc-200 placeholder-zinc-600 inset-depth focus:outline-none focus:ring-2 focus:ring-rose-500/20"
        />

        <select
          value={modelFilter}
          onChange={(e) => setModelFilter(e.target.value)}
          className="h-8 rounded-lg border border-zinc-700/60 bg-zinc-800/60 px-2 text-xs text-zinc-300 focus:outline-none cursor-pointer"
        >
          <option value="all">All Models</option>
          {usedModels.map((m) => (
            <option key={m} value={m}>{MODEL_MAP[m]?.label || m}</option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-8 rounded-lg border border-zinc-700/60 bg-zinc-800/60 px-2 text-xs text-zinc-300 focus:outline-none cursor-pointer"
        >
          <option value="all">All Status</option>
          {usedStatuses.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="h-8 rounded-lg border border-zinc-700/60 bg-zinc-800/60 px-2 text-xs text-zinc-300 focus:outline-none cursor-pointer"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20"><Spinner size={32} /></div>
      ) : filtered.length === 0 ? (
        <Empty icon="video" title={videos.length === 0 ? 'No videos yet' : 'No videos match'} subtitle={videos.length === 0 ? 'Generate videos and they will appear here' : 'Try adjusting your filters'} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((v) => (
            <VideoCard
              key={v.id}
              video={v}
              expanded={expandedId === v.id}
              onToggle={() => setExpandedId(expandedId === v.id ? null : v.id)}
              onDelete={() => setDeleteTarget(v.id)}
              bulkMode={bulkMode}
              selected={selectedIds.has(v.id)}
              onSelect={() => toggleSelection(v.id)}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={deleteTarget === '__bulk__' ? `Delete ${selectedIds.size} Video(s)` : 'Delete Video'}
        message={deleteTarget === '__bulk__' ? `This will permanently delete ${selectedIds.size} video file(s) and history entries.` : 'This will permanently delete the video file and history entry.'}
        confirmLabel="Delete"
      />
    </div>
  );
}

function VideoCard({ video, expanded, onToggle, onDelete, bulkMode, selected, onSelect }) {
  const { notify } = useApp();
  const v = video;
  const hasFile = !!v.filename;
  const videoSrc = hasFile ? videoApi.fileUrl(v.filename) : null;

  // The download was a bare `<a href={cleanFileUrl} download>`: it DID hit the clean (stripping)
  // route, but the browser saved it named `clean` (the URL's last path segment) with no visible
  // proof of stripping, and a bare anchor cannot read the X-Metadata-Stripped header — so a strip
  // FAILURE (route serves the original and says so in the header) would have been handed over
  // silently as if cleaned. This goes through the same fetch→header→downloadBlob path Eddy uses, so
  // the saved name ends _metadatacleaned (or _NOT-cleaned, with a loud warning, on failure).
  const handleDownload = async () => {
    if (!hasFile) return;
    try {
      const resp = await fetch(videoApi.cleanFileUrl(v.filename), { credentials: 'include' });
      if (!resp.ok) throw new Error(`Video download failed (${resp.status})`);
      const stripped = resp.headers.get('X-Metadata-Stripped') === 'yes';
      const ext = (v.filename.match(/\.[a-z0-9]+$/i) || ['.mp4'])[0];
      const stem = v.filename.slice(0, v.filename.length - ext.length) || 'video';
      const blob = await resp.blob();
      // downloadBlob leaves video bytes alone (already stripped upstream) and keeps this honest name.
      await downloadBlob(blob, `${stem}${stripped ? '_metadatacleaned' : '_NOT-cleaned'}${ext}`);
      if (!stripped) {
        notify('Metadata could NOT be removed from this clip — it saved as _NOT-cleaned. Do not publish it as-is.', 'error');
      }
    } catch (err) {
      notify(err?.message || 'Video download failed', 'error');
    }
  };

  const statusColor = v.status === 'completed' ? 'green' : v.status === 'failed' ? 'red' : 'blue';

  const handleClick = bulkMode ? onSelect : onToggle;

  return (
    <div className={`rounded-2xl overflow-hidden bg-zinc-900 border shadow-lg hover:shadow-xl transition-all duration-300 group ${
      selected ? 'border-rose-500 ring-2 ring-rose-500/30' : 'border-zinc-800/60'
    }`}>
      {/* Video / Thumbnail */}
      <div className="relative aspect-video bg-zinc-950 flex items-center justify-center overflow-hidden">
        {videoSrc ? (
          <video
            src={videoSrc}
            className="w-full h-full object-cover cursor-pointer"
            muted
            loop
            playsInline
            preload="metadata"
            onClick={handleClick}
            onMouseEnter={(e) => { if (!bulkMode) e.target.play().catch(() => {}); }}
            onMouseLeave={(e) => { if (!bulkMode) { e.target.pause(); e.target.currentTime = 0; } }}
          />
        ) : (
          <div className="text-zinc-700 text-xs cursor-pointer" onClick={handleClick}>
            {v.status === 'processing' ? 'Processing...' : v.status === 'failed' ? 'Failed' : 'No video'}
          </div>
        )}

        {/* Status overlay */}
        <div className="absolute top-2 left-2">
          <Badge color={statusColor}>{v.status}</Badge>
        </div>

        {/* Bulk checkbox */}
        {bulkMode && (
          <button
            onClick={(e) => { e.stopPropagation(); onSelect(); }}
            className={`absolute top-2 right-2 w-7 h-7 rounded-md border-2 flex items-center justify-center transition cursor-pointer ${
              selected
                ? 'border-rose-500 bg-rose-500 text-white'
                : 'border-zinc-400 bg-black/40 text-transparent hover:border-rose-400'
            }`}
          >
            {selected && '✓'}
          </button>
        )}

        {/* Hover actions (non-bulk) */}
        {!bulkMode && hasFile && (
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 flex flex-col justify-end p-3">
            <div className="flex gap-1.5 pointer-events-auto">
              <button
                type="button"
                onClick={handleDownload}
                className="flex-1 rounded-md bg-zinc-800/90 px-2 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 transition text-center cursor-pointer"
              >
                Download
              </button>
              <button
                onClick={onToggle}
                className="rounded-md bg-zinc-800/90 px-2 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 transition cursor-pointer"
              >
                {expanded ? 'Collapse' : 'Expand'}
              </button>
              <button
                onClick={onDelete}
                className="rounded-md bg-red-600/80 px-2 py-1.5 text-xs text-white hover:bg-red-500 transition cursor-pointer"
              >
                Delete
              </button>
            </div>
          </div>
        )}

        {!bulkMode && !hasFile && (
          <button
            onClick={onDelete}
            className="absolute top-2 right-2 w-6 h-6 rounded-full bg-zinc-800/80 border border-zinc-700 text-zinc-500 text-xs flex items-center justify-center hover:text-red-400 cursor-pointer opacity-0 group-hover:opacity-100 transition"
          >
            ×
          </button>
        )}
      </div>

      {/* Info */}
      <div className="px-3 py-2.5 space-y-1">
        {v.prompt && (
          <p className="text-sm text-zinc-300 line-clamp-2" title={v.prompt}>{v.prompt}</p>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[0.625rem] text-zinc-500">{formatDate(v.createdAt)}</span>
          <Badge color="zinc">{MODEL_MAP[v.model]?.label || v.model}</Badge>
          {v.duration && <span className="text-[0.625rem] text-zinc-600">{v.duration}s</span>}
        </div>
        {v.error && <p className="text-[0.625rem] text-red-400 truncate">{v.error}</p>}
      </div>

      {/* Expanded player */}
      {expanded && videoSrc && !bulkMode && (
        <div className="px-3 pb-3">
          <video
            src={videoSrc}
            controls
            autoPlay
            loop
            className="w-full rounded-lg border border-zinc-700/60"
          />
        </div>
      )}
    </div>
  );
}
