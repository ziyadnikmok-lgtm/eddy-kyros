import React, { useState } from 'react';

const styles = {
  container: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0f' },
  box: { background: '#111', border: '1px solid #222', borderRadius: '12px', padding: '2rem', width: '100%', maxWidth: '400px' },
  title: { color: '#e0e0ff', fontSize: '24px', fontWeight: 700, marginBottom: '1.5rem', textAlign: 'center' },
  input: { width: '100%', padding: '0.75rem', borderRadius: '8px', border: '1px solid #333', background: '#1a1a2e', color: '#e0e0ff', fontSize: '14px', marginBottom: '1rem', boxSizing: 'border-box' },
  button: { width: '100%', padding: '0.75rem', background: '#6366f1', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: 600, cursor: 'pointer', marginBottom: '1rem' },
  error: { color: '#f87171', fontSize: '14px', marginBottom: '1rem', textAlign: 'center' },
  link: { color: '#818cf8', cursor: 'pointer', background: 'none', border: 'none', fontSize: '14px', textDecoration: 'underline' },
  linkRow: { textAlign: 'center', color: '#a0a0c0', fontSize: '14px', marginTop: '0.5rem' }
};

export default function LoginPage({ onLogin, onNavigate }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, keepSignedIn })
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Login failed');
      else if (onLogin) onLogin(data.user);
    } catch { setError('Network error'); }
    setLoading(false);
  };

  return (
    <div style={styles.container}>
      <div style={styles.box}>
        <h2 style={styles.title}>AI Content Studio</h2>
        <form onSubmit={handleSubmit}>
          {error && <div style={styles.error}>{error}</div>}
          <input type="text" placeholder="Email or username" value={email} onChange={e => setEmail(e.target.value)} required style={styles.input} />
          <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required style={styles.input} />
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#a0a0c0', fontSize: '14px', marginBottom: '1rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={keepSignedIn} onChange={e => setKeepSignedIn(e.target.checked)} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
            Keep me signed in for 30 days
          </label>
          <button type="submit" style={styles.button} disabled={loading}>{loading ? 'Signing in...' : 'Sign In'}</button>
        </form>
        <div style={styles.linkRow}>
          <button onClick={() => onNavigate && onNavigate('forgot-password')} style={styles.link}>Forgot password?</button>
        </div>
        <div style={styles.linkRow}>
          No account? <button onClick={() => onNavigate && onNavigate('register')} style={styles.link}>Register</button>
        </div>
      </div>
    </div>
  );
}
