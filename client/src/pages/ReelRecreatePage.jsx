import { useEffect, useState, useMemo } from 'react';
import { characters as charApi, reel as reelApi, availability as availabilityApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { useStepTimer } from '../hooks/useStepTimer';
import { Card, Btn, Input, Badge, Spinner, ImageCard, Empty, StepProgress } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL } from '../config/photoModes';
import { IconVideo, IconCamera } from 'nucleo-glass';

// Module-level session cache — survives unmount/remount when navigating away and back
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

export default function ReelRecreatePage() {
  const { notify, characters: chars } = useApp();
  const { loading, run } = useAsync();
  const { openLightbox, LightboxComponent } = useImageLightbox();

  const [reelUrl, setReelUrl] = useState(_cache.reelUrl);
  const [localVideoFile, setLocalVideoFile] = useState(null);
  const [charId, setCharId] = useState(_cache.charId);
  const [charDetail, setCharDetail] = useState(null);
  const [result, setResult] = useState(_cache.result);
  const [recreationHistory, setRecreationHistory] = useState(_cache.recreationHistory);
  const [runSourceType, setRunSourceType] = useState(_cache.runSourceType);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [poseMatchStrength, setPoseMatchStrength] = useState(_cache.poseMatchStrength);
  const [environmentMatchStrength, setEnvironmentMatchStrength] = useState(_cache.environmentMatchStrength);
  const [poseMatchEnabled, setPoseMatchEnabled] = useState(_cache.poseMatchEnabled);
  const [environmentMatchEnabled, setEnvironmentMatchEnabled] = useState(_cache.environmentMatchEnabled);
  const [useSourceFrameReference, setUseSourceFrameReference] = useState(_cache.useSourceFrameReference);
  const [outfitTransition, setOutfitTransition] = useState(_cache.outfitTransition);
  const [availability, setAvailability] = useState(null);

  const STRENGTH_LEVELS = ['soft', 'medium', 'strict'];
  const strengthToIndex = (value) => {
    const idx = STRENGTH_LEVELS.indexOf(value);
    return idx >= 0 ? idx : 1;
  };
  const indexToStrength = (value) => STRENGTH_LEVELS[Math.max(0, Math.min(2, Number(value) || 1))];

  // ── Session cache sync ──
  useEffect(() => { _cache.reelUrl = reelUrl; }, [reelUrl]);
  useEffect(() => { _cache.charId = charId; }, [charId]);
  useEffect(() => { _cache.result = result; }, [result]);
  useEffect(() => { _cache.recreationHistory = recreationHistory; }, [recreationHistory]);
  useEffect(() => { _cache.poseMatchStrength = poseMatchStrength; }, [poseMatchStrength]);
  useEffect(() => { _cache.environmentMatchStrength = environmentMatchStrength; }, [environmentMatchStrength]);
  useEffect(() => { _cache.poseMatchEnabled = poseMatchEnabled; }, [poseMatchEnabled]);
  useEffect(() => { _cache.environmentMatchEnabled = environmentMatchEnabled; }, [environmentMatchEnabled]);
  useEffect(() => { _cache.useSourceFrameReference = useSourceFrameReference; }, [useSourceFrameReference]);
  useEffect(() => { _cache.outfitTransition = outfitTransition; }, [outfitTransition]);
  useEffect(() => { _cache.runSourceType = runSourceType; }, [runSourceType]);
  useEffect(() => { _cache.imageModel = imageModel; }, [imageModel]);

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
  const { elapsedSec, stepIndex: liveStepIndex } = useStepTimer(loading, REEL_THRESHOLDS);

  useEffect(() => {
    if (charId) charApi.get(charId).then(setCharDetail).catch(() => setCharDetail(null));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear detail when no char selected
    else setCharDetail(null);
  }, [charId]);

  const handleRun = () => run(async () => {
    if (!reelUrl.trim() && !localVideoFile) { notify('Reel URL or local video is required', 'error'); return; }
    if (!charId) { notify('Select a character', 'error'); return; }
    setRunSourceType(localVideoFile ? 'upload' : 'apify');

    if (!localVideoFile && reelUrl.trim()) {
      const check = await availabilityApi.check(reelUrl.trim());
      setAvailability(check);
      if (!check?.allowed) {
        notify(check?.label || 'Reel is not available for scraping', 'error');
        return;
      }
    }

    const activeRefIds = charDetail?.references?.filter((r) => r.isActive).map((r) => r.id) || [];
    let payload;
    if (localVideoFile) {
      payload = new FormData();
      payload.append('video', localVideoFile);
      payload.append('characterId', charId);
      if (reelUrl.trim()) payload.append('reelUrl', reelUrl.trim());
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
    setResult(data);
    if (data?.recreations) setRecreationHistory((h) => [data.recreations, ...h].slice(0, 10));
    notify('Reel frames recreated with character', 'success');
  });

  const handleRerunFromFrames = () => run(async () => {
    if (!result?.frames?.first?.base64Data || !result?.frames?.last?.base64Data) {
      notify('No cached source frames available', 'error');
      return;
    }
    if (!charId) {
      notify('Select a character', 'error');
      return;
    }

    setRunSourceType('cached');
    // Keep source frames visible but clear old recreations so the loading steps show.
    setResult((prev) => prev ? { ...prev, recreations: null } : prev);

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
    setResult(data);
    if (data?.recreations) setRecreationHistory((h) => [data.recreations, ...h].slice(0, 10));
    notify('Recreated again using cached source frames', 'success');
  });

  const firstFrameSrc = result?.frames?.first?.base64Data
    ? `data:${result.frames.first.mimeType || 'image/jpeg'};base64,${result.frames.first.base64Data}`
    : null;
  const lastFrameSrc = result?.frames?.last?.base64Data
    ? `data:${result.frames.last.mimeType || 'image/jpeg'};base64,${result.frames.last.base64Data}`
    : null;

  return (
    <div className="space-y-6 animate-in">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
        <div className="lg:col-span-1 space-y-4">
          <Card className="space-y-4">
            <Input
              label="Instagram Reel URL"
              placeholder="https://www.instagram.com/reel/..."
              value={reelUrl}
              onChange={(e) => setReelUrl(e.target.value)}
            />
            <div className="space-y-1">
              <span className="text-xs text-zinc-400 font-medium block">Or Upload Local Video</span>
              <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed px-3 py-2 text-xs transition ${localVideoFile ? 'border-blue-500/40 bg-blue-500/5 text-blue-300' : 'border-zinc-700/80 text-zinc-300 hover:border-blue-500/30 hover:text-blue-300'}`}>
                <span className="flex items-center justify-center [--nc-gradient-1-color-1:currentColor] [--nc-gradient-1-color-2:currentColor]">
                  {localVideoFile ? <IconCamera uniqueId="reel-local-video-camera" size={18} aria-hidden /> : <IconVideo uniqueId="reel-local-video-upload" size={18} aria-hidden />}
                </span>
                <input
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
                  className="hidden"
                  onChange={(e) => setLocalVideoFile(e.target.files?.[0] || null)}
                />
                {localVideoFile ? 'Change Local Video' : 'Choose Local Video'}
              </label>
              {localVideoFile && (
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

            {availability && (
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

            <Btn onClick={handleRun} disabled={loading || (!reelUrl.trim() && !localVideoFile) || !charId} className="w-full">
              {loading ? <><Spinner size={16} /> Processing... {elapsedSec}s</> : 'Fetch + Recreate Frames'}
            </Btn>
            <Btn
              onClick={handleRerunFromFrames}
              disabled={loading || !charId || !result?.frames?.first?.base64Data || !result?.frames?.last?.base64Data}
              variant="secondary"
              className="w-full"
            >
              Recreate Again (Current Frames)
            </Btn>
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {!loading && !result && (
            <Card className="min-h-[360px] flex items-center justify-center">
              <Empty icon={<IconVideo uniqueId="empty-reel" size={40} aria-hidden />} title="No reel processed yet" subtitle="Paste a reel URL and run recreation" />
            </Card>
          )}

          {result && (
            <Card className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-300">Source Frames (from Reel)</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-zinc-500 mb-2">First Frame</p>
                  {firstFrameSrc ? (
                    <img src={firstFrameSrc} alt="First frame" className="w-full rounded-lg cursor-pointer" onClick={() => openLightbox([firstFrameSrc], 0)} />
                  ) : <div className="rounded-lg border border-zinc-700/80 p-4 text-xs text-zinc-500">Unavailable</div>}
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-2">Last Frame</p>
                  {lastFrameSrc ? (
                    <img src={lastFrameSrc} alt="Last frame" className="w-full rounded-lg cursor-pointer" onClick={() => openLightbox([lastFrameSrc], 0)} />
                  ) : <div className="rounded-lg border border-zinc-700/80 p-4 text-xs text-zinc-500">Unavailable</div>}
                </div>
              </div>
            </Card>
          )}

          {loading && (
            <StepProgress steps={LIVE_STEPS} currentIndex={liveStepIndex} elapsedSec={elapsedSec} className="min-h-[360px]" />
          )}

          {!loading && result?.recreations && (
            <Card className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-300">Recreated with Character</h3>
              <div className="grid grid-cols-2 gap-3">
                <ImageCard
                  base64={result?.recreations?.first?.image?.base64Data}
                  mimeType={result?.recreations?.first?.image?.mimeType}
                  onSelect={() => {
                    const base64 = result?.recreations?.first?.image?.base64Data;
                    const mime = result?.recreations?.first?.image?.mimeType || 'image/png';
                    if (base64) openLightbox([`data:${mime};base64,${base64}`], 0);
                  }}
                />
                <ImageCard
                  base64={result?.recreations?.last?.image?.base64Data}
                  mimeType={result?.recreations?.last?.image?.mimeType}
                  onSelect={() => {
                    const base64 = result?.recreations?.last?.image?.base64Data;
                    const mime = result?.recreations?.last?.image?.mimeType || 'image/png';
                    if (base64) openLightbox([`data:${mime};base64,${base64}`], 0);
                  }}
                />
              </div>

              {(result.recreations.first?.prompt || result.recreations.last?.prompt) && (
                <details className="group">
                  <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-300 transition select-none">
                    Show Gemini Prompts
                  </summary>
                  <div className="mt-2 space-y-3">
                    {result.recreations.first?.prompt && (
                      <div>
                        <p className="text-[11px] font-medium text-zinc-400 mb-1">First Frame Prompt</p>
                        <pre className="text-[10px] text-zinc-500 bg-zinc-900/80 border border-zinc-800 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">{result.recreations.first.prompt}</pre>
                      </div>
                    )}
                    {result.recreations.last?.prompt && (
                      <div>
                        <p className="text-[11px] font-medium text-zinc-400 mb-1">Last Frame Prompt</p>
                        <pre className="text-[10px] text-zinc-500 bg-zinc-900/80 border border-zinc-800 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">{result.recreations.last.prompt}</pre>
                      </div>
                    )}
                  </div>
                </details>
              )}
            </Card>
          )}

          {recreationHistory.length > 1 && (
            <div>
              <h3 className="text-sm font-medium text-zinc-400 mb-3">Previous Recreations</h3>
              <div className="space-y-3">
                {recreationHistory.slice(1, 6).map((rec, i) => (
                  <div key={i} className="grid grid-cols-2 gap-3">
                    <ImageCard
                      base64={rec?.first?.image?.base64Data}
                      mimeType={rec?.first?.image?.mimeType}
                      className="!rounded-lg"
                      onSelect={() => {
                        const b = rec?.first?.image?.base64Data;
                        const m = rec?.first?.image?.mimeType || 'image/png';
                        if (b) openLightbox([`data:${m};base64,${b}`], 0);
                      }}
                    />
                    <ImageCard
                      base64={rec?.last?.image?.base64Data}
                      mimeType={rec?.last?.image?.mimeType}
                      className="!rounded-lg"
                      onSelect={() => {
                        const b = rec?.last?.image?.base64Data;
                        const m = rec?.last?.image?.mimeType || 'image/png';
                        if (b) openLightbox([`data:${m};base64,${b}`], 0);
                      }}
                    />
                  </div>
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
