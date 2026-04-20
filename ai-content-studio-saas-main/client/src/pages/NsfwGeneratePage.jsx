import { useState, useEffect, useCallback } from 'react';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { nsfwGenerate as api, loraPresets as presetsApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Textarea, Spinner, Badge } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { useStepTimer } from '../hooks/useStepTimer';
import { ASPECT_RATIOS } from '../config/photoModes';

const NSFW_QUEUE_STORAGE_KEY = 'kyros.nsfwGenerate.queueItems';
const NSFW_PRESETS_STORAGE_KEY = 'kyros.nsfwGenerate.presets';
const PHOTO_MATCH_HANDOFF_KEY = 'kyros.photoMatch.handoff';
const NANO_BYPASS_HANDOFF_KEY = 'kyros.nanoBypass.handoff';

function normalizeLookupValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function resolveCharacterIdFromPreset(preset, characters) {
  if (!preset?.name || !Array.isArray(characters) || characters.length === 0) return '';
  const presetName = normalizeLookupValue(preset.name);
  if (!presetName) return '';

  const exact = characters.find((character) => normalizeLookupValue(character?.name) === presetName);
  if (exact?.id) return exact.id;

  const partial = characters.find((character) => {
    const characterName = normalizeLookupValue(character?.name);
    return characterName && (presetName.includes(characterName) || characterName.includes(presetName));
  });
  return partial?.id || '';
}

function writeHandoff(key, payload) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Ignore storage failures; navigate params still carry the same payload.
  }
}

function readStoredQueueItems() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(NSFW_QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readStoredPresets() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(NSFW_PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredPresets(items) {
  if (typeof window === 'undefined') return;
  try {
    if (!items || items.length === 0) {
      window.localStorage.removeItem(NSFW_PRESETS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(NSFW_PRESETS_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Ignore storage failures and keep in-memory behavior.
  }
}

function writeStoredQueueItems(items) {
  if (typeof window === 'undefined') return;
  try {
    if (!items || items.length === 0) {
      window.sessionStorage.removeItem(NSFW_QUEUE_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(NSFW_QUEUE_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Ignore storage failures and keep in-memory behavior.
  }
}

const _cache = {
  result: null,
  history: [],
  queueItems: readStoredQueueItems(),
  variations: [],
  selectedPresetId: '',
  presetStrength: 1.0,
  extraLoras: [],
  prompt: '',
  aspectRatio: '4:5',
};

const storeListeners = new Set();

function getStoreSnapshot() {
  return {
    result: _cache.result,
    history: _cache.history,
    queueItems: _cache.queueItems,
    variations: _cache.variations,
  };
}

function emitStoreChange() {
  const snapshot = getStoreSnapshot();
  for (const listener of storeListeners) listener(snapshot);
}

function subscribeToStore(listener) {
  storeListeners.add(listener);
  listener(getStoreSnapshot());
  return () => {
    storeListeners.delete(listener);
  };
}

function setCachedResult(next) {
  _cache.result = typeof next === 'function' ? next(_cache.result) : next;
  emitStoreChange();
}

function setCachedHistory(next) {
  _cache.history = typeof next === 'function' ? next(_cache.history) : next;
  emitStoreChange();
}

function setCachedQueueItems(next) {
  _cache.queueItems = typeof next === 'function' ? next(_cache.queueItems) : next;
  writeStoredQueueItems(_cache.queueItems);
  emitStoreChange();
}

function setCachedVariations(next) {
  _cache.variations = typeof next === 'function' ? next(_cache.variations) : next;
  emitStoreChange();
}

const NSFW_STEPS = [
  'Preparing WaveSpeed request',
  'Generating image with LoRAs',
  'Saving result to library',
];

const NSFW_THRESHOLDS = [1, 4];

function NsfwQueueCard({ job, onDismiss }) {
  const { elapsedSec, stepIndex } = useStepTimer(job.status === 'running', NSFW_THRESHOLDS);
  const currentStep = NSFW_STEPS[Math.min(stepIndex, NSFW_STEPS.length - 1)];

  return (
    <Card className="!p-0 overflow-hidden">
      <div className="relative border-b border-zinc-800/70 bg-zinc-950/80 p-4">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(168,85,247,0.18),transparent_55%)]" />
        <div className="relative space-y-3">
          <div className="flex items-center justify-between gap-2">
            <Badge color={job.status === 'running' ? 'blue' : 'red'}>
              {job.status === 'running' ? (job.kind === 'variation' ? 'Creating Variation' : 'Generating') : 'Failed'}
            </Badge>
            <span className="text-[10px] font-mono text-zinc-500">{job.aspectRatio}</span>
          </div>

          {job.status === 'running' ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Spinner size={18} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-zinc-100">{currentStep}</div>
                  <div className="text-xs text-zinc-500">{elapsedSec}s elapsed</div>
                </div>
              </div>
              <div className="space-y-1.5">
                {NSFW_STEPS.map((step, idx) => (
                  <div
                    key={step}
                    className={`flex items-center gap-2 text-[11px] ${
                      idx < stepIndex ? 'text-green-400' : idx === stepIndex ? 'text-purple-300' : 'text-zinc-600'
                    }`}
                  >
                    <span className="w-4 text-center">{idx < stepIndex ? '✓' : idx === stepIndex ? '>' : 'o'}</span>
                    <span>{step}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2">
              <div className="text-sm font-medium text-red-300">Generation failed</div>
              <div className="mt-1 text-xs text-red-200/80 line-clamp-4">{job.errorMessage || 'Something went wrong'}</div>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2 p-3">
        <div className="text-sm text-zinc-200 line-clamp-3">{job.promptPreview}</div>
        <div className="flex flex-wrap gap-1.5">
          {job.characterLoraName ? <Badge color="zinc">{job.characterLoraName}</Badge> : null}
          {job.kind === 'variation' ? <Badge color="zinc">Variation</Badge> : <Badge color="zinc">WaveSpeed</Badge>}
        </div>
        {job.status === 'running' ? (
          <div className="text-[11px] text-zinc-500">You can leave this page and come back while it is still running.</div>
        ) : (
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => onDismiss?.(job.id)}
              className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

export default function NsfwGeneratePage() {
  const { notify, navigateTo, characters } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();

  const [prompt, setPrompt] = useState(_cache.prompt);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [result, setResult] = useState(_cache.result);
  const [history, setHistory] = useState(_cache.history);
  const [queueItems, setQueueItems] = useState(_cache.queueItems);
  const [variations, setVariations] = useState(_cache.variations);

  // Presets
  const [presets, setPresets] = useState(readStoredPresets());
  const [selectedPresetId, setSelectedPresetId] = useState(_cache.selectedPresetId);
  const [presetStrength, setPresetStrength] = useState(_cache.presetStrength);
  const [extraLoras, setExtraLoras] = useState(_cache.extraLoras);
  const [showSavePreset, setShowSavePreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetPath, setNewPresetPath] = useState('');
  const [newPresetScale, setNewPresetScale] = useState(1.0);
  const [newPresetTrigger, setNewPresetTrigger] = useState('');
  const [varyPrompt, setVaryPrompt] = useState('');
  const [varyStrength, setVaryStrength] = useState(0.6);
  const [presetsLoadedOnce, setPresetsLoadedOnce] = useState(false);

  const sync = (k, v) => { _cache[k] = v; };

  useEffect(() => subscribeToStore((snapshot) => {
    setResult(snapshot.result);
    setHistory(snapshot.history);
    setQueueItems(snapshot.queueItems);
    setVariations(snapshot.variations);
  }), []);

  const loadPresets = useCallback(async () => {
    try {
      const data = await presetsApi.list();
      const nextPresets = (Array.isArray(data) ? data : []).slice().sort((a, b) => {
        const aTs = Date.parse(a?.createdAt || 0) || 0;
        const bTs = Date.parse(b?.createdAt || 0) || 0;
        return bTs - aTs;
      });
      setPresets(nextPresets);
      writeStoredPresets(nextPresets);
      setPresetsLoadedOnce(true);
      if (selectedPresetId && !nextPresets.some((preset) => preset.id === selectedPresetId)) {
        setSelectedPresetId('');
        sync('selectedPresetId', '');
      }
    } catch (err) {
      setPresetsLoadedOnce(true);
      notify(err?.message || 'Failed to load Character LoRAs', 'error');
    }
  }, [notify, selectedPresetId]);

  useEffect(() => { loadPresets(); }, [loadPresets]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const refresh = () => { loadPresets(); };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadPresets]);

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
    if (selectedPreset) all.push({ path: selectedPreset.path, scale: presetStrength });
    for (const l of extraLoras) {
      if (l.path.trim()) all.push({ path: l.path.trim(), scale: l.scale });
    }
    return all.slice(0, 3);
  };

  const handleSavePreset = async () => {
    if (!newPresetName.trim() || !newPresetPath.trim()) { notify('Name and LoRA path are required', 'error'); return; }
    try {
      const created = await presetsApi.create({ name: newPresetName.trim(), path: newPresetPath.trim(), scale: newPresetScale, triggerPrompt: newPresetTrigger.trim() });
      await loadPresets();
      setSelectedPresetId(created.id);
      sync('selectedPresetId', created.id);
      setPresetStrength(created.scale || 1.0);
      sync('presetStrength', created.scale || 1.0);
      if (created.triggerPrompt) {
        const next = created.triggerPrompt + (prompt.trim() ? ', ' + prompt.trim() : '');
        setPrompt(next); sync('prompt', next);
      }
      setNewPresetName(''); setNewPresetPath(''); setNewPresetScale(1.0); setNewPresetTrigger(''); setShowSavePreset(false);
      notify('Character LoRA saved and selected', 'success');
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

  const buildFinalPrompt = () => prompt.trim();

  const dismissQueueItem = (queueId) => {
    setCachedQueueItems((prev) => prev.filter((job) => job.id !== queueId));
  };

  const activeQueueCount = queueItems.filter((job) => job.status === 'running').length;

  const handleGenerate = async () => {
    const finalPrompt = buildFinalPrompt();
    if (!finalPrompt) { notify('Enter a prompt', 'error'); return; }
    const queueId = globalThis.crypto?.randomUUID?.() || `nsfw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setCachedQueueItems((prev) => [
      {
        id: queueId,
        kind: 'generate',
        status: 'running',
        promptPreview: finalPrompt,
        aspectRatio,
        characterLoraName: selectedPreset?.name || '',
      },
      ...prev.slice(0, 5),
    ]);
    pushPending({ id: queueId, prompt: finalPrompt, imageModel: 'nsfw-generate', aspectRatio, resolutionTier: '1K' });
    try {
      const data = await api.image({ prompt: finalPrompt, aspectRatio, loras: buildLoras() });
      setCachedQueueItems((prev) => prev.filter((job) => job.id !== queueId));
      const feedGalleryId = data.galleryId || data.imageId;
      if (feedGalleryId) {
        resolvePending(queueId, {
          imageId: feedGalleryId,
          galleryId: feedGalleryId,
          mimeType: data.image?.mimeType || 'image/png',
          prompt: finalPrompt,
          imageModel: 'nsfw-generate',
          aspectRatio,
          resolutionTier: '1K',
          generatedAt: Date.now(),
        });
      } else {
        rejectPending(queueId);
      }
      setCachedResult(data);
      setCachedVariations([]);
      setCachedHistory((h) => {
        const next = [{ imageId: data.imageId, galleryId: data.galleryId || data.imageId, mimeType: data.image?.mimeType, base64: data.image?.base64Data }, ...h].slice(0, 12);
        return next;
      });
      notify('Image generated!', 'success');
    } catch (err) {
      rejectPending(queueId);
      setCachedQueueItems((prev) => prev.map((job) => (
        job.id === queueId
          ? { ...job, status: 'error', errorMessage: err?.message || 'Failed to generate image' }
          : job
      )));
      notify(err?.message || 'Failed to generate image', 'error');
    }
  };

  const handleVary = async () => {
    if (!result?.image) return;
    const varPrompt = varyPrompt.trim() || buildFinalPrompt();
    if (!varPrompt) { notify('Enter a variation prompt', 'error'); return; }
    const queueId = globalThis.crypto?.randomUUID?.() || `nsfw-vary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setCachedQueueItems((prev) => [
      {
        id: queueId,
        kind: 'variation',
        status: 'running',
        promptPreview: varPrompt,
        aspectRatio,
        characterLoraName: selectedPreset?.name || '',
      },
      ...prev.slice(0, 5),
    ]);
    pushPending({ id: queueId, prompt: varPrompt, imageModel: 'nsfw-generate', aspectRatio, resolutionTier: '1K' });
    try {
      const data = await api.vary({
        imageBase64: result.image.base64Data, mimeType: result.image.mimeType,
        prompt: varPrompt, aspectRatio, strength: varyStrength, loras: buildLoras(),
      });
      setCachedQueueItems((prev) => prev.filter((job) => job.id !== queueId));
      const feedGalleryId = data.galleryId || data.imageId;
      if (feedGalleryId) {
        resolvePending(queueId, { imageId: feedGalleryId, galleryId: feedGalleryId, mimeType: data.image?.mimeType || 'image/png', prompt: varPrompt, imageModel: 'nsfw-generate', aspectRatio, resolutionTier: '1K', generatedAt: Date.now() });
      } else { rejectPending(queueId); }
      setCachedVariations((prev) => [...prev, data]);
      setCachedHistory((h) => {
        const next = [{ imageId: data.imageId, galleryId: data.galleryId || data.imageId, mimeType: data.image?.mimeType, base64: data.image?.base64Data }, ...h].slice(0, 12);
        return next;
      });
      notify('Variation created!', 'success');
    } catch (err) {
      rejectPending(queueId);
      setCachedQueueItems((prev) => prev.map((job) => (
        job.id === queueId
          ? { ...job, status: 'error', errorMessage: err?.message || 'Failed to create variation' }
          : job
      )));
      notify(err?.message || 'Failed to create variation', 'error');
    }
  };

  const downloadImg = (img, prefix = 'wavespeed') => {
    const a = document.createElement('a');
    a.href = `data:${img.mimeType};base64,${img.base64Data}`;
    a.download = `${prefix}_${Date.now()}.png`;
    a.click();
  };

  const openInPhotoMatch = (img, filename = 'nsfw-generate') => {
    if (!img?.base64Data) {
      notify('This image is not ready for Photo Match yet', 'error');
      return;
    }
    const payload = {
      sourceImageBase64: img.base64Data,
      sourceImageMimeType: img.mimeType || 'image/png',
      sourceImageName: filename,
      characterId: resolveCharacterIdFromPreset(selectedPreset, characters),
      exactRecreate: true,
      aspectRatio,
    };
    writeHandoff(PHOTO_MATCH_HANDOFF_KEY, payload);
    navigateTo('photoMatch', payload);
  };

  const openInNanoBypass = (img, filename = 'nsfw-generate') => {
    if (!img?.base64Data) {
      notify('This image is not ready for Nano Bypass yet', 'error');
      return;
    }
    const payload = {
      sourceImageBase64: img.base64Data,
      sourceImageMimeType: img.mimeType || 'image/png',
      sourceImageName: filename,
      aspectRatio,
    };
    writeHandoff(NANO_BYPASS_HANDOFF_KEY, payload);
    navigateTo('nanoBypass', payload);
  };

  const recentHistory = history.slice(1, 9).filter((h) => h?.imageId);

  return (
    <div>
      <div className="space-y-4 max-w-sm pb-8">
        <Card className="p-4 space-y-4">
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300">Beta</span>
              <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-200">
                Character LoRA Recommended
              </span>
            </div>
            <p className="text-xs leading-relaxed text-amber-100/90">
              This mode works best when you use a trained character LoRA. Without one, outputs can still generate,
              but character consistency and likeness will be unreliable.
            </p>
            <p className="text-[11px] leading-relaxed text-amber-200/70">
              Pick your trained character LoRA below before generating if you want repeatable results.
            </p>
          </div>

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
              <div>
                <span className="text-xs text-zinc-400 font-medium">Character LoRA</span>
                <p className="mt-0.5 text-[10px] text-zinc-500">
                  {presets.length > 0
                    ? `${presets.length} saved preset${presets.length === 1 ? '' : 's'}`
                    : presetsLoadedOnce
                      ? 'No saved presets yet'
                      : 'Loading saved presets...'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={loadPresets}
                  className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
                >
                  Refresh
                </button>
                <button type="button" onClick={() => setShowSavePreset(!showSavePreset)} className="text-xs text-purple-400 hover:text-purple-300 cursor-pointer">
                  {showSavePreset ? 'Cancel' : '+ Save New'}
                </button>
              </div>
            </div>
            <select
              value={selectedPresetId}
              onChange={(e) => {
              const newId = e.target.value;
              setSelectedPresetId(newId); sync('selectedPresetId', newId);
              setPresetStrength(1.0); sync('presetStrength', 1.0);
              const picked = presets.find((p) => p.id === newId);
              if (picked?.triggerPrompt) {
                // Strip previous trigger from prompt if switching presets
                const prevTrigger = presets.find((p) => p.id === selectedPresetId)?.triggerPrompt || '';
                let base = prompt.trim();
                if (prevTrigger && base.startsWith(prevTrigger)) {
                  base = base.slice(prevTrigger.length).replace(/^,\s*/, '').trim();
                }
                const next = picked.triggerPrompt + (base ? ', ' + base : '');
                setPrompt(next); sync('prompt', next);
              }
            }}
              className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-purple-500/70 focus:ring-1 focus:ring-purple-500/20 cursor-pointer"
            >
              <option value="">No character LoRA</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name} (scale: {p.scale})</option>
              ))}
            </select>
            {selectedPreset && (
              <div className="bg-purple-900/20 rounded-lg px-3 py-2 border border-purple-800/30 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <span className="text-xs text-purple-300 font-medium block truncate">{selectedPreset.name}</span>
                    <span className="text-[10px] text-zinc-500 block truncate">{selectedPreset.path}</span>
                    {selectedPreset.triggerPrompt && (
                      <span className="text-[10px] text-purple-400/70 block truncate mt-0.5">Trigger: {selectedPreset.triggerPrompt}</span>
                    )}
                  </div>
                  <button type="button" onClick={() => handleDeletePreset(selectedPreset.id)} className="text-zinc-500 hover:text-red-400 text-xs ml-2 shrink-0 cursor-pointer" title="Delete preset">&times;</button>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[10px] text-zinc-400">Strength</span>
                    <span className="text-[10px] text-zinc-500 font-mono">{presetStrength.toFixed(1)}</span>
                  </div>
                  <input type="range" min={0.1} max={2.0} step={0.1} value={presetStrength} onChange={(e) => { const v = parseFloat(e.target.value); setPresetStrength(v); sync('presetStrength', v); }} className="w-full accent-purple-500" />
                </div>
              </div>
            )}
            {showSavePreset && (
              <div className="space-y-2 bg-zinc-800/40 rounded-lg p-3 border border-zinc-700/40">
                <input type="text" value={newPresetName} onChange={(e) => setNewPresetName(e.target.value)} placeholder="Preset name (e.g. Maria v2)" className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-purple-500/70 placeholder:text-zinc-600" />
                <input type="text" value={newPresetPath} onChange={(e) => setNewPresetPath(e.target.value)} placeholder="HuggingFace URL or model path" className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-purple-500/70 placeholder:text-zinc-600" />
                <textarea value={newPresetTrigger} onChange={(e) => setNewPresetTrigger(e.target.value)} placeholder="Trigger prompt (auto-pastes into prompt when selected)" rows={2} className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-purple-500/70 placeholder:text-zinc-600 resize-none" />
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
          <Btn onClick={handleGenerate} disabled={!prompt.trim()} className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40">
            {activeQueueCount > 0 ? `Queue Another · ${activeQueueCount} running` : 'Generate (WaveSpeed)'}
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
            <Btn onClick={handleVary} disabled={!result?.image} className="w-full bg-purple-700 hover:bg-purple-600 disabled:opacity-40">
              {activeQueueCount > 0 ? `Queue Variation · ${activeQueueCount} running` : 'Create Variation'}
            </Btn>
          </Card>
        )}
      </div>


      <LightboxComponent />
    </div>
  );
}
