import { useState, useEffect, useMemo } from 'react';
import {
  gallery as galleryApi,
  characters as charApi,
  carousel as carouselApi,
  batch as batchApi,
} from '../services/api';
import { useApp } from '../context/AppContext';
import { useStepTimer } from '../hooks/useStepTimer';
import { Card, Btn, Spinner, ImageCard, Empty, Badge, Toggle, StepProgress } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { RESOLUTION_TIERS, ASPECT_RATIOS_COMPACT as ASPECT_RATIOS } from '../config/photoModes';

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function CarouselPage() {
  const { notify, characters: chars } = useApp();
  const { openLightbox, LightboxComponent } = useImageLightbox();

  const [selectedImageId, setSelectedImageId] = useState(null);
  const [galleryImages, setGalleryImages] = useState([]);
  const [uploadedImages, setUploadedImages] = useState([]);
  const [loadingGallery, setLoadingGallery] = useState(true);

  const [aspectRatio, setAspectRatio] = useState('4:5');
  const [resolutionTier, setResolutionTier] = useState('2K');
  const [kineticMotionBlur, setKineticMotionBlur] = useState('off');

  const [characterId, setCharacterId] = useState('');
  const [characterDetail, setCharacterDetail] = useState(null);


  const [followUpLoading, setFollowUpLoading] = useState(false);
  const [executeJobIds, setExecuteJobIds] = useState([]);
  const [executeJobs, setExecuteJobs] = useState([]);
  const [followUpCount, setFollowUpCount] = useState(4);
  const [followUpDirection, setFollowUpDirection] = useState('');
  const [followUpMode, setFollowUpMode] = useState('manual');
  const [strictContinuityLock, setStrictContinuityLock] = useState(true);
  const [useCharacterRefsInFollowUp, setUseCharacterRefsInFollowUp] = useState(false);

  const selectableImages = [...uploadedImages, ...galleryImages];
  const selectedImage = selectableImages.find((img) => img.id === selectedImageId);
  const selectedImageSrc = selectedImage
    ? (selectedImage.src || `/api/gallery/${selectedImage.id}/image`)
    : null;

  const generatedImages = executeJobs
    .flatMap((job) => (job.results || []))
    .filter((item) => item && item.success && item.image && item.image.base64Data);
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
        const list = await galleryApi.list();
        if (!cancelled) setGalleryImages(list || []);
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
    const fetchJobs = async () => {
      try {
        const jobs = await Promise.all(executeJobIds.map((jobId) => batchApi.get(jobId).catch(() => null)));
        if (!cancelled) setExecuteJobs(jobs.filter(Boolean));
      } catch {
        // Keep previous job states during transient failures.
      }
    };

    fetchJobs();
    const interval = setInterval(fetchJobs, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [executeJobIds]);

  useEffect(() => {
    if (!Array.isArray(executeJobs) || executeJobs.length === 0) return;

    const runningIds = executeJobs
      .filter((job) => job && job.status === 'running')
      .map((job) => job.jobId);

    // Functional update avoids stale closure over executeJobIds
    setExecuteJobIds((prev) => {
      if (runningIds.length === prev.length && runningIds.every((id) => prev.includes(id))) return prev;
      return runningIds;
    });
  }, [executeJobs]);

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

    // Start a fresh follow-up session: clear previous follow-up job cards/images.
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

  return (
    <div className="space-y-6 animate-in">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-gradient">Carousel Generator</h1>
        <p className="text-zinc-500 text-sm mt-1">Select a base image and generate follow-up carousel variations.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
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
              <div className="grid [grid-template-columns:repeat(auto-fill,minmax(120px,1fr))] gap-3 max-h-[300px] overflow-y-auto pr-1">
                <label className="group relative flex aspect-square cursor-pointer items-center justify-center rounded-xl border border-dashed border-zinc-700/80 bg-zinc-900/70 text-zinc-400 transition hover:border-blue-500/70 hover:bg-zinc-800/80 hover:text-zinc-200">
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
                  const src = img.src || `/api/gallery/${img.id}/image`;
                  return (
                    <button
                      key={img.id}
                      type="button"
                      onClick={() => setSelectedImageId(img.id)}
                      className={`group relative aspect-square overflow-hidden rounded-xl border bg-zinc-900 transition duration-200 hover:scale-[1.02] hover:shadow-[0_0_24px_rgba(59,130,246,0.2)] ${isSelected ? 'border-2 border-blue-500 shadow-[0_0_18px_rgba(59,130,246,0.35)]' : 'border-zinc-800'}`}
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
                  className="w-full aspect-video object-cover"
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
                {executeJobs.map((job) => (
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

          {generatedImages.length === 0 ? (
            <Card className="flex items-center justify-center py-20">
              <Empty icon="Carousel" title="No generated slides yet" subtitle="Use Execute or Follow-up to start jobs" />
            </Card>
          ) : (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-zinc-400">Generated Slides ({generatedImages.length})</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {generatedImages.map((v, i) => (
                  <ImageCard
                    key={`${v.index}-${i}`}
                    base64={v.image?.base64Data}
                    mimeType={v.image?.mimeType}
                    meta={{ identityConfidence: v.image?.validation?.identity_match_score }}
                    className="animate-in"
                    onSelect={() => openLightbox(
                      generatedImages.map((img) => `data:${img.image?.mimeType || 'image/png'};base64,${img.image?.base64Data}`),
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
