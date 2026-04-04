import { useState, useEffect } from 'react';
import { Card, Btn, Badge, Spinner } from '../components/UI';

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    period: '',
    features: ['10 generations/day', 'Basic models', 'Community support'],
    color: '#52525b',
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$19',
    period: '/mo',
    features: ['Unlimited generations', 'All models', 'Priority support', 'Batch generation'],
    color: '#6366f1',
  },
  {
    id: 'unlimited',
    name: 'Unlimited',
    price: '$49',
    period: '/mo',
    features: ['Everything in Pro', 'API access', 'Dedicated support', 'Faster generation'],
    color: '#8b5cf6',
  },
];

export default function BillingPage() {
  const [sub, setSub] = useState(null);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [upgrading, setUpgrading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      fetch('/api/billing/status', { credentials: 'include' }).then(r => r.json()),
      fetch('/api/auth/me', { credentials: 'include' }).then(r => r.ok ? r.json() : null),
    ]).then(([subData, meData]) => {
      setSub(subData);
      setMe(meData);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const handleUpgrade = async (planId) => {
    if (planId === 'free') return;
    setUpgrading(true); setError('');
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
    finally { setUpgrading(false); }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner size={32} />
      </div>
    );
  }

  const currentPlan = sub?.plan || 'free';
  const isActive = sub?.status === 'active';

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Billing & Subscription</h1>
        {me && (
          <p className="text-sm text-zinc-500 mt-1">{me.email}</p>
        )}
      </div>

      {/* Current plan status */}
      <Card className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs text-zinc-500 uppercase tracking-wider font-semibold mb-1">Current Plan</p>
          <p className="text-lg font-semibold text-zinc-100 capitalize">{currentPlan}</p>
          {sub?.expires_at && (
            <p className="text-xs text-zinc-500 mt-0.5">
              Renews {new Date(sub.expires_at).toLocaleDateString()}
            </p>
          )}
        </div>
        <Badge color={isActive ? 'green' : 'red'}>{isActive ? 'Active' : sub?.status || 'inactive'}</Badge>
      </Card>

      {error && (
        <div className="rounded-lg bg-red-950/60 border border-red-800/50 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Plan cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {PLANS.map(plan => {
          const isCurrent = currentPlan === plan.id;
          return (
            <div
              key={plan.id}
              className="rounded-xl border p-5 flex flex-col gap-4 transition-colors"
              style={{
                background: isCurrent ? 'rgba(99,102,241,0.06)' : '#111118',
                borderColor: isCurrent ? plan.color : '#27272a',
              }}
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-zinc-100">{plan.name}</span>
                  {isCurrent && (
                    <span
                      className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                      style={{ background: plan.color + '33', color: plan.color }}
                    >
                      Current
                    </span>
                  )}
                </div>
                <div className="flex items-baseline gap-0.5">
                  <span className="text-2xl font-bold text-zinc-100">{plan.price}</span>
                  {plan.period && <span className="text-zinc-500 text-sm">{plan.period}</span>}
                </div>
              </div>

              <ul className="space-y-1.5 flex-1">
                {plan.features.map(f => (
                  <li key={f} className="flex items-center gap-2 text-xs text-zinc-400">
                    <span style={{ color: plan.color }}>✓</span>
                    {f}
                  </li>
                ))}
              </ul>

              {plan.id !== 'free' && !isCurrent && (
                <Btn
                  onClick={() => handleUpgrade(plan.id)}
                  disabled={upgrading}
                  variant="primary"
                  size="sm"
                  className="w-full"
                >
                  {upgrading ? 'Processing…' : `Upgrade to ${plan.name}`}
                </Btn>
              )}
              {isCurrent && plan.id !== 'free' && (
                <p className="text-xs text-center text-zinc-600">You're on this plan</p>
              )}
              {plan.id === 'free' && isCurrent && (
                <p className="text-xs text-center text-zinc-600">Your current plan</p>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-zinc-600 text-center">
        Payments processed via Heleket (crypto). Contact support if you have billing questions.
      </p>

      <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-zinc-100">Need help with billing or setup?</p>
          <p className="text-xs text-zinc-500 mt-1">Join the community support chat and talk directly with the team.</p>
        </div>
        <a
          href="https://t.me/Kyros_Studio"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 transition"
        >
          Open Telegram Support
        </a>
      </Card>
    </div>
  );
}
