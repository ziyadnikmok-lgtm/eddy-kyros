import React, { useState } from 'react';

const s = {
  container: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0f' },
  box: { background: '#111', border: '1px solid #222', borderRadius: '12px', padding: '2rem', width: '100%', maxWidth: '400px' },
  title: { color: '#e0e0ff', fontSize: '24px', fontWeight: 700, marginBottom: '1.5rem', textAlign: 'center' },
  input: { width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid #333', background: '#1a1a2e', color: '#e0e0ff', fontSize: '14px', marginBottom: '1rem', boxSizing: 'border-box' },
  btn: { width: '100%', padding: '0.75rem', background: '#6366f1', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: 600, cursor: 'pointer' },
  err: { color: '#f87171', fontSize: '14px', marginBottom: '1rem', textAlign: 'center' },
  msg: { color: '#4ade80', fontSize: '14px', textAlign: 'center', padding: '1rem' },
  link: { color: '#818cf8', cursor: 'pointer', background: 'none', border: 'none', fontSize: '14px', textDecoration: 'underline' },
  row: { textAlign: 'center', marginTop: '1rem' }
};

export default function ResetPasswordPage({ onNavigate }) {
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const token = new URLSearchParams(window.location.search).get('token');

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError('');
    const res = await fetch(`/api/auth/reset-password/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const data = await res.json();
    if (!res.ok) setError(data.error || 'Reset failed');
    else {
      setMsg(data.message || 'Password reset successful. Redirecting...');
      setTimeout(() => onNavigate && onNavigate('login', { replace: true }), 900);
    }
    setLoading(false);
  };

  return (
    <div style={s.container}>
      <div style={s.box}>
        <h2 style={s.title}>Reset Password</h2>
        {msg ? <div style={s.msg}>{msg}</div> : (
          <form onSubmit={handleSubmit}>
            {error && <div style={s.err}>{error}</div>}
            <input type="password" placeholder="New password (min 8 chars)" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} style={s.input} />
            <button type="submit" style={s.btn} disabled={loading}>{loading ? 'Resetting...' : 'Reset Password'}</button>
          </form>
        )}
        <div style={s.row}><button onClick={() => onNavigate && onNavigate('login', { replace: true })} style={s.link}>Back to Login</button></div>
      </div>
    </div>
  );
}
