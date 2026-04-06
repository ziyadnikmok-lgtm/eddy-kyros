import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useInView } from 'framer-motion';
import {
  ArrowRight,
  Bot,
  Camera,
  Check,
  ChevronDown,
  Image,
  Layers,
  ShieldCheck,
  Sparkles,
  Star,
  Users,
  Video,
  X,
  Zap,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';

const TELEGRAM_URL = 'https://t.me/Kyros_Studio';

// ─── Design System (UI/UX Pro Max — Plus Jakarta Sans + Sky/Orange) ────────────
const DS = {
  bg: '#08080c',
  surface: '#111116',
  surfaceHover: '#16161d',
  border: 'rgba(255,255,255,0.07)',
  borderHover: 'rgba(255,255,255,0.14)',
  primary: '#0EA5E9',
  primaryGlow: 'rgba(14,165,233,0.15)',
  cta: '#3b82f6',
  ctaGlow: 'rgba(59,130,246,0.25)',
  text: '#FAFAFA',
  textMuted: 'rgba(250,250,250,0.45)',
  textSubtle: 'rgba(250,250,250,0.25)',
  font: "'Plus Jakarta Sans', 'DM Sans', system-ui, sans-serif",
};

// ─── Utility components ────────────────────────────────────────────────────────

function BlurFade({ children, className, delay = 0, yOffset = 24 }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-60px' });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: yOffset, filter: 'blur(6px)' }}
      animate={inView ? { opacity: 1, y: 0, filter: 'blur(0px)' } : undefined}
      transition={{ delay, duration: 0.55, ease: 'easeOut' }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function CountUp({ end, duration = 2000, suffix = '' }) {
  const [count, setCount] = useState(0);
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });
  useEffect(() => {
    if (!inView) return;
    let start = 0;
    const step = end / (duration / 16);
    const timer = setInterval(() => {
      start += step;
      if (start >= end) { setCount(end); clearInterval(timer); }
      else setCount(Math.floor(start));
    }, 16);
    return () => clearInterval(timer);
  }, [inView, end, duration]);
  return <span ref={ref}>{count}{suffix}</span>;
}

function FAQItem({ question, answer, isOpen, onToggle }) {
  return (
    <div className="border-b" style={{ borderColor: DS.border }}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center justify-between gap-4 py-5 text-left transition-colors"
        style={{ color: isOpen ? DS.primary : DS.text }}
      >
        <span className="text-base font-medium">{question}</span>
        <motion.div animate={{ rotate: isOpen ? 180 : 0 }} transition={{ duration: 0.22 }}>
          <ChevronDown className="h-4 w-4 shrink-0" style={{ color: DS.textSubtle }} />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <p className="pb-5 text-sm leading-7" style={{ color: DS.textMuted }}>{answer}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Auth Modal (preserved exactly) ───────────────────────────────────────────
function AuthModal({ mode, onClose, onSuccess, onNavigate }) {
  const [tab, setTab] = useState(mode || 'register');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const [registerForm, setRegisterForm] = useState({ name: '', email: '', password: '' });
  const [confirm, setConfirm] = useState('');
  const [registerMsg, setRegisterMsg] = useState('');
  const [registerError, setRegisterError] = useState('');
  const [registerLoading, setRegisterLoading] = useState(false);

  const passwordsMatch = confirm.length === 0 || registerForm.password === confirm;

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: loginEmail, password: loginPassword, keepSignedIn }),
      });
      const data = await res.json();
      if (!res.ok) setLoginError(data.error || 'Login failed');
      else onSuccess?.();
    } catch { setLoginError('Network error'); }
    setLoginLoading(false);
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    if (registerForm.password !== confirm) { setRegisterError('Passwords do not match'); return; }
    if (registerForm.password.length < 8) { setRegisterError('Password must be at least 8 characters'); return; }
    setRegisterLoading(true);
    setRegisterError('');
    setRegisterMsg('');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(registerForm),
      });
      const data = await res.json();
      if (!res.ok) setRegisterError(data.error || 'Registration failed');
      else setRegisterMsg(data.message || 'Account created. Check your email to verify.');
    } catch { setRegisterError('Network error'); }
    setRegisterLoading(false);
  };

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[80] flex items-center justify-center p-4 sm:p-6"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      >
        <button type="button" className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={onClose} aria-label="Close" />
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 18, scale: 0.98 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="relative z-10 w-full max-w-5xl overflow-hidden rounded-[2rem]"
          style={{ border: `1px solid ${DS.border}`, background: '#0a0d13', boxShadow: '0 40px 120px rgba(0,0,0,0.6)' }}
        >
          <div className="grid lg:grid-cols-[1fr_0.95fr]">
            <div className="relative hidden overflow-hidden border-r lg:block" style={{ borderColor: DS.border }}>
              <div className="absolute inset-0" style={{ background: `radial-gradient(circle at top,${DS.primaryGlow},transparent 28%),linear-gradient(180deg,#090b11 0%,#0b0f16 100%)` }} />
              <div className="relative flex h-full flex-col justify-between p-10">
                <div>
                  <div className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs uppercase tracking-[0.24em]" style={{ border: `1px solid rgba(14,165,233,0.2)`, background: 'rgba(14,165,233,0.1)', color: DS.primary }}>
                    Kyros Studio
                  </div>
                  <h2 className="mt-8 text-5xl font-bold leading-[0.95] tracking-tight text-white" style={{ fontFamily: DS.font }}>
                    Keep the same<br />workflow.
                  </h2>
                  <p className="mt-6 max-w-md text-base leading-8" style={{ color: DS.textMuted, fontFamily: DS.font }}>
                    Create your account or sign in without leaving the landing flow.
                  </p>
                </div>
                <div className="grid gap-3">
                  {['Image generation with consistency', 'Instagram clone and scene workflows', 'WaveSpeed video and reels', 'Batch queue and auto planner'].map((item) => (
                    <div key={item} className="flex items-center gap-3 rounded-2xl px-4 py-3" style={{ border: `1px solid ${DS.border}`, background: 'rgba(255,255,255,0.03)' }}>
                      <Check className="h-4 w-4" style={{ color: DS.primary }} />
                      <span className="text-sm" style={{ color: 'rgba(255,255,255,0.75)', fontFamily: DS.font }}>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="relative p-5 sm:p-7">
              <button type="button" onClick={onClose} className="absolute right-4 top-4 rounded-full p-2 transition" style={{ border: `1px solid ${DS.border}`, background: 'rgba(255,255,255,0.03)', color: DS.textMuted }}>
                <X className="h-4 w-4" />
              </button>
              <div className="rounded-[1.6rem] p-4 sm:p-6" style={{ border: `1px solid ${DS.border}`, background: 'rgba(0,0,0,0.3)' }}>
                <div className="flex gap-2 rounded-full p-1" style={{ border: `1px solid ${DS.border}`, background: 'rgba(255,255,255,0.03)' }}>
                  {['register', 'login'].map((t) => (
                    <button key={t} type="button" onClick={() => setTab(t)}
                      className="flex-1 rounded-full px-4 py-2 text-sm font-medium transition"
                      style={{ background: tab === t ? DS.primary : 'transparent', color: tab === t ? '#fff' : DS.textMuted }}>
                      {t === 'register' ? 'Create Account' : 'Sign In'}
                    </button>
                  ))}
                </div>
                <AnimatePresence mode="wait">
                  {tab === 'login' ? (
                    <motion.form key="login" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.22 }} onSubmit={handleLogin} className="mt-6 space-y-4">
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.28em]" style={{ color: DS.textSubtle, fontFamily: DS.font }}>Sign in</div>
                        <h3 className="mt-2 text-3xl font-bold tracking-tight text-white" style={{ fontFamily: DS.font }}>Welcome back.</h3>
                        <p className="mt-2 text-sm leading-7" style={{ color: DS.textMuted, fontFamily: DS.font }}>Jump straight back into your Kyros workspace.</p>
                      </div>
                      {loginError && <div className="rounded-2xl px-4 py-3 text-sm" style={{ border: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.1)', color: '#fca5a5' }}>{loginError}</div>}
                      {['text', 'password'].map((type, i) => (
                        <input key={type} type={type} placeholder={i === 0 ? 'Email or username' : 'Password'}
                          value={i === 0 ? loginEmail : loginPassword}
                          onChange={(e) => i === 0 ? setLoginEmail(e.target.value) : setLoginPassword(e.target.value)}
                          required className="h-12 w-full rounded-full px-4 text-sm text-white outline-none transition"
                          style={{ border: `1px solid ${DS.border}`, background: 'rgba(255,255,255,0.04)', fontFamily: DS.font }}
                        />
                      ))}
                      <div className="flex items-center justify-between px-1">
                        <label className="flex items-center gap-3 text-sm cursor-pointer" style={{ color: DS.textMuted, fontFamily: DS.font }}>
                          <input type="checkbox" checked={keepSignedIn} onChange={(e) => setKeepSignedIn(e.target.checked)} className="h-4 w-4 rounded" />
                          Keep me signed in
                        </label>
                        <button type="button" onClick={() => { onClose?.(); onNavigate?.('forgot-password'); }} className="text-sm transition-colors" style={{ color: DS.textMuted, fontFamily: DS.font }}>
                          Forgot password?
                        </button>
                      </div>
                      <button type="submit" disabled={loginLoading} className="inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-full text-sm font-semibold transition"
                        style={{ background: DS.primary, color: '#fff', fontFamily: DS.font, opacity: loginLoading ? 0.6 : 1 }}>
                        {loginLoading ? 'Signing in...' : 'Sign In'}{!loginLoading && <ArrowRight className="h-4 w-4" />}
                      </button>
                    </motion.form>
                  ) : (
                    <motion.form key="register" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.22 }} onSubmit={handleRegister} className="mt-6 space-y-4">
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.28em]" style={{ color: DS.textSubtle, fontFamily: DS.font }}>Register</div>
                        <h3 className="mt-2 text-3xl font-bold tracking-tight text-white" style={{ fontFamily: DS.font }}>Build your account.</h3>
                        <p className="mt-2 text-sm leading-7" style={{ color: DS.textMuted, fontFamily: DS.font }}>Create your Kyros workspace without leaving this page.</p>
                      </div>
                      {registerMsg && <div className="rounded-[1.4rem] px-4 py-4 text-sm leading-7" style={{ border: '1px solid rgba(52,211,153,0.2)', background: 'rgba(52,211,153,0.1)', color: '#6ee7b7' }}>{registerMsg}</div>}
                      {registerError && <div className="rounded-2xl px-4 py-3 text-sm" style={{ border: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.1)', color: '#fca5a5' }}>{registerError}</div>}
                      {[['text', 'Name', 'name'], ['email', 'Email', 'email'], ['password', 'Password (min 8 characters)', 'password']].map(([type, placeholder, field]) => (
                        <input key={field} type={type} placeholder={placeholder} value={registerForm[field]}
                          onChange={(e) => setRegisterForm({ ...registerForm, [field]: e.target.value })}
                          required className="h-12 w-full rounded-full px-4 text-sm text-white outline-none transition"
                          style={{ border: `1px solid ${DS.border}`, background: 'rgba(255,255,255,0.04)', fontFamily: DS.font }}
                        />
                      ))}
                      <div>
                        <input type="password" placeholder="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required
                          className="h-12 w-full rounded-full px-4 text-sm text-white outline-none transition"
                          style={{ border: `1px solid ${passwordsMatch ? DS.border : 'rgba(239,68,68,0.4)'}`, background: 'rgba(255,255,255,0.04)', fontFamily: DS.font }}
                        />
                        {!passwordsMatch && <p className="mt-2 px-2 text-xs" style={{ color: '#fca5a5' }}>Passwords don't match.</p>}
                      </div>
                      <button type="submit" disabled={registerLoading || !passwordsMatch} className="inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-full text-sm font-semibold transition"
                        style={{ background: DS.cta, color: '#fff', fontFamily: DS.font, opacity: (registerLoading || !passwordsMatch) ? 0.6 : 1 }}>
                        {registerLoading ? 'Creating...' : 'Create Account'}{!registerLoading && <ArrowRight className="h-4 w-4" />}
                      </button>
                    </motion.form>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ─── Data ──────────────────────────────────────────────────────────────────────
const FEATURES = [
  { icon: Image, label: 'Image Generation', title: 'Gemini-powered. Style-locked.', body: 'Generate stunning images with real consistency. Lock your character, style atoms, and references so every output fits your brand.', color: '#0EA5E9' },
  { icon: Video, label: 'Video Creation', title: 'Reels in minutes, not hours.', body: 'WaveSpeed and Veo-style video workflows built right in. Prompt to finished short-form video without bouncing between apps.', color: '#a78bfa' },
  { icon: Users, label: 'Character Engine', title: 'Build once. Use forever.', body: 'Create AI personas with locked appearance, outfits, and expressions. Stays consistent across thousands of outputs.', color: '#f472b6' },
  { icon: Camera, label: 'Instagram Clone', title: 'Turn viral content into yours.', body: 'Scrape any profile with Apify, analyze what makes their posts work, then recreate the exact format in your own style.', color: '#fb923c' },
  { icon: Zap, label: 'Batch & Auto Plans', title: 'Queue 100 posts. Walk away.', body: 'Auto Planner builds your full content calendar and executes it automatically. Come back to a week of content ready to post.', color: '#34d399' },
  { icon: ShieldCheck, label: 'Hosted Access', title: 'Use it from anywhere.', body: 'Your team or clients can access the platform through the hosted site, while your private local setup stays separate.', color: '#60a5fa' },
];

const STATS = [
  { value: 8, suffix: '+', label: 'AI Integrations' },
  { value: 100, suffix: '+', label: 'Active Users' },
  { value: 50, suffix: 'k+', label: 'Images Generated' },
  { value: 8, suffix: '.1', label: 'Current Version', isText: true, display: 'v8.1' },
];

const STEPS = [
  { num: '01', title: 'Create your account', body: 'Sign up on the hosted site and get into the platform instantly — no install required.' },
  { num: '02', title: 'Add your API keys', body: 'Paste Gemini, WaveSpeed, and Apify keys from the dashboard to unlock the full workflow.' },
  { num: '03', title: 'Build your character', body: 'Create an AI persona once with style atoms and references. It stays consistent everywhere.' },
  { num: '04', title: 'Generate at scale', body: 'Queue batch jobs, run auto plans, and clone winning formats. Build weeks of content in one session.' },
];

const TESTIMONIALS = [
  { name: 'Sarah M.', role: 'Content Creator', body: 'Kyros Studio replaced 4 different tools for me. The character consistency alone is worth it — every image looks like the same person.', stars: 5 },
  { name: 'Alex R.', role: 'Social Media Agency', body: 'We batch generate an entire month of content for 3 clients in one afternoon. The auto planner is a game changer.', stars: 5 },
  { name: 'Jordan K.', role: 'Solo Creator', body: 'The Instagram clone workflow helped me go from 0 to understanding what actually converts. Then I recreate it in my own style.', stars: 5 },
];

const FAQS = [
  { question: 'What is Kyros Studio actually for?', answer: 'A hosted AI creative platform for creators and agencies who need consistent branded content at volume — images, reels, cloning, and auto-planning workflows in one place.' },
  { question: 'Do I need my own API key?', answer: 'Yes. You bring your own Gemini, WaveSpeed, and Apify keys so you keep full control over providers and costs.' },
  { question: 'How is this different from Midjourney or Runway?', answer: 'Those are single-purpose tools. Kyros Studio combines image generation, video creation, character systems, Instagram clone workflows, and batch auto-planning in one hosted workflow.' },
  { question: 'What is the Instagram Clone workflow?', answer: 'Point the app at any profile using Apify, it analyzes the content structure, then helps you recreate those formats in your own character and style.' },
  { question: 'Do I need to install anything?', answer: 'No. The main product is accessed entirely through the hosted site. No local setup needed for regular users.' },
  { question: 'Can I generate content automatically?', answer: 'Yes. Auto Planner builds content schedules and Batch Generator queues large runs — set it up and let it keep producing.' },
];

// ─── Main Component ────────────────────────────────────────────────────────────
export default function LandingPage({ onNavigate, initialAuthModal = null }) {
  const [openFAQ, setOpenFAQ] = useState(0);
  const [authModal, setAuthModal] = useState(initialAuthModal);

  useEffect(() => {
    setAuthModal(initialAuthModal || null);
  }, [initialAuthModal]);

  const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="min-h-screen overflow-hidden text-white" style={{ background: DS.bg, fontFamily: DS.font }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        html { scroll-behavior: smooth; }
        @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-12px)} }
        @keyframes pulse-dot { 0%,100%{opacity:1} 50%{opacity:.3} }
        @keyframes shimmer { 0%{background-position:-200% center} 100%{background-position:200% center} }
        .shimmer-text {
          background: linear-gradient(90deg, #3b82f6 0%, #7dd3fc 40%, #60a5fa 60%, #3b82f6 100%);
          background-size: 200% auto;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          animation: shimmer 4s linear infinite;
        }
        .glow-border:hover { box-shadow: 0 0 0 1px ${DS.primary}, 0 0 20px ${DS.primaryGlow}; }
      `}</style>

      {/* Auth Modal */}
      {authModal && (
        <AuthModal
          mode={authModal}
          onClose={() => {
            setAuthModal(null);
            if (initialAuthModal) onNavigate?.('landing', { replace: true });
          }}
          onSuccess={() => { setAuthModal(null); window.location.reload(); }}
          onNavigate={(page) => { setAuthModal(null); onNavigate?.(page); }}
        />
      )}

      {/* ── Navbar ── */}
      <nav className="fixed left-0 right-0 top-0 z-50 flex items-center justify-between px-6 py-4 sm:px-10"
        style={{ background: 'rgba(8,8,12,0.8)', backdropFilter: 'blur(20px)', borderBottom: `1px solid ${DS.border}` }}>
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: `linear-gradient(135deg, ${DS.primary}, #7c3aed)` }}>
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <span className="text-base font-bold tracking-tight text-white" style={{ fontFamily: DS.font }}>Kyros Studio</span>
        </div>

        <div className="hidden items-center gap-8 md:flex">
          {[['Features', 'features'], ['How It Works', 'how-it-works'], ['FAQ', 'faq']].map(([label, id]) => (
            <button key={id} type="button" onClick={() => scrollTo(id)}
              className="cursor-pointer text-sm font-medium transition-colors hover:text-white"
              style={{ color: DS.textMuted, background: 'none', border: 'none' }}>
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <a href={TELEGRAM_URL} target="_blank" rel="noreferrer"
            className="hidden h-9 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition hover:text-white sm:inline-flex"
            style={{ border: `1px solid ${DS.border}`, color: DS.textMuted }}>
            Telegram
          </a>
          <button type="button" onClick={() => setAuthModal('register')}
            className="h-9 cursor-pointer rounded-full px-5 text-sm font-semibold text-white transition"
            style={{ background: DS.cta, boxShadow: `0 0 20px ${DS.ctaGlow}` }}>
            Get Started
          </button>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="relative flex min-h-screen flex-col items-center justify-center px-6 pb-24 pt-32 text-center">
        {/* Background orbs */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-40 left-1/2 -translate-x-1/2 h-[600px] w-[600px] rounded-full blur-[120px]" style={{ background: 'rgba(14,165,233,0.08)' }} />
          <div className="absolute top-1/3 -left-40 h-[400px] w-[400px] rounded-full blur-[100px]" style={{ background: 'rgba(124,58,237,0.06)' }} />
          <div className="absolute top-1/4 -right-40 h-[350px] w-[350px] rounded-full blur-[100px]" style={{ background: 'rgba(249,115,22,0.06)' }} />
          {/* Grid */}
          <div className="absolute inset-0" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.022) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.022) 1px,transparent 1px)', backgroundSize: '64px 64px' }} />
        </div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
          className="relative mb-6 inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold"
          style={{ background: 'rgba(14,165,233,0.1)', border: '1px solid rgba(14,165,233,0.22)', color: DS.primary }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: DS.primary, animation: 'pulse-dot 2s infinite' }} />
          v8.1.0 — Beta Phase · Free During Testing
        </motion.div>

        <motion.h1 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.7 }}
          className="relative mb-6 text-white"
          style={{ fontSize: 'clamp(44px,8vw,88px)', lineHeight: 1.05, letterSpacing: '-0.03em', fontWeight: 800 }}>
          Create better content<br />
          <span className="shimmer-text">without the chaos.</span>
        </motion.h1>

        <motion.p initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.7 }}
          className="relative mx-auto mb-10 max-w-xl text-lg leading-8" style={{ color: DS.textMuted }}>
          One hosted platform to generate images, create videos, build characters,
          clone Instagram content, and automate your entire content workflow.
        </motion.p>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3, duration: 0.7 }}
          className="relative flex flex-wrap items-center justify-center gap-3">
          <button type="button" onClick={() => setAuthModal('register')}
            className="group inline-flex cursor-pointer items-center gap-2 rounded-full px-8 py-3.5 text-sm font-semibold text-white transition-all hover:scale-105"
            style={{ background: DS.cta, boxShadow: `0 4px 24px ${DS.ctaGlow}` }}>
            Create Free Account
            <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
          </button>
          <button type="button" onClick={() => setAuthModal('login')}
            className="inline-flex cursor-pointer items-center gap-2 rounded-full px-8 py-3.5 text-sm font-medium transition-all hover:text-white"
            style={{ border: `1px solid ${DS.border}`, color: DS.textMuted, background: 'transparent' }}>
            Sign In
          </button>
        </motion.div>

        <motion.a initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.42, duration: 0.6 }}
          href={TELEGRAM_URL} target="_blank" rel="noreferrer"
          className="relative mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm transition hover:text-white"
          style={{ border: '1px solid rgba(14,165,233,0.18)', background: 'rgba(14,165,233,0.07)', color: '#7dd3fc' }}>
          Join support on Telegram <ArrowRight className="h-4 w-4" />
        </motion.a>

        {/* Stats bar */}
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5, duration: 0.7 }}
          className="relative mt-20 flex flex-wrap justify-center gap-12">
          {STATS.map((stat, i) => (
            <div key={stat.label} className="text-center">
              <div className="text-4xl font-bold" style={{ color: DS.primary, fontFamily: DS.font }}>
                {stat.isText ? stat.display : <CountUp end={stat.value} suffix={stat.suffix} />}
              </div>
              <div className="mt-1 text-xs font-medium" style={{ color: DS.textSubtle }}>{stat.label}</div>
            </div>
          ))}
        </motion.div>
      </section>

      {/* ── Social proof strip ── */}
      <BlurFade>
        <div className="px-6 py-10" style={{ borderTop: `1px solid ${DS.border}`, borderBottom: `1px solid ${DS.border}`, background: DS.surface }}>
          <div className="mx-auto max-w-5xl">
            <p className="mb-6 text-center text-xs font-semibold uppercase tracking-widest" style={{ color: DS.textSubtle }}>
              Replaces all of these
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {['Midjourney', 'RunwayML', 'CapCut', 'Later.com', 'Character.ai', 'Apify', 'Lightroom'].map((tool) => (
                <span key={tool} className="rounded-full px-4 py-1.5 text-sm line-through"
                  style={{ border: `1px solid ${DS.border}`, background: 'rgba(255,255,255,0.03)', color: DS.textSubtle }}>
                  {tool}
                </span>
              ))}
              <span className="rounded-full px-5 py-1.5 text-sm font-semibold"
                style={{ border: `1px solid rgba(14,165,233,0.3)`, background: 'rgba(14,165,233,0.1)', color: DS.primary }}>
                ✦ Kyros Studio
              </span>
            </div>
          </div>
        </div>
      </BlurFade>

      {/* ── Features ── */}
      <section id="features" className="px-6 py-28">
        <div className="mx-auto max-w-6xl">
          <BlurFade className="mb-3 text-center">
            <span className="text-xs font-bold uppercase tracking-widest" style={{ color: DS.primary }}>Features</span>
          </BlurFade>
          <BlurFade delay={0.08} className="mb-16 text-center">
            <h2 className="text-white" style={{ fontSize: 'clamp(28px,5vw,52px)', fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.03em' }}>
              Replace your entire<br />
              <span style={{ color: DS.primary }}>content stack.</span>
            </h2>
          </BlurFade>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <BlurFade key={f.label} delay={0.05 * i}>
                <motion.div whileHover={{ y: -6, scale: 1.01 }} transition={{ duration: 0.2 }}
                  className="glow-border group relative h-full rounded-2xl p-6 transition-all"
                  style={{ border: `1px solid ${DS.border}`, background: DS.surface }}>
                  <div className="absolute inset-0 rounded-2xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                    style={{ background: `radial-gradient(circle at 0% 0%, ${f.color}12, transparent 60%)` }} />
                  <div className="relative">
                    <div className="mb-4 inline-flex rounded-xl p-2.5" style={{ border: `1px solid ${f.color}30`, background: `${f.color}15` }}>
                      <f.icon className="h-5 w-5" style={{ color: f.color }} />
                    </div>
                    <div className="mb-1 text-xs font-bold uppercase tracking-widest" style={{ color: DS.textSubtle }}>{f.label}</div>
                    <h3 className="mb-3 text-base font-bold leading-tight text-white">{f.title}</h3>
                    <p className="text-sm leading-7" style={{ color: DS.textMuted }}>{f.body}</p>
                  </div>
                </motion.div>
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="how-it-works" className="px-6 py-28" style={{ background: DS.surface }}>
        <div className="mx-auto max-w-5xl">
          <BlurFade className="mb-3 text-center">
            <span className="text-xs font-bold uppercase tracking-widest" style={{ color: DS.primary }}>How It Works</span>
          </BlurFade>
          <BlurFade delay={0.08} className="mb-16 text-center">
            <h2 className="text-white" style={{ fontSize: 'clamp(28px,4vw,48px)', fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.03em' }}>
              Up and running<br /><span style={{ color: DS.primary }}>in minutes.</span>
            </h2>
          </BlurFade>

          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, i) => (
              <BlurFade key={step.num} delay={0.08 * i}>
                <motion.div whileHover={{ y: -6 }} transition={{ duration: 0.2 }}
                  className="relative rounded-2xl p-6" style={{ border: `1px solid ${DS.border}`, background: DS.bg }}>
                  <div className="mb-4 text-5xl font-black" style={{ color: `${DS.primary}22`, lineHeight: 1 }}>{step.num}</div>
                  <h3 className="mb-2 font-bold text-white">{step.title}</h3>
                  <p className="text-sm leading-6" style={{ color: DS.textMuted }}>{step.body}</p>
                  {i < STEPS.length - 1 && (
                    <div className="absolute -right-3 top-1/2 hidden -translate-y-1/2 lg:block" style={{ color: DS.textSubtle, fontSize: 18 }}>→</div>
                  )}
                </motion.div>
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      {/* ── Testimonials ── */}
      <section className="px-6 py-28">
        <div className="mx-auto max-w-5xl">
          <BlurFade className="mb-3 text-center">
            <span className="text-xs font-bold uppercase tracking-widest" style={{ color: DS.primary }}>What People Say</span>
          </BlurFade>
          <BlurFade delay={0.08} className="mb-14 text-center">
            <h2 className="text-white" style={{ fontSize: 'clamp(28px,4vw,48px)', fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.03em' }}>
              Creators love<br /><span style={{ color: DS.primary }}>the results.</span>
            </h2>
          </BlurFade>

          <div className="grid gap-5 md:grid-cols-3">
            {TESTIMONIALS.map((t, i) => (
              <BlurFade key={t.name} delay={0.08 * i}>
                <motion.div whileHover={{ y: -4 }} transition={{ duration: 0.2 }}
                  className="rounded-2xl p-6" style={{ border: `1px solid ${DS.border}`, background: DS.surface }}>
                  <div className="mb-4 flex gap-1">
                    {Array.from({ length: t.stars }).map((_, si) => (
                      <Star key={si} className="h-4 w-4 fill-current" style={{ color: DS.cta }} />
                    ))}
                  </div>
                  <p className="mb-6 text-sm leading-7" style={{ color: DS.textMuted }}>"{t.body}"</p>
                  <div>
                    <div className="font-semibold text-white">{t.name}</div>
                    <div className="text-xs" style={{ color: DS.textSubtle }}>{t.role}</div>
                  </div>
                </motion.div>
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" className="px-6 py-28" style={{ background: DS.surface }}>
        <div className="mx-auto max-w-3xl">
          <BlurFade className="mb-3 text-center">
            <span className="text-xs font-bold uppercase tracking-widest" style={{ color: DS.primary }}>FAQ</span>
          </BlurFade>
          <BlurFade delay={0.08} className="mb-14 text-center">
            <h2 className="text-white" style={{ fontSize: 'clamp(28px,4vw,48px)', fontWeight: 800, letterSpacing: '-0.03em' }}>
              Before you sign up.
            </h2>
          </BlurFade>
          <BlurFade delay={0.12}>
            <div className="rounded-2xl px-6 sm:px-8" style={{ border: `1px solid ${DS.border}`, background: DS.bg }}>
              {FAQS.map((faq, i) => (
                <FAQItem key={faq.question} question={faq.question} answer={faq.answer}
                  isOpen={openFAQ === i} onToggle={() => setOpenFAQ(openFAQ === i ? null : i)} />
              ))}
            </div>
          </BlurFade>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="px-6 py-28">
        <div className="mx-auto max-w-4xl">
          <BlurFade>
            <motion.div whileHover={{ scale: 1.005 }} transition={{ duration: 0.3 }}
              className="relative overflow-hidden rounded-3xl p-12 text-center"
              style={{ background: `linear-gradient(135deg, rgba(14,165,233,0.12), rgba(124,58,237,0.1))`, border: `1px solid rgba(14,165,233,0.2)` }}>
              <div className="pointer-events-none absolute -right-20 -top-20 h-[300px] w-[300px] rounded-full blur-[80px]" style={{ background: 'rgba(14,165,233,0.12)' }} />
              <div className="pointer-events-none absolute -bottom-20 -left-20 h-[300px] w-[300px] rounded-full blur-[80px]" style={{ background: 'rgba(249,115,22,0.08)' }} />
              <div className="relative">
                <Bot className="mx-auto mb-6 h-12 w-12" style={{ color: DS.primary }} />
                <h2 className="text-white" style={{ fontSize: 'clamp(28px,5vw,52px)', fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.03em', marginBottom: 16 }}>
                  Ready to build at scale?
                </h2>
                <p className="mx-auto mb-10 max-w-lg text-lg" style={{ color: DS.textMuted }}>
                  Create an account, connect your keys, and start generating images, videos, and full content calendars today.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-4">
                  <button type="button" onClick={() => setAuthModal('register')}
                    className="group inline-flex cursor-pointer items-center gap-2 rounded-full px-10 py-4 text-sm font-semibold text-white transition-all hover:scale-105"
                    style={{ background: DS.cta, boxShadow: `0 4px 24px ${DS.ctaGlow}` }}>
                    Create Free Account
                    <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
                  </button>
                  <button type="button" onClick={() => setAuthModal('login')}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-full px-8 py-4 text-sm font-medium transition hover:text-white"
                    style={{ border: `1px solid ${DS.border}`, color: DS.textMuted, background: 'transparent' }}>
                    Sign In
                  </button>
                </div>
                <div className="mt-8 flex flex-wrap items-center justify-center gap-6 text-sm" style={{ color: DS.textSubtle }}>
                  {['Hosted access', 'Bring your own keys', 'Built for scale'].map((item) => (
                    <span key={item} className="flex items-center gap-1.5">
                      <Check className="h-3.5 w-3.5" style={{ color: DS.primary }} /> {item}
                    </span>
                  ))}
                </div>
              </div>
            </motion.div>
          </BlurFade>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="px-8 py-10" style={{ borderTop: `1px solid ${DS.border}` }}>
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-lg" style={{ background: `linear-gradient(135deg, ${DS.primary}, #7c3aed)` }}>
                <Sparkles className="h-3.5 w-3.5 text-white" />
              </div>
              <span className="font-bold text-white" style={{ fontFamily: DS.font }}>Kyros Studio</span>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-6">
              {[['Features', 'features'], ['How It Works', 'how-it-works'], ['FAQ', 'faq']].map(([label, id]) => (
                <button key={id} type="button" onClick={() => scrollTo(id)}
                  className="cursor-pointer text-sm transition-colors hover:text-white"
                  style={{ color: DS.textSubtle, background: 'none', border: 'none' }}>
                  {label}
                </button>
              ))}
              <a href={TELEGRAM_URL} target="_blank" rel="noreferrer" className="text-sm transition-colors hover:text-white" style={{ color: DS.textSubtle }}>
                Telegram
              </a>
            </div>
            <p className="text-xs" style={{ color: DS.textSubtle }}>© 2025 Kyros Studio. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
