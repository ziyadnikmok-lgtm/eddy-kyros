import { useState, useEffect, useCallback, useRef } from 'react';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { scene as sceneApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Textarea, Badge, Spinner } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { ASPECT_RATIOS, RESOLUTION_TIERS, IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL, DEFAULT_RESOLUTION_TIER } from '../config/photoModes';
import { createPersistentPageState, makePersistentJobId } from '../lib/persistentPageState';
import { IconCamera } from 'nucleo-glass';

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

const _cache = {
  sceneData: null,
  editableScene: '',
  selectedCharIds: [],
  aspectRatio: '4:5',
  resolutionTier: DEFAULT_RESOLUTION_TIER,
  imageModel: DEFAULT_IMAGE_MODEL,
  sameBackground: false,
  samePose: false,
  sameHair: false,
  sameTattoos: false,
  provider: 'auto',
  result: null,
  history: [],
};

const MAX_RUNNING_SCENE_JOBS = 2;
const SCENE_RECREATE_SOURCE_STORAGE_KEY = 'kyros.sceneRecreate.sources';

function readStoredSourceFiles() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SCENE_RECREATE_SOURCE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object' && item.dataUrl) : [];
  } catch { return []; }
}

function writeStoredSourceFiles(items) {
  if (typeof window === 'undefined') return;
  try {
    const payload = items.map((item) => ({
      id: item.id,
      name: item.name || 'source-image',
      type: item.type || 'image/png',
      size: item.size || 0,
      dataUrl: item.dataUrl,
    }));
    if (payload.length === 0) window.localStorage.removeItem(SCENE_RECREATE_SOURCE_STORAGE_KEY);
    else window.localStorage.setItem(SCENE_RECREATE_SOURCE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage failures.
  }
}

function dataUrlToFile(dataUrl, filename = 'scene-recreate-source.png') {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const [, mimeType, base64] = match;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const ext = mimeType.split('/')[1] || 'png';
  return new File([bytes], filename.includes('.') ? filename : `${filename}.${ext}`, { type: mimeType });
}

function resizeAndCompressImage(file, maxDimension = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    // Only compress images larger than 500KB
    if (file.size <= 500 * 1024) {
      resolve(file);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
        canvas.toBlob((blob) => {
          if (!blob) {
            resolve(file);
            return;
          }
          const compressedFile = new File([blob], file.name, {
            type: 'image/jpeg',
            lastModified: Date.now()
          });
          resolve(compressedFile);
        }, 'image/jpeg', quality);
      };
      img.onerror = () => resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

const scenePageStore = createPersistentPageState('scene-recreate', {
  sceneData: _cache.sceneData,
  editableScene: _cache.editableScene,
  result: _cache.result,
  history: _cache.history,
  queueItems: [],
});

export default function SceneRecreatePage() {
  const { notify, characters: chars } = useApp();
  const { LightboxComponent } = useImageLightbox();
  const initialStoreState = scenePageStore.getSnapshot();
  const fileInputRef = useRef(null);
  const filesRef = useRef([]);
  const runningJobsRef = useRef(new Set());
  const [files, setFiles] = useState(() => readStoredSourceFiles().map((item) => ({
    file: dataUrlToFile(item.dataUrl, item.name),
    previewUrl: item.dataUrl,
    id: item.id,
  })).filter((entry) => entry.file));
  const [isDragging, setIsDragging] = useState(false);
  const [sceneData, setSceneData] = useState(initialStoreState.sceneData);
  const [editableScene, setEditableScene] = useState(initialStoreState.editableScene);
  const [selectedCharIds, setSelectedCharIds] = useState(_cache.selectedCharIds);
  const [charDetails, setCharDetails] = useState({});
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolutionTier, setResolutionTier] = useState(_cache.resolutionTier);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [sameBackground, setSameBackground] = useState(_cache.sameBackground);
  const [samePose, setSamePose] = useState(_cache.samePose);
  const [sameHair, setSameHair] = useState(_cache.sameHair);
  const [sameTattoos, setSameTattoos] = useState(_cache.sameTattoos);
  const [provider, setProvider] = useState(_cache.provider);
  const [result, setResult] = useState(initialStoreState.result);
  const [queueItems, setQueueItems] = useState(initialStoreState.queueItems);
  const [queuePaused, setQueuePaused] = useState(false);

  const [instagramLinks, setInstagramLinks] = useState('');
  const [failedInstagramLinks, setFailedInstagramLinks] = useState([]);
  const [isExtractingInstagram, setIsExtractingInstagram] = useState(false);
  const [showInstagramImport, setShowInstagramImport] = useState(false);
  const firstSelectedChar = selectedCharIds[0] ? charDetails[selectedCharIds[0]] : null;
  const characterPromptPreview = String(firstSelectedChar?.masterPrompt || '').trim();

  useEffect(() => { _cache.sceneData = sceneData; }, [sceneData]);
  useEffect(() => { _cache.editableScene = editableScene; }, [editableScene]);
  useEffect(() => { _cache.selectedCharIds = selectedCharIds; }, [selectedCharIds]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolutionTier = resolutionTier; }, [resolutionTier]);
  useEffect(() => { _cache.imageModel = imageModel; }, [imageModel]);
  useEffect(() => { _cache.sameBackground = sameBackground; }, [sameBackground]);
  useEffect(() => { _cache.samePose = samePose; }, [samePose]);
  useEffect(() => { _cache.sameHair = sameHair; }, [sameHair]);
  useEffect(() => { _cache.sameTattoos = sameTattoos; }, [sameTattoos]);
  useEffect(() => { _cache.provider = provider; }, [provider]);
  useEffect(() => scenePageStore.subscribe((snapshot) => {
    setSceneData(snapshot.sceneData);
    setEditableScene(snapshot.editableScene);
    setResult(snapshot.result);
    setQueueItems(snapshot.queueItems);
  }), []);

  useEffect(() => { filesRef.current = files; }, [files]);

  useEffect(() => {
    const next = {};
    Promise.all(selectedCharIds.map(id => charApi.get(id).then(d => { next[id] = d; }).catch(() => {}))).then(() => setCharDetails(next));
  }, [selectedCharIds]);

  useEffect(() => {
    const serialized = files
      .filter((entry) => entry.file)
      .map((entry) => ({
        id: entry.id,
        name: entry.file.name,
        type: entry.file.type,
        size: entry.file.size,
        dataUrl: entry.previewUrl,
      }));
    writeStoredSourceFiles(serialized);
  }, [files]);

  const handleInstagramImport = async (linksText = instagramLinks) => {
    const lines = linksText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('http'));

    if (lines.length === 0) {
      notify('Please enter at least one valid Instagram, TikTok, or X URL', 'error');
      return;
    }

    setIsExtractingInstagram(true);
    notify(`Starting import for ${lines.length} link(s)…`, 'info');

    const newFailures = [];
    const successfulFiles = [];

    for (const url of lines) {
      const isTikTok = url.toLowerCase().includes('tiktok.com');
      const isX = url.toLowerCase().includes('x.com') || url.toLowerCase().includes('twitter.com');
      const platformName = isTikTok ? 'TikTok' : isX ? 'X' : 'Instagram';
      const filePrefix = isTikTok ? 'tiktok' : isX ? 'x' : 'instagram';
      try {
        const res = await fetch('/api/instagram-frames/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, frameCount: 2, intervalMs: 300 }),
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          const errorMsg = (typeof json.error === 'object' ? json.error?.message : json.error) || json.message || 'Extraction failed';
          throw new Error(errorMsg);
        }

        const frames = json.data?.frames || [];
        if (frames.length === 0) {
          throw new Error('No frames returned');
        }

        let selectedFrame = null;
        if (frames.length >= 2 && frames[1].timestampMs > 0) {
          selectedFrame = frames[1];
        } else {
          let imgIndex = null;
          try {
            const urlObj = new URL(url);
            const val = urlObj.searchParams.get('img_index');
            if (val) {
              const parsed = parseInt(val, 10);
              if (!isNaN(parsed) && parsed > 0) {
                imgIndex = parsed;
              }
            }
          } catch {}

          if (imgIndex !== null && frames[imgIndex - 1]) {
            selectedFrame = frames[imgIndex - 1];
          } else {
            selectedFrame = frames[0];
          }
        }

        if (!selectedFrame) {
          throw new Error('Selected frame not found');
        }

        const mimeType = selectedFrame.mimeType || 'image/jpeg';
        const base64 = selectedFrame.base64;
        const file = dataUrlToFile(`data:${mimeType};base64,${base64}`, `${filePrefix}-${Date.now()}.jpg`);
        
        if (file) {
          successfulFiles.push({
            file,
            previewUrl: `data:${mimeType};base64,${base64}`,
            id: `${filePrefix}-${Date.now()}-${Math.random()}`,
          });
        }
      } catch (err) {
        newFailures.push({ url, errorMessage: err.message || 'Unknown error' });
      }
    }

    if (successfulFiles.length > 0) {
      setFiles(prev => [...prev, ...successfulFiles]);
      notify(`Successfully imported ${successfulFiles.length} image(s)`, 'success');
      scenePageStore.patch({ sceneData: null, editableScene: '', result: null });
    }

    if (newFailures.length > 0) {
      setFailedInstagramLinks(prev => {
        const existingUrls = prev.map(f => f.url);
        const merged = [...prev];
        for (const failure of newFailures) {
          if (!existingUrls.includes(failure.url)) {
            merged.push(failure);
          } else {
            const idx = merged.findIndex(f => f.url === failure.url);
            if (idx >= 0) merged[idx] = failure;
          }
        }
        return merged;
      });
      notify(`Failed to import ${newFailures.length} link(s)`, 'error');
    }

    const failedUrls = newFailures.map(f => f.url);
    const remainingText = lines
      .filter(url => failedUrls.includes(url))
      .join('\n');
    setInstagramLinks(remainingText);
    setIsExtractingInstagram(false);
  };

  const handleRetryFailedLink = async (failedItem) => {
    setFailedInstagramLinks(prev => prev.filter(f => f.url !== failedItem.url));
    await handleInstagramImport(failedItem.url);
  };

  const addFiles = useCallback(async (incoming) => {
    const valid = [...incoming].filter(f => f.type.startsWith('image/'));
    if (valid.length === 0) { notify('Please use image files (PNG, JPEG, WebP)', 'error'); return; }
    
    // Compress large images first
    const compressed = await Promise.all(valid.map(f => resizeAndCompressImage(f)));
    
    const next = await Promise.all(compressed.map(async (f) => ({
      file: f,
      previewUrl: await fileToBase64(f),
      id: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`,
    })));
    setFiles(prev => [...prev, ...next]);
    scenePageStore.patch({ sceneData: null, editableScene: '', result: null });
  }, [notify]);

  const removeFile = (id) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const clearFiles = () => {
    setFiles([]);
  };

  const toggleCharacter = (id) => setSelectedCharIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  useEffect(() => {
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'));
      if (!item) return;
      e.preventDefault();
      const pastedFile = item.getAsFile();
      if (pastedFile) {
        addFiles([pastedFile]);
        notify('Pasted scene image from clipboard', 'success');
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles, notify]);

  // ── Extension handoff (localStorage written before this page loads) ──────
  useEffect(() => {
    async function consumeHandoff() {
      try {
        const raw = localStorage.getItem('kyros_handoff');
        if (!raw) return;
        const handoff = JSON.parse(raw);
        if (handoff.feature !== 'scene-recreate') return;
        if (Date.now() - handoff.ts > 60000) return;
        localStorage.removeItem('kyros_handoff');

        const imageUrl = handoff.pinImage;
        if (!imageUrl) return;

        notify('Loading pin image…', 'info');
        const proxyUrl = `/api/pinterest/proxy?url=${encodeURIComponent(imageUrl)}`;
        const resp = await fetch(proxyUrl);
        if (!resp.ok) throw new Error(`Proxy ${resp.status}`);
        const blob = await resp.blob();
        const ext  = blob.type.split('/')[1] || 'jpg';
        addFiles([new File([blob], `pin.${ext}`, { type: blob.type })]);
        notify('Pin image auto-loaded ⚡ Choose a character and generate!', 'success');
      } catch (err) {
        notify(`Could not load pin: ${err.message}`, 'error');
      }
    }

    consumeHandoff();
    window.addEventListener('kyros:handoff', consumeHandoff);
    return () => window.removeEventListener('kyros:handoff', consumeHandoff);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFile = (e) => {
    addFiles(e.target.files || []);
    e.target.value = '';
  };

  const handleDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = () => setIsDragging(false);
  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragging(false);

    // 1. Check if dropped custom Kyros library items
    const rawData = e.dataTransfer?.getData('application/json');
    if (rawData) {
      try {
        const payload = JSON.parse(rawData);
        if (payload?.type === 'kyros-library-items' && Array.isArray(payload.items)) {
          const filesToAdd = [];
          for (const item of payload.items) {
            const response = await fetch(item.previewUrl, { credentials: 'include' });
            if (response.ok) {
              const blob = await response.blob();
              filesToAdd.push(new File([blob], item.name, { type: blob.type }));
            }
          }
          if (filesToAdd.length > 0) {
            addFiles(filesToAdd);
            notify(`Loaded ${filesToAdd.length} image${filesToAdd.length === 1 ? '' : 's'} from Library`, 'success');
          }
          return;
        }
      } catch (err) {
        console.error('Failed to parse dropped library items', err);
      }
    }

    // 2. Fallback to normal files drop
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  const handlePasteFromClipboard = async () => {
    if (!navigator.clipboard?.read) {
      notify('Clipboard image paste is not supported in this browser. Try Ctrl+V instead.', 'error');
      return;
    }
    const clipboardItems = await navigator.clipboard.read();
    const imageItem = clipboardItems.find((entry) => entry.types.some((type) => type.startsWith('image/')));
    if (!imageItem) { notify('No image found in clipboard', 'error'); return; }
    const imageType = imageItem.types.find((type) => type.startsWith('image/'));
    const blob = await imageItem.getType(imageType);
    const pastedFile = new File([blob], `scene-paste-${Date.now()}.${imageType.split('/')[1] || 'png'}`, { type: imageType });
    addFiles([pastedFile]);
    notify('Pasted scene image from clipboard', 'success');
  };

  const activeQueueCount = queueItems.filter((job) => job.status === 'running').length;
  const pendingQueueCount = queueItems.filter((job) => job.status === 'pending').length;
  const failedQueueCount = queueItems.filter((job) => job.status === 'error').length;
  const completedQueueCount = queueItems.filter((job) => job.status === 'completed').length;
  const isRecreating = queueItems.some((job) => job.status === 'running' && job.kind === 'recreate');
  const totalJobs = files.length * selectedCharIds.length;

  const runQueueJob = useCallback(async (job) => {
    if (!job?.id || runningJobsRef.current.has(job.id)) return;
    runningJobsRef.current.add(job.id);

    const fileEntry = filesRef.current.find(f => f.id === job.fileId);
    const fileSnap = fileEntry?.file;
    const opts = job.opts || {};

    if (!fileSnap) {
      runningJobsRef.current.delete(job.id);
      scenePageStore.setValue('queueItems', (prev) => prev.map((item) => (
        item.id === job.id ? { ...item, status: 'error', errorMessage: 'Source image was removed. Add it again to retry.' } : item
      )));
      return;
    }

    pushPending({ id: job.id, prompt: 'Scene Recreate', imageModel: opts.imageModel || '', aspectRatio: opts.aspectRatio, resolutionTier: opts.resolutionTier });

    try {
      const dataUri = await fileToBase64(fileSnap);
      const base64 = dataUri.split(',')[1];
      const analyzed = await sceneApi.analyze(base64, fileSnap.type);
      const text = Object.entries(analyzed).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
      scenePageStore.patch({ sceneData: analyzed, editableScene: text });
      const parsed = {};
      (opts.editableScene || text).split('\n').forEach((line) => {
        const idx = line.indexOf(':');
        if (idx > 0) parsed[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
      const data = await sceneApi.recreate({
        sceneData: { ...analyzed, ...parsed },
        characterId: job.characterId,
        activeReferenceIds: job.activeReferenceIds?.length > 0 ? job.activeReferenceIds : undefined,
        masterPromptOverride: job.masterPromptOverride || undefined,
        aspectRatio: opts.aspectRatio,
        resolutionTier: opts.resolutionTier,
        imageModel: opts.imageModel,
        sameBackground: opts.sameBackground,
        samePose: opts.samePose,
        sameHair: opts.sameHair,
        sameTattoos: opts.sameTattoos,
        provider: opts.provider,
      });
      scenePageStore.setValue('result', data);
      scenePageStore.setValue('history', (prev) => [data, ...prev].slice(0, 10));
      scenePageStore.setValue('queueItems', (prev) => prev.filter((item) => item.id !== job.id));
      resolvePending(job.id, {
        imageId: data.imageId,
        galleryId: data.galleryId || data.imageId,
        mimeType: data.image?.mimeType,
        prompt: job.masterPromptOverride || 'Scene Recreate',
        imageModel: opts.imageModel || '',
        aspectRatio: opts.aspectRatio,
        resolutionTier: opts.resolutionTier,
        generatedAt: Date.now(),
        characterId: job.characterId || null,
      });
      notify('Scene recreated!', 'success');
    } catch (err) {
      rejectPending(job.id);
      scenePageStore.setValue('queueItems', (prev) => prev.map((item) => (
        item.id === job.id ? { ...item, status: 'error', errorMessage: err?.message || 'Failed to recreate scene' } : item
      )));
      notify(err?.message || 'Failed to recreate scene', 'error');
    } finally {
      runningJobsRef.current.delete(job.id);
    }
  }, [notify]);

  useEffect(() => {
    if (queuePaused) return;
    const runningCount = queueItems.filter((job) => job.status === 'running').length;
    const slots = MAX_RUNNING_SCENE_JOBS - runningCount;
    if (slots <= 0) return;
    const nextJobs = queueItems.filter((job) => job.status === 'pending').slice(0, slots);
    if (nextJobs.length === 0) return;
    scenePageStore.setValue('queueItems', (prev) => prev.map((job) => (
      nextJobs.some((nextJob) => nextJob.id === job.id) ? { ...job, status: 'running', errorMessage: '' } : job
    )));
    nextJobs.forEach(runQueueJob);
  }, [queueItems, queuePaused, runQueueJob]);

  const handleGenerate = () => {
    if (files.length === 0) { notify('Upload at least one image first', 'error'); return; }
    if (selectedCharIds.length === 0) { notify('Select at least one character', 'error'); return; }
    const opts = { aspectRatio, resolutionTier, imageModel, sameBackground, samePose, sameHair, sameTattoos, provider, editableScene };
    const jobs = [];
    for (const { file: f, id: fileId } of files) {
      for (const characterId of selectedCharIds) {
        const detail = charDetails[characterId] || null;
        const activeReferenceIds = detail?.references?.filter((r) => r.isActive).map((r) => r.id) || [];
        jobs.push({
          id: makePersistentJobId('scene-recreate'), kind: 'recreate', status: 'pending', label: 'Recreating Scene',
          fileId, characterId, activeReferenceIds, masterPromptOverride: String(detail?.masterPrompt || '').trim(), opts,
          summary: f.name || 'Scene image',
          meta: `${aspectRatio} · ${resolutionTier}`,
          badges: [detail?.name ? { label: detail.name, color: 'zinc' } : null, { label: imageModel, color: 'zinc' }].filter(Boolean),
        });
      }
    }
    scenePageStore.setValue('queueItems', (prev) => [...prev, ...jobs]);
    notify(`${jobs.length} job${jobs.length === 1 ? '' : 's'} added to queue`, 'success');
  };

  useEffect(() => {
    const onInboxSource = (e) => {
      const items = Array.isArray(e.detail?.items) ? e.detail.items : [];
      if (items.length === 0) return;
      const filesToAdd = items
        .map((item) => dataUrlToFile(item.dataUrl, item.name))
        .filter(Boolean);
      if (filesToAdd.length === 0) return;
      addFiles(filesToAdd);
      notify(`Loaded ${filesToAdd.length} image${filesToAdd.length === 1 ? '' : 's'} from Paste Inbox into Scene Recreate`, 'success');
    };
    window.addEventListener('kyros:use-as-scene-source', onInboxSource);
    return () => window.removeEventListener('kyros:use-as-scene-source', onInboxSource);
  }, [addFiles, notify]);

  const retryJob = (id) => {
    scenePageStore.setValue('queueItems', (prev) => prev.map((job) => job.id === id ? { ...job, status: 'pending', errorMessage: '' } : job));
  };

  const clearFailedJobs = () => {
    scenePageStore.setValue('queueItems', (prev) => prev.filter((job) => job.status !== 'error'));
  };

  const clearCompletedJobs = () => {
    scenePageStore.setValue('queueItems', (prev) => prev.filter((job) => job.status !== 'completed'));
  };

  return (
    <div className="space-y-6 animate-in">
      <div className="max-w-md">

        {/* ── CONTROLS ── */}
        <div className="space-y-3">

          {/* Upload card */}
          <Card className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Scene Images</span>
              <div className="flex items-center gap-2">
                {files.length > 0 && <Badge color="blue">{files.length} photo{files.length > 1 ? 's' : ''}</Badge>}
                <Badge color="zinc">Ctrl+V</Badge>
              </div>
            </div>
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`flex items-center justify-center border-2 border-dashed rounded-xl cursor-pointer transition-all min-h-[160px] px-4 py-4 ${isDragging ? 'border-blue-500/80 bg-blue-500/10' : 'border-zinc-700/60 hover:border-zinc-500/60 hover:bg-zinc-800/20'}`}
            >
              <div className="text-center flex flex-col items-center gap-2 py-6 [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor]">
                <div className="w-10 h-10 rounded-xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center">
                  <IconCamera uniqueId="scene-upload" size={20} className="text-zinc-400" aria-hidden />
                </div>
                <div>
                  <p className="text-sm text-zinc-400 font-medium">Drop images here or click to browse</p>
                  <p className="text-xs text-zinc-600 mt-0.5">PNG, JPEG, WebP · no image limit</p>
                </div>
              </div>
              <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={handleFile} />
            </div>

            {files.length > 0 && (
              <div>
                <div className="grid grid-cols-4 gap-2">
                  {files.map(({ id, previewUrl, file: sourceFile }) => (
                    <div key={id} className="relative aspect-square overflow-hidden rounded-lg border border-zinc-700/60 bg-zinc-900 group">
                      <img src={previewUrl} alt={sourceFile.name} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeFile(id); }}
                        className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-xs font-bold text-zinc-300 opacity-0 transition group-hover:opacity-100 hover:bg-red-500/80 hover:text-white"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="flex aspect-square cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-zinc-700/60 bg-zinc-900/40 text-zinc-600 transition hover:border-zinc-500 hover:text-zinc-400"
                  >
                    <span className="text-xl font-light">+</span>
                  </div>
                </div>
                <button type="button" onClick={clearFiles} className="mt-2 text-xs text-zinc-600 transition hover:text-red-400">Clear all</button>
              </div>
            )}

            <Btn variant="secondary" onClick={handlePasteFromClipboard} className="w-full text-xs py-2 mb-3">
              Paste from Clipboard
            </Btn>

            <div className="pt-2 border-t border-zinc-800/80">
              <button
                type="button"
                onClick={() => setShowInstagramImport(prev => !prev)}
                className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition font-medium cursor-pointer"
              >
                <span className="text-[10px] transform transition-transform duration-200 inline-block" style={{ transform: showInstagramImport ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                Import from Instagram / TikTok / X URL
              </button>

              {showInstagramImport && (
                <div className="mt-3 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
                  <p className="text-[11px] text-zinc-500 leading-normal">
                    Paste Instagram, TikTok, or X URLs (one per line). Carousel posts support <code className="text-zinc-400 bg-zinc-850 px-1 py-0.5 rounded">?img_index=N</code>.
                  </p>
                  <textarea
                    value={instagramLinks}
                    onChange={e => setInstagramLinks(e.target.value)}
                    placeholder="https://www.instagram.com/p/...&#10;https://www.tiktok.com/@username/video/...&#10;https://x.com/username/status/..."
                    rows={3}
                    className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-3 py-2 text-xs font-mono text-zinc-300 placeholder-zinc-700 outline-none focus:border-blue-500/60 resize-none"
                    disabled={isExtractingInstagram}
                  />
                  <button
                    type="button"
                    onClick={() => handleInstagramImport()}
                    disabled={isExtractingInstagram || !instagramLinks.trim()}
                    className="w-full rounded-lg bg-zinc-800 hover:bg-zinc-750 text-zinc-200 text-xs py-2 font-medium transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
                  >
                    {isExtractingInstagram ? (
                      <>
                        <Spinner size="xs" />
                        <span>Extracting...</span>
                      </>
                    ) : (
                      <span>Import Links</span>
                    )}
                  </button>

                  {/* Failed Links Panel */}
                  {failedInstagramLinks.length > 0 && (
                    <div className="mt-3 rounded-lg border border-red-900/30 bg-red-950/10 p-2.5 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-semibold text-red-400 uppercase tracking-wider">Failed Downloads</span>
                        <button
                          type="button"
                          onClick={() => setFailedInstagramLinks([])}
                          className="text-[10px] text-zinc-500 hover:text-zinc-300 transition"
                        >
                          Clear All
                        </button>
                      </div>
                      <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                        {failedInstagramLinks.map((item, idx) => (
                          <div key={idx} className="flex flex-col gap-1 text-[11px] bg-red-950/20 border border-red-900/20 rounded p-1.5">
                            <span className="font-mono text-zinc-400 truncate" title={item.url}>{item.url}</span>
                            <span className="text-red-400/80 leading-normal">{item.errorMessage}</span>
                            <div className="flex items-center gap-2 mt-1">
                              <button
                                type="button"
                                onClick={() => handleRetryFailedLink(item)}
                                className="text-[10px] text-blue-400 hover:text-blue-300 font-semibold"
                              >
                                Retry
                              </button>
                              <span className="text-zinc-700">|</span>
                              <button
                                type="button"
                                onClick={() => setFailedInstagramLinks(prev => prev.filter(f => f.url !== item.url))}
                                className="text-[10px] text-zinc-500 hover:text-zinc-400"
                              >
                                Dismiss
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>

          {/* Scene details — shown after first generate */}
          {sceneData && (
            <Card className="space-y-3 animate-in">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Scene Details</span>
                <Badge color="green">Analyzed</Badge>
              </div>
              <div className="grid grid-cols-1 gap-1 max-h-44 overflow-y-auto pr-1">
                {Object.entries(sceneData).filter(([, v]) => v).map(([key, val]) => (
                  <div key={key} className="flex gap-2 py-0.5">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wide shrink-0 w-20 pt-0.5">{key}</span>
                    <span className="text-xs text-zinc-300 leading-relaxed">{val}</span>
                  </div>
                ))}
              </div>
              <Textarea
                label="Edit description (used on next generate)"
                value={editableScene}
                onChange={(e) => scenePageStore.setValue('editableScene', e.target.value)}
                className="!min-h-[64px] !text-xs"
              />
            </Card>
          )}

          {/* Settings card — always visible */}
          <Card className="space-y-4">
            <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Settings</span>

            {/* Character */}
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Character</span>
              {chars.length === 0 ? (
                <p className="text-xs text-zinc-500">No characters yet.</p>
              ) : (
                <div className="space-y-1 max-h-52 overflow-y-auto pr-1">
                  {chars.map((c) => {
                    const isChecked = selectedCharIds.includes(c.id);
                    const detail = charDetails[c.id];
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleCharacter(c.id)}
                        className={`w-full flex items-center gap-3 rounded-lg border px-3 py-2 text-sm transition cursor-pointer text-left ${isChecked ? 'border-blue-500/60 bg-blue-500/15 text-blue-100' : 'border-zinc-700/60 bg-zinc-900/40 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800/60'}`}
                      >
                        <span className={`flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center transition ${isChecked ? 'border-blue-400 bg-blue-500' : 'border-zinc-600'}`}>
                          {isChecked && <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                        </span>
                        <span className="flex-1 font-medium truncate">{c.name}</span>
                        {detail?.references?.filter((r) => r.isActive).length > 0 && <Badge color="zinc">{detail.references.filter((r) => r.isActive).length} refs</Badge>}
                      </button>
                    );
                  })}
                </div>
              )}
              {characterPromptPreview && (
                <div className="mt-3 rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Character Prompt</span>
                    <Badge color="blue">Auto applied</Badge>
                  </div>
                  <p className="mt-2 line-clamp-4 text-xs leading-5 text-zinc-300">
                    {characterPromptPreview}
                  </p>
                </div>
              )}
            </div>

            {/* Model */}
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Image Model</span>
              <select
                value={imageModel}
                onChange={(e) => setImageModel(e.target.value)}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
              >
                {IMAGE_MODEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Provider */}
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Provider</span>
              <div className="flex gap-2">
                {[
                  { value: 'auto', label: 'Auto' },
                  { value: 'gemini', label: 'Gemini' },
                  { value: 'vertex', label: 'Vertex' },
                ].map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setProvider(p.value)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition cursor-pointer ${
                      provider === p.value
                        ? 'border-blue-500/60 bg-blue-500/15 text-blue-100'
                        : 'border-zinc-700/70 bg-zinc-900/50 text-zinc-400 hover:border-zinc-600'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-zinc-600 mt-1">Gemini = direct API (better bypass). Vertex = GCP account.</p>
            </div>

            {/* Aspect ratio + resolution */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-xs text-zinc-400 font-medium block mb-1.5">Aspect Ratio</span>
                <div className="flex flex-wrap gap-1">
                  {ASPECT_RATIOS.map((ar) => (
                    <button
                      key={ar}
                      onClick={() => setAspectRatio(ar)}
                      className={`rounded-md px-2 py-1 text-[11px] font-medium transition cursor-pointer ${aspectRatio === ar ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
                    >
                      {ar}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className="text-xs text-zinc-400 font-medium block mb-1.5">Resolution</span>
                <div className="flex flex-wrap gap-1">
                  {RESOLUTION_TIERS.map((tier) => (
                    <button
                      key={tier}
                      onClick={() => setResolutionTier(tier)}
                      className={`rounded-md px-2 py-1 text-[11px] font-medium transition cursor-pointer ${resolutionTier === tier ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
                    >
                      {tier}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Lock options */}
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Lock</span>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setSameBackground(v => !v)} className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition cursor-pointer border ${sameBackground ? 'bg-blue-600/20 text-blue-300 border-blue-500/60' : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/60 hover:bg-zinc-700/60 hover:text-zinc-300'}`}>
                  {sameBackground ? '🔒' : '🔓'} Background
                </button>
                <button type="button" onClick={() => setSamePose(v => !v)} className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition cursor-pointer border ${samePose ? 'bg-purple-600/20 text-purple-300 border-purple-500/60' : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/60 hover:bg-zinc-700/60 hover:text-zinc-300'}`}>
                  {samePose ? '🔒' : '🔓'} Pose
                </button>
                <button type="button" onClick={() => setSameHair(v => !v)} className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition cursor-pointer border ${sameHair ? 'bg-emerald-600/20 text-emerald-300 border-emerald-500/60' : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/60 hover:bg-zinc-700/60 hover:text-zinc-300'}`}>
                  {sameHair ? '🔒' : '🔓'} Hair
                </button>
                <button type="button" onClick={() => setSameTattoos(v => !v)} className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition cursor-pointer border ${sameTattoos ? 'bg-amber-600/20 text-amber-300 border-amber-500/60' : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/60 hover:bg-zinc-700/60 hover:text-zinc-300'}`}>
                  {sameTattoos ? '🔒' : '🔓'} Tattoos
                </button>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                Hair and tattoos stay off by default. Turn them on only when you want to copy those details from the source scene.
              </p>
            </div>

            {/* Generate button */}
            {totalJobs > 1 && files.length > 0 && selectedCharIds.length > 0 && (
              <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 px-3 py-2 text-xs text-blue-300">
                {files.length} photo{files.length > 1 ? 's' : ''} × {selectedCharIds.length} character{selectedCharIds.length > 1 ? 's' : ''} = <span className="font-bold">{totalJobs} jobs</span>
              </div>
            )}

            <Btn onClick={handleGenerate} disabled={files.length === 0 || selectedCharIds.length === 0} className="w-full py-3 text-sm font-semibold">
              {activeQueueCount > 0 ? `Queue More · ${activeQueueCount}/2 running` : totalJobs > 1 ? `Scene Recreate ×${totalJobs}` : 'Generate Scene'}
            </Btn>

            {queueItems.length > 0 && (
              <div className="space-y-2 rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-zinc-200">Queue</div>
                    <div className="text-[11px] text-zinc-500">Runs max 2 jobs at a time. Finished jobs auto-clear.</div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {pendingQueueCount > 0 && <Badge color="zinc">{pendingQueueCount} pending</Badge>}
                    {activeQueueCount > 0 && <Badge color="blue">{activeQueueCount} running</Badge>}
                    {failedQueueCount > 0 && <Badge color="red">{failedQueueCount} error</Badge>}
                    {completedQueueCount > 0 && <Badge color="green">{completedQueueCount} done</Badge>}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setQueuePaused(v => !v)} className="rounded-md border border-zinc-700/70 bg-zinc-900/70 px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 cursor-pointer">
                    {queuePaused ? 'Resume' : 'Pause all'}
                  </button>
                  <button type="button" onClick={clearFailedJobs} disabled={failedQueueCount === 0} className="rounded-md border border-zinc-700/70 bg-zinc-900/70 px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer">
                    Clear failed
                  </button>
                  <button type="button" onClick={clearCompletedJobs} disabled={completedQueueCount === 0} className="rounded-md border border-zinc-700/70 bg-zinc-900/70 px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer">
                    Clear completed
                  </button>
                </div>

                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {queueItems.map((job) => (
                    <div key={job.id} className="rounded-lg border border-zinc-800/70 bg-zinc-900/50 px-3 py-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge color={job.status === 'running' ? 'blue' : job.status === 'error' ? 'red' : 'zinc'}>
                              {job.status === 'running' ? 'Running' : job.status === 'error' ? 'Error' : 'Pending'}
                            </Badge>
                            {Array.isArray(job.badges) && job.badges.map((badge, index) => (
                              <Badge key={`${job.id}-${badge?.label || badge}-${index}`} color={badge?.color || 'zinc'}>{badge?.label || badge}</Badge>
                            ))}
                          </div>
                          <div className="truncate text-sm text-zinc-200">{job.summary || 'Scene image'}</div>
                          {job.meta && <div className="text-[10px] font-mono text-zinc-600">{job.meta}</div>}
                          {job.status === 'error' && <div className="text-xs text-red-300 line-clamp-3">{job.errorMessage || 'Failed'}</div>}
                        </div>
                        {job.status === 'running' ? (
                          <span className="w-4 h-4 rounded-full border border-t-white border-white/20 animate-spin" />
                        ) : job.status === 'error' ? (
                          <button type="button" onClick={() => retryJob(job.id)} className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-200 transition hover:bg-red-500/20 cursor-pointer">Retry</button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

        </div>
      </div>
      <LightboxComponent />
    </div>
  );
}
