import { useState, useEffect, useCallback } from 'react';
import { Card, Btn, Spinner, Badge, Empty, Toggle } from '../components/UI';
import { useApp } from '../context/AppContext';

const LEVEL_STYLES = {
  error: 'text-red-300',
  warn: 'text-amber-300',
  info: 'text-rose-300',
};

const LEVEL_BADGES = {
  error: 'red',
  warn: 'yellow',
  info: 'blue',
};

export default function LogsPage() {
  const { notify } = useApp();
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedErrors, setCopiedErrors] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const errorLines = lines.filter((line) => ['error', 'warn'].includes(String(line.level || '').toLowerCase()));

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/logs?n=200', { credentials: 'include' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || `Failed to load logs (${res.status})`);
      }
      setLines(Array.isArray(data?.lines) ? data.lines : []);
      setLastUpdatedAt(new Date());
    } catch (err) {
      setError(err.message || 'Failed to load logs');
      setLines([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    fetchLogs();
    const id = setInterval(fetchLogs, 5000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchLogs]);

  const handleCopy = async () => {
    if (!lines.length) {
      notify('No logs to copy yet', 'info');
      return;
    }
    const text = lines
      .map((line) => `[${line.ts}] [${String(line.level || 'info').toUpperCase()}] ${line.text || ''}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      notify('Logs copied to clipboard', 'success');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      notify('Failed to copy logs', 'error');
    }
  };

  const handleCopyErrors = async () => {
    if (!errorLines.length) {
      notify('No warnings or errors to copy yet', 'info');
      return;
    }
    const text = errorLines
      .map((line) => `[${line.ts}] [${String(line.level || 'info').toUpperCase()}] ${line.text || ''}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedErrors(true);
      notify('Warnings and errors copied to clipboard', 'success');
      window.setTimeout(() => setCopiedErrors(false), 2000);
    } catch {
      notify('Failed to copy warnings and errors', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-zinc-100">Session Logs</h3>
              <Badge color="zinc">{lines.length} lines</Badge>
              <Badge color={errorLines.length ? 'yellow' : 'zinc'}>{errorLines.length} issues</Badge>
              {autoRefresh && <Badge color="blue">Live</Badge>}
            </div>
            <p className="text-sm text-zinc-500">
              Recent server-side app logs scoped to the currently signed-in user. Copy these for support when something breaks.
            </p>
            <p className="text-xs text-zinc-600">
              {lastUpdatedAt ? `Last updated ${lastUpdatedAt.toLocaleTimeString()}` : 'Not loaded yet'}
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Toggle checked={autoRefresh} onChange={setAutoRefresh} label="Auto-refresh" />
            <div className="flex gap-2">
              <Btn variant="secondary" onClick={fetchLogs} disabled={loading}>
                {loading ? <><Spinner size={14} /> Refreshing...</> : 'Refresh'}
              </Btn>
              <Btn variant="secondary" onClick={handleCopyErrors}>
                {copiedErrors ? 'Copied Issues!' : 'Copy Errors'}
              </Btn>
              <Btn onClick={handleCopy}>
                {copied ? 'Copied!' : 'Copy All'}
              </Btn>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800/70 bg-zinc-950/80 overflow-hidden">
          {loading && !lines.length ? (
            <div className="flex items-center justify-center py-20">
              <Spinner size={28} />
            </div>
          ) : error ? (
            <div className="p-6">
              <Empty
                title="Could not load logs"
                subtitle={error}
              />
            </div>
          ) : !lines.length ? (
            <div className="p-6">
              <Empty
                title="No user-scoped logs yet"
                subtitle={autoRefresh
                  ? 'Live refresh is on. Use the app and new logs for this account will appear here.'
                  : 'Use the app, then refresh to load new logs for this account.'}
              />
            </div>
          ) : (
            <div className="max-h-[70vh] overflow-auto">
              <div className="min-w-[760px]">
                <div className="grid grid-cols-[170px_90px_1fr] gap-3 border-b border-zinc-800/70 bg-zinc-900/70 px-4 py-3 text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                  <div>Timestamp</div>
                  <div>Level</div>
                  <div>Message</div>
                </div>
                {[...lines].reverse().map((line, index) => (
                  <div
                    key={`${line.ts}-${index}`}
                    className={`grid grid-cols-[170px_90px_1fr] gap-3 border-b px-4 py-3 text-sm last:border-b-0 ${
                      line.level === 'error'
                        ? 'border-red-500/10 bg-red-500/8'
                        : line.level === 'warn'
                          ? 'border-amber-500/10 bg-amber-500/6'
                          : 'border-zinc-900/80'
                    }`}
                  >
                    <div className="font-mono text-xs text-zinc-500">
                      {String(line.ts || '').replace('T', ' ').replace('Z', '')}
                    </div>
                    <div>
                      <Badge color={LEVEL_BADGES[line.level] || 'zinc'}>
                        {String(line.level || 'info').toUpperCase()}
                      </Badge>
                    </div>
                    <div className={`break-words font-mono text-xs ${LEVEL_STYLES[line.level] || 'text-zinc-300'}`}>
                      {line.text || ''}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
