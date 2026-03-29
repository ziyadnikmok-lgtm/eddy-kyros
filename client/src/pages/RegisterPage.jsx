import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';

export default function RegisterPage() {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const r = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error || 'Registration failed'); return; }
      setSuccess('Registration successful! Check your email to verify your account.');
      setTimeout(() => navigate('/login'), 3000);
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  };

  const s = (f) => (e) => setForm(p => ({ ...p, [f]: e.target.value }));

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Create Account</h1>
        <p style={styles.subtitle}>AI Content Studio</p>
        {error && <div style={styles.error}>{error}</div>}
        {success && <div style={styles.success}>{success}</div>}
        <form onSubmit={handleSubmit}>
          <label style={styles.label}>Name</label>
          <input style={styles.input} value={form.name} onChange={s('name')} required />
          <label style={styles.label}>Email</label>
          <input style={styles.input} type="email" value={form.email} onChange={s('email')} required />
          <label style={styles.label}>Password</label>
          <input style={styles.input} type="password" value={form.password} onChange={s('password')} minLength={8} required />
          <button style={styles.button} type="submit" disabled={loading}>{loading ? 'Creating...' : 'Create Account'}</button>
        </form>
        <p style={{ textAlign: 'center', marginTop: '16px', color: '#a0a0c0' }}>
          Already have an account? <Link to="/login" style={styles.link}>Sign in</Link>
        </p>
      </div>
    </div>
  );
}

const styles = {
  container: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f0f1a' },
  card: { background: '#1a1a2e', border: '1px solid #2d2d4e', borderRadius: '12px', padding: '40px', width: '100%', maxWidth: '400px' },
  title: { color: '#e0e0ff', marginBottom: '4px', fontSize: '24px', fontWeight: 700, textAlign: 'center' },
  subtitle: { color: '#6b6b8a', textAlign: 'center', marginBottom: '28px', fontSize: '14px' },
  error: { background: '#3b1f1f', color: '#f87171', padding: '10px 14px', borderRadius: '8px', marginBottom: '16px', fontSize: '14px' },
  success: { background: '#1f3b2a', color: '#4ade80', padding: '10px 14px', borderRadius: '8px', marginBottom: '16px', fontSize: '14px' },
  label: { display: 'block', color: '#a0a0c0', fontSize: '13px', marginBottom: '6px', fontWeight: 500 },
  input: { width: '100%', padding: '10px 12px', background: '#0f0f1a', border: '1px solid #3d3d5e', borderRadius: '8px', color: '#e0e0ff', fontSize: '14px', marginBottom: '16px', boxSizing: 'border-box' },
  button: { width: '100%', padding: '12px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: 600, cursor: 'pointer' },
  link: { color: '#818cf8', textDecoration: 'none' },
};
