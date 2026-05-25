import { useState, useEffect, useCallback, useRef } from 'react';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { photoMatch as photoMatchApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Badge } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { ASPECT_RATIOS, RESOLUTION_TIERS, IMAGE_MODEL_OPTIONS } from '../config/photoModes';
import { createPersistentPageState, makePersistentJobId } from '../lib/persistentPageState';
import { IconImage } from 'nucleo-glass';

const PHOTO_MATCH_HANDOFF_KEY = 'kyros.photoMatch.handoff';

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

function readPhotoMatchHandoff() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(PHOTO_MATCH_HANDOFF_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(PHOTO_MATCH_HANDOFF_KEY);
    return JSON.parse(raw);
  } catch { return null; }
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
  selectedCharIds: [], bgStrength: 80, poseStrength: 80,
  exactRecreate: false, varyBackground: false, aspectRatio: '4:5', resolutionTier: '1K',
  imageModel: 'gemini-3.1-flash-image-preview',
};

const photoMatchStore = createPersistentPageState('photo-match', { result: null, history: [], queueItems: [] });

export default function PhotoMatchPage() {
  const { notify, characters: chars, consumePageParams } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const dropRef = useRef(null);
  const fileInputRef = useRef(null);
  const initialStoreState = photoMatchStore.getSnapshot();

  // Multiple source files
  const [files, setFiles] = useState([]); // [{ file, previewUrl, id }]
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
  const [queueItems, setQueueItems] = useState(initialStoreState.queueItems);

  useEffect(() => { _cache.selectedCharIds = selectedCharIds; }, [selectedCharIds]);
  useEffect(() => { _cache.bgStrength = bgStrength; }, [bgStrength]);
  useEffect(() => { _cache.poseStrength = poseStrength; }, [poseStrength]);
  useEffect(() => { _cache.exactRecreate = exactRecreate; }, [exactRecreate]);
  useEffect(() => { _cache.varyBackground = varyBackground; }, [varyBackground]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolutionTier = resolutionTier; }, [resolutionTier]);
  useEffect(() => { _cache.imageModel = imageModel; }, [imageModel]);
  useEffect(() => photoMatchStore.subscribe((s) => setQueueItems(s.queueItems)), []);

  // Fetch details for selected characters
  useEffect(() => {
    const nd = {};
    Promise.all(selectedCharIds.map(id => charApi.get(id).then(d => { nd[id] = d; }).catch(() => {}))).then(() => setCharDetails(nd));
  }, [selectedCharIds]);

  // Revoke blob URLs on unmount / change
  useEffect(() => () => files.forEach(f => f.previewUrl && URL.revokeObjectURL(f.previewUrl)), [files]);

  const addFiles = useCallback((incoming) => {
    const valid = [...incoming].filter(f => f.type.startsWith('image/'));
    if (valid.length === 0) { notify('Only PNG, JPEG, WebP allowed', 'error'); return; }
    setFiles(prev => {
      const next = [...prev];
      for (const f of valid) {
        if (next.length >= 20) break; // cap at 20
        const previewUrl = URL.createObjectURL(f);
        next.push({ file: f, previewUrl, id: `${f.name}-${f.size}-${Date.now()}-${Math.random()}` });
      }
      return next;
    });
    photoMatchStore.setValue('result', null);
  }, [notify]);

  const removeFile = (id) => {
    setFiles(prev => {
      const entry = prev.find(f => f.id === id);
      if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      return prev.filter(f => f.id !== id);
    });
  };

  const clearAll = () => {
    setFiles(prev => { prev.forEach(f => f.previewUrl && URL.revokeObjectURL(f.previewUrl)); return []; });
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
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
      if (item) { e.preventDefault(); const f = item.getAsFile(); if (f) applyFile(f); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [applyFile]);

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

  const onDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e) => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer?.files || []); };
  const handleFileInput = (e) => { addFiles(e.target.files || []); e.target.value = ''; };

  const activeQueueCount = queueItems.filter(j => j.status === 'running').length;
  const totalJobs = files.length * selectedCharIds.length;

  const toggleCharacter = (id) => setSelectedCharIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const dispatchOneJob = useCallback((charIdSnap, charDetailSnap, fileSnap, opts) => {
    const { bgStr, poseStr, exact, varyBg, ar, resTier, imgModel } = opts;
    const queueId = makePersistentJobId('photo-match');
    pushPending({ id: queueId, prompt: exact ? 'Exact Recreate' : 'Photo Match', imageModel: imgModel || '', aspectRatio: ar, resolutionTier: resTier });
    photoMatchStore.setValue('queueItems', prev => [{
      id: queueId, kind: 'match', status: 'running',
      label: exact ? 'Exact Recreate' : 'Photo Match',
      summary: fileSnap.name || 'Reference photo match',
      meta: `${ar} · ${resTier}`,
      badges: [
        charDetailSnap?.name ? { label: charDetailSnap.name, color: 'zinc' } : null,
        exact ? { label: 'Exact', color: 'blue' } : null,
        { label: `${bgStr}/${poseStr}`, color: 'zinc' },
      ].filter(Boolean),
    }, ...prev.slice(0, 5)]);

    fileToBase64(fileSnap).then(dataUri => {
      const base64 = dataUri.split(',')[1];
      const activeRefIds = charDetailSnap?.references?.filter(r => r.isActive).map(r => r.id) || [];
      return photoMatchApi.recreate({
        image: base64, mimeType: fileSnap.type, characterId: charIdSnap,
        activeReferenceIds: activeRefIds.length > 0 ? activeRefIds : undefined,
        bgStrength: bgStr, poseStrength: poseStr,
        matchMode: exact ? 'exact' : 'match',
        varyBackground: varyBg,
        aspectRatio: ar, resolutionTier: resTier, imageModel: imgModel,
      });
    }).then(data => {
      photoMatchStore.setValue('result', data);
      photoMatchStore.setValue('history', prev => [data, ...prev].slice(0, 12));
      photoMatchStore.setValue('queueItems', prev => prev.filter(j => j.id !== queueId));
      resolvePending(queueId, {
        imageId: data.imageId, galleryId: data.galleryId || data.imageId,
        mimeType: data.image?.mimeType,
        prompt: exact ? 'Exact Recreate' : 'Photo Match',
        imageModel: imgModel || '', aspectRatio: ar, resolutionTier: resTier,
        generatedAt: Date.now(), characterId: charIdSnap || null,
      });
      notify(exact ? 'Exact recreate done!' : 'Photo matched!', 'success');
    }).catch(err => {
      rejectPending(queueId);
      photoMatchStore.setValue('queueItems', prev => prev.map(j => j.id === queueId ? { ...j, status: 'error', errorMessage: err?.message || 'Failed' } : j));
      notify(err?.message || 'Photo match failed', 'error');
    });
  }, [notify]);

  const handleGenerate = () => {
    if (files.length === 0) { notify('Add at least one source image', 'error'); return; }
    if (selectedCharIds.length === 0) { notify('Select at least one character', 'error'); return; }
    const opts = { bgStr: bgStrength, poseStr: poseStrength, exact: exactRecreate, varyBg: varyBackground, ar: aspectRatio, resTier: resolutionTier, imgModel: imageModel };
    for (const { file: f } of files) {
      for (const charIdSnap of selectedCharIds) {
        dispatchOneJob(charIdSnap, charDetails[charIdSnap] || null, f, opts);
      }
    }
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
                <p className="text-xs text-zinc-600">PNG, JPEG, WebP · up to 20 images</p>
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
                ? <>Queue More · {activeQueueCount} running</>
                : totalJobs > 1
                  ? <>Photo Match ×{totalJobs}</>
                  : <>Photo Match</>
              }
            </Btn>
          </Card>
        </div>
      </div>
      <LightboxComponent />
    </div>
  );
}
