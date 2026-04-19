import React, { useEffect, useState } from 'react';
import {
  ArrowUpRight, Check, Clock, Copy, DollarSign,
  ExternalLink, Gift, TrendingUp, Users, Wallet,
} from 'lucide-react';

const BASE = window.location.origin;

export default function ReferralPage() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showPayout, setShowPayout] = useState(false);
  const [wallet, setWallet] = useState('');
  const [method, setMethod] = useState('USDT (TRC-20)');
  const [payoutMsg, setPayoutMsg] = useState('');
  const [payoutErr, setPayoutErr] = useState('');
  const [payoutLoading, setPayoutLoading] = useState(false);

  useEffect(() => {
    fetch('/api/referral/stats', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { setStats(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const referralLink = stats?.code ? `${BASE}?ref=${stats.code}` : '';

  const copyLink = () => {
    if (!referralLink) return;
    navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const requestPayout = async () => {
    if (!wallet.trim()) { setPayoutErr('Enter your wallet address.'); return; }
    setPayoutLoading(true); setPayoutErr(''); setPayoutMsg('');
    const res = await fetch('/api/referral/request-payout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ wallet: wallet.trim(), method }),
    });
    const data = await res.json();
    if (!res.ok) setPayoutErr(data.error || 'Failed');
    else { setPayoutMsg(data.message); setShowPayout(false); setWallet(''); }
    setPayoutLoading(false);
  };

  const STAT_CARDS = stats ? [
    { label: 'Total Signups',      value: stats.totalSignups, icon: Users,       color: '#a78bfa' },
    { label: 'Conversions',        value: stats.conversions,  icon: TrendingUp,  color: '#34d399' },
    { label: 'Pending Earnings',   value: `$${stats.pending.toFixed(2)}`, icon: Clock,  color: '#fbbf24' },
    { label: 'Total Paid Out',     value: `$${stats.paid.toFixed(2)}`,    icon: DollarSign, color: '#FF4D6D' },
  ] : [];

  const STATUS_STYLE = {
    pending: { bg: 'rgba(251,191,36,0.1)', border: 'rgba(251,191,36,0.25)', color: '#fbbf24' },
    paid:    { bg: 'rgba(52,211,153,0.1)',  border: 'rgba(52,211,153,0.25)',  color: '#34d399' },
    refunded:{ bg: 'rgba(239,68,68,0.1)',   border: 'rgba(239,68,68,0.25)',   color: '#f87171' },
  };

  return (
    <div className="min-h-screen p-6 md:p-8" style={{ background: '#0A0A0A', color: '#F5F5F5', fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600&display=swap');`}</style>

      {/* Header */}
      <div className="mb-8 max-w-5xl mx-auto">
        <div className="flex items-center gap-3 mb-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl" style={{ background: 'linear-gradient(135deg, #FF4D6D, #FF8C69)' }}>
            <Gift className="h-4 w-4 text-white" />
          </div>
          <h1 className="text-2xl font-bold" style={{ fontFamily: "'Syne', sans-serif", letterSpacing: '-0.02em' }}>
            Referral Program
          </h1>
        </div>
        <p className="text-sm leading-relaxed" style={{ color: 'rgba(245,245,245,0.5)' }}>
          Earn <strong style={{ color: '#FF4D6D' }}>20% recurring commission</strong> every month a referred user stays on Pro or Unlimited.
          Pro = $3.80/mo · Unlimited = $9.80/mo per referral.
        </p>
      </div>

      <div className="max-w-5xl mx-auto space-y-6">
        {/* Referral Link Card */}
        <div className="rounded-2xl p-6" style={{ border: '1px solid rgba(255,77,109,0.2)', background: 'linear-gradient(135deg, rgba(255,77,109,0.07), rgba(10,10,10,1) 60%)' }}>
          <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: '#FF4D6D', fontFamily: "'Syne', sans-serif" }}>
            Your Referral Link
          </p>
          {loading ? (
            <div className="h-12 rounded-xl animate-pulse" style={{ background: 'rgba(255,255,255,0.05)' }} />
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex-1 rounded-xl px-4 py-3 text-sm font-mono truncate"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(245,245,245,0.8)' }}>
                {referralLink || '—'}
              </div>
              <button onClick={copyLink} disabled={!referralLink}
                className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-all hover:opacity-85"
                style={{ background: copied ? 'rgba(52,211,153,0.15)' : '#FF4D6D', color: copied ? '#34d399' : '#fff', border: copied ? '1px solid rgba(52,211,153,0.3)' : 'none', minWidth: 100 }}>
                {copied ? <><Check className="h-4 w-4" /> Copied!</> : <><Copy className="h-4 w-4" /> Copy</>}
              </button>
              <a href={referralLink} target="_blank" rel="noreferrer"
                className="flex items-center gap-1.5 rounded-xl px-4 py-3 text-sm transition-all hover:text-white"
                style={{ border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(245,245,245,0.5)', background: 'rgba(255,255,255,0.03)' }}>
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          )}
          <p className="mt-3 text-xs" style={{ color: 'rgba(245,245,245,0.3)' }}>
            Share this link. When someone signs up and upgrades, you earn 20% of their plan every month.
          </p>
        </div>

        {/* Stats Grid */}
        {loading ? (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-28 rounded-2xl animate-pulse" style={{ background: 'rgba(255,255,255,0.04)' }} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {STAT_CARDS.map(({ label, value, icon: Icon, color }) => (
              <div key={label} className="rounded-2xl p-5" style={{ border: '1px solid rgba(255,255,255,0.06)', background: '#111111' }}>
                <div className="mb-3 inline-flex rounded-lg p-2" style={{ background: `${color}15` }}>
                  <Icon className="h-4 w-4" style={{ color }} />
                </div>
                <div className="text-2xl font-bold mb-1" style={{ fontFamily: "'Syne', sans-serif", letterSpacing: '-0.02em' }}>{value}</div>
                <div className="text-xs" style={{ color: 'rgba(245,245,245,0.4)' }}>{label}</div>
              </div>
            ))}
          </div>
        )}

        {/* How It Works */}
        <div className="rounded-2xl p-6" style={{ border: '1px solid rgba(255,255,255,0.06)', background: '#111111' }}>
          <p className="text-xs font-bold uppercase tracking-widest mb-5" style={{ color: 'rgba(245,245,245,0.3)', fontFamily: "'Syne', sans-serif" }}>How It Works</p>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              { step: '01', title: 'Share your link', body: 'Send your referral link to OFM operators, agency owners, or creators.' },
              { step: '02', title: 'They upgrade', body: 'When they sign up and pay for Pro or Unlimited, the commission is recorded.' },
              { step: '03', title: 'You get paid', body: 'Request payout once you hit $20. We pay in crypto within 48 hours.' },
            ].map(s => (
              <div key={s.step} className="flex gap-4">
                <span className="text-3xl font-black shrink-0" style={{ fontFamily: "'Syne', sans-serif", color: 'rgba(255,77,109,0.2)', lineHeight: 1 }}>{s.step}</span>
                <div>
                  <div className="font-semibold text-sm mb-1 text-white" style={{ fontFamily: "'Syne', sans-serif" }}>{s.title}</div>
                  <div className="text-xs leading-relaxed" style={{ color: 'rgba(245,245,245,0.45)' }}>{s.body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Payout section */}
        {stats && stats.pending >= 20 && (
          <div className="rounded-2xl p-6" style={{ border: '1px solid rgba(251,191,36,0.2)', background: 'rgba(251,191,36,0.05)' }}>
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="font-semibold text-white" style={{ fontFamily: "'Syne', sans-serif" }}>
                  ${stats.pending.toFixed(2)} ready to withdraw
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'rgba(245,245,245,0.45)' }}>Minimum $20 — paid in USDT, BTC, or ETH within 48h</p>
              </div>
              <button onClick={() => setShowPayout(!showPayout)}
                className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-all hover:opacity-85"
                style={{ background: '#fbbf24', color: '#0A0A0A' }}>
                <Wallet className="h-4 w-4" /> Request Payout
              </button>
            </div>
            {payoutMsg && <p className="mt-3 text-sm px-4 py-3 rounded-xl" style={{ background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', color: '#34d399' }}>{payoutMsg}</p>}
            {showPayout && (
              <div className="mt-4 space-y-3 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="block text-xs mb-1.5" style={{ color: 'rgba(245,245,245,0.5)' }}>Method</label>
                    <select value={method} onChange={e => setMethod(e.target.value)}
                      className="w-full rounded-xl px-4 py-2.5 text-sm"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#F5F5F5', outline: 'none' }}>
                      {['USDT (TRC-20)', 'USDT (ERC-20)', 'BTC', 'ETH'].map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs mb-1.5" style={{ color: 'rgba(245,245,245,0.5)' }}>Wallet Address</label>
                    <input value={wallet} onChange={e => setWallet(e.target.value)}
                      placeholder="0x... or T..."
                      className="w-full rounded-xl px-4 py-2.5 text-sm"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#F5F5F5', outline: 'none', fontFamily: 'monospace' }} />
                  </div>
                </div>
                {payoutErr && <p className="text-xs" style={{ color: '#f87171' }}>{payoutErr}</p>}
                <button onClick={requestPayout} disabled={payoutLoading}
                  className="rounded-xl px-6 py-2.5 text-sm font-semibold transition-all hover:opacity-85"
                  style={{ background: '#FF4D6D', color: '#fff', opacity: payoutLoading ? 0.6 : 1 }}>
                  {payoutLoading ? 'Sending…' : 'Confirm Request'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Commission History */}
        <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="px-6 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: '#111111' }}>
            <p className="text-sm font-bold" style={{ fontFamily: "'Syne', sans-serif" }}>Commission History</p>
          </div>
          {loading ? (
            <div className="p-6 space-y-3">
              {[...Array(3)].map((_, i) => <div key={i} className="h-10 rounded-xl animate-pulse" style={{ background: 'rgba(255,255,255,0.04)' }} />)}
            </div>
          ) : !stats?.commissions?.length ? (
            <div className="px-6 py-12 text-center" style={{ background: '#0E0E0E' }}>
              <Gift className="h-8 w-8 mx-auto mb-3" style={{ color: 'rgba(245,245,245,0.15)' }} />
              <p className="text-sm" style={{ color: 'rgba(245,245,245,0.3)' }}>No commissions yet. Share your link to start earning.</p>
            </div>
          ) : (
            <div style={{ background: '#0E0E0E' }}>
              {/* Desktop table */}
              <table className="w-full hidden md:table">
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    {['User', 'Plan', 'Commission', 'Status', 'Date'].map(h => (
                      <th key={h} className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest"
                        style={{ color: 'rgba(245,245,245,0.25)', fontFamily: "'Syne', sans-serif" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stats.commissions.map((c, i) => {
                    const s = STATUS_STYLE[c.status] || STATUS_STYLE.pending;
                    return (
                      <tr key={c.id} style={{ borderBottom: i < stats.commissions.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                        <td className="px-6 py-4">
                          <div className="text-sm font-medium text-white">{c.referee_name}</div>
                          <div className="text-xs" style={{ color: 'rgba(245,245,245,0.35)' }}>{c.referee_email}</div>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-xs font-semibold uppercase px-2.5 py-1 rounded-full"
                            style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(245,245,245,0.6)', border: '1px solid rgba(255,255,255,0.08)' }}>
                            {c.plan}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm font-bold" style={{ color: '#34d399' }}>${c.amount_usd.toFixed(2)}</td>
                        <td className="px-6 py-4">
                          <span className="text-xs font-semibold px-2.5 py-1 rounded-full"
                            style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color }}>
                            {c.status}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-xs" style={{ color: 'rgba(245,245,245,0.35)' }}>
                          {new Date(c.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {/* Mobile cards */}
              <div className="md:hidden divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                {stats.commissions.map(c => {
                  const s = STATUS_STYLE[c.status] || STATUS_STYLE.pending;
                  return (
                    <div key={c.id} className="px-5 py-4 flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-white truncate">{c.referee_name}</div>
                        <div className="text-xs mt-0.5 truncate" style={{ color: 'rgba(245,245,245,0.35)' }}>{c.plan} · {new Date(c.created_at).toLocaleDateString()}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-sm font-bold" style={{ color: '#34d399' }}>${c.amount_usd.toFixed(2)}</span>
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                          style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color }}>
                          {c.status}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Info footer */}
        <p className="text-xs text-center pb-4" style={{ color: 'rgba(245,245,245,0.2)' }}>
          Commissions are tracked automatically. Payouts processed within 48h after request. Minimum $20. Questions? Telegram: @Kyros_Studio
        </p>
      </div>
    </div>
  );
}
