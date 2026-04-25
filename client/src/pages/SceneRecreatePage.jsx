import { useState, useEffect, useCallback } from 'react';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { scene as sceneApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Textarea, Badge, ImageCard } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { ASPECT_RATIOS, RESOLUTION_TIERS, IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL, DEFAULT_RESOLUTION_TIER } from '../config/photoModes';
import { createPersistentPageState, makePersistentJobId, PersistentJobCard } from '../lib/persistentPageState';
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
  resolutionTier: DEFAULT_RESOLUTION_TIER,
  imageModel: DEFAULT_IMAGE_MODEL,
  sameBackground: false,
  samePose: false,
  sameHair: false,
  sameTattoos: false,
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

const SCENE_RECREATE_STEPS = [
  'Analyzing scene image',
  'Applying character references',
  'Generating recreated scene',
];

const SCENE_RECREATE_THRESHOLDS = [8, 18];

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
  const [sameHair, setSameHair] = useState(_cache.sameHair);
  const [sameTattoos, setSameTattoos] = useState(_cache.sameTattoos);
  const [result, setResult] = useState(initialStoreState.result);
  const [history, setHistory] = useState(initialStoreState.history);
  const [queueItems, setQueueItems] = useState(initialStoreState.queueItems);
  const [analyzing, setAnalyzing] = useState(false);
  const characterPromptPreview = String(charDetail?.masterPrompt || '').trim();

  useEffect(() => { _cache.sceneData = sceneData; }, [sceneData]);
  useEffect(() => { _cache.editableScene = editableScene; }, [editableScene]);
  useEffect(() => { _cache.charId = charId; }, [charId]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolutionTier = resolutionTier; }, [resolutionTier]);
  useEffect(() => { _cache.imageModel = imageModel; }, [imageModel]);
  useEffect(() => { _cache.sameBackground = sameBackground; }, [sameBackground]);
  useEffect(() => { _cache.samePose = samePose; }, [samePose]);
  useEffect(() => { _cache.sameHair = sameHair; }, [sameHair]);
  useEffect(() => { _cache.sameTattoos = sameTattoos; }, [sameTattoos]);
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
        applyFile(new File([blob], `pin.${ext}`, { type: blob.type }));
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

  const handleGenerate = async () => {
    if (!file) { notify('Upload an image first', 'error'); return; }
    if (!charId) { notify('Select a character', 'error'); return; }
    const activeRefIds = charDetail?.references?.filter((r) => r.isActive).map((r) => r.id) || [];
    const queueId = makePersistentJobId('scene-recreate');
    pushPending({ id: queueId, prompt: 'Scene Recreate', imageModel: imageModel || '', aspectRatio, resolutionTier });
    scenePageStore.setValue('queueItems', (prev) => [
      {
        id: queueId, kind: 'recreate', status: 'running', label: 'Recreating Scene',
        summary: file.name || 'Scene image',
        meta: `${aspectRatio} · ${resolutionTier}`,
        badges: [charDetail?.name ? { label: charDetail.name, color: 'zinc' } : null, { label: imageModel, color: 'zinc' }].filter(Boolean),
      },
      ...prev.slice(0, 5),
    ]);
    try {
      // Step 1: analyze
      setAnalyzing(true);
      const dataUri = await fileToBase64(file);
      const base64 = dataUri.split(',')[1];
      const analyzed = await sceneApi.analyze(base64, file.type);
      const text = Object.entries(analyzed).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
      scenePageStore.patch({ sceneData: analyzed, editableScene: text });
      setAnalyzing(false);
      // Step 2: recreate using editableScene overrides if any
      const parsed = {};
      (editableScene || text).split('\n').forEach((line) => {
        const idx = line.indexOf(':');
        if (idx > 0) parsed[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
      const data = await sceneApi.recreate({
        sceneData: { ...analyzed, ...parsed },
        characterId: charId,
        activeReferenceIds: activeRefIds.length > 0 ? activeRefIds : undefined,
        masterPromptOverride: characterPromptPreview || undefined,
        aspectRatio, resolutionTier, imageModel, sameBackground, samePose,
        sameHair, sameTattoos,
      });
      scenePageStore.setValue('result', data);
      scenePageStore.setValue('history', (prev) => [data, ...prev].slice(0, 10));
      scenePageStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
      resolvePending(queueId, {
        imageId: data.imageId,
        galleryId: data.galleryId || data.imageId,
        mimeType: data.image?.mimeType,
        prompt: characterPromptPreview || 'Scene Recreate',
        imageModel: imageModel || '',
        aspectRatio,
        resolutionTier,
        generatedAt: Date.now(),
        characterId: charId || null,
      });
      notify('Scene recreated!', 'success');
    } catch (err) {
      setAnalyzing(false);
      rejectPending(queueId);
      scenePageStore.setValue('queueItems', (prev) => prev.map((job) => (
        job.id === queueId ? { ...job, status: 'error', errorMessage: err?.message || 'Failed to recreate scene' } : job
      )));
      notify(err?.message || 'Failed to recreate scene', 'error');
    }
  };

  const isRunning = analyzing || isRecreating;

  return (
    <div className="space-y-6 animate-in">
      <div className="max-w-md">

        {/* ── CONTROLS ── */}
        <div className="space-y-3">

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
            <Btn variant="secondary" onClick={handlePasteFromClipboard} className="w-full text-xs py-2">
              Paste from Clipboard
            </Btn>
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
            <Btn
              onClick={handleGenerate}
              disabled={!file || !charId}
              className="w-full py-3 text-sm font-semibold"
            >
              {analyzing ? (
                <span className="flex items-center gap-2">
                  <span className="w-3.5 h-3.5 rounded-full border border-t-white border-white/20 animate-spin" />
                  Analyzing…
                </span>
              ) : activeQueueCount > 0 ? `Queue Another · ${activeQueueCount} running` : result ? 'Generate Again' : 'Generate Scene'}
            </Btn>
          </Card>

        </div>
      </div>
      <LightboxComponent />
    </div>
  );
}
