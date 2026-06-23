import { useState, useRef, useCallback, useEffect } from 'react';
import { useApp } from '../context/AppContext';

const API = '/api/instagram-frames';
const IG_STATE_KEY = 'kyros.igFrames.state';
const PHOTO_MATCH_SOURCE_KEY = 'kyros.photoMatch.sources';
const SCENE_SOURCE_KEY = 'kyros.sceneRecreate.sources';

// ── Helpers ────────────────────────────────────────────────────────────────
function base64ToDataUrl(base64, mimeType) {
  return `data:${mimeType};base64,${base64}`;
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(IG_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveState(state) {
  try {
    localStorage.setItem(IG_STATE_KEY, JSON.stringify(state));
  } catch { /* ignore quota errors */ }
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
      <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
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
        <div className="flex gap-2"><span className="shrink-0 w-5 h-5 rounded-full bg-amber-600 text-black flex items-center justify-center text-[10px] font-bold">1</span><span>Install <a href="https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc" target="_blank" rel="noreferrer" className="text-blue-400 underline">"Get cookies.txt LOCALLY"</a> in Chrome</span></div>
        <div className="flex gap-2"><span className="shrink-0 w-5 h-5 rounded-full bg-amber-600 text-black flex items-center justify-center text-[10px] font-bold">2</span><span>Go to instagram.com, tiktok.com, or x.com while logged in</span></div>
        <div className="flex gap-2"><span className="shrink-0 w-5 h-5 rounded-full bg-amber-600 text-black flex items-center justify-center text-[10px] font-bold">3</span><span>Click extension → Export → copy all text</span></div>
        <div className="flex gap-2"><span className="shrink-0 w-5 h-5 rounded-full bg-amber-600 text-black flex items-center justify-center text-[10px] font-bold">4</span><span>Paste below and Save (platform is auto-detected)</span></div>
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
          <button onClick={() => handleRemove('instagram')} className="text-[11px] text-zinc-600 hover:text-red-400 transition cursor-pointer">Remove</button>
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
          <button onClick={() => handleRemove('tiktok')} className="text-[11px] text-zinc-600 hover:text-red-400 transition cursor-pointer">Remove</button>
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
          <button onClick={() => handleRemove('x')} className="text-[11px] text-zinc-600 hover:text-red-400 transition cursor-pointer">Remove</button>
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

  // ── Restore persisted state ──────────────────────────────────────────────
  const saved = loadSavedState();

  // Multiple URL inputs
  const [urlList, setUrlList] = useState(() => saved?.urlList ?? ['']);
  const [frameCount, setFrameCount] = useState(() => saved?.frameCount ?? 10);
  const [intervalMs, setIntervalMs] = useState(() => saved?.intervalMs ?? 200);

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [allFrames, setAllFrames] = useState(() => saved?.allFrames ?? []); // { urlLabel, frames[] }
  const [selected, setSelected] = useState(() => new Set(saved?.selected ?? [])); // Set of frame unique IDs

  const [previewIdx, setPreviewIdx] = useState(null); // index in flatFrames
  const [cookieInfo, setCookieInfo] = useState(null);
  const [dragBox, setDragBox] = useState(null);
  const [isDragSelecting, setIsDragSelecting] = useState(false);
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

  // Flat list of all frames across all URLs, annotated with a unique ID
  const flatFrames = allFrames.flatMap(g => 
    g.frames.map((f, fIdx) => ({
      ...f,
      id: `${g.url}-${f.timestampMs}`,
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

  // ── Persist state on change ──────────────────────────────────────────────
  useEffect(() => {
    if (loading) return;
    saveState({
      urlList,
      frameCount,
      intervalMs,
      allFrames,
      selected: Array.from(selected),
    });
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
          return [...filtered, newGroup];
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
    try { localStorage.removeItem(IG_STATE_KEY); } catch {}
    notify('Cleared all extracted frames', 'success');
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
        };
      });
  };

  // ── Send selected frames to another page ─────────────────────────────────
  const sendTo = (page) => {
    if (!selected.size) { notify('Select at least one frame', 'error'); return; }
    const payload = buildStoragePayload(selected);
    const storageKey = page === 'photoMatch' ? PHOTO_MATCH_SOURCE_KEY : SCENE_SOURCE_KEY;
    const eventName = page === 'photoMatch' ? 'kyros:use-as-photo-match-source' : 'kyros:use-as-scene-source';
    try { localStorage.setItem(storageKey, JSON.stringify(payload)); } catch { /* ignore */ }
    navigateTo(page);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent(eventName, { detail: { items: payload.map(p => ({ dataUrl: p.dataUrl, name: p.name })) } }));
    }, 300);
    notify(`${payload.length} frame${payload.length > 1 ? 's' : ''} sent to ${page === 'photoMatch' ? 'Photo Match' : 'Scene Recreate'} ⚡`, 'success');
  };

  const sendSingleTo = (globalIdx, page) => {
    const f = flatFrames[globalIdx];
    if (!f) return;
    const dataUrl = base64ToDataUrl(f.base64, f.mimeType);
    const payload = [{
      id: `ig-frame-${f.id}-${Date.now()}`,
      name: `ig_frame_${globalIdx + 1}.jpg`,
      type: f.mimeType,
      size: 0,
      dataUrl,
    }];
    const storageKey = page === 'photoMatch' ? PHOTO_MATCH_SOURCE_KEY : SCENE_SOURCE_KEY;
    const eventName = page === 'photoMatch' ? 'kyros:use-as-photo-match-source' : 'kyros:use-as-scene-source';
    try { localStorage.setItem(storageKey, JSON.stringify(payload)); } catch { /* ignore */ }
    navigateTo(page);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent(eventName, { detail: { items: [{ dataUrl, name: payload[0].name }] } }));
    }, 300);
    notify(`1 frame sent to ${page === 'photoMatch' ? 'Photo Match' : 'Scene Recreate'} ⚡`, 'success');
  };

  const downloadSelected = () => {
    if (!selected.size) { notify('Select at least one frame', 'error'); return; }
    flatFrames.forEach((f, i) => {
      if (selected.has(f.id)) {
        const a = document.createElement('a');
        a.href = base64ToDataUrl(f.base64, f.mimeType);
        a.download = `ig_frame_${String(i + 1).padStart(3, '0')}_${f.timestampMs}ms.jpg`;
        a.click();
      }
    });
  };

  const saveSelectedToLibrary = () => {
    if (!selected.size) { notify('Select at least one frame', 'error'); return; }
    try {
      const existingRaw = localStorage.getItem('kyros.frameLibrary.items');
      const existing = existingRaw ? JSON.parse(existingRaw) : [];
      
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

      const updated = [...newItems, ...existing].slice(0, 500);
      localStorage.setItem('kyros.frameLibrary.items', JSON.stringify(updated));
      notify(`Saved ${newItems.length} frame${newItems.length > 1 ? 's' : ''} to Frame Library 📥`, 'success');
    } catch (err) {
      notify('Failed to save to Frame Library (storage full?)', 'error');
    }
  };

  const saveSingleToLibrary = (globalIdx) => {
    const f = flatFrames[globalIdx];
    if (!f) return;
    try {
      const existingRaw = localStorage.getItem('kyros.frameLibrary.items');
      const existing = existingRaw ? JSON.parse(existingRaw) : [];
      
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

      const updated = [newItem, ...existing].slice(0, 500);
      localStorage.setItem('kyros.frameLibrary.items', JSON.stringify(updated));
      notify('Saved frame to Frame Library 📥', 'success');
    } catch (err) {
      notify('Failed to save to Frame Library (storage full?)', 'error');
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

  return (
    <div className="flex gap-6 animate-in h-full min-h-0">
      {/* ── Left column: controls + grid ────────────────────────────────── */}
      <div className="flex flex-col gap-5 w-[430px] xl:w-[460px] 2xl:w-[500px] shrink-0 overflow-y-auto">
        {/* Cookie status */}
        {cookieInfo === null ? (
          <div className="rounded-2xl border border-zinc-800/70 bg-zinc-900/60 p-4 text-xs text-zinc-500 animate-pulse">Checking session status…</div>
        ) : hasCookies ? (
          <CookiesStatusBar cookieInfo={cookieInfo} onRemove={reloadCookieInfo} />
        ) : (
          <CookiesSetupPanel onSaved={reloadCookieInfo} />
        )}

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

        {/* Frames grid */}
        {totalFrames > 0 && (
          <div className="space-y-3 animate-in">
            {/* Toolbar */}
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
                <button onClick={() => sendTo('photoMatch')} disabled={!selected.size} className="rounded-lg border border-blue-700/60 bg-blue-950/50 px-3 py-1 text-xs font-semibold text-blue-300 hover:text-blue-100 hover:border-blue-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                  → Photo Match ({selected.size})
                </button>
                <button onClick={() => sendTo('scene')} disabled={!selected.size} className="rounded-lg border border-purple-700/60 bg-purple-950/50 px-3 py-1 text-xs font-semibold text-purple-300 hover:text-purple-100 hover:border-purple-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                  → Scene ({selected.size})
                </button>
                <button onClick={downloadSelected} disabled={!selected.size} className="rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-2.5 py-1 text-xs text-zinc-300 hover:text-white hover:border-zinc-500 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">↓</button>
              </div>
            </div>

            {/* Groups by reel */}
            {allFrames.map((group, gIdx) => {
              const offset = allFrames.slice(0, gIdx).reduce((s, g) => s + g.frames.length, 0);
              return (
                <div key={gIdx} className="space-y-2">
                  <div className="flex items-center gap-2 py-1">
                    <span className="text-xs text-zinc-400 font-mono font-medium">{group.urlLabel}</span>
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
                  
                  <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-5">
                    {group.frames.map((frame, fIdx) => {
                      const globalIdx = offset + fIdx;
                      const frameId = `${group.url}-${frame.timestampMs}`;
                      const isSelected = selected.has(frameId);
                      const isPreviewing = previewIdx === globalIdx;
                      return (
                        <div
                          key={fIdx}
                          data-library-item-id={frameId}
                          onClick={() => setPreviewIdx(globalIdx === previewIdx ? null : globalIdx)}
                          draggable="true"
                          onDragStart={(e) => handleDragStart(e, frame, frameId, globalIdx)}
                          className={`relative aspect-[9/16] overflow-hidden rounded-xl border-2 cursor-pointer transition-all duration-150 group ${
                            isPreviewing ? 'border-pink-500 ring-2 ring-pink-500/40' :
                            isSelected ? 'border-blue-500 ring-1 ring-blue-500/40' :
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
                            onClick={e => { e.stopPropagation(); toggleSelect(frameId); }}
                            className={`absolute top-1.5 left-1.5 w-5 h-5 rounded-full border-2 flex items-center justify-center transition cursor-pointer ${isSelected ? 'bg-blue-500 border-blue-500 text-white' : 'bg-black/40 border-zinc-400/60 hover:border-white'}`}
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
                          <div className="absolute bottom-1 left-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[9px] font-mono text-zinc-300 pointer-events-none">{formatMs(frame.timestampMs)}</div>
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

        {/* Empty state */}
        {!loading && totalFrames === 0 && hasCookies && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-14 h-14 rounded-2xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center mb-4">
              <IconInstagram size={24} className="text-pink-400/60" />
            </div>
            <p className="text-sm text-zinc-500 font-medium">Paste one or more Instagram, TikTok, or X URLs above</p>
            <p className="text-xs text-zinc-600 mt-1">Click a frame to preview · Checkbox to select · Send selected to Photo Match</p>
          </div>
        )}
      </div>

      {/* ── Right column: frame detail preview ──────────────────────────── */}
      <div className="flex-1 min-w-0">
        {previewFrame ? (
          <div className="sticky top-6 flex flex-col gap-4 max-h-[calc(100vh-140px)]">
            {/* Top bar */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400 font-mono">
                Frame {previewIdx + 1} / {flatFrames.length} · {formatMs(previewFrame.timestampMs)}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggleSelect(previewFrame.id)}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${previewIsSelected ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
                >
                  {previewIsSelected ? <><IconCheck size={11} /> Selected</> : 'Select'}
                </button>
                <button
                  onClick={() => setPreviewIdx(null)}
                  className="rounded-lg bg-zinc-800/80 p-1.5 text-zinc-400 hover:text-white transition cursor-pointer"
                >
                  <IconClose size={15} />
                </button>
              </div>
            </div>

            {/* Image + nav arrows */}
            <div className="flex items-center gap-3 flex-1 min-h-0">
              <button
                onClick={() => previewIdx > 0 && setPreviewIdx(previewIdx - 1)}
                disabled={previewIdx === 0}
                className="rounded-xl bg-zinc-800/80 p-2 text-zinc-300 hover:text-white disabled:opacity-20 transition cursor-pointer shrink-0"
              >
                <IconArrowLeft size={20} />
              </button>

              <div className="flex-1 flex justify-center min-h-0">
                <img
                  src={base64ToDataUrl(previewFrame.base64, previewFrame.mimeType)}
                  alt={`Frame ${previewIdx + 1}`}
                  className="max-h-[calc(100vh-280px)] max-w-full rounded-2xl object-contain shadow-2xl"
                  style={{ border: previewIsSelected ? '2px solid #3b82f6' : '2px solid transparent' }}
                />
              </div>

              <button
                onClick={() => previewIdx < flatFrames.length - 1 && setPreviewIdx(previewIdx + 1)}
                disabled={previewIdx === flatFrames.length - 1}
                className="rounded-xl bg-zinc-800/80 p-2 text-zinc-300 hover:text-white disabled:opacity-20 transition cursor-pointer shrink-0"
              >
                <IconArrowRight size={20} />
              </button>
            </div>

            {/* Action buttons */}
            <div className="flex items-center justify-center gap-3 flex-wrap">
              <button
                onClick={() => { saveSingleToLibrary(previewIdx); }}
                className="rounded-lg border border-pink-700/60 bg-pink-950/60 px-4 py-2 text-xs font-semibold text-pink-300 hover:text-pink-100 hover:border-pink-500 transition cursor-pointer"
              >
                📥 Save to Library
              </button>
              <button
                onClick={() => { sendSingleTo(previewIdx, 'photoMatch'); setPreviewIdx(null); }}
                className="rounded-lg border border-blue-700/60 bg-blue-950/60 px-4 py-2 text-xs font-semibold text-blue-300 hover:text-blue-100 hover:border-blue-500 transition cursor-pointer"
              >
                → Photo Match
              </button>
              <button
                onClick={() => { sendSingleTo(previewIdx, 'scene'); setPreviewIdx(null); }}
                className="rounded-lg border border-purple-700/60 bg-purple-950/60 px-4 py-2 text-xs font-semibold text-purple-300 hover:text-purple-100 hover:border-purple-500 transition cursor-pointer"
              >
                → Scene Recreate
              </button>
              <button
                onClick={() => {
                  const f = flatFrames[previewIdx];
                  const a = document.createElement('a');
                  a.href = base64ToDataUrl(f.base64, f.mimeType);
                  a.download = `ig_frame_${String(previewIdx + 1).padStart(3, '0')}_${f.timestampMs}ms.jpg`;
                  a.click();
                }}
                className="rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-4 py-2 text-xs text-zinc-300 hover:text-white transition cursor-pointer"
              >
                ↓ Download
              </button>
              <button
                onClick={() => {
                  const currentFrame = flatFrames[previewIdx];
                  if (!currentFrame) return;
                  setAllFrames(prev => prev.map(g => {
                    if (g.url !== currentFrame.url) return g;
                    return {
                      ...g,
                      frames: g.frames.filter(f => f.timestampMs !== currentFrame.timestampMs)
                    };
                  }).filter(g => g.frames.length > 0));
                  setSelected(prev => {
                    const next = new Set(prev);
                    next.delete(currentFrame.id);
                    return next;
                  });
                  setPreviewIdx(null);
                  notify('Frame removed', 'success');
                }}
                className="rounded-lg border border-red-900/40 bg-red-950/40 px-4 py-2 text-xs text-red-400 hover:text-red-300 hover:border-red-500/50 transition cursor-pointer"
              >
                Delete Frame
              </button>
              <span className="text-xs text-zinc-600">← → arrows · Space select · Esc close</span>
            </div>
          </div>
        ) : (
          /* Empty preview state */
          <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
            <div className="w-20 h-20 rounded-3xl bg-zinc-900/80 border border-zinc-800/60 flex items-center justify-center mb-5">
              <IconInstagram size={36} className="text-zinc-700" />
            </div>
            <p className="text-sm text-zinc-600 font-medium">Click any frame to preview it here</p>
            <p className="text-xs text-zinc-700 mt-1">Then send it directly to Photo Match or Scene Recreate</p>
          </div>
        )}
      </div>
      {isDragSelecting && dragBox && (
        <div
          className="fixed border border-blue-500 bg-blue-500/10 rounded pointer-events-none z-[9999]"
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
