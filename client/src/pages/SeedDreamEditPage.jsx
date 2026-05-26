import { useState, useCallback, useRef, useEffect } from 'react';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { seedDreamEdit as api } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Badge } from '../components/UI';
import { makePersistentJobId } from '../lib/persistentPageState';

const ASPECT_RATIOS = ['1:1', '4:5', '9:16', '16:9', '3:4', '4:3'];

const PRESET_PROMPTS = [
  'Change the outfit to a red dress',
  'Replace background with a beach sunset',
  'Change hair color to blonde',
  'Add dramatic cinematic lighting',
  'Put her in business casual attire',
  'Add a neon city background at night',
  'Change outfit to a white bikini',
  'Natural outdoor lighting look',
  'Make the breasts larger',
];

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export default function SeedDreamEditPage() {
  const { notify } = useApp();
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  const [files, setFiles] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [guidanceScale, setGuidanceScale] = useState(3.5);
  const [isGenerating, setIsGenerating] = useState(false);
  const [results, setResults] = useState([]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      files.forEach(f => { try { URL.revokeObjectURL(f.previewUrl); } catch {} });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = useCallback((incoming) => {
    const arr = Array.from(incoming || []);
    const valid = arr.filter(f => f.type && f.type.startsWith('image/'));
    if (valid.length === 0) return;
    setFiles(prev => {
      const next = [...prev];
      for (const f of valid) {
        if (next.length >= 4) break;
        const previewUrl = URL.createObjectURL(f);
        next.push({ file: f, previewUrl, id: `${f.name}-${Date.now()}-${Math.random()}` });
      }
      return next;
    });
  }, []);

  const removeFile = useCallback((id) => {
    setFiles(prev => {
      const entry = prev.find(f => f.id === id);
      try { if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl); } catch {}
      return prev.filter(f => f.id !== id);
    });
  }, []);

  const onDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e) => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer?.files); };
  const handleFileInput = (e) => { addFiles(e.target.files); e.target.value = ''; };

  const handleGenerate = async () => {
    if (files.length === 0) { notify('Add at least one source image', 'error'); return; }
    if (!prompt.trim()) { notify('Enter an edit prompt', 'error'); return; }

    const queueId = makePersistentJobId('seed-dream');
    pushPending({ id: queueId, prompt: prompt.trim(), imageModel: 'SeedDream v4.5', aspectRatio });
    setIsGenerating(true);
    setResults([]);

    try {
      const imageInputs = await Promise.all(files.map(async ({ file }) => {
        const dataUri = await fileToBase64(file);
        const base64 = dataUri.split(',')[1];
        return { base64, mimeType: file.type };
      }));

      const data = await api.edit({
        images: imageInputs,
        prompt: prompt.trim(),
        aspectRatio,
        guidanceScale,
      });

      setResults(data.images || []);
      resolvePending(queueId, {
        imageId: data.images?.[0]?.imageId,
        galleryId: data.images?.[0]?.galleryId,
        mimeType: data.images?.[0]?.mimeType,
        prompt: prompt.trim(),
        imageModel: 'SeedDream v4.5',
        aspectRatio,
        generatedAt: Date.now(),
      });
      notify(`${data.images?.length || 1} image${(data.images?.length || 1) > 1 ? 's' : ''} edited!`, 'success');
    } catch (err) {
      rejectPending(queueId);
      notify(err?.message || 'Edit failed', 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="flex gap-6 h-full">
      {/* Controls panel */}
      <div className="w-80 shrink-0 space-y-4 overflow-y-auto pr-2 pb-8">

        {/* Model badge */}
        <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2.5 flex items-center justify-between">
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-violet-300 block">WaveSpeed</span>
            <div className="text-sm font-semibold text-zinc-100 mt-0.5">SeedDream v4.5</div>
            <div className="text-[10px] font-mono text-violet-200/70">edit-sequential · $0.04/img</div>
          </div>
          <Badge color="blue">Identity Lock</Badge>
        </div>

        {/* Source images */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-300 font-semibold">Source Images ({files.length}/4)</span>
            {files.length > 0 && (
              <button type="button" onClick={() => {
                files.forEach(f => { try { URL.revokeObjectURL(f.previewUrl); } catch {} });
                setFiles([]);
                setResults([]);
              }} className="text-[10px] text-zinc-600 hover:text-red-400 transition cursor-pointer">
                Clear all
              </button>
            )}
          </div>

          {/* Drop zone */}
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl cursor-pointer transition-all min-h-[72px] px-3 py-4 text-center ${
              isDragging ? 'border-violet-500/80 bg-violet-500/10' : 'border-zinc-700/80 hover:border-zinc-500 hover:bg-zinc-800/30'
            }`}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-600">
              <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
            </svg>
            <div>
              <p className="text-sm text-zinc-400 font-medium">Drop photos or click to browse</p>
              <p className="text-[10px] text-zinc-600 mt-0.5">PNG · JPEG · WebP · up to 4 images</p>
            </div>
          </div>
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={handleFileInput} />

          {/* Image previews */}
          {files.length > 0 && (
            <div className="grid grid-cols-4 gap-1.5">
              {files.map(({ id, previewUrl, file: f }) => (
                <div key={id} className="relative group aspect-square rounded-lg overflow-hidden border border-zinc-700/60 bg-zinc-900">
                  <img src={previewUrl} alt={f.name} className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeFile(id)}
                    className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 text-zinc-300 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-[10px] font-bold hover:bg-red-500/80 hover:text-white cursor-pointer"
                  >×</button>
                </div>
              ))}
              {files.length < 4 && (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="aspect-square rounded-lg border-2 border-dashed border-zinc-700/60 hover:border-zinc-500 bg-zinc-900/40 flex items-center justify-center cursor-pointer transition"
                >
                  <span className="text-zinc-600 text-lg font-light">+</span>
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Edit prompt */}
        <Card className="space-y-3">
          <span className="text-xs text-zinc-400 font-medium block">Edit Instruction</span>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="What to change… e.g. 'Change the outfit to a red dress'"
            rows={3}
            className="w-full resize-none rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-violet-500/70 transition"
          />
          {/* Presets */}
          <div className="flex flex-wrap gap-1">
            {PRESET_PROMPTS.map(p => (
              <button
                key={p}
                type="button"
                onClick={() => setPrompt(p)}
                className="text-[10px] rounded-full px-2 py-0.5 border border-zinc-700/60 bg-zinc-800/60 text-zinc-500 hover:border-violet-500/50 hover:text-violet-300 hover:bg-violet-500/10 transition cursor-pointer"
              >
                {p}
              </button>
            ))}
          </div>
        </Card>

        {/* Settings */}
        <Card className="space-y-3">
          <span className="text-xs text-zinc-400 font-medium block">Settings</span>

          <div>
            <span className="text-[11px] text-zinc-500 block mb-1.5">Aspect Ratio</span>
            <div className="flex flex-wrap gap-1">
              {ASPECT_RATIOS.map(ar => (
                <button key={ar} type="button" onClick={() => setAspectRatio(ar)}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition cursor-pointer ${aspectRatio === ar ? 'bg-violet-600 text-white' : 'bg-zinc-700/60 text-zinc-400 hover:bg-zinc-600'}`}>
                  {ar}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] text-zinc-500">Guidance Scale</span>
              <span className="text-[11px] font-mono text-zinc-400">{guidanceScale.toFixed(1)}</span>
            </div>
            <input type="range" min="1" max="10" step="0.5" value={guidanceScale}
              onChange={e => setGuidanceScale(Number(e.target.value))}
              className="w-full accent-violet-500 h-1.5 rounded-full appearance-none bg-zinc-700 cursor-pointer" />
            <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
              <span>Creative</span><span>Precise</span>
            </div>
          </div>
        </Card>

        {/* Generate */}
        <Btn
          onClick={handleGenerate}
          disabled={isGenerating || files.length === 0 || !prompt.trim()}
          className="w-full"
        >
          {isGenerating ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Editing with SeedDream…
            </span>
          ) : `✦ Edit ${files.length > 1 ? `${files.length} Images` : 'Image'}`}
        </Btn>

        <p className="text-[10px] text-zinc-600 text-center">
          Powered by WaveSpeed · bytedance/seedream-v4.5 · Identity locked across all shots
        </p>

        {/* Inline results (also appear in feed) */}
        {results.length > 0 && (
          <div className="space-y-2">
            <span className="text-xs text-zinc-400 font-medium block">Results</span>
            <div className="grid grid-cols-2 gap-2">
              {results.map((img, i) => (
                <div key={i} className="relative group rounded-xl overflow-hidden border border-zinc-700/60 bg-zinc-900 aspect-square">
                  <img
                    src={`data:${img.mimeType};base64,${img.base64Data}`}
                    alt={`Result ${i + 1}`}
                    className="w-full h-full object-cover"
                  />
                  <a
                    href={`data:${img.mimeType};base64,${img.base64Data}`}
                    download={`seeddream-${i + 1}.png`}
                    onClick={e => e.stopPropagation()}
                    className="absolute bottom-1 right-1 opacity-0 group-hover:opacity-100 transition bg-black/60 rounded-md px-1.5 py-0.5 text-[10px] text-white"
                  >
                    ↓
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
