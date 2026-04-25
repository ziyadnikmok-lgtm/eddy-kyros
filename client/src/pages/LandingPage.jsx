import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useInView } from 'framer-motion';
import {
  ArrowRight, ArrowUpRight,
  BarChart3, Bot, Calendar, Camera, Check,
  ChevronDown, Layers, MessageSquare,
  ShieldCheck, Sparkles, Star, Video, X,
} from 'lucide-react';

const TELEGRAM_URL = 'https://t.me/Kyros_Studio';

// ─── Design System — Noir + Hot Coral ──────────────────────────────────────────
const DS = {
  bg:          '#080808',
  surface:     '#0F0F0F',
  surfaceAlt:  '#0C0C0C',
  border:      'rgba(255,255,255,0.07)',
  borderMid:   'rgba(255,255,255,0.12)',
  coral:       '#FF3D5A',
  coralGlow:   'rgba(255,61,90,0.2)',
  coralDim:    'rgba(255,61,90,0.09)',
  salmon:      '#FF7A5C',
  text:        '#F0EEE8',
  textMuted:   'rgba(240,238,232,0.42)',
  textSubtle:  'rgba(240,238,232,0.16)',
  display:     "'Clash Display', 'Syne', sans-serif",
  body:        "'Cabinet Grotesk', 'DM Sans', sans-serif",
};

// ─── Utility ────────────────────────────────────────────────────────────────────
function BlurFade({ children, className, delay = 0, yOffset = 20 }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-50px' });
  return (
    <motion.div ref={ref} className={className}
      initial={{ opacity: 0, y: yOffset, filter: 'blur(8px)' }}
      animate={inView ? { opacity: 1, y: 0, filter: 'blur(0px)' } : undefined}
      transition={{ delay, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
      {children}
    </motion.div>
  );
}

function CountUp({ end, suffix = '', prefix = '' }) {
  const [n, setN] = useState(0);
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });
  useEffect(() => {
    if (!inView) return;
    let s = 0;
    const step = end / (1800 / 16);
    const t = setInterval(() => {
      s += step;
      if (s >= end) { setN(end); clearInterval(t); } else setN(Math.floor(s));
    }, 16);
    return () => clearInterval(t);
  }, [inView, end]);
  return <span ref={ref}>{prefix}{n}{suffix}</span>;
}

function FAQItem({ question, answer, isOpen, onToggle }) {
  return (
    <div style={{ borderBottom: `1px solid ${DS.border}` }}>
      <button type="button" onClick={onToggle}
        className="flex w-full cursor-pointer items-center justify-between gap-4 py-6 text-left"
        style={{ background: 'none', border: 'none', color: isOpen ? DS.coral : DS.text }}>
        <span className="text-[15px] font-medium" style={{ fontFamily: DS.body }}>{question}</span>
        <motion.div animate={{ rotate: isOpen ? 45 : 0 }} transition={{ duration: 0.2 }}>
          <span style={{ color: DS.textSubtle, fontSize: 20, lineHeight: 1 }}>+</span>
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: 'easeOut' }} className="overflow-hidden">
            <p className="pb-6 text-sm leading-[1.9]" style={{ color: DS.textMuted, fontFamily: DS.body }}>{answer}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Auth Modal ─────────────────────────────────────────────────────────────────
function AuthModal({ mode, onClose, onSuccess, onNavigate, refCode }) {
  const [tab, setTab] = useState(mode || 'register');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [confirm, setConfirm] = useState('');
  const [registerMsg, setRegisterMsg] = useState('');
  const [registerError, setRegisterError] = useState('');
  const [registerLoading, setRegisterLoading] = useState(false);
  const match = confirm.length === 0 || form.password === confirm;

  const handleLogin = async (e) => {
    e.preventDefault(); setLoginLoading(true); setLoginError('');
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: loginEmail, password: loginPassword, keepSignedIn }) });
      const data = await res.json();
      if (!res.ok) setLoginError(typeof data.error === 'string' ? data.error : (data.error?.message || 'Login failed'));
      else onSuccess?.();
    } catch { setLoginError('Network error'); }
    setLoginLoading(false);
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    if (form.password !== confirm) { setRegisterError('Passwords do not match'); return; }
    if (form.password.length < 8) { setRegisterError('Min 8 characters'); return; }
    setRegisterLoading(true); setRegisterError(''); setRegisterMsg('');
    try {
      const storedRef = refCode || localStorage.getItem('kyros_ref') || undefined;
      const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ ...form, ...(storedRef ? { ref_code: storedRef } : {}) }) });
      const data = await res.json();
      if (!res.ok) setRegisterError(typeof data.error === 'string' ? data.error : (data.error?.message || 'Registration failed'));
      else setRegisterMsg(data.message || 'Account created. Check your email to verify.');
    } catch { setRegisterError('Network error'); }
    setRegisterLoading(false);
  };

  const inputStyle = { height: 48, width: '100%', borderRadius: 999, padding: '0 20px', fontSize: 14, color: DS.text, background: 'rgba(255,255,255,0.04)', border: `1px solid ${DS.border}`, outline: 'none', fontFamily: DS.body };

  return (
    <AnimatePresence>
      <motion.div className="fixed inset-0 z-[80] flex items-center justify-center p-4"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
        <button type="button" className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} aria-label="Close" />
        <motion.div className="relative z-10 w-full max-w-5xl overflow-hidden"
          initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 18 }} transition={{ duration: 0.25 }}
          style={{ borderRadius: 28, border: `1px solid ${DS.border}`, background: '#0C0C0C', boxShadow: '0 40px 120px rgba(0,0,0,0.7)' }}>
          <div className="grid lg:grid-cols-[1fr_1fr]">
            {/* Left panel */}
            <div className="relative hidden overflow-hidden border-r lg:flex flex-col justify-between p-10" style={{ borderColor: DS.border }}>
              <div className="absolute inset-0" style={{ background: `radial-gradient(circle at 30% 40%, ${DS.coralGlow}, transparent 60%)` }} />
              <div className="relative">
                <div className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs uppercase tracking-widest mb-8"
                  style={{ border: `1px solid ${DS.coral}30`, background: DS.coralDim, color: DS.coral, fontFamily: DS.display }}>
                  Kyros Studio
                </div>
                <h2 className="text-white leading-[1]" style={{ fontSize: 48, fontWeight: 800, fontFamily: DS.display, letterSpacing: '-0.03em' }}>
                  Stop booking<br /><span style={{ color: DS.coral }}>shoots.</span>
                </h2>
                <p className="mt-5 text-sm leading-7" style={{ color: DS.textMuted, fontFamily: DS.body }}>
                  Create your account and start generating at scale today.
                </p>
              </div>
              <div className="relative space-y-2.5">
                {['Character identity locked every run', 'Unrestricted generation — 90% success rate', '200 images batched in one session', 'Auto Post across all platforms'].map((item) => (
                  <div key={item} className="flex items-center gap-3 rounded-2xl px-4 py-3"
                    style={{ border: `1px solid ${DS.border}`, background: 'rgba(255,255,255,0.02)' }}>
                    <Check className="h-4 w-4 shrink-0" style={{ color: DS.coral }} />
                    <span className="text-sm" style={{ color: 'rgba(245,245,245,0.7)', fontFamily: DS.body }}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
            {/* Right panel */}
            <div className="relative p-6 sm:p-8">
              <button type="button" onClick={onClose}
                className="absolute right-4 top-4 rounded-full p-2 transition-colors hover:bg-white/10"
                style={{ border: `1px solid ${DS.border}`, background: 'none', color: DS.textMuted }}>
                <X className="h-4 w-4" />
              </button>
              <div className="flex gap-1.5 rounded-full p-1 mb-6"
                style={{ border: `1px solid ${DS.border}`, background: 'rgba(255,255,255,0.02)' }}>
                {['register', 'login'].map((t) => (
                  <button key={t} type="button" onClick={() => setTab(t)}
                    className="flex-1 rounded-full py-2 text-sm font-medium transition"
                    style={{ background: tab === t ? DS.coral : 'transparent', color: tab === t ? '#fff' : DS.textMuted, fontFamily: DS.body }}>
                    {t === 'register' ? 'Create Account' : 'Sign In'}
                  </button>
                ))}
              </div>
              <AnimatePresence mode="wait">
                {tab === 'login' ? (
                  <motion.form key="login" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }}
                    transition={{ duration: 0.2 }} onSubmit={handleLogin} className="space-y-4">
                    <div className="mb-6">
                      <p className="text-[11px] uppercase tracking-[0.3em] mb-2" style={{ color: DS.textSubtle, fontFamily: DS.display }}>Sign in</p>
                      <h3 className="text-3xl font-bold text-white" style={{ fontFamily: DS.display, letterSpacing: '-0.02em' }}>Welcome back.</h3>
                    </div>
                    {loginError && <div className="rounded-2xl px-4 py-3 text-sm" style={{ border: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.08)', color: '#fca5a5' }}>{loginError}</div>}
                    <input type="text" placeholder="Email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} required style={inputStyle} />
                    <input type="password" placeholder="Password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} required style={inputStyle} />
                    <div className="flex justify-between items-center px-1">
                      <label className="flex items-center gap-2.5 text-sm cursor-pointer" style={{ color: DS.textMuted, fontFamily: DS.body }}>
                        <input type="checkbox" checked={keepSignedIn} onChange={e => setKeepSignedIn(e.target.checked)} className="h-4 w-4" />
                        Keep me signed in
                      </label>
                      <button type="button" onClick={() => { onClose?.(); onNavigate?.('forgot-password'); }}
                        className="text-sm transition-colors hover:text-white" style={{ color: DS.textMuted, background: 'none', border: 'none', fontFamily: DS.body }}>
                        Forgot?
                      </button>
                    </div>
                    <button type="submit" disabled={loginLoading}
                      className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full text-sm font-semibold text-white transition hover:opacity-90"
                      style={{ background: DS.coral, opacity: loginLoading ? 0.6 : 1, fontFamily: DS.display }}>
                      {loginLoading ? 'Signing in…' : <><span>Sign In</span><ArrowRight className="h-4 w-4" /></>}
                    </button>
                  </motion.form>
                ) : (
                  <motion.form key="register" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }}
                    transition={{ duration: 0.2 }} onSubmit={handleRegister} className="space-y-4">
                    <div className="mb-6">
                      <p className="text-[11px] uppercase tracking-[0.3em] mb-2" style={{ color: DS.textSubtle, fontFamily: DS.display }}>Register</p>
                      <h3 className="text-3xl font-bold text-white" style={{ fontFamily: DS.display, letterSpacing: '-0.02em' }}>Start building.</h3>
                    </div>
                    {registerMsg && <div className="rounded-2xl px-4 py-3 text-sm leading-6" style={{ border: '1px solid rgba(52,211,153,0.2)', background: 'rgba(52,211,153,0.08)', color: '#6ee7b7' }}>{registerMsg}</div>}
                    {registerError && <div className="rounded-2xl px-4 py-3 text-sm" style={{ border: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.08)', color: '#fca5a5' }}>{registerError}</div>}
                    <input type="text" placeholder="Name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required style={inputStyle} />
                    <input type="email" placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required style={inputStyle} />
                    <input type="password" placeholder="Password (min 8 chars)" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required style={inputStyle} />
                    <input type="password" placeholder="Confirm password" value={confirm} onChange={e => setConfirm(e.target.value)} required
                      style={{ ...inputStyle, borderColor: match ? DS.border : 'rgba(239,68,68,0.4)' }} />
                    {!match && <p className="text-xs px-2" style={{ color: '#fca5a5' }}>Passwords don't match.</p>}
                    <button type="submit" disabled={registerLoading || !match}
                      className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full text-sm font-semibold text-white transition hover:opacity-90"
                      style={{ background: DS.coral, opacity: (registerLoading || !match) ? 0.6 : 1, fontFamily: DS.display }}>
                      {registerLoading ? 'Creating…' : <><span>Create Account</span><ArrowRight className="h-4 w-4" /></>}
                    </button>
                  </motion.form>
                )}
              </AnimatePresence>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ─── Data ────────────────────────────────────────────────────────────────────────
const FEATURES = [
  { num: '01', name: 'Photo Match',       icon: Camera,       color: DS.coral,   title: '3 photos → 50 pieces of content',        body: 'Drop in a real reference photo. Kyros replaces the person with your character — same face, body, skin tone, aesthetic. Multiply every shoot by 10x.' },
  { num: '02', name: 'Character Engine',  icon: Sparkles,     color: '#a78bfa',  title: 'Build once. Generate forever.',          body: 'Set face, body type, style, and personality once. Every generation after that locks to that identity. No drift. No inconsistency.' },
  { num: '03', name: 'Unrestricted Engine', icon: ShieldCheck,  color: '#34d399',  title: '90% of images others block — generated here.',   body: 'While other tools refuse prompts or cap output, Kyros uses a proprietary pipeline that generates what you actually need. Then strips metadata and AI patterns so it posts clean everywhere.' },
  { num: '04', name: 'Batch Generator',   icon: Layers,       color: DS.salmon,  title: '200 images. One run. Walk away.',        body: 'Set the prompt, pick the character, hit batch. Come back to a full week of consistent content. No babysitting required.' },
  { num: '05', name: 'Reel Builder',      icon: Video,        color: '#f472b6',  title: 'Static images → viral reels.',           body: 'Transitions, pacing, caption overlays — automated. Output goes straight to TikTok, Instagram Reels, and Reddit format.' },
  { num: '06', name: 'Auto Post',         icon: Calendar,     color: '#60a5fa',  title: 'Set it Sunday. Posts all week.',         body: 'Schedules across Instagram, TikTok, and X at peak audience times. Your account runs 24/7 without you touching it.' },
  { num: '07', name: 'Brand Voice',       icon: MessageSquare, color: '#fbbf24', title: 'Every caption sounds like her.',         body: 'Learns exactly how the model writes. Generates captions in her tone — flirty, direct, personalized. Not generic AI slop.' },
  { num: '08', name: 'Profile Analyzer',  icon: BarChart3,    color: '#e879f9',  title: 'Reverse-engineer any account.',          body: 'Paste any Instagram or TikTok URL. Reads their top content, posting frequency, and hooks. Tells you exactly what\'s working.' },
];

const PRICING = [
  {
    name: 'Free',     price: '$0',  meta: '/mo', popular: false,
    features: ['Character creation', '10 image generations', 'Profile analyzer', 'Community support'],
    cta: 'Get Started Free',
  },
  {
    name: 'Pro',      price: '$19', meta: '/mo', popular: true,
    features: ['Everything in Free', '200 generations/mo', 'Unrestricted engine', 'Reel Builder', 'Brand Voice', 'Priority support'],
    cta: 'Start Pro',
  },
  {
    name: 'Unlimited', price: '$49', meta: '/mo', popular: false,
    features: ['Everything in Pro', 'Unlimited generations', 'Batch (200/run)', 'Auto Post', 'LoRA datasets', 'Scene Memory', 'Team access'],
    cta: 'Go Unlimited',
  },
];

const COMPARISON = [
  { feature: 'Character identity lock',  kyros: true,     mid: false,       gen: false,       photo: true     },
  { feature: 'Unlimited generation',     kyros: true,     mid: 'limited',   gen: 'limited',   photo: false    },
  { feature: 'Unrestricted generation',  kyros: '90%',    mid: '~40%',      gen: '~35%',      photo: 'N/A'    },
  { feature: 'Auto post & schedule',     kyros: true,     mid: false,       gen: false,       photo: false    },
  { feature: 'Available 24/7',           kyros: true,     mid: true,        gen: true,        photo: false    },
  { feature: 'Cost per 100 images',      kyros: '~$0.25', mid: '~$12',      gen: '~$8',       photo: '~$800+' },
];

const TESTIMONIALS = [
  { name: 'Sarah M.',  role: 'Agency Owner — 8 creator accounts', body: 'Every other tool blocks half the prompts. Kyros generates what we actually need — same character, every time. We dropped 4 subscriptions the first week.', stars: 5 },
  { name: 'Alex R.',   role: 'Content Manager',            body: 'We batch a full month of content for 3 creators in one afternoon. The 90% generation rate is real — nothing else comes close.', stars: 5 },
  { name: 'Jordan K.', role: 'Solo Creator',               body: 'Had 10 reference shots. Now I have 300 consistent pieces that actually post without getting flagged. Haven\'t booked a shoot in 2 months.', stars: 5 },
];

const FAQS = [
  { question: 'Does the character look the same every time?',    answer: 'Yes. Kyros locks face geometry, skin tone, body type, and aesthetic at the character level. Photo Match reinforces this by using your reference as the identity anchor — not the scene source.' },
  { question: 'Will content get flagged as AI?',                 answer: 'Our pipeline strips AI fingerprints — metadata, statistical patterns — from every image before export. Content posts clean on Instagram, TikTok, Reddit, and OF without triggering detection.' },
  { question: 'How many images can I generate per month?',       answer: 'Free gives you 10 to test. Pro gives 200/mo for solo creators and small agencies. Unlimited removes all caps — batch runs of 50–200+ images, no limits.' },
  { question: 'Can I manage multiple models or characters?',     answer: 'Yes. Every plan supports multiple characters. Agencies running 5–20 accounts create one character per creator and generate for all of them from one workspace.' },
  { question: 'Do I need design or editing skills?',             answer: 'No. Drop in a reference photo, describe the scene, Kyros handles everything. Reel Builder adds transitions and captions automatically.' },
  { question: 'Is there a free trial?',                          answer: 'The Free plan is permanently free — no credit card. Pro and Unlimited can be cancelled anytime.' },
];

// ─── Section Decoration Components ──────────────────────────────────────────────────
function DotGrid({ opacity = 0.4, size = 28, color = 'rgba(255,255,255,0.15)' }) {
  return (
    <div className="absolute inset-0 pointer-events-none" style={{
      backgroundImage: `radial-gradient(circle, ${color} 1px, transparent 1px)`,
      backgroundSize: `${size}px ${size}px`,
      opacity,
    }} />
  );
}

function DiagonalLines({ opacity = 0.03 }) {
  return (
    <div className="absolute inset-0 pointer-events-none" style={{
      backgroundImage: `repeating-linear-gradient(45deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.06) 1px, transparent 1px, transparent 40px)`,
      opacity,
    }} />
  );
}

function GlowLine({ side = 'left', color = 'rgba(255,61,90,0.3)', top = '20%', height = '60%' }) {
  const isLeft = side === 'left';
  return (
    <div className="absolute pointer-events-none" style={{
      [isLeft ? 'left' : 'right']: 0,
      top,
      width: 1,
      height,
      background: `linear-gradient(to bottom, transparent, ${color}, transparent)`,
      boxShadow: `0 0 20px 2px ${color}`,
    }} />
  );
}

function FloatingShapes({ coral }) {
  const shapes = [
    { size: 180, x: '8%',  y: '15%', rot: 12,  opacity: 0.04 },
    { size: 120, x: '88%', y: '30%', rot: -20, opacity: 0.05 },
    { size: 80,  x: '70%', y: '70%', rot: 45,  opacity: 0.06 },
    { size: 200, x: '20%', y: '75%', rot: -8,  opacity: 0.03 },
  ];
  return (
    <>
      {shapes.map((s, i) => (
        <div key={i} className="absolute pointer-events-none" style={{
          left: s.x, top: s.y,
          width: s.size, height: s.size,
          border: `1px solid ${coral}`,
          borderRadius: i % 2 === 0 ? '30%' : '50%',
          transform: `rotate(${s.rot}deg)`,
          opacity: s.opacity,
        }} />
      ))}
    </>
  );
}

function Particles({ count = 24, coral }) {
  const items = Array.from({ length: count }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    y: Math.random() * 100,
    size: Math.random() * 2.5 + 0.5,
    dur: Math.random() * 8 + 6,
    delay: Math.random() * 6,
    color: i % 5 === 0 ? coral : i % 3 === 0 ? 'rgba(255,122,92,0.6)' : 'rgba(255,255,255,0.25)',
  }));
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {items.map(p => (
        <motion.div key={p.id}
          className="absolute rounded-full"
          style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.size, height: p.size, background: p.color }}
          animate={{ opacity: [0, 1, 0], y: [0, -30, -60], scale: [1, 1.2, 0] }}
          transition={{ duration: p.dur, delay: p.delay, repeat: Infinity, ease: 'easeOut' }}
        />
      ))}
    </div>
  );
}

const REPLACED = ['Midjourney', 'RunwayML', 'CapCut', 'Later.com', 'Character.ai', 'Lightroom', 'Adobe Firefly', 'Canva', 'Buffer', 'Hootsuite'];

// ─── Hero Background — Animated Mesh Orbs ────────────────────────────────────────
function HeroBg() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Deep gradient base */}
      <div className="absolute inset-0" style={{
        background: `radial-gradient(ellipse 80% 60% at 50% -10%, rgba(255,61,90,0.14) 0%, transparent 60%),
                     radial-gradient(ellipse 60% 40% at 80% 60%, rgba(255,122,92,0.07) 0%, transparent 55%),
                     radial-gradient(ellipse 50% 60% at 10% 80%, rgba(120,40,200,0.05) 0%, transparent 55%),
                     ${DS.bg}`,
      }} />

      {/* Orb 1 — main coral */}
      <div style={{
        position: 'absolute', top: '-15%', right: '5%',
        width: 700, height: 700, borderRadius: '50%',
        background: `radial-gradient(circle, rgba(255,61,90,0.22) 0%, rgba(255,61,90,0.08) 40%, transparent 70%)`,
        filter: 'blur(60px)', animation: 'orb-drift-1 18s ease-in-out infinite',
      }} />

      {/* Orb 2 — salmon warm */}
      <div style={{
        position: 'absolute', bottom: '10%', left: '-8%',
        width: 550, height: 550, borderRadius: '50%',
        background: `radial-gradient(circle, rgba(255,122,92,0.14) 0%, rgba(255,122,92,0.05) 45%, transparent 70%)`,
        filter: 'blur(70px)', animation: 'orb-drift-2 22s ease-in-out infinite',
      }} />

      {/* Orb 3 — cool purple accent */}
      <div style={{
        position: 'absolute', top: '40%', left: '40%',
        width: 400, height: 400, borderRadius: '50%',
        background: `radial-gradient(circle, rgba(139,92,246,0.09) 0%, transparent 65%)`,
        filter: 'blur(80px)', animation: 'orb-drift-3 26s ease-in-out infinite',
      }} />

      {/* Fine grid */}
      <div className="absolute inset-0" style={{
        backgroundImage: `linear-gradient(rgba(255,255,255,0.028) 1px, transparent 1px),
                          linear-gradient(90deg, rgba(255,255,255,0.028) 1px, transparent 1px)`,
        backgroundSize: '60px 60px',
      }} />

      {/* Floating particles */}
      <Particles count={30} coral={`rgba(255,61,90,0.7)`} />

      {/* Horizontal light beams */}
      <div className="absolute pointer-events-none" style={{
        top: '35%', left: 0, right: 0, height: 1,
        background: `linear-gradient(90deg, transparent 0%, rgba(255,61,90,0.15) 30%, rgba(255,61,90,0.08) 60%, transparent 100%)`,
      }} />
      <div className="absolute pointer-events-none" style={{
        top: '65%', left: 0, right: 0, height: 1,
        background: `linear-gradient(90deg, transparent 10%, rgba(255,122,92,0.08) 40%, rgba(255,122,92,0.12) 70%, transparent 100%)`,
      }} />

      {/* Vignette */}
      <div className="absolute inset-0" style={{
        background: `radial-gradient(ellipse 100% 100% at 50% 50%, transparent 40%, rgba(8,8,8,0.7) 100%)`,
      }} />

      {/* Bottom fade */}
      <div className="absolute bottom-0 inset-x-0" style={{
        height: '45%',
        background: `linear-gradient(to bottom, transparent 0%, ${DS.bg} 100%)`,
      }} />
    </div>
  );
}

// ─── Marquee ─────────────────────────────────────────────────────────────────────
function Marquee() {
  const items = [...REPLACED, ...REPLACED];
  return (
    <div className="overflow-hidden py-8 relative" style={{ borderTop: `1px solid ${DS.border}`, borderBottom: `1px solid ${DS.border}` }}>
      <div className="flex gap-6" style={{ animation: 'marquee 22s linear infinite', width: 'max-content' }}>
        {items.map((name, i) => (
          <span key={i} className="text-sm font-medium line-through whitespace-nowrap px-5 py-1.5 rounded-full"
            style={{ fontFamily: DS.body, color: DS.textSubtle, border: `1px solid ${DS.border}`, background: 'rgba(255,255,255,0.02)' }}>
            {name}
          </span>
        ))}
        <span className="text-sm font-semibold whitespace-nowrap px-5 py-1.5 rounded-full"
          style={{ fontFamily: DS.display, color: DS.coral, border: `1px solid ${DS.coral}40`, background: DS.coralDim }}>
          ✦ Kyros Studio
        </span>
      </div>
    </div>
  );
}

// ─── Feature Row ─────────────────────────────────────────────────────────────────
function FeatureRow({ feature, index }) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });

  return (
    <motion.div ref={ref} onClick={() => setExpanded(!expanded)}
      initial={{ opacity: 0, x: -16 }} animate={inView ? { opacity: 1, x: 0 } : undefined}
      transition={{ delay: index * 0.06, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="group cursor-pointer"
      style={{ borderBottom: `1px solid ${DS.border}` }}>
      <div className="grid items-center gap-6 py-5 transition-all duration-200"
        style={{ gridTemplateColumns: '52px 160px 1fr 24px' }}>
        {/* Number */}
        <span className="text-xs font-bold tracking-widest" style={{ color: DS.textSubtle, fontFamily: DS.display }}>
          {feature.num}
        </span>
        {/* Name */}
        <span className="font-bold text-sm tracking-wide transition-colors duration-200 group-hover:text-white"
          style={{ color: expanded ? DS.coral : DS.text, fontFamily: DS.display, letterSpacing: '0.04em' }}>
          {feature.name}
        </span>
        {/* Title */}
        <span className="text-sm" style={{ color: DS.textMuted, fontFamily: DS.body }}>
          {expanded ? (
            <span className="leading-[1.8]" style={{ color: 'rgba(245,245,245,0.65)' }}>{feature.body}</span>
          ) : feature.title}
        </span>
        {/* Icon */}
        <motion.div animate={{ rotate: expanded ? 45 : 0 }} transition={{ duration: 0.2 }}>
          <span style={{ color: expanded ? DS.coral : DS.textSubtle, fontSize: 18, lineHeight: 1 }}>+</span>
        </motion.div>
      </div>
    </motion.div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────────
export default function LandingPage({ onNavigate, initialAuthModal = null }) {
  const [openFAQ, setOpenFAQ] = useState(0);
  const [authModal, setAuthModal] = useState(initialAuthModal);
  const [scrolled, setScrolled] = useState(false);
  const [refCode, setRefCode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('ref') || localStorage.getItem('kyros_ref') || '';
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('ref');
    if (code) { localStorage.setItem('kyros_ref', code); setRefCode(code); }
  }, []);

  useEffect(() => { setAuthModal(initialAuthModal || null); }, [initialAuthModal]);
  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 50);
    window.addEventListener('scroll', fn, { passive: true });
    return () => window.removeEventListener('scroll', fn);
  }, []);

  const openAuth = (m) => setAuthModal(m);
  const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="min-h-screen overflow-x-hidden" style={{ background: DS.bg, color: DS.text, fontFamily: DS.body }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500;600&display=swap');
        @import url('https://api.fontshare.com/v2/css?f[]=clash-display@400,500,600,700&f[]=cabinet-grotesk@400,500,700&display=swap');
        *, *::before, *::after { box-sizing: border-box; }
        html { scroll-behavior: smooth; }
        body { overflow-x: hidden; }

        /* Grain overlay */
        body::after {
          content: '';
          position: fixed;
          inset: 0;
          z-index: 9999;
          pointer-events: none;
          opacity: 0.032;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
          background-size: 180px 180px;
        }

        @keyframes marquee { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        @keyframes pulse-coral { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        @keyframes coral-shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        @keyframes orb-drift-1 {
          0%,100% { transform: translate(0,0) scale(1); }
          33% { transform: translate(60px,-40px) scale(1.12); }
          66% { transform: translate(-30px,50px) scale(0.9); }
        }
        @keyframes orb-drift-2 {
          0%,100% { transform: translate(0,0) scale(1); }
          40% { transform: translate(-70px,60px) scale(1.08); }
          70% { transform: translate(40px,-30px) scale(0.95); }
        }
        @keyframes orb-drift-3 {
          0%,100% { transform: translate(0,0) scale(1); }
          50% { transform: translate(50px,40px) scale(1.15); }
        }
        .coral-text {
          background: linear-gradient(90deg, #FF3D5A 0%, #FF7A5C 40%, #FFB347 65%, #FF3D5A 100%);
          background-size: 200% auto;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          animation: coral-shimmer 5s linear infinite;
        }
        .feature-row-mobile { display: none; }
        @media (max-width: 768px) {
          .feature-row-desktop { display: none; }
          .feature-row-mobile { display: block; }
        }
        /* Premium card hover */
        .kyros-card {
          transition: transform 0.4s cubic-bezier(0.32,0.72,0,1), box-shadow 0.4s cubic-bezier(0.32,0.72,0,1), border-color 0.3s ease;
        }
        .kyros-card:hover {
          transform: translateY(-6px);
          box-shadow: 0 24px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,61,90,0.12);
        }
      `}</style>

      {/* Auth Modal */}
      {authModal && (
        <AuthModal mode={authModal}
          refCode={refCode}
          onClose={() => { setAuthModal(null); if (initialAuthModal) onNavigate?.('landing', { replace: true }); }}
          onSuccess={() => { setAuthModal(null); window.location.reload(); }}
          onNavigate={(page) => { setAuthModal(null); onNavigate?.(page); }} />
      )}

      {/* ── Navbar — Floating Pill ── */}
      <motion.nav
        initial={{ y: -60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.6, ease: [0.22,1,0.36,1] }}
        className="fixed inset-x-0 top-0 z-50 flex justify-center pt-5 px-4"
        style={{ pointerEvents: 'none' }}>
        <div className="flex w-full max-w-4xl items-center justify-between rounded-full px-5 py-2.5"
          style={{
            pointerEvents: 'all',
            background: scrolled ? 'rgba(8,8,8,0.88)' : 'rgba(8,8,8,0.6)',
            backdropFilter: 'blur(28px) saturate(180%)',
            border: `1px solid ${scrolled ? DS.borderMid : DS.border}`,
            boxShadow: scrolled ? '0 8px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)' : '0 4px 24px rgba(0,0,0,0.3)',
            transition: 'all 0.4s cubic-bezier(0.32,0.72,0,1)',
          }}>
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg"
              style={{ background: `linear-gradient(135deg, ${DS.coral}, ${DS.salmon})`, boxShadow: `0 0 16px ${DS.coralGlow}` }}>
              <Sparkles className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="text-sm font-bold tracking-tight" style={{ fontFamily: DS.display, color: DS.text }}>Kyros Studio</span>
          </div>
          {/* Nav links */}
          <div className="hidden items-center gap-7 md:flex">
            {[['Features', 'features'], ['How It Works', 'how-it-works'], ['Pricing', 'pricing'], ['FAQ', 'faq']].map(([label, id]) => (
              <button key={id} type="button" onClick={() => scrollTo(id)}
                className="cursor-pointer text-[11px] font-semibold uppercase tracking-widest transition-colors hover:text-white"
                style={{ color: DS.textMuted, background: 'none', border: 'none', fontFamily: DS.display }}>
                {label}
              </button>
            ))}
          </div>
          {/* CTA */}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => openAuth('login')}
              className="hidden h-8 cursor-pointer items-center rounded-full px-4 text-[11px] font-semibold uppercase tracking-widest transition hover:text-white sm:inline-flex"
              style={{ color: DS.textMuted, background: 'none', border: `1px solid ${DS.border}`, fontFamily: DS.display }}>
              Sign In
            </button>
            <button type="button" onClick={() => openAuth('register')}
              className="h-8 cursor-pointer rounded-full px-5 text-[11px] font-semibold uppercase tracking-widest text-white transition-all hover:scale-[1.04] hover:opacity-90"
              style={{ background: `linear-gradient(135deg, ${DS.coral}, ${DS.salmon})`, fontFamily: DS.display, letterSpacing: '0.08em', boxShadow: `0 4px 20px ${DS.coralGlow}` }}>
              Start Free
            </button>
          </div>
        </div>
      </motion.nav>

      {/* ── Hero ── */}
      <section className="relative min-h-screen flex flex-col justify-center px-6 sm:px-10 pt-28 pb-20">
        <HeroBg />
        <div className="relative z-10 max-w-7xl mx-auto w-full">
          <div className="max-w-3xl">
            {/* Eyebrow */}
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
              className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 mb-10 text-[11px] font-semibold uppercase tracking-[0.2em]"
              style={{ border: `1px solid ${DS.coral}35`, background: DS.coralDim, color: DS.coral, fontFamily: DS.display }}>
              <span className="h-1.5 w-1.5 rounded-full inline-block" style={{ background: DS.coral, animation: 'pulse-coral 2s infinite' }} />
              The #1 content engine for creators
            </motion.div>

            {/* Headline — split weight editorial, product-specific */}
            <div className="mb-8">
              {[
                { text: 'Other tools cap your generations.', weight: 400, delay: 0.1 },
                { text: 'Ours gives you 90% more.', weight: 800, delay: 0.2 },
              ].map(({ text, weight, delay }) => (
                <motion.div key={text} initial={{ opacity: 0, y: 30, filter: 'blur(10px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ delay, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}>
                  <h1 style={{
                    fontFamily: DS.display,
                    fontSize: 'clamp(40px, 7vw, 80px)',
                    lineHeight: 1.05,
                    letterSpacing: '-0.035em',
                    fontWeight: weight,
                    color: weight === 400 ? DS.textMuted : DS.text,
                    margin: 0,
                  }}>
                    {text}
                  </h1>
                </motion.div>
              ))}
              <motion.h1 initial={{ opacity: 0, y: 30, filter: 'blur(10px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ delay: 0.3, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                className="coral-text"
                style={{ fontFamily: DS.display, fontSize: 'clamp(40px, 7vw, 80px)', lineHeight: 1.05, letterSpacing: '-0.035em', fontWeight: 800, margin: 0 }}>
                Create once. Monetize everywhere.
              </motion.h1>
            </div>

            {/* Sub */}
            <motion.p initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.45, duration: 0.6 }}
              className="mb-10 text-lg leading-[1.8] max-w-xl"
              style={{ color: DS.textMuted, fontFamily: DS.body }}>
              Every other platform limits what you can generate. Kyros uses an unrestricted engine that produces 90% of images other tools block — then strips every AI fingerprint so your content posts clean. One character, 200 images per batch, zero restrictions.
            </motion.p>

            {/* CTAs */}
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.55, duration: 0.6 }}
              className="flex flex-wrap items-center gap-4 mb-12">
              <button type="button" onClick={() => openAuth('register')}
                className="group inline-flex cursor-pointer items-center gap-2 rounded-full px-8 py-3.5 text-sm font-semibold text-white transition-all hover:opacity-90 hover:scale-[1.02]"
                style={{ background: DS.coral, fontFamily: DS.display, letterSpacing: '0.04em', boxShadow: `0 8px 32px ${DS.coralGlow}` }}>
                Start for Free
                <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
              </button>
              <a href={TELEGRAM_URL} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full px-6 py-3.5 text-sm font-medium transition hover:text-white"
                style={{ color: DS.textMuted, border: `1px solid ${DS.border}`, fontFamily: DS.body }}>
                Join Telegram <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            </motion.div>

            {/* Proof pills */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.7, duration: 0.6 }}
              className="flex flex-wrap gap-3">
              {['554+ creators', '90% generation success rate', 'Free to start'].map((label) => (
                <span key={label} className="text-xs rounded-full px-4 py-1.5"
                  style={{ color: DS.textSubtle, border: `1px solid ${DS.border}`, background: 'rgba(255,255,255,0.02)', fontFamily: DS.body }}>
                  {label}
                </span>
              ))}
            </motion.div>
          </div>
        </div>
      </section>

      {/* ── Marquee ── */}
      <Marquee />

      {/* ── Stats ── */}
      <section className="px-6 py-24" style={{ borderBottom: `1px solid ${DS.border}` }}>
        <div className="mx-auto max-w-5xl grid grid-cols-2 gap-6 md:grid-cols-4">
          {[
            { value: 554, suffix: '+', label: 'Active Creators' },
            { value: 90,  suffix: '%', label: 'Generation Rate' },
            { value: 200, suffix: '+', label: 'Images / Session' },
            { value: 49,  prefix: '$', label: 'Unlimited / mo' },
          ].map((s, i) => (
            <BlurFade key={s.label} delay={0.08 * i}>
              <div className="rounded-2xl p-6" style={{ border: `1px solid ${DS.border}`, background: `linear-gradient(160deg, rgba(255,255,255,0.03) 0%, transparent 100%)` }}>
                <div className="text-5xl font-black tracking-tight mb-1.5"
                  style={{ fontFamily: DS.display, color: i === 0 ? DS.coral : i === 1 ? DS.salmon : DS.text, letterSpacing: '-0.04em' }}>
                  <CountUp end={s.value} suffix={s.suffix} prefix={s.prefix} />
                </div>
                <div className="text-xs uppercase tracking-widest" style={{ color: DS.textSubtle, fontFamily: DS.display }}>{s.label}</div>
              </div>
            </BlurFade>
          ))}
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" className="relative px-6 py-24 overflow-hidden">
        {/* Dot grid background */}
        <DotGrid opacity={0.35} size={32} color="rgba(255,255,255,0.12)" />
        {/* Side glow lines */}
        <GlowLine side="left" color="rgba(255,61,90,0.25)" top="10%" height="80%" />
        <GlowLine side="right" color="rgba(255,122,92,0.15)" top="30%" height="50%" />
        {/* Corner orb */}
        <div className="absolute pointer-events-none" style={{
          bottom: '-10%', right: '-5%', width: 400, height: 400, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255,61,90,0.07) 0%, transparent 70%)',
          filter: 'blur(60px)',
        }} />
        <div className="mx-auto max-w-5xl">
          <BlurFade className="mb-14">
            <p className="text-xs font-bold uppercase tracking-[0.25em] mb-4" style={{ color: DS.coral, fontFamily: DS.display }}>What It Does</p>
            <h2 style={{ fontFamily: DS.display, fontSize: 'clamp(28px,5vw,52px)', fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1.08 }}>
              Replace your entire<br />
              <span style={{ color: DS.textMuted, fontWeight: 400 }}>content stack.</span>
            </h2>
          </BlurFade>

          {/* Desktop: editorial table */}
          <div className="feature-row-desktop" style={{ borderTop: `1px solid ${DS.border}` }}>
            {FEATURES.map((f, i) => <FeatureRow key={f.num} feature={f} index={i} />)}
          </div>

          {/* Mobile: card grid */}
          <div className="feature-row-mobile grid grid-cols-1 gap-4 sm:grid-cols-2">
            {FEATURES.map((f, i) => (
              <BlurFade key={f.num} delay={0.06 * i}>
                <motion.div whileHover={{ scale: 1.02 }} transition={{ duration: 0.2 }}
                  className="rounded-2xl p-5" style={{ border: `1px solid ${DS.border}`, background: DS.surface }}>
                  <div className="mb-3 inline-flex rounded-xl p-2.5" style={{ background: `${f.color}18`, border: `1px solid ${f.color}30` }}>
                    <f.icon className="h-4 w-4" style={{ color: f.color }} />
                  </div>
                  <p className="text-xs font-bold uppercase tracking-widest mb-1.5" style={{ color: DS.textSubtle, fontFamily: DS.display }}>{f.name}</p>
                  <h3 className="text-sm font-semibold text-white mb-2" style={{ fontFamily: DS.display }}>{f.title}</h3>
                  <p className="text-xs leading-[1.8]" style={{ color: DS.textMuted }}>{f.body}</p>
                </motion.div>
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      {/* ── How It Works ── */}
      <section id="how-it-works" className="relative px-6 py-24 overflow-hidden" style={{ background: DS.surface }}>
        {/* Diagonal lines texture */}
        <DiagonalLines opacity={1} />
        {/* Top edge glow */}
        <div className="absolute top-0 inset-x-0 pointer-events-none" style={{
          height: 1,
          background: `linear-gradient(90deg, transparent 0%, ${DS.coral}40 30%, ${DS.coral}60 50%, ${DS.coral}40 70%, transparent 100%)`,
          boxShadow: `0 0 30px 2px ${DS.coralGlow}`,
        }} />
        {/* Background orb */}
        <div className="absolute pointer-events-none" style={{
          top: '-20%', left: '50%', transform: 'translateX(-50%)',
          width: 600, height: 600, borderRadius: '50%',
          background: `radial-gradient(circle, rgba(255,61,90,0.05) 0%, transparent 65%)`,
          filter: 'blur(80px)',
        }} />
        <div className="mx-auto max-w-5xl">
          <BlurFade className="mb-14">
            <p className="text-xs font-bold uppercase tracking-[0.25em] mb-4" style={{ color: DS.coral, fontFamily: DS.display }}>How It Works</p>
            <h2 style={{ fontFamily: DS.display, fontSize: 'clamp(28px,5vw,48px)', fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.08 }}>
              Up and running<br /><span style={{ color: DS.textMuted, fontWeight: 400 }}>in 20 minutes.</span>
            </h2>
          </BlurFade>
          <div className="grid gap-5 md:grid-cols-3">
            {[
              { step: '01', title: 'Build Your Character', body: 'Upload 3–5 reference photos. Lock face, body, style, aesthetic. Your character is the identity anchor for every generation going forward.' },
              { step: '02', title: 'Generate at Scale', body: 'Set a prompt or clone a viral format. Batch generates 50–200 consistent images. All look like the same person, every time.' },
              { step: '03', title: 'Post Without Thinking', body: 'Every image runs through our cleanup pipeline — AI fingerprints stripped automatically. Auto Post schedules across platforms at peak times. Your account runs 24/7.' },
            ].map((item, i) => (
              <BlurFade key={item.step} delay={0.1 * i}>
                {/* Double-bezel card */}
                <div className="rounded-[2rem] p-[3px]"
                  style={{ background: `linear-gradient(135deg, rgba(255,61,90,0.15) 0%, rgba(255,255,255,0.04) 50%, rgba(255,122,92,0.08) 100%)` }}>
                  <div className="rounded-[calc(2rem-3px)] p-8 h-full"
                    style={{ background: `linear-gradient(160deg, rgba(255,255,255,0.04) 0%, ${DS.bg} 60%)`, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)' }}>
                    <div className="mb-5 text-6xl font-black" style={{ fontFamily: DS.display, color: `${DS.coral}18`, lineHeight: 1, letterSpacing: '-0.04em' }}>{item.step}</div>
                    <h3 className="mb-3 text-lg font-bold" style={{ fontFamily: DS.display, letterSpacing: '-0.02em', color: DS.text }}>{item.title}</h3>
                    <p className="text-sm leading-[1.9]" style={{ color: DS.textMuted }}>{item.body}</p>
                  </div>
                </div>
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      {/* ── Comparison ── */}
      <section className="relative px-6 py-24 overflow-hidden">
        {/* Scanlines */}
        <div className="absolute inset-0 pointer-events-none" style={{
          backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(255,255,255,0.008) 3px, rgba(255,255,255,0.008) 4px)',
          backgroundSize: '100% 4px',
        }} />
        <FloatingShapes coral={`rgba(255,61,90,0.5)`} />
        {/* Left accent orb */}
        <div className="absolute pointer-events-none" style={{
          left: '-10%', top: '30%', width: 350, height: 350, borderRadius: '50%',
          background: `radial-gradient(circle, rgba(255,61,90,0.06) 0%, transparent 70%)`,
          filter: 'blur(60px)',
        }} />
        <div className="mx-auto max-w-5xl">
          <BlurFade className="mb-14">
            <p className="text-xs font-bold uppercase tracking-[0.25em] mb-4" style={{ color: DS.coral, fontFamily: DS.display }}>Comparison</p>
            <h2 style={{ fontFamily: DS.display, fontSize: 'clamp(28px,5vw,48px)', fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.08 }}>
              Built for creators.<br /><span style={{ color: DS.textMuted, fontWeight: 400 }}>Nothing else comes close.</span>
            </h2>
          </BlurFade>
          <BlurFade delay={0.12}>
            <div className="overflow-x-auto rounded-2xl" style={{ border: `1px solid ${DS.border}` }}>
              <table className="w-full border-collapse">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${DS.border}` }}>
                    <th className="py-4 pl-6 pr-4 text-left text-xs font-bold uppercase tracking-widest" style={{ color: DS.textSubtle, fontFamily: DS.display }}>Feature</th>
                    {[{l:'Kyros Studio',h:true},{l:'MidJourney'},{l:'Generic AI'},{l:'Photographers'}].map(({ l, h }) => (
                      <th key={l} className="px-5 py-4 text-center text-xs font-bold uppercase tracking-widest"
                        style={{ color: h ? DS.coral : DS.textSubtle, fontFamily: DS.display }}>{l}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COMPARISON.map((row, i) => (
                    <tr key={row.feature} style={{ borderBottom: i < COMPARISON.length - 1 ? `1px solid ${DS.border}` : 'none', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                      <td className="py-4 pl-6 pr-4 text-sm" style={{ color: 'rgba(245,245,245,0.7)', fontFamily: DS.body }}>{row.feature}</td>
                      {[row.kyros, row.mid, row.gen, row.photo].map((val, ci) => (
                        <td key={ci} className="px-5 py-4 text-center">
                          {typeof val === 'boolean'
                            ? val
                              ? <Check className="mx-auto h-4 w-4" style={{ color: ci === 0 ? DS.coral : DS.textSubtle }} />
                              : <X className="mx-auto h-4 w-4" style={{ color: 'rgba(255,77,109,0.35)' }} />
                            : <span className="text-xs" style={{ color: ci === 0 ? DS.text : DS.textSubtle, fontFamily: DS.body }}>{val}</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </BlurFade>
        </div>
      </section>

      {/* ── Testimonials ── */}
      <section className="relative overflow-hidden" style={{ background: DS.surface, borderTop: `1px solid ${DS.border}`, borderBottom: `1px solid ${DS.border}` }}>
        <DotGrid opacity={0.25} size={40} color="rgba(255,61,90,0.2)" />
        <FloatingShapes coral={`rgba(255,122,92,0.6)`} />
        {/* Glow orb center */}
        <div className="absolute pointer-events-none" style={{
          top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 500, height: 300, borderRadius: '50%',
          background: `radial-gradient(ellipse, rgba(255,61,90,0.05) 0%, transparent 70%)`,
          filter: 'blur(60px)',
        }} />
        <div className="mx-auto max-w-5xl px-6 py-24">
          <BlurFade className="mb-14">
            <p className="text-xs font-bold uppercase tracking-[0.25em] mb-4" style={{ color: DS.coral, fontFamily: DS.display }}>Results</p>
            <h2 style={{ fontFamily: DS.display, fontSize: 'clamp(28px,5vw,48px)', fontWeight: 800, letterSpacing: '-0.03em' }}>
              Agencies love it.<br /><span style={{ color: DS.textMuted, fontWeight: 400 }}>Shoots don't.</span>
            </h2>
          </BlurFade>
          <div className="grid gap-5 md:grid-cols-3">
            {TESTIMONIALS.map((t, i) => (
              <BlurFade key={t.name} delay={0.1 * i}>
                <motion.div whileHover={{ y: -4 }} transition={{ duration: 0.2 }}
                  className="rounded-2xl p-7 flex flex-col h-full"
                  style={{ border: `1px solid ${DS.border}`, background: DS.bg }}>
                  <div className="flex gap-1 mb-5">
                    {Array.from({ length: t.stars }).map((_, j) => (
                      <Star key={j} className="h-3.5 w-3.5 fill-current" style={{ color: DS.coral }} />
                    ))}
                  </div>
                  <p className="text-sm leading-[1.9] flex-1 mb-6" style={{ color: DS.textMuted }}>"{t.body}"</p>
                  <div>
                    <div className="font-bold text-sm text-white" style={{ fontFamily: DS.display }}>{t.name}</div>
                    <div className="text-xs mt-0.5" style={{ color: DS.textSubtle }}>{t.role}</div>
                  </div>
                </motion.div>
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" className="relative px-6 py-24 overflow-hidden">
        {/* Mesh gradient background */}
        <div className="absolute inset-0 pointer-events-none" style={{
          background: `radial-gradient(ellipse 70% 50% at 50% 0%, rgba(255,61,90,0.06) 0%, transparent 60%),
                       radial-gradient(ellipse 50% 40% at 100% 80%, rgba(255,122,92,0.04) 0%, transparent 55%)`,
        }} />
        <DotGrid opacity={0.2} size={36} color="rgba(255,255,255,0.1)" />
        <GlowLine side="right" color="rgba(255,61,90,0.2)" top="15%" height="70%" />
        <div className="mx-auto max-w-5xl">
          <BlurFade className="mb-14">
            <p className="text-xs font-bold uppercase tracking-[0.25em] mb-4" style={{ color: DS.coral, fontFamily: DS.display }}>Pricing</p>
            <h2 style={{ fontFamily: DS.display, fontSize: 'clamp(28px,5vw,48px)', fontWeight: 800, letterSpacing: '-0.03em' }}>
              Start free.<br /><span style={{ color: DS.textMuted, fontWeight: 400 }}>Upgrade when it works.</span>
            </h2>
          </BlurFade>
          <div className="grid gap-5 md:grid-cols-3">
            {PRICING.map((plan, i) => (
              <BlurFade key={plan.name} delay={0.1 * i}>
                <div className="kyros-card relative flex h-full flex-col rounded-[2rem] p-[2px] cursor-default"
                  style={{
                    background: plan.popular
                      ? `linear-gradient(145deg, ${DS.coral} 0%, ${DS.salmon} 50%, rgba(255,255,255,0.08) 100%)`
                      : `linear-gradient(145deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 100%)`,
                  }}>
                  <div className="flex flex-col h-full rounded-[calc(2rem-2px)] p-8"
                    style={{
                      background: plan.popular
                        ? `linear-gradient(160deg, rgba(255,61,90,0.12) 0%, ${DS.surface} 40%)`
                        : DS.surface,
                      boxShadow: plan.popular ? `0 0 80px ${DS.coralDim}` : 'none',
                    }}>
                    {plan.popular && (
                      <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 rounded-full px-5 py-1 text-[11px] font-bold uppercase tracking-widest"
                        style={{ background: `linear-gradient(135deg, ${DS.coral}, ${DS.salmon})`, color: '#fff', fontFamily: DS.display, boxShadow: `0 4px 20px ${DS.coralGlow}` }}>
                        Most Popular
                      </span>
                    )}
                    <div className="mb-6">
                      <h3 className="mb-4 text-sm font-bold uppercase tracking-widest" style={{ fontFamily: DS.display, color: plan.popular ? DS.coral : DS.textSubtle }}>{plan.name}</h3>
                      <div className="flex items-baseline gap-1">
                        <span className="text-5xl font-black" style={{ fontFamily: DS.display, letterSpacing: '-0.04em', color: DS.text }}>{plan.price}</span>
                        <span className="text-sm" style={{ color: DS.textSubtle }}>{plan.meta}</span>
                      </div>
                    </div>
                    <ul className="flex-1 space-y-3 mb-8">
                      {plan.features.map((feat) => (
                        <li key={feat} className="flex items-start gap-2.5 text-sm leading-[1.7]" style={{ color: 'rgba(240,238,232,0.75)', fontFamily: DS.body }}>
                          <Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: DS.coral }} />
                          {feat}
                        </li>
                      ))}
                    </ul>
                    <button type="button" onClick={() => openAuth('register')}
                      className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-full py-3.5 text-sm font-semibold uppercase tracking-wider transition-all hover:opacity-90 hover:scale-[1.02]"
                      style={{
                        background: plan.popular ? `linear-gradient(135deg, ${DS.coral}, ${DS.salmon})` : 'rgba(255,255,255,0.07)',
                        border: plan.popular ? 'none' : `1px solid ${DS.border}`,
                        color: '#fff',
                        fontFamily: DS.display,
                        letterSpacing: '0.08em',
                        boxShadow: plan.popular ? `0 4px 24px ${DS.coralGlow}` : 'none',
                      }}>
                      {plan.cta} <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" className="relative px-6 py-24 overflow-hidden" style={{ background: DS.surface }}>
        <DiagonalLines opacity={1} />
        <GlowLine side="left" color="rgba(255,61,90,0.2)" top="20%" height="60%" />
        <div className="mx-auto max-w-3xl">
          <BlurFade className="mb-14">
            <p className="text-xs font-bold uppercase tracking-[0.25em] mb-4" style={{ color: DS.coral, fontFamily: DS.display }}>FAQ</p>
            <h2 style={{ fontFamily: DS.display, fontSize: 'clamp(28px,5vw,48px)', fontWeight: 800, letterSpacing: '-0.03em' }}>Before you sign up.</h2>
          </BlurFade>
          <BlurFade delay={0.1}>
            <div>
              {FAQS.map((faq, i) => (
                <FAQItem key={faq.question} question={faq.question} answer={faq.answer}
                  isOpen={openFAQ === i} onToggle={() => setOpenFAQ(openFAQ === i ? null : i)} />
              ))}
            </div>
          </BlurFade>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="px-6 py-24">
        <div className="mx-auto max-w-4xl">
          <BlurFade>
            <motion.div whileHover={{ scale: 1.005 }} transition={{ duration: 0.3 }}
              className="relative overflow-hidden rounded-3xl px-10 py-16 text-center"
              style={{ background: `linear-gradient(135deg, rgba(255,77,109,0.1) 0%, rgba(255,140,105,0.06) 60%, rgba(10,10,10,1) 100%)`, border: `1px solid ${DS.coral}25` }}>
              <div className="absolute -right-20 -top-20 h-72 w-72 rounded-full"
                style={{ background: `radial-gradient(circle, ${DS.coralGlow} 0%, transparent 70%)`, filter: 'blur(40px)' }} />
              <div className="absolute -bottom-16 -left-16 h-56 w-56 rounded-full"
                style={{ background: 'radial-gradient(circle, rgba(255,140,105,0.08) 0%, transparent 70%)', filter: 'blur(40px)' }} />
              <div className="relative">
                <p className="text-xs font-bold uppercase tracking-[0.3em] mb-6" style={{ color: DS.coral, fontFamily: DS.display }}>Get Started</p>
                <h2 className="mb-5 text-white" style={{ fontFamily: DS.display, fontSize: 'clamp(28px,5vw,52px)', fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.035em' }}>
                  Ready to build<br />at scale?
                </h2>
                <p className="mx-auto mb-10 max-w-md text-base leading-[1.9]" style={{ color: DS.textMuted, fontFamily: DS.body }}>
                  Create an account, build your character, and generate a week of content in the next 20 minutes.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-4 mb-10">
                  <button type="button" onClick={() => openAuth('register')}
                    className="group inline-flex cursor-pointer items-center gap-2 rounded-full px-10 py-4 text-sm font-semibold uppercase tracking-widest text-white transition-all hover:scale-[1.02] hover:opacity-90"
                    style={{ background: DS.coral, fontFamily: DS.display, boxShadow: `0 8px 32px ${DS.coralGlow}` }}>
                    Start for Free
                    <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
                  </button>
                  <button type="button" onClick={() => openAuth('login')}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-full px-8 py-4 text-sm font-medium transition hover:text-white"
                    style={{ color: DS.textMuted, border: `1px solid ${DS.border}`, background: 'none', fontFamily: DS.body }}>
                    Sign In
                  </button>
                </div>
                <div className="flex flex-wrap justify-center gap-6 text-xs" style={{ color: DS.textSubtle }}>
                  {['No credit card', 'Cancel anytime', '554+ creators already inside'].map((t) => (
                    <span key={t} className="flex items-center gap-1.5" style={{ fontFamily: DS.body }}>
                      <Check className="h-3 w-3" style={{ color: DS.coral }} /> {t}
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
        <div className="mx-auto max-w-6xl flex flex-col items-center justify-between gap-6 sm:flex-row">
          <div className="flex items-center gap-2.5">
            <div className="flex h-6 w-6 items-center justify-center rounded-lg"
              style={{ background: `linear-gradient(135deg, ${DS.coral}, ${DS.salmon})` }}>
              <Sparkles className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="font-bold text-sm text-white" style={{ fontFamily: DS.display }}>Kyros Studio</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-6">
            {[['Features', 'features'], ['How It Works', 'how-it-works'], ['Pricing', 'pricing'], ['FAQ', 'faq']].map(([label, id]) => (
              <button key={id} type="button" onClick={() => scrollTo(id)}
                className="cursor-pointer text-xs uppercase tracking-widest transition-colors hover:text-white"
                style={{ color: DS.textSubtle, background: 'none', border: 'none', fontFamily: DS.display }}>
                {label}
              </button>
            ))}
            <a href={TELEGRAM_URL} target="_blank" rel="noreferrer"
              className="text-xs uppercase tracking-widest transition-colors hover:text-white"
              style={{ color: DS.textSubtle, fontFamily: DS.display }}>
              Telegram
            </a>
          </div>
          <p className="text-xs" style={{ color: DS.textSubtle, fontFamily: DS.body }}>© 2025 Kyros Studio</p>
        </div>
      </footer>
    </div>
  );
}
