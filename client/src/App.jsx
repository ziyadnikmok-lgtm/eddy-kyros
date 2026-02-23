import { lazy, Suspense, useState, useEffect } from 'react';
import { useApp } from './context/AppContext';
import { Toasts, Spinner } from './components/UI';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { PageErrorBoundary } from './components/ErrorBoundary';
import { keys as keysApi } from './services/api';

// Lazy-loaded pages — each becomes its own chunk, loaded on first visit
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

const NAV_SECTIONS = [
  {
    label: 'Create',
    items: [
      { id: 'generate', label: 'Generate', icon: '\u2726' },
      { id: 'batch', label: 'Batch', icon: '\u229E' },
      { id: 'auto', label: 'Auto Generator', icon: '\u26A1' },
    ],
  },
  {
    label: 'Remix',
    items: [
      { id: 'carousel', label: 'Carousel', icon: '\u25cd' },
      { id: 'scene', label: 'Scene Recreate', icon: '\uD83C\uDFAC' },
      { id: 'reel', label: 'Reel Copy', icon: '\uD83C\uDFA5' },
      { id: 'postClone', label: 'Post Clone', icon: '\uD83D\uDDBC' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { id: 'styleLibrary', label: 'Style Library', icon: '\uD83C\uDFA8' },
      { id: 'promptBuilder', label: 'Prompt Builder', icon: '\uD83E\uDDE9' },
      { id: 'profileAnalyzer', label: 'Profile Analyzer', icon: '\uD83D\uDD0D' },
      { id: 'storyteller', label: 'Storyteller', icon: '\u270D' },
    ],
  },
  {
    label: 'Manage',
    items: [
      { id: 'gallery', label: 'Gallery', icon: '\uD83D\uDDBC' },
      { id: 'characters', label: 'Characters', icon: '\u263B' },
      { id: 'keys', label: 'API Keys', icon: '\u26BF' },
    ],
  },
];

// Flat list for header label lookup
const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);

const PAGE_DESCRIPTIONS = {
  generate: 'Create a single image with full control',
  batch: 'Generate multiple images in parallel',
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
  characters: 'Manage character identities and references',
  keys: 'Configure API keys and connections',
};

const PAGES = {
  generate: GeneratePage,
  batch: BatchPage,
  carousel: CarouselPage,
  scene: SceneRecreatePage,
  reel: ReelRecreatePage,
  postClone: PostClonePage,
  styleLibrary: StyleLibraryPage,
  promptBuilder: PromptBuilderPage,
  profileAnalyzer: ProfileAnalyzerPage,
  storyteller: StorytellerPage,
  auto: AutoGeneratorPage,
  gallery: GalleryPage,
  characters: CharactersPage,
  keys: ApiKeysPage,
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

export default function App() {
  const { activeKey, setActiveKey, page, navigateTo } = useApp();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [apifyConnected, setApifyConnected] = useState(false);

  useEffect(() => {
    Promise.all([keysApi.list(), keysApi.getApify()])
      .then(([data, apify]) => {
        const act = data.find((k) => k.isActive);
        if (act) setActiveKey(act);
        else setActiveKey(null);
        setApifyConnected(!!apify?.hasApifyKey);
      })
      .catch(() => {
        setApifyConnected(false);
      });
  }, [setActiveKey]);

  const PageComponent = PAGES[page] || GeneratePage;
  const currentNav = ALL_NAV_ITEMS.find((n) => n.id === page);

  return (
    <TooltipPrimitive.Provider delayDuration={200}>
    <div className="flex h-screen overflow-hidden bg-zinc-950">
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <aside className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-zinc-800/50 bg-zinc-900/95 backdrop-blur-md transition-transform duration-250 lg:static lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        {/* Logo area with ambient glow */}
        <div className="relative flex h-16 items-center gap-2.5 border-b border-zinc-800/40 px-5 overflow-hidden">
          {/* Ambient glow behind logo */}
          <div className="absolute -left-4 -top-4 w-24 h-24 rounded-full bg-blue-500/10 blur-2xl pointer-events-none" style={{ animation: 'glow-breathe 4s ease-in-out infinite' }} />
          <div className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 text-sm font-bold text-white shadow-lg shadow-blue-600/30">AI</div>
          <div className="relative">
            <div className="text-sm font-semibold text-zinc-100 tracking-tight">Content Studio</div>
            <div className="inline-flex items-center rounded-full border border-zinc-700/50 bg-zinc-800/60 px-1.5 py-px text-[9px] text-zinc-500 font-mono mt-0.5">v8.0</div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-3">
          {NAV_SECTIONS.map((section, sIdx) => (
            <div key={section.label} className={`mb-1.5 ${sIdx > 0 ? 'pt-3 mt-1' : ''}`}>
              {/* Section label with decorative line */}
              <div className="flex items-center gap-2 px-3 py-1.5">
                <span className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider whitespace-nowrap">{section.label}</span>
                <div className="flex-1 h-px bg-zinc-800/60" />
              </div>
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <button key={item.id} onClick={() => { navigateTo(item.id); setSidebarOpen(false); }}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150 cursor-pointer group ${
                      page === item.id
                        ? 'bg-blue-600/12 text-blue-400 shadow-[inset_2px_0_0_0_#3b82f6]'
                        : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200 hover:translate-x-0.5'
                    }`}>
                    <span className={`w-5 text-center text-base transition-opacity duration-150 ${page === item.id ? 'opacity-100' : 'opacity-60 group-hover:opacity-90'}`}>{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-zinc-800/40 px-4 py-3">
          <div className="text-[10px] text-zinc-600 font-mono">Local Only</div>
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

        <main className="flex-1 overflow-y-auto p-4 lg:p-6 ambient-glow">
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
