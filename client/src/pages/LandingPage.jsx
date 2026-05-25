import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useInView } from 'framer-motion';

const TELEGRAM_URL = 'https://t.me/Kyros_Studio';
const DISCORD_URL  = 'https://discord.gg/sYMNpMDASe';

// ─── Siren Design System ──────────────────────────────────────────────────────
const DS = {
  bg:           '#000000',
  surface:      '#070707',
  surfaceAlt:   '#0A0A0A',
  border:       'rgba(255,255,255,0.06)',
  borderMid:    'rgba(255,255,255,0.1)',
  crimson:      '#CC1124',
  crimsonBright:'#FF1A2E',
  crimsonGlow:  'rgba(204,17,36,0.22)',
  crimsonDim:   'rgba(204,17,36,0.07)',
  text:         '#F2EDE8',
  textMuted:    'rgba(242,237,232,0.42)',
  textSubtle:   'rgba(242,237,232,0.14)',
  display:      "'Bebas Neue', 'Impact', sans-serif",
  mono:         "'Space Mono', 'Courier New', monospace",
  body:         "'DM Sans', 'Helvetica Neue', sans-serif",
};

// ─── Font Loader ─────────────────────────────────────────────────────────────
function useFonts() {
  useEffect(() => {
    if (document.getElementById('siren-fonts')) return;
    const link = document.createElement('link');
    link.id = 'siren-fonts';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:ital,wght@0,400;0,700;1,400&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&display=swap';
    document.head.appendChild(link);
  }, []);
}

// ─── Content ──────────────────────────────────────────────────────────────────
const FEATURES = [
  { num: '01', tag: 'Photo Match',       accent: DS.crimsonBright, title: '3 photos → 50 pieces of content', body: 'Drop in a real reference photo. Kyros replaces the person with your character — same face, body, skin tone, aesthetic. Multiply every shoot by 10×.' },
  { num: '02', tag: 'Character Engine',  accent: '#7C5CFC',         title: 'Build once. Generate forever.',   body: 'Set face, body type, style, and personality once. Every generation after that locks to that identity. No drift. No inconsistency.' },
  { num: '03', tag: 'Unrestricted',      accent: '#00C896',         title: '90% of images others block — generated here.', body: 'While other tools refuse prompts, Kyros uses a proprietary pipeline that generates what you actually need. Metadata and AI fingerprints stripped on export.' },
  { num: '04', tag: 'Batch Generator',   accent: '#F97316',         title: '200 images. One run. Walk away.',  body: 'Set the prompt, pick the character, hit batch. Come back to a full week of consistent content. No babysitting required.' },
  { num: '05', tag: 'Reel Builder',      accent: '#EC4899',         title: 'Static images → viral reels.',    body: 'Transitions, pacing, caption overlays — automated. Output goes straight to TikTok, Instagram Reels, and Reddit format.' },
  { num: '06', tag: 'Auto Post',         accent: '#3B82F6',         title: 'Set it Sunday. Posts all week.',  body: 'Schedules across Instagram, TikTok, and X at peak audience times. Your account runs 24/7 without you touching it.' },
  { num: '07', tag: 'Brand Voice',       accent: '#F59E0B',         title: 'Every caption sounds like her.',  body: 'Learns exactly how the model writes. Generates captions in her tone — flirty, direct, personalized. Not generic AI slop.' },
  { num: '08', tag: 'Profile Analyzer',  accent: '#A855F7',         title: 'Reverse-engineer any account.',   body: 'Paste any Instagram or TikTok URL. Reads their top content, posting frequency, and hooks. Tells you exactly what\'s working.' },
];

const PRICING = [
  { name: 'Free',     price: '$0',  meta: '/mo', popular: false, cta: 'Get Started Free',
    features: ['Character creation', '10 image generations', 'Profile analyzer', 'Community support'] },
  { name: 'Pro',      price: '$19', meta: '/mo', popular: true,  cta: 'Start Pro',
    features: ['Everything in Free', '200 generations/mo', 'Unrestricted engine', 'Reel Builder', 'Brand Voice', 'Priority support'] },
  { name: 'Unlimited',price: '$49', meta: '/mo', popular: false, cta: 'Go Unlimited',
    features: ['Everything in Pro', 'Unlimited generations', 'Batch (200/run)', 'Auto Post', 'LoRA datasets', 'Scene Memory', 'Team access'] },
];

const COMPARISON = [
  { feature: 'Character identity lock',  kyros: true,      mid: false,       gen: false,       photo: true     },
  { feature: 'Unlimited generation',     kyros: true,      mid: 'limited',   gen: 'limited',   photo: false    },
  { feature: 'Unrestricted generation',  kyros: '90%',     mid: '~40%',      gen: '~35%',      photo: 'N/A'    },
  { feature: 'Auto post & schedule',     kyros: true,      mid: false,       gen: false,       photo: false    },
  { feature: 'Available 24/7',           kyros: true,      mid: true,        gen: true,        photo: false    },
  { feature: 'Cost per 100 images',      kyros: '~$0.25',  mid: '~$12',      gen: '~$8',       photo: '~$800+' },
];

const FAQS = [
  { question: 'Does the character look the same every time?', answer: 'Yes. Kyros locks face geometry, skin tone, body type, and aesthetic at the character level. Photo Match reinforces this by using your reference as the identity anchor — not the scene source.' },
  { question: 'Will content get flagged as AI?', answer: 'Our pipeline strips AI fingerprints — metadata, statistical patterns — from every image before export. Content posts clean on Instagram, TikTok, Reddit, and OF without triggering detection.' },
  { question: 'How many images can I generate per month?', answer: 'Free gives you 10 to test. Pro gives 200/mo for solo creators and small agencies. Unlimited removes all caps — batch runs of 50–200+ images, no limits.' },
  { question: 'Can I manage multiple models or characters?', answer: 'Yes. Every plan supports multiple characters. Agencies running 5–20 accounts create one character per creator and generate for all of them from one workspace.' },
  { question: 'Do I need design or editing skills?', answer: 'No. Drop in a reference photo, describe the scene, Kyros handles everything. Reel Builder adds transitions and captions automatically.' },
  { question: 'Is there a free trial?', answer: 'The Free plan is permanently free — no credit card. Pro and Unlimited can be cancelled anytime.' },
];

// ─── Utility Components ───────────────────────────────────────────────────────
function Reveal({ children, delay = 0, y = 24 }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-60px' });
  return (
    <motion.div ref={ref}
      initial={{ opacity: 0, y }}
      animate={inView ? { opacity: 1, y: 0 } : undefined}
      transition={{ delay, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}>
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
    const step = end / (1600 / 16);
    const t = setInterval(() => {
      s += step;
      if (s >= end) { setN(end); clearInterval(t); } else setN(Math.floor(s));
    }, 16);
    return () => clearInterval(t);
  }, [inView, end]);
  return <span ref={ref}>{prefix}{n}{suffix}</span>;
}

// ─── Sonar Rings (Hero BG effect) ────────────────────────────────────────────
function SonarRings() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden">
      {[1,2,3,4,5].map(i => (
        <motion.div key={i}
          className="absolute rounded-full border"
          style={{
            width: `${i * 18}vw`,
            height: `${i * 18}vw`,
            borderColor: `rgba(204,17,36,${0.22 - i * 0.04})`,
            boxShadow: i === 1 ? `0 0 40px 4px rgba(204,17,36,0.15)` : 'none',
          }}
          animate={{ scale: [1, 1.04, 1], opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 3 + i * 0.6, repeat: Infinity, ease: 'easeInOut', delay: i * 0.3 }}
        />
      ))}
      <div className="absolute" style={{
        width: '60vw', height: '60vw',
        background: 'radial-gradient(circle, rgba(204,17,36,0.12) 0%, transparent 70%)',
        borderRadius: '50%',
      }} />
    </div>
  );
}

// ─── Grain Overlay ────────────────────────────────────────────────────────────
function Grain() {
  return (
    <div className="pointer-events-none fixed inset-0 z-[9999]" style={{ opacity: 0.022, mixBlendMode: 'overlay' }}>
      <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <filter id="grain-filter">
          <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain-filter)" />
      </svg>
    </div>
  );
}

// ─── Red Rule ─────────────────────────────────────────────────────────────────
function Rule({ my = 0 }) {
  return <div style={{ height: 1, background: DS.crimson, opacity: 0.35, margin: `${my}px 0` }} />;
}

// ─── Tag (small label) ────────────────────────────────────────────────────────
function Tag({ children }) {
  return (
    <span style={{
      fontFamily: DS.mono, fontSize: 10, letterSpacing: '0.15em',
      color: DS.crimson, textTransform: 'uppercase',
      border: `1px solid ${DS.crimson}`, padding: '3px 10px', borderRadius: 2,
    }}>{children}</span>
  );
}

// ─── FAQ Item ─────────────────────────────────────────────────────────────────
function FAQItem({ question, answer, isOpen, onToggle, idx }) {
  return (
    <div style={{ borderBottom: `1px solid ${DS.border}` }}>
      <button type="button" onClick={onToggle}
        className="flex w-full cursor-pointer items-center justify-between gap-4 py-5 text-left"
        style={{ background: 'none', border: 'none' }}>
        <div className="flex items-center gap-4">
          <span style={{ fontFamily: DS.mono, fontSize: 11, color: DS.crimson, letterSpacing: '0.08em', minWidth: 28 }}>
            {String(idx + 1).padStart(2, '0')}
          </span>
          <span style={{ fontFamily: DS.body, fontSize: 15, fontWeight: 500, color: isOpen ? DS.text : DS.textMuted }}>
            {question}
          </span>
        </div>
        <motion.span animate={{ rotate: isOpen ? 45 : 0 }} transition={{ duration: 0.2 }}
          style={{ color: DS.crimson, fontSize: 22, fontFamily: DS.mono, flexShrink: 0 }}>+</motion.span>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: 'easeOut' }} className="overflow-hidden">
            <p className="pb-5 pl-10 text-sm leading-[1.9]" style={{ color: DS.textMuted, fontFamily: DS.body }}>{answer}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Auth Modal ───────────────────────────────────────────────────────────────
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
    e.preventDefault(); setLoginError(''); setLoginLoading(true);
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: loginEmail, password: loginPassword, keepSignedIn }) });
      const data = await res.json();
      if (data.ok) { if (onSuccess) onSuccess(data.user); }
      else setLoginError(data.error || 'Invalid credentials');
    } catch { setLoginError('Connection error — please try again'); }
    finally { setLoginLoading(false); }
  };

  const handleRegister = async (e) => {
    e.preventDefault(); setRegisterError(''); setRegisterLoading(true);
    if (form.password !== confirm) { setRegisterError('Passwords do not match'); setRegisterLoading(false); return; }
    try {
      const body = { ...form };
      if (refCode) body.referralCode = refCode;
      const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
      const data = await res.json();
      if (data.ok) {
        if (data.requiresVerification) setRegisterMsg('Check your email to verify your account, then log in.');
        else if (onSuccess) onSuccess(data.user);
      } else setRegisterError(data.error || 'Registration failed');
    } catch { setRegisterError('Connection error'); }
    finally { setRegisterLoading(false); }
  };

  const inputStyle = {
    width: '100%', background: '#0A0A0A', border: `1px solid ${DS.border}`,
    borderRadius: 4, padding: '11px 14px', color: DS.text,
    fontFamily: DS.body, fontSize: 14, outline: 'none',
  };

  return (
    <motion.div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <motion.div className="relative w-full max-w-md"
        style={{ background: DS.surface, border: `1px solid ${DS.borderMid}`, borderRadius: 6, padding: '2rem' }}
        initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}>
        <div style={{ height: 2, background: DS.crimson, marginBottom: '1.5rem', borderRadius: 1 }} />
        <div className="flex gap-1 mb-6">
          {['login', 'register'].map(t => (
            <button key={t} onClick={() => { setTab(t); setLoginError(''); setRegisterError(''); setRegisterMsg(''); }}
              style={{
                flex: 1, padding: '9px', border: 'none', borderRadius: 4, cursor: 'pointer',
                fontFamily: DS.body, fontWeight: 600, fontSize: 13,
                background: tab === t ? DS.crimson : 'transparent',
                color: tab === t ? '#fff' : DS.textMuted, transition: 'all .15s',
              }}>
              {t === 'login' ? 'Sign In' : 'Create Account'}
            </button>
          ))}
        </div>

        {tab === 'login' ? (
          <form onSubmit={handleLogin} className="flex flex-col gap-3">
            <input value={loginEmail} onChange={e => setLoginEmail(e.target.value)} type="email" placeholder="Email" required style={inputStyle} />
            <input value={loginPassword} onChange={e => setLoginPassword(e.target.value)} type="password" placeholder="Password" required style={inputStyle} />
            {loginError && <p style={{ color: DS.crimsonBright, fontSize: 13, fontFamily: DS.body }}>{loginError}</p>}
            <button type="submit" disabled={loginLoading}
              style={{ background: DS.crimson, color: '#fff', border: 'none', borderRadius: 4, padding: '12px', fontFamily: DS.body, fontWeight: 700, fontSize: 14, cursor: 'pointer', opacity: loginLoading ? 0.6 : 1 }}>
              {loginLoading ? 'Signing in...' : 'Sign In'}
            </button>
            <div className="flex justify-between mt-1" style={{ fontSize: 12, fontFamily: DS.body }}>
              <button type="button" onClick={() => onNavigate && onNavigate('forgot')} style={{ background: 'none', border: 'none', color: DS.textMuted, cursor: 'pointer' }}>Forgot password?</button>
              <button type="button" onClick={() => setTab('register')} style={{ background: 'none', border: 'none', color: DS.crimson, cursor: 'pointer' }}>Create account →</button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleRegister} className="flex flex-col gap-3">
            {registerMsg ? (
              <div style={{ background: DS.crimsonDim, border: `1px solid ${DS.crimsonGlow}`, borderRadius: 4, padding: '12px 14px', color: DS.text, fontFamily: DS.body, fontSize: 13 }}>{registerMsg}</div>
            ) : (
              <>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Full name" required style={inputStyle} />
                <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} type="email" placeholder="Email" required style={inputStyle} />
                <input value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} type="password" placeholder="Password" required minLength={8} style={inputStyle} />
                <input value={confirm} onChange={e => setConfirm(e.target.value)} type="password" placeholder="Confirm password" required style={{ ...inputStyle, borderColor: confirm && !match ? DS.crimsonBright : DS.border }} />
                {registerError && <p style={{ color: DS.crimsonBright, fontSize: 13, fontFamily: DS.body }}>{registerError}</p>}
                <button type="submit" disabled={registerLoading || (confirm.length > 0 && !match)}
                  style={{ background: DS.crimson, color: '#fff', border: 'none', borderRadius: 4, padding: '12px', fontFamily: DS.body, fontWeight: 700, fontSize: 14, cursor: 'pointer', opacity: registerLoading ? 0.6 : 1 }}>
                  {registerLoading ? 'Creating account...' : 'Create Account'}
                </button>
              </>
            )}
          </form>
        )}
        <button onClick={onClose} className="absolute top-4 right-4" style={{ background: 'none', border: 'none', color: DS.textMuted, cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>×</button>
      </motion.div>
    </motion.div>
  );
}

// ─── Main Landing Page ────────────────────────────────────────────────────────
export default function LandingPage() {
  useFonts();
  const [authModal, setAuthModal]   = useState(null);
  const [user, setUser]             = useState(null);
  const [openFAQ, setOpenFAQ]       = useState(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [scrolled, setScrolled]     = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    if (ref) sessionStorage.setItem('refCode', ref);
    fetch('/api/auth/me', { credentials: 'include' }).then(r => r.json()).then(d => { if (d.ok) setUser(d.user); }).catch(() => {});
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleAuthSuccess = (u) => { setUser(u); setAuthModal(null); window.location.href = '/app'; };
  const refCode = sessionStorage.getItem('refCode') || '';

  const navLinks = [['Features', '#features'], ['How It Works', '#how-it-works'], ['Pricing', '#pricing'], ['FAQ', '#faq']];

  return (
    <div style={{ background: DS.bg, color: DS.text, minHeight: '100vh', overflowX: 'hidden' }}>
      <Grain />

      {/* ── Auth Modal ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {authModal && (
          <AuthModal mode={authModal} onClose={() => setAuthModal(null)} onSuccess={handleAuthSuccess}
            onNavigate={(m) => setAuthModal(m)} refCode={refCode} />
        )}
      </AnimatePresence>

      {/* ── Nav ──────────────────────────────────────────────────────────── */}
      <motion.nav className="fixed top-0 left-0 right-0 z-40"
        style={{
          background: scrolled ? 'rgba(0,0,0,0.92)' : 'transparent',
          borderBottom: scrolled ? `1px solid ${DS.border}` : '1px solid transparent',
          backdropFilter: scrolled ? 'blur(12px)' : 'none',
          transition: 'all 0.3s',
        }}>
        <div className="flex items-center justify-between px-6 sm:px-10 h-16 max-w-7xl mx-auto">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: DS.crimson, boxShadow: `0 0 10px ${DS.crimson}` }} />
            <span style={{ fontFamily: DS.display, fontSize: 22, letterSpacing: '0.12em', color: DS.text }}>KYROS</span>
            <span style={{ fontFamily: DS.mono, fontSize: 9, color: DS.crimson, letterSpacing: '0.1em', marginLeft: 2, marginTop: 1 }}>STUDIO</span>
          </div>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-8">
            {navLinks.map(([label, href]) => (
              <a key={label} href={href}
                style={{ fontFamily: DS.body, fontSize: 13, fontWeight: 500, color: DS.textMuted, textDecoration: 'none', letterSpacing: '0.01em', transition: 'color .15s' }}
                onMouseEnter={e => e.target.style.color = DS.text}
                onMouseLeave={e => e.target.style.color = DS.textMuted}>
                {label}
              </a>
            ))}
          </div>

          {/* CTA */}
          <div className="flex items-center gap-3">
            {user ? (
              <a href="/app" style={{ fontFamily: DS.body, fontSize: 13, fontWeight: 600, color: DS.text, textDecoration: 'none',
                background: DS.crimson, padding: '8px 20px', borderRadius: 3 }}>
                Open Studio →
              </a>
            ) : (
              <>
                <button onClick={() => setAuthModal('login')} className="hidden sm:block"
                  style={{ fontFamily: DS.body, fontSize: 13, fontWeight: 500, color: DS.textMuted, background: 'none', border: 'none', cursor: 'pointer' }}>
                  Sign In
                </button>
                <button onClick={() => setAuthModal('register')}
                  style={{ fontFamily: DS.body, fontSize: 13, fontWeight: 700, color: '#fff',
                    background: DS.crimson, border: 'none', padding: '8px 20px', borderRadius: 3, cursor: 'pointer', letterSpacing: '0.02em' }}>
                  Start Free
                </button>
              </>
            )}
            <button className="md:hidden" onClick={() => setMobileMenu(m => !m)}
              style={{ background: 'none', border: 'none', color: DS.text, cursor: 'pointer', fontSize: 20 }}>☰</button>
          </div>
        </div>

        {/* Mobile menu */}
        <AnimatePresence>
          {mobileMenu && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              style={{ background: '#050505', borderTop: `1px solid ${DS.border}`, overflow: 'hidden' }}>
              <div className="flex flex-col px-6 py-4 gap-4">
                {navLinks.map(([label, href]) => (
                  <a key={label} href={href} onClick={() => setMobileMenu(false)}
                    style={{ fontFamily: DS.body, fontSize: 15, color: DS.textMuted, textDecoration: 'none' }}>{label}</a>
                ))}
                <button onClick={() => { setAuthModal('login'); setMobileMenu(false); }}
                  style={{ fontFamily: DS.body, fontSize: 14, color: DS.text, background: 'none', border: `1px solid ${DS.borderMid}`, padding: '10px', borderRadius: 3, cursor: 'pointer', textAlign: 'center' }}>
                  Sign In
                </button>
                <button onClick={() => { setAuthModal('register'); setMobileMenu(false); }}
                  style={{ fontFamily: DS.body, fontSize: 14, fontWeight: 700, color: '#fff', background: DS.crimson, border: 'none', padding: '10px', borderRadius: 3, cursor: 'pointer' }}>
                  Start Free
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.nav>

      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="relative min-h-screen flex flex-col items-center justify-center px-6 text-center overflow-hidden" style={{ paddingTop: 80 }}>
        <SonarRings />

        {/* Top tag */}
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="mb-8">
          <Tag>Siren Edition — Content Engine for OFM</Tag>
        </motion.div>

        {/* Main headline */}
        <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay: 0.1 }}>
          <h1 style={{ fontFamily: DS.display, lineHeight: 0.88, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            <span style={{ display: 'block', fontSize: 'clamp(72px, 14vw, 200px)', color: DS.text }}>YOUR AI</span>
            <span style={{ display: 'block', fontSize: 'clamp(72px, 14vw, 200px)', color: DS.crimson, textShadow: `0 0 80px rgba(204,17,36,0.4)` }}>CREATOR</span>
            <span style={{ display: 'block', fontSize: 'clamp(72px, 14vw, 200px)', color: DS.text }}>ENGINE</span>
          </h1>
        </motion.div>

        {/* Subhead */}
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.7, delay: 0.35 }}
          className="mt-8 max-w-lg mx-auto"
          style={{ fontFamily: DS.body, fontSize: 16, lineHeight: 1.75, color: DS.textMuted, fontWeight: 400 }}>
          Build AI creator identities. Generate 200+ pieces of consistent, unrestricted content per batch.
          Auto-post across platforms. <strong style={{ color: DS.text, fontWeight: 600 }}>Your model runs 24/7 without you.</strong>
        </motion.p>

        {/* CTAs */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.5 }}
          className="flex flex-wrap justify-center gap-3 mt-10">
          <button onClick={() => setAuthModal('register')}
            style={{ fontFamily: DS.body, fontWeight: 700, fontSize: 14, letterSpacing: '0.04em',
              background: DS.crimson, color: '#fff', border: 'none', padding: '14px 36px', borderRadius: 3, cursor: 'pointer',
              boxShadow: `0 0 30px rgba(204,17,36,0.35)`, transition: 'all .2s' }}
            onMouseEnter={e => { e.target.style.background = DS.crimsonBright; e.target.style.boxShadow = `0 0 50px rgba(204,17,36,0.5)`; }}
            onMouseLeave={e => { e.target.style.background = DS.crimson; e.target.style.boxShadow = `0 0 30px rgba(204,17,36,0.35)`; }}>
            START FREE — NO CARD
          </button>
          <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer"
            style={{ fontFamily: DS.body, fontWeight: 600, fontSize: 14, letterSpacing: '0.04em',
              color: DS.textMuted, textDecoration: 'none', padding: '14px 32px', border: `1px solid ${DS.borderMid}`,
              borderRadius: 3, transition: 'all .2s', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onMouseEnter={e => { e.currentTarget.style.color = DS.text; e.currentTarget.style.borderColor = DS.border; }}
            onMouseLeave={e => { e.currentTarget.style.color = DS.textMuted; e.currentTarget.style.borderColor = DS.borderMid; }}>
            JOIN TELEGRAM ↗
          </a>
        </motion.div>

        {/* Stats row */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8, duration: 0.6 }}
          className="flex flex-wrap justify-center gap-12 mt-20"
          style={{ borderTop: `1px solid ${DS.border}`, paddingTop: 32, width: '100%', maxWidth: 700 }}>
          {[
            { n: 90, suffix: '%', label: 'image success rate' },
            { n: 200, suffix: '+', label: 'images per batch run' },
            { n: 0.25, suffix: '¢', prefix: '~$', label: 'cost per 100 images' },
          ].map((s, i) => (
            <div key={i} className="text-center">
              <div style={{ fontFamily: DS.display, fontSize: 48, letterSpacing: '0.04em', color: DS.crimson, lineHeight: 1 }}>
                <CountUp end={s.n} suffix={s.suffix} prefix={s.prefix || ''} />
              </div>
              <div style={{ fontFamily: DS.mono, fontSize: 10, letterSpacing: '0.12em', color: DS.textSubtle, textTransform: 'uppercase', marginTop: 6 }}>
                {s.label}
              </div>
            </div>
          ))}
        </motion.div>

        {/* Scroll indicator */}
        <motion.div className="absolute bottom-10" animate={{ y: [0, 6, 0] }} transition={{ duration: 1.5, repeat: Infinity }}>
          <span style={{ fontFamily: DS.mono, fontSize: 10, color: DS.textSubtle, letterSpacing: '0.1em' }}>SCROLL</span>
          <div style={{ width: 1, height: 32, background: `linear-gradient(to bottom, ${DS.crimson}, transparent)`, margin: '6px auto 0' }} />
        </motion.div>
      </section>

      {/* ── Marquee ──────────────────────────────────────────────────────── */}
      <div style={{ borderTop: `1px solid ${DS.border}`, borderBottom: `1px solid ${DS.border}`, overflow: 'hidden', padding: '14px 0' }}>
        <motion.div className="flex gap-12 whitespace-nowrap"
          animate={{ x: [0, '-50%'] }} transition={{ duration: 22, repeat: Infinity, ease: 'linear' }}
          style={{ display: 'flex', width: 'max-content' }}>
          {[...Array(2)].map((_, rep) => (
            ['PHOTO MATCH', 'CHARACTER LOCK', 'UNRESTRICTED ENGINE', 'BATCH 200+', 'REEL BUILDER', 'AUTO POST', 'BRAND VOICE', 'PROFILE ANALYZER', 'AI MODELS', 'OFM AUTOMATION'].map((item, i) => (
              <span key={`${rep}-${i}`} style={{ fontFamily: DS.mono, fontSize: 11, letterSpacing: '0.16em', color: i % 3 === 0 ? DS.crimson : DS.textSubtle, marginRight: 48 }}>
                {item} <span style={{ color: DS.crimsonDim, margin: '0 12px' }}>◆</span>
              </span>
            ))
          ))}
        </motion.div>
      </div>

      {/* ── Features ─────────────────────────────────────────────────────── */}
      <section id="features" className="px-6 sm:px-10 py-28 max-w-7xl mx-auto">
        <Reveal>
          <div className="flex items-center gap-4 mb-16">
            <span style={{ fontFamily: DS.mono, fontSize: 11, color: DS.crimson, letterSpacing: '0.14em' }}>01 / CAPABILITIES</span>
            <div style={{ flex: 1, height: 1, background: DS.border }} />
          </div>
        </Reveal>

        <Reveal delay={0.05}>
          <h2 style={{ fontFamily: DS.display, fontSize: 'clamp(40px, 6vw, 80px)', letterSpacing: '0.04em', lineHeight: 0.9, textTransform: 'uppercase', marginBottom: 64 }}>
            EIGHT WEAPONS.<br />
            <span style={{ color: DS.crimson }}>ONE PLATFORM.</span>
          </h2>
        </Reveal>

        <div style={{ borderTop: `1px solid ${DS.border}` }}>
          {FEATURES.map((f, i) => (
            <Reveal key={f.num} delay={i * 0.04}>
              <motion.div
                className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-0 py-7"
                style={{ borderBottom: `1px solid ${DS.border}`, cursor: 'default' }}
                whileHover={{ backgroundColor: 'rgba(204,17,36,0.025)' }}
                transition={{ duration: 0.2 }}>
                <span style={{ fontFamily: DS.mono, fontSize: 12, color: DS.crimson, letterSpacing: '0.08em', minWidth: 48 }}>{f.num}</span>
                <span style={{ fontFamily: DS.body, fontWeight: 600, fontSize: 13, color: DS.textSubtle, letterSpacing: '0.06em', textTransform: 'uppercase', minWidth: 180 }}>{f.tag}</span>
                <div className="sm:flex-1">
                  <p style={{ fontFamily: DS.body, fontWeight: 600, fontSize: 15, color: DS.text, marginBottom: 4 }}>{f.title}</p>
                  <p style={{ fontFamily: DS.body, fontSize: 13, color: DS.textMuted, lineHeight: 1.7, maxWidth: 600 }}>{f.body}</p>
                </div>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: f.accent, boxShadow: `0 0 10px ${f.accent}`, flexShrink: 0, marginLeft: 24 }} className="hidden sm:block" />
              </motion.div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── How It Works ─────────────────────────────────────────────────── */}
      <section id="how-it-works" style={{ background: DS.surface, borderTop: `1px solid ${DS.border}`, borderBottom: `1px solid ${DS.border}` }} className="px-6 sm:px-10 py-28">
        <div className="max-w-7xl mx-auto">
          <Reveal>
            <div className="flex items-center gap-4 mb-16">
              <span style={{ fontFamily: DS.mono, fontSize: 11, color: DS.crimson, letterSpacing: '0.14em' }}>02 / PROTOCOL</span>
              <div style={{ flex: 1, height: 1, background: DS.border }} />
            </div>
          </Reveal>

          <Reveal delay={0.05}>
            <h2 style={{ fontFamily: DS.display, fontSize: 'clamp(40px, 6vw, 80px)', letterSpacing: '0.04em', lineHeight: 0.9, textTransform: 'uppercase', marginBottom: 64 }}>
              THREE STEPS.<br />
              <span style={{ color: DS.crimson }}>INFINITE OUTPUT.</span>
            </h2>
          </Reveal>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-px" style={{ border: `1px solid ${DS.border}` }}>
            {[
              { step: '01', title: 'Build Your Character', body: 'Upload 3–5 reference photos. Lock face, body, style, aesthetic. Your character is the identity anchor for every generation going forward.' },
              { step: '02', title: 'Generate at Scale', body: 'Set a prompt or clone a viral format. Batch generates 50–200 consistent images. All look like the same person, every time.' },
              { step: '03', title: 'Post Without Thinking', body: 'Every image runs through our cleanup pipeline — AI fingerprints stripped automatically. Auto Post schedules across platforms at peak times. 24/7.' },
            ].map((item, i) => (
              <Reveal key={item.step} delay={i * 0.1}>
                <div className="p-8 sm:p-10 h-full" style={{ background: DS.surface, borderRight: i < 2 ? `1px solid ${DS.border}` : 'none' }}>
                  <div style={{ fontFamily: DS.display, fontSize: 64, letterSpacing: '0.06em', color: i === 0 ? DS.crimson : DS.textSubtle, lineHeight: 1, marginBottom: 24 }}>{item.step}</div>
                  <h3 style={{ fontFamily: DS.body, fontWeight: 700, fontSize: 17, color: DS.text, marginBottom: 12, letterSpacing: '-0.01em' }}>{item.title}</h3>
                  <p style={{ fontFamily: DS.body, fontSize: 14, color: DS.textMuted, lineHeight: 1.8 }}>{item.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ──────────────────────────────────────────────────────── */}
      <section id="pricing" className="px-6 sm:px-10 py-28 max-w-7xl mx-auto">
        <Reveal>
          <div className="flex items-center gap-4 mb-16">
            <span style={{ fontFamily: DS.mono, fontSize: 11, color: DS.crimson, letterSpacing: '0.14em' }}>03 / PRICING</span>
            <div style={{ flex: 1, height: 1, background: DS.border }} />
          </div>
        </Reveal>

        <Reveal delay={0.05}>
          <h2 style={{ fontFamily: DS.display, fontSize: 'clamp(40px, 6vw, 80px)', letterSpacing: '0.04em', lineHeight: 0.9, textTransform: 'uppercase', marginBottom: 64 }}>
            PICK YOUR<br />
            <span style={{ color: DS.crimson }}>OPERATION.</span>
          </h2>
        </Reveal>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {PRICING.map((plan, i) => (
            <Reveal key={plan.name} delay={i * 0.1}>
              <motion.div
                style={{
                  background: plan.popular ? 'linear-gradient(160deg, rgba(204,17,36,0.12) 0%, rgba(204,17,36,0.04) 100%)' : DS.surfaceAlt,
                  border: plan.popular ? `1px solid rgba(204,17,36,0.4)` : `1px solid ${DS.border}`,
                  borderRadius: 4, padding: '2rem', position: 'relative',
                  boxShadow: plan.popular ? `0 0 60px rgba(204,17,36,0.08)` : 'none',
                }}
                whileHover={{ y: -3 }} transition={{ duration: 0.2 }}>
                {plan.popular && (
                  <div style={{ position: 'absolute', top: -1, left: 0, right: 0, height: 2, background: DS.crimson, borderRadius: '4px 4px 0 0' }} />
                )}
                {plan.popular && (
                  <div style={{ marginBottom: 12 }}>
                    <span style={{ fontFamily: DS.mono, fontSize: 9, letterSpacing: '0.15em', color: DS.crimson, background: DS.crimsonDim, padding: '3px 10px', borderRadius: 2 }}>MOST POPULAR</span>
                  </div>
                )}
                <div style={{ fontFamily: DS.body, fontWeight: 700, fontSize: 13, letterSpacing: '0.08em', textTransform: 'uppercase', color: DS.textMuted, marginBottom: 16 }}>{plan.name}</div>
                <div className="flex items-end gap-1 mb-6">
                  <span style={{ fontFamily: DS.display, fontSize: 60, letterSpacing: '0.02em', color: plan.popular ? DS.crimsonBright : DS.text, lineHeight: 1 }}>{plan.price}</span>
                  <span style={{ fontFamily: DS.mono, fontSize: 12, color: DS.textSubtle, marginBottom: 8 }}>{plan.meta}</span>
                </div>
                <div style={{ borderTop: `1px solid ${DS.border}`, paddingTop: 20, marginBottom: 24 }}>
                  {plan.features.map((f, fi) => (
                    <div key={fi} className="flex items-center gap-3 mb-3">
                      <span style={{ color: plan.popular ? DS.crimson : DS.textSubtle, fontSize: 14, lineHeight: 1 }}>→</span>
                      <span style={{ fontFamily: DS.body, fontSize: 13, color: DS.textMuted }}>{f}</span>
                    </div>
                  ))}
                </div>
                <button onClick={() => setAuthModal('register')}
                  style={{
                    width: '100%', padding: '12px', borderRadius: 3, cursor: 'pointer',
                    fontFamily: DS.body, fontWeight: 700, fontSize: 13, letterSpacing: '0.04em',
                    background: plan.popular ? DS.crimson : 'transparent',
                    color: plan.popular ? '#fff' : DS.textMuted,
                    border: plan.popular ? 'none' : `1px solid ${DS.borderMid}`,
                    transition: 'all .2s',
                  }}
                  onMouseEnter={e => { if (!plan.popular) { e.target.style.color = DS.text; e.target.style.borderColor = DS.border; } }}
                  onMouseLeave={e => { if (!plan.popular) { e.target.style.color = DS.textMuted; e.target.style.borderColor = DS.borderMid; } }}>
                  {plan.cta} →
                </button>
              </motion.div>
            </Reveal>
          ))}
        </div>

        {/* Comparison table */}
        <Reveal delay={0.1}>
          <div className="mt-16" style={{ border: `1px solid ${DS.border}`, borderRadius: 4, overflow: 'hidden' }}>
            <div className="grid grid-cols-5" style={{ background: DS.surfaceAlt, borderBottom: `1px solid ${DS.border}` }}>
              {['Feature', 'Kyros', 'Midjourney', 'Gen-2', 'Photo Shoot'].map((h, i) => (
                <div key={h} className="p-4 text-center" style={{ fontFamily: DS.mono, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: i === 1 ? DS.crimson : DS.textSubtle }}>
                  {h}
                </div>
              ))}
            </div>
            {COMPARISON.map((row, i) => (
              <div key={i} className="grid grid-cols-5" style={{ borderBottom: i < COMPARISON.length - 1 ? `1px solid ${DS.border}` : 'none', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                <div className="p-4" style={{ fontFamily: DS.body, fontSize: 13, color: DS.textMuted }}>{row.feature}</div>
                {[row.kyros, row.mid, row.gen, row.photo].map((v, j) => (
                  <div key={j} className="p-4 text-center flex items-center justify-center">
                    {v === true ? <span style={{ color: DS.crimson, fontSize: 16 }}>✓</span>
                     : v === false ? <span style={{ color: DS.textSubtle, fontSize: 14 }}>—</span>
                     : <span style={{ fontFamily: DS.mono, fontSize: 11, color: j === 0 ? DS.crimson : DS.textMuted }}>{v}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      {/* ── FAQ ──────────────────────────────────────────────────────────── */}
      <section id="faq" style={{ background: DS.surface, borderTop: `1px solid ${DS.border}` }} className="px-6 sm:px-10 py-28">
        <div className="max-w-3xl mx-auto">
          <Reveal>
            <div className="flex items-center gap-4 mb-16">
              <span style={{ fontFamily: DS.mono, fontSize: 11, color: DS.crimson, letterSpacing: '0.14em' }}>04 / FAQ</span>
              <div style={{ flex: 1, height: 1, background: DS.border }} />
            </div>
          </Reveal>

          <Reveal delay={0.05}>
            <h2 style={{ fontFamily: DS.display, fontSize: 'clamp(36px, 5vw, 64px)', letterSpacing: '0.04em', lineHeight: 0.9, textTransform: 'uppercase', marginBottom: 48 }}>
              QUESTIONS<br />
              <span style={{ color: DS.crimson }}>ANSWERED.</span>
            </h2>
          </Reveal>

          <div style={{ borderTop: `1px solid ${DS.border}` }}>
            {FAQS.map((item, i) => (
              <FAQItem key={i} idx={i} question={item.question} answer={item.answer}
                isOpen={openFAQ === i} onToggle={() => setOpenFAQ(openFAQ === i ? null : i)} />
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA Banner ───────────────────────────────────────────────────── */}
      <section className="px-6 sm:px-10 py-24 relative overflow-hidden" style={{ borderTop: `1px solid ${DS.border}` }}>
        <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 50% 50%, rgba(204,17,36,0.08) 0%, transparent 70%)' }} />
        <div className="relative max-w-3xl mx-auto text-center">
          <Reveal>
            <h2 style={{ fontFamily: DS.display, fontSize: 'clamp(48px, 9vw, 120px)', letterSpacing: '0.04em', lineHeight: 0.88, textTransform: 'uppercase', marginBottom: 32 }}>
              YOUR MODEL<br />
              <span style={{ color: DS.crimson }}>NEVER SLEEPS</span>
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p style={{ fontFamily: DS.body, fontSize: 16, color: DS.textMuted, marginBottom: 36, lineHeight: 1.7 }}>
              10 free images. No credit card. Start building your creator empire in the next 3 minutes.
            </p>
          </Reveal>
          <Reveal delay={0.15}>
            <div className="flex flex-wrap justify-center gap-3">
              <button onClick={() => setAuthModal('register')}
                style={{ fontFamily: DS.body, fontWeight: 700, fontSize: 14, letterSpacing: '0.06em',
                  background: DS.crimson, color: '#fff', border: 'none', padding: '15px 42px', borderRadius: 3, cursor: 'pointer',
                  boxShadow: `0 0 40px rgba(204,17,36,0.35)` }}>
                START FREE NOW
              </button>
              <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer"
                style={{ fontFamily: DS.body, fontWeight: 600, fontSize: 14, letterSpacing: '0.04em',
                  color: DS.textMuted, textDecoration: 'none', padding: '15px 36px', border: `1px solid ${DS.borderMid}`, borderRadius: 3 }}>
                JOIN DISCORD
              </a>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer style={{ borderTop: `1px solid ${DS.border}`, padding: '40px 40px' }}>
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: DS.crimson }} />
            <span style={{ fontFamily: DS.display, fontSize: 18, letterSpacing: '0.12em' }}>KYROS STUDIO</span>
          </div>

          <div className="flex flex-wrap justify-center gap-8">
            {navLinks.map(([label, href]) => (
              <a key={label} href={href} style={{ fontFamily: DS.body, fontSize: 12, color: DS.textSubtle, textDecoration: 'none', letterSpacing: '0.04em' }}>{label}</a>
            ))}
            <a href="/privacy" style={{ fontFamily: DS.body, fontSize: 12, color: DS.textSubtle, textDecoration: 'none' }}>Privacy</a>
            <a href="/terms" style={{ fontFamily: DS.body, fontSize: 12, color: DS.textSubtle, textDecoration: 'none' }}>Terms</a>
          </div>

          <div className="flex items-center gap-4">
            <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer"
              style={{ fontFamily: DS.mono, fontSize: 10, letterSpacing: '0.12em', color: DS.crimson, textDecoration: 'none' }}>TG ↗</a>
            <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer"
              style={{ fontFamily: DS.mono, fontSize: 10, letterSpacing: '0.12em', color: DS.textSubtle, textDecoration: 'none' }}>DISCORD ↗</a>
          </div>
        </div>

        <div className="max-w-7xl mx-auto mt-8 pt-6" style={{ borderTop: `1px solid ${DS.border}` }}>
          <p style={{ fontFamily: DS.mono, fontSize: 10, color: DS.textSubtle, letterSpacing: '0.08em', textAlign: 'center' }}>
            © {new Date().getFullYear()} KYROS STUDIO. ALL RIGHTS RESERVED. — SIREN EDITION
          </p>
        </div>
      </footer>
    </div>
  );
}
