import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';

export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState('verifying');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const token = params.get('token');
    if (!token) { setStatus('error'); setMsg('No verification token provided.'); return; }
    fetch(`/api/auth/verify/${token}`)
      .then(r => r.json())
      .then(d => { if (d.message) { setStatus('success'); setMsg(d.message); } else { setStatus('error'); setMsg(d.error || 'Verification failed'); } })
      .catch(() => { setStatus('error'); setMsg('Network error'); });
  }, []);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f0f1a' }}>
      <div style={{ background: '#1a1a2e', border: '1px solid #2d2d4e', borderRadius: '12px', padding: '40px', maxWidth: '400px', textAlign: 'center' }}>
        {status === 'verifying' && <p style={{ color: '#a0a0c0' }}>Verifying your email...</p>}
        {status === 'success' && <><p style={{ color: '#4ade80', fontSize: '18px' }}>✓ {msg}</p><Link to="/login" style={{ color: '#818cf8' }}>Go to login</Link></>}
        {status === 'error' && <><p style={{ color: '#f87171', fontSize: '16px' }}>{msg}</p><Link to="/register" style={{ color: '#818cf8' }}>Back to register</Link></>}
      </div>
    </div>
  );
}
