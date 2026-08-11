import { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeFeed, removeFeedItem, getFeed, resolvePending, rejectPending, failPending } from '../lib/generationFeed';
import { gallery as galleryApi, video as videoApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Modal, Btn } from './UI';
import useImageLightbox from './lightbox/useImageLightbox';
import { downloadBlob } from '../lib/stripMetadata';

const WORKSPACE_PREFS_KEY = 'kyros_generation_workspace_prefs_v2';
const DEFAULT_PREFS = {
  layoutMode: 'grid',
  imageSize: 'mini',
  editGrouping: 'ungroup',
  railWidth: 'm',
};

// Three good widths beats a drag handle: no fiddling, and it can't be left at a broken size.
const RAIL_WIDTHS = {
  s: 'w-[380px] xl:w-[420px]',
  m: 'w-[520px] xl:w-[600px] 2xl:w-[680px]',
  l: 'w-[680px] xl:w-[780px] 2xl:w-[900px]',
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
    const raw = window.localStorage.getItem(WORKSPACE_PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writeWorkspacePrefs(next) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WORKSPACE_PREFS_KEY, JSON.stringify(next));
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
  // Videos must not inherit an image extension — a .png-named mp4 won't open properly.
  if (item?.isVideo) {
    const fromUrl = String(item.videoUrl || '').match(/\.(mp4|webm|mov|m4v)(?:\?|$)/i);
    return `${cleanedPrompt || 'kyros-video'}.${fromUrl ? fromUrl[1].toLowerCase() : 'mp4'}`;
  }
  const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
  return `${cleanedPrompt || 'kyros-image'}.${ext}`;
}

function FeedChip({ children, tone = 'default' }) {
  const toneClass =
    tone === 'live'
      ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
      : tone === 'success'
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
        : tone === 'warn'
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
          : 'border-zinc-700/60 bg-zinc-900/70 text-zinc-400';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-medium ${toneClass}`}>
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
      <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${active ? 'border-rose-500' : 'border-zinc-600'}`}>
        <span className={`h-2.5 w-2.5 rounded-full ${active ? 'bg-rose-500' : 'bg-transparent'}`} />
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

  // No renderable media (e.g. a finished video whose file URL didn't persist across reload).
  // Still render a placeholder WITH the action button so the user can copy the link or delete it.
  if (!imageUrl && !(item.isVideo && item.videoUrl)) {
    return (
      <div
        className={`group relative overflow-hidden rounded-[24px] border border-zinc-800/70 bg-zinc-950 ${row ? imageSizeToRowMediaClass(imageSize) : 'w-full'}`}
        style={{ aspectRatio: aspectRatioToCss(item.aspectRatio) }}
        onContextMenu={(event) => onOpenMenu?.(item, event)}
      >
        <CardActionButton onClick={(event) => onOpenMenu?.(item, event)} busy={busy} />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-zinc-600"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
          <span className="text-[0.6875rem] leading-snug text-zinc-500">{item.isVideo ? 'Video file unavailable — use ⋯ to copy link or delete' : 'Image unavailable'}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`group relative overflow-hidden rounded-[24px] border border-zinc-800/70 bg-zinc-950 ${row ? imageSizeToRowMediaClass(imageSize) : 'w-full'}`}
      style={row ? { minWidth: undefined, aspectRatio: aspectRatioToCss(item.aspectRatio) } : { aspectRatio: aspectRatioToCss(item.aspectRatio) }}
      onContextMenu={(event) => onOpenMenu?.(item, event)}
    >
      <CardActionButton onClick={(event) => onOpenMenu?.(item, event)} busy={busy} />
      {/* Recreate hover button */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpenMenu?.(item, e, 'useAsSource'); }}
        className="absolute bottom-2 left-2 z-10 flex items-center gap-1 rounded-lg border border-white/10 bg-black/60 px-2 py-1 text-[0.625rem] font-semibold text-zinc-200 opacity-0 transition-all duration-150 group-hover:opacity-100 hover:bg-black/80 hover:text-white backdrop-blur-sm"
        title="Use this image as source in Photo Match"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.47"/></svg>
        Use as source
      </button>
      {item.isVideo && item.videoUrl ? (
        <video
          src={item.videoUrl}
          className="h-full w-full object-cover cursor-pointer"
          muted
          loop
          autoPlay
          playsInline
          onClick={() => onOpenImage?.(item)}
          title="Click to open the video"
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

function PendingCard({ item, mode = 'rail', layoutMode = 'row', imageSize = 'medium', onDismiss }) {
  const workspace = mode === 'workspace';
  const row = workspace && layoutMode === 'row';
  // How many results this job will actually produce (batch jobs set expectedCount).
  const pendingCount = Math.max(1, Math.min(4, Number(item.expectedCount) || 1));

  if (row) {
    return (
      <article className="rounded-[28px] border border-zinc-800/80 bg-[linear-gradient(180deg,rgba(22,24,30,0.98),rgba(12,13,18,0.98))] p-4 shadow-[0_16px_48px_rgba(0,0,0,0.22)]">
        <div className="flex gap-4">
          <div
            className={`relative shrink-0 overflow-hidden rounded-[22px] border border-zinc-800/70 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.15),transparent_60%),linear-gradient(180deg,rgba(32,34,40,0.95),rgba(18,19,24,0.95))] ${imageSizeToRowMediaClass(imageSize)}`}
            style={{ aspectRatio: aspectRatioToCss(item.aspectRatio) }}
          >
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
              <div className="h-8 w-8 rounded-full border-2 border-zinc-700 border-t-rose-400 animate-spin" />
              <FeedChip tone="live">Live</FeedChip>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FeedChip tone="live">
                <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-rose-400 animate-pulse" />
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
      className={`rounded-2xl shadow-[0_16px_48px_rgba(0,0,0,0.22)] ${
        workspace
          ? 'overflow-hidden bg-[#14141a] border border-rose-500/25 p-4'
          : 'bg-[#14141a] border border-rose-500/20 p-3'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-rose-400 animate-pulse" style={{ boxShadow: '0 0 0 0 rgba(217,70,168,0.6)' }} />
          <FeedChip tone="live">
            Generating…
          </FeedChip>
          <FeedChip>{item.isVideo ? 'Video' : 'Image'}</FeedChip>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[0.625rem] text-zinc-600">Live</span>
          {onDismiss ? (
            <button onClick={onDismiss} title="Dismiss (the job may still finish in Library)"
              className="text-zinc-600 hover:text-white text-sm leading-none cursor-pointer">✕</button>
          ) : null}
        </div>
      </div>

      <p className={`mt-3 leading-6 text-zinc-100 ${workspace ? 'text-[0.9375rem] font-medium line-clamp-2' : 'text-sm line-clamp-2'}`}>
        {item.prompt || (item.isVideo ? 'Video generation in progress' : 'Image generation in progress')}
      </p>

      {/* Rose progress bar like the sketch */}
      <div className="mt-3 w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className="h-full rounded-full animate-pulse"
          style={{
            width: '55%',
            background: 'linear-gradient(90deg,#d946a8,#ec4899)',
            boxShadow: '0 0 10px 0 rgba(217,70,168,0.6)',
          }}
        />
      </div>

      {/* Shimmer placeholders — one per expected output (was hardcoded to 4, which
          made a single generation look like a batch of 4). */}
      <div className={`mt-3 grid gap-2 ${pendingCount > 1 ? 'grid-cols-4' : 'grid-cols-1'}`}>
        {Array.from({ length: pendingCount }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg skeleton"
            style={{ aspectRatio: pendingCount > 1 ? '1 / 1' : aspectRatioToCss(item.aspectRatio) }}
          />
        ))}
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
        <span className="text-[0.625rem] text-zinc-600">{formatFeedTime(item.generatedAt)}</span>
      </div>

      {item.prompt ? (
        <p className={`mt-3 leading-6 text-zinc-100 ${workspace ? 'text-[0.9375rem] font-medium line-clamp-2' : 'text-sm line-clamp-2'}`}>
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

function FailedCard({ item, onDismiss }) {
  return (
    <article className="rounded-[22px] border border-red-900/40 bg-red-950/20 p-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-400">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[0.75rem] font-semibold text-red-300">{item.isVideo ? 'Video failed' : 'Generation failed'}</p>
          <p className="mt-1 text-[0.6875rem] leading-snug text-red-400/90 break-words">{item.error || 'Unknown error'}</p>
          {item.prompt ? <p className="mt-1.5 text-[0.625rem] text-zinc-500 line-clamp-1">{item.prompt}</p> : null}
        </div>
        <button onClick={onDismiss} className="shrink-0 text-zinc-500 hover:text-white text-sm cursor-pointer" title="Dismiss">✕</button>
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
        <h4 className="text-[1.75rem] font-semibold text-white">View mode</h4>
      </div>
      <div className="mt-4 border-t border-zinc-800/70 pt-4">
        <p className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-[0.18em] text-zinc-500">Layout</p>
        <div className="space-y-1">
          <ViewChoice active={layoutMode === 'row'} label="Row" onClick={() => setLayoutMode('row')} />
          <ViewChoice active={layoutMode === 'grid'} label="Grid" onClick={() => setLayoutMode('grid')} />
        </div>
      </div>
      <div className="mt-5 border-t border-zinc-800/70 pt-4">
        <p className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-[0.18em] text-zinc-500">Image size</p>
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
        <p className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-[0.18em] text-zinc-500">Edits</p>
        <div className="space-y-1">
          <ViewChoice active={editGrouping === 'group'} label="Group" onClick={() => setEditGrouping('group')} />
          <ViewChoice active={editGrouping === 'ungroup'} label="Ungroup" onClick={() => setEditGrouping('ungroup')} />
        </div>
      </div>
    </div>
  );
}

/* Inline SVG icons for feed context menu */
const feedCtxIcons = {
  eye: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  clipboard: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>,
  image: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>,
  edit: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  zap: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  grid: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  download: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  recreate: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.47"/></svg>,
  trash: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>,
  link: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
};

function FeedContextMenuItem({ icon, label, tone = 'default', ...props }) {
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

function ActionMenu({ x, y, item, onAction, onClose }) {
  const badges = [
    item.aspectRatio,
    item.resolutionTier,
    item.imageModel,
  ].filter(Boolean);

  const timeStr = item.generatedAt ? formatFeedTime(item.generatedAt) : '';

  return (
    <div
      className="fixed z-50 w-60 rounded-2xl border border-zinc-700/50 bg-zinc-900/[0.97] p-1.5 shadow-2xl shadow-black/50 backdrop-blur-2xl"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {/* Header */}
      <div className="mb-1 rounded-xl bg-zinc-800/50 px-3 py-2.5">
        <p className="text-[0.8125rem] font-semibold text-zinc-100 line-clamp-1">{item.isVideo ? 'Video' : 'Generated Image'}</p>
        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
          {timeStr && <span className="text-[0.625rem] text-zinc-500">{timeStr}</span>}
          {badges.map((b, i) => (
            <span key={i} className="rounded-md bg-zinc-700/50 px-1.5 py-0.5 text-[0.5625rem] font-medium text-zinc-400">{b}</span>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="py-0.5">
        <FeedContextMenuItem icon={feedCtxIcons.eye} label="Open preview" onClick={() => onAction('open', item)} />
        <FeedContextMenuItem icon={feedCtxIcons.clipboard} label="Copy prompt" onClick={() => onAction('copyPrompt', item)} />
        <FeedContextMenuItem icon={feedCtxIcons.link} label={item.sourceUrl ? 'Copy source video link' : 'Copy link'} onClick={() => onAction('copyLink', item)} />
        {!item.isVideo && (
          <>
            <FeedContextMenuItem icon={feedCtxIcons.recreate} label="Use as source →" onClick={() => onAction('useAsSource', item)} />
            <FeedContextMenuItem icon={feedCtxIcons.image} label="Copy image" onClick={() => onAction('copyImage', item)} />
            <div className="my-1 border-t border-zinc-800/80 mx-2" />
            <FeedContextMenuItem icon={feedCtxIcons.edit} label="Edit in Image Editor" onClick={() => onAction('imageEditor', item)} />
            <FeedContextMenuItem icon={feedCtxIcons.zap} label="Nano Bypass" onClick={() => onAction('nanoBypass', item)} />
            <FeedContextMenuItem icon={feedCtxIcons.grid} label="Go to Carousel" onClick={() => onAction('carousel', item)} />
          </>
        )}
        <div className="my-1 border-t border-zinc-800/80 mx-2" />
        <FeedContextMenuItem icon={feedCtxIcons.download} label="Download" onClick={() => onAction('download', item)} />
        <div className="my-1 border-t border-zinc-800/80 mx-2" />
        <FeedContextMenuItem icon={feedCtxIcons.trash} label="Delete from feed" tone="danger" onClick={() => onAction('deleteFeedItem', item)} />
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
  const [railWidth, setRailWidth] = useState(() => readWorkspacePrefs().railWidth);
  const [contextMenu, setContextMenu] = useState(null);
  const [videoPreview, setVideoPreview] = useState(null);
  const [actionBusyId, setActionBusyId] = useState('');
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const viewButtonRef = useRef(null);
  const viewPanelRef = useRef(null);

  useEffect(() => subscribeFeed(setFeed), []);

  // The feed finishes its own video cards. Previously only the page that started a job polled
  // it, so navigating away killed the poller and the card span forever -- while the server-side
  // reconciler still downloaded the file, which is why it appeared in Library and nowhere else.
  // This panel is always mounted, so the watch survives navigation and reload.
  useEffect(() => {
    const iv = setInterval(async () => {
      const now = Date.now();
      // Expire cards that can never resolve on their own: a pending video with no taskId (made
      // before taskId was tracked), or anything pending far longer than a render takes. Without
      // this they spin forever -- exactly the stuck "Generating…" card.
      for (const item of getFeed()) {
        if (item.status !== 'pending') continue;
        const age = now - (item.generatedAt || now);
        const noWayToCheck = item.isVideo && !item.taskId;
        if ((noWayToCheck && age > 60_000) || age > 30 * 60_000) {
          failPending(item.id, 'Timed out — status unknown. It may have failed or completed; check Library.');
        }
      }
      const watching = getFeed().filter((i) => i.status === 'pending' && i.isVideo && i.taskId);
      for (const item of watching) {
        try {
          const data = await videoApi.status(item.taskId);
          if (data.status === 'completed') {
            const url = data.localFilename
              ? videoApi.fileUrl(data.localFilename)
              : (data.outputs?.[0] || data.videoUrl || '');
            if (url) resolvePending(item.id, { isVideo: true, videoUrl: url, generatedAt: Date.now() });
          } else if (data.status === 'failed') {
            failPending(item.id, data.error);
          }
        } catch { /* transient: the route reports network blips as 'processing', so keep watching */ }
      }
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  // Not gated on `workspace`: railWidth is a rail-mode setting, and the old guard would have
  // dropped every write in exactly the mode that uses it. Only one panel is mounted at a time,
  // so writing the whole object keeps a single source of truth.
  useEffect(() => {
    writeWorkspacePrefs({ layoutMode, imageSize, editGrouping, railWidth });
  }, [layoutMode, imageSize, editGrouping, railWidth]);

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
    // Videos aren't in doneImageItems and the lightbox is image-only — findIndex would return
    // -1 and silently open a random IMAGE instead. Give videos their own player.
    if (item?.isVideo) {
      if (!item.videoUrl) { notify('This video has no playable file anymore', 'error'); return; }
      setVideoPreview(item);
      return;
    }
    const urls = doneImageItems.map((entry) => `/api/gallery/${entry.galleryId || entry.imageId}/image`);
    const index = doneImageItems.findIndex((entry) => (entry.galleryId || entry.imageId) === (item.galleryId || item.imageId));
    openLightbox(urls, index < 0 ? 0 : index);
  };

  const openContextMenu = (item, event, directAction = null) => {
    // Allow the menu for any finished item — images AND videos (videos have no gallery id,
    // so the old isImageItem() guard silently blocked them → 3-dot did nothing).
    if (item?.status !== 'done') return;
    event.preventDefault();
    event.stopPropagation();
    // If a directAction is specified (e.g. from the hover button), handle immediately
    if (directAction) {
      handleContextAction(directAction, item);
      return;
    }
    const width = 240;
    const height = 400;
    const x = Math.max(12, Math.min(event.clientX, window.innerWidth - width - 12));
    const y = Math.max(12, Math.min(event.clientY, window.innerHeight - height - 12));
    setContextMenu({ item, x, y });
  };

  const handleContextAction = async (action, item) => {
    setContextMenu(null);
    const targetId = item.galleryId || item.imageId;
    const toAbsolute = (u) => !u ? '' : (/^(https?:|blob:|data:)/.test(u) ? u : `${window.location.origin}${u.startsWith('/') ? '' : '/'}${u}`);

    // ── Actions that work for ANY finished item (image OR video) — no gallery id needed ──
    if (action === 'deleteFeedItem') {
      removeFeedItem(item.id);
      notify('Removed from feed', 'success');
      return;
    }

    if (action === 'open') {
      handleOpenImage(item);
      return;
    }

    if (action === 'copyPrompt') {
      try {
        await navigator.clipboard.writeText(item.prompt || '');
        notify('Prompt copied', 'success');
      } catch (err) {
        notify(err.message || 'Failed to copy prompt', 'error');
      }
      return;
    }

    if (action === 'copyLink') {
      // Prefer the SOURCE reel link — when a grabbed frame was used, this traces back to the
      // original video. Fall back to the media's own URL (video file or gallery image).
      let link = '';
      let label = 'Link copied 🔗';
      if (item.sourceUrl) { link = item.sourceUrl; label = 'Source video link copied 🔗'; }
      else if (item.isVideo && item.videoUrl) link = toAbsolute(item.videoUrl);
      else if (targetId) link = toAbsolute(galleryApi.imageUrl(targetId));
      if (!link) { notify('No link available for this item', 'error'); return; }
      try {
        await navigator.clipboard.writeText(link);
        notify(label, 'success');
      } catch (err) {
        notify(err.message || 'Failed to copy link', 'error');
      }
      return;
    }

    if (action === 'download') {
      // Video goes through the server's clean route; images are stripped in the browser.
      const url = item.isVideo && item.videoUrl
        ? (item.videoFilename ? videoApi.cleanFileUrl(item.videoFilename) : item.videoUrl)
        : galleryApi.imageUrl(targetId);
      // Video passes through untouched — stripping an MP4 needs a container rewrite.
      const blob = await (await fetch(url, { credentials: 'include' })).blob();
      await downloadBlob(blob, buildActionFilename(item));
      return;
    }

    // ── Everything below is image-only and needs a generated gallery image ──
    if (!targetId) { notify('That action only works on generated images', 'error'); return; }

    if (action === 'copyImage') {
      try {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
          throw new Error('Copy image is not supported in this browser');
        }
        const response = await fetch(galleryApi.imageUrl(targetId), { credentials: 'include' });
        if (!response.ok) throw new Error(`Failed to load image (${response.status})`);
        const blob = await response.blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
        notify('Image copied', 'success');
      } catch (err) {
        notify(err.message || 'Failed to copy image', 'error');
      }
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
        aspectRatio: '4:5',
      });
      return;
    }

    if (action === 'useAsSource') {
      setActionBusyId(itemKey(item));
      try {
        const response = await fetch(galleryApi.imageUrl(targetId), { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load image');
        const blob = await response.blob();
        const dataUrl = await blobToDataUrl(blob);
        const parsed = parseDataUrl(dataUrl);
        if (!parsed) throw new Error('Failed to read image data');
        // Navigate to Photo Match first, then fire event after a short mount delay
        navigateTo('photoMatch');
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('kyros:use-as-source', {
            detail: {
              base64: parsed.base64,
              mimeType: parsed.mimeType,
              name: buildActionFilename(item, parsed.mimeType),
              aspectRatio: item.aspectRatio || undefined,
              characterId: item.characterId || undefined,
            }
          }));
        }, 150);
        notify('Image loaded into Photo Match ⚡', 'success');
      } catch (error) {
        notify(error.message || 'Failed to load image', 'error');
      } finally {
        setActionBusyId('');
      }
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
          aspectRatio: item.aspectRatio || undefined,
        });
        notify('Loaded image into Nano Bypass', 'success');
      } catch (error) {
        notify(error.message || 'Failed to open Nano Bypass', 'error');
      } finally {
        setActionBusyId('');
      }
      return;
    }
  };

  // Drives BOTH modes. The rail used to render a hardcoded vertical stack, so View mode's size
  // and layout did nothing there — one giant card per row while a batch of 8 ran offscreen.
  const feedLayoutClass = layoutMode === 'grid'
    ? `grid ${workspace ? 'gap-4' : 'gap-2'} ${imageSizeToGridColumns(imageSize)}`
    : `${workspace ? 'space-y-4' : 'space-y-3'}`;

  return (
    <>
      <aside
        className={`flex flex-col overflow-hidden bg-[#1e1a2c]/70 backdrop-blur-2xl ${
          workspace
            ? 'hidden lg:flex min-w-0 flex-1'
            : `${collapsed ? 'hidden lg:flex w-11 shrink-0' : `hidden lg:flex shrink-0 ${RAIL_WIDTHS[railWidth] || RAIL_WIDTHS.m}`} transition-all duration-300`
        }`}
      >
        <div className="border-b border-white/[0.06] px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1 flex items-center gap-2">
              {pendingItems.length > 0 ? (
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-rose-400 animate-pulse" style={{ boxShadow: '0 0 6px rgba(217,70,168,0.7)' }} />
                  <span className="text-[0.75rem] font-semibold text-white">{pendingItems.length > 1 ? `Generating batch of ${pendingItems.length}…` : 'Generating…'}</span>
                </div>
              ) : (
                <div>
                  <span className="text-[0.875rem] font-bold text-white">Generation Feed</span>
                  {doneItems.length > 0 && <span className="ml-2 text-[0.6875rem] text-zinc-500">{doneItems.length} saved</span>}
                </div>
              )}
            </div>

            {/* Controls live in BOTH modes. This used to be `!workspace ? collapse : viewControls`,
                which meant the rail (where you actually watch a batch run) got nothing but a
                collapse chevron, and the S/M/L control was guarded by `!workspace` INSIDE the
                workspace-only branch — so it could never render at all. */}
            <div className="relative ml-auto flex shrink-0 items-center gap-2">
              {!workspace && !collapsed && (
                <div className="hidden xl:flex items-center gap-0.5 rounded-xl border border-white/[0.06] bg-white/[0.03] p-0.5">
                  {['s', 'm', 'l'].map((size) => (
                    <button
                      key={size}
                      type="button"
                      onClick={() => setRailWidth(size)}
                      title={`${{ s: 'Narrow', m: 'Medium', l: 'Wide' }[size]} feed`}
                      aria-pressed={railWidth === size}
                      className={`h-6 w-6 rounded-lg text-[0.625rem] font-bold uppercase transition cursor-pointer ${
                        railWidth === size ? 'bg-white/[0.10] text-white' : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              )}

              {!collapsed && (
                <button
                  ref={viewButtonRef}
                  type="button"
                  onClick={() => setViewOpen((value) => !value)}
                  className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-xs font-medium text-zinc-400 transition hover:border-zinc-700 hover:text-white cursor-pointer"
                  title="Card size and layout"
                >
                  View mode
                </button>
              )}

              {!workspace && (
                <button
                  type="button"
                  onClick={() => setCollapsed((value) => !value)}
                  className="rounded-lg border border-white/[0.06] bg-white/[0.03] p-1.5 text-zinc-500 transition hover:text-zinc-200 cursor-pointer"
                  title={collapsed ? 'Expand feed' : 'Collapse feed'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    {collapsed ? <path d="M9 18l6-6-6-6" /> : <path d="M15 18l-6-6 6-6" />}
                  </svg>
                </button>
              )}

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
          </div>

          {(!collapsed || workspace) && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {filterOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFilter(option.id)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[0.7188rem] font-medium transition cursor-pointer ${
                    filter === option.id
                      ? 'border-transparent text-white font-semibold'
                      : 'border-white/[0.06] bg-white/[0.03] text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
                  }`}
                  style={filter === option.id ? {
                    background: 'linear-gradient(135deg,#d946a8,#ec4899)',
                    boxShadow: '0 4px 14px -4px rgba(217,70,168,0.5)',
                  } : {}}
                >
                  <span>{option.label}</span>
                  <span className="text-[0.625rem] opacity-80">{option.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {(!collapsed || workspace) && (
          <div className={`flex-1 overflow-y-auto ${workspace ? 'px-5 py-5' : 'px-3 py-3'}`}>
            {visibleEntries.length === 0 ? (
              <FeedEmptyState filter={filter} mode={mode} />
            ) : (
              <div className={feedLayoutClass}>
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
                      onDismiss={() => removeFeedItem(entry.item.id)}
                    />
                  ) : entry.item.status === 'error' ? (
                    <FailedCard key={entry.key} item={entry.item} onDismiss={() => removeFeedItem(entry.item.id)} />
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

      {/* Video player — the image lightbox can't render video, so videos get their own. */}
      <Modal
        open={!!videoPreview}
        onClose={() => setVideoPreview(null)}
        title={videoPreview?.prompt ? String(videoPreview.prompt).slice(0, 80) : 'Video'}
        className="!max-w-3xl"
      >
        {videoPreview?.videoUrl && (
          <div className="space-y-3">
            <video
              src={videoPreview.videoUrl}
              controls
              autoPlay
              loop
              playsInline
              className="w-full max-h-[65vh] rounded-xl border border-zinc-800/60 bg-black"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {videoPreview.imageModel ? <FeedChip>{videoPreview.imageModel}</FeedChip> : null}
                {videoPreview.aspectRatio ? <FeedChip>{videoPreview.aspectRatio}</FeedChip> : null}
                {videoPreview.resolutionTier ? <FeedChip>{videoPreview.resolutionTier}</FeedChip> : null}
              </div>
              <div className="flex items-center gap-2">
                <Btn
                  variant="secondary"
                  className="!rounded-lg !py-1.5 !px-3 !text-xs"
                  onClick={() => handleContextAction('copyLink', videoPreview)}
                >
                  Copy link
                </Btn>
                <Btn
                  variant="secondary"
                  className="!rounded-lg !py-1.5 !px-3 !text-xs"
                  onClick={() => handleContextAction('download', videoPreview)}
                >
                  Download
                </Btn>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <LightboxComponent />
    </>
  );
}
