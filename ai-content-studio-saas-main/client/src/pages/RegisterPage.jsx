import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { AuthShell } from '../components/ui/sign-in-flow-1';

export default function RegisterPage({ onNavigate }) {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.password !== confirm) { setError('Passwords do not match'); return; }
    if (form.password.length < 8) { setError('Password must be at least 8 characters'); return; }
    setLoading(true); setError(''); setMsg('');
    try {
      const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) setError(typeof data.error === 'string' ? data.error : (data.error?.message || data.message || 'Registration failed'));
      else setMsg(data.message);
    } catch { setError('Network error'); }
    setLoading(false);
  };

  const passwordsMatch = confirm.length === 0 || form.password === confirm;

  return (
    <AuthShell
      onNavigate={onNavigate}
      compact
      title="Create your Kyros workspace."
      subtitle="Set up your account and move straight into character-based generation, Photo Match, Nano Bypass, reels, and library management."
    >
      <motion.div
        initial={{ opacity: 0, x: 30 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className="rounded-[2rem] border border-white/10 bg-white/[0.05] p-5 backdrop-blur-xl"
      >
        <div className="rounded-[1.6rem] border border-white/10 bg-black/35 p-6">
          <div className="text-[11px] uppercase tracking-[0.3em] text-zinc-500">Register</div>
          <h2 className="mt-3 text-3xl font-semibold tracking-[-0.05em] text-white">Build your account.</h2>

          {msg ? (
            <div className="mt-6 rounded-[1.4rem] border border-emerald-400/20 bg-emerald-500/10 px-4 py-4 text-sm leading-7 text-emerald-300">
              {msg}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              {error ? <div className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div> : null}
              <input
                type="text"
                placeholder="Name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                className="h-12 w-full rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition placeholder:text-zinc-500 focus:border-white/25 focus:bg-white/[0.06]"
              />
              <input
                type="email"
                placeholder="Email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
                className="h-12 w-full rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition placeholder:text-zinc-500 focus:border-white/25 focus:bg-white/[0.06]"
              />
              <input
                type="password"
                placeholder="Password (min 8 characters)"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
                className="h-12 w-full rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition placeholder:text-zinc-500 focus:border-white/25 focus:bg-white/[0.06]"
              />
              <div>
                <input
                  type="password"
                  placeholder="Confirm password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  className={`h-12 w-full rounded-full border bg-white/[0.04] px-4 text-sm text-white outline-none transition placeholder:text-zinc-500 ${
                    passwordsMatch ? 'border-white/10 focus:border-white/25 focus:bg-white/[0.06]' : 'border-red-400/40'
                  }`}
                />
                {!passwordsMatch ? <p className="mt-2 px-2 text-xs text-red-300">Passwords don't match.</p> : null}
              </div>
              <button
                type="submit"
                disabled={loading || !passwordsMatch}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-white text-sm font-medium text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? 'Creating...' : 'Create Account'}
                {!loading ? <ArrowRight className="h-4 w-4" /> : null}
              </button>
            </form>
          )}

          <div className="mt-5 text-sm text-zinc-400">
            Already have an account?{' '}
            <button type="button" onClick={() => onNavigate?.('login')} className="text-cyan-300 transition hover:text-cyan-200">
              Sign in
            </button>
          </div>
        </div>
      </motion.div>
    </AuthShell>
  );
}
