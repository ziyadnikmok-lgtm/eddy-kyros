import React, { useEffect, useState } from 'react';

const s = {
  container: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0f' },
  box: { background: '#111', border: '1px solid #222', borderRadius: '12px', padding: '2rem', width: '100%', maxWidth: '400px', textAlign: 'center' },
  title: { color: '#e0e0ff', fontSize: '24px', fontWeight: 700, marginBottom: '1rem' },
  ok: { color: '#4ade80', fontSize: '16px', marginBottom: '1rem' },
  err: { color: '#f87171', fontSize: '16px', marginBottom: '1rem' },
  link: { color: '#818cf8', cursor: 'pointer', background: 'none', border: 'none', fontSize: '14px', textDecoration: 'underline' }
};

export default function VerifyEmailPage({ onNavigate }) {
  const [status, setStatus] = useState('loading');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) { setStatus('error'); setMsg('No token provided.'); return; }
    fetch(`/api/auth/verify/${token}`, { redirect: 'manual' })
      .then(r => { if (r.ok || r.status === 302) { setStatus('success'); setMsg('Email verified! You can now log in.'); } else { setStatus('error'); setMsg('Invalid or expired token.'); } })
      .catch(() => { setStatus('error'); setMsg('Network error.'); });
  }, []);

  return (
    <div style={s.container}>
      <div style={s.box}>
        <h2 style={s.title}>Email Verification</h2>
        {status === 'loading' && <div style={{ color: '#a0a0c0' }}>Verifying...</div>}
        {status === 'success' && <div style={s.ok}>{msg}</div>}
        {status === 'error' && <div style={s.err}>{msg}</div>}
        <button onClick={() => onNavigate && onNavigate('landing')} style={s.link}>Go to Login</button>
      </div>
    </div>
  );
}
