import { useState } from 'react';
import { Link } from 'react-router-dom';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true);
    const r = await fetch('/api/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const d = await r.json();
    setMsg(d.message || d.error || 'Done');
    setLoading(false);
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f0f1a' }}>
      <div style={{ background: '#1a1a2e', border: '1px solid #2d2d4e', borderRadius: '12px', padding: '40px', width: '100%', maxWidth: '400px' }}>
        <h1 style={{ color: '#e0e0ff', textAlign: 'center', marginBottom: '24px' }}>Reset Password</h1>
        {msg && <p style={{ color: '#4ade80', background: '#1f3b2a', padding: '10px 14px', borderRadius: '8px', marginBottom: '16px' }}>{msg}</p>}
        <form onSubmit={handleSubmit}>
          <label style={{ display: 'block', color: '#a0a0c0', marginBottom: '6px', fontSize: '13px' }}>Email</label>
          <input style={{ width: '100%', padding: '10px 12px', background: '#0f0f1a', border: '1px solid #3d3d5e', borderRadius: '8px', color: '#e0e0ff', marginBottom: '16px', boxSizing: 'border-box' }} type="email" value={email} onChange={e => setEmail(e.target.value)} required />
          <button style={{ width: '100%', padding: '12px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer' }} type="submit" disabled={loading}>{loading ? 'Sending...' : 'Send Reset Link'}</button>
        </form>
        <p style={{ textAlign: 'center', marginTop: '16px', color: '#a0a0c0' }}><Link to="/login" style={{ color: '#818cf8' }}>Back to login</Link></p>
      </div>
    </div>
  );
}
