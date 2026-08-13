import { lazy, Suspense, useState, useEffect, useCallback } from 'react';
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));
const VerifyEmailPage = lazy(() => import('./pages/VerifyEmailPage'));
const LandingPage = lazy(() => import('./pages/LandingPage'));
import { useApp } from './context/AppContext';
import { Toasts, Spinner } from './components/UI';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { PageErrorBoundary } from './components/ErrorBoundary';
import GenerationFeedPanel, { GenerationFeedVideoWatcher } from './components/GenerationFeedPanel';
import { keys as keysApi } from './services/api';
import { WORKSPACES, getWorkspace, setWorkspace as persistWorkspace, workspaceEngines } from './lib/workspace';
import { cn } from './lib/utils';
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
const VideoEditorPage = lazy(() => import('./pages/VideoEditorPage'));
const SeedanceVideoPage = lazy(() => import('./pages/SeedanceVideoPage'));
const SeedanceOmniPage = lazy(() => import('./pages/SeedanceOmniPage'));
const SeedreamEditPage = lazy(() => import('./pages/SeedreamEditPage'));
const SeedreamGeneratePage = lazy(() => import('./pages/SeedreamGeneratePage'));
const OutfitSwapSeedreamPage = lazy(() => import('./pages/OutfitSwapSeedreamPage'));
const PhotoMatchSeedreamPage = lazy(() => import('./pages/PhotoMatchSeedreamPage'));
const PinterestFeedPage = lazy(() => import('./pages/PinterestFeedPage'));
const SceneRecreateSeedreamPage = lazy(() => import('./pages/SceneRecreateSeedreamPage'));
const PoseRemixSeedreamPage = lazy(() => import('./pages/PoseRemixSeedreamPage'));
const EddyGeneratePage = lazy(() => import('./pages/EddyGeneratePage'));
const EddyLibraryPage = lazy(() => import('./pages/EddyTabs').then((m) => ({ default: m.EddyLibraryPage })));
const EddyOutfitPage = lazy(() => import('./pages/EddyTabs').then((m) => ({ default: m.EddyOutfitPage })));
const EddyPosePage = lazy(() => import('./pages/EddyTabs').then((m) => ({ default: m.EddyPosePage })));
const EddyEnvironmentPage = lazy(() => import('./pages/EddyTabs').then((m) => ({ default: m.EddyEnvironmentPage })));
const EddyBaseLibraryPage = lazy(() => import('./pages/EddyTabs').then((m) => ({ default: m.EddyBaseLibraryPage })));
const EddyBasePage = lazy(() => import('./pages/EddyBasePage'));
// Same component as Eddy, in its Max Nano mode — see the `mode` prop on EddyGeneratePage.
const EddyMaxOutfitPage = lazy(() => import('./pages/EddyGeneratePage').then((m) => ({ default: () => <m.default mode="maxOutfit" /> })));
const EddyMaxNanoPage = lazy(async () => {
  const m = await import('./pages/EddyGeneratePage');
  const Page = m.default;
  return { default: () => <Page mode="maxNano" /> };
});
const VideoLibraryPage = lazy(() => import('./pages/EddyTabs').then((m) => ({ default: m.VideoLibraryPage })));
const EddyCharacterPage = lazy(() => import('./pages/EddyCharacterPage'));
const NsfwGeneratePage = lazy(() => import('./pages/NsfwGeneratePage'));
const ImageEditorPage = lazy(() => import('./pages/ImageEditorPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const InstagramFramesPage = lazy(() => import('./pages/InstagramFramesPage'));
const InstagramReelPage = lazy(() => import('./pages/InstagramReelPage'));
const LogsPage = lazy(() => import('./pages/LogsPage'));
const PhotoMatchPage = lazy(() => import('./pages/PhotoMatchPage'));
const PoseFixPage = lazy(() => import('./pages/PoseFixPage'));
const NanoBypassPage = lazy(() => import('./pages/NanoBypassPage'));
const OutfitSwapPage = lazy(() => import('./pages/OutfitSwapPage'));
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
  seedanceVideo: IconVideo,
  seedanceOmni: IconVideo,
  seedreamEdit: IconLayers,
  seedreamGenerate: IconMagicWandSparkle,
  outfitSwapSeedream: IconLayers,
  photoMatchSeedream: IconCrosshairs,
  pinterestFeed: IconCrosshairs,
  sceneRecreateSeedream: IconCamera,
  poseRemixSeedream: IconSwap,
  eddyGenerate: IconBadgeSparkle,
  eddy: IconBadgeSparkle,
  eddyLibrary: IconGrid2,
  eddyOutfit: IconLayers,
  eddyPose: IconSwap,
  eddyEnvironment: IconGrid2,
  eddyMaxNano: IconBadgeSparkle,
  eddyMaxOutfit: IconBadgeSparkle,
  eddyBase: IconGrid2,
  eddyBaseLibrary: IconGrid2,
  videoLibrary: IconGrid2,
  eddyCharacter: IconUsers,
  postClone: IconCopies,
  instagramFrames: IconImage,
  instagramReel: IconCamera,
  frameLibrary: IconGrid2,
  styleLibrary: IconColorPalette,
  promptBuilder: IconMagicWandSparkle,
  loraDataset: IconLayers,
  profileAnalyzer: IconMagnifier,
  storyteller: IconBookOpen,
  library: IconGrid2,
  pasteInbox: IconClipboard,
  imageEditor: IconRulerPen,
  videoEditor: IconVideo,
  characters: IconUsers,
  keys: IconKey,
  billing: IconCreditCards,
  logs: IconBulletList,
  photoMatch: IconCrosshairs,
  poseFix: IconSwap,
  nanoBypass: IconMagicWandSparkle,
  outfitSwap: IconLayers,
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
  seedanceVideo:  ['#f9a8d4', '#d946a8'],
  seedanceOmni:   ['#c4b5fd', '#d946a8'],
  seedreamEdit:   ['#f0abfc', '#c026d3'],
  seedreamGenerate: ['#fda4af', '#e11d48'],
  outfitSwapSeedream: ['#f9a8d4', '#c026d3'],
  photoMatchSeedream: ['#f0abfc', '#a21caf'],
  pinterestFeed: ['#fca5a5', '#b91c1c'],
  sceneRecreateSeedream: ['#67e8f9', '#0891b2'],
  poseRemixSeedream: ['#fbcfe8', '#db2777'],
  eddyGenerate: ['#fde68a', '#f59e0b'],
  eddy: ['#fde68a', '#f59e0b'],
  eddyLibrary: ['#fcd34d', '#d97706'],
  eddyOutfit: ['#fdba74', '#ea580c'],
  eddyPose: ['#fda4af', '#e11d48'],
  eddyEnvironment: ['#a7f3d0', '#059669'],
  eddyMaxNano: ['#93c5fd', '#2563eb'],
  eddyMaxOutfit: ['#c4b5fd', '#7c3aed'],
  eddyBase: ['#a7f3d0', '#059669'],
  eddyBaseLibrary: ['#6ee7b7', '#047857'],
  videoLibrary: ['#c4b5fd', '#7c3aed'],
  eddyCharacter: ['#fcd34d', '#f59e0b'],
  postClone:      ['#d8b4fe', '#9333ea'],
  instagramFrames: ['#f9a8d4', '#e879f9'],
  instagramReel:  ['#fbcfe8', '#c026d3'],
  frameLibrary:    ['#fcd34d', '#f43f5e'],
  styleLibrary:   ['#6ee7b7', '#059669'],
  promptBuilder:  ['#a5b4fc', '#4f46e5'],
  profileAnalyzer:['#7dd3fc', '#0284c7'],
  storyteller:    ['#bef264', '#65a30d'],
  library:        ['#67e8f9', '#0284c7'],
  pasteInbox:     ['#c084fc', '#7c3aed'],
  imageEditor:    ['#f9a8d4', '#db2777'],
  videoEditor:    ['#c4b5fd', '#7c3aed'],
  characters:     ['#c4b5fd', '#7c3aed'],
  keys:           ['#94a3b8', '#475569'],
  billing:        ['#86efac', '#16a34a'],
  logs:           ['#fda4af', '#e11d48'],
  photoMatch:     ['#6ee7b7', '#0891b2'],
  poseFix:        ['#fbcfe8', '#db2777'],
  nanoBypass:     ['#c4b5fd', '#7c3aed'],
  outfitSwap:     ['#f472b6', '#a855f7'],
  referral:       ['#fb923c', '#ea580c'],
  admin:          ['#fcd34d', '#d97706'],
  settings:       ['#94a3b8', '#64748b'],
};

const NAV_SECTIONS = [
  // The Create section is gone from the sidebar. Its pages are still registered and still
  // reachable by URL — only the nav entries were removed, so nothing that links to them breaks.
  // Everything Muapi/ByteDance in one place: Seedream edits images, Seedance makes video from
  // them. Sits directly above Media Grab because Frame Grabber is where Omni's clips come from.
  {
    label: 'Eddy',
    items: [
      { id: 'eddy', label: 'Eddy' },
      // Directly under Eddy: it is the same page in another mode, so it belongs beside the page it
      // mirrors rather than down among the collections (owner, 2026-08-09).
      { id: 'eddyMaxNano', label: 'Max Nano' },
      // Stage 2 sits beside stage 1: Max Nano makes the poses, Max Outfit dresses them.
      { id: 'eddyMaxOutfit', label: 'Max Outfit' },
      { id: 'eddyLibrary', label: 'Library' },
      { id: 'eddyOutfit', label: 'Outfit' },
      { id: 'eddyPose', label: 'Pose' },
      { id: 'eddyBase', label: 'Base' },
      { id: 'eddyBaseLibrary', label: 'Base Library' },
      { id: 'eddyCharacter', label: 'Character' },
    ],
  },
  {
    engine: 'seedream',
    label: 'Seedream · Seedance',
    items: [
      { id: 'seedreamGenerate', label: 'Generate' },
      { id: 'seedreamEdit', label: 'Seedream 5 Pro' },
      { id: 'outfitSwapSeedream', label: 'Outfit Swap' },
      // "Photo Match SD" — SD for Seedream. Two tabs called Photo Match, one Seedream and one
      // Gemini, cost real time twice on 2026-08-13: a bug report and a fix landed on different
      // pages. The name says which is which (owner).
      { id: 'photoMatchSeedream', label: 'Photo Match SD' },
      { id: 'sceneRecreateSeedream', label: 'Scene Recreate' },
      { id: 'poseRemixSeedream', label: 'Pose Remix' },
    ],
  },
  {
    engine: 'seedream',
    label: 'Video',
    items: [
      { id: 'seedanceVideo', label: 'Seedance Video' },
      { id: 'seedanceOmni', label: 'Seedance Omni' },
      { id: 'videoLibrary', label: 'Video Library' },
    ],
  },
  {
    label: 'Media Grab',
    items: [
      // Pinterest belongs here, not under Seedream: this section is where source material is
      // FETCHED from, and generating with it is a separate step further down (owner, 2026-08-10).
      { id: 'pinterestFeed', label: 'Pinterest' },
      { id: 'instagramFrames', label: 'Frame Grabber' },
      { id: 'frameLibrary', label: 'Frame Library' },
      { id: 'instagramReel', label: 'Instagram' },
    ],
  },
  {
    label: 'Content',
    items: [
      { id: 'pasteInbox', label: 'Paste Inbox' },
      { id: 'imageEditor', label: 'Image Editor' },
      { id: 'videoEditor', label: 'Video Editor' },
    ],
  },
  {
    engine: 'gemini',
    label: 'Gemini',
    items: [
      { id: 'photoMatch', label: 'Photo Match (old · Gemini)' },
      { id: 'outfitSwap', label: 'Outfit Swap' },
      { id: 'scene', label: 'Scene Recreate' },
      { id: 'postClone', label: 'Post Clone' },
      { id: 'carousel', label: 'Carousel' },
      { id: 'poseFix', label: 'Pose Remix' },
      { id: 'nanoBypass', label: 'Nano Bypass' },
      { id: 'video', label: 'Video' },
      { id: 'videoGallery', label: 'Video Gallery' },
      { id: 'characters', label: 'Characters' },
    ],
  },
  {
    // UNGATED since 2026-08-09. This was tagged engine:'gemini' back when Gemini was a sidebar
    // you could switch to. Gemini is gone, so leaving the tag would have made API Keys — the only
    // place the WaveSpeed key is entered — unreachable from every workspace. A section holding the
    // credentials for the engine you are using must never be behind that engine's own toggle.
    label: 'Account',
    items: [
      { id: 'keys', label: 'API Keys' },
      { id: 'settings', label: 'Settings' },
      { id: 'logs', label: 'App Logs' },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);

const APP_VERSION = '8.1.3';

const FEED_HIDDEN_PAGES = new Set([
  // Pinterest generates nothing -- it fetches source material and hands it on. A feed of unrelated
  // results beside a search grid is noise, and it costs the grid a third of the window
  // (owner, 2026-08-10).
  'pinterestFeed',
  // Photo Match grew the same inline results column Eddy has — tick, send to Library or Base
  // Library. Showing the shared feed too would put every result on screen twice, and the feed was
  // occupying the space the results column needs (owner, 2026-08-13).
  'photoMatchSeedream',
  // Eddy Generate grew its own inline results area (select tiles, shared instruction,
  // Regenerate, Generate video). Showing the shared feed too put every result on screen twice.
  // Both ids route to EddyGeneratePage, so both must be listed or the panel returns via /eddy.
  'eddyGenerate',
  'eddyMaxNano',
  'eddyMaxOutfit',
  'eddy',
  'eddyLibrary',
  'eddyOutfit',
  'eddyPose',
  'eddyEnvironment',
  'eddyMaxNano',
  'eddyMaxOutfit',
  'eddyBase',
  'eddyBaseLibrary',
  'videoLibrary',
  'eddyCharacter',
  'library',
  'videoGallery',
  'imageEditor',
  'videoEditor',
  'characters',
  'keys',
  'billing',
  'referral',
  'settings',
  'logs',
  'instagramFrames',
  'frameLibrary',
  // Same reason as eddyGenerate/eddy above: this page grows its own inline shot-review grid
  // (Task 5+), so the shared Generation Feed would just duplicate it in a second column.
  'instagramReel',
]);

// Pages where controls panel is narrow and feed takes the rest of the space
const FEED_DOMINANT_PAGES = new Set([
  'generate', 'nsfwGenerate', 'batch', 'video', 'seedanceVideo', 'seedanceOmni', 'auto',
  'scene', 'postClone', 'carousel', 'photoMatch', 'poseFix', 'nanoBypass', 'outfitSwap',
]);

// Pages that lay out their OWN scroll regions and must not sit inside <main>'s single scroller.
//
// WHY: Eddy Generate is a two-column workspace — setup form left, results right — and the whole
// point is that you can watch results land while the form is still on screen. A page that scrolls
// as one document cannot do that: scrolling to the results scrolls the form away. So <main> stops
// scrolling for these pages and hands its exact height down, and the page puts `overflow-y-auto`
// on each column instead. Only pages that actually build their own scrollers belong here; anything
// else listed would simply have its overflow clipped.
const SELF_SCROLL_PAGES = new Set([
  // Both ids route to EddyGeneratePage — same reason both are in FEED_HIDDEN_PAGES.
  'eddyGenerate',
  'eddy',
  // Photo Match now uses Eddy's two-column shell: setup left, results right, each scrolling on its
  // own. Without this the page scrolls as one document and watching a match land scrolls the form
  // away — which is the whole reason Eddy stopped doing that.
  'photoMatchSeedream',
  // Mirrors EddyGeneratePage's two-column shell (fixed left setup column, flex-1 right results
  // column, both independently scrollable) — same layout, same need for a bounded height.
  'instagramReel',
  // The video editor lays out its own header / tools+preview+adjust / timeline and needs a bounded
  // height to hang them from — same reason as Eddy.
  'videoEditor',
]);

const NAV_COLLAPSED_KEY = 'kyros_nav_collapsed';

function readNavCollapsed() {
  try { return window.localStorage.getItem(NAV_COLLAPSED_KEY) === '1'; } catch { return false; }
}

function SidebarHeader({ collapsed, onToggle }) {
  // Collapsed, the logo IS the expand control — at 72px there is no room for a separate
  // button, and a floating one would have to position against the fixed <aside>.
  return (
    <header className={`h-20 flex items-center border-b border-white/[0.05] shrink-0 ${collapsed ? 'justify-center px-2' : 'gap-3 px-5'}`}>
      <button
        type="button"
        onClick={collapsed ? onToggle : undefined}
        title={collapsed ? 'Expand sidebar' : undefined}
        aria-label={collapsed ? 'Expand sidebar' : undefined}
        className={`w-9 h-9 rounded-xl flex items-center justify-center font-extrabold text-white text-base shrink-0 ${collapsed ? 'cursor-pointer' : 'cursor-default'}`}
        style={{ background: 'linear-gradient(135deg,#d946a8,#ec4899)', boxShadow: '0 0 20px 0 rgba(217,70,168,0.55)' }}
      >
        K
      </button>
      {!collapsed && (
        <>
          <div className="leading-tight min-w-0">
            <div className="font-bold text-white text-[0.9375rem] tracking-tight">Kyros Studio</div>
            <div className="text-[0.6875rem] text-zinc-500">AI Content Suite</div>
          </div>
          <span className="inline-flex items-center rounded-full border border-white/[0.07] bg-white/[0.03] px-1.5 py-px text-[0.5625rem] text-zinc-600 font-mono ml-auto shrink-0">
            v{APP_VERSION}
          </span>
          <button
            type="button"
            onClick={onToggle}
            title="Collapse sidebar to icons"
            aria-label="Collapse sidebar to icons"
            className="hidden lg:flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.03] text-zinc-500 transition-colors hover:text-zinc-200 cursor-pointer"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        </>
      )}
    </header>
  );
}

const PAGE_DESCRIPTIONS = {
  generate: 'Create a single image with full control',
  nsfwGenerate: 'WaveSpeed Turbo LoRA — uncensored image generation',
  batch: 'Generate multiple images in parallel',
  video: 'Generate videos from images using AI',
  seedanceVideo: 'Muapi Seedance 2 Omni — show it photos of your model and it builds a fresh video of her (reference, not a first frame)',
  seedanceOmni: 'Reference a real video and recreate its motion with your model — plus reusable trained characters',
  seedreamEdit: "Muapi Seedream 5.0 Pro Edit — ByteDance's flagship image editor, up to 10 reference images",
  seedreamGenerate: "Pick your character, type a prompt — Seedream 5.0 Pro generates a new photo of her.",
  outfitSwapSeedream: 'Put the outfit from image 2 onto the person in image 1 — via Seedream 5.0 Pro (no Gemini)',
  photoMatchSeedream: 'Photo Match SD — paste any photo and rebuild it with your character, on Seedream 5.0 Pro or Nano Banana 2',
  pinterestFeed: 'Search Pinterest, tick the shots you want, send them straight into Photo Match',
  sceneRecreateSeedream: 'Put your character in a scene and remix it — new background, outfit, lighting — via Seedream 5.0 Pro',
  poseRemixSeedream: 'Repose your character into any pose — sexy, flirty, sexual, or read from a reference — via Seedream 5.0 Pro',
  eddyGenerate: 'Your character, in any outfit and pose',
  eddy: 'Your character, in any outfit and pose',
  eddyLibrary: 'All your Eddy images',
  eddyOutfit: 'Outfits, organised in folders',
  eddyPose: 'Your saved pose prompts',
  eddyMaxNano: 'Her, in every pose you pick — Nano Banana 2 at 2K, no outfit swap',
  eddyMaxOutfit: 'Pick a Library folder, pick outfits — Seedream 5.0 Pro swaps the clothes and keeps everything else',
  eddyBase: 'Make a new base photo of a saved character, from her own references',
  eddyBaseLibrary: 'Your generated base photos, filed by character',
  eddyCharacter: 'Characters from a base image — no prompt needed',
  auto: 'AI-planned multi-day content schedules',
  carousel: 'Generate slide variations from a source image',
  scene: 'Upload a scene and recreate it with your character',
  postClone: 'Clone Instagram posts with your character',
  instagramFrames: 'Grab frames from any public Instagram Reel or TikTok Video — send to Photo Match or Scene Recreate',
  instagramReel: 'Recreate a reel with your model',
  frameLibrary: 'Manage your downloaded Instagram/TikTok frames and reference images',
  styleLibrary: 'Manage reusable style building blocks',
  promptBuilder: 'Visual prompt composition with Nano-Banana formula',
  loraDataset: 'Build captioned LoRA training datasets from characters',
  profileAnalyzer: 'Extract style patterns from Instagram profiles',
  storyteller: 'Generate captions and hashtags for images',
  library: 'Browse and manage all generated images and videos',
  pasteInbox: 'Save pasted images for quick reuse in Photo Match or Scene Recreate',
  imageEditor: 'Crop, adjust and touch up any image in your gallery',
  videoEditor: 'Trim, add stickers and text, and adjust any video from your gallery',
  videoGallery: 'Browse and manage all generated videos',
  characters: 'Manage character identities and references',
  keys: 'Configure API keys and connections',
  billing: 'View your plan and upgrade your subscription',
  referral: 'Earn 20% recurring commission for every creator you refer',
  logs: 'View recent app logs and copy them for support',
  settings: 'Change password, manage your account',
  photoMatch: 'Paste any photo — match background & pose with your character',
  poseFix: 'Re-pose any photo into a flattering Instagram pose — keeps the character, outfit & location',
  nanoBypass: 'Multi-image AI editing — combine, transform, reimagine with Gemini 3',
  outfitSwap: 'Swap outfits between photos — take clothing from one image and apply to another',
  admin: 'Run the SaaS, inspect users, and review audit activity',
};

function PageFallback() {
  return (
    <div className="flex items-center justify-center py-24">
      <Spinner size={32} />
    </div>
  );
}

const PAGES = {
  generate: GeneratePage,
  nsfwGenerate: NsfwGeneratePage,
  batch: BatchPage,
  carousel: CarouselPage,
  scene: SceneRecreatePage,
  postClone: PostClonePage,
  instagramFrames: InstagramFramesPage,
  instagramReel: InstagramReelPage,
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
  seedanceVideo: SeedanceVideoPage,
  seedanceOmni: SeedanceOmniPage,
  seedreamEdit: SeedreamEditPage,
  seedreamGenerate: SeedreamGeneratePage,
  outfitSwapSeedream: OutfitSwapSeedreamPage,
  photoMatchSeedream: PhotoMatchSeedreamPage,
  pinterestFeed: PinterestFeedPage,
  sceneRecreateSeedream: SceneRecreateSeedreamPage,
  poseRemixSeedream: PoseRemixSeedreamPage,
  eddyGenerate: EddyGeneratePage,
  eddy: EddyGeneratePage,
  eddyLibrary: EddyLibraryPage,
  eddyOutfit: EddyOutfitPage,
  eddyPose: EddyPosePage,
  eddyEnvironment: EddyEnvironmentPage,
  eddyMaxNano: EddyMaxNanoPage,
  eddyMaxOutfit: EddyMaxOutfitPage,
  eddyBase: EddyBasePage,
  eddyBaseLibrary: EddyBaseLibraryPage,
  videoLibrary: VideoLibraryPage,
  eddyCharacter: EddyCharacterPage,
  auto: AutoGeneratorPage,
  imageEditor: ImageEditorPage,
  videoEditor: VideoEditorPage,
  characters: CharactersPage,
  keys: ApiKeysPage,
  billing: BillingPage,
  referral: ReferralPage,
  logs: LogsPage,
  photoMatch: PhotoMatchPage,
  poseFix: PoseFixPage,
  nanoBypass: NanoBypassPage,
  outfitSwap: OutfitSwapPage,
  admin: AdminPage,
  settings: SettingsPage,
};

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
        {sublabel && <span className="text-[0.625rem] font-mono text-emerald-200/45 hidden sm:block">{sublabel}</span>}
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

// Photo Match, Outfit Swap, Scene Recreate and Pose Remix exist twice — once per engine — so
// the sidebar showed two of each with no way to tell them apart. Only one engine's tools are
// listed at a time; the other set stays reachable by URL.
const ENGINE_KEY = 'kyros.engine';
// Text size is a preference, not something to guess at. Everything is sized in rem, so one
// root value scales the whole interface.
const UI_SCALE_KEY = 'kyros.uiScale';
const UI_SCALE_MIN = 16;
// Raised from 26: the old ceiling was not big enough on a large monitor — everything is sized in
// rem off this, so it is the single control that grows the whole interface.
const UI_SCALE_MAX = 36;

/**
 * The browser-style workspace tabs across the very top of the app.
 *
 * Deliberately looks like browser tabs (rounded top corners, the active one joined to the frame
 * below it) so it reads as "which workspace am I in", not as another nav row inside the app. The
 * active tab's dot uses `bg-rose-500`, which is itself re-themed per workspace — so the tab strip
 * shows each workspace in its OWN colour.
 */
function WorkspaceTabs({ current, onSelect }) {
  return (
    <div className="relative z-10 flex shrink-0 items-end gap-1.5 px-3 lg:px-4">
      {WORKSPACES.map((w) => {
        const active = w.id === current;
        return (
          <button
            key={w.id}
            type="button"
            onClick={() => onSelect(w.id)}
            aria-current={active ? 'true' : undefined}
            title={active ? `${w.label} — current workspace` : `Switch to ${w.label}`}
            className={cn(
              // Sized like a real browser tab: tall, wide, generous type, joined to the frame below.
              'group relative flex min-w-[190px] items-center gap-3 overflow-hidden rounded-t-2xl border border-b-0 px-6 py-3.5 text-base font-bold tracking-wide transition cursor-pointer',
              // High contrast between states: the selected tab is a LIT panel (pale surface, pure
              // white text, its own colour along the top edge); the others are pressed-down and
              // dimmed. The two used to differ only by a few percent of black, which is not enough
              // to tell at a glance which workspace you are in.
              active
                ? 'border-white/25 bg-[#2a2440] text-white shadow-[0_-6px_22px_-6px_rgba(0,0,0,0.85)]'
                : 'border-transparent bg-black/60 text-zinc-500 hover:bg-black/45 hover:text-zinc-200',
            )}
          >
            {/* The active tab wears its workspace's colour as a thick top edge — tells you which tab
                AND whose it is in one glance, without relying on the small dot alone. */}
            {active && (
              <span className="pointer-events-none absolute inset-x-0 top-0 h-1" style={{ backgroundColor: w.swatch }} />
            )}
            <span
              className="h-3 w-3 shrink-0 rounded-full transition"
              style={{ backgroundColor: w.swatch, opacity: active ? 1 : 0.35 }}
            />
            {w.label}
            {/* Fills the 1px seam between the active tab and the frame, so the tab reads as joined
                to the page below it the way a browser tab does. */}
            {active && <span className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-[#2a2440]" />}
          </button>
        );
      })}
    </div>
  );
}

function MainApp({ onLogout, currentUser }) {
  const { activeKey, setActiveKey, vertexActive, setVertexActive, integrationRefreshToken, page, navigateTo } = useApp();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Which workspace tab is active. Initialised from the same store main.jsx already applied before
  // first paint, so state and the DOM attribute never disagree on load.
  const [workspace, setWorkspaceState] = useState(getWorkspace);
  const changeWorkspace = useCallback((id) => setWorkspaceState(persistWorkspace(id)), []);
  // Collapse is desktop-only: on mobile the sidebar is already a drawer.
  const [navCollapsed, setNavCollapsed] = useState(readNavCollapsed);
  const toggleNavCollapsed = useCallback(() => {
    setNavCollapsed((cur) => {
      const next = !cur;
      try { window.localStorage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  }, []);
  const [apifyConnected, setApifyConnected] = useState(false);
  const isFeedDominant = FEED_DOMINANT_PAGES.has(page);
  const showGenerationFeed = !FEED_HIDDEN_PAGES.has(page);
  const isSelfScroll = SELF_SCROLL_PAGES.has(page);

  useEffect(() => {
    if (page === 'admin' && !currentUser?.isAdmin) {
      navigateTo('eddy');
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

  const [engine, setEngine] = useState(() => {
    try { return localStorage.getItem(ENGINE_KEY) || 'seedream'; } catch { return 'seedream'; }
  });
  // Engines this workspace offers (Eddy = Seedream only). The engine is remembered globally, so a
  // value the current workspace does not offer has to be corrected — otherwise switching to Eddy
  // while on Gemini filters every section out and the sidebar looks broken with no way back.
  const allowedEngines = workspaceEngines(workspace);
  useEffect(() => {
    if (!allowedEngines.includes(engine)) setEngine(allowedEngines[0]);
  }, [allowedEngines, engine]);
  const [uiScale, setUiScale] = useState(() => {
    const saved = Number(localStorage.getItem(UI_SCALE_KEY));
    return Number.isFinite(saved) && saved >= UI_SCALE_MIN && saved <= UI_SCALE_MAX ? saved : 20;
  });
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', `${uiScale}px`);
    try { localStorage.setItem(UI_SCALE_KEY, String(uiScale)); } catch { /* private mode */ }
  }, [uiScale]);
  useEffect(() => {
    try { localStorage.setItem(ENGINE_KEY, engine); } catch { /* private mode — the default is fine */ }
  }, [engine]);

  const PageComponent = PAGES[page] || GeneratePage;
  const visibleSections = NAV_SECTIONS.map((section) => ({ ...section }))
    // A section tagged with an engine only shows when that engine is picked. Untagged
    // sections — Eddy, Media Grab, Content, Account — always show.
    .filter((section) => !section.engine || section.engine === engine)
    .filter((section) => section.items.length > 0);
  const visibleNavItems = visibleSections.flatMap((section) => section.items);
  const allNavItems = [...visibleNavItems, { id: 'admin', label: 'Admin' }, { id: 'logs', label: 'App Logs' }];
  const currentNav = allNavItems.find((n) => n.id === page);

  return (
    <TooltipPrimitive.Provider delayDuration={200}>
    {/* flex-col (was flex-row): the workspace tab strip is a row ABOVE the application frame, the
        way browser tabs sit above the page. The frame keeps flex-1 so it still fills the rest. */}
    <div className="relative flex flex-col h-screen overflow-hidden bg-[#0c0a12] text-white p-3 lg:p-4">
      {/* Deep — procedural smoke, tinted per workspace (see .smoke-deep in index.css) */}
      <div className="pointer-events-none absolute inset-0 smoke-deep" />

      <WorkspaceTabs current={workspace} onSelect={changeWorkspace} />

      {/* Inner Application frame container (Helios floating dashboard shell).
          Translucent on purpose: an opaque fill here covers the backdrop completely. The glass
          is kept NEUTRAL — tinting it pink over pink light reads as mud, not depth. */}
      <div className="relative flex flex-1 overflow-hidden rounded-[24px] border border-white/[0.08] bg-[#12111a]/35 backdrop-blur-2xl shadow-2xl w-full">
        
        {sidebarOpen && (
          <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden" onClick={() => setSidebarOpen(false)} />
        )}

        {/* ── Sidebar ── */}
        <aside className={`fixed inset-y-0 left-0 z-40 flex w-[360px] flex-col border-r border-white/[0.05] bg-[#1e1a2c]/70 backdrop-blur-2xl transition-[transform,width] duration-250 lg:static lg:translate-x-0 ${navCollapsed ? 'lg:w-[92px]' : 'lg:w-[360px]'} ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <SidebarHeader collapsed={navCollapsed} onToggle={toggleNavCollapsed} />
          <nav className="flex-1 overflow-y-auto px-3 py-2 scrollbar-none">
            {/* Which engine's tools are listed. Seedream by default; Gemini keeps its own
                versions of Photo Match, Outfit Swap, Scene Recreate and Pose Remix. */}
            {/* Hidden entirely when the workspace offers only one engine — a switcher with a single
                option is just noise. */}
            {!navCollapsed && allowedEngines.length > 1 && (
              <div className="mb-2 flex gap-1 rounded-xl border border-white/[0.06] bg-black/20 p-1">
                {[['seedream', 'Seedream'], ['gemini', 'Gemini']].filter(([id]) => allowedEngines.includes(id)).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setEngine(id)}
                    className={`flex-1 rounded-lg py-3 text-base font-semibold transition cursor-pointer ${
                      engine === id
                        ? 'bg-rose-500/20 text-rose-100 ring-1 ring-rose-500/40'
                        : 'text-zinc-300 hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {!navCollapsed && (
              <div className="mb-2 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-black/20 px-2.5 py-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">Text</span>
                <button
                  onClick={() => setUiScale((v) => Math.max(UI_SCALE_MIN, v - 1))}
                  disabled={uiScale <= UI_SCALE_MIN}
                  className="h-6 w-6 rounded-md bg-white/[0.06] text-sm font-bold text-white transition hover:bg-white/[0.12] disabled:opacity-30 cursor-pointer"
                >−</button>
                <span className="min-w-[2.5rem] text-center text-xs font-semibold text-white">{uiScale}px</span>
                <button
                  onClick={() => setUiScale((v) => Math.min(UI_SCALE_MAX, v + 1))}
                  disabled={uiScale >= UI_SCALE_MAX}
                  className="h-6 w-6 rounded-md bg-white/[0.06] text-sm font-bold text-white transition hover:bg-white/[0.12] disabled:opacity-30 cursor-pointer"
                >+</button>
              </div>
            )}
            {visibleSections.map((section, sIdx) => (
              // data-nav-group is the hook a workspace CSS file uses to hide a whole section from
              // its OWN tab (e.g. eddy.css hides the Gemini group). Slugged from the label so it is
              // stable and readable: "Seedream · Seedance" -> "seedream-seedance".
              <div
                key={section.label}
                data-nav-group={section.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}
                className={`mb-0.5 ${sIdx > 0 ? 'pt-1' : ''}`}
              >
                <div className={`flex items-center gap-2 py-1 ${navCollapsed ? 'px-2' : 'px-3'}`}>
                  {!navCollapsed && <span className="text-sm font-black text-white/90 uppercase tracking-[0.16em] whitespace-nowrap">{section.label}</span>}
                  <div className="flex-1 h-px bg-white/[0.045]" />
                </div>
                <div className="space-y-1">
                  {section.items.map((item) => {
                    const IconComponent = NAV_ICONS[item.id];
                    const isActive = page === item.id;
                    return (
                      <button key={item.id} onClick={() => { navigateTo(item.id); setSidebarOpen(false); }}
                        title={navCollapsed ? item.label : undefined}
                        aria-label={navCollapsed ? item.label : undefined}
                        className={`relative flex w-full items-center rounded-full py-2.5 text-lg font-semibold transition-all duration-200 cursor-pointer group ${navCollapsed ? 'justify-center px-0' : 'gap-3.5 px-4'} ${
                          isActive
                            ? 'bg-[linear-gradient(135deg,rgba(217,70,168,0.18),rgba(236,72,153,0.06))] text-white shadow-[0_0_24px_-6px_rgba(217,70,168,0.35),inset_0_0_0_1px_rgba(255,255,255,0.07)]'
                            : 'text-white hover:bg-white/[0.06] hover:text-white'
                        }`}>
                        {IconComponent ? (
                          <span
                            className={`flex h-10 w-10 items-center justify-center rounded-full transition-all duration-150 ${isActive ? 'bg-rose-400/10 opacity-100' : 'bg-white/[0.05] opacity-80 group-hover:opacity-100'}`}
                            style={{
                              '--nc-gradient-1-color-1': (NAV_COLORS[item.id] || ['#f9a8d4', '#d946a8'])[0],
                              '--nc-gradient-1-color-2': (NAV_COLORS[item.id] || ['#f9a8d4', '#d946a8'])[1],
                            }}
                          >
                            <IconComponent uniqueId={`nav-${item.id}`} size={18} aria-hidden />
                          </span>
                        ) : null}
                        {!navCollapsed && <span className="truncate text-lg">{item.label}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

        {currentUser?.isAdmin && (
          <div className={`pb-1 border-t border-white/[0.04] pt-2 ${navCollapsed ? 'px-2' : 'px-3'}`}>
            <button
              onClick={() => { navigateTo('admin'); setSidebarOpen(false); }}
              title={navCollapsed ? 'Admin' : undefined}
              className={`flex w-full items-center rounded-lg py-1.5 text-xs font-medium transition-all duration-150 cursor-pointer group ${navCollapsed ? 'justify-center px-0' : 'gap-3 px-3'} ${
                page === 'admin'
                  ? 'bg-amber-600/10 text-amber-400 shadow-[inset_2px_0_0_0_#d97706]'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06]'
              }`}
            >
              {NAV_ICONS.admin && (
                <span className="flex items-center justify-center w-4 opacity-50 group-hover:opacity-70" style={{ '--nc-gradient-1-color-1': NAV_COLORS.admin[0], '--nc-gradient-1-color-2': NAV_COLORS.admin[1] }}>
                  <NAV_ICONS.admin uniqueId="nav-admin-bottom" size={16} aria-hidden />
                </span>
              )}
              {!navCollapsed && 'Admin'}
            </button>
          </div>
        )}

        {!navCollapsed && currentUser?.usageInfo?.plan === 'free' && currentUser.usageInfo.limit != null && (() => {
          const used = Math.max(0, Number(currentUser.usageInfo.used) || 0);
          const limit = Math.max(1, Number(currentUser.usageInfo.limit) || 10);
          const displayUsed = Math.min(used, limit);
          const remaining = Math.max(0, limit - used);
          const isFinished = used >= limit;
          return (
          <div className="px-4 py-3 border-t border-white/[0.05]">
            {isFinished ? (
              <div className="rounded-xl bg-red-950/40 border border-red-800/25 p-3 text-center">
                <p className="text-[0.6875rem] font-semibold text-red-400 mb-1">Free limit reached</p>
                <p className="text-[0.625rem] text-zinc-500 mb-2">You used {displayUsed}/{limit} generations</p>
                <button onClick={() => navigateTo('billing')}
                  className="w-full rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[0.6875rem] font-semibold py-1.5 transition cursor-pointer shadow-[0_0_16px_rgba(217,70,168,0.3)]">
                  Upgrade to Pro
                </button>
              </div>
            ) : (
              <div>
                <div className="flex justify-between mb-1.5">
                  <span className="text-[0.625rem] text-zinc-500">Free trial</span>
                  <span className="text-[0.625rem] text-zinc-500 font-mono">{displayUsed}/{limit}</span>
                </div>
                <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-rose-600 to-pink-500 transition-all shadow-[0_0_8px_rgba(217,70,168,0.4)]"
                    style={{ width: `${Math.min(100, (displayUsed / limit) * 100)}%` }} />
                </div>
                <p className="text-[0.5625rem] text-zinc-600 mt-1">{remaining} generations left</p>
              </div>
            )}
          </div>
          );
        })()}

        {/* User footer (Helios card-styled profile badge) */}
        <div className={`border-t border-white/[0.05] ${navCollapsed ? 'p-2' : 'p-4'}`}>
          <div className={`flex items-center rounded-[16px] bg-white/[0.02] border border-white/[0.04] shadow-sm ${navCollapsed ? 'justify-center p-1.5' : 'gap-3 p-2.5'}`}>
            <img src="https://i.pravatar.cc/64?img=13" className="w-8 h-8 rounded-full object-cover ring-2 ring-rose-500/20" alt="avatar" title={navCollapsed ? currentUser?.email : undefined} />
            {!navCollapsed && (
              <>
                <div className="min-w-0 flex-1">
                  <p className="text-[0.75rem] font-bold text-white truncate">{currentUser?.email?.split('@')[0] || 'Mira Okafor'}</p>
                  <p className="text-[0.625rem] text-zinc-500 truncate">{currentUser?.plan === 'pro' ? 'Pro Studio Plan' : 'Free Trial'}</p>
                </div>
                <button onClick={handleLogout} className="text-[0.625rem] text-zinc-600 hover:text-rose-400 transition cursor-pointer" title="Sign out">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
                </button>
              </>
            )}
          </div>
        </div>
      </aside>

      {/* ── Main area (Helios dark investment dashboard style) ── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-20 items-center justify-between border-b border-white/[0.05] bg-[#1e1a2c]/60 backdrop-blur-xl px-5 lg:px-8 shrink-0">
          <div className="flex items-center gap-3">
            <button className="lg:hidden text-zinc-400 hover:text-zinc-200 p-1 cursor-pointer" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 5h14M3 10h14M3 15h14" /></svg>
            </button>
            {/* The greeting belongs on the landing page only. Everywhere else this space
                does the job that actually changes: telling you which tool you're in.
                ~35 of 45 pages render no title of their own, so without this they were
                anonymous. PAGE_DESCRIPTIONS already carries good copy for each one. */}
            <div className="min-w-0">
              {page === 'generate' ? (
                <>
                  <h2 className="text-xl font-bold tracking-tight text-white leading-tight">
                    Welcome, <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#d946a8] to-[#ec4899]">{currentUser?.email?.split('@')[0] || 'Creator'}</span>
                  </h2>
                  <p className="text-[0.6875rem] text-zinc-500 hidden sm:block mt-0.5">Here's your content creation dashboard overview</p>
                </>
              ) : (
                <>
                  <h2 className="text-xl font-bold tracking-tight text-white leading-tight truncate">
                    {currentNav?.label || 'Kyros Studio'}
                  </h2>
                  {PAGE_DESCRIPTIONS[page] && (
                    <p className="text-[0.6875rem] text-zinc-500 hidden sm:block mt-0.5 truncate max-w-[52ch]">
                      {PAGE_DESCRIPTIONS[page]}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Circular buttons for settings and notifications */}
            <div className="flex items-center gap-2">
              <button className="w-9 h-9 rounded-full flex items-center justify-center border border-white/[0.06] hover:bg-white/[0.04] text-zinc-300 transition" title="Notifications">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/></svg>
              </button>
              <button onClick={() => navigateTo('settings')} className="w-9 h-9 rounded-full flex items-center justify-center border border-white/[0.06] hover:bg-white/[0.04] text-zinc-300 transition" title="Settings">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </button>
            </div>

            {/* Profile badge */}
            <div className="flex items-center gap-2 border-l border-white/[0.06] pl-4">
              <img src="https://i.pravatar.cc/64?img=13" className="w-8 h-8 rounded-full ring-2 ring-white/10" alt="avatar" />
              <div className="hidden lg:block text-left leading-none">
                <p className="text-xs font-bold text-white">{currentUser?.email?.split('@')[0] || 'Creator'}</p>
                <p className="text-[0.5625rem] text-zinc-500 mt-0.5">{currentUser?.email || ''}</p>
              </div>
            </div>
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {/* Three shapes, one element. isSelfScroll comes FIRST because it is the only one that
              turns <main>'s own scroller off — a self-scrolling page has to receive a fixed height
              to hang its columns' `overflow-y-auto` from, and `overflow-y-auto` here would give it
              an unbounded one instead. flex-col + a min-h-0 child is what passes that height down
              without the classic flexbox overflow blowout. */}
          <main className={`${isSelfScroll ? 'flex flex-1 flex-col overflow-hidden safe-bottom ambient-glow p-3 sm:p-4 lg:p-6' : isFeedDominant ? 'w-[430px] xl:w-[460px] 2xl:w-[500px] shrink-0 overflow-y-auto overflow-x-hidden safe-bottom ambient-glow border-r border-white/[0.05] bg-white/[0.012] p-3 lg:p-5' : `flex-1 overflow-y-auto overflow-x-hidden safe-bottom ambient-glow ${showGenerationFeed ? 'border-r border-white/[0.05]' : ''} p-3 sm:p-4 lg:p-6`}`}>
            {/* A page with no generation feed owns the whole area — the collection tabs manage
                their own columns, so a 1152px cap there just wastes a wide monitor. Pages that
                DO show the feed keep the cap: prose and forms are unreadable at full width. */}
            <div className={`relative ${isSelfScroll ? 'flex min-h-0 flex-1 flex-col max-w-none' : isFeedDominant || !showGenerationFeed ? 'max-w-none' : 'mx-auto max-w-6xl'}`}>
              <PageErrorBoundary pageKey={page}>
                <Suspense fallback={<PageFallback />}>
                  <PageComponent key={page} />
                </Suspense>
              </PageErrorBoundary>
            </div>
          </main>
          {showGenerationFeed && <GenerationFeedPanel mode={isFeedDominant ? 'workspace' : 'rail'} />}
          {/* Outside the showGenerationFeed gate on purpose: pages that hide the panel still
              submit video jobs, and this watch is the only thing that resolves them. */}
          <GenerationFeedVideoWatcher />
        </div>
      </div>

      {/* End Inner Frame Container */}
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
          <div className="mb-2 text-[0.625rem] font-black uppercase tracking-[0.24em] text-cyan-300">Kyros Studio Access</div>
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
        <p className="mt-4 text-center text-[0.6875rem] text-zinc-600">Tokens are signed, expire automatically, and lock to this machine after activation.</p>
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
