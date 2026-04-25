import { useEffect, useState, useMemo } from 'react';
import { characters as charApi, reel as reelApi, availability as availabilityApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Input, Badge, Spinner, ImageCard, Empty } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL } from '../config/photoModes';
import { createPersistentPageState, makePersistentJobId, PersistentJobCard } from '../lib/persistentPageState';
import { IconVideo } from 'nucleo-glass';

const _cache = {
  reelUrl: '',
  charId: '',
  result: null,
  recreationHistory: [],
  poseMatchStrength: 'medium',
  environmentMatchStrength: 'medium',
  poseMatchEnabled: true,
  environmentMatchEnabled: true,
  useSourceFrameReference: false,
  outfitTransition: false,
  runSourceType: 'url',
  imageModel: DEFAULT_IMAGE_MODEL,
};

const reelPageStore = createPersistentPageState('reel-recreate', {
  result: _cache.result,
  recreationHistory: _cache.recreationHistory,
  queueItems: [],
});

export default function ReelRecreatePage() {
  const { notify, characters: chars } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const initialStoreState = reelPageStore.getSnapshot();

  const [reelUrl, setReelUrl] = useState(_cache.reelUrl);
  const [localVideoFile, setLocalVideoFile] = useState(null);
  const [charId, setCharId] = useState(_cache.charId);
  const [charDetail, setCharDetail] = useState(null);
  const [result, setResult] = useState(initialStoreState.result);
  const [recreationHistory, setRecreationHistory] = useState(initialStoreState.recreationHistory);
  const [queueItems, setQueueItems] = useState(initialStoreState.queueItems);
  const [runSourceType, setRunSourceType] = useState(_cache.runSourceType);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [poseMatchStrength, setPoseMatchStrength] = useState(_cache.poseMatchStrength);
  const [environmentMatchStrength, setEnvironmentMatchStrength] = useState(_cache.environmentMatchStrength);
  const [poseMatchEnabled, setPoseMatchEnabled] = useState(_cache.poseMatchEnabled);
  const [environmentMatchEnabled, setEnvironmentMatchEnabled] = useState(_cache.environmentMatchEnabled);
  const [useSourceFrameReference, setUseSourceFrameReference] = useState(_cache.useSourceFrameReference);
  const [outfitTransition, setOutfitTransition] = useState(_cache.outfitTransition);
  const [availability, setAvailability] = useState(null);
  const hasLocalVideo = !!localVideoFile;

  const STRENGTH_LEVELS = ['soft', 'medium', 'strict'];
  const strengthToIndex = (value) => {
    const idx = STRENGTH_LEVELS.indexOf(value);
    return idx >= 0 ? idx : 1;
  };
  const indexToStrength = (value) => STRENGTH_LEVELS[Math.max(0, Math.min(2, Number(value) || 1))];

  useEffect(() => { _cache.reelUrl = reelUrl; }, [reelUrl]);
  useEffect(() => { _cache.charId = charId; }, [charId]);
  useEffect(() => { _cache.poseMatchStrength = poseMatchStrength; }, [poseMatchStrength]);
  useEffect(() => { _cache.environmentMatchStrength = environmentMatchStrength; }, [environmentMatchStrength]);
  useEffect(() => { _cache.poseMatchEnabled = poseMatchEnabled; }, [poseMatchEnabled]);
  useEffect(() => { _cache.environmentMatchEnabled = environmentMatchEnabled; }, [environmentMatchEnabled]);
  useEffect(() => { _cache.useSourceFrameReference = useSourceFrameReference; }, [useSourceFrameReference]);
  useEffect(() => { _cache.outfitTransition = outfitTransition; }, [outfitTransition]);
  useEffect(() => { _cache.runSourceType = runSourceType; }, [runSourceType]);
  useEffect(() => { _cache.imageModel = imageModel; }, [imageModel]);
  useEffect(() => reelPageStore.subscribe((snapshot) => {
    setResult(snapshot.result);
    setRecreationHistory(snapshot.recreationHistory);
    setQueueItems(snapshot.queueItems);
  }), []);

  const LIVE_STEPS = useMemo(() => runSourceType === 'cached'
    ? ['Reusing cached source frames', 'Analyzing scenes with Gemini', 'Recreating first frame', 'Recreating follow-up frame']
    : [
      runSourceType === 'upload' ? 'Using local uploaded video' : 'Getting reel video from Apify',
      'Extracting first and last frames',
      'Analyzing frame scenes with Gemini',
      'Recreating with selected character',
    ],
  [runSourceType]);
  const REEL_THRESHOLDS = useMemo(() => runSourceType === 'cached' ? [2, 8, 25] : [35, 45, 65], [runSourceType]);

  useEffect(() => {
    if (charId) charApi.get(charId).then(setCharDetail).catch(() => setCharDetail(null));
    else setCharDetail(null);
  }, [charId]);

  useEffect(() => {
    if (hasLocalVideo) {
      setAvailability(null);
    }
  }, [hasLocalVideo]);

  const dismissQueueItem = (queueId) => {
    reelPageStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
  };

  const activeQueueCount = queueItems.filter((job) => job.status === 'running').length;

  const handleRun = async () => {
    if (!reelUrl.trim() && !localVideoFile) { notify('Reel URL or local video is required', 'error'); return; }
    if (!charId) { notify('Select a character', 'error'); return; }
    setRunSourceType(localVideoFile ? 'upload' : 'apify');
    let queueId = null;

    try {
      if (!localVideoFile && reelUrl.trim()) {
        const check = await availabilityApi.check(reelUrl.trim());
        setAvailability(check);
        if (!check?.allowed) {
          notify(check?.label || 'Reel is not available for scraping', 'error');
          return;
        }
      }

      queueId = makePersistentJobId('reel-recreate');
      reelPageStore.setValue('queueItems', (prev) => [
        {
          id: queueId,
          kind: localVideoFile ? 'upload' : 'apify',
          status: 'running',
          label: 'Reel Recreate',
          summary: localVideoFile ? localVideoFile.name : reelUrl.trim(),
          meta: localVideoFile ? 'Local upload' : 'Instagram',
          badges: [
            charDetail?.name ? { label: charDetail.name, color: 'zinc' } : null,
            { label: imageModel, color: 'zinc' },
          ].filter(Boolean),
        },
        ...prev.slice(0, 5),
      ]);

      const activeRefIds = charDetail?.references?.filter((r) => r.isActive).map((r) => r.id) || [];
      let payload;
      if (localVideoFile) {
        payload = new FormData();
        payload.append('video', localVideoFile);
        payload.append('characterId', charId);
        if (activeRefIds.length) payload.append('activeReferenceIds', JSON.stringify(activeRefIds));
        payload.append('poseMatchStrength', poseMatchStrength);
        payload.append('environmentMatchStrength', environmentMatchStrength);
        payload.append('poseMatchEnabled', String(poseMatchEnabled));
        payload.append('environmentMatchEnabled', String(environmentMatchEnabled));
        payload.append('useSourceFrameReference', String(useSourceFrameReference));
        payload.append('outfitTransition', String(outfitTransition));
        payload.append('imageModel', imageModel);
      } else {
        payload = {
          reelUrl: reelUrl.trim(),
          characterId: charId,
          activeReferenceIds: activeRefIds.length ? activeRefIds : undefined,
          poseMatchStrength,
          environmentMatchStrength,
          poseMatchEnabled,
          environmentMatchEnabled,
          useSourceFrameReference,
          outfitTransition,
          imageModel,
        };
      }

      const data = await reelApi.recreate(payload);
      reelPageStore.setValue('result', data);
      if (data?.recreations) {
        reelPageStore.setValue('recreationHistory', (prev) => [data.recreations, ...prev].slice(0, 10));
      }
      reelPageStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
      notify('Reel frames recreated with character', 'success');
    } catch (err) {
      if (queueId) {
        reelPageStore.setValue('queueItems', (prev) => prev.map((job) => (
          job.id === queueId
            ? { ...job, status: 'error', errorMessage: err?.message || 'Failed to recreate reel' }
            : job
        )));
      }
      notify(err?.message || 'Failed to recreate reel', 'error');
    }
  };

  const handleRerunFromFrames = async () => {
    if (!result?.frames?.first?.base64Data || !result?.frames?.last?.base64Data) {
      notify('No cached source frames available', 'error');
      return;
    }
    if (!charId) {
      notify('Select a character', 'error');
      return;
    }
    setRunSourceType('cached');
    reelPageStore.setValue('result', (prev) => prev ? { ...prev, recreations: null } : prev);

    const queueId = makePersistentJobId('reel-rerun');
    reelPageStore.setValue('queueItems', (prev) => [
      {
        id: queueId,
        kind: 'cached',
        status: 'running',
        label: 'Recreate Again',
        summary: 'Using cached source frames',
        meta: 'Cached',
        badges: [
          charDetail?.name ? { label: charDetail.name, color: 'zinc' } : null,
          { label: imageModel, color: 'zinc' },
        ].filter(Boolean),
      },
      ...prev.slice(0, 5),
    ]);

    try {
      const activeRefIds = charDetail?.references?.filter((r) => r.isActive).map((r) => r.id) || [];
      const data = await reelApi.recreate({
        characterId: charId,
        activeReferenceIds: activeRefIds.length ? activeRefIds : undefined,
        poseMatchStrength,
        environmentMatchStrength,
        poseMatchEnabled,
        environmentMatchEnabled,
        useSourceFrameReference,
        outfitTransition,
        imageModel,
        sourceFrames: result.frames,
        sourceAnalysis: result.sourceAnalysis || undefined,
      });
      reelPageStore.setValue('result', data);
      if (data?.recreations) {
        reelPageStore.setValue('recreationHistory', (prev) => [data.recreations, ...prev].slice(0, 10));
      }
      reelPageStore.setValue('queueItems', (prev) => prev.filter((job) => job.id !== queueId));
      notify('Recreated again using cached source frames', 'success');
    } catch (err) {
      reelPageStore.setValue('queueItems', (prev) => prev.map((job) => (
        job.id === queueId ? { ...job, status: 'error', errorMessage: err?.message || 'Failed to rerun from cached frames' } : job
      )));
      notify(err?.message || 'Failed to rerun from cached frames', 'error');
    }
  };

  const firstFrameSrc = result?.frames?.first?.base64Data
    ? `data:${result.frames.first.mimeType || 'image/jpeg'};base64,${result.frames.first.base64Data}`
    : null;
  const lastFrameSrc = result?.frames?.last?.base64Data
    ? `data:${result.frames.last.mimeType || 'image/jpeg'};base64,${result.frames.last.base64Data}`
    : null;

  return (
    <div className="space-y-6 animate-in">
      <div>
        <div className="space-y-4">
          <Card className="space-y-4">
            <Input
              label={hasLocalVideo ? 'Instagram Reel URL (optional)' : 'Instagram Reel URL'}
              placeholder={hasLocalVideo ? 'Optional, only for your own notes/context' : 'https://www.instagram.com/reel/...'}
              value={reelUrl}
              onChange={(e) => setReelUrl(e.target.value)}
            />
            <div className="space-y-1">
              <span className="text-xs text-zinc-400 font-medium block">Or Upload Local Video</span>
              <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed px-3 py-2 text-xs transition ${localVideoFile ? 'border-blue-500/40 bg-blue-500/5 text-blue-300' : 'border-zinc-700/80 text-zinc-300 hover:border-blue-500/30 hover:text-blue-300'}`}>
                <input
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
                  className="hidden"
                  onChange={(e) => setLocalVideoFile(e.target.files?.[0] || null)}
                />
                {localVideoFile ? 'Change Local Video' : 'Choose Local Video'}
              </label>
              {localVideoFile && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px] text-zinc-500">
                    <span className="truncate pr-2">{localVideoFile.name}</span>
                    <button
                      type="button"
                      className="text-zinc-400 hover:text-red-400"
                      onClick={() => setLocalVideoFile(null)}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-[11px] text-blue-200">
                    Local upload mode active. This run will use your uploaded video directly and will not require Apify.
                  </div>
                </div>
              )}
              {!localVideoFile && (
                <div className="text-[11px] text-zinc-500">
                  Use a local video if you want to skip Instagram scraping entirely.
                </div>
              )}
            </div>

            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Character</span>
              <select
                value={charId}
                onChange={(e) => setCharId(e.target.value)}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
              >
                <option value="">Select character...</option>
                {chars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {availability && !hasLocalVideo && (
              <div className={`rounded-lg border px-3 py-2 text-xs ${
                availability.color === 'green'
                  ? 'border-green-500/40 bg-green-500/10 text-green-300'
                  : availability.color === 'yellow'
                    ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300'
                    : 'border-red-500/40 bg-red-500/10 text-red-300'
              }`}>
                {availability.label}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Badge color="blue">Locked: 2K</Badge>
              <Badge color="blue">Locked: 9:16</Badge>
            </div>

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

            <div className="space-y-1">
              <div className="flex justify-between items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-zinc-400 font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={poseMatchEnabled}
                    onChange={(e) => setPoseMatchEnabled(e.target.checked)}
                    className="h-3.5 w-3.5 accent-blue-500"
                  />
                  Pose Match Strength
                </label>
                <span className="text-[11px] uppercase tracking-wide text-zinc-500">{poseMatchStrength}</span>
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={1}
                value={strengthToIndex(poseMatchStrength)}
                onChange={(e) => setPoseMatchStrength(indexToStrength(e.target.value))}
                disabled={!poseMatchEnabled}
                className="w-full accent-blue-500"
              />
              <div className="flex justify-between text-[10px] text-zinc-500">
                <span>soft</span>
                <span>medium</span>
                <span>strict</span>
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-zinc-400 font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={environmentMatchEnabled}
                    onChange={(e) => setEnvironmentMatchEnabled(e.target.checked)}
                    className="h-3.5 w-3.5 accent-blue-500"
                  />
                  Background Match Strength
                </label>
                <span className="text-[11px] uppercase tracking-wide text-zinc-500">{environmentMatchStrength}</span>
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={1}
                value={strengthToIndex(environmentMatchStrength)}
                onChange={(e) => setEnvironmentMatchStrength(indexToStrength(e.target.value))}
                disabled={!environmentMatchEnabled}
                className="w-full accent-blue-500"
              />
              <div className="flex justify-between text-[10px] text-zinc-500">
                <span>soft</span>
                <span>medium</span>
                <span>strict</span>
              </div>
            </div>

            <label className="flex items-center justify-between rounded-lg border border-zinc-700/80 bg-zinc-900/40 px-3 py-2 cursor-pointer hover:bg-zinc-800/50 transition">
              <span className="text-xs text-zinc-300 font-medium">Use Source Frame as Direct Ref (optional)</span>
              <input
                type="checkbox"
                checked={useSourceFrameReference}
                onChange={(e) => setUseSourceFrameReference(e.target.checked)}
                className="h-4 w-4 accent-blue-500"
              />
            </label>

            <label className="flex items-center justify-between rounded-lg border border-zinc-700/80 bg-zinc-900/40 px-3 py-2 cursor-pointer hover:bg-zinc-800/50 transition">
              <div>
                <span className="text-xs text-zinc-300 font-medium block">Outfit Transition</span>
                <span className="text-[10px] text-zinc-500">Last frame uses outfit from source last frame instead of matching first</span>
              </div>
              <input
                type="checkbox"
                checked={outfitTransition}
                onChange={(e) => setOutfitTransition(e.target.checked)}
                className="h-4 w-4 accent-blue-500 shrink-0 ml-3"
              />
            </label>

            <Btn onClick={handleRun} disabled={(!reelUrl.trim() && !localVideoFile) || !charId} className="w-full">
              {activeQueueCount > 0 ? `Queue Another · ${activeQueueCount} running` : (hasLocalVideo ? 'Use Local Video + Recreate Frames' : 'Fetch + Recreate Frames')}
            </Btn>
            <Btn
              onClick={handleRerunFromFrames}
              disabled={!charId || !result?.frames?.first?.base64Data || !result?.frames?.last?.base64Data}
              variant="secondary"
              className="w-full"
            >
              {activeQueueCount > 0 ? `Queue Rerun · ${activeQueueCount} running` : 'Recreate Again (Current Frames)'}
            </Btn>
          </Card>
        </div>

      </div>
      <LightboxComponent />
    </div>
  );
}
