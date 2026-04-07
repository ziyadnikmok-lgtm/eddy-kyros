import { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeFeed } from '../lib/generationFeed';
import { gallery as galleryApi } from '../services/api';
import { useApp } from '../context/AppContext';
import useImageLightbox from './lightbox/useImageLightbox';

const WORKSPACE_PREFS_KEY = 'kyros_generation_workspace_prefs_v1';
const DEFAULT_PREFS = {
  layoutMode: 'row',
  imageSize: 'medium',
  editGrouping: 'ungroup',
};

function aspectRatioToCss(aspectRatio) {
  if (!aspectRatio || aspectRatio === 'auto') return '4 / 5';
  const map = {
    '1:1': '1 / 1',
    '16:9': '16 / 9',
    '9:16': '9 / 16',
    '4:5': '4 / 5',
    '5:4': '5 / 4',
    '3:2': '3 / 2',
    '2:3': '2 / 3',
    '3:4': '3 / 4',
    '4:3': '4 / 3',
    '2:1': '2 / 1',
  };
  return map[aspectRatio] || '4 / 5';
}

function formatFeedTime(timestamp) {
  if (!timestamp) return 'Just now';
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.max(0, Math.floor(diffMs / 60000));
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function readWorkspacePrefs() {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.sessionStorage.getItem(WORKSPACE_PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writeWorkspacePrefs(next) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(WORKSPACE_PREFS_KEY, JSON.stringify(next));
  } catch {}
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
  return { mimeType: match[1], base64: match[2] };
}

function imageSizeToGridColumns(imageSize) {
  const map = {
    mini: 'grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4',
    small: 'grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3',
    medium: 'grid-cols-1 xl:grid-cols-2',
    large: 'grid-cols-1',
  };
  return map[imageSize] || map.medium;
}

function imageSizeToRowMediaClass(imageSize) {
  const map = {
    mini: 'w-24',
    small: 'w-32',
    medium: 'w-44',
    large: 'w-56',
  };
  return map[imageSize] || map.medium;
}

function sizeToGroupGrid(imageSize) {
  const map = {
    mini: 'grid-cols-3',
    small: 'grid-cols-3',
    medium: 'grid-cols-2',
    large: 'grid-cols-2',
  };
  return map[imageSize] || map.medium;
}

function itemKey(item) {
  return item.id || item.galleryId || item.imageId || item.videoUrl || `${item.prompt}-${item.generatedAt}`;
}

function isImageItem(item) {
  return item?.status === 'done' && !item?.isVideo && Boolean(item?.galleryId || item?.imageId);
}

function buildActionFilename(item, mimeType = 'image/png') {
  const cleanedPrompt = String(item?.prompt || 'kyros-image')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 48)
    .toLowerCase();
  const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
  return `${cleanedPrompt || 'kyros-image'}.${ext}`;
}

function FeedChip({ children, tone = 'default' }) {
  const toneClass =
    tone === 'live'
      ? 'border-blue-500/30 bg-blue-500/10 text-blue-300'
      : tone === 'success'
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
        : tone === 'warn'
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
          : 'border-zinc-700/70 bg-zinc-900/80 text-zinc-400';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${toneClass}`}>
      {children}
    </span>
  );
}

function ViewChoice({ active, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl px-1 py-1 text-left text-sm text-zinc-300 transition hover:text-white"
    >
      <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${active ? 'border-blue-500' : 'border-zinc-600'}`}>
        <span className={`h-2.5 w-2.5 rounded-full ${active ? 'bg-blue-500' : 'bg-transparent'}`} />
      </span>
      <span>{label}</span>
    </button>
  );
}

function CardActionButton({ onClick, busy = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute right-2 top-2 z-10 rounded-xl border border-zinc-700/70 bg-black/55 px-2 py-1 text-xs text-zinc-300 opacity-0 transition group-hover:opacity-100 hover:border-zinc-500 hover:text-white"
      title="More actions"
    >
      {busy ? '…' : '•••'}
    </button>
  );
}

function ImageSurface({ item, onOpenImage, onOpenMenu, layoutMode, imageSize, busy = false }) {
  const row = layoutMode === 'row';
  const imageUrl = item.galleryId || item.imageId ? `/api/gallery/${item.galleryId || item.imageId}/image` : null;

  if (!imageUrl && !(item.isVideo && item.videoUrl)) return null;

  return (
    <div
      className={`group relative overflow-hidden rounded-[24px] border border-zinc-800/70 bg-zinc-950 ${row ? imageSizeToRowMediaClass(imageSize) : 'w-full'}`}
      style={row ? { minWidth: undefined, aspectRatio: aspectRatioToCss(item.aspectRatio) } : { aspectRatio: aspectRatioToCss(item.aspectRatio) }}
      onContextMenu={(event) => onOpenMenu?.(item, event)}
    >
      <CardActionButton onClick={(event) => onOpenMenu?.(item, event)} busy={busy} />
      {item.isVideo && item.videoUrl ? (
        <video
          src={item.videoUrl}
          className="h-full w-full object-cover"
          muted
          loop
          autoPlay
          playsInline
        />
      ) : (
        <button
          type="button"
          onClick={() => onOpenImage(item)}
          className="block h-full w-full cursor-pointer text-left"
        >
          <img
            src={imageUrl}
            alt={item.prompt || 'Generated image'}
            className="h-full w-full object-cover transition duration-200 hover:scale-[1.01] hover:opacity-95"
            loading="lazy"
          />
        </button>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent px-3 pb-3 pt-12">
        <div className="flex flex-wrap items-center gap-1.5">
          {item.aspectRatio ? <FeedChip>{item.aspectRatio}</FeedChip> : null}
          {item.resolutionTier ? <FeedChip>{item.resolutionTier}</FeedChip> : null}
          {item.imageModel ? <FeedChip>{item.imageModel}</FeedChip> : null}
        </div>
      </div>
    </div>
  );
}

function PendingCard({ item, mode = 'rail', layoutMode = 'row', imageSize = 'medium' }) {
  const workspace = mode === 'workspace';
  const row = workspace && layoutMode === 'row';

  if (row) {
    return (
      <article className="rounded-[28px] border border-zinc-800/80 bg-[linear-gradient(180deg,rgba(22,24,30,0.98),rgba(12,13,18,0.98))] p-4 shadow-[0_16px_48px_rgba(0,0,0,0.22)]">
        <div className="flex gap-4">
          <div
            className={`relative shrink-0 overflow-hidden rounded-[22px] border border-zinc-800/70 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.15),transparent_60%),linear-gradient(180deg,rgba(32,34,40,0.95),rgba(18,19,24,0.95))] ${imageSizeToRowMediaClass(imageSize)}`}
            style={{ aspectRatio: aspectRatioToCss(item.aspectRatio) }}
          >
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
              <div className="h-8 w-8 rounded-full border-2 border-zinc-700 border-t-blue-400 animate-spin" />
              <FeedChip tone="live">Live</FeedChip>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FeedChip tone="live">
                <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                Generating
              </FeedChip>
              <FeedChip>{item.isVideo ? 'Video' : 'Image'}</FeedChip>
            </div>
            <p className="mt-3 line-clamp-2 text-base font-medium leading-6 text-zinc-100">
              {item.prompt || (item.isVideo ? 'Video generation in progress' : 'Image generation in progress')}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {item.aspectRatio ? <FeedChip>{item.aspectRatio}</FeedChip> : null}
              {item.resolutionTier ? <FeedChip>{item.resolutionTier}</FeedChip> : null}
              {item.imageModel ? <FeedChip>{item.imageModel}</FeedChip> : null}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-zinc-500">
              Keep queueing more prompts while this one finishes.
            </p>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article
      className={`rounded-2xl border border-zinc-800/80 shadow-[0_16px_48px_rgba(0,0,0,0.22)] ${
        workspace
          ? 'overflow-hidden bg-[linear-gradient(180deg,rgba(24,26,33,0.98),rgba(13,14,18,0.98))] p-4'
          : 'bg-zinc-900/75 p-3'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FeedChip tone="live">
            <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
            Generating
          </FeedChip>
          <FeedChip>{item.isVideo ? 'Video' : 'Image'}</FeedChip>
        </div>
        <span className="text-[10px] text-zinc-600">Live</span>
      </div>

      <p className={`mt-3 leading-6 text-zinc-100 ${workspace ? 'text-[15px] font-medium line-clamp-2' : 'text-sm line-clamp-2'}`}>
        {item.prompt || (item.isVideo ? 'Video generation in progress' : 'Image generation in progress')}
      </p>

      <div
        className={`relative mt-3 overflow-hidden rounded-[22px] border border-zinc-800/70 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.14),transparent_60%),linear-gradient(180deg,rgba(32,34,40,0.95),rgba(18,19,24,0.95))] ${
          workspace ? 'p-4' : ''
        }`}
        style={{ aspectRatio: aspectRatioToCss(item.aspectRatio) }}
      >
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <div className="h-8 w-8 rounded-full border-2 border-zinc-700 border-t-blue-400 animate-spin" />
          <div className="flex flex-wrap items-center justify-center gap-1.5 px-4">
            {item.aspectRatio ? <FeedChip>{item.aspectRatio}</FeedChip> : null}
            {item.resolutionTier ? <FeedChip>{item.resolutionTier}</FeedChip> : null}
            {item.imageModel ? <FeedChip>{item.imageModel}</FeedChip> : null}
          </div>
        </div>
      </div>
    </article>
  );
}

function DoneCard({ item, onOpenImage, onOpenMenu, mode = 'rail', layoutMode = 'row', imageSize = 'medium', busy = false }) {
  const workspace = mode === 'workspace';
  const row = workspace && layoutMode === 'row';

  if (row) {
    return (
      <article className="rounded-[28px] border border-zinc-800/80 bg-[linear-gradient(180deg,rgba(22,24,30,0.98),rgba(12,13,18,0.98))] p-4 shadow-[0_16px_48px_rgba(0,0,0,0.22)]">
        <div className="flex gap-4">
          <ImageSurface item={item} onOpenImage={onOpenImage} onOpenMenu={onOpenMenu} layoutMode={layoutMode} imageSize={imageSize} busy={busy} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <FeedChip tone="success">{item.isVideo ? 'Video Ready' : 'Image Ready'}</FeedChip>
                <FeedChip>{formatFeedTime(item.generatedAt)}</FeedChip>
              </div>
              {item.characterId ? <FeedChip tone="warn">Character linked</FeedChip> : null}
            </div>
            {item.prompt ? (
              <p className="mt-3 line-clamp-3 text-base font-medium leading-6 text-zinc-100">{item.prompt}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {item.resolutionTier ? <FeedChip>{item.resolutionTier}</FeedChip> : null}
              {item.imageModel ? <FeedChip>{item.imageModel}</FeedChip> : null}
              {item.mimeType ? <FeedChip>{item.mimeType.replace('image/', '').replace('video/', '').toUpperCase()}</FeedChip> : null}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-zinc-500">
              Right-click this card for more edits, or keep stacking new generations from the left.
            </p>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article
      className={`rounded-2xl border border-zinc-800/80 shadow-[0_16px_48px_rgba(0,0,0,0.22)] ${
        workspace
          ? 'overflow-hidden bg-[linear-gradient(180deg,rgba(24,26,33,0.98),rgba(13,14,18,0.98))] p-4'
          : 'bg-zinc-900/75 p-3'
      }`}
      onContextMenu={(event) => onOpenMenu?.(item, event)}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FeedChip tone="success">{item.isVideo ? 'Video Ready' : 'Image Ready'}</FeedChip>
          {item.aspectRatio ? <FeedChip>{item.aspectRatio}</FeedChip> : null}
        </div>
        <span className="text-[10px] text-zinc-600">{formatFeedTime(item.generatedAt)}</span>
      </div>

      {item.prompt ? (
        <p className={`mt-3 leading-6 text-zinc-100 ${workspace ? 'text-[15px] font-medium line-clamp-2' : 'text-sm line-clamp-2'}`}>
          {item.prompt}
        </p>
      ) : null}

      <div className="mt-3">
        <ImageSurface item={item} onOpenImage={onOpenImage} onOpenMenu={onOpenMenu} layoutMode="grid" imageSize={imageSize} busy={busy} />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {item.resolutionTier ? <FeedChip>{item.resolutionTier}</FeedChip> : null}
        {item.imageModel ? <FeedChip>{item.imageModel}</FeedChip> : null}
        {item.mimeType ? <FeedChip>{item.mimeType.replace('image/', '').replace('video/', '').toUpperCase()}</FeedChip> : null}
      </div>
    </article>
  );
}

function GroupedDoneCard({ group, layoutMode, imageSize, onOpenImage, onOpenMenu, busyId }) {
  const row = layoutMode === 'row';

  return (
    <article className="rounded-[28px] border border-zinc-800/80 bg-[linear-gradient(180deg,rgba(22,24,30,0.98),rgba(12,13,18,0.98))] p-4 shadow-[0_16px_48px_rgba(0,0,0,0.22)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <FeedChip tone="success">Grouped edits</FeedChip>
            <FeedChip>{group.items.length} results</FeedChip>
          </div>
          <p className="mt-3 max-w-3xl text-base font-medium leading-6 text-zinc-100">{group.prompt}</p>
        </div>
        <span className="text-xs text-zinc-500">Newest first</span>
      </div>
      <div className={`mt-4 ${row ? 'flex gap-3 overflow-x-auto pb-1' : `grid gap-3 ${sizeToGroupGrid(imageSize)}`}`}>
        {group.items.map((item) => (
          <div key={itemKey(item)} className={row ? `shrink-0 ${imageSizeToRowMediaClass(imageSize)}` : ''}>
            <ImageSurface
              item={item}
              onOpenImage={onOpenImage}
              onOpenMenu={onOpenMenu}
              layoutMode={row ? 'row' : 'grid'}
              imageSize={imageSize}
              busy={busyId === itemKey(item)}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              <FeedChip>{formatFeedTime(item.generatedAt)}</FeedChip>
              {item.resolutionTier ? <FeedChip>{item.resolutionTier}</FeedChip> : null}
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function FeedEmptyState({ filter, mode = 'rail' }) {
  const copy = {
    all: {
      title: 'Nothing generated yet',
      body: 'Queue your first image and this workspace will start stacking results instantly.',
    },
    running: {
      title: 'No active runs right now',
      body: 'Start a new run and the live cards will appear here.',
    },
    images: {
      title: 'No saved images yet',
      body: 'Generated images will stay here so you can keep building from them.',
    },
    videos: {
      title: 'No saved videos yet',
      body: 'Finished videos will appear here next to your image results.',
    },
  }[filter] || {
    title: 'Nothing here yet',
    body: 'Start generating to fill this workspace.',
  };

  return (
    <div
      className={`flex flex-col items-center justify-center rounded-2xl border border-zinc-800/70 bg-zinc-900/45 px-6 text-center ${
        mode === 'workspace' ? 'min-h-[420px]' : 'min-h-[280px]'
      }`}
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800/70 bg-zinc-950/80 text-zinc-600">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M7 8h10" />
          <path d="M7 12h10" />
          <path d="M7 16h6" />
        </svg>
      </div>
      <p className="mt-4 text-sm font-medium text-zinc-300">{copy.title}</p>
      <p className="mt-1 max-w-[320px] text-xs leading-5 text-zinc-500">{copy.body}</p>
    </div>
  );
}

function ViewModePanel({ layoutMode, setLayoutMode, imageSize, setImageSize, editGrouping, setEditGrouping }) {
  return (
    <div className="absolute right-0 top-full z-30 mt-2 w-[260px] rounded-[26px] border border-zinc-800/80 bg-[#111214] p-4 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
      <div className="flex items-center justify-between">
        <h4 className="text-[28px] font-semibold text-white">View mode</h4>
      </div>
      <div className="mt-4 border-t border-zinc-800/70 pt-4">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Layout</p>
        <div className="space-y-1">
          <ViewChoice active={layoutMode === 'row'} label="Row" onClick={() => setLayoutMode('row')} />
          <ViewChoice active={layoutMode === 'grid'} label="Grid" onClick={() => setLayoutMode('grid')} />
        </div>
      </div>
      <div className="mt-5 border-t border-zinc-800/70 pt-4">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Image size</p>
        <div className="space-y-1">
          {['mini', 'small', 'medium', 'large'].map((size) => (
            <ViewChoice
              key={size}
              active={imageSize === size}
              label={size[0].toUpperCase() + size.slice(1)}
              onClick={() => setImageSize(size)}
            />
          ))}
        </div>
      </div>
      <div className="mt-5 border-t border-zinc-800/70 pt-4">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Edits</p>
        <div className="space-y-1">
          <ViewChoice active={editGrouping === 'group'} label="Group" onClick={() => setEditGrouping('group')} />
          <ViewChoice active={editGrouping === 'ungroup'} label="Ungroup" onClick={() => setEditGrouping('ungroup')} />
        </div>
      </div>
    </div>
  );
}

function ActionMenu({ x, y, item, onAction, onClose }) {
  return (
    <div
      className="fixed z-50 w-[240px] rounded-2xl border border-zinc-800/80 bg-[#111214] p-2 shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="border-b border-zinc-800/70 px-3 py-2">
        <p className="line-clamp-2 text-sm font-medium text-white">{item.prompt || 'Generated image'}</p>
        <p className="mt-1 text-[11px] text-zinc-500">Choose the next edit flow for this result.</p>
      </div>
      <div className="space-y-1 p-2">
        <button type="button" onClick={() => onAction('open', item)} className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-zinc-300 transition hover:bg-zinc-800/80 hover:text-white">
          Open preview
        </button>
        <button type="button" onClick={() => onAction('imageEditor', item)} className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-zinc-300 transition hover:bg-zinc-800/80 hover:text-white">
          Edit in Image Editor
        </button>
        <button type="button" onClick={() => onAction('nanoBypass', item)} className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-zinc-300 transition hover:bg-zinc-800/80 hover:text-white">
          More edit in Nano Bypass
        </button>
        <button type="button" onClick={() => onAction('carousel', item)} className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-zinc-300 transition hover:bg-zinc-800/80 hover:text-white">
          Go to Carousel
        </button>
      </div>
      <div className="border-t border-zinc-800/70 px-3 py-2">
        <button type="button" onClick={onClose} className="text-xs text-zinc-500 transition hover:text-zinc-300">
          Close
        </button>
      </div>
    </div>
  );
}

export default function GenerationFeedPanel({ mode = 'rail' }) {
  const workspace = mode === 'workspace';
  const { navigateTo, notify } = useApp();
  const [feed, setFeed] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState('all');
  const [viewOpen, setViewOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState(() => readWorkspacePrefs().layoutMode);
  const [imageSize, setImageSize] = useState(() => readWorkspacePrefs().imageSize);
  const [editGrouping, setEditGrouping] = useState(() => readWorkspacePrefs().editGrouping);
  const [contextMenu, setContextMenu] = useState(null);
  const [actionBusyId, setActionBusyId] = useState('');
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const viewButtonRef = useRef(null);
  const viewPanelRef = useRef(null);

  useEffect(() => subscribeFeed(setFeed), []);

  useEffect(() => {
    if (!workspace) return;
    writeWorkspacePrefs({ layoutMode, imageSize, editGrouping });
  }, [workspace, layoutMode, imageSize, editGrouping]);

  useEffect(() => {
    const closeMenus = (event) => {
      if (viewPanelRef.current?.contains(event.target) || viewButtonRef.current?.contains(event.target)) return;
      setViewOpen(false);
      setContextMenu(null);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setViewOpen(false);
        setContextMenu(null);
      }
    };
    window.addEventListener('pointerdown', closeMenus);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', closeMenus);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const pendingItems = useMemo(() => feed.filter((item) => item.status === 'pending'), [feed]);
  const doneItems = useMemo(() => feed.filter((item) => item.status === 'done'), [feed]);
  const doneImageItems = useMemo(() => doneItems.filter((item) => !item.isVideo), [doneItems]);
  const doneVideoItems = useMemo(() => doneItems.filter((item) => item.isVideo), [doneItems]);

  const filterOptions = [
    { id: 'all', label: 'All', count: feed.length },
    { id: 'running', label: 'Running', count: pendingItems.length },
    { id: 'images', label: 'Images', count: doneImageItems.length },
    { id: 'videos', label: 'Videos', count: doneVideoItems.length },
  ];

  const visibleItems = useMemo(() => {
    if (filter === 'running') return pendingItems;
    if (filter === 'images') return doneImageItems;
    if (filter === 'videos') return doneVideoItems;
    return feed;
  }, [doneImageItems, doneVideoItems, feed, filter, pendingItems]);

  const visibleEntries = useMemo(() => {
    if (!workspace || editGrouping === 'ungroup') {
      return visibleItems.map((item) => ({ type: 'single', key: itemKey(item), item }));
    }

    const grouped = [];
    const groupedByPrompt = new Map();
    visibleItems.forEach((item) => {
      const normalizedPrompt = String(item.prompt || '').trim().toLowerCase();
      if (item.status !== 'done' || !normalizedPrompt) {
        grouped.push({ type: 'single', key: itemKey(item), item });
        return;
      }

      const groupKey = `${item.isVideo ? 'video' : 'image'}:${normalizedPrompt}:${item.characterId || ''}`;
      let existing = groupedByPrompt.get(groupKey);
      if (!existing) {
        existing = { type: 'group', key: groupKey, prompt: item.prompt, items: [] };
        groupedByPrompt.set(groupKey, existing);
        grouped.push(existing);
      }
      existing.items.push(item);
    });

    return grouped;
  }, [editGrouping, visibleItems, workspace]);

  const handleOpenImage = (item) => {
    const urls = doneImageItems.map((entry) => `/api/gallery/${entry.galleryId || entry.imageId}/image`);
    const index = doneImageItems.findIndex((entry) => (entry.galleryId || entry.imageId) === (item.galleryId || item.imageId));
    openLightbox(urls, index < 0 ? 0 : index);
  };

  const openContextMenu = (item, event) => {
    if (!isImageItem(item)) return;
    event.preventDefault();
    event.stopPropagation();
    const width = 240;
    const height = 248;
    const x = Math.max(12, Math.min(event.clientX, window.innerWidth - width - 12));
    const y = Math.max(12, Math.min(event.clientY, window.innerHeight - height - 12));
    setContextMenu({ item, x, y });
  };

  const handleContextAction = async (action, item) => {
    setContextMenu(null);
    const targetId = item.galleryId || item.imageId;
    if (!targetId) return;

    if (action === 'open') {
      handleOpenImage(item);
      return;
    }

    if (action === 'imageEditor') {
      navigateTo('imageEditor', { editId: targetId });
      return;
    }

    if (action === 'carousel') {
      navigateTo('carousel', {
        sourceImageId: targetId,
        characterId: item.characterId || undefined,
        aspectRatio: item.aspectRatio || undefined,
      });
      return;
    }

    if (action === 'nanoBypass') {
      setActionBusyId(itemKey(item));
      try {
        const response = await fetch(galleryApi.imageUrl(targetId), { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load image for Nano Bypass');
        const blob = await response.blob();
        const dataUrl = await blobToDataUrl(blob);
        const parsed = parseDataUrl(dataUrl);
        if (!parsed) throw new Error('Failed to read image data');
        navigateTo('nanoBypass', {
          sourceImageBase64: parsed.base64,
          sourceImageMimeType: parsed.mimeType,
          sourceImageName: buildActionFilename(item, parsed.mimeType),
          characterId: item.characterId || undefined,
          aspectRatio: item.aspectRatio || undefined,
        });
        notify('Loaded image into Nano Bypass', 'success');
      } catch (error) {
        notify(error.message || 'Failed to open Nano Bypass', 'error');
      } finally {
        setActionBusyId('');
      }
    }
  };

  const workspaceLayoutClass = layoutMode === 'grid'
    ? `grid gap-4 ${imageSizeToGridColumns(imageSize)}`
    : 'space-y-4';

  return (
    <>
      <aside
        className={`flex flex-col overflow-hidden bg-[linear-gradient(180deg,rgba(16,18,22,0.98),rgba(11,12,16,0.98))] ${
          workspace
            ? 'hidden lg:flex min-w-0 flex-1'
            : `${collapsed ? 'hidden lg:flex w-11 shrink-0' : 'hidden lg:flex w-[400px] shrink-0 xl:w-[440px] 2xl:w-[500px]'} transition-all duration-300`
        }`}
      >
        <div className="border-b border-zinc-800/60 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className={`font-semibold text-zinc-100 ${workspace ? 'text-base' : 'text-sm'}`}>
                  {workspace ? 'Generations' : 'Generation Feed'}
                </h3>
                {pendingItems.length > 0 ? <FeedChip tone="live">{pendingItems.length} live</FeedChip> : null}
              </div>
              {!collapsed || workspace ? (
                <p className="mt-1 text-[11px] leading-5 text-zinc-500">
                  {workspace
                    ? 'Images and videos stay here while you keep queueing more from the left.'
                    : 'Persistent results rail for images and videos across the whole app.'}
                </p>
              ) : null}
            </div>

            {!workspace ? (
              <button
                type="button"
                onClick={() => setCollapsed((value) => !value)}
                className="ml-auto rounded-lg border border-zinc-800/70 bg-zinc-900/80 p-1.5 text-zinc-500 transition hover:text-zinc-200 cursor-pointer"
                title={collapsed ? 'Expand feed' : 'Collapse feed'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {collapsed ? <path d="M9 18l6-6-6-6" /> : <path d="M15 18l-6-6 6-6" />}
                </svg>
              </button>
            ) : (
              <div className="relative">
                <button
                  ref={viewButtonRef}
                  type="button"
                  onClick={() => setViewOpen((value) => !value)}
                  className="rounded-xl border border-zinc-800/70 bg-zinc-900/85 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-white"
                >
                  View mode
                </button>
                {viewOpen ? (
                  <div ref={viewPanelRef}>
                    <ViewModePanel
                      layoutMode={layoutMode}
                      setLayoutMode={setLayoutMode}
                      imageSize={imageSize}
                      setImageSize={setImageSize}
                      editGrouping={editGrouping}
                      setEditGrouping={setEditGrouping}
                    />
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {(!collapsed || workspace) && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {filterOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFilter(option.id)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition cursor-pointer ${
                    filter === option.id
                      ? 'border-blue-500/40 bg-blue-500/12 text-blue-300'
                      : 'border-zinc-800/70 bg-zinc-900/70 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
                  }`}
                >
                  <span>{option.label}</span>
                  <span className="text-[10px] opacity-80">{option.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {(!collapsed || workspace) && (
          <div className={`flex-1 overflow-y-auto ${workspace ? 'px-5 py-5' : 'px-3 py-3'}`}>
            {visibleEntries.length === 0 ? (
              <FeedEmptyState filter={filter} mode={mode} />
            ) : workspace ? (
              <div className={workspaceLayoutClass}>
                {visibleEntries.map((entry) => (
                  entry.type === 'group' ? (
                    <GroupedDoneCard
                      key={entry.key}
                      group={entry}
                      layoutMode={layoutMode}
                      imageSize={imageSize}
                      onOpenImage={handleOpenImage}
                      onOpenMenu={openContextMenu}
                      busyId={actionBusyId}
                    />
                  ) : entry.item.status === 'pending' ? (
                    <PendingCard
                      key={entry.key}
                      item={entry.item}
                      mode={mode}
                      layoutMode={layoutMode}
                      imageSize={imageSize}
                    />
                  ) : (
                    <DoneCard
                      key={entry.key}
                      item={entry.item}
                      onOpenImage={handleOpenImage}
                      onOpenMenu={openContextMenu}
                      mode={mode}
                      layoutMode={layoutMode}
                      imageSize={imageSize}
                      busy={actionBusyId === itemKey(entry.item)}
                    />
                  )
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {visibleEntries.map((entry) => (
                  entry.type === 'group' ? (
                    <GroupedDoneCard
                      key={entry.key}
                      group={entry}
                      layoutMode="grid"
                      imageSize="small"
                      onOpenImage={handleOpenImage}
                      onOpenMenu={openContextMenu}
                      busyId={actionBusyId}
                    />
                  ) : entry.item.status === 'pending' ? (
                    <PendingCard key={entry.key} item={entry.item} mode={mode} />
                  ) : (
                    <DoneCard
                      key={entry.key}
                      item={entry.item}
                      onOpenImage={handleOpenImage}
                      onOpenMenu={openContextMenu}
                      mode={mode}
                      busy={actionBusyId === itemKey(entry.item)}
                    />
                  )
                ))}
              </div>
            )}
          </div>
        )}
      </aside>

      {contextMenu ? (
        <ActionMenu
          x={contextMenu.x}
          y={contextMenu.y}
          item={contextMenu.item}
          onAction={handleContextAction}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
      <LightboxComponent />
    </>
  );
}
