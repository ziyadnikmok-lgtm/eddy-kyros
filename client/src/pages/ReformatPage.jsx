import { useState, useEffect } from 'react';
import { gallery as galleryApi, reformat as reformatApi } from '../services/api';
import { Card, Btn, Spinner } from '../components/UI';
import { downloadBlob } from '../lib/stripMetadata';

const RATIOS = [
  { value: '9:16', label: '9:16', desc: 'Story / Reel', icon: '▯' },
  { value: '4:5', label: '4:5', desc: 'Feed Post', icon: '▮' },
  { value: '1:1', label: '1:1', desc: 'Square', icon: '■' },
  { value: '16:9', label: '16:9', desc: 'Landscape', icon: '▬' },
  { value: '3:4', label: '3:4', desc: 'Portrait', icon: '▮' },
];

export default function ReformatPage() {
  const [images, setImages] = useState([]);
  const [loadingGallery, setLoadingGallery] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [targetRatio, setTargetRatio] = useState('9:16');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    galleryApi.list({ limit: 50 })
      .then(r => setImages(r.images || r || []))
      .catch(() => setImages([]))
      .finally(() => setLoadingGallery(false));
  }, []);

  const selectedImage = images.find(i => i.id === selectedId);
  const selectedSrc = selectedId ? `/api/gallery/${selectedId}/thumb` : null;

  async function handleConvert() {
    if (!selectedId) return;
    setRunning(true); setError(''); setResult(null);
    try {
      const data = await reformatApi.convert({ imageId: selectedId, targetRatio });
      setResult(data);
    } catch (e) {
      setError(e?.message || 'Generation failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6 animate-in overflow-x-hidden">
      <div>
        <h1 className="text-lg font-semibold text-zinc-100">Reformat</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Convert an image to a different aspect ratio — AI extends the background naturally</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
        {/* Left — settings */}
        <div className="lg:col-span-1 space-y-4">
          <Card className="space-y-4">
            {/* Source image picker */}
            <div>
              <span className="text-xs font-medium text-zinc-400 block mb-2">Source Image</span>
              {loadingGallery ? (
                <div className="flex justify-center py-6"><Spinner /></div>
              ) : (
                <div className="grid grid-cols-2 auto-rows-[100px] gap-2 max-h-[50vh] overflow-y-auto rounded-xl border border-zinc-800 bg-[#111] p-2">
                  {images.map(img => {
                    const isSelected = selectedId === img.id;
                    return (
                      <button
                        key={img.id}
                        onClick={() => { setSelectedId(img.id); setResult(null); }}
                        className={`w-full h-full overflow-hidden rounded-lg border transition duration-150 ${isSelected ? 'border-rose-500 ring-1 ring-rose-500/40' : 'border-zinc-800 hover:border-zinc-600'}`}
                      >
                        <img src={`/api/gallery/${img.id}/thumb`} alt="" className="w-full h-full object-cover" loading="lazy" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Target ratio */}
            <div>
              <span className="text-xs font-medium text-zinc-400 block mb-2">Target Format</span>
              <div className="grid grid-cols-2 gap-2">
                {RATIOS.map(r => (
                  <button
                    key={r.value}
                    onClick={() => setTargetRatio(r.value)}
                    className={`flex flex-col items-center justify-center rounded-xl border py-3 px-2 text-center transition cursor-pointer ${targetRatio === r.value ? 'border-rose-500 bg-rose-600/10 text-rose-400' : 'border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'}`}
                  >
                    <span className="text-lg leading-none mb-1">{r.icon}</span>
                    <span className="text-xs font-semibold">{r.label}</span>
                    <span className="text-[0.625rem] text-zinc-500 mt-0.5">{r.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <Btn
              onClick={handleConvert}
              disabled={!selectedId || running}
              className="w-full"
            >
              {running ? 'Converting…' : 'Convert'}
            </Btn>

            {error && (
              <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">{error}</div>
            )}
          </Card>
        </div>

        {/* Right — preview */}
        <div className="lg:col-span-2 space-y-4">
          {/* Source preview */}
          {selectedSrc && (
            <Card>
              <span className="text-xs font-medium text-zinc-400 block mb-2">Source</span>
              <div className="rounded-xl overflow-hidden border border-zinc-800 bg-zinc-950">
                <img src={selectedSrc} alt="source" className="w-full max-h-[40vh] object-contain" />
              </div>
            </Card>
          )}

          {/* Result */}
          {running && (
            <Card>
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <Spinner />
                <p className="text-sm text-zinc-400 animate-pulse">Extending image to {targetRatio}…</p>
              </div>
            </Card>
          )}

          {result && !running && (
            <Card className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-400">Result — {targetRatio}</span>
                <span className="text-[0.625rem] text-green-400 bg-green-500/10 border border-green-500/20 rounded px-2 py-0.5">✓ Saved to gallery</span>
              </div>
              <div className="rounded-xl overflow-hidden border border-zinc-800 bg-zinc-950">
                <img
                  src={`data:${result.image?.mimeType || 'image/png'};base64,${result.image?.base64Data}`}
                  alt="reformatted"
                  className="w-full object-contain"
                />
              </div>
              <Btn
                variant="secondary"
                className="w-full"
                onClick={async () => {
                  const src = `data:${result.image?.mimeType || 'image/png'};base64,${result.image?.base64Data}`;
                  const blob = await (await fetch(src)).blob();
                  await downloadBlob(blob, `reformat-${targetRatio.replace(':', 'x')}-${Date.now()}.png`);
                }}
              >
                Download
              </Btn>
            </Card>
          )}

          {!selectedId && !running && !result && (
            <Card>
              <div className="flex flex-col items-center justify-center py-16 text-center gap-2">
                <span className="text-3xl">⊞</span>
                <p className="text-sm text-zinc-400">Select a source image to get started</p>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
