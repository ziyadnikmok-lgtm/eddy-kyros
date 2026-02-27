import { useState, useEffect } from 'react';
import { keys as keysApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { Card, Btn, Input, Badge, Spinner, Empty, ConfirmDialog } from '../components/UI';

export default function ApiKeysPage() {
  const { activeKey, setActiveKey, notify } = useApp();
  const [keyList, setKeyList] = useState([]);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apifyKey, setApifyKey] = useState('');
  const [apifyInfo, setApifyInfo] = useState({ hasApifyKey: false, maskedKey: '', updatedAt: null });
  const [instagramSessionId, setInstagramSessionId] = useState('');
  const [instagramSessionInfo, setInstagramSessionInfo] = useState({ hasInstagramSession: false, maskedValue: '', updatedAt: null });
  const [igLoginUsername, setIgLoginUsername] = useState('');
  const [igLoginPassword, setIgLoginPassword] = useState('');
  const [igLogin2faSecret, setIgLogin2faSecret] = useState('');
  const [igLoginInfo, setIgLoginInfo] = useState({ hasInstagramLogin: false, maskedUsername: '', maskedPassword: '', has2fa: false, masked2faSecret: '', updatedAt: null });
  const [refreshing, setRefreshing] = useState(false);
  const [health, setHealth] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
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
    const [data, apify, igSession, igLogin] = await Promise.all([
      keysApi.list(), keysApi.getApify(), keysApi.getInstagramSession(), keysApi.getInstagramLogin(),
    ]);
    setKeyList(data);
    setApifyInfo(apify || { hasApifyKey: false, maskedKey: '', updatedAt: null });
    setInstagramSessionInfo(igSession || { hasInstagramSession: false, maskedValue: '', updatedAt: null });
    setIgLoginInfo(igLogin || { hasInstagramLogin: false, maskedUsername: '', maskedPassword: '', updatedAt: null });
    const act = data.find((k) => k.isActive);
    if (act) setActiveKey(act);
    else if (data.length === 0) setActiveKey(null);
    await refreshHealth();
  });

  useEffect(() => { load(); }, []);

  const handleAdd = () => run(async () => {
    if (!name.trim() || !apiKey.trim()) { notify('Name and key are required', 'error'); return; }
    await keysApi.add(name.trim(), apiKey.trim());
    setName(''); setApiKey('');
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
    if (!apifyKey.trim()) {
      notify('Apify key is required', 'error');
      return;
    }
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

  const handleSaveInstagramSession = () => run(async () => {
    if (!instagramSessionId.trim()) {
      notify('Instagram sessionid is required', 'error');
      return;
    }
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
    if (!igLoginUsername.trim() || !igLoginPassword.trim()) {
      notify('Username and password are required', 'error');
      return;
    }
    await keysApi.setInstagramLogin(igLoginUsername.trim(), igLoginPassword.trim(), igLogin2faSecret.trim() || null);
    setIgLoginUsername('');
    setIgLoginPassword('');
    setIgLogin2faSecret('');
    notify('Instagram credentials saved', 'success');
    await load();
  });

  const handleClearInstagramLogin = () => run(async () => {
    await keysApi.clearInstagramLogin();
    setIgLoginUsername('');
    setIgLoginPassword('');
    setIgLogin2faSecret('');
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

  return (
    <div className="space-y-6 animate-in">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gradient">API Keys</h1>
        <p className="text-zinc-500 text-sm mt-1">Manage Gemini and Apify API keys. Keys are encrypted at rest.</p>
      </div>

      <Card className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Live Health Check</h3>
          <Btn variant="secondary" className="!py-1.5 !px-3 !text-xs" onClick={refreshHealth} disabled={loadingHealth}>
            {loadingHealth ? <Spinner size={14} /> : null} Refresh
          </Btn>
        </div>

        {!health && loadingHealth ? (
          <div className="flex justify-center py-4"><Spinner size={20} /></div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/30 p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-200">Gemini</span>
                <Badge color={badgeColorForStatus(health?.gemini?.status)}>{health?.gemini?.status || 'unknown'}</Badge>
              </div>
              <div className="text-xs text-zinc-400">{health?.gemini?.message || 'No data yet'}</div>
              {health?.gemini?.latencyMs != null && <div className="text-[11px] text-zinc-500 font-mono">{health.gemini.latencyMs}ms</div>}
            </div>

            <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/30 p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-200">Apify</span>
                <Badge color={badgeColorForStatus(health?.apify?.status)}>{health?.apify?.status || 'unknown'}</Badge>
              </div>
              <div className="text-xs text-zinc-400">{health?.apify?.message || 'No data yet'}</div>
              {health?.apify?.latencyMs != null && <div className="text-[11px] text-zinc-500 font-mono">{health.apify.latencyMs}ms</div>}
            </div>

            <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/30 p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-200">Instagram Session</span>
                <Badge color={badgeColorForStatus(health?.instagramSession?.status)}>{health?.instagramSession?.status || 'unknown'}</Badge>
              </div>
              <div className="text-xs text-zinc-400">{health?.instagramSession?.message || 'No data yet'}</div>
              {health?.instagramSession?.maskedValue && (
                <div className="text-[11px] text-zinc-500 font-mono">{health.instagramSession.maskedValue}</div>
              )}
              {health?.instagramSession?.status === 'expired' && igLoginInfo?.hasInstagramLogin && (
                <Btn variant="secondary" className="!py-1 !px-2 !text-[11px] mt-1" onClick={handleAutoRefresh} disabled={refreshing}>
                  {refreshing ? <Spinner size={12} /> : null} Auto Fix
                </Btn>
              )}
            </div>
          </div>
        )}

        {health?.checkedAt && (
          <div className="text-[11px] text-zinc-500">
            Last check: {new Date(health.checkedAt).toLocaleString()}
          </div>
        )}
      </Card>

      <Card className="space-y-4">
        <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Add New Key</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="Key Name" placeholder="e.g. Production Key" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="API Key" placeholder="AIza..." type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </div>
        <Btn onClick={handleAdd} disabled={loading || !name.trim() || !apiKey.trim()}>
          {loading ? <Spinner size={16} /> : null} Add Key
        </Btn>
      </Card>

      <Card className="space-y-4">
        <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Apify Key</h3>
        <Input
          label="Apify API Key"
          placeholder="apify_api_..."
          type="password"
          value={apifyKey}
          onChange={(e) => setApifyKey(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Btn onClick={handleSaveApify} disabled={loading || !apifyKey.trim()}>
            {loading ? <Spinner size={16} /> : null} Save Apify Key
          </Btn>
          <Btn variant="secondary" onClick={() => setConfirmAction({ title: 'Remove Apify key?', message: 'Profile Analyzer and Post Clone features will stop working without an Apify key.', onConfirm: handleClearApify, label: 'Remove' })} disabled={loading || !apifyInfo?.hasApifyKey}>
            Clear
          </Btn>
        </div>
        {apifyInfo?.hasApifyKey ? (
          <div className="text-xs text-zinc-400">
            <span className="font-medium text-zinc-300">Stored:</span> <span className="font-mono">{apifyInfo.maskedKey}</span>
          </div>
        ) : (
          <div className="text-xs text-zinc-500">No Apify key stored</div>
        )}
      </Card>

      <Card className="space-y-4">
        <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Instagram Session (Optional)</h3>
        <Input
          label="sessionid"
          placeholder="IGSC..."
          type="password"
          value={instagramSessionId}
          onChange={(e) => setInstagramSessionId(e.target.value)}
        />
        <p className="text-xs text-zinc-500">Used for age-restricted profile/post access via Apify loginCookies.</p>
        <div className="flex items-center gap-2">
          <Btn onClick={handleSaveInstagramSession} disabled={loading || !instagramSessionId.trim()}>
            {loading ? <Spinner size={16} /> : null} Save Session
          </Btn>
          <Btn variant="secondary" onClick={() => setConfirmAction({ title: 'Remove Instagram session?', message: 'Age-restricted content access will be disabled until a new session is set.', onConfirm: handleClearInstagramSession, label: 'Remove' })} disabled={loading || !instagramSessionInfo?.hasInstagramSession}>
            Clear
          </Btn>
          <Btn variant="secondary" onClick={handleAutoRefresh} disabled={refreshing || !igLoginInfo?.hasInstagramLogin} title={!igLoginInfo?.hasInstagramLogin ? 'Save burner credentials below first' : ''}>
            {refreshing ? <Spinner size={16} /> : null} Auto Refresh
          </Btn>
        </div>
        {instagramSessionInfo?.hasInstagramSession ? (
          <div className="text-xs text-zinc-400">
            <span className="font-medium text-zinc-300">Stored:</span> <span className="font-mono">{instagramSessionInfo.maskedValue}</span>
          </div>
        ) : (
          <div className="text-xs text-zinc-500">No Instagram session stored</div>
        )}
      </Card>

      <Card className="space-y-4">
        <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Instagram Auto-Login</h3>
        <Input
          label="Username"
          placeholder="user:pass:2fasecret or just username"
          value={igLoginUsername}
          onChange={(e) => {
            const val = e.target.value;
            // Smart paste: auto-split user:pass:2fa format
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
        <Input
          label="Password"
          placeholder="••••••••"
          type="password"
          value={igLoginPassword}
          onChange={(e) => setIgLoginPassword(e.target.value)}
        />
        <Input
          label="2FA Secret (optional)"
          placeholder="TOTP base32 secret e.g. TKUNBPAQ..."
          type="password"
          value={igLogin2faSecret}
          onChange={(e) => setIgLogin2faSecret(e.target.value)}
        />
        <p className="text-xs text-zinc-500">Burner account credentials for auto-refreshing expired sessions. Paste <span className="font-mono text-zinc-400">user:pass:2fasecret</span> into username to auto-fill all fields.</p>
        <div className="flex items-center gap-2">
          <Btn onClick={handleSaveInstagramLogin} disabled={loading || !igLoginUsername.trim() || !igLoginPassword.trim()}>
            {loading ? <Spinner size={16} /> : null} Save Credentials
          </Btn>
          <Btn variant="secondary" onClick={() => setConfirmAction({ title: 'Remove Instagram credentials?', message: 'Auto-refresh for expired sessions will stop working.', onConfirm: handleClearInstagramLogin, label: 'Remove' })} disabled={loading || !igLoginInfo?.hasInstagramLogin}>
            Clear
          </Btn>
        </div>
        {igLoginInfo?.hasInstagramLogin ? (
          <div className="flex items-start justify-between gap-3">
            <div className="text-xs text-zinc-400 space-y-0.5">
              <div><span className="font-medium text-zinc-300">Stored:</span> <span className="font-mono">{igLoginInfo.maskedUsername}</span></div>
              {igLoginInfo.has2fa && <div><span className="font-medium text-zinc-300">2FA:</span> <span className="font-mono">{igLoginInfo.masked2faSecret}</span></div>}
            </div>
            <Btn variant="secondary" className="!py-1 !px-3 !text-xs shrink-0" onClick={handleAutoRefresh} disabled={refreshing}>
              {refreshing ? <Spinner size={12} /> : null} {refreshing ? 'Logging in...' : 'Get Session'}
            </Btn>
          </div>
        ) : (
          <div className="text-xs text-zinc-500">No Instagram credentials stored</div>
        )}
      </Card>

      <Card>
        <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider mb-4">Stored Keys</h3>
        {loadingList ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : keyList.length === 0 ? (
          <Empty icon="🔑" title="No API keys yet" subtitle="Add one above to get started" />
        ) : (
          <div className="space-y-2">
            {keyList.map((k) => (
              <div key={k.id} className={`flex items-center gap-3 rounded-lg border px-4 py-3 transition ${k.isActive ? 'border-blue-500/50 bg-blue-500/5' : 'border-zinc-700/50 bg-zinc-800/40'}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-zinc-200">{k.name}</span>
                    {k.isActive && <Badge color="green">Active</Badge>}
                  </div>
                  <div className="text-xs font-mono text-zinc-500 mt-0.5">{k.maskedKey}</div>
                </div>
                <div className="flex gap-2">
                  {!k.isActive && (
                    <Btn variant="secondary" className="!py-1.5 !px-3 !text-xs" onClick={() => handleActivate(k.id)} disabled={loading}>
                      Activate
                    </Btn>
                  )}
                  <Btn variant="danger" className="!py-1.5 !px-3 !text-xs" onClick={() => setConfirmAction({ title: `Delete "${k.name}"?`, message: 'This will permanently remove this API key.', onConfirm: () => handleDelete(k.id) })} disabled={loading}>
                    Delete
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

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
