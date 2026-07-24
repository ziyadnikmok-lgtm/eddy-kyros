import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { nanoBypass as api, gallery as galleryApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Textarea, Spinner, Badge } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { createPersistentPageState, makePersistentJobId, PersistentJobCard } from '../lib/persistentPageState';
import { downloadBlob } from '../lib/stripMetadata';


const ASPECT_RATIOS = ['auto', '1:1', '9:16', '16:9', '4:5', '3:4', '2:3'];
const IMAGE_SIZES = ['1K', '2K'];

const LOCKED_MODEL = { id: 'flash', label: 'Flash 3.1', sublabel: 'gemini-3.1-flash', color: 'bg-rose-600 hover:bg-rose-500' };
const NANO_BYPASS_HANDOFF_KEY = 'kyros.nanoBypass.handoff';
const INITIAL_IMAGE_SLOT_COUNT = 3;

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

function fileToImageItem(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      base64: reader.result,
      mimeType: file.type || 'image/png',
      preview: reader.result,
      filename: file.name || 'nano-source.png',
    });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function filesToImageItems(fileList) {
  const files = Array.from(fileList || []).filter((file) => file?.type?.startsWith('image/'));
  if (files.length === 0) return [];
  return Promise.all(files.map(fileToImageItem));
}

function createEmptyImageSlots(count = INITIAL_IMAGE_SLOT_COUNT) {
  return Array.from({ length: count }, () => null);
}

function ensureOpenImageSlot(slots) {
  const next = Array.isArray(slots) ? [...slots] : createEmptyImageSlots();
  let lastFilledIndex = -1;
  next.forEach((slot, index) => {
    if (slot) lastFilledIndex = index;
  });

  const targetLength = Math.max(INITIAL_IMAGE_SLOT_COUNT, lastFilledIndex + 2);
  while (next.length < targetLength) next.push(null);
  return next.slice(0, targetLength);
}

function placeImagesAt(slots, startIndex, incoming) {
  const next = Array.isArray(slots) ? [...slots] : createEmptyImageSlots();
  const imagesToPlace = Array.isArray(incoming) ? incoming.filter(Boolean) : [];
  let cursor = Math.max(0, Number(startIndex) || 0);

  imagesToPlace.forEach((image, offset) => {
    if (offset === 0) {
      while (next.length <= cursor) next.push(null);
      next[cursor] = image;
      cursor += 1;
      return;
    }

    let nextOpenIndex = next.findIndex((slot, index) => index >= cursor && !slot);
    if (nextOpenIndex === -1) {
      nextOpenIndex = next.length;
      next.push(null);
    }
    next[nextOpenIndex] = image;
    cursor = nextOpenIndex + 1;
  });

  return ensureOpenImageSlot(next);
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

function ImageSlot({ index, image, onAddMany, onRemove }) {
  const inputRef = useRef(null);

  const addFiles = async (fileList) => {
    try {
      const items = await filesToImageItems(fileList);
      if (items.length > 0) onAddMany(index, items);
    } catch {
      // Ignore unreadable local files; the page-level API call will still validate inputs.
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  };

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border transition cursor-pointer group
        ${image
          ? 'border-zinc-600/60 bg-zinc-950 shadow-lg shadow-black/20'
          : 'border-dashed border-zinc-700/60 bg-zinc-950/45 hover:border-cyan-400/60 hover:bg-cyan-500/[0.04]'}`}
      style={{ aspectRatio: '1/1' }}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      onClick={() => !image && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = '';
        }}
      />
      {image ? (
        <>
          <img src={image.preview} alt="" className="w-full h-full object-cover" />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/10 opacity-80" />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(index); }}
            className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/75 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition cursor-pointer"
          >×</button>
          <div className="absolute bottom-1.5 left-1.5 bg-black/65 rounded-md px-1.5 py-0.5 text-[0.5625rem] text-zinc-200">
            {image.autoCharacterRef ? 'REF' : `IMG ${index + 1}`}
          </div>
          {image.referenceLabel && (
            <div className="absolute inset-x-1.5 bottom-6 truncate rounded bg-black/55 px-1.5 py-0.5 text-[0.5625rem] text-zinc-200">
              {image.referenceLabel}
            </div>
          )}
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-zinc-500 transition group-hover:text-cyan-200">
          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-700/70 bg-zinc-900/80 text-xl shadow-inner shadow-white/5 transition group-hover:border-cyan-400/50 group-hover:bg-cyan-400/10">+</span>
          <span className="text-[0.625rem] font-medium">Image {index + 1}</span>
        </div>
      )}
    </div>
  );
}

function AddImageSlot({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative overflow-hidden rounded-2xl border border-cyan-400/25 bg-gradient-to-br from-cyan-500/15 via-rose-500/10 to-zinc-950 p-3 text-left transition hover:border-cyan-300/60 hover:from-cyan-400/20 hover:shadow-lg hover:shadow-cyan-950/30"
      style={{ aspectRatio: '1/1' }}
    >
      <div className="absolute -right-8 -top-8 h-20 w-20 rounded-full bg-cyan-300/10 blur-2xl transition group-hover:bg-cyan-300/20" />
      <div className="relative flex h-full flex-col items-center justify-center gap-2 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-full border border-cyan-300/40 bg-cyan-300/10 text-2xl font-light text-cyan-100 transition group-hover:scale-105">+</span>
        <span className="text-[0.6875rem] font-semibold text-cyan-100">Add more</span>
        <span className="text-[0.5625rem] leading-tight text-cyan-100/55">Unlimited slots</span>
      </div>
    </button>
  );
}

export default function NanoBypassPage() {
  const { notify, characters, consumePageParams } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const initialStoreState = nanoPageStore.getSnapshot();
  const autofillCharacterPromptRef = useRef(false);
  const lastAutofilledCharacterIdRef = useRef('');

  const [images, setImages] = useState(() => createEmptyImageSlots());
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
      return ensureOpenImageSlot(next);
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
          filesToImageItems([file]).then((items) => {
            if (items.length === 0) return;
            setImages((prev) => {
              const slot = prev.findIndex((s) => !s);
              return placeImagesAt(prev, slot === -1 ? prev.length : slot, items);
            });
          }).catch(() => {});
          break;
        }
      }
    };
    window.addEventListener('paste', handler);
    return () => window.removeEventListener('paste', handler);
  }, []);

  const handleAddMany = useCallback((index, items) => {
    setImages((prev) => placeImagesAt(prev, index, items));
  }, []);

  const addImageSlot = useCallback(() => {
    setImages((prev) => [...prev, null]);
  }, []);

  const handleRemove = useCallback((index) => {
    setImages((prev) => {
      const next = [...prev];
      next[index] = null;
      return ensureOpenImageSlot(next);
    });
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
            let emptyIndex = next.findIndex((img) => !img);
            if (emptyIndex === -1) {
              emptyIndex = next.length;
              next.push(null);
            }
            next[emptyIndex] = refImage;
          }
          return ensureOpenImageSlot(next);
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
        images: activeImages.map((img) => ({
          base64: img.base64,
          mimeType: img.mimeType,
          autoCharacterRef: img.autoCharacterRef || false,
        })),
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

  const downloadResult = async () => {
    if (!result?.base64Data) return;
    const blob = await (await fetch(`data:image/png;base64,${result.base64Data}`)).blob();
    await downloadBlob(blob, `nano-bypass-${Date.now()}.png`);
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
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-[0.18em] text-rose-300 block">Locked Model</span>
                  <div className="mt-1 text-sm font-semibold text-zinc-100">{LOCKED_MODEL.label}</div>
                  <div className="text-[0.625rem] font-mono text-rose-200/80 mt-0.5">{LOCKED_MODEL.sublabel}</div>
                </div>
                <Badge color="blue">Bypass Safe</Badge>
              </div>
              <p className="mt-2 text-[0.6875rem] text-rose-100/85">
                Nano Bypass only works reliably on Gemini 3.1 Flash. Pro has been disabled for this tool.
              </p>
            </div>
          </div>

          {/* Images grid */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-zinc-300 font-semibold">Images ({activeImages.length})</span>
              <span className="text-[0.625rem] text-zinc-600">Paste/drop multiple</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {images.map((img, i) => (
                <ImageSlot key={i} index={i} image={img} onAddMany={handleAddMany} onRemove={handleRemove} />
              ))}
              <AddImageSlot onClick={addImageSlot} />
            </div>
          </div>

          {/* Prompt */}
          <div>
            <span className="text-xs text-zinc-400 font-medium block mb-1.5">Character</span>
            <select
              value={characterId}
              onChange={(e) => handleCharacterChange(e.target.value)}
              className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-rose-500"
            >
              <option value="">No character</option>
              {characters.map((character) => (
                <option key={character.id} value={character.id}>{character.name || character.id}</option>
              ))}
            </select>
            <p className="mt-1 text-[0.625rem] text-zinc-500">
              Optional. Selecting a character auto-loads that character&apos;s primary/reference images and master prompt.
            </p>
            {characterReferenceDescriptors.length > 0 && (
              <div className="mt-2 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.6875rem] text-zinc-400">Auto-loaded Character Refs</span>
                  {loadingCharacterRefs && <span className="text-[0.625rem] text-zinc-500">Loading...</span>}
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
                        <span className="block truncate text-[0.625rem] text-zinc-200">{item.label}</span>
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
                    ${aspectRatio === ar ? 'bg-rose-600 text-white' : 'bg-zinc-700/60 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200'}`}
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
                    ${imageSize === s ? 'bg-rose-600 text-white' : 'bg-zinc-700/60 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200'}`}
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
              className="w-full accent-rose-500"
            />
            <div className="flex justify-between text-[0.625rem] text-zinc-600 mt-0.5">
              <span>Precise</span>
              <span>Creative</span>
            </div>
          </div>

          <Btn
            onClick={handleGenerate}
            disabled={activeImages.length === 0 || !prompt.trim()}
            className="w-full bg-rose-600 hover:bg-rose-500 disabled:opacity-40"
          >
            {activeQueueCount > 0 ? `Queue Another · ${activeQueueCount} running` : '⚡ Nano Bypass'}
          </Btn>
          <p className="text-[0.625rem] text-zinc-500 text-center">Powered by Gemini 3 image editing</p>
        </Card>
      </div>


      <LightboxComponent />
    </div>
  );
}
