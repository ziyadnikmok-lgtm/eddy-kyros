import { useState, useRef, useCallback, useEffect } from 'react';
import { nanoBypass as api, gallery as galleryApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Textarea, Spinner, Badge } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';


const ASPECT_RATIOS = ['auto', '1:1', '9:16', '16:9', '4:5', '3:4', '2:3'];
const IMAGE_SIZES = ['1K', '2K', '4K'];

const LOCKED_MODEL = { id: 'flash', label: 'Flash 3.1', sublabel: 'gemini-3.1-flash', color: 'bg-blue-600 hover:bg-blue-500' };

const _cache = {
  prompt: '',
  model: 'flash',
  aspectRatio: 'auto',
  imageSize: '2K',
  temperature: 1.0,
};

function ImageSlot({ index, image, onAdd, onRemove }) {
  const inputRef = useRef(null);

  const handleDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) readFile(file);
  };

  const readFile = (file) => {
    const reader = new FileReader();
    reader.onload = () => onAdd(index, { base64: reader.result, mimeType: file.type, preview: reader.result });
    reader.readAsDataURL(file);
  };

  return (
    <div
      className={`relative rounded-xl border-2 border-dashed transition cursor-pointer group
        ${image ? 'border-zinc-600/60' : 'border-zinc-700/50 hover:border-zinc-500/60'}`}
      style={{ aspectRatio: '1/1' }}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      onClick={() => !image && inputRef.current?.click()}
    >
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />
      {image ? (
        <>
          <img src={image.preview} alt="" className="w-full h-full object-cover rounded-xl" />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(index); }}
            className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/70 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition cursor-pointer"
          >×</button>
          <div className="absolute bottom-1.5 left-1.5 bg-black/60 rounded-md px-1.5 py-0.5 text-[9px] text-zinc-300">IMG {index + 1}</div>
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-zinc-600">
          <span className="text-2xl">+</span>
          <span className="text-[10px]">Image {index + 1}</span>
        </div>
      )}
    </div>
  );
}

export default function NanoBypassPage() {
  const { notify } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();

  const [images, setImages] = useState([null, null, null, null, null]);
  const [prompt, setPrompt] = useState(_cache.prompt);
  const [model, setModel] = useState(_cache.model);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [imageSize, setImageSize] = useState(_cache.imageSize);
  const [temperature, setTemperature] = useState(_cache.temperature);

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);

  const busyRef = useRef(false);

  // Paste support
  useEffect(() => {
    const handler = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = () => {
            setImages((prev) => {
              const next = [...prev];
              const slot = next.findIndex((s) => !s);
              if (slot === -1) return prev;
              next[slot] = { base64: reader.result, mimeType: file.type, preview: reader.result };
              return next;
            });
          };
          reader.readAsDataURL(file);
          break;
        }
      }
    };
    window.addEventListener('paste', handler);
    return () => window.removeEventListener('paste', handler);
  }, []);

  const handleAdd = useCallback((index, img) => {
    setImages((prev) => { const next = [...prev]; next[index] = img; return next; });
  }, []);

  const handleRemove = useCallback((index) => {
    setImages((prev) => { const next = [...prev]; next[index] = null; return next; });
  }, []);

  const activeImages = images.filter(Boolean);

  const handleGenerate = async () => {
    if (busyRef.current) return;
    if (activeImages.length === 0) { notify('Add at least one image', 'error'); return; }
    if (!prompt.trim()) { notify('Enter a prompt describing the edit', 'error'); return; }

    busyRef.current = true;
    setLoading(true);
    setResult(null);

    // Update cache
    _cache.prompt = prompt;
    _cache.model = model;
    _cache.aspectRatio = aspectRatio;
    _cache.imageSize = imageSize;
    _cache.temperature = temperature;

    try {
      const data = await api.edit({
        images: activeImages.map((img) => ({ base64: img.base64, mimeType: img.mimeType })),
        prompt: prompt.trim(),
        model,
        aspectRatio,
        imageSize,
        temperature,
      });

      setResult(data);
      setHistory((h) => [data, ...h].slice(0, 12));
      notify('Done!', 'success');
    } catch (err) {
      notify(err.message || 'Generation failed', 'error');
    } finally {
      setLoading(false);
      busyRef.current = false;
    }
  };

  const downloadResult = () => {
    if (!result?.base64Data) return;
    const a = document.createElement('a');
    a.href = `data:image/png;base64,${result.base64Data}`;
    a.download = `nano-bypass-${Date.now()}.png`;
    a.click();
  };

  const saveToGallery = (item) => {
    if (item.galleryId) {
      notify('Already saved to gallery', 'info');
    }
  };

  return (
    <div className="flex gap-6 h-full">
      {/* Left panel */}
      <div className="w-80 shrink-0 space-y-4 overflow-y-auto pr-2 pb-8">

        <Card className="p-4 space-y-4">
          <div>
            <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-300 block">Locked Model</span>
                  <div className="mt-1 text-sm font-semibold text-zinc-100">{LOCKED_MODEL.label}</div>
                  <div className="text-[10px] font-mono text-blue-200/80 mt-0.5">{LOCKED_MODEL.sublabel}</div>
                </div>
                <Badge color="blue">Bypass Safe</Badge>
              </div>
              <p className="mt-2 text-[11px] text-blue-100/85">
                Nano Bypass only works reliably on Gemini 3.1 Flash. Pro has been disabled for this tool.
              </p>
            </div>
          </div>

          {/* Images grid */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-zinc-400 font-medium">Images ({activeImages.length}/5)</span>
              <span className="text-[10px] text-zinc-600">Paste or drop</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {images.map((img, i) => (
                <ImageSlot key={i} index={i} image={img} onAdd={handleAdd} onRemove={handleRemove} />
              ))}
            </div>
          </div>

          {/* Prompt */}
          <div>
            <span className="text-xs text-zinc-400 font-medium block mb-1.5">Edit Prompt</span>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what you want to do with the image(s)..."
              rows={4}
              className="w-full"
            />
          </div>

          {/* Aspect ratio */}
          <div>
            <span className="text-xs text-zinc-400 font-medium block mb-2">Aspect Ratio</span>
            <div className="flex flex-wrap gap-1.5">
              {ASPECT_RATIOS.map((ar) => (
                <button
                  key={ar}
                  type="button"
                  onClick={() => setAspectRatio(ar)}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition cursor-pointer
                    ${aspectRatio === ar ? 'bg-blue-600 text-white' : 'bg-zinc-700/60 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200'}`}
                >
                  {ar}
                </button>
              ))}
            </div>
          </div>

          {/* Image size */}
          <div>
            <span className="text-xs text-zinc-400 font-medium block mb-2">Output Size</span>
            <div className="flex gap-2">
              {IMAGE_SIZES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setImageSize(s)}
                  className={`flex-1 rounded-md py-1.5 text-xs font-medium transition cursor-pointer
                    ${imageSize === s ? 'bg-blue-600 text-white' : 'bg-zinc-700/60 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200'}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Temperature */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-zinc-400 font-medium">Creativity</span>
              <span className="text-xs text-zinc-500 font-mono">{temperature.toFixed(1)}</span>
            </div>
            <input
              type="range" min={0.0} max={2.0} step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(parseFloat(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
              <span>Precise</span>
              <span>Creative</span>
            </div>
          </div>

          <Btn
            onClick={handleGenerate}
            disabled={loading || activeImages.length === 0 || !prompt.trim()}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40"
          >
            {loading ? <><Spinner size={14} /> Bypassing...</> : '⚡ Nano Bypass'}
          </Btn>
          <p className="text-[10px] text-zinc-500 text-center">Powered by Gemini 3 image editing</p>
        </Card>
      </div>

      {/* Right panel */}
      <div className="flex-1 min-w-0 overflow-y-auto pb-8 space-y-6">

        {loading && (
          <Card className="flex items-center justify-center py-20">
            <div className="text-center space-y-3">
              <Spinner size={32} />
              <p className="text-sm text-zinc-400">Nano Bypass processing...</p>
              <p className="text-xs text-zinc-600">Model: {LOCKED_MODEL.sublabel}</p>
            </div>
          </Card>
        )}

        {!loading && result && (
          <Card className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-300">Result</h3>
              <div className="flex items-center gap-2">
                <Badge color="blue">{LOCKED_MODEL.label}</Badge>
                {result.galleryId && <Badge color="green">Saved</Badge>}
              </div>
            </div>
            <img
              src={`data:image/png;base64,${result.base64Data}`}
              alt="Nano Bypass result"
              className="w-full rounded-xl border border-zinc-700/60 cursor-pointer"
              onClick={() => openLightbox([`data:image/png;base64,${result.base64Data}`])}
            />
            <div className="flex gap-2">
              <Btn onClick={downloadResult} className="flex-1 bg-zinc-700 hover:bg-zinc-600">
                Download PNG
              </Btn>
              <Btn
                variant="ghost"
                onClick={() => { setResult(null); }}
                className="flex-1"
              >
                Clear
              </Btn>
            </div>
          </Card>
        )}

        {!loading && !result && (
          <Card className="flex flex-col items-center justify-center py-20 space-y-3">
            <div className="text-4xl">⚡</div>
            <p className="text-sm font-medium text-zinc-400">Nano Bypass</p>
            <p className="text-xs text-zinc-600 text-center max-w-xs">
              Upload up to 5 images + a prompt. Gemini edits them directly — combine, transform, reimagine.
            </p>
          </Card>
        )}

        {/* History */}
        {history.length > 1 && (
          <div>
            <span className="text-xs text-zinc-400 font-medium block mb-2">Recent</span>
            <div className="grid grid-cols-3 lg:grid-cols-4 gap-2">
              {history.slice(1).map((h, i) => (
                <div key={i} className="relative group rounded-lg overflow-hidden border border-zinc-700/40 cursor-pointer"
                  onClick={() => openLightbox([`data:image/png;base64,${h.base64Data}`])}>
                  <img
                    src={`data:image/png;base64,${h.base64Data}`}
                    alt=""
                    className="w-full aspect-square object-cover"
                  />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition" />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <LightboxComponent />
    </div>
  );
}
