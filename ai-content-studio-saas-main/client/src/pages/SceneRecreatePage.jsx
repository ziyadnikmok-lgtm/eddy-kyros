import { useState, useEffect, useCallback } from 'react';
import { scene as sceneApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Textarea, Badge, ImageCard, Empty } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { ASPECT_RATIOS, RESOLUTION_TIERS, IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL } from '../config/photoModes';
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
  charId: '',
  aspectRatio: '4:5',
  resolutionTier: '2K',
  imageModel: DEFAULT_IMAGE_MODEL,
  sameBackground: false,
  samePose: false,
  result: null,
  history: [],
};

const scenePageStore = createPersistentPageState('scene-recreate', {
  sceneData: _cache.sceneData,
  editableScene: _cache.editableScene,
  result: _cache.result,
  history: _cache.history,
  queueItems: [],
});

function StepIndicator({ number, title, active, done }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-all ${
        done
          ? 'bg-green-500/20 text-green-400 border border-green-500/40'
          : active
          ? 'bg-blue-600 text-white shadow-[0_0_12px_rgba(59,130,246,0.4)]'
          : 'bg-zinc-800 text-zinc-500 border border-zinc-700/60'
      }`}>
        {done ? '✓' : number}
      </div>
      <span className={`text-sm font-medium ${active ? 'text-zinc-100' : done ? 'text-zinc-300' : 'text-zinc-500'}`}>
        {title}
      </span>
    </div>
  );
}

function GeneratingOverlay({ label = 'Generating…' }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-zinc-950/80 backdrop-blur-sm rounded-xl z-10">
      <div className="relative">
        <div className="w-14 h-14 rounded-full border-2 border-blue-500/20 border-t-blue-500 animate-spin" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-6 h-6 rounded-full bg-blue-500/20 animate-pulse" />
        </div>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-zinc-200">{label}</p>
        <p className="text-xs text-zinc-500 mt-1">Building identity-locked prompt…</p>
      </div>
      <div className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
    </div>
  );
}

function SkeletonImage() {
  return (
    <div className="w-full aspect-[4/5] rounded-xl bg-zinc-800/60 overflow-hidden relative">
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-zinc-700/20 to-transparent animate-shimmer" />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-zinc-700/60 animate-pulse" />
        <div className="w-32 h-2 rounded-full bg-zinc-700/60 animate-pulse" />
        <div className="w-24 h-2 rounded-full bg-zinc-700/40 animate-pulse" style={{ animationDelay: '0.2s' }} />
      </div>
    </div>
  );
}

export default function SceneRecreatePage() {
  const { notify, characters: chars } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const initialStoreState = scenePageStore.getSnapshot();
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [sceneData, setSceneData] = useState(initialStoreState.sceneData);
  const [editableScene, setEditableScene] = useState(initialStoreState.editableScene);
  const [charId, setCharId] = useState(_cache.charId);
  const [charDetail, setCharDetail] = useState(null);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolutionTier, setResolutionTier] = useState(_cache.resolutionTier);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [sameBackground, setSameBackground] = useState(_cache.sameBackground);
  const [samePose, setSamePose] = useState(_cache.samePose);
  const [result, setResult] = useState(initialStoreState.result);
  const [history, setHistory] = useState(initialStoreState.history);
  const [queueItems, setQueueItems] = useState(initialStoreState.queueItems);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => { _cache.sceneData = sceneData; }, [sceneData]);
  useEffect(() => { _cache.editableScene = editableScene; }, [editableScene]);
  useEffect(() => { _cache.charId = charId; }, [charId]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolutionTier = resolutionTier; }, [resolutionTier]);
  useEffect(() => { _cache.imageModel = imageModel; }, [imageModel]);
  useEffect(() => { _cache.sameBackground = sameBackground; }, [sameBackground]);
  useEffect(() => { _cache.samePose = samePose; }, [samePose]);
  useEffect(() => scenePageStore.subscribe((snapshot) => {
    setSceneData(snapshot.sceneData);
    setEditableScene(snapshot.editableScene);
    setResult(snapshot.result);
    setHistory(snapshot.history);
    setQueueItems(snapshot.queueItems);
  }), []);

  useEffect(() => {
    if (charId) charApi.get(charId).then(setCharDetail).catch(() => setCharDetail(null));
    else setCharDetail(null);
  }, [charId]);

  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);

  const applyFile = useCallback((f) => {
    if (f) {
      if (!f.type.startsWith('image/')) {
        notify('Please use an image file (PNG, JPEG, WebP)', 'error');
        return;
      }
      setFile(f);
      setPreview((prev) => {
        if (prev?.startsWith?.('blob:')) URL.revokeObjectURL(prev);
        return URL.createObjectURL(f);
      });
      scenePageStore.patch({ sceneData: null, editableScene: '', result: null });
    }
  }, [notify]);

  useEffect(() => {
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'));
      if (!item) return;
      e.preventDefault();
      const pastedFile = item.getAsFile();
      if (pastedFile) {
        applyFile(pastedFile);
        notify('Pasted scene image from clipboard', 'success');
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [applyFile, notify]);

  const handleFile = (e) => {
    const f = e.target.files?.[0];
    if (f) applyFile(f);
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
    applyFile(pastedFile);
    notify('Pasted scene image from clipboard', 'success');
  };

  const dismissQueueItem = (queueId) => {
    scenePageStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
  };

  const activeQueueCount = queueItems.filter((job) => job.status === 'running').length;
  const isRecreating = queueItems.some((job) => job.status === 'running' && job.kind === 'recreate');
  const isAnalyzing = analyzing || queueItems.some((job) => job.status === 'running' && job.kind === 'analyze');

  const handleAnalyze = async () => {
    if (!file) { notify('Upload an image first', 'error'); return; }
    setAnalyzing(true);
    const queueId = makePersistentJobId('scene-analyze');
    scenePageStore.setValue('queueItems', (prev) => [
      { id: queueId, kind: 'analyze', status: 'running', label: 'Analyzing Scene', summary: file.name || 'Scene image', badges: [{ label: file.type || 'image', color: 'zinc' }] },
      ...prev.slice(0, 5),
    ]);
    try {
      const dataUri = await fileToBase64(file);
      const base64 = dataUri.split(',')[1];
      const data = await sceneApi.analyze(base64, file.type);
      const text = Object.entries(data).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
      scenePageStore.patch({ sceneData: data, editableScene: text });
      scenePageStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
      notify('Scene analyzed!', 'success');
    } catch (err) {
      scenePageStore.setValue('queueItems', (prev) => prev.map((job) => (
        job.id === queueId ? { ...job, status: 'error', errorMessage: err?.message || 'Failed to analyze scene' } : job
      )));
      notify(err?.message || 'Failed to analyze scene', 'error');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleRecreate = async () => {
    if (!sceneData) { notify('Analyze a scene first', 'error'); return; }
    if (!charId) { notify('Select a character', 'error'); return; }
    const parsed = {};
    editableScene.split('\n').forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > 0) parsed[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    const activeRefIds = charDetail?.references?.filter((r) => r.isActive).map((r) => r.id) || [];
    const queueId = makePersistentJobId('scene-recreate');
    scenePageStore.setValue('queueItems', (prev) => [
      {
        id: queueId, kind: 'recreate', status: 'running', label: 'Recreating Scene',
        summary: editableScene || 'Recreate scene with selected character',
        meta: `${aspectRatio} · ${resolutionTier}`,
        badges: [charDetail?.name ? { label: charDetail.name, color: 'zinc' } : null, { label: imageModel, color: 'zinc' }].filter(Boolean),
      },
      ...prev.slice(0, 5),
    ]);
    try {
      const data = await sceneApi.recreate({
        sceneData: { ...sceneData, ...parsed },
        characterId: charId,
        activeReferenceIds: activeRefIds.length > 0 ? activeRefIds : undefined,
        aspectRatio, resolutionTier, imageModel, sameBackground, samePose,
      });
      scenePageStore.setValue('result', data);
      scenePageStore.setValue('history', (prev) => [data, ...prev].slice(0, 10));
      scenePageStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
      notify('Scene recreated!', 'success');
    } catch (err) {
      scenePageStore.setValue('queueItems', (prev) => prev.map((job) => (
        job.id === queueId ? { ...job, status: 'error', errorMessage: err?.message || 'Failed to recreate scene' } : job
      )));
      notify(err?.message || 'Failed to recreate scene', 'error');
    }
  };

  const sceneFields = sceneData ? Object.entries(sceneData).filter(([, v]) => v) : [];
  const step = !file ? 1 : !sceneData ? 2 : 3;
  const failedJobs = queueItems.filter((job) => job.status === 'error');

  return (
    <div className="space-y-6 animate-in">
      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6">

        {/* ── LEFT PANEL ── */}
        <div className="space-y-3">

          {/* Step progress */}
          <div className="flex items-center gap-2 px-1 py-2">
            <StepIndicator number={1} title="Upload" active={step === 1} done={step > 1} />
            <div className={`flex-1 h-px ${step > 1 ? 'bg-green-500/30' : 'bg-zinc-700/60'}`} />
            <StepIndicator number={2} title="Analyze" active={step === 2} done={step > 2} />
            <div className={`flex-1 h-px ${step > 2 ? 'bg-green-500/30' : 'bg-zinc-700/60'}`} />
            <StepIndicator number={3} title="Generate" active={step === 3} done={false} />
          </div>

          {/* Upload card */}
          <Card className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Scene Image</span>
              <Badge color="zinc">Ctrl+V</Badge>
            </div>
            <label className={`flex items-center justify-center border-2 border-dashed rounded-xl cursor-pointer transition-all overflow-hidden ${
              preview
                ? 'border-blue-500/30 hover:border-blue-500/50'
                : 'border-zinc-700/60 hover:border-zinc-500/60 hover:bg-zinc-800/20'
            }`} style={{ minHeight: '160px' }}>
              {preview ? (
                <img src={preview} alt="Scene" className="w-full h-full object-contain max-h-52 rounded-lg" />
              ) : (
                <div className="text-center flex flex-col items-center gap-2 py-10 [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor]">
                  <div className="w-10 h-10 rounded-xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center">
                    <IconCamera uniqueId="scene-upload" size={20} className="text-zinc-400" aria-hidden />
                  </div>
                  <div>
                    <p className="text-sm text-zinc-400 font-medium">Drop image here</p>
                    <p className="text-xs text-zinc-600 mt-0.5">PNG, JPEG, WebP · or paste</p>
                  </div>
                </div>
              )}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleFile} />
            </label>
            <div className="flex gap-2">
              <Btn variant="secondary" onClick={handlePasteFromClipboard} className="flex-1 text-xs py-2">
                Paste
              </Btn>
              <Btn
                onClick={handleAnalyze}
                disabled={!file || isAnalyzing}
                className="flex-1 text-xs py-2"
              >
                {isAnalyzing ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-full border border-t-white border-white/20 animate-spin" />
                    Analyzing…
                  </span>
                ) : sceneData ? 'Re-analyze' : 'Analyze Scene'}
              </Btn>
            </div>
          </Card>

          {/* Scene analysis result */}
          {sceneData && (
            <Card className="space-y-3 animate-in">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Scene Details</span>
                <Badge color="green">Analyzed</Badge>
              </div>
              <div className="grid grid-cols-1 gap-1 max-h-44 overflow-y-auto pr-1">
                {sceneFields.map(([key, val]) => (
                  <div key={key} className="flex gap-2 py-0.5">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wide shrink-0 w-20 pt-0.5">{key}</span>
                    <span className="text-xs text-zinc-300 leading-relaxed">{val}</span>
                  </div>
                ))}
              </div>
              <Textarea
                label="Edit description"
                value={editableScene}
                onChange={(e) => scenePageStore.setValue('editableScene', e.target.value)}
                className="!min-h-[64px] !text-xs"
              />
            </Card>
          )}

          {/* Recreate settings */}
          {sceneData && (
            <Card className="space-y-4 animate-in">
              <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Generate Settings</span>

              {/* Character */}
              <div>
                <span className="text-xs text-zinc-400 font-medium block mb-1.5">Character</span>
                <select
                  value={charId}
                  onChange={(e) => setCharId(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
                >
                  <option value="">Select character…</option>
                  {chars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {charDetail?.references?.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {charDetail.references.map((r) => (
                      <Badge key={r.id} color={r.isActive ? 'blue' : 'zinc'}>{r.category}</Badge>
                    ))}
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

              {/* Aspect ratio + resolution in a row */}
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
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSameBackground(v => !v)}
                    className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition cursor-pointer border ${
                      sameBackground
                        ? 'bg-blue-600/20 text-blue-300 border-blue-500/60'
                        : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/60 hover:bg-zinc-700/60 hover:text-zinc-300'
                    }`}
                  >
                    {sameBackground ? '🔒' : '🔓'} Background
                  </button>
                  <button
                    type="button"
                    onClick={() => setSamePose(v => !v)}
                    className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition cursor-pointer border ${
                      samePose
                        ? 'bg-purple-600/20 text-purple-300 border-purple-500/60'
                        : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/60 hover:bg-zinc-700/60 hover:text-zinc-300'
                    }`}
                  >
                    {samePose ? '🔒' : '🔓'} Pose
                  </button>
                </div>
              </div>

              {/* Generate button */}
              <Btn
                onClick={handleRecreate}
                disabled={!charId}
                className="w-full py-3 text-sm font-semibold"
              >
                {isRecreating ? (
                  <span className="flex items-center gap-2">
                    <span className="w-3.5 h-3.5 rounded-full border border-t-white border-white/20 animate-spin" />
                    Queue Another
                  </span>
                ) : result ? (
                  'Generate Again'
                ) : (
                  'Generate Scene'
                )}
              </Btn>
            </Card>
          )}

          {/* Failed jobs */}
          {failedJobs.length > 0 && (
            <div className="space-y-2">
              {failedJobs.map((job) => (
                <div key={job.id} className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge color="red">Failed</Badge>
                        {job.meta && <span className="text-[10px] text-zinc-500">{job.meta}</span>}
                      </div>
                      <p className="text-xs text-zinc-400 mt-1.5">{job.errorMessage || 'Something went wrong'}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => dismissQueueItem(job.id)}
                      className="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer shrink-0"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── RIGHT PANEL ── */}
        <div className="space-y-4">

          {/* Running jobs */}
          {isRecreating && (
            <div className="space-y-2">
              {queueItems.filter((j) => j.status === 'running' && j.kind === 'recreate').map((job) => (
                <div key={job.id} className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3 flex items-center gap-3">
                  <div className="w-5 h-5 rounded-full border-2 border-t-blue-400 border-blue-400/20 animate-spin shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-blue-300">Generating…</span>
                      {job.meta && <span className="text-[10px] text-zinc-500">{job.meta}</span>}
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-0.5 truncate">{job.badges?.map((b) => b?.label).filter(Boolean).join(' · ')}</p>
                  </div>
                  <div className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Main result area */}
          <Card className="relative overflow-hidden">
            {/* Result image */}
            {result && (
              <div className="animate-in space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Latest Result</span>
                  <div className="flex items-center gap-2">
                    {result.image?.validation?.identity_match_score != null && (
                      <Badge color={result.image.validation.identity_match_score > 0.7 ? 'green' : 'zinc'}>
                        Identity {Math.round(result.image.validation.identity_match_score * 100)}%
                      </Badge>
                    )}
                    <Badge color="zinc">{aspectRatio} · {resolutionTier}</Badge>
                  </div>
                </div>
                <ImageCard
                  base64={result.image?.base64Data}
                  mimeType={result.image?.mimeType}
                  meta={{ imageId: result.imageId, identityConfidence: result.image?.validation?.identity_match_score }}
                  onSelect={() => result.image?.base64Data && openLightbox([`data:${result.image?.mimeType || 'image/png'};base64,${result.image?.base64Data}`], 0)}
                />
              </div>
            )}

            {/* Empty state */}
            {!result && !isRecreating && (
              <div className="flex flex-col items-center justify-center py-24 gap-4">
                <div className="w-16 h-16 rounded-2xl bg-zinc-800/60 border border-zinc-700/40 flex items-center justify-center">
                  <IconCamera uniqueId="empty-scene-result" size={28} className="text-zinc-600" aria-hidden />
                </div>
                <div className="text-center max-w-xs">
                  <p className="text-sm font-medium text-zinc-400">
                    {step === 1 ? 'Upload a scene to get started' : step === 2 ? 'Analyze the scene to continue' : 'Select a character and generate'}
                  </p>
                  <p className="text-xs text-zinc-600 mt-1">
                    {step === 1
                      ? 'Drop an image in the panel on the left'
                      : step === 2
                      ? 'Click Analyze Scene to extract scene details'
                      : 'Your recreated scene will appear here'}
                  </p>
                </div>
              </div>
            )}

            {/* Empty while first job running */}
            {!result && isRecreating && (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <p className="text-sm text-zinc-500">Results will appear here as they complete</p>
              </div>
            )}
          </Card>

          {/* Side-by-side comparison */}
          {result && preview && (
            <div className="grid grid-cols-2 gap-4 animate-in">
              <Card className="!p-3">
                <p className="text-[11px] text-zinc-500 font-medium uppercase tracking-wider mb-2">Original</p>
                <img src={preview} alt="Original" className="w-full rounded-lg" />
              </Card>
              <Card className="!p-3">
                <p className="text-[11px] text-zinc-500 font-medium uppercase tracking-wider mb-2">Recreated</p>
                {result.image && (
                  <img
                    src={`data:${result.image.mimeType};base64,${result.image.base64Data}`}
                    alt="Recreated"
                    className="w-full rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                    onClick={() => result.image?.base64Data && openLightbox([`data:${result.image?.mimeType || 'image/png'};base64,${result.image?.base64Data}`], 0)}
                  />
                )}
              </Card>
            </div>
          )}

          {/* History */}
          {history.length > 1 && (
            <div className="animate-in">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">History</span>
                <Badge color="zinc">{history.slice(1, 9).length}</Badge>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2">
                {history.slice(1, 9).filter((h) => h?.image?.base64Data).map((h, i) => (
                  <ImageCard
                    key={i}
                    base64={h.image?.base64Data}
                    mimeType={h.image?.mimeType}
                    className="!rounded-lg"
                    onSelect={() => h?.image?.base64Data && openLightbox(
                      history.slice(1, 9).filter((img) => img?.image?.base64Data).map((img) => `data:${img.image?.mimeType || 'image/png'};base64,${img.image?.base64Data}`),
                      i
                    )}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <LightboxComponent />
    </div>
  );
}
