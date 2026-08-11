import { useState, useEffect, useRef, useCallback } from 'react';
import { video as videoApi, gallery as galleryApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Select, Slider, Textarea, Toggle, Badge, Spinner, ConfirmDialog } from '../components/UI';
import { SEEDANCE_MODELS, SEEDANCE_ASPECT_RATIOS, SEEDANCE_DURATION_MIN, SEEDANCE_DURATION_MAX, SEEDANCE_DURATION_DEFAULT } from '../config/photoModes';
import { pushPending, resolvePending, rejectPending, attachTaskId } from '../lib/generationFeed';
import { detectAspectRatio } from '../lib/detectAspectRatio';
import { createPageStore } from '../lib/pageStateStore';
import { cn } from '../lib/utils';

const MODEL_MAP = Object.fromEntries(SEEDANCE_MODELS.map((m) => [m.id, m]));
// 'auto' snaps to whichever supported ratio is closest to the source image — Seedance has a
// fixed enum, so there is no true passthrough.
const ASPECT_RATIO_OPTIONS = [{ value: 'auto', label: 'Auto (match source)' }, ...SEEDANCE_ASPECT_RATIOS.map((r) => ({ value: r, label: r }))];

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const _cache = {
  model: 'seedance-2-fast',
  prompt: '',
  duration: SEEDANCE_DURATION_DEFAULT,
  aspectRatio: 'auto',
  lockCamera: true,
};
// The source image is too big for _cache/localStorage — IndexedDB so it survives a reload.
const store = createPageStore('kyros-seedance-video-state');

// Appended to the prompt when "Lock camera" is on — the only lever this endpoint exposes
// against the model's default push-in (there is no separate camera/negative parameter).
const NO_ZOOM_DIRECTIVE = 'Static locked-off camera. No zoom, no push-in, no dolly, no camera movement — the frame stays fixed while only the subject moves.';

export default function SeedanceVideoPage() {
  const { notify } = useApp();

  const [model, setModel] = useState(_cache.model);
  const [prompt, setPrompt] = useState(_cache.prompt);
  const [duration, setDuration] = useState(_cache.duration);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [lockCamera, setLockCamera] = useState(_cache.lockCamera);

  const [sourceImage, setSourceImage] = useState(null);
  const [sourcePreview, setSourcePreview] = useState(null);
  const [sourceGalleryId, setSourceGalleryId] = useState(null);
  // The three source fields only ever move together — a per-field restore guard could mix a
  // saved galleryId into a just-uploaded image, and handleGenerate prefers galleryId, so it
  // would render the wrong picture. This flips the moment anything touches the source, and
  // the restore below skips the whole trio when it is set.
  const sourceTouched = useRef(false);

  const [galleryImages, setGalleryImages] = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Multi-job queue: each Generate adds a job that polls independently, so you can
  // swap the image and queue another while earlier ones are still rendering.
  const [jobs, setJobs] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const jobsRef = useRef([]);
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);

  const [deleteTarget, setDeleteTarget] = useState(null);

  // Restore the source image and prompt that were on the page last time.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [src, p] = await Promise.all([store.get('source', null), store.get('prompt', '')]);
      if (cancelled) return;
      // Never clobber: this resolves asynchronously, so whatever the user already put on the
      // page while it was loading wins.
      if (src?.preview && !sourceTouched.current) {
        setSourceImage(src.image ?? null);
        setSourcePreview(src.preview);
        setSourceGalleryId(src.galleryId ?? null);
      }
      if (p) setPrompt((cur) => cur || p);
      setRestored(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist only after the restore has run, or the first empty render would wipe the save.
  useEffect(() => {
    if (restored) store.set('source', { image: sourceImage, preview: sourcePreview, galleryId: sourceGalleryId });
  }, [sourceImage, sourcePreview, sourceGalleryId, restored]);
  useEffect(() => { if (restored) store.set('prompt', prompt); }, [prompt, restored]);

  useEffect(() => { _cache.model = model; }, [model]);
  useEffect(() => { _cache.prompt = prompt; }, [prompt]);
  useEffect(() => { _cache.duration = duration; }, [duration]);
  useEffect(() => { _cache.aspectRatio = aspectRatio; }, [aspectRatio]);
  useEffect(() => { _cache.lockCamera = lockCamera; }, [lockCamera]);

  const modelInfo = MODEL_MAP[model] || SEEDANCE_MODELS[0];
  const estimatedCost = duration * modelInfo.pricePerSecond;

  const fetchGallery = useCallback(async () => {
    setGalleryLoading(true);
    try {
      const res = await galleryApi.list({ limit: 120 });
      setGalleryImages(res.images || res || []);
    } catch { /* gallery is optional — the page works without it */ }
    finally { setGalleryLoading(false); }
  }, []);

  const updateJob = useCallback((id, patch) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  // One ticker drives every running job: refresh elapsed time and poll each task.
  useEffect(() => {
    const iv = setInterval(async () => {
      const running = jobsRef.current.filter((j) => j.status === 'processing' && j.taskId);
      if (!running.length) return;

      setJobs((prev) => prev.map((j) => (
        j.status === 'processing' ? { ...j, elapsed: Math.floor((Date.now() - j.startedAt) / 1000) } : j
      )));

      for (const job of running) {
        try {
          const data = await videoApi.status(job.taskId);
          if (data.status === 'completed') {
            const url = data.localFilename
              ? videoApi.fileUrl(data.localFilename)
              : (data.outputs?.[0] || data.videoUrl || '');
            updateJob(job.id, { status: 'done', videoUrl: url });
            resolvePending(job.feedId, {
              isVideo: true,
              videoUrl: url,
              prompt: job.feedPrompt,
              imageModel: job.modelLabel,
              aspectRatio: job.aspectRatio,
              resolutionTier: `${job.duration}s`,
              generatedAt: Date.now(),
            });
            notify('Video ready 🎬', 'success');
          } else if (data.status === 'failed') {
            updateJob(job.id, { status: 'failed', error: data.error || 'Generation failed' });
            rejectPending(job.feedId);
            notify(data.error || 'Video generation failed', 'error');
          }
        } catch {
          // Transient status-check blip — keep polling rather than killing the job.
        }
      }
    }, 2500);
    return () => clearInterval(iv);
  }, [updateJob, notify]);

  const applyImageFile = async (file) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|webp)$/i.test(file.type)) {
      notify('Please use a PNG, JPG, or WebP image', 'error');
      return;
    }
    const dataUrl = await fileToBase64(file);
    sourceTouched.current = true;
    setSourceImage(dataUrl);
    setSourcePreview(dataUrl);
    setSourceGalleryId(null);
  };

  const handleImageUpload = async (e) => {
    await applyImageFile(e.target.files?.[0]);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) { await applyImageFile(file); return; }
    // Dragging an <img> in from a browser/gallery drops a URL, not a file.
    const url = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
    if (url && /^https?:|^data:/.test(url)) {
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        if (!/^image\//.test(blob.type)) throw new Error('not an image');
        const dataUrl = await fileToBase64(new File([blob], 'dropped', { type: blob.type }));
        sourceTouched.current = true;
        setSourceImage(dataUrl);
        setSourcePreview(dataUrl);
        setSourceGalleryId(null);
      } catch {
        notify('Couldn\'t read that dragged image — try Upload instead', 'error');
      }
    }
  };

  const handlePickFromGallery = (imgId) => {
    sourceTouched.current = true;
    setSourceGalleryId(imgId);
    setSourcePreview(galleryApi.imageUrl(imgId));
    setSourceImage(null);
    setShowGallery(false);
  };

  const handleGenerate = async () => {
    if (!sourceImage && !sourceGalleryId) {
      notify('Select or upload a source image first', 'error');
      return;
    }

    // Resolve 'auto' up front: the job card and feed must show the real ratio, and the
    // literal string would 422 at the API. Works for uploads (data URL) and gallery picks
    // (same-origin URL) alike — Image() only needs to read the dimensions.
    const ratio = aspectRatio === 'auto'
      ? await detectAspectRatio(sourcePreview, SEEDANCE_ASPECT_RATIOS, '16:9')
      : aspectRatio;

    const jobId = `sd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const feedId = `seedance-${jobId}`;
    const feedPrompt = prompt.trim() || 'Seedance video';

    setJobs((prev) => [{
      id: jobId,
      feedId,
      feedPrompt,
      status: 'submitting',
      thumb: sourcePreview,
      modelLabel: modelInfo?.label || model,
      duration,
      aspectRatio: ratio,
      cost: estimatedCost,
      startedAt: Date.now(),
      elapsed: 0,
      taskId: null,
      videoUrl: null,
      error: null,
    }, ...prev]);

    pushPending({
      id: feedId,
      prompt: feedPrompt,
      imageModel: modelInfo?.label || model,
      aspectRatio: ratio,
      resolutionTier: `${duration}s`,
      isVideo: true,
    });

    setSubmitting(true);
    try {
      const body = { model, duration, aspectRatio: ratio };
      // Camera-lock directive leads so the model reads it before any subject motion.
      const promptParts = [];
      if (lockCamera) promptParts.push(NO_ZOOM_DIRECTIVE);
      if (prompt.trim()) promptParts.push(prompt.trim());
      const finalPrompt = promptParts.join(' ');
      if (finalPrompt) body.prompt = finalPrompt;

      if (sourceGalleryId) {
        body.galleryId = sourceGalleryId;
      } else if (sourceImage) {
        const match = sourceImage.match(/^data:([^;]+);base64,(.+)$/);
        if (match) { body.image = match[2]; body.imageMimeType = match[1]; }
        else body.image = sourceImage;
      }

      const res = await videoApi.generate(body);
      if (res.status === 'failed') throw new Error('Muapi returned an error — try again or pick a different model');
      updateJob(jobId, { status: 'processing', taskId: res.taskId, startedAt: Date.now() });
      // Give the feed the taskId so it can finish the card itself. Renders continue on the
      // server after this page unmounts; without this the card spins forever while the file
      // quietly lands in Library.
      attachTaskId(feedId, res.taskId);
      notify('Queued 🎬 — swap the image and queue another while this renders', 'success');
    } catch (err) {
      updateJob(jobId, { status: 'failed', error: err.message || 'Failed to start' });
      rejectPending(feedId);
      notify(err.message || 'Failed to start video generation', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const downloadJob = async (job) => {
    if (!job?.videoUrl) return;
    try {
      // A job that has been saved locally can be fetched through the clean route; a remote
      // provider URL cannot, so that one comes down as-is.
      const src = job.localFilename ? videoApi.cleanFileUrl(job.localFilename) : job.videoUrl;
      const resp = await fetch(src);
      if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Only claim it when the clean route was actually used; a raw provider URL is not cleaned.
      a.download = job.localFilename ? `seedance-${job.id}_metadatacleaned.mp4` : `seedance-${job.id}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      // Fallback: open in a new tab so the user can save manually.
      notify(err.message || 'Download failed — opening in a new tab instead', 'error');
      window.open(job.videoUrl, '_blank', 'noopener');
    }
  };

  const runningCount = jobs.filter((j) => j.status === 'processing' || j.status === 'submitting').length;

  return (
    <div className="space-y-6 animate-in">
      <div className="space-y-4">
        {/* Source Image */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Source Image</h3>
          <div className="flex items-start gap-4">
            {sourcePreview ? (
              <div
                className="relative shrink-0"
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
              >
                <img src={sourcePreview} alt="Source" className={cn('w-40 h-52 object-cover rounded-xl border bg-zinc-950 transition-colors', dragging ? 'border-rose-500' : 'border-zinc-800/60')} />
                <button onClick={() => { sourceTouched.current = true; setSourceImage(null); setSourcePreview(null); setSourceGalleryId(null); }}
                  className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 text-xs flex items-center justify-center hover:text-white cursor-pointer">
                  ×
                </button>
              </div>
            ) : (
              <label
                className={cn(
                  'w-40 h-52 rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-1.5 text-xs text-center shrink-0 cursor-pointer transition-colors px-2',
                  dragging ? 'border-rose-500 bg-rose-500/[0.06] text-rose-300' : 'border-zinc-800/60 text-zinc-600 hover:border-zinc-600',
                )}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
              >
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleImageUpload} />
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                <span>{dragging ? 'Drop image' : 'Drag image here or click'}</span>
              </label>
            )}
            <div className="flex flex-col gap-2 flex-1">
              <div className="flex items-center gap-2">
                <label className="cursor-pointer">
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleImageUpload} />
                  <span className="inline-block">
                    <Btn variant="secondary" className="!rounded-lg pointer-events-none">Upload Image</Btn>
                  </span>
                </label>
                <Btn variant="secondary" className="!rounded-lg" onClick={() => {
                  if (!showGallery && galleryImages.length === 0) fetchGallery();
                  setShowGallery((v) => !v);
                }}>
                  {showGallery ? 'Hide Gallery' : 'Pick from Gallery'}
                </Btn>
              </div>
              <p className="text-xs text-zinc-500">PNG, JPG, WebP. This becomes the first frame of the video.</p>
            </div>
          </div>

          {showGallery && (
            <div className="pt-2">
              {galleryLoading ? (
                <div className="flex items-center justify-center py-6 text-zinc-400 text-sm"><Spinner size={16} /> <span className="ml-2">Loading gallery...</span></div>
              ) : galleryImages.length === 0 ? (
                <p className="text-xs text-zinc-500 py-4 text-center">No images in gallery yet.</p>
              ) : (
                <div className="grid [grid-template-columns:repeat(auto-fill,minmax(80px,1fr))] gap-2 max-h-[240px] overflow-y-auto pr-1">
                  {galleryImages.map((img) => (
                    <button
                      key={img.id}
                      onClick={() => handlePickFromGallery(img.id)}
                      className={cn(
                        'relative aspect-square overflow-hidden rounded-lg border transition-all cursor-pointer hover:scale-[1.03]',
                        sourceGalleryId === img.id
                          ? 'border-rose-500 ring-2 ring-rose-500/25 shadow-lg shadow-rose-500/10'
                          : 'border-zinc-800/60 hover:border-zinc-600',
                      )}
                    >
                      <img src={galleryApi.thumbUrl(img.id)} alt="" className="h-full w-full object-cover bg-zinc-950" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Model */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Model</h3>
          <div className="grid grid-cols-2 gap-3">
            {SEEDANCE_MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setModel(m.id)}
                className={cn(
                  'text-left rounded-xl border p-3.5 transition-all duration-200 cursor-pointer',
                  model === m.id
                    ? 'border-rose-500 ring-2 ring-rose-500/25 shadow-lg shadow-rose-500/10 bg-rose-500/[0.04]'
                    : 'border-zinc-800/60 hover:border-zinc-600 bg-white/[0.02]',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-zinc-100">{m.label}</span>
                  {model === m.id && <Badge>Selected</Badge>}
                </div>
                <p className="text-xs text-zinc-500 mt-1 leading-relaxed">{m.desc}</p>
                <div className="text-[0.6875rem] text-zinc-500 mt-2.5">
                  <span className="text-zinc-300 font-medium font-mono tabular-nums">${m.pricePerSecond.toFixed(2)}</span> / second
                </div>
              </button>
            ))}
          </div>
        </Card>

        {/* Prompt */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
            Motion Prompt <span className="text-zinc-600 font-normal normal-case">(optional)</span>
          </h3>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the motion you want, e.g. 'the person walks forward with a smile'..."
            rows={3}
            maxLength={4000}
          />
          <div className="text-[0.625rem] text-zinc-600 text-right">{prompt.length}/4000</div>
        </Card>

        {/* Settings */}
        <Card className="p-4 space-y-4">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Settings</h3>

          <Select
            label="Aspect Ratio"
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value)}
            options={ASPECT_RATIO_OPTIONS}
          />

          <Slider
            label="Duration (seconds)"
            value={duration}
            onChange={setDuration}
            min={SEEDANCE_DURATION_MIN}
            max={SEEDANCE_DURATION_MAX}
            step={1}
          />

          <div className="pt-1 border-t border-zinc-800/40">
            <div className="flex items-start justify-between gap-4 pt-3">
              <div className="flex-1">
                <div className="text-xs font-medium text-zinc-300">Lock camera (no zoom)</div>
                <p className="text-[0.625rem] text-zinc-600 mt-0.5 leading-relaxed">
                  Stops the default slow push-in — the frame stays fixed and only the subject moves. Adds a camera-lock instruction to your prompt (this model has no separate camera setting).
                </p>
              </div>
              <Toggle checked={lockCamera} onChange={setLockCamera} />
            </div>
          </div>

          <div className="pt-1 border-t border-zinc-800/40">
            <div className="pt-3">
              <div className="text-xs font-medium text-zinc-300">Content safety</div>
              <p className="text-[0.625rem] text-zinc-600 mt-0.5">
                This model has no per-request safety-checker parameter — Muapi's own OpenAPI schema confirms it.
                Any content filtering is controlled by your Muapi account settings, not by a toggle here.
              </p>
            </div>
          </div>
        </Card>

        {/* Generate — stays enabled so you can queue more while others render */}
        <Btn onClick={handleGenerate} disabled={submitting} className="w-full">
          {submitting ? <Spinner size={16} /> : null}
          {submitting ? 'Queueing…' : `Generate Video · $${estimatedCost.toFixed(2)}`}
        </Btn>
        {runningCount > 0 && (
          <p className="text-center text-[0.6875rem] text-zinc-500">
            {runningCount} rendering — swap the image above and hit Generate again to queue another.
          </p>
        )}

        {/* Queue */}
        {jobs.length > 0 && (
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
                Queue <span className="text-zinc-600 font-normal normal-case">({jobs.length})</span>
              </h3>
              {jobs.some((j) => j.status === 'done' || j.status === 'failed') && (
                <button
                  type="button"
                  onClick={() => setJobs((prev) => prev.filter((j) => j.status === 'processing' || j.status === 'submitting'))}
                  className="text-[0.6875rem] text-zinc-500 hover:text-zinc-300 transition cursor-pointer underline"
                >
                  Clear finished
                </button>
              )}
            </div>

            <div className="space-y-3">
              {jobs.map((job) => (
                <div key={job.id} className="rounded-xl border border-zinc-800/60 bg-white/[0.02] p-3">
                  <div className="flex gap-3">
                    {job.thumb ? (
                      <img src={job.thumb} alt="" className="w-14 h-20 object-cover rounded-lg border border-zinc-800/60 bg-zinc-950 shrink-0" />
                    ) : (
                      <div className="w-14 h-20 rounded-lg border border-zinc-800/60 bg-zinc-950 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        {job.status === 'done' ? <Badge color="green">Ready</Badge>
                          : job.status === 'failed' ? <Badge color="red">Failed</Badge>
                          : <Badge color="yellow">{job.status === 'submitting' ? 'Queueing…' : `Rendering ${job.elapsed}s`}</Badge>}
                        <span className="text-[0.625rem] text-zinc-600 font-mono tabular-nums shrink-0">
                          {job.modelLabel} · {job.duration}s · {job.aspectRatio} · ${job.cost.toFixed(2)}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[0.6875rem] text-zinc-500 line-clamp-2 leading-snug">{job.feedPrompt}</p>
                      {job.status === 'failed' && job.error && (
                        <p className="mt-1 text-[0.6875rem] text-red-400 leading-snug">{job.error}</p>
                      )}
                      {job.status === 'done' && (
                        <Btn variant="secondary" className="!rounded-lg !py-1 !px-2.5 !text-[0.6875rem] mt-2" onClick={() => downloadJob(job)}>
                          Download
                        </Btn>
                      )}
                    </div>
                  </div>
                  {job.status === 'done' && job.videoUrl && (
                    <video src={job.videoUrl} controls className="mt-3 w-full rounded-lg border border-zinc-800/60 bg-black" />
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          await videoApi.removeHistory(deleteTarget);
          setDeleteTarget(null);
        }}
        title="Delete Video"
        message="This will permanently delete the video file."
        confirmLabel="Delete"
      />
    </div>
  );
}
