import { useState, useEffect, useReducer, useRef } from 'react';
import { batch as batchApi, characters as charApi, gallery as galleryApi, templates as templatesApi } from '../services/api';
// characters, sceneMemories, outfits come from AppContext (fetched once on app load)
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { useBatchProgress } from '../hooks/useBatchProgress';
import { Card, Btn, Textarea, Input, Slider, Toggle, Spinner, ImageCard, ProgressBar, Badge, Section, Hint, ConfirmDialog } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import {
  RESOLUTION_TIERS, ASPECT_RATIOS_COMPACT as ASPECT_RATIOS,
  CAMERA_PROFILES, POSE_MODES, EXPRESSION_MODES, SCENE_MODES,
} from '../config/photoModes';

const INITIAL_STATE = {
  mode: 'variation',
  aspectRatio: '4:5',
  resolutionTier: '2K',
  prompt: '',
  count: 4,
  randomSeed: true,
  tempMin: 0.7,
  tempMax: 1.3,
  multiPrompts: '',
  charId: '',
  charDetail: null,
  overrideSets: [{ referenceIds: [] }],
  selectedImageId: null,
  editPrompt: '',
  characterId: null,
  editCharacterDetail: null,
  editGalleryImages: [],
  editUploadImages: [],
  loadingEditGallery: false,
  useSpecificReferences: false,
  specificOutfitRef: null,
  specificItemRef: null,
  specificSceneRef: null,
  sceneMemoryId: '',
  outfitId: '',
  cameraProfileId: '',
  poseMode: 'none',
  useExpressionMode: false,
  expressionMode: 'none',
  useSceneMode: false,
  sceneMode: 'none',
  jobId: null,
  elapsedSec: 0,
  contentMixCount: 10,
  contentMixDist: { lifestyle: 40, personality: 30, teasing: 20, engagement: 10 },
  contentMixThemes: { lifestyle: '', personality: '', teasing: '', engagement: '' },
};

function formReducer(state, action) {
  if (typeof action === 'function') return { ...state, ...action(state) };
  return { ...state, ...action };
}

export default function BatchPage() {
  const { notify, characters: chars, sceneMemories, outfits } = useApp();
  const { loading, run } = useAsync();
  const busyRef = useRef(false);
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const [state, update] = useReducer(formReducer, INITIAL_STATE);
  const {
    mode, aspectRatio, resolutionTier, prompt, count, randomSeed, tempMin, tempMax,
    multiPrompts, charId, charDetail, overrideSets,
    selectedImageId, editPrompt, characterId, editCharacterDetail,
    editGalleryImages, editUploadImages, loadingEditGallery,
    useSpecificReferences, specificOutfitRef, specificItemRef, specificSceneRef,
    sceneMemoryId, outfitId, cameraProfileId, poseMode,
    useExpressionMode, expressionMode, useSceneMode, sceneMode,
    jobId, elapsedSec,
  } = state;

  const { job, setJob, subscribe, cleanup: cleanupProgress } = useBatchProgress();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  // Templates
  const [tplList, setTplList] = useState([]);
  const [tplName, setTplName] = useState('');
  const [showSaveTpl, setShowSaveTpl] = useState(false);

  useEffect(() => { templatesApi.list('batch').then(setTplList).catch(() => {}); }, []);

  const getSaveableConfig = () => {
    const { charDetail, editCharacterDetail, editGalleryImages, editUploadImages, loadingEditGallery,
      selectedImageId, specificOutfitRef, specificItemRef, specificSceneRef, jobId, elapsedSec, ...saveable } = state;
    return saveable;
  };

  const handleSaveTemplate = async () => {
    if (!tplName.trim()) { notify('Enter a template name', 'error'); return; }
    try {
      const created = await templatesApi.create({ name: tplName.trim(), page: 'batch', config: getSaveableConfig() });
      setTplList((prev) => [created, ...prev]);
      setTplName('');
      setShowSaveTpl(false);
      notify('Template saved', 'success');
    } catch (err) { notify(err.message || 'Failed to save template', 'error'); }
  };

  const handleLoadTemplate = (t) => {
    update({ ...INITIAL_STATE, ...t.config });
    notify(`Loaded "${t.name}"`, 'info');
  };

  const handleDeleteTemplate = async (id) => {
    try {
      await templatesApi.remove(id);
      setTplList((prev) => prev.filter((t) => t.id !== id));
      notify('Template deleted', 'success');
    } catch (err) { notify(err.message || 'Failed to delete template', 'error'); }
  };

  // Job history
  const [jobHistory, setJobHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [expandedJobId, setExpandedJobId] = useState(null);

  const fetchHistory = async () => {
    setHistoryLoading(true);
    try { setJobHistory(await batchApi.list()); } catch { /* ignore */ }
    setHistoryLoading(false);
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch
  useEffect(() => { fetchHistory(); }, []);

  // Refresh history when current job completes
  // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh history on job completion
  useEffect(() => {
    if (job && (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')) {
      fetchHistory();
    }
  }, [job?.status]);

  const handleRerun = (historyJob) => {
    if (!historyJob.config) { notify('No config saved for this job', 'error'); return; }
    update({ ...INITIAL_STATE, ...historyJob.config, mode: historyJob.mode || 'variation' });
    notify('Config loaded from history', 'info');
  };

  useEffect(() => {
    if (charId) charApi.get(charId).then((d) => update({ charDetail: d })).catch(() => update({ charDetail: null }));
    else update({ charDetail: null });
  }, [charId]);
  useEffect(() => {
    if (characterId) charApi.get(characterId).then((d) => update({ editCharacterDetail: d })).catch(() => update({ editCharacterDetail: null }));
    else update({ editCharacterDetail: null });
  }, [characterId]);
  useEffect(() => {
    let cancelled = false;
    const loadEditGallery = async () => {
      if (mode !== 'edit') return;
      update({ loadingEditGallery: true });
      try {
        const list = await galleryApi.list();
        if (!cancelled) update({ editGalleryImages: list || [] });
      } catch {
        if (!cancelled) update({ editGalleryImages: [] });
      } finally {
        if (!cancelled) update({ loadingEditGallery: false });
      }
    };
    loadEditGallery();
    return () => { cancelled = true; };
  }, [mode]);

  const handleEditUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const src = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const tempId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const uploaded = { id: tempId, src, prompt: file.name, source: 'upload' };
      update((prev) => ({ editUploadImages: [uploaded, ...prev.editUploadImages], selectedImageId: tempId }));
    } catch {
      notify('Failed to read file', 'error');
    } finally {
      event.target.value = '';
    }
  };

  const handleSpecificReferenceUpload = async (event, refType) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const next = {
        image: dataUrl,
        mimeType: file.type,
        name: file.name,
        note: file.name.replace(/\.[^/.]+$/, ''),
      };
      if (refType === 'outfit') update({ specificOutfitRef: next });
      if (refType === 'item') update({ specificItemRef: next });
      if (refType === 'scene') update({ specificSceneRef: next });
    } catch {
      notify('Failed to read specific reference image', 'error');
    } finally {
      event.target.value = '';
    }
  };

  const startBatch = () => {
    if (busyRef.current) return;
    busyRef.current = true;
    run(async () => {
    let config;
    if (mode === 'variation') {
      if (!prompt.trim()) { notify('Prompt required', 'error'); return; }
      config = { prompt: prompt.trim(), count, randomizeSeed: randomSeed, temperatureRange: { min: tempMin, max: tempMax } };
      if (charId) { config.characterId = charId; config.activeReferenceIds = charDetail?.references?.filter((r) => r.isActive).map((r) => r.id) || []; }
    } else if (mode === 'multi') {
      const lines = multiPrompts.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) { notify('Enter at least one prompt', 'error'); return; }
      config = { prompts: lines };
    } else if (mode === 'override') {
      if (!charId) { notify('Select a character', 'error'); return; }
      config = { characterId: charId, overrideSets, prompt: prompt.trim() };
    } else if (mode === 'edit') {
      if (!selectedImageId) { notify('Select an image to edit', 'error'); return; }
      if (!editPrompt.trim()) { notify('Modification prompt required', 'error'); return; }
      config = {
        imageId: selectedImageId,
        modificationPrompt: editPrompt.trim(),
        count,
        characterId: characterId || undefined,
        activeReferenceIds: editCharacterDetail?.references?.filter((r) => r.isActive).map((r) => r.id) || undefined,
      };
      if (useSpecificReferences) {
        const typedRefs = [
          specificOutfitRef
            ? { ...specificOutfitRef, referenceType: 'outfit', note: specificOutfitRef.note || 'Outfit reference' }
            : null,
          specificItemRef
            ? { ...specificItemRef, referenceType: 'item', note: specificItemRef.note || 'Item reference' }
            : null,
          specificSceneRef
            ? { ...specificSceneRef, referenceType: 'scene', note: specificSceneRef.note || 'Background/scene reference' }
            : null,
        ].filter(Boolean);
        if (typedRefs.length > 0) {
          config.customReferenceImages = typedRefs.map((ref) => ({
            image: ref.image,
            mimeType: ref.mimeType,
            name: ref.name,
            referenceType: ref.referenceType,
            note: ref.note || '',
          }));
        }
      }
    } else if (mode === 'content-mix') {
      const total = Object.values(state.contentMixDist).reduce((a, b) => a + b, 0);
      if (total !== 100) { notify('Distribution must sum to 100%', 'error'); return; }
      config = {
        totalCount: state.contentMixCount,
        distribution: state.contentMixDist,
        baseThemes: Object.fromEntries(Object.entries(state.contentMixThemes).filter(([, v]) => v.trim())),
      };
      if (charId) {
        config.characterId = charId;
        config.activeReferenceIds = charDetail?.references?.filter((r) => r.isActive).map((r) => r.id) || [];
      }
    }
    config.sceneMemoryId = sceneMemoryId || null;
    config.outfitId = outfitId || null;
    config.cameraProfileId = cameraProfileId || null;
    config.poseMode = poseMode;
    config.autoPose = poseMode === 'auto';
    config.expressionMode = useExpressionMode ? expressionMode : 'none';
    config.sceneMode = useSceneMode ? sceneMode : 'none';
    const data = await batchApi.start({ mode, config, aspectRatio, resolutionTier });
    update({ jobId: data.jobId });
    setJob(data);
    subscribe(data.jobId);
    notify('Batch started', 'success');
  }).finally(() => { busyRef.current = false; });
  };

  const cancelBatch = () => run(async () => {
    if (!jobId) return;
    const data = await batchApi.cancel(jobId);
    setJob(data);
    cleanupProgress();
    notify('Batch cancelled', 'info');
  });

  const isRunning = job?.status === 'running';
  const completed = (job?.completed || 0) + (job?.failed || 0);
  const successfulResults = (job?.results || []).filter((r) => r?.success && r?.image?.base64Data);
  const jobImageUrls = successfulResults.map((r) => `data:${r.image?.mimeType || 'image/png'};base64,${r.image?.base64Data}`);

  useEffect(() => {
    if (!isRunning) {
      update({ elapsedSec: 0 });
      return undefined;
    }
    const started = Date.now();
    const tick = () => update({ elapsedSec: Math.floor((Date.now() - started) / 1000) });
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  const toggleOverrideRef = (setIdx, refId) => {
    update((prev) => ({
      overrideSets: prev.overrideSets.map((s, i) => {
        if (i !== setIdx) return s;
        const ids = s.referenceIds.includes(refId) ? s.referenceIds.filter((r) => r !== refId) : [...s.referenceIds, refId];
        return { referenceIds: ids };
      }),
    }));
  };

  return (
    <div className="space-y-6 animate-in">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-gradient">Batch Generation</h1>
        <p className="text-zinc-500 text-sm mt-1">Generate multiple images in parallel. Model: Nano Banana Pro.</p>
      </div>

      <Card className="space-y-5">
        <div>
          <span className="text-sm text-zinc-400 font-medium mb-2 flex items-center gap-1.5">Mode <Hint text="Variation: same prompt, multiple outputs. Multi-Prompt: different prompt per image. Override: same scene, different references. Edit: modify an existing image." /></span>
          <div className="flex flex-wrap gap-2">
            {[['variation', 'Variation'], ['multi', 'Multi-Prompt'], ['override', 'Override Iter.'], ['edit', 'Edit Image'], ['content-mix', 'Content Mix']].map(([m, label]) => (
              <button key={m} onClick={() => update({ mode: m })}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition cursor-pointer ${mode === m ? 'bg-blue-600 text-white' : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className="text-xs text-zinc-400 font-medium block mb-2">Resolution</span>
            <div className="flex flex-wrap gap-2">
              {RESOLUTION_TIERS.map((tier) => (
                <button
                  key={tier}
                  onClick={() => update({ resolutionTier: tier })}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${resolutionTier === tier ? 'bg-blue-500 text-white' : 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600'}`}
                >
                  {tier}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="text-xs text-zinc-400 font-medium block mb-2">Aspect Ratio</span>
            <div className="flex flex-wrap gap-1.5">
              {ASPECT_RATIOS.map((ar) => (
                <button
                  key={ar}
                  onClick={() => update({ aspectRatio: ar })}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition cursor-pointer ${aspectRatio === ar ? 'bg-blue-600 text-white' : 'bg-zinc-700/60 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200'}`}
                >
                  {ar}
                </button>
              ))}
            </div>
          </div>
        </div>

        <Section title="Camera, Pose & Scene" hint="Control how images are shot — camera angle, body pose, facial expression, and environment.">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <span className="text-xs text-zinc-400 font-medium mb-1.5 flex items-center gap-1.5">Scene Memory <Hint text="Saved lighting & environment settings applied for consistent scenes across generations." /></span>
              <select value={sceneMemoryId} onChange={(e) => update({ sceneMemoryId: e.target.value })}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
                <option value="">None</option>
                {sceneMemories.map((scene) => <option key={scene.id} value={scene.id}>{scene.name}</option>)}
              </select>
            </div>
            <div>
              <span className="text-xs text-zinc-400 font-medium mb-1.5 flex items-center gap-1.5">Outfit Lock <Hint text="Forces a specific saved outfit on the character, overriding any outfit in the prompt." /></span>
              <select value={outfitId} onChange={(e) => update({ outfitId: e.target.value })}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
                <option value="">None</option>
                {outfits.map((outfit) => <option key={outfit.id} value={outfit.id}>{outfit.name}</option>)}
              </select>
            </div>
            <div>
              <span className="text-xs text-zinc-400 font-medium mb-1.5 flex items-center gap-1.5">Camera Profile <Hint text="Simulates a camera style — selfie, cinematic, flash, etc. Changes how the photo feels." /></span>
              <select value={cameraProfileId} onChange={(e) => update({ cameraProfileId: e.target.value })}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
                <option value="">None</option>
                {CAMERA_PROFILES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <span className="text-xs text-zinc-400 font-medium mb-1.5 flex items-center gap-1.5">Pose Mode <Hint text="Controls body positioning. 'Auto Rotate' picks a different pose each generation." /></span>
              <select value={poseMode} onChange={(e) => update({ poseMode: e.target.value })}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
                {POSE_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Toggle checked={useExpressionMode} onChange={(v) => update({ useExpressionMode: v })} label="Expression Lock" />
                <Hint text="Forces a specific facial expression on the character instead of letting AI choose." />
              </div>
              <select value={expressionMode} onChange={(e) => update({ expressionMode: e.target.value })}
                disabled={!useExpressionMode}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
                {EXPRESSION_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Toggle checked={useSceneMode} onChange={(v) => update({ useSceneMode: v })} label="Scene Mode" />
                <Hint text="Adds a preset environment/background like beach, rooftop, or cafe." />
              </div>
              <select value={sceneMode} onChange={(e) => update({ sceneMode: e.target.value })}
                disabled={!useSceneMode}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
                {SCENE_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
          </div>
        </Section>

        {(mode === 'variation' || mode === 'override') && (
          <div>
            <span className="text-xs text-zinc-400 font-medium block mb-1.5">Character (optional for variation)</span>
            <select value={charId} onChange={(e) => update({ charId: e.target.value })}
              className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
              <option value="">{mode === 'override' ? 'Select character...' : 'No character'}</option>
              {chars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {charId && charDetail?.references?.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {charDetail.references.map((r) => (
                  <Badge key={r.id} color={r.isActive ? 'blue' : 'zinc'}>{r.category} {r.isActive ? '✓' : ''}</Badge>
                ))}
              </div>
            )}
          </div>
        )}

        {mode === 'variation' && (
          <>
            <Textarea label="Base Prompt" placeholder="Same prompt, multiple variations..." value={prompt} onChange={(e) => update({ prompt: e.target.value })} />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <Input label="Count" type="number" min={1} max={20} value={count} onChange={(e) => update({ count: Math.min(20, Math.max(1, +e.target.value)) })} />
              <div>
                <Slider label="Temp Min" value={tempMin} onChange={(v) => update({ tempMin: v })} min={0} max={2} step={0.05} />
                <span className="text-[10px] text-zinc-600 mt-0.5 block">Lower = more consistent</span>
              </div>
              <div>
                <Slider label="Temp Max" value={tempMax} onChange={(v) => update({ tempMax: v })} min={0} max={2} step={0.05} />
                <span className="text-[10px] text-zinc-600 mt-0.5 block">Higher = more creative</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Toggle checked={randomSeed} onChange={(v) => update({ randomSeed: v })} label="Randomize seed per image" />
              <Hint text="Each image gets a unique random seed for maximum variety between outputs." />
            </div>
          </>
        )}

        {mode === 'multi' && (
          <Textarea label="Prompts (one per line)" placeholder={"A sunset over the ocean\nA cat in a garden\nA futuristic cityscape"} value={multiPrompts} onChange={(e) => update({ multiPrompts: e.target.value })} className="!min-h-[140px]" />
        )}

        {mode === 'override' && (
          <>
            <Textarea label="Scene Prompt" placeholder="The scene for all variations..." value={prompt} onChange={(e) => update({ prompt: e.target.value })} />
            {charDetail?.references?.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-400 font-medium">Override Sets ({overrideSets.length})</span>
                  <Btn variant="ghost" className="!text-xs !py-1" onClick={() => update((p) => ({ overrideSets: [...p.overrideSets, { referenceIds: [] }] }))}>+ Add Set</Btn>
                </div>
                {overrideSets.map((set, si) => (
                  <div key={si} className="rounded-lg border border-zinc-700/50 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-zinc-500">Set {si + 1}</span>
                      {overrideSets.length > 1 && (
                        <button className="text-xs text-zinc-600 hover:text-red-400 cursor-pointer" onClick={() => update((p) => ({ overrideSets: p.overrideSets.filter((_, i) => i !== si) }))}>Remove</button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {charDetail.references.map((r) => (
                        <button key={r.id} onClick={() => toggleOverrideRef(si, r.id)}
                          className={`text-xs rounded-md px-2 py-1 transition cursor-pointer ${set.referenceIds.includes(r.id) ? 'bg-blue-600 text-white' : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600'}`}>
                          {r.category}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {mode === 'edit' && (
          <>
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Select Image to Edit</span>
              {loadingEditGallery ? (
                <div className="py-8 text-center text-sm text-zinc-500">Loading gallery images...</div>
              ) : (
                <div className="grid [grid-template-columns:repeat(auto-fill,minmax(120px,1fr))] gap-3 max-h-[300px] overflow-y-auto pr-1 rounded-xl border border-zinc-800 bg-[#111] p-3">
                  <label className="group relative flex aspect-square cursor-pointer items-center justify-center rounded-xl border border-dashed border-zinc-700/80 bg-zinc-900/70 text-zinc-400 transition hover:border-blue-500/70 hover:bg-zinc-800/80 hover:text-zinc-200">
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={handleEditUpload}
                    />
                    <div className="text-center">
                      <div className="text-2xl leading-none">+</div>
                      <div className="mt-1 text-xs">Upload Image</div>
                    </div>
                  </label>
                  {[...editUploadImages, ...editGalleryImages].map((img) => {
                    const isSelected = selectedImageId === img.id;
                    const src = img.src || `/api/gallery/${img.id}/image`;
                    return (
                      <button
                        key={img.id}
                        type="button"
                        onClick={() => update({ selectedImageId: img.id })}
                        className={`group relative aspect-square overflow-hidden rounded-xl border bg-zinc-900 transition duration-200 hover:scale-[1.02] hover:shadow-[0_0_24px_rgba(59,130,246,0.2)] ${isSelected ? 'border-2 border-blue-500 shadow-[0_0_18px_rgba(59,130,246,0.35)]' : 'border-zinc-800'}`}
                      >
                        <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Character (optional)</span>
              <select value={characterId || ''} onChange={(e) => update({ characterId: e.target.value || null })}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
                <option value="">No character</option>
                {chars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {characterId && editCharacterDetail?.references?.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {editCharacterDetail.references.map((r) => (
                    <Badge key={r.id} color={r.isActive ? 'blue' : 'zinc'}>{r.category}</Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Toggle checked={useSpecificReferences} onChange={(v) => update({ useSpecificReferences: v })} label="Use Specific Image References" />
              {useSpecificReferences && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <label className="flex items-center justify-between border border-dashed border-zinc-700/80 rounded-lg cursor-pointer hover:border-zinc-500 transition h-16 overflow-hidden bg-zinc-900/50 px-3">
                    <div className="text-left">
                      <div className="text-zinc-300 text-sm">Outfit Ref</div>
                      <div className="text-zinc-500 text-xs">Clothing/style source</div>
                    </div>
                    {specificOutfitRef?.image && <img src={specificOutfitRef.image} alt="" className="h-10 w-10 rounded object-cover border border-zinc-700/80" />}
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => handleSpecificReferenceUpload(e, 'outfit')} />
                  </label>
                  <label className="flex items-center justify-between border border-dashed border-zinc-700/80 rounded-lg cursor-pointer hover:border-zinc-500 transition h-16 overflow-hidden bg-zinc-900/50 px-3">
                    <div className="text-left">
                      <div className="text-zinc-300 text-sm">Item Ref</div>
                      <div className="text-zinc-500 text-xs">Props/accessories/details</div>
                    </div>
                    {specificItemRef?.image && <img src={specificItemRef.image} alt="" className="h-10 w-10 rounded object-cover border border-zinc-700/80" />}
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => handleSpecificReferenceUpload(e, 'item')} />
                  </label>
                  <label className="flex items-center justify-between border border-dashed border-zinc-700/80 rounded-lg cursor-pointer hover:border-zinc-500 transition h-16 overflow-hidden bg-zinc-900/50 px-3">
                    <div className="text-left">
                      <div className="text-zinc-300 text-sm">Background/Scene Ref</div>
                      <div className="text-zinc-500 text-xs">Location/composition source</div>
                    </div>
                    {specificSceneRef?.image && <img src={specificSceneRef.image} alt="" className="h-10 w-10 rounded object-cover border border-zinc-700/80" />}
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => handleSpecificReferenceUpload(e, 'scene')} />
                  </label>
                </div>
              )}
              {useSpecificReferences && (
                <div className="flex gap-2">
                  <button type="button" onClick={() => update({ specificOutfitRef: null })} className="text-xs text-zinc-500 hover:text-zinc-200 cursor-pointer">Clear Outfit</button>
                  <button type="button" onClick={() => update({ specificItemRef: null })} className="text-xs text-zinc-500 hover:text-zinc-200 cursor-pointer">Clear Item</button>
                  <button type="button" onClick={() => update({ specificSceneRef: null })} className="text-xs text-zinc-500 hover:text-zinc-200 cursor-pointer">Clear Scene</button>
                </div>
              )}
            </div>

            <Textarea label="Modification Prompt" placeholder="What to change: make it nighttime, add rain..." value={editPrompt} onChange={(e) => update({ editPrompt: e.target.value })} />
            <Input label="Variations" type="number" min={1} max={10} value={count} onChange={(e) => update({ count: Math.min(10, Math.max(1, +e.target.value)) })} />
          </>
        )}

        {/* Content Mix mode */}
        {mode === 'content-mix' && (
          <>
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Character (optional)</span>
              <select value={charId} onChange={(e) => { update({ charId: e.target.value, charDetail: null }); if (e.target.value) charApi.get(e.target.value).then(d => update({ charDetail: d })).catch(() => {}); }}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
                <option value="">No character</option>
                {chars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            <Input label="Total Images" type="number" min={4} max={20} value={state.contentMixCount}
              onChange={(e) => update({ contentMixCount: Math.min(20, Math.max(4, +e.target.value)) })} />

            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-2">Category Distribution</span>
              <div className="space-y-2.5">
                {[
                  { key: 'lifestyle', label: 'Lifestyle', pct: '40%' },
                  { key: 'personality', label: 'Personality', pct: '30%' },
                  { key: 'teasing', label: 'Teasing', pct: '20%' },
                  { key: 'engagement', label: 'Engagement', pct: '10%' },
                ].map(cat => {
                  const pct = state.contentMixDist[cat.key];
                  const computed = Math.round(state.contentMixCount * pct / 100);
                  return (
                    <div key={cat.key} className="flex items-center gap-3">
                      <span className="text-xs text-zinc-300 w-24 shrink-0">{cat.label}</span>
                      <input type="range" min={0} max={100} step={5} value={pct}
                        onChange={(e) => update(prev => ({ contentMixDist: { ...prev.contentMixDist, [cat.key]: +e.target.value } }))}
                        className="flex-1 accent-blue-500 h-1.5 rounded-full appearance-none bg-zinc-700 cursor-pointer" />
                      <span className="text-xs text-zinc-400 w-10 text-right font-mono">{pct}%</span>
                      <Badge color="zinc">{computed}</Badge>
                    </div>
                  );
                })}
                {(() => {
                  const total = Object.values(state.contentMixDist).reduce((a, b) => a + b, 0);
                  return total !== 100 && (
                    <div className="text-xs text-red-400 font-medium">Total: {total}% — must be 100%</div>
                  );
                })()}
              </div>
            </div>

            <Section title="Custom Themes per Category" hint="Override auto-generated prompts with your own theme for each category. Leave empty for random presets.">
              <div className="space-y-2">
                {['lifestyle', 'personality', 'teasing', 'engagement'].map(cat => (
                  <Textarea key={cat} label={cat.charAt(0).toUpperCase() + cat.slice(1)}
                    placeholder={`Custom ${cat} prompt... (leave empty for random presets)`}
                    value={state.contentMixThemes[cat]}
                    onChange={(e) => update(prev => ({ contentMixThemes: { ...prev.contentMixThemes, [cat]: e.target.value } }))}
                    className="!min-h-[60px]" />
                ))}
              </div>
            </Section>
          </>
        )}

        {/* Templates */}
        <Section title="Templates" badge={tplList.length > 0 ? <Badge color="zinc">{tplList.length}</Badge> : null}>
          <div className="space-y-2">
            <div className="flex items-center justify-end">
              <button onClick={() => setShowSaveTpl(!showSaveTpl)} className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer">
                {showSaveTpl ? 'Cancel' : 'Save current'}
              </button>
            </div>
            {showSaveTpl && (
              <div className="flex gap-2">
                <input type="text" value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="Template name..."
                  className="flex-1 h-8 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 text-sm text-zinc-200 placeholder:text-zinc-500 outline-none transition-all duration-200 hover:border-zinc-600 focus:border-blue-500/70 focus:ring-2 focus:ring-blue-500/20"
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveTemplate()} />
                <Btn variant="primary" onClick={handleSaveTemplate} className="!py-1 !px-3 !text-xs">Save</Btn>
              </div>
            )}
            {tplList.length > 0 && (
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {tplList.map((t) => (
                  <div key={t.id} className="flex items-center justify-between rounded-lg bg-zinc-800/60 px-2.5 py-1.5 group">
                    <button onClick={() => handleLoadTemplate(t)} className="text-sm text-zinc-300 hover:text-blue-400 transition truncate text-left flex-1 cursor-pointer">{t.name}</button>
                    <button onClick={() => handleDeleteTemplate(t.id)} className="text-zinc-600 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition cursor-pointer ml-2">Delete</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>

        <div className="flex gap-3">
          <Btn onClick={startBatch} disabled={loading || isRunning} className="flex-1">
            {loading ? <Spinner size={16} /> : null} {isRunning ? `Running... ${elapsedSec}s` : 'Start Batch'}
          </Btn>
          {isRunning && <Btn variant="danger" onClick={() => setShowCancelConfirm(true)} disabled={loading}>Cancel</Btn>}
        </div>
      </Card>

      {job && (
        <Card className="space-y-4 animate-in">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-medium text-zinc-300">Job Progress</h3>
              <Badge color={job.status === 'completed' ? 'green' : job.status === 'running' ? 'blue' : job.status === 'cancelled' ? 'yellow' : 'red'}>{job.status}</Badge>
              {job.status === 'running' && <span className="text-xs text-zinc-500 font-mono">{elapsedSec}s elapsed</span>}
            </div>
            <span className="text-xs text-zinc-500 font-mono">{completed} / {job.total}</span>
          </div>
          <ProgressBar value={completed} max={job.total} />

          {successfulResults.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {successfulResults.map((r, i) => (
                <ImageCard key={r.index} base64={r.image?.base64Data} mimeType={r.image?.mimeType}
                  meta={{ seed: r.seed, identityConfidence: r.image?.validation?.identity_match_score }} className="animate-in"
                  onSelect={() => openLightbox(jobImageUrls, i)} />
              ))}
            </div>
          )}

          {job.results?.some((r) => r && !r.success && r.error !== 'Job cancelled') && (
            <div className="space-y-1">
              {job.results.filter((r) => r && !r.success && r.error !== 'Job cancelled').map((r) => (
                <div key={r.index} className="text-xs text-red-400 bg-red-500/10 rounded px-3 py-1.5">Image {r.index + 1}: {r.error}</div>
              ))}
            </div>
          )}
        </Card>
      )}
      {/* Job History */}
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">Job History</h3>
          <Btn variant="secondary" onClick={fetchHistory} disabled={historyLoading} className="!py-1 !px-3 !text-xs">
            {historyLoading ? 'Loading...' : 'Refresh'}
          </Btn>
        </div>
        {jobHistory.length === 0 ? (
          <p className="text-xs text-zinc-500 py-2">No job history yet.</p>
        ) : (
          <div className="space-y-1.5 max-h-80 overflow-y-auto">
            {jobHistory.map((h) => {
              const isExpanded = expandedJobId === h.jobId;
              const duration = h.completedAt && h.createdAt
                ? Math.round((new Date(h.completedAt) - new Date(h.createdAt)) / 1000)
                : null;
              return (
                <div key={h.jobId} className="rounded-lg border border-zinc-700/50 bg-zinc-800/40">
                  <button
                    onClick={() => setExpandedJobId(isExpanded ? null : h.jobId)}
                    className="w-full flex items-center justify-between px-3 py-2 text-left cursor-pointer hover:bg-zinc-700/30 transition rounded-lg"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge color={h.status === 'completed' ? 'green' : h.status === 'running' ? 'blue' : h.status === 'cancelled' ? 'yellow' : 'red'}>
                        {h.status}
                      </Badge>
                      <span className="text-xs text-zinc-400 truncate">{h.mode}</span>
                      <span className="text-[10px] text-zinc-600">{h.completed}/{h.total}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {duration !== null && <span className="text-[10px] text-zinc-600">{duration}s</span>}
                      <span className="text-[10px] text-zinc-600">
                        {new Date(h.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {' '}
                        {new Date(h.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="text-zinc-600 text-xs">{isExpanded ? '▲' : '▼'}</span>
                    </div>
                  </button>
                  {isExpanded && h.config && (
                    <div className="px-3 pb-2.5 border-t border-zinc-700/30 pt-2 space-y-2">
                      <div className="text-xs text-zinc-400 space-y-0.5">
                        {h.config.prompt && <div><span className="text-zinc-500">Prompt:</span> {h.config.prompt}</div>}
                        {h.config.modificationPrompt && <div><span className="text-zinc-500">Edit prompt:</span> {h.config.modificationPrompt}</div>}
                        {h.config.count && <div><span className="text-zinc-500">Count:</span> {h.config.count}</div>}
                        {h.config.prompts && <div><span className="text-zinc-500">Prompts:</span> {h.config.prompts.length} lines</div>}
                        {h.aspectRatio && <div><span className="text-zinc-500">Ratio:</span> {h.aspectRatio}</div>}
                        {h.config.characterId && <div><span className="text-zinc-500">Character:</span> {h.config.characterId.slice(0, 8)}...</div>}
                      </div>
                      <Btn variant="secondary" onClick={() => handleRerun(h)} className="!py-1 !px-3 !text-xs">
                        Re-run with this config
                      </Btn>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        onConfirm={cancelBatch}
        title="Cancel batch job?"
        message={`This will stop the current batch. ${completed} of ${job?.total || 0} images already completed will be kept.`}
        confirmLabel="Cancel Job"
      />

      <LightboxComponent />
    </div>
  );
}
