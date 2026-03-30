import React, { useEffect, useRef } from 'react';

const FEATURES = [
  {
    icon: '✦',
    gradient: 'linear-gradient(135deg, #a5b4fc, #6366f1)',
    title: 'AI Image Generation',
    desc: 'Generate stunning images from text prompts using Google Gemini. Full control over style, character, and scene.',
  },
  {
    icon: '⚡',
    gradient: 'linear-gradient(135deg, #fde68a, #f59e0b)',
    title: 'Batch & Auto Content',
    desc: 'Queue hundreds of images at once. AI plans multi-day content calendars automatically — set it and forget it.',
  },
  {
    icon: '🎬',
    gradient: 'linear-gradient(135deg, #f9a8d4, #ec4899)',
    title: 'Video Generation',
    desc: 'Turn images into AI-animated videos. Compose reels with audio, text overlays, and custom timing.',
  },
  {
    icon: '👁',
    gradient: 'linear-gradient(135deg, #67e8f9, #0891b2)',
    title: 'Scene & Reel Recreation',
    desc: 'Upload any Instagram scene or reel and recreate it with your own character. Clone posts in seconds.',
  },
  {
    icon: '🎨',
    gradient: 'linear-gradient(135deg, #6ee7b7, #059669)',
    title: 'Style Library',
    desc: 'Save and reuse style building blocks. Visual prompt composer with the Nano-Banana formula for perfect results.',
  },
  {
    icon: '📊',
    gradient: 'linear-gradient(135deg, #7dd3fc, #0284c7)',
    title: 'Profile Analyzer',
    desc: 'Extract style patterns from any Instagram profile. Understand what makes content perform and replicate it.',
  },
];

const STEPS = [
  { n: '01', title: 'Create your account', desc: 'Register in seconds. No credit card required to start.' },
  { n: '02', title: 'Add your API key', desc: 'Connect your Google Gemini key in Settings. One key, all features unlocked.' },
  { n: '03', title: 'Generate content', desc: 'Describe your character, pick a style, and generate. Your first image in under 10 seconds.' },
];

const PLANS = [
  {
    name: 'Free',
    price: '$0',
    period: 'forever',
    highlight: false,
    features: ['Generate images', 'Batch generation', 'Gallery management', 'Characters library', 'Bring your own API key'],
  },
  {
    name: 'Pro',
    price: '$19',
    period: 'per month',
    highlight: true,
    badge: 'Most Popular',
    features: ['Everything in Free', 'Video generation', 'Auto content planner', 'Scene & reel recreation', 'Style Library & Prompt Builder', 'Priority support'],
  },
  {
    name: 'Unlimited',
    price: '$49',
    period: 'per month',
    highlight: false,
    features: ['Everything in Pro', 'NSFW generation (LoRA)', 'Profile analyzer', 'Unlimited batch jobs', 'Admin dashboard', 'Early access to new features'],
  },
];

export default function LandingPage({ onNavigate }) {
  const heroRef = useRef(null);

  useEffect(() => {
    // Parallax glow on mouse move
    const el = heroRef.current;
    if (!el) return;
    const onMove = (e) => {
      const x = (e.clientX / window.innerWidth - 0.5) * 40;
      const y = (e.clientY / window.innerHeight - 0.5) * 40;
      el.style.setProperty('--gx', `${50 + x}%`);
      el.style.setProperty('--gy', `${50 + y}%`);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: '#09090b', color: '#f4f4f5', fontFamily: '"Outfit", system-ui, sans-serif', overflowX: 'hidden' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&display=swap');
        * { box-sizing: border-box; }
        ::selection { background: #6366f1; color: white; }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: #18181b; } ::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 99px; }

        @keyframes fadeUp { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes float { 0%,100% { transform: translateY(0px); } 50% { transform: translateY(-10px); } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

        .fade-up { animation: fadeUp 0.7s ease both; }
        .fade-up-2 { animation: fadeUp 0.7s 0.1s ease both; }
        .fade-up-3 { animation: fadeUp 0.7s 0.2s ease both; }
        .fade-up-4 { animation: fadeUp 0.7s 0.3s ease both; }

        .gradient-text {
          background: linear-gradient(135deg, #a5b4fc 0%, #818cf8 40%, #c084fc 70%, #f472b6 100%);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
        }
        .gradient-text-alt {
          background: linear-gradient(135deg, #67e8f9 0%, #818cf8 50%, #a78bfa 100%);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
        }

        .glass-card {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 16px;
          backdrop-filter: blur(8px);
          transition: all 0.25s ease;
        }
        .glass-card:hover {
          background: rgba(255,255,255,0.06);
          border-color: rgba(99,102,241,0.35);
          transform: translateY(-2px);
          box-shadow: 0 8px 32px rgba(99,102,241,0.12);
        }

        .btn-primary {
          background: linear-gradient(135deg, #6366f1, #4f46e5);
          color: white; border: none; border-radius: 10px;
          padding: 0.75rem 1.75rem; font-size: 15px; font-weight: 600;
          cursor: pointer; transition: all 0.2s ease;
          box-shadow: 0 4px 16px rgba(99,102,241,0.35);
        }
        .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(99,102,241,0.5); filter: brightness(1.1); }
        .btn-primary:active { transform: translateY(0); }

        .btn-ghost {
          background: rgba(255,255,255,0.05);
          color: #a1a1aa; border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px; padding: 0.75rem 1.75rem;
          font-size: 15px; font-weight: 500; cursor: pointer;
          transition: all 0.2s ease;
        }
        .btn-ghost:hover { background: rgba(255,255,255,0.09); color: #f4f4f5; border-color: rgba(255,255,255,0.2); }

        .hero-glow {
          position: absolute; inset: 0; pointer-events: none;
          background: radial-gradient(ellipse 60% 50% at var(--gx, 50%) var(--gy, 40%), rgba(99,102,241,0.18) 0%, transparent 70%);
          transition: background 0.1s ease;
        }

        .plan-popular {
          background: linear-gradient(135deg, rgba(99,102,241,0.15), rgba(139,92,246,0.1));
          border: 1px solid rgba(99,102,241,0.5) !important;
          box-shadow: 0 0 40px rgba(99,102,241,0.15), inset 0 1px 0 rgba(255,255,255,0.08);
        }

        .check-icon::before { content: '✓'; color: #818cf8; font-weight: 700; margin-right: 8px; }

        .nav-link { color: #71717a; background: none; border: none; cursor: pointer; font-size: 14px; font-weight: 500; font-family: inherit; transition: color 0.2s; padding: 4px 0; }
        .nav-link:hover { color: #f4f4f5; }

        .feature-icon {
          width: 44px; height: 44px; border-radius: 12px;
          display: flex; align-items: center; justify-content: center;
          font-size: 20px; margin-bottom: 16px; flex-shrink: 0;
        }

        .divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent); margin: 80px 0; }

        .badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); border-radius: 99px; padding: 4px 12px; font-size: 12px; color: #a5b4fc; font-weight: 600; letter-spacing: 0.03em; }

        .noise-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 0; opacity: 0.025;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
        }

        @media (max-width: 768px) {
          .hero-title { font-size: 40px !important; }
          .hero-sub { font-size: 16px !important; }
          .features-grid { grid-template-columns: 1fr !important; }
          .plans-grid { grid-template-columns: 1fr !important; }
          .steps-grid { grid-template-columns: 1fr !important; }
          .nav-links { display: none !important; }
        }
      `}</style>

      <div className="noise-overlay" />

      {/* NAV */}
      <nav style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100, padding: '0 24px', height: '64px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(9,9,11,0.8)', backdropFilter: 'blur(16px)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800 }}>✦</div>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#f4f4f5', letterSpacing: '-0.02em' }}>Content Studio</span>
        </div>
        <div className="nav-links" style={{ display: 'flex', alignItems: 'center', gap: '28px' }}>
          <button className="nav-link" onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })}>Features</button>
          <button className="nav-link" onClick={() => document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' })}>Pricing</button>
          <button className="nav-link" onClick={() => document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' })}>How it works</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button className="btn-ghost" style={{ padding: '0.5rem 1.1rem', fontSize: 14 }} onClick={() => onNavigate('login')}>Sign in</button>
          <button className="btn-primary" style={{ padding: '0.5rem 1.1rem', fontSize: 14 }} onClick={() => onNavigate('register')}>Get started free</button>
        </div>
      </nav>

      {/* HERO */}
      <section ref={heroRef} style={{ position: 'relative', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '120px 24px 80px', overflow: 'hidden' }}>
        <div className="hero-glow" />
        {/* Grid lines */}
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)', backgroundSize: '80px 80px', pointerEvents: 'none' }} />

        <div style={{ position: 'relative', maxWidth: '800px' }}>
          <div className="fade-up" style={{ marginBottom: 24 }}>
            <span className="badge">✦ AI-Powered Content Creation</span>
          </div>

          <h1 className="fade-up-2 hero-title gradient-text" style={{ fontSize: 64, fontWeight: 900, lineHeight: 1.05, letterSpacing: '-0.04em', margin: '0 0 24px' }}>
            Create viral content<br />at machine speed
          </h1>

          <p className="fade-up-3 hero-sub" style={{ fontSize: 20, color: '#71717a', lineHeight: 1.7, maxWidth: 560, margin: '0 auto 40px', fontWeight: 400 }}>
            Generate images, videos, reels, and carousels with AI. Build your content calendar in minutes — not days.
          </p>

          <div className="fade-up-4" style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="btn-primary" style={{ fontSize: 16, padding: '0.875rem 2rem' }} onClick={() => onNavigate('register')}>
              Start for free →
            </button>
            <button className="btn-ghost" style={{ fontSize: 16, padding: '0.875rem 2rem' }} onClick={() => onNavigate('login')}>
              Sign in
            </button>
          </div>

          <div style={{ marginTop: 60, opacity: 0.4, fontSize: 13, color: '#52525b', letterSpacing: '0.05em' }}>
            POWERED BY
          </div>
          <div style={{ display: 'flex', gap: 24, justifyContent: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            {['Google Gemini', 'WaveSpeed AI', 'Apify', 'FFmpeg'].map(t => (
              <span key={t} style={{ color: '#52525b', fontSize: 13, fontWeight: 600, border: '1px solid rgba(255,255,255,0.06)', borderRadius: 99, padding: '4px 12px' }}>{t}</span>
            ))}
          </div>
        </div>

        {/* Scroll indicator */}
        <div style={{ position: 'absolute', bottom: 32, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 1, height: 40, background: 'linear-gradient(to bottom, rgba(99,102,241,0.6), transparent)', animation: 'pulse 2s infinite' }} />
        </div>
      </section>

      <div className="divider" />

      {/* FEATURES */}
      <section id="features" style={{ padding: '0 24px 80px', maxWidth: 1140, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 60 }}>
          <div style={{ marginBottom: 12 }}><span className="badge">Features</span></div>
          <h2 style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', margin: '0 0 16px' }}>
            Everything you need to<br /><span className="gradient-text">dominate social media</span>
          </h2>
          <p style={{ color: '#71717a', fontSize: 17, maxWidth: 500, margin: '0 auto' }}>
            One platform. Every AI content tool you'll ever need.
          </p>
        </div>

        <div className="features-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {FEATURES.map((f) => (
            <div key={f.title} className="glass-card" style={{ padding: 24 }}>
              <div className="feature-icon" style={{ background: f.gradient + '22', border: `1px solid ${f.gradient.split(',')[1].trim().replace(')','')}44` }}>
                <span style={{ background: f.gradient, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>{f.icon}</span>
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: '#f4f4f5' }}>{f.title}</h3>
              <p style={{ fontSize: 14, color: '#71717a', lineHeight: 1.6, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="divider" />

      {/* HOW IT WORKS */}
      <section id="how" style={{ padding: '0 24px 80px', maxWidth: 1140, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 60 }}>
          <div style={{ marginBottom: 12 }}><span className="badge">How it works</span></div>
          <h2 style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', margin: '0 0 16px' }}>
            From zero to <span className="gradient-text-alt">viral in 3 steps</span>
          </h2>
        </div>

        <div className="steps-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24 }}>
          {STEPS.map((step, i) => (
            <div key={step.n} className="glass-card" style={{ padding: 32, position: 'relative', overflow: 'hidden' }}>
              <div style={{ fontSize: 72, fontWeight: 900, color: 'rgba(99,102,241,0.08)', lineHeight: 1, position: 'absolute', top: 16, right: 20, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.05em' }}>{step.n}</div>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800, color: 'white', marginBottom: 20 }}>{i + 1}</div>
              <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 10, color: '#f4f4f5' }}>{step.title}</h3>
              <p style={{ fontSize: 15, color: '#71717a', lineHeight: 1.6, margin: 0 }}>{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="divider" />

      {/* PRICING */}
      <section id="pricing" style={{ padding: '0 24px 80px', maxWidth: 1140, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 60 }}>
          <div style={{ marginBottom: 12 }}><span className="badge">Pricing</span></div>
          <h2 style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', margin: '0 0 16px' }}>
            Simple, transparent <span className="gradient-text">pricing</span>
          </h2>
          <p style={{ color: '#71717a', fontSize: 17 }}>Start free. Upgrade when you're ready.</p>
        </div>

        <div className="plans-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, alignItems: 'start' }}>
          {PLANS.map((plan) => (
            <div key={plan.name} className={plan.highlight ? 'plan-popular' : 'glass-card'} style={{ padding: 28, borderRadius: 16, position: 'relative' }}>
              {plan.badge && (
                <div style={{ position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', borderRadius: 99, padding: '3px 14px', fontSize: 12, fontWeight: 700, color: 'white', whiteSpace: 'nowrap', boxShadow: '0 4px 12px rgba(99,102,241,0.4)' }}>
                  {plan.badge}
                </div>
              )}
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#71717a', letterSpacing: '0.05em', marginBottom: 8 }}>{plan.name.toUpperCase()}</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 42, fontWeight: 900, color: '#f4f4f5', letterSpacing: '-0.04em' }}>{plan.price}</span>
                  <span style={{ fontSize: 14, color: '#52525b' }}>/{plan.period}</span>
                </div>
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 28px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {plan.features.map(f => (
                  <li key={f} className="check-icon" style={{ fontSize: 14, color: '#a1a1aa', display: 'flex', alignItems: 'flex-start' }}>
                    <span style={{ color: '#818cf8', fontWeight: 700, marginRight: 8, flexShrink: 0 }}>✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <button
                className={plan.highlight ? 'btn-primary' : 'btn-ghost'}
                style={{ width: '100%', textAlign: 'center' }}
                onClick={() => onNavigate('register')}
              >
                {plan.name === 'Free' ? 'Get started free' : `Start ${plan.name}`}
              </button>
            </div>
          ))}
        </div>
      </section>

      <div className="divider" />

      {/* BOTTOM CTA */}
      <section style={{ padding: '0 24px 120px', textAlign: 'center' }}>
        <div style={{ maxWidth: 600, margin: '0 auto' }}>
          <div style={{ marginBottom: 12 }}><span className="badge">Ready to start?</span></div>
          <h2 style={{ fontSize: 44, fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1.1, marginBottom: 20 }}>
            Build your content empire<br /><span className="gradient-text">starting today</span>
          </h2>
          <p style={{ color: '#71717a', fontSize: 17, marginBottom: 36 }}>
            Join creators already using AI Content Studio to generate professional content at scale.
          </p>
          <button className="btn-primary" style={{ fontSize: 17, padding: '1rem 2.5rem' }} onClick={() => onNavigate('register')}>
            Create your free account →
          </button>
        </div>
      </section>

      {/* FOOTER */}
      <footer style={{ borderTop: '1px solid rgba(255,255,255,0.05)', padding: '24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 22, height: 22, borderRadius: 6, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800 }}>✦</div>
          <span style={{ fontSize: 13, color: '#52525b', fontWeight: 600 }}>AI Content Studio</span>
        </div>
        <div style={{ display: 'flex', gap: 20 }}>
          <button className="nav-link" style={{ fontSize: 13 }} onClick={() => onNavigate('login')}>Sign in</button>
          <button className="nav-link" style={{ fontSize: 13 }} onClick={() => onNavigate('register')}>Register</button>
        </div>
        <div style={{ fontSize: 12, color: '#3f3f46' }}>© {new Date().getFullYear()} AI Content Studio</div>
      </footer>
    </div>
  );
}
