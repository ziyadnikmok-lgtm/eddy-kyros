import React, { useState, useEffect, useCallback } from 'react';

const LEVEL_COLOR = {
  error: '#f87171',
  warn: '#fbbf24',
  info: '#a5b4fc',
};

export default function LogsPage() {
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/logs?n=200', { credentials: 'include' });
      const data = await res.json();
      if (data.success) setLines(data.lines);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchLogs, 5000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchLogs]);

  const handleCopy = () => {
    const text = lines.map(l => `[${l.ts}] [${l.level.toUpperCase()}] ${l.text}`).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <h2 style={{ margin: 0, color: '#e0e0ff', fontSize: '20px', fontWeight: 700 }}>App Logs</h2>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <label style={{ color: '#a0a0c0', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            Auto-refresh
          </label>
          <button
            onClick={fetchLogs}
            disabled={loading}
            style={{ padding: '6px 14px', background: '#1e1e3a', border: '1px solid #333', borderRadius: '6px', color: '#a0a0c0', fontSize: '13px', cursor: 'pointer' }}
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          <button
            onClick={handleCopy}
            style={{ padding: '6px 14px', background: copied ? '#166534' : '#6366f1', border: 'none', borderRadius: '6px', color: '#fff', fontSize: '13px', cursor: 'pointer', fontWeight: 600 }}
          >
            {copied ? 'Copied!' : 'Copy All'}
          </button>
        </div>
      </div>

      <p style={{ color: '#6b7280', fontSize: '13px', marginBottom: '12px' }}>
        Last {lines.length} log entries from the current session. Copy and send these to support if you experience errors.
      </p>

      <div style={{ background: '#0d0d1a', border: '1px solid #1e1e3a', borderRadius: '8px', padding: '12px', fontFamily: 'monospace', fontSize: '12px', maxHeight: '600px', overflowY: 'auto' }}>
        {lines.length === 0 ? (
          <div style={{ color: '#4b5563', textAlign: 'center', padding: '40px' }}>No logs yet</div>
        ) : (
          [...lines].reverse().map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: '10px', marginBottom: '4px', lineHeight: '1.5' }}>
              <span style={{ color: '#4b5563', flexShrink: 0 }}>{l.ts.replace('T', ' ').replace('Z', '')}</span>
              <span style={{ color: LEVEL_COLOR[l.level] || '#a0a0c0', flexShrink: 0, fontWeight: 600, textTransform: 'uppercase', width: '40px' }}>{l.level}</span>
              <span style={{ color: '#c0c0d0', wordBreak: 'break-all' }}>{l.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
