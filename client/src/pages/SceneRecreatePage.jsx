import { useState, useEffect, useMemo, useCallback } from 'react';
import { scene as sceneApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { useStepTimer } from '../hooks/useStepTimer';
import { Card, Btn, Textarea, Badge, Spinner, ImageCard, Empty, StepProgress } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { ASPECT_RATIOS, RESOLUTION_TIERS, IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL } from '../config/photoModes';
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

export default function SceneRecreatePage() {
  const { notify, characters: chars } = useApp();
  const { loading: analyzing, run: runAnalyze } = useAsync();
  const { loading: recreating, run: runRecreate } = useAsync();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [sceneData, setSceneData] = useState(_cache.sceneData);
  const [editableScene, setEditableScene] = useState(_cache.editableScene);
  const [charId, setCharId] = useState(_cache.charId);
  const [charDetail, setCharDetail] = useState(null);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolutionTier, setResolutionTier] = useState(_cache.resolutionTier);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [sameBackground, setSameBackground] = useState(_cache.sameBackground);
  const [samePose, setSamePose] = useState(_cache.samePose);
  const [result, setResult] = useState(_cache.result);
  const [history, setHistory] = useState(_cache.history);

  useEffect(() => { _cache.sceneData = sceneData; }, [sceneData]);
  useEffect(() => { _cache.editableScene = editableScene; }, [editableScene]);
  useEffect(() => { _cache.charId = charId; }, [charId]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolutionTier = resolutionTier; }, [resolutionTier]);
  useEffect(() => { _cache.imageModel = imageModel; }, [imageModel]);
  useEffect(() => { _cache.sameBackground = sameBackground; }, [sameBackground]);
  useEffect(() => { _cache.samePose = samePose; }, [samePose]);
  useEffect(() => { _cache.result = result; }, [result]);
  useEffect(() => { _cache.history = history; }, [history]);

  const ANALYZE_THRESHOLDS = useMemo(() => [2, 5], []);
  const RECREATE_STEPS = useMemo(() => [
    'Analyzing scene with Gemini',
    'Building identity-locked prompt',
    'Generating recreated image',
  ], []);
  const RECREATE_THRESHOLDS = useMemo(() => [3, 8], []);
  const { elapsedSec: analyzeElapsedSec } = useStepTimer(analyzing, ANALYZE_THRESHOLDS);
  const { elapsedSec: recreateElapsedSec, stepIndex: recreateStepIndex } = useStepTimer(recreating, RECREATE_THRESHOLDS);

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
      setSceneData(null);
      setEditableScene('');
      setResult(null);
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

  const handlePasteFromClipboard = () => runAnalyze(async () => {
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
  });

  const handleAnalyze = () => runAnalyze(async () => {
    if (!file) { notify('Upload an image first', 'error'); return; }
    const dataUri = await fileToBase64(file);
    const base64 = dataUri.split(',')[1];
    const data = await sceneApi.analyze(base64, file.type);
    setSceneData(data);
    const text = Object.entries(data).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
    setEditableScene(text);
    notify('Scene analyzed!', 'success');
  });

  const handleRecreate = () => runRecreate(async () => {
    if (!sceneData) { notify('Analyze a scene first', 'error'); return; }
    if (!charId) { notify('Select a character', 'error'); return; }

    const parsed = {};
    editableScene.split('\n').forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > 0) parsed[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });

    const activeRefIds = charDetail?.references?.filter((r) => r.isActive).map((r) => r.id) || [];

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
    setResult(data);
    setHistory((h) => [data, ...h].slice(0, 10));
    notify('Scene recreated!', 'success');
  });

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
              <Btn variant="secondary" onClick={handlePasteFromClipboard} disabled={analyzing} className="flex-1">
                Paste
              </Btn>
              <Btn onClick={handleAnalyze} disabled={analyzing || !file} className="flex-1">
              {analyzing ? <><Spinner size={16} /> Analyzing... {analyzeElapsedSec}s</> : <>Analyze Scene</>}
              </Btn>
            </div>
          </Card>

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
              <Textarea label="Edit Scene Description (optional)" value={editableScene} onChange={(e) => setEditableScene(e.target.value)} className="!min-h-[80px] !text-xs" />
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

              <Btn onClick={handleRecreate} disabled={recreating || !charId} className="w-full">
                {recreating ? <><Spinner size={16} /> Recreating... {recreateElapsedSec}s</> : <>Recreate Scene</>}
              </Btn>
            </Card>
          )}
        </div>

        <div className="lg:col-span-2 space-y-4">
          {!recreating && !result && (
            <Card className="flex items-center justify-center py-24">
              <Empty icon={<IconCamera uniqueId="empty-scene" size={40} aria-hidden />} title="No recreation yet" subtitle="Upload an image, analyze its scene, then recreate with a character" />
            </Card>
          )}

          {recreating && (
            <StepProgress steps={RECREATE_STEPS} currentIndex={recreateStepIndex} elapsedSec={recreateElapsedSec} className="min-h-[360px]" />
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
