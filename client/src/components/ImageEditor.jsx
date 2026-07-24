import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { gallery as galleryApi } from '../services/api';
import { cn } from '../lib/utils';
import { Btn, Spinner } from './UI';
import CompareSlider from './CompareSlider';
import { EDITOR_PRESETS, loadCustomPresets, saveCustomPresets } from '../lib/editorPresets';
import { downloadBlob } from '../lib/stripMetadata';

const ADJUSTMENTS = [
  { key: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1, default: 0, css: true },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, default: 0, css: true },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, default: 0, css: true },
  { key: 'warmth', label: 'Warmth', min: -100, max: 100, step: 1, default: 0, css: false },
  { key: 'sharpness', label: 'Sharpness', min: 0, max: 100, step: 1, default: 0, css: false },
  { key: 'grain', label: 'Grain / Noise', min: 0, max: 100, step: 1, default: 0, css: false },
  { key: 'vignette', label: 'Vignette', min: 0, max: 100, step: 1, default: 0, css: false },
  { key: 'fade', label: 'Fade (Lifted Blacks)', min: 0, max: 100, step: 1, default: 0, css: false },
  { key: 'hueShift', label: 'Hue Shift', min: -180, max: 180, step: 1, default: 0, css: true },
  { key: 'rgbSplitDistance', label: 'RGB Split', min: 0, max: 20, step: 1, default: 0, css: false, group: 'rgbSplit' },
  { key: 'rgbSplitDirection', label: 'Split Direction', min: 0, max: 360, step: 15, default: 180, css: false, group: 'rgbSplit' },
];

const RGB_SPLIT_COLORS = [
  { id: 'rc', label: 'Red / Cyan', colors: ['#ff4444', '#44dddd'] },
  { id: 'rb', label: 'Red / Blue', colors: ['#ff4444', '#4466ff'] },
  { id: 'gm', label: 'Green / Magenta', colors: ['#44dd44', '#dd44dd'] },
  { id: 'gb', label: 'Green / Blue', colors: ['#44dd44', '#4466ff'] },
  { id: 'yo', label: 'Red / Green', colors: ['#ff4444', '#44dd44'] },
  { id: 'cb', label: 'Blue / Green', colors: ['#4466ff', '#44dd44'] },
];

const PRESETS = [
  { name: 'Reset', values: {} },
  ...EDITOR_PRESETS,
];

function getDefaults() {
  const d = {};
  for (const a of ADJUSTMENTS) d[a.key] = a.default;
  d.rgbSplitColor = 'rc';
  return d;
}

function getCssFilterStyle(values) {
  const parts = [];
  if (values.brightness !== 0) parts.push(`brightness(${1 + values.brightness / 100})`);
  if (values.contrast !== 0) parts.push(`contrast(${1 + values.contrast / 100})`);
  if (values.saturation !== 0) parts.push(`saturate(${1 + values.saturation / 100})`);
  if (values.hueShift !== 0) parts.push(`hue-rotate(${values.hueShift}deg)`);
  return parts.length > 0 ? parts.join(' ') : 'none';
}

function hasServerOnlyChanges(values) {
  return values.warmth !== 0 || values.sharpness !== 0 || values.grain !== 0 ||
    values.vignette !== 0 || values.fade !== 0 || (values.rgbSplitDistance || 0) > 0;
}

function hasAnyChanges(values) {
  return ADJUSTMENTS.some((a) => values[a.key] !== a.default);
}

export default function ImageEditor({ imageId, imageUrl, onClose, onSaved }) {
  const [values, setValues] = useState(getDefaults);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverPreviewUrl, setServerPreviewUrl] = useState(null);
  const [customPresets, setCustomPresets] = useState(loadCustomPresets);
  const [activePreset, setActivePreset] = useState(null);
  const [showSavePreset, setShowSavePreset] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [compareMode, setCompareMode] = useState(false);
  const [holdOriginal, setHoldOriginal] = useState(false);
  const [history, setHistory] = useState([getDefaults()]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const debounceRef = useRef(null);
  const historyDebounceRef = useRef(null);

  const pushHistory = useCallback((newValues) => {
    if (historyDebounceRef.current) clearTimeout(historyDebounceRef.current);
    historyDebounceRef.current = setTimeout(() => {
      setHistory(prev => {
        const truncated = prev.slice(0, historyIndex + 1);
        const next = [...truncated, newValues];
        if (next.length > 50) next.shift();
        return next;
      });
      setHistoryIndex(prev => Math.min(prev + 1, 49));
    }, 300);
  }, [historyIndex]);

  const setValue = useCallback((key, val) => {
    setValues((prev) => {
      const next = { ...prev, [key]: val };
      setActivePreset(null);
      pushHistory(next);
      return next;
    });
  }, [pushHistory]);

  const applyPreset = useCallback((preset) => {
    const base = getDefaults();
    const newValues = { ...base, ...preset.values };
    setValues(newValues);
    setActivePreset(preset.name);
    // Immediate push for preset application (no debounce)
    if (historyDebounceRef.current) clearTimeout(historyDebounceRef.current);
    setHistory(prev => {
      const truncated = prev.slice(0, historyIndex + 1);
      const next = [...truncated, newValues];
      if (next.length > 50) next.shift();
      return next;
    });
    setHistoryIndex(prev => Math.min(prev + 1, 49));
  }, [historyIndex]);

  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setValues(history[newIndex]);
      setActivePreset(null);
    }
  }, [historyIndex, history]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      setValues(history[newIndex]);
      setActivePreset(null);
    }
  }, [historyIndex, history]);

  const handleSavePreset = useCallback(() => {
    const name = presetName.trim();
    if (!name) return;
    const nonDefault = {};
    const defaults = getDefaults();
    for (const [k, v] of Object.entries(values)) {
      if (v !== defaults[k]) nonDefault[k] = v;
    }
    if (Object.keys(nonDefault).length === 0) return;
    const updated = [...customPresets.filter((p) => p.name !== name), { name, values: nonDefault }];
    setCustomPresets(updated);
    saveCustomPresets(updated);
    setPresetName('');
    setShowSavePreset(false);
  }, [presetName, values, customPresets]);

  const handleDeletePreset = useCallback((name) => {
    const updated = customPresets.filter((p) => p.name !== name);
    setCustomPresets(updated);
    saveCustomPresets(updated);
  }, [customPresets]);

  const cssFilter = useMemo(() => getCssFilterStyle(values), [values]);
  const needsServer = useMemo(() => hasServerOnlyChanges(values), [values]);
  const changed = useMemo(() => hasAnyChanges(values), [values]);

  // Auto-render: debounce server preview on every value change
  useEffect(() => {
    if (!changed) { setServerPreviewUrl(null); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setProcessing(true);
      try {
        const res = await fetch(`/api/gallery/${imageId}/edit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values),
        });
        if (!res.ok) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setServerPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
      } catch { /* ignore */ } finally {
        setProcessing(false);
      }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [values, changed, imageId]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const result = await galleryApi.saveEdit(imageId, values);
      localStorage.setItem('imageEditor_lastEdit', JSON.stringify(values));
      if (result?.galleryId) {
        onSaved?.(result.galleryId);
      }
      onClose?.();
    } catch {
      // error
    } finally {
      setSaving(false);
    }
  }, [imageId, values, onClose, onSaved]);

  const handleDownload = useCallback(async () => {
    setProcessing(true);
    try {
      const res = await fetch(`/api/gallery/${imageId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      await downloadBlob(blob, `edited-${imageId.slice(0, 8)}.png`);
    } finally {
      setProcessing(false);
    }
  }, [imageId, values]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === 'Escape') { onClose?.(); return; }
      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); return; }
      if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); return; }
      if (e.key === 'r' || e.key === 'R') { applyPreset({ name: 'Reset', values: {} }); return; }
      if (e.key === 's' || e.key === 'S') { if (changed && !saving) handleSave(); return; }
      if (e.key === 'd' || e.key === 'D') { if (changed && !processing) handleDownload(); return; }
      if (e.key === '[') {
        const allP = [...PRESETS, ...customPresets];
        const idx = allP.findIndex(p => p.name === activePreset);
        if (idx > 0) applyPreset(allP[idx - 1]);
        else if (idx === -1) applyPreset(allP[allP.length - 1]);
        return;
      }
      if (e.key === ']') {
        const allP = [...PRESETS, ...customPresets];
        const idx = allP.findIndex(p => p.name === activePreset);
        if (idx < allP.length - 1) applyPreset(allP[idx + 1]);
        else if (idx === -1) applyPreset(allP[0]);
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, undo, redo, applyPreset, changed, saving, processing, handleSave, handleDownload, activePreset, customPresets]);

  // Vignette CSS overlay for live preview
  const vignetteStyle = values.vignette > 0
    ? { boxShadow: `inset 0 0 ${values.vignette * 1.5}px ${values.vignette * 0.8}px rgba(0,0,0,${values.vignette / 100 * 0.7})` }
    : {};

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex">
      {/* Image preview */}
      <div className="flex-1 flex items-center justify-center p-4 min-w-0">
        <div className="relative max-w-full max-h-full">
          {holdOriginal ? (
            <div className="relative">
              <img
                src={imageUrl}
                alt="Original"
                className="max-w-full max-h-[85vh] rounded-lg object-contain"
              />
              <div className="absolute top-3 left-3 px-2.5 py-1 rounded-md text-[0.6875rem] font-bold bg-black/60 text-amber-400 backdrop-blur-sm">
                ORIGINAL
              </div>
            </div>
          ) : compareMode && changed ? (
            <div className="relative" style={{ maxHeight: '85vh', maxWidth: '100%' }}>
              <CompareSlider
                originalSrc={imageUrl}
                processedSrc={serverPreviewUrl || imageUrl}
                processedStyle={serverPreviewUrl ? undefined : { filter: cssFilter }}
                originalLabel="BEFORE"
                processedLabel="AFTER"
                className="rounded-lg"
                imgClassName="max-h-[85vh] w-auto object-contain"
              />
            </div>
          ) : (
            <>
              {serverPreviewUrl ? (
                <img
                  src={serverPreviewUrl}
                  alt="Server preview"
                  className="max-w-full max-h-[85vh] rounded-lg object-contain"
                />
              ) : (
                <div className="relative">
                  <img
                    src={imageUrl}
                    alt="Preview"
                    className="max-w-full max-h-[85vh] rounded-lg object-contain"
                    style={{ filter: cssFilter }}
                  />
                  <div
                    className="absolute inset-0 rounded-lg pointer-events-none"
                    style={vignetteStyle}
                  />
                </div>
              )}
              {processing && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-sm text-[0.625rem] text-zinc-400">
                  Rendering...
                </div>
              )}
            </>
          )}
          {processing && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-lg">
              <Spinner size={32} />
            </div>
          )}
        </div>
      </div>

      {/* Controls sidebar */}
      <div className="w-72 bg-zinc-900/95 border-l border-zinc-700/60 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700/60">
          <h3 className="text-sm font-semibold text-zinc-200">Edit Image</h3>
          <div className="flex items-center gap-1.5">
            <button
              onClick={undo}
              disabled={historyIndex <= 0}
              className="text-[0.625rem] px-1.5 py-1 rounded-md border border-zinc-700/60 text-zinc-500 hover:text-zinc-300 disabled:opacity-30 disabled:cursor-default transition cursor-pointer"
              title="Undo (Ctrl+Z)"
            >
              &#8617;
            </button>
            <button
              onClick={redo}
              disabled={historyIndex >= history.length - 1}
              className="text-[0.625rem] px-1.5 py-1 rounded-md border border-zinc-700/60 text-zinc-500 hover:text-zinc-300 disabled:opacity-30 disabled:cursor-default transition cursor-pointer"
              title="Redo (Ctrl+Y)"
            >
              &#8618;
            </button>
            <button
              onMouseDown={() => setHoldOriginal(true)}
              onMouseUp={() => setHoldOriginal(false)}
              onMouseLeave={() => setHoldOriginal(false)}
              onTouchStart={() => setHoldOriginal(true)}
              onTouchEnd={() => setHoldOriginal(false)}
              disabled={!changed}
              className={cn(
                'text-[0.625rem] px-2 py-1 rounded-md border transition cursor-pointer select-none',
                holdOriginal
                  ? 'border-amber-500 bg-amber-500/20 text-amber-300'
                  : 'border-zinc-700/60 text-zinc-500 hover:text-zinc-300 disabled:opacity-30 disabled:cursor-default',
              )}
              title="Hold to see original"
            >
              Original
            </button>
            <button
              onClick={() => setCompareMode(!compareMode)}
              disabled={!changed}
              className={cn(
                'text-[0.625rem] px-2 py-1 rounded-md border transition cursor-pointer',
                compareMode
                  ? 'border-rose-500 bg-rose-500/20 text-rose-300'
                  : 'border-zinc-700/60 text-zinc-500 hover:text-zinc-300 disabled:opacity-30 disabled:cursor-default',
              )}
              title="Before / After slider"
            >
              B/A
            </button>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg cursor-pointer">&times;</button>
          </div>
        </div>

        {/* Presets */}
        <div className="px-4 py-2 border-b border-zinc-700/40 space-y-1.5">
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                onClick={() => applyPreset(p)}
                className={cn(
                  'text-[0.625rem] px-2 py-0.5 rounded-full border transition cursor-pointer',
                  activePreset === p.name
                    ? 'border-rose-500 bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/30'
                    : 'border-zinc-700/60 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500',
                )}
              >
                {p.name}
              </button>
            ))}
          </div>
          {customPresets.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {customPresets.map((p) => (
                <span key={p.name} className={cn(
                  'inline-flex items-center gap-0.5 text-[0.625rem] px-2 py-0.5 rounded-full border transition',
                  activePreset === p.name
                    ? 'border-rose-400 bg-rose-500/25 text-rose-200 ring-1 ring-rose-500/30'
                    : 'border-rose-500/40 bg-rose-500/10 text-rose-300',
                )}>
                  <button onClick={() => applyPreset(p)} className="cursor-pointer hover:text-rose-200">{p.name}</button>
                  <button onClick={() => handleDeletePreset(p.name)} className="text-rose-500 hover:text-red-400 cursor-pointer ml-0.5">&times;</button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1">
            {showSavePreset ? (
              <>
                <input
                  type="text"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSavePreset()}
                  placeholder="Preset name..."
                  className="flex-1 h-5 bg-zinc-800 border border-zinc-700/60 rounded px-1.5 text-[0.625rem] text-zinc-200 outline-none focus:border-rose-500/60"
                  autoFocus
                />
                <button onClick={handleSavePreset} disabled={!presetName.trim() || !changed} className="text-[0.625rem] text-rose-400 hover:text-rose-300 cursor-pointer disabled:text-zinc-600">Save</button>
                <button onClick={() => { setShowSavePreset(false); setPresetName(''); }} className="text-[0.625rem] text-zinc-500 hover:text-zinc-300 cursor-pointer">&times;</button>
              </>
            ) : (
              <button
                onClick={() => setShowSavePreset(true)}
                disabled={!changed}
                className="text-[0.625rem] text-zinc-500 hover:text-rose-400 cursor-pointer disabled:text-zinc-700 transition"
              >
                + Save as preset
              </button>
            )}
          </div>
        </div>

        {/* Sliders */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {ADJUSTMENTS.map((a) => {
            // Hide direction slider when RGB split distance is 0
            if (a.key === 'rgbSplitDirection' && (values.rgbSplitDistance || 0) === 0) return null;
            return (
              <div key={a.key}>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[0.6875rem] text-zinc-400">{a.label}</span>
                    <input
                      type="number"
                      min={a.min}
                      max={a.max}
                      step={a.step}
                      value={values[a.key]}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (!isNaN(v)) setValue(a.key, Math.max(a.min, Math.min(a.max, v)));
                      }}
                      className="w-8 text-right text-[0.625rem] font-mono text-zinc-500 bg-transparent border-none outline-none focus:text-zinc-200 p-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={a.min}
                      max={a.max}
                      step={a.step}
                      value={values[a.key]}
                      onChange={(e) => setValue(a.key, parseInt(e.target.value, 10))}
                      className="w-full accent-rose-500 h-1 rounded-full appearance-none bg-zinc-700 cursor-pointer"
                    />
                    <button
                      onClick={() => setValue(a.key, a.default)}
                      className={cn(
                        'text-[0.5625rem] px-1 rounded cursor-pointer transition',
                        values[a.key] !== a.default ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-700',
                      )}
                      title="Reset"
                    >
                      &crarr;
                    </button>
                  </div>
                </div>
                {/* RGB Split color picker — show after direction slider */}
                {a.key === 'rgbSplitDirection' && (values.rgbSplitDistance || 0) > 0 && (
                  <div className="mt-2 space-y-1">
                    <span className="text-[0.6875rem] text-zinc-400">Color</span>
                    <div className="flex gap-1.5">
                      {RGB_SPLIT_COLORS.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => setValue('rgbSplitColor', c.id)}
                          title={c.label}
                          className={cn(
                            'w-6 h-6 rounded-full border-2 transition cursor-pointer flex items-center justify-center overflow-hidden',
                            values.rgbSplitColor === c.id
                              ? 'border-white ring-1 ring-rose-500/50 scale-110'
                              : 'border-zinc-600 hover:border-zinc-400',
                          )}
                        >
                          <div className="w-full h-full flex">
                            <div className="w-1/2 h-full" style={{ backgroundColor: c.colors[0] }} />
                            <div className="w-1/2 h-full" style={{ backgroundColor: c.colors[1] }} />
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Actions */}
        <div className="px-4 py-3 border-t border-zinc-700/60 space-y-2">
          <div className="flex gap-2">
            <Btn onClick={handleSave} disabled={!changed || saving} className="flex-1 !text-xs">
              {saving ? <><Spinner size={14} /> Saving...</> : 'Save Copy'}
            </Btn>
            <Btn variant="secondary" onClick={handleDownload} disabled={!changed || processing} className="flex-1 !text-xs">
              Download
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
