import { useEffect, useMemo, useState } from 'react';
import { postClone as postCloneApi, availability as availabilityApi, keys as keysApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { useStepTimer } from '../hooks/useStepTimer';
import { Card, Btn, Input, Badge, Slider, Spinner, Empty, Toggle, StepProgress } from '../components/UI';
import useImageLightbox from '../components/lightbox/useImageLightbox';

export default function PostClonePage() {
  const { notify, characters: chars } = useApp();
  const { loading, run } = useAsync();
  const { openLightbox, LightboxComponent } = useImageLightbox();

  const [inputMode, setInputMode] = useState('single'); // single | profile
  const [postUrl, setPostUrl] = useState('');
  const [profileUrl, setProfileUrl] = useState('');
  const [postLimit, setPostLimit] = useState(5);
  const [charId, setCharId] = useState('');
  const [mode, setMode] = useState('exact'); // exact | creative
  const [result, setResult] = useState([]);
  const [availability, setAvailability] = useState(null);

  // IG session quick-edit + live status
  const [showSession, setShowSession] = useState(false);
  const [sessionInput, setSessionInput] = useState('');
  const [sessionInfo, setSessionInfo] = useState(null);
  const [sessionStatus, setSessionStatus] = useState(null); // from health-check
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
    } catch { /* ignore */ }
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

  const LIVE_STEPS = useMemo(() => inputMode === 'profile'
    ? [
      'Fetching posts from profile via Apify',
      'Downloading images and filtering carousels',
      'Analyzing post visuals with Gemini',
      'Recreating with selected character',
    ]
    : [
      'Fetching post from Apify',
      'Downloading post images',
      'Analyzing visual structure with Gemini',
      'Recreating with selected character',
    ],
  [inputMode]);
  const POST_THRESHOLDS = useMemo(() =>
    inputMode === 'profile' ? [45, 60, 90] : [35, 45, 65],
  [inputMode]);
  const { elapsedSec, stepIndex: liveStepIndex } = useStepTimer(loading, POST_THRESHOLDS);

  const canRun = useMemo(() => {
    if (!charId) return false;
    if (inputMode === 'single') return !!postUrl.trim();
    return !!profileUrl.trim() && postLimit >= 1 && postLimit <= 20;
  }, [charId, inputMode, postUrl, profileUrl, postLimit]);

  const handleRun = () => run(async () => {
    if (!canRun) return;
    const checkUrl = inputMode === 'single' ? postUrl.trim() : profileUrl.trim();
    const check = await availabilityApi.check(checkUrl);
    setAvailability(check);
    if (!check?.allowed) {
      notify(check?.label || 'Profile/post not available for scraping', 'error');
      return;
    }

    let data;
    if (inputMode === 'single') {
      data = await postCloneApi.clonePost({
        postUrl: postUrl.trim(),
        characterId: charId,
        mode,
      });
    } else {
      data = await postCloneApi.cloneProfile({
        profileUrl: profileUrl.trim(),
        characterId: charId,
        postLimit: Math.max(1, Math.min(20, Math.round(postLimit))),
        mode,
      });
    }
    setResult(Array.isArray(data) ? data : []);
    notify('Post Clone completed', 'success');
  });

  return (
    <div className="space-y-6 animate-in">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-gradient">Post Clone</h1>
        <p className="text-zinc-500 text-sm mt-1">Clone single posts, carousels, or profile feeds with your selected character at locked 2K 4:5.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <Card className="space-y-4">
            <div className="space-y-2">
              <span className="text-xs text-zinc-400 font-medium block">Input Mode</span>
              <div className="grid grid-cols-2 gap-2">
                <Btn type="button" variant={inputMode === 'single' ? 'primary' : 'secondary'} onClick={() => setInputMode('single')}>Single/Carousel</Btn>
                <Btn type="button" variant={inputMode === 'profile' ? 'primary' : 'secondary'} onClick={() => setInputMode('profile')}>Profile Scrape</Btn>
              </div>
            </div>

            {inputMode === 'single' ? (
              <Input
                label="Instagram Post URL"
                placeholder="https://www.instagram.com/p/..."
                value={postUrl}
                onChange={(e) => setPostUrl(e.target.value)}
              />
            ) : (
              <>
                <Input
                  label="Instagram Profile URL"
                  placeholder="https://www.instagram.com/username/"
                  value={profileUrl}
                  onChange={(e) => setProfileUrl(e.target.value)}
                />
                <Slider
                  label="Number of Posts"
                  value={postLimit}
                  min={1}
                  max={20}
                  step={1}
                  onChange={(v) => setPostLimit(Math.round(v))}
                />
              </>
            )}

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

            <div className="flex flex-wrap gap-2">
              <Badge color="blue">Locked: 2K</Badge>
              <Badge color="blue">Locked: 4:5</Badge>
            </div>

            <Btn onClick={handleRun} disabled={loading || !canRun} className="w-full">
              {loading ? <><Spinner size={16} /> Fetching... {elapsedSec}s</> : 'Fetch + Recreate'}
            </Btn>
          </Card>

          {/* IG Session quick-edit with live status */}
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
          {!loading && (!Array.isArray(result) || result.length === 0) && (
            <Card className="min-h-[360px] flex items-center justify-center">
              <Empty icon="Cl" title="No clone results yet" subtitle="Run a post clone and results will appear here." />
            </Card>
          )}

          {loading && (
            <StepProgress steps={LIVE_STEPS} currentIndex={liveStepIndex} elapsedSec={elapsedSec} className="min-h-[360px]" />
          )}

          {!loading && Array.isArray(result) && result.length > 0 && result.map((post, idx) => (
            <Card key={`${post.sourceUrl || 'post'}-${idx}`} className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-300">Post {idx + 1}</h3>
                <Badge color="zinc">{post.type}</Badge>
              </div>
              {post.sourceUrl && <p className="text-[11px] text-zinc-500 truncate">{post.sourceUrl}</p>}

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
            </Card>
          ))}
        </div>
      </div>
      <LightboxComponent />
    </div>
  );
}
