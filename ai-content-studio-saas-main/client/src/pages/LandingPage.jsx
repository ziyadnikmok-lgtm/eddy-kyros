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
  bg:          '#0A0A0A',
  surface:     '#111111',
  surfaceAlt:  '#0E0E0E',
  border:      'rgba(255,255,255,0.06)',
  borderMid:   'rgba(255,255,255,0.1)',
  coral:       '#FF4D6D',
  coralGlow:   'rgba(255,77,109,0.18)',
  coralDim:    'rgba(255,77,109,0.08)',
  salmon:      '#FF8C69',
  text:        '#F5F5F5',
  textMuted:   'rgba(245,245,245,0.45)',
  textSubtle:  'rgba(245,245,245,0.18)',
  display:     "'Syne', sans-serif",
  body:        "'DM Sans', sans-serif",
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
                {['Character identity locked every run', 'Nano Bypass — no AI detection flags', '200 images batched in one session', 'Auto Post across all platforms'].map((item) => (
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
  { num: '03', name: 'Nano Bypass',       icon: ShieldCheck,  color: '#34d399',  title: "AI content that doesn't get flagged.",   body: 'Strips AI fingerprints — metadata, statistical patterns — before you post. Passes current detection on Instagram, TikTok, and Reddit.' },
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
    features: ['Everything in Free', '200 generations/mo', 'Nano Bypass', 'Reel Builder', 'Brand Voice', 'Priority support'],
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
  { feature: 'AI detection bypass',      kyros: true,     mid: false,       gen: false,       photo: 'N/A'    },
  { feature: 'Auto post & schedule',     kyros: true,     mid: false,       gen: false,       photo: false    },
  { feature: 'Available 24/7',           kyros: true,     mid: true,        gen: true,        photo: false    },
  { feature: 'Cost per 100 images',      kyros: '~$0.25', mid: '~$12',      gen: '~$8',       photo: '~$800+' },
];

const TESTIMONIALS = [
  { name: 'Sarah M.',  role: 'OFM Agency — 8 accounts',   body: 'Kyros replaced 4 different tools. Character consistency saves us 3 shoots a month. The ROI was obvious in week one.', stars: 5 },
  { name: 'Alex R.',   role: 'Content Manager',            body: 'We batch a full month of content for 3 clients in one afternoon. The auto planner basically runs the operation.', stars: 5 },
  { name: 'Jordan K.', role: 'Solo Creator',               body: 'Had 10 reference shots. Now I have 300 consistent pieces. I haven\'t booked a shoot in 2 months.', stars: 5 },
];

const FAQS = [
  { question: 'Does the character look the same every time?',    answer: 'Yes. Kyros locks face geometry, skin tone, body type, and aesthetic at the character level. Photo Match reinforces this by using your reference as the identity anchor — not the scene source.' },
  { question: 'Will content get flagged as AI?',                 answer: 'Nano Bypass strips AI fingerprints — metadata, statistical patterns — from every image before you post. It passes current detection on Instagram, TikTok, and Reddit.' },
  { question: 'How many images can I generate per month?',       answer: 'Free gives you 10 to test. Pro gives 200/mo for solo creators and small agencies. Unlimited removes all caps — batch runs of 50–200+ images, no limits.' },
  { question: 'Can I manage multiple models or characters?',     answer: 'Yes. Every plan supports multiple characters. Agencies running 5–20 accounts create one character per creator and generate for all of them from one workspace.' },
  { question: 'Do I need design or editing skills?',             answer: 'No. Drop in a reference photo, describe the scene, Kyros handles everything. Reel Builder adds transitions and captions automatically.' },
  { question: 'Is there a free trial?',                          answer: 'The Free plan is permanently free — no credit card. Pro and Unlimited can be cancelled anytime.' },
];

const REPLACED = ['Midjourney', 'RunwayML', 'CapCut', 'Later.com', 'Character.ai', 'Lightroom', 'Adobe Firefly', 'Canva', 'Buffer', 'Hootsuite'];

// ─── Hero Background ─────────────────────────────────────────────────────────────
const BG_IMAGES = ['/hero-bg/noir1.jpg', '/hero-bg/noir2.jpg', '/hero-bg/noir3.jpg'];

function HeroBg() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx(i => (i + 1) % BG_IMAGES.length), 7000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Crossfading AI-generated backgrounds */}
      {BG_IMAGES.map((src, i) => (
        <motion.div key={src} className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: `url(${src})`, filter: 'brightness(0.45) saturate(80%)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: i === idx ? 1 : 0 }}
          transition={{ duration: 2.8, ease: 'easeInOut' }}
        />
      ))}

      {/* Coral glow at top — editorial light leak */}
      <motion.div className="absolute" style={{
        top: '-10%', right: '-5%',
        width: 600, height: 500,
        background: `radial-gradient(ellipse, ${DS.coralGlow} 0%, transparent 65%)`,
        filter: 'blur(40px)',
      }}
        animate={{ opacity: [0.6, 1, 0.6], scale: [1, 1.08, 1] }}
        transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div className="absolute" style={{
        bottom: '10%', left: '-5%',
        width: 400, height: 400,
        background: 'radial-gradient(ellipse, rgba(255,140,105,0.08) 0%, transparent 65%)',
        filter: 'blur(60px)',
      }}
        animate={{ opacity: [0.4, 0.8, 0.4], x: [0, 20, 0] }}
        transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
      />

      {/* Grid overlay */}
      <div className="absolute inset-0" style={{
        backgroundImage: `linear-gradient(${DS.border} 1px, transparent 1px), linear-gradient(90deg, ${DS.border} 1px, transparent 1px)`,
        backgroundSize: '80px 80px',
        opacity: 0.6,
      }} />

      {/* Gradient bottom fade */}
      <div className="absolute bottom-0 inset-x-0 h-72"
        style={{ background: `linear-gradient(to bottom, transparent 0%, ${DS.bg} 100%)` }} />

      {/* Grain overlay via SVG filter */}
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <filter id="grain-hero">
            <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="4" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
        </defs>
      </svg>
      <div className="absolute inset-0" style={{ filter: 'url(#grain-hero)', opacity: 0.04, mixBlendMode: 'overlay' }} />
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
        *, *::before, *::after { box-sizing: border-box; }
        html { scroll-behavior: smooth; }
        @keyframes marquee { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        @keyframes pulse-coral { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        @keyframes coral-shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        .coral-text {
          background: linear-gradient(90deg, #FF4D6D 0%, #FF8C69 40%, #FFB347 65%, #FF4D6D 100%);
          background-size: 200% auto;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          animation: coral-shimmer 4s linear infinite;
        }
        .feature-row-mobile { display: none; }
        @media (max-width: 768px) {
          .feature-row-desktop { display: none; }
          .feature-row-mobile { display: block; }
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

      {/* ── Navbar ── */}
      <motion.nav
        initial={{ y: -50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.5, ease: 'easeOut' }}
        className="fixed inset-x-0 top-0 z-50 flex items-center justify-between px-6 py-4 sm:px-10"
        style={{
          background: scrolled ? 'rgba(10,10,10,0.92)' : 'transparent',
          backdropFilter: scrolled ? 'blur(24px)' : 'none',
          borderBottom: scrolled ? `1px solid ${DS.border}` : '1px solid transparent',
          transition: 'all 0.35s ease',
        }}>
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg"
            style={{ background: `linear-gradient(135deg, ${DS.coral}, ${DS.salmon})` }}>
            <Sparkles className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-sm font-bold tracking-tight text-white" style={{ fontFamily: DS.display }}>Kyros Studio</span>
        </div>
        {/* Nav links */}
        <div className="hidden items-center gap-8 md:flex">
          {[['Features', 'features'], ['How It Works', 'how-it-works'], ['Pricing', 'pricing'], ['FAQ', 'faq']].map(([label, id]) => (
            <button key={id} type="button" onClick={() => scrollTo(id)}
              className="cursor-pointer text-xs font-semibold uppercase tracking-widest transition-colors hover:text-white"
              style={{ color: DS.textMuted, background: 'none', border: 'none', fontFamily: DS.display }}>
              {label}
            </button>
          ))}
        </div>
        {/* CTA */}
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => openAuth('login')}
            className="hidden h-8 cursor-pointer items-center rounded-full px-5 text-xs font-semibold uppercase tracking-widest transition sm:inline-flex"
            style={{ color: DS.textMuted, background: 'none', border: `1px solid ${DS.border}`, fontFamily: DS.display }}>
            Sign In
          </button>
          <button type="button" onClick={() => openAuth('register')}
            className="h-8 cursor-pointer rounded-full px-5 text-xs font-semibold uppercase tracking-widest text-white transition hover:opacity-85"
            style={{ background: DS.coral, fontFamily: DS.display, letterSpacing: '0.08em' }}>
            Start Free
          </button>
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
              Built for OFM agencies
            </motion.div>

            {/* Headline — split weight editorial, product-specific */}
            <div className="mb-8">
              {[
                { text: 'Your AI content keeps getting flagged.', weight: 400, delay: 0.1 },
                { text: "Ours doesn't.", weight: 800, delay: 0.2 },
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
                Generate anything. Post everything.
              </motion.h1>
            </div>

            {/* Sub */}
            <motion.p initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.45, duration: 0.6 }}
              className="mb-10 text-lg leading-[1.8] max-w-xl"
              style={{ color: DS.textMuted, fontFamily: DS.body }}>
              Kyros strips AI fingerprints before you post, locks your character's identity across every image, and batches 200 pieces of content in one run. No flags. No shoots. No gaps.
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
              {['554+ users', '925+ images generated', 'Free to start'].map((label) => (
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
      <section className="px-6 py-20" style={{ borderBottom: `1px solid ${DS.border}` }}>
        <div className="mx-auto max-w-5xl grid grid-cols-2 gap-10 md:grid-cols-4">
          {[
            { value: 554, suffix: '+', label: 'Active Users' },
            { value: 200, suffix: '+', label: 'Images / Week' },
            { value: 3, suffix: 'x', label: 'Faster Than Shoots' },
            { value: 49, prefix: '$', label: 'Unlimited / mo' },
          ].map((s, i) => (
            <BlurFade key={s.label} delay={0.08 * i}>
              <div>
                <div className="text-5xl font-black tracking-tight mb-1.5"
                  style={{ fontFamily: DS.display, color: i === 0 ? DS.coral : DS.text, letterSpacing: '-0.04em' }}>
                  <CountUp end={s.value} suffix={s.suffix} prefix={s.prefix} />
                </div>
                <div className="text-xs uppercase tracking-widest" style={{ color: DS.textSubtle, fontFamily: DS.display }}>{s.label}</div>
              </div>
            </BlurFade>
          ))}
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" className="px-6 py-24">
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
      <section id="how-it-works" className="px-6 py-24" style={{ background: DS.surface }}>
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
              { step: '03', title: 'Post Without Thinking', body: 'Nano Bypass strips AI fingerprints. Auto Post schedules across platforms at peak times. Your account runs 24/7 without you.' },
            ].map((item, i) => (
              <BlurFade key={item.step} delay={0.1 * i}>
                <motion.div whileHover={{ y: -5 }} transition={{ duration: 0.2 }}
                  className="rounded-2xl p-8" style={{ border: `1px solid ${DS.border}`, background: DS.bg }}>
                  <div className="mb-5 text-6xl font-black" style={{ fontFamily: DS.display, color: `${DS.coral}20`, lineHeight: 1, letterSpacing: '-0.04em' }}>{item.step}</div>
                  <h3 className="mb-3 text-lg font-bold text-white" style={{ fontFamily: DS.display, letterSpacing: '-0.02em' }}>{item.title}</h3>
                  <p className="text-sm leading-[1.9]" style={{ color: DS.textMuted }}>{item.body}</p>
                </motion.div>
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      {/* ── Comparison ── */}
      <section className="px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <BlurFade className="mb-14">
            <p className="text-xs font-bold uppercase tracking-[0.25em] mb-4" style={{ color: DS.coral, fontFamily: DS.display }}>Comparison</p>
            <h2 style={{ fontFamily: DS.display, fontSize: 'clamp(28px,5vw,48px)', fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.08 }}>
              Built for OFM.<br /><span style={{ color: DS.textMuted, fontWeight: 400 }}>Nothing else comes close.</span>
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
      <section style={{ background: DS.surface, borderTop: `1px solid ${DS.border}`, borderBottom: `1px solid ${DS.border}` }}>
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
      <section id="pricing" className="px-6 py-24">
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
                <motion.div whileHover={{ y: -6 }} transition={{ duration: 0.2 }}
                  className="relative flex h-full flex-col rounded-3xl p-8"
                  style={{
                    border: `1px solid ${plan.popular ? `${DS.coral}50` : DS.border}`,
                    background: plan.popular ? `linear-gradient(160deg, rgba(255,77,109,0.08) 0%, ${DS.surface} 35%)` : DS.surface,
                    boxShadow: plan.popular ? `0 0 60px ${DS.coralDim}` : 'none',
                  }}>
                  {plan.popular && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-4 py-1 text-[11px] font-bold uppercase tracking-widest"
                      style={{ background: DS.coral, color: '#fff', fontFamily: DS.display }}>
                      Popular
                    </span>
                  )}
                  <div className="mb-6">
                    <h3 className="mb-4 text-sm font-bold uppercase tracking-widest" style={{ fontFamily: DS.display, color: plan.popular ? DS.coral : DS.textSubtle }}>{plan.name}</h3>
                    <div className="flex items-baseline gap-1">
                      <span className="text-5xl font-black text-white" style={{ fontFamily: DS.display, letterSpacing: '-0.04em' }}>{plan.price}</span>
                      <span className="text-sm" style={{ color: DS.textSubtle }}>{plan.meta}</span>
                    </div>
                  </div>
                  <ul className="flex-1 space-y-3 mb-8">
                    {plan.features.map((feat) => (
                      <li key={feat} className="flex items-start gap-2.5 text-sm leading-[1.7]" style={{ color: 'rgba(245,245,245,0.75)', fontFamily: DS.body }}>
                        <Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: DS.coral }} />
                        {feat}
                      </li>
                    ))}
                  </ul>
                  <button type="button" onClick={() => openAuth('register')}
                    className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-full py-3.5 text-sm font-semibold uppercase tracking-wider text-white transition-all hover:opacity-85"
                    style={{
                      background: plan.popular ? DS.coral : 'rgba(255,255,255,0.07)',
                      border: plan.popular ? 'none' : `1px solid ${DS.border}`,
                      fontFamily: DS.display,
                      letterSpacing: '0.08em',
                    }}>
                    {plan.cta} <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </motion.div>
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" className="px-6 py-24" style={{ background: DS.surface }}>
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
                  {['No credit card', 'Cancel anytime', '554+ agencies already inside'].map((t) => (
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
