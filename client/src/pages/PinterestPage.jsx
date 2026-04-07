import { useState, useEffect, useCallback, useRef } from 'react';
import { pinterest as pinterestApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Input, Textarea, Badge, ImageCard, Empty, Select } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { ASPECT_RATIOS, RESOLUTION_TIERS, IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL } from '../config/photoModes';
import { createPersistentPageState, makePersistentJobId, PersistentJobCard } from '../lib/persistentPageState';
import { IconCamera } from 'nucleo-glass';

const SCENE_FIELD_ORDER = [
  'environment',
  'lighting',
  'camera',
  'composition',
  'mood',
  'pose',
  'expression',
  'outfit',
  'format',
];

function SceneInsightCard({ label, value }) {
  return (
    <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/70 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className="mt-1.5 text-xs leading-5 text-zinc-300 line-clamp-4">{value}</div>
    </div>
  );
}

function LockChip({ active, colorClass, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3 py-2 text-xs font-semibold transition cursor-pointer ${
        active
          ? `${colorClass} border-current/40`
          : 'border-zinc-700/60 bg-zinc-900/70 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
      }`}
    >
      {active ? 'Locked' : 'Optional'} {label}
    </button>
  );
}

const _cache = {
  charId: '',
  aspectRatio: '4:5',
  resolutionTier: '2K',
  imageModel: DEFAULT_IMAGE_MODEL,
  sameBackground: false,
  samePose: false,
};

const ANALYZE_STEPS = [
  'Fetching pin image',
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
const VIDEO_RECREATE_STEPS = [
  'Downloading Pinterest video',
  'Extracting first frame',
  'Analyzing source frame',
  'Recreating with selected character',
];
const VIDEO_RECREATE_THRESHOLDS = [2, 6, 12];

const pinterestPageStore = createPersistentPageState('pinterest-recreate', {
  sceneData: null,
  editableScene: '',
  result: null,
  history: [],
  queueItems: [],
});

/** Fetch a remote image via the pinterest proxy and return { base64, mimeType }. */
async function fetchPinImageAsBase64(imageUrl) {
  const proxyUrl = pinterestApi.proxyUrl(imageUrl);
  const res = await fetch(proxyUrl);
  if (!res.ok) throw new Error(`Failed to fetch pin image (${res.status})`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = reader.result;
      const match = dataUri.match(/^data:(image\/[\w+]+);base64,(.+)$/);
      if (!match) { reject(new Error('Could not read image data')); return; }
      resolve({ mimeType: match[1], base64: match[2] });
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export default function PinterestPage() {
  const { notify, characters: chars } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const initialStoreState = pinterestPageStore.getSnapshot();

  // --- Pin fetch state ---
  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [pinResult, setPinResult] = useState(null); // raw klickpin result
  const inputRef = useRef(null);

  // --- Video state ---
  const [pinVideoUrl, setPinVideoUrl] = useState(null);
  const [videoAnalyzing, setVideoAnalyzing] = useState(false);
  const [klingPrompt, setKlingPrompt] = useState('');
  const [promptCopied, setPromptCopied] = useState(false);

  // --- Scene / recreate state (mirroring SceneRecreatePage) ---
  const [showEditScene, setShowEditScene] = useState(false);
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

  // sync _cache
  useEffect(() => { _cache.charId = charId; }, [charId]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolutionTier = resolutionTier; }, [resolutionTier]);
  useEffect(() => { _cache.imageModel = imageModel; }, [imageModel]);
  useEffect(() => { _cache.sameBackground = sameBackground; }, [sameBackground]);
  useEffect(() => { _cache.samePose = samePose; }, [samePose]);

  // subscribe to persistent store
  useEffect(() => pinterestPageStore.subscribe((snapshot) => {
    setSceneData(snapshot.sceneData);
    setEditableScene(snapshot.editableScene);
    setResult(snapshot.result);
    setHistory(snapshot.history);
    setQueueItems(snapshot.queueItems);
  }), []);

  // load char detail when charId changes
  useEffect(() => {
    if (charId) charApi.get(charId).then(setCharDetail).catch(() => setCharDetail(null));
    else setCharDetail(null);
  }, [charId]);

  // -------------------------------------------------------------------------
  // Fetch pin
  // -------------------------------------------------------------------------
  const handleFetch = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setFetching(true);
    setFetchError('');
    setPinResult(null);
    setPinVideoUrl(null);
    setKlingPrompt('');
    setVideoAnalyzing(false);
    // clear previous scene when fetching a new pin
    pinterestPageStore.patch({ sceneData: null, editableScene: '', result: null });
    setShowEditScene(false);
    try {
      const data = await pinterestApi.fetch({ url: trimmed });
      if (data.error) throw new Error(data.error);
      setPinResult(data);
      // auto-trigger analyze for image pins
      if (data.type === 'image' && data.url) {
        triggerAnalyze(data.url);
      }
      // auto-trigger video analysis for video pins
      if (data.type === 'video' && data.url) {
        setPinVideoUrl(data.url);
        triggerAnalyzeVideo(data.url);
      }
    } catch (err) {
      setFetchError(err.message || 'Failed to fetch pin');
    } finally {
      setFetching(false);
    }
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleKeyDown = useCallback(
    (e) => { if (e.key === 'Enter') handleFetch(); },
    [handleFetch]
  );

  // -------------------------------------------------------------------------
  // Analyze (image)
  // -------------------------------------------------------------------------
  const triggerAnalyze = useCallback(async (imageUrl) => {
    const queueId = makePersistentJobId('pinterest-analyze');
    pinterestPageStore.setValue('queueItems', (prev) => [
      {
        id: queueId,
        kind: 'analyze',
        status: 'running',
        label: 'Analyzing Pin',
        summary: imageUrl,
        badges: [{ label: 'image', color: 'zinc' }],
      },
      ...prev.slice(0, 5),
    ]);

    try {
      const { base64, mimeType } = await fetchPinImageAsBase64(imageUrl);
      const data = await pinterestApi.analyze(base64, mimeType);
      const text = Object.entries(data).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
      pinterestPageStore.patch({ sceneData: data, editableScene: text });
      pinterestPageStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
      notify('Pin analyzed!', 'success');
    } catch (err) {
      pinterestPageStore.setValue('queueItems', (prev) => prev.map((job) => (
        job.id === queueId ? { ...job, status: 'error', errorMessage: err?.message || 'Failed to analyze pin' } : job
      )));
      notify(err?.message || 'Failed to analyze pin', 'error');
    }
  }, [notify]);

  const handleAnalyze = () => {
    if (!pinResult?.url) { notify('Fetch a pin image first', 'error'); return; }
    if (pinResult.type !== 'image') { notify('Only image pins can be analyzed', 'error'); return; }
    triggerAnalyze(pinResult.url);
  };

  // -------------------------------------------------------------------------
  // Analyze video → Kling prompt
  // -------------------------------------------------------------------------
  const triggerAnalyzeVideo = useCallback(async (videoUrl) => {
    setVideoAnalyzing(true);
    setKlingPrompt('');
    try {
      const data = await pinterestApi.analyzeVideo(videoUrl);
      setKlingPrompt(data.prompt || '');
      notify('Kling prompt ready!', 'success');
    } catch (err) {
      notify(err?.message || 'Failed to analyze video', 'error');
    } finally {
      setVideoAnalyzing(false);
    }
  }, [notify]);

  const handleCopyPrompt = () => {
    if (!klingPrompt) return;
    navigator.clipboard.writeText(klingPrompt).then(() => {
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 2000);
    });
  };

  // -------------------------------------------------------------------------
  // Recreate
  // -------------------------------------------------------------------------
  const handleRecreate = async () => {
    if (!sceneData) { notify('Analyze the pin first', 'error'); return; }
    if (!charId) { notify('Select a character', 'error'); return; }

    const parsed = {};
    editableScene.split('\n').forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > 0) parsed[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });

    const activeRefIds = charDetail?.references?.filter((r) => r.isActive).map((r) => r.id) || [];
    const queueId = makePersistentJobId('pinterest-recreate');
    pinterestPageStore.setValue('queueItems', (prev) => [
      {
        id: queueId,
        kind: 'recreate',
        status: 'running',
        label: 'Recreating Pin',
        summary: editableScene || 'Recreate pin with selected character',
        meta: `${aspectRatio} · ${resolutionTier}`,
        badges: [
          charDetail?.name ? { label: charDetail.name, color: 'zinc' } : null,
          sameBackground ? { label: 'Same BG', color: 'blue' } : null,
          samePose ? { label: 'Same Pose', color: 'blue' } : null,
        ].filter(Boolean),
      },
      ...prev.slice(0, 5),
    ]);

    try {
      const data = await pinterestApi.recreate({
        sceneData: { ...sceneData, ...parsed },
        characterId: charId,
        activeReferenceIds: activeRefIds.length > 0 ? activeRefIds : undefined,
        aspectRatio,
        resolutionTier,
        imageModel,
        sameBackground,
        samePose,
      });
      pinterestPageStore.setValue('result', data);
      pinterestPageStore.setValue('history', (prev) => [data, ...prev].slice(0, 10));
      pinterestPageStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
      notify('Pin recreated!', 'success');
    } catch (err) {
      pinterestPageStore.setValue('queueItems', (prev) => prev.map((job) => (
        job.id === queueId ? { ...job, status: 'error', errorMessage: err?.message || 'Failed to recreate pin' } : job
      )));
      notify(err?.message || 'Failed to recreate pin', 'error');
    }
  };

  const handleVideoRecreate = async () => {
    if (!pinVideoUrl) { notify('Fetch a Pinterest video first', 'error'); return; }
    if (!charId) { notify('Select a character', 'error'); return; }

    const activeRefIds = charDetail?.references?.filter((r) => r.isActive).map((r) => r.id) || [];
    const queueId = makePersistentJobId('pinterest-video-recreate');
    pinterestPageStore.setValue('queueItems', (prev) => [
      {
        id: queueId,
        kind: 'video-recreate',
        status: 'running',
        label: 'Recreating First Frame',
        summary: 'Extracting first frame from Pinterest video',
        meta: '9:16 · 2K',
        badges: [
          charDetail?.name ? { label: charDetail.name, color: 'zinc' } : null,
          { label: imageModel, color: 'zinc' },
          { label: 'First Frame', color: 'blue' },
        ].filter(Boolean),
      },
      ...prev.slice(0, 5),
    ]);

    try {
      const data = await pinterestApi.recreateVideoFrame({
        videoUrl: pinVideoUrl,
        characterId: charId,
        activeReferenceIds: activeRefIds.length > 0 ? activeRefIds : undefined,
        imageModel,
      });
      pinterestPageStore.setValue('result', data);
      pinterestPageStore.setValue('history', (prev) => [data, ...prev].slice(0, 10));
      pinterestPageStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
      notify('First frame recreated!', 'success');
    } catch (err) {
      pinterestPageStore.setValue('queueItems', (prev) => prev.map((job) => (
        job.id === queueId ? { ...job, status: 'error', errorMessage: err?.message || 'Failed to recreate first frame' } : job
      )));
      notify(err?.message || 'Failed to recreate first frame', 'error');
    }
  };

  // -------------------------------------------------------------------------
  // Queue helpers
  // -------------------------------------------------------------------------
  const dismissQueueItem = (queueId) => {
    pinterestPageStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
  };
  const dismissAllFailed = () => {
    pinterestPageStore.setValue('queueItems', (prev) => prev.filter((job) => job.status !== 'error'));
  };

  const failedQueueCount = queueItems.filter((job) => job.status === 'error').length;
  const activeQueueCount = queueItems.filter((job) => job.status === 'running').length;

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------
  const sceneFields = sceneData
    ? SCENE_FIELD_ORDER.map((key) => [key, sceneData[key]]).filter(([, value]) => value)
    : [];
  const sceneHighlights = sceneFields.slice(0, showEditScene ? sceneFields.length : 6);
  const selectedCharacterLabel = chars.find((c) => c.id === charId)?.name || 'Choose character';
  const readyToRecreate = !!sceneData && !!charId;
  const pinImageUrl = pinResult?.type === 'image' ? pinResult.url : null;
  const pinPreviewUrl = pinImageUrl ? pinterestApi.proxyUrl(pinImageUrl) : null;
  const isVideoPin = pinResult?.type === 'video';
  const resultImageSrc = result?.image?.base64Data
    ? `data:${result.image?.mimeType || 'image/png'};base64,${result.image?.base64Data}`
    : null;
  const sourceFrameSrc = result?.sourceFrame?.base64Data
    ? `data:${result.sourceFrame?.mimeType || 'image/jpeg'};base64,${result.sourceFrame?.base64Data}`
    : null;

  // -------------------------------------------------------------------------
  return (
    <div className="space-y-6 animate-in">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">

        {/* ---------------------------------------------------------------- */}
        {/* LEFT COLUMN                                                        */}
        {/* ---------------------------------------------------------------- */}
        <div className="lg:col-span-1 space-y-4">
          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-medium text-zinc-200">Pinterest Pin</h3>
                <p className="text-xs text-zinc-500 mt-1">Paste a pin URL to fetch, then recreate with your character.</p>
              </div>
            </div>

            {/* URL input row */}
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="https://www.pinterest.com/pin/... or pin.it/..."
                className="flex-1"
                disabled={fetching}
              />
              <Btn onClick={handleFetch} disabled={fetching || !url.trim()} className="shrink-0">
                {fetching ? 'Fetching…' : 'Fetch'}
              </Btn>
            </div>
            {fetchError && (
              <p className="text-xs text-red-400 bg-red-950/30 rounded-md px-3 py-2">{fetchError}</p>
            )}

            {/* Pin preview + controls */}
            <div className="grid gap-4 md:grid-cols-[152px,1fr]">
              {/* Thumbnail */}
              <div
                className="flex h-72 items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-zinc-700/80 bg-zinc-950/90 p-3"
              >
                {pinImageUrl ? (
                  <img
                    src={pinPreviewUrl}
                    alt={pinResult?.title || 'Pin'}
                    className="max-h-full w-auto max-w-full rounded-lg object-contain"
                  />
                ) : isVideoPin ? (
                  <div className="text-center px-4">
                    <p className="text-sm font-medium text-violet-400">Video Pin</p>
                    <p className="text-[11px] text-zinc-500 mt-1">See player →</p>
                  </div>
                ) : (
                  <div className="text-center px-4 [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor]">
                    <div className="flex justify-center">
                      <IconCamera uniqueId="pin-empty" size={30} className="text-zinc-600" aria-hidden />
                    </div>
                    <p className="mt-2 text-sm font-medium text-zinc-400">No pin yet</p>
                    <p className="text-[11px] text-zinc-600 mt-1">Paste a URL above</p>
                  </div>
                )}
              </div>

              {/* Right of thumbnail */}
              {!isVideoPin && (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select
                      label="Character"
                      value={charId}
                      onChange={(e) => setCharId(e.target.value)}
                      placeholder="Select character..."
                      className="w-full"
                      options={[{ value: '', label: 'Select character...' }, ...chars.map((c) => ({ value: c.id, label: c.name }))]}
                    />
                    <Select
                      label="Model"
                      value={imageModel}
                      onChange={(e) => setImageModel(e.target.value)}
                      className="w-full"
                      options={IMAGE_MODEL_OPTIONS}
                    />
                  </div>

                  <div className="rounded-xl border border-zinc-800/70 bg-zinc-950/70 p-3 space-y-3">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Workflow</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge color={pinResult ? 'green' : 'zinc'}>{pinResult ? 'Pin fetched' : 'No pin yet'}</Badge>
                      <Badge color={sceneData ? 'green' : 'zinc'}>{sceneData ? 'Scene understood' : 'Needs analysis'}</Badge>
                      <Badge color={readyToRecreate ? 'blue' : 'zinc'}>{readyToRecreate ? 'Ready to recreate' : selectedCharacterLabel}</Badge>
                      {result ? <Badge color="blue">Latest result ready</Badge> : null}
                    </div>
                    <p className="mt-3 text-xs leading-5 text-zinc-400">
                      {sceneData
                        ? `Detected ${sceneFields.length} scene cues. Tweak the summary if needed, then recreate with ${selectedCharacterLabel}.`
                        : 'Paste a Pinterest URL and fetch. The image is analyzed automatically so you can recreate it with your character.'}
                    </p>

                    <div className="grid gap-3 pt-1 sm:grid-cols-2">
                      <div>
                        <span className="text-xs font-medium text-zinc-400 block mb-2">Aspect Ratio</span>
                        <div className="flex flex-wrap gap-1.5">
                          {ASPECT_RATIOS.map((ar) => (
                            <button
                              key={ar}
                              type="button"
                              onClick={() => setAspectRatio(ar)}
                              className={`rounded-md px-2 py-1 text-xs font-medium transition cursor-pointer ${
                                aspectRatio === ar ? 'bg-blue-600 text-white' : 'bg-zinc-800/70 text-zinc-400 hover:bg-zinc-700'
                              }`}
                            >
                              {ar}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <span className="text-xs font-medium text-zinc-400 block mb-2">Resolution</span>
                        <div className="flex flex-wrap gap-2">
                          {RESOLUTION_TIERS.map((tier) => (
                            <button
                              key={tier}
                              type="button"
                              onClick={() => setResolutionTier(tier)}
                              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${
                                resolutionTier === tier ? 'bg-blue-500 text-white' : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                              }`}
                            >
                              {tier}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2 pt-1">
                      <div className="text-xs font-medium text-zinc-400">Locks</div>
                      <div className="grid grid-cols-2 gap-2">
                        <LockChip
                          active={sameBackground}
                          colorClass="bg-blue-600/20 text-blue-300"
                          label="Background"
                          onClick={() => setSameBackground((prev) => !prev)}
                        />
                        <LockChip
                          active={samePose}
                          colorClass="bg-blue-600/20 text-blue-300"
                          label="Pose"
                          onClick={() => setSamePose((prev) => !prev)}
                        />
                      </div>
                    </div>
                  </div>

                  <Btn
                    variant="secondary"
                    onClick={handleAnalyze}
                    disabled={!pinImageUrl || activeQueueCount > 0}
                    className="w-full"
                  >
                    {activeQueueCount > 0 ? `${activeQueueCount} running…` : 'Re-analyze'}
                  </Btn>

                  <Btn onClick={handleRecreate} disabled={!sceneData || !charId} className="w-full">
                    {activeQueueCount > 0 ? `Queue Another · ${activeQueueCount} running` : 'Recreate Pin'}
                  </Btn>
                </div>
              )}

              {/* Video pin — compact left panel info */}
              {isVideoPin && (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select
                      label="Character"
                      value={charId}
                      onChange={(e) => setCharId(e.target.value)}
                      placeholder="Select character..."
                      className="w-full"
                      options={[{ value: '', label: 'Select character...' }, ...chars.map((c) => ({ value: c.id, label: c.name }))]}
                    />
                    <Select
                      label="Model"
                      value={imageModel}
                      onChange={(e) => setImageModel(e.target.value)}
                      className="w-full"
                      options={IMAGE_MODEL_OPTIONS}
                    />
                  </div>
                  <div className="rounded-xl border border-violet-800/40 bg-violet-950/20 p-3 space-y-3">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-400">Video Workflow</div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge color={pinResult ? 'green' : 'zinc'}>Pin fetched</Badge>
                      <Badge color={videoAnalyzing ? 'blue' : klingPrompt ? 'green' : 'zinc'}>
                        {videoAnalyzing ? 'Analyzing…' : klingPrompt ? 'Prompt ready' : 'Awaiting analysis'}
                      </Badge>
                      <Badge color={charId ? 'blue' : 'zinc'}>{charId ? selectedCharacterLabel : 'Choose character'}</Badge>
                      {resultImageSrc ? <Badge color="blue">First frame recreated</Badge> : null}
                    </div>
                    <p className="text-xs leading-5 text-zinc-400">
                      Video is being analyzed with Gemini to generate a Kling 2.6 prompt. You can also run a reel-copy style recreate using the extracted first frame.
                    </p>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Badge color="blue">Locked: 9:16</Badge>
                      <Badge color="blue">Locked: 2K</Badge>
                      <Badge color="zinc">First frame</Badge>
                    </div>
                  </div>
                  {klingPrompt && (
                    <Btn
                      variant="secondary"
                      onClick={() => triggerAnalyzeVideo(pinVideoUrl)}
                      disabled={videoAnalyzing}
                      className="w-full"
                    >
                      {videoAnalyzing ? 'Analyzing…' : 'Re-analyze Video'}
                    </Btn>
                  )}
                  <Btn onClick={handleVideoRecreate} disabled={!pinVideoUrl || !charId || activeQueueCount > 0} className="w-full">
                    {activeQueueCount > 0 ? `Queue Another · ${activeQueueCount} running` : 'Recreate First Frame'}
                  </Btn>
                </div>
              )}
            </div>
          </Card>

          {/* Scene summary card — image pins only */}
          {sceneData && !isVideoPin && (
            <Card className="space-y-4 animate-in">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-medium text-zinc-200">Scene Summary</h3>
                  <p className="text-xs text-zinc-500 mt-1">Compact cues first. Expand to rewrite.</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge color="zinc">{sceneFields.length} fields</Badge>
                  <button
                    type="button"
                    onClick={() => setShowEditScene((prev) => !prev)}
                    className="text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer transition"
                  >
                    {showEditScene ? 'Hide editor' : 'Edit all'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {sceneHighlights.map(([key, value]) => (
                  <SceneInsightCard key={key} label={key} value={value} />
                ))}
              </div>

              {!showEditScene && sceneFields.length > 6 && (
                <button
                  type="button"
                  onClick={() => setShowEditScene(true)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer transition"
                >
                  Show full scene text
                </button>
              )}

              {showEditScene && (
                <Textarea
                  label="Edit Scene Description"
                  value={editableScene}
                  onChange={(e) => pinterestPageStore.setValue('editableScene', e.target.value)}
                  className="!min-h-[112px] !text-xs"
                />
              )}
            </Card>
          )}

          {/* Active character references — image pins only */}
          {sceneData && !isVideoPin && charDetail?.references?.length > 0 && (
            <Card className="space-y-3 animate-in">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Active Character References</div>
              <div className="flex flex-wrap gap-1.5">
                {charDetail.references.map((r) => (
                  <Badge key={r.id} color={r.isActive ? 'blue' : 'zinc'}>{r.category}</Badge>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* RIGHT COLUMN                                                       */}
        {/* ---------------------------------------------------------------- */}
        <div className="lg:col-span-2 space-y-4">
          {/* Queue */}
          {queueItems.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-zinc-400">Pinterest Recreate Queue</h3>
                <div className="flex items-center gap-2">
                  {failedQueueCount > 0 && (
                    <button type="button" onClick={dismissAllFailed} className="text-[11px] text-red-400/70 hover:text-red-300 cursor-pointer transition">
                      Dismiss all failed
                    </button>
                  )}
                  <Badge color={activeQueueCount > 0 ? 'blue' : 'zinc'}>
                    {activeQueueCount > 0 ? `${activeQueueCount} running` : `${queueItems.length} update${queueItems.length === 1 ? '' : 's'}`}
                  </Badge>
                </div>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                {queueItems.map((job) => (
                  <PersistentJobCard
                    key={job.id}
                    job={job}
                    steps={job.kind === 'analyze' ? ANALYZE_STEPS : job.kind === 'video-recreate' ? VIDEO_RECREATE_STEPS : RECREATE_STEPS}
                    thresholds={job.kind === 'analyze' ? ANALYZE_THRESHOLDS : job.kind === 'video-recreate' ? VIDEO_RECREATE_THRESHOLDS : RECREATE_THRESHOLDS}
                    onDismiss={dismissQueueItem}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ---- VIDEO PIN UI ---- */}
          {isVideoPin && pinVideoUrl && (
            <>
              {/* Video player card */}
              <Card className="animate-in !p-3">
                <p className="text-xs text-violet-400 font-semibold uppercase tracking-[0.12em] mb-3">Video Preview</p>
                <video
                  src={pinVideoUrl}
                  controls
                  className="w-full rounded-lg max-h-[480px] bg-black"
                  preload="metadata"
                />
              </Card>

              {/* Kling Prompt card */}
              <Card className="animate-in border border-violet-800/40 bg-violet-950/10">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="text-base font-semibold text-violet-300">Kling 2.6 Prompt</h3>
                    <p className="text-xs text-zinc-500 mt-0.5">Generated by Gemini video analysis</p>
                  </div>
                  {klingPrompt && !videoAnalyzing && (
                    <button
                      type="button"
                      onClick={handleCopyPrompt}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition cursor-pointer border ${
                        promptCopied
                          ? 'bg-violet-600/30 text-violet-200 border-violet-500/50'
                          : 'bg-violet-900/30 text-violet-300 border-violet-700/50 hover:bg-violet-800/40 hover:text-violet-200'
                      }`}
                    >
                      {promptCopied ? 'Copied!' : 'Copy Prompt'}
                    </button>
                  )}
                </div>

                {videoAnalyzing && (
                  <div className="flex items-center gap-3 py-8 justify-center">
                    <div className="h-5 w-5 rounded-full border-2 border-violet-500 border-t-transparent animate-spin" />
                    <span className="text-sm text-zinc-400">Analyzing video with Gemini…</span>
                  </div>
                )}

                {!videoAnalyzing && klingPrompt && (
                  <div className="rounded-lg border border-violet-800/30 bg-zinc-950/60 p-4">
                    <p className="text-sm leading-7 text-zinc-200 font-mono whitespace-pre-wrap break-words">{klingPrompt}</p>
                  </div>
                )}

                {!videoAnalyzing && !klingPrompt && (
                  <div className="flex items-center justify-center py-8">
                    <p className="text-sm text-zinc-500">Waiting for analysis to complete…</p>
                  </div>
                )}
              </Card>

              {!resultImageSrc && activeQueueCount === 0 && (
                <Card className="flex items-center justify-center py-20">
                  <Empty
                    icon={<IconCamera uniqueId="empty-pinterest-video" size={40} aria-hidden />}
                    title={charId ? 'Ready to recreate first frame' : 'Choose a character'}
                    subtitle={
                      charId
                        ? 'Use Recreate First Frame to run a reel-copy style character recreation from the video.'
                        : 'Select a character first, then recreate the opening frame of this Pinterest video.'
                    }
                  />
                </Card>
              )}

              {resultImageSrc && (
                <>
                  <Card className="animate-in !p-3">
                    <ImageCard
                      base64={result.image?.base64Data}
                      mimeType={result.image?.mimeType}
                      meta={{ imageId: result.imageId }}
                      onSelect={() => resultImageSrc && openLightbox([resultImageSrc], 0)}
                    />
                  </Card>

                  {sourceFrameSrc && (
                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                      <Card className="!p-2">
                        <p className="text-xs text-zinc-500 mb-2 text-center font-medium">Extracted First Frame</p>
                        <img
                          src={sourceFrameSrc}
                          alt="Extracted first frame"
                          className="w-full rounded-lg object-contain max-h-96"
                        />
                      </Card>
                      <Card className="!p-2">
                        <p className="text-xs text-zinc-500 mb-2 text-center font-medium">Character Recreation</p>
                        <img
                          src={resultImageSrc}
                          alt="Character recreation"
                          className="w-full rounded-lg object-contain max-h-96 cursor-pointer"
                          onClick={() => resultImageSrc && openLightbox([resultImageSrc], 0)}
                        />
                      </Card>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ---- IMAGE PIN UI ---- */}
          {!isVideoPin && (
            <>
              {/* Empty state */}
              {!result && activeQueueCount === 0 && (
                <Card className="flex items-center justify-center py-24">
                  <Empty
                    icon={<IconCamera uniqueId="empty-pinterest" size={40} aria-hidden />}
                    title={sceneData ? 'Ready to recreate' : 'No recreation yet'}
                    subtitle={
                      sceneData
                        ? 'Pin analyzed. Choose a character and hit Recreate Pin.'
                        : 'Paste a Pinterest URL above. After fetching, the scene is analyzed automatically.'
                    }
                  />
                </Card>
              )}

              {/* Latest result */}
              {result && (
                <Card className="animate-in !p-3">
                  <ImageCard
                    base64={result.image?.base64Data}
                    mimeType={result.image?.mimeType}
                    meta={{ imageId: result.imageId, identityConfidence: result.image?.validation?.identity_match_score }}
                    onSelect={() => resultImageSrc && openLightbox([resultImageSrc], 0)}
                  />
                </Card>
              )}

              {/* Side-by-side comparison */}
              {result && pinImageUrl && (
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <Card className="!p-2">
                    <p className="text-xs text-zinc-500 mb-2 text-center font-medium">Original Pin</p>
                    <img
                      src={pinPreviewUrl}
                      alt="Original"
                      className="w-full rounded-lg object-contain max-h-96"
                    />
                  </Card>
                  <Card className="!p-2">
                    <p className="text-xs text-zinc-500 mb-2 text-center font-medium">Recreated</p>
                    {result.image && (
                      <img
                        src={resultImageSrc}
                        alt="Recreated"
                        className="w-full rounded-lg object-contain max-h-96 cursor-pointer"
                        onClick={() => resultImageSrc && openLightbox([resultImageSrc], 0)}
                      />
                    )}
                  </Card>
                </div>
              )}

              {/* History */}
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
                        onSelect={() => h?.image?.base64Data && openLightbox(
                          history.slice(1, 9).filter((img) => img?.image?.base64Data).map((img) => `data:${img.image?.mimeType || 'image/png'};base64,${img.image?.base64Data}`),
                          i
                        )}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <LightboxComponent />
    </div>
  );
}
