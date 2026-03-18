import { lazy, Suspense, useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { batch as batchApi, autoPlans as plansApi, styleLibrary as styleApi, backgrounds as bgApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useStepTimer } from '../hooks/useStepTimer';
import { cn } from '../lib/utils';
import { Card, Btn, Input, Toggle, Slider, Spinner, Empty, Badge, ImageCard, StepProgress, Section, Hint } from '../components/UI';
import { IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL } from '../config/photoModes';

const StyleAtomPicker = lazy(() => import('../components/StyleAtomPicker'));


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
              <li key={`c${day.day}-${idx}`} className="text-xs text-zinc-300 bg-zinc-800/50 rounded-lg p-2.5 whitespace-pre-wrap leading-relaxed">{prompt}</li>
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
              <li key={`r${day.day}-${idx}`} className="text-xs text-zinc-300 bg-zinc-800/50 rounded-lg p-2.5 whitespace-pre-wrap leading-relaxed">{prompt}</li>
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
              <li key={`s${day.day}-${idx}`} className="text-xs text-zinc-300 bg-zinc-800/50 rounded-lg p-2.5 whitespace-pre-wrap leading-relaxed">{prompt}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

const COSPLAY_THEMES = [
  { value: '', label: 'Custom (type your own)' },
  // Anime
  { value: 'popular shonen heroines', label: 'Shonen Heroines' },
  { value: 'classic 90s anime girls', label: 'Classic 90s Anime' },
  { value: 'isekai waifus', label: 'Isekai Waifus' },
  { value: 'anime villain girls', label: 'Villain Girls' },
  { value: 'magical girl cosplay sailor moon madoka', label: 'Magical Girls' },
  { value: 'demon slayer kimetsu no yaiba female characters', label: 'Demon Slayer' },
  { value: 'one piece female characters', label: 'One Piece Girls' },
  { value: 'jujutsu kaisen female characters', label: 'Jujutsu Kaisen' },
  { value: 'evangelion female characters', label: 'Evangelion' },
  // Gaming
  { value: 'valorant female agents jett sage reyna viper', label: 'Valorant Agents' },
  { value: 'league of legends female champions ahri jinx katarina', label: 'League of Legends' },
  { value: 'genshin impact female characters gacha game', label: 'Genshin Impact' },
  { value: 'honkai star rail female characters', label: 'Honkai Star Rail' },
  { value: 'blue archive female students gacha', label: 'Blue Archive' },
  { value: 'nier automata 2b a2 female characters', label: 'NieR: Automata' },
  { value: 'final fantasy female characters tifa aerith lightning', label: 'Final Fantasy' },
  { value: 'overwatch female heroes dva mercy widowmaker kiriko', label: 'Overwatch' },
  { value: 'street fighter female fighters chun-li juri cammy', label: 'Street Fighter' },
  { value: 'resident evil female characters ada wong jill valentine', label: 'Resident Evil' },
  { value: 'wuthering waves female characters gacha', label: 'Wuthering Waves' },
  { value: 'zenless zone zero female characters', label: 'Zenless Zone Zero' },
  // Styles
  { value: 'gacha game characters genshin honkai blue archive', label: 'Gacha Games (Mix)' },
  { value: 'bunny suit cosplay versions', label: 'Bunny Suit Versions' },
  { value: 'maid cafe cosplay outfits', label: 'Maid Cafe' },
  { value: 'summer swimsuit anime cosplay', label: 'Swimsuit Versions' },
];

const COSPLAY_LOCATIONS = [
  { value: '', label: 'Auto (mixed)' },
  { value: 'bedroom', label: 'Bedroom' },
  { value: 'hotel_room', label: 'Hotel Room' },
  { value: 'convention_hallway', label: 'Convention Hallway' },
  { value: 'outdoor_park', label: 'Outdoor / Park' },
  { value: 'living_room', label: 'Living Room' },
  { value: 'studio_backdrop', label: 'Simple Backdrop' },
];

const GOTH_THEMES = [
  { value: '', label: 'Custom (type your own)' },
  { value: 'classic goth girl dark romantic aesthetic', label: 'Classic Goth' },
  { value: 'e-girl egirl alt girl aesthetic dark makeup', label: 'E-Girl / Alt Girl' },
  { value: 'punk goth studded leather chains band tees', label: 'Punk Goth' },
  { value: 'romantic goth velvet lace corset victorian dark', label: 'Romantic Goth' },
  { value: 'streetwear goth techwear dark urban all black', label: 'Streetwear Goth' },
  { value: 'goth x anime cosplay dark anime characters cat ears', label: 'Goth x Anime' },
  { value: 'witchy goth occult dark academia tarot crystals', label: 'Witchy / Occult' },
  { value: 'cyber goth neon accents platform boots industrial', label: 'Cyber Goth' },
  { value: 'soft goth pastel goth pink black cute dark', label: 'Pastel Goth' },
  { value: 'club goth nightlife dark party rave latex vinyl', label: 'Club / Nightlife' },
  { value: 'grunge goth 90s flannel torn fishnets messy hair', label: 'Grunge Goth' },
  { value: 'goth girlfriend cozy dark aesthetic candid boyfriend pov', label: 'Goth GF Aesthetic' },
];

const GOTH_LOCATIONS = [
  { value: '', label: 'Auto (mixed)' },
  { value: 'urban_night', label: 'Urban Night / Streets' },
  { value: 'bar_club', label: 'Bar / Club' },
  { value: 'bedroom_dark', label: 'Dark Bedroom' },
  { value: 'car_night', label: 'Car at Night' },
  { value: 'rooftop_city', label: 'Rooftop / City View' },
  { value: 'alley_graffiti', label: 'Alley / Graffiti Wall' },
  { value: 'park_night', label: 'Park at Night' },
  { value: 'mirror_selfie', label: 'Bedroom Mirror' },
];

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
  similarityCooldown: 'on',
  footwearLock: '',
  autoExecute: false,
  imageModel: DEFAULT_IMAGE_MODEL,
  // Cosplay options
  cosplayLewdness: 30,
  cosplayStyle: 'accurate',
  cosplayLocation: '',
  cosplaySignaturePoses: true,
  cosplayPropShots: false,
  cosplayBeforeAfter: false,
  cosplayGroupTheme: false,
  cosplayTiktokReveal: false,
  cosplayConventionMode: false,
  cosplayThemePreset: '',
  backgroundRefId: '',
};


export default function AutoGeneratorPage() {
  const { notify, characters } = useApp();

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
  const [similarityCooldown, setSimilarityCooldown] = useState(_cache.similarityCooldown);
  const [footwearLock, setFootwearLock] = useState(_cache.footwearLock);
  const [autoExecute, setAutoExecute] = useState(_cache.autoExecute);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [cosplayLewdness, setCosplayLewdness] = useState(_cache.cosplayLewdness);
  const [cosplayStyle, setCosplayStyle] = useState(_cache.cosplayStyle);
  const [cosplayLocation, setCosplayLocation] = useState(_cache.cosplayLocation);
  const [cosplaySignaturePoses, setCosplaySignaturePoses] = useState(_cache.cosplaySignaturePoses);
  const [cosplayPropShots, setCosplayPropShots] = useState(_cache.cosplayPropShots);
  const [cosplayBeforeAfter, setCosplayBeforeAfter] = useState(_cache.cosplayBeforeAfter);
  const [cosplayGroupTheme, setCosplayGroupTheme] = useState(_cache.cosplayGroupTheme);
  const [cosplayTiktokReveal, setCosplayTiktokReveal] = useState(_cache.cosplayTiktokReveal);
  const [cosplayConventionMode, setCosplayConventionMode] = useState(_cache.cosplayConventionMode);
  const [cosplayThemePreset, setCosplayThemePreset] = useState(_cache.cosplayThemePreset);
  const [backgroundRefId, setBackgroundRefId] = useState(_cache.backgroundRefId);
  const [backgroundList, setBackgroundList] = useState([]);
  const [bgUploading, setBgUploading] = useState(false);
  const [loading, setLoading] = useState(false);

  const [result, setResult] = useState(_cache.result);
  const [executeJobs, setExecuteJobs] = useState(_cache.executeJobs);

  const [styleAtomIds, setStyleAtomIds] = useState(_cache.styleAtomIds);
  const [styleAtomDetails, setStyleAtomDetails] = useState(_cache.styleAtomDetails);
  const [showAtomPicker, setShowAtomPicker] = useState(false);

  const [activePlan, setActivePlan] = useState(_cache.activePlan);
  const [savedPlans, setSavedPlans] = useState(_cache.savedPlans);
  const [startDate, setStartDate] = useState(_cache.startDate || todayStr());
  const [expandedDay, setExpandedDay] = useState(_cache.expandedDay);
  const [executingDay, setExecutingDay] = useState(null);

  useEffect(() => {
    if (!characterId && characters.length > 0) {
      setCharacterId(characters[0].id);
    }
  }, [characters]);

  useEffect(() => { Object.assign(_cache, {
    theme, personaMode, customPersona, spicinessLevel, duration, characterId,
    includeReels, includeStories, carouselCount, reelCount, storyCount,
    result, executeJobs, styleAtomIds, styleAtomDetails, activePlan, savedPlans,
    startDate, expandedDay, similarityCooldown, footwearLock, autoExecute, imageModel,
    cosplayLewdness, cosplayStyle, cosplayLocation, cosplaySignaturePoses,
    cosplayPropShots, cosplayBeforeAfter, cosplayGroupTheme, cosplayTiktokReveal,
    cosplayConventionMode, cosplayThemePreset, backgroundRefId,
  }); });

  useEffect(() => {
    plansApi.list().then(setSavedPlans).catch(() => {});
    bgApi.list().then(setBackgroundList).catch(() => {});
  }, []);

  useEffect(() => {
    if (!result || result.mode !== 'execute' || !Array.isArray(result.data?.jobIds) || result.data.jobIds.length === 0) {
      setExecuteJobs([]);
      return undefined;
    }

    let cancelled = false;
    const jobIds = result.data.jobIds;

    let lostCount = 0;
    const fetchJobs = async () => {
      try {
        const jobs = await Promise.all(jobIds.map((jobId) => batchApi.get(jobId).catch(() => null)));
        if (cancelled) return;
        const valid = jobs.filter(Boolean);
        setExecuteJobs(valid);
        // Stop polling if all jobs completed or if jobs can't be found (server restart)
        if (valid.length > 0 && valid.every((j) => j.status !== 'running')) {
          clearInterval(interval);
        } else if (valid.length === 0) {
          lostCount++;
          if (lostCount >= 3) clearInterval(interval);
        }
      } catch { }
    };

    fetchJobs();
    const interval = setInterval(fetchJobs, 2000);
    return () => { cancelled = true; clearInterval(interval); };
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
      try { const atom = await styleApi.get(id); details.push({ id: atom.id, category: atom.category, text: atom.text }); } catch { }
    }
    setStyleAtomDetails(details);
  };

  const removeStyleAtom = (id) => {
    setStyleAtomIds((prev) => prev.filter((x) => x !== id));
    setStyleAtomDetails((prev) => prev.filter((x) => x.id !== id));
  };

  const abortRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { abortRef.current?.abort(); }, []);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  const bgFileRef = useRef(null);
  const handleBgUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBgUploading(true);
    try {
      const reader = new FileReader();
      const base64 = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const entry = await bgApi.upload({ name: file.name.replace(/\.[^.]+$/, ''), mimeType: file.type, base64Data: base64 });
      setBackgroundList((prev) => [...prev, entry]);
      setBackgroundRefId(entry.id);
      notify('Background uploaded', 'success');
    } catch (err) {
      notify(err.message || 'Upload failed', 'error');
    } finally {
      setBgUploading(false);
      if (bgFileRef.current) bgFileRef.current.value = '';
    }
  };
  const handleBgDelete = async (id) => {
    try {
      await bgApi.remove(id);
      setBackgroundList((prev) => prev.filter((b) => b.id !== id));
      if (backgroundRefId === id) setBackgroundRefId('');
      notify('Background removed', 'success');
    } catch (err) {
      notify(err.message || 'Delete failed', 'error');
    }
  };

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
    setResult(null);
    setExecuteJobs([]);
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
          imageModel,
          ...((personaMode === 'cosplay' || personaMode === 'goth') && {
            cosplayOptions: {
              lewdness: cosplayLewdness,
              style: cosplayStyle,
              location: cosplayLocation || undefined,
              signaturePoses: cosplaySignaturePoses,
              propShots: cosplayPropShots,
              beforeAfter: cosplayBeforeAfter,
              groupTheme: cosplayGroupTheme,
              tiktokReveal: cosplayTiktokReveal,
              conventionMode: cosplayConventionMode,
              backgroundRefId: backgroundRefId || undefined,
            },
          }),
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]),
      });

      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(json?.error?.message || `Request failed (${response.status})`);

      const data = json?.data;
      if (!data) throw new Error('Invalid response from auto endpoint');

      if (autoExecute) {
        if (!Array.isArray(data.jobIds)) throw new Error('Invalid execute response format');
        setResult({ mode: 'execute', data });
        // If server returned a saved plan, set it so day-level images show
        if (data.plan) {
          setActivePlan(data.plan);
          setSavedPlans((prev) => [{ id: data.plan.id, name: data.plan.name, theme: data.plan.theme, personaMode: data.plan.personaMode, duration: data.plan.duration, startDate: data.plan.startDate, status: data.plan.status, totalDays: data.plan.days?.length || 0, executedDayCount: data.plan.executedDays?.length || 0, createdAt: data.plan.createdAt }, ...prev]);
        }
        notify('Generation started', 'success');
      } else {
        if (!Array.isArray(data)) throw new Error('Invalid plan response format');

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
              imageModel,
              backgroundRefId: backgroundRefId || undefined,
            },
          });
          setActivePlan(saved);
          setSavedPlans((prev) => [{ id: saved.id, name: saved.name, theme: saved.theme, personaMode: saved.personaMode, duration: saved.duration, startDate: saved.startDate, status: saved.status, totalDays: saved.days.length, executedDayCount: 0, createdAt: saved.createdAt }, ...prev]);
        } catch {
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

  const handleLoadPlan = useCallback(async (planId) => {
    try {
      const plan = await plansApi.get(planId);
      setActivePlan(plan);
      setStartDate(plan.startDate || todayStr());
      setExpandedDay(null);
      setDayResults({});
      setResult({ mode: 'plan', data: plan.days });
      notify(`Loaded: ${plan.name}`, 'success');
    } catch (err) {
      notify(err.message || 'Failed to load plan', 'error');
    }
  }, [notify]);

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

  const handleExecuteDay = useCallback(async (dayNumber) => {
    if (!activePlan?.id) { notify('Save the plan first to execute individual days', 'error'); return; }
    setExecutingDay(dayNumber);
    try {
      const res = await plansApi.executeDay(activePlan.id, dayNumber);
      notify(`Day ${dayNumber} started: ${res.totalImages} images across ${res.jobIds.length} batch job${res.jobIds.length > 1 ? 's' : ''}`, 'success');
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

  const handleExecuteAll = useCallback(async () => {
    if (!activePlan?.id) return;
    const executedSet = new Set((activePlan.executedDays || []).map((d) => d.day));
    const remaining = activePlan.days.filter((d) => !executedSet.has(d.day));
    if (remaining.length === 0) { notify('All days already executed', 'info'); return; }

    for (const day of remaining) {
      if (!mountedRef.current) break;
      await handleExecuteDay(day.day);
    }
  }, [activePlan, handleExecuteDay, notify]);

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

  // Map jobId → dayNumber for grouping results by day
  const jobToDayMap = useMemo(() => {
    const map = {};
    for (const ed of (activePlan?.executedDays || [])) {
      for (const jid of (ed.jobIds || [])) {
        map[jid] = ed.day;
      }
    }
    return map;
  }, [activePlan]);

  // Track per-day results from executed jobs
  const [dayResults, setDayResults] = useState({});
  const dayPollRef = useRef(null);

  useEffect(() => {
    const executedDays = activePlan?.executedDays || [];
    const allJobIds = executedDays.flatMap((ed) => ed.jobIds || []);
    if (allJobIds.length === 0) { setDayResults({}); return undefined; }

    // Build local day map in case the memoized one hasn't updated yet
    const localDayMap = {};
    for (const ed of executedDays) {
      for (const jid of (ed.jobIds || [])) {
        localDayMap[jid] = ed.day;
      }
    }

    let cancelled = false;
    let failCount = 0;
    const poll = async () => {
      try {
        const jobs = await Promise.all(allJobIds.map((jid) => batchApi.get(jid).catch(() => null)));
        if (cancelled) return;
        const valid = jobs.filter(Boolean);
        if (valid.length === 0) {
          failCount++;
          if (failCount >= 3 && dayPollRef.current) {
            clearInterval(dayPollRef.current);
            dayPollRef.current = null;
          }
          return;
        }
        failCount = 0;
        const grouped = {};
        for (const job of valid) {
          const dayNum = localDayMap[job.jobId] || jobToDayMap[job.jobId];
          if (!dayNum) continue;
          if (!grouped[dayNum]) grouped[dayNum] = { images: [], running: false, completed: 0, total: 0 };
          grouped[dayNum].total += job.total || 0;
          grouped[dayNum].completed += (job.completed || 0) + (job.failed || 0);
          if (job.status === 'running') grouped[dayNum].running = true;
          const imgs = (job.results || []).filter((r) => r?.success && r?.galleryId);
          grouped[dayNum].images.push(...imgs);
        }
        if (cancelled) return;
        setDayResults(grouped);

        // Stop polling if all done
        const anyRunning = Object.values(grouped).some((g) => g.running);
        if (!anyRunning && dayPollRef.current) {
          clearInterval(dayPollRef.current);
          dayPollRef.current = null;
        }
      } catch (err) {
        console.warn('dayResults poll error:', err);
      }
    };

    poll();
    dayPollRef.current = setInterval(poll, 2500);
    return () => { cancelled = true; clearInterval(dayPollRef.current); dayPollRef.current = null; };
  }, [activePlan?.executedDays, jobToDayMap]);

  return (
    <div className="space-y-6 animate-in">
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

      <Section title="Plan Configuration" defaultOpen={!activePlan} className="space-y-0">
        <Card className="space-y-4">
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
              <span className="text-zinc-400 font-medium">Image Model</span>
              <select
                value={imageModel}
                onChange={(e) => setImageModel(e.target.value)}
                className="rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
              >
                {IMAGE_MODEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>

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
                <option value="cosplay">Cosplay (Anime)</option>
                <option value="goth">Goth / Alt Girl</option>
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

          {(personaMode === 'cosplay' || personaMode === 'goth') && (
            <Section title={personaMode === 'goth' ? 'Goth Options' : 'Cosplay Options'} defaultOpen>
              <div className="space-y-4">
                {/* Theme preset dropdown */}
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="text-zinc-400 font-medium">{personaMode === 'goth' ? 'Goth Theme' : 'Cosplay Theme'}</span>
                  <select
                    value={cosplayThemePreset}
                    onChange={(e) => {
                      setCosplayThemePreset(e.target.value);
                      if (e.target.value) setTheme(e.target.value);
                    }}
                    className="rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-pink-500/70 focus:ring-1 focus:ring-pink-500/20 cursor-pointer"
                  >
                    {(personaMode === 'goth' ? GOTH_THEMES : COSPLAY_THEMES).map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </label>

                {/* Style + Location row */}
                <div className={cn('grid gap-3', backgroundRefId ? 'grid-cols-1' : 'grid-cols-2')}>
                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="text-zinc-400 font-medium">Style</span>
                    <select
                      value={cosplayStyle}
                      onChange={(e) => setCosplayStyle(e.target.value)}
                      className="rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-pink-500/70 focus:ring-1 focus:ring-pink-500/20 cursor-pointer"
                    >
                      {personaMode === 'goth' ? (
                        <>
                          <option value="accurate">Classic Goth</option>
                          <option value="sexy">Sexy / Provocative</option>
                          <option value="casual">Casual Dark Streetwear</option>
                        </>
                      ) : (
                        <>
                          <option value="accurate">Accurate Cosplay</option>
                          <option value="sexy">Sexy Reinterpretation</option>
                          <option value="casual">Casual Closet Cosplay</option>
                        </>
                      )}
                    </select>
                  </label>
                  {!backgroundRefId && (
                    <label className="flex flex-col gap-1.5 text-sm">
                      <span className="text-zinc-400 font-medium">Location</span>
                      <select
                        value={cosplayLocation}
                        onChange={(e) => setCosplayLocation(e.target.value)}
                        className="rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-pink-500/70 focus:ring-1 focus:ring-pink-500/20 cursor-pointer"
                      >
                        {(personaMode === 'goth' ? GOTH_LOCATIONS : COSPLAY_LOCATIONS).map((l) => (
                          <option key={l.value} value={l.value}>{l.label}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>

                {/* Lewdness slider */}
                <div>
                  <Slider
                    label="Lewdness"
                    value={cosplayLewdness}
                    onChange={(value) => setCosplayLewdness(Math.round(value / 5) * 5)}
                    min={0}
                    max={100}
                    step={5}
                    className="rounded-lg border border-zinc-700/80 bg-zinc-800/60 px-3 py-3"
                  />
                  <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
                    {personaMode === 'goth' ? (
                      <>
                        <span>Covered / modest</span>
                        <span>Revealing</span>
                        <span>Lingerie goth</span>
                      </>
                    ) : (
                      <>
                        <span>Accurate costume</span>
                        <span>Bikini version</span>
                        <span>Bunny suit</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Toggles grid */}
                <div className="grid grid-cols-2 gap-2">
                  {personaMode === 'goth' ? (
                    <>
                      <Toggle checked={cosplaySignaturePoses} onChange={setCosplaySignaturePoses} label="Flash Photography" />
                      <Toggle checked={cosplayPropShots} onChange={setCosplayPropShots} label="Accessory Close-ups" />
                      <Toggle checked={cosplayBeforeAfter} onChange={setCosplayBeforeAfter} label="Getting Ready (Makeup)" />
                      <Toggle checked={cosplayGroupTheme} onChange={setCosplayGroupTheme} label="Friend Group Shots" />
                      <Toggle checked={cosplayTiktokReveal} onChange={setCosplayTiktokReveal} label="Day → Night Transition" />
                      <Toggle checked={cosplayConventionMode} onChange={setCosplayConventionMode} label="Multi Outfit per Day" />
                    </>
                  ) : (
                    <>
                      <Toggle checked={cosplaySignaturePoses} onChange={setCosplaySignaturePoses} label="Signature Poses" />
                      <Toggle checked={cosplayPropShots} onChange={setCosplayPropShots} label="Prop Focus Shots" />
                      <Toggle checked={cosplayBeforeAfter} onChange={setCosplayBeforeAfter} label="Before/After (Getting Ready)" />
                      <Toggle checked={cosplayGroupTheme} onChange={setCosplayGroupTheme} label="Group Theme (Same Anime)" />
                      <Toggle checked={cosplayTiktokReveal} onChange={setCosplayTiktokReveal} label="TikTok Reveal (Civilian → Cosplay)" />
                      <Toggle checked={cosplayConventionMode} onChange={setCosplayConventionMode} label="Convention Mode (Multi per Day)" />
                    </>
                  )}
                </div>

                {/* Background Reference */}
                <div className="space-y-2">
                  <span className="text-zinc-400 font-medium text-sm flex items-center gap-1.5">
                    Background Lock <Hint text="Upload a background photo to lock the scene. All generated images will use this background as reference — only the character changes." />
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {backgroundList.map((bg) => (
                      <div
                        key={bg.id}
                        onClick={() => setBackgroundRefId(backgroundRefId === bg.id ? '' : bg.id)}
                        className={cn(
                          'relative w-20 h-20 rounded-lg overflow-hidden cursor-pointer border-2 transition-all group',
                          backgroundRefId === bg.id
                            ? 'border-pink-500 ring-2 ring-pink-500/30 scale-105'
                            : 'border-zinc-700/60 hover:border-zinc-500',
                        )}
                      >
                        <img
                          src={bgApi.imageUrl(bg.id)}
                          alt={bg.name}
                          className="w-full h-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleBgDelete(bg.id); }}
                          className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 text-zinc-400 hover:text-red-400 text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition cursor-pointer"
                        >
                          &times;
                        </button>
                        <div className="absolute bottom-0 inset-x-0 bg-black/60 text-[9px] text-zinc-300 px-1 py-0.5 truncate">
                          {bg.name}
                        </div>
                      </div>
                    ))}
                    <label className={cn(
                      'w-20 h-20 rounded-lg border-2 border-dashed border-zinc-700/60 flex flex-col items-center justify-center cursor-pointer hover:border-zinc-500 transition text-zinc-500 hover:text-zinc-400',
                      bgUploading && 'opacity-50 pointer-events-none',
                    )}>
                      <input ref={bgFileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleBgUpload} />
                      {bgUploading ? <Spinner size={16} /> : <span className="text-xl leading-none">+</span>}
                      <span className="text-[9px] mt-0.5">Add BG</span>
                    </label>
                  </div>
                  {backgroundRefId && <p className="text-[10px] text-pink-400/70">Background locked — all shots use this scene</p>}
                </div>
              </div>
            </Section>
          )}

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

      {loading && (
        <StepProgress steps={AUTO_STEPS} currentIndex={autoStepIndex} elapsedSec={loadingElapsedSec} className="min-h-[360px]" />
      )}

      {!loading && !result && !activePlan && (
        <Card className="flex items-center justify-center py-16">
          <Empty icon="Auto" title="No plan yet" subtitle="Configure your content plan above and click Generate Plan" />
        </Card>
      )}

      {!loading && result?.mode === 'execute' && (() => {
        const totalCompleted = executeJobs.reduce((sum, j) => sum + (j?.completed || 0), 0);
        const totalFailed = executeJobs.reduce((sum, j) => sum + (j?.failed || 0), 0);
        const totalTarget = result.data.totalImages ?? executeJobs.reduce((sum, j) => sum + (j?.total || 0), 0);
        const pct = totalTarget > 0 ? Math.round(((totalCompleted + totalFailed) / totalTarget) * 100) : 0;
        const completedImages = executeJobs
          .flatMap((job) => (job?.results || []))
          .filter((item) => item && item.success && item.galleryId);
        const allDone = executeJobs.length > 0 && executeJobs.every((j) => j?.status !== 'running');
        const jobsLoaded = executeJobs.length > 0;
        const jobsLost = !jobsLoaded && result.data.jobIds.length > 0;
        return (
          <Card className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-zinc-300">
                {allDone ? 'Generation Complete' : jobsLost ? 'Jobs lost (server restarted?)' : jobsLoaded ? 'Generating...' : 'Starting jobs...'}
              </h2>
              <span className="text-xs text-zinc-400">
                {totalCompleted}/{totalTarget} images
                {totalFailed > 0 && <span className="text-red-400 ml-1">({totalFailed} failed)</span>}
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${allDone ? 'bg-green-500' : 'bg-blue-500'}`}
                style={{ width: `${Math.max(pct, isExecuteRunning ? 2 : 0)}%` }}
              />
            </div>
            {isExecuteRunning && (
              <p className="text-xs text-zinc-500 font-mono">
                {executeElapsedSec}s elapsed
                {totalCompleted === 0 && executeElapsedSec > 5 && ' — generating anchor images first...'}
              </p>
            )}
            {completedImages.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {completedImages.map((item, idx) => (
                  <div key={item.galleryId || idx} className="rounded-xl overflow-hidden bg-zinc-900 border border-zinc-700/40">
                    <img
                      src={`/api/gallery/${item.galleryId}/image`}
                      alt={`Generated ${idx + 1}`}
                      className="w-full h-auto object-cover"
                      loading="lazy"
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>
        );
      })()}

      {!loading && activePlan && activePlan.days?.length > 0 && result?.mode === 'plan' && (
        <div className="space-y-4">
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

            {calendarStats && calendarStats.totalDays > 0 && (
              <div className="h-1.5 rounded-full bg-zinc-800/80 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-blue-500 to-green-500 transition-all duration-500"
                  style={{ width: `${(calendarStats.executedCount / calendarStats.totalDays) * 100}%` }}
                />
              </div>
            )}
          </Card>

          {/* Day-by-day results view */}
          <div className="space-y-4">
            {activePlan.days.map((day) => {
              const executed = executedDaySet.has(day.day);
              const isExecuting = executingDay === day.day;
              const dayRes = dayResults[day.day];
              const { weekday, date } = formatDayDate(activePlan.startDate || startDate, day.day - 1);
              const postCount = (day.carouselPrompts || []).length;
              const reelCount = (day.reelPrompts || []).length;
              const storyCount = (day.storyPrompts || []).length;
              const hasLifestyle = !!day.lifestylePrompt;
              const total = postCount + (hasLifestyle ? 1 : 0) + reelCount + storyCount;
              const expanded = expandedDay === day.day;

              // Extract theme label from first carousel prompt or day plan
              const dayTheme = day.carouselPrompts?.[0]?.match(/Theme context:\s*(.+)/)?.[1]
                || day.carouselPrompts?.[0]?.split('\n')[0]?.replace(/^Scene:\s*/, '')
                || `Day ${day.day}`;

              return (
                <Card key={day.day} className="space-y-3">
                  {/* Day header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <Badge color={executed ? 'green' : 'zinc'}>Day {day.day}</Badge>
                        <span className="text-xs text-zinc-500">{weekday} {date}</span>
                      </div>
                      <span className="text-sm font-medium text-zinc-200 truncate max-w-[400px]">{dayTheme}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-zinc-500">{total} images</span>
                      {!executed && (
                        <Btn
                          variant="secondary"
                          className="text-xs px-3 py-1"
                          onClick={() => handleExecuteDay(day.day)}
                          disabled={!!executingDay}
                        >
                          {isExecuting ? <><Spinner size={12} /> Starting...</> : 'Execute'}
                        </Btn>
                      )}
                      {executed && !dayRes?.running && <span className="text-[10px] text-green-400 font-medium">Done</span>}
                      {dayRes?.running && <span className="text-[10px] text-blue-400 font-medium">{dayRes.completed}/{dayRes.total} generating...</span>}
                      <button
                        type="button"
                        onClick={() => setExpandedDay((prev) => prev === day.day ? null : day.day)}
                        className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
                      >
                        {expanded ? 'Hide prompts' : 'Show prompts'}
                      </button>
                    </div>
                  </div>

                  {/* Content type badges */}
                  <div className="flex gap-2 flex-wrap">
                    {postCount > 0 && (
                      <span className="flex items-center gap-1 text-[10px] text-zinc-400 bg-zinc-800/50 px-2 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400" /> {postCount} Posts
                      </span>
                    )}
                    {hasLifestyle && (
                      <span className="flex items-center gap-1 text-[10px] text-zinc-400 bg-zinc-800/50 px-2 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400" /> 1 Lifestyle
                      </span>
                    )}
                    {reelCount > 0 && (
                      <span className="flex items-center gap-1 text-[10px] text-zinc-400 bg-zinc-800/50 px-2 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-400" /> {reelCount} Reels
                      </span>
                    )}
                    {storyCount > 0 && (
                      <span className="flex items-center gap-1 text-[10px] text-zinc-400 bg-zinc-800/50 px-2 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> {storyCount} Stories
                      </span>
                    )}
                  </div>

                  {/* Generated images for this day */}
                  {dayRes?.images?.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                      {dayRes.images.map((item, idx) => (
                        <div key={item.galleryId || `d${day.day}-${idx}`} className="rounded-xl overflow-hidden bg-zinc-900 border border-zinc-700/40">
                          <img
                            src={`/api/gallery/${item.galleryId}/image`}
                            alt={`Day ${day.day} - ${idx + 1}`}
                            className="w-full h-auto object-cover"
                            loading="lazy"
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Progress bar for running day */}
                  {dayRes?.running && dayRes.total > 0 && (
                    <div className="h-1 rounded-full bg-zinc-800/80 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-blue-500 transition-all duration-500"
                        style={{ width: `${(dayRes.completed / dayRes.total) * 100}%` }}
                      />
                    </div>
                  )}

                  {/* Expanded prompts */}
                  {expanded && <DayDetail day={day} />}
                </Card>
              );
            })}
          </div>
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
