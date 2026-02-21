import { useState, useEffect, useMemo } from 'react';
import { story as storyApi, niches as nichesApi, gallery as galleryApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { useStepTimer } from '../hooks/useStepTimer';
import { Card, Btn, Select, Toggle, Slider, Spinner, Badge, Empty, CopyBtn, StepProgress } from '../components/UI';

const CTA_TYPES = [
  { value: 'follow', label: 'Follow' },
  { value: 'like', label: 'Like' },
  { value: 'comment', label: 'Comment' },
  { value: 'share', label: 'Share' },
  { value: 'save', label: 'Save' },
  { value: 'link', label: 'Link in Bio' },
  { value: 'dm', label: 'DM' },
  { value: 'custom', label: 'Custom' },
];

export default function StorytellerPage() {
  const { notify } = useApp();
  const { loading, run } = useAsync();
  const [niches, setNiches] = useState([]);
  const [galleryImages, setGalleryImages] = useState([]);
  const [nicheId, setNicheId] = useState('');
  const [customNiche, setCustomNiche] = useState('');
  const [selectedImages, setSelectedImages] = useState([]);
  const [viralMode, setViralMode] = useState(false);
  const [hashtagCount, setHashtagCount] = useState(15);
  const [ctaType, setCtaType] = useState('follow');
  const [includeHashtags, setIncludeHashtags] = useState(true);
  const [result, setResult] = useState(null);

  const STORY_STEPS = useMemo(() => [
    'Uploading images to gallery',
    'Analyzing visual narrative',
    'Crafting story captions and hooks',
    'Generating hashtags and CTA',
  ], []);
  const STORY_THRESHOLDS = useMemo(() => [3, 8, 15], []);
  const { elapsedSec, stepIndex: storyStepIndex } = useStepTimer(loading, STORY_THRESHOLDS);

  useEffect(() => {
    nichesApi.list().then((data) => {
      setNiches(data);
      if (data.length > 0 && !nicheId) setNicheId(data[0].id);
    }).catch(() => {});

    galleryApi.list().then((data) => {
      setGalleryImages(data || []);
    }).catch(() => {});
  }, []);

  const addGalleryImage = (image) => {
    setSelectedImages((prev) => {
      if (prev.length >= 10) return prev;
      if (prev.some((item) => item.id && item.id === image.id)) return prev;
      return [...prev, { id: image.id, preview: `/api/gallery/${image.id}/image` }];
    });
  };

  const handleUploadImage = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setSelectedImages((prev) => {
      if (prev.length >= 10) return prev;
      return [...prev, { file, preview: URL.createObjectURL(file) }];
    });

    event.target.value = '';
  };

  const removeSelectedImage = (idx) => {
    setSelectedImages((prev) => {
      const item = prev[idx];
      // Defer revocation so the image element can finish its current render cycle
      if (item?.file && item.preview) {
        setTimeout(() => URL.revokeObjectURL(item.preview), 100);
      }
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleGenerate = () => run(async ({ signal }) => {
    if (selectedImages.length === 0) {
      notify('Select at least one image', 'error');
      return;
    }

    if (!nicheId) {
      notify('Select a niche', 'error');
      return;
    }

    if (nicheId === 'custom' && !customNiche.trim()) {
      notify('Enter your niche', 'error');
      return;
    }

    const imageIds = [];

    for (const image of selectedImages) {
      if (image.id) {
        imageIds.push(image.id);
        continue;
      }

      if (image.file) {
        const fd = new FormData();
        fd.append('file', image.file);
        fd.append('prompt', image.file.name || 'External upload');
        fd.append('source', 'upload');

        const uploadUrl = '/api/gallery/upload';
        const res = await fetch(uploadUrl, {
          method: 'POST',
          body: fd,
          signal,
        });
        const json = await res.json().catch(() => null);

        if (!res.ok || !json?.data?.id) {
          throw new Error(json?.error?.message || 'Failed to upload external image');
        }

        imageIds.push(json.data.id);
      }
    }

    const finalNicheId = nicheId === 'custom' ? (niches[0]?.id || '') : nicheId;
    if (!finalNicheId) {
      notify('No niche available', 'error');
      return;
    }

    const payload = {
      imageIds,
      nicheId: finalNicheId,
      viralMode,
      includeHashtags,
      hashtagCount,
      ctaType,
    };
    const data = await storyApi.generate(payload);

    setResult(data);
    notify('Story generated!', 'success');
  });

  const allText = result
    ? [result.hook, ...result.slides.map((s) => s.caption), result.finalCTA, result.hashtags?.map((h) => `#${h}`).join(' ')].filter(Boolean).join('\n\n')
    : '';

  return (
    <div className="space-y-6 animate-in">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-gradient">Storyteller</h1>
        <p className="text-zinc-500 text-sm mt-1">AI-powered carousel captions with niche-specific voice and viral techniques.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Controls */}
        <div className="lg:col-span-1 space-y-4">
          <Card className="space-y-4">
            <h3 className="text-sm font-semibold text-zinc-300">Select Images ({selectedImages.length}/10)</h3>

            <label className="inline-flex cursor-pointer items-center rounded-lg border border-dashed border-zinc-700/80 px-3 py-2 text-xs text-zinc-300 hover:border-blue-500/70 hover:text-blue-300 transition">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={handleUploadImage}
              />
              Upload External Image
            </label>

            {galleryImages.length === 0 ? (
              <p className="text-xs text-zinc-500">No gallery images found.</p>
            ) : (
              <div className="grid grid-cols-5 gap-2 max-h-48 overflow-y-auto pr-1">
                {galleryImages.slice(0, 60).map((img) => (
                  <button
                    key={img.id}
                    type="button"
                    onClick={() => addGalleryImage(img)}
                    disabled={selectedImages.length >= 10}
                    className="aspect-square overflow-hidden rounded-lg border border-zinc-700/60 bg-zinc-900 hover:border-zinc-500 transition disabled:opacity-50"
                  >
                    <img src={`/api/gallery/${img.id}/image`} alt="" className="h-full w-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            )}

            {selectedImages.length > 0 && (
              <div className="grid grid-cols-5 gap-2">
                {selectedImages.map((image, index) => (
                  <div key={`${image.id || 'file'}-${index}`} className="relative aspect-square overflow-hidden rounded-lg border border-zinc-700/80">
                    <img
                      src={image.id ? `/api/gallery/${image.id}/image` : image.preview}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeSelectedImage(index)}
                      aria-label="Remove image"
                      className="absolute right-1 top-1 h-5 w-5 rounded-full bg-black/80 text-xs text-white hover:bg-red-500 transition"
                    >
                      X
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">Niche</label>
              <select
                value={nicheId}
                onChange={(e) => setNicheId(e.target.value)}
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
              >
                {niches.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                <option value="custom">Custom</option>
              </select>
            </div>

            {nicheId === 'custom' && (
              <input
                type="text"
                value={customNiche}
                onChange={(e) => setCustomNiche(e.target.value)}
                placeholder="Enter your niche..."
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none transition-all duration-200 hover:border-zinc-600 focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20"
              />
            )}

            <Toggle checked={viralMode} onChange={setViralMode} label="Viral Mode" />
            <Toggle checked={includeHashtags} onChange={setIncludeHashtags} label="Include Hashtags" />
            {includeHashtags && (
              <Slider label="Hashtag Count" value={hashtagCount} onChange={(v) => setHashtagCount(Math.round(v))} min={1} max={25} step={1} />
            )}
            <Select label="CTA Type" value={ctaType} onChange={(e) => setCtaType(e.target.value)} options={CTA_TYPES} />
            <Btn onClick={handleGenerate} disabled={loading || selectedImages.length === 0 || !nicheId || (nicheId === 'custom' && !customNiche.trim())} className="w-full">
              {loading ? <><Spinner size={16} /> Generating... {elapsedSec}s</> : 'Generate Captions'}
            </Btn>
          </Card>
        </div>

        {/* Output */}
        <div className="lg:col-span-2">
          {!result && !loading ? (
            <Card className="flex items-center justify-center py-20">
              <Empty icon="Writer" title="No story yet" subtitle="Select images and a niche, then generate" />
            </Card>
          ) : loading ? (
            <StepProgress steps={STORY_STEPS} currentIndex={storyStepIndex} elapsedSec={elapsedSec} className="min-h-[360px]" />
          ) : result ? (
            <div className="space-y-4">
              <div className="flex justify-end">
                <CopyBtn text={allText} className="!text-sm" />
              </div>

              {/* Hook */}
              <Card className="animate-in border-l-4 !border-l-blue-500">
                <div className="flex items-start justify-between">
                  <Badge color="blue">Hook</Badge>
                  <CopyBtn text={result.hook} />
                </div>
                <p className="mt-2 text-zinc-100 font-medium leading-relaxed">{result.hook}</p>
              </Card>

              {/* Slides */}
              {result.slides.map((s) => (
                <Card key={s.slide} className="animate-in" style={{ animationDelay: `${s.slide * 60}ms` }}>
                  <div className="flex items-start justify-between">
                    <Badge color="zinc">Slide {s.slide}</Badge>
                    <CopyBtn text={s.caption} />
                  </div>
                  <p className="mt-2 text-zinc-200 leading-relaxed">{s.caption}</p>
                </Card>
              ))}

              {/* CTA */}
              <Card className="animate-in border-l-4 !border-l-green-500">
                <div className="flex items-start justify-between">
                  <Badge color="green">Final CTA</Badge>
                  <CopyBtn text={result.finalCTA} />
                </div>
                <p className="mt-2 text-zinc-100 font-medium leading-relaxed">{result.finalCTA}</p>
              </Card>

              {/* Hashtags */}
              {result.hashtags?.length > 0 && (
                <Card className="animate-in">
                  <div className="flex items-start justify-between mb-3">
                    <Badge color="blue">Hashtags ({result.hashtags.length})</Badge>
                    <CopyBtn text={result.hashtags.map((h) => `#${h}`).join(' ')} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {result.hashtags.map((h, i) => (
                      <Badge key={i} color="blue">#{h}</Badge>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
