import { useState, useEffect, useMemo } from 'react';
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
import { RESOLUTION_TIERS, ASPECT_RATIOS_COMPACT as ASPECT_RATIOS, IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL } from '../config/photoModes';

const CAROUSEL_MODES = [
  { key: 'follow-up', label: 'Follow-Up' },
  { key: 'polls', label: 'Polls' },
];

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

const _cache = {
  executeJobIds: [],
  executeJobs: [],
  completedSlides: [],
  pollJobIds: [],
  pollJobs: [],
  completedPollSlides: [],
  pollResults: null,
  selectedImageId: null,
  uploadedImages: [],
  characterId: '',
  aspectRatio: '4:5',
  resolutionTier: '2K',
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

  const [selectedImageId, setSelectedImageId] = useState(_cache.selectedImageId);
  const [galleryImages, setGalleryImages] = useState([]);
  const [uploadedImages, setUploadedImages] = useState(_cache.uploadedImages);
  const [loadingGallery, setLoadingGallery] = useState(true);

  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolutionTier, setResolutionTier] = useState(_cache.resolutionTier);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [kineticMotionBlur, setKineticMotionBlur] = useState(_cache.kineticMotionBlur || 'off');

  const [characterId, setCharacterId] = useState(_cache.characterId);
  const [characterDetail, setCharacterDetail] = useState(null);

  const [followUpLoading, setFollowUpLoading] = useState(false);
  const [executeJobIds, setExecuteJobIds] = useState(_cache.executeJobIds);
  const [executeJobs, setExecuteJobs] = useState(_cache.executeJobs);
  const [completedSlides, setCompletedSlides] = useState(_cache.completedSlides);
  const [followUpCount, setFollowUpCount] = useState(_cache.followUpCount);
  const [followUpDirection, setFollowUpDirection] = useState(_cache.followUpDirection);
  const [followUpMode, setFollowUpMode] = useState(_cache.followUpMode);
  const [strictContinuityLock, setStrictContinuityLock] = useState(true);
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
    executeJobIds, executeJobs, completedSlides, pollJobIds, pollJobs,
    completedPollSlides, pollResults, selectedImageId, uploadedImages,
    characterId, aspectRatio, resolutionTier, imageModel, followUpDirection,
    followUpMode, followUpCount, carouselMode, pollTopic, pollCount, kineticMotionBlur,
  }); });

  useEffect(() => {
    const params = consumePageParams();
    if (params.recreate) {
      if (params.characterId) setCharacterId(params.characterId);
      if (params.aspectRatio) setAspectRatio(params.aspectRatio);
      if (params.sourceImageId) setSelectedImageId(params.sourceImageId);
    }
  }, []);

  const selectableImages = [...uploadedImages, ...galleryImages];
  const selectedImage = selectableImages.find((img) => img.id === selectedImageId);
  const selectedImageSrc = selectedImage
    ? (selectedImage.src || `/api/gallery/${selectedImage.id}/image`)
    : null;

  const isAnyJobRunning = executeJobs.some((job) => job?.status === 'running');

  useEffect(() => {
    if (characterId) charApi.get(characterId).then(setCharacterDetail).catch(() => setCharacterDetail(null));
    else setCharacterDetail(null);
  }, [characterId]);

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
        }
      }
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  }, [executeJobs]);

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
      }
      notify('Follow-up generation started', 'success');
    } catch (err) {
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
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
        <div className="lg:col-span-1 space-y-4">
          <Card className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-300">Generation Settings</h3>
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Character</span>
              <select
                value={characterId}
                onChange={(e) => setCharacterId(e.target.value)}
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
            <label className="text-xs text-zinc-400 block">
              Direction (optional)
              <input
                value={followUpDirection}
                onChange={(e) => setFollowUpDirection(e.target.value)}
                placeholder={followUpMode === 'ai' ? 'extra guidance for AI variants' : 'new framing + expression'}
                className="mt-1 w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
              />
            </label>
            <label className="flex items-center gap-2 rounded-lg border border-zinc-700/80 bg-zinc-800/50 px-3 py-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={strictContinuityLock}
                onChange={(e) => setStrictContinuityLock(e.target.checked)}
                className="h-4 w-4 accent-blue-500"
              />
              <span>Strict Continuity Lock (recommended)</span>
            </label>
            <div className="rounded-lg border border-zinc-700/80 bg-zinc-800/50 px-3 py-2">
              <Toggle
                checked={useCharacterRefsInFollowUp}
                onChange={setUseCharacterRefsInFollowUp}
                label="Use Character Refs in Follow-Up"
              />
            </div>
            <Btn onClick={handleFollowUpCarousel} disabled={followUpLoading || !selectedImageId} className="w-full">
              {followUpLoading ? <><Spinner size={14} /> Starting...</> : (followUpMode === 'ai' ? 'AI Follow-up from Selected Image' : 'Follow-up from Selected Image')}
            </Btn>
            {followUpLoading && (
              <div className="text-[11px] text-zinc-500">{followUpElapsedSec}s elapsed</div>
            )}
          </Card>

        </div>

        <div className="lg:col-span-2 space-y-4">
          {followUpLoading && (
            <StepProgress steps={FOLLOW_STEPS} currentIndex={followStepIndex} elapsedSec={followUpElapsedSec} className="min-h-[360px]" />
          )}

          {executeJobs.length > 0 && (
            <Card className="space-y-3 mb-4">
              <h3 className="text-sm font-semibold text-zinc-300">Live Carousel Jobs</h3>
              {isAnyJobRunning && <p className="text-xs text-zinc-500 font-mono">{jobsElapsedSec}s elapsed</p>}
              <div className="space-y-2">
                {executeJobs.map((job) => {
                  const errors = (job.results || []).filter(r => r && !r.success && r.error);
                  return (
                  <div key={job.jobId} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 space-y-1">
                    <div className="flex items-center justify-between text-xs text-zinc-400">
                      <span className="font-mono">{job.jobId}</span>
                      <span>{job.status} — {job.completed} ok / {job.failed} failed / {job.total}</span>
                    </div>
                    {errors.length > 0 && (
                      <div className="text-[10px] text-red-400/80 space-y-0.5 mt-1">
                        {errors.slice(0, 3).map((e, i) => <p key={i}>#{e.index + 1}: {e.error}</p>)}
                        {errors.length > 3 && <p>...and {errors.length - 3} more</p>}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            </Card>
          )}

          {completedSlides.length === 0 && !isAnyJobRunning ? (
            <Card className="flex items-center justify-center py-20">
              <Empty icon="Carousel" title="No generated slides yet" subtitle="Use Execute or Follow-up to start jobs" />
            </Card>
          ) : (
            <div className="space-y-4">
              {completedSlides.length > 0 && (
                <h3 className="text-sm font-semibold text-zinc-400">Generated Slides ({completedSlides.length})</h3>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {completedSlides.map((v, i) => {
                  const imgSrc = v.image?.base64Data
                    ? `data:${v.image.mimeType || 'image/png'};base64,${v.image.base64Data}`
                    : v.galleryId ? `/api/gallery/${v.galleryId}/image` : null;
                  return (
                    <ImageCard
                      key={v._key}
                      src={imgSrc}
                      meta={{ identityConfidence: v.image?.validation?.identity_match_score }}
                      className="animate-in"
                      onSelect={() => openLightbox(
                        completedSlides.map((img) => img.image?.base64Data
                          ? `data:${img.image.mimeType || 'image/png'};base64,${img.image.base64Data}`
                          : `/api/gallery/${img.galleryId}/image`
                        ),
                        i
                      )}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      )}

      {carouselMode === 'polls' && (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
        <div className="lg:col-span-1 space-y-4">
          <Card className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-300">Poll Settings</h3>
            <div>
              <span className="text-xs text-zinc-400 font-medium block mb-1.5">Character (optional)</span>
              <select value={characterId} onChange={(e) => setCharacterId(e.target.value)}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer">
                <option value="">No character</option>
                {chars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
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
              {pollLoading ? <><Spinner size={14} /> Generating Polls...</> : 'Generate Poll Carousel'}
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

        <div className="lg:col-span-2 space-y-4">
          {pollLoading && (
            <StepProgress steps={POLL_STEPS} currentIndex={pollStepIndex} elapsedSec={pollElapsedSec} className="min-h-[360px]" />
          )}

          {pollJobs.length > 0 && (
            <Card className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-300">Poll Image Jobs</h3>
              {isPollJobRunning && <p className="text-xs text-zinc-500 font-mono">{pollElapsedSec}s</p>}
              <div className="space-y-2">
                {pollJobs.map(job => (
                  <div key={job.jobId} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                    <div className="flex items-center justify-between text-xs text-zinc-400">
                      <span className="font-mono">{job.jobId}</span>
                      <span>{job.status} - {job.completed + job.failed}/{job.total}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {pollResults?.polls?.length > 0 && completedPollSlides.length > 0 ? (
            <div className="space-y-6">
              <h3 className="text-sm font-semibold text-zinc-400">Poll Results ({pollResults.polls.length} questions)</h3>
              {pollResults.polls.map((poll, pi) => {
                const imgA = completedPollSlides[pi * 2];
                const imgB = completedPollSlides[pi * 2 + 1];
                return (
                  <Card key={poll.question || pi} className="space-y-3 animate-in">
                    <div className="text-center">
                      <p className="text-sm font-semibold text-zinc-200">{poll.question}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <div className="text-center">
                          <Badge color="blue">{poll.optionA?.label || 'Option A'}</Badge>
                        </div>
                        {imgA ? (
                          <ImageCard
                            src={imgA.image?.base64Data ? `data:${imgA.image.mimeType || 'image/png'};base64,${imgA.image.base64Data}` : `/api/gallery/${imgA.galleryId}/image`}
                            className="animate-in"
                            onSelect={() => openLightbox(
                              completedPollSlides.map(img => img.image?.base64Data ? `data:${img.image.mimeType || 'image/png'};base64,${img.image.base64Data}` : `/api/gallery/${img.galleryId}/image`),
                              pi * 2
                            )}
                          />
                        ) : (
                          <div className="aspect-square rounded-lg bg-zinc-800/60 border border-zinc-700/40 flex items-center justify-center">
                            <Spinner size={20} />
                          </div>
                        )}
                      </div>
                      <div className="space-y-2">
                        <div className="text-center">
                          <Badge color="purple">{poll.optionB?.label || 'Option B'}</Badge>
                        </div>
                        {imgB ? (
                          <ImageCard
                            src={imgB.image?.base64Data ? `data:${imgB.image.mimeType || 'image/png'};base64,${imgB.image.base64Data}` : `/api/gallery/${imgB.galleryId}/image`}
                            className="animate-in"
                            onSelect={() => openLightbox(
                              completedPollSlides.map(img => img.image?.base64Data ? `data:${img.image.mimeType || 'image/png'};base64,${img.image.base64Data}` : `/api/gallery/${img.galleryId}/image`),
                              pi * 2 + 1
                            )}
                          />
                        ) : (
                          <div className="aspect-square rounded-lg bg-zinc-800/60 border border-zinc-700/40 flex items-center justify-center">
                            <Spinner size={20} />
                          </div>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          ) : !pollLoading && (
            <Card className="flex items-center justify-center py-20">
              <Empty icon="Carousel" title="No polls generated yet" subtitle="Enter a topic and generate your first poll carousel" />
            </Card>
          )}
        </div>
      </div>
      )}

      <LightboxComponent />
    </div>
  );
}
