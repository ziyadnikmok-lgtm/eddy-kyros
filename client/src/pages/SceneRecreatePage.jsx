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

const ANALYZE_STEPS = [
  'Reading scene image',
  'Analyzing scene with Gemini',
  'Preparing editable scene data',
];
const ANALYZE_THRESHOLDS = [2, 5];
const RECREATE_STEPS = [
  'Analyzing scene with Gemini',
  'Building identity-locked prompt',
  'Generating recreated image',
];
const RECREATE_THRESHOLDS = [3, 8];

const scenePageStore = createPersistentPageState('scene-recreate', {
  sceneData: _cache.sceneData,
  editableScene: _cache.editableScene,
  result: _cache.result,
  history: _cache.history,
  queueItems: [],
});

function CompactSceneJob({ job, onDismiss }) {
  const isRunning = job?.status === 'running';
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        isRunning
          ? 'border-blue-500/20 bg-blue-500/5'
          : 'border-red-500/20 bg-red-500/8'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge color={isRunning ? 'blue' : 'red'}>{isRunning ? (job?.label || 'Running') : 'Failed'}</Badge>
            {job?.meta ? <span className="text-[10px] text-zinc-500">{job.meta}</span> : null}
          </div>
          <div className="mt-2 text-sm text-zinc-200">{job?.summary || 'Scene request'}</div>
          {job?.badges?.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {job.badges.map((badge, index) => (
                <Badge key={`${badge?.label || badge}-${index}`} color={badge?.color || 'zinc'}>
                  {badge?.label || badge}
                </Badge>
              ))}
            </div>
          ) : null}
          <div className="mt-2 text-[11px] text-zinc-500">
            {isRunning ? 'Still running in background. You can keep working.' : (job?.errorMessage || 'Something went wrong')}
          </div>
        </div>
        {!isRunning ? (
          <button
            type="button"
            onClick={() => onDismiss?.(job?.id)}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer shrink-0"
          >
            Dismiss
          </button>
        ) : null}
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
    if (!imageItem) {
      notify('No image found in clipboard', 'error');
      return;
    }

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

  const handleAnalyze = async () => {
    if (!file) { notify('Upload an image first', 'error'); return; }

    const queueId = makePersistentJobId('scene-analyze');
    scenePageStore.setValue('queueItems', (prev) => [
      {
        id: queueId,
        kind: 'analyze',
        status: 'running',
        label: 'Analyzing Scene',
        summary: file.name || 'Scene image',
        badges: [{ label: file.type || 'image', color: 'zinc' }],
      },
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
        id: queueId,
        kind: 'recreate',
        status: 'running',
        label: 'Recreating Scene',
        summary: editableScene || 'Recreate scene with selected character',
        meta: `${aspectRatio} · ${resolutionTier}`,
        badges: [
          charDetail?.name ? { label: charDetail.name, color: 'zinc' } : null,
          { label: imageModel, color: 'zinc' },
        ].filter(Boolean),
      },
      ...prev.slice(0, 5),
    ]);

    try {
      const data = await sceneApi.recreate({
        sceneData: { ...sceneData, ...parsed },
        characterId: charId,
        activeReferenceIds: activeRefIds.length > 0 ? activeRefIds : undefined,
        aspectRatio,
        resolutionTier,
        imageModel,
        sameBackground,
        samePose,
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

  return (
    <div className="space-y-6 animate-in">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
        <div className="lg:col-span-1 space-y-4">
          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-medium text-zinc-200">1. Upload Scene Image</h3>
              <Badge color="zinc">Ctrl+V to paste</Badge>
            </div>
            <label className="flex items-center justify-center border-2 border-dashed border-zinc-700/80 rounded-lg cursor-pointer hover:border-zinc-500 transition h-40 overflow-hidden">
              {preview ? (
                <img src={preview} alt="Scene" className="max-h-full max-w-full object-contain" />
              ) : (
                <div className="text-center flex flex-col items-center [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor]">
                <IconCamera uniqueId="scene-upload" size={32} className="mb-1 text-zinc-500" aria-hidden />
                <span className="text-zinc-500 text-sm">Click, paste or drop image</span>
                <span className="text-zinc-600 text-xs mt-1">PNG, JPEG, WebP</span>
              </div>
              )}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleFile} />
            </label>
            <div className="flex gap-2">
              <Btn variant="secondary" onClick={handlePasteFromClipboard} className="flex-1">
                Paste
              </Btn>
              <Btn onClick={handleAnalyze} disabled={!file} className="flex-1">
              {activeQueueCount > 0 ? <>Analyze Again · {activeQueueCount} running</> : <>Analyze Scene</>}
              </Btn>
            </div>
          </Card>

          {queueItems.length > 0 && (
            <Card className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-zinc-300">Background Jobs</h3>
                <Badge color={activeQueueCount > 0 ? 'blue' : 'zinc'}>
                  {activeQueueCount > 0 ? `${activeQueueCount} running` : `${queueItems.length} update${queueItems.length === 1 ? '' : 's'}`}
                </Badge>
              </div>
              <div className="space-y-2">
                {queueItems.map((job) => (
                  <CompactSceneJob key={job.id} job={job} onDismiss={dismissQueueItem} />
                ))}
              </div>
            </Card>
          )}

          {sceneData && (
            <Card className="space-y-3 animate-in">
              <h3 className="text-lg font-medium text-zinc-200">2. Scene Analysis</h3>
              <div className="space-y-1.5">
                {sceneFields.map(([key, val]) => (
                  <div key={key} className="flex gap-2">
                    <Badge color="zinc">{key}</Badge>
                    <span className="text-xs text-zinc-300 flex-1">{val}</span>
                  </div>
                ))}
              </div>
              <Textarea label="Edit Scene Description (optional)" value={editableScene} onChange={(e) => scenePageStore.setValue('editableScene', e.target.value)} className="!min-h-[80px] !text-xs" />
            </Card>
          )}

          {sceneData && (
            <Card className="space-y-4 animate-in">
              <h3 className="text-lg font-medium text-zinc-200">3. Recreate with Character</h3>
              <select value={charId} onChange={(e) => setCharId(e.target.value)}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
                <option value="">Select character...</option>
                {chars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>

              {charDetail?.references?.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {charDetail.references.map((r) => (
                    <Badge key={r.id} color={r.isActive ? 'blue' : 'zinc'}>{r.category}</Badge>
                  ))}
                </div>
              )}

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

              <div>
                <span className="text-xs text-zinc-400 font-medium block mb-2">Aspect Ratio</span>
                <div className="flex flex-wrap gap-1.5">
                  {ASPECT_RATIOS.map((ar) => (
                    <button key={ar} onClick={() => setAspectRatio(ar)}
                      className={`rounded-md px-2 py-1 text-xs font-medium transition cursor-pointer ${aspectRatio === ar ? 'bg-blue-600 text-white' : 'bg-zinc-700/60 text-zinc-400 hover:bg-zinc-600'}`}>
                      {ar}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="text-xs text-zinc-400 font-medium block mb-2">Resolution Tier</span>
                <div className="flex flex-wrap gap-2">
                  {RESOLUTION_TIERS.map((tier) => (
                    <button
                      key={tier}
                      onClick={() => setResolutionTier(tier)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${resolutionTier === tier ? 'bg-blue-500 text-white' : 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600'}`}
                    >
                      {tier}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="text-xs text-zinc-400 font-medium block mb-2">Lock Options</span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSameBackground(v => !v)}
                    className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition cursor-pointer border ${
                      sameBackground
                        ? 'bg-blue-600/20 text-blue-300 border-blue-500/60'
                        : 'bg-zinc-800/60 text-zinc-400 border-zinc-700/60 hover:bg-zinc-700/60'
                    }`}
                  >
                    {sameBackground ? '🔒' : '🔓'} Same BG
                  </button>
                  <button
                    type="button"
                    onClick={() => setSamePose(v => !v)}
                    className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition cursor-pointer border ${
                      samePose
                        ? 'bg-purple-600/20 text-purple-300 border-purple-500/60'
                        : 'bg-zinc-800/60 text-zinc-400 border-zinc-700/60 hover:bg-zinc-700/60'
                    }`}
                  >
                    {samePose ? '🔒' : '🔓'} Same Pose
                  </button>
                </div>
              </div>

              <Btn onClick={handleRecreate} disabled={!charId} className="w-full">
                {activeQueueCount > 0 ? <>Queue Another · {activeQueueCount} running</> : <>Recreate Scene</>}
              </Btn>
            </Card>
          )}
        </div>

        <div className="lg:col-span-2 space-y-4">
          {!result && (
            <Card className="flex items-center justify-center py-24">
              <Empty
                icon={<IconCamera uniqueId="empty-scene" size={40} aria-hidden />}
                title={activeQueueCount > 0 ? 'Scene job is running' : 'No recreation yet'}
                subtitle={activeQueueCount > 0
                  ? 'Your scene request is still processing in the background. You can keep editing on the left.'
                  : 'Upload an image, analyze its scene, then recreate with a character'}
              />
            </Card>
          )}

          {result && (
            <Card className="animate-in !p-3">
              <ImageCard base64={result.image?.base64Data} mimeType={result.image?.mimeType}
                meta={{ imageId: result.imageId, identityConfidence: result.image?.validation?.identity_match_score }}
                onSelect={() => result.image?.base64Data && openLightbox([`data:${result.image?.mimeType || 'image/png'};base64,${result.image?.base64Data}`], 0)} />
            </Card>
          )}

          {result && preview && (
            <div className="grid grid-cols-2 gap-4">
              <Card className="!p-2">
                <p className="text-xs text-zinc-500 mb-2 text-center">Original Scene</p>
                <img src={preview} alt="Original" className="w-full rounded-lg" />
              </Card>
              <Card className="!p-2">
                <p className="text-xs text-zinc-500 mb-2 text-center">Recreated</p>
                {result.image && (
                  <img src={`data:${result.image.mimeType};base64,${result.image.base64Data}`} alt="Recreated" className="w-full rounded-lg"
                    style={{ cursor: 'pointer' }} onClick={() => result.image?.base64Data && openLightbox([`data:${result.image?.mimeType || 'image/png'};base64,${result.image?.base64Data}`], 0)} />
                )}
              </Card>
            </div>
          )}

          {history.length > 1 && (
            <div>
              <h3 className="text-sm font-medium text-zinc-400 mb-3">Previous Recreations</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {history.slice(1, 9).filter((h) => h?.image?.base64Data).map((h, i) => (
                  <ImageCard
                    key={i}
                    base64={h.image?.base64Data}
                    mimeType={h.image?.mimeType}
                    className="!rounded-lg"
                    onSelect={() => h?.image?.base64Data && openLightbox(history.slice(1, 9).filter((img) => img?.image?.base64Data).map((img) => `data:${img.image?.mimeType || 'image/png'};base64,${img.image?.base64Data}`), i)}
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
