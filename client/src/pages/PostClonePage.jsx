import { useEffect, useMemo, useState, useCallback } from 'react';
import { postClone as postCloneApi, postCloneHistory as historyApi, styleFocus as styleFocusApi, availability as availabilityApi, keys as keysApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { useStepTimer } from '../hooks/useStepTimer';
import { cn } from '../lib/utils';
import { Card, Btn, Input, Badge, Slider, Spinner, Empty, Toggle, StepProgress, Section } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';
import { IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL } from '../config/photoModes';

const DNA_LABELS = {
  lighting: { label: 'Lighting', color: 'text-amber-400', dot: 'bg-amber-400' },
  camera: { label: 'Camera', color: 'text-blue-400', dot: 'bg-blue-400' },
  pose: { label: 'Pose', color: 'text-purple-400', dot: 'bg-purple-400' },
  expression: { label: 'Expression', color: 'text-pink-400', dot: 'bg-pink-400' },
  outfit: { label: 'Outfit', color: 'text-green-400', dot: 'bg-green-400' },
  scene: { label: 'Scene', color: 'text-cyan-400', dot: 'bg-cyan-400' },
  accessories: { label: 'Accessories', color: 'text-orange-400', dot: 'bg-orange-400' },
  details: { label: 'Details', color: 'text-rose-400', dot: 'bg-rose-400' },
  format: { label: 'Format', color: 'text-zinc-400', dot: 'bg-zinc-400' },
  wig: { label: 'Wig', color: 'text-violet-400', dot: 'bg-violet-400' },
};

const _cache = {
  inputMode: 'single',
  postUrl: '',
  profileUrl: '',
  charId: '',
  mode: 'exact',
  cosplayMode: false,
  result: [],
  fetchedPosts: [],
  selected: new Set(),
  history: [],
  postLimit: 9,
  availability: null,
  imageModel: DEFAULT_IMAGE_MODEL,
};

export default function PostClonePage() {
  const { notify, characters: chars } = useApp();
  const { loading, run } = useAsync();
  const { openLightbox, LightboxComponent } = useImageLightbox();

  const [inputMode, setInputMode] = useState(_cache.inputMode);
  const [postUrl, setPostUrl] = useState(_cache.postUrl);
  const [profileUrl, setProfileUrl] = useState(_cache.profileUrl);
  const [postLimit, setPostLimit] = useState(_cache.postLimit);
  const [charId, setCharId] = useState(_cache.charId);
  const [mode, setMode] = useState(_cache.mode);
  const [cosplayMode, setCosplayMode] = useState(_cache.cosplayMode);
  const [imageModel, setImageModel] = useState(_cache.imageModel);
  const [result, setResult] = useState(_cache.result);
  const [availability, setAvailability] = useState(_cache.availability);
  const [savingFocus, setSavingFocus] = useState(null);
  const [focusName, setFocusName] = useState('');

  const [fetchedPosts, setFetchedPosts] = useState(_cache.fetchedPosts);
  const [selected, setSelected] = useState(_cache.selected);
  const [fetching, setFetching] = useState(false);

  const [history, setHistory] = useState(_cache.history);
  const loadHistory = async () => {
    try {
      const data = await historyApi.list();
      setHistory(Array.isArray(data) ? data : []);
    } catch { }
  };
  useEffect(() => { loadHistory(); }, []);

  useEffect(() => { _cache.inputMode = inputMode; }, [inputMode]);
  useEffect(() => { _cache.postUrl = postUrl; }, [postUrl]);
  useEffect(() => { _cache.profileUrl = profileUrl; }, [profileUrl]);
  useEffect(() => { _cache.charId = charId; }, [charId]);
  useEffect(() => { _cache.mode = mode; }, [mode]);
  useEffect(() => { _cache.cosplayMode = cosplayMode; }, [cosplayMode]);
  useEffect(() => { _cache.result = result; }, [result]);
  useEffect(() => { _cache.fetchedPosts = fetchedPosts; }, [fetchedPosts]);
  useEffect(() => { _cache.selected = selected; }, [selected]);
  useEffect(() => { _cache.history = history; }, [history]);
  useEffect(() => { _cache.postLimit = postLimit; }, [postLimit]);
  useEffect(() => { _cache.availability = availability; }, [availability]);
  useEffect(() => { _cache.imageModel = imageModel; }, [imageModel]);

  const [showSession, setShowSession] = useState(false);
  const [sessionInput, setSessionInput] = useState('');
  const [sessionInfo, setSessionInfo] = useState(null);
  const [sessionStatus, setSessionStatus] = useState(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [igLoginInfo, setIgLoginInfo] = useState(null);
  const [autoRefreshing, setAutoRefreshing] = useState(false);

  const loadSession = async () => {
    try {
      const [info, health, login] = await Promise.all([
        keysApi.getInstagramSession(),
        keysApi.healthCheck(),
        keysApi.getInstagramLogin(),
      ]);
      setSessionInfo(info || null);
      setSessionStatus(health?.instagramSession || null);
      setIgLoginInfo(login || null);
    } catch { }
  };
  useEffect(() => { loadSession(); }, []);

  const handleAutoRefresh = async () => {
    setAutoRefreshing(true);
    try {
      await keysApi.igAutoRefresh();
      notify('IG session refreshed via auto-login', 'success');
      await loadSession();
    } catch (err) {
      notify(err.message || 'Auto-refresh failed', 'error');
    } finally { setAutoRefreshing(false); }
  };

  const handleSaveStyleFocus = async (postIdx) => {
    const post = result[postIdx];
    if (!post) return;
    const firstRec = (post.recreatedImages || [])[0];
    const structured = firstRec?.structured;
    if (!structured) {
      notify('No visual DNA found for this post', 'error');
      return;
    }
    const name = focusName.trim() || `Style from ${post.sourceUrl || `Post ${postIdx + 1}`}`.slice(0, 100);
    try {
      await styleFocusApi.save({
        name,
        sourceUrl: post.sourceUrl || '',
        attributes: {
          lighting: structured.lighting || '',
          camera: structured.camera || '',
          pose: structured.pose || '',
          expression: structured.expression || '',
          outfit: structured.outfit || '',
          scene: structured.scene || '',
          accessories: structured.accessories || '',
          details: structured.details || '',
          format: structured.format || '',
        },
        fullPrompt: structured.full_prompt || '',
      });
      notify(`Style Focus "${name}" saved`, 'success');
      setSavingFocus(null);
      setFocusName('');
    } catch (err) {
      notify(err.message || 'Failed to save Style Focus', 'error');
    }
  };

  const LIVE_STEPS = useMemo(() => [
    'Fetching post from Apify',
    'Downloading post images',
    'Analyzing visual structure with Gemini',
    'Recreating with selected character',
  ], []);
  const RECREATE_STEPS = useMemo(() => [
    'Downloading original images',
    'Analyzing post visuals with Gemini',
    'Recreating with selected character',
  ], []);
  const activeSteps = inputMode === 'profile' && fetchedPosts.length > 0 ? RECREATE_STEPS : LIVE_STEPS;
  const POST_THRESHOLDS = useMemo(() =>
    inputMode === 'profile' ? [30, 60, 90] : [35, 45, 65],
  [inputMode]);
  const { elapsedSec, stepIndex: liveStepIndex } = useStepTimer(loading, POST_THRESHOLDS);

  const canRunSingle = useMemo(() => {
    return !!charId && !!postUrl.trim();
  }, [charId, postUrl]);

  const canFetch = useMemo(() => {
    return !!profileUrl.trim() && postLimit >= 1;
  }, [profileUrl, postLimit]);

  const canRecreate = useMemo(() => {
    return !!charId && selected.size > 0;
  }, [charId, selected]);

  const toggleSelect = useCallback((idx) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(fetchedPosts.map((_, i) => i)));
  }, [fetchedPosts]);

  const deselectAll = useCallback(() => {
    setSelected(new Set());
  }, []);

  const handleFetch = async () => {
    if (fetching) return;
    setFetching(true);
    setFetchedPosts([]);
    setSelected(new Set());
    setResult([]);
    try {
      const check = await availabilityApi.check(profileUrl.trim());
      setAvailability(check);
      if (!check?.allowed) {
        notify(check?.label || 'Profile not available for scraping', 'error');
        return;
      }
      const data = await postCloneApi.fetchProfile({
        profileUrl: profileUrl.trim(),
        postLimit: Math.max(1, Math.min(30, Math.round(postLimit))),
      });
      const posts = Array.isArray(data) ? data : [];
      setFetchedPosts(posts);
      setSelected(new Set(posts.map((_, i) => i)));
      if (posts.length === 0) {
        notify('No posts found for this profile', 'error');
      } else {
        notify(`Found ${posts.length} post(s)`, 'success');
      }
    } catch (err) {
      notify(err.message || 'Failed to fetch profile', 'error');
    } finally {
      setFetching(false);
    }
  };

  const handleRecreate = () => run(async () => {
    if (!canRecreate) return;
    const postsToClone = fetchedPosts.filter((_, i) => selected.has(i));
    const data = await postCloneApi.recreateSelected({
      posts: postsToClone,
      characterId: charId,
      mode,
      cosplayMode,
      imageModel,
    });
    setResult(Array.isArray(data) ? data : []);
    notify('Post Clone completed', 'success');
    loadHistory();
  });

  const handleRunSingle = () => run(async () => {
    if (!canRunSingle) return;
    const check = await availabilityApi.check(postUrl.trim());
    setAvailability(check);
    if (!check?.allowed) {
      notify(check?.label || 'Post not available for scraping', 'error');
      return;
    }
    const data = await postCloneApi.clonePost({
      postUrl: postUrl.trim(),
      characterId: charId,
      mode,
      cosplayMode,
      imageModel,
    });
    setResult(Array.isArray(data) ? data : []);
    notify('Post Clone completed', 'success');
    loadHistory();
  });

  const handleBack = () => {
    setFetchedPosts([]);
    setSelected(new Set());
    setResult([]);
  };

  const isProfileSelecting = inputMode === 'profile' && fetchedPosts.length > 0 && result.length === 0 && !loading;

  return (
    <div className="space-y-6 animate-in">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
        <div className="lg:col-span-1 space-y-4">
          <Card className="space-y-4">
            <div className="space-y-2">
              <span className="text-xs text-zinc-400 font-medium block">Input Mode</span>
              <div className="grid grid-cols-2 gap-2">
                <Btn type="button" variant={inputMode === 'single' ? 'primary' : 'secondary'} onClick={() => { setInputMode('single'); handleBack(); }}>Single/Carousel</Btn>
                <Btn type="button" variant={inputMode === 'profile' ? 'primary' : 'secondary'} onClick={() => { setInputMode('profile'); setResult([]); }}>Profile Scrape</Btn>
              </div>
            </div>

            {inputMode === 'single' ? (
              <>
                <Input
                  label="Instagram Post URL"
                  placeholder="https://www.instagram.com/p/..."
                  value={postUrl}
                  onChange={(e) => setPostUrl(e.target.value)}
                />
                <div>
                  <span className="text-xs text-zinc-400 font-medium block mb-1.5">Character</span>
                  <select
                    value={charId}
                    onChange={(e) => setCharId(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
                  >
                    <option value="">Select character...</option>
                    {chars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <Toggle
                  checked={mode === 'exact'}
                  onChange={(next) => setMode(next ? 'exact' : 'creative')}
                  label={mode === 'exact' ? 'Exact Scene Recreate' : 'Creative Reinterpretation'}
                />
                <Toggle
                  checked={cosplayMode}
                  onChange={setCosplayMode}
                  label="Cosplay Mode"
                />
                {cosplayMode && (
                  <p className="text-[10px] text-purple-400/80 -mt-2">Keeps wig color &amp; styling from the source instead of your character's natural hair.</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Badge color="blue">Locked: 2K</Badge>
                  <Badge color="blue">Locked: 4:5</Badge>
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
                <Btn onClick={handleRunSingle} disabled={loading || !canRunSingle} className="w-full">
                  {loading ? <><Spinner size={16} /> Cloning... {elapsedSec}s</> : 'Fetch + Recreate'}
                </Btn>
              </>
            ) : fetchedPosts.length === 0 ? (
              <>
                <Input
                  label="Instagram Profile URL"
                  placeholder="https://www.instagram.com/username/"
                  value={profileUrl}
                  onChange={(e) => setProfileUrl(e.target.value)}
                />
                <Slider
                  label="Posts to Fetch"
                  value={postLimit}
                  min={1}
                  max={30}
                  step={1}
                  onChange={(v) => setPostLimit(Math.round(v))}
                />
                <Btn onClick={handleFetch} disabled={fetching || !canFetch} className="w-full">
                  {fetching ? <><Spinner size={16} /> Fetching...</> : 'Fetch Posts'}
                </Btn>
              </>
            ) : (
              <>
                <div className="text-xs text-zinc-400">
                  <span className="font-medium text-zinc-300">{fetchedPosts.length}</span> posts fetched from profile
                </div>
                <div>
                  <span className="text-xs text-zinc-400 font-medium block mb-1.5">Character</span>
                  <select
                    value={charId}
                    onChange={(e) => setCharId(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
                  >
                    <option value="">Select character...</option>
                    {chars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <Toggle
                  checked={mode === 'exact'}
                  onChange={(next) => setMode(next ? 'exact' : 'creative')}
                  label={mode === 'exact' ? 'Exact Scene Recreate' : 'Creative Reinterpretation'}
                />
                <Toggle
                  checked={cosplayMode}
                  onChange={setCosplayMode}
                  label="Cosplay Mode"
                />
                {cosplayMode && (
                  <p className="text-[10px] text-purple-400/80 -mt-2">Keeps wig color &amp; styling from the source instead of your character's natural hair.</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Badge color="blue">Locked: 2K</Badge>
                  <Badge color="blue">Locked: 4:5</Badge>
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
                <Btn onClick={handleRecreate} disabled={loading || !canRecreate} className="w-full">
                  {loading ? <><Spinner size={16} /> Recreating... {elapsedSec}s</> : `Recreate Selected (${selected.size})`}
                </Btn>
                <Btn variant="secondary" onClick={handleBack} disabled={loading} className="w-full">
                  Back
                </Btn>
              </>
            )}

            {availability && (
              <div className={`rounded-lg border px-3 py-2 text-xs ${
                availability.color === 'green'
                  ? 'border-green-500/40 bg-green-500/10 text-green-300'
                  : availability.color === 'yellow'
                    ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300'
                    : 'border-red-500/40 bg-red-500/10 text-red-300'
              }`}>
                {availability.label}
              </div>
            )}
          </Card>

          <Card className="!p-0 overflow-hidden">
            <button
              type="button"
              onClick={() => setShowSession((p) => !p)}
              className="w-full flex items-center justify-between px-3 py-2.5 text-xs text-zinc-400 hover:text-zinc-300 transition-colors cursor-pointer"
            >
              <span className="flex items-center gap-1.5">
                IG Session
                {sessionStatus?.status === 'active'
                  ? <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" title="Active" />
                  : sessionStatus?.status === 'expired'
                    ? <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500" title="Expired" />
                    : sessionInfo?.hasInstagramSession
                      ? <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500" title="Stored (unverified)" />
                      : <span className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-600" title="Not set" />}
              </span>
              <span className="flex items-center gap-2">
                {sessionStatus?.status === 'active' && (
                  <span className="text-green-400 text-[10px]">{sessionStatus.message}</span>
                )}
                {sessionStatus?.status === 'expired' && (
                  <span className="text-red-400 text-[10px]">Expired</span>
                )}
                <span className={`transition-transform duration-150 ${showSession ? 'rotate-180' : ''}`}>&#9662;</span>
              </span>
            </button>
            {showSession && (
              <div className="px-3 pb-3 space-y-2 border-t border-zinc-700/60 pt-2">
                {sessionStatus?.message && (
                  <div className={`text-[11px] ${
                    sessionStatus.status === 'active' ? 'text-green-400'
                      : sessionStatus.status === 'expired' ? 'text-red-400'
                        : 'text-zinc-500'
                  }`}>{sessionStatus.message}</div>
                )}
                {sessionInfo?.hasInstagramSession && (
                  <div className="text-[11px] text-zinc-500 font-mono">{sessionInfo.maskedValue}</div>
                )}
                <Input
                  placeholder="Paste sessionid cookie..."
                  type="password"
                  value={sessionInput}
                  onChange={(e) => setSessionInput(e.target.value)}
                />
                <div className="flex gap-2">
                  <Btn
                    size="sm"
                    disabled={sessionLoading || !sessionInput.trim()}
                    onClick={async () => {
                      setSessionLoading(true);
                      try {
                        await keysApi.setInstagramSession(sessionInput.trim());
                        setSessionInput('');
                        notify('IG session saved', 'success');
                        await loadSession();
                      } catch (err) {
                        notify(err.message || 'Failed to save session', 'error');
                      } finally { setSessionLoading(false); }
                    }}
                  >
                    {sessionLoading ? <Spinner size={14} /> : 'Save'}
                  </Btn>
                  {sessionInfo?.hasInstagramSession && (
                    <Btn
                      size="sm"
                      variant="secondary"
                      disabled={sessionLoading}
                      onClick={async () => {
                        setSessionLoading(true);
                        try {
                          await keysApi.clearInstagramSession();
                          setSessionInput('');
                          notify('IG session cleared', 'success');
                          await loadSession();
                        } catch (err) {
                          notify(err.message || 'Failed to clear session', 'error');
                        } finally { setSessionLoading(false); }
                      }}
                    >
                      Clear
                    </Btn>
                  )}
                  {igLoginInfo?.hasInstagramLogin && (
                    <Btn
                      size="sm"
                      variant="secondary"
                      disabled={autoRefreshing}
                      onClick={handleAutoRefresh}
                    >
                      {autoRefreshing ? <Spinner size={14} /> : 'Auto Refresh'}
                    </Btn>
                  )}
                </div>
              </div>
            )}
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {isProfileSelecting && (
            <Card className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-300">Select Posts to Recreate</h3>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={selectAll} className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors cursor-pointer">Select All</button>
                  <span className="text-zinc-700">|</span>
                  <button type="button" onClick={deselectAll} className="text-[11px] text-zinc-500 hover:text-zinc-400 transition-colors cursor-pointer">Deselect All</button>
                  <Badge color="zinc">{selected.size}/{fetchedPosts.length}</Badge>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {fetchedPosts.map((post, idx) => {
                  const isSelected = selected.has(idx);
                  const cachedThumb = postCloneApi.thumbUrl(post.thumbnail);
                  const hasSrc = !!(cachedThumb || (post.imageUrls || [])[0]);
                  return (
                    <button
                      key={`${post.sourceUrl}-${idx}`}
                      type="button"
                      onClick={() => toggleSelect(idx)}
                      className={cn(
                        'relative rounded-lg overflow-hidden border-2 transition-all cursor-pointer group',
                        isSelected
                          ? 'border-blue-500 ring-1 ring-blue-500/30'
                          : 'border-zinc-700/60 hover:border-zinc-600',
                      )}
                    >
                      {hasSrc ? (
                        <img
                          src={cachedThumb || postCloneApi.proxyImageUrl((post.imageUrls || [])[0])}
                          alt=""
                          className="w-full aspect-[4/5] object-cover bg-zinc-800"
                          loading="lazy"
                          onError={(e) => {
                            e.target.style.display = 'none';
                            e.target.nextElementSibling?.classList?.remove('hidden');
                          }}
                        />
                      ) : null}
                      <div className={cn(
                        'w-full aspect-[4/5] bg-zinc-800 flex items-center justify-center text-xs text-zinc-500',
                        hasSrc ? 'hidden' : '',
                      )}>
                        No preview
                      </div>
                      <div className={cn(
                        'absolute top-1.5 right-1.5 w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold transition-colors',
                        isSelected
                          ? 'bg-blue-500 text-white'
                          : 'bg-zinc-900/70 border border-zinc-600 text-transparent group-hover:border-zinc-500',
                      )}>
                        {isSelected && '✓'}
                      </div>
                      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1.5 pt-4">
                        <div className="flex items-center gap-1">
                          <Badge color="zinc" className="!text-[9px] !px-1 !py-0">{post.type}</Badge>
                          {post.slideCount > 1 && (
                            <span className="text-[9px] text-zinc-400">{post.slideCount} slides</span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </Card>
          )}

          {fetching && (
            <Card className="min-h-[360px] flex items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <Spinner size={24} />
                <p className="text-sm text-zinc-400">Fetching posts from profile...</p>
              </div>
            </Card>
          )}

          {!loading && !fetching && !isProfileSelecting && (!Array.isArray(result) || result.length === 0) && (
            <Card className="min-h-[360px] flex items-center justify-center">
              <Empty icon="Cl" title="No clone results yet" subtitle={inputMode === 'profile' ? 'Fetch posts from a profile, select which ones to recreate.' : 'Run a post clone and results will appear here.'} />
            </Card>
          )}

          {loading && (
            <StepProgress steps={activeSteps} currentIndex={liveStepIndex} elapsedSec={elapsedSec} className="min-h-[360px]" />
          )}

          {!loading && Array.isArray(result) && result.length > 0 && result.map((post, idx) => {
            const firstStructured = (post.recreatedImages || [])[0]?.structured;
            const hasDna = firstStructured && Object.values(DNA_LABELS).some((_, i) => firstStructured[Object.keys(DNA_LABELS)[i]]);

            return (
              <Card key={`${post.sourceUrl || 'post'}-${idx}`} className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-zinc-300">Post {idx + 1}</h3>
                  <div className="flex items-center gap-2">
                    {hasDna && (
                      <Btn
                        variant="ghost"
                        className="!px-2 !py-1 text-[10px]"
                        onClick={() => setSavingFocus(savingFocus === idx ? null : idx)}
                      >
                        {savingFocus === idx ? 'Cancel' : 'Save Style Focus'}
                      </Btn>
                    )}
                    <Badge color="zinc">{post.type}</Badge>
                  </div>
                </div>
                {post.sourceUrl && <p className="text-[11px] text-zinc-500 truncate">{post.sourceUrl}</p>}

                {savingFocus === idx && (
                  <div className="flex items-center gap-2 bg-zinc-800/50 rounded-lg p-2">
                    <input
                      type="text"
                      placeholder="Style Focus name..."
                      value={focusName}
                      onChange={(e) => setFocusName(e.target.value)}
                      className="flex-1 h-8 rounded-md border border-zinc-700/60 bg-zinc-900/50 px-2.5 text-xs text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500/70"
                    />
                    <Btn className="!px-3 !py-1 text-xs" onClick={() => handleSaveStyleFocus(idx)}>
                      Save
                    </Btn>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <p className="text-xs text-zinc-500">Original</p>
                    {(post.originalImages || []).map((img, i) => {
                      const src = img.base64Data ? `data:${img.mimeType || 'image/jpeg'};base64,${img.base64Data}` : img.url;
                      return (
                        <img
                          key={`orig-${i}`}
                          src={src}
                          alt=""
                          className="w-full rounded-lg cursor-pointer"
                          onClick={() => openLightbox((post.originalImages || []).map((item) => item.base64Data ? `data:${item.mimeType || 'image/jpeg'};base64,${item.base64Data}` : item.url), i)}
                        />
                      );
                    })}
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-zinc-500">Recreated</p>
                    {(post.recreatedImages || []).map((img, i) => {
                      const src = img.base64Data ? `data:${img.mimeType || 'image/png'};base64,${img.base64Data}` : '';
                      return (
                        <img
                          key={`recreate-${i}`}
                          src={src}
                          alt=""
                          className="w-full rounded-lg cursor-pointer"
                          onClick={() => openLightbox((post.recreatedImages || []).map((item) => `data:${item.mimeType || 'image/png'};base64,${item.base64Data}`), i)}
                        />
                      );
                    })}
                  </div>
                </div>

                {hasDna && (
                  <Section title="Visual DNA" badge={<Badge color="purple">Extracted</Badge>}>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {Object.entries(DNA_LABELS).map(([key, meta]) => {
                        const value = firstStructured[key];
                        if (!value) return null;
                        return (
                          <div key={key} className="bg-zinc-800/40 rounded-lg p-2">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span className={cn('w-1.5 h-1.5 rounded-full', meta.dot)} />
                              <span className={cn('text-[10px] font-medium uppercase tracking-wider', meta.color)}>{meta.label}</span>
                            </div>
                            <p className="text-[11px] text-zinc-300 leading-relaxed line-clamp-3">{value}</p>
                          </div>
                        );
                      })}
                    </div>
                  </Section>
                )}
              </Card>
            );
          })}
        </div>
      </div>

      {history.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Clone History</h2>
            <Badge color="zinc">{history.length}</Badge>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {history.map((entry) => (
              <Card key={entry.id} className="!p-3 space-y-2">
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {(entry.galleryIds || []).slice(0, 4).map((gid) => (
                    <img
                      key={gid}
                      src={historyApi.imageUrl(gid)}
                      alt=""
                      className="w-14 h-[70px] object-cover rounded-md bg-zinc-800 flex-shrink-0 cursor-pointer"
                      onClick={() => openLightbox((entry.galleryIds || []).map((id) => historyApi.imageUrl(id)), (entry.galleryIds || []).indexOf(gid))}
                    />
                  ))}
                  {(entry.galleryIds || []).length > 4 && (
                    <div className="w-14 h-[70px] rounded-md bg-zinc-800/60 border border-zinc-700/40 flex items-center justify-center flex-shrink-0">
                      <span className="text-[10px] text-zinc-500">+{entry.galleryIds.length - 4}</span>
                    </div>
                  )}
                </div>
                {entry.sourceUrl && (
                  <a
                    href={entry.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-[11px] text-blue-400 hover:text-blue-300 truncate transition-colors"
                  >
                    {entry.sourceUrl}
                  </a>
                )}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Badge color="zinc">{entry.type}</Badge>
                    {entry.slideCount > 1 && (
                      <span className="text-[10px] text-zinc-500">{entry.slideCount} slides</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-zinc-600">{new Date(entry.createdAt).toLocaleDateString()}</span>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await historyApi.remove(entry.id);
                          setHistory((prev) => prev.filter((h) => h.id !== entry.id));
                        } catch (err) {
                          notify(err.message || 'Failed to remove', 'error');
                        }
                      }}
                      className="text-[10px] text-zinc-600 hover:text-red-400 transition-colors cursor-pointer"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      <LightboxComponent />
    </div>
  );
}
