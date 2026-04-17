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


// ─── Main component ───────────────────────────────────────────────────────────
export default function ApiKeysPage() {
  const { activeKey, setActiveKey, refreshIntegrationStatus, notify } = useApp();
  const [keyList, setKeyList] = useState([]);
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
  const [vertexJson, setVertexJson] = useState('');
  const [vertexInfo, setVertexInfo] = useState({ hasVertexCredentials: false, projectId: '', clientEmail: '', updatedAt: null });
  const [refreshing, setRefreshing] = useState(false);
  const [health, setHealth] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [spend, setSpend] = useState(null);
  const [showGeminiGuide, setShowGeminiGuide] = useState(false);
  const { loading, run } = useAsync();
  const { loading: loadingList, run: runList } = useAsync();
  const { loading: loadingHealth, run: runHealth } = useAsync();

  const badgeColorForStatus = (status) => {
    if (status === 'ok' || status === 'active') return 'green';
    if (status === 'degraded') return 'yellow';
    if (status === 'missing') return 'zinc';
    return 'red';
  };

  const refreshHealth = ({ silent = false } = {}) => runHealth(async () => {
    const data = await keysApi.healthCheck();
    setHealth(data);
  }, { silent });

  const load = () => runList(async () => {
    const [data, apify, ws, igSession, igLogin, vtx, spendData] = await Promise.all([
      keysApi.list(), keysApi.getApify(), keysApi.getWavespeed(), keysApi.getInstagramSession(), keysApi.getInstagramLogin(), keysApi.getVertex().catch(() => null), keysApi.getSpend().catch(() => null),
    ]);
    if (spendData) setSpend(spendData);
    setKeyList(data);
    setApifyInfo(apify || { hasApifyKey: false, maskedKey: '', updatedAt: null });
    setWavespeedInfo(ws || { hasWavespeedKey: false, maskedKey: '', updatedAt: null });
    setInstagramSessionInfo(igSession || { hasInstagramSession: false, maskedValue: '', updatedAt: null });
    setIgLoginInfo(igLogin || { hasInstagramLogin: false, maskedUsername: '', maskedPassword: '', updatedAt: null });
    setVertexInfo(vtx || { hasVertexCredentials: false, projectId: '', clientEmail: '', updatedAt: null });
    const act = data.find((k) => k.isActive);
    if (act) setActiveKey(act);
    else if (data.length === 0) setActiveKey(null);
    refreshIntegrationStatus();
    await refreshHealth({ silent: true });
  });

  useEffect(() => { load(); }, []);

  const hasGeminiKeys = keyList.length > 0;
  const hasActiveGeminiKey = keyList.some((k) => k.isActive);
  const activeBackend = vertexInfo?.activeBackend || 'gemini';

  const handleAdd = () => run(async () => {
    if (!apiKey.trim()) { notify('Please paste your Gemini API key', 'error'); return; }
    const autoName = keyList.length === 0 ? 'Gemini Key' : `Gemini Key ${keyList.length + 1}`;
    await keysApi.add(autoName, apiKey.trim());
    setApiKey('');
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

  const handleSaveVertex = () => run(async () => {
    if (!vertexJson.trim()) { notify('Paste your service account JSON first', 'error'); return; }
    await keysApi.setVertex(vertexJson.trim());
    setVertexJson('');
    notify('Vertex AI credentials saved — switched to Vertex', 'success');
    await load();
  });

  const handleClearVertex = () => run(async () => {
    await keysApi.clearVertex();
    setVertexJson('');
    notify('Vertex credentials removed', 'success');
    await load();
  });

  const handleSetBackend = (backend) => run(async () => {
    await keysApi.setActiveBackend(backend);
    notify(backend === 'vertex' ? 'Switched to Vertex AI' : 'Switched to Gemini API Key', 'success');
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
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-950/50 p-4 space-y-3">
      <Input label={hasGeminiKeys ? 'Paste a new key to replace the current one' : 'Paste your Gemini API key'} placeholder="AIza..." type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      <Btn onClick={handleAdd} disabled={loading || !apiKey.trim()}>
        {loading ? <Spinner size={16} /> : null} {hasGeminiKeys ? 'Add Key' : 'Save Key'}
      </Btn>
    </div>
  );

  const geminiGuideSections = [
    {
      id: '01',
      stage: 'Stage 1',
      title: 'Get free credit',
      subtitle: 'Start the Google Cloud free trial so billing is enabled and the first $300 is covered.',
      tintClass: 'border-blue-700/40 bg-blue-950/10',
      stageClass: 'text-blue-400',
      stepClass: 'border-blue-500/30 bg-blue-950/10',
      steps: [
        'Go to cloud.google.com, sign in, and click "Get started for free."',
        'Enter a card for identity verification only — you will not be charged.',
        'Google adds $300 of free credit, usually valid for 90 days.',
      ],
    },
    {
      id: '02',
      stage: 'Stage 2',
      title: 'Create Tier 1 key',
      subtitle: 'Make the Gemini key inside a billing-enabled Google Cloud project.',
      tintClass: 'border-cyan-700/40 bg-cyan-950/10',
      stageClass: 'text-cyan-400',
      stepClass: 'border-cyan-500/30 bg-cyan-950/10',
      steps: [
        'Open aistudio.google.com using the same Google account.',
        'Click "Get API key" and create the key in the project with billing enabled.',
        'That new key is Tier 1 and unlocks image generation in Kyros.',
      ],
    },
    {
      id: '03',
      stage: 'Stage 3',
      title: 'Add it to Kyros',
      subtitle: 'Paste the new Gemini key below and save it once.',
      tintClass: 'border-emerald-700/40 bg-emerald-950/10',
      stageClass: 'text-emerald-400',
      stepClass: 'border-emerald-500/30 bg-emerald-950/10',
      steps: [
        'Copy the API key from AI Studio.',
        'Paste it into the Gemini field below and click Save Key.',
      ],
    },
  ];

  return (
    <div className="space-y-6 animate-in max-w-7xl">

<div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_380px]">
        <div className="space-y-6">
          {/* ── 1. Gemini ── */}
          <Card className="space-y-4">
            <div className="space-y-4">
                {/* Header */}
                <div className="flex items-start gap-3">
                  <span className="text-2xl leading-none mt-0.5">🧠</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-zinc-100 text-sm">Gemini API Key</span>
                      <Badge color={hasGeminiKeys ? 'green' : 'red'}>{hasGeminiKeys ? 'Connected' : 'Not set'}</Badge>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700/50">Tier 1 Required</span>
                    </div>
                    <p className="text-xs text-zinc-500 mt-1">Required for image generation. Must be Tier 1 (billing-enabled) — use the $300 Google Cloud free credit so you pay nothing until it runs out.</p>
                  </div>
                </div>

                {/* Warning */}
                <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 px-3 py-2.5 flex gap-2.5">
                  <span className="text-amber-500 shrink-0 text-sm">⚠</span>
                  <p className="text-xs text-amber-300/90 leading-relaxed">The free Gemini tier blocks image generation. You need a billing-enabled key — use the free $300 credit so it costs nothing.</p>
                </div>

                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
                  <div className="space-y-3">
                    {/* Links */}
                    <div className="flex flex-wrap gap-3">
                      <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 rounded-lg border border-blue-600/60 bg-blue-600/20 px-4 py-2.5 text-sm font-semibold text-blue-300 hover:bg-blue-600/30 hover:text-blue-200 transition-colors">
                        🧠 Get Gemini API Key ↗
                      </a>
                      <a href="https://cloud.google.com/free" target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 rounded-lg border border-blue-700/40 bg-blue-900/20 px-4 py-2.5 text-sm font-semibold text-blue-400 hover:bg-blue-900/35 hover:text-blue-300 transition-colors">
                        ☁️ Claim $300 Free Credit ↗
                      </a>
                    </div>

                    {/* Setup guide toggle */}
                    <button type="button" onClick={() => setShowGeminiGuide(v => !v)}
                      className="flex w-full items-center justify-between rounded-lg border border-zinc-700/50 bg-zinc-900/40 px-3 py-2.5 text-left hover:bg-zinc-900/60 transition-colors">
                      <span className="text-xs font-medium text-zinc-300">How to get a Tier 1 key (step by step)</span>
                      <span className="text-zinc-500 text-xs">{showGeminiGuide ? '▲' : '▼'}</span>
                    </button>

                    {showGeminiGuide && (
                      <div className="space-y-3 rounded-xl border border-zinc-700/40 bg-zinc-950/40 p-3.5">
                        {geminiGuideSections.map((section) => (
                          <div
                            key={section.id}
                            className={`rounded-xl border p-3 ${section.tintClass}`}
                          >
                            <div className="space-y-1.5 px-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${section.stageClass}`}>{section.stage}</span>
                                <span className="text-sm font-semibold text-zinc-100">{section.title}</span>
                              </div>
                              <p className="text-xs leading-relaxed text-zinc-400">{section.subtitle}</p>
                            </div>

                            <div className="mt-3 space-y-2">
                              {section.steps.map((text, i) => (
                                <div
                                  key={i}
                                  className={`rounded-lg border-l-2 px-3.5 py-3 ${section.stepClass}`}
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="text-[11px] font-semibold text-zinc-500">Step {i + 1}</span>
                                  </div>
                                  <p className="text-sm leading-relaxed text-zinc-200">{text}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Success state */}
                    {hasGeminiKeys && (
                      <div className="rounded-lg border border-emerald-800/40 bg-emerald-950/20 px-3 py-2.5 flex gap-2.5">
                        <span className="text-emerald-400 shrink-0">✓</span>
                        <p className="text-xs text-emerald-300 leading-relaxed">Key saved. Image generation is unlocked — head to <strong>Generate</strong> to start creating.</p>
                      </div>
                    )}

                    {/* Vertex override notice */}
                    {activeBackend === 'vertex' && (
                      <div className="rounded-lg border border-blue-700/40 bg-blue-950/20 px-3 py-2.5 flex gap-2.5 items-start">
                        <span className="text-blue-400 shrink-0 mt-0.5">☁️</span>
                        <p className="text-xs text-blue-300/90 leading-relaxed">
                          <strong className="text-blue-200">Vertex AI is currently active</strong> — generation is routed through your GCP service account, not this key. Scroll down to the AI Backend section to switch back.
                        </p>
                      </div>
                    )}

                    {/* Input form — always visible so they can paste a replacement */}
                    {geminiKeyForm}
                  </div>

                  {/* Saved keys */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Saved Keys</h3>
                      <span className="text-[11px] text-zinc-600">{keyList.length} total</span>
                    </div>
                    {loadingList ? (
                      <div className="flex justify-center py-6"><Spinner /></div>
                    ) : keyList.length === 0 ? (
                      <div className="rounded-lg border border-zinc-800/50 bg-zinc-900/20 px-3 py-4 text-center">
                        <p className="text-xs text-zinc-600">No keys yet — paste yours below</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {keyList.map((k) => (
                          <div key={k.id} className={`rounded-xl border px-3 py-3 transition ${k.isActive ? 'border-zinc-600/60 bg-zinc-800/30' : 'border-zinc-700/40 bg-zinc-900/30'}`}>
                            <div className="flex items-center gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-medium text-sm text-zinc-200">{k.name}</span>
                                  {k.isActive && <Badge color="green">Active</Badge>}
                                </div>
                                <div className="text-[11px] font-mono text-zinc-600 mt-0.5">{k.maskedKey}</div>
                              </div>
                              <div className="flex gap-1.5">
                                {!k.isActive && (
                                  <Btn variant="secondary" className="!py-1 !px-2.5 !text-xs" onClick={() => handleActivate(k.id)} disabled={loading}>Use</Btn>
                                )}
                                <Btn variant="danger" className="!py-1 !px-2.5 !text-xs" onClick={() => setConfirmAction({ title: 'Delete this key?', message: 'The key will be removed. If it was your only active key, image generation will stop working until you add a new one.', onConfirm: () => handleDelete(k.id) })} disabled={loading}>Delete</Btn>
                              </div>
                            </div>
                            <div className="mt-2 pt-1.5 border-t border-zinc-700/40 flex items-center gap-3 text-[11px]">
                              <span className={`font-mono font-semibold ${(k.totalSpendUsd || 0) >= (k.spendBudgetUsd || 300) ? 'text-red-400' : 'text-zinc-400'}`}>
                                ${(k.totalSpendUsd || 0).toFixed(2)} / ${(k.spendBudgetUsd || 300).toFixed(0)}
                              </span>
                              <SpendBar spent={k.totalSpendUsd || 0} budget={k.spendBudgetUsd || 300} className="flex-1" />
                              <span className="text-zinc-600">{k.imageCallCount || 0} imgs</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
            </div>
          </Card>

          {/* ── 2. AI Backend Switcher ── */}
          <Card id="vertex-section" className="space-y-5">
            {/* Header */}
            <div>
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="font-semibold text-zinc-100 text-sm">AI Backend</span>
                <Badge color={activeBackend === 'vertex' ? 'blue' : 'green'}>
                  {activeBackend === 'vertex' ? 'Vertex AI active' : 'Gemini API active'}
                </Badge>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700/50">Optional</span>
              </div>
              <p className="text-xs text-zinc-500 leading-relaxed">
                Click a card to switch instantly. Both credentials are saved separately — no need to re-paste when switching back.
              </p>
            </div>

            {/* Clickable two-option switcher */}
            <div className="grid grid-cols-2 gap-3">
              {/* Gemini API Key card */}
              <button
                type="button"
                onClick={() => { if (activeBackend !== 'gemini') handleSetBackend('gemini'); }}
                disabled={loading || activeBackend === 'gemini'}
                className={`rounded-xl border-2 p-4 text-left transition-all ${activeBackend === 'gemini' ? 'border-blue-500/60 bg-blue-950/15 cursor-default' : 'border-zinc-700/40 bg-zinc-900/20 hover:border-zinc-600/50 hover:bg-zinc-800/30 cursor-pointer'}`}
              >
                <div className="flex items-start gap-2.5">
                  <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${activeBackend === 'gemini' ? 'border-blue-400 bg-blue-400' : 'border-zinc-600'}`}>
                    {activeBackend === 'gemini' && <div className="w-1.5 h-1.5 rounded-full bg-zinc-950" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-zinc-200">🧠 Gemini API Key</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">AI Studio key · Simple setup</p>
                    {activeBackend === 'gemini'
                      ? <span className="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-900/60 text-blue-300 border border-blue-700/50">Active</span>
                      : <span className="inline-block mt-1.5 text-[10px] text-zinc-500">Click to switch</span>
                    }
                  </div>
                </div>
              </button>
              {/* Vertex AI card */}
              <button
                type="button"
                onClick={() => {
                  if (activeBackend === 'vertex') return;
                  if (vertexInfo?.hasVertexCredentials) { handleSetBackend('vertex'); }
                  else { document.getElementById('vertex-json-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
                }}
                disabled={loading || activeBackend === 'vertex'}
                className={`rounded-xl border-2 p-4 text-left transition-all ${activeBackend === 'vertex' ? 'border-emerald-500/60 bg-emerald-950/15 cursor-default' : 'border-zinc-700/40 bg-zinc-900/20 hover:border-zinc-600/50 hover:bg-zinc-800/30 cursor-pointer'}`}
              >
                <div className="flex items-start gap-2.5">
                  <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${activeBackend === 'vertex' ? 'border-emerald-400 bg-emerald-400' : 'border-zinc-600'}`}>
                    {activeBackend === 'vertex' && <div className="w-1.5 h-1.5 rounded-full bg-zinc-950" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-zinc-200">☁️ Vertex AI (GCP)</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">Google Cloud · Service account JSON</p>
                    {activeBackend === 'vertex'
                      ? <span className="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-900/60 text-emerald-300 border border-emerald-700/50">Active</span>
                      : vertexInfo?.hasVertexCredentials
                        ? <span className="inline-block mt-1.5 text-[10px] text-emerald-500">✓ Saved — click to switch back</span>
                        : <span className="inline-block mt-1.5 text-[10px] text-zinc-500">Paste JSON below to activate</span>
                    }
                  </div>
                </div>
              </button>
            </div>

            {activeBackend === 'vertex' ? (
              /* ── VERTEX ACTIVE ── */
              <div className="space-y-3">
                <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/20 px-4 py-3.5 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-emerald-400">✓</span>
                    <span className="text-sm font-semibold text-emerald-300">Vertex AI is active</span>
                    {vertexInfo?.updatedAt && <span className="text-[10px] text-zinc-600 ml-auto">saved {new Date(vertexInfo.updatedAt).toLocaleDateString()}</span>}
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="rounded-lg border border-emerald-800/30 bg-emerald-950/30 px-3 py-2">
                      <p className="text-[10px] text-zinc-500 mb-0.5">GCP Project</p>
                      <p className="font-mono text-[11px] text-zinc-200 break-all">{vertexInfo?.projectId}</p>
                    </div>
                    <div className="rounded-lg border border-emerald-800/30 bg-emerald-950/30 px-3 py-2">
                      <p className="text-[10px] text-zinc-500 mb-0.5">Service Account</p>
                      <p className="font-mono text-[10px] text-zinc-300 break-all">{vertexInfo?.clientEmail}</p>
                    </div>
                  </div>
                </div>
                <details className="group rounded-xl border border-zinc-700/40 bg-zinc-900/20">
                  <summary className="flex items-center justify-between px-4 py-3 cursor-pointer text-xs font-medium text-zinc-400 hover:text-zinc-300 transition-colors list-none">
                    <span>Update or remove credentials</span>
                    <span className="text-zinc-600 group-open:rotate-180 transition-transform text-[10px]">▼</span>
                  </summary>
                  <div className="px-4 pb-4 pt-2 space-y-3 border-t border-zinc-700/40">
                    <textarea
                      className="w-full rounded-lg border border-zinc-700/60 bg-zinc-900/60 px-3 py-2.5 text-[11px] font-mono text-zinc-300 placeholder-zinc-600 focus:border-blue-500/60 focus:outline-none resize-none"
                      rows={4}
                      placeholder={'{\n  "type": "service_account",\n  "project_id": "...",\n  ...\n}'}
                      value={vertexJson}
                      onChange={(e) => setVertexJson(e.target.value)}
                    />
                    <div className="flex items-center gap-2">
                      <Btn onClick={handleSaveVertex} disabled={loading || !vertexJson.trim()}>
                        {loading ? <Spinner size={16} /> : null} Update JSON
                      </Btn>
                      <Btn variant="danger" className="!py-1.5 !px-3 !text-xs" onClick={() => setConfirmAction({ title: 'Remove Vertex credentials?', message: 'The stored GCP service account JSON will be permanently deleted. You will need to re-paste it to use Vertex again.', onConfirm: handleClearVertex, label: 'Remove' })} disabled={loading}>
                        Remove credentials
                      </Btn>
                    </div>
                  </div>
                </details>
              </div>
            ) : vertexInfo?.hasVertexCredentials ? (
              /* ── GEMINI ACTIVE, VERTEX CREDS SAVED ── */
              <div className="rounded-xl border border-zinc-700/40 bg-zinc-900/20 px-4 py-3.5 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-blue-400">✓</span>
                  <span className="text-xs font-semibold text-zinc-300">Using Gemini API Key</span>
                </div>
                <div className="rounded-lg border border-emerald-800/30 bg-emerald-950/15 px-3 py-2.5 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] text-emerald-400 font-medium">☁️ Vertex credentials are saved</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">Project: <span className="font-mono text-zinc-400">{vertexInfo.projectId}</span></p>
                    <p className="text-[10px] text-zinc-600 mt-0.5">Click the ☁️ Vertex AI card above to switch back — no re-pasting needed.</p>
                  </div>
                  <Btn variant="secondary" className="!py-1.5 !px-3 !text-xs shrink-0" onClick={() => handleSetBackend('vertex')} disabled={loading}>
                    Use Vertex
                  </Btn>
                </div>
              </div>
            ) : (
              /* ── NO VERTEX CREDS — show setup ── */
              <div className="space-y-4" id="vertex-json-form">
                <div className="rounded-lg border border-zinc-700/40 bg-zinc-900/30 px-4 py-3 space-y-2">
                  <p className="text-xs font-semibold text-zinc-300">What is Vertex AI / Why use it?</p>
                  <div className="grid sm:grid-cols-2 gap-2 text-[11px] text-zinc-500 leading-relaxed">
                    <div className="space-y-1">
                      <p className="text-zinc-400 font-medium">Use it if…</p>
                      <p>✓ You already have a Google Cloud (GCP) account</p>
                      <p>✓ You want to use GCP billing / $300 free credit</p>
                      <p>✓ You need higher quotas than AI Studio</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-zinc-400 font-medium">How it works</p>
                      <p>Download a service account JSON from GCP and paste it here. Same Gemini models, no Gemini API key needed.</p>
                    </div>
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-700/40 bg-zinc-900/20 p-4 space-y-3">
                  <p className="text-xs font-semibold text-zinc-300">How to get your service account JSON</p>
                  <div className="space-y-2">
                    {[
                      { n: 1, title: 'Open Google Cloud Console', body: null, link: { href: 'https://console.cloud.google.com', label: 'console.cloud.google.com ↗' }, color: 'blue' },
                      { n: 2, title: 'Enable the Generative Language API', body: 'Search "Generative Language API" → Enable it.', link: null, color: 'blue' },
                      { n: 3, title: 'Go to IAM & Admin → Service Accounts', body: null, link: null, color: 'violet' },
                      { n: 4, title: 'Create a Service Account', body: 'Click "+ Create Service Account", give it a name, assign role "Vertex AI User", click Done.', link: null, color: 'violet' },
                      { n: 5, title: 'Download the JSON key', body: 'Click the account → Keys tab → Add Key → JSON → Create. A .json file downloads.', link: null, color: 'emerald' },
                      { n: 6, title: 'Paste it below', body: 'Open the file in any text editor, select all, copy, paste below.', link: null, color: 'emerald' },
                    ].map(({ n, title, body, link, color }) => {
                      const cm = { blue: 'bg-blue-900/50 border-blue-700/50 text-blue-300', violet: 'bg-violet-900/50 border-violet-700/50 text-violet-300', emerald: 'bg-emerald-900/50 border-emerald-700/50 text-emerald-300' };
                      return (
                        <div key={n} className="flex gap-3 items-start">
                          <div className={`shrink-0 w-6 h-6 rounded-full border flex items-center justify-center ${cm[color]}`}>
                            <span className="text-[11px] font-bold">{n}</span>
                          </div>
                          <div className="flex-1 min-w-0 pt-0.5">
                            <p className="text-[11px] font-semibold text-zinc-300">{title}</p>
                            {body && <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">{body}</p>}
                            {link && <a href={link.href} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-400 underline underline-offset-2 hover:text-blue-300 mt-0.5 inline-block">{link.label}</a>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-700/50 bg-zinc-950/50 p-4 space-y-3">
                  <label className="text-xs font-semibold text-zinc-300">Paste your service account JSON here</label>
                  <textarea
                    className="w-full rounded-lg border border-zinc-700/60 bg-zinc-900/60 px-3 py-2.5 text-[11px] font-mono text-zinc-300 placeholder-zinc-600 focus:border-blue-500/60 focus:outline-none resize-none"
                    rows={6}
                    placeholder={'{\n  "type": "service_account",\n  "project_id": "my-project",\n  ...\n}'}
                    value={vertexJson}
                    onChange={(e) => setVertexJson(e.target.value)}
                  />
                  <Btn onClick={handleSaveVertex} disabled={loading || !vertexJson.trim()}>
                    {loading ? <Spinner size={16} /> : null} Save & Switch to Vertex AI
                  </Btn>
                </div>
              </div>
            )}
          </Card>

          {/* ── 3. Apify ── */}
          <Card className="space-y-4">
            <div className="flex items-start gap-3">
              <span className="text-2xl leading-none mt-0.5">📸</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-zinc-100 text-sm">Apify Key</span>
                  <Badge color={apifyInfo?.hasApifyKey ? 'green' : 'zinc'}>{apifyInfo?.hasApifyKey ? 'Connected' : 'Not set'}</Badge>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700/50">Optional</span>
                </div>
                <p className="text-xs text-zinc-500 mt-1">Only needed for Post Clone, Profile Analyzer, and Reel Copy — tools that scrape Instagram. If you just want to generate images, skip this.</p>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <a href="https://console.apify.com/account/integrations" target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-700/50 bg-zinc-900/60 px-3 py-1.5 text-[11px] text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors">
                    Apify Console — get key ↗
                  </a>
                </div>
                <p className="text-[11px] text-zinc-600 leading-relaxed">Go to Apify Console → Account → Integrations → copy your API token. Free plan includes ~$5 of credits per month which is plenty for most users.</p>
                <div className="rounded-xl border border-zinc-700/50 bg-zinc-950/50 p-4 space-y-3">
                  <Input label="Paste your Apify API key" placeholder="apify_api_..." type="password" value={apifyKey} onChange={(e) => setApifyKey(e.target.value)} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Btn onClick={handleSaveApify} disabled={loading || !apifyKey.trim()}>
                      {loading ? <Spinner size={16} /> : null} Save Key
                    </Btn>
                    {apifyInfo?.hasApifyKey && (
                      <Btn variant="secondary" onClick={() => setConfirmAction({ title: 'Remove Apify key?', message: 'Post Clone, Profile Analyzer and Reel Copy will stop working.', onConfirm: handleClearApify, label: 'Remove' })} disabled={loading}>
                        Remove
                      </Btn>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-zinc-700/40 bg-zinc-900/30 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-zinc-300">Status</p>
                  <Badge color={apifyInfo?.hasApifyKey ? 'green' : 'zinc'}>{apifyInfo?.hasApifyKey ? 'Saved' : 'Not set'}</Badge>
                </div>
                {apifyInfo?.hasApifyKey ? (
                  <>
                    <div className="rounded-lg border border-zinc-700/40 bg-zinc-950/50 px-3 py-2.5">
                      <p className="text-[10px] text-zinc-500 mb-1">Stored key</p>
                      <p className="text-[11px] font-mono text-zinc-300">{apifyInfo.maskedKey}</p>
                    </div>
                    <p className="text-[11px] text-zinc-500 leading-relaxed">Post Clone, Profile Analyzer, and Reel Copy are unlocked and ready to use.</p>
                  </>
                ) : (
                  <>
                    <p className="text-[11px] text-zinc-600 leading-relaxed">Without this key, scrape-based tools will show an error. Everything else in the app works fine without it.</p>
                    <div className="rounded-lg border border-zinc-800/50 bg-zinc-950/30 px-3 py-2.5 space-y-1">
                      <p className="text-[10px] font-semibold text-zinc-500">Tools that need Apify</p>
                      <p className="text-[11px] text-zinc-600">Post Clone · Profile Analyzer · Reel Copy</p>
                    </div>
                  </>
                )}
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-6 xl:sticky xl:top-4 self-start">
          {/* ── Live Health ── */}
          <Card className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Connection Status</h3>
                <p className="text-[10px] text-zinc-600 mt-0.5">"ok" means the key works and the API responded</p>
              </div>
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
                  { key: 'vertex', label: '☁️ Vertex AI', data: health?.vertex },
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
                <div>
                  <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">💸 API Spending</h3>
                  <p className="text-[10px] text-zinc-600 mt-0.5">Local estimate only — check Google Cloud for actual charges</p>
                </div>
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
