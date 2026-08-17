import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../context/AppContext';
import { stashSourceHandoff, handoffDestination } from '../lib/sourceHandoff';
import { saveIgFramesState, loadIgFramesState, clearIgFramesState } from '../lib/igFramesStateStore';
import { appendFrames } from '../lib/frameLibraryStore';
import { downloadBlob } from '../lib/stripMetadata';

const API = '/api/instagram-frames';

// A map, not a ternary. sendTo() used to pick the event with
// `page === 'photoMatch' ? photoMatchEvent : sceneEvent`, so every destination that wasn't
// Photo Match silently fired the Scene Recreate event and toasted "sent to Scene Recreate".
// Adding a third target to that shape would misfire.
const SEND_TARGETS = {
  photoMatch: { event: 'kyros:use-as-photo-match-source', label: 'Photo Match' },
  photoMatchSeedream: { event: 'kyros:use-as-photo-match-seedream-source', label: 'Photo Match · Seedream' },
  scene: { event: 'kyros:use-as-scene-source', label: 'Scene Recreate' },
  sceneRecreateSeedream: { event: 'kyros:use-as-scene-recreate-seedream-source', label: 'Scene Recreate · Seedream' },
};
const PHOTO_MATCH_SOURCE_KEY = 'kyros.photoMatch.sources';
const SCENE_SOURCE_KEY = 'kyros.sceneRecreate.sources';
const PROFILE_URL_KEY = 'kyros.igFrames.profileUrl';
const GRAB_HISTORY_KEY = 'kyros.igFrames.grabbedHistory';
const IG_PROFILE_RE = /https?:\/\/(www\.)?instagram\.com\/([A-Za-z0-9_.]+)(\/reels|\/videos|\/posts)?\/?/i;

// ── Helpers ────────────────────────────────────────────────────────────────
function base64ToDataUrl(base64, mimeType) {
  return `data:${mimeType};base64,${base64}`;
}

// Which reel shortcodes has this profile already been grabbed for before? Persisted so a
// repeat "Grab Reels" click surfaces genuinely new reels instead of reshuffling the same small
// pool the server (Apify especially) can find for that account.
function extractIgUsername(profileUrl) {
  return profileUrl.match(IG_PROFILE_RE)?.[2] || '';
}
function loadGrabHistory() {
  try { const raw = localStorage.getItem(GRAB_HISTORY_KEY); const obj = raw ? JSON.parse(raw) : {}; return (obj && typeof obj === 'object') ? obj : {}; } catch { return {}; }
}
function saveGrabHistory(history) {
  try { localStorage.setItem(GRAB_HISTORY_KEY, JSON.stringify(history)); } catch { /* ignore */ }
}

// ── Icons ──────────────────────────────────────────────────────────────────
function IconInstagram({ size = 18, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.5" fill="currentColor" />
    </svg>
  );
}

function IconCheck({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconClose({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconPlus({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconTrash({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
    </svg>
  );
}

function IconCopy({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
    </svg>
  );
}

function IconArrowLeft({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  );
}

function IconArrowRight({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  );
}

function IconKey({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/>
    </svg>
  );
}

// ── Slider ─────────────────────────────────────────────────────────────────
function Slider({ label, value, min, max, step = 1, onChange, format }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-zinc-400 font-medium">{label}</span>
        <span className="text-xs font-mono text-zinc-300 bg-zinc-800/80 px-2 py-0.5 rounded-md">
          {format ? format(value) : value}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full accent-pink-500 bg-zinc-700 cursor-pointer"
      />
      <div className="flex justify-between text-[0.625rem] text-zinc-600 mt-1">
        <span>{format ? format(min) : min}</span>
        <span>{format ? format(max) : max}</span>
      </div>
    </div>
  );
}

// ── Cookies Setup Panel ────────────────────────────────────────────────────
function CookiesSetupPanel({ onSaved }) {
  const { notify } = useApp();
  const [cookiesText, setCookiesText] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!cookiesText.trim()) { notify('Paste your cookies.txt content first', 'error'); return; }
    setSaving(true);
    try {
      const res = await fetch(`${API}/save-cookies`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ cookies: cookiesText }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        const errorMsg = (typeof json.error === 'object' ? json.error?.message : json.error) || json.message || 'Failed to save';
        throw new Error(errorMsg);
      }
      const platform = json.data?.platform === 'tiktok' ? 'TikTok' : json.data?.platform === 'x' ? 'X (Twitter)' : 'Instagram';
      notify(`${platform} cookies saved! ✓`, 'success');
      setCookiesText('');
      onSaved();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-amber-800/40 bg-amber-950/20 p-4 space-y-4">
      <div className="flex items-center gap-2">
        <IconKey size={14} className="text-amber-400 shrink-0" />
        <span className="text-xs font-semibold text-amber-300 uppercase tracking-wider">Cookies Setup</span>
      </div>
      <p className="text-xs text-zinc-400 leading-relaxed">
        Instagram, TikTok, and X (Twitter) require cookies to download reels/videos. You only need to do this <strong className="text-zinc-200">once per platform</strong>.
      </p>
      <div className="space-y-2 text-xs text-zinc-300">
        <div className="flex gap-2"><span className="shrink-0 w-5 h-5 rounded-full bg-amber-600 text-black flex items-center justify-center text-[0.625rem] font-bold">1</span><span>Install <a href="https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc" target="_blank" rel="noreferrer" className="text-rose-400 underline">"Get cookies.txt LOCALLY"</a> in Chrome</span></div>
        <div className="flex gap-2"><span className="shrink-0 w-5 h-5 rounded-full bg-amber-600 text-black flex items-center justify-center text-[0.625rem] font-bold">2</span><span>Go to instagram.com, tiktok.com, or x.com while logged in</span></div>
        <div className="flex gap-2"><span className="shrink-0 w-5 h-5 rounded-full bg-amber-600 text-black flex items-center justify-center text-[0.625rem] font-bold">3</span><span>Click extension → Export → copy all text</span></div>
        <div className="flex gap-2"><span className="shrink-0 w-5 h-5 rounded-full bg-amber-600 text-black flex items-center justify-center text-[0.625rem] font-bold">4</span><span>Paste below and Save (platform is auto-detected)</span></div>
      </div>
      <div className="space-y-2">
        <textarea value={cookiesText} onChange={e => setCookiesText(e.target.value)}
          placeholder="# Netscape HTTP Cookie File&#10;# Paste instagram.com, tiktok.com, or x.com cookies.txt here..."
          rows={4}
          className="w-full rounded-xl border border-zinc-700/70 bg-zinc-950/80 px-3 py-2.5 text-xs font-mono text-zinc-300 placeholder-zinc-600 outline-none focus:border-amber-500/60 resize-none"
        />
        <button onClick={handleSave} disabled={saving || !cookiesText.trim()}
          className="w-full rounded-xl bg-gradient-to-br from-amber-600 to-orange-600 py-2.5 text-sm font-semibold text-white transition hover:from-amber-500 hover:to-orange-500 disabled:opacity-50 cursor-pointer">
          {saving ? 'Saving…' : 'Save Cookies'}
        </button>
      </div>
    </div>
  );
}

function CookiesStatusBar({ cookieInfo, onRemove }) {
  const handleRemove = async (platform) => {
    await fetch(`${API}/cookies?platform=${platform}`, { method: 'DELETE', credentials: 'include' });
    onRemove();
  };

  const getAgeText = (savedAt) => {
    if (!savedAt) return '';
    const age = Math.round((Date.now() - savedAt) / (1000 * 60 * 60 * 24));
    return age === 0 ? 'saved today' : `${age}d ago`;
  };

  return (
    <div className="space-y-2">
      {cookieInfo?.instagram?.hasCookies ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-800/40 bg-emerald-950/20 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-emerald-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span className="font-medium">Instagram cookies active</span>
            {cookieInfo.instagram.savedAt && (
              <span className="text-emerald-600">· {getAgeText(cookieInfo.instagram.savedAt)}</span>
            )}
          </div>
          <button onClick={() => handleRemove('instagram')} className="text-[0.6875rem] text-zinc-600 hover:text-red-400 transition cursor-pointer">Remove</button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-800/40 bg-amber-950/20 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-amber-300">
            <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
            <span className="font-medium">Instagram cookies missing</span>
          </div>
        </div>
      )}

      {cookieInfo?.tiktok?.hasCookies ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-800/40 bg-emerald-950/20 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-emerald-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span className="font-medium">TikTok cookies active</span>
            {cookieInfo.tiktok.savedAt && (
              <span className="text-emerald-600">· {getAgeText(cookieInfo.tiktok.savedAt)}</span>
            )}
          </div>
          <button onClick={() => handleRemove('tiktok')} className="text-[0.6875rem] text-zinc-600 hover:text-red-400 transition cursor-pointer">Remove</button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-800/40 bg-amber-950/20 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-amber-300">
            <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
            <span className="font-medium">TikTok cookies missing</span>
          </div>
        </div>
      )}

      {cookieInfo?.x?.hasCookies ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-800/40 bg-emerald-950/20 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-emerald-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span className="font-medium">X (Twitter) cookies active</span>
            {cookieInfo.x.savedAt && (
              <span className="text-emerald-600">· {getAgeText(cookieInfo.x.savedAt)}</span>
            )}
          </div>
          <button onClick={() => handleRemove('x')} className="text-[0.6875rem] text-zinc-600 hover:text-red-400 transition cursor-pointer">Remove</button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-800/40 bg-amber-950/20 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-amber-300">
            <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
            <span className="font-medium">X (Twitter) cookies missing</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function InstagramFramesPage() {
  const { notify, navigateTo } = useApp();

  // ── Restore persisted state (IndexedDB — async, hydrated below) ──────────
  // Full frame images (base64 included) live on IndexedDB, not localStorage — localStorage's
  // ~5-10MB quota can't hold a real batch (263 frames × ~100-300KB each), so the old code
  // stripped the base64 before saving there and every restored thumbnail rendered black.
  const hydratedRef = useRef(false);

  // Multiple URL inputs
  const [urlList, setUrlList] = useState(['']);
  const [frameCount, setFrameCount] = useState(10);
  const [intervalMs, setIntervalMs] = useState(200);

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [allFrames, setAllFrames] = useState([]); // { urlLabel, frames[] }
  const [selected, setSelected] = useState(new Set()); // Set of frame unique IDs

  const [previewIdx, setPreviewIdx] = useState(null); // index in flatFrames
  const [cookieInfo, setCookieInfo] = useState(null);
  const [dragBox, setDragBox] = useState(null);
  const [isDragSelecting, setIsDragSelecting] = useState(false);
  const [isDroppingVideo, setIsDroppingVideo] = useState(false);
  const [videoDropLoading, setVideoDropLoading] = useState(false);
  const videoFileInputRef = useRef(null);

  // Profile Grab — pull N random reels from an IG profile URL
  const [showProfileGrab, setShowProfileGrab] = useState(true);
  const [profileUrl, setProfileUrl] = useState(() => { try { return window.localStorage.getItem(PROFILE_URL_KEY) || ''; } catch { return ''; } });
  const [profileCount, setProfileCount] = useState(10);
  const [customCount, setCustomCount] = useState('');
  const [useApifyFallback, setUseApifyFallback] = useState(() => {
    try { const v = window.localStorage.getItem('kyros.igFrames.useApifyFallback'); return v === null ? false : v === '1'; } catch { return false; }
  });
  // Skip reels already grabbed from this profile before, so repeat grabs surface new ones
  // instead of reshuffling the same pool. On by default; user-visible toggle to turn off.
  const [skipDuplicateReels, setSkipDuplicateReels] = useState(() => {
    try { const v = window.localStorage.getItem('kyros.igFrames.skipDuplicateReels'); return v === null ? true : v === '1'; } catch { return true; }
  });
  const [isGrabbing, setIsGrabbing] = useState(false);
  const [videoDownloading, setVideoDownloading] = useState(false);
  const [grabProgress, setGrabProgress] = useState(null);
  const [grabPhase, setGrabPhase] = useState(null);
  const [grabDownloaded, setGrabDownloaded] = useState(0);
  const [grabErrors, setGrabErrors] = useState([]);
  const [grabbedLinks, setGrabbedLinks] = useState([]);
  const [showLinksPanel, setShowLinksPanel] = useState(false);
  const [linksCopied, setLinksCopied] = useState(false);
  const [frameMode, setFrameMode] = useState(() => {
    try { return window.localStorage.getItem('kyros.igFrames.frameMode') || 'brain'; } catch { return 'brain'; }
  });
  useEffect(() => {
    try { window.localStorage.setItem('kyros.igFrames.frameMode', frameMode); } catch { /* ignore */ }
  }, [frameMode]);
  const [linkCopied, setLinkCopied] = useState(null);

  // ── Collections (Folders) ─────────────────────────────────────────────────
  const FOLDERS_KEY = 'kyros.igFrames.collections';
  const COLORS = ['#a855f7','#ec4899','#3b82f6','#22c55e','#f59e0b','#ef4444','#06b6d4','#f97316'];
  const loadFolders = () => { try { const r = localStorage.getItem(FOLDERS_KEY); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a : []; } catch { return []; } };
  const saveFolders = (f) => { try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(f)); } catch {} };

  const [folders, setFolders] = useState(() => loadFolders());
  const [activeFolder, setActiveFolder] = useState(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderColor, setNewFolderColor] = useState(() => COLORS[Math.floor(Math.random() * COLORS.length)]);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState(null);

  const refreshFolders = () => setFolders(loadFolders());
  const handleCreateFolder = () => {
    if (!newFolderName.trim()) return;
    const col = { id: `col-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, name: newFolderName.trim(), color: newFolderColor, createdAt: Date.now(), frameIds: [] };
    const updated = [...loadFolders(), col];
    saveFolders(updated); setFolders(updated);
    setNewFolderName(''); setNewFolderColor(COLORS[Math.floor(Math.random() * COLORS.length)]); setShowNewFolder(false);
  };
  const handleDeleteFolder = (id) => { const updated = loadFolders().filter(c => c.id !== id); saveFolders(updated); setFolders(updated); if (activeFolder === id) setActiveFolder(null); };
  const handleRenameFolder = (id, name) => { const updated = loadFolders().map(c => c.id === id ? { ...c, name: name.trim() || c.name } : c); saveFolders(updated); setFolders(updated); setRenamingFolder(null); };
  const handleAddToFolder = (folderId, frameIds) => {
    const updated = loadFolders().map(c => c.id === folderId ? { ...c, frameIds: Array.from(new Set([...(c.frameIds || []), ...frameIds])) } : c);
    saveFolders(updated); setFolders(updated);
    notify(`Added ${frameIds.length} frame${frameIds.length > 1 ? 's' : ''} to folder`, 'success');
  };
  const activeDragSelectedRef = useRef(new Set());
  const initialSelectedRef = useRef(new Set());

  useEffect(() => {
    const handleMouseDown = (e) => {
      if (e.button !== 0) return;
      const target = e.target;
      const isInteractive = target.closest('button, input, select, textarea, a, [role="button"]') ||
                            target.closest('.ConfirmDialog') ||
                            target.closest('.Modal') ||
                            target.closest('[class*="ContextMenu"]');
      if (isInteractive) return;
      if (target.closest('img, video, [draggable="true"]')) return;

      const startX = e.clientX;
      const startY = e.clientY;
      let hasTriggeredDrag = false;
      const initialSelected = new Set(selected);
      initialSelectedRef.current = initialSelected;
      activeDragSelectedRef.current = new Set();

      const handleMouseMove = (moveEvent) => {
        const currentX = moveEvent.clientX;
        const currentY = moveEvent.clientY;
        const dx = currentX - startX;
        const dy = currentY - startY;

        if (!hasTriggeredDrag && Math.sqrt(dx * dx + dy * dy) > 5) {
          hasTriggeredDrag = true;
          setIsDragSelecting(true);
        }

        if (hasTriggeredDrag) {
          moveEvent.preventDefault();
          setDragBox({ startX, startY, currentX, currentY });

          const boxLeft = Math.min(startX, currentX);
          const boxTop = Math.min(startY, currentY);
          const boxWidth = Math.abs(currentX - startX);
          const boxHeight = Math.abs(currentY - startY);

          const elements = document.querySelectorAll('[data-library-item-id]');
          const intersectingIds = new Set();

          elements.forEach((el) => {
            const itemId = el.getAttribute('data-library-item-id');
            if (!itemId) return;
            const rect = el.getBoundingClientRect();
            const intersects = !(
              rect.right < boxLeft ||
              rect.left > boxLeft + boxWidth ||
              rect.bottom < boxTop ||
              rect.top > boxTop + boxHeight
            );
            if (intersects) intersectingIds.add(itemId);
          });

          const isSetEqual = (a, b) => a.size === b.size && [...a].every(value => b.has(value));
          if (!isSetEqual(intersectingIds, activeDragSelectedRef.current)) {
            activeDragSelectedRef.current = intersectingIds;
            const isModifierHeld = moveEvent.shiftKey || moveEvent.ctrlKey || moveEvent.metaKey;
            setSelected(() => {
              if (isModifierHeld) {
                const merged = new Set(initialSelected);
                intersectingIds.forEach(id => {
                  if (initialSelected.has(id)) {
                    merged.delete(id);
                  } else {
                    merged.add(id);
                  }
                });
                return merged;
              } else {
                return new Set(intersectingIds);
              }
            });
          }
        }
      };

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        setIsDragSelecting(false);
        setDragBox(null);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousedown', handleMouseDown);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, [selected]);

  // Flat list of all frames across all URLs, annotated with a unique ID.
  // Include fIdx in the id — smart-mode frames (face/outfit picks) all share timestampMs=0,
  // so timestampMs alone collides and makes it impossible to select just one of them.
  const flatFrames = allFrames.flatMap(g =>
    g.frames.map((f, fIdx) => ({
      ...f,
      id: `${g.url}-${f.timestampMs}-${fIdx}`,
      urlLabel: g.urlLabel,
      url: g.url
    }))
  );

  const formatMs = (v) => v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;

  const toggleSelect = useCallback((id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── Restore persisted state from IndexedDB, once on mount ────────────────
  useEffect(() => {
    let cancelled = false;
    loadIgFramesState().then((saved) => {
      if (cancelled || !saved) { hydratedRef.current = true; return; }
      if (saved.urlList) setUrlList(saved.urlList);
      if (saved.frameCount) setFrameCount(saved.frameCount);
      if (saved.intervalMs) setIntervalMs(saved.intervalMs);
      if (saved.allFrames) setAllFrames(saved.allFrames);
      if (saved.selected) setSelected(new Set(saved.selected));
      hydratedRef.current = true;
    }).catch(() => { hydratedRef.current = true; });
    return () => { cancelled = true; };
  }, []);

  // ── Persist state on change (after hydration, so we don't clobber the
  // saved batch with the empty initial state before it's loaded) ──────────
  useEffect(() => {
    if (loading || !hydratedRef.current) return;
    saveIgFramesState({ urlList, frameCount, intervalMs, allFrames, selected: Array.from(selected) });
  }, [urlList, frameCount, intervalMs, allFrames, selected, loading]);

  // ── Keyboard navigation for preview ─────────────────────────────────────
  useEffect(() => {
    if (previewIdx === null) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setPreviewIdx(null);
      if (e.key === 'ArrowLeft' && previewIdx > 0) setPreviewIdx(previewIdx - 1);
      if (e.key === 'ArrowRight' && previewIdx < flatFrames.length - 1) setPreviewIdx(previewIdx + 1);
      if (e.key === ' ') {
        e.preventDefault();
        const f = flatFrames[previewIdx];
        if (f) toggleSelect(f.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewIdx, flatFrames, toggleSelect]);

  useEffect(() => {
    fetch(`${API}/cookies-status`, { credentials: 'include' })
      .then(r => r.json())
      .then(j => setCookieInfo(j.success ? j.data : {}))
      .catch(() => setCookieInfo({}));
  }, []);

  const reloadCookieInfo = () => {
    setCookieInfo(null);
    fetch(`${API}/cookies-status`, { credentials: 'include' })
      .then(r => r.json())
      .then(j => setCookieInfo(j.success ? j.data : {}))
      .catch(() => setCookieInfo({}));
  };

  // URL list management
  const updateUrl = (i, val) => setUrlList(prev => prev.map((u, idx) => idx === i ? val : u));
  const addUrl = () => setUrlList(prev => [...prev, '']);
  const removeUrl = (i) => setUrlList(prev => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev);

  const handleExtract = async () => {
    const urls = urlList.map(u => u.trim()).filter(u => u && (u.includes('instagram.com') || u.includes('tiktok.com') || u.includes('x.com') || u.includes('twitter.com')));
    if (!urls.length) { notify('Add at least one valid Instagram, TikTok, or X URL', 'error'); return; }
    
    // Check if we have the cookies for the platforms of the URLs entered
    const hasInstagram = urls.some(u => u.includes('instagram.com'));
    const hasTikTok = urls.some(u => u.includes('tiktok.com'));
    const hasX = urls.some(u => u.includes('x.com') || u.includes('twitter.com'));

    if (hasInstagram && !cookieInfo?.instagram?.hasCookies) {
      notify('Set up Instagram cookies first', 'error');
      return;
    }
    if (hasTikTok && !cookieInfo?.tiktok?.hasCookies) {
      notify('Set up TikTok cookies first', 'error');
      return;
    }
    if (hasX && !cookieInfo?.x?.hasCookies) {
      notify('Set up X (Twitter) cookies first', 'error');
      return;
    }

    setLoading(true);
    setProgress('Initializing...');
    setSelected(new Set());

    let allSucceeded = true;

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const isTikTok = url.includes('tiktok.com');
      const isX = url.includes('x.com') || url.includes('twitter.com');
      const platformName = isTikTok ? 'TikTok' : isX ? 'X' : 'Instagram';
      const statusIdMatch = url.match(/\/status\/(\d+)/i);
      const urlShort = statusIdMatch ? statusIdMatch[1] : (url.match(/\/(reel|p|tv|video)\/([A-Za-z0-9_-]+)/)?.[2] || url.split('/').slice(-2, -1)[0] || url);
      
      let success = false;
      let json = null;
      let attempt = 0;
      const maxRetries = 3;

      while (attempt < maxRetries && !success) {
        attempt++;
        if (attempt > 1) {
          setProgress(`Retrying ${i + 1}/${urls.length} (Attempt ${attempt}/${maxRetries}): ${urlShort}`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          setProgress(`Downloading ${i + 1}/${urls.length}: ${urlShort}`);
        }

        try {
          const res = await fetch(`${API}/extract`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ url, frameCount, intervalMs }),
          });
          json = await res.json();
          if (res.ok && json.success) {
            success = true;
          } else {
            if (res.status === 401) reloadCookieInfo();
          }
        } catch (err) {
          // Trigger retry
        }
      }

      if (success && json?.data?.frames) {
        const label = statusIdMatch ? `x-${statusIdMatch[1]}` : (url.match(/\/(reel|p|tv|video)\/([A-Za-z0-9_-]+)/)?.[2] || `${isTikTok ? 'tiktok' : isX ? 'x' : 'clip'}${i + 1}`);
        const newGroup = { urlLabel: label, url, frames: json.data.frames };
        
        setAllFrames(prev => {
          const filtered = prev.filter(g => g.url !== url);
          return [newGroup, ...filtered];
        });
      } else {
        allSucceeded = false;
        const errorMsg = (typeof json?.error === 'object' ? json.error?.message : json?.error) || json?.message || 'Extract failed';
        notify(`URL ${i + 1} failed: ${errorMsg}`, 'error');
      }
    }

    setLoading(false);
    setProgress('');

    if (allSucceeded) {
      notify('All URLs extracted successfully ✓', 'success');
    } else {
      notify('Some extracts failed, successfully extracted files were kept.', 'warning');
    }
  };

  const clearAllFrames = () => {
    setAllFrames([]);
    setSelected(new Set());
    setPreviewIdx(null);
    clearIgFramesState();
    notify('Cleared all extracted frames', 'success');
  };

  // Reset the "already grabbed" history for the current profile URL, so future grabs are
  // willing to re-surface reels that were previously grabbed and skipped.
  const grabHistoryCountForCurrentProfile = () => {
    const u = extractIgUsername(profileUrl.trim());
    if (!u) return 0;
    return (loadGrabHistory()[u] || []).length;
  };
  const forgetGrabHistory = () => {
    const u = extractIgUsername(profileUrl.trim());
    if (!u) return;
    const history = loadGrabHistory();
    delete history[u];
    saveGrabHistory(history);
    notify(`Forgot grabbed-reel history for @${u} — next grab can re-surface old reels`, 'success');
  };

  // ── Local video drop → extract frames via server ffmpeg ─────────────────
  const processVideoFiles = async (files) => {
    const videos = Array.from(files).filter(f => /^video\//.test(f.type) || /\.(mp4|mov|webm|m4v|mkv)$/i.test(f.name));
    if (!videos.length) { notify('Drop video files (MP4, MOV, WEBM)', 'error'); return; }
    setVideoDropLoading(true);
    let added = 0;
    for (const file of videos) {
      try {
        const buf = await file.arrayBuffer();
        const smartPick = 1; // always use smart pick in Frame Grabber
        const res = await fetch(`${API}/extract-smart-from-upload?type=${encodeURIComponent(file.type || 'video/mp4')}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) throw new Error(json?.error?.message || json?.error || `HTTP ${res.status}`);
        const frames = json.data?.frames || [];
        if (!frames.length) throw new Error('No frame extracted');
        const label = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || `local-video-${Date.now()}`;
        const group = {
          urlLabel: label,
          url: `local://${file.name}`,
          frames: frames.map((f, i) => ({
            base64: f.base64,
            mimeType: f.mimeType || 'image/jpeg',
            timestampMs: i * 200,
            frameIndex: i,
          })),
        };
        setAllFrames(prev => [group, ...prev.filter(g => g.url !== group.url)]);
        added++;
      } catch (err) {
        notify(`${file.name}: ${err.message}`, 'error');
      }
    }
    setVideoDropLoading(false);
    if (added) notify(`Extracted frames from ${added} video${added > 1 ? 's' : ''} ✓`, 'success');
  };

  const clearAllEverything = () => {
    if (window.confirm('Delete all links and extracted frames?')) {
      setUrlList(['']);
      setAllFrames([]);
      setSelected(new Set());
      setPreviewIdx(null);
      notify('Deleted all links and frames', 'success');
    }
  };

  // ── Profile Grab — pull N random reels from an IG profile ────────────────
  const grabProfile = async () => {
    if (!profileUrl.trim()) { notify('Paste an Instagram profile URL first', 'error'); return; }
    const finalCount = customCount && Number(customCount) > 0 ? Number(customCount) : profileCount;
    setIsGrabbing(true);
    setGrabProgress(null);
    setGrabPhase(null);
    setGrabDownloaded(0);
    setGrabErrors([]);
    setGrabbedLinks([]);
    setShowLinksPanel(false);
    let savedCount = 0;
    let alreadyGrabbedSkipped = 0;
    const collectedLinks = [];
    const igUsername = extractIgUsername(profileUrl.trim());
    const grabHistory = loadGrabHistory();
    const excludeShortcodes = (skipDuplicateReels && igUsername) ? (grabHistory[igUsername] || []) : [];
    try {
      const res = await fetch('/api/instagram-frames/grab-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileUrl: profileUrl.trim(), count: finalCount, multiFrameCount: frameCount, intervalMs, useApify: useApifyFallback, excludeShortcodes }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j?.error?.message || j?.error || msg; } catch {}
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'frame') {
              savedCount++;
              const f = msg.frame;
              const rawSource = f.sourceUrl || '';
              // Server sends the yt-dlp basename (shortcode) as sourceUrl — reconstruct full IG URL.
              // Do NOT strip any suffix: each basename is a unique video shortcode, stripping would
              // collapse different videos into the same key and cause accidental bulk-deletion.
              const fullSourceUrl = rawSource.startsWith('http')
                ? rawSource
                : rawSource
                  ? `https://www.instagram.com/reel/${rawSource}/`
                  : `profile-grab-${Date.now()}-${savedCount}`;
              const sourceKey = fullSourceUrl;
              const sourceLabel = rawSource.startsWith('http')
                ? (rawSource.match(/\/(reel|p|tv|video)\/([A-Za-z0-9_-]+)/)?.[2] || rawSource.slice(0, 30))
                : (rawSource.slice(0, 30) || `grab-${savedCount}`);
              // Track reel links for the links panel
              if (fullSourceUrl && !fullSourceUrl.startsWith('profile-grab-')) {
                collectedLinks.push(fullSourceUrl);
              }
              setAllFrames(prev => {
                const existing = prev.find(g => g.url === sourceKey);
                if (existing) {
                  return prev.map(g => g.url === sourceKey ? { ...g, frames: [...g.frames, { base64: f.base64, mimeType: f.mimeType || 'image/jpeg', timestampMs: f.timestampMs || 0, frameIndex: g.frames.length }] } : g);
                }
                return [{ urlLabel: sourceLabel, url: sourceKey, frames: [{ base64: f.base64, mimeType: f.mimeType || 'image/jpeg', timestampMs: f.timestampMs || 0, frameIndex: 0 }] }, ...prev];
              });

            } else if (msg.type === 'reel_link') {
              // Server sends discovered reel URLs before downloading
              if (msg.url) collectedLinks.push(msg.url);
            } else if (msg.type === 'phase') {
              setGrabPhase(msg.phase);
            } else if (msg.type === 'download_progress') {
              setGrabDownloaded(msg.downloaded);
            } else if (msg.type === 'progress') {
              setGrabProgress({ done: msg.done, total: msg.total });
            } else if (msg.type === 'video_error') {
              setGrabErrors(prev => [...prev, { url: msg.url, message: msg.message }]);
            } else if (msg.type === 'done') {
              setGrabPhase(null);
              setGrabProgress({ done: msg.totalAttempted, total: msg.totalAttempted });
              alreadyGrabbedSkipped = msg.alreadyGrabbedSkipped || 0;
              // Remember these shortcodes so a future grab on this profile skips them —
              // persisted per-username, survives across grabs and app restarts. Skip recording
              // entirely when the toggle is off, so switching it off fully disables the feature.
              if (skipDuplicateReels && igUsername && Array.isArray(msg.newShortcodes) && msg.newShortcodes.length) {
                const history = loadGrabHistory();
                const prevList = history[igUsername] || [];
                history[igUsername] = Array.from(new Set([...prevList, ...msg.newShortcodes])).slice(-500);
                saveGrabHistory(history);
              }
              // Emit final links list
              if (msg.reelLinks && Array.isArray(msg.reelLinks)) {
                const merged = Array.from(new Set([...collectedLinks, ...msg.reelLinks]));
                setGrabbedLinks(merged);
                if (merged.length > 0) setShowLinksPanel(true);
              } else if (collectedLinks.length > 0) {
                setGrabbedLinks(Array.from(new Set(collectedLinks)));
                setShowLinksPanel(true);
              }
            } else if (msg.type === 'error') {
              throw new Error(msg.message);
            }
          } catch (parseErr) {
            if (parseErr?.message && !parseErr.message.includes('JSON')) throw parseErr;
          }
        }
      }
      const skippedNote = alreadyGrabbedSkipped > 0 ? ` (skipped ${alreadyGrabbedSkipped} already grabbed before)` : '';
      if (savedCount > 0) notify(`Grabbed ${savedCount} frame${savedCount === 1 ? '' : 's'} from profile${skippedNote} 🎬`, 'success');
      else if (alreadyGrabbedSkipped > 0) notify(`No new reels — you've already grabbed all ${alreadyGrabbedSkipped} reel${alreadyGrabbedSkipped === 1 ? '' : 's'} this profile has available. Use "Forget grabbed reels" below to re-grab them.`, 'error');
      else notify('No frames grabbed — check cookies or try fewer videos', 'error');
    } catch (err) {
      notify(err.message || 'Profile grab failed', 'error');
    } finally {
      setIsGrabbing(false);
      setGrabProgress(null);
      setGrabPhase(null);
      setGrabDownloaded(0);
    }
  };

  const copyLink = (url) => {
    if (!url || url.startsWith('local://')) { notify('No source URL available', 'error'); return; }
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(url);
      notify('Link copied! 📋', 'success');
      setTimeout(() => setLinkCopied(null), 2000);
    }).catch(() => notify('Failed to copy', 'error'));
  };

  // All selected frames' source links, one per line — 10 frames selected gives 10 lines.
  const copySelectedLinks = () => {
    const links = flatFrames.filter((f) => selected.has(f.id)).map((f) => f.url).filter((u) => u && !u.startsWith('local://'));
    if (!links.length) { notify('No source links in the selection (uploaded videos have none)', 'error'); return; }
    navigator.clipboard.writeText(links.join('\n'))
      .then(() => notify(`Copied ${links.length} link${links.length === 1 ? '' : 's'} 📋`, 'success'))
      .catch(() => notify('Failed to copy', 'error'));
  };

  // Re-download the FULL source reel/video (not the still frame) for the frame's source URL.
  const downloadVideo = async (url) => {
    if (!url || url.startsWith('local://')) { notify('No source link for this frame — can only download the frame image', 'error'); return; }
    if (videoDownloading) return;
    setVideoDownloading(true);
    notify('Fetching the video…', 'info');
    try {
      const res = await fetch('/api/instagram-frames/download-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        let msg = `Download failed (${res.status})`;
        try { const j = await res.json(); msg = j?.error?.message || j?.message || msg; } catch { /* non-JSON */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const m = cd.match(/filename="?([^";]+)"?/);
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = m ? m[1] : `reel_${Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(dlUrl);
      notify('Video downloaded 🎬', 'success');
    } catch (err) {
      notify(err.message || 'Video download failed', 'error');
    } finally {
      setVideoDownloading(false);
    }
  };

  const selectAll = () => setSelected(new Set(flatFrames.map(f => f.id)));
  const selectNone = () => setSelected(new Set());

  // ── Build localStorage payload for target page ───────────────────────────
  const buildStoragePayload = (selectedIds) => {
    return flatFrames
      .filter(f => selectedIds.has(f.id))
      .map((f, i) => {
        const dataUrl = base64ToDataUrl(f.base64, f.mimeType);
        return {
          id: `ig-frame-${f.id}-${Date.now()}`,
          name: `ig_frame_${i + 1}.jpg`,
          type: f.mimeType,
          size: 0,
          dataUrl,
          // Carry the source reel link so the generated result can trace back to the video.
          sourceUrl: f.url && !f.url.startsWith('local://') ? f.url : null,
        };
      });
  };

  // ── Send selected frames to another page ─────────────────────────────────
  const sendTo = (page) => {
    if (!selected.size) { notify('Select at least one frame', 'error'); return; }
    const target = SEND_TARGETS[page];
    if (!target) { notify('Unknown destination', 'error'); return; }
    const payload = buildStoragePayload(selected);
    const handoff = payload.map(p => ({ dataUrl: p.dataUrl, name: p.name, sourceUrl: p.sourceUrl || null }));
    // Stash for reliable mount-time pickup (the event alone races with the lazy page load).
    stashSourceHandoff(page, handoff);
    navigateTo(handoffDestination(page));
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent(target.event, { detail: { items: handoff } }));
    }, 300);
    notify(`${payload.length} frame${payload.length > 1 ? 's' : ''} sent to ${target.label} ⚡`, 'success');
  };

  const sendSingleTo = (globalIdx, page) => {
    const f = flatFrames[globalIdx];
    if (!f) return;
    const dataUrl = base64ToDataUrl(f.base64, f.mimeType);
    const srcUrl = f.url && !f.url.startsWith('local://') ? f.url : null;
    const payload = [{
      id: `ig-frame-${f.id}-${Date.now()}`,
      name: `ig_frame_${globalIdx + 1}.jpg`,
      type: f.mimeType,
      size: 0,
      dataUrl,
      sourceUrl: srcUrl,
    }];
    const target = SEND_TARGETS[page];
    if (!target) { notify('Unknown destination', 'error'); return; }
    const one = [{ dataUrl, name: payload[0].name, sourceUrl: srcUrl }];
    stashSourceHandoff(page, one);
    // Fire event for already-mounted pages — no navigation so frames stay in memory.
    window.dispatchEvent(new CustomEvent(target.event, { detail: { items: one } }));
    notify(`1 frame sent to ${target.label} ⚡ — click ${target.label} in the sidebar`, 'success');
  };

  const downloadSelected = () => {
    if (!selected.size) { notify('Select at least one frame', 'error'); return; }
    flatFrames.forEach((f, i) => {
      if (selected.has(f.id)) {
        (async () => {
          const blob = await (await fetch(base64ToDataUrl(f.base64, f.mimeType))).blob();
          await downloadBlob(blob, `ig_frame_${String(i + 1).padStart(3, '0')}_${f.timestampMs}ms.jpg`);
        })();
      }
    });
  };

  // Frame Library now lives on IndexedDB (frameLibraryStore.js) — it migrated off localStorage
  // earlier because a real batch of full-res frames blows localStorage's ~5-10MB quota outright
  // (the save would throw, or silently land in a legacy key the Library page never reads once
  // its IndexedDB store already has data). Use the same store here instead of writing raw
  // localStorage directly, which is what this used to do.
  const saveSelectedToLibrary = async () => {
    if (!selected.size) { notify('Select at least one frame', 'error'); return; }
    try {
      let i = 0;
      const newItems = flatFrames
        .filter(f => selected.has(f.id))
        .map(f => {
          i++;
          const dataUrl = base64ToDataUrl(f.base64, f.mimeType);
          const isTikTok = f.url?.includes('tiktok.com');
          const isX = f.url?.includes('x.com') || f.url?.includes('twitter.com');
          const prefix = isTikTok ? 'tiktok' : isX ? 'x' : 'ig';
          const source = isTikTok ? 'TikTok Frames' : isX ? 'X Frames' : 'Instagram Frames';
          return {
            id: `frame-${Date.now()}-${f.id}-${Math.random().toString(36).slice(2, 10)}`,
            name: `${prefix}_frame_${i}.jpg`,
            type: f.mimeType,
            size: 0,
            createdAt: Date.now(),
            source,
            dataUrl,
            usage: [],
          };
        });

      const addedCount = await appendFrames(newItems);
      notify(`Saved ${addedCount} frame${addedCount === 1 ? '' : 's'} to Frame Library 📥`, 'success');
    } catch (err) {
      notify('Failed to save to Frame Library', 'error');
    }
  };

  const saveSingleToLibrary = async (globalIdx) => {
    const f = flatFrames[globalIdx];
    if (!f) return;
    try {
      const dataUrl = base64ToDataUrl(f.base64, f.mimeType);
      const isTikTok = f.url?.includes('tiktok.com');
      const isX = f.url?.includes('x.com') || f.url?.includes('twitter.com');
      const prefix = isTikTok ? 'tiktok' : isX ? 'x' : 'ig';
      const source = isTikTok ? 'TikTok Frames' : isX ? 'X Frames' : 'Instagram Frames';
      const newItem = {
        id: `frame-${Date.now()}-${f.id}-${Math.random().toString(36).slice(2, 10)}`,
        name: `${prefix}_frame_${globalIdx + 1}.jpg`,
        type: f.mimeType,
        size: 0,
        createdAt: Date.now(),
        source,
        dataUrl,
        usage: [],
      };

      await appendFrames([newItem]);
      notify('Saved frame to Frame Library 📥', 'success');
    } catch (err) {
      notify('Failed to save to Frame Library', 'error');
    }
  };

  const hasCookies = !!(cookieInfo?.instagram?.hasCookies || cookieInfo?.tiktok?.hasCookies || cookieInfo?.x?.hasCookies);
  const totalFrames = flatFrames.length;

  const handleDragStart = (e, frame, frameId, globalIdx) => {
    if (!window.electronAPI?.startDragFiles) return;

    let dragTargets = [];
    if (selected.has(frameId)) {
      dragTargets = flatFrames.filter(f => selected.has(f.id));
    } else {
      dragTargets = {
        ...frame,
        id: frameId
      };
      dragTargets = [dragTargets];
    }

    const filesPayload = dragTargets.map((f, i) => {
      const ext = f.mimeType === 'image/png' ? 'png' : f.mimeType === 'image/webp' ? 'webp' : 'jpg';
      const name = `frame_${String(i + 1).padStart(3, '0')}_${f.timestampMs}ms.${ext}`;
      return {
        name,
        base64: f.base64
      };
    });

    e.preventDefault();
    window.electronAPI.startDragFiles({ files: filesPayload });
  };

  // ── Preview panel frame ──────────────────────────────────────────────────
  const previewFrame = previewIdx !== null ? flatFrames[previewIdx] : null;
  const previewIsSelected = previewFrame !== null && selected.has(previewFrame.id);
  // Every frame from the SAME reel as the one open, with its index in flatFrames so a click can
  // jump straight to it — the filmstrip under the preview.
  const previewReelFrames = previewFrame
    ? flatFrames.map((f, i) => ({ f, i })).filter((x) => x.f.url === previewFrame.url)
    : [];

  return (
    <div className="flex flex-col gap-0 animate-in h-full min-h-0">

      {/* ── FOLDERS STRIP — always at top, sticky ─────────────────────────── */}
      <div className="sticky top-0 z-20 flex items-center gap-1.5 flex-wrap px-0.5 py-2 bg-[var(--bg-main,#0c0c0e)] border-b border-zinc-800/50 mb-4">
        <button
          onClick={() => setActiveFolder(null)}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[0.6875rem] font-medium border transition cursor-pointer ${activeFolder === null ? 'bg-zinc-700 border-zinc-500 text-white' : 'bg-zinc-900/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}
        >
          📁 All frames
        </button>

        {folders.map((col) => {
          const isActive = activeFolder === col.id;
          const count = col.frameIds?.length || 0;
          return (
            <div key={col.id} className="relative group/col flex items-center">
              {renamingFolder?.id === col.id ? (
                <form onSubmit={(e) => { e.preventDefault(); handleRenameFolder(col.id, renamingFolder.name); }} className="flex items-center gap-1">
                  <input autoFocus value={renamingFolder.name} onChange={(e) => setRenamingFolder({ ...renamingFolder, name: e.target.value })} onBlur={() => handleRenameFolder(col.id, renamingFolder.name)} onKeyDown={(e) => e.key === 'Escape' && setRenamingFolder(null)} className="rounded-full px-2 py-0.5 text-[0.6875rem] bg-zinc-800 border border-zinc-600 text-white outline-none w-24" />
                </form>
              ) : (
                <button
                  onClick={() => setActiveFolder(isActive ? null : col.id)}
                  className={`flex items-center gap-1.5 pl-2 pr-2 py-1 rounded-full text-[0.6875rem] font-medium border transition cursor-pointer ${isActive ? 'text-white' : 'bg-zinc-900/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}
                  style={isActive ? { background: col.color + '33', borderColor: col.color + '80' } : {}}
                >
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: col.color }} />
                  {col.name}
                  {count > 0 && <span className="text-[0.5625rem] opacity-60 ml-0.5">({count})</span>}
                </button>
              )}
              {renamingFolder?.id !== col.id && (
                <div className="absolute -top-1 -right-1 hidden group-hover/col:flex items-center gap-0.5 z-10">
                  <button onClick={(e) => { e.stopPropagation(); setRenamingFolder({ id: col.id, name: col.name }); }} className="w-4 h-4 rounded-full bg-zinc-800 border border-zinc-600 text-[0.5rem] flex items-center justify-center cursor-pointer hover:text-white" title="Rename">✏️</button>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteFolder(col.id); }} className="w-4 h-4 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 hover:text-red-400 text-[0.625rem] flex items-center justify-center cursor-pointer" title="Delete">×</button>
                </div>
              )}
            </div>
          );
        })}

        {showNewFolder ? (
          <form onSubmit={(e) => { e.preventDefault(); handleCreateFolder(); }} className="flex items-center gap-1">
            <div className="w-4 h-4 rounded-full cursor-pointer border-2 border-white/20 flex-shrink-0" style={{ background: newFolderColor }} onClick={() => { setNewFolderColor(COLORS[(COLORS.indexOf(newFolderColor)+1)%COLORS.length]); }} title="Click to change colour" />
            <input autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setShowNewFolder(false)} placeholder="Folder name…" className="rounded-full px-2 py-0.5 text-[0.6875rem] bg-zinc-800 border border-zinc-600 text-white outline-none w-28 placeholder-zinc-600" />
            <button type="submit" className="text-[0.625rem] text-emerald-400 font-semibold cursor-pointer">✓</button>
            <button type="button" onClick={() => setShowNewFolder(false)} className="text-[0.625rem] text-zinc-500 cursor-pointer">✕</button>
          </form>
        ) : (
          <button onClick={() => setShowNewFolder(true)} className="flex items-center gap-1 px-2 py-1 rounded-full text-[0.6875rem] text-zinc-500 border border-dashed border-zinc-700 hover:border-zinc-500 hover:text-zinc-300 transition cursor-pointer">
            + New Folder
          </button>
        )}

        {selected.size > 0 && folders.length > 0 && (
          <div className="ml-auto relative group/addmenu">
            <button className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[0.6875rem] bg-zinc-800/80 border border-zinc-700/60 text-zinc-300 hover:border-zinc-500 transition cursor-pointer">
              📁 Save {selected.size} to folder…
            </button>
            <div className="absolute right-0 top-full mt-1 bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-xl p-1 min-w-[150px] z-30 hidden group-hover/addmenu:block">
              {folders.map((col) => (
                <button key={col.id} onClick={() => handleAddToFolder(col.id, Array.from(selected))} className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg text-[0.6875rem] text-zinc-300 hover:bg-zinc-800 transition cursor-pointer">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: col.color }} />
                  {col.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

    <div className="flex flex-col lg:flex-row gap-6 flex-1 min-h-0">
      {/* ── Left column: ALL controls + frames select toolbar ───────────── */}
      <div className="flex flex-col gap-5 w-full lg:w-[430px] xl:w-[460px] 2xl:w-[500px] shrink-0 overflow-y-auto">
        {/* Cookie status */}
        {cookieInfo === null ? (
          <div className="rounded-2xl border border-zinc-800/70 bg-zinc-900/60 p-4 text-xs text-zinc-500 animate-pulse">Checking session status…</div>
        ) : hasCookies ? (
          <CookiesStatusBar cookieInfo={cookieInfo} onRemove={reloadCookieInfo} />
        ) : (
          <CookiesSetupPanel onSaved={reloadCookieInfo} />
        )}

        {/* ── Local video drop zone — no cookies needed ─────────────── */}
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDroppingVideo(true); }}
          onDragEnter={(e) => { e.preventDefault(); setIsDroppingVideo(true); }}
          onDragLeave={() => setIsDroppingVideo(false)}
          onDrop={(e) => { e.preventDefault(); setIsDroppingVideo(false); processVideoFiles(e.dataTransfer.files); }}
          onClick={() => videoFileInputRef.current?.click()}
          className={`rounded-2xl border-2 border-dashed p-4 flex items-center gap-3 cursor-pointer transition-all duration-150 ${
            isDroppingVideo
              ? 'border-pink-500 bg-pink-500/10 scale-[0.99]'
              : videoDropLoading
                ? 'border-rose-500/60 bg-rose-950/20'
                : 'border-zinc-700/60 bg-zinc-900/40 hover:border-pink-500/50 hover:bg-pink-500/5'
          }`}
        >
          <input ref={videoFileInputRef} type="file" accept="video/*,.mp4,.mov,.webm,.mkv,.m4v" multiple className="hidden" onChange={(e) => { processVideoFiles(e.target.files); e.target.value = ''; }} />
          {videoDropLoading ? (
            <>
              <svg className="animate-spin h-6 w-6 text-rose-400 shrink-0" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
              <span className="text-sm text-rose-300 font-medium">Extracting frames…</span>
            </>
          ) : (
            <>
              <div className="w-10 h-10 rounded-xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center text-xl shrink-0">🎬</div>
              <div>
                <div className="text-sm font-semibold text-zinc-200">Drop a video here, or click to browse</div>
                <div className="text-[0.6875rem] text-zinc-500 mt-0.5">MP4 · MOV · WEBM · No cookies needed · frames appear in grid below</div>
              </div>
            </>
          )}
        </div>

        {hasCookies && (
          <>
            {/* URL list */}
            <div className="rounded-2xl border border-zinc-800/70 bg-zinc-900/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-400 font-semibold uppercase tracking-wider">Instagram / TikTok / X URLs</span>
                </div>
                <div className="flex gap-2">
                  {urlList.some(u => u.trim()) && (
                    <button onClick={() => setUrlList([''])} className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-400 hover:text-red-400 transition cursor-pointer">
                      Clear Links
                    </button>
                  )}
                  {(urlList.some(u => u.trim()) || allFrames.length > 0) && (
                    <button onClick={clearAllEverything} className="flex items-center gap-1 rounded-lg border border-red-900/40 bg-red-950/20 px-2.5 py-1 text-xs font-semibold text-red-400 hover:text-red-300 hover:border-red-500/60 transition cursor-pointer">
                      Delete All
                    </button>
                  )}
                  <button onClick={addUrl} className="flex items-center gap-1 rounded-lg border border-zinc-700/70 bg-zinc-800/60 px-2.5 py-1 text-xs text-zinc-300 hover:text-white hover:border-zinc-500 transition cursor-pointer">
                    <IconPlus size={12} /> Add URL
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {urlList.map((url, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      type="url"
                      value={url}
                      onChange={e => updateUrl(i, e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleExtract()}
                      placeholder="https://www.instagram.com/reel/..., https://www.tiktok.com/@username/video/... or https://x.com/username/status/..."
                      className="flex-1 rounded-xl border border-zinc-700/80 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-pink-500/60 transition"
                    />
                    {urlList.length > 1 && (
                      <button onClick={() => removeUrl(i)} className="rounded-xl border border-zinc-700/50 bg-zinc-800/60 px-2.5 text-zinc-500 hover:text-red-400 hover:border-red-800/50 transition cursor-pointer">
                        <IconTrash size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <button onClick={handleExtract} disabled={loading}
                className="w-full rounded-xl bg-gradient-to-br from-pink-600 to-rose-600 py-2.5 text-sm font-semibold text-white transition hover:from-pink-500 hover:to-rose-500 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
                {loading ? `${progress || 'Working…'}` : `Extract Frames${urlList.filter(u => u.trim()).length > 1 ? ` (${urlList.filter(u => u.trim()).length} reels)` : ''}`}
              </button>

              {loading && (
                <div className="flex items-center gap-2 rounded-xl bg-zinc-800/60 border border-zinc-700/40 px-3 py-2">
                  <svg className="animate-spin h-3.5 w-3.5 text-pink-400 shrink-0" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                  <span className="text-xs text-zinc-400 truncate">{progress}</span>
                </div>
              )}
            </div>

            {/* ── Profile Grab Card ──────────────────────────────────────── */}
            <div className="rounded-2xl border border-rose-500/25 bg-zinc-900/60 overflow-hidden">
              <button
                type="button"
                onClick={() => setShowProfileGrab(v => !v)}
                className="w-full flex items-center gap-2 px-4 py-3 bg-gradient-to-r from-rose-600/20 to-pink-600/10 hover:from-rose-600/30 transition cursor-pointer"
              >
                <span className="text-lg">🎬</span>
                <div className="text-left flex-1">
                  <div className="text-sm font-semibold text-rose-200">Grab Reels from Profile</div>
                  <div className="text-[0.625rem] text-zinc-500">Randomly picks reels — always different videos</div>
                </div>
                <span className="text-zinc-500 text-xs transition-transform" style={{ transform: showProfileGrab ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
              </button>

              {showProfileGrab && (
                <div className="p-4 space-y-3 border-t border-rose-500/10">
                  {/* Profile URL */}
                  <div>
                    <label className="text-[0.6875rem] text-zinc-500 block mb-1">Instagram Profile or Reels URL</label>
                    <input
                      type="url"
                      value={profileUrl}
                      onChange={e => { setProfileUrl(e.target.value); try { window.localStorage.setItem(PROFILE_URL_KEY, e.target.value); } catch {} }}
                      disabled={isGrabbing}
                      placeholder="https://www.instagram.com/username/reels/"
                      className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-3 py-2 text-xs font-mono text-zinc-300 placeholder-zinc-700 outline-none focus:border-rose-500/60 disabled:opacity-50"
                    />
                  </div>

                  {/* Settings info box */}
                  <div className="flex items-center gap-2 rounded-lg border border-zinc-700/30 bg-zinc-800/30 px-3 py-2">
                    <span className="text-zinc-500 text-sm">⚙️</span>
                    <p className="text-[0.625rem] text-zinc-400 leading-relaxed">
                      Uses your <span className="font-semibold text-zinc-200">{frameCount} frames</span> every <span className="font-semibold text-zinc-200">{intervalMs}ms</span> settings from below.
                    </p>
                  </div>

                  {/* Count selector */}
                  <div>
                    <label className="text-[0.6875rem] text-zinc-500 block mb-1.5">How many reels to grab</label>
                    <div className="flex gap-2">
                      {[10, 20, 50].map(n => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => { setProfileCount(n); setCustomCount(''); }}
                          disabled={isGrabbing}
                          className={`flex-1 rounded-lg border py-2 text-xs font-semibold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                            profileCount === n && !customCount
                              ? 'border-rose-500/70 bg-rose-500/15 text-rose-200'
                              : 'border-zinc-700/50 bg-zinc-900/40 text-zinc-400 hover:border-zinc-600'
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                      <input
                        type="number"
                        min="1"
                        max="200"
                        placeholder="Custom"
                        value={customCount}
                        onChange={e => setCustomCount(e.target.value)}
                        disabled={isGrabbing}
                        className={`w-20 rounded-lg border px-2 py-2 text-xs font-semibold text-center transition outline-none disabled:opacity-40 disabled:cursor-not-allowed ${
                          customCount
                            ? 'border-rose-500/70 bg-rose-500/15 text-rose-200'
                            : 'border-zinc-700/50 bg-zinc-900/40 text-zinc-400'
                        }`}
                      />
                    </div>
                  </div>

                  {/* Apify fallback toggle */}
                  <label className="flex items-start gap-2.5 cursor-pointer group">
                    <div className="relative mt-0.5 shrink-0">
                      <input
                        type="checkbox"
                        checked={useApifyFallback}
                        disabled={isGrabbing}
                        onChange={e => { setUseApifyFallback(e.target.checked); try { window.localStorage.setItem('kyros.igFrames.useApifyFallback', e.target.checked ? '1' : '0'); } catch {} }}
                        className="sr-only"
                      />
                      <div className={`w-8 h-4 rounded-full transition-colors duration-200 ${ useApifyFallback ? 'bg-rose-500' : 'bg-zinc-700' }`}>
                        <div className={`w-3 h-3 rounded-full bg-white shadow transition-transform duration-200 mt-0.5 ${ useApifyFallback ? 'translate-x-4' : 'translate-x-0.5' }`} />
                      </div>
                    </div>
                    <div>
                      <span className="text-[0.6875rem] text-zinc-300 font-medium">Use Apify if cookies fail</span>
                      <p className="text-[0.625rem] text-zinc-600 leading-relaxed mt-0.5">Automatically falls back to Apify scraper when gallery-dl can't download. Requires Apify key in API Keys. Uses ~$0.05–0.10 / grab.</p>
                    </div>
                  </label>

                  {/* Skip already-grabbed reels toggle */}
                  <label className="flex items-start gap-2.5 cursor-pointer group">
                    <div className="relative mt-0.5 shrink-0">
                      <input
                        type="checkbox"
                        checked={skipDuplicateReels}
                        disabled={isGrabbing}
                        onChange={e => { setSkipDuplicateReels(e.target.checked); try { window.localStorage.setItem('kyros.igFrames.skipDuplicateReels', e.target.checked ? '1' : '0'); } catch {} }}
                        className="sr-only"
                      />
                      <div className={`w-8 h-4 rounded-full transition-colors duration-200 ${ skipDuplicateReels ? 'bg-rose-500' : 'bg-zinc-700' }`}>
                        <div className={`w-3 h-3 rounded-full bg-white shadow transition-transform duration-200 mt-0.5 ${ skipDuplicateReels ? 'translate-x-4' : 'translate-x-0.5' }`} />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-[0.6875rem] text-zinc-300 font-medium">Skip already-grabbed reels</span>
                      <p className="text-[0.625rem] text-zinc-600 leading-relaxed mt-0.5">Remembers which reels this profile has already given you and excludes them from future grabs, so you get new ones instead of repeats. Off = every grab can repeat old reels.</p>
                      {skipDuplicateReels && grabHistoryCountForCurrentProfile() > 0 && (
                        <div className="mt-1 flex items-center gap-2 text-[0.625rem] text-zinc-500">
                          <span>Remembering {grabHistoryCountForCurrentProfile()} reel{grabHistoryCountForCurrentProfile() === 1 ? '' : 's'} from this profile.</span>
                          <button type="button" onClick={(e) => { e.preventDefault(); forgetGrabHistory(); }} className="shrink-0 text-rose-400 hover:text-rose-200 transition cursor-pointer underline">Forget</button>
                        </div>
                      )}
                    </div>
                  </label>

                  {/* Uses the page's existing settings */}
                  <div className="flex items-center gap-2 rounded-lg border border-zinc-700/30 bg-zinc-800/30 px-3 py-2">
                    <span className="text-zinc-500 text-sm">⚙️</span>
                    <p className="text-[0.625rem] text-zinc-400 leading-relaxed">
                      Uses your <span className="font-semibold text-zinc-200">{frameCount} frames</span> every <span className="font-semibold text-zinc-200">{formatMs(intervalMs)}</span> settings from below.
                    </p>
                  </div>

                  {/* Shuffle guarantee */}
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-900/30 bg-emerald-950/10 px-3 py-2">
                    <span className="text-emerald-400 text-sm">🔀</span>
                    <p className="text-[0.625rem] text-emerald-300/80 leading-relaxed">
                      <span className="font-semibold">Always different.</span> Every grab shuffles ALL reels on the profile with a random seed before picking — same URL will never give the same batch twice.
                    </p>
                  </div>

                  {/* Live progress */}
                  {isGrabbing && (
                    <div className="space-y-2 rounded-xl border border-rose-500/20 bg-rose-950/20 p-3">
                      {grabPhase === 'downloading' && (
                        <>
                          <div className="flex items-center justify-between text-[0.6875rem]">
                            <span className="text-rose-300 font-medium flex items-center gap-1.5">
                              <span className="inline-block w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
                              Downloading reels from profile…
                            </span>
                            {grabDownloaded > 0 && (
                              <span className="text-rose-200 font-semibold">{grabDownloaded} videos saved</span>
                            )}
                          </div>
                          <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden relative">
                            <div
                              className="absolute inset-0 h-full rounded-full bg-gradient-to-r from-transparent via-rose-500 to-transparent"
                              style={{ animation: 'grabPulse 1.5s ease-in-out infinite' }}
                            />
                          </div>
                          <p className="text-[0.625rem] text-zinc-600">gallery-dl is fetching videos… this takes 1-2 min for 10 reels</p>
                        </>
                      )}
                      {grabPhase === 'extracting' && grabProgress && (
                        <>
                          <div className="flex items-center justify-between text-[0.6875rem]">
                            <span className="text-pink-300 font-medium flex items-center gap-1.5">
                              <span className="inline-block w-2 h-2 rounded-full bg-pink-400 animate-pulse" />
                              Extracting frames…
                            </span>
                            <span className="text-zinc-400">{grabProgress.done} / {grabProgress.total}</span>
                          </div>
                          <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-rose-600 to-pink-500 transition-all duration-500"
                              style={{ width: `${grabProgress.total > 0 ? (grabProgress.done / grabProgress.total) * 100 : 0}%` }}
                            />
                          </div>
                          <p className="text-[0.625rem] text-zinc-600">Frames appear in your grid live ↑</p>
                        </>
                      )}
                      {!grabPhase && (
                        <div className="flex items-center gap-2 text-[0.6875rem] text-zinc-500">
                          <span className="inline-block w-2 h-2 rounded-full bg-zinc-500 animate-pulse" />
                          Connecting to Instagram…
                        </div>
                      )}
                    </div>
                  )}

                  {/* Grab button */}
                  <button
                    type="button"
                    onClick={grabProfile}
                    disabled={isGrabbing || !profileUrl.trim()}
                    className="w-full rounded-xl bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 text-white text-sm py-3 font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shadow-lg shadow-rose-900/30"
                  >
                    {isGrabbing
                      ? (grabPhase === 'downloading'
                        ? `📥 Downloading… ${grabDownloaded > 0 ? `${grabDownloaded} saved` : ''}`
                        : grabPhase === 'extracting' && grabProgress
                          ? `🎬 Extracting ${grabProgress.done}/${grabProgress.total}`
                          : '⏳ Starting…')
                      : `🎬 Grab ${customCount && Number(customCount) > 0 ? Number(customCount) : profileCount} Random Reels`}
                  </button>

                  {/* Grabbed Links Panel */}
                  {showLinksPanel && grabbedLinks.length > 0 && !isGrabbing && (
                    <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-rose-500/20">
                        <span className="text-[0.6875rem] font-semibold text-rose-300 flex items-center gap-1.5">
                          🔗 Reel Links <span className="bg-rose-500/30 text-rose-200 text-[0.625rem] rounded-full px-1.5 py-0.5">{grabbedLinks.length}</span>
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(grabbedLinks.join('\n'));
                              setLinksCopied(true);
                              setTimeout(() => setLinksCopied(false), 2000);
                            }}
                            className="text-[0.625rem] font-semibold px-2 py-1 rounded-md bg-rose-500/20 hover:bg-rose-500/40 text-rose-200 transition cursor-pointer"
                          >
                            {linksCopied ? '✅ Copied!' : '📋 Copy All'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowLinksPanel(false)}
                            className="text-[0.625rem] text-zinc-500 hover:text-zinc-300 transition cursor-pointer"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <div className="max-h-40 overflow-y-auto p-2 space-y-1" style={{ scrollbarWidth: 'thin' }}>
                        {grabbedLinks.map((link, i) => (
                          <div key={i} className="flex items-center gap-2 group">
                            <span className="text-[0.5625rem] text-zinc-600 w-4 shrink-0 text-right">{i + 1}</span>
                            <span className="flex-1 text-[0.625rem] font-mono text-zinc-400 truncate group-hover:text-zinc-200 transition">{link}</span>
                            <button
                              type="button"
                              onClick={() => navigator.clipboard.writeText(link)}
                              className="opacity-0 group-hover:opacity-100 text-[0.5625rem] text-rose-400 hover:text-rose-200 transition cursor-pointer shrink-0"
                            >
                              copy
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Errors */}
                  {grabErrors.length > 0 && !isGrabbing && (
                    <div className="rounded-lg border border-orange-900/30 bg-orange-950/10 p-2.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[0.625rem] font-semibold text-orange-400 uppercase tracking-wider">Skipped ({grabErrors.length})</span>
                        <button type="button" onClick={() => setGrabErrors([])} className="text-[0.625rem] text-zinc-500 hover:text-zinc-300 transition cursor-pointer">Clear</button>
                      </div>
                      <div className="space-y-1 max-h-24 overflow-y-auto">
                        {grabErrors.map((e, i) => (
                          <div key={i} className="text-[0.625rem] text-orange-300/70 truncate">{e.message || 'Unknown error'}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>



            {/* Settings */}
            <div className="rounded-2xl border border-zinc-800/70 bg-zinc-900/60 p-4 space-y-4">
              <span className="text-xs text-zinc-500 font-semibold uppercase tracking-wider">Settings</span>
              <Slider label="Frames per reel" value={frameCount} min={1} max={60} onChange={setFrameCount} />
              <Slider label="Interval between frames" value={intervalMs} min={50} max={2000} step={50} onChange={setIntervalMs} format={formatMs} />
              <div className="rounded-xl bg-zinc-800/40 border border-zinc-700/40 px-3 py-2 text-xs text-zinc-500">
                <span className="text-zinc-300 font-medium">{frameCount} frames</span> every{' '}
                <span className="text-zinc-300 font-medium">{formatMs(intervalMs)}</span> →{' '}
                covers <span className="text-zinc-300 font-medium">{formatMs((frameCount - 1) * intervalMs)}</span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Right column: extracted frames feed (wide grid) ─────────────── */}
      <div className="flex-1 min-w-0 overflow-y-auto pr-1">
        {totalFrames > 0 && (
          <div className="sticky top-0 z-10 rounded-2xl border border-zinc-800/70 bg-zinc-900/95 backdrop-blur p-3 mb-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-zinc-200">{totalFrames} Frames</span>
                <span className="text-xs text-zinc-500">{selected.size} selected</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={selectAll} className="rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-2.5 py-1 text-xs text-zinc-300 hover:text-white hover:border-zinc-500 transition cursor-pointer">All</button>
                <button onClick={selectNone} className="rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-2.5 py-1 text-xs text-zinc-300 hover:text-white hover:border-zinc-500 transition cursor-pointer">None</button>
                <button onClick={clearAllFrames} className="rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-2.5 py-1 text-xs text-zinc-400 hover:text-red-400 hover:border-red-900/30 transition cursor-pointer">Clear</button>
                <button onClick={saveSelectedToLibrary} disabled={!selected.size} className="rounded-lg border border-pink-700/60 bg-pink-950/50 px-3 py-1 text-xs font-semibold text-pink-300 hover:text-pink-100 hover:border-pink-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                  📥 Save to Library ({selected.size})
                </button>
                <button onClick={() => sendTo('photoMatch')} disabled={!selected.size} className="rounded-lg border border-rose-700/60 bg-rose-950/50 px-3 py-1 text-xs font-semibold text-rose-300 hover:text-rose-100 hover:border-rose-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                  → Photo Match ({selected.size})
                </button>
                <button onClick={() => sendTo('photoMatchSeedream')} disabled={!selected.size} className="rounded-lg border border-fuchsia-700/60 bg-fuchsia-950/50 px-3 py-1 text-xs font-semibold text-fuchsia-300 hover:text-fuchsia-100 hover:border-fuchsia-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                  → Photo Match · Seedream ({selected.size})
                </button>
                <button onClick={() => sendTo('scene')} disabled={!selected.size} className="rounded-lg border border-rose-700/60 bg-rose-950/50 px-3 py-1 text-xs font-semibold text-rose-300 hover:text-rose-100 hover:border-rose-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                  → Scene ({selected.size})
                </button>
                <button onClick={() => sendTo('sceneRecreateSeedream')} disabled={!selected.size} className="rounded-lg border border-fuchsia-700/60 bg-fuchsia-950/50 px-3 py-1 text-xs font-semibold text-fuchsia-300 hover:text-fuchsia-100 hover:border-fuchsia-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                  → Scene · SD ({selected.size})
                </button>
                <button onClick={copySelectedLinks} disabled={!selected.size} className="rounded-lg border border-sky-700/60 bg-sky-950/50 px-3 py-1 text-xs font-semibold text-sky-300 hover:text-sky-100 hover:border-sky-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                  🔗 Copy Links ({selected.size})
                </button>
                <button onClick={downloadSelected} disabled={!selected.size} className="rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-2.5 py-1 text-xs text-zinc-300 hover:text-white hover:border-zinc-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">↓</button>
              </div>
            </div>
          </div>
        )}

        {totalFrames > 0 && (
          <div className="space-y-3 animate-in">
            {/* Groups by reel */}
            {allFrames.map((group, gIdx) => {
              const offset = allFrames.slice(0, gIdx).reduce((s, g) => s + g.frames.length, 0);
              return (
                <div key={gIdx} className="space-y-2">
                  <div className="flex items-center gap-2 py-1">
                    <span className="text-xs text-zinc-400 font-mono font-medium">{group.urlLabel}</span>
                    {/* Copy link */}
                    {group.url && !group.url.startsWith('local://') && (
                      <button
                        onClick={() => copyLink(group.url)}
                        className={`transition ml-0.5 cursor-pointer ${linkCopied === group.url ? 'text-emerald-400' : 'text-zinc-600 hover:text-rose-400'}`}
                        title={linkCopied === group.url ? 'Copied!' : 'Copy source URL'}
                      >
                        {linkCopied === group.url ? <IconCheck size={12} /> : <IconCopy size={12} />}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setAllFrames(prev => prev.filter(g => g.url !== group.url));
                        setPreviewIdx(null);
                        notify('Reel frames deleted', 'success');
                      }}
                      className="text-zinc-500 hover:text-red-400 transition ml-1 cursor-pointer"
                      title="Delete this reel's frames"
                    >
                      <IconTrash size={12} />
                    </button>
                    <div className="h-px flex-1 bg-zinc-800" />
                  </div>
                  
                  <div className="grid grid-cols-3 gap-2 xl:grid-cols-4 2xl:grid-cols-5">
                    {group.frames.map((frame, fIdx) => {
                      const globalIdx = offset + fIdx;
                      // Must match the flatFrames id formula exactly (see above) — fIdx
                      // disambiguates smart-mode frames that share timestampMs=0.
                      const frameId = `${group.url}-${frame.timestampMs}-${fIdx}`;
                      const isSelected = selected.has(frameId);
                      const isPreviewing = previewIdx === globalIdx;
                      return (
                        <div
                          key={fIdx}
                          data-library-item-id={frameId}
                          onClick={() => toggleSelect(frameId)}
                          draggable="true"
                          onDragStart={(e) => handleDragStart(e, frame, frameId, globalIdx)}
                          className={`relative aspect-[9/16] overflow-hidden rounded-xl border-2 cursor-pointer transition-all duration-150 group ${
                            isPreviewing ? 'border-pink-500 ring-2 ring-pink-500/40' :
                            isSelected ? 'border-rose-500 ring-1 ring-rose-500/40' :
                            'border-zinc-700/50 hover:border-zinc-500'
                          }`}
                        >
                          {/* Click image = preview in right panel */}
                          <img
                            src={base64ToDataUrl(frame.base64, frame.mimeType)}
                            alt={`Frame ${globalIdx + 1}`}
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                          {/* Checkbox = select (top-left) */}
                          <div
                            className={`pointer-events-none absolute top-1.5 left-1.5 w-5 h-5 rounded-full border-2 flex items-center justify-center transition ${isSelected ? 'bg-rose-500 border-rose-500 text-white' : 'bg-black/40 border-zinc-400/60'}`}
                          >
                            {isSelected && <IconCheck size={10} />}
                          </div>
                          {/* Delete button on hover (top-right) */}
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              setAllFrames(prev => prev.map(g => {
                                if (g.url !== group.url) return g;
                                return {
                                  ...g,
                                  frames: g.frames.filter((_, idx) => idx !== fIdx)
                                };
                              }).filter(g => g.frames.length > 0));
                              if (previewIdx === globalIdx) setPreviewIdx(null);
                              notify('Frame removed', 'success');
                            }}
                            className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-black/75 border border-zinc-700/50 text-zinc-400 hover:text-red-400 hover:bg-black/90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition cursor-pointer"
                            title="Delete frame"
                          >
                            ×
                          </button>
                          {/* Timestamp */}
                          <div className="absolute bottom-1 left-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[0.5625rem] font-mono text-zinc-300 pointer-events-none">{formatMs(frame.timestampMs)}</div>
                          {/* Hover overlay */}
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition pointer-events-none" />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {totalFrames === 0 && (
          <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
            <div className="w-20 h-20 rounded-3xl bg-zinc-900/80 border border-zinc-800/60 flex items-center justify-center mb-5">
              <IconInstagram size={36} className="text-zinc-700" />
            </div>
            <p className="text-sm text-zinc-600 font-medium">Extracted frames will appear here</p>
            <p className="text-xs text-zinc-700 mt-1">Paste URLs or grab a profile on the left · click any frame to open it fullscreen</p>
          </div>
        )}
      </div>
    </div>


      {isDragSelecting && dragBox && (
        <div
          className="fixed border border-rose-500 bg-rose-500/10 rounded pointer-events-none z-[9999]"
          style={{
            left: Math.min(dragBox.startX, dragBox.currentX),
            top: Math.min(dragBox.startY, dragBox.currentY),
            width: Math.abs(dragBox.startX - dragBox.currentX),
            height: Math.abs(dragBox.startY - dragBox.currentY),
          }}
        />
      )}
    </div>
  );
}
