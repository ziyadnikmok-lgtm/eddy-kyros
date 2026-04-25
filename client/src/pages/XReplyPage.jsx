import { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { xReply as xReplyApi } from '../services/api';
import { Card, Btn, Input, Select, Spinner, Empty } from '../components/UI';

const TONE_OPTIONS = [
  { value: 'engaging and friendly', label: 'Engaging & Friendly' },
  { value: 'funny and witty', label: 'Funny & Witty' },
  { value: 'professional and insightful', label: 'Professional & Insightful' },
  { value: 'casual and relatable', label: 'Casual & Relatable' },
  { value: 'enthusiastic and hype', label: 'Enthusiastic & Hype' },
  { value: 'thoughtful and deep', label: 'Thoughtful & Deep' },
];

const IDLE_STATE = {
  status: 'idle',
  repliesCount: 0,
  maxReplies: 15,
  elapsedMs: 0,
  maxMs: 3600000,
  log: [],
  startedAt: null,
  stoppedAt: null,
};

function parseCookies(raw) {
  raw = raw.trim();
  // Try JSON array format (from Cookie Editor extension)
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0 && arr[0].name) return { ok: true, cookies: arr };
    } catch {}
  }
  // Try JSON object format (single cookie)
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      if (obj.name) return { ok: true, cookies: [obj] };
    } catch {}
  }
  // Try Netscape format (name\tvalue per line, or "name=value; name=value")
  if (raw.includes('=')) {
    const cookies = raw.split(/;|\n/).map((s) => s.trim()).filter(Boolean).map((s) => {
      const eq = s.indexOf('=');
      if (eq === -1) return null;
      return { name: s.slice(0, eq).trim(), value: s.slice(eq + 1).trim(), domain: '.x.com' };
    }).filter(Boolean);
    if (cookies.length > 0) return { ok: true, cookies };
  }
  return { ok: false, error: 'Could not parse cookies. Paste JSON from Cookie Editor or name=value pairs.' };
}

function formatElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return `${min}m ${s.toString().padStart(2, '0')}s`;
}

function LogEntry({ entry }) {
  const color =
    entry.level === 'error' ? 'text-red-400' :
    entry.level === 'warn' ? 'text-yellow-400' :
    entry.message.startsWith('✓') ? 'text-green-400' :
    'text-zinc-400';

  const time = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className={`flex gap-2 text-[11px] font-mono ${color}`}>
      <span className="text-zinc-600 shrink-0">{time}</span>
      <span className="break-all">{entry.message}</span>
    </div>
  );
}

export default function XReplyPage() {
  const { notify } = useApp();

  // Setup state
  const [cookieRaw, setCookieRaw] = useState('');
  const [cookieParsed, setCookieParsed] = useState(null);
  const [cookieError, setCookieError] = useState('');
  const [accounts, setAccounts] = useState(['']);
  const [imageFolder, setImageFolder] = useState('');
  const [tone, setTone] = useState('engaging and friendly');
  const [attachImageChance, setAttachImageChance] = useState(50);

  // Session state
  const [session, setSession] = useState(IDLE_STATE);
  const pollRef = useRef(null);
  const logEndRef = useRef(null);

  // Poll status while running
  const pollStatus = useCallback(async () => {
    try {
      const data = await xReplyApi.status();
      setSession(data);
      if (data.status !== 'running') {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {}
  }, []);

  useEffect(() => {
    // Load current status on mount
    xReplyApi.status().then(setSession).catch(() => {});
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.log]);

  const handleCookiePaste = (val) => {
    setCookieRaw(val);
    if (!val.trim()) {
      setCookieParsed(null);
      setCookieError('');
      return;
    }
    const result = parseCookies(val);
    if (result.ok) {
      setCookieParsed(result.cookies);
      setCookieError('');
    } else {
      setCookieParsed(null);
      setCookieError(result.error);
    }
  };

  const addAccount = () => setAccounts((prev) => [...prev, '']);
  const removeAccount = (i) => setAccounts((prev) => prev.filter((_, idx) => idx !== i));
  const updateAccount = (i, val) => setAccounts((prev) => prev.map((a, idx) => idx === i ? val : a));

  const handleStart = async () => {
    if (!cookieParsed) {
      notify('Paste your X cookies first', 'error');
      return;
    }
    const cleanAccounts = accounts.map((a) => a.replace(/^@/, '').trim()).filter(Boolean);
    if (cleanAccounts.length === 0) {
      notify('Add at least one target account', 'error');
      return;
    }

    try {
      await xReplyApi.start({
        cookies: cookieParsed,
        accounts: cleanAccounts,
        imageFolder: imageFolder.trim() || null,
        tone,
        attachImageChance: attachImageChance / 100,
      });
      notify('Session started!', 'success');
      setSession({ ...IDLE_STATE, status: 'running', startedAt: Date.now(), log: [] });
      pollRef.current = setInterval(pollStatus, 2000);
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const handleStop = async () => {
    try {
      await xReplyApi.stop();
      notify('Stopping session...', 'info');
      if (!pollRef.current) {
        pollRef.current = setInterval(pollStatus, 2000);
      }
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const isRunning = session.status === 'running';
  const isDone = session.status === 'done' || session.status === 'stopped' || session.status === 'error';
  const hasSession = isRunning || isDone;

  const timeProgress = session.startedAt
    ? Math.min(100, (session.elapsedMs / session.maxMs) * 100)
    : 0;
  const replyProgress = Math.min(100, (session.repliesCount / session.maxReplies) * 100);

  return (
    <div className="space-y-5 animate-in">

      {/* Cookie Setup */}
      <Card>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-200">X Account Cookies</h3>
            <span className="text-[10px] text-zinc-500">
              Export from browser using "Cookie Editor" extension → Copy all as JSON
            </span>
          </div>
          <textarea
            className="w-full h-28 rounded-lg bg-zinc-800/70 border border-zinc-700/50 px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-600 resize-none focus:outline-none focus:border-zinc-500 transition-colors"
            placeholder={'Paste cookies here — JSON array from Cookie Editor:\n[{"name":"auth_token","value":"...","domain":".x.com",...}, ...]\n\nOr name=value pairs: auth_token=abc123; ct0=xyz456'}
            value={cookieRaw}
            onChange={(e) => handleCookiePaste(e.target.value)}
            spellCheck={false}
          />
          {cookieError && (
            <p className="text-[11px] text-red-400">{cookieError}</p>
          )}
          {cookieParsed && (
            <p className="text-[11px] text-green-400">
              ✓ {cookieParsed.length} cookie(s) parsed —{' '}
              {cookieParsed.find((c) => c.name === 'auth_token') ? 'auth_token found ✓' : 'auth_token not found (may still work)'}
            </p>
          )}
          <div className="text-[10px] text-zinc-600 space-y-0.5">
            <p>1. Install "Cookie Editor" browser extension</p>
            <p>2. Go to x.com while logged in</p>
            <p>3. Open Cookie Editor → click Export → Copy All</p>
            <p>4. Paste above</p>
          </div>
        </div>
      </Card>

      {/* Target Accounts */}
      <Card>
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-zinc-200">Target Accounts</h3>
          <p className="text-[11px] text-zinc-500">The bot will visit these accounts and reply to their recent posts</p>
          <div className="space-y-2">
            {accounts.map((acc, i) => (
              <div key={i} className="flex gap-2 items-center">
                <span className="text-zinc-500 text-sm">@</span>
                <Input
                  placeholder="username"
                  value={acc}
                  onChange={(e) => updateAccount(i, e.target.value)}
                  className="flex-1"
                />
                {accounts.length > 1 && (
                  <button
                    onClick={() => removeAccount(i)}
                    className="p-1.5 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-500/10 cursor-pointer transition-colors"
                    title="Remove"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M2 2l10 10M12 2L2 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
          <Btn variant="ghost" onClick={addAccount} className="text-xs">+ Add Account</Btn>
        </div>
      </Card>

      {/* Reply Settings */}
      <Card>
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-zinc-200">Reply Settings</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label="Reply Tone"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              options={TONE_OPTIONS}
            />
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">Image Attachment Chance</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={10}
                  value={attachImageChance}
                  onChange={(e) => setAttachImageChance(Number(e.target.value))}
                  className="flex-1 accent-blue-500"
                />
                <span className="text-sm text-zinc-300 w-10 text-right">{attachImageChance}%</span>
              </div>
              <p className="text-[10px] text-zinc-600">
                {attachImageChance === 0 ? 'Never attach images' :
                 attachImageChance === 100 ? 'Always attach an image' :
                 `${attachImageChance}% of replies will include an image`}
              </p>
            </div>
          </div>

          {attachImageChance > 0 && (
            <div className="space-y-1.5">
              <Input
                label="Image Folder Path"
                placeholder="/Users/you/Pictures/reply-images"
                value={imageFolder}
                onChange={(e) => setImageFolder(e.target.value)}
              />
              <p className="text-[10px] text-zinc-600">
                Local folder containing JPG/PNG images to randomly attach to replies. Leave empty to skip images.
              </p>
            </div>
          )}
        </div>
      </Card>

      {/* Session Limits Info */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-zinc-800/40 border border-zinc-700/30 p-3 text-center">
          <p className="text-lg font-bold text-zinc-200">15</p>
          <p className="text-[10px] text-zinc-500">Max replies per session</p>
        </div>
        <div className="rounded-xl bg-zinc-800/40 border border-zinc-700/30 p-3 text-center">
          <p className="text-lg font-bold text-zinc-200">1 hr</p>
          <p className="text-[10px] text-zinc-500">Max session duration</p>
        </div>
      </div>

      {/* Start / Stop */}
      <div className="flex gap-3">
        {!isRunning ? (
          <Btn
            variant="primary"
            onClick={handleStart}
            disabled={!cookieParsed || isRunning}
            className="flex-1"
          >
            {session.status === 'done' ? 'Start New Session' :
             session.status === 'stopped' ? 'Restart Session' :
             session.status === 'error' ? 'Retry Session' :
             'Start Reply Session'}
          </Btn>
        ) : (
          <Btn variant="danger" onClick={handleStop} className="flex-1">
            Stop Session
          </Btn>
        )}
      </div>

      {/* Live Session Panel */}
      {hasSession && (
        <Card>
          <div className="space-y-4">
            {/* Status header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {isRunning && <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />}
                <span className={`text-sm font-semibold ${
                  session.status === 'done' ? 'text-green-400' :
                  session.status === 'error' ? 'text-red-400' :
                  session.status === 'stopped' ? 'text-yellow-400' :
                  'text-zinc-200'
                }`}>
                  {session.status === 'running' ? 'Session Running' :
                   session.status === 'done' ? 'Session Complete' :
                   session.status === 'stopped' ? 'Session Stopped' :
                   session.status === 'error' ? 'Session Error' : 'Session'}
                </span>
              </div>
              {session.startedAt && (
                <span className="text-[11px] text-zinc-500 font-mono">
                  {formatElapsed(session.elapsedMs)} / 60m
                </span>
              )}
            </div>

            {/* Progress bars */}
            <div className="space-y-2">
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] text-zinc-500">
                  <span>Replies</span>
                  <span>{session.repliesCount} / {session.maxReplies}</span>
                </div>
                <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all duration-500"
                    style={{ width: `${replyProgress}%` }}
                  />
                </div>
              </div>
              {session.startedAt && (
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] text-zinc-500">
                    <span>Time</span>
                    <span>{formatElapsed(session.elapsedMs)} / 60m</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-zinc-600 transition-all duration-500"
                      style={{ width: `${timeProgress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Activity Log */}
            <div>
              <p className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-2">Activity Log</p>
              <div className="h-52 overflow-y-auto rounded-lg bg-zinc-900/60 border border-zinc-800/60 p-3 space-y-1">
                {session.log.length === 0 && (
                  <p className="text-[11px] text-zinc-600 italic">Waiting for activity...</p>
                )}
                {session.log.map((entry, i) => (
                  <LogEntry key={i} entry={entry} />
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          </div>
        </Card>
      )}

      {!hasSession && (
        <Empty
          icon="𝕏"
          title="X Auto-Reply Bot"
          subtitle="Configure your cookies and target accounts, then start a session to auto-reply to posts"
        />
      )}
    </div>
  );
}
