import { useState, useEffect, useCallback, useRef } from 'react';
import { photoMatch as photoMatchApi, characters as charApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { useStepTimer } from '../hooks/useStepTimer';
import { Card, Btn, Badge, Spinner, ImageCard, Empty, StepProgress } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { ASPECT_RATIOS, RESOLUTION_TIERS, IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL } from '../config/photoModes';
import { IconImage } from 'nucleo-glass';

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function StrengthSlider({ label, sublabel, value, onChange, color = '#6366f1' }) {
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
          className="absolute inset-x-0 w-full opacity-0 cursor-pointer h-7"
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
  aspectRatio: '4:5',
  resolutionTier: '2K',
  imageModel: DEFAULT_IMAGE_MODEL,
  result: null,
  history: [],
};

export default function PhotoMatchPage() {
  const { notify, characters: chars } = useApp();
  const { loading: generating, run: runGenerate } = useAsync();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const dropRef = useRef(null);

  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [charId, setCharId] = useState(_cache.charId);
  const [charDetail, setCharDetail] = useState(null);
  const [bgStrength, setBgStrength] = useState(_cache.bgStrength);
  const [poseStrength, setPoseStrength] = useState(_cache.poseStrength);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolutionTier, setResolutionTier] = useState(_cache.resolutionTier);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [result, setResult] = useState(_cache.result);
  const [history, setHistory] = useState(_cache.history);

  useEffect(() => { _cache.charId = charId; }, [charId]);
  useEffect(() => { _cache.bgStrength = bgStrength; }, [bgStrength]);
  useEffect(() => { _cache.poseStrength = poseStrength; }, [poseStrength]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.resolutionTier = resolutionTier; }, [resolutionTier]);
  useEffect(() => { _cache.imageModel = imageModel; }, [imageModel]);
  useEffect(() => { _cache.result = result; }, [result]);
  useEffect(() => { _cache.history = history; }, [history]);

  const { elapsedSec, stepIndex } = useStepTimer(generating, RECREATE_THRESHOLDS);

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
    setResult(null);
  }, [notify]);

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

  const handleGenerate = () => runGenerate(async () => {
    if (!file) { notify('Upload or paste an image first', 'error'); return; }
    if (!charId) { notify('Select a character', 'error'); return; }

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
      aspectRatio,
      resolutionTier,
      imageModel,
    });

    setResult(data);
    setHistory(h => [data, ...h].slice(0, 12));
    notify('Photo matched!', 'success');
  });

  return (
    <div className="space-y-6 animate-in">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">

        {/* LEFT PANEL */}
        <div className="lg:col-span-1 space-y-4">

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
            <h3 className="text-base font-medium text-zinc-200">Match Strength</h3>
            <StrengthSlider
              label="Background Match"
              sublabel="environment & lighting"
              value={bgStrength}
              onChange={setBgStrength}
              color="#3b82f6"
            />
            <StrengthSlider
              label="Pose Match"
              sublabel="body position & stance"
              value={poseStrength}
              onChange={setPoseStrength}
              color="#8b5cf6"
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

            <Btn onClick={handleGenerate} disabled={generating || !file || !charId} className="w-full">
              {generating
                ? <><Spinner size={16} /> Matching... {elapsedSec}s</>
                : <>Photo Match</>
              }
            </Btn>
          </Card>
        </div>

        {/* RIGHT PANEL */}
        <div className="lg:col-span-2 space-y-4">
          {!generating && !result && (
            <Card className="flex items-center justify-center py-24">
              <Empty
                icon={<IconImage uniqueId="empty-pm" size={40} aria-hidden />}
                title="No result yet"
                subtitle="Paste or upload a reference image, set your match strengths, choose a character and hit Photo Match"
              />
            </Card>
          )}

          {generating && (
            <StepProgress steps={RECREATE_STEPS} currentIndex={stepIndex} elapsedSec={elapsedSec} className="min-h-[360px]" />
          )}

          {result && !generating && (
            <Card className="animate-in !p-3">
              <ImageCard
                base64={result.image?.base64Data}
                mimeType={result.image?.mimeType}
                meta={{ imageId: result.imageId }}
                onSelect={() => result.image?.base64Data && openLightbox([`data:${result.image.mimeType || 'image/png'};base64,${result.image.base64Data}`], 0)}
              />
            </Card>
          )}

          {result && preview && !generating && (
            <div className="grid grid-cols-2 gap-4">
              <Card className="!p-2">
                <p className="text-xs text-zinc-500 mb-2 text-center font-medium">Reference</p>
                <img src={preview} alt="Reference" className="w-full rounded-lg object-contain max-h-80" />
                <div className="mt-2 flex gap-1.5 justify-center flex-wrap">
                  <span className="text-[10px] font-semibold rounded-full px-2 py-0.5 bg-blue-500/20 text-blue-400 border border-blue-500/30">BG {bgStrength}%</span>
                  <span className="text-[10px] font-semibold rounded-full px-2 py-0.5 bg-purple-500/20 text-purple-400 border border-purple-500/30">Pose {poseStrength}%</span>
                </div>
              </Card>
              <Card className="!p-2">
                <p className="text-xs text-zinc-500 mb-2 text-center font-medium">Generated</p>
                {result.image && (
                  <img
                    src={`data:${result.image.mimeType};base64,${result.image.base64Data}`}
                    alt="Generated"
                    className="w-full rounded-lg object-contain max-h-80 cursor-pointer"
                    onClick={() => result.image?.base64Data && openLightbox([`data:${result.image.mimeType || 'image/png'};base64,${result.image.base64Data}`], 0)}
                  />
                )}
              </Card>
            </div>
          )}

          {result?.sceneData && !generating && (
            <Card className="animate-in">
              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Detected Scene</h4>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(result.sceneData).filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} className="flex items-start gap-1.5">
                    <Badge color="zinc">{k}</Badge>
                    <span className="text-xs text-zinc-400 max-w-xs">{v}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {history.length > 1 && (
            <div>
              <h3 className="text-sm font-medium text-zinc-400 mb-3">Previous Results</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {history.slice(1, 9).filter(h => h?.image?.base64Data).map((h, i) => (
                  <ImageCard
                    key={i}
                    base64={h.image.base64Data}
                    mimeType={h.image.mimeType}
                    className="!rounded-lg"
                    onSelect={() => openLightbox(
                      history.slice(1, 9).filter(img => img?.image?.base64Data).map(img => `data:${img.image.mimeType || 'image/png'};base64,${img.image.base64Data}`),
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
