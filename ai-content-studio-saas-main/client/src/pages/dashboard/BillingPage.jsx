import { useState, useEffect } from 'react';
import Navbar from '../../components/Navbar';
import { useAuth } from '../../context/AuthContext';

const PLANS = [
  { id: 'free', name: 'Free', price: '$0', features: ['10 generations/day', 'Basic models'] },
  { id: 'pro', name: 'Pro', price: '$19/mo', features: ['Unlimited generations', 'All models', 'Priority support'] },
  { id: 'unlimited', name: 'Unlimited', price: '$49/mo', features: ['Everything in Pro', 'API access', 'Dedicated support'] },
];

export default function BillingPage() {
  const { user } = useAuth();
  const [sub, setSub] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/billing/status', { credentials: 'include' })
      .then(r => r.json()).then(setSub);
  }, []);

  const handleUpgrade = async (planId) => {
    if (planId === 'free') return;
    setLoading(true); setError('');
    try {
      const r = await fetch('/api/billing/create-invoice', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planId }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to create invoice'); return; }
      if (d.url) window.location.href = d.url;
    } catch (e) { setError('Network error: ' + e.message); }
    finally { setLoading(false); }
  };

  const currentPlan = user?.plan || 'free';

  return (
    <>
      <Navbar />
      <div style={{ maxWidth: '800px', margin: '40px auto', padding: '0 20px' }}>
        <h1 style={{ color: '#e0e0ff', marginBottom: '8px' }}>Billing & Subscription</h1>
        {sub && <p style={{ color: '#6b6b8a', marginBottom: '32px' }}>Current plan: <strong style={{ color: '#a0a0c0' }}>{sub.plan}</strong> — Status: <strong style={{ color: sub.status === 'active' ? '#4ade80' : '#f87171' }}>{sub.status}</strong>{sub.expires_at ? ` — Renews ${new Date(sub.expires_at).toLocaleDateString()}` : ''}</p>}
        {error && <div style={{ background: '#3b1f1f', color: '#f87171', padding: '12px 16px', borderRadius: '8px', marginBottom: '20px' }}>{error}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
          {PLANS.map(plan => (
            <div key={plan.id} style={{ background: '#1a1a2e', border: `2px solid ${currentPlan === plan.id ? '#4f46e5' : '#2d2d4e'}`, borderRadius: '12px', padding: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h2 style={{ color: '#e0e0ff', margin: 0, fontSize: '20px' }}>{plan.name}</h2>
                {currentPlan === plan.id && <span style={{ background: '#4f46e5', color: '#fff', fontSize: '11px', padding: '2px 8px', borderRadius: '12px' }}>Current</span>}
              </div>
              <p style={{ color: '#818cf8', fontSize: '24px', fontWeight: 700, margin: '12px 0' }}>{plan.price}</p>
              <ul style={{ color: '#a0a0c0', fontSize: '13px', paddingLeft: '18px', marginBottom: '20px' }}>
                {plan.features.map(f => <li key={f} style={{ marginBottom: '6px' }}>{f}</li>)}
              </ul>
              {plan.id !== 'free' && currentPlan !== plan.id && (
                <button onClick={() => handleUpgrade(plan.id)} disabled={loading}
                  style={{ width: '100%', padding: '10px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}>
                  {loading ? 'Processing...' : `Upgrade to ${plan.name}`}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
