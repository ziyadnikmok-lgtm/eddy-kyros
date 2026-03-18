import { useState, useEffect, useRef, useCallback } from 'react';
import { video as videoApi, gallery as galleryApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { usePoll } from '../hooks/usePoll';
import { Card, Btn, Slider, Badge, Spinner, Empty, Section, StepProgress, ConfirmDialog } from '../components/UI';
import { VIDEO_MODELS } from '../config/photoModes';

const MODEL_MAP = Object.fromEntries(VIDEO_MODELS.map((m) => [m.id, m]));
const IS_MOTION = (id) => id === 'kling-v2.6-motion' || id === 'kling-v2.6-motion-pro';
const IS_PRO = (id) => id === 'kling-v2.5-turbo-pro';
const IS_GROK = (id) => id === 'grok-imagine-video';

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const _cache = {
  model: 'kling-v2.5-turbo-std',
  prompt: '',
  duration: 5,
  negativePrompt: '',
  guidanceScale: 0.5,
  resolution: '720p',
  motionSourceType: 'url',
  motionUrl: '',
  characterOrientation: 'image',
};

export default function VideoPage() {
  const { notify } = useApp();

  const [model, setModel] = useState(_cache.model);
  const [prompt, setPrompt] = useState(_cache.prompt);
  const [duration, setDuration] = useState(_cache.duration);
  const [negativePrompt, setNegativePrompt] = useState(_cache.negativePrompt);
  const [guidanceScale, setGuidanceScale] = useState(_cache.guidanceScale);
  const [resolution, setResolution] = useState(_cache.resolution);

  const [sourceImage, setSourceImage] = useState(null);
  const [sourcePreview, setSourcePreview] = useState(null);
  const [sourceGalleryId, setSourceGalleryId] = useState(null);

  const [lastFrameImage, setLastFrameImage] = useState(null);
  const [lastFramePreview, setLastFramePreview] = useState(null);

  const [motionSourceType, setMotionSourceType] = useState(_cache.motionSourceType);
  const [motionUrl, setMotionUrl] = useState(_cache.motionUrl);
  const [motionVideo, setMotionVideo] = useState(null);
  const [characterOrientation, setCharacterOrientation] = useState(_cache.characterOrientation);
  const [keepOriginalSound, setKeepOriginalSound] = useState(true);

  const [galleryImages, setGalleryImages] = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [showGallery, setShowGallery] = useState(false);

  const [loading, setLoading] = useState(false);
  const [taskId, setTaskId] = useState(null);
  const [result, setResult] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startTimeRef = useRef(null);

  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  useEffect(() => { _cache.model = model; }, [model]);
  useEffect(() => { _cache.prompt = prompt; }, [prompt]);
  useEffect(() => { _cache.duration = duration; }, [duration]);
  useEffect(() => { _cache.negativePrompt = negativePrompt; }, [negativePrompt]);
  useEffect(() => { _cache.guidanceScale = guidanceScale; }, [guidanceScale]);
  useEffect(() => { _cache.resolution = resolution; }, [resolution]);
  useEffect(() => { _cache.motionSourceType = motionSourceType; }, [motionSourceType]);
  useEffect(() => { _cache.motionUrl = motionUrl; }, [motionUrl]);
  useEffect(() => { _cache.characterOrientation = characterOrientation; }, [characterOrientation]);

  const modelInfo = MODEL_MAP[model] || VIDEO_MODELS[0];

  useEffect(() => {
    const validDurations = modelInfo.durations;
    if (!validDurations.includes(duration)) {
      setDuration(validDurations[0]);
    }
  }, [model, modelInfo, duration]);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const data = await videoApi.history();
      setHistory(data);
    } catch {}
    finally { setHistoryLoading(false); }
  }, []);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  const fetchGallery = useCallback(async () => {
    setGalleryLoading(true);
    try {
      const res = await galleryApi.list();
      setGalleryImages(res.images || res || []);
    } catch {}
    finally { setGalleryLoading(false); }
  }, []);

  const pollFn = useCallback(async () => {
    if (!taskId) return null;
    return await videoApi.status(taskId);
  }, [taskId]);

  const { data: pollData, active: polling, start: startPolling, stop: stopPolling } = usePoll(pollFn, 2000);

  useEffect(() => {
    if (!pollData) return;
    if (pollData.status === 'completed') {
      stopPolling();
      setLoading(false);
      setResult(pollData);
      fetchHistory();
      notify('Video generation complete!', 'success');
    } else if (pollData.status === 'failed') {
      stopPolling();
      setLoading(false);
      notify(pollData.error || 'Video generation failed', 'error');
      fetchHistory();
    }
  }, [pollData, stopPolling, fetchHistory, notify]);

  useEffect(() => {
    if (!polling && loading && taskId && pollData?.status !== 'failed' && pollData?.status !== 'completed') {
      setLoading(false);
      notify('Lost connection to video task — check history later', 'error');
    }
  }, [polling, loading, taskId, notify, pollData]);

  useEffect(() => {
    if (!loading) {
      startTimeRef.current = null;
      return;
    }
    startTimeRef.current = Date.now();
    setElapsedSec(0);
    const iv = setInterval(() => {
      if (startTimeRef.current) setElapsedSec(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(iv);
  }, [loading]);

  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await fileToBase64(file);
    setSourceImage(dataUrl);
    setSourcePreview(dataUrl);
    setSourceGalleryId(null);
  };

  const handleLastFrameUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await fileToBase64(file);
    setLastFrameImage(dataUrl);
    setLastFramePreview(dataUrl);
  };

  const handleMotionVideoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await fileToBase64(file);
    setMotionVideo(dataUrl);
  };

  const handleGenerate = async () => {
    if (!sourceImage && !sourceGalleryId) {
      notify('Select or upload a source image first', 'error');
      return;
    }

    if (IS_MOTION(model)) {
      if (motionSourceType === 'url' && !motionUrl.trim()) {
        notify('Enter a Reel/TikTok URL for motion reference', 'error');
        return;
      }
      if (motionSourceType === 'upload' && !motionVideo) {
        notify('Upload a reference video for motion control', 'error');
        return;
      }
    }

    setLoading(true);
    setResult(null);
    setTaskId(null);

    try {
      const body = { model };
      if (!IS_MOTION(model)) body.duration = duration;
      if (prompt.trim()) body.prompt = prompt.trim();
      if (negativePrompt.trim()) body.negativePrompt = negativePrompt.trim();

      if (sourceGalleryId) {
        body.galleryId = sourceGalleryId;
      } else if (sourceImage) {
        const match = sourceImage.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          body.image = match[2];
          body.imageMimeType = match[1];
        } else {
          body.image = sourceImage;
        }
      }

      if (!IS_MOTION(model)) {
        if (model === 'kling-v2.5-turbo-std' || model === 'kling-v2.5-turbo-pro') {
          body.guidanceScale = guidanceScale;
        }
        if (IS_GROK(model)) {
          body.resolution = resolution;
        }
        if (IS_PRO(model) && lastFrameImage) {
          const m = lastFrameImage.match(/^data:([^;]+);base64,(.+)$/);
          if (m) {
            body.lastImage = m[2];
            body.lastImageMimeType = m[1];
          } else {
            body.lastImage = lastFrameImage;
          }
        }
      } else {
        body.characterOrientation = characterOrientation;
        body.keepOriginalSound = keepOriginalSound;
        if (motionSourceType === 'url') {
          body.motionSource = { type: 'url', url: motionUrl.trim() };
        } else {
          const m = motionVideo?.match(/^data:([^;]+);base64,(.+)$/);
          body.motionSource = { type: 'upload', videoBase64: m ? m[2] : motionVideo };
        }
      }

      const res = await videoApi.generate(body);
      if (res.status === 'failed') {
        setLoading(false);
        notify('WaveSpeed returned an error — try again or pick a different model', 'error');
        fetchHistory();
        return;
      }
      setTaskId(res.taskId);
      startPolling();
    } catch (err) {
      setLoading(false);
      notify(err.message || 'Failed to start video generation', 'error');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await videoApi.removeHistory(deleteTarget);
      setHistory((prev) => prev.filter((h) => h.id !== deleteTarget));
      notify('Video removed', 'info');
    } catch (err) {
      notify(err.message || 'Failed to delete', 'error');
    }
    setDeleteTarget(null);
  };

  const STEPS = IS_MOTION(model)
    ? ['Uploading image & video', 'Submitting to WaveSpeed', 'Generating video']
    : ['Uploading image', 'Submitting to WaveSpeed', 'Generating video'];

  const stepIndex = loading ? (taskId ? 2 : 0) : -1;

  return (
    <div className="space-y-6 animate-in">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Controls */}
        <div className="lg:col-span-2 space-y-4">
          {/* Source Image */}
          <Card className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Source Image</h3>
            <div className="flex items-start gap-4">
              {sourcePreview ? (
                <div className="relative shrink-0">
                  <img src={sourcePreview} alt="Source" className="w-32 h-32 object-cover rounded-lg border border-zinc-700/60" />
                  <button onClick={() => { setSourceImage(null); setSourcePreview(null); setSourceGalleryId(null); }}
                    className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 text-xs flex items-center justify-center hover:text-white cursor-pointer">
                    ×
                  </button>
                </div>
              ) : (
                <div className="w-32 h-32 rounded-lg border-2 border-dashed border-zinc-700/60 flex items-center justify-center text-zinc-600 text-xs text-center shrink-0">
                  No image
                </div>
              )}
              <div className="flex flex-col gap-2 flex-1">
                <div className="flex items-center gap-2">
                  <label className="cursor-pointer">
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleImageUpload} />
                    <span className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700/60 transition-colors">
                      Upload Image
                    </span>
                  </label>
                  <button
                    onClick={() => { if (!showGallery) fetchGallery(); setShowGallery((v) => !v); }}
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700/60 transition-colors cursor-pointer"
                  >
                    {showGallery ? 'Hide Gallery' : 'Pick from Gallery'}
                  </button>
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
                        onClick={() => {
                          setSourceGalleryId(img.id);
                          setSourcePreview(galleryApi.imageUrl(img.id));
                          setSourceImage(null);
                          setShowGallery(false);
                        }}
                        className={`relative aspect-square overflow-hidden rounded-lg border transition-all cursor-pointer hover:scale-[1.03] hover:shadow-[0_0_16px_rgba(59,130,246,0.2)] ${
                          sourceGalleryId === img.id
                            ? 'border-2 border-blue-500 shadow-[0_0_14px_rgba(59,130,246,0.3)]'
                            : 'border-zinc-700/50 hover:border-zinc-600'
                        }`}
                      >
                        <img src={galleryApi.imageUrl(img.id)} alt="" className="h-full w-full object-cover" loading="lazy" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Model Selection */}
          <Card className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Model</h3>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-lg border border-zinc-700/60 bg-zinc-900/50 px-3 py-2.5 text-sm text-zinc-100 outline-none transition-all duration-200 cursor-pointer inset-depth hover:border-zinc-600 focus:border-blue-500/70 focus:ring-2 focus:ring-blue-500/20"
            >
              {VIDEO_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label} — {m.desc}</option>
              ))}
            </select>
            {modelInfo.prices && (
              <div className="flex items-center gap-3 text-[11px] text-zinc-500">
                {Object.entries(modelInfo.prices).map(([dur, price]) => (
                  <span key={dur}>{dur}s → <span className="text-zinc-300 font-medium font-mono tabular-nums">${price.toFixed(2)}</span></span>
                ))}
              </div>
            )}
          </Card>

          {/* Prompt */}
          <Card className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Motion Prompt <span className="text-zinc-600 font-normal normal-case">(optional)</span></h3>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the motion or changes you want in the video..."
              rows={3}
              maxLength={2500}
              className="w-full rounded-lg border border-zinc-700/60 bg-zinc-800/60 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 inset-depth focus:outline-none focus:ring-2 focus:ring-blue-500/20 resize-y min-h-[72px]"
            />
            <div className="text-[10px] text-zinc-600 text-right">{prompt.length}/2500</div>
          </Card>

          {/* Settings */}
          <Card className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Settings</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {/* Duration */}
              <div className="space-y-1.5">
                <span className="text-xs text-zinc-400 font-medium">Duration</span>
                {IS_MOTION(model) ? (
                  <p className="text-xs text-zinc-500 py-1">Follows source video length</p>
                ) : (
                  <div className="flex gap-1">
                    {modelInfo.durations.map((d) => (
                      <button key={d} onClick={() => setDuration(d)}
                        className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium border transition-colors cursor-pointer ${
                          duration === d
                            ? 'border-blue-500/50 bg-blue-600/12 text-blue-400'
                            : 'border-zinc-700/40 bg-zinc-800/40 text-zinc-500 hover:text-zinc-300'
                        }`}>
                        {d}s
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Guidance Scale (Kling only) */}
              {(model === 'kling-v2.5-turbo-std' || model === 'kling-v2.5-turbo-pro') && (
                <div className="space-y-1.5">
                  <Slider label="Guidance Scale" value={guidanceScale} onChange={(e) => setGuidanceScale(parseFloat(e.target.value))} min={0} max={1} step={0.05} />
                </div>
              )}

              {/* Resolution (Grok only) */}
              {IS_GROK(model) && (
                <div className="space-y-1.5">
                  <span className="text-xs text-zinc-400 font-medium">Resolution</span>
                  <div className="flex gap-1">
                    {['720p', '480p'].map((r) => (
                      <button key={r} onClick={() => setResolution(r)}
                        className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium border transition-colors cursor-pointer ${
                          resolution === r
                            ? 'border-blue-500/50 bg-blue-600/12 text-blue-400'
                            : 'border-zinc-700/40 bg-zinc-800/40 text-zinc-500 hover:text-zinc-300'
                        }`}>
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Negative Prompt */}
            <Section title="Negative Prompt" hint="Describe what you don't want in the video">
              <textarea
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                placeholder="Things to avoid..."
                rows={2}
                className="w-full rounded-lg border border-zinc-700/60 bg-zinc-800/60 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 inset-depth focus:outline-none focus:ring-2 focus:ring-blue-500/20 resize-y"
              />
            </Section>
          </Card>

          {/* Motion Control (Kling v2.6 only) */}
          {IS_MOTION(model) && (
            <Card className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Motion Source</h3>
              <p className="text-xs text-zinc-500">The reference video whose motion will be transferred to your image.</p>

              <div className="flex gap-1 rounded-lg bg-zinc-800/60 p-0.5 w-fit">
                {[{ key: 'url', label: 'Reel / TikTok URL' }, { key: 'upload', label: 'Upload Video' }].map((tab) => (
                  <button key={tab.key} onClick={() => setMotionSourceType(tab.key)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                      motionSourceType === tab.key ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                    }`}>
                    {tab.label}
                  </button>
                ))}
              </div>

              {motionSourceType === 'url' ? (
                <input
                  type="text"
                  value={motionUrl}
                  onChange={(e) => setMotionUrl(e.target.value)}
                  placeholder="https://www.instagram.com/reel/... or TikTok URL"
                  className="w-full rounded-lg border border-zinc-700/60 bg-zinc-800/60 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 inset-depth focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              ) : (
                <div className="space-y-2">
                  <label className="cursor-pointer">
                    <input type="file" accept="video/mp4,video/quicktime,video/webm" className="hidden" onChange={handleMotionVideoUpload} />
                    <span className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700/60 transition-colors">
                      {motionVideo ? 'Replace Video' : 'Upload Video'}
                    </span>
                  </label>
                  {motionVideo && <Badge color="green">Video loaded</Badge>}
                  <p className="text-[10px] text-zinc-600">MP4, MOV, WebM. Max 120MB.</p>
                </div>
              )}

              <div className="flex items-start gap-6">
                <div className="space-y-1.5">
                  <span className="text-xs text-zinc-400 font-medium">Character Orientation</span>
                  <div className="flex gap-1">
                    {[{ key: 'image', label: 'From Image' }, { key: 'video', label: 'From Video' }].map((o) => (
                      <button key={o.key} onClick={() => setCharacterOrientation(o.key)}
                        className={`rounded-md px-3 py-1.5 text-xs font-medium border transition-colors cursor-pointer ${
                          characterOrientation === o.key
                            ? 'border-blue-500/50 bg-blue-600/12 text-blue-400'
                            : 'border-zinc-700/40 bg-zinc-800/40 text-zinc-500 hover:text-zinc-300'
                        }`}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-xs text-zinc-400 font-medium">Keep Original Sound</span>
                  <button
                    onClick={() => setKeepOriginalSound((v) => !v)}
                    className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium border transition-colors cursor-pointer ${
                      keepOriginalSound
                        ? 'border-blue-500/50 bg-blue-600/12 text-blue-400'
                        : 'border-zinc-700/40 bg-zinc-800/40 text-zinc-500 hover:text-zinc-300'
                    }`}>
                    {keepOriginalSound ? 'On' : 'Off'}
                  </button>
                </div>
              </div>
            </Card>
          )}

          {/* End Frame (Kling Pro only) */}
          {IS_PRO(model) && (
            <Card className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">End Frame <span className="text-zinc-600 font-normal normal-case">(optional)</span></h3>
              <p className="text-xs text-zinc-500">Upload an image for the last frame to control the video ending.</p>
              <div className="flex items-center gap-3">
                {lastFramePreview ? (
                  <div className="relative shrink-0">
                    <img src={lastFramePreview} alt="End frame" className="w-20 h-20 object-cover rounded-lg border border-zinc-700/60" />
                    <button onClick={() => { setLastFrameImage(null); setLastFramePreview(null); }}
                      className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 text-xs flex items-center justify-center hover:text-white cursor-pointer">
                      ×
                    </button>
                  </div>
                ) : null}
                <label className="cursor-pointer">
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleLastFrameUpload} />
                  <span className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700/60 transition-colors">
                    {lastFramePreview ? 'Replace' : 'Upload End Frame'}
                  </span>
                </label>
              </div>
            </Card>
          )}

          {/* Generate Button */}
          <Btn onClick={handleGenerate} disabled={loading} className="w-full">
            {loading ? 'Generating...' : `Generate Video${modelInfo.prices?.[duration] ? ` · $${modelInfo.prices[duration].toFixed(2)}` : ''}`}
          </Btn>
        </div>

        {/* Right column: Result + History */}
        <div className="space-y-4">
          {/* Progress */}
          {loading && (
            <StepProgress steps={STEPS} currentIndex={stepIndex} elapsedSec={elapsedSec} />
          )}

          {/* Result */}
          {result && result.outputs?.length > 0 && (
            <Card className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Result</h3>
              <video
                src={result.localFilename ? videoApi.fileUrl(result.localFilename) : result.outputs[0]}
                controls
                autoPlay
                loop
                className="w-full rounded-lg border border-zinc-700/60"
              />
              <div className="flex items-center gap-2">
                <a
                  href={result.localFilename ? videoApi.fileUrl(result.localFilename) : result.outputs[0]}
                  download
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700/60 transition-colors"
                >
                  Download
                </a>
                <Btn variant="ghost" onClick={() => { setResult(null); setTaskId(null); }}>
                  Generate Again
                </Btn>
              </div>
              {result.timings?.inference && (
                <p className="text-[10px] text-zinc-600">Generated in {(result.timings.inference / 1000).toFixed(1)}s</p>
              )}
            </Card>
          )}

          {/* No result yet */}
          {!loading && !result && (
            <Card className="flex items-center justify-center py-12">
              <Empty icon="video" title="No video yet" subtitle="Configure settings and click Generate" />
            </Card>
          )}

          {/* History */}
          <Card className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">History</h3>
              <Btn variant="ghost" onClick={fetchHistory} disabled={historyLoading} className="text-xs">
                {historyLoading ? <Spinner size={14} /> : 'Refresh'}
              </Btn>
            </div>

            {history.length === 0 ? (
              <p className="text-xs text-zinc-500 py-2">No videos generated yet.</p>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {history.map((h) => (
                  <div key={h.id} className="flex items-center gap-3 rounded-lg border border-zinc-700/30 bg-zinc-800/30 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge color={h.status === 'completed' ? 'green' : h.status === 'failed' ? 'red' : 'blue'}>
                          {h.status}
                        </Badge>
                        <span className="text-[10px] text-zinc-600">{MODEL_MAP[h.model]?.label || h.model}</span>
                      </div>
                      {h.prompt && <p className="text-xs text-zinc-500 truncate mt-0.5">{h.prompt}</p>}
                      <p className="text-[10px] text-zinc-600 mt-0.5">{new Date(h.createdAt).toLocaleString()}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {h.filename && (
                        <a href={videoApi.fileUrl(h.filename)} download
                          className="text-xs text-zinc-500 hover:text-zinc-300 px-1.5 py-1 rounded hover:bg-zinc-700/50 transition-colors">
                          DL
                        </a>
                      )}
                      <button onClick={() => setDeleteTarget(h.id)}
                        className="text-xs text-zinc-600 hover:text-red-400 px-1.5 py-1 rounded hover:bg-zinc-700/50 transition-colors cursor-pointer">
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Video"
        message="This will permanently delete the video file and history entry."
        confirmLabel="Delete"
      />
    </div>
  );
}
