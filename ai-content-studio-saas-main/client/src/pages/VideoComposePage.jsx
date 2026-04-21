import { Component, useEffect, useMemo, useRef, useState } from 'react';
import { Spinner, Slider } from '../components/UI';
import { useApp } from '../context/AppContext';
import { video as videoApi, videoCompose as videoComposeApi } from '../services/api';

const POSITIONS = ['top', 'center', 'bottom'];
const PRESETS = [
  ['none', 'Original'], ['clean', 'Clean'], ['cinematic', 'Cinematic'], ['warm', 'Warm'],
  ['cool', 'Cool'], ['dramatic', 'Dramatic'], ['mono', 'Mono'], ['glam', 'Glam'],
];
const PREVIEW_FILTER_PRESETS = {
  none: { brightness: 0, contrast: 1, saturation: 1, blur: 0, warmth: 0, sharpness: 0, vignette: 0 },
  clean: { brightness: 0.01, contrast: 1.04, saturation: 1.03, blur: 0, warmth: 0.03, sharpness: 0.35, vignette: 0 },
  cinematic: { brightness: -0.03, contrast: 1.15, saturation: 0.92, blur: 0.2, warmth: -0.02, sharpness: 0.2, vignette: 0.45 },
  warm: { brightness: 0.02, contrast: 1.05, saturation: 1.08, blur: 0, warmth: 0.12, sharpness: 0.1, vignette: 0 },
  cool: { brightness: 0, contrast: 1.06, saturation: 0.94, blur: 0, warmth: -0.1, sharpness: 0.15, vignette: 0 },
  dramatic: { brightness: -0.05, contrast: 1.2, saturation: 0.88, blur: 0, warmth: -0.03, sharpness: 0.45, vignette: 0.55 },
  mono: { brightness: 0, contrast: 1.08, saturation: 0, blur: 0, warmth: 0, sharpness: 0.2, vignette: 0 },
  glam: { brightness: 0.03, contrast: 1.08, saturation: 1.15, blur: 0.15, warmth: 0.08, sharpness: 0.15, vignette: 0.1 },
};
const TABS = [
  { id: 'media', label: 'Media' }, { id: 'text', label: 'Text' },
  { id: 'audio', label: 'Audio' }, { id: 'adjust', label: 'Adjust' }, { id: 'export', label: 'Export' },
];
const TIMELINE_LANE_PAD_PX = 18;

function clamp(v, min, max, fb) { const n = Number(v); if (!Number.isFinite(n)) return fb; return Math.max(min, Math.min(max, n)); }
function stamp(s) {
  const t = Number.isFinite(s) ? Math.max(0, s) : 0;
  const m = Math.floor(t / 60), sec = Math.floor(t % 60), c = Math.floor((t % 1) * 100);
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}:${String(c).padStart(2,'0')}`;
}
function newId() { return `c-${Date.now()}-${Math.random().toString(36).slice(2,6)}`; }

function fileMatchesAccept(file, accept = '') {
  if (!file) return false;
  const rules = String(accept || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  if (rules.length === 0) return true;

  const fileType = String(file.type || '').toLowerCase();
  const fileName = String(file.name || '').toLowerCase();

  return rules.some((rule) => {
    if (rule.endsWith('/*')) return fileType.startsWith(rule.slice(0, -1));
    if (rule.startsWith('.')) return fileName.endsWith(rule);
    return fileType === rule;
  });
}

function isImageFile(file) {
  return Boolean(file && String(file.type || '').toLowerCase().startsWith('image/'));
}

function isVideoFile(file) {
  return Boolean(file && String(file.type || '').toLowerCase().startsWith('video/'));
}

function getClipboardImageFile(event) {
  const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'));
  const file = item?.getAsFile?.();
  if (!file) return null;
  const ext = file.type?.split('/')?.[1] || 'png';
  return new File([file], `composer-paste-${Date.now()}.${ext}`, { type: file.type || 'image/png' });
}

function DropZone({ label, accept, file, onFile, showGalleryPicker }) {
  const ref = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  const applyFile = (incomingFile) => {
    if (!incomingFile) return;
    if (!fileMatchesAccept(incomingFile, accept)) return;
    onFile(incomingFile);
  };

  return (
    <div className="flex min-w-0 gap-2">
      <button
        type="button"
        onClick={() => ref.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setIsDragging(true);
        }}
        onDragEnter={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setIsDragging(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.currentTarget.contains(event.relatedTarget)) return;
          setIsDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setIsDragging(false);
          const droppedFile = event.dataTransfer?.files?.[0];
          applyFile(droppedFile);
        }}
        className={`flex-1 min-w-0 rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${
          isDragging
            ? 'border-cyan-400 bg-cyan-500/10 shadow-[0_0_0_1px_rgba(34,211,238,0.3)]'
            : 'border-zinc-700 bg-zinc-900/40 hover:border-cyan-500/60 hover:bg-cyan-500/5'
        }`}
      >
        <input ref={ref} type="file" accept={accept} className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) applyFile(f); }} />
        {file ? (
          <div className="mx-auto flex max-w-full flex-col items-center gap-1">
            <div className="max-w-full text-center text-sm font-medium leading-tight text-zinc-200 break-all">
              {file.name}
            </div>
            <div className="text-[11px] text-zinc-500">{(file.size / 1024 / 1024).toFixed(1)} MB</div>
          </div>
        ) : (
          <>
            <div className="text-3xl mb-2 opacity-30">+</div>
            <div className="text-sm text-zinc-400">{label}</div>
            <div className="text-[11px] text-zinc-600 mt-0.5">Drop, paste, or click to browse</div>
          </>
        )}
      </button>
      {showGalleryPicker && !file && (
        <button type="button" onClick={showGalleryPicker}
          className="w-16 flex flex-col items-center justify-center rounded-xl border border-zinc-700 bg-zinc-800/80 hover:bg-zinc-700 transition">
          <span className="text-xl opacity-70 mb-1">G</span>
          <span className="text-[9px] uppercase tracking-wider text-zinc-400">Gallery</span>
        </button>
      )}
    </div>
  );
}

function DraggableClip({ clip, isSelected, onSelect, onUpdate }) {
  const isCustomPos = typeof clip.x === 'number' && typeof clip.y === 'number';
  const left = isCustomPos ? `${clip.x * 100}%` : '50%';
  const top = isCustomPos 
    ? `${clip.y * 100}%` 
    : (clip.position === 'top' ? '15%' : clip.position === 'center' ? '50%' : '85%');

  return (
    <div
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect();
        const el = e.currentTarget;
        const parent = el.parentElement;
        const rect = parent.getBoundingClientRect();
        
        let currentX = isCustomPos ? clip.x : 0.5;
        let currentY = isCustomPos ? clip.y : (clip.position === 'top' ? 0.15 : clip.position === 'center' ? 0.5 : 0.85);
        
        const startClientX = e.clientX;
        const startClientY = e.clientY;

        const onMove = (ev) => {
          const dx = (ev.clientX - startClientX) / rect.width;
          const dy = (ev.clientY - startClientY) / rect.height;
          const newX = Math.max(0, Math.min(1, currentX + dx));
          const newY = Math.max(0, Math.min(1, currentY + dy));
          el.style.left = `${newX * 100}%`;
          el.style.top = `${newY * 100}%`;
          el.dataset.x = newX;
          el.dataset.y = newY;
        };
        
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          if (el.dataset.x !== undefined) {
             onUpdate({ x: parseFloat(el.dataset.x), y: parseFloat(el.dataset.y) });
          }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      }}
      className="absolute cursor-move touch-none flex items-center justify-center -translate-x-1/2 -translate-y-1/2"
      style={{ left, top, zIndex: isSelected ? 30 : 20 }}
    >
      <div className={`max-w-[92%] whitespace-pre-line px-4 py-2 text-center font-bold leading-tight text-white transition cursor-move ${isSelected ? 'scale-105 opacity-100' : 'opacity-90'}`}
        style={{ fontFamily: "'Montserrat', 'Inter', 'Roboto', 'Arial Black', sans-serif", letterSpacing: '-0.02em', fontSize: `${Math.max(13, Math.min(38, clip.fontSize * 0.37))}px`, textShadow: '2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 0 4px 8px rgba(0,0,0,0.8)' }}>
        {clip.text}
      </div>
    </div>
  );
}

function DraggableTimelineClip({ clip, timelineDuration, isSelected, onSelect, onUpdate }) {
  const left = timelineDuration > 0 ? (clip.start / timelineDuration) * 100 : 0;
  const width = timelineDuration > 0 ? Math.max(0.5, ((clip.end - clip.start) / timelineDuration) * 100) : 0;

  const handlePointerDown = (e, mode) => {
    e.stopPropagation();
    onSelect();
    const el = e.currentTarget;
    const parent = el.closest('[data-timeline-track]');
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const startX = e.clientX;
    const startClipStart = clip.start;
    const startClipEnd = clip.end;

    const onMove = (ev) => {
      const dt = ((ev.clientX - startX) / rect.width) * timelineDuration;
      let newStart = startClipStart;
      let newEnd = startClipEnd;
      
      if (mode === 'move') {
        const dur = startClipEnd - startClipStart;
        newStart = Math.max(0, startClipStart + dt);
        newEnd = newStart + dur;
      } else if (mode === 'left') {
        newStart = Math.max(0, Math.min(startClipEnd - 0.1, startClipStart + dt));
      } else if (mode === 'right') {
        newEnd = Math.max(newStart + 0.1, startClipEnd + dt);
      }
      onUpdate({ start: newStart, end: newEnd });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      onPointerDown={(e) => handlePointerDown(e, 'move')}
      className={`absolute inset-y-1.5 rounded border text-left transition ${isSelected ? 'border-fuchsia-300 z-30 shadow-lg ring-1 ring-fuchsia-400/50' : 'border-fuchsia-500/30 z-10'} overflow-hidden cursor-grab active:cursor-grabbing flex items-center justify-between group`}
      style={{ left: `${left}%`, width: `${width}%`, backgroundColor: isSelected ? 'rgba(217,70,239,0.35)' : 'rgba(192,38,211,0.2)' }}
    >
      <div 
        onPointerDown={(e) => handlePointerDown(e, 'left')} 
        className="w-2.5 h-full bg-fuchsia-400/0 hover:bg-fuchsia-400/40 cursor-w-resize shrink-0 transition relative z-20 flex items-center border-r border-fuchsia-500/20" 
      />
      <span className="text-[9px] text-fuchsia-200 truncate flex-1 px-1 pointer-events-none select-none drop-shadow">{String(clip.text || '').replace(/\s*\n\s*/g, ' / ')}</span>
      <div 
        onPointerDown={(e) => handlePointerDown(e, 'right')} 
        className="w-2.5 h-full bg-fuchsia-400/0 hover:bg-fuchsia-400/40 cursor-e-resize shrink-0 transition relative z-20 flex items-center justify-end border-l border-fuchsia-500/20" 
      />
    </div>
  );
}

function DraggableMediaClip({ start, end, maxDuration, onUpdate, bgClass, borderClass, children }) {
  const left = maxDuration > 0 ? (start / maxDuration) * 100 : 0;
  const width = maxDuration > 0 ? Math.max(0.5, ((end - start) / maxDuration) * 100) : 0;

  const handlePointerDown = (e, mode) => {
    e.stopPropagation();
    const el = e.currentTarget;
    const parent = el.closest('[data-timeline-track]');
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const startX = e.clientX;
    const startClipStart = start;
    const startClipEnd = end;

    const onMove = (ev) => {
      const dt = ((ev.clientX - startX) / rect.width) * maxDuration;
      let newStart = startClipStart;
      let newEnd = startClipEnd;
      
      if (mode === 'move') {
        const dur = startClipEnd - startClipStart;
        newStart = Math.min(Math.max(0, startClipStart + dt), Math.max(0, maxDuration - dur));
        newEnd = newStart + dur;
      } else if (mode === 'left') {
        newStart = Math.max(0, Math.min(startClipEnd - 0.1, startClipStart + dt));
      } else if (mode === 'right') {
        newEnd = Math.max(newStart + 0.1, Math.min(maxDuration, startClipEnd + dt));
      }
      onUpdate(newStart, newEnd, mode);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      onPointerDown={(e) => handlePointerDown(e, 'move')}
      className={`absolute inset-y-2 rounded-lg border ${borderClass} overflow-hidden flex items-center justify-between cursor-grab active:cursor-grabbing group`}
      style={{ left: `${left}%`, width: `${width}%` }}
    >
      <div className={`absolute inset-0 ${bgClass}`}>{children}</div>
      <div 
        onPointerDown={(e) => handlePointerDown(e, 'left')} 
        className={`w-3 h-full cursor-w-resize shrink-0 transition relative z-20 flex items-center bg-black/0 hover:bg-black/20 border-r ${borderClass}`} 
      />
      <div className="flex-1 min-w-0" />
      <div 
        onPointerDown={(e) => handlePointerDown(e, 'right')} 
        className={`w-3 h-full cursor-e-resize shrink-0 transition relative z-20 flex items-center bg-black/0 hover:bg-black/20 border-l ${borderClass}`} 
      />
    </div>
  );
}

function FriendlySlider({ label, value, onChange, min, max, step, formatter, hint, onReset, resetDisabled = false }) {
  const adjustByStep = (direction) => {
    const nextValue = clamp(value + (step * direction), min, max, value);
    onChange(Number(nextValue.toFixed(4)));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-200">{label}</div>
          {hint ? <div className="text-[10px] uppercase tracking-wider text-zinc-600">{hint}</div> : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-mono text-zinc-300 tabular-nums">
            {formatter ? formatter(value) : value}
          </span>
          <button
            type="button"
            onClick={onReset}
            disabled={resetDisabled}
            className="rounded-md border border-zinc-700 px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-500 transition hover:border-zinc-600 hover:text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Reset
          </button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => adjustByStep(-1)}
          disabled={value <= min}
          className="h-8 w-8 shrink-0 rounded-md border border-zinc-700 bg-zinc-900 text-sm font-semibold text-zinc-300 transition hover:border-zinc-600 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
        >
          -
        </button>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full accent-blue-500 h-1.5 rounded-full appearance-none bg-zinc-700 cursor-pointer"
        />
        <button
          type="button"
          onClick={() => adjustByStep(1)}
          disabled={value >= max}
          className="h-8 w-8 shrink-0 rounded-md border border-zinc-700 bg-zinc-900 text-sm font-semibold text-zinc-300 transition hover:border-zinc-600 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
        >
          +
        </button>
      </div>
    </div>
  );
}

// Error boundary — catches render/effect errors in the composer and shows a recoverable UI
class CompositorErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[VideoComposer] UI error:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-zinc-800 bg-[#131313] p-12 text-center" style={{ minHeight: 400 }}>
          <div className="text-4xl mb-2">⚠️</div>
          <div className="text-base font-semibold text-zinc-200">Composer Error</div>
          <div className="text-xs text-zinc-500 max-w-xs break-words">{this.state.error.message}</div>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-2 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700 transition"
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function VideoComposePage() {
  const { notify, navigateTo } = useApp();
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const pickerTargetRef = useRef('primary');

  const [panel, setPanel] = useState('media');
  const [videoFile, setVideoFile] = useState(null);
  const [videoFile2, setVideoFile2] = useState(null);
  const [audioFile, setAudioFile] = useState(null);
  const [clips, setClips] = useState([]);
  const [selectedClipId, setSelectedClipId] = useState(null);
  const [preset, setPreset] = useState('none');
  const [speed, setSpeed] = useState(1);
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(1);
  const [saturation, setSaturation] = useState(1);
  const [blur, setBlur] = useState(0);
  const [warmth, setWarmth] = useState(0);
  const [sharpness, setSharpness] = useState(0);
  const [vignette, setVignette] = useState(0);
  const [primaryZoom, setPrimaryZoom] = useState(1);
  const [primaryPanX, setPrimaryPanX] = useState(0);
  const [primaryPanY, setPrimaryPanY] = useState(0);
  const [secondaryZoom, setSecondaryZoom] = useState(1);
  const [secondaryPanX, setSecondaryPanX] = useState(0);
  const [secondaryPanY, setSecondaryPanY] = useState(0);
  const [musicVolume, setMusicVolume] = useState(0.8);
  const [originalAudioVolume, setOriginalAudioVolume] = useState(1);
  const [replaceOriginalAudio, setReplaceOriginalAudio] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioStart, setAudioStart] = useState(0);
  const [audioEnd, setAudioEnd] = useState(0);
  const [audioOffset, setAudioOffset] = useState(0);
  const [duration, setDuration] = useState(0);
  const [duration2, setDuration2] = useState(0);
  const [imageDuration, setImageDuration] = useState(5);
  const [imageDuration2, setImageDuration2] = useState(5);
  const [time, setTime] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [trimReady, setTrimReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerItems, setPickerItems] = useState([]);
  const [pickerTarget, setPickerTarget] = useState('primary');

  const previewUrl = useMemo(() => (videoFile ? URL.createObjectURL(videoFile) : null), [videoFile]);
  const previewUrl2 = useMemo(() => (videoFile2 ? URL.createObjectURL(videoFile2) : null), [videoFile2]);
  const audioPreviewUrl = useMemo(() => (audioFile ? URL.createObjectURL(audioFile) : null), [audioFile]);
  const primaryIsImage = isImageFile(videoFile);
  const secondaryIsImage = isImageFile(videoFile2);
  const audioIsVideo = isVideoFile(audioFile);
  const selectedClip = clips.find(c => c.id === selectedClipId) || null;
  const effectiveTrimEnd = duration > 0 ? (trimReady ? trimEnd : duration) : trimEnd;
  const visibleDuration = duration > 0 ? Math.max(0.1, effectiveTrimEnd - trimStart) : 0;
  const secondVisibleDuration = Math.max(0, duration2 || 0);
  const mergedDuration = visibleDuration + secondVisibleDuration;
  const timelineDuration = mergedDuration > 0 ? mergedDuration : visibleDuration;
  const audioClipDuration = Math.max(0.1, audioEnd - audioStart);
  const playheadPct = visibleDuration > 0 ? Math.min(100, Math.max(0, ((time - trimStart) / visibleDuration) * 100)) : 0;
  const displayTime = Math.max(0, Math.min(visibleDuration, time - trimStart));
  const laneInsetStyle = { left: TIMELINE_LANE_PAD_PX, right: TIMELINE_LANE_PAD_PX };
  const lanePlayheadStyle = { left: `calc(${playheadPct}% + ${TIMELINE_LANE_PAD_PX}px)` };
  const previewVignetteStrength = useMemo(() => {
    const presetValues = PREVIEW_FILTER_PRESETS[preset] || PREVIEW_FILTER_PRESETS.none;
    return Math.max(0, Math.min(1, presetValues.vignette + vignette));
  }, [preset, vignette]);
  const previewFilterStyle = useMemo(() => {
    const presetValues = PREVIEW_FILTER_PRESETS[preset] || PREVIEW_FILTER_PRESETS.none;
    const finalBrightness = Math.max(-1, Math.min(1, presetValues.brightness + brightness));
    const finalContrast = Math.max(0, Math.min(3, presetValues.contrast * contrast));
    const finalSaturation = Math.max(0, Math.min(3, presetValues.saturation * saturation));
    const finalBlur = Math.max(0, Math.min(8, presetValues.blur + blur));
    const finalWarmth = Math.max(-0.35, Math.min(0.35, presetValues.warmth + warmth));
    const finalSharpness = Math.max(0, Math.min(2.5, presetValues.sharpness + sharpness));
    const finalVignette = Math.max(0, Math.min(1, presetValues.vignette + vignette));
    return {
      objectPosition: `${(50 + primaryPanX * 25).toFixed(1)}% ${(50 + primaryPanY * 25).toFixed(1)}%`,
      transform: `scale(${primaryZoom.toFixed(3)})`,
      transformOrigin: 'center center',
      filter: [
        `brightness(${(1 + finalBrightness).toFixed(3)})`,
        `contrast(${finalContrast.toFixed(3)})`,
        `saturate(${finalSaturation.toFixed(3)})`,
        Math.abs(finalWarmth) > 0.005 ? `sepia(${Math.min(0.5, Math.abs(finalWarmth) * 1.6).toFixed(3)})` : '',
        finalWarmth < -0.005 ? `hue-rotate(${Math.round(Math.abs(finalWarmth) * 40)}deg)` : '',
        finalSharpness > 0.01 ? `drop-shadow(0 0 ${Math.min(1.2, finalSharpness * 0.45).toFixed(2)}px rgba(255,255,255,0.35))` : '',
        finalBlur > 0.01 ? `blur(${finalBlur.toFixed(2)}px)` : '',
      ].filter(Boolean).join(' '),
    };
  }, [preset, brightness, contrast, saturation, blur, warmth, sharpness, vignette, primaryPanX, primaryPanY, primaryZoom]);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(() => () => { if (previewUrl2) URL.revokeObjectURL(previewUrl2); }, [previewUrl2]);
  useEffect(() => () => { if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl); }, [audioPreviewUrl]);

  useEffect(() => {
    const onPaste = (event) => {
      const pastedImage = getClipboardImageFile(event);
      if (!pastedImage) return;

      event.preventDefault();
      if (!videoFile) {
        setVideoFile(pastedImage);
        setPanel('media');
        notify('Pasted image as main clip', 'success');
        return;
      }

      setVideoFile2(pastedImage);
      setPanel('media');
      notify('Pasted image as second clip', 'success');
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [notify, videoFile]);

  useEffect(() => {
    setClips([]); setSelectedClipId(null); setTrimStart(0); setTrimEnd(0);
    setTrimReady(false); setResult(null); setPlaying(false); setAudioDuration(0); setAudioStart(0); setAudioEnd(0); setAudioOffset(0);
    setPrimaryZoom(1); setPrimaryPanX(0); setPrimaryPanY(0);
  }, [videoFile]);

  useEffect(() => {
    if (videoFile2) return;
    setSecondaryZoom(1);
    setSecondaryPanX(0);
    setSecondaryPanY(0);
  }, [videoFile2]);

  useEffect(() => {
    if (!previewUrl2) {
      setDuration2(0);
      return undefined;
    }
    if (secondaryIsImage) {
      setDuration2(Math.max(0.1, imageDuration2 || 5));
      return undefined;
    }
    const probeNode = document.createElement('video');
    probeNode.preload = 'metadata';
    probeNode.src = previewUrl2;
    const onLoaded = () => {
      const next = Number.isFinite(probeNode.duration) && probeNode.duration > 0 ? probeNode.duration : 0;
      setDuration2(next);
    };
    const onError = () => setDuration2(0);
    probeNode.addEventListener('loadedmetadata', onLoaded);
    probeNode.addEventListener('error', onError);
    return () => {
      probeNode.removeEventListener('loadedmetadata', onLoaded);
      probeNode.removeEventListener('error', onError);
      probeNode.src = '';
    };
  }, [previewUrl2, secondaryIsImage, imageDuration2]);

  useEffect(() => {
    if (!audioPreviewUrl) {
      setAudioDuration(0);
      setAudioStart(0);
      setAudioEnd(0);
      setAudioOffset(0);
      return undefined;
    }
    const audio = audioIsVideo ? document.createElement('video') : new Audio(audioPreviewUrl);
    audio.preload = 'metadata';
    audio.src = audioPreviewUrl;
    const onLoaded = () => {
      const nextDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      setAudioDuration(nextDuration);
      setAudioStart(0);
      setAudioEnd(Math.max(0.1, Math.min(nextDuration || Math.max(timelineDuration, 0.1), timelineDuration || nextDuration || 5)));
      setAudioOffset(0);
    };
    const onError = () => {
      setAudioDuration(0);
      setAudioStart(0);
      setAudioEnd(Math.max(0.1, timelineDuration || 5));
      setAudioOffset(0);
    };
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('error', onError);
    if (typeof audio.load === 'function') audio.load();
    return () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('error', onError);
      audio.src = '';
    };
  }, [audioPreviewUrl, timelineDuration, audioIsVideo]);

  useEffect(() => {
    if (!videoFile || !primaryIsImage) return undefined;
    const nextDuration = Math.max(0.1, imageDuration || 5);
    setDuration(nextDuration);
    setTrimStart(0);
    setTrimEnd(nextDuration);
    setTrimReady(true);
    setTime(0);
    return undefined;
  }, [videoFile, primaryIsImage, imageDuration]);

  function syncPreviewAudio(shouldPlay = false) {
    const videoNode = videoRef.current;
    const audioNode = audioRef.current;
    if (!videoNode || !audioNode || !audioPreviewUrl) return;

    const relativeVideoTime = Math.max(0, (videoNode.currentTime || trimStart) - trimStart);
    const audioTimelineStart = audioOffset;
    const audioTimelineEnd = audioOffset + audioClipDuration;
    const inRange = relativeVideoTime >= audioTimelineStart && relativeVideoTime < audioTimelineEnd && relativeVideoTime < timelineDuration;

    if (!inRange) {
      audioNode.pause();
      return;
    }

    const targetAudioTime = audioStart + Math.max(0, relativeVideoTime - audioTimelineStart);
    if (Math.abs((audioNode.currentTime || 0) - targetAudioTime) > 0.12) {
      audioNode.currentTime = targetAudioTime;
    }

    if (shouldPlay) {
      audioNode.play().catch(() => {});
    }
  }

  useEffect(() => {
    if (primaryIsImage) return undefined;
    const node = videoRef.current;
    if (!node) return;
    const onMeta = () => {
      const d = node.duration || 0; setDuration(d); setTime(0);
      if (!trimReady && d > 0) { setTrimStart(0); setTrimEnd(d); setTrimReady(true); }
    };
    const onTime = () => {
      if (trimReady && node.currentTime < trimStart) {
        node.currentTime = trimStart;
      }
      if (trimReady && node.currentTime >= effectiveTrimEnd - 0.01) {
        node.currentTime = effectiveTrimEnd;
        node.pause();
        audioRef.current?.pause();
      }
      setTime(node.currentTime || 0);
    };
    const onSeeked = () => {
      if (!trimReady) return;
      if (node.currentTime < trimStart) node.currentTime = trimStart;
      if (node.currentTime > effectiveTrimEnd) node.currentTime = effectiveTrimEnd;
      setTime(node.currentTime || 0);
      syncPreviewAudio(!node.paused);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      audioRef.current?.pause();
    };
    node.addEventListener('loadedmetadata', onMeta); node.addEventListener('timeupdate', onTime);
    node.addEventListener('seeked', onSeeked);
    node.addEventListener('play', onPlay); node.addEventListener('pause', onPause);
    return () => {
      node.removeEventListener('loadedmetadata', onMeta); node.removeEventListener('timeupdate', onTime);
      node.removeEventListener('seeked', onSeeked);
      node.removeEventListener('play', onPlay); node.removeEventListener('pause', onPause);
    };
  }, [previewUrl, trimReady, trimStart, effectiveTrimEnd, primaryIsImage]);

  useEffect(() => {
    if (primaryIsImage) return;
    const node = videoRef.current;
    if (!node || !trimReady) return;
    if (node.currentTime < trimStart || node.currentTime > effectiveTrimEnd) {
      node.pause();
      audioRef.current?.pause();
      node.currentTime = trimStart;
      setTime(trimStart);
    }
  }, [trimStart, effectiveTrimEnd, trimReady, primaryIsImage]);

  useEffect(() => {
    if (primaryIsImage) return undefined;
    const node = videoRef.current;
    if (!node || !playing || !trimReady) return undefined;
    let rafId = 0;
    const syncTrimBounds = () => {
      const current = node.currentTime || 0;
      if (current < trimStart) {
        node.currentTime = trimStart;
        setTime(trimStart);
      } else if (current >= effectiveTrimEnd - 0.002) {
        node.currentTime = effectiveTrimEnd;
        node.pause();
        setTime(effectiveTrimEnd);
        audioRef.current?.pause();
        return;
      } else {
        setTime(current);
        syncPreviewAudio(true);
      }
      rafId = window.requestAnimationFrame(syncTrimBounds);
    };
    rafId = window.requestAnimationFrame(syncTrimBounds);
    return () => window.cancelAnimationFrame(rafId);
  }, [playing, trimReady, trimStart, effectiveTrimEnd, primaryIsImage]);

  useEffect(() => {
    if (primaryIsImage) return;
    const node = videoRef.current;
    if (!node) return;
    node.playbackRate = speed;
    node.volume = audioPreviewUrl && replaceOriginalAudio ? 0 : originalAudioVolume;
    node.muted = audioPreviewUrl && replaceOriginalAudio ? true : false;
  }, [speed, originalAudioVolume, replaceOriginalAudio, audioPreviewUrl, primaryIsImage]);

  useEffect(() => {
    const audioNode = audioRef.current;
    if (!audioNode) return;
    audioNode.volume = musicVolume;
    audioNode.playbackRate = speed;
  }, [speed, musicVolume, audioPreviewUrl]);

  useEffect(() => {
    if (!playing) {
      audioRef.current?.pause();
      return;
    }
    syncPreviewAudio(true);
  }, [playing, audioPreviewUrl, audioStart, audioEnd, audioOffset, speed, musicVolume, replaceOriginalAudio]);

  useEffect(() => {
    if (!selectedClipId && clips.length) setSelectedClipId(clips[0].id);
    if (selectedClipId && !clips.some(c => c.id === selectedClipId)) setSelectedClipId(clips[0]?.id || null);
  }, [clips, selectedClipId]);

  useEffect(() => {
    if (!timelineDuration) return;
    setClips(prev => prev.map(clip => {
      const start = clamp(clip.start, 0, Math.max(0, timelineDuration - 0.1), clip.start);
      const end = clamp(clip.end, start + 0.1, timelineDuration, clip.end);
      return { ...clip, start, end };
    }));
  }, [timelineDuration]);

  // NOTE: audioEnd/audioStart are intentionally omitted from deps. This effect is only
  // meant to clamp/reset audio bounds when the *source* changes (file, probed duration,
  // or timeline length). Including them would create a set→trigger→re-set loop.
  useEffect(() => {
    if (!audioFile) {
      setAudioStart(0);
      setAudioEnd(0);
      setAudioOffset(0);
      return;
    }
    const maxSourceDuration = Math.max(0.1, audioDuration || timelineDuration || 5);
    const defaultWindow = Math.min(maxSourceDuration, Math.max(0.1, timelineDuration || 5));
    // Use purely functional setState so we never need the current values as closure deps.
    setAudioStart((prev) => clamp(prev, 0, Math.max(0, defaultWindow - 0.1), prev));
    setAudioEnd((prev) => {
      const nextEnd = prev || defaultWindow;
      return clamp(nextEnd, 0.1, maxSourceDuration, nextEnd);
    });
    // Clamp offset to ensure the audio window fits within the timeline.
    setAudioOffset((prev) => clamp(prev, 0, Math.max(0, timelineDuration - defaultWindow), prev));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioFile, audioDuration, timelineDuration]);

  const activeClips = clips.filter(clip => {
    const rel = Math.max(0, time - trimStart);
    return rel >= clip.start && rel <= clip.end;
  });

  function togglePlay() {
    if (primaryIsImage) return;
    const n = videoRef.current; if (!n) return;
    if (trimReady && (n.currentTime < trimStart || n.currentTime >= effectiveTrimEnd - 0.01)) {
      n.currentTime = trimStart;
      setTime(trimStart);
    }
    if (n.paused) {
      syncPreviewAudio(true);
      n.play();
    } else {
      n.pause();
      audioRef.current?.pause();
    }
  }

  function seekFromTimeline(e) {
    if (primaryIsImage) return;
    if (!videoRef.current || !visibleDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    videoRef.current.currentTime = trimStart + ratio * visibleDuration;
  }

  function addClip() {
    const start = timelineDuration > 0 ? clamp(time - trimStart, 0, Math.max(0, timelineDuration - 0.4), 0) : 0;
    const end = timelineDuration > 0 ? Math.min(timelineDuration, start + 2) : start + 2;
    const c = { id: newId(), text: `Caption ${clips.length + 1}`, start, end: Math.max(start + 0.3, end), position: 'bottom', fontSize: 64 };
    setClips(prev => [...prev, c].sort((a, b) => a.start - b.start));
    setSelectedClipId(c.id); setPanel('text');
  }

  function updateClip(patch, overrideId) {
    const targetId = overrideId || selectedClipId;
    if (!targetId) return;
    setClips(prev => prev.map(clip => {
      if (clip.id !== targetId) return clip;
      const s = patch.start !== undefined ? clamp(patch.start, 0, Math.max(0, timelineDuration - 0.1), clip.start) : clip.start;
      const e = patch.end !== undefined ? clamp(patch.end, s + 0.1, timelineDuration || s + 0.1, clip.end) : clip.end;
      return { ...clip, ...patch, start: s, end: e };
    }).sort((a, b) => a.start - b.start));
  }

  function removeClip() {
    if (!selectedClipId) return;
    setClips(prev => prev.filter(c => c.id !== selectedClipId));
  }

  function handleAudioClipUpdate(nextStart, nextEnd, mode) {
    const sourceDuration = Math.max(0.1, audioDuration || audioEnd || timelineDuration || 5);
    const currentDuration = Math.max(0.1, audioEnd - audioStart);
    if (mode === 'move') {
      const nextOffset = clamp(nextStart, 0, Math.max(0, timelineDuration - currentDuration), audioOffset);
      setAudioOffset(nextOffset);
      return;
    }
    if (mode === 'left') {
      const delta = nextStart - audioOffset;
      const nextAudioStart = clamp(audioStart + delta, 0, Math.max(0, audioEnd - 0.1), audioStart);
      const nextOffset = Math.max(0, nextStart);
      setAudioStart(nextAudioStart);
      setAudioOffset(nextOffset);
      return;
    }
    if (mode === 'right') {
      const nextDuration = Math.max(0.1, nextEnd - audioOffset);
      setAudioEnd(clamp(audioStart + nextDuration, audioStart + 0.1, sourceDuration, audioEnd));
    }
  }

  function resetAdjustments() {
    setSpeed(1);
    setBrightness(0);
    setContrast(1);
    setSaturation(1);
    setBlur(0);
    setWarmth(0);
    setSharpness(0);
    setVignette(0);
    setPrimaryZoom(1);
    setPrimaryPanX(0);
    setPrimaryPanY(0);
    setSecondaryZoom(1);
    setSecondaryPanX(0);
    setSecondaryPanY(0);
  }

  async function compose() {
    if (!videoFile) return notify('Add a clip first', 'error');
    setLoading(true); setResult(null);
    try {
      const fd = new FormData();
      fd.append('video', videoFile);
      if (videoFile2) fd.append('video2', videoFile2);
      if (audioFile) fd.append('audio', audioFile);
      if (primaryIsImage) fd.append('imageDuration', String(Math.max(0.1, imageDuration || 5)));
      if (secondaryIsImage) fd.append('imageDuration2', String(Math.max(0.1, imageDuration2 || 5)));
      fd.append('textClips', JSON.stringify(clips));
      fd.append('trimStart', String(trimStart)); fd.append('trimEnd', String(effectiveTrimEnd));
      fd.append('preset', preset); fd.append('speed', String(speed));
      fd.append('brightness', String(brightness)); fd.append('contrast', String(contrast));
      fd.append('saturation', String(saturation)); fd.append('blur', String(blur));
      fd.append('warmth', String(warmth));
      fd.append('sharpness', String(sharpness));
      fd.append('vignette', String(vignette));
      fd.append('primaryZoom', String(primaryZoom));
      fd.append('primaryPanX', String(primaryPanX));
      fd.append('primaryPanY', String(primaryPanY));
      fd.append('secondaryZoom', String(secondaryZoom));
      fd.append('secondaryPanX', String(secondaryPanX));
      fd.append('secondaryPanY', String(secondaryPanY));
      fd.append('musicVolume', String(musicVolume)); fd.append('originalAudioVolume', String(originalAudioVolume));
      fd.append('replaceOriginalAudio', String(replaceOriginalAudio));
      fd.append('audioStart', String(audioStart));
      fd.append('audioEnd', String(audioEnd));
      fd.append('audioOffset', String(audioOffset));
      const data = await videoComposeApi.compose(fd);
      setResult(data); setPanel('export');
      notify('Video composed and saved to gallery', 'success');
    } catch (err) {
      notify(err.message || 'Failed to compose', 'error');
    } finally { setLoading(false); }
  }

  const rulerTicks = useMemo(() => {
    if (!visibleDuration) return [];
    return Array.from({ length: 11 }, (_, i) => ({
      pct: (i / 10) * 100,
      label: stamp((i / 10) * timelineDuration),
    }));
  }, [timelineDuration]);

  async function openGalleryPicker(target = 'primary') {
    setLoading(true);
    try {
      const hist = await videoApi.history();
      setPickerItems(hist.filter(v => v.status === 'completed' && v.filename));
      pickerTargetRef.current = target;
      setPickerTarget(target);
      setPickerOpen(true);
    } catch (err) {
      notify('Failed to load gallery', 'error');
    } finally { setLoading(false); }
  }

  async function selectGalleryVideo(item) {
    setPickerOpen(false);
    setLoading(true);
    try {
      const res = await fetch(videoApi.fileUrl(item.filename));
      const blob = await res.blob();
      const file = new File([blob], item.filename, { type: blob.type || 'video/mp4' });
      const target = pickerTargetRef.current || pickerTarget;
      if (target === 'secondary') {
        setVideoFile2(file);
      } else {
        setVideoFile(file);
      }
    } catch (err) {
      notify('Failed to load selected video', 'error');
    } finally { setLoading(false); }
  }

  /* Render */
  return (
    <div className="flex flex-col bg-[#131313] text-zinc-100 rounded-xl border border-zinc-800/80 overflow-hidden animate-in" style={{ minHeight: 700, height: 'calc(100vh - 130px)' }}>

      {/* Top bar */}
      <header className="flex items-center justify-between px-5 py-2.5 border-b border-zinc-800 bg-[#1c1c1c] shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-zinc-100">Video Composer</h1>
          <p className="text-[10px] text-zinc-600">trim · captions · audio · effects</p>
        </div>
        <div className="flex items-center gap-2">
          {videoFile && duration > 0 && (
            <span className="text-[11px] font-mono text-zinc-500 tabular-nums">{timelineDuration.toFixed(2)}s</span>
          )}
          <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-0.5 text-[10px] text-zinc-500">9:16</span>
          <button onClick={compose} disabled={loading || !videoFile}
            className="flex items-center gap-1.5 rounded-lg bg-cyan-500 px-4 py-1.5 text-sm font-semibold text-black transition hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed">
            {loading ? <Spinner size={13} /> : null}
            {loading ? 'Rendering...' : 'Export'}
          </button>
        </div>
      </header>

      {/* Main row */}
      <div className="flex flex-1 min-h-0">

        {/* Left panel */}
        <aside className="w-64 shrink-0 border-r border-zinc-800 bg-[#1c1c1c] flex flex-col">
          {/* Tab row */}
          <div className="grid grid-cols-3 gap-1 border-b border-zinc-800 bg-zinc-900/40 p-2 shrink-0">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setPanel(t.id)}
                className={`min-w-0 rounded-lg px-2 py-2 text-[9px] font-semibold uppercase tracking-[0.12em] transition ${panel === t.id ? 'bg-cyan-500/12 text-cyan-300 shadow-[inset_0_-2px_0_rgba(34,211,238,0.85)]' : 'text-zinc-600 hover:bg-zinc-800/60 hover:text-zinc-300'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Panel body */}
          <div className="flex-1 overflow-y-auto p-3 space-y-4">

            {panel === 'media' && <>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/25 p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-600">Media</div>
                <div className="mt-1 text-[11px] text-zinc-500">Load a reel clip, trim it, then pick the look you want.</div>
              </div>
              <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-1">Source Clip</div>
              <DropZone label="Drop video or image here" accept="video/*,image/*" file={videoFile} onFile={setVideoFile} showGalleryPicker={() => openGalleryPicker('primary')} />
              {primaryIsImage && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
                  <FriendlySlider label="Still Duration" hint="main image" value={imageDuration} onChange={setImageDuration} min={1} max={20} step={0.5} formatter={(v) => `${v.toFixed(1)}s`} onReset={() => setImageDuration(5)} resetDisabled={Math.abs(imageDuration - 5) < 0.0001} />
                </div>
              )}
              <div className="text-[10px] uppercase tracking-widest text-zinc-600 mt-3 mb-1">Append Second Clip</div>
              <DropZone label="Drop second video or image here" accept="video/*,image/*" file={videoFile2} onFile={setVideoFile2} showGalleryPicker={() => openGalleryPicker('secondary')} />
              {secondaryIsImage && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
                  <FriendlySlider label="Still Duration" hint="second image" value={imageDuration2} onChange={setImageDuration2} min={1} max={20} step={0.5} formatter={(v) => `${v.toFixed(1)}s`} onReset={() => setImageDuration2(5)} resetDisabled={Math.abs(imageDuration2 - 5) < 0.0001} />
                </div>
              )}
              {videoFile2 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-3 text-[11px] text-zinc-500">
                  The second clip appends after the trimmed main clip during export.
                </div>
              )}
              {duration > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3 space-y-3">
                  <div className="text-[10px] uppercase tracking-widest text-zinc-600">Trim Range</div>
                  <Slider label="Start" value={trimStart} onChange={v => setTrimStart(clamp(v, 0, Math.max(0, effectiveTrimEnd - 0.1), trimStart))} min={0} max={Math.max(0.01, effectiveTrimEnd - 0.1)} step={0.05} />
                  <Slider label="End" value={effectiveTrimEnd} onChange={v => setTrimEnd(clamp(v, trimStart + 0.1, duration || v, effectiveTrimEnd))} min={trimStart + 0.1} max={duration || trimStart + 0.1} step={0.05} />
                </div>
              )}
              <div className="text-[10px] uppercase tracking-widest text-zinc-600 mt-2 mb-1">Color Preset</div>
              <div className="grid grid-cols-2 gap-1.5">
                {PRESETS.map(([id, label]) => (
                  <button key={id} onClick={() => setPreset(id)}
                    className={`rounded-lg py-1.5 text-xs font-medium transition border ${preset === id ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-300' : 'border-zinc-800 bg-zinc-900/40 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </>}

            {panel === 'text' && <>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/25 p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-600">Text Layers</div>
                <div className="mt-1 text-[11px] text-zinc-500">Create hook text and timed caption blocks, then position them on the reel.</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-widest text-zinc-600">Captions</div>
                <button onClick={addClip} className="rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 px-2.5 py-1 text-[11px] text-fuchsia-300 hover:bg-fuchsia-500/20 transition">+ Add</button>
              </div>
              <div className="space-y-1.5">
                {clips.length === 0 && (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 text-center text-[11px] text-zinc-600">
                    No captions yet.<br />Click &ldquo;+ Add&rdquo; to create one.
                  </div>
                )}
                {clips.map(clip => (
                  <button key={clip.id} onClick={() => setSelectedClipId(clip.id)}
                    className={`w-full rounded-xl border px-3 py-2 text-left transition ${clip.id === selectedClipId ? 'border-fuchsia-400/50 bg-fuchsia-500/10' : 'border-zinc-800 bg-zinc-900/30 hover:border-zinc-700'}`}>
                    <div className="text-xs font-medium text-zinc-200 truncate">{clip.text}</div>
                    <div className="text-[10px] text-zinc-600 mt-0.5">{stamp(clip.start)} {'->'} {stamp(clip.end)}</div>
                  </button>
                ))}
              </div>
              {selectedClip && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-600">Edit</div>
                    <button onClick={removeClip} className="text-[10px] text-zinc-700 hover:text-rose-400 transition">Remove</button>
                  </div>
                  <textarea value={selectedClip.text} onChange={e => updateClip({ text: e.target.value })}
                    rows={2} className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-950/60 px-2.5 py-2 text-xs text-zinc-100 focus:border-cyan-500/50 focus:outline-none" />
                  <Slider label="Clip Start" value={selectedClip.start} onChange={v => updateClip({ start: v })} min={0} max={Math.max(0, timelineDuration - 0.1)} step={0.05} />
                  <Slider label="Clip End" value={selectedClip.end} onChange={v => updateClip({ end: v })} min={selectedClip.start + 0.1} max={timelineDuration || selectedClip.start + 0.1} step={0.05} />
                  <Slider label="Font Size" value={selectedClip.fontSize} onChange={v => updateClip({ fontSize: v })} min={16} max={160} step={4} />
                  <div className="grid grid-cols-3 gap-1.5">
                    {POSITIONS.map(pos => (
                      <button key={pos} onClick={() => updateClip({ position: pos })}
                        className={`rounded-lg py-1.5 text-[10px] capitalize transition border ${selectedClip.position === pos ? 'border-fuchsia-400/50 bg-fuchsia-500/15 text-fuchsia-300' : 'border-zinc-800 bg-zinc-900/40 text-zinc-500 hover:border-zinc-700'}`}>
                        {pos}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>}

            {panel === 'audio' && <>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/25 p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-600">Audio</div>
                <div className="mt-1 text-[11px] text-zinc-500">Preview background music live, line it up by ear, then mix or replace the source audio.</div>
              </div>
              <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-1">Music Track</div>
              <DropZone label="Drop audio or video here" accept="audio/*,video/*" file={audioFile} onFile={setAudioFile} />
              {!audioFile && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-3 text-[11px] text-zinc-500">
                  Add a track to preview music live with the reel before exporting, or drop a video to use its audio.
                </div>
              )}
              {audioFile && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3 space-y-3">
                  <button onClick={() => setReplaceOriginalAudio(v => !v)}
                    className={`w-full rounded-lg py-1.5 text-[11px] font-medium border transition ${replaceOriginalAudio ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'}`}>
                    {replaceOriginalAudio ? 'Replace Original' : 'Mix With Original'}
                  </button>
                  <div className="text-[10px] text-zinc-600">
                    Segment: {stamp(audioStart)} {'->'} {stamp(audioEnd)} at {stamp(audioOffset)}
                  </div>
                  <Slider label="Music Volume" value={musicVolume} onChange={setMusicVolume} min={0} max={2} step={0.05} />
                  <Slider label="Original Volume" value={originalAudioVolume} onChange={setOriginalAudioVolume} min={0} max={2} step={0.05} />
                </div>
              )}
            </>}

            {panel === 'adjust' && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-zinc-600">Adjustments</div>
                    <div className="text-[11px] text-zinc-500">Fine-tune the look, then reset when you want a clean slate.</div>
                  </div>
                  <button
                    type="button"
                    onClick={resetAdjustments}
                    className="rounded-lg border border-zinc-700 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
                  >
                    Reset All
                  </button>
                </div>
                <FriendlySlider label="Speed" hint="pace" value={speed} onChange={setSpeed} min={0.5} max={2} step={0.05} formatter={(v) => `${v.toFixed(2)}x`} onReset={() => setSpeed(1)} resetDisabled={Math.abs(speed - 1) < 0.0001} />
                <FriendlySlider label="Exposure" hint="light" value={brightness} onChange={setBrightness} min={-0.4} max={0.4} step={0.01} formatter={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`} onReset={() => setBrightness(0)} resetDisabled={Math.abs(brightness) < 0.0001} />
                <FriendlySlider label="Contrast" hint="pop" value={contrast} onChange={setContrast} min={0.5} max={1.8} step={0.01} formatter={(v) => `${Math.round(v * 100)}%`} onReset={() => setContrast(1)} resetDisabled={Math.abs(contrast - 1) < 0.0001} />
                <FriendlySlider label="Color" hint="richness" value={saturation} onChange={setSaturation} min={0} max={2} step={0.01} formatter={(v) => `${Math.round(v * 100)}%`} onReset={() => setSaturation(1)} resetDisabled={Math.abs(saturation - 1) < 0.0001} />
                <FriendlySlider label="Warmth" hint="cool to warm" value={warmth} onChange={setWarmth} min={-0.3} max={0.3} step={0.01} formatter={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`} onReset={() => setWarmth(0)} resetDisabled={Math.abs(warmth) < 0.0001} />
                <FriendlySlider label="Sharpness" hint="detail" value={sharpness} onChange={setSharpness} min={0} max={2} step={0.05} formatter={(v) => `${Math.round(v * 100)}%`} onReset={() => setSharpness(0)} resetDisabled={Math.abs(sharpness) < 0.0001} />
                <FriendlySlider label="Vignette" hint="edge focus" value={vignette} onChange={setVignette} min={0} max={1} step={0.01} formatter={(v) => `${Math.round(v * 100)}%`} onReset={() => setVignette(0)} resetDisabled={Math.abs(vignette) < 0.0001} />
                <FriendlySlider label="Soft Focus" hint="glow" value={blur} onChange={setBlur} min={0} max={4} step={0.1} formatter={(v) => `${v.toFixed(1)}px`} onReset={() => setBlur(0)} resetDisabled={Math.abs(blur) < 0.0001} />
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 space-y-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-zinc-600">Main Clip Framing</div>
                    <div className="text-[11px] text-zinc-500">Zoom in and nudge the shot until the crop feels right.</div>
                  </div>
                  <FriendlySlider label="Zoom" hint="main clip" value={primaryZoom} onChange={setPrimaryZoom} min={1} max={2.5} step={0.01} formatter={(v) => `${v.toFixed(2)}x`} onReset={() => setPrimaryZoom(1)} resetDisabled={Math.abs(primaryZoom - 1) < 0.0001} />
                  <FriendlySlider label="Horizontal" hint="left to right" value={primaryPanX} onChange={setPrimaryPanX} min={-1} max={1} step={0.01} formatter={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`} onReset={() => setPrimaryPanX(0)} resetDisabled={Math.abs(primaryPanX) < 0.0001} />
                  <FriendlySlider label="Vertical" hint="up to down" value={primaryPanY} onChange={setPrimaryPanY} min={-1} max={1} step={0.01} formatter={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`} onReset={() => setPrimaryPanY(0)} resetDisabled={Math.abs(primaryPanY) < 0.0001} />
                </div>
                {videoFile2 ? (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 space-y-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-widest text-zinc-600">Second Clip Framing</div>
                      <div className="text-[11px] text-zinc-500">Tune the appended clip so the export feels matched.</div>
                    </div>
                    <FriendlySlider label="Zoom" hint="second clip" value={secondaryZoom} onChange={setSecondaryZoom} min={1} max={2.5} step={0.01} formatter={(v) => `${v.toFixed(2)}x`} onReset={() => setSecondaryZoom(1)} resetDisabled={Math.abs(secondaryZoom - 1) < 0.0001} />
                    <FriendlySlider label="Horizontal" hint="left to right" value={secondaryPanX} onChange={setSecondaryPanX} min={-1} max={1} step={0.01} formatter={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`} onReset={() => setSecondaryPanX(0)} resetDisabled={Math.abs(secondaryPanX) < 0.0001} />
                    <FriendlySlider label="Vertical" hint="up to down" value={secondaryPanY} onChange={setSecondaryPanY} min={-1} max={1} step={0.01} formatter={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`} onReset={() => setSecondaryPanY(0)} resetDisabled={Math.abs(secondaryPanY) < 0.0001} />
                  </div>
                ) : null}
              </div>
            )}

            {panel === 'export' && (
              <div className="space-y-3">
                <div className="rounded-xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/10 to-zinc-900/60 p-3">
                  <div className="text-[10px] uppercase tracking-widest text-cyan-300/80">Ready To Export</div>
                  <div className="mt-1 text-[11px] text-zinc-400">Review the reel settings, then save it straight into your gallery.</div>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3 text-xs space-y-2">
                  <div className="flex justify-between text-zinc-500"><span>Duration</span><span className="text-zinc-200">{timelineDuration ? `${timelineDuration.toFixed(2)}s` : '--'}</span></div>
                  <div className="flex justify-between text-zinc-500"><span>Video Clips</span><span className="text-zinc-200">{videoFile2 ? '2' : '1'}</span></div>
                  <div className="flex justify-between text-zinc-500"><span>Captions</span><span className="text-zinc-200">{clips.length}</span></div>
                  <div className="flex justify-between text-zinc-500"><span>Preset</span><span className="text-zinc-200 capitalize">{preset}</span></div>
                  <div className="flex justify-between text-zinc-500"><span>Style Tweaks</span><span className="text-zinc-200">{[brightness, contrast - 1, saturation - 1, warmth, sharpness, vignette, blur].some(v => Math.abs(v) > 0.0001) ? 'Custom' : 'Default'}</span></div>
                  <div className="flex justify-between text-zinc-500"><span>Framing</span><span className="text-zinc-200">{[primaryZoom - 1, primaryPanX, primaryPanY, secondaryZoom - 1, secondaryPanX, secondaryPanY].some(v => Math.abs(v) > 0.0001) ? 'Custom' : 'Default'}</span></div>
                  <div className="flex justify-between text-zinc-500"><span>Speed</span><span className="text-zinc-200">{speed.toFixed(2)}x</span></div>
                  <div className="flex justify-between text-zinc-500"><span>Audio</span><span className="text-zinc-200">{audioFile ? (replaceOriginalAudio ? 'Replace' : 'Mix') : 'Original'}</span></div>
                </div>
                <button onClick={compose} disabled={loading || !videoFile}
                  className="w-full flex items-center justify-center gap-2 rounded-xl bg-cyan-500 py-3 text-sm font-semibold text-black shadow-[0_12px_32px_rgba(34,211,238,0.18)] transition hover:bg-cyan-400 disabled:opacity-40">
                  {loading ? <Spinner size={15} /> : null}
                  {loading ? 'Rendering...' : 'Compose & Save'}
                </button>
                {result?.localFilename && (
                  <div className="space-y-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-emerald-300/80">Saved To Gallery</div>
                        <div className="mt-1 text-[11px] text-zinc-400">Your reel export is ready to preview, open, or download.</div>
                      </div>
                      <div className="rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Done</div>
                    </div>
                    <video src={videoApi.fileUrl(result.localFilename)} controls className="w-full rounded-xl border border-zinc-800 bg-black" />
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={() => navigateTo('videoGallery')} className="rounded-lg border border-zinc-700 py-2 text-[11px] text-zinc-300 hover:border-zinc-600 transition">Open Gallery</button>
                      <button onClick={() => { const a = document.createElement('a'); a.href = videoApi.fileUrl(result.localFilename); a.download = result.localFilename; a.click(); }}
                        className="rounded-lg bg-zinc-700 py-2 text-[11px] text-zinc-100 hover:bg-zinc-600 transition">Download MP4</button>
                    </div>
                  </div>
                )}
              </div>
            )}

          </div>
        </aside>

        {/* Center: Preview + Timeline */}
        <div className="flex-1 flex flex-col min-h-0">

          {/* Preview */}
          <div className="flex-1 min-h-0 flex items-center justify-center bg-[#0d0d0d] relative overflow-hidden">
            {previewUrl ? (
              <div className="relative h-full max-h-full flex items-center justify-center" style={{ aspectRatio: '9 / 16' }}>
                {primaryIsImage ? (
                  <img src={previewUrl} alt="Primary clip preview" className="w-full h-full object-cover rounded-2xl" style={previewFilterStyle} />
                ) : (
                  <video ref={videoRef} src={previewUrl} className="w-full h-full object-cover rounded-2xl cursor-pointer" style={previewFilterStyle} onClick={togglePlay} />
                )}
                {previewVignetteStrength > 0.01 ? (
                  <div
                    className="absolute inset-0 rounded-2xl pointer-events-none"
                    style={{
                      background: `radial-gradient(circle at center, rgba(0,0,0,0) ${Math.max(25, 74 - previewVignetteStrength * 28).toFixed(1)}%, rgba(0,0,0,${(0.18 + previewVignetteStrength * 0.45).toFixed(3)}) 100%)`,
                    }}
                  />
                ) : null}
                {audioPreviewUrl ? <audio ref={audioRef} src={audioPreviewUrl} preload="metadata" className="hidden" /> : null}
                {/* Text overlays */}
                {activeClips.map(clip => (
                  <DraggableClip
                    key={clip.id}
                    clip={clip}
                    isSelected={clip.id === selectedClipId}
                    onSelect={() => { setSelectedClipId(clip.id); setPanel('text'); }}
                    onUpdate={(patch) => updateClip(patch, clip.id)}
                  />
                ))}
                {/* Play overlay */}
                {!primaryIsImage && !playing && (
                  <button onClick={togglePlay} className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all hover:bg-black/10 hover:opacity-100">
                    <div className="flex h-16 w-16 items-center justify-center rounded-full border border-white/20 bg-black/55 text-white backdrop-blur-sm shadow-lg">
                      <svg width="18" height="18" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                        <path d="M2 1.4C2 0.78 2.67 0.39 3.2 0.71L10.2 5.31C10.71 5.63 10.71 6.37 10.2 6.69L3.2 11.29C2.67 11.61 2 11.22 2 10.6V1.4Z" />
                      </svg>
                    </div>
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center text-center opacity-30" style={{ aspectRatio: '9 / 16', height: '80%' }}>
                <div className="text-3xl mb-4 font-mono">VIDEO</div>
                <div className="text-sm text-zinc-400">Add a video or image in the Media panel to start editing</div>
              </div>
            )}

            {/* Playback bar overlay */}
            {videoFile && duration > 0 && !primaryIsImage && (
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-5 pb-4 pt-10">
                <div className="flex items-center gap-3">
                  <button
                    onClick={togglePlay}
                    aria-label={playing ? 'Pause preview' : 'Play preview'}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/45 text-white transition hover:bg-black/65"
                  >
                    {playing ? (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                        <rect x="1" y="1" width="3" height="10" rx="0.8" />
                        <rect x="8" y="1" width="3" height="10" rx="0.8" />
                      </svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                        <path d="M2 1.4C2 0.78 2.67 0.39 3.2 0.71L10.2 5.31C10.71 5.63 10.71 6.37 10.2 6.69L3.2 11.29C2.67 11.61 2 11.22 2 10.6V1.4Z" />
                      </svg>
                    )}
                  </button>
                  <div
                    className="group relative flex-1 cursor-pointer py-3"
                    onClick={e => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const r = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                      if (videoRef.current) videoRef.current.currentTime = trimStart + r * visibleDuration;
                    }}
                  >
                    <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/15" />
                    <div className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-cyan-400 shadow-[0_0_16px_rgba(34,211,238,0.35)]" style={{ width: `${playheadPct}%` }} />
                    <div
                      className="absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-white bg-cyan-300 shadow-lg shadow-cyan-500/20 transition-transform group-hover:scale-110"
                      style={{ left: `calc(${playheadPct}% - 8px)` }}
                    />
                  </div>
                  <span className="min-w-[96px] text-right text-[11px] font-mono tabular-nums text-white/90 shrink-0">{stamp(displayTime)} / {stamp(timelineDuration)}</span>
                </div>
              </div>
            )}
          </div>

          {/* Timeline */}
          <div className="shrink-0 border-t border-zinc-800 bg-[#1a1a1a]" style={{ height: 200 }}>

            {/* Ruler */}
            <div className="flex bg-[#141414] border-b border-zinc-800 shrink-0 select-none">
              <div className="w-16 h-7 shrink-0 border-r border-zinc-800/60 bg-[#141414]" />
              <div className="flex-1 relative h-7 cursor-pointer overflow-hidden" onClick={seekFromTimeline}>
                <div className="absolute inset-y-0" style={laneInsetStyle}>
                  {rulerTicks.map((tick, i) => (
                    <div key={i} className="absolute top-0 flex flex-col items-start" style={{ left: `${tick.pct}%` }}>
                      <div className="w-px bg-zinc-700" style={{ height: i % 5 === 0 ? 10 : 6, marginTop: 4 }} />
                      {i % 2 === 0 && <span className="text-[9px] text-zinc-600 mt-0.5 pl-0.5 whitespace-nowrap">{tick.label.slice(3)}</span>}
                    </div>
                  ))}
                </div>
                {/* Playhead needle */}
                <div className="absolute top-0 bottom-0 pointer-events-none z-20 flex flex-col items-center" style={lanePlayheadStyle}>
                  <div className="w-0 h-0 border-l-[5px] border-r-[5px] border-t-[7px] border-l-transparent border-r-transparent border-t-cyan-400 mt-0.5 -translate-x-1/2" />
                  <div className="w-px flex-1 bg-cyan-400/80 -translate-x-1/2" />
                </div>
              </div>
            </div>

            {/* Tracks */}
            <div className="flex flex-col" style={{ height: 173 }}>

              {/* Video track */}
              <div className="flex border-b border-zinc-800/60 bg-[linear-gradient(180deg,rgba(255,255,255,0.015),rgba(255,255,255,0))]" style={{ height: 64 }}>
                <div className="w-16 shrink-0 border-r border-zinc-800/60 bg-[#161616] flex items-center justify-center">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.28em] text-zinc-600 [writing-mode:vertical-lr] rotate-180">Video</span>
                </div>
                <div className="flex-1 relative cursor-pointer bg-zinc-900/20" onClick={seekFromTimeline} data-timeline-track="true">
                  <div className="absolute inset-y-0" style={laneInsetStyle}>
                    {videoFile && (
                      <DraggableMediaClip
                        start={trimStart}
                        end={effectiveTrimEnd}
                        maxDuration={timelineDuration}
                        bgClass="bg-gradient-to-r from-cyan-900/90 via-cyan-800/70 to-cyan-900/90"
                        borderClass="border-cyan-600/40"
                        onUpdate={(s, e) => {
                          setTrimStart(clamp(s, 0, Math.max(0, e - 0.1), trimStart));
                          setTrimEnd(clamp(e, s + 0.1, duration || e, effectiveTrimEnd));
                        }}
                      >
                        <div className="absolute inset-0 flex">
                          {Array.from({ length: 16 }, (_, i) => (
                            <div key={i} className="h-full flex-1 border-r border-black/30 relative">
                              <div className="absolute top-1 left-0 right-0 flex justify-around">
                                {[0,1].map(j => <div key={j} className="w-1 h-1 rounded-sm bg-black/50" />)}
                              </div>
                              <div className="absolute bottom-1 left-0 right-0 flex justify-around">
                                {[0,1].map(j => <div key={j} className="w-1 h-1 rounded-sm bg-black/50" />)}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="absolute inset-0 flex items-center px-2 pointer-events-none">
                          <span className="text-[10px] text-cyan-200/70 font-medium truncate drop-shadow">{videoFile.name}{primaryIsImage ? ` · ${imageDuration.toFixed(1)}s` : ''}</span>
                        </div>
                      </DraggableMediaClip>
                    )}
                    {videoFile2 && secondVisibleDuration > 0 && (
                      <div
                        className="absolute inset-y-2 rounded-lg border border-cyan-400/40 bg-gradient-to-r from-cyan-700/50 via-cyan-600/35 to-cyan-700/50 overflow-hidden"
                        style={{
                          left: `${timelineDuration > 0 ? (visibleDuration / timelineDuration) * 100 : 0}%`,
                          width: `${timelineDuration > 0 ? (secondVisibleDuration / timelineDuration) * 100 : 0}%`,
                        }}
                      >
                        <div className="absolute inset-0 opacity-50">
                          <div className="absolute inset-0 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.08)_0_14px,transparent_14px_28px)]" />
                        </div>
                        <div className="absolute inset-0 flex items-center px-2 pointer-events-none">
                          <span className="text-[10px] text-cyan-100/75 font-medium truncate drop-shadow">{videoFile2.name}{secondaryIsImage ? ` · ${imageDuration2.toFixed(1)}s` : ''}</span>
                        </div>
                      </div>
                    )}
                    {!videoFile && <div className="absolute inset-0 flex items-center px-4 text-[10px] text-zinc-700">Add a source clip to begin</div>}
                  </div>
                  {/* Playhead */}
                  <div className="absolute inset-0 pointer-events-none z-10">
                    <div className="absolute top-0 bottom-0 w-px bg-cyan-400/70 -translate-x-1/2" style={lanePlayheadStyle} />
                  </div>
                </div>
              </div>

              {/* Text track */}
              <div className="flex border-b border-zinc-800/60 bg-[linear-gradient(180deg,rgba(255,255,255,0.01),rgba(255,255,255,0))]" style={{ height: 48 }}>
                <div className="w-16 shrink-0 border-r border-zinc-800/60 bg-[#161616] flex items-center justify-center">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.28em] text-zinc-600 [writing-mode:vertical-lr] rotate-180">Text</span>
                </div>
                <div className="flex-1 relative cursor-pointer bg-zinc-900/20" onClick={seekFromTimeline} data-timeline-track="true">
                  <div className="absolute inset-y-0" style={laneInsetStyle}>
                    {clips.map(clip => (
                      <DraggableTimelineClip
                        key={clip.id}
                        clip={clip}
                        timelineDuration={timelineDuration}
                        isSelected={clip.id === selectedClipId}
                        onSelect={() => { setSelectedClipId(clip.id); setPanel('text'); }}
                        onUpdate={(patch) => updateClip(patch, clip.id)}
                      />
                    ))}
                    {clips.length === 0 && <div className="absolute inset-0 flex items-center px-4 text-[10px] text-zinc-700">Add caption blocks from the Text tab</div>}
                  </div>
                  <div className="absolute inset-0 pointer-events-none z-10">
                    <div className="absolute top-0 bottom-0 w-px bg-cyan-400/70 -translate-x-1/2" style={lanePlayheadStyle} />
                  </div>
                </div>
              </div>

              {/* Audio track */}
              <div className="flex bg-[linear-gradient(180deg,rgba(255,255,255,0.008),rgba(255,255,255,0))]" style={{ height: 60 }}>
                <div className="w-16 shrink-0 border-r border-zinc-800/60 bg-[#161616] flex items-center justify-center">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.28em] text-zinc-600 [writing-mode:vertical-lr] rotate-180">Audio</span>
                </div>
                <div className="flex-1 relative cursor-pointer bg-zinc-900/20" onClick={seekFromTimeline} data-timeline-track="true">
                  <div className="absolute inset-y-0" style={laneInsetStyle}>
                    {audioFile ? (
                      <DraggableMediaClip
                        start={audioOffset}
                        end={audioOffset + audioClipDuration}
                        maxDuration={timelineDuration}
                        bgClass="bg-emerald-900/30"
                        borderClass="border-emerald-500/30"
                        onUpdate={handleAudioClipUpdate}
                      >
                        {/* Waveform bars */}
                        <div className="absolute inset-0 flex items-center gap-px px-1">
                          {Array.from({ length: 120 }, (_, i) => {
                            const h = Math.abs(Math.sin(i * 0.5) * Math.cos(i * 0.3) * 0.8 + 0.2) * 100;
                            return <div key={i} className="flex-1 rounded-full bg-emerald-400/50" style={{ height: `${h}%` }} />;
                          })}
                        </div>
                        <span className="relative z-10 text-[10px] text-emerald-300/70 font-medium truncate px-2 pointer-events-none drop-shadow">{audioFile.name}</span>
                      </DraggableMediaClip>
                    ) : (
                      <div className="absolute inset-0 flex items-center px-4 text-[10px] text-zinc-700">Add music from the Audio tab to preview and export it</div>
                    )}
                  </div>
                  <div className="absolute inset-0 pointer-events-none z-10">
                    <div className="absolute top-0 bottom-0 w-px bg-cyan-400/70 -translate-x-1/2" style={lanePlayheadStyle} />
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>

      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-8">
          <div className="bg-[#1c1c1c] w-full max-w-4xl max-h-full rounded-2xl border border-zinc-800 shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95">
            <div className="px-6 py-4 flex items-center justify-between border-b border-zinc-800 shrink-0">
              <h2 className="text-lg font-semibold">Select Video from Gallery</h2>
              <button onClick={() => setPickerOpen(false)} className="text-zinc-500 hover:text-zinc-300 px-3 py-1 text-2xl leading-none">&times;</button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 min-h-0">
              {pickerItems.length === 0 ? (
                <div className="text-center py-20 text-sm text-zinc-500">No videos found. Generate some in the Videos tab first!</div>
              ) : (
                <div className="grid grid-cols-3 gap-4">
                  {pickerItems.map(item => (
                    <button key={item.id} onClick={() => selectGalleryVideo(item)}
                      className="group relative aspect-[9/16] rounded-xl overflow-hidden border border-zinc-800 bg-black transition hover:border-cyan-500/50 hover:ring-2 hover:ring-cyan-500/20 text-left">
                      <video src={videoApi.fileUrl(item.filename)} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition" />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-3 pointer-events-none">
                        <div className="text-[10px] text-zinc-400 capitalize">{item.model || 'Video'}</div>
                        <div className="text-xs text-zinc-200 mt-1 line-clamp-2">{item.prompt || item.filename || 'Untitled'}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-zinc-800 flex justify-end shrink-0">
              <button onClick={() => setPickerOpen(false)} className="rounded-lg bg-zinc-800 px-5 py-2 text-sm text-zinc-300 hover:bg-zinc-700 transition">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function VideoComposePageRoot() {
  return (
    <CompositorErrorBoundary>
      <VideoComposePage />
    </CompositorErrorBoundary>
  );
}
