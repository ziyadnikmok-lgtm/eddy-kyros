import React, { useState } from 'react';

const s = {
  container: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0f' },
  box: { background: '#111', border: '1px solid #222', borderRadius: '12px', padding: '2rem', width: '100%', maxWidth: '400px' },
  title: { color: '#e0e0ff', fontSize: '24px', fontWeight: 700, marginBottom: '1.5rem', textAlign: 'center' },
  input: { width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid #333', background: '#1a1a2e', color: '#e0e0ff', fontSize: '14px', marginBottom: '1rem', boxSizing: 'border-box' },
  btn: { width: '100%', padding: '0.75rem', background: '#6366f1', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: 600, cursor: 'pointer', marginBottom: '1rem' },
  msg: { color: '#4ade80', fontSize: '14px', textAlign: 'center', padding: '1rem' },
  link: { color: '#818cf8', cursor: 'pointer', background: 'none', border: 'none', fontSize: '14px', textDecoration: 'underline' },
  row: { textAlign: 'center', color: '#a0a0c0', fontSize: '14px', marginTop: '0.5rem' }
};

export default function ForgotPasswordPage({ onNavigate }) {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true);
    const res = await fetch('/api/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const data = await res.json();
    setMsg(data.message || 'Check your email for a reset link.');
    setLoading(false);
  };

  return (
    <div style={s.container}>
      <div style={s.box}>
        <h2 style={s.title}>Forgot Password</h2>
        {msg ? <div style={s.msg}>{msg}</div> : (
          <form onSubmit={handleSubmit}>
            <input type="email" placeholder="Your email" value={email} onChange={e => setEmail(e.target.value)} required style={s.input} />
            <button type="submit" style={s.btn} disabled={loading}>{loading ? 'Sending...' : 'Send Reset Link'}</button>
          </form>
        )}
        <div style={s.row}><button onClick={() => onNavigate && onNavigate('login')} style={s.link}>Back to Login</button></div>
      </div>
    </div>
  );
}
