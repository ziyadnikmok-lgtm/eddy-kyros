import { useState, useRef, useEffect, useCallback } from 'react';
import { video as videoApi, videoEdit as videoEditApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Btn, Spinner } from './UI';
import { cn } from '../lib/utils';

// In-app video editor. Drag emoji / stickers / text anywhere over a gallery clip, trim it, and
// tune filters / speed / audio, then export a burned mp4 back to the gallery.
//
// Overlays are stored as { cx, cy, size, rotation } — a CENTER (fractions of the frame) plus a
// uniform size (fraction of frame HEIGHT) and a rotation. Uniform scale is the natural gesture for
// a sticker and sidesteps separate width/height handles. On export each overlay is drawn to a
// transparent PNG (rotation baked in) and the server just scales + places it — no fonts or emoji
// rendering server-side.

// Apple (iPhone) emoji artwork — Windows/Chromium would otherwise render its own (Segoe) glyphs,
// which read as "Samsung/Windows". We pull the Apple PNGs from jsdelivr's emoji-datasource-apple.
// jsdelivr sends CORS headers, so with crossOrigin='anonymous' these can be drawn to a canvas for
// the export without tainting it. `u` is the emoji's unified codepoint = the image filename.
// If the image can't load (offline), the UI falls back to the system glyph in `c`.
const EMOJIS = [
  { c: '😍', u: '1f60d' }, { c: '🔥', u: '1f525' }, { c: '💦', u: '1f4a6' }, { c: '🥵', u: '1f975' },
  { c: '😈', u: '1f608' }, { c: '💋', u: '1f48b' }, { c: '🍑', u: '1f351' }, { c: '🍒', u: '1f352' },
  { c: '👅', u: '1f445' }, { c: '💕', u: '1f495' }, { c: '⭐', u: '2b50' }, { c: '✨', u: '2728' },
  { c: '💯', u: '1f4af' }, { c: '👀', u: '1f440' }, { c: '🤤', u: '1f924' }, { c: '😏', u: '1f60f' },
  { c: '🥰', u: '1f970' }, { c: '😘', u: '1f618' }, { c: '💖', u: '1f496' }, { c: '🌶️', u: '1f336-fe0f' },
  { c: '💥', u: '1f4a5' }, { c: '🎀', u: '1f380' }, { c: '👑', u: '1f451' }, { c: '🫦', u: '1fae6' },
];
const appleEmojiUrl = (u) => `https://cdn.jsdelivr.net/npm/emoji-datasource-apple/img/apple/64/${u}.png`;

// Load an image for the canvas export; resolves null on failure so the caller can fall back.
function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

const FILTERS = [
  { key: 'brightness', label: 'Brightness', min: -0.4, max: 0.4, step: 0.02, def: 0, group: 'Color' },
  { key: 'contrast', label: 'Contrast', min: 0.5, max: 1.8, step: 0.02, def: 1, group: 'Color' },
  { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.02, def: 1, group: 'Color' },
  { key: 'warmth', label: 'Warmth', min: -0.3, max: 0.3, step: 0.02, def: 0, group: 'Color' },
  { key: 'blur', label: 'Blur', min: 0, max: 4, step: 0.1, def: 0, group: 'Detail' },
  { key: 'sharpness', label: 'Sharpen', min: 0, max: 2, step: 0.05, def: 0, group: 'Detail' },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.02, def: 0, group: 'Detail' },
  { key: 'zoom', label: 'Zoom', min: 1, max: 2.5, step: 0.02, def: 1, group: 'Frame' },
  { key: 'panX', label: 'Pan X', min: -1, max: 1, step: 0.02, def: 0, group: 'Frame' },
  { key: 'panY', label: 'Pan Y', min: -1, max: 1, step: 0.02, def: 0, group: 'Frame' },
  { key: 'speed', label: 'Speed', min: 0.5, max: 2, step: 0.05, def: 1, group: 'Playback' },
  { key: 'originalAudioVolume', label: 'Audio', min: 0, max: 2, step: 0.05, def: 1, group: 'Playback' },
];
const FILTER_GROUPS = ['Color', 'Detail', 'Frame', 'Playback'];
const FILTER_DEFAULTS = Object.fromEntries(FILTERS.map((f) => [f.key, f.def]));

let _uid = 0;
const nextId = () => `ov-${Date.now()}-${_uid++}`;

export default function VideoEditor({ video: v, onClose, onSaved }) {
  const { notify } = useApp();
  const src = videoApi.fileUrl(v.filename);

  const videoRef = useRef(null);
  const stageRef = useRef(null);          // the box overlays are positioned within (== the video)
  const [duration, setDuration] = useState(0);
  const [now, setNow] = useState(0);   // current playhead (drives the timeline + overlay show/hide)
  const [dims, setDims] = useState({ w: 9, h: 16 });   // video pixel aspect; seeds the stage size

  const [overlays, setOverlays] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [trim, setTrim] = useState({ start: 0, end: 0 });
  const [params, setParams] = useState(FILTER_DEFAULTS);
  const [exporting, setExporting] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [failedEmoji, setFailedEmoji] = useState(() => new Set());   // codes whose Apple img 404'd
  const markEmojiFailed = (code) => setFailedEmoji((prev) => (prev.has(code) ? prev : new Set(prev).add(code)));

  const drag = useRef(null);   // { id, mode:'move'|'resize'|'rotate', ... }

  const selected = overlays.find((o) => o.id === selectedId) || null;
  const patch = (id, p) => setOverlays((prev) => prev.map((o) => (o.id === id ? { ...o, ...p } : o)));

  // ── add / remove overlays ────────────────────────────────────────────────
  const addEmoji = (emoji) => {
    const id = nextId();
    setOverlays((prev) => [...prev, { id, type: 'emoji', content: emoji.c, code: emoji.u, cx: 0.5, cy: 0.5, size: 0.16, rotation: 0, start: 0, end: duration || 0 }]);
    setSelectedId(id);
  };
  const addText = () => {
    const id = nextId();
    setOverlays((prev) => [...prev, { id, type: 'text', content: 'Your text', color: '#ffffff', cx: 0.5, cy: 0.5, size: 0.1, rotation: 0, start: 0, end: duration || 0 }]);
    setSelectedId(id);
  };
  const removeOverlay = (id) => { setOverlays((prev) => prev.filter((o) => o.id !== id)); if (selectedId === id) setSelectedId(null); };

  // ── pointer interaction (move / resize / rotate) ─────────────────────────
  const stageRect = () => stageRef.current.getBoundingClientRect();

  const onPointerDown = (e, id, mode) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedId(id);
    const o = overlays.find((x) => x.id === id);
    const r = stageRect();
    const centerPx = { x: o.cx * r.width + r.left, y: o.cy * r.height + r.top };
    drag.current = {
      id, mode, r,
      startX: e.clientX, startY: e.clientY,
      cx0: o.cx, cy0: o.cy, size0: o.size, rot0: o.rotation,
      centerPx,
      // Distance from centre to where the resize grab STARTED — resize scales relative to this so
      // grabbing the handle doesn't snap the element to a new size on the first move.
      dist0: Math.max(1, Math.hypot(e.clientX - centerPx.x, e.clientY - centerPx.y)),
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const onPointerMove = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === 'move') {
      const dx = (e.clientX - d.startX) / d.r.width;
      const dy = (e.clientY - d.startY) / d.r.height;
      patch(d.id, { cx: Math.min(1, Math.max(0, d.cx0 + dx)), cy: Math.min(1, Math.max(0, d.cy0 + dy)) });
    } else if (d.mode === 'resize') {
      // Scale relative to the grab: size grows/shrinks with the pointer's distance from centre vs
      // where it started, so there is no jump on the first move.
      const dist = Math.hypot(e.clientX - d.centerPx.x, e.clientY - d.centerPx.y);
      patch(d.id, { size: Math.min(1.5, Math.max(0.03, d.size0 * (dist / d.dist0))) });
    } else if (d.mode === 'rotate') {
      const ang = Math.atan2(e.clientY - d.centerPx.y, e.clientX - d.centerPx.x) * 180 / Math.PI;
      patch(d.id, { rotation: ang + 90 });          // +90: handle sits above the element
    }
  }, []);

  const onPointerUp = useCallback(() => {
    drag.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove]);

  useEffect(() => () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove, onPointerUp]);

  // Slowing/speeding is applied to the PREVIEW playback so you actually see (and hear) it, not just
  // on export. Re-applied whenever speed changes and after the clip loads (a new src resets rate).
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = params.speed;
  }, [params.speed, duration]);

  // ── timeline (CapCut-style) ───────────────────────────────────────────────
  // Everything below is on the FULL-clip time axis (0..duration): the video track, the trim window,
  // each overlay's clip, and the playhead. Export converts overlay times to trim-relative seconds.
  const trackInnerRef = useRef(null);    // the box whose width maps 1:1 to [0, duration]
  const tlDrag = useRef(null);
  const [thumbs, setThumbs] = useState([]);

  const timeFromClientX = (clientX) => {
    const r = trackInnerRef.current?.getBoundingClientRect();
    if (!r || !duration) return 0;
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  const xPct = (t) => (duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0);
  const fmtT = (s) => { const v = Math.max(0, s || 0); return `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`; };

  const tlMove = useCallback((e) => {
    const d = tlDrag.current; if (!d) return;
    const t = timeFromClientX(e.clientX);
    if (d.mode === 'seek') {
      if (videoRef.current) videoRef.current.currentTime = t;
      setNow(t);
    } else if (d.mode === 'trim-start') {
      const s = Math.min(t, d.otherEnd - 0.1);
      setTrim((tr) => ({ ...tr, start: s }));
      if (videoRef.current) videoRef.current.currentTime = s;
      setNow(s);
    } else if (d.mode === 'trim-end') {
      const en = Math.max(t, d.otherStart + 0.1);
      setTrim((tr) => ({ ...tr, end: en }));
      if (videoRef.current) videoRef.current.currentTime = en;
      setNow(en);
    } else if (d.mode === 'clip-move') {
      const len = d.end0 - d.start0;
      const ns = Math.min(Math.max(0, d.start0 + (t - d.t0)), duration - len);
      patch(d.id, { start: ns, end: ns + len });
    } else if (d.mode === 'clip-start') {
      patch(d.id, { start: Math.min(Math.max(0, t), d.end0 - 0.1) });
    } else if (d.mode === 'clip-end') {
      patch(d.id, { end: Math.max(Math.min(duration, t), d.start0 + 0.1) });
    }
  }, [duration]);

  const tlUp = useCallback(() => {
    tlDrag.current = null;
    window.removeEventListener('pointermove', tlMove);
    window.removeEventListener('pointerup', tlUp);
  }, [tlMove]);

  const tlDown = (e, mode, extra = {}) => {
    e.stopPropagation();
    if (mode === 'clip-move' || mode === 'clip-start' || mode === 'clip-end') setSelectedId(extra.id);
    tlDrag.current = { mode, ...extra };
    if (mode === 'seek') { const t = timeFromClientX(e.clientX); if (videoRef.current) videoRef.current.currentTime = t; setNow(t); }
    window.addEventListener('pointermove', tlMove);
    window.addEventListener('pointerup', tlUp);
  };

  useEffect(() => () => {
    window.removeEventListener('pointermove', tlMove);
    window.removeEventListener('pointerup', tlUp);
  }, [tlMove, tlUp]);

  // Generate thumbnails from a SEPARATE hidden video so scrubbing them doesn't disturb the preview.
  useEffect(() => {
    if (!duration || !src) return;
    let cancelled = false;
    const COUNT = 12;
    const vid = document.createElement('video');
    vid.src = src; vid.muted = true; vid.preload = 'auto';
    const canvas = document.createElement('canvas');
    const seekTo = (t) => new Promise((res) => {
      const on = () => { vid.removeEventListener('seeked', on); res(); };
      vid.addEventListener('seeked', on);
      vid.currentTime = t;
    });
    const run = async () => {
      const w = 96; const h = Math.max(2, Math.round(w * (dims.h / dims.w)));
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      const out = [];
      for (let i = 0; i < COUNT; i += 1) {
        if (cancelled) return;
        await seekTo(((i + 0.5) / COUNT) * duration);
        if (cancelled) return;
        try { ctx.drawImage(vid, 0, 0, w, h); out.push(canvas.toDataURL('image/jpeg', 0.55)); }
        catch { /* a frame that won't draw just leaves a gap */ }
      }
      if (!cancelled) setThumbs(out);
    };
    const onReady = () => { run(); };
    vid.addEventListener('loadeddata', onReady, { once: true });
    return () => { cancelled = true; vid.removeAttribute('src'); vid.load?.(); };
  }, [duration, src, dims.w, dims.h]);

  // Keyboard shortcuts (ignored while typing in a field). Space play/pause · ←/→ seek 1s (Shift 5s)
  // · I/O set trim in/out to the playhead · Delete removes the selected sticker · Esc deselects.
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
      const el = videoRef.current;
      if (e.key === ' ') {
        e.preventDefault();
        if (el) { if (el.paused) el.play().catch(() => {}); else el.pause(); }
      } else if (e.key === 'ArrowLeft' && el) {
        e.preventDefault(); el.currentTime = Math.max(0, el.currentTime - (e.shiftKey ? 5 : 1)); setNow(el.currentTime);
      } else if (e.key === 'ArrowRight' && el) {
        e.preventDefault(); el.currentTime = Math.min(duration, el.currentTime + (e.shiftKey ? 5 : 1)); setNow(el.currentTime);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault(); removeOverlay(selectedId);
      } else if ((e.key === 'i' || e.key === 'I') && el) {
        setTrim((t) => ({ ...t, start: Math.min(el.currentTime, t.end - 0.1) }));
      } else if ((e.key === 'o' || e.key === 'O') && el) {
        setTrim((t) => ({ ...t, end: Math.max(el.currentTime, t.start + 0.1) }));
      } else if (e.key === 'Escape' && selectedId) {
        e.preventDefault(); setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, duration]);

  // ── video metadata ────────────────────────────────────────────────────────
  const onLoadedMeta = () => {
    const el = videoRef.current;
    const dur = el?.duration || 0;
    setVideoError(false);   // metadata loaded ⇒ the clip is fine; clear any earlier transient error
    setDuration(dur);
    if (el?.videoWidth && el?.videoHeight) setDims({ w: el.videoWidth, h: el.videoHeight });
    setTrim({ start: 0, end: dur });
    // Give any already-added overlays a real end time.
    setOverlays((prev) => prev.map((o) => (o.end === 0 ? { ...o, end: dur } : o)));
    // Nudge to the first frame so a paused clip actually PAINTS a frame in the preview (Chromium
    // shows nothing for a preload=metadata video until it decodes one) — otherwise a dark clip
    // reads as an empty stage.
    if (el && el.currentTime === 0) { try { el.currentTime = 0.05; } catch { /* ignore */ } }
  };

  // Keep PLAYBACK inside the trim window (so it previews what will export), but leave scrubbing free
  // — when paused, the playhead can go anywhere on the timeline to position overlays across the clip.
  const onTimeUpdate = () => {
    const el = videoRef.current;
    if (!el) return;
    if (!el.paused && (el.currentTime < trim.start || el.currentTime > trim.end)) el.currentTime = trim.start;
    setNow(el.currentTime);
  };


  // ── export ──────────────────────────────────────────────────────────────
  // Draw ONE overlay onto a FULL-FRAME transparent PNG (exact video resolution) at its precise pixel
  // position and rotation — the same layout the preview shows. The server composites this frame onto
  // the video at 0:0, so there is NO coordinate translation and the sticker lands pixel-for-pixel
  // where you placed it. (This is how OpenCut / CapCut-style editors avoid the drift you saw.)
  const renderOverlay = async (o, outW, outH) => {
    const appleImg = o.type === 'emoji' && o.code ? await loadImage(appleEmojiUrl(o.code)) : null;

    const canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const cx = o.cx * outW;
    const cy = o.cy * outH;
    const sidePx = o.size * outH;   // height in output px (emoji square; text uses this as its size)

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((o.rotation || 0) * Math.PI / 180);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (o.type === 'emoji') {
      if (appleImg) {
        ctx.drawImage(appleImg, -sidePx / 2, -sidePx / 2, sidePx, sidePx);   // the iPhone artwork
      } else {
        ctx.font = `${sidePx * 0.92}px "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
        ctx.fillText(o.content, 0, 0);                                        // offline fallback
      }
    } else {
      const fs = sidePx * 0.82;
      ctx.font = `bold ${fs}px "Segoe UI", Arial, sans-serif`;
      ctx.lineJoin = 'round';
      ctx.lineWidth = fs * 0.12;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';        // outline for legibility on any background
      ctx.strokeText(o.content, 0, 0);
      ctx.fillStyle = o.color || '#ffffff';
      ctx.fillText(o.content, 0, 0);
    }
    ctx.restore();

    // Position is baked into the frame; timing is computed by the caller (it knows the trim window).
    return new Promise((resolve) => { canvas.toBlob((blob) => resolve(blob), 'image/png'); });
  };

  const doExport = async () => {
    setExporting(true);
    try {
      const outW = videoRef.current?.videoWidth || 1080;
      const outH = videoRef.current?.videoHeight || 1920;
      const fd = new FormData();
      fd.append('sourceFilename', v.filename);
      fd.append('trimStart', String(trim.start));
      fd.append('trimEnd', String(trim.end));
      for (const f of FILTERS) fd.append(f.key, String(params[f.key]));

      // Overlay times are on the full-clip axis; convert to trim-relative seconds for the server and
      // drop any overlay that falls entirely outside the kept window.
      const trimmed = trim.end - trim.start;
      const items = [];
      for (const o of overlays) {
        const s = o.start ?? 0; const e = o.end ?? duration;
        if (e <= trim.start || s >= trim.end) continue;
        const blob = await renderOverlay(o, outW, outH);
        const startT = Math.max(0, s - trim.start);
        const endT = Math.min(trimmed, e - trim.start);
        items.push({ blob, meta: { start: startT, end: Math.max(startT + 0.1, endT) } });
      }
      fd.append('overlays', JSON.stringify(items.map((x) => x.meta)));
      items.forEach((x, i) => { if (x.blob) fd.append(`overlay_${i}`, x.blob, `overlay_${i}.png`); });

      const res = await videoEditApi.export(fd);
      notify(`Saved edited clip to the gallery ✨ (${res.overlayCount} overlay${res.overlayCount === 1 ? '' : 's'})`, 'success');
      onSaved?.();
      onClose();
    } catch (err) {
      notify(err?.message || 'Export failed', 'error');
    } finally {
      setExporting(false);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────
  const stageH = () => stageRef.current?.getBoundingClientRect().height || 0;
  const TEXT_COLORS = ['#ffffff', '#000000', '#ff2d78', '#ffd400', '#38e08a', '#3aa0ff', '#c77dff'];

  // Live preview of the colour/tone adjustments via CSS filters, so the sliders visibly do
  // something instead of only showing on export. Brightness is remapped from the ffmpeg additive
  // range (−0.4..0.4) to CSS's multiplicative one (0.6..1.4); warmth is approximated with sepia
  // (warm) / hue-rotate (cool). These are previews — the export re-does them precisely in ffmpeg.
  const previewFilter = [
    `brightness(${(1 + params.brightness).toFixed(3)})`,
    `contrast(${params.contrast.toFixed(3)})`,
    `saturate(${params.saturation.toFixed(3)})`,
    params.blur > 0 ? `blur(${params.blur.toFixed(2)}px)` : '',
    params.warmth > 0 ? `sepia(${(params.warmth * 1.6).toFixed(2)})` : '',
    params.warmth < 0 ? `hue-rotate(${(params.warmth * 40).toFixed(0)}deg)` : '',
  ].filter(Boolean).join(' ');
  // Zoom/pan preview on the video element (overlays are placed after zoom on export, so previewing
  // zoom on the video alone stays visually faithful for the common no-overlay-with-zoom case).
  const previewTransform = `scale(${params.zoom.toFixed(3)}) translate(${(params.panX * 8).toFixed(2)}%, ${(params.panY * 8).toFixed(2)}%)`;

  // Renders as a PAGE (fills its container's height), not a modal — reached as the "Video Editor"
  // tab, same as the Image Editor. The parent hands it a bounded height (it's a self-scroll page),
  // so the flex column here lays out header / tools+preview+adjust / timeline cleanly.
  return (
    <div className="flex flex-col h-full min-h-0 bg-[#0b0b0f] text-zinc-200 rounded-2xl overflow-hidden border border-white/[0.06]" onPointerDown={() => setSelectedId(null)}>
      {/* header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/5 shrink-0 bg-white/[0.015]" onPointerDown={(e) => e.stopPropagation()}>
        <h3 className="text-base font-light tracking-tight text-white">Edit video <span className="text-zinc-600 text-sm">· one screen</span></h3>
        <div className="flex items-center gap-2.5">
          <button onClick={onClose} disabled={exporting}
            className="rounded-full px-4 py-1.5 text-sm font-medium text-zinc-300 bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 transition disabled:opacity-50 cursor-pointer">Cancel</button>
          <button onClick={doExport} disabled={exporting}
            className="inline-flex items-center gap-1.5 rounded-full px-5 py-1.5 text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:from-violet-400 hover:to-fuchsia-400 shadow-lg shadow-violet-500/30 transition disabled:opacity-60 cursor-pointer">
            {exporting ? <Spinner size={14} /> : null} Export to gallery
          </button>
        </div>
      </div>

      {/* main: tools · preview · adjust */}
      <div className="flex-1 flex min-h-0">
        {/* LEFT — stickers + text, all visible */}
        <div className="w-52 shrink-0 border-r border-white/5 overflow-y-auto p-3 space-y-3 bg-white/[0.012]" onPointerDown={(e) => e.stopPropagation()}>
          <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-3">
            <h4 className="text-[0.8125rem] font-bold uppercase tracking-wider text-zinc-500 mb-2">Stickers</h4>
            <div className="grid grid-cols-5 gap-1.5">
              {EMOJIS.map((em) => (
                <button key={em.u} onClick={() => addEmoji(em)} className="aspect-square rounded-xl bg-white/[0.04] hover:bg-white/[0.1] ring-1 ring-white/5 flex items-center justify-center transition p-1 hover:scale-105" title="Add">
                  {failedEmoji.has(em.u)
                    ? <span className="text-xl">{em.c}</span>
                    : <img src={appleEmojiUrl(em.u)} alt={em.c} draggable={false} onError={() => markEmojiFailed(em.u)} className="w-full h-full object-contain" />}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-3">
            <h4 className="text-[0.8125rem] font-bold uppercase tracking-wider text-zinc-500 mb-2">Text</h4>
            <button onClick={addText} className="w-full rounded-xl bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-sm font-medium text-zinc-200 py-2 transition cursor-pointer">+ Add text</button>
            {selected?.type === 'text' && (
              <div className="space-y-2 pt-2">
                <textarea value={selected.content} onChange={(e) => patch(selected.id, { content: e.target.value })} rows={2}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none" />
                <div className="flex flex-wrap gap-1.5">
                  {TEXT_COLORS.map((c) => (
                    <button key={c} onClick={() => patch(selected.id, { color: c })} style={{ background: c }}
                      className={cn('w-6 h-6 rounded-full border', selected.color === c ? 'border-violet-400 ring-1 ring-violet-400' : 'border-zinc-600')} />
                  ))}
                </div>
              </div>
            )}
          </div>

          {selected && (
            <div className="flex items-center gap-2 text-[0.8125rem] text-zinc-400">
              <span className="font-mono">layer {(selected.start || 0).toFixed(1)}–{(selected.end ?? duration).toFixed(1)}s</span>
              <button onClick={() => removeOverlay(selected.id)} className="ml-auto text-red-400 hover:text-red-300 underline">Remove</button>
            </div>
          )}

          <p className="text-[0.75rem] text-zinc-600 leading-relaxed">Add, then drag it on the video. Corner = resize, top dot = rotate. Its lane on the timeline sets when it shows.</p>
        </div>

        {/* CENTER — preview. The stage is sized by the video's ASPECT RATIO (height fills, width
            follows) instead of shrink-wrapping the <video>, which was collapsing to zero. Because
            the stage box equals the video frame, overlays on inset-0 map 1:1 to the exported frame. */}
        <div className="flex-1 min-w-0 min-h-0 flex items-center justify-center p-5 bg-black/50" onPointerDown={(e) => e.stopPropagation()}>
          <div
            ref={stageRef}
            className="relative ring-1 ring-white/10 rounded-2xl overflow-hidden bg-black shadow-2xl shadow-black/60"
            style={{ aspectRatio: `${dims.w} / ${dims.h}`, height: '100%', maxWidth: '100%' }}
          >
            <video
              ref={videoRef}
              src={src}
              className="absolute inset-0 w-full h-full object-contain bg-black"
              style={{ filter: previewFilter, transform: previewTransform }}
              controls
              controlsList="nodownload noremoteplayback"
              disablePictureInPicture
              loop
              playsInline
              onLoadedMetadata={onLoadedMeta}
              onTimeUpdate={onTimeUpdate}
              onError={() => setVideoError(true)}
            />
            {/* vignette preview (sits above the video, below the stickers) */}
            {params.vignette > 0 && (
              <div className="absolute inset-0 pointer-events-none" style={{ background: `radial-gradient(ellipse at center, transparent ${(1 - params.vignette) * 55}%, rgba(0,0,0,${(params.vignette * 0.9).toFixed(2)}) 100%)` }} />
            )}
            {videoError && !duration && (
              <div className="absolute inset-0 flex items-center justify-center bg-zinc-900 text-sm text-red-400 p-4 text-center">
                Couldn&apos;t load this clip for editing.
              </div>
            )}
            {/* Overlay layer is click-through so the native controls underneath stay usable; only the
                overlay elements opt back in with pointer-events-auto. */}
            <div className="absolute inset-0 pointer-events-none">
              {overlays.map((o) => {
                const sidePx = o.size * stageH();
                const isSel = o.id === selectedId;
                const visible = now >= (o.start || 0) && now <= (o.end ?? duration);
                return (
                  <div
                    key={o.id}
                    onPointerDown={(e) => onPointerDown(e, o.id, 'move')}
                    onDoubleClick={() => setSelectedId(o.id)}
                    className={cn('absolute select-none touch-none pointer-events-auto', isSel && 'z-10')}
                    style={{
                      left: `${o.cx * 100}%`,
                      top: `${o.cy * 100}%`,
                      transform: `translate(-50%,-50%) rotate(${o.rotation}deg)`,
                      cursor: 'move',
                      opacity: visible ? 1 : 0.28,
                    }}
                  >
                    <div className={cn('relative flex items-center justify-center', isSel && 'outline outline-1 outline-violet-400/80')}
                      style={{ height: sidePx, minWidth: o.type === 'emoji' ? sidePx : undefined, padding: o.type === 'text' ? '0 0.15em' : 0 }}>
                      {o.type === 'emoji' ? (
                        o.code && !failedEmoji.has(o.code) ? (
                          <img src={appleEmojiUrl(o.code)} alt={o.content} draggable={false} onError={() => markEmojiFailed(o.code)}
                            className="pointer-events-none select-none" style={{ width: sidePx, height: sidePx, objectFit: 'contain' }} />
                        ) : (
                          <span style={{ fontSize: sidePx * 0.92, lineHeight: 1 }}>{o.content}</span>
                        )
                      ) : (
                        <span style={{ fontSize: sidePx * 0.82, color: o.color, fontWeight: 700, WebkitTextStroke: `${sidePx * 0.03}px rgba(0,0,0,0.55)`, whiteSpace: 'nowrap', lineHeight: 1 }}>{o.content || ' '}</span>
                      )}
                      {isSel && (
                        <>
                          <div onPointerDown={(e) => onPointerDown(e, o.id, 'rotate')}
                            className="absolute left-1/2 -top-6 -translate-x-1/2 w-4 h-4 rounded-full bg-violet-500 border border-white cursor-grab" title="Rotate" />
                          <div onPointerDown={(e) => onPointerDown(e, o.id, 'resize')}
                            className="absolute -right-2 -bottom-2 w-4 h-4 rounded-sm bg-white border border-violet-500 cursor-nwse-resize" title="Resize" />
                          <button onPointerDown={(e) => { e.stopPropagation(); removeOverlay(o.id); }}
                            className="absolute -left-2 -top-2 w-5 h-5 rounded-full bg-zinc-900 border border-zinc-600 text-red-400 text-sm flex items-center justify-center" title="Remove">×</button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* RIGHT — every adjustment, no tabs */}
        <div className="w-60 shrink-0 border-l border-white/5 overflow-y-auto p-3 bg-white/[0.012]" onPointerDown={(e) => e.stopPropagation()}>
          <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-[0.8125rem] font-bold uppercase tracking-wider text-zinc-500">Adjust</h4>
              <button onClick={() => setParams(FILTER_DEFAULTS)} className="text-[0.75rem] text-zinc-500 hover:text-zinc-300 underline">Reset all</button>
            </div>
            {FILTER_GROUPS.map((group) => (
              <div key={group} className="rounded-xl bg-white/[0.02] border border-white/5 p-2.5 space-y-2">
                <div className="text-[0.75rem] font-bold uppercase tracking-[0.14em] text-violet-300/70">{group}</div>
                {FILTERS.filter((f) => f.group === group).map((f) => (
                  <div key={f.key}>
                    <div className="flex justify-between text-[0.8125rem] text-zinc-400">
                      <span>{f.label}</span>
                      <span className="font-mono tabular-nums text-violet-300/80">{Number(params[f.key]).toFixed(2)}</span>
                    </div>
                    <input type="range" min={f.min} max={f.max} step={f.step} value={params[f.key]}
                      onChange={(e) => setParams((p) => ({ ...p, [f.key]: Number(e.target.value) }))}
                      className="w-full accent-violet-500 h-1" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* BOTTOM — timeline (OpenCut-style): a track-label rail, a time ruler, and spaced tracks
          (video thumbnails with trim handles + a lane per sticker/text) with a draggable playhead. */}
      <div className="border-t border-white/5 px-4 pt-2.5 pb-3 shrink-0 bg-white/[0.02]" onPointerDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2 px-1 text-sm">
          <span className="font-mono tabular-nums text-zinc-200">{fmtT(now)} <span className="text-zinc-600">/ {fmtT(duration)}</span></span>
          <span className="hidden md:flex items-center gap-2 text-[0.8125rem] text-zinc-600">
            <kbd className="rounded bg-zinc-800 px-1 text-zinc-400">Space</kbd> play
            <kbd className="rounded bg-zinc-800 px-1 text-zinc-400">←→</kbd> seek
            <kbd className="rounded bg-zinc-800 px-1 text-zinc-400">I</kbd>/<kbd className="rounded bg-zinc-800 px-1 text-zinc-400">O</kbd> trim
            <kbd className="rounded bg-zinc-800 px-1 text-zinc-400">Del</kbd> remove
          </span>
          <span className="text-zinc-400">
            final clip <span className="text-violet-300 font-semibold">{((trim.end - trim.start) / params.speed).toFixed(1)}s</span>
            {params.speed !== 1 && <span className="text-zinc-500"> — {(trim.end - trim.start).toFixed(1)}s of footage at {params.speed}× {params.speed < 1 ? '(slow-mo)' : '(sped up)'}</span>}
          </span>
        </div>

        <div className="flex">
          {/* track-label rail */}
          <div className="w-16 shrink-0 pr-2 text-right">
            <div className="h-4" />{/* ruler spacer */}
            <div className="h-11 mt-1 flex items-center justify-end gap-1 text-[0.8125rem] font-semibold uppercase tracking-wide text-zinc-500">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none"/></svg>
              Clip
            </div>
            {overlays.map((o) => (
              <div key={o.id} className={cn('h-6 mt-1 flex items-center justify-end gap-1 pr-0.5 rounded-l', o.id === selectedId && 'bg-violet-500/10')}>
                {o.type === 'emoji'
                  ? (o.code && !failedEmoji.has(o.code) ? <img src={appleEmojiUrl(o.code)} alt="" className="h-3.5 w-3.5" /> : <span className="text-[0.75rem]">{o.content}</span>)
                  : <span className="text-[0.8125rem] font-bold text-zinc-400">T</span>}
              </div>
            ))}
          </div>

          {/* track area — click/drag anywhere to scrub */}
          <div className="flex-1 min-w-0 relative cursor-pointer" onPointerDown={(e) => tlDown(e, 'seek')}>
            <div ref={trackInnerRef} className="relative">
              {/* ruler */}
              <div className="h-4 relative border-b border-zinc-800">
                {Array.from({ length: 6 }).map((_, i) => {
                  const t = (i / 5) * duration;
                  return (
                    <div key={i} className="absolute top-0 bottom-0 flex flex-col items-start pointer-events-none" style={{ left: `${xPct(t)}%` }}>
                      <span className="w-px h-1.5 bg-zinc-700" />
                      <span className="text-[0.6875rem] text-zinc-600 -ml-1 mt-px font-mono">{fmtT(t)}</span>
                    </div>
                  );
                })}
              </div>

              {/* video track */}
              <div className="relative h-11 mt-1 rounded-md overflow-hidden bg-zinc-800 ring-1 ring-zinc-700/60 flex">
                {thumbs.length
                  ? thumbs.map((tsrc, i) => <img key={i} src={tsrc} alt="" draggable={false} className="h-full object-cover pointer-events-none" style={{ width: `${100 / thumbs.length}%` }} />)
                  : <div className="w-full h-full animate-pulse bg-zinc-700/40" />}
                <div className="absolute inset-y-0 left-0 bg-black/65 pointer-events-none" style={{ width: `${xPct(trim.start)}%` }} />
                <div className="absolute inset-y-0 right-0 bg-black/65 pointer-events-none" style={{ width: `${100 - xPct(trim.end)}%` }} />
                <div className="absolute inset-y-0 border-2 border-violet-500/90 rounded pointer-events-none" style={{ left: `${xPct(trim.start)}%`, width: `${Math.max(0, xPct(trim.end) - xPct(trim.start))}%` }} />
                <div onPointerDown={(e) => tlDown(e, 'trim-start', { otherEnd: trim.end })}
                  className="absolute inset-y-0 -ml-1.5 w-3 bg-violet-500 rounded-l cursor-ew-resize flex items-center justify-center z-10" style={{ left: `${xPct(trim.start)}%` }}>
                  <span className="w-0.5 h-4 bg-white/90 rounded" />
                </div>
                <div onPointerDown={(e) => tlDown(e, 'trim-end', { otherStart: trim.start })}
                  className="absolute inset-y-0 -ml-1.5 w-3 bg-violet-500 rounded-r cursor-ew-resize flex items-center justify-center z-10" style={{ left: `${xPct(trim.end)}%` }}>
                  <span className="w-0.5 h-4 bg-white/90 rounded" />
                </div>
              </div>

              {/* overlay lanes */}
              {overlays.map((o) => (
                <div key={o.id} className={cn('relative h-6 mt-1 rounded', o.id === selectedId && 'bg-violet-500/[0.07]')}>
                  <div
                    onPointerDown={(e) => tlDown(e, 'clip-move', { id: o.id, start0: o.start || 0, end0: o.end ?? duration, t0: timeFromClientX(e.clientX) })}
                    className={cn('absolute inset-y-0 rounded-md flex items-center gap-1 px-2 overflow-hidden cursor-grab shadow-sm',
                      o.id === selectedId ? 'bg-gradient-to-b from-violet-500/60 to-violet-600/50 ring-1 ring-violet-300' : 'bg-gradient-to-b from-violet-500/30 to-violet-600/25 hover:from-violet-500/40')}
                    style={{ left: `${xPct(o.start || 0)}%`, width: `${Math.max(2, xPct(o.end ?? duration) - xPct(o.start || 0))}%` }}
                  >
                    {o.type === 'emoji'
                      ? (o.code && !failedEmoji.has(o.code) ? <img src={appleEmojiUrl(o.code)} alt="" className="h-3.5 w-3.5 pointer-events-none shrink-0" /> : <span className="text-[0.8125rem] shrink-0">{o.content}</span>)
                      : <span className="text-[0.75rem] text-white/90 truncate pointer-events-none">{o.content}</span>}
                    <div onPointerDown={(e) => tlDown(e, 'clip-start', { id: o.id, end0: o.end ?? duration })} className="absolute inset-y-0 left-0 w-1.5 bg-white/60 hover:bg-white cursor-ew-resize rounded-l" />
                    <div onPointerDown={(e) => tlDown(e, 'clip-end', { id: o.id, start0: o.start || 0 })} className="absolute inset-y-0 right-0 w-1.5 bg-white/60 hover:bg-white cursor-ew-resize rounded-r" />
                  </div>
                </div>
              ))}

              {/* playhead across the whole stack */}
              <div className="absolute top-0 bottom-0 w-px bg-white pointer-events-none z-20" style={{ left: `${xPct(now)}%` }}>
                <span className="absolute -top-0.5 -left-[4px] w-2.5 h-2.5 rotate-45 bg-white rounded-[1px]" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
