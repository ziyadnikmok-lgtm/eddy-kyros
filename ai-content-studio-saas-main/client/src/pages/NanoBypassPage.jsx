import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { nanoBypass as api, gallery as galleryApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Textarea, Spinner, Badge } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { createPersistentPageState, makePersistentJobId, PersistentJobCard } from '../lib/persistentPageState';


const ASPECT_RATIOS = ['auto', '1:1', '9:16', '16:9', '4:5', '3:4', '2:3'];
const IMAGE_SIZES = ['1K', '2K'];

const LOCKED_MODEL = { id: 'flash', label: 'Flash 3.1', sublabel: 'gemini-3.1-flash', color: 'bg-blue-600 hover:bg-blue-500' };
const NANO_BYPASS_HANDOFF_KEY = 'kyros.nanoBypass.handoff';

const _cache = {
  prompt: '',
  characterId: '',
  model: 'flash',
  aspectRatio: 'auto',
  imageSize: '2K',
  temperature: 1.0,
};

const NANO_STEPS = [
  'Preparing uploaded references',
  'Sending edit request to Gemini',
  'Rendering final image edit',
];
const NANO_THRESHOLDS = [3, 8];

const nanoPageStore = createPersistentPageState('nano-bypass', {
  result: null,
  history: [],
  queueItems: [],
});

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function dataUrlToImageItem(dataUrl, filename = 'nano-source.png') {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const [, mimeType] = match;
  return {
    base64: dataUrl,
    mimeType,
    preview: dataUrl,
    filename,
  };
}

function readNanoBypassHandoff() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(NANO_BYPASS_HANDOFF_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(NANO_BYPASS_HANDOFF_KEY);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildCharacterReferenceDescriptors(characterId, character) {
  if (!characterId || !character) return [];

  const items = [];
  const primaryCount = Math.max(0, Number(character.primaryImageCount || 0));
  for (let index = 0; index < primaryCount; index += 1) {
    items.push({
      key: `primary-${index}`,
      label: index === 0 ? 'Primary' : `Primary ${index + 1}`,
      src: charApi.primaryImageUrl(characterId, index),
    });
  }

  for (const ref of character.references || []) {
    if (!ref?.isActive) continue;
    items.push({
      key: `ref-${ref.id}`,
      label: ref.category || 'Reference',
      src: charApi.refImageUrl(characterId, ref.id),
    });
  }

  return items;
}

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
          <div className="absolute bottom-1.5 left-1.5 bg-black/60 rounded-md px-1.5 py-0.5 text-[9px] text-zinc-300">
            {image.autoCharacterRef ? 'REF' : `IMG ${index + 1}`}
          </div>
          {image.referenceLabel && (
            <div className="absolute inset-x-1.5 bottom-6 truncate rounded bg-black/55 px-1.5 py-0.5 text-[9px] text-zinc-200">
              {image.referenceLabel}
            </div>
          )}
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
  const { notify, characters, consumePageParams } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const initialStoreState = nanoPageStore.getSnapshot();
  const autofillCharacterPromptRef = useRef(false);
  const lastAutofilledCharacterIdRef = useRef('');

  const [images, setImages] = useState([null, null, null, null, null]);
  const [prompt, setPrompt] = useState(_cache.prompt);
  const [characterId, setCharacterId] = useState(_cache.characterId);
  const [model, setModel] = useState(_cache.model);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [imageSize, setImageSize] = useState(IMAGE_SIZES.includes(_cache.imageSize) ? _cache.imageSize : '2K');
  const [temperature, setTemperature] = useState(_cache.temperature);
  const [loadingCharacterRefs, setLoadingCharacterRefs] = useState(false);

  const [loading, setLoading] = useState(initialStoreState.queueItems.some((job) => job.status === 'running'));
  const [result, setResult] = useState(initialStoreState.result);
  const [history, setHistory] = useState(initialStoreState.history);
  const [queueItems, setQueueItems] = useState(initialStoreState.queueItems);

  const selectedCharacter = useMemo(
    () => characters.find((character) => character.id === characterId) || null,
    [characters, characterId],
  );
  const characterReferenceDescriptors = useMemo(
    () => buildCharacterReferenceDescriptors(characterId, selectedCharacter),
    [characterId, selectedCharacter],
  );

  const handleCharacterChange = useCallback((nextCharacterId) => {
    autofillCharacterPromptRef.current = Boolean(nextCharacterId);
    setCharacterId(nextCharacterId);
  }, []);

  useEffect(() => nanoPageStore.subscribe((snapshot) => {
    setResult(snapshot.result);
    setHistory(snapshot.history);
    setQueueItems(snapshot.queueItems);
    setLoading(snapshot.queueItems.some((job) => job.status === 'running'));
  }), []);

  useEffect(() => {
    const params = consumePageParams();
    const handoff = params?.sourceImageBase64 ? params : readNanoBypassHandoff();
    if (!handoff?.sourceImageBase64) return;

    const imageItem = dataUrlToImageItem(
      `data:${handoff.sourceImageMimeType || 'image/png'};base64,${handoff.sourceImageBase64}`,
      handoff.sourceImageName || 'nsfw-generate',
    );
    if (!imageItem) {
      notify('Could not load source image into Nano Bypass', 'error');
      return;
    }

    setImages((prev) => {
      const next = [...prev];
      next[0] = {
        ...imageItem,
        autoCharacterRef: false,
        referenceLabel: 'Source',
      };
      return next;
    });

    if (handoff.characterId) {
      autofillCharacterPromptRef.current = true;
      setCharacterId(handoff.characterId);
    } else {
      // Coming from Library with no character — clear so no refs auto-inject into image slots
      autofillCharacterPromptRef.current = false;
      setCharacterId('');
    }
    if (typeof handoff.aspectRatio === 'string' && ASPECT_RATIOS.includes(handoff.aspectRatio)) {
      setAspectRatio(handoff.aspectRatio);
    }
    notify('Loaded image into Nano Bypass', 'success');
  }, [consumePageParams, notify]);

  useEffect(() => {
    if (!characterId) {
      autofillCharacterPromptRef.current = false;
      lastAutofilledCharacterIdRef.current = '';
      return;
    }

    const masterPrompt = String(selectedCharacter?.masterPrompt || '').trim();
    if (!masterPrompt) {
      autofillCharacterPromptRef.current = false;
      return;
    }

    setPrompt((prev) => {
      const shouldAutofill = autofillCharacterPromptRef.current
        || (!String(prev || '').trim() && lastAutofilledCharacterIdRef.current !== characterId);
      if (!shouldAutofill) return prev;
      lastAutofilledCharacterIdRef.current = characterId;
      return masterPrompt;
    });
    autofillCharacterPromptRef.current = false;
  }, [characterId, selectedCharacter]);

  useEffect(() => {
    if (!IMAGE_SIZES.includes(imageSize)) {
      setImageSize('2K');
    }
  }, [imageSize]);

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

  useEffect(() => {
    let cancelled = false;

    const applyCharacterRefs = async () => {
      if (!characterId || characterReferenceDescriptors.length === 0) {
        setLoadingCharacterRefs(false);
        setImages((prev) => prev.map((img) => (img?.autoCharacterRef ? null : img)));
        return;
      }

      setLoadingCharacterRefs(true);
      try {
        const loadedRefs = [];
        for (const descriptor of characterReferenceDescriptors) {
          const response = await fetch(descriptor.src, { credentials: 'include' });
          if (!response.ok) throw new Error(`Failed to load ${descriptor.label.toLowerCase()}`);
          const blob = await response.blob();
          const dataUrl = await blobToDataUrl(blob);
          loadedRefs.push({
            base64: dataUrl,
            mimeType: blob.type || 'image/png',
            preview: dataUrl,
            autoCharacterRef: true,
            referenceLabel: descriptor.label,
            referenceKey: descriptor.key,
          });
        }

        if (cancelled) return;

        setImages((prev) => {
          const next = prev.map((img) => (img?.autoCharacterRef ? null : img));
          for (const refImage of loadedRefs) {
            const emptyIndex = next.findIndex((img) => !img);
            if (emptyIndex === -1) break;
            next[emptyIndex] = refImage;
          }
          return next;
        });
      } catch (err) {
        if (!cancelled) notify(err.message || 'Failed to load character reference images', 'error');
      } finally {
        if (!cancelled) setLoadingCharacterRefs(false);
      }
    };

    applyCharacterRefs();

    return () => {
      cancelled = true;
    };
  }, [characterId, characterReferenceDescriptors, notify]);

  const activeImages = images.filter(Boolean);
  const activeQueueCount = queueItems.filter((job) => job.status === 'running').length;

  const dismissQueueItem = useCallback((queueId) => {
    nanoPageStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
  }, []);

  const handleGenerate = async () => {
    if (activeImages.length === 0) { notify('Add at least one image', 'error'); return; }
    if (!prompt.trim()) { notify('Enter a prompt describing the edit', 'error'); return; }

    const queueId = makePersistentJobId('nano-bypass');
    pushPending({ id: queueId, prompt: prompt || '', imageModel: model || '', aspectRatio, resolutionTier: imageSize });
    nanoPageStore.patch({
      result: null,
      queueItems: [
        {
          id: queueId,
          kind: 'edit',
          status: 'running',
          label: 'Nano Bypass',
          summary: prompt.trim(),
          meta: `${aspectRatio} · ${imageSize}`,
          badges: [
            selectedCharacter?.name ? { label: selectedCharacter.name, color: 'zinc' } : null,
            { label: LOCKED_MODEL.label, color: 'blue' },
            { label: `${activeImages.length} refs`, color: 'zinc' },
          ].filter(Boolean),
        },
        ...queueItems.filter((job) => job.status !== 'running').slice(0, 5),
      ],
    });

    // Update cache
    _cache.prompt = prompt;
    _cache.characterId = characterId;
    _cache.model = model;
    _cache.aspectRatio = aspectRatio;
    _cache.imageSize = imageSize;
    _cache.temperature = temperature;

    try {
      const data = await api.edit({
        images: activeImages.map((img) => ({ base64: img.base64, mimeType: img.mimeType })),
        prompt: prompt.trim(),
        characterId: characterId || undefined,
        model,
        aspectRatio,
        imageSize,
        temperature,
      });

      nanoPageStore.setValue('result', data);
      nanoPageStore.setValue('history', (prev) => [data, ...prev].slice(0, 12));
      nanoPageStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
      resolvePending(queueId, {
        imageId: data.imageId,
        galleryId: data.galleryId || data.imageId,
        mimeType: data.image?.mimeType,
        prompt: prompt || '',
        imageModel: model || '',
        aspectRatio,
        resolutionTier: imageSize,
        generatedAt: Date.now(),
        characterId: characterId || null,
      });
      notify('Done!', 'success');
    } catch (err) {
      rejectPending(queueId);
      nanoPageStore.setValue('queueItems', (prev) => prev.map((job) => (
        job.id === queueId ? { ...job, status: 'error', errorMessage: err.message || 'Generation failed' } : job
      )));
      notify(err.message || 'Generation failed', 'error');
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
            <span className="text-xs text-zinc-400 font-medium block mb-1.5">Character</span>
            <select
              value={characterId}
              onChange={(e) => handleCharacterChange(e.target.value)}
              className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500"
            >
              <option value="">No character</option>
              {characters.map((character) => (
                <option key={character.id} value={character.id}>{character.name || character.id}</option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-zinc-500">
              Optional. Selecting a character auto-loads that character&apos;s primary/reference images and master prompt.
            </p>
            {characterReferenceDescriptors.length > 0 && (
              <div className="mt-2 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-zinc-400">Auto-loaded Character Refs</span>
                  {loadingCharacterRefs && <span className="text-[10px] text-zinc-500">Loading...</span>}
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {characterReferenceDescriptors.map((item, index) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => openLightbox(characterReferenceDescriptors.map((entry) => entry.src), index)}
                      className="relative aspect-square overflow-hidden rounded-lg border border-zinc-700/70 bg-zinc-900/60 transition hover:border-zinc-500 cursor-pointer"
                      title={item.label}
                    >
                      <img src={item.src} alt={item.label} className="h-full w-full object-cover" loading="lazy" />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4">
                        <span className="block truncate text-[10px] text-zinc-200">{item.label}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
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
            disabled={activeImages.length === 0 || !prompt.trim()}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40"
          >
            {activeQueueCount > 0 ? `Queue Another · ${activeQueueCount} running` : '⚡ Nano Bypass'}
          </Btn>
          <p className="text-[10px] text-zinc-500 text-center">Powered by Gemini 3 image editing</p>
        </Card>
      </div>


      <LightboxComponent />
    </div>
  );
}
