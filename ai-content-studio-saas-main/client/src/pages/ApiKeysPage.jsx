import { useState, useEffect } from 'react';
import { keys as keysApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { Card, Btn, Input, Badge, Spinner, Empty, ConfirmDialog, SpendBar } from '../components/UI';
import { IconKey } from 'nucleo-glass';

// ─── Key metadata ────────────────────────────────────────────────────────────
const KEY_INFO = {
  gemini: {
    emoji: '🧠',
    name: 'Gemini API Key',
    what: 'Powers all image generation and AI features. Get it free from Google AI Studio — no credit card, no setup.',
    why: 'Required — nothing works without it.',
    where: 'Google AI Studio',
    link: 'https://aistudio.google.com/app/apikey',
    free: true,
    freeNote: 'Free — no credit card required',
  },
  apify: {
    emoji: '📸',
    name: 'Apify Key',
    what: 'Scrapes Instagram profiles and posts so you can clone or analyze them.',
    why: 'Needed for Profile Analyzer, Post Clone, and Reel Copy.',
    where: 'Apify Console',
    link: 'https://console.apify.com/account/integrations',
    free: true,
    freeNote: 'Free tier: ~$5 of free credits/month',
  },
  wavespeed: {
    emoji: '🎬',
    name: 'WaveSpeed Key',
    what: 'Runs video generation models (Kling, Grok video). Veo 3.1 uses your Gemini key instead.',
    why: 'Only needed if you want video models besides Veo.',
    where: 'WaveSpeed.ai',
    link: 'https://wavespeed.ai',
    free: false,
    freeNote: 'Paid — pay per generation',
  },
  instagram: {
    emoji: '🍪',
    name: 'Instagram Session',
    what: 'A browser cookie from your Instagram login. Lets Apify access age-restricted profiles.',
    why: 'Optional — only needed for private/restricted content.',
    where: 'Your browser (copy from DevTools)',
    link: null,
    free: true,
    freeNote: 'No account needed — use your own Instagram login',
  },
  iglogin: {
    emoji: '🔑',
    name: 'Instagram Auto-Login',
    what: 'Burner Instagram account credentials. Automatically re-generates your session cookie when it expires.',
    why: 'Optional — saves you from manually refreshing the session cookie.',
    where: 'A spare Instagram account',
    link: null,
    free: true,
    freeNote: 'Use a throwaway account, not your main one',
  },
};

const QUICK_START_LINKS = {
  gemini: 'https://aistudio.google.com/app/apikey',
  apify: 'https://console.apify.com/account/integrations',
  googleCloud: 'https://cloud.google.com/free',
};

// ─── Reusable key section header ─────────────────────────────────────────────
function KeyHeader({ infoKey, isConnected, children }) {
  const info = KEY_INFO[infoKey];
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="text-2xl leading-none mt-0.5">{info.emoji}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-zinc-100 text-sm">{info.name}</span>
            <Badge color={isConnected ? 'green' : 'zinc'}>{isConnected ? 'Connected' : 'Not set'}</Badge>
            {info.free && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-900/50 text-emerald-400 border border-emerald-700/40">
                FREE
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-400 mt-1 leading-relaxed">{info.what}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[11px]">
            <span className="text-zinc-500">{info.why}</span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-500">Get it from</span>
            {info.link ? (
              <a
                href={info.link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors"
              >
                {info.where} ↗
              </a>
            ) : (
              <span className="text-zinc-400">{info.where}</span>
            )}
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-500">{info.freeNote}</span>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

function SetupGuide({ title, subtitle, url, steps, note, onCopyLink, badge = 'START HERE' }) {
  return (
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 p-3.5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-zinc-100">{title}</p>
          <p className="text-xs text-zinc-400 leading-relaxed">{subtitle}</p>
        </div>
        <Badge color="blue">{badge}</Badge>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {steps.map((step, index) => (
          <div key={`${title}-${index}`} className="rounded-lg border border-zinc-700/40 bg-zinc-950/50 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-400">Step {index + 1}</div>
            <div className="mt-1 text-xs text-zinc-300 leading-relaxed">{step}</div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-zinc-700/40 bg-zinc-950/60 px-3 py-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Direct link</span>
          <Btn variant="secondary" className="!py-1 !px-2.5 !text-[11px]" onClick={() => onCopyLink?.(url, title)}>
            Copy Link
          </Btn>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="block break-all text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2"
        >
          {url}
        </a>
        {note ? <p className="text-[11px] text-zinc-500 leading-relaxed">{note}</p> : null}
      </div>
    </div>
  );
}

function QuickStartGuide({ onCopyLink }) {
  return (
    <div className="rounded-2xl border border-blue-800/40 bg-blue-950/20 p-4 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-blue-300">🚀 Start Here</p>
          <p className="text-xs text-blue-400/80 leading-relaxed">
            Add Gemini first. Add Apify only if you want clone and scrape tools.
          </p>
        </div>
        <Badge color="blue">Quick Setup</Badge>
      </div>

      <div className="grid gap-2 sm:grid-cols-5">
        {[
          { num: '1', title: 'Gemini', text: 'Add your main key first.' },
          { num: '2', title: 'Characters', text: 'Create your first character.' },
          { num: '3', title: 'Generate', text: 'Create your first image.' },
          { num: '4', title: 'Library', text: 'Find everything here.' },
          { num: '5', title: 'Apify (opt.)', text: 'Only for clone tools.' },
        ].map((item) => (
          <div key={item.num} className="rounded-xl border border-zinc-700/50 bg-zinc-950/40 p-3 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1.5 text-[10px] font-semibold text-white">
                {item.num}
              </span>
              <span className="text-xs font-semibold text-zinc-100">{item.title}</span>
            </div>
            <p className="text-[11px] leading-relaxed text-zinc-500">{item.text}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {[
          {
            title: '🧠 Gemini Key',
            url: QUICK_START_LINKS.gemini,
            copyLabel: 'Gemini',
            highlight: true,
          },
          {
            title: '📸 Apify Key',
            subtitle: 'Optional · Only for Post Clone & Profile Analyzer',
            url: QUICK_START_LINKS.apify,
            copyLabel: 'Apify',
            highlight: false,
          },
        ].map((item) => (
          <div key={item.title} className={`rounded-xl border p-3 space-y-2.5 ${item.highlight ? 'border-blue-600/40 bg-blue-950/20' : 'border-zinc-700/50 bg-zinc-950/40'}`}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-zinc-100">{item.title}</p>
                {item.subtitle ? <p className="text-[11px] text-zinc-500">{item.subtitle}</p> : null}
              </div>
              <Btn variant="secondary" className="!py-1 !px-2.5 !text-[11px]" onClick={() => onCopyLink?.(item.url, item.copyLabel)}>
                Copy Link
              </Btn>
            </div>
            <a href={item.url} target="_blank" rel="noopener noreferrer" className="block break-all text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2">
              {item.url}
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function ApiKeysPage() {
  const { activeKey, setActiveKey, refreshIntegrationStatus, notify } = useApp();
  const [keyList, setKeyList] = useState([]);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apifyKey, setApifyKey] = useState('');
  const [apifyInfo, setApifyInfo] = useState({ hasApifyKey: false, maskedKey: '', updatedAt: null });
  const [instagramSessionId, setInstagramSessionId] = useState('');
  const [instagramSessionInfo, setInstagramSessionInfo] = useState({ hasInstagramSession: false, maskedValue: '', updatedAt: null });
  const [wavespeedKey, setWavespeedKey] = useState('');
  const [wavespeedInfo, setWavespeedInfo] = useState({ hasWavespeedKey: false, maskedKey: '', updatedAt: null });
  const [igLoginUsername, setIgLoginUsername] = useState('');
  const [igLoginPassword, setIgLoginPassword] = useState('');
  const [igLogin2faSecret, setIgLogin2faSecret] = useState('');
  const [igLoginInfo, setIgLoginInfo] = useState({ hasInstagramLogin: false, maskedUsername: '', maskedPassword: '', has2fa: false, masked2faSecret: '', updatedAt: null });
  const [refreshing, setRefreshing] = useState(false);
  const [health, setHealth] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [spend, setSpend] = useState(null);
  const [showGeminiGuide, setShowGeminiGuide] = useState(false);
  const [showGeminiAddForm, setShowGeminiAddForm] = useState(false);
  const { loading, run } = useAsync();
  const { loading: loadingList, run: runList } = useAsync();
  const { loading: loadingHealth, run: runHealth } = useAsync();

  const badgeColorForStatus = (status) => {
    if (status === 'ok' || status === 'active') return 'green';
    if (status === 'degraded') return 'yellow';
    if (status === 'missing') return 'zinc';
    return 'red';
  };

  const refreshHealth = () => runHealth(async () => {
    const data = await keysApi.healthCheck();
    setHealth(data);
  });

  const load = () => runList(async () => {
    const [data, apify, ws, igSession, igLogin, spendData] = await Promise.all([
      keysApi.list(), keysApi.getApify(), keysApi.getWavespeed(), keysApi.getInstagramSession(), keysApi.getInstagramLogin(), keysApi.getSpend().catch(() => null),
    ]);
    if (spendData) setSpend(spendData);
    setKeyList(data);
    setApifyInfo(apify || { hasApifyKey: false, maskedKey: '', updatedAt: null });
    setWavespeedInfo(ws || { hasWavespeedKey: false, maskedKey: '', updatedAt: null });
    setInstagramSessionInfo(igSession || { hasInstagramSession: false, maskedValue: '', updatedAt: null });
    setIgLoginInfo(igLogin || { hasInstagramLogin: false, maskedUsername: '', maskedPassword: '', updatedAt: null });
    const act = data.find((k) => k.isActive);
    if (act) setActiveKey(act);
    else if (data.length === 0) setActiveKey(null);
    refreshIntegrationStatus();
    await refreshHealth();
  });

  useEffect(() => { load(); }, []);

  const hasGeminiKeys = keyList.length > 0;
  const hasActiveGeminiKey = keyList.some((k) => k.isActive);

  const handleAdd = () => run(async () => {
    if (!name.trim() || !apiKey.trim()) { notify('Name and key are required', 'error'); return; }
    await keysApi.add(name.trim(), apiKey.trim());
    setName(''); setApiKey('');
    setShowGeminiAddForm(false);
    notify('Key added', 'success');
    await load();
  });

  const handleActivate = (id) => run(async () => {
    await keysApi.activate(id);
    notify('Key activated', 'success');
    await load();
  });

  const handleDelete = (id) => run(async () => {
    await keysApi.remove(id);
    notify('Key removed', 'success');
    await load();
  });

  const handleSaveApify = () => run(async () => {
    if (!apifyKey.trim()) { notify('Apify key is required', 'error'); return; }
    await keysApi.setApify(apifyKey.trim());
    setApifyKey('');
    notify('Apify key saved', 'success');
    await load();
  });

  const handleClearApify = () => run(async () => {
    await keysApi.clearApify();
    setApifyKey('');
    notify('Apify key removed', 'success');
    await load();
  });

  const handleSaveWavespeed = () => run(async () => {
    if (!wavespeedKey.trim()) { notify('WaveSpeed key is required', 'error'); return; }
    await keysApi.setWavespeed(wavespeedKey.trim());
    setWavespeedKey('');
    notify('WaveSpeed key saved', 'success');
    await load();
  });

  const handleClearWavespeed = () => run(async () => {
    await keysApi.clearWavespeed();
    setWavespeedKey('');
    notify('WaveSpeed key removed', 'success');
    await load();
  });

  const handleSaveInstagramSession = () => run(async () => {
    if (!instagramSessionId.trim()) { notify('Instagram sessionid is required', 'error'); return; }
    await keysApi.setInstagramSession(instagramSessionId.trim());
    setInstagramSessionId('');
    notify('Instagram session saved', 'success');
    await load();
  });

  const handleClearInstagramSession = () => run(async () => {
    await keysApi.clearInstagramSession();
    setInstagramSessionId('');
    notify('Instagram session removed', 'success');
    await load();
  });

  const handleSaveInstagramLogin = () => run(async () => {
    if (!igLoginUsername.trim() || !igLoginPassword.trim()) { notify('Username and password are required', 'error'); return; }
    await keysApi.setInstagramLogin(igLoginUsername.trim(), igLoginPassword.trim(), igLogin2faSecret.trim() || null);
    setIgLoginUsername(''); setIgLoginPassword(''); setIgLogin2faSecret('');
    notify('Instagram credentials saved', 'success');
    await load();
  });

  const handleClearInstagramLogin = () => run(async () => {
    await keysApi.clearInstagramLogin();
    setIgLoginUsername(''); setIgLoginPassword(''); setIgLogin2faSecret('');
    notify('Instagram credentials removed', 'success');
    await load();
  });

  const handleAutoRefresh = async () => {
    setRefreshing(true);
    try {
      await keysApi.igAutoRefresh();
      notify('IG session refreshed via auto-login', 'success');
      await load();
    } catch (err) {
      notify(err.message || 'Auto-refresh failed', 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const handleCopyLink = async (url, label) => {
    try {
      await navigator.clipboard.writeText(url);
      notify(`${label} link copied`, 'success');
    } catch {
      notify(`Failed to copy ${label.toLowerCase()} link`, 'error');
    }
  };

  const geminiKeyForm = (
    <div className="rounded-2xl border border-zinc-700/50 bg-zinc-950/50 p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-zinc-100">Paste your Gemini key here</p>
          <p className="text-xs text-zinc-400 mt-1">Name it, paste it, save it.</p>
        </div>
        <Badge color="blue">Main Key</Badge>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="Key Name" placeholder="e.g. Main Gemini" value={name} onChange={(e) => setName(e.target.value)} />
        <Input label="Gemini API Key" placeholder="AIza..." type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Btn onClick={handleAdd} disabled={loading || !name.trim() || !apiKey.trim()}>
          {loading ? <Spinner size={16} /> : null} Add Key
        </Btn>
      </div>
    </div>
  );

  return (
    <div className="space-y-6 animate-in max-w-7xl">

      <QuickStartGuide onCopyLink={handleCopyLink} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_380px]">
        <div className="space-y-6">
          {/* ── 1. Gemini ── */}
          <Card className="space-y-5">
            {!hasGeminiKeys ? (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex items-start gap-3">
                    <span className="text-2xl leading-none mt-0.5">🧠</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-zinc-100 text-sm">Gemini API Key</span>
                        <Badge color="red">Not set</Badge>
                        <Badge color="blue">Tier 1 Required</Badge>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                        Unlocks image generation. Use a billing-enabled Gemini key.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-amber-700/50 bg-amber-950/20 px-4 py-3 text-xs text-amber-300 leading-relaxed">
                  Image generation needs billing enabled. Google&apos;s $300 free credit works.
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href="https://aistudio.google.com/app/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-700/50 bg-zinc-900/50 px-3 py-1.5 text-[11px] text-blue-300 hover:bg-zinc-800/60 transition-colors"
                  >
                    aistudio.google.com/app/apikey ↗
                  </a>
                  <a
                    href="https://cloud.google.com/free"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-700/50 bg-zinc-900/50 px-3 py-1.5 text-[11px] text-blue-300 hover:bg-zinc-800/60 transition-colors"
                  >
                    cloud.google.com/free ↗
                  </a>
                </div>

                <button
                  type="button"
                  onClick={() => setShowGeminiGuide((prev) => !prev)}
                  className="flex w-full items-center justify-between rounded-xl border border-zinc-700/50 bg-zinc-900/40 px-4 py-3 text-left transition hover:border-zinc-600/60 hover:bg-zinc-900/60"
                >
                  <span className="text-sm font-medium text-zinc-100">Need a Tier 1 key?</span>
                  <span className={`inline-block text-zinc-400 transition-transform duration-200 ${showGeminiGuide ? 'rotate-90' : ''}`}>▸</span>
                </button>

                <div className={`grid transition-all duration-300 ease-out ${showGeminiGuide ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                  <div className="overflow-hidden">
                    <div className="pt-3 space-y-5">
                      <div className="rounded-xl overflow-hidden border border-zinc-700/50">
                        <div className="grid grid-cols-3 bg-zinc-900/80 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                          <span>Feature</span>
                          <span className="text-center">Free Tier</span>
                          <span className="text-center text-blue-400">Tier 1</span>
                        </div>
                        {[
                          { feature: 'Text / chat', free: '✓', tier1: '✓', tier1Color: 'text-zinc-300' },
                          { feature: 'Image generation', free: '✗', tier1: '✓', freeColor: 'text-red-400', tier1Color: 'text-emerald-400' },
                          { feature: 'Rate limits', free: 'Low', tier1: 'High', freeColor: 'text-zinc-400', tier1Color: 'text-emerald-400' },
                          { feature: 'Billing required', free: 'No', tier1: 'Yes', freeColor: 'text-zinc-300', tier1Color: 'text-blue-400' },
                        ].map((row, i) => (
                          <div key={row.feature} className={`grid grid-cols-3 px-3 py-2.5 text-xs border-t border-zinc-700/40 ${i % 2 === 0 ? 'bg-zinc-950/30' : ''}`}>
                            <span className="text-zinc-400">{row.feature}</span>
                            <span className={`text-center font-medium ${row.freeColor || 'text-zinc-300'}`}>{row.free}</span>
                            <span className={`text-center font-semibold ${row.tier1Color}`}>{row.tier1}</span>
                          </div>
                        ))}
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white shrink-0">1</span>
                          <p className="text-xs font-semibold text-blue-300">Claim the Google Cloud credit</p>
                        </div>
                        <div className="space-y-1.5 pl-7">
                          {[
                            'Go to cloud.google.com and sign in with your Google account.',
                            'Click "Get started for free" and enter a card — identity check only, not charged.',
                            'Google adds $300 credit valid for 90 days.',
                          ].map((text, i) => (
                            <div key={i} className="rounded-lg border-l-2 border-blue-600/60 bg-zinc-900/50 px-3 py-2">
                              <span className="text-[10px] font-semibold text-blue-500 mr-1.5">Step {i + 1}</span>
                              <span className="text-xs text-zinc-300">{text}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-teal-600 text-[10px] font-bold text-white shrink-0">2</span>
                          <p className="text-xs font-semibold text-teal-300">Create the right Gemini key</p>
                        </div>
                        <div className="space-y-1.5 pl-7">
                          {[
                            'Open AI Studio with the same Google account.',
                            'Create the API key in a Google Cloud project with billing enabled.',
                            'That key becomes Tier 1 and can generate images.',
                          ].map((text, i) => (
                            <div key={i} className="rounded-lg border-l-2 border-teal-600/60 bg-zinc-900/50 px-3 py-2">
                              <span className="text-[10px] font-semibold text-teal-500 mr-1.5">Step {i + 4}</span>
                              <span className="text-xs text-zinc-300">{text}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-purple-600 text-[10px] font-bold text-white shrink-0">3</span>
                          <p className="text-xs font-semibold text-purple-300">Add it to Kyros</p>
                        </div>
                        <div className="space-y-1.5 pl-7">
                          {[
                            'Copy the API key from AI Studio.',
                            'Paste it into the fields below.',
                            'Click Add Key to enable image generation.',
                          ].map((text, i) => (
                            <div key={i} className="rounded-lg border-l-2 border-purple-600/60 bg-zinc-900/50 px-3 py-2">
                              <span className="text-[10px] font-semibold text-purple-500 mr-1.5">Step {i + 7}</span>
                              <span className="text-xs text-zinc-300">{text}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {geminiKeyForm}
              </div>
            ) : (
              <div className="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(320px,1.05fr)]">
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex items-start gap-3">
                      <span className="text-2xl leading-none mt-0.5">🧠</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-zinc-100 text-sm">Gemini API Key</span>
                          <Badge color="green">Connected</Badge>
                          <Badge color="blue">Tier 1</Badge>
                        </div>
                        <p className="text-xs text-zinc-400 mt-1">Image generation enabled.</p>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowGeminiAddForm((prev) => !prev)}
                    className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Add another key
                    <span className={`inline-block transition-transform duration-200 ${showGeminiAddForm ? 'rotate-90' : ''}`}>▸</span>
                  </button>

                  <div className={`grid transition-all duration-300 ease-out ${showGeminiAddForm ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                    <div className="overflow-hidden">
                      <div className="pt-2">
                        {geminiKeyForm}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Saved Keys</h3>
                    <span className="text-[11px] text-zinc-500">{keyList.length} total</span>
                  </div>
                  {loadingList ? (
                    <div className="flex justify-center py-8"><Spinner /></div>
                  ) : (
                    <div className="space-y-2">
                      {keyList.map((k) => (
                        <div key={k.id} className={`rounded-xl border px-3 py-3 transition ${k.isActive ? 'border-blue-500/50 bg-blue-500/5' : 'border-zinc-700/50 bg-zinc-900/40'}`}>
                          <div className="flex items-center gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium text-sm text-zinc-200">{k.name}</span>
                                {k.isActive && <Badge color="green">Active</Badge>}
                              </div>
                              <div className="text-[11px] font-mono text-zinc-500 mt-0.5">{k.maskedKey}</div>
                            </div>
                            <div className="flex gap-1.5">
                              {!k.isActive && (
                                <Btn variant="secondary" className="!py-1 !px-2.5 !text-xs" onClick={() => handleActivate(k.id)} disabled={loading}>Use</Btn>
                              )}
                              <Btn variant="danger" className="!py-1 !px-2.5 !text-xs" onClick={() => setConfirmAction({ title: `Delete "${k.name}"?`, message: 'This will permanently remove this API key.', onConfirm: () => handleDelete(k.id) })} disabled={loading}>✕</Btn>
                            </div>
                          </div>
                          <div className="mt-2 pt-1.5 border-t border-zinc-700/40 flex items-center gap-3 text-[11px]">
                            <span className={`font-mono font-semibold ${(k.totalSpendUsd || 0) >= (k.spendBudgetUsd || 300) ? 'text-red-400' : 'text-zinc-300'}`}>
                              ${(k.totalSpendUsd || 0).toFixed(2)} / ${(k.spendBudgetUsd || 300).toFixed(0)}
                            </span>
                            <SpendBar spent={k.totalSpendUsd || 0} budget={k.spendBudgetUsd || 300} className="flex-1" />
                            <span className="text-zinc-500">{k.imageCallCount || 0} imgs</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </Card>

          {/* ── 2. Apify ── */}
          <Card className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <KeyHeader infoKey="apify" isConnected={apifyInfo?.hasApifyKey} />
              <div className="shrink-0 hidden sm:flex items-center gap-2">
                <Btn variant="secondary" className="!py-1.5 !px-3 !text-xs" onClick={() => handleCopyLink(QUICK_START_LINKS.apify, 'Apify')}>
                  Copy Apify Link
                </Btn>
                <Badge color="blue">Recommended</Badge>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)]">
              <div className="space-y-4">
                <div className="grid gap-2 sm:grid-cols-3">
                  {[
                    'Open Apify Console.',
                    'Copy your API key from Integrations.',
                    'Paste it into the field below.',
                  ].map((step, index) => (
                    <div key={step} className="rounded-xl border border-zinc-700/40 bg-zinc-950/50 px-3 py-2.5">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-400">Step {index + 1}</div>
                      <div className="mt-1 text-xs text-zinc-300 leading-relaxed">{step}</div>
                    </div>
                  ))}
                </div>

                <div className="rounded-2xl border border-zinc-700/50 bg-zinc-950/50 p-4 space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-zinc-100">Paste your Apify key here</p>
                      <p className="text-xs text-zinc-400 mt-1">Paste it once to unlock clone tools.</p>
                    </div>
                    <Badge color="zinc">Optional</Badge>
                  </div>
                  <Input label="Apify API Key" placeholder="apify_api_..." type="password" value={apifyKey} onChange={(e) => setApifyKey(e.target.value)} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Btn onClick={handleSaveApify} disabled={loading || !apifyKey.trim()}>
                      {loading ? <Spinner size={16} /> : null} Save Apify Key
                    </Btn>
                    <Btn variant="secondary" onClick={() => setConfirmAction({ title: 'Remove Apify key?', message: 'Profile Analyzer and Post Clone will stop working.', onConfirm: handleClearApify, label: 'Remove' })} disabled={loading || !apifyInfo?.hasApifyKey}>
                      Clear
                    </Btn>
                    <a
                      href={QUICK_START_LINKS.apify}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2"
                    >
                      Open Apify Console ↗
                    </a>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-700/50 bg-zinc-950/50 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-zinc-100">Current Apify Status</p>
                  <Badge color={apifyInfo?.hasApifyKey ? 'green' : 'zinc'}>
                    {apifyInfo?.hasApifyKey ? 'Saved' : 'Missing'}
                  </Badge>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Kyros uses this key for Post Clone, Reel Copy, and profile-based scraping tools.
                </p>
                {apifyInfo?.hasApifyKey ? (
                  <div className="rounded-xl border border-emerald-800/30 bg-emerald-950/10 px-3 py-3 space-y-1">
                    <p className="text-xs font-medium text-emerald-300">Stored key</p>
                    <p className="text-[11px] font-mono text-zinc-300">{apifyInfo.maskedKey}</p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-zinc-700/40 bg-zinc-900/40 px-3 py-3 text-xs text-zinc-500">
                    No Apify key saved yet.
                  </div>
                )}
                <div className="rounded-xl border border-zinc-700/40 bg-zinc-900/40 px-3 py-3 space-y-1">
                  <p className="text-xs font-medium text-zinc-300">After this</p>
                  <p className="text-[11px] text-zinc-500">Clone tools will be ready.</p>
                </div>
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-6 xl:sticky xl:top-4 self-start">
          {/* ── Live Health ── */}
          <Card className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Connection Status</h3>
              <Btn variant="secondary" className="!py-1 !px-2.5 !text-xs" onClick={refreshHealth} disabled={loadingHealth}>
                {loadingHealth ? <Spinner size={12} /> : '↻'} Check
              </Btn>
            </div>
            {!health && loadingHealth ? (
              <div className="flex justify-center py-4"><Spinner size={20} /></div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {[
                  { key: 'gemini', label: '🧠 Gemini', data: health?.gemini },
                  { key: 'apify', label: '📸 Apify', data: health?.apify },
                  { key: 'wavespeed', label: '🎬 WaveSpeed', data: health?.wavespeed },
                  { key: 'instagram', label: '🍪 Instagram', data: health?.instagramSession },
                ].map(({ key, label, data }) => (
                  <div key={key} className="rounded-lg border border-zinc-700/50 bg-zinc-900/40 px-3 py-2 space-y-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs text-zinc-300 font-medium">{label}</span>
                      <Badge color={badgeColorForStatus(data?.status)}>{data?.status || '—'}</Badge>
                    </div>
                    <p className="text-[10px] text-zinc-500 leading-tight">{data?.message || 'Not checked yet'}</p>
                    {data?.latencyMs != null && <span className="text-[10px] font-mono text-zinc-600">{data.latencyMs}ms</span>}
                    {data?.status === 'expired' && igLoginInfo?.hasInstagramLogin && (
                      <Btn variant="secondary" className="!py-0.5 !px-2 !text-[10px] mt-1 w-full" onClick={handleAutoRefresh} disabled={refreshing}>
                        {refreshing ? <Spinner size={10} /> : null} Auto Fix
                      </Btn>
                    )}
                  </div>
                ))}
              </div>
            )}
            {health?.checkedAt && (
              <p className="text-[10px] text-zinc-600">Last checked: {new Date(health.checkedAt).toLocaleString()}</p>
            )}
          </Card>

          {/* ── API Spend ── */}
          {spend && (
            <Card className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">💸 API Spending</h3>
                <Btn variant="secondary" className="!py-1 !px-2.5 !text-xs" onClick={() => {
                  if (window.confirm('Reset spend counter to $0? This does not affect your actual Google billing.')) {
                    keysApi.resetSpend().then((data) => { setSpend(data); notify('Spend counter reset', 'success'); }).catch(() => notify('Reset failed', 'error'));
                  }
                }}>Reset</Btn>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-zinc-400">Total Spend</span>
                  <span className={`font-mono font-semibold ${spend.totalSpendUsd >= spend.spendBudgetUsd ? 'text-red-400' : spend.totalSpendUsd >= spend.spendBudgetUsd * 0.8 ? 'text-amber-400' : 'text-green-400'}`}>
                    ${spend.totalSpendUsd.toFixed(4)}
                  </span>
                </div>
                <SpendBar spent={spend.totalSpendUsd} budget={spend.spendBudgetUsd} />
                <div className="flex items-center justify-between text-xs text-zinc-500">
                  <span>${spend.totalSpendUsd.toFixed(2)} / ${spend.spendBudgetUsd.toFixed(0)}</span>
                  <span>${spend.remainingUsd.toFixed(2)} remaining</span>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/30 p-2 text-center">
                    <div className="text-lg font-mono font-semibold text-zinc-200">{spend.imageCallCount}</div>
                    <div className="text-[10px] text-zinc-500 uppercase">Images Generated</div>
                    <div className="text-[10px] text-zinc-600">~$0.13-0.15 each (2K)</div>
                  </div>
                  <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/30 p-2 text-center">
                    <div className="text-lg font-mono font-semibold text-zinc-200">{spend.textCallCount}</div>
                    <div className="text-[10px] text-zinc-500 uppercase">Text API Calls</div>
                    <div className="text-[10px] text-zinc-600">analysis, planning, captions</div>
                  </div>
                </div>
              </div>
              {spend.totalSpendUsd >= spend.spendBudgetUsd && (
                <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-2.5 text-xs text-red-400">
                  Budget limit reached. All API calls are blocked until the counter is reset.
                </div>
              )}
              {Array.isArray(spend.spendLog) && spend.spendLog.length > 0 && (() => {
                const log = spend.spendLog.slice(-30);
                const maxVal = Math.max(...log.map(d => (d.textSpend || 0) + (d.imageSpend || 0)), 0.01);
                const avg = log.reduce((s, d) => s + ((d.textSpend || 0) + (d.imageSpend || 0)), 0) / log.length;
                const barW = Math.max(8, Math.floor(480 / log.length) - 2);
                const chartH = 100;
                const svgW = log.length * (barW + 2);
                return (
                  <div className="space-y-1.5 pt-2 border-t border-zinc-700/40">
                    <h4 className="text-xs font-medium text-zinc-400">Daily spend (last {log.length} days)</h4>
                    <div className="overflow-x-auto">
                      <svg width={svgW} height={chartH + 20} className="block">
                        {log.map((day, i) => {
                          const val = (day.textSpend || 0) + (day.imageSpend || 0);
                          const h = (val / maxVal) * chartH;
                          const x = i * (barW + 2);
                          return (
                            <g key={day.date || i}>
                              <title>{day.date}: ${val.toFixed(4)}</title>
                              <rect x={x} y={chartH - h} width={barW} height={Math.max(h, 1)} rx={2} fill={val > avg ? '#ef4444' : '#22c55e'} opacity={0.8} />
                              {i % Math.max(1, Math.floor(log.length / 6)) === 0 && (
                                <text x={x + barW / 2} y={chartH + 14} textAnchor="middle" className="fill-zinc-600" style={{ fontSize: 8 }}>
                                  {(day.date || '').slice(5)}
                                </text>
                              )}
                            </g>
                          );
                        })}
                        <line x1={0} y1={chartH - (avg / maxVal) * chartH} x2={svgW} y2={chartH - (avg / maxVal) * chartH} stroke="#fbbf24" strokeWidth={1} strokeDasharray="4 2" opacity={0.5} />
                      </svg>
                    </div>
                  </div>
                );
              })()}
            </Card>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Optional and Advanced Connections</h3>
            <p className="text-xs text-zinc-500 mt-1">Most people can skip this section at first.</p>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-3">
          {/* ── 3. WaveSpeed ── */}
          <Card>
            <KeyHeader infoKey="wavespeed" isConnected={wavespeedInfo?.hasWavespeedKey}>
              <div className="space-y-3 pt-1">
                <div className="rounded-xl border border-zinc-700/40 bg-zinc-950/50 p-3 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-zinc-100">Need a WaveSpeed key?</p>
                      <p className="text-xs text-zinc-400 mt-1">Only for extra video models like Kling or Grok video.</p>
                    </div>
                    <Badge color="blue">Optional</Badge>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {[
                      'Open WaveSpeed.ai and sign in.',
                      'Find your API key in the dashboard/account area.',
                      'Copy it and paste it into the field below.',
                    ].map((step, index) => (
                      <div key={step} className="rounded-lg border border-zinc-700/40 bg-zinc-900/40 px-3 py-2.5">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-400">Step {index + 1}</div>
                        <div className="mt-1 text-xs text-zinc-300 leading-relaxed">{step}</div>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-lg border border-zinc-700/40 bg-zinc-900/40 px-3 py-2.5 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Direct Link</span>
                      <Btn variant="secondary" className="!py-1 !px-2.5 !text-[11px]" onClick={() => handleCopyLink('https://wavespeed.ai', 'WaveSpeed')}>
                        Copy Link
                      </Btn>
                    </div>
                    <a href="https://wavespeed.ai" target="_blank" rel="noopener noreferrer" className="block break-all text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2">
                      https://wavespeed.ai
                    </a>
                    <p className="text-[11px] text-zinc-500">Skip this if you only use Gemini / Veo video.</p>
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-700/40 bg-zinc-950/50 p-3 space-y-3">
                  <Input label="WaveSpeed API Key" placeholder="wsa_..." type="password" value={wavespeedKey} onChange={(e) => setWavespeedKey(e.target.value)} />
                  <div className="flex items-center gap-2">
                    <Btn onClick={handleSaveWavespeed} disabled={loading || !wavespeedKey.trim()}>
                      {loading ? <Spinner size={16} /> : null} Save
                    </Btn>
                    <Btn variant="secondary" onClick={() => setConfirmAction({ title: 'Remove WaveSpeed key?', message: 'Video generation will stop working.', onConfirm: handleClearWavespeed, label: 'Remove' })} disabled={loading || !wavespeedInfo?.hasWavespeedKey}>
                      Clear
                    </Btn>
                  </div>
                  {wavespeedInfo?.hasWavespeedKey && (
                    <p className="text-[11px] text-zinc-500 font-mono">Stored: {wavespeedInfo.maskedKey}</p>
                  )}
                </div>
              </div>
            </KeyHeader>
          </Card>

          {/* ── 4. Instagram Session ── */}
          <Card>
            <KeyHeader infoKey="instagram" isConnected={instagramSessionInfo?.hasInstagramSession}>
              <div className="space-y-3 pt-1">
                <div className="rounded-lg border border-zinc-700/40 bg-zinc-900/40 px-3 py-2.5 text-xs text-zinc-400 space-y-1">
                  <p className="font-medium text-zinc-300">How to get your sessionid:</p>
                  <ol className="list-decimal list-inside space-y-0.5 text-zinc-500">
                    <li>Log into Instagram in Chrome/Firefox</li>
                    <li>Press F12 → Application → Cookies → instagram.com</li>
                    <li>Copy the value of <code className="text-zinc-300 font-mono">sessionid</code></li>
                  </ol>
                </div>
                <div className="rounded-xl border border-zinc-700/40 bg-zinc-950/50 p-3 space-y-3">
                  <Input label="sessionid cookie value" placeholder="IGSC..." type="password" value={instagramSessionId} onChange={(e) => setInstagramSessionId(e.target.value)} />
                  <div className="flex items-center gap-2">
                    <Btn onClick={handleSaveInstagramSession} disabled={loading || !instagramSessionId.trim()}>
                      {loading ? <Spinner size={16} /> : null} Save
                    </Btn>
                    <Btn variant="secondary" onClick={() => setConfirmAction({ title: 'Remove Instagram session?', message: 'Age-restricted content access will be disabled.', onConfirm: handleClearInstagramSession, label: 'Remove' })} disabled={loading || !instagramSessionInfo?.hasInstagramSession}>
                      Clear
                    </Btn>
                    <Btn variant="secondary" onClick={handleAutoRefresh} disabled={refreshing || !igLoginInfo?.hasInstagramLogin} title={!igLoginInfo?.hasInstagramLogin ? 'Save burner credentials below first' : ''}>
                      {refreshing ? <Spinner size={16} /> : null} Auto Refresh
                    </Btn>
                  </div>
                  {instagramSessionInfo?.hasInstagramSession && (
                    <p className="text-[11px] text-zinc-500 font-mono">Stored: {instagramSessionInfo.maskedValue}</p>
                  )}
                </div>
              </div>
            </KeyHeader>
          </Card>

          {/* ── 5. Instagram Auto-Login ── */}
          <Card>
            <KeyHeader infoKey="iglogin" isConnected={igLoginInfo?.hasInstagramLogin}>
              <div className="space-y-3 pt-1">
                <div className="rounded-lg border border-amber-800/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-400/80">
                  ⚠️ Use a <strong>throwaway/burner account</strong>, not your real Instagram.
                </div>
                <div className="rounded-xl border border-zinc-700/40 bg-zinc-950/50 p-3 space-y-3">
                  <Input
                    label="Username"
                    placeholder="username (or paste user:pass:2fasecret)"
                    value={igLoginUsername}
                    onChange={(e) => {
                      const val = e.target.value;
                      const parts = val.split(':');
                      if (parts.length >= 3 && !igLoginPassword && !igLogin2faSecret) {
                        setIgLoginUsername(parts[0]);
                        setIgLoginPassword(parts[1]);
                        setIgLogin2faSecret(parts.slice(2).join(':'));
                      } else if (parts.length === 2 && !igLoginPassword) {
                        setIgLoginUsername(parts[0]);
                        setIgLoginPassword(parts[1]);
                      } else {
                        setIgLoginUsername(val);
                      }
                    }}
                  />
                  <Input label="Password" placeholder="••••••••" type="password" value={igLoginPassword} onChange={(e) => setIgLoginPassword(e.target.value)} />
                  <Input label="2FA Secret (optional)" placeholder="TOTP base32 secret e.g. TKUNBPAQ..." type="password" value={igLogin2faSecret} onChange={(e) => setIgLogin2faSecret(e.target.value)} />
                  <div className="flex items-center gap-2">
                    <Btn onClick={handleSaveInstagramLogin} disabled={loading || !igLoginUsername.trim() || !igLoginPassword.trim()}>
                      {loading ? <Spinner size={16} /> : null} Save
                    </Btn>
                    <Btn variant="secondary" onClick={() => setConfirmAction({ title: 'Remove Instagram credentials?', message: 'Auto-refresh for expired sessions will stop working.', onConfirm: handleClearInstagramLogin, label: 'Remove' })} disabled={loading || !igLoginInfo?.hasInstagramLogin}>
                      Clear
                    </Btn>
                  </div>
                  {igLoginInfo?.hasInstagramLogin && (
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[11px] text-zinc-500 font-mono space-y-0.5">
                        <div>Stored: {igLoginInfo.maskedUsername}</div>
                        {igLoginInfo.has2fa && <div>2FA: {igLoginInfo.masked2faSecret}</div>}
                      </div>
                      <Btn variant="secondary" className="!py-1 !px-3 !text-xs shrink-0" onClick={handleAutoRefresh} disabled={refreshing}>
                        {refreshing ? <Spinner size={12} /> : null} {refreshing ? 'Logging in…' : 'Get Session Now'}
                      </Btn>
                    </div>
                  )}
                </div>
              </div>
            </KeyHeader>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => confirmAction?.onConfirm()}
        title={confirmAction?.title || 'Confirm'}
        message={confirmAction?.message || 'Are you sure?'}
        confirmLabel={confirmAction?.label || 'Delete'}
      />
    </div>
  );
}
