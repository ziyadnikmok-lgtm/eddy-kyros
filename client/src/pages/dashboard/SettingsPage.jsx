import { useState, useEffect } from 'react';
import Navbar from '../../components/Navbar';

const SERVICES = [
  { key: 'gemini', label: 'Google Gemini API Key' },
  { key: 'openai', label: 'OpenAI API Key' },
  { key: 'runway', label: 'Runway API Key' },
  { key: 'wavespeed', label: 'WaveSpeed API Key' },
  { key: 'apify', label: 'Apify API Key' },
];

export default function SettingsPage() {
  const [keys, setKeys] = useState({});
  const [show, setShow] = useState({});
  const [saved, setSaved] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/user/keys', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        const m = {};
        (data || []).forEach(k => { m[k.service] = '••••••••••••'; });
        setKeys(m);
      });
  }, []);

  const handleSave = async (service) => {
    const key = keys[service];
    if (!key || key.startsWith('•')) return;
    setLoading(true);
    const r = await fetch('/api/user/keys', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, key }),
    });
    if (r.ok) setSaved(p => ({ ...p, [service]: true }));
    setTimeout(() => setSaved(p => ({ ...p, [service]: false })), 2000);
    setLoading(false);
  };

  const handleDelete = async (service) => {
    await fetch(`/api/user/keys/${service}`, { method: 'DELETE', credentials: 'include' });
    setKeys(p => { const n = { ...p }; delete n[service]; return n; });
  };

  return (
    <>
      <Navbar />
      <div style={{ maxWidth: '700px', margin: '40px auto', padding: '0 20px' }}>
        <h1 style={{ color: '#e0e0ff', marginBottom: '8px' }}>API Keys</h1>
        <p style={{ color: '#6b6b8a', marginBottom: '32px' }}>Your keys are encrypted at rest and never shared.</p>
        {SERVICES.map(({ key: svc, label }) => (
          <div key={svc} style={{ background: '#1a1a2e', border: '1px solid #2d2d4e', borderRadius: '10px', padding: '20px', marginBottom: '16px' }}>
            <label style={{ display: 'block', color: '#a0a0c0', fontWeight: 600, marginBottom: '10px' }}>{label}</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type={show[svc] ? 'text' : 'password'}
                value={keys[svc] || ''}
                onChange={e => setKeys(p => ({ ...p, [svc]: e.target.value }))}
                placeholder={`Enter ${label}`}
                style={{ flex: 1, padding: '10px 12px', background: '#0f0f1a', border: '1px solid #3d3d5e', borderRadius: '8px', color: '#e0e0ff', fontSize: '14px' }}
              />
              <button onClick={() => setShow(p => ({ ...p, [svc]: !p[svc] }))} style={btnStyle('#2d2d4e')}>{show[svc] ? 'Hide' : 'Show'}</button>
              <button onClick={() => handleSave(svc)} disabled={loading} style={btnStyle(saved[svc] ? '#065f46' : '#4f46e5')}>{saved[svc] ? 'Saved!' : 'Save'}</button>
              {keys[svc] && <button onClick={() => handleDelete(svc)} style={btnStyle('#7f1d1d')}>Delete</button>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function btnStyle(bg) {
  return { background: bg, color: '#fff', border: 'none', borderRadius: '8px', padding: '10px 14px', cursor: 'pointer', fontSize: '13px', whiteSpace: 'nowrap' };
}
