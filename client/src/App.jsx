import { lazy, Suspense, useState, useEffect, useCallback } from 'react';
const LoginPage = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));
const VerifyEmailPage = lazy(() => import('./pages/VerifyEmailPage'));
import { useApp } from './context/AppContext';
import { Toasts, Spinner } from './components/UI';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { PageErrorBoundary } from './components/ErrorBoundary';
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
  IconRulerPen,
  IconGrid2,
  IconUsers,
  IconKey,
  IconCreditCards,
  IconBulletList,
} from 'nucleo-glass';

const GeneratePage = lazy(() => import('./pages/GeneratePage'));
const BatchPage = lazy(() => import('./pages/BatchPage'));
const CarouselPage = lazy(() => import('./pages/CarouselPage'));
const StorytellerPage = lazy(() => import('./pages/StorytellerPage'));
const AutoGeneratorPage = lazy(() => import('./pages/AutoGeneratorPage'));
const CharactersPage = lazy(() => import('./pages/CharactersPage'));
const GalleryPage = lazy(() => import('./pages/GalleryPage'));
const SceneRecreatePage = lazy(() => import('./pages/SceneRecreatePage'));
const ReelRecreatePage = lazy(() => import('./pages/ReelRecreatePage'));
const PostClonePage = lazy(() => import('./pages/PostClonePage'));
const StyleLibraryPage = lazy(() => import('./pages/StyleLibraryPage'));
const ProfileAnalyzerPage = lazy(() => import('./pages/ProfileAnalyzerPage'));
const PromptBuilderPage = lazy(() => import('./pages/PromptBuilderPage'));
const ApiKeysPage = lazy(() => import('./pages/ApiKeysPage'));
const VideoPage = lazy(() => import('./pages/VideoPage'));
const VideoGalleryPage = lazy(() => import('./pages/VideoGalleryPage'));
const ReformatPage = lazy(() => import('./pages/ReformatPage'));
const NsfwGeneratePage = lazy(() => import('./pages/NsfwGeneratePage'));
const ImageEditorPage = lazy(() => import('./pages/ImageEditorPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const InstaFramePage = lazy(() => import('./pages/InstaFramePage'));
const VideoComposePage = lazy(() => import('./pages/VideoComposePage'));
const LogsPage = lazy(() => import('./pages/LogsPage'));

const NAV_ICONS = {
  generate: IconBadgeSparkle,
  nsfwGenerate: IconFlame,
  batch: IconAppStack,
  auto: IconBolt,
  carousel: IconLayers,
  scene: IconCamera,
  video: IconVideo,
  videoGallery: IconGrid2,
  reel: IconSwap,
  postClone: IconCopies,
  styleLibrary: IconColorPalette,
  promptBuilder: IconMagicWandSparkle,
  profileAnalyzer: IconMagnifier,
  storyteller: IconBookOpen,
  gallery: IconImage,
  imageEditor: IconRulerPen,
  instaFrame: IconCamera,
  videoCompose: IconVideo,
  characters: IconUsers,
  keys: IconKey,
  billing: IconCreditCards,
  logs: IconBulletList,
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
  reel:           ['#fdba74', '#ea580c'],
  postClone:      ['#d8b4fe', '#9333ea'],
  styleLibrary:   ['#6ee7b7', '#059669'],
  promptBuilder:  ['#a5b4fc', '#4f46e5'],
  profileAnalyzer:['#7dd3fc', '#0284c7'],
  storyteller:    ['#bef264', '#65a30d'],
  gallery:        ['#fcd34d', '#d97706'],
  imageEditor:    ['#f9a8d4', '#db2777'],
  instaFrame:     ['#67e8f9', '#0891b2'],
  videoCompose:   ['#fdba74', '#ea580c'],
  characters:     ['#c4b5fd', '#7c3aed'],
  keys:           ['#94a3b8', '#475569'],
  billing:        ['#86efac', '#16a34a'],
  logs:           ['#fda4af', '#e11d48'],
};

const NAV_SECTIONS = [
  {
    label: 'Create',
    items: [
      { id: 'generate', label: 'Generate' },
      { id: 'nsfwGenerate', label: 'NSFW Generate' },
      { id: 'batch', label: 'Batch' },
      { id: 'video', label: 'Video' },
      { id: 'auto', label: 'Auto Generator' },
    ],
  },
  {
    label: 'Remix',
    items: [
      { id: 'carousel', label: 'Carousel' },
      { id: 'scene', label: 'Scene Recreate' },
      { id: 'reel', label: 'Reel Copy' },
      { id: 'postClone', label: 'Post Clone' },
      { id: 'instaFrame', label: 'Insta Frame' },
      { id: 'videoCompose', label: 'Video Composer' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { id: 'styleLibrary', label: 'Style Library' },
      { id: 'promptBuilder', label: 'Prompt Builder' },
      { id: 'profileAnalyzer', label: 'Profile Analyzer' },
      { id: 'storyteller', label: 'Storyteller' },
    ],
  },
  {
    label: 'Manage',
    items: [
      { id: 'gallery', label: 'Gallery' },
      { id: 'imageEditor', label: 'Image Editor' },
      { id: 'videoGallery', label: 'Video Gallery' },
      { id: 'characters', label: 'Characters' },
      { id: 'keys', label: 'API Keys' },
      { id: 'billing', label: 'Billing' },
      { id: 'logs', label: 'App Logs' },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);

const APP_VERSION = '8.1.0';

function SidebarHeader() {
  return (
    <header className="flex h-14 items-center gap-2 border-b border-zinc-800/40 px-4">
      <span className="text-sm font-semibold text-zinc-100 tracking-tight">Content Studio</span>
      <span className="inline-flex items-center rounded-full border border-zinc-700/50 bg-zinc-800/60 px-1.5 py-px text-[9px] text-zinc-500 font-mono">
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
  reel: 'Recreate Instagram reels with your character',
  postClone: 'Clone Instagram posts with your character',
  styleLibrary: 'Manage reusable style building blocks',
  promptBuilder: 'Visual prompt composition with Nano-Banana formula',
  profileAnalyzer: 'Extract style patterns from Instagram profiles',
  storyteller: 'Generate captions and hashtags for images',
  gallery: 'Browse and manage all generated images',
  videoGallery: 'Browse and manage all generated videos',
  characters: 'Manage character identities and references',
  keys: 'Configure API keys and connections',
  billing: 'View your plan and upgrade your subscription',
  instaFrame: 'Extract the first frame from any Instagram Reel',
  videoCompose: 'Drop a video — add audio and text overlay',
  logs: 'View recent app logs and copy them for support',
};

const PAGES = {
  generate: GeneratePage,
  nsfwGenerate: NsfwGeneratePage,
  batch: BatchPage,
  carousel: CarouselPage,
  scene: SceneRecreatePage,
  reel: ReelRecreatePage,
  postClone: PostClonePage,
  styleLibrary: StyleLibraryPage,
  promptBuilder: PromptBuilderPage,
  profileAnalyzer: ProfileAnalyzerPage,
  storyteller: StorytellerPage,
  video: VideoPage,
  videoGallery: VideoGalleryPage,
  auto: AutoGeneratorPage,
  gallery: GalleryPage,
  imageEditor: ImageEditorPage,
  characters: CharactersPage,
  keys: ApiKeysPage,
  billing: BillingPage,
  instaFrame: InstaFramePage,
  videoCompose: VideoComposePage,
  logs: LogsPage,
};

function PageFallback() {
  return (
    <div className="flex items-center justify-center py-24">
      <Spinner size={32} />
    </div>
  );
}

function StatusDot({ active, label, sublabel, offLabel, onClick }) {
  const Wrapper = onClick ? 'button' : 'div';
  const clickProps = onClick ? { onClick, type: 'button' } : {};
  if (active) {
    return (
      <Wrapper className={`flex items-center gap-2 ${onClick ? 'cursor-pointer hover:opacity-80 transition' : ''}`} {...clickProps}>
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
        </span>
        <span className="text-xs text-zinc-400 hidden sm:block">{label}</span>
        {sublabel && <span className="text-[10px] font-mono text-zinc-600 hidden sm:block">{sublabel}</span>}
      </Wrapper>
    );
  }
  return (
    <Wrapper className={`flex items-center gap-2 ${onClick ? 'cursor-pointer hover:opacity-80 transition' : ''}`} {...clickProps}>
      <span className="h-2 w-2 rounded-full bg-red-500" />
      <span className="text-xs text-zinc-500 hidden sm:block">{offLabel}</span>
    </Wrapper>
  );
}

function MainApp({ onLogout }) {
  const { activeKey, setActiveKey, page, navigateTo } = useApp();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [apifyConnected, setApifyConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([keysApi.list(), keysApi.getApify()])
      .then(([data, apify]) => {
        if (cancelled) return;
        const act = data.find((k) => k.isActive);
        if (act) setActiveKey(act);
        else setActiveKey(null);
        setApifyConnected(!!apify?.hasApifyKey);
      })
      .catch(() => {
        if (!cancelled) setApifyConnected(false);
      });
    return () => { cancelled = true; };
  }, [setActiveKey]);

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    onLogout();
  }

  const PageComponent = PAGES[page] || GeneratePage;
  const currentNav = ALL_NAV_ITEMS.find((n) => n.id === page);

  return (
    <TooltipPrimitive.Provider delayDuration={200}>
    <div className="flex h-screen overflow-hidden bg-zinc-950">
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <aside className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-zinc-800/50 bg-zinc-900/95 backdrop-blur-md transition-transform duration-250 lg:static lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <SidebarHeader />
        <nav className="flex-1 overflow-y-auto px-3 py-3">
          {NAV_SECTIONS.map((section, sIdx) => (
            <div key={section.label} className={`mb-1.5 ${sIdx > 0 ? 'pt-3 mt-1' : ''}`}>
              <div className="flex items-center gap-2 px-3 py-1.5">
                <span className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider whitespace-nowrap">{section.label}</span>
                <div className="flex-1 h-px bg-zinc-800/60" />
              </div>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const IconComponent = NAV_ICONS[item.id];
                  return (
                    <button key={item.id} onClick={() => { navigateTo(item.id); setSidebarOpen(false); }}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150 cursor-pointer group ${
                        page === item.id
                          ? 'bg-blue-600/12 text-blue-400 shadow-[inset_2px_0_0_0_#3b82f6]'
                          : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200 hover:translate-x-0.5'
                      }`}>
                      {IconComponent ? (
                        <span
                          className={`flex items-center justify-center w-5 transition-all duration-150 ${page === item.id ? 'opacity-100' : 'opacity-50 group-hover:opacity-80'}`}
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

        <div className="border-t border-zinc-800/40 px-4 py-3 flex items-center justify-between">
          <div className="text-[10px] text-zinc-600 font-mono">Local Only</div>
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
        <header className="flex h-14 items-center justify-between border-b border-zinc-800/40 bg-zinc-900/60 backdrop-blur-md px-4 lg:px-6 shrink-0">
          <div className="flex items-center gap-3">
            <button className="lg:hidden text-zinc-400 hover:text-zinc-200 p-1 cursor-pointer" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 5h14M3 10h14M3 15h14" /></svg>
            </button>
            <div>
              <h2 className="text-sm font-semibold text-zinc-300 capitalize">{currentNav?.label || 'Studio'}</h2>
              {PAGE_DESCRIPTIONS[page] && <p className="text-[10px] text-zinc-500 hidden sm:block">{PAGE_DESCRIPTIONS[page]}</p>}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <StatusDot active={!!activeKey} label={activeKey?.name} sublabel={activeKey?.maskedKey} offLabel="No API key" onClick={() => navigateTo('keys')} />
            <StatusDot active={apifyConnected} label="Apify connected" offLabel="Apify not set" onClick={() => navigateTo('keys')} />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-4 lg:p-6 safe-bottom ambient-glow">
          <div className="relative mx-auto max-w-6xl">
            <PageErrorBoundary pageKey={page}>
              <Suspense fallback={<PageFallback />}>
                <PageComponent key={page} />
              </Suspense>
            </PageErrorBoundary>
          </div>
        </main>
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

// Auth states: 'loading' | 'authenticated' | 'unauthenticated'
export default function App() {
  const [authState, setAuthState] = useState('loading');
  const [authPage, setAuthPage] = useState('login');

  useEffect(() => {
    // Check for token in URL (verify email, reset password)
    const params = new URLSearchParams(window.location.search);
    if (window.location.pathname === '/verify-email' && params.get('token')) {
      setAuthPage('verify-email');
    } else if (window.location.pathname === '/reset-password' && params.get('token')) {
      setAuthPage('reset-password');
    }

    fetch('/api/auth/status', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        setAuthState(data.authenticated ? 'authenticated' : 'unauthenticated');
      })
      .catch(() => {
        setAuthState('unauthenticated');
      });
  }, []);

  if (authState === 'loading') {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Spinner size={32} />
      </div>
    );
  }

  if (authState === 'unauthenticated') {
    const navigate = (page) => setAuthPage(page);
    if (authPage === 'register') {
      return <AuthSuspense><RegisterPage onNavigate={navigate} /></AuthSuspense>;
    }
    if (authPage === 'forgot-password') {
      return <AuthSuspense><ForgotPasswordPage onNavigate={navigate} /></AuthSuspense>;
    }
    if (authPage === 'reset-password') {
      return <AuthSuspense><ResetPasswordPage onNavigate={navigate} /></AuthSuspense>;
    }
    if (authPage === 'verify-email') {
      return <AuthSuspense><VerifyEmailPage onNavigate={navigate} /></AuthSuspense>;
    }
    return <AuthSuspense><LoginPage onLogin={() => setAuthState('authenticated')} onNavigate={navigate} /></AuthSuspense>;
  }

  return <MainApp onLogout={() => { setAuthState('unauthenticated'); setAuthPage('login'); }} />;
}
