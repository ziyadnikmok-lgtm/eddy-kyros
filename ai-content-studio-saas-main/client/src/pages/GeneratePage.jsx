import { useState, useEffect, useMemo, useReducer, useRef, lazy, Suspense } from 'react';
import { pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import { generate as genApi, characters as charApi, templates as templatesApi, styleLibrary as styleApi, captionTemplates as captionApi, styleFocus as styleFocusApi } from '../services/api';
import { useStepTimer } from '../hooks/useStepTimer';
import { useApp } from '../context/AppContext';
import { Card, Btn, Textarea, Toggle, Spinner, ImageCard, Badge, Section, Hint, CopyBtn } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import {
  ASPECT_RATIOS, RESOLUTION_TIERS,
  CAMERA_PROFILES, POSE_MODES, EXPRESSION_MODES, SCENE_MODES,
  IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL, DEFAULT_RESOLUTION_TIER,
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

const DEFAULT_CAPTION_DRAFT = { title: '', body: '', category: 'general', hashtags: '', cta: '' };

const INITIAL_STATE = {
  prompt: '',
  aspectRatio: '4:5',
  resolutionTier: DEFAULT_RESOLUTION_TIER,
  imageModel: DEFAULT_IMAGE_MODEL,
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

const GENERATE_STEPS = [
  'Building prompt with identity lock',
  'Sending to Gemini for generation',
  'Processing generated image',
];

const GENERATE_THRESHOLDS = [2, 5];

function toAspectRatioValue(aspectRatio = '1:1') {
  const [w = '1', h = '1'] = String(aspectRatio).split(':');
  return `${w} / ${h}`;
}

function buildCharacterReferencePreviewItems(characterId, character) {
  if (!characterId || !character) return [];

  const previews = [];
  const primaryCount = Math.max(0, Number(character.primaryImageCount || 0));
  for (let index = 0; index < primaryCount; index += 1) {
    previews.push({
      key: `primary-${index}`,
      label: index === 0 ? 'Primary' : `Primary ${index + 1}`,
      src: charApi.primaryImageUrl(characterId, index),
    });
  }

  for (const ref of character.references || []) {
    if (!ref?.isActive) continue;
    previews.push({
      key: `ref-${ref.id}`,
      label: ref.category || 'Reference',
      src: charApi.refImageUrl(characterId, ref.id),
    });
  }

  return previews;
}

function matchesQuickDefaults(state, defaults) {
  if (!defaults) return false;
  return (
    (state.cameraProfileId || '') === (defaults.cameraProfileId || '') &&
    (state.poseMode || 'none') === (defaults.poseMode || 'none') &&
    Boolean(state.useExpressionMode) === (defaults.expressionMode !== 'none') &&
    (state.expressionMode || 'none') === (defaults.expressionMode || 'none') &&
    Boolean(state.useSceneMode) === (defaults.sceneMode !== 'none') &&
    (state.sceneMode || 'none') === (defaults.sceneMode || 'none')
  );
}

function GenerationQueueCard({ job, onDismiss }) {
  const { elapsedSec, stepIndex } = useStepTimer(job.status === 'running', GENERATE_THRESHOLDS);
  const currentStep = GENERATE_STEPS[Math.min(stepIndex, GENERATE_STEPS.length - 1)];

  return (
    <Card className="!p-0 overflow-hidden">
      <div className="relative border-b border-zinc-800/70 bg-zinc-950/80" style={{ aspectRatio: toAspectRatioValue(job.aspectRatio) }}>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.16),transparent_55%)]" />
        <div className="absolute inset-0 flex flex-col justify-between p-4">
          <div className="flex items-center justify-between gap-2">
            <Badge color={job.status === 'running' ? 'blue' : 'red'}>
              {job.status === 'running' ? 'Generating' : 'Failed'}
            </Badge>
            <span className="text-[10px] font-mono text-zinc-500">{job.aspectRatio} · {job.resolutionTier}</span>
          </div>

          {job.status === 'running' ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Spinner size={18} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-zinc-100">{currentStep}</div>
                  <div className="text-xs text-zinc-500">{elapsedSec}s elapsed · {job.imageModelLabel}</div>
                </div>
              </div>
              <div className="space-y-1.5">
                {GENERATE_STEPS.map((step, idx) => (
                  <div
                    key={step}
                    className={`flex items-center gap-2 text-[11px] ${
                      idx < stepIndex ? 'text-green-400' : idx === stepIndex ? 'text-blue-300' : 'text-zinc-600'
                    }`}
                  >
                    <span className="w-4 text-center">{idx < stepIndex ? '✓' : idx === stepIndex ? '›' : '○'}</span>
                    <span>{step}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2">
              <div className="text-sm font-medium text-red-300">Generation failed</div>
              <div className="mt-1 text-xs text-red-200/80 line-clamp-4">{job.errorMessage || 'Something went wrong'}</div>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2 p-3">
        <div className="text-sm text-zinc-200 line-clamp-3">{job.promptPreview}</div>
        <div className="flex flex-wrap gap-1.5">
          {job.characterName && <Badge color="zinc">{job.characterName}</Badge>}
          <Badge color="zinc">{job.imageModelLabel}</Badge>
        </div>
        {job.status === 'running' ? (
          <div className="text-[11px] text-zinc-500">You can keep editing the prompt and queue the next image.</div>
        ) : (
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => onDismiss?.(job.id)}
              className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

function formReducer(state, action) {
  if (typeof action === 'function') return { ...state, ...action(state) };
  return { ...state, ...action };
}

const _cache = {
  formState: null,
  result: null,
  history: [],
  queueItems: [],
  styleAtomIds: [],
  styleAtomDetails: [],
  activeMods: new Set(),
  contentTab: 'lifestyle',
  selectedFocusId: '',
  enhancedPreview: null,
  suggestedCaptions: [],
  captionDraft: DEFAULT_CAPTION_DRAFT,
  recreateSourceId: null,
};

const GENERATE_PAGE_STORAGE_KEY = 'kyros.generate.pageState';
const GENERATE_QUEUE_STORAGE_KEY = 'kyros.generate.queueItems';

function sanitizeStoredFormState(formState) {
  if (!formState || typeof formState !== 'object') return null;
  const { selectedChar, ...rest } = formState;
  return { ...INITIAL_STATE, ...rest, selectedChar: null };
}

function summarizeStoredResult(result) {
  if (!result || typeof result !== 'object') return null;
  const galleryId = result.galleryId || result.imageId || null;
  if (!galleryId) return null;
  return {
    imageId: result.imageId || galleryId,
    galleryId,
    image: {
      mimeType: result.image?.mimeType || 'image/png',
      validation: result.image?.validation?.identity_match_score != null
        ? { identity_match_score: result.image.validation.identity_match_score }
        : undefined,
    },
  };
}

function readStoredGeneratePageState() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(GENERATE_PAGE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      formState: sanitizeStoredFormState(parsed.formState),
      result: summarizeStoredResult(parsed.result),
      history: Array.isArray(parsed.history) ? parsed.history : [],
      styleAtomIds: Array.isArray(parsed.styleAtomIds) ? parsed.styleAtomIds : [],
      styleAtomDetails: Array.isArray(parsed.styleAtomDetails) ? parsed.styleAtomDetails : [],
      activeMods: new Set(Array.isArray(parsed.activeMods) ? parsed.activeMods : []),
      contentTab: typeof parsed.contentTab === 'string' ? parsed.contentTab : 'lifestyle',
      selectedFocusId: typeof parsed.selectedFocusId === 'string' ? parsed.selectedFocusId : '',
      enhancedPreview: parsed.enhancedPreview && typeof parsed.enhancedPreview === 'object' ? parsed.enhancedPreview : null,
      suggestedCaptions: Array.isArray(parsed.suggestedCaptions) ? parsed.suggestedCaptions : [],
      captionDraft: parsed.captionDraft && typeof parsed.captionDraft === 'object'
        ? { ...DEFAULT_CAPTION_DRAFT, ...parsed.captionDraft }
        : DEFAULT_CAPTION_DRAFT,
      recreateSourceId: typeof parsed.recreateSourceId === 'string' ? parsed.recreateSourceId : null,
    };
  } catch {
    return null;
  }
}

function writeStoredGeneratePageState(cache) {
  if (typeof window === 'undefined') return;
  try {
    const payload = {};
    const formState = sanitizeStoredFormState(cache.formState);
    if (formState) payload.formState = formState;
    const result = summarizeStoredResult(cache.result);
    if (result) payload.result = result;
    if (Array.isArray(cache.history) && cache.history.length > 0) payload.history = cache.history.slice(0, 9);
    if (Array.isArray(cache.styleAtomIds) && cache.styleAtomIds.length > 0) payload.styleAtomIds = cache.styleAtomIds;
    if (Array.isArray(cache.styleAtomDetails) && cache.styleAtomDetails.length > 0) payload.styleAtomDetails = cache.styleAtomDetails;
    if (cache.activeMods instanceof Set && cache.activeMods.size > 0) payload.activeMods = [...cache.activeMods];
    if (cache.contentTab) payload.contentTab = cache.contentTab;
    if (cache.selectedFocusId) payload.selectedFocusId = cache.selectedFocusId;
    if (cache.enhancedPreview?.changed) payload.enhancedPreview = cache.enhancedPreview;
    if (Array.isArray(cache.suggestedCaptions) && cache.suggestedCaptions.length > 0) payload.suggestedCaptions = cache.suggestedCaptions;
    if (cache.captionDraft && Object.values(cache.captionDraft).some(Boolean)) payload.captionDraft = cache.captionDraft;
    if (cache.recreateSourceId) payload.recreateSourceId = cache.recreateSourceId;

    if (Object.keys(payload).length === 0) {
      window.sessionStorage.removeItem(GENERATE_PAGE_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(GENERATE_PAGE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota/private-mode failures and keep in-memory behavior.
  }
}

function readStoredQueueItems() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(GENERATE_QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredQueueItems(items) {
  if (typeof window === 'undefined') return;
  try {
    if (!items || items.length === 0) {
      window.sessionStorage.removeItem(GENERATE_QUEUE_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(GENERATE_QUEUE_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Ignore storage failures (quota/private mode) and keep in-memory behavior.
  }
}

const storedGeneratePageState = readStoredGeneratePageState();
if (storedGeneratePageState) {
  _cache.formState = storedGeneratePageState.formState;
  _cache.result = storedGeneratePageState.result;
  _cache.history = storedGeneratePageState.history;
  _cache.styleAtomIds = storedGeneratePageState.styleAtomIds;
  _cache.styleAtomDetails = storedGeneratePageState.styleAtomDetails;
  _cache.activeMods = storedGeneratePageState.activeMods;
  _cache.contentTab = storedGeneratePageState.contentTab;
  _cache.selectedFocusId = storedGeneratePageState.selectedFocusId;
  _cache.enhancedPreview = storedGeneratePageState.enhancedPreview;
  _cache.suggestedCaptions = storedGeneratePageState.suggestedCaptions;
  _cache.captionDraft = storedGeneratePageState.captionDraft;
  _cache.recreateSourceId = storedGeneratePageState.recreateSourceId;
}
_cache.queueItems = readStoredQueueItems();

const storeListeners = new Set();

function getStoreSnapshot() {
  return {
    result: _cache.result,
    history: _cache.history,
    queueItems: _cache.queueItems,
    enhancedPreview: _cache.enhancedPreview,
    suggestedCaptions: _cache.suggestedCaptions,
  };
}

function emitStoreChange() {
  const snapshot = getStoreSnapshot();
  for (const listener of storeListeners) listener(snapshot);
}

function subscribeToStore(listener) {
  storeListeners.add(listener);
  listener(getStoreSnapshot());
  return () => {
    storeListeners.delete(listener);
  };
}

function setCachedResult(next) {
  _cache.result = typeof next === 'function' ? next(_cache.result) : next;
  writeStoredGeneratePageState(_cache);
  emitStoreChange();
}

function setCachedHistory(next) {
  _cache.history = typeof next === 'function' ? next(_cache.history) : next;
  writeStoredGeneratePageState(_cache);
  emitStoreChange();
}

function setCachedQueueItems(next) {
  _cache.queueItems = typeof next === 'function' ? next(_cache.queueItems) : next;
  writeStoredQueueItems(_cache.queueItems);
  emitStoreChange();
}

function setCachedEnhancedPreview(next) {
  _cache.enhancedPreview = typeof next === 'function' ? next(_cache.enhancedPreview) : next;
  writeStoredGeneratePageState(_cache);
  emitStoreChange();
}

function setCachedSuggestedCaptions(next) {
  _cache.suggestedCaptions = typeof next === 'function' ? next(_cache.suggestedCaptions) : next;
  writeStoredGeneratePageState(_cache);
  emitStoreChange();
}

export default function GeneratePage() {
  const { notify, activeKey, vertexActive, characters: chars, sceneMemories, outfits, consumePageParams } = useApp();
  const autofillCharacterPromptRef = useRef(false);
  const lastAutofilledCharacterIdRef = useRef('');
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const [state, update] = useReducer(formReducer, _cache.formState || INITIAL_STATE);
  const {
    prompt, aspectRatio, resolutionTier,
    imageModel,
    useCharacter, selectedCharId, selectedChar,
    sceneMemoryId, outfitId, cameraProfileId, poseMode,
    useExpressionMode, expressionMode, useSceneMode, sceneMode,
    useExtraReference, extraReference, extraReferencePreview,
    specificOutfitRef, specificItemRef, specificSceneRef,
  } = state;
  const [result, setResult] = useState(_cache.result);
  const [history, setHistory] = useState(_cache.history);
  const [queueItems, setQueueItems] = useState(_cache.queueItems);
  const feedItems = history.filter((h) => h?.imageId);

  const [tplList, setTplList] = useState([]);
  const [tplName, setTplName] = useState('');
  const [showSaveTpl, setShowSaveTpl] = useState(false);

  const [styleAtomIds, setStyleAtomIds] = useState(_cache.styleAtomIds);
  const [styleAtomDetails, setStyleAtomDetails] = useState(_cache.styleAtomDetails);
  const [showAtomPicker, setShowAtomPicker] = useState(false);
  const [stylePreview, setStylePreview] = useState('');

  const [styleFocusList, setStyleFocusList] = useState([]);
  const [selectedFocusId, setSelectedFocusId] = useState(_cache.selectedFocusId);
  const [selectedFocusData, setSelectedFocusData] = useState(null);
  useEffect(() => {
    if (!selectedFocusId) { setSelectedFocusData(null); return; }
    styleFocusApi.get(selectedFocusId).then(setSelectedFocusData).catch(() => setSelectedFocusData(null));
  }, [selectedFocusId]);

  const [activeMods, setActiveMods] = useState(_cache.activeMods);
  const [enhanceEnabled, setEnhanceEnabled] = useState(false);
  const [enhancedPreview, setEnhancedPreview] = useState(_cache.enhancedPreview); // { original, enhanced, changed }

  const [contentPresets, setContentPresets] = useState([]);
  const [contentTab, setContentTab] = useState(_cache.contentTab);

  const [captionList, setCaptionList] = useState([]);
  const [suggestedCaptions, setSuggestedCaptions] = useState(_cache.suggestedCaptions);
  const [showCaptionComposer, setShowCaptionComposer] = useState(false);
  const [captionDraft, setCaptionDraft] = useState(_cache.captionDraft);
  const characterReferencePreviewItems = useMemo(
    () => buildCharacterReferencePreviewItems(selectedCharId, selectedChar),
    [selectedCharId, selectedChar],
  );

  useEffect(() => { _cache.formState = state; }, [state]);
  useEffect(() => { _cache.result = result; }, [result]);
  useEffect(() => { _cache.history = history; }, [history]);
  useEffect(() => { _cache.styleAtomIds = styleAtomIds; }, [styleAtomIds]);
  useEffect(() => { _cache.styleAtomDetails = styleAtomDetails; }, [styleAtomDetails]);
  useEffect(() => { _cache.activeMods = activeMods; }, [activeMods]);
  useEffect(() => { _cache.contentTab = contentTab; }, [contentTab]);
  useEffect(() => { _cache.selectedFocusId = selectedFocusId; }, [selectedFocusId]);
  useEffect(() => { _cache.queueItems = queueItems; }, [queueItems]);
  useEffect(() => { _cache.enhancedPreview = enhancedPreview; }, [enhancedPreview]);
  useEffect(() => { _cache.suggestedCaptions = suggestedCaptions; }, [suggestedCaptions]);
  useEffect(() => { _cache.captionDraft = captionDraft; }, [captionDraft]);
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      writeStoredGeneratePageState(_cache);
    }, 120);
    return () => window.clearTimeout(timeoutId);
  }, [state, styleAtomIds, styleAtomDetails, activeMods, contentTab, selectedFocusId, enhancedPreview, suggestedCaptions, captionDraft, result, history]);

  useEffect(() => subscribeToStore((snapshot) => {
    setResult(snapshot.result);
    setHistory(snapshot.history);
    setQueueItems(snapshot.queueItems);
    setEnhancedPreview(snapshot.enhancedPreview);
    setSuggestedCaptions(snapshot.suggestedCaptions);
  }), []);

  useEffect(() => { templatesApi.list('generate').then(setTplList).catch(() => {}); }, []);
  useEffect(() => { styleFocusApi.list().then(setStyleFocusList).catch(() => {}); }, []);
  useEffect(() => { styleApi.contentPresets().then(setContentPresets).catch(() => {}); }, []);
  useEffect(() => { captionApi.list().then(setCaptionList).catch(() => {}); }, []);

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

  useEffect(() => {
    if (styleAtomIds.length === 0) { setStylePreview(''); return; }
    styleApi.compose(styleAtomIds).then(r => setStylePreview(r.prompt)).catch(() => setStylePreview(''));
  }, [styleAtomIds]);

  const handleApplyAtoms = async (ids) => {
    setStyleAtomIds(ids);
    setShowAtomPicker(false);
    const details = [];
    for (const id of ids) {
      try { const atom = await styleApi.get(id); details.push({ id: atom.id, category: atom.category, text: atom.text }); } catch { }
    }
    setStyleAtomDetails(details);
  };

  const removeStyleAtom = (id) => {
    setStyleAtomIds(prev => prev.filter(x => x !== id));
    setStyleAtomDetails(prev => prev.filter(x => x.id !== id));
  };

  useEffect(() => {
    const raw = sessionStorage.getItem('pb_atomIds');
    if (!raw) return;
    sessionStorage.removeItem('pb_atomIds');
    try {
      const ids = JSON.parse(raw);
      if (Array.isArray(ids) && ids.length > 0) handleApplyAtoms(ids);
    } catch { }
    const ar = sessionStorage.getItem('pb_aspectRatio');
    const res = sessionStorage.getItem('pb_resolutionTier');
    if (ar) { update({ aspectRatio: ar }); sessionStorage.removeItem('pb_aspectRatio'); }
    if (res) { update({ resolutionTier: res }); sessionStorage.removeItem('pb_resolutionTier'); }
  }, []);

  const [recreateSourceId, setRecreateSourceId] = useState(_cache.recreateSourceId);
  useEffect(() => {
    _cache.recreateSourceId = recreateSourceId;
    writeStoredGeneratePageState(_cache);
  }, [recreateSourceId]);

  useEffect(() => {
    const params = consumePageParams();
    if (params.recreate) {
      const changes = {};
      if (params.prompt) changes.prompt = params.prompt;
      if (params.aspectRatio) changes.aspectRatio = params.aspectRatio;
      if (params.characterId) {
        changes.useCharacter = true;
        changes.selectedCharId = params.characterId;
      }
      if (params.sourceImageId) setRecreateSourceId(params.sourceImageId);
      if (Object.keys(changes).length > 0) update(changes);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!selectedCharId) {
      autofillCharacterPromptRef.current = false;
      lastAutofilledCharacterIdRef.current = '';
      update({ selectedChar: null });
      return () => {
        cancelled = true;
      };
    }

    const cachedCharacter = chars.find((entry) => entry.id === selectedCharId) || null;
    if (cachedCharacter) {
      update((prev) => {
        const masterPrompt = String(cachedCharacter.masterPrompt || '').trim();
        const shouldAutofill = autofillCharacterPromptRef.current
          || (!String(prev.prompt || '').trim() && lastAutofilledCharacterIdRef.current !== selectedCharId);
        const next = { selectedChar: cachedCharacter };
        if (shouldAutofill && masterPrompt) {
          next.prompt = masterPrompt;
          lastAutofilledCharacterIdRef.current = selectedCharId;
        }
        return next;
      });
      autofillCharacterPromptRef.current = false;
    }

    charApi.get(selectedCharId)
      .then((d) => {
        if (cancelled) return;
        update((prev) => {
          const next = { selectedChar: d };
          const masterPrompt = String(d?.masterPrompt || '').trim();
          const shouldAutofill = autofillCharacterPromptRef.current
            || (!String(prev.prompt || '').trim() && lastAutofilledCharacterIdRef.current !== selectedCharId);
          if (shouldAutofill && masterPrompt) {
            next.prompt = masterPrompt;
            lastAutofilledCharacterIdRef.current = selectedCharId;
          }
          return next;
        });
        autofillCharacterPromptRef.current = false;
      })
      .catch(() => {
        if (cancelled) return;
        autofillCharacterPromptRef.current = false;
        update({ selectedChar: null });
      });

    return () => {
      cancelled = true;
    };
  }, [selectedCharId, chars]);
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

  const dismissQueueItem = (queueId) => {
    setCachedQueueItems((prev) => prev.filter((job) => job.id !== queueId));
  };

  const handleCharacterSelect = (nextCharId) => {
    autofillCharacterPromptRef.current = Boolean(nextCharId);
    update((prev) => {
      const cachedCharacter = chars.find((entry) => entry.id === nextCharId) || null;
      const next = {
        selectedCharId: nextCharId,
        selectedChar: cachedCharacter,
      };
      const masterPrompt = String(cachedCharacter?.masterPrompt || '').trim();
      if (nextCharId && masterPrompt) {
        next.prompt = masterPrompt;
        lastAutofilledCharacterIdRef.current = nextCharId;
      } else if (!nextCharId && prev.selectedCharId) {
        lastAutofilledCharacterIdRef.current = '';
      }
      return next;
    });
  };

  const handleQuickContentTypeToggle = (contentTypeKey) => {
    update((prev) => {
      if (prev.quickContentType === contentTypeKey) {
        const defaults = SMART_DEFAULTS[contentTypeKey];
        const next = { quickContentType: '' };
        if (matchesQuickDefaults(prev, defaults)) {
          next.cameraProfileId = '';
          next.poseMode = 'none';
          next.useExpressionMode = false;
          next.expressionMode = 'none';
          next.useSceneMode = false;
          next.sceneMode = 'none';
        }
        return next;
      }

      const defaults = SMART_DEFAULTS[contentTypeKey];
      return {
        quickContentType: contentTypeKey,
        ...(defaults ? {
          cameraProfileId: defaults.cameraProfileId,
          poseMode: defaults.poseMode,
          useExpressionMode: defaults.expressionMode !== 'none',
          expressionMode: defaults.expressionMode,
          useSceneMode: defaults.sceneMode !== 'none',
          sceneMode: defaults.sceneMode,
        } : {}),
      };
    });
  };

  const handleGenerate = async () => {
    setCachedEnhancedPreview(null);
    if (!prompt.trim() && !selectedCharId) { notify('Enter a prompt or select a character', 'error'); return; }
    const queueId = globalThis.crypto?.randomUUID?.() || `generate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const imageModelLabel = IMAGE_MODEL_OPTIONS.find((opt) => opt.value === imageModel)?.label || imageModel;
    const promptPreview = prompt.trim() || (selectedChar?.name ? `Generate ${selectedChar.name}` : 'Character generation');

    pushPending({ id: queueId, prompt: promptPreview, imageModel: imageModelLabel, aspectRatio, resolutionTier });

    setCachedQueueItems((prev) => [
      {
        id: queueId,
        status: 'running',
        promptPreview,
        aspectRatio,
        resolutionTier,
        imageModelLabel,
        characterName: useCharacter && selectedChar?.name ? selectedChar.name : '',
      },
      ...prev.slice(0, 5),
    ]);

    let finalPrompt = prompt.trim();
    if (activeMods.size > 0) {
      const modTexts = AUTHENTICITY_MODIFIERS.filter(m => activeMods.has(m.id)).map(m => m.text);
      finalPrompt = finalPrompt ? `${finalPrompt}\n${modTexts.join('. ')}` : modTexts.join('. ');
    }
    // Prompt enhancement step (opt-in)
    if (enhanceEnabled && finalPrompt.length >= 5) {
      try {
        const enhanceResult = await genApi.enhancePrompt({
          prompt: finalPrompt,
          characterName: selectedChar?.name || null,
          characterId: selectedCharId || null,
          hasReferences: !!(selectedChar?.references?.some((r) => r.isActive)),
        });
        if (enhanceResult?.changed && enhanceResult.enhanced) {
          setCachedEnhancedPreview(enhanceResult);
          finalPrompt = enhanceResult.enhanced;
        }
      } catch {
        // Enhancement failed — continue with original prompt
      }
    }
    const body = {
      prompt: finalPrompt,
      aspectRatio,
      resolutionTier,
      imageModel,
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
    try {
      const data = await genApi.image(body);
      setCachedQueueItems((prev) => prev.filter((job) => job.id !== queueId));
      setCachedResult(data);
      setRecreateSourceId(null);
      const feedItem = {
        imageId: data.imageId,
        galleryId: data.galleryId || data.imageId,
        mimeType: data.image?.mimeType,
        identityConfidence: data.image?.validation?.identity_match_score,
        prompt: finalPrompt || '',
        imageModel: imageModel || '',
        aspectRatio: aspectRatio || '',
        resolutionTier: resolutionTier || '',
        generatedAt: Date.now(),
        characterId: useCharacter ? (selectedCharId || null) : null,
      };
      resolvePending(queueId, feedItem);
      setCachedHistory((h) => [feedItem, ...h].slice(0, 50));
      notify('Image generated!', 'success');
      captionApi.suggest(contentTab || 'lifestyle', 3).then((items) => {
        setCachedSuggestedCaptions(items);
      }).catch(() => {});
    } catch (err) {
      rejectPending(queueId);
      setCachedQueueItems((prev) => prev.map((job) => (
        job.id === queueId
          ? { ...job, status: 'error', errorMessage: err?.message || 'Failed to generate image' }
          : job
      )));
      notify(err?.message || 'Failed to generate image', 'error');
    }
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
  const activeQueueCount = queueItems.filter((job) => job.status === 'running').length;
  return (
    <div className="space-y-6 animate-in">
      {!activeKey && !vertexActive && (
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

      <div className="max-w-[420px]">
        <div className="xl:sticky xl:top-5">
          <Card className="!p-0 overflow-hidden border border-zinc-800/70 bg-zinc-950/90 shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
            <div className="border-b border-zinc-800/70 bg-[linear-gradient(180deg,rgba(35,38,45,0.96),rgba(18,19,24,0.96))] px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Image Generator</div>
                  <h3 className="mt-1 text-lg font-semibold text-zinc-100">Generate</h3>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                    Prompt, queue, and keep building while your live feed stays pinned on the right.
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <Badge color={activeQueueCount > 0 ? 'blue' : 'zinc'}>
                    {activeQueueCount > 0 ? `${activeQueueCount} running` : `${feedItems.length} result${feedItems.length === 1 ? '' : 's'}`}
                  </Badge>
                  <span className="text-[10px] font-mono text-zinc-500">{state.aspectRatio} · {state.resolutionTier}</span>
                </div>
              </div>
            </div>

            <div className="space-y-4 p-4 xl:max-h-[calc(100vh-140px)] xl:overflow-y-auto">
              <div className="flex items-center justify-between gap-3">
                <div className="flex rounded-xl bg-zinc-900/80 p-1 border border-zinc-800/60">
                  {[['quick', 'Quick'], ['advanced', 'Advanced']].map(([m, label]) => (
                    <button
                      key={m}
                      onClick={() => update({ formMode: m })}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${
                        state.formMode === m ? 'bg-blue-600 text-white shadow-[0_10px_24px_rgba(37,99,235,0.35)]' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] text-zinc-500">
                  {state.formMode === 'quick' ? 'Fast setup' : 'Full controls'}
                </span>
              </div>

              <div className="space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Model</span>
                <select
                  value={imageModel}
                  onChange={(e) => update({ imageModel: e.target.value })}
                  className="w-full rounded-xl border border-zinc-700/80 bg-zinc-900/80 px-3 py-3 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
                >
                  {IMAGE_MODEL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => update({ useCharacter: !useCharacter })}
                  className={`rounded-xl border px-3 py-3 text-left transition cursor-pointer ${
                    useCharacter ? 'border-blue-500/50 bg-blue-500/10 text-blue-200' : 'border-zinc-800/80 bg-zinc-900/70 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                  }`}
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em]">Character</div>
                  <div className="mt-1 text-xs">{useCharacter ? (selectedChar?.name || 'Enabled') : 'Off'}</div>
                </button>
                <button
                  type="button"
                  onClick={() => setShowAtomPicker(true)}
                  className="rounded-xl border border-zinc-800/80 bg-zinc-900/70 px-3 py-3 text-left text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 cursor-pointer"
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em]">Style</div>
                  <div className="mt-1 text-xs">{styleAtomIds.length > 0 ? `${styleAtomIds.length} picked` : 'Library'}</div>
                </button>
                <button
                  type="button"
                  onClick={() => update({ formMode: state.formMode === 'quick' ? 'advanced' : 'quick' })}
                  className="rounded-xl border border-zinc-800/80 bg-zinc-900/70 px-3 py-3 text-left text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 cursor-pointer"
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em]">Controls</div>
                  <div className="mt-1 text-xs">{state.formMode === 'quick' ? 'Essential' : 'Detailed'}</div>
                </button>
              </div>

              <div className="space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Prompt</span>
                <Textarea
                  label={null}
                  placeholder="Describe the image you want to generate..."
                  value={prompt}
                  onChange={(e) => update({ prompt: e.target.value })}
                  className="!min-h-[180px] !rounded-xl !border-zinc-700/80 !bg-zinc-900/80"
                />
              </div>

              <div className="flex items-center justify-between rounded-xl border border-zinc-800/70 bg-zinc-900/60 px-3 py-2.5">
                <Toggle checked={enhanceEnabled} onChange={setEnhanceEnabled} label="AI Prompt Assist" />
                <span className="text-[10px] text-zinc-500">{enhanceEnabled ? 'On' : 'Off'}</span>
              </div>

              <div className="space-y-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/45 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Character Lock</div>
                    <div className="mt-1 text-xs text-zinc-400">Use identity references automatically.</div>
                  </div>
                  <Toggle checked={useCharacter} onChange={(v) => update({ useCharacter: v })} label={null} />
                </div>

                {useCharacter && (
                  <div className="space-y-3">
                    <select
                      value={selectedCharId}
                      onChange={(e) => handleCharacterSelect(e.target.value)}
                      className="w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
                    >
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

                    {characterReferencePreviewItems.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium text-zinc-400">Loaded references</span>
                          <span className="text-[10px] text-zinc-500">{characterReferencePreviewItems.length} active</span>
                        </div>
                        <div className="grid grid-cols-4 gap-2">
                          {characterReferencePreviewItems.map((item, index) => (
                            <button
                              key={item.key}
                              type="button"
                              onClick={() => openLightbox(characterReferencePreviewItems.map((entry) => entry.src), index)}
                              className="relative aspect-square overflow-hidden rounded-xl border border-zinc-700/70 bg-zinc-950/80 transition hover:border-zinc-500 cursor-pointer"
                              title={item.label}
                            >
                              <img src={item.src} alt={item.label} className="h-full w-full object-cover" loading="lazy" />
                              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4">
                                <span className="block truncate text-[10px] text-zinc-200">{item.label}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="space-y-2 rounded-xl border border-zinc-800/70 bg-zinc-950/60 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Scene Reference</div>
                          <div className="mt-1 text-[11px] text-zinc-500">Optional second image for scene or composition.</div>
                        </div>
                        <Toggle checked={useExtraReference} onChange={(v) => update({ useExtraReference: v })} label={null} />
                      </div>

                      {useExtraReference && (
                        <>
                          <label className={`flex items-center justify-center border border-dashed rounded-xl transition h-28 overflow-hidden bg-zinc-900/50 ${selectedCharId ? 'border-zinc-700/80 cursor-pointer hover:border-zinc-500' : 'border-zinc-800 cursor-not-allowed opacity-70'}`}>
                            {extraReferencePreview ? (
                              <img src={extraReferencePreview} alt="Extra reference" className="max-h-full max-w-full object-contain" />
                            ) : (
                              <div className="text-center">
                                <div className="text-zinc-300 text-sm">Add second image</div>
                                <div className="text-zinc-500 text-xs mt-1">Character keeps identity, scene follows this image</div>
                              </div>
                            )}
                            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleExtraReferenceUpload} disabled={!selectedCharId} />
                          </label>
                          {!selectedCharId && (
                            <div className="text-xs text-zinc-500">Select a character first to use this upload.</div>
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
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500 block mb-2">Aspect Ratio</span>
                  <div className="flex flex-wrap gap-1.5">
                    {ASPECT_RATIOS.map((ar) => (
                      <button
                        key={ar}
                        onClick={() => update({ aspectRatio: ar })}
                        className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition cursor-pointer ${aspectRatio === ar ? 'bg-blue-600 text-white shadow-[0_10px_24px_rgba(37,99,235,0.35)]' : 'bg-zinc-800/70 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'}`}
                      >
                        {ar}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500 block mb-2">Resolution</span>
                  <div className="flex flex-wrap gap-1.5">
                    {RESOLUTION_TIERS.map((tier) => (
                      <button
                        key={tier}
                        onClick={() => update({ resolutionTier: tier })}
                        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${resolutionTier === tier ? 'bg-blue-500 text-white shadow-[0_10px_24px_rgba(37,99,235,0.35)]' : 'bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700'}`}
                      >
                        {tier}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {state.formMode === 'quick' && (
                <div className="space-y-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500 block">Content Type</span>
                  <div className="grid grid-cols-2 gap-2">
                    {CONTENT_TYPES.map(ct => (
                      <button
                        key={ct.key}
                        onClick={() => handleQuickContentTypeToggle(ct.key)}
                        className={`rounded-xl px-3 py-3 text-left transition cursor-pointer border ${
                          state.quickContentType === ct.key
                            ? 'border-blue-500/50 bg-blue-500/12'
                            : 'border-zinc-800/70 bg-zinc-900/55 hover:border-zinc-700'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className={`text-xs font-medium ${state.quickContentType === ct.key ? 'text-blue-300' : 'text-zinc-300'}`}>{ct.label}</span>
                          <span className="text-[10px] text-zinc-600">{ct.pct}%</span>
                        </div>
                        <span className="mt-1 block text-[10px] leading-relaxed text-zinc-500">{ct.desc}</span>
                      </button>
                    ))}
                  </div>
                  {state.quickContentType && (
                    <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/50 px-3 py-2 text-[11px] text-zinc-500">
                      Auto-configured from this preset: {SMART_DEFAULTS[state.quickContentType] && `Camera ${CAMERA_PROFILES.find(c => c.value === SMART_DEFAULTS[state.quickContentType].cameraProfileId)?.label || '—'}, Pose ${POSE_MODES.find(p => p.value === SMART_DEFAULTS[state.quickContentType].poseMode)?.label || '—'}`}
                    </div>
                  )}
                </div>
              )}

              {state.formMode === 'advanced' && <>
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
                      {(() => {
                        const charOutfits = outfits.filter((o) => o.characterId && o.characterId === selectedCharId);
                        const shared = outfits.filter((o) => !o.characterId);
                        const other = outfits.filter((o) => o.characterId && o.characterId !== selectedCharId);
                        return (<>
                          {charOutfits.length > 0 && <optgroup label="Character Wardrobe">{charOutfits.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</optgroup>}
                          {shared.length > 0 && <optgroup label="Shared">{shared.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</optgroup>}
                          {other.length > 0 && <optgroup label="Other Characters">{other.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</optgroup>}
                          {charOutfits.length === 0 && shared.length === 0 && other.length === 0 && outfits.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </>);
                      })()}
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
                <Btn onClick={handleGenerate} disabled={!prompt.trim() && !selectedCharId} className="w-full !rounded-xl !py-3.5">
                  {activeQueueCount > 0
                    ? `✦ Queue Another · ${activeQueueCount} running`
                    : `✦ Generate Image · ~$${state.resolutionTier === '4K' ? '0.15' : state.resolutionTier === '1K' ? '0.07' : '0.10'}`}
                </Btn>
                {activeQueueCount > 0 && (
                  <p className="mt-2 text-[11px] text-zinc-500">Keep generating while earlier images are still processing.</p>
                )}
                {enhancedPreview?.changed && (
                  <div className="mt-2 rounded-xl border border-blue-500/20 bg-blue-500/5 p-2.5 text-xs space-y-1.5">
                    <div className="flex items-center gap-1.5 text-blue-400 font-medium">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                      Prompt Enhanced
                    </div>
                    <p className="text-zinc-400 line-through">{enhancedPreview.original.slice(0, 120)}...</p>
                    <p className="text-zinc-200">{enhancedPreview.enhanced.slice(0, 200)}...</p>
                  </div>
                )}
              </div>
            </div>
          </Card>
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
