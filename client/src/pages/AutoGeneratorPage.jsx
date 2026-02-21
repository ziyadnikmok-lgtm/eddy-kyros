import { lazy, Suspense, useEffect, useRef, useState, useMemo } from 'react';
import { batch as batchApi, styleLibrary as styleApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useStepTimer } from '../hooks/useStepTimer';
import { Card, Btn, Input, Toggle, Slider, Spinner, Empty, Badge, ImageCard, StepProgress, Section, Hint } from '../components/UI';

const StyleAtomPicker = lazy(() => import('../components/StyleAtomPicker'));

export default function AutoGeneratorPage() {
  const { notify, characters } = useApp();

  const [theme, setTheme] = useState('');
  const [personaMode, setPersonaMode] = useState('luxury');
  const [customPersona, setCustomPersona] = useState('');
  const [spicinessLevel, setSpicinessLevel] = useState(30);
  const [duration, setDuration] = useState(7);
  const [characterId, setCharacterId] = useState('');
  const [includeReels, setIncludeReels] = useState(true);
  const [includeStories, setIncludeStories] = useState(false);
  const [carouselCount, setCarouselCount] = useState(3);
  const [reelCount, setReelCount] = useState(1);
  const [storyCount, setStoryCount] = useState(1);
  const [similarityCooldown, setSimilarityCooldown] = useState('on');
  const [footwearLock, setFootwearLock] = useState('');
  const [autoExecute, setAutoExecute] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [executeJobs, setExecuteJobs] = useState([]);

  // Style Library
  const [styleAtomIds, setStyleAtomIds] = useState([]);
  const [styleAtomDetails, setStyleAtomDetails] = useState([]);
  const [showAtomPicker, setShowAtomPicker] = useState(false);

  // Auto-select first character when list arrives and none selected yet
  useEffect(() => {
    if (!characterId && characters.length > 0) {
      setCharacterId(characters[0].id);
    }
  }, [characters, characterId]);

  useEffect(() => {
    if (!result || result.mode !== 'execute' || !Array.isArray(result.data?.jobIds) || result.data.jobIds.length === 0) {
      setExecuteJobs([]);
      return undefined;
    }

    let cancelled = false;
    const jobIds = result.data.jobIds;

    const fetchJobs = async () => {
      try {
        const jobs = await Promise.all(jobIds.map((jobId) => batchApi.get(jobId).catch(() => null)));
        if (!cancelled) {
          setExecuteJobs(jobs.filter(Boolean));
        }
      } catch {
        // keep previous results during transient polling failures
      }
    };

    fetchJobs();
    const interval = setInterval(fetchJobs, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [result]);

  const AUTO_STEPS = useMemo(() => autoExecute
    ? ['Building content plan with Gemini', 'Submitting batch generation jobs', 'Starting image generation']
    : ['Analyzing theme and persona', 'Building content plan with Gemini', 'Formatting schedule output'],
  [autoExecute]);
  const AUTO_THRESHOLDS = useMemo(() => [3, 8], []);
  const { elapsedSec: loadingElapsedSec, stepIndex: autoStepIndex } = useStepTimer(loading, AUTO_THRESHOLDS);

  const isExecuteRunning = executeJobs.some((job) => job?.status === 'running');
  const EXEC_THRESHOLDS = useMemo(() => [5], []);
  const { elapsedSec: executeElapsedSec } = useStepTimer(isExecuteRunning, EXEC_THRESHOLDS);

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
    setStyleAtomIds((prev) => prev.filter((x) => x !== id));
    setStyleAtomDetails((prev) => prev.filter((x) => x.id !== id));
  };

  const abortRef = useRef(null);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const handleGenerate = async () => {
    if (!characterId) {
      notify('Character is required', 'error');
      return;
    }
    if (!theme.trim()) {
      notify('Theme is required', 'error');
      return;
    }

    const durationInt = Number.parseInt(String(duration), 10);
    const carouselCountInt = Number.parseInt(String(carouselCount), 10);
    const reelCountInt = Number.parseInt(String(reelCount), 10);
    const storyCountInt = Number.parseInt(String(storyCount), 10);
    if (!Number.isInteger(durationInt) || durationInt < 1 || durationInt > 14) {
      notify('Duration must be between 1 and 14', 'error');
      return;
    }
    if (!Number.isInteger(carouselCountInt) || carouselCountInt < 1 || carouselCountInt > 10) {
      notify('Carousel posts per day must be between 1 and 10', 'error');
      return;
    }
    if (!Number.isInteger(reelCountInt) || reelCountInt < 1 || reelCountInt > 10) {
      notify('Reels per day must be between 1 and 10', 'error');
      return;
    }
    if (!Number.isInteger(storyCountInt) || storyCountInt < 1 || storyCountInt > 10) {
      notify('Stories per day must be between 1 and 10', 'error');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const endpoint = autoExecute ? '/api/auto/execute' : '/api/auto/plan';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          theme: theme.trim(),
          personaMode,
          customPersona,
          spicinessLevel,
          duration: durationInt,
          characterId,
          includeReels,
          includeStories,
          carouselCount: carouselCountInt,
          reelCount: reelCountInt,
          storyCount: storyCountInt,
          similarityCooldown,
          footwearLock: footwearLock.trim() || undefined,
          styleAtomIds: styleAtomIds.length > 0 ? styleAtomIds : undefined,
        }),
        signal: controller.signal,
      });

      const json = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(json?.error?.message || `Request failed (${response.status})`);
      }

      const data = json?.data;
      if (!data) {
        throw new Error('Invalid response from auto endpoint');
      }

      if (autoExecute) {
        if (!Array.isArray(data.jobIds)) {
          throw new Error('Invalid execute response format');
        }
      } else if (!Array.isArray(data)) {
        throw new Error('Invalid plan response format');
      }

      setResult({ mode: autoExecute ? 'execute' : 'plan', data });
      notify(autoExecute ? 'Generation started' : 'Plan generated', 'success');
    } catch (err) {
      if (err.name === 'AbortError') return;
      const msg = err.message || 'Failed to generate';
      notify(msg.includes('API') || msg.includes('key') ? msg : `Generation failed: ${msg}. Check your API key and character settings.`, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 animate-in">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-gradient">Auto Generator</h1>
        <p className="text-zinc-500 text-sm mt-1">Generate weekly plans or execute instantly from a single flow.</p>
      </div>

      <Card className="space-y-4">
        {/* ── Essential: Character, Theme, Persona ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-zinc-400 font-medium">Character</span>
            <select
              value={characterId}
              onChange={(e) => setCharacterId(e.target.value)}
              className="rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
            >
              <option value="">Select character...</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>

          <Input
            label="Theme"
            placeholder="Example: 1 week in Mykonos luxury vacation"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
          />

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-zinc-400 font-medium flex items-center gap-1.5">Persona Mode <Hint text="Sets the overall style and vibe direction. Each persona generates different types of content and aesthetics." /></span>
            <select
              value={personaMode}
              onChange={(e) => setPersonaMode(e.target.value)}
              className="rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
            >
              <option value="luxury">Luxury</option>
              <option value="of">OF Creator</option>
              <option value="fitness">Fitness</option>
              <option value="girl_next_door">Girl Next Door</option>
              <option value="high_fashion">High Fashion</option>
            </select>
          </label>

          <Input
            label="Duration (days)"
            type="number"
            min={1}
            max={14}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </div>

        {personaMode === 'of' && (
          <div>
            <Slider
              label="Spiciness Level"
              value={spicinessLevel}
              onChange={(value) => setSpicinessLevel(Math.round(value / 5) * 5)}
              min={0}
              max={100}
              step={5}
              className="rounded-lg border border-zinc-700/80 bg-zinc-800/60 px-3 py-3"
            />
            <span className="text-[10px] text-zinc-600 mt-0.5 block">0 = subtle, 100 = maximum suggestiveness</span>
          </div>
        )}

        {/* ── Collapsible: Content Schedule ── */}
        <Section title="Content Schedule" defaultOpen>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-zinc-400 font-medium">Carousel Posts / Day</span>
              <select
                value={carouselCount}
                onChange={(e) => setCarouselCount(e.target.value)}
                className="rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400 font-medium">Reels / Day</span>
                <Toggle checked={includeReels} onChange={setIncludeReels} />
              </div>
              <select
                value={reelCount}
                onChange={(e) => setReelCount(e.target.value)}
                disabled={!includeReels}
                className="rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400 font-medium">Stories / Day</span>
                <Toggle checked={includeStories} onChange={setIncludeStories} />
              </div>
              <select
                value={storyCount}
                onChange={(e) => setStoryCount(e.target.value)}
                disabled={!includeStories}
                className="rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
        </Section>

        {/* ── Collapsible: Advanced Options ── */}
        <Section title="Advanced Options" hint="Fine-tune the generation with custom persona overrides, footwear consistency, and duplicate prevention.">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-zinc-400 font-medium flex items-center gap-1.5">Custom Persona <Hint text="Override the preset persona with your own description. Leave empty to use the selected persona mode." /></span>
              <textarea
                value={customPersona}
                onChange={(e) => setCustomPersona(e.target.value)}
                rows={3}
                placeholder="Example: Seductive luxury influencer, mysterious energy, dominant gaze, always alone, high-end fashion, bold confidence."
                className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 resize-y"
              />
            </label>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <span className="text-zinc-400 font-medium text-sm flex items-center gap-1.5">Footwear Lock <Hint text="Forces the same footwear across all generated images for consistency." /></span>
                <input
                  placeholder="Example: white Nike Air Force 1 sneakers"
                  value={footwearLock}
                  onChange={(e) => setFootwearLock(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20"
                />
              </div>

              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-zinc-400 font-medium flex items-center gap-1.5">Similarity Cooldown <Hint text="Prevents similar-looking images from appearing in sequence. Keeps the feed looking varied." /></span>
                <select
                  value={similarityCooldown}
                  onChange={(e) => setSimilarityCooldown(e.target.value)}
                  className="rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
                >
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </label>
            </div>
          </div>
        </Section>

        {/* ── Collapsible: Style Library ── */}
        <Section title="Style Library" badge={styleAtomIds.length > 0 ? <Badge color="blue">{styleAtomIds.length}</Badge> : null} hint="Reusable style building blocks that shape the visual style. Additional atoms are auto-selected based on your theme.">
          <div className="flex items-center justify-end">
            <div className="flex items-center gap-2">
              {styleAtomIds.length > 0 && (
                <button onClick={() => { setStyleAtomIds([]); setStyleAtomDetails([]); }} className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer">Clear</button>
              )}
              <button onClick={() => setShowAtomPicker(true)} className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer">Browse Library</button>
            </div>
          </div>
          {styleAtomDetails.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {styleAtomDetails.map((a) => (
                <span key={a.id} className="inline-flex items-center gap-1 bg-blue-500/15 text-blue-400 text-xs px-2 py-0.5 rounded-full">
                  {a.category}
                  <button onClick={() => removeStyleAtom(a.id)} className="hover:text-red-400 cursor-pointer">&times;</button>
                </span>
              ))}
            </div>
          )}
          <p className="text-[10px] text-zinc-500">Auto-selects additional atoms based on theme keywords</p>
        </Section>

        <div className="flex items-center gap-3 pt-1">
          <Toggle checked={autoExecute} onChange={setAutoExecute} label="Generate instantly (skip preview)" />
          <Hint text="When on, images start generating immediately without showing the plan first." />
          <Btn onClick={handleGenerate} disabled={loading}>
            {loading ? <><Spinner size={16} /> Generating...</> : autoExecute ? 'Generate & Execute' : 'Generate Plan'}
          </Btn>
        </div>
      </Card>

      {loading && (
        <StepProgress steps={AUTO_STEPS} currentIndex={autoStepIndex} elapsedSec={loadingElapsedSec} className="min-h-[360px]" />
      )}

      {!loading && !result && (
        <Card className="flex items-center justify-center py-16">
          <Empty icon="Auto" title="No result yet" subtitle="Configure inputs and click Generate Plan" />
        </Card>
      )}

      {!loading && result?.mode === 'execute' && (
        <Card className="space-y-4">
          <h2 className="text-sm font-medium text-zinc-300">Execution Started</h2>
          <p className="text-sm text-zinc-200">Target images: {result.data.totalImages ?? 0}</p>
          {result.data.footwearLock && <p className="text-xs text-zinc-400">Footwear lock: {result.data.footwearLock}</p>}
          {Array.isArray(result.data.styleAtomIds) && result.data.styleAtomIds.length > 0 && (
            <p className="text-xs text-zinc-400">Style atoms: {result.data.styleAtomIds.length} active</p>
          )}
          {isExecuteRunning && <p className="text-xs text-zinc-500 font-mono">{executeElapsedSec}s elapsed</p>}
          <div>
            <p className="text-sm font-medium text-zinc-300 mb-2">Job IDs</p>
            <div className="flex flex-wrap gap-2">
              {(result.data.jobIds || []).map((jobId) => (
                <Badge key={jobId} color="blue">{jobId}</Badge>
              ))}
            </div>
          </div>
          {executeJobs.length > 0 && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-zinc-300">Live Results</p>
              <div className="space-y-2">
                {executeJobs.map((job) => (
                  <div key={job.jobId} className="rounded-lg border border-zinc-700/60 bg-zinc-900/50 px-3 py-2">
                    <div className="flex items-center justify-between text-xs text-zinc-400">
                      <span className="font-mono">{job.jobId}</span>
                      <span>{job.status} - {job.completed + job.failed}/{job.total}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {executeJobs
                  .flatMap((job) => (job.results || []))
                  .filter((item) => item && item.success && item.image && item.image.base64Data)
                  .map((item, idx) => (
                    <ImageCard
                      key={`${idx}-${item.index}`}
                      base64={item.image.base64Data}
                      mimeType={item.image.mimeType}
                      meta={{ seed: item.seed, identityConfidence: item.image?.validation?.identity_match_score }}
                    />
                  ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {!loading && result?.mode === 'plan' && Array.isArray(result.data) && (
        <div className="space-y-4">
          {result.data.map((dayBlock) => (
            <Card key={`day-${dayBlock.day}`} className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge color="zinc">Day {dayBlock.day}</Badge>
              </div>

              <div>
                <h3 className="text-sm font-medium text-zinc-300">Carousel Prompts</h3>
                {dayBlock.carouselPrompts?.length ? (
                  <ul className="mt-2 list-disc pl-5 space-y-1 text-sm text-zinc-200">
                    {dayBlock.carouselPrompts.map((prompt, idx) => (
                      <li key={`carousel-${dayBlock.day}-${idx}`}>{prompt}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-zinc-500">None</p>
                )}
              </div>

              <div>
                <h3 className="text-sm font-medium text-zinc-300">Lifestyle Prompt</h3>
                <p className="mt-1 text-sm text-zinc-200">{dayBlock.lifestylePrompt || 'None'}</p>
              </div>

              <div>
                <h3 className="text-sm font-medium text-zinc-300">Reel Prompts</h3>
                {dayBlock.reelPrompts?.length ? (
                  <ul className="mt-2 list-disc pl-5 space-y-1 text-sm text-zinc-200">
                    {dayBlock.reelPrompts.map((prompt, idx) => (
                      <li key={`reel-${dayBlock.day}-${idx}`}>{prompt}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-zinc-500">None</p>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

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
