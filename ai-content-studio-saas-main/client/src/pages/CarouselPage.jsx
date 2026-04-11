import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { pushToFeed, pushPending, resolvePending, rejectPending } from '../lib/generationFeed';
import {
  gallery as galleryApi,
  characters as charApi,
  carousel as carouselApi,
  batch as batchApi,
} from '../services/api';
import { useApp } from '../context/AppContext';
import { useStepTimer } from '../hooks/useStepTimer';
import { Card, Btn, Spinner, ImageCard, Empty, Badge, Toggle, StepProgress, CopyBtn } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { RESOLUTION_TIERS, ASPECT_RATIOS_COMPACT as ASPECT_RATIOS, IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL, DEFAULT_RESOLUTION_TIER } from '../config/photoModes';

const CAROUSEL_MODES = [
  { key: 'follow-up', label: 'Follow-Up' },
  { key: 'polls', label: 'Polls' },
];

const DEFAULT_CAROUSEL_ASPECT_RATIO = '4:5';

function mergeJobSnapshots(prevJobs, fetchedJobs, expectedIds) {
  const prevMap = new Map((Array.isArray(prevJobs) ? prevJobs : []).map((job) => [job.jobId, job]));
  const fetchedMap = new Map((Array.isArray(fetchedJobs) ? fetchedJobs : []).map((job) => [job.jobId, job]));

  const orderedIds = Array.isArray(expectedIds) && expectedIds.length > 0
    ? expectedIds
    : Array.from(new Set([
      ...Array.from(prevMap.keys()),
      ...Array.from(fetchedMap.keys()),
    ]));

  return orderedIds
    .map((jobId) => fetchedMap.get(jobId) || prevMap.get(jobId))
    .filter(Boolean);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function resultToSrc(result) {
  if (!result) return null;
  if (result.image?.base64Data) {
    return `data:${result.image.mimeType || 'image/png'};base64,${result.image.base64Data}`;
  }
  const galleryId = result.galleryId || result.imageId;
  return galleryId ? `/api/gallery/${galleryId}/image` : null;
}

function CarouselResultCard({ title, prompt, status, src, error, onOpen }) {
  const isDone = status === 'done';
  const isError = status === 'error';

  return (
    <Card className="!p-0 overflow-hidden">
      <div className="relative aspect-[4/5] bg-zinc-950 border-b border-zinc-800/70">
        {isDone && src ? (
          <img
            src={src}
            alt={title}
            className="h-full w-full object-cover cursor-pointer transition-transform duration-300 hover:scale-[1.02]"
            onClick={onOpen}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <div className={`h-12 w-12 rounded-2xl border ${isError ? 'border-red-500/30 bg-red-500/10' : 'border-zinc-700/60 bg-zinc-800/70'} flex items-center justify-center`}>
              {isError ? (
                <span className="text-lg text-red-300">!</span>
              ) : (
                <div className="h-5 w-5 rounded-full border-2 border-blue-500/30 border-t-blue-400 animate-spin" />
              )}
            </div>
            <div className="w-24 h-2 rounded-full bg-zinc-800/80 overflow-hidden">
              {!isError ? <div className="h-full w-1/2 bg-blue-500/50 animate-pulse" /> : null}
            </div>
          </div>
        )}
        <div className="absolute left-3 top-3">
          <Badge color={isDone ? 'green' : isError ? 'red' : 'blue'}>
            {isDone ? 'Ready' : isError ? 'Failed' : 'Generating'}
          </Badge>
        </div>
      </div>
      <div className="space-y-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-100">{title}</p>
            <p className={`mt-1 text-xs leading-relaxed ${isError ? 'text-red-300/80' : 'text-zinc-500'} line-clamp-3`}>
              {isError ? error || 'Generation failed' : prompt}
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

const _cache = {
  executeJobIds: [],
  executeJobs: [],
  completedSlides: [],
  followUpDrafts: [],
  pollJobIds: [],
  pollJobs: [],
  completedPollSlides: [],
  pollResults: null,
  selectedImageId: null,
  uploadedImages: [],
  characterId: '',
  aspectRatio: DEFAULT_CAROUSEL_ASPECT_RATIO,
  resolutionTier: DEFAULT_RESOLUTION_TIER,
  followUpDirection: '',
  followUpMode: 'manual',
  followUpCount: 4,
  carouselMode: 'follow-up',
  pollTopic: '',
  pollCount: 3,
  imageModel: DEFAULT_IMAGE_MODEL,
};

export default function CarouselPage() {
  const { notify, characters: chars, consumePageParams } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();
  const lastAutofilledCarouselCharIdRef = useRef('');

  const [selectedImageId, setSelectedImageId] = useState(_cache.selectedImageId);
  const [galleryImages, setGalleryImages] = useState([]);
  const [uploadedImages, setUploadedImages] = useState(_cache.uploadedImages);
  const [loadingGallery, setLoadingGallery] = useState(true);

  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio || DEFAULT_CAROUSEL_ASPECT_RATIO);
  const [resolutionTier, setResolutionTier] = useState(_cache.resolutionTier);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [kineticMotionBlur, setKineticMotionBlur] = useState(_cache.kineticMotionBlur || 'off');

  const [characterId, setCharacterId] = useState(_cache.characterId);
  const [characterDetail, setCharacterDetail] = useState(null);

  const [followUpLoading, setFollowUpLoading] = useState(false);
  const [executeJobIds, setExecuteJobIds] = useState(_cache.executeJobIds);
  const [executeJobs, setExecuteJobs] = useState(_cache.executeJobs);
  const [completedSlides, setCompletedSlides] = useState(_cache.completedSlides);
  const [followUpDrafts, setFollowUpDrafts] = useState(_cache.followUpDrafts);
  const [followUpCount, setFollowUpCount] = useState(_cache.followUpCount);
  const [followUpDirection, setFollowUpDirection] = useState(_cache.followUpDirection);
  const [followUpMode, setFollowUpMode] = useState(_cache.followUpMode);
  const [strictContinuityLock, setStrictContinuityLock] = useState(false);
  const [useCharacterRefsInFollowUp, setUseCharacterRefsInFollowUp] = useState(false);

  const [carouselMode, setCarouselMode] = useState(_cache.carouselMode);

  const [pollTopic, setPollTopic] = useState(_cache.pollTopic);
  const [pollCount, setPollCount] = useState(_cache.pollCount);
  const [pollLoading, setPollLoading] = useState(false);
  const [pollResults, setPollResults] = useState(_cache.pollResults);
  const [pollJobs, setPollJobs] = useState(_cache.pollJobs);
  const [pollJobIds, setPollJobIds] = useState(_cache.pollJobIds);
  const [completedPollSlides, setCompletedPollSlides] = useState(_cache.completedPollSlides);

  useEffect(() => { Object.assign(_cache, {
    executeJobIds, executeJobs, completedSlides, followUpDrafts, pollJobIds, pollJobs,
    completedPollSlides, pollResults, selectedImageId, uploadedImages,
    characterId, aspectRatio, resolutionTier, imageModel, followUpDirection,
    followUpMode, followUpCount, carouselMode, pollTopic, pollCount, kineticMotionBlur,
  }); });

  useEffect(() => {
    const params = consumePageParams();
    if (params.recreate) {
      setAspectRatio(params.aspectRatio || DEFAULT_CAROUSEL_ASPECT_RATIO);
      if (params.sourceImageId) setSelectedImageId(params.sourceImageId);
    }
  }, []);

  const selectableImages = [...uploadedImages, ...galleryImages];
  const selectedImage = selectableImages.find((img) => img.id === selectedImageId);
  const selectedImageSrc = selectedImage
    ? (selectedImage.src || `/api/gallery/${selectedImage.id}/image`)
    : null;

  const isAnyJobRunning = executeJobs.some((job) => job?.status === 'running');

  const pushedToFeedRef = useRef(new Set());

  const followUpCards = useMemo(() => {
    if (!Array.isArray(followUpDrafts) || followUpDrafts.length === 0) return [];

    const jobsById = new Map((executeJobs || []).map((job) => [job.jobId, job]));
    return followUpDrafts.map((draft, index) => {
      const job = draft.jobId ? jobsById.get(draft.jobId) : null;
      const resultIndex = draft.mode === 'ai' ? 0 : index;
      const result = job?.results?.find((entry) => entry && entry.index === resultIndex);
      const src = resultToSrc(result);

      let status = 'pending';
      let error = '';
      if (src) {
        status = 'done';
      } else if (result?.error) {
        status = 'error';
        error = result.error;
      } else if (job?.status === 'failed') {
        status = 'error';
        error = 'Generation failed';
      } else if (job?.status === 'running' || followUpLoading) {
        status = 'running';
      }

      return { ...draft, status, error, src, _result: result };
    });
  }, [executeJobs, followUpDrafts, followUpLoading]);

  // Sync followUpCards → generation feed (must be useEffect, not useMemo)
  useEffect(() => {
    if (!Array.isArray(followUpCards) || followUpCards.length === 0) return;
    for (const card of followUpCards) {
      const pendingId = `carousel-followup-${card.id}`;
      if (card.status === 'done' && card.src) {
        const resolveKey = `resolved-${pendingId}`;
        if (!pushedToFeedRef.current.has(resolveKey)) {
          pushedToFeedRef.current.add(resolveKey);
          const feedGalleryId = card._result?.galleryId || card._result?.imageId;
          if (feedGalleryId) {
            resolvePending(pendingId, {
              imageId: feedGalleryId,
              galleryId: feedGalleryId,
              mimeType: card._result?.image?.mimeType || 'image/png',
              prompt: card.prompt || card.title || 'Carousel slide',
              imageModel: imageModel || '',
              aspectRatio,
              resolutionTier,
              generatedAt: Date.now(),
            });
          }
        }
      } else if (card.status === 'error') {
        const rejectKey = `rejected-${pendingId}`;
        if (!pushedToFeedRef.current.has(rejectKey)) {
          pushedToFeedRef.current.add(rejectKey);
          rejectPending(pendingId);
        }
      }
    }
  }, [followUpCards, imageModel, aspectRatio, resolutionTier]);

  useEffect(() => {
    let cancelled = false;
    if (!characterId) {
      lastAutofilledCarouselCharIdRef.current = '';
      setCharacterDetail(null);
      return () => {
        cancelled = true;
      };
    }

    const cachedCharacter = chars.find((entry) => entry.id === characterId) || null;
    if (cachedCharacter) {
      setCharacterDetail(cachedCharacter);
      const masterPrompt = String(cachedCharacter.masterPrompt || '').trim();
      if (carouselMode === 'follow-up' && !String(followUpDirection || '').trim() && lastAutofilledCarouselCharIdRef.current !== characterId && masterPrompt) {
        setFollowUpDirection(masterPrompt);
        lastAutofilledCarouselCharIdRef.current = characterId;
      }
    }

    charApi.get(characterId).then((detail) => {
      if (cancelled) return;
      setCharacterDetail(detail);
      const masterPrompt = String(detail?.masterPrompt || '').trim();
      if (carouselMode === 'follow-up' && !String(followUpDirection || '').trim() && lastAutofilledCarouselCharIdRef.current !== characterId && masterPrompt) {
        setFollowUpDirection(masterPrompt);
        lastAutofilledCarouselCharIdRef.current = characterId;
      }
    }).catch(() => {
      if (!cancelled) setCharacterDetail(null);
    });

    return () => {
      cancelled = true;
    };
  }, [characterId, chars, carouselMode, followUpDirection]);

  const handleCarouselCharacterChange = (nextCharId) => {
    const cachedCharacter = chars.find((entry) => entry.id === nextCharId) || null;
    setCharacterId(nextCharId);
    setCharacterDetail(cachedCharacter);

    if (!nextCharId) {
      lastAutofilledCarouselCharIdRef.current = '';
      return;
    }

    if (carouselMode === 'follow-up') {
      const masterPrompt = String(cachedCharacter?.masterPrompt || '').trim();
      if (masterPrompt) {
        setFollowUpDirection(masterPrompt);
        lastAutofilledCarouselCharIdRef.current = nextCharId;
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    const loadGallery = async () => {
      setLoadingGallery(true);
      try {
        const res = await galleryApi.list({ limit: 30 });
        if (!cancelled) setGalleryImages(res.images || res || []);
      } catch {
        if (!cancelled) setGalleryImages([]);
      } finally {
        if (!cancelled) setLoadingGallery(false);
      }
    };
    loadGallery();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!Array.isArray(executeJobIds) || executeJobIds.length === 0) {
      return undefined;
    }

    let cancelled = false;
    let intervalId = null;
    const fetchJobs = async () => {
      try {
        const jobs = await Promise.all(executeJobIds.map((jobId) => batchApi.get(jobId).catch(() => null)));
        if (!cancelled) {
          const filtered = jobs.filter(Boolean);
          setExecuteJobs((prev) => mergeJobSnapshots(prev, filtered, executeJobIds));
          if (filtered.length > 0 && filtered.every((j) => j.status !== 'running')) {
            clearInterval(intervalId);
          }
        }
      } catch {
      }
    };

    fetchJobs();
    intervalId = setInterval(fetchJobs, 2000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [executeJobIds]);

  useEffect(() => {
    if (!Array.isArray(pollJobIds) || pollJobIds.length === 0) return undefined;
    let cancelled = false;
    let intervalId = null;
    const fetchPollJobs = async () => {
      try {
        const jobs = await Promise.all(pollJobIds.map(id => batchApi.get(id).catch(() => null)));
        if (!cancelled) {
          const filtered = jobs.filter(Boolean);
          setPollJobs((prev) => mergeJobSnapshots(prev, filtered, pollJobIds));
          if (filtered.length > 0 && filtered.every(j => j.status !== 'running')) {
            clearInterval(intervalId);
          }
        }
      } catch { }
    };
    fetchPollJobs();
    intervalId = setInterval(fetchPollJobs, 2000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [pollJobIds]);

  const isPollJobRunning = pollJobs.some(j => j?.status === 'running');

  useEffect(() => {
    setCompletedSlides(prev => {
      const existing = new Set(prev.map(s => s._key));
      const additions = [];
      for (const job of executeJobs) {
        for (const r of (job.results || [])) {
          if (!r?.success) continue;
          const key = `${job.jobId}-${r.index}`;
          if (existing.has(key)) continue;
          const galleryId = r.galleryId || r.imageId;
          if (r.image?.base64Data) {
            additions.push({ _key: key, index: r.index, image: { ...r.image } });
          } else if (galleryId) {
            additions.push({ _key: key, index: r.index, galleryId });
          }
          // Push to generation feed
          if (!pushedToFeedRef.current.has(key)) {
            pushedToFeedRef.current.add(key);
            const feedGalleryId = r.galleryId || r.imageId;
            if (feedGalleryId) {
              pushToFeed({
                id: key,
                status: 'done',
                imageId: feedGalleryId,
                galleryId: feedGalleryId,
                mimeType: r.image?.mimeType || 'image/png',
                prompt: r.prompt || 'Carousel slide',
                imageModel: imageModel || '',
                aspectRatio,
                resolutionTier,
                generatedAt: Date.now(),
              });
            }
          }
        }
      }
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  }, [executeJobs, imageModel, aspectRatio, resolutionTier]);

  useEffect(() => {
    setCompletedPollSlides(prev => {
      const existing = new Set(prev.map(s => s._key));
      const additions = [];
      for (const job of pollJobs) {
        for (const r of (job.results || [])) {
          if (!r?.success) continue;
          const key = `${job.jobId}-${r.index}`;
          if (existing.has(key)) continue;
          const galleryId = r.galleryId || r.imageId;
          if (r.image?.base64Data) {
            additions.push({ _key: key, index: r.index, image: { ...r.image } });
          } else if (galleryId) {
            additions.push({ _key: key, index: r.index, galleryId });
          }
        }
      }
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  }, [pollJobs]);

  const FOLLOW_STEPS = useMemo(() => ['Analyzing source image', 'Generating follow-up variations'], []);
  const FOLLOW_THRESHOLDS = useMemo(() => [3], []);
  const JOBS_THRESHOLDS = useMemo(() => [5], []);

  const { elapsedSec: followUpElapsedSec, stepIndex: followStepIndex } = useStepTimer(followUpLoading, FOLLOW_THRESHOLDS);
  const { elapsedSec: jobsElapsedSec } = useStepTimer(isAnyJobRunning, JOBS_THRESHOLDS);

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const src = await fileToDataUrl(file);
      const tempId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const uploaded = { id: tempId, src, prompt: file.name, source: 'upload' };
      setUploadedImages((prev) => [uploaded, ...prev]);
      setSelectedImageId(tempId);
    } catch {
      notify('Failed to read file', 'error');
    } finally {
      event.target.value = '';
    }
  };

  const handleFollowUpCarousel = async () => {
    if (!selectedImageId) {
      notify('Select a base image first', 'error');
      return;
    }

    const countInt = Number.parseInt(String(followUpCount), 10);
    if (!Number.isInteger(countInt) || countInt < 1 || countInt > 10) {
      notify('Follow-up count must be between 1 and 10', 'error');
      return;
    }

    setCompletedSlides([]);
    setExecuteJobs([]);
    setExecuteJobIds([]);
    const promptSummary = followUpDirection.trim() || selectedImage?.prompt || 'Follow-up variation';
    const draftSeed = Date.now();
    setFollowUpDrafts(
      Array.from({ length: countInt }, (_, index) => ({
        id: `${draftSeed}-${index}`,
        index,
        title: followUpMode === 'ai' ? `AI Variation ${index + 1}` : `Variation ${index + 1}`,
        prompt: followUpMode === 'ai' ? (followUpDirection.trim() || 'AI decides a new framing, pose, and expression from the source image') : promptSummary,
        mode: followUpMode,
        jobId: null,
      })),
    );
    // Push pending skeletons immediately so feed shows spinners while generating
    Array.from({ length: countInt }, (_, index) => {
      pushPending({
        id: `carousel-followup-${draftSeed}-${index}`,
        prompt: promptSummary,
        imageModel: imageModel || '',
        aspectRatio,
        resolutionTier,
      });
    });
    setFollowUpLoading(true);
    try {
      const data = await carouselApi.followUp({
        imageId: selectedImageId,
        imageBase64: selectedImage?.src?.startsWith('data:image/') ? selectedImage.src : undefined,
        mimeType: selectedImage?.src?.startsWith('data:image/')
          ? (selectedImage.src.match(/^data:(image\/[\w.+-]+);base64,/)?.[1] || 'image/png')
          : undefined,
        characterId: useCharacterRefsInFollowUp ? (characterId || undefined) : undefined,
        activeReferenceIds: useCharacterRefsInFollowUp
          ? (characterDetail?.references?.filter((r) => r.isActive).map((r) => r.id) || undefined)
          : undefined,
        useCharacterRefsInFollowUp,
        count: countInt,
        direction: followUpDirection.trim() || undefined,
        followUpMode,
        strictContinuityLock,
        aspectRatio,
        resolutionTier,
        imageModel,
        kineticMotionBlur: kineticMotionBlur !== 'off' ? kineticMotionBlur : undefined,
      });
      const returnedJobIds = Array.isArray(data?.jobIds) ? data.jobIds : (data?.jobId ? [data.jobId] : []);
      if (returnedJobIds.length > 0) {
        setExecuteJobIds((prev) => Array.from(new Set([...(prev || []), ...returnedJobIds])));
        setFollowUpDrafts((prev) => prev.map((draft, index) => ({
          ...draft,
          jobId: followUpMode === 'ai'
            ? (returnedJobIds[index] || draft.jobId)
            : (returnedJobIds[0] || draft.jobId),
        })));
      }
      notify('Follow-up generation started', 'success');
    } catch (err) {
      setFollowUpDrafts([]);
      notify(err.message || 'Failed to start follow-up generation', 'error');
    } finally {
      setFollowUpLoading(false);
    }
  };

  const handleGeneratePolls = async () => {
    if (!pollTopic.trim()) { notify('Enter a poll topic', 'error'); return; }
    setPollLoading(true);
    setPollResults(null);
    setCompletedPollSlides([]);
    setPollJobs([]);
    setPollJobIds([]);
    try {
      const data = await carouselApi.polls({
        topic: pollTopic.trim(),
        characterId: characterId || undefined,
        activeReferenceIds: characterDetail?.references?.filter(r => r.isActive).map(r => r.id) || undefined,
        pollCount,
        aspectRatio,
        resolutionTier,
        imageModel,
      });
      setPollResults(data);
      const returnedJobIds = Array.isArray(data?.jobIds) ? data.jobIds : [];
      if (returnedJobIds.length > 0) setPollJobIds(returnedJobIds);
      notify(`${data.polls?.length || 0} poll questions generated, ${data.totalImages} images queued`, 'success');
    } catch (err) {
      notify(err.message || 'Failed to generate polls', 'error');
    } finally {
      setPollLoading(false);
    }
  };

  const POLL_STEPS = useMemo(() => ['Generating poll questions', 'Creating contrasting image prompts', 'Submitting image jobs'], []);
  const POLL_THRESHOLDS = useMemo(() => [3, 6], []);
  const { elapsedSec: pollElapsedSec, stepIndex: pollStepIndex } = useStepTimer(pollLoading, POLL_THRESHOLDS);

  return (
    <div className="space-y-6 animate-in overflow-x-hidden">
      <div className="flex rounded-lg bg-zinc-800/60 p-0.5 w-fit">
        {CAROUSEL_MODES.map(m => (
          <button key={m.key} onClick={() => setCarouselMode(m.key)}
            className={`rounded-md px-4 py-1.5 text-xs font-medium transition cursor-pointer ${
              carouselMode === m.key ? 'bg-blue-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}>
            {m.label}
          </button>
        ))}
      </div>

      {carouselMode === 'follow-up' && (
      <div>
        <div className="space-y-4">
          <Card className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-300">Generation Settings</h3>
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Character</span>
              <select
                value={characterId}
                onChange={(e) => handleCarouselCharacterChange(e.target.value)}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
              >
                <option value="">Select character...</option>
                {chars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {characterId && characterDetail?.references?.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {characterDetail.references.map((r) => (
                    <Badge key={r.id} color={r.isActive ? 'blue' : 'zinc'}>{r.category}</Badge>
                  ))}
                </div>
              )}
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
              <span className="text-xs text-zinc-400 font-medium block mb-2">Aspect Ratio</span>
              <div className="flex flex-wrap gap-1.5">
                {ASPECT_RATIOS.map((ar) => (
                  <button
                    key={ar}
                    onClick={() => setAspectRatio(ar)}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition cursor-pointer ${aspectRatio === ar ? 'bg-blue-600 text-white' : 'bg-zinc-700/60 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200'}`}
                  >
                    {ar}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Kinetic Motion Blur</span>
              <select
                value={kineticMotionBlur}
                onChange={(e) => setKineticMotionBlur(e.target.value)}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
              >
                <option value="off">Off</option>
                <option value="some">Some (subtle)</option>
                <option value="more">More (strong)</option>
              </select>
            </div>
          </Card>

          <Card className="space-y-4">
            <h3 className="text-sm font-semibold text-zinc-300">Follow-Up Source Image</h3>
            {loadingGallery ? (
              <div className="py-8 text-center text-sm text-zinc-500">Loading gallery images...</div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 auto-rows-[160px] gap-2 max-h-[55vh] overflow-y-auto pr-1">
                <label className="group relative flex w-full h-full cursor-pointer items-center justify-center rounded-xl border border-dashed border-zinc-700/80 bg-zinc-900/70 text-zinc-400 transition hover:border-blue-500/70 hover:bg-zinc-800/80 hover:text-zinc-200">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={handleUpload}
                  />
                  <div className="text-center">
                    <div className="text-2xl leading-none">+</div>
                    <div className="mt-1 text-xs">Upload Image</div>
                  </div>
                </label>
                {selectableImages.map((img) => {
                  const isSelected = selectedImageId === img.id;
                  const src = img.src || `/api/gallery/${img.id}/thumb`;
                  return (
                    <button
                      key={img.id}
                      type="button"
                      onClick={() => setSelectedImageId(img.id)}
                      className={`group relative w-full h-full overflow-hidden rounded-xl border bg-zinc-950 transition duration-200 hover:scale-[1.02] hover:shadow-[0_0_24px_rgba(59,130,246,0.2)] ${isSelected ? 'border-2 border-blue-500 shadow-[0_0_18px_rgba(59,130,246,0.35)]' : 'border-zinc-800'}`}
                    >
                      <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
                    </button>
                  );
                })}
              </div>
            )}

            {selectedImageSrc && (
              <div className="rounded-lg overflow-hidden border border-zinc-700/40">
                <img
                  src={selectedImageSrc}
                  alt="Selected base"
                  className="w-full aspect-[4/5] sm:aspect-video object-cover"
                  loading="lazy"
                  style={{ cursor: 'pointer' }}
                  onClick={() => openLightbox([selectedImageSrc], 0)}
                />
                <div className="px-3 py-2 bg-zinc-900/50">
                  <p className="text-[11px] text-zinc-500 line-clamp-2">
                    {selectedImage?.prompt || 'Selected gallery image'}
                  </p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-zinc-400">
                Follow-Up Count
                <select
                  value={followUpCount}
                  onChange={(e) => setFollowUpCount(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-zinc-400">
                Follow-Up Mode
                <select
                  value={followUpMode}
                  onChange={(e) => setFollowUpMode(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
                >
                  <option value="manual">Manual</option>
                  <option value="ai">AI Analyze + Unique</option>
                </select>
              </label>
            </div>
            <div className="space-y-1.5">
              <span className="text-xs text-zinc-400 font-medium">Direction (optional)</span>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { label: 'Sexy', prompt: 'Change pose to sexy and facial expression to sexy, and hand placement to sexy' },
                  { label: 'Playful', prompt: 'Change pose to playful and facial expression to playful, and hand placement to playful' },
                  { label: 'Cute', prompt: 'Change pose to cute and facial expression to cute, and hand placement to cute' },
                ].map(({ label, prompt }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setFollowUpDirection(prompt)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition cursor-pointer border ${followUpDirection === prompt ? 'bg-blue-600 border-blue-500 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <input
                value={followUpDirection}
                onChange={(e) => setFollowUpDirection(e.target.value)}
                placeholder={followUpMode === 'ai' ? 'extra guidance for AI variants' : 'new framing + expression'}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
              />
            </div>
            <label className="flex items-center gap-2 rounded-lg border border-zinc-700/80 bg-zinc-800/50 px-3 py-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={strictContinuityLock}
                onChange={(e) => setStrictContinuityLock(e.target.checked)}
                className="h-4 w-4 accent-blue-500"
              />
              <span>Strict Continuity Lock</span>
            </label>
            <div className="rounded-lg border border-zinc-700/80 bg-zinc-800/50 px-3 py-2">
              <Toggle
                checked={useCharacterRefsInFollowUp}
                onChange={setUseCharacterRefsInFollowUp}
                label="Use Character Refs in Follow-Up"
              />
            </div>
            <Btn onClick={handleFollowUpCarousel} disabled={followUpLoading || !selectedImageId} className="w-full">
              {followUpLoading ? <><Spinner size={14} /> Starting...</> : `${followUpMode === 'ai' ? 'AI Follow-up' : 'Follow-up'} · ~$${(followUpCount * 0.10).toFixed(2)}`}
            </Btn>
            {followUpLoading && (
              <div className="text-[11px] text-zinc-500">{followUpElapsedSec}s elapsed</div>
            )}
          </Card>

        </div>

      </div>
      )}

      {carouselMode === 'polls' && (
      <div>
        <div className="space-y-4">
          <Card className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-300">Poll Settings</h3>
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Character (optional)</span>
              <select value={characterId} onChange={(e) => handleCarouselCharacterChange(e.target.value)}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
                <option value="">No character</option>
                {chars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
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
            <div className="grid grid-cols-2 gap-2">
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
                <div className="flex flex-wrap gap-1.5">
                  {RESOLUTION_TIERS.map(tier => (
                    <button key={tier} onClick={() => setResolutionTier(tier)}
                      className={`rounded-md px-2 py-1 text-xs font-medium transition cursor-pointer ${resolutionTier === tier ? 'bg-blue-500 text-white' : 'bg-zinc-700/60 text-zinc-200 hover:bg-zinc-600'}`}>
                      {tier}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Card>

          <Card className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-300">Poll Builder</h3>
            <label className="text-xs text-zinc-400 block">
              Topic / Theme
              <input value={pollTopic} onChange={(e) => setPollTopic(e.target.value)}
                placeholder="e.g. beach vs city, morning routine vs night routine..."
                className="mt-1 w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70" />
            </label>
            <label className="text-xs text-zinc-400 block">
              Number of Questions
              <select value={pollCount} onChange={(e) => setPollCount(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500/70">
                {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} question{n > 1 ? 's' : ''} ({n * 2} images)</option>)}
              </select>
            </label>
            <Btn onClick={handleGeneratePolls} disabled={pollLoading || !pollTopic.trim()} className="w-full">
              {pollLoading ? <><Spinner size={14} /> Generating Polls...</> : `Generate Poll Carousel · ~$${(pollCount * 2 * 0.10).toFixed(2)}`}
            </Btn>
          </Card>

          {pollResults?.polls?.length > 0 && (
            <Card className="space-y-2">
              <h3 className="text-sm font-semibold text-zinc-300">Poll Questions</h3>
              {pollResults.polls.map((poll, i) => (
                <div key={poll.question || i} className="rounded-lg border border-zinc-700/40 bg-zinc-800/40 p-2.5 space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs text-zinc-200 font-medium">{poll.question}</p>
                    <CopyBtn text={poll.question} />
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <div className="rounded-md bg-blue-500/10 border border-blue-500/20 px-2 py-1">
                      <span className="text-[9px] text-blue-400 uppercase tracking-wider">A</span>
                      <p className="text-[11px] text-zinc-300">{poll.optionA?.label}</p>
                    </div>
                    <div className="rounded-md bg-purple-500/10 border border-purple-500/20 px-2 py-1">
                      <span className="text-[9px] text-purple-400 uppercase tracking-wider">B</span>
                      <p className="text-[11px] text-zinc-300">{poll.optionB?.label}</p>
                    </div>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>

      </div>
      )}

      <LightboxComponent />
    </div>
  );
}
