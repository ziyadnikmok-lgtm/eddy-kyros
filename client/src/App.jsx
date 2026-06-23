import { lazy, Suspense, useState, useEffect, useCallback } from 'react';
const LoginPage = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));
const VerifyEmailPage = lazy(() => import('./pages/VerifyEmailPage'));
const LandingPage = lazy(() => import('./pages/LandingPage'));
import { useApp } from './context/AppContext';
import { Toasts, Spinner } from './components/UI';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { PageErrorBoundary } from './components/ErrorBoundary';
import GenerationFeedPanel from './components/GenerationFeedPanel';
import { keys as keysApi } from './services/api';
import {
  IconBadgeSparkle,
  IconFlame,
  IconAppStack,
  IconBolt,
  IconLayers,
  IconCamera,
  IconVideo,
  IconSwap,
  IconCopies,
  IconColorPalette,
  IconMagicWandSparkle,
  IconMagnifier,
  IconBookOpen,
  IconImage,
  IconClipboard,
  IconRulerPen,
  IconGrid2,
  IconUsers,
  IconKey,
  IconCreditCards,
  IconBulletList,
  IconCrosshairs,
  IconSettingsWrench,
} from 'nucleo-glass';

const GeneratePage = lazy(() => import('./pages/GeneratePage'));
const BatchPage = lazy(() => import('./pages/BatchPage'));
const CarouselPage = lazy(() => import('./pages/CarouselPage'));
const StorytellerPage = lazy(() => import('./pages/StorytellerPage'));
const AutoGeneratorPage = lazy(() => import('./pages/AutoGeneratorPage'));
const CharactersPage = lazy(() => import('./pages/CharactersPage'));
const GalleryPage = lazy(() => import('./pages/GalleryPage'));
const LibraryPage = lazy(() => import('./pages/LibraryPage'));
const PasteInboxPage = lazy(() => import('./pages/PasteInboxPage'));
const SceneRecreatePage = lazy(() => import('./pages/SceneRecreatePage'));
const FrameLibraryPage = lazy(() => import('./pages/FrameLibraryPage'));
const PostClonePage = lazy(() => import('./pages/PostClonePage'));
const StyleLibraryPage = lazy(() => import('./pages/StyleLibraryPage'));
const ProfileAnalyzerPage = lazy(() => import('./pages/ProfileAnalyzerPage'));
const PromptBuilderPage = lazy(() => import('./pages/PromptBuilderPage'));
const LoraDatasetPage = lazy(() => import('./pages/LoraDatasetPage'));
const ApiKeysPage = lazy(() => import('./pages/ApiKeysPage'));
const VideoPage = lazy(() => import('./pages/VideoPage'));
const VideoGalleryPage = lazy(() => import('./pages/VideoGalleryPage'));
const ReformatPage = lazy(() => import('./pages/ReformatPage'));
const NsfwGeneratePage = lazy(() => import('./pages/NsfwGeneratePage'));
const ImageEditorPage = lazy(() => import('./pages/ImageEditorPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const InstagramFramesPage = lazy(() => import('./pages/InstagramFramesPage'));
const LogsPage = lazy(() => import('./pages/LogsPage'));
const PhotoMatchPage = lazy(() => import('./pages/PhotoMatchPage'));
const NanoBypassPage = lazy(() => import('./pages/NanoBypassPage'));
const SeedDreamEditPage = lazy(() => import('./pages/SeedDreamEditPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const ReferralPage = lazy(() => import('./pages/ReferralPage'));

const NAV_ICONS = {
  generate: IconBadgeSparkle,
  nsfwGenerate: IconFlame,
  batch: IconAppStack,
  auto: IconBolt,
  carousel: IconLayers,
  scene: IconCamera,
  video: IconVideo,
  videoGallery: IconGrid2,
  postClone: IconCopies,
  instagramFrames: IconImage,
  frameLibrary: IconGrid2,
  styleLibrary: IconColorPalette,
  promptBuilder: IconMagicWandSparkle,
  loraDataset: IconLayers,
  profileAnalyzer: IconMagnifier,
  storyteller: IconBookOpen,
  library: IconGrid2,
  pasteInbox: IconClipboard,
  gallery: IconImage,
  imageEditor: IconRulerPen,
  characters: IconUsers,
  keys: IconKey,
  billing: IconCreditCards,
  logs: IconBulletList,
  photoMatch: IconCrosshairs,
  nanoBypass: IconMagicWandSparkle,
  seedEdit: IconRulerPen,
  referral: IconUsers,
  admin: IconBulletList,
  settings: IconSettingsWrench,
};

// Each entry: [gradientTop, gradientBottom] matching --nc-gradient-1-color-1 / color-2
const NAV_COLORS = {
  generate:       ['#a5b4fc', '#6366f1'],
  nsfwGenerate:   ['#fca5a5', '#ef4444'],
  batch:          ['#c4b5fd', '#8b5cf6'],
  auto:           ['#fde68a', '#f59e0b'],
  carousel:       ['#93c5fd', '#3b82f6'],
  scene:          ['#67e8f9', '#0891b2'],
  video:          ['#f9a8d4', '#ec4899'],
  videoGallery:   ['#5eead4', '#0d9488'],
  postClone:      ['#d8b4fe', '#9333ea'],
  instagramFrames: ['#f9a8d4', '#e879f9'],
  frameLibrary:    ['#fcd34d', '#f43f5e'],
  styleLibrary:   ['#6ee7b7', '#059669'],
  promptBuilder:  ['#a5b4fc', '#4f46e5'],
  profileAnalyzer:['#7dd3fc', '#0284c7'],
  storyteller:    ['#bef264', '#65a30d'],
  library:        ['#67e8f9', '#0284c7'],
  pasteInbox:     ['#c084fc', '#7c3aed'],
  gallery:        ['#fcd34d', '#d97706'],
  imageEditor:    ['#f9a8d4', '#db2777'],
  characters:     ['#c4b5fd', '#7c3aed'],
  keys:           ['#94a3b8', '#475569'],
  billing:        ['#86efac', '#16a34a'],
  logs:           ['#fda4af', '#e11d48'],
  photoMatch:     ['#6ee7b7', '#0891b2'],
  nanoBypass:     ['#c4b5fd', '#7c3aed'],
  seedEdit:       ['#f0abfc', '#a855f7'],
  referral:       ['#fb923c', '#ea580c'],
  admin:          ['#fcd34d', '#d97706'],
  settings:       ['#94a3b8', '#64748b'],
};

const NAV_SECTIONS = [
  {
    label: 'Create',
    items: [
      { id: 'generate', label: 'Generate' },
      { id: 'batch', label: 'Batch' },
      { id: 'video', label: 'Video' },
      { id: 'auto', label: 'Auto Generator' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { id: 'styleLibrary', label: 'Style Library' },
      { id: 'promptBuilder', label: 'Prompt Builder' },
      { id: 'loraDataset', label: 'LoRA Dataset' },
      { id: 'profileAnalyzer', label: 'Profile Analyzer' },
      { id: 'storyteller', label: 'Storyteller' },
    ],
  },
  {
    label: 'Image Remix',
    items: [
      { id: 'scene', label: 'Scene Recreate' },
      { id: 'postClone', label: 'Post Clone' },
      { id: 'carousel', label: 'Carousel' },
      { id: 'photoMatch', label: 'Photo Match' },
      { id: 'nanoBypass', label: 'Nano Bypass' },
      { id: 'seedEdit', label: 'SeedDream Edit' },
    ],
  },
  {
    label: 'Media Grab',
    items: [
      { id: 'instagramFrames', label: 'Frame Grabber' },
      { id: 'frameLibrary', label: 'Frame Library' },
    ],
  },
    {
      label: 'Content',
      items: [
        { id: 'library', label: 'Library' },
        { id: 'pasteInbox', label: 'Paste Inbox' },
        { id: 'imageEditor', label: 'Image Editor' },
        { id: 'characters', label: 'Characters' },
      ],
  },
  {
    label: 'Account',
    items: [
      { id: 'keys', label: 'API Keys' },
      { id: 'billing', label: 'Billing' },
      { id: 'referral', label: 'Referral' },
      { id: 'settings', label: 'Settings' },
      { id: 'logs', label: 'App Logs' },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);

const APP_VERSION = '8.1.3';

const FEED_HIDDEN_PAGES = new Set([
  'library',
  'gallery',
  'videoGallery',
  'imageEditor',
  'characters',
  'keys',
  'billing',
  'referral',
  'settings',
  'logs',
  'instagramFrames',
  'frameLibrary',
]);

// Pages where controls panel is narrow and feed takes the rest of the space
const FEED_DOMINANT_PAGES = new Set([
  'generate', 'nsfwGenerate', 'batch', 'video', 'auto',
  'scene', 'postClone', 'carousel', 'photoMatch', 'nanoBypass', 'seedEdit',
]);

function SidebarHeader() {
  return (
    <header className="flex h-[72px] items-center gap-2 border-b border-white/[0.07] px-5">
      <span className="text-sm font-semibold text-zinc-100 tracking-tight">Kyros Studio</span>
      <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.045] px-1.5 py-px text-[9px] text-zinc-500 font-mono">
        v{APP_VERSION}
      </span>
    </header>
  );
}

const PAGE_DESCRIPTIONS = {
  generate: 'Create a single image with full control',
  nsfwGenerate: 'WaveSpeed Turbo LoRA — uncensored image generation',
  batch: 'Generate multiple images in parallel',
  video: 'Generate videos from images using AI',
  auto: 'AI-planned multi-day content schedules',
  carousel: 'Generate slide variations from a source image',
  scene: 'Upload a scene and recreate it with your character',
  postClone: 'Clone Instagram posts with your character',
  instagramFrames: 'Grab frames from any public Instagram Reel or TikTok Video — send to Photo Match or Scene Recreate',
  frameLibrary: 'Manage your downloaded Instagram/TikTok frames and reference images',
  styleLibrary: 'Manage reusable style building blocks',
  promptBuilder: 'Visual prompt composition with Nano-Banana formula',
  loraDataset: 'Build captioned LoRA training datasets from characters',
  profileAnalyzer: 'Extract style patterns from Instagram profiles',
  storyteller: 'Generate captions and hashtags for images',
  library: 'Browse and manage all generated images and videos',
  pasteInbox: 'Save pasted images for quick reuse in Photo Match or Scene Recreate',
  gallery: 'Browse and manage all generated images',
  videoGallery: 'Browse and manage all generated videos',
  characters: 'Manage character identities and references',
  keys: 'Configure API keys and connections',
  billing: 'View your plan and upgrade your subscription',
  referral: 'Earn 20% recurring commission for every creator you refer',
  logs: 'View recent app logs and copy them for support',
  settings: 'Change password, manage your account',
  photoMatch: 'Paste any photo — match background & pose with your character',
  nanoBypass: 'Multi-image AI editing — combine, transform, reimagine with Gemini 3',
  seedEdit: 'WaveSpeed SeedDream v4.5 — edit images while locking character identity',
  admin: 'Run the SaaS, inspect users, and review audit activity',
};

const PAGES = {
  generate: GenerateTabWrapper,
  nsfwGenerate: NsfwGeneratePage,
  batch: BatchPage,
  carousel: CarouselPage,
  scene: SceneRecreatePage,
  postClone: PostClonePage,
  instagramFrames: InstagramFramesPage,
  frameLibrary: FrameLibraryPage,
  styleLibrary: StyleLibraryPage,
  promptBuilder: PromptBuilderPage,
  loraDataset: LoraDatasetPage,
  profileAnalyzer: ProfileAnalyzerPage,
  storyteller: StorytellerPage,
  library: LibraryPage,
  pasteInbox: PasteInboxPage,
  video: VideoPage,
  videoGallery: VideoGalleryPage,
  auto: AutoGeneratorPage,
  gallery: GalleryPage,
  imageEditor: ImageEditorPage,
  characters: CharactersPage,
  keys: ApiKeysPage,
  billing: BillingPage,
  referral: ReferralPage,
  logs: LogsPage,
  photoMatch: PhotoMatchPage,
  nanoBypass: NanoBypassPage,
  seedEdit: SeedDreamEditPage,
  admin: AdminPage,
  settings: SettingsPage,
};

function PageFallback() {
  return (
    <div className="flex items-center justify-center py-24">
      <Spinner size={32} />
    </div>
  );
}

function GenerateTabWrapper() {
  const [tab, setTab] = useState('generate');
  return (
    <div className="space-y-4">
      <div className="flex gap-1 p-1 rounded-lg bg-zinc-900/80 border border-zinc-800/50 w-fit">
        <button
          onClick={() => setTab('generate')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-150 cursor-pointer ${
            tab === 'generate'
              ? 'bg-zinc-800 text-zinc-100 shadow-sm'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Generate
        </button>
        <button
          onClick={() => setTab('nsfw')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-150 cursor-pointer flex items-center gap-1.5 ${
            tab === 'nsfw'
              ? 'bg-red-900/60 text-red-300 shadow-sm'
              : 'text-zinc-500 hover:text-red-400'
          }`}
        >
          <span className="text-[10px]">🔞</span> NSFW
        </button>
      </div>
      <Suspense fallback={<PageFallback />}>
        {tab === 'generate' ? <GeneratePage key="generate" /> : <NsfwGeneratePage key="nsfw" />}
      </Suspense>
    </div>
  );
}

function StatusDot({ active, label, sublabel, offLabel, onClick }) {
  const Wrapper = onClick ? 'button' : 'div';
  const clickProps = onClick ? { onClick, type: 'button' } : {};
  if (active) {
    return (
      <Wrapper className={`flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/[0.08] px-3 py-1.5 text-xs font-medium text-emerald-300 ${onClick ? 'cursor-pointer hover:border-emerald-300/35 hover:bg-emerald-400/[0.12] transition' : ''}`} {...clickProps}>
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
        </span>
        <span className="hidden sm:block">{label}</span>
        {sublabel && <span className="text-[10px] font-mono text-emerald-200/45 hidden sm:block">{sublabel}</span>}
      </Wrapper>
    );
  }
  return (
    <Wrapper className={`flex items-center gap-2 rounded-full border border-red-400/15 bg-red-400/[0.06] px-3 py-1.5 text-xs font-medium text-red-300 ${onClick ? 'cursor-pointer hover:border-red-300/30 hover:bg-red-400/[0.10] transition' : ''}`} {...clickProps}>
      <span className="h-2 w-2 rounded-full bg-red-500" />
      <span className="hidden sm:block">{offLabel}</span>
    </Wrapper>
  );
}

function MainApp({ onLogout, currentUser }) {
  const { activeKey, setActiveKey, vertexActive, setVertexActive, integrationRefreshToken, page, navigateTo } = useApp();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [apifyConnected, setApifyConnected] = useState(false);
  const isFeedDominant = FEED_DOMINANT_PAGES.has(page);
  const showGenerationFeed = !FEED_HIDDEN_PAGES.has(page);

  useEffect(() => {
    if (page === 'admin' && !currentUser?.isAdmin) {
      navigateTo('generate');
    }
  }, [page, currentUser, navigateTo]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([keysApi.list(), keysApi.getApify(), keysApi.getVertex().catch(() => null)])
      .then(([data, apify, vtx]) => {
        if (cancelled) return;
        const act = data.find((k) => k.isActive);
        if (act) setActiveKey(act);
        else setActiveKey(null);
        setVertexActive(!!vtx?.hasVertexCredentials);
        setApifyConnected(!!apify?.hasApifyKey);
      })
      .catch(() => {
        if (!cancelled) setApifyConnected(false);
      });
    return () => { cancelled = true; };
  }, [integrationRefreshToken, setActiveKey]);

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Best-effort logout. Local auth state is cleared below.
    }
    onLogout();
  }

  const PageComponent = PAGES[page] || GeneratePage;
  const visibleSections = NAV_SECTIONS.map((section) => ({ ...section }))
    .filter((section) => section.items.length > 0);
  const visibleNavItems = visibleSections.flatMap((section) => section.items);
  const allNavItems = [...visibleNavItems, { id: 'admin', label: 'Admin' }, { id: 'logs', label: 'App Logs' }];
  const currentNav = allNavItems.find((n) => n.id === page);

  return (
    <TooltipPrimitive.Provider delayDuration={200}>
    <div className="relative flex h-screen overflow-hidden bg-[#050608] text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_16%_-12%,rgba(34,211,238,0.15),transparent_30%),radial-gradient(circle_at_86%_4%,rgba(249,115,22,0.10),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.035),transparent_22%)]" />
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[272px] flex-col border-r border-white/[0.07] bg-[#080a0f]/95 backdrop-blur-2xl transition-transform duration-250 lg:static lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <SidebarHeader />
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {visibleSections.map((section, sIdx) => (
            <div key={section.label} className={`mb-2 ${sIdx > 0 ? 'pt-3 mt-1' : ''}`}>
              <div className="flex items-center gap-2 px-3 py-1.5">
                <span className="text-[10px] font-black text-zinc-600 uppercase tracking-[0.22em] whitespace-nowrap">{section.label}</span>
                <div className="flex-1 h-px bg-white/[0.06]" />
              </div>
              <div className="space-y-1">
                {section.items.map((item) => {
                  const IconComponent = NAV_ICONS[item.id];
                  return (
                    <button key={item.id} onClick={() => { navigateTo(item.id); setSidebarOpen(false); }}
                      className={`relative flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-sm font-semibold transition-all duration-200 cursor-pointer group ${
                        page === item.id
                          ? 'bg-cyan-400/[0.105] text-cyan-200 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.16),0_14px_35px_rgba(8,145,178,0.10)]'
                          : 'text-zinc-500 hover:bg-white/[0.055] hover:text-zinc-100'
                      }`}>
                      {page === item.id && <span className="absolute left-0 top-1/2 h-7 w-1 -translate-y-1/2 rounded-r-full bg-cyan-300 shadow-[0_0_18px_rgba(34,211,238,0.85)]" />}
                      {IconComponent ? (
                        <span
                          className={`flex h-8 w-8 items-center justify-center rounded-xl transition-all duration-150 ${page === item.id ? 'bg-cyan-300/12 opacity-100' : 'bg-white/[0.045] opacity-55 group-hover:opacity-85'}`}
                          style={{
                            '--nc-gradient-1-color-1': (NAV_COLORS[item.id] || ['#a5b4fc','#6366f1'])[0],
                            '--nc-gradient-1-color-2': (NAV_COLORS[item.id] || ['#a5b4fc','#6366f1'])[1],
                          }}
                        >
                          <IconComponent uniqueId={`nav-${item.id}`} size={20} aria-hidden />
                        </span>
                      ) : null}
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {currentUser?.isAdmin && (
          <div className="px-3 pb-1 border-t border-zinc-800/30 pt-2">
            <button
              onClick={() => { navigateTo('admin'); setSidebarOpen(false); }}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150 cursor-pointer group ${
                page === 'admin'
                  ? 'bg-amber-600/10 text-amber-400 shadow-[inset_2px_0_0_0_#d97706]'
                  : 'text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800/40'
              }`}
            >
              {NAV_ICONS.admin && (
                <span className="flex items-center justify-center w-4 opacity-50 group-hover:opacity-70" style={{ '--nc-gradient-1-color-1': NAV_COLORS.admin[0], '--nc-gradient-1-color-2': NAV_COLORS.admin[1] }}>
                  <NAV_ICONS.admin uniqueId="nav-admin-bottom" size={16} aria-hidden />
                </span>
              )}
              Admin
            </button>
          </div>
        )}

        {currentUser?.usageInfo?.plan === 'free' && currentUser.usageInfo.limit != null && (() => {
          const used = Math.max(0, Number(currentUser.usageInfo.used) || 0);
          const limit = Math.max(1, Number(currentUser.usageInfo.limit) || 10);
          const displayUsed = Math.min(used, limit);
          const remaining = Math.max(0, limit - used);
          const isFinished = used >= limit;
          return (
          <div className="px-4 py-3 border-t border-white/[0.07]">
            {isFinished ? (
              <div className="rounded-lg bg-red-950/40 border border-red-800/30 p-3 text-center">
                <p className="text-[11px] font-semibold text-red-400 mb-1">Free limit reached</p>
                <p className="text-[10px] text-zinc-500 mb-2">You used {displayUsed}/{limit} generations</p>
                <button onClick={() => navigateTo('billing')}
                  className="w-full rounded-md bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium py-1.5 transition cursor-pointer">
                  Upgrade to Pro
                </button>
              </div>
            ) : (
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-[10px] text-zinc-500">Free trial</span>
                  <span className="text-[10px] text-zinc-500 font-mono">{displayUsed}/{limit}</span>
                </div>
                <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
                  <div className="h-full rounded-full bg-blue-500 transition-all"
                    style={{ width: `${Math.min(100, (displayUsed / limit) * 100)}%` }} />
                </div>
                <p className="text-[9px] text-zinc-600 mt-1">{remaining} generations left</p>
              </div>
            )}
          </div>
          );
        })()}

        <div className="border-t border-white/[0.07] px-4 py-3 flex items-center justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              {currentUser?.isOwner ? (
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-yellow-900/50 text-yellow-300 border border-yellow-600/40">Owner</span>
              ) : currentUser?.isAdmin ? (
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-700/30">Admin</span>
              ) : currentUser?.plan === 'unlimited' ? (
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-900/40 text-violet-300 border border-violet-700/30">Unlimited</span>
              ) : currentUser?.plan === 'pro' ? (
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300 border border-blue-700/30">Pro</span>
              ) : (
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-700/30">Free Trial</span>
              )}
            </div>
            <div className="text-[10px] text-zinc-500 truncate max-w-[145px]">{currentUser?.email || 'Unknown user'}</div>
          </div>
          <button
            onClick={handleLogout}
            className="text-[10px] text-zinc-600 hover:text-zinc-400 transition font-mono"
            title="Sign out"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-[72px] items-center justify-between border-b border-white/[0.07] bg-[#090b10]/88 backdrop-blur-2xl px-4 lg:px-6 shrink-0">
          <div className="flex items-center gap-3">
            <button className="lg:hidden text-zinc-400 hover:text-zinc-200 p-1 cursor-pointer" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 5h14M3 10h14M3 15h14" /></svg>
            </button>
            <div>
              <h2 className="text-lg font-black tracking-tight text-zinc-100 capitalize">{currentNav?.label || 'Studio'}</h2>
              {PAGE_DESCRIPTIONS[page] && <p className="text-[10px] text-zinc-500 hidden sm:block">{PAGE_DESCRIPTIONS[page]}</p>}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <StatusDot active={!!activeKey || vertexActive} label={activeKey?.name || (vertexActive ? 'Vertex AI' : null)} sublabel={activeKey?.maskedKey || (vertexActive ? 'GCP backend' : null)} offLabel="No API key" onClick={() => navigateTo('keys')} />
            <StatusDot active={apifyConnected} label="Apify connected" offLabel="Apify not set" onClick={() => navigateTo('keys')} />
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <main className={`${isFeedDominant ? 'w-[430px] xl:w-[460px] 2xl:w-[500px] shrink-0 overflow-y-auto overflow-x-hidden safe-bottom ambient-glow border-r border-white/[0.07] bg-white/[0.015] p-3 lg:p-5' : `flex-1 overflow-y-auto overflow-x-hidden safe-bottom ambient-glow ${showGenerationFeed ? 'border-r border-white/[0.07]' : ''} p-3 sm:p-4 lg:p-6`}`}>
            <div className={`relative ${isFeedDominant ? 'max-w-none' : 'mx-auto max-w-6xl'}`}>
              <PageErrorBoundary pageKey={page}>
                <Suspense fallback={<PageFallback />}>
                  <PageComponent key={page} />
                </Suspense>
              </PageErrorBoundary>
            </div>
          </main>
          {showGenerationFeed && <GenerationFeedPanel mode={isFeedDominant ? 'workspace' : 'rail'} />}
        </div>
      </div>

      <Toasts />
    </div>
    </TooltipPrimitive.Provider>
  );
}

const AuthSuspense = ({ children }) => (
  <Suspense fallback={<div className="min-h-screen bg-zinc-950 flex items-center justify-center"><Spinner size={32} /></div>}>
    {children}
  </Suspense>
);

function LicenseGate({ children }) {
  const electron = typeof window !== 'undefined' ? window.electronAPI : null;
  const [state, setState] = useState(() => electron?.isElectron ? 'loading' : 'valid');
  const [license, setLicense] = useState(null);
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  const refreshLicense = useCallback(() => {
    if (!electron?.isElectron || !electron.licenseLoad) {
      setState('valid');
      return;
    }
    setState('loading');
    electron.licenseLoad()
      .then((info) => {
        setLicense(info || null);
        setError(info && !info.valid ? info.reason || 'Invalid access token' : '');
        setState(info?.valid ? 'valid' : 'locked');
      })
      .catch(() => {
        setLicense(null);
        setError('Could not read the access token.');
        setState('locked');
      });
  }, [electron]);

  useEffect(() => { refreshLicense(); }, [refreshLicense]);

  const activate = async (event) => {
    event.preventDefault();
    setError('');
    const raw = token.trim();
    const customerEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      setError('Enter your customer email first.');
      return;
    }
    if (!raw) {
      setError('Paste your paid Kyros access token first.');
      return;
    }
    setState('activating');
    try {
      const result = await electron.licenseActivate({ email: customerEmail, key: raw });
      setLicense(result || null);
      if (result?.valid) {
        setToken('');
        setState('valid');
        return;
      }
      setError(result?.reason || 'Invalid access token.');
      setState('locked');
    } catch {
      setError('Activation failed. Try again.');
      setState('locked');
    }
  };

  if (state === 'valid') return children;
  if (state === 'loading') {
    return <div className="min-h-screen bg-zinc-950 flex items-center justify-center"><Spinner size={32} /></div>;
  }

  return (
    <div className="min-h-screen overflow-hidden bg-[#050608] text-white flex items-center justify-center p-6">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(34,211,238,0.18),transparent_28%),radial-gradient(circle_at_80%_0%,rgba(245,158,11,0.12),transparent_30%)]" />
      <div className="relative w-full max-w-lg rounded-3xl border border-white/10 bg-zinc-950/85 p-6 shadow-2xl backdrop-blur-xl">
        <div className="mb-6">
          <div className="mb-2 text-[10px] font-black uppercase tracking-[0.24em] text-cyan-300">Kyros Studio Access</div>
          <h1 className="text-2xl font-black tracking-tight">Paid token required</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-400">This app no longer includes free trial access. Activate a paid Kyros token to open the studio.</p>
        </div>
        <form onSubmit={activate} className="space-y-4">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="customer@email.com"
            type="email"
            className="w-full rounded-2xl border border-white/10 bg-black/40 p-4 text-sm text-zinc-100 outline-none transition focus:border-cyan-400/60"
          />
          <textarea
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="KYROS2-..."
            spellCheck={false}
            className="min-h-28 w-full resize-none rounded-2xl border border-white/10 bg-black/40 p-4 font-mono text-xs text-zinc-100 outline-none transition focus:border-cyan-400/60"
          />
          {error && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</div>}
          {license?.machineMismatch && <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">This token is machine locked. Contact support for a transfer.</div>}
          <button
            type="submit"
            disabled={state === 'activating'}
            className="w-full rounded-2xl bg-cyan-400 px-4 py-3 text-sm font-black text-zinc-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {state === 'activating' ? 'Activating...' : 'Activate Paid Token'}
          </button>
        </form>
        <p className="mt-4 text-center text-[11px] text-zinc-600">Tokens are signed, expire automatically, and lock to this machine after activation.</p>
      </div>
    </div>
  );
}

const AUTH_PATHS = {
  landing: '/',
  login: '/login',
  register: '/register',
  'forgot-password': '/forgot-password',
  'reset-password': '/reset-password',
  'verify-email': '/verify-email',
};

function getAuthPageFromLocation() {
  if (typeof window === 'undefined') return 'landing';
  const params = new URLSearchParams(window.location.search);
  const { pathname } = window.location;
  if (pathname === AUTH_PATHS['verify-email'] && params.get('token')) return 'verify-email';
  if (pathname === AUTH_PATHS['reset-password'] && params.get('token')) return 'reset-password';
  if (pathname === AUTH_PATHS.login) return 'login';
  if (pathname === AUTH_PATHS.register) return 'register';
  if (pathname === AUTH_PATHS['forgot-password']) return 'forgot-password';
  return 'landing';
}

function syncAuthLocation(page, { replace = false } = {}) {
  if (typeof window === 'undefined') return;
  const nextPath = AUTH_PATHS[page] || AUTH_PATHS.landing;
  const nextUrl = new URL(window.location.href);
  nextUrl.pathname = nextPath;
  if (page !== 'reset-password' && page !== 'verify-email') {
    nextUrl.search = '';
  }
  const nextHref = `${nextUrl.pathname}${nextUrl.search}`;
  const currentHref = `${window.location.pathname}${window.location.search}`;
  if (nextHref === currentHref) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', nextHref);
}

// Auth states: 'loading' | 'authenticated' | 'unauthenticated'
export default function App() {
  const isPublicPreviewHost =
    typeof window !== 'undefined' && window.location.hostname.endsWith('trycloudflare.com');
  const [authState, setAuthState] = useState('loading');
  const [authPage, setAuthPage] = useState(getAuthPageFromLocation);
  const [currentUser, setCurrentUser] = useState(null);

  const refreshCurrentUser = useCallback(async ({ silent = false } = {}) => {
    if (isPublicPreviewHost) return null;
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) {
        if (!silent) {
          setCurrentUser(null);
          setAuthState('unauthenticated');
        }
        return null;
      }
      const data = await res.json();
      setCurrentUser(data);
      return data;
    } catch {
      if (!silent) {
        setCurrentUser(null);
        setAuthState('unauthenticated');
      }
      return null;
    }
  }, [isPublicPreviewHost]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handlePopState = () => setAuthPage(getAuthPageFromLocation());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (isPublicPreviewHost) {
      setAuthState('unauthenticated');
      setAuthPage('landing');
      setCurrentUser(null);
      return;
    }

    fetch('/api/auth/status', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        setAuthState(data.authenticated ? 'authenticated' : 'unauthenticated');
        if (!data.authenticated) setCurrentUser(null);
      })
      .catch(() => {
        setAuthState('unauthenticated');
        setCurrentUser(null);
      });
  }, [isPublicPreviewHost]);

  useEffect(() => {
    if (isPublicPreviewHost) return;
    if (authState !== 'authenticated') return;
    let cancelled = false;
    refreshCurrentUser().then((data) => {
      if (cancelled || data) return;
      setCurrentUser(null);
      setAuthState('unauthenticated');
    });
    return () => {
      cancelled = true;
    };
  }, [authState, isPublicPreviewHost, refreshCurrentUser]);

  useEffect(() => {
    if (isPublicPreviewHost || authState !== 'authenticated') return undefined;
    let refreshTimer = null;
    const scheduleRefresh = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshCurrentUser({ silent: true });
      }, 250);
    };
    window.addEventListener('kyros:usage-changed', scheduleRefresh);
    window.addEventListener('focus', scheduleRefresh);
    return () => {
      window.clearTimeout(refreshTimer);
      window.removeEventListener('kyros:usage-changed', scheduleRefresh);
      window.removeEventListener('focus', scheduleRefresh);
    };
  }, [authState, isPublicPreviewHost, refreshCurrentUser]);

  if (authState === 'loading') {
    return (
      <LicenseGate><div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Spinner size={32} />
      </div></LicenseGate>
    );
  }

  if (authState === 'unauthenticated') {
    const navigate = (page, options) => {
      setAuthPage(page);
      syncAuthLocation(page, options);
    };
    if (authPage === 'login') {
      return <LicenseGate><AuthSuspense><LandingPage initialAuthModal="login" onNavigate={navigate} /></AuthSuspense></LicenseGate>;
    }
    if (authPage === 'register') {
      return <LicenseGate><AuthSuspense><LandingPage initialAuthModal="register" onNavigate={navigate} /></AuthSuspense></LicenseGate>;
    }
    if (authPage === 'forgot-password') {
      return <LicenseGate><AuthSuspense><ForgotPasswordPage onNavigate={navigate} /></AuthSuspense></LicenseGate>;
    }
    if (authPage === 'reset-password') {
      return <LicenseGate><AuthSuspense><ResetPasswordPage onNavigate={navigate} /></AuthSuspense></LicenseGate>;
    }
    if (authPage === 'verify-email') {
      return <LicenseGate><AuthSuspense><VerifyEmailPage onNavigate={navigate} /></AuthSuspense></LicenseGate>;
    }
    // Default: landing page
    return <LicenseGate><AuthSuspense><LandingPage onNavigate={navigate} /></AuthSuspense></LicenseGate>;
  }

  if (!currentUser) {
    return (
      <LicenseGate><div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Spinner size={32} />
      </div></LicenseGate>
    );
  }

  return <LicenseGate><MainApp currentUser={currentUser} onLogout={() => {
    setCurrentUser(null);
    setAuthState('unauthenticated');
    setAuthPage('landing');
    syncAuthLocation('landing', { replace: true });
  }} /></LicenseGate>;
}
