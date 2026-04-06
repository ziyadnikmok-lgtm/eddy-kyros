import { useEffect, useMemo, useState } from 'react';
import { subscribeFeed } from '../lib/generationFeed';
import useImageLightbox from './lightbox/useImageLightbox';

function aspectRatioToCss(aspectRatio) {
  if (!aspectRatio) return '4 / 5';
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

function FeedChip({ children, tone = 'default' }) {
  const toneClass =
    tone === 'live'
      ? 'border-blue-500/30 bg-blue-500/10 text-blue-300'
      : tone === 'success'
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
        : 'border-zinc-700/70 bg-zinc-900/80 text-zinc-400';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${toneClass}`}>
      {children}
    </span>
  );
}

function PendingCard({ item, mode = 'rail' }) {
  const workspace = mode === 'workspace';

  return (
    <article
      className={`rounded-2xl border border-zinc-800/80 shadow-[0_16px_48px_rgba(0,0,0,0.22)] ${
        workspace
          ? 'break-inside-avoid overflow-hidden bg-[linear-gradient(180deg,rgba(24,26,33,0.98),rgba(13,14,18,0.98))] p-4'
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

      {item.prompt ? (
        <p className={`mt-3 leading-6 text-zinc-100 ${workspace ? 'text-[15px] font-medium line-clamp-2' : 'text-sm line-clamp-2'}`}>
          {item.prompt}
        </p>
      ) : (
        <p className={`mt-3 leading-6 text-zinc-400 ${workspace ? 'text-[15px]' : 'text-sm'}`}>
          {item.isVideo ? 'Video generation in progress' : 'Image generation in progress'}
        </p>
      )}

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

      <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
        Keep queueing more prompts. This run stays here until it finishes.
      </p>
    </article>
  );
}

function DoneCard({ item, imageUrls, onOpenImage, mode = 'rail' }) {
  const workspace = mode === 'workspace';
  const imageUrl = item.galleryId || item.imageId ? `/api/gallery/${item.galleryId || item.imageId}/image` : null;

  return (
    <article
      className={`rounded-2xl border border-zinc-800/80 shadow-[0_16px_48px_rgba(0,0,0,0.22)] ${
        workspace
          ? 'break-inside-avoid overflow-hidden bg-[linear-gradient(180deg,rgba(24,26,33,0.98),rgba(13,14,18,0.98))] p-4'
          : 'bg-zinc-900/75 p-3'
      }`}
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

      {item.isVideo && item.videoUrl ? (
        <div className="mt-3 overflow-hidden rounded-[22px] border border-zinc-800/70 bg-zinc-950">
          <video
            src={item.videoUrl}
            className="h-auto w-full object-cover"
            muted
            loop
            autoPlay
            playsInline
          />
        </div>
      ) : imageUrl ? (
        <button
          type="button"
          onClick={() => onOpenImage(item, imageUrls)}
          className="mt-3 block w-full cursor-pointer overflow-hidden rounded-[22px] border border-zinc-800/70 bg-zinc-950 text-left transition duration-200 hover:border-zinc-700"
        >
          <img
            src={imageUrl}
            alt={item.prompt || 'Generated image'}
            className="h-auto w-full object-cover transition duration-200 hover:scale-[1.01] hover:opacity-90"
            loading="lazy"
          />
        </button>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {item.resolutionTier ? <FeedChip>{item.resolutionTier}</FeedChip> : null}
        {item.imageModel ? <FeedChip>{item.imageModel}</FeedChip> : null}
        {item.mimeType ? <FeedChip>{item.mimeType.replace('image/', '').replace('video/', '').toUpperCase()}</FeedChip> : null}
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

export default function GenerationFeedPanel({ mode = 'rail' }) {
  const workspace = mode === 'workspace';
  const [feed, setFeed] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState('all');
  const { openLightbox, LightboxComponent } = useImageLightbox();

  useEffect(() => subscribeFeed(setFeed), []);

  const pendingItems = useMemo(() => feed.filter((item) => item.status === 'pending'), [feed]);
  const doneItems = useMemo(() => feed.filter((item) => item.status === 'done'), [feed]);
  const doneImageItems = useMemo(() => doneItems.filter((item) => !item.isVideo), [doneItems]);
  const doneVideoItems = useMemo(() => doneItems.filter((item) => item.isVideo), [doneItems]);
  const imageUrls = useMemo(
    () => doneImageItems.map((item) => `/api/gallery/${item.galleryId || item.imageId}/image`),
    [doneImageItems]
  );

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

  const handleOpenImage = (item, urls) => {
    const index = doneImageItems.findIndex((entry) => (entry.galleryId || entry.imageId) === (item.galleryId || item.imageId));
    openLightbox(urls, index < 0 ? 0 : index);
  };

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
                  {workspace ? 'Live Workspace' : 'Generation Feed'}
                </h3>
                {pendingItems.length > 0 ? <FeedChip tone="live">{pendingItems.length} live</FeedChip> : null}
              </div>
              {!collapsed || workspace ? (
                <p className="mt-1 text-[11px] leading-5 text-zinc-500">
                  {workspace
                    ? 'Your newest image and video runs stack here while you keep queueing more from the left.'
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
              <span className="rounded-full border border-zinc-800/70 bg-zinc-900/80 px-2.5 py-1 text-[10px] text-zinc-500">
                Newest first
              </span>
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
            {visibleItems.length === 0 ? (
              <FeedEmptyState filter={filter} mode={mode} />
            ) : workspace ? (
              <div className="columns-1 gap-4 xl:columns-2 2xl:columns-3">
                {visibleItems.map((item) => (
                  <div key={item.id || item.galleryId || item.imageId || item.videoUrl} className="mb-4">
                    {item.status === 'pending' ? (
                      <PendingCard item={item} mode={mode} />
                    ) : (
                      <DoneCard
                        item={item}
                        imageUrls={imageUrls}
                        onOpenImage={handleOpenImage}
                        mode={mode}
                      />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {visibleItems.map((item) => (
                  item.status === 'pending' ? (
                    <PendingCard key={item.id} item={item} mode={mode} />
                  ) : (
                    <DoneCard
                      key={item.id || item.galleryId || item.imageId || item.videoUrl}
                      item={item}
                      imageUrls={imageUrls}
                      onOpenImage={handleOpenImage}
                      mode={mode}
                    />
                  )
                ))}
              </div>
            )}
          </div>
        )}
      </aside>
      <LightboxComponent />
    </>
  );
}
