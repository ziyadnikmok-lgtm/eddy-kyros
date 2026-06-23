import { useState, useEffect, useCallback, useRef } from 'react';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { photoMatch as photoMatchApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Badge, Spinner } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { ASPECT_RATIOS, RESOLUTION_TIERS, IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL } from '../config/photoModes';
import { createPersistentPageState, makePersistentJobId } from '../lib/persistentPageState';
import { IconImage } from 'nucleo-glass';

const PHOTO_MATCH_HANDOFF_KEY = 'kyros.photoMatch.handoff';
const PHOTO_MATCH_SOURCE_STORAGE_KEY = 'kyros.photoMatch.sources';
const MAX_RUNNING_PHOTO_MATCH_JOBS = 3;

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl, filename = 'photo-match-source.png') {
  const match = dataUrl?.match(/^data:([^;]+);base64,(.+)$/);
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

function readPhotoMatchHandoff() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(PHOTO_MATCH_HANDOFF_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(PHOTO_MATCH_HANDOFF_KEY);
    return JSON.parse(raw);
  } catch { return null; }
}

function readStoredSourceFiles() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PHOTO_MATCH_SOURCE_STORAGE_KEY);
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
    if (payload.length === 0) window.localStorage.removeItem(PHOTO_MATCH_SOURCE_STORAGE_KEY);
    else window.localStorage.setItem(PHOTO_MATCH_SOURCE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage failures.
  }
}

function StrengthSlider({ label, sublabel, value, onChange, color = '#6366f1', disabled = false }) {
  const low = value < 35;
  const mid = value >= 35 && value < 70;
  const levelLabel = low ? 'Loose' : mid ? 'Close' : value >= 85 ? 'Exact' : 'Strong';
  const levelColor = low ? '#f59e0b' : mid ? '#3b82f6' : '#22c55e';
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="text-sm font-medium text-zinc-200">{label}</span>
          {sublabel && <span className="text-xs text-zinc-500 ml-2">{sublabel}</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-zinc-400">{value}%</span>
          <span className="text-[10px] font-semibold rounded-full px-2 py-0.5" style={{ background: levelColor + '22', color: levelColor, border: `1px solid ${levelColor}44` }}>{levelLabel}</span>
        </div>
      </div>
      <div className="relative h-7 flex items-center">
        <div className="absolute inset-x-0 h-1.5 rounded-full bg-zinc-800" />
        <div className="absolute left-0 h-1.5 rounded-full transition-all" style={{ width: `${value}%`, background: `linear-gradient(90deg, ${color}88, ${color})` }} />
        <input type="range" min="0" max="100" step="5" value={value}
          onChange={e => onChange(Number(e.target.value))} disabled={disabled}
          className={`absolute inset-x-0 w-full opacity-0 h-7 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
          style={{ zIndex: 2 }} />
        <div className="absolute h-4 w-4 rounded-full shadow-lg border-2 border-white/20 pointer-events-none transition-all"
          style={{ left: `calc(${value}% - 8px)`, background: color, boxShadow: `0 0 8px ${color}66` }} />
      </div>
      <div className="flex justify-between text-[10px] text-zinc-600 mt-1 px-0.5">
        <span>Loose</span><span>Close</span><span>Exact</span>
      </div>
    </div>
  );
}

const _cache = {
  selectedCharIds: [], bgStrength: 85, poseStrength: 85,
  exactRecreate: false, varyBackground: false, aspectRatio: '9:16', resolutionTier: '1K',
  imageModel: DEFAULT_IMAGE_MODEL,
  provider: 'gemini',
};

const photoMatchStore = createPersistentPageState('photo-match', { result: null, history: [], queueItems: [] });

export default function PhotoMatchPage() {
  const { notify, characters: chars, consumePageParams } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const dropRef = useRef(null);
  const fileInputRef = useRef(null);
  const filesRef = useRef([]);
  const runningJobsRef = useRef(new Set());
  const initialStoreState = photoMatchStore.getSnapshot();

  // Multiple source files
  const [files, setFiles] = useState(() => readStoredSourceFiles().map((item) => ({
    file: dataUrlToFile(item.dataUrl, item.name),
    previewUrl: item.dataUrl,
    id: item.id,
  })).filter((entry) => entry.file)); // [{ file, previewUrl, id }]
  const [isDragging, setIsDragging] = useState(false);
  const [selectedCharIds, setSelectedCharIds] = useState(_cache.selectedCharIds);
  const [charDetails, setCharDetails] = useState({});
  const [bgStrength, setBgStrength] = useState(_cache.bgStrength);
  const [poseStrength, setPoseStrength] = useState(_cache.poseStrength);
  const [exactRecreate, setExactRecreate] = useState(_cache.exactRecreate);
  const [varyBackground, setVaryBackground] = useState(_cache.varyBackground);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolutionTier, setResolutionTier] = useState(_cache.resolutionTier);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [provider, setProvider] = useState(_cache.provider);
  const [queueItems, setQueueItems] = useState(initialStoreState.queueItems);
  const [queuePaused, setQueuePaused] = useState(false);

  const [instagramLinks, setInstagramLinks] = useState('');
  const [failedInstagramLinks, setFailedInstagramLinks] = useState([]);
  const [isExtractingInstagram, setIsExtractingInstagram] = useState(false);
  const [showInstagramImport, setShowInstagramImport] = useState(false);

  useEffect(() => { _cache.selectedCharIds = selectedCharIds; }, [selectedCharIds]);
  useEffect(() => photoMatchStore.subscribe((s) => setQueueItems(s.queueItems)), []);
  useEffect(() => { filesRef.current = files; }, [files]);

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
      // Skip persisting previews for large batches — localStorage has a ~5MB limit
      // and 20+ high-res images will exceed it. Files remain in-memory just fine.
      if (serialized.length <= 20) writeStoredSourceFiles(serialized);
      else window.localStorage.removeItem(PHOTO_MATCH_SOURCE_STORAGE_KEY);
    }, [files]);


  // Fetch details for selected characters
  useEffect(() => {
    const nd = {};
    Promise.all(selectedCharIds.map(id => charApi.get(id).then(d => { nd[id] = d; }).catch(() => {}))).then(() => setCharDetails(nd));
  }, [selectedCharIds]);



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
      photoMatchStore.setValue('result', null);
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
    if (valid.length === 0) { notify('Only PNG, JPEG, WebP allowed', 'error'); return; }
    
    // Compress large images first
    const compressed = await Promise.all(valid.map(f => resizeAndCompressImage(f)));
    
    const next = await Promise.all(compressed.map(async (f) => ({
      file: f,
      previewUrl: await fileToBase64(f),
      id: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`,
    })));
    setFiles(prev => [...prev, ...next]);
    photoMatchStore.setValue('result', null);
  }, [notify]);

  const removeFile = (id) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const clearAll = () => {
    setFiles([]);
  };

  // Single-file handoff (from other pages / extensions)
  const applyFile = useCallback((f) => addFiles([f]), [addFiles]);

  useEffect(() => {
    const params = consumePageParams();
    const handoff = params?.sourceImageBase64 ? params : readPhotoMatchHandoff();
    if (!handoff?.sourceImageBase64) return;
    const mimeType = handoff.sourceImageMimeType || 'image/png';
    const filename = handoff.sourceImageName || 'nsfw-generate';
    const sourceFile = dataUrlToFile(`data:${mimeType};base64,${handoff.sourceImageBase64}`, filename);
    if (!sourceFile) { notify('Could not load source image', 'error'); return; }
    applyFile(sourceFile);
    if (handoff.characterId) setSelectedCharIds([handoff.characterId]);
    if (handoff.exactRecreate === true) { setExactRecreate(true); setBgStrength(100); setPoseStrength(100); }
    if (typeof handoff.aspectRatio === 'string' && ASPECT_RATIOS.includes(handoff.aspectRatio)) setAspectRatio(handoff.aspectRatio);
    if (typeof handoff.resolutionTier === 'string' && RESOLUTION_TIERS.includes(handoff.resolutionTier)) setResolutionTier(handoff.resolutionTier);
    notify('Loaded image from NSFW Generate', 'success');
  }, [applyFile, consumePageParams, notify]);

  useEffect(() => {
    async function consumeHandoff() {
      try {
        const raw = localStorage.getItem('kyros_handoff');
        if (!raw) return;
        const handoff = JSON.parse(raw);
        if (handoff.feature !== 'photo-match') return;
        if (Date.now() - handoff.ts > 60000) return;
        localStorage.removeItem('kyros_handoff');
        const imageUrl = handoff.pinImage;
        if (!imageUrl) return;
        notify('Loading pin image…', 'info');
        const resp = await fetch(`/api/pinterest/proxy?url=${encodeURIComponent(imageUrl)}`);
        if (!resp.ok) throw new Error(`Proxy ${resp.status}`);
        const blob = await resp.blob();
        const ext = blob.type.split('/')[1] || 'jpg';
        applyFile(new File([blob], `pin.${ext}`, { type: blob.type }));
        notify('Pin image auto-loaded ⚡', 'success');
      } catch (err) { notify(`Could not load pin: ${err.message}`, 'error'); }
    }
    consumeHandoff();
    window.addEventListener('kyros:handoff', consumeHandoff);
    return () => window.removeEventListener('kyros:handoff', consumeHandoff);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onPaste = (e) => {
      // Windows Explorer multi-file copy puts files in clipboardData.files
      const clipFiles = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
      if (clipFiles.length > 0) {
        e.preventDefault();
        addFiles(clipFiles);
        notify(`Pasted ${clipFiles.length} image${clipFiles.length > 1 ? 's' : ''} from clipboard`, 'success');
        return;
      }
      // Fallback: single screenshot pasted directly as image data
      const items = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/'));
      if (items.length === 0) return;
      e.preventDefault();
      const pastedFiles = items.map(i => i.getAsFile()).filter(Boolean);
      if (pastedFiles.length > 0) {
        addFiles(pastedFiles);
        notify(`Pasted ${pastedFiles.length} image${pastedFiles.length > 1 ? 's' : ''} from clipboard`, 'success');
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles, notify]);

  useEffect(() => {
    const onUseAsSource = (e) => {
      const { base64, mimeType, name } = e.detail || {};
      if (!base64 || !mimeType) return;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const ext = mimeType.split('/')[1] || 'png';
      applyFile(new File([bytes], name || `source.${ext}`, { type: mimeType }));
    };
    window.addEventListener('kyros:use-as-source', onUseAsSource);
    return () => window.removeEventListener('kyros:use-as-source', onUseAsSource);
  }, [applyFile]);

  useEffect(() => {
    const onInboxSource = (e) => {
      const items = Array.isArray(e.detail?.items) ? e.detail.items : [];
      if (items.length === 0) return;
      const filesToAdd = items
        .map((item) => dataUrlToFile(item.dataUrl, item.name))
        .filter(Boolean);
      if (filesToAdd.length === 0) return;
      addFiles(filesToAdd);
      notify(`Loaded ${filesToAdd.length} image${filesToAdd.length === 1 ? '' : 's'} from Paste Inbox into Photo Match`, 'success');
    };
    window.addEventListener('kyros:use-as-photo-match-source', onInboxSource);
    return () => window.removeEventListener('kyros:use-as-photo-match-source', onInboxSource);
  }, [addFiles, notify]);

  const onDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = async (e) => {
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
  const handleFileInput = (e) => { addFiles(e.target.files || []); e.target.value = ''; };

  const activeQueueCount = queueItems.filter(j => j.status === 'running').length;
  const pendingQueueCount = queueItems.filter(j => j.status === 'pending').length;
  const failedQueueCount = queueItems.filter(j => j.status === 'error').length;
  const completedQueueCount = queueItems.filter(j => j.status === 'completed').length;
  const totalJobs = files.length * selectedCharIds.length;

  const toggleCharacter = (id) => setSelectedCharIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const runQueueJob = useCallback((job) => {
    if (!job?.id || runningJobsRef.current.has(job.id)) return;
    runningJobsRef.current.add(job.id);

    const fileSnap = filesRef.current.find(f => f.id === job.fileId)?.file;
    const charIdSnap = job.characterId;
    const activeReferenceIds = Array.isArray(job.activeReferenceIds) ? job.activeReferenceIds : [];
    const opts = job.opts || {};
    const { bgStr, poseStr, exact, varyBg, ar, resTier, imgModel, prov } = opts;

    if (!fileSnap) {
      runningJobsRef.current.delete(job.id);
      photoMatchStore.setValue('queueItems', prev => prev.map(j => j.id === job.id ? { ...j, status: 'error', errorMessage: 'Source image was removed. Add it again to retry.' } : j));
      return;
    }

    pushPending({ id: job.id, prompt: exact ? 'Exact Recreate' : 'Photo Match', imageModel: imgModel || '', aspectRatio: ar, resolutionTier: resTier });

    fileToBase64(fileSnap).then(dataUri => {
      const base64 = dataUri.split(',')[1];
      return photoMatchApi.recreate({
        image: base64, mimeType: fileSnap.type, characterId: charIdSnap,
        activeReferenceIds: activeReferenceIds.length > 0 ? activeReferenceIds : undefined,
        bgStrength: bgStr, poseStrength: poseStr,
        matchMode: exact ? 'exact' : 'match',
        varyBackground: varyBg,
        aspectRatio: ar, resolutionTier: resTier, imageModel: imgModel,
        provider: prov,
      });
    }).then(data => {
      photoMatchStore.setValue('result', data);
      photoMatchStore.setValue('history', prev => [data, ...prev].slice(0, 12));
      photoMatchStore.setValue('queueItems', prev => prev.filter(j => j.id !== job.id));
      resolvePending(job.id, {
        imageId: data.imageId, galleryId: data.galleryId || data.imageId,
        mimeType: data.image?.mimeType,
        prompt: exact ? 'Exact Recreate' : 'Photo Match',
        imageModel: imgModel || '', aspectRatio: ar, resolutionTier: resTier,
        generatedAt: Date.now(), characterId: charIdSnap || null,
      });
      notify(exact ? 'Exact recreate done!' : 'Photo matched!', 'success');
    }).catch(err => {
      rejectPending(job.id);
      photoMatchStore.setValue('queueItems', prev => prev.map(j => j.id === job.id ? { ...j, status: 'error', errorMessage: err?.message || 'Failed' } : j));
      notify(err?.message || 'Photo match failed', 'error');
    }).finally(() => {
      runningJobsRef.current.delete(job.id);
    });
  }, [notify]);

  useEffect(() => {
    if (queuePaused) return;
    const runningCount = queueItems.filter(j => j.status === 'running').length;
    const slots = MAX_RUNNING_PHOTO_MATCH_JOBS - runningCount;
    if (slots <= 0) return;

    const nextJobs = queueItems.filter(j => j.status === 'pending').slice(0, slots);
    if (nextJobs.length === 0) return;

    photoMatchStore.setValue('queueItems', prev => prev.map(j => (
      nextJobs.some(nextJob => nextJob.id === j.id) ? { ...j, status: 'running', errorMessage: '' } : j
    )));
    nextJobs.forEach(runQueueJob);
  }, [queueItems, queuePaused, runQueueJob]);

  const handleGenerate = () => {
    if (files.length === 0) { notify('Add at least one source image', 'error'); return; }
    if (selectedCharIds.length === 0) { notify('Select at least one character', 'error'); return; }
    const opts = { bgStr: bgStrength, poseStr: poseStrength, exact: exactRecreate, varyBg: varyBackground, ar: aspectRatio, resTier: resolutionTier, imgModel: imageModel, prov: provider };
    const jobs = [];
    for (const { file: f, id: fileId } of files) {
      for (const charIdSnap of selectedCharIds) {
        const charDetailSnap = charDetails[charIdSnap] || null;
        const activeReferenceIds = charDetailSnap?.references?.filter(r => r.isActive).map(r => r.id) || [];
        jobs.push({
          id: makePersistentJobId('photo-match'), kind: 'match', status: 'pending',
          fileId, characterId: charIdSnap, activeReferenceIds, opts,
          label: exactRecreate ? 'Exact Recreate' : 'Photo Match',
          summary: f.name || 'Reference photo match',
          meta: `${aspectRatio} · ${resolutionTier}`,
          badges: [
            charDetailSnap?.name ? { label: charDetailSnap.name, color: 'zinc' } : null,
            exactRecreate ? { label: 'Exact', color: 'blue' } : null,
            { label: `${bgStrength}/${poseStrength}`, color: 'zinc' },
          ].filter(Boolean),
        });
      }
    }
    photoMatchStore.setValue('queueItems', prev => [...prev, ...jobs]);
    notify(`${jobs.length} job${jobs.length === 1 ? '' : 's'} added to queue`, 'success');
  };

  const retryJob = (id) => {
    photoMatchStore.setValue('queueItems', prev => prev.map(j => j.id === id ? { ...j, status: 'pending', errorMessage: '' } : j));
  };

  const clearFailedJobs = () => {
    photoMatchStore.setValue('queueItems', prev => prev.filter(j => j.status !== 'error'));
  };

  const clearCompletedJobs = () => {
    photoMatchStore.setValue('queueItems', prev => prev.filter(j => j.status !== 'completed'));
  };

  const cancelPendingJobs = () => {
    photoMatchStore.setValue('queueItems', prev => prev.filter(j => j.status !== 'pending'));
  };

  return (
    <div className="space-y-6 animate-in">
      <div className="max-w-md">
        <div className="space-y-4">

          {/* Source Images — multi-drop zone */}
          <Card className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-medium text-zinc-200">Source Images</h3>
              <div className="flex items-center gap-2">
                {files.length > 0 && <Badge color="blue">{files.length} photo{files.length > 1 ? 's' : ''}</Badge>}
                <Badge color="zinc">Ctrl+V to paste</Badge>
              </div>
            </div>

            {/* Drop zone */}
            <div
              ref={dropRef}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`flex items-center justify-center border-2 border-dashed rounded-xl cursor-pointer transition-all min-h-[80px] px-4 py-4 ${
                isDragging ? 'border-blue-500/80 bg-blue-500/10' : 'border-zinc-700/80 hover:border-zinc-500'
              }`}
            >
              <div className="text-center flex flex-col items-center gap-1.5 [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor]">
                <IconImage uniqueId="pm-upload" size={24} className="text-zinc-600" aria-hidden />
                <p className="text-sm text-zinc-400 font-medium">Drop photos here or click to browse</p>
                <p className="text-xs text-zinc-600">PNG, JPEG, WebP · no image limit</p>
              </div>
              <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={handleFileInput} />
            </div>

            {/* Thumbnail grid */}
            {files.length > 0 && (
              <div>
                <div className="grid grid-cols-4 gap-2">
                  {files.map(({ id, previewUrl, file: f }) => (
                    <div key={id} className="relative group aspect-square rounded-lg overflow-hidden border border-zinc-700/60 bg-zinc-900">
                      <img src={previewUrl} alt={f.name} className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeFile(id); }}
                        className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/70 text-zinc-300 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-xs font-bold hover:bg-red-500/80 hover:text-white"
                      >×</button>
                    </div>
                  ))}
                  {/* Add more tile */}
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="aspect-square rounded-lg border-2 border-dashed border-zinc-700/60 hover:border-zinc-500 bg-zinc-900/40 flex items-center justify-center cursor-pointer transition"
                  >
                    <span className="text-zinc-600 text-xl font-light">+</span>
                  </div>
                </div>
                <button type="button" onClick={clearAll} className="mt-2 text-xs text-zinc-600 hover:text-red-400 transition">Clear all</button>
              </div>
            )}

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

          {/* Match Mode sliders */}
          <Card className="space-y-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-medium text-zinc-200">Match Mode</h3>
                {exactRecreate ? <Badge color="blue">Same Outfit • Same Pose • Same Background</Badge> : null}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setExactRecreate(false)}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition cursor-pointer ${!exactRecreate ? 'border-blue-500/60 bg-blue-500/15 text-blue-100' : 'border-zinc-700/70 bg-zinc-900/50 text-zinc-400 hover:border-zinc-600'}`}>
                  Flexible Match
                </button>
                <button type="button" onClick={() => { setExactRecreate(true); setBgStrength(100); setPoseStrength(100); }}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition cursor-pointer ${exactRecreate ? 'border-blue-500/60 bg-blue-500/15 text-blue-100' : 'border-zinc-700/70 bg-zinc-900/50 text-zinc-400 hover:border-zinc-600'}`}>
                  Exact Recreate
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-zinc-500">
                {exactRecreate ? 'Locks the source image much harder: same outfit, same framing, same expression, same pose, same background.' : 'Use sliders to decide how closely the new image follows the source image.'}
              </p>
            </div>
            <StrengthSlider label="Background Match" sublabel="environment & lighting" value={bgStrength} onChange={setBgStrength} color="#3b82f6" disabled={exactRecreate} />
            <StrengthSlider label="Pose Match" sublabel="body position & stance" value={poseStrength} onChange={setPoseStrength} color="#8b5cf6" disabled={exactRecreate} />

            {/* Vary Background toggle */}
            <button
              type="button"
              disabled={exactRecreate}
              onClick={() => !exactRecreate && setVaryBackground(v => !v)}
              className={`w-full flex items-center justify-between rounded-lg border px-3 py-2.5 transition ${
                exactRecreate ? 'opacity-40 cursor-not-allowed border-zinc-800 bg-zinc-900/30' :
                varyBackground ? 'border-emerald-500/60 bg-emerald-500/10 cursor-pointer' : 'border-zinc-700/60 bg-zinc-900/40 hover:border-zinc-600 cursor-pointer'
              }`}
            >
              <div className="text-left">
                <span className={`text-sm font-medium ${varyBackground ? 'text-emerald-300' : 'text-zinc-300'}`}>Vary Background</span>
                <p className="text-[11px] text-zinc-500 mt-0.5">Same environment, changed lighting & extra background details</p>
              </div>
              <div className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${ varyBackground ? 'bg-emerald-500' : 'bg-zinc-700'}`}>
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${ varyBackground ? 'left-[18px]' : 'left-0.5'}`} />
              </div>
            </button>
          </Card>

          {/* Character multi-select */}
          <Card className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-medium text-zinc-200">Character</h3>
              {selectedCharIds.length > 0 && (
                <Badge color="blue">{selectedCharIds.length} selected</Badge>
              )}
            </div>

            {chars.length === 0 ? (
              <p className="text-xs text-zinc-500">No characters yet — create one in the Characters section.</p>
            ) : (
              <div className="space-y-1 max-h-52 overflow-y-auto pr-1">
                {chars.map((c) => {
                  const isChecked = selectedCharIds.includes(c.id);
                  const detail = charDetails[c.id];
                  const activeRefCount = detail?.references?.filter(r => r.isActive).length ?? 0;
                  return (
                    <button key={c.id} type="button" onClick={() => toggleCharacter(c.id)}
                      className={`w-full flex items-center gap-3 rounded-lg border px-3 py-2 text-sm transition cursor-pointer text-left ${isChecked ? 'border-blue-500/60 bg-blue-500/15 text-blue-100' : 'border-zinc-700/60 bg-zinc-900/40 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800/60'}`}>
                      <span className={`flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center transition ${isChecked ? 'border-blue-400 bg-blue-500' : 'border-zinc-600'}`}>
                        {isChecked && <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                      </span>
                      <span className="flex-1 font-medium truncate">{c.name}</span>
                      {activeRefCount > 0 && <Badge color="zinc">{activeRefCount} refs</Badge>}
                    </button>
                  );
                })}
              </div>
            )}

            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Image Model</span>
              <select value={imageModel} onChange={e => setImageModel(e.target.value)}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 cursor-pointer">
                {IMAGE_MODEL_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
            </div>

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

            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-2">Aspect Ratio</span>
              <div className="flex flex-wrap gap-1.5">
                {ASPECT_RATIOS.map(ar => (
                  <button key={ar} onClick={() => setAspectRatio(ar)}
                    className={`rounded-md px-2 py-1 text-xs font-medium transition cursor-pointer ${aspectRatio === ar ? 'bg-blue-600 text-white' : 'bg-zinc-700/60 text-zinc-400 hover:bg-zinc-600'}`}>
                    {ar}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-2">Resolution</span>
              <div className="flex gap-2">
                {RESOLUTION_TIERS.map(tier => (
                  <button key={tier} onClick={() => setResolutionTier(tier)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${resolutionTier === tier ? 'bg-blue-500 text-white' : 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600'}`}>
                    {tier}
                  </button>
                ))}
              </div>
            </div>

            {/* Job count summary */}
            {totalJobs > 1 && files.length > 0 && selectedCharIds.length > 0 && (
              <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 px-3 py-2 text-xs text-blue-300">
                {files.length} photo{files.length > 1 ? 's' : ''} × {selectedCharIds.length} character{selectedCharIds.length > 1 ? 's' : ''} = <span className="font-bold">{totalJobs} jobs</span>
              </div>
            )}

            <Btn onClick={handleGenerate} disabled={files.length === 0 || selectedCharIds.length === 0} className="w-full">
              {activeQueueCount > 0
                ? <>Queue More · {activeQueueCount}/2 running</>
                : totalJobs > 1
                  ? <>Photo Match ×{totalJobs}</>
                  : <>Photo Match</>
              }
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
                  <button type="button" onClick={cancelPendingJobs} disabled={pendingQueueCount === 0} className="rounded-md border border-red-800/60 bg-red-950/40 px-2.5 py-1 text-xs font-medium text-red-400 transition hover:border-red-600 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer">
                    Cancel pending ({pendingQueueCount})
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
                              <Badge key={`${job.id}-${badge?.label || badge}-${index}`} color={badge?.color || 'zinc'}>
                                {badge?.label || badge}
                              </Badge>
                            ))}
                          </div>
                          <div className="truncate text-sm text-zinc-200">{job.summary || 'Reference photo match'}</div>
                          {job.meta && <div className="text-[10px] font-mono text-zinc-600">{job.meta}</div>}
                          {job.status === 'error' && <div className="text-xs text-red-300 line-clamp-3">{job.errorMessage || 'Failed'}</div>}
                        </div>
                        {job.status === 'running' ? (
                          <Spinner size={16} />
                        ) : job.status === 'error' ? (
                          <button type="button" onClick={() => retryJob(job.id)} className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-200 transition hover:bg-red-500/20 cursor-pointer">
                            Retry
                          </button>
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
