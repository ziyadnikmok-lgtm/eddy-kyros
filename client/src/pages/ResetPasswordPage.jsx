import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setLoading(true); setError('');
    const token = params.get('token');
    const r = await fetch(`/api/auth/reset-password/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const d = await r.json();
    if (!r.ok) { setError(d.error || 'Failed'); setLoading(false); return; }
    setMsg(d.message);
    setTimeout(() => navigate('/login'), 2000);
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f0f1a' }}>
      <div style={{ background: '#1a1a2e', border: '1px solid #2d2d4e', borderRadius: '12px', padding: '40px', width: '100%', maxWidth: '400px' }}>
        <h1 style={{ color: '#e0e0ff', textAlign: 'center', marginBottom: '24px' }}>New Password</h1>
        {error && <p style={{ color: '#f87171', background: '#3b1f1f', padding: '10px', borderRadius: '8px', marginBottom: '12px' }}>{error}</p>}
        {msg && <p style={{ color: '#4ade80', background: '#1f3b2a', padding: '10px', borderRadius: '8px', marginBottom: '12px' }}>{msg}</p>}
        <form onSubmit={handleSubmit}>
          {['Password', 'Confirm'].map((lbl, i) => (
            <div key={lbl}>
              <label style={{ display: 'block', color: '#a0a0c0', marginBottom: '6px', fontSize: '13px' }}>{lbl}</label>
              <input style={{ width: '100%', padding: '10px 12px', background: '#0f0f1a', border: '1px solid #3d3d5e', borderRadius: '8px', color: '#e0e0ff', marginBottom: '16px', boxSizing: 'border-box' }}
                type="password" value={i === 0 ? password : confirm} onChange={e => i === 0 ? setPassword(e.target.value) : setConfirm(e.target.value)} minLength={8} required />
            </div>
          ))}
          <button style={{ width: '100%', padding: '12px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer' }} type="submit" disabled={loading}>{loading ? 'Saving...' : 'Reset Password'}</button>
        </form>
      </div>
    </div>
  );
}
