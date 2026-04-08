import { useState, useEffect, useCallback, useRef } from 'react';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { photoMatch as photoMatchApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Badge, ImageCard, Empty } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { ASPECT_RATIOS, RESOLUTION_TIERS, IMAGE_MODEL_OPTIONS } from '../config/photoModes';
import { createPersistentPageState, makePersistentJobId, PersistentJobCard } from '../lib/persistentPageState';
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
  const extension = mimeType.split('/')[1] || 'png';
  return new File([bytes], filename.includes('.') ? filename : `${filename}.${extension}`, { type: mimeType });
}

function readPhotoMatchHandoff() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(PHOTO_MATCH_HANDOFF_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(PHOTO_MATCH_HANDOFF_KEY);
    return JSON.parse(raw);
  } catch {
    return null;
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
        <input
          type="range" min="0" max="100" step="5" value={value}
          onChange={e => onChange(Number(e.target.value))}
          disabled={disabled}
          className={`absolute inset-x-0 w-full opacity-0 h-7 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
          style={{ zIndex: 2 }}
        />
        <div className="absolute h-4 w-4 rounded-full shadow-lg border-2 border-white/20 pointer-events-none transition-all"
          style={{ left: `calc(${value}% - 8px)`, background: color, boxShadow: `0 0 8px ${color}66` }} />
      </div>
      <div className="flex justify-between text-[10px] text-zinc-600 mt-1 px-0.5">
        <span>Loose</span><span>Close</span><span>Exact</span>
      </div>
    </div>
  );
}

const RECREATE_STEPS = [
  'Analyzing scene with Gemini',
  'Building strength-weighted prompt',
  'Generating matched image',
];
const RECREATE_THRESHOLDS = [4, 9];

const _cache = {
  charId: '',
  bgStrength: 80,
  poseStrength: 80,
  exactRecreate: false,
  aspectRatio: '4:5',
  resolutionTier: '1K',
  imageModel: 'gemini-3.1-flash-image-preview',
  result: null,
  history: [],
};

const photoMatchStore = createPersistentPageState('photo-match', {
  result: _cache.result,
  history: _cache.history,
  queueItems: [],
});

export default function PhotoMatchPage() {
  const { notify, characters: chars, consumePageParams } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const dropRef = useRef(null);
  const initialStoreState = photoMatchStore.getSnapshot();

  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [charId, setCharId] = useState(_cache.charId);
  const [charDetail, setCharDetail] = useState(null);
  const [bgStrength, setBgStrength] = useState(_cache.bgStrength);
  const [poseStrength, setPoseStrength] = useState(_cache.poseStrength);
  const [exactRecreate, setExactRecreate] = useState(_cache.exactRecreate);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolutionTier, setResolutionTier] = useState(_cache.resolutionTier);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [result, setResult] = useState(initialStoreState.result);
  const [history, setHistory] = useState(initialStoreState.history);
  const [queueItems, setQueueItems] = useState(initialStoreState.queueItems);

  useEffect(() => { _cache.charId = charId; }, [charId]);
  useEffect(() => { _cache.bgStrength = bgStrength; }, [bgStrength]);
  useEffect(() => { _cache.poseStrength = poseStrength; }, [poseStrength]);
  useEffect(() => { _cache.exactRecreate = exactRecreate; }, [exactRecreate]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolutionTier = resolutionTier; }, [resolutionTier]);
  useEffect(() => { _cache.imageModel = imageModel; }, [imageModel]);
  useEffect(() => photoMatchStore.subscribe((snapshot) => {
    setResult(snapshot.result);
    setHistory(snapshot.history);
    setQueueItems(snapshot.queueItems);
  }), []);

  useEffect(() => {
    if (charId) charApi.get(charId).then(setCharDetail).catch(() => setCharDetail(null));
    else setCharDetail(null);
  }, [charId]);

  useEffect(() => {
    return () => { if (preview && preview.startsWith('blob:')) URL.revokeObjectURL(preview); };
  }, [preview]);

  const applyFile = useCallback((f) => {
    if (!f || !f.type.startsWith('image/')) {
      notify('Please use an image file (PNG, JPEG, WebP)', 'error');
      return;
    }
    setFile(f);
    const url = URL.createObjectURL(f);
    setPreview(prev => { if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev); return url; });
    photoMatchStore.setValue('result', null);
  }, [notify]);

  useEffect(() => {
    const params = consumePageParams();
    const handoff = params?.sourceImageBase64 ? params : readPhotoMatchHandoff();
    if (!handoff?.sourceImageBase64) return;
    const mimeType = handoff.sourceImageMimeType || 'image/png';
    const filename = handoff.sourceImageName || 'nsfw-generate';
    const sourceFile = dataUrlToFile(`data:${mimeType};base64,${handoff.sourceImageBase64}`, filename);
    if (!sourceFile) {
      notify('Could not load source image into Photo Match', 'error');
      return;
    }
    applyFile(sourceFile);
    if (handoff.characterId) setCharId(handoff.characterId);
    if (handoff.exactRecreate === true) {
      setExactRecreate(true);
      setBgStrength(100);
      setPoseStrength(100);
    }
    if (typeof handoff.aspectRatio === 'string' && ASPECT_RATIOS.includes(handoff.aspectRatio)) {
      setAspectRatio(handoff.aspectRatio);
    }
    if (typeof handoff.resolutionTier === 'string' && RESOLUTION_TIERS.includes(handoff.resolutionTier)) {
      setResolutionTier(handoff.resolutionTier);
    }
    notify('Loaded image from NSFW Generate', 'success');
  }, [applyFile, consumePageParams, notify]);

  // Paste from clipboard (Ctrl+V)
  useEffect(() => {
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
      if (item) {
        e.preventDefault();
        const f = item.getAsFile();
        if (f) applyFile(f);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [applyFile]);

  // Drag & drop
  const onDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e) => {
    e.preventDefault(); setIsDragging(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) applyFile(f);
  };

  const handleFileInput = (e) => {
    const f = e.target.files?.[0];
    if (f) applyFile(f);
  };

  const dismissQueueItem = (queueId) => {
    photoMatchStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
  };

  const activeQueueCount = queueItems.filter((job) => job.status === 'running').length;

  const handleGenerate = async () => {
    if (!file) { notify('Upload or paste an image first', 'error'); return; }
    if (!charId) { notify('Select a character', 'error'); return; }

    const queueId = makePersistentJobId('photo-match');
    pushPending({ id: queueId, prompt: exactRecreate ? 'Exact Recreate' : 'Photo Match', imageModel: imageModel || '', aspectRatio, resolutionTier });
    photoMatchStore.setValue('queueItems', (prev) => [
      {
        id: queueId,
        kind: 'match',
        status: 'running',
        label: exactRecreate ? 'Exact Recreate' : 'Photo Match',
        summary: file.name || 'Reference photo match',
        meta: `${aspectRatio} · ${resolutionTier}`,
        badges: [
          charDetail?.name ? { label: charDetail.name, color: 'zinc' } : null,
          exactRecreate ? { label: 'Exact', color: 'blue' } : null,
          { label: `${bgStrength}/${poseStrength}`, color: 'zinc' },
        ].filter(Boolean),
      },
      ...prev.slice(0, 5),
    ]);

    try {
      const dataUri = await fileToBase64(file);
      const base64 = dataUri.split(',')[1];
      const activeRefIds = charDetail?.references?.filter(r => r.isActive).map(r => r.id) || [];

      const data = await photoMatchApi.recreate({
        image: base64,
        mimeType: file.type,
        characterId: charId,
        activeReferenceIds: activeRefIds.length > 0 ? activeRefIds : undefined,
        bgStrength,
        poseStrength,
        matchMode: exactRecreate ? 'exact' : 'match',
        aspectRatio,
        resolutionTier,
        imageModel,
      });

      photoMatchStore.setValue('result', data);
      photoMatchStore.setValue('history', (prev) => [data, ...prev].slice(0, 12));
      photoMatchStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
      resolvePending(queueId, {
        imageId: data.imageId,
        galleryId: data.galleryId || data.imageId,
        mimeType: data.image?.mimeType,
        prompt: exactRecreate ? 'Exact Recreate' : 'Photo Match',
        imageModel: imageModel || '',
        aspectRatio,
        resolutionTier,
        generatedAt: Date.now(),
        characterId: charId || null,
      });
      notify(exactRecreate ? 'Exact recreate finished!' : 'Photo matched!', 'success');
    } catch (err) {
      rejectPending(queueId);
      photoMatchStore.setValue('queueItems', (prev) => prev.map((job) => (
        job.id === queueId ? { ...job, status: 'error', errorMessage: err?.message || 'Photo match failed' } : job
      )));
      notify(err?.message || 'Photo match failed', 'error');
    }
  };

  return (
    <div className="space-y-6 animate-in">
      <div className="max-w-md">

        {/* CONTROLS */}
        <div className="space-y-4">

          {/* Upload / Paste */}
          <Card className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-medium text-zinc-200">Source Image</h3>
              <Badge color="zinc">Ctrl+V to paste</Badge>
            </div>
            <label
              ref={dropRef}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              className={`flex items-center justify-center border-2 border-dashed rounded-xl cursor-pointer transition-all h-48 overflow-hidden relative ${
                isDragging ? 'border-blue-500/80 bg-blue-500/10' : 'border-zinc-700/80 hover:border-zinc-500'
              }`}
            >
              {preview ? (
                <>
                  <img src={preview} alt="Source" className="max-h-full max-w-full object-contain" />
                  <div className="absolute inset-0 bg-black/0 hover:bg-black/30 transition-all flex items-center justify-center opacity-0 hover:opacity-100">
                    <span className="text-white text-xs font-medium bg-black/60 rounded-lg px-3 py-1.5">Click to change</span>
                  </div>
                </>
              ) : (
                <div className="text-center flex flex-col items-center gap-2 px-4 [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor]">
                  <IconImage uniqueId="pm-upload" size={32} className="text-zinc-600" aria-hidden />
                  <div>
                    <p className="text-sm text-zinc-400 font-medium">Drop, click or paste</p>
                    <p className="text-xs text-zinc-600 mt-0.5">PNG, JPEG, WebP</p>
                  </div>
                </div>
              )}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleFileInput} />
            </label>
          </Card>

          {/* Strength sliders */}
          <Card className="space-y-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-medium text-zinc-200">Match Mode</h3>
                {exactRecreate ? <Badge color="blue">Same Outfit • Same Pose • Same Background</Badge> : null}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setExactRecreate(false)}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition cursor-pointer ${
                    !exactRecreate
                      ? 'border-blue-500/60 bg-blue-500/15 text-blue-100'
                      : 'border-zinc-700/70 bg-zinc-900/50 text-zinc-400 hover:border-zinc-600'
                  }`}
                >
                  Flexible Match
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExactRecreate(true);
                    setBgStrength(100);
                    setPoseStrength(100);
                  }}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition cursor-pointer ${
                    exactRecreate
                      ? 'border-blue-500/60 bg-blue-500/15 text-blue-100'
                      : 'border-zinc-700/70 bg-zinc-900/50 text-zinc-400 hover:border-zinc-600'
                  }`}
                >
                  Exact Recreate
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-zinc-500">
                {exactRecreate
                  ? 'Locks the source image much harder: same outfit, same framing, same expression, same pose, same background.'
                  : 'Use sliders to decide how closely the new image follows the source image.'}
              </p>
            </div>
            <StrengthSlider
              label="Background Match"
              sublabel="environment & lighting"
              value={bgStrength}
              onChange={setBgStrength}
              color="#3b82f6"
              disabled={exactRecreate}
            />
            <StrengthSlider
              label="Pose Match"
              sublabel="body position & stance"
              value={poseStrength}
              onChange={setPoseStrength}
              color="#8b5cf6"
              disabled={exactRecreate}
            />
          </Card>

          {/* Character */}
          <Card className="space-y-4">
            <h3 className="text-base font-medium text-zinc-200">Character</h3>
            <select value={charId} onChange={e => setCharId(e.target.value)}
              className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
              <option value="">Select character...</option>
              {chars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>

            {charDetail?.references?.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {charDetail.references.map(r => (
                  <Badge key={r.id} color={r.isActive ? 'blue' : 'zinc'}>{r.category}</Badge>
                ))}
              </div>
            )}

            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Image Model</span>
              <select value={imageModel} onChange={e => setImageModel(e.target.value)}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
                {IMAGE_MODEL_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
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

            <Btn onClick={handleGenerate} disabled={!file || !charId} className="w-full">
              {activeQueueCount > 0
                ? <>Queue Another · {activeQueueCount} running</>
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
