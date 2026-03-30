import React, { useState } from 'react';

const s = {
  container: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0f' },
  box: { background: '#111', border: '1px solid #222', borderRadius: '12px', padding: '2rem', width: '100%', maxWidth: '400px' },
  title: { color: '#e0e0ff', fontSize: '24px', fontWeight: 700, marginBottom: '1.5rem', textAlign: 'center' },
  input: { width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid #333', background: '#1a1a2e', color: '#e0e0ff', fontSize: '14px', marginBottom: '1rem', boxSizing: 'border-box' },
  btn: { width: '100%', padding: '0.75rem', background: '#6366f1', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: 600, cursor: 'pointer', marginBottom: '1rem' },
  err: { color: '#f87171', fontSize: '14px', marginBottom: '1rem', textAlign: 'center' },
  msg: { color: '#4ade80', fontSize: '14px', textAlign: 'center', padding: '1rem' },
  link: { color: '#818cf8', cursor: 'pointer', background: 'none', border: 'none', fontSize: '14px', textDecoration: 'underline' },
  row: { textAlign: 'center', color: '#a0a0c0', fontSize: '14px', marginTop: '0.5rem' }
};

export default function RegisterPage({ onNavigate }) {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.password !== confirm) { setError('Passwords do not match'); return; }
    if (form.password.length < 8) { setError('Password must be at least 8 characters'); return; }
    setLoading(true); setError(''); setMsg('');
    try {
      const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Registration failed');
      else setMsg(data.message);
    } catch { setError('Network error'); }
    setLoading(false);
  };

  const passwordsMatch = confirm.length === 0 || form.password === confirm;

  return (
    <div style={s.container}>
      <div style={s.box}>
        <h2 style={s.title}>Create Account</h2>
        {msg ? <div style={s.msg}>{msg}</div> : (
          <form onSubmit={handleSubmit}>
            {error && <div style={s.err}>{error}</div>}
            <input type="text" placeholder="Name" value={form.name} onChange={e => setForm({...form, name: e.target.value})} required style={s.input} />
            <input type="email" placeholder="Email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} required style={s.input} />
            <input type="password" placeholder="Password (min 8 characters)" value={form.password} onChange={e => setForm({...form, password: e.target.value})} required style={s.input} />
            <input
              type="password"
              placeholder="Confirm password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              required
              style={{ ...s.input, borderColor: passwordsMatch ? '#333' : '#ef4444', marginBottom: '0.25rem' }}
            />
            {!passwordsMatch && <p style={{ color: '#f87171', fontSize: '12px', marginBottom: '0.75rem' }}>Passwords don't match</p>}
            <button type="submit" style={{ ...s.btn, marginTop: '0.5rem' }} disabled={loading || !passwordsMatch}>{loading ? 'Creating...' : 'Create Account'}</button>
          </form>
        )}
        <div style={s.row}>Already have an account? <button onClick={() => onNavigate && onNavigate('login')} style={s.link}>Sign in</button></div>
      </div>
    </div>
  );
}
