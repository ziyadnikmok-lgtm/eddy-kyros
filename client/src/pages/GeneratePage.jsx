import { useState, useEffect, useMemo, useReducer, useRef, lazy, Suspense } from 'react';
import { generate as genApi, characters as charApi, templates as templatesApi, styleLibrary as styleApi, captionTemplates as captionApi, styleFocus as styleFocusApi } from '../services/api';
// characters, sceneMemories, outfits come from AppContext (fetched once on app load)
import { useAsync } from '../hooks/useAsync';
import { useStepTimer } from '../hooks/useStepTimer';
import { useApp } from '../context/AppContext';
import { Card, Btn, Textarea, Toggle, Spinner, ImageCard, Badge, StepProgress, Section, Hint, CopyBtn } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import {
  ASPECT_RATIOS, RESOLUTION_TIERS,
  CAMERA_PROFILES, POSE_MODES, EXPRESSION_MODES, SCENE_MODES,
} from '../config/photoModes';

const StyleAtomPicker = lazy(() => import('../components/StyleAtomPicker'));
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const AUTHENTICITY_MODIFIERS = [
  { id: 'iphone-selfie', label: 'iPhone Selfie', text: 'Shot on iPhone, slight lens distortion, natural phone camera quality' },
  { id: 'natural-grain', label: 'Natural Grain', text: 'Subtle film grain, organic noise texture, not studio-perfect' },
  { id: 'casual-angle', label: 'Casual Angle', text: 'Slightly off-center framing, imperfect composition like a real photo' },
  { id: 'mirror-selfie', label: 'Mirror Selfie', text: 'Mirror reflection selfie, phone visible in hand, reflected environment' },
  { id: 'golden-hour', label: 'Golden Hour', text: 'Warm golden hour sunlight, long shadows, amber lens flare' },
  { id: 'flash-photo', label: 'Flash Photo', text: 'Direct camera flash, harsh shadows, slightly washed highlights, party photo feel' },
  { id: 'bedroom-cozy', label: 'Bedroom Cozy', text: 'Soft warm lamp light, rumpled bedding texture, intimate close framing' },
  { id: 'no-makeup', label: 'No-Makeup Look', text: 'Minimal/no-makeup appearance, natural skin texture, dewy fresh face' },
];

const CONTENT_TYPES = [
  { key: 'lifestyle', label: 'Lifestyle', pct: 40, desc: 'Daily life, travel, activities' },
  { key: 'personality', label: 'Personality', pct: 30, desc: 'Close-ups, expressions, moods' },
  { key: 'teasing', label: 'Teasing', pct: 20, desc: 'Playful, suggestive, alluring' },
  { key: 'engagement', label: 'Engagement', pct: 10, desc: 'Q&A, polls, conversation' },
];

const SMART_DEFAULTS = {
  lifestyle: { cameraProfileId: 'iphone_selfie', poseMode: 'auto', expressionMode: 'relaxed_soft_smile', sceneMode: 'cafe_street_candid' },
  personality: { cameraProfileId: 'golden_hour_glow', poseMode: 'hip_pop_stand', expressionMode: 'warm_happy_smile', sceneMode: 'none' },
  teasing: { cameraProfileId: 'ring_light_vanity', poseMode: 'mirror_selfie', expressionMode: 'playful_soft_pout', sceneMode: 'bathroom_mirror_snap' },
  engagement: { cameraProfileId: 'iphone_selfie', poseMode: 'none', expressionMode: 'confident_smirk_direct', sceneMode: 'none' },
};

const INITIAL_STATE = {
  prompt: '',
  aspectRatio: '4:5',
  resolutionTier: '2K',
  formMode: 'quick',
  quickContentType: '',
  useCharacter: false,
  selectedCharId: '',
  selectedChar: null,
  sceneMemoryId: '',
  outfitId: '',
  cameraProfileId: '',
  poseMode: 'none',
  useExpressionMode: false,
  expressionMode: 'none',
  useSceneMode: false,
  sceneMode: 'none',
  useExtraReference: false,
  extraReference: null,
  extraReferencePreview: '',
  specificOutfitRef: null,
  specificItemRef: null,
  specificSceneRef: null,
};

function formReducer(state, action) {
  if (typeof action === 'function') return { ...state, ...action(state) };
  return { ...state, ...action };
}

// Module-level session cache — survives unmount/remount when navigating away and back
const _cache = {
  formState: null,
  result: null,
  history: [],
  styleAtomIds: [],
  styleAtomDetails: [],
  activeMods: new Set(),
  contentTab: 'lifestyle',
  selectedFocusId: '',
  captionDraft: { title: '', body: '', category: 'general', hashtags: '', cta: '' },
};

export default function GeneratePage() {
  const { notify, activeKey, characters: chars, sceneMemories, outfits } = useApp();
  const { loading, run } = useAsync();
  const busyRef = useRef(false);
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const [state, update] = useReducer(formReducer, _cache.formState || INITIAL_STATE);
  const {
    prompt, aspectRatio, resolutionTier,
    useCharacter, selectedCharId, selectedChar,
    sceneMemoryId, outfitId, cameraProfileId, poseMode,
    useExpressionMode, expressionMode, useSceneMode, sceneMode,
    useExtraReference, extraReference, extraReferencePreview,
    specificOutfitRef, specificItemRef, specificSceneRef,
  } = state;
  const [result, setResult] = useState(_cache.result);
  const [history, setHistory] = useState(_cache.history);
  const recentHistory = history.slice(1, 9).filter((h) => h?.imageId);

  // Templates
  const [tplList, setTplList] = useState([]);
  const [tplName, setTplName] = useState('');
  const [showSaveTpl, setShowSaveTpl] = useState(false);

  // Style Library
  const [styleAtomIds, setStyleAtomIds] = useState(_cache.styleAtomIds);
  const [styleAtomDetails, setStyleAtomDetails] = useState(_cache.styleAtomDetails); // [{id, category, text}]
  const [showAtomPicker, setShowAtomPicker] = useState(false);
  const [stylePreview, setStylePreview] = useState('');

  // Style Focus (visual DNA presets from Post Clone)
  const [styleFocusList, setStyleFocusList] = useState([]);
  const [selectedFocusId, setSelectedFocusId] = useState(_cache.selectedFocusId);
  const [selectedFocusData, setSelectedFocusData] = useState(null);
  useEffect(() => {
    if (!selectedFocusId) { setSelectedFocusData(null); return; }
    styleFocusApi.get(selectedFocusId).then(setSelectedFocusData).catch(() => setSelectedFocusData(null));
  }, [selectedFocusId]);

  // Authenticity modifiers
  const [activeMods, setActiveMods] = useState(_cache.activeMods);

  // Content type presets
  const [contentPresets, setContentPresets] = useState([]);
  const [contentTab, setContentTab] = useState(_cache.contentTab);

  // Caption templates
  const [captionList, setCaptionList] = useState([]);
  const [suggestedCaptions, setSuggestedCaptions] = useState([]);
  const [showCaptionComposer, setShowCaptionComposer] = useState(false);
  const [captionDraft, setCaptionDraft] = useState(_cache.captionDraft);

  // ── Session cache sync ──
  useEffect(() => { _cache.formState = state; }, [state]);
  useEffect(() => { _cache.result = result; }, [result]);
  useEffect(() => { _cache.history = history; }, [history]);
  useEffect(() => { _cache.styleAtomIds = styleAtomIds; }, [styleAtomIds]);
  useEffect(() => { _cache.styleAtomDetails = styleAtomDetails; }, [styleAtomDetails]);
  useEffect(() => { _cache.activeMods = activeMods; }, [activeMods]);
  useEffect(() => { _cache.contentTab = contentTab; }, [contentTab]);
  useEffect(() => { _cache.selectedFocusId = selectedFocusId; }, [selectedFocusId]);
  useEffect(() => { _cache.captionDraft = captionDraft; }, [captionDraft]);

  useEffect(() => { templatesApi.list('generate').then(setTplList).catch(() => {}); }, []);
  useEffect(() => { styleFocusApi.list().then(setStyleFocusList).catch(() => {}); }, []);
  useEffect(() => { styleApi.contentPresets().then(setContentPresets).catch(() => {}); }, []);
  useEffect(() => { captionApi.list().then(setCaptionList).catch(() => {}); }, []);

  // Prompt completeness indicator — Nano-Banana formula coverage
  const promptCompleteness = useMemo(() => {
    const atomCats = new Set(styleAtomDetails.map(a => a.category));
    return [
      { label: 'Subject', covered: !!(useCharacter && selectedCharId) },
      { label: 'Style', covered: !!(outfitId || atomCats.has('outfit') || atomCats.has('vibe')) },
      { label: 'Composition', covered: !!(cameraProfileId || atomCats.has('camera') || atomCats.has('scene') || (useSceneMode && sceneMode !== 'none')) },
      { label: 'Lighting', covered: !!(sceneMemoryId || atomCats.has('lighting')) },
      { label: 'Details', covered: !!((poseMode && poseMode !== 'none') || (useExpressionMode && expressionMode !== 'none') || atomCats.has('pose') || atomCats.has('expression')) },
      { label: 'Format', covered: !!(atomCats.has('format') || activeMods.size > 0) },
    ];
  }, [useCharacter, selectedCharId, outfitId, cameraProfileId, sceneMemoryId, poseMode, useExpressionMode, expressionMode, useSceneMode, sceneMode, styleAtomDetails, activeMods]);

  // Fetch composed preview when style atoms change
  useEffect(() => {
    if (styleAtomIds.length === 0) { setStylePreview(''); return; }
    styleApi.compose(styleAtomIds).then(r => setStylePreview(r.prompt)).catch(() => setStylePreview(''));
  }, [styleAtomIds]);

  const handleApplyAtoms = async (ids) => {
    setStyleAtomIds(ids);
    setShowAtomPicker(false);
    const details = [];
    for (const id of ids) {
      try { const atom = await styleApi.get(id); details.push({ id: atom.id, category: atom.category, text: atom.text }); } catch { /* skip */ }
    }
    setStyleAtomDetails(details);
  };

  const removeStyleAtom = (id) => {
    setStyleAtomIds(prev => prev.filter(x => x !== id));
    setStyleAtomDetails(prev => prev.filter(x => x.id !== id));
  };

  // Pick up atoms + format sent from Prompt Builder page
  useEffect(() => {
    const raw = sessionStorage.getItem('pb_atomIds');
    if (!raw) return;
    sessionStorage.removeItem('pb_atomIds');
    try {
      const ids = JSON.parse(raw);
      if (Array.isArray(ids) && ids.length > 0) handleApplyAtoms(ids);
    } catch { /* ignore */ }
    const ar = sessionStorage.getItem('pb_aspectRatio');
    const res = sessionStorage.getItem('pb_resolutionTier');
    if (ar) { update({ aspectRatio: ar }); sessionStorage.removeItem('pb_aspectRatio'); }
    if (res) { update({ resolutionTier: res }); sessionStorage.removeItem('pb_resolutionTier'); }
  }, []);

  useEffect(() => {
    if (selectedCharId) charApi.get(selectedCharId).then((d) => update({ selectedChar: d })).catch(() => update({ selectedChar: null }));
    else update({ selectedChar: null });
  }, [selectedCharId]);
  useEffect(() => {
    if (!useCharacter) {
      update({ useExtraReference: false, extraReference: null, extraReferencePreview: '' });
    }
  }, [useCharacter]);
  useEffect(() => {
    if (!useExtraReference) {
      update({ extraReference: null, extraReferencePreview: '' });
    }
  }, [useExtraReference]);

  const GENERATE_STEPS = useMemo(() => [
    'Building prompt with identity lock',
    'Sending to Gemini for generation',
    'Processing generated image',
  ], []);
  const GENERATE_THRESHOLDS = useMemo(() => [2, 5], []);
  const { elapsedSec, stepIndex: generateStepIndex } = useStepTimer(loading, GENERATE_THRESHOLDS);

  const getSaveableConfig = () => {
    const { selectedChar, extraReference, extraReferencePreview, specificOutfitRef, specificItemRef, specificSceneRef, ...saveable } = state;
    return saveable;
  };

  const handleSaveTemplate = async () => {
    if (!tplName.trim()) { notify('Enter a template name', 'error'); return; }
    try {
      const created = await templatesApi.create({ name: tplName.trim(), page: 'generate', config: getSaveableConfig() });
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

  const handleGenerate = () => {
    if (busyRef.current) return;
    busyRef.current = true;
    run(async () => {
    if (!prompt.trim() && !selectedCharId) { notify('Enter a prompt or select a character', 'error'); return; }
    let finalPrompt = prompt.trim();
    if (activeMods.size > 0) {
      const modTexts = AUTHENTICITY_MODIFIERS.filter(m => activeMods.has(m.id)).map(m => m.text);
      finalPrompt = finalPrompt ? `${finalPrompt}\n${modTexts.join('. ')}` : modTexts.join('. ');
    }
    const body = {
      prompt: finalPrompt,
      aspectRatio,
      resolutionTier,
      sceneMemoryId: sceneMemoryId || null,
      outfitId: outfitId || null,
      cameraProfileId: cameraProfileId || null,
      autoPose: poseMode === 'auto',
      poseMode,
      expressionMode: useExpressionMode ? expressionMode : 'none',
      sceneMode: useSceneMode ? sceneMode : 'none',
      styleAtomIds: styleAtomIds.length > 0 ? styleAtomIds : undefined,
      styleFocusId: selectedFocusId || undefined,
      contentType: state.quickContentType || contentTab || undefined,
    };
    if (useCharacter && selectedCharId) {
      body.characterId = selectedCharId;
      const activeRefIds = selectedChar?.references?.filter((r) => r.isActive).map((r) => r.id);
      if (activeRefIds?.length) body.activeReferenceIds = activeRefIds;
      if (useExtraReference && extraReference?.image) body.extraReferenceImage = extraReference;
    }
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
      body.customReferenceImages = typedRefs.map((ref) => ({
        image: ref.image,
        mimeType: ref.mimeType,
        name: ref.name,
        referenceType: ref.referenceType,
        note: ref.note || '',
      }));
    }
    const data = await genApi.image(body);
    setResult(data);
    // Store lightweight history entry (imageId + meta only) to avoid holding
    // 20 full base64 images in memory (~5-10MB each = 100-200MB).
    setHistory((h) => [{
      imageId: data.imageId,
      galleryId: data.galleryId || data.imageId,
      mimeType: data.image?.mimeType,
      identityConfidence: data.image?.validation?.identity_match_score,
    }, ...h].slice(0, 9));
    notify('Image generated!', 'success');
    captionApi.suggest(contentTab || 'lifestyle', 3).then(setSuggestedCaptions).catch(() => {});
  }).finally(() => { busyRef.current = false; });
  };

  const handleExtraReferenceUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      update({
        extraReference: { image: dataUrl, mimeType: file.type, name: file.name },
        extraReferencePreview: dataUrl,
      });
    } catch {
      notify('Failed to read extra reference image', 'error');
    } finally {
      event.target.value = '';
    }
  };

  const handleSpecificReferenceUpload = async (event, refType) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
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

  const activeRefCount = [specificOutfitRef, specificItemRef, specificSceneRef].filter(Boolean).length;
  const activeTechCount = [cameraProfileId, poseMode !== 'none' && poseMode, useExpressionMode && expressionMode !== 'none', useSceneMode && sceneMode !== 'none'].filter(Boolean).length;

  return (
    <div className="space-y-6 animate-in">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-gradient">Generate</h1>
        <p className="text-zinc-500 text-sm mt-1">Create images with full control over character, scene, and style.</p>
      </div>

      {/* Welcome banner for new users */}
      {!activeKey && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-5 py-4">
          <p className="text-sm text-amber-300 font-medium mb-2">Getting started</p>
          <div className="space-y-1.5 text-sm text-zinc-300">
            <p>1. Go to <strong>API Keys</strong> and add your Gemini API key</p>
            <p>2. Go to <strong>Characters</strong> and create a character with a reference image</p>
            <p>3. Come back here, write a prompt, and generate!</p>
          </div>
          <p className="text-xs text-zinc-500 mt-2">Click the status dots in the header to jump to API Keys.</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <Card className="space-y-4">
            {/* ── Quick / Advanced Toggle ── */}
            <div className="flex items-center justify-between">
              <div className="flex rounded-lg bg-zinc-800/60 p-0.5">
                {[['quick', 'Quick'], ['advanced', 'Advanced']].map(([m, label]) => (
                  <button key={m} onClick={() => update({ formMode: m })}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition cursor-pointer ${
                      state.formMode === m ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
              {state.formMode === 'quick' && <span className="text-[10px] text-zinc-500">Essential controls only</span>}
            </div>

            {/* ── Essential: Prompt + Character ── */}
            <Textarea label="Prompt" placeholder="Describe the image you want to generate..." value={prompt} onChange={(e) => update({ prompt: e.target.value })} className="!min-h-[120px]" />

            <Toggle checked={useCharacter} onChange={(v) => update({ useCharacter: v })} label="Use Character" />

            {useCharacter && (
              <div className="space-y-3 pl-3 border-l-2 border-blue-500/30">
                <select value={selectedCharId} onChange={(e) => update({ selectedCharId: e.target.value })}
                  className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
                  <option value="">Select character...</option>
                  {chars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {selectedChar?.references?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {selectedChar.references.map((r) => (
                      <Badge key={r.id} color={r.isActive ? 'blue' : 'zinc'}>{r.category}</Badge>
                    ))}
                  </div>
                )}

                {useCharacter && (
                  <div className="space-y-2">
                    <Toggle checked={useExtraReference} onChange={(v) => update({ useExtraReference: v })} label="Use Other Ref Image (Optional)" />
                    {useExtraReference && (
                      <>
                        <span className="text-xs text-zinc-400 font-medium block">Extra Reference (Scene/Location)</span>
                        <label className={`flex items-center justify-center border border-dashed rounded-lg transition h-28 overflow-hidden bg-zinc-900/50 ${selectedCharId ? 'border-zinc-700/80 cursor-pointer hover:border-zinc-500' : 'border-zinc-800 cursor-not-allowed opacity-70'}`}>
                          {extraReferencePreview ? (
                            <img src={extraReferencePreview} alt="Extra reference" className="max-h-full max-w-full object-contain" />
                          ) : (
                            <div className="text-center">
                              <div className="text-zinc-300 text-sm">Add second image</div>
                              <div className="text-zinc-500 text-xs mt-1">Character keeps identity, follows this scene/composition</div>
                            </div>
                          )}
                          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleExtraReferenceUpload} disabled={!selectedCharId} />
                        </label>
                        {!selectedCharId && (
                          <div className="text-xs text-zinc-500">Select a character to enable this upload.</div>
                        )}
                        {extraReference && (
                          <button
                            type="button"
                            onClick={() => update({ extraReference: null, extraReferencePreview: '' })}
                            className="text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer"
                          >
                            Remove extra reference
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── Image Size ── */}
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-2">Aspect Ratio</span>
              <div className="flex flex-wrap gap-1.5">
                {ASPECT_RATIOS.map((ar) => (
                  <button key={ar} onClick={() => update({ aspectRatio: ar })}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition cursor-pointer ${aspectRatio === ar ? 'bg-blue-600 text-white' : 'bg-zinc-700/60 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200'}`}>
                    {ar}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-2">Resolution Tier</span>
              <div className="flex flex-wrap gap-1.5">
                {RESOLUTION_TIERS.map((tier) => (
                  <button
                    key={tier}
                    onClick={() => update({ resolutionTier: tier })}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${resolutionTier === tier ? 'bg-blue-500 text-white' : 'bg-zinc-700/60 text-zinc-200 hover:bg-zinc-600/80'}`}
                  >
                    {tier}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Quick Mode: Content Type Picker ── */}
            {state.formMode === 'quick' && (
              <div>
                <span className="text-xs text-zinc-400 font-medium block mb-2">Content Type</span>
                <div className="grid grid-cols-2 gap-1.5">
                  {CONTENT_TYPES.map(ct => (
                    <button key={ct.key} onClick={() => {
                      update({ quickContentType: ct.key });
                      const defaults = SMART_DEFAULTS[ct.key];
                      if (defaults) {
                        update({
                          cameraProfileId: defaults.cameraProfileId,
                          poseMode: defaults.poseMode,
                          useExpressionMode: defaults.expressionMode !== 'none',
                          expressionMode: defaults.expressionMode,
                          useSceneMode: defaults.sceneMode !== 'none',
                          sceneMode: defaults.sceneMode,
                        });
                      }
                    }}
                      className={`rounded-lg px-2.5 py-2 text-left transition cursor-pointer border ${
                        state.quickContentType === ct.key
                          ? 'border-blue-500/40 bg-blue-500/10'
                          : 'border-zinc-700/40 bg-zinc-800/40 hover:border-zinc-600'
                      }`}>
                      <div className="flex items-center justify-between">
                        <span className={`text-xs font-medium ${state.quickContentType === ct.key ? 'text-blue-300' : 'text-zinc-300'}`}>{ct.label}</span>
                        <span className="text-[10px] text-zinc-600">{ct.pct}%</span>
                      </div>
                      <span className="text-[10px] text-zinc-500 block mt-0.5">{ct.desc}</span>
                    </button>
                  ))}
                </div>
                {state.quickContentType && (
                  <div className="mt-2 text-[10px] text-zinc-500">
                    Auto-configured: {SMART_DEFAULTS[state.quickContentType] && `Camera: ${CAMERA_PROFILES.find(c => c.value === SMART_DEFAULTS[state.quickContentType].cameraProfileId)?.label || '—'}, Pose: ${POSE_MODES.find(p => p.value === SMART_DEFAULTS[state.quickContentType].poseMode)?.label || '—'}`}
                  </div>
                )}
              </div>
            )}

            {/* ── Advanced-only sections ── */}
            {state.formMode === 'advanced' && <>
            {/* ── Collapsible: Authenticity Modifiers ── */}
            <Section title="Authenticity Modifiers" badge={activeMods.size > 0 ? <Badge color="blue">{activeMods.size}</Badge> : null} hint="Add realistic photo imperfections like grain, flash, or phone quality to make images look less AI-generated.">
              <div className="flex flex-wrap gap-1.5">
                {AUTHENTICITY_MODIFIERS.map(mod => (
                  <button key={mod.id} onClick={() => setActiveMods(prev => {
                    const next = new Set(prev);
                    next.has(mod.id) ? next.delete(mod.id) : next.add(mod.id);
                    return next;
                  })}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition cursor-pointer border ${
                      activeMods.has(mod.id)
                        ? 'bg-purple-600/30 text-purple-300 border-purple-500/50'
                        : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/50 hover:border-zinc-600 hover:text-zinc-400'
                    }`}
                    title={mod.text}
                  >
                    {mod.label}
                  </button>
                ))}
              </div>
            </Section>

            {/* ── Collapsible: Camera, Pose, Expression, Scene ── */}
            <Section title="Camera, Pose & Scene" badge={activeTechCount > 0 ? <Badge color="blue">{activeTechCount}</Badge> : null} hint="Control how the image is shot — camera angle, body pose, facial expression, and environment.">
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

            {/* ── Collapsible: Image References ── */}
            <Section title="Image References" badge={activeRefCount > 0 ? <Badge color="blue">{activeRefCount}</Badge> : null} hint="Upload reference images for outfit, items, or background. The AI will incorporate these into the generation.">
              <div className="grid grid-cols-1 gap-2">
                <label className={`flex items-center justify-between rounded-lg cursor-pointer transition h-16 overflow-hidden px-3 border border-dashed ${specificOutfitRef ? 'border-purple-500/40 bg-purple-500/5' : 'border-zinc-700/80 bg-zinc-900/50 hover:border-purple-500/30'}`}>
                  <div className="flex items-center gap-2.5">
                    <span className="text-lg w-6 text-center flex-shrink-0">👗</span>
                    <div className="text-left">
                      <div className="text-zinc-300 text-sm">Outfit Ref</div>
                      <div className="text-zinc-500 text-xs">Clothing/style source</div>
                    </div>
                  </div>
                  {specificOutfitRef?.image && <img src={specificOutfitRef.image} alt="" className="h-10 w-10 rounded object-cover border border-zinc-700/80" />}
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => handleSpecificReferenceUpload(e, 'outfit')} />
                </label>

                <label className={`flex items-center justify-between rounded-lg cursor-pointer transition h-16 overflow-hidden px-3 border border-dashed ${specificItemRef ? 'border-amber-500/40 bg-amber-500/5' : 'border-zinc-700/80 bg-zinc-900/50 hover:border-amber-500/30'}`}>
                  <div className="flex items-center gap-2.5">
                    <span className="text-lg w-6 text-center flex-shrink-0">💎</span>
                    <div className="text-left">
                      <div className="text-zinc-300 text-sm">Item Ref</div>
                      <div className="text-zinc-500 text-xs">Props/accessories/details</div>
                    </div>
                  </div>
                  {specificItemRef?.image && <img src={specificItemRef.image} alt="" className="h-10 w-10 rounded object-cover border border-zinc-700/80" />}
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => handleSpecificReferenceUpload(e, 'item')} />
                </label>

                <label className={`flex items-center justify-between rounded-lg cursor-pointer transition h-16 overflow-hidden px-3 border border-dashed ${specificSceneRef ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-zinc-700/80 bg-zinc-900/50 hover:border-emerald-500/30'}`}>
                  <div className="flex items-center gap-2.5">
                    <span className="text-lg w-6 text-center flex-shrink-0">🏞</span>
                    <div className="text-left">
                      <div className="text-zinc-300 text-sm">Background/Scene Ref</div>
                      <div className="text-zinc-500 text-xs">Location/composition source</div>
                    </div>
                  </div>
                  {specificSceneRef?.image && <img src={specificSceneRef.image} alt="" className="h-10 w-10 rounded object-cover border border-zinc-700/80" />}
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => handleSpecificReferenceUpload(e, 'scene')} />
                </label>

                {(specificOutfitRef || specificItemRef || specificSceneRef) && (
                  <div className="flex gap-2">
                    {specificOutfitRef && <button type="button" onClick={() => update({ specificOutfitRef: null })} className="text-xs text-zinc-500 hover:text-zinc-200 cursor-pointer">Clear Outfit</button>}
                    {specificItemRef && <button type="button" onClick={() => update({ specificItemRef: null })} className="text-xs text-zinc-500 hover:text-zinc-200 cursor-pointer">Clear Item</button>}
                    {specificSceneRef && <button type="button" onClick={() => update({ specificSceneRef: null })} className="text-xs text-zinc-500 hover:text-zinc-200 cursor-pointer">Clear Scene</button>}
                  </div>
                )}
              </div>
            </Section>

            {/* ── Collapsible: Style Library ── */}
            <Section title="Style Library" badge={styleAtomIds.length > 0 ? <Badge color="blue">{styleAtomIds.length}</Badge> : null} hint="Reusable style building blocks (lighting, vibe, camera, etc.) that combine into a cohesive visual style.">
              <div className="flex items-center justify-end">
                <button onClick={() => setShowAtomPicker(true)} className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer">
                  Browse Library
                </button>
              </div>
              {styleAtomDetails.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap gap-1">
                    {styleAtomDetails.map(a => (
                      <span key={a.id} className="inline-flex items-center gap-1 bg-blue-500/15 text-blue-400 text-xs px-2 py-0.5 rounded-full">
                        {a.category}
                        <button onClick={() => removeStyleAtom(a.id)} className="hover:text-red-400 cursor-pointer">&times;</button>
                      </span>
                    ))}
                  </div>
                  {stylePreview && (
                    <div className="bg-zinc-800/60 rounded-lg p-2 text-[11px] text-zinc-400 font-mono whitespace-pre-wrap max-h-20 overflow-y-auto">
                      {stylePreview}
                    </div>
                  )}
                  <button onClick={() => { setStyleAtomIds([]); setStyleAtomDetails([]); setStylePreview(''); }}
                    className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer">Clear all</button>
                </div>
              )}
            </Section>

            {/* ── Collapsible: Style Focus ── */}
            {styleFocusList.length > 0 && (
            <Section title="Style Focus" badge={selectedFocusId ? <Badge color="purple">1</Badge> : null}
              hint="Apply a saved visual DNA snapshot from Post Clone analysis. Overrides camera, lighting, pose, and expression settings.">
              <div className="space-y-2">
                <select value={selectedFocusId} onChange={(e) => setSelectedFocusId(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-purple-500/70 focus:ring-1 focus:ring-purple-500/20 cursor-pointer">
                  <option value="">None</option>
                  {styleFocusList.map(sf => (
                    <option key={sf.id} value={sf.id}>{sf.name} ({sf.attributeCount} attrs)</option>
                  ))}
                </select>
                {selectedFocusData && (
                  <div className="space-y-1.5">
                    <div className="grid grid-cols-2 gap-1">
                      {Object.entries(selectedFocusData.attributes || {}).filter(([, v]) => v).map(([key, val]) => (
                        <div key={key} className="bg-purple-500/10 border border-purple-500/20 rounded-md px-2 py-1">
                          <div className="text-[9px] text-purple-400 uppercase tracking-wider">{key}</div>
                          <div className="text-[11px] text-zinc-300 line-clamp-1">{val}</div>
                        </div>
                      ))}
                    </div>
                    <button onClick={() => setSelectedFocusId('')}
                      className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer">Clear</button>
                  </div>
                )}
              </div>
            </Section>
            )}

            {/* ── Collapsible: Content Type Presets ── */}
            <Section title="Content Type Presets" hint="Quick-start prompt presets organized by content category. Click one to fill your prompt instantly.">
              <div className="space-y-2.5">
                <div className="grid grid-cols-2 gap-1.5">
                  {CONTENT_TYPES.map(ct => (
                    <button key={ct.key} onClick={() => setContentTab(ct.key)}
                      className={`rounded-lg px-2.5 py-2 text-left transition cursor-pointer border ${
                        contentTab === ct.key
                          ? 'border-blue-500/40 bg-blue-500/10'
                          : 'border-zinc-700/40 bg-zinc-800/40 hover:border-zinc-600'
                      }`}>
                      <div className="flex items-center justify-between">
                        <span className={`text-xs font-medium ${contentTab === ct.key ? 'text-blue-300' : 'text-zinc-300'}`}>{ct.label}</span>
                        <span className="text-[10px] text-zinc-600">{ct.pct}%</span>
                      </div>
                      <span className="text-[10px] text-zinc-500 block mt-0.5">{ct.desc}</span>
                    </button>
                  ))}
                </div>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {contentPresets.filter(p => p.contentType === contentTab).map(preset => (
                    <button key={preset.id}
                      onClick={() => {
                        const atoms = Object.entries(preset.suggestedAtoms || {}).map(([cat, text]) => `${cat}: ${text}`);
                        update({ prompt: atoms.join('\n') });
                        notify(`Applied "${preset.name}" preset to prompt`, 'success');
                      }}
                      className="w-full text-left rounded-lg bg-zinc-800/40 hover:bg-zinc-800/80 p-2 transition cursor-pointer">
                      <span className="text-xs text-zinc-300 font-medium block">{preset.name}</span>
                      <span className="text-[10px] text-zinc-500">{preset.description}</span>
                    </button>
                  ))}
                  {contentPresets.filter(p => p.contentType === contentTab).length === 0 && (
                    <p className="text-[10px] text-zinc-600 italic py-1">No presets available</p>
                  )}
                </div>
              </div>
            </Section>

            {/* ── Collapsible: Captions ── */}
            <Section title="Captions" badge={captionList.length > 0 ? <Badge color="zinc">{captionList.length}</Badge> : null}
              hint="Caption templates for Instagram posts. Suggested after generation based on content type.">
              <div className="space-y-2">
                {suggestedCaptions.length > 0 && (
                  <div className="space-y-1.5">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Suggested</span>
                    {suggestedCaptions.map(c => (
                      <div key={c.id} className="bg-zinc-800/40 rounded-lg p-2 group">
                        <div className="text-xs text-zinc-300 font-medium">{c.title}</div>
                        <div className="text-[11px] text-zinc-400 mt-0.5 line-clamp-2">{c.body}</div>
                        {c.hashtags.length > 0 && (
                          <div className="text-[10px] text-blue-400 mt-1 truncate">{c.hashtags.map(h => `#${h}`).join(' ')}</div>
                        )}
                        <div className="flex gap-1.5 mt-1.5 opacity-0 group-hover:opacity-100 transition">
                          <CopyBtn text={`${c.body}${c.hashtags.length ? '\n\n' + c.hashtags.map(h => '#' + h).join(' ') : ''}${c.cta ? '\n\n' + c.cta : ''}`} />
                          <button onClick={() => { captionApi.markUsed(c.id).catch(() => {}); notify('Marked as used', 'info'); }}
                            className="text-[10px] text-zinc-500 hover:text-green-400 cursor-pointer">Use</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-end">
                  <button onClick={() => setShowCaptionComposer(!showCaptionComposer)}
                    className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer">
                    {showCaptionComposer ? 'Cancel' : '+ New Caption'}
                  </button>
                </div>
                {showCaptionComposer && (
                  <div className="space-y-2 bg-zinc-800/30 rounded-lg p-2.5">
                    <input type="text" placeholder="Caption title..."
                      value={captionDraft.title} onChange={(e) => setCaptionDraft(d => ({ ...d, title: e.target.value }))}
                      className="w-full h-8 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 text-sm text-zinc-200 placeholder:text-zinc-500 outline-none focus:border-blue-500/70" />
                    <select value={captionDraft.category} onChange={(e) => setCaptionDraft(d => ({ ...d, category: e.target.value }))}
                      className="w-full h-8 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 text-xs text-zinc-300 outline-none cursor-pointer">
                      {['general', 'lifestyle', 'personality', 'teasing', 'engagement'].map(c => (
                        <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                      ))}
                    </select>
                    <textarea placeholder="Caption body... Use {{placeholder}} for variables" rows={3}
                      value={captionDraft.body} onChange={(e) => setCaptionDraft(d => ({ ...d, body: e.target.value }))}
                      className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-500 outline-none resize-y focus:border-blue-500/70" />
                    <input type="text" placeholder="Hashtags (comma-separated)..."
                      value={captionDraft.hashtags} onChange={(e) => setCaptionDraft(d => ({ ...d, hashtags: e.target.value }))}
                      className="w-full h-8 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 text-sm text-zinc-200 placeholder:text-zinc-500 outline-none focus:border-blue-500/70" />
                    <input type="text" placeholder="Call to action (optional)..."
                      value={captionDraft.cta} onChange={(e) => setCaptionDraft(d => ({ ...d, cta: e.target.value }))}
                      className="w-full h-8 rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 text-sm text-zinc-200 placeholder:text-zinc-500 outline-none focus:border-blue-500/70" />
                    <Btn variant="primary" className="!py-1 !px-3 !text-xs" onClick={async () => {
                      try {
                        const created = await captionApi.create({
                          ...captionDraft,
                          hashtags: captionDraft.hashtags.split(',').map(h => h.trim()).filter(Boolean),
                        });
                        setCaptionList(prev => [created, ...prev]);
                        setCaptionDraft({ title: '', body: '', category: 'general', hashtags: '', cta: '' });
                        setShowCaptionComposer(false);
                        notify('Caption template saved', 'success');
                      } catch (err) { notify(err.message || 'Failed to save', 'error'); }
                    }}>Save Caption</Btn>
                  </div>
                )}
                {captionList.length > 0 && (
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {captionList.map(c => (
                      <div key={c.id} className="flex items-center justify-between rounded-lg bg-zinc-800/60 px-2.5 py-1.5 group">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-zinc-300 truncate">{c.title}</div>
                          <div className="text-[10px] text-zinc-500">{c.category}</div>
                        </div>
                        <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition">
                          <CopyBtn text={`${c.body}${c.hashtags.length ? '\n\n' + c.hashtags.map(h => '#' + h).join(' ') : ''}`} />
                          <button onClick={() => captionApi.remove(c.id).then(() => {
                            setCaptionList(prev => prev.filter(x => x.id !== c.id));
                            notify('Caption deleted', 'success');
                          }).catch(err => notify(err.message, 'error'))}
                            className="text-zinc-600 hover:text-red-400 text-xs cursor-pointer ml-1">Del</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Section>

            {/* ── Collapsible: Templates ── */}
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
            </>}

            <div className="pt-1">
              {/* Prompt Completeness Indicator */}
              <div className="flex items-center gap-1 mb-2">
                {promptCompleteness.map(item => (
                  <div key={item.label} className="flex-1 group relative">
                    <div className={`h-1.5 rounded-full transition ${item.covered ? 'bg-green-500/70' : 'bg-zinc-700/50'}`} />
                    <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[9px] text-zinc-500 opacity-0 group-hover:opacity-100 transition whitespace-nowrap pointer-events-none">
                      {item.label} {item.covered ? '\u2713' : '\u2717'}
                    </span>
                  </div>
                ))}
              </div>
              <Btn onClick={handleGenerate} disabled={loading || (!prompt.trim() && !selectedCharId)} className="w-full">
                {loading ? <><Spinner size={16} /> Generating...</> : '\u2726 Generate Image'}
              </Btn>
            </div>
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {loading && (
            <div className="flex items-center justify-center min-h-[calc(100vh-10rem)]">
              <StepProgress steps={GENERATE_STEPS} currentIndex={generateStepIndex} elapsedSec={elapsedSec} className="w-full max-w-md" />
            </div>
          )}

          {result && (
            <Card className="animate-in !p-3">
              <ImageCard base64={result.image?.base64Data} mimeType={result.image?.mimeType}
                meta={{ imageId: result.imageId, identityConfidence: result.image?.validation?.identity_match_score }}
                onSelect={() => result.image?.base64Data && openLightbox([`data:${result.image?.mimeType || 'image/png'};base64,${result.image?.base64Data}`], 0)} />
            </Card>
          )}

          {history.length > 1 && (
            <div>
              <h3 className="text-sm font-medium text-zinc-400 mb-3">Recent</h3>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                {recentHistory.map((h, i) => {
                  const thumbUrl = `/api/gallery/${h.galleryId || h.imageId}/image`;
                  return (
                    <ImageCard
                      key={h.imageId || i}
                      src={thumbUrl}
                      mimeType={h.mimeType}
                      meta={{ identityConfidence: h.identityConfidence }}
                      className="!rounded-lg"
                      onSelect={() => openLightbox(recentHistory.map((img) => `/api/gallery/${img.galleryId || img.imageId}/image`), i)}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      <LightboxComponent />
      {showAtomPicker && (
        <Suspense fallback={null}>
          <StyleAtomPicker
            selectedIds={styleAtomIds}
            onApply={handleApplyAtoms}
            onClose={() => setShowAtomPicker(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
