import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { AuthShell } from '../components/ui/sign-in-flow-1';

export default function LoginPage({ onLogin, onNavigate }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, keepSignedIn })
      });
      const data = await res.json();
      if (!res.ok) setError(typeof data.error === 'string' ? data.error : (data.error?.message || data.message || 'Login failed'));
      else if (onLogin) onLogin(data.user);
    } catch { setError('Network error'); }
    setLoading(false);
  };

  return (
    <AuthShell
      onNavigate={onNavigate}
      compact
      title="Sign in and jump straight back into production."
      subtitle="Get back to your characters, prompts, image queue, Nano Bypass edits, and saved outputs without losing your flow."
    >
      <motion.div
        initial={{ opacity: 0, x: 30 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className="rounded-[2rem] border border-white/10 bg-white/[0.05] p-5 backdrop-blur-xl"
      >
        <div className="rounded-[1.6rem] border border-white/10 bg-black/35 p-6">
          <div className="text-[0.6875rem] uppercase tracking-[0.3em] text-zinc-500">Login</div>
          <h2 className="mt-3 text-3xl font-semibold tracking-[-0.05em] text-white">Welcome back.</h2>
          <p className="mt-3 text-sm leading-7 text-zinc-400">Use your email or username to continue into Kyros Studio.</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            {error ? <div className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div> : null}
            <input
              type="text"
              placeholder="Email or username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="h-12 w-full rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition placeholder:text-zinc-500 focus:border-white/25 focus:bg-white/[0.06]"
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="h-12 w-full rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition placeholder:text-zinc-500 focus:border-white/25 focus:bg-white/[0.06]"
            />
            <label className="flex items-center gap-3 px-1 text-sm text-zinc-400">
              <input
                type="checkbox"
                checked={keepSignedIn}
                onChange={(e) => setKeepSignedIn(e.target.checked)}
                className="h-4 w-4 rounded border-white/20 bg-black"
              />
              Keep me signed in for 30 days
            </label>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-white text-sm font-medium text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'Signing in...' : 'Sign In'}
              {!loading ? <ArrowRight className="h-4 w-4" /> : null}
            </button>
          </form>

          <div className="mt-5 flex items-center justify-between gap-4 text-sm">
            <button type="button" onClick={() => onNavigate?.('forgot-password')} className="text-zinc-400 transition hover:text-white">
              Forgot password?
            </button>
            <button type="button" onClick={() => onNavigate?.('register')} className="text-cyan-300 transition hover:text-cyan-200">
              Create account
            </button>
          </div>
        </div>
      </motion.div>
    </AuthShell>
  );
}
