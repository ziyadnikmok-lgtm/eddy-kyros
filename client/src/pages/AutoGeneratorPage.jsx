import { lazy, Suspense, useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { batch as batchApi, autoPlans as plansApi, styleLibrary as styleApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useStepTimer } from '../hooks/useStepTimer';
import { cn } from '../lib/utils';
import { Card, Btn, Input, Toggle, Slider, Spinner, Empty, Badge, ImageCard, StepProgress, Section, Hint } from '../components/UI';

const StyleAtomPicker = lazy(() => import('../components/StyleAtomPicker'));

/* ── Helpers ──────────────────────────────────────── */

function addDaysToDate(dateStr, offset) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + offset);
  return d;
}

function formatDayDate(startDate, dayOffset) {
  const d = addDaysToDate(startDate, dayOffset);
  return {
    weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
    date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  };
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

const STATUS_STYLES = {
  draft: { color: 'zinc', label: 'Draft' },
  partial: { color: 'blue', label: 'In Progress' },
  completed: { color: 'green', label: 'Completed' },
};

/* ── Day Cell ─────────────────────────────────────── */

function DayCell({ day, startDate, executed, executingDay, onExecute, expanded, onToggle }) {
  const { weekday, date } = formatDayDate(startDate, day.day - 1);
  const postCount = (day.carouselPrompts || []).length;
  const hasLifestyle = !!(day.lifestylePrompt);
  const reelCount = (day.reelPrompts || []).length;
  const storyCount = (day.storyPrompts || []).length;
  const total = postCount + (hasLifestyle ? 1 : 0) + reelCount + storyCount;
  const isExecuting = executingDay === day.day;

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'glass border rounded-xl p-3 text-left transition-all cursor-pointer w-full',
        executed ? 'border-green-500/40 bg-green-500/5' : 'border-zinc-700/60',
        expanded && 'ring-1 ring-blue-500/30 border-blue-500/40',
        'hover:border-zinc-600',
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{weekday}</p>
          <p className="text-sm font-medium text-zinc-200">{date}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {executed && <span className="w-2 h-2 rounded-full bg-green-400" title="Executed" />}
          <Badge color={executed ? 'green' : 'zinc'}>Day {day.day}</Badge>
        </div>
      </div>

      <div className="space-y-0.5 mb-2">
        {postCount > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
            {postCount} {postCount === 1 ? 'Post' : 'Posts'}
          </div>
        )}
        {hasLifestyle && (
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
            1 Lifestyle
          </div>
        )}
        {reelCount > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400 shrink-0" />
            {reelCount} {reelCount === 1 ? 'Reel' : 'Reels'}
          </div>
        )}
        {storyCount > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
            {storyCount} {storyCount === 1 ? 'Story' : 'Stories'}
          </div>
        )}
        {total === 0 && <p className="text-[10px] text-zinc-600">No content</p>}
      </div>

      <div className="flex items-center justify-between pt-1.5 border-t border-zinc-800/60">
        <span className="text-[10px] text-zinc-500">{total} image{total !== 1 ? 's' : ''}</span>
        {!executed && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onExecute(day.day); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onExecute(day.day); } }}
            className={cn(
              'text-[10px] font-medium px-2 py-0.5 rounded-md transition',
              isExecuting
                ? 'bg-blue-500/20 text-blue-300'
                : 'bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 hover:text-blue-300',
            )}
          >
            {isExecuting ? 'Starting...' : 'Execute'}
          </span>
        )}
        {executed && <span className="text-[10px] text-green-400 font-medium">Done</span>}
      </div>
    </button>
  );
}

/* ── Day Detail Panel ─────────────────────────────── */

function DayDetail({ day }) {
  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <Badge color="blue">Day {day.day} Details</Badge>
      </div>

      {(day.carouselPrompts || []).length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" /> Carousel Prompts
          </h3>
          <ul className="mt-2 space-y-2">
            {day.carouselPrompts.map((prompt, idx) => (
              <li key={idx} className="text-xs text-zinc-300 bg-zinc-800/50 rounded-lg p-2.5 whitespace-pre-wrap leading-relaxed">{prompt}</li>
            ))}
          </ul>
        </div>
      )}

      {day.lifestylePrompt && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" /> Lifestyle Prompt
          </h3>
          <p className="mt-2 text-xs text-zinc-300 bg-zinc-800/50 rounded-lg p-2.5 whitespace-pre-wrap leading-relaxed">{day.lifestylePrompt}</p>
        </div>
      )}

      {(day.reelPrompts || []).length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400" /> Reel Prompts
          </h3>
          <ul className="mt-2 space-y-2">
            {day.reelPrompts.map((prompt, idx) => (
              <li key={idx} className="text-xs text-zinc-300 bg-zinc-800/50 rounded-lg p-2.5 whitespace-pre-wrap leading-relaxed">{prompt}</li>
            ))}
          </ul>
        </div>
      )}

      {(day.storyPrompts || []).length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Story Prompts
          </h3>
          <ul className="mt-2 space-y-2">
            {day.storyPrompts.map((prompt, idx) => (
              <li key={idx} className="text-xs text-zinc-300 bg-zinc-800/50 rounded-lg p-2.5 whitespace-pre-wrap leading-relaxed">{prompt}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// Module-level session cache — survives unmount/remount when navigating away and back
const _cache = {
  theme: '',
  personaMode: 'luxury',
  customPersona: '',
  spicinessLevel: 30,
  duration: 7,
  characterId: '',
  includeReels: true,
  includeStories: false,
  carouselCount: 3,
  reelCount: 1,
  storyCount: 1,
  result: null,
  executeJobs: [],
  styleAtomIds: [],
  styleAtomDetails: [],
  activePlan: null,
  savedPlans: [],
  startDate: null,
  expandedDay: null,
};

/* ── Main Page ────────────────────────────────────── */

export default function AutoGeneratorPage() {
  const { notify, characters } = useApp();

  // ── Form state (unchanged) ──
  const [theme, setTheme] = useState(_cache.theme);
  const [personaMode, setPersonaMode] = useState(_cache.personaMode);
  const [customPersona, setCustomPersona] = useState(_cache.customPersona);
  const [spicinessLevel, setSpicinessLevel] = useState(_cache.spicinessLevel);
  const [duration, setDuration] = useState(_cache.duration);
  const [characterId, setCharacterId] = useState(_cache.characterId);
  const [includeReels, setIncludeReels] = useState(_cache.includeReels);
  const [includeStories, setIncludeStories] = useState(_cache.includeStories);
  const [carouselCount, setCarouselCount] = useState(_cache.carouselCount);
  const [reelCount, setReelCount] = useState(_cache.reelCount);
  const [storyCount, setStoryCount] = useState(_cache.storyCount);
  const [similarityCooldown, setSimilarityCooldown] = useState('on');
  const [footwearLock, setFootwearLock] = useState('');
  const [autoExecute, setAutoExecute] = useState(false);
  const [loading, setLoading] = useState(false);

  // ── Execute mode state (unchanged) ──
  const [result, setResult] = useState(_cache.result);
  const [executeJobs, setExecuteJobs] = useState(_cache.executeJobs);

  // ── Style Library (unchanged) ──
  const [styleAtomIds, setStyleAtomIds] = useState(_cache.styleAtomIds);
  const [styleAtomDetails, setStyleAtomDetails] = useState(_cache.styleAtomDetails);
  const [showAtomPicker, setShowAtomPicker] = useState(false);

  // ── Calendar view state ──
  const [activePlan, setActivePlan] = useState(_cache.activePlan);
  const [savedPlans, setSavedPlans] = useState(_cache.savedPlans);
  const [startDate, setStartDate] = useState(_cache.startDate || todayStr());
  const [expandedDay, setExpandedDay] = useState(_cache.expandedDay);
  const [executingDay, setExecutingDay] = useState(null);

  // Auto-select first character
  useEffect(() => {
    if (!characterId && characters.length > 0) {
      setCharacterId(characters[0].id);
    }
  }, [characters, characterId]);

  // ── Session cache sync ──
  useEffect(() => { _cache.theme = theme; }, [theme]);
  useEffect(() => { _cache.personaMode = personaMode; }, [personaMode]);
  useEffect(() => { _cache.customPersona = customPersona; }, [customPersona]);
  useEffect(() => { _cache.spicinessLevel = spicinessLevel; }, [spicinessLevel]);
  useEffect(() => { _cache.duration = duration; }, [duration]);
  useEffect(() => { _cache.characterId = characterId; }, [characterId]);
  useEffect(() => { _cache.includeReels = includeReels; }, [includeReels]);
  useEffect(() => { _cache.includeStories = includeStories; }, [includeStories]);
  useEffect(() => { _cache.carouselCount = carouselCount; }, [carouselCount]);
  useEffect(() => { _cache.reelCount = reelCount; }, [reelCount]);
  useEffect(() => { _cache.storyCount = storyCount; }, [storyCount]);
  useEffect(() => { _cache.result = result; }, [result]);
  useEffect(() => { _cache.executeJobs = executeJobs; }, [executeJobs]);
  useEffect(() => { _cache.styleAtomIds = styleAtomIds; }, [styleAtomIds]);
  useEffect(() => { _cache.styleAtomDetails = styleAtomDetails; }, [styleAtomDetails]);
  useEffect(() => { _cache.activePlan = activePlan; }, [activePlan]);
  useEffect(() => { _cache.savedPlans = savedPlans; }, [savedPlans]);
  useEffect(() => { _cache.startDate = startDate; }, [startDate]);
  useEffect(() => { _cache.expandedDay = expandedDay; }, [expandedDay]);

  // Load saved plans on mount
  useEffect(() => {
    plansApi.list().then(setSavedPlans).catch(() => {});
  }, []);

  // ── Execute mode polling (unchanged) ──
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
        if (!cancelled) setExecuteJobs(jobs.filter(Boolean));
      } catch { /* keep previous */ }
    };

    fetchJobs();
    const interval = setInterval(fetchJobs, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [result]);

  // ── Step timers (unchanged) ──
  const AUTO_STEPS = useMemo(() => autoExecute
    ? ['Building content plan with Gemini', 'Submitting batch generation jobs', 'Starting image generation']
    : ['Analyzing theme and persona', 'Building content plan with Gemini', 'Formatting schedule output'],
  [autoExecute]);
  const AUTO_THRESHOLDS = useMemo(() => [3, 8], []);
  const { elapsedSec: loadingElapsedSec, stepIndex: autoStepIndex } = useStepTimer(loading, AUTO_THRESHOLDS);

  const isExecuteRunning = executeJobs.some((job) => job?.status === 'running');
  const EXEC_THRESHOLDS = useMemo(() => [5], []);
  const { elapsedSec: executeElapsedSec } = useStepTimer(isExecuteRunning, EXEC_THRESHOLDS);

  // ── Style Library handlers (unchanged) ──
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

  // ── Generate handler ──
  const handleGenerate = async () => {
    if (!characterId) { notify('Character is required', 'error'); return; }
    if (!theme.trim()) { notify('Theme is required', 'error'); return; }

    const durationInt = Number.parseInt(String(duration), 10);
    const carouselCountInt = Number.parseInt(String(carouselCount), 10);
    const reelCountInt = Number.parseInt(String(reelCount), 10);
    const storyCountInt = Number.parseInt(String(storyCount), 10);
    if (!Number.isInteger(durationInt) || durationInt < 1 || durationInt > 14) { notify('Duration must be between 1 and 14', 'error'); return; }
    if (!Number.isInteger(carouselCountInt) || carouselCountInt < 1 || carouselCountInt > 10) { notify('Carousel posts per day must be between 1 and 10', 'error'); return; }
    if (!Number.isInteger(reelCountInt) || reelCountInt < 1 || reelCountInt > 10) { notify('Reels per day must be between 1 and 10', 'error'); return; }
    if (!Number.isInteger(storyCountInt) || storyCountInt < 1 || storyCountInt > 10) { notify('Stories per day must be between 1 and 10', 'error'); return; }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setActivePlan(null);
    setExpandedDay(null);

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
      if (!response.ok) throw new Error(json?.error?.message || `Request failed (${response.status})`);

      const data = json?.data;
      if (!data) throw new Error('Invalid response from auto endpoint');

      if (autoExecute) {
        if (!Array.isArray(data.jobIds)) throw new Error('Invalid execute response format');
        setResult({ mode: 'execute', data });
        notify('Generation started', 'success');
      } else {
        if (!Array.isArray(data)) throw new Error('Invalid plan response format');

        // Auto-save the plan
        try {
          const saved = await plansApi.save({
            name: theme.trim().slice(0, 80),
            theme: theme.trim(),
            personaMode,
            characterId,
            duration: durationInt,
            startDate,
            days: data,
            config: {
              styleAtomIds: styleAtomIds.length > 0 ? styleAtomIds : [],
              includeReels,
              includeStories,
              carouselCount: carouselCountInt,
              reelCount: reelCountInt,
              storyCount: storyCountInt,
            },
          });
          setActivePlan(saved);
          setSavedPlans((prev) => [{ id: saved.id, name: saved.name, theme: saved.theme, personaMode: saved.personaMode, duration: saved.duration, startDate: saved.startDate, status: saved.status, totalDays: saved.days.length, executedDayCount: 0, createdAt: saved.createdAt }, ...prev]);
        } catch {
          // Save failed — still show the plan inline
          setActivePlan({ id: null, days: data, executedDays: [], startDate, name: theme.trim() });
        }

        setResult({ mode: 'plan', data });
        notify('Plan generated and saved', 'success');
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      const msg = err.message || 'Failed to generate';
      notify(msg.includes('API') || msg.includes('key') ? msg : `Generation failed: ${msg}. Check your API key and character settings.`, 'error');
    } finally {
      setLoading(false);
    }
  };

  // ── Load a saved plan ──
  const handleLoadPlan = useCallback(async (planId) => {
    try {
      const plan = await plansApi.get(planId);
      setActivePlan(plan);
      setStartDate(plan.startDate || todayStr());
      setExpandedDay(null);
      setResult({ mode: 'plan', data: plan.days });
      notify(`Loaded: ${plan.name}`, 'success');
    } catch (err) {
      notify(err.message || 'Failed to load plan', 'error');
    }
  }, [notify]);

  // ── Delete a saved plan ──
  const handleDeletePlan = useCallback(async (planId) => {
    try {
      await plansApi.remove(planId);
      setSavedPlans((prev) => prev.filter((p) => p.id !== planId));
      if (activePlan?.id === planId) {
        setActivePlan(null);
        setResult(null);
      }
      notify('Plan deleted', 'success');
    } catch (err) {
      notify(err.message || 'Failed to delete plan', 'error');
    }
  }, [activePlan, notify]);

  // ── Execute a single day ──
  const handleExecuteDay = useCallback(async (dayNumber) => {
    if (!activePlan?.id) { notify('Save the plan first to execute individual days', 'error'); return; }
    setExecutingDay(dayNumber);
    try {
      const res = await plansApi.executeDay(activePlan.id, dayNumber);
      notify(`Day ${dayNumber} started: ${res.totalImages} images across ${res.jobIds.length} batch job${res.jobIds.length > 1 ? 's' : ''}`, 'success');
      // Update local plan state
      setActivePlan((prev) => {
        if (!prev) return prev;
        const executedDays = [...(prev.executedDays || []), { day: dayNumber, jobIds: res.jobIds, executedAt: new Date().toISOString() }];
        const executedSet = new Set(executedDays.map((d) => d.day));
        return { ...prev, executedDays, status: executedSet.size >= prev.days.length ? 'completed' : 'partial' };
      });
    } catch (err) {
      notify(err.message || `Failed to execute day ${dayNumber}`, 'error');
    } finally {
      setExecutingDay(null);
    }
  }, [activePlan, notify]);

  // ── Execute all remaining days ──
  const handleExecuteAll = useCallback(async () => {
    if (!activePlan?.id) return;
    const executedSet = new Set((activePlan.executedDays || []).map((d) => d.day));
    const remaining = activePlan.days.filter((d) => !executedSet.has(d.day));
    if (remaining.length === 0) { notify('All days already executed', 'info'); return; }

    for (const day of remaining) {
      await handleExecuteDay(day.day);
    }
  }, [activePlan, handleExecuteDay, notify]);

  // ── Calendar stats ──
  const calendarStats = useMemo(() => {
    if (!activePlan?.days) return null;
    const executedSet = new Set((activePlan.executedDays || []).map((d) => d.day));
    let totalPosts = 0, totalLifestyle = 0, totalReels = 0, totalStories = 0;
    for (const day of activePlan.days) {
      totalPosts += (day.carouselPrompts || []).length;
      totalLifestyle += day.lifestylePrompt ? 1 : 0;
      totalReels += (day.reelPrompts || []).length;
      totalStories += (day.storyPrompts || []).length;
    }
    return {
      totalImages: totalPosts + totalLifestyle + totalReels + totalStories,
      totalPosts, totalLifestyle, totalReels, totalStories,
      executedCount: executedSet.size,
      totalDays: activePlan.days.length,
      remainingDays: activePlan.days.length - executedSet.size,
    };
  }, [activePlan]);

  const executedDaySet = useMemo(
    () => new Set((activePlan?.executedDays || []).map((d) => d.day)),
    [activePlan],
  );

  return (
    <div className="space-y-6 animate-in">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-gradient">Auto Generator</h1>
        <p className="text-zinc-500 text-sm mt-1">Generate weekly content plans with a calendar view, then execute day by day.</p>
      </div>

      {/* ── Saved Plans Bar ── */}
      {savedPlans.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-zinc-500 font-medium shrink-0">Saved Plans:</span>
          {savedPlans.map((p) => {
            const s = STATUS_STYLES[p.status] || STATUS_STYLES.draft;
            return (
              <div
                key={p.id}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs transition cursor-pointer',
                  activePlan?.id === p.id
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                    : 'bg-zinc-800/60 text-zinc-400 border border-zinc-700/40 hover:border-zinc-600 hover:text-zinc-300',
                )}
              >
                <button type="button" onClick={() => handleLoadPlan(p.id)} className="cursor-pointer truncate max-w-[140px]">
                  {p.name}
                </button>
                <span className={cn('w-1.5 h-1.5 rounded-full', s.color === 'green' ? 'bg-green-400' : s.color === 'blue' ? 'bg-blue-400' : 'bg-zinc-500')} title={s.label} />
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleDeletePlan(p.id); }}
                  className="text-zinc-600 hover:text-red-400 cursor-pointer ml-0.5"
                  title="Delete plan"
                >
                  &times;
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Form Card ── */}
      <Section title="Plan Configuration" defaultOpen={!activePlan} className="space-y-0">
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

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Duration (days)"
                type="number"
                min={1}
                max={14}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-zinc-400 font-medium">Start Date</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="h-10 rounded-lg border border-zinc-700/60 bg-zinc-900/50 px-3 text-sm text-zinc-100 outline-none transition-all hover:border-zinc-600 focus:border-blue-500/70 focus:ring-2 focus:ring-blue-500/20"
                />
              </label>
            </div>
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

          {/* ── Content Schedule ── */}
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

          {/* ── Advanced Options ── */}
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

          {/* ── Style Library ── */}
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
      </Section>

      {/* ── Loading ── */}
      {loading && (
        <StepProgress steps={AUTO_STEPS} currentIndex={autoStepIndex} elapsedSec={loadingElapsedSec} className="min-h-[360px]" />
      )}

      {/* ── Empty state ── */}
      {!loading && !result && !activePlan && (
        <Card className="flex items-center justify-center py-16">
          <Empty icon="Auto" title="No plan yet" subtitle="Configure your content plan above and click Generate Plan" />
        </Card>
      )}

      {/* ── Execute mode results (unchanged) ── */}
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

      {/* ── Calendar View ── */}
      {!loading && activePlan && activePlan.days?.length > 0 && result?.mode === 'plan' && (
        <div className="space-y-4">
          {/* Plan header */}
          <Card className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">{activePlan.name || 'Content Plan'}</h2>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  <span className="text-xs text-zinc-500">{calendarStats?.totalDays} days</span>
                  <span className="text-xs text-zinc-600">|</span>
                  <span className="flex items-center gap-1 text-xs text-zinc-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400" /> {calendarStats?.totalPosts} posts
                  </span>
                  {calendarStats?.totalLifestyle > 0 && (
                    <>
                      <span className="text-xs text-zinc-600">|</span>
                      <span className="flex items-center gap-1 text-xs text-zinc-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400" /> {calendarStats?.totalLifestyle} lifestyle
                      </span>
                    </>
                  )}
                  {calendarStats?.totalReels > 0 && (
                    <>
                      <span className="text-xs text-zinc-600">|</span>
                      <span className="flex items-center gap-1 text-xs text-zinc-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-400" /> {calendarStats?.totalReels} reels
                      </span>
                    </>
                  )}
                  {calendarStats?.totalStories > 0 && (
                    <>
                      <span className="text-xs text-zinc-600">|</span>
                      <span className="flex items-center gap-1 text-xs text-zinc-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> {calendarStats?.totalStories} stories
                      </span>
                    </>
                  )}
                  <span className="text-xs text-zinc-600">|</span>
                  <span className="text-xs text-zinc-400">{calendarStats?.totalImages} total images</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {calendarStats?.executedCount > 0 && (
                  <Badge color="green">{calendarStats.executedCount}/{calendarStats.totalDays} done</Badge>
                )}
                {calendarStats?.remainingDays > 0 && (
                  <Btn
                    variant="secondary"
                    className="text-xs"
                    onClick={handleExecuteAll}
                    disabled={!!executingDay}
                  >
                    {executingDay ? <><Spinner size={12} /> Executing...</> : `Execute All (${calendarStats.remainingDays} days)`}
                  </Btn>
                )}
              </div>
            </div>

            {/* Progress bar */}
            {calendarStats && calendarStats.totalDays > 0 && (
              <div className="h-1.5 rounded-full bg-zinc-800/80 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-blue-500 to-green-500 transition-all duration-500"
                  style={{ width: `${(calendarStats.executedCount / calendarStats.totalDays) * 100}%` }}
                />
              </div>
            )}
          </Card>

          {/* Calendar grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3">
            {activePlan.days.map((day) => (
              <DayCell
                key={day.day}
                day={day}
                startDate={activePlan.startDate || startDate}
                executed={executedDaySet.has(day.day)}
                executingDay={executingDay}
                onExecute={handleExecuteDay}
                expanded={expandedDay === day.day}
                onToggle={() => setExpandedDay((prev) => prev === day.day ? null : day.day)}
              />
            ))}
          </div>

          {/* Expanded day detail */}
          {expandedDay && (() => {
            const day = activePlan.days.find((d) => d.day === expandedDay);
            return day ? <DayDetail day={day} /> : null;
          })()}
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
