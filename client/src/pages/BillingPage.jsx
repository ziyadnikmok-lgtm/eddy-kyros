import { useEffect, useMemo, useState } from 'react';
import { Badge, Btn, Card, Spinner } from '../components/UI';

const PLANS = [
  {
    id: 'trial',
    planId: 'free',
    cycle: null,
    name: 'Free Trial',
    eyebrow: 'Start here',
    price: '$0',
    period: '',
    highlight: 'Try the tools before you commit to anything.',
    features: [
      'AI image generation',
      'Character creation',
      'Scene & photo recreation',
      'Pinterest & reel tools',
      '10 free generations',
    ],
    accent: '#71717a',
    cta: 'Start Free',
    trial: true,
  },
  {
    id: 'pro-monthly',
    planId: 'pro',
    cycle: 'monthly',
    name: '1 Month',
    eyebrow: 'Full access',
    price: '$19.99',
    period: 'one-time',
    highlight: 'Everything unlocked for 30 days.',
    features: [
      'Unlimited image generation',
      'NSFW generation',
      'Photo match & scene recreate',
      'Carousel, batch & auto-generator',
      'Video compose & reel tools',
      'Style library & prompt builder',
      'Pinterest recreate workflow',
    ],
    accent: '#3b82f6',
    cta: 'Get 1 Month',
  },
  {
    id: 'pro-quarterly',
    planId: 'pro',
    cycle: 'quarterly',
    name: '3 Months',
    eyebrow: 'Most popular',
    price: '$44.99',
    period: 'one-time',
    highlight: 'Same full access, 3x the runway. Save $15.',
    features: [
      'Everything in 1 Month',
      'Unlimited image generation',
      'NSFW generation',
      'All workflows — video, carousel, batch',
      'Photo match & scene recreate',
      'Pinterest & reel tools',
      'Style library & prompt builder',
    ],
    accent: '#0ea5e9',
    cta: 'Get 3 Months',
    featured: true,
    saveLabel: 'Save $15',
  },
  {
    id: 'founder-lifetime',
    planId: 'unlimited',
    cycle: 'lifetime',
    name: 'Lifetime',
    eyebrow: 'Limited spots',
    price: '$149',
    period: 'one-time',
    highlight: 'Pay once, use forever. Every feature, no expiry.',
    features: [
      'Everything — forever',
      'Unlimited image generation',
      'NSFW generation',
      'All current & future workflows',
      'Photo match, scene, video, carousel',
      'Pinterest, reel & batch tools',
      'Priority support',
    ],
    accent: '#f59e0b',
    cta: 'Claim Lifetime',
    lifetime: true,
  },
];

const PLAN_NAME_MAP = {
  free: 'Free Trial',
  pro: 'Kyros Creator',
  unlimited: 'Founder Lifetime',
};

function formatExpiry(expiresAt) {
  if (!expiresAt) return 'No expiry set';
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return 'No expiry set';
  return date.toLocaleDateString();
}

export default function BillingPage() {
  const [sub, setSub] = useState(null);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pendingPlan, setPendingPlan] = useState('');
  const [error, setError] = useState('');
  const paymentStatus = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('status');
  }, []);
  const showTg = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('tg') === '1';
  }, []);

  useEffect(() => {
    if (paymentStatus === 'success' && showTg) {
      const t = setTimeout(() => { window.open('https://t.me/shiaspam', '_blank'); }, 2000);
      return () => clearTimeout(t);
    }
  }, [paymentStatus, showTg]);

  useEffect(() => {
    Promise.all([
      fetch('/api/billing/status', { credentials: 'include' }).then((r) => r.json()),
      fetch('/api/auth/me', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([subData, meData]) => {
        setSub(subData);
        setMe(meData);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const currentPlan = sub?.plan || 'free';
  const isActive = sub?.status === 'active';
  const heroStats = useMemo(() => {
    if (currentPlan === 'unlimited') {
      return { title: 'Founder access active', sublabel: 'You are on the lifetime founder track.' };
    }
    if (currentPlan === 'pro') {
      return { title: 'Creator access active', sublabel: sub?.expires_at ? `Renews or ends ${formatExpiry(sub.expires_at)}` : 'Paid access is active.' };
    }
    return { title: 'You are on the free trial', sublabel: 'You have 10 generations to test the workflow before upgrading.' };
  }, [currentPlan, sub?.expires_at]);

  const handleCheckout = async (plan) => {
    if (plan.trial) return;
    setPendingPlan(plan.id);
    setError('');
    try {
      const r = await fetch('/api/billing/create-invoice', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: plan.planId, cycle: plan.cycle }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || 'Failed to create invoice');
        return;
      }
      if (d.url) window.location.href = d.url;
    } catch (e) {
      setError('Network error: ' + e.message);
    } finally {
      setPendingPlan('');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner size={32} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 space-y-8">
      <section className="rounded-3xl border border-zinc-800 bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.18),transparent_25%),linear-gradient(180deg,#0f1118_0%,#090b10_100%)] p-8 shadow-[0_30px_120px_rgba(0,0,0,0.35)]">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.28em] text-rose-400">Kyros Studio</div>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">Everything you need to create.</h1>
            <p className="mt-4 max-w-xl text-sm leading-7 text-zinc-400">
              Generate, recreate, and automate content with your own AI characters. Try free, upgrade when you're ready.
            </p>
            <div className="mt-6 flex flex-wrap gap-2 text-xs text-zinc-300">
              <span className="rounded-full border border-rose-500/25 bg-rose-500/10 px-3 py-1.5 text-rose-300">AI image generation</span>
              <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5">Photo & scene recreation</span>
              <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5">Video & carousel tools</span>
              <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5">Free trial included</span>
            </div>
          </div>

          <Card className="min-w-[280px] border-zinc-800 bg-zinc-950/70">
            <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.24em] text-zinc-500">Current Access</p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-semibold text-zinc-100">{heroStats.title}</p>
                <p className="mt-1 text-sm text-zinc-500">{heroStats.sublabel}</p>
                {me?.email && <p className="mt-3 text-xs text-zinc-600">{me.email}</p>}
              </div>
              <Badge color={isActive ? 'green' : 'red'}>{isActive ? PLAN_NAME_MAP[currentPlan] || currentPlan : sub?.status || 'inactive'}</Badge>
            </div>
          </Card>
        </div>
      </section>

      {error && (
        <div className="rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {paymentStatus === 'success' && (
        <div className="rounded-2xl border border-emerald-900/60 bg-emerald-950/40 px-5 py-4 space-y-3">
          <p className="text-sm font-semibold text-emerald-300">Payment received. Your plan is being activated now.</p>
          <p className="text-sm text-emerald-400/80">Opening Telegram to send you your access details{showTg ? ' (opening in 2s…)' : ''}.</p>
          <a
            href="https://t.me/shiaspam"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20 transition"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12l-6.871 4.326-2.962-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.833.941z"/></svg>
            Join Telegram — @shiaspam
          </a>
        </div>
      )}

      <section className="grid grid-cols-1 gap-5 xl:grid-cols-4">
        {PLANS.map((plan) => {
          const isCurrent = currentPlan === plan.planId;
          const isProcessing = pendingPlan === plan.id;
          return (
            <div
              key={plan.id}
              className={`relative flex h-full flex-col overflow-hidden rounded-3xl border p-6 transition-transform duration-200 ${plan.featured ? 'xl:-translate-y-2' : ''}`}
              style={{
                borderColor: isCurrent ? `${plan.accent}88` : 'rgba(255,255,255,0.08)',
                background: plan.featured
                  ? 'linear-gradient(180deg, rgba(14,165,233,0.16), rgba(10,13,18,0.98) 24%, rgba(10,13,18,0.98) 100%)'
                  : 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(9,11,16,0.98))',
                boxShadow: plan.featured ? '0 24px 80px rgba(14,165,233,0.14)' : '0 20px 60px rgba(0,0,0,0.22)',
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.24em]" style={{ color: plan.accent }}>{plan.eyebrow}</div>
                  <h2 className="mt-3 text-2xl font-semibold text-zinc-50">{plan.name}</h2>
                </div>
                {plan.featured && <span className="rounded-full border border-rose-400/30 bg-rose-400/12 px-3 py-1 text-[0.6875rem] font-semibold text-rose-300">Best Value</span>}
                {plan.lifetime && <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-3 py-1 text-[0.6875rem] font-semibold text-amber-300">Limited</span>}
              </div>

              <div className="mt-5 flex items-end gap-2">
                <div className="text-5xl font-semibold tracking-tight text-zinc-50">{plan.price}</div>
                {plan.period && <div className="pb-2 text-sm text-zinc-500">{plan.period}</div>}
              </div>

              {plan.saveLabel && (
                <div className="mt-3 inline-flex w-fit rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-300">
                  {plan.saveLabel}
                </div>
              )}

              <p className="mt-4 min-h-[64px] text-sm leading-7 text-zinc-400">{plan.highlight}</p>

              <div className="mt-6 flex-1 space-y-3">
                {plan.features.map((feature) => (
                  <div key={feature} className="flex items-start gap-3 rounded-2xl border border-zinc-800/80 bg-black/20 px-4 py-3 text-sm text-zinc-300">
                    <span className="mt-0.5 h-2 w-2 rounded-full" style={{ background: plan.accent }} />
                    <span>{feature}</span>
                  </div>
                ))}
              </div>

              <div className="mt-6">
                {plan.trial ? (
                  <button
                    type="button"
                    className="w-full cursor-default rounded-2xl border border-zinc-700 bg-zinc-900/70 px-4 py-3 text-sm font-semibold text-zinc-200"
                  >
                    Included when you sign up
                  </button>
                ) : (
                  <Btn
                    onClick={() => handleCheckout(plan)}
                    disabled={isProcessing}
                    variant="primary"
                    className="w-full rounded-2xl"
                    style={{ background: plan.accent, boxShadow: `0 18px 40px ${plan.accent}30` }}
                  >
                    {isProcessing ? 'Creating invoice…' : plan.cta}
                  </Btn>
                )}
                {isCurrent && (
                  <p className="mt-3 text-center text-xs text-zinc-500">
                    You are currently on {PLAN_NAME_MAP[currentPlan] || currentPlan}.
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </section>

      <section className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
        <Card className="border-zinc-800 bg-zinc-950/60">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.24em] text-zinc-500">What you get</p>
          <h3 className="mt-2 text-xl font-semibold text-zinc-50">Every tool in one place.</h3>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {[
              ['Generate', 'Create AI images with your own characters — full control over style, pose, and scene.'],
              ['Recreate', 'Drop any photo, replicate the scene with your character. Photo match, scene clone, Pinterest.'],
              ['Automate', 'Batch generation, carousels, auto-scheduler, video compose, reel recreation — all built in.'],
            ].map(([title, body]) => (
              <div key={title} className="rounded-2xl border border-zinc-800 bg-black/20 p-4">
                <div className="text-sm font-semibold text-zinc-100">{title}</div>
                <div className="mt-2 text-sm leading-6 text-zinc-500">{body}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="border-zinc-800 bg-zinc-950/60 flex flex-col justify-between">
          <div>
            <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.24em] text-zinc-500">Questions?</p>
            <h3 className="mt-2 text-xl font-semibold text-zinc-50">Talk to us directly.</h3>
            <p className="mt-3 text-sm leading-7 text-zinc-400">After payment we activate your account personally. Message us on Telegram and we will get you set up.</p>
          </div>
          <a
            href="https://t.me/shiaspam"
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-flex items-center justify-center gap-2 rounded-2xl border border-zinc-700 bg-zinc-900/70 px-4 py-3 text-sm font-medium text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-800/80 hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12l-6.871 4.326-2.962-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.833.941z"/></svg>
            Message @shiaspam on Telegram
          </a>
        </Card>
      </section>
    </div>
  );
}
