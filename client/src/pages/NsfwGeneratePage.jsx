import { useState, useRef, useEffect, useCallback } from 'react';
import { nsfwGenerate as api, loraPresets as presetsApi } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { useApp } from '../context/AppContext';
import { Card, Btn, Textarea, Spinner } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { ASPECT_RATIOS } from '../config/photoModes';

const _cache = { result: null, history: [], selectedPresetId: '', extraLoras: [], prompt: '', aspectRatio: '4:5' };

export default function NsfwGeneratePage() {
  const { notify } = useApp();
  const { loading, run } = useAsync();
  const busyRef = useRef(false);
  const { openLightbox, LightboxComponent } = useImageLightbox();

  const [prompt, setPrompt] = useState(_cache.prompt);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [result, setResult] = useState(_cache.result);
  const [history, setHistory] = useState(_cache.history);

  // Presets
  const [presets, setPresets] = useState([]);
  const [selectedPresetId, setSelectedPresetId] = useState(_cache.selectedPresetId);
  const [extraLoras, setExtraLoras] = useState(_cache.extraLoras);
  const [showSavePreset, setShowSavePreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetPath, setNewPresetPath] = useState('');
  const [newPresetScale, setNewPresetScale] = useState(1.0);

  // Variation mode
  const [varyPrompt, setVaryPrompt] = useState('');
  const [varyStrength, setVaryStrength] = useState(0.6);
  const [variations, setVariations] = useState([]);

  const sync = (k, v) => { _cache[k] = v; };

  const loadPresets = useCallback(async () => {
    try {
      const data = await presetsApi.list();
      setPresets(data || []);
    } catch {}
  }, []);

  useEffect(() => { loadPresets(); }, [loadPresets]);

  const selectedPreset = presets.find((p) => p.id === selectedPresetId) || null;

  const updateExtra = (idx, field, value) => {
    const next = [...extraLoras];
    next[idx] = { ...next[idx], [field]: value };
    setExtraLoras(next);
    sync('extraLoras', next);
  };

  const addExtra = () => {
    if (extraLoras.length >= 2) return;
    const next = [...extraLoras, { path: '', scale: 1.0 }];
    setExtraLoras(next);
    sync('extraLoras', next);
  };

  const removeExtra = (idx) => {
    const next = extraLoras.filter((_, i) => i !== idx);
    setExtraLoras(next);
    sync('extraLoras', next);
  };

  const buildLoras = () => {
    const all = [];
    if (selectedPreset) all.push({ path: selectedPreset.path, scale: selectedPreset.scale });
    for (const l of extraLoras) {
      if (l.path.trim()) all.push({ path: l.path.trim(), scale: l.scale });
    }
    return all.slice(0, 3);
  };

  const handleSavePreset = async () => {
    if (!newPresetName.trim() || !newPresetPath.trim()) { notify('Name and LoRA path are required', 'error'); return; }
    try {
      await presetsApi.create({ name: newPresetName.trim(), path: newPresetPath.trim(), scale: newPresetScale });
      await loadPresets();
      setNewPresetName(''); setNewPresetPath(''); setNewPresetScale(1.0); setShowSavePreset(false);
      notify('LoRA preset saved!', 'success');
    } catch { notify('Failed to save preset', 'error'); }
  };

  const handleDeletePreset = async (id) => {
    try {
      await presetsApi.remove(id);
      if (selectedPresetId === id) { setSelectedPresetId(''); sync('selectedPresetId', ''); }
      await loadPresets();
      notify('Preset deleted', 'success');
    } catch { notify('Failed to delete preset', 'error'); }
  };

  const handleGenerate = () => {
    if (busyRef.current) return;
    busyRef.current = true;
    run(async () => {
      if (!prompt.trim()) { notify('Enter a prompt', 'error'); return; }
      const data = await api.image({ prompt: prompt.trim(), aspectRatio, loras: buildLoras() });
      setResult(data);
      sync('result', data);
      setVariations([]);
      setHistory((h) => {
        const next = [{ imageId: data.imageId, galleryId: data.galleryId || data.imageId, mimeType: data.image?.mimeType, base64: data.image?.base64Data }, ...h].slice(0, 12);
        sync('history', next);
        return next;
      });
      notify('Image generated!', 'success');
    }).finally(() => { busyRef.current = false; });
  };

  const handleVary = () => {
    if (busyRef.current || !result?.image) return;
    busyRef.current = true;
    run(async () => {
      const varPrompt = varyPrompt.trim() || prompt.trim();
      if (!varPrompt) { notify('Enter a variation prompt', 'error'); return; }
      const data = await api.vary({
        imageBase64: result.image.base64Data, mimeType: result.image.mimeType,
        prompt: varPrompt, aspectRatio, strength: varyStrength, loras: buildLoras(),
      });
      setVariations((prev) => [...prev, data]);
      setHistory((h) => {
        const next = [{ imageId: data.imageId, galleryId: data.galleryId || data.imageId, mimeType: data.image?.mimeType, base64: data.image?.base64Data }, ...h].slice(0, 12);
        sync('history', next);
        return next;
      });
      notify('Variation created!', 'success');
    }).finally(() => { busyRef.current = false; });
  };

  const downloadImg = (img, prefix = 'wavespeed') => {
    const a = document.createElement('a');
    a.href = `data:${img.mimeType};base64,${img.base64Data}`;
    a.download = `${prefix}_${Date.now()}.png`;
    a.click();
  };

  const recentHistory = history.slice(1, 9).filter((h) => h?.imageId);

  return (
    <div className="flex gap-6 h-full">
      {/* Left panel — controls */}
      <div className="w-80 shrink-0 space-y-4 overflow-y-auto pr-2 pb-8">
        <Card className="p-4 space-y-4">
          {/* Prompt */}
          <div>
            <span className="text-xs text-zinc-400 font-medium block mb-1.5">Prompt</span>
            <Textarea
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); sync('prompt', e.target.value); }}
              placeholder="Describe the image you want to generate..."
              rows={5}
              className="w-full"
            />
          </div>

          {/* LoRA Model Preset */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400 font-medium">Character LoRA</span>
              <button type="button" onClick={() => setShowSavePreset(!showSavePreset)} className="text-xs text-purple-400 hover:text-purple-300 cursor-pointer">
                {showSavePreset ? 'Cancel' : '+ Save New'}
              </button>
            </div>
            <select
              value={selectedPresetId}
              onChange={(e) => { setSelectedPresetId(e.target.value); sync('selectedPresetId', e.target.value); }}
              className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-purple-500/70 focus:ring-1 focus:ring-purple-500/20 cursor-pointer"
            >
              <option value="">No character LoRA</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name} (scale: {p.scale})</option>
              ))}
            </select>
            {selectedPreset && (
              <div className="flex items-center justify-between bg-purple-900/20 rounded-lg px-3 py-2 border border-purple-800/30">
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-purple-300 font-medium block truncate">{selectedPreset.name}</span>
                  <span className="text-[10px] text-zinc-500 block truncate">{selectedPreset.path}</span>
                </div>
                <button type="button" onClick={() => handleDeletePreset(selectedPreset.id)} className="text-zinc-500 hover:text-red-400 text-xs ml-2 shrink-0 cursor-pointer" title="Delete preset">&times;</button>
              </div>
            )}
            {showSavePreset && (
              <div className="space-y-2 bg-zinc-800/40 rounded-lg p-3 border border-zinc-700/40">
                <input type="text" value={newPresetName} onChange={(e) => setNewPresetName(e.target.value)} placeholder="Preset name (e.g. Maria v2)" className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-purple-500/70 placeholder:text-zinc-600" />
                <input type="text" value={newPresetPath} onChange={(e) => setNewPresetPath(e.target.value)} placeholder="HuggingFace URL or model path" className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-purple-500/70 placeholder:text-zinc-600" />
                <div className="flex gap-2 items-center">
                  <div className="flex-1">
                    <input type="number" value={newPresetScale} onChange={(e) => setNewPresetScale(parseFloat(e.target.value) || 0)} min={0} max={4} step={0.1} className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-2 py-2 text-xs text-zinc-100 text-center outline-none focus:border-purple-500/70" />
                    <span className="text-[10px] text-zinc-500 block text-center mt-0.5">scale</span>
                  </div>
                  <Btn onClick={handleSavePreset} className="bg-purple-600 hover:bg-purple-500 text-xs px-3 py-2">Save</Btn>
                </div>
              </div>
            )}
          </div>

          {/* Extra LoRAs */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400 font-medium">Extra LoRAs ({extraLoras.length}/2)</span>
              {extraLoras.length < 2 && (
                <button type="button" onClick={addExtra} className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer">+ Add LoRA</button>
              )}
            </div>
            {extraLoras.map((lora, idx) => (
              <div key={idx} className="flex gap-2 items-start">
                <div className="flex-1">
                  <input type="text" value={lora.path} onChange={(e) => updateExtra(idx, 'path', e.target.value)} placeholder="HuggingFace URL or model path" className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 placeholder:text-zinc-600" />
                </div>
                <div className="w-20">
                  <input type="number" value={lora.scale} onChange={(e) => updateExtra(idx, 'scale', parseFloat(e.target.value) || 0)} min={0} max={4} step={0.1} className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-2 py-2 text-xs text-zinc-100 text-center outline-none focus:border-blue-500/70" />
                  <span className="text-[10px] text-zinc-500 block text-center mt-0.5">scale</span>
                </div>
                <button type="button" onClick={() => removeExtra(idx)} className="text-zinc-500 hover:text-red-400 text-xs mt-2 cursor-pointer">&times;</button>
              </div>
            ))}
            {extraLoras.length === 0 && <p className="text-[10px] text-zinc-500">Add style or pose LoRAs on top of your character</p>}
          </div>

          {/* Aspect Ratio */}
          <div>
            <span className="text-xs text-zinc-400 font-medium block mb-2">Aspect Ratio</span>
            <div className="flex flex-wrap gap-1.5">
              {ASPECT_RATIOS.map((ar) => (
                <button key={ar} onClick={() => { setAspectRatio(ar); sync('aspectRatio', ar); }} className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition cursor-pointer ${aspectRatio === ar ? 'bg-purple-600 text-white' : 'bg-zinc-700/60 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200'}`}>{ar}</button>
              ))}
            </div>
          </div>

          {/* Generate button */}
          <Btn onClick={handleGenerate} disabled={loading || !prompt.trim()} className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40">
            {loading && !result?.image ? <><Spinner size={14} /> Generating...</> : 'Generate (WaveSpeed)'}
          </Btn>
          <p className="text-[10px] text-zinc-500 text-center">$0.01 per image &middot; No safety filters &middot; Sub-second latency</p>
        </Card>

        {/* Variation controls */}
        {result?.image && (
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-purple-400">Create Variations</span>
              <span className="text-[10px] text-zinc-500">{variations.length} created</span>
            </div>
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Variation Prompt</span>
              <Textarea value={varyPrompt} onChange={(e) => setVaryPrompt(e.target.value)} placeholder="Change pose, outfit, angle... (leave empty to reuse original prompt)" rows={3} className="w-full" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-zinc-400 font-medium">Strength</span>
                <span className="text-xs text-zinc-500 font-mono">{varyStrength.toFixed(1)}</span>
              </div>
              <input type="range" min={0.1} max={1.0} step={0.05} value={varyStrength} onChange={(e) => setVaryStrength(parseFloat(e.target.value))} className="w-full accent-purple-500" />
              <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
                <span>Subtle (keep pose)</span>
                <span>Major (new pose)</span>
              </div>
            </div>
            <Btn onClick={handleVary} disabled={loading} className="w-full bg-purple-700 hover:bg-purple-600 disabled:opacity-40">
              {loading ? <><Spinner size={14} /> Creating...</> : 'Create Variation'}
            </Btn>
          </Card>
        )}
      </div>

      {/* Right panel — result + variations */}
      <div className="flex-1 min-w-0 overflow-y-auto pb-8">
        {result?.image ? (
          <div className="space-y-6">
            {/* Main result */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-zinc-300">Base Image</span>
              </div>
              <img
                src={`data:${result.image.mimeType};base64,${result.image.base64Data}`}
                alt="Generated"
                className="max-h-[60vh] w-auto mx-auto rounded-xl cursor-pointer border border-zinc-800/60"
                onClick={() => openLightbox(`data:${result.image.mimeType};base64,${result.image.base64Data}`)}
              />
              <div className="flex items-center gap-2 justify-center">
                <button type="button" onClick={() => downloadImg(result.image, 'wavespeed_base')} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-700/60 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-600 transition cursor-pointer">
                  Download PNG
                </button>
              </div>
            </div>

            {/* Variations grid */}
            {variations.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-purple-300">Variations ({variations.length})</span>
                  <button type="button" onClick={() => variations.forEach((v, i) => setTimeout(() => downloadImg(v.image, `wavespeed_var${i + 1}`), i * 200))} className="text-xs text-purple-400 hover:text-purple-300 cursor-pointer">Download All</button>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                  {variations.map((v, i) => (
                    <div key={v.imageId || i} className="group relative">
                      <img
                        src={`data:${v.image.mimeType};base64,${v.image.base64Data}`}
                        alt={`Variation ${i + 1}`}
                        className="w-full rounded-lg border border-zinc-800/60 cursor-pointer hover:border-purple-500/40 transition"
                        onClick={() => openLightbox(`data:${v.image.mimeType};base64,${v.image.base64Data}`)}
                      />
                      <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition">
                        <button type="button" onClick={() => downloadImg(v.image, `wavespeed_var${i + 1}`)} className="rounded-md bg-black/70 px-2 py-1 text-[10px] text-white backdrop-blur-sm cursor-pointer">Save</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
            {loading ? <Spinner size={24} /> : 'Enter a prompt and hit Generate'}
          </div>
        )}

        {/* History strip */}
        {recentHistory.length > 0 && (
          <div className="mt-6">
            <span className="text-xs text-zinc-400 font-medium block mb-2">Recent</span>
            <div className="flex gap-2 flex-wrap">
              {recentHistory.map((h) => (
                <img
                  key={h.imageId}
                  src={h.base64 ? `data:${h.mimeType};base64,${h.base64}` : `/api/gallery/${h.galleryId}/thumbnail`}
                  alt=""
                  className="w-16 h-16 rounded-lg object-cover border border-zinc-700/60 cursor-pointer hover:border-zinc-500 transition"
                  onClick={() => {
                    const src = h.base64 ? `data:${h.mimeType};base64,${h.base64}` : `/api/gallery/${h.galleryId}/download`;
                    openLightbox(src);
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <LightboxComponent />
    </div>
  );
}
