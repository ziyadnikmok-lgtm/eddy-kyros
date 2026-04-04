import React, { useRef, useState } from 'react';
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
  Users,
  Video,
  Zap,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';

function IntroSweep() {
  return (
    <motion.div
      className="pointer-events-none fixed inset-0 z-[60] bg-[#08080c]"
      initial={{ opacity: 1 }}
      animate={{ opacity: 0 }}
      transition={{ duration: 0.6, delay: 0.95, ease: 'easeOut' }}
    >
      <motion.div
        className="absolute inset-y-0 left-0 w-full bg-gradient-to-r from-sky-400/20 via-cyan-300/12 to-transparent"
        initial={{ x: '-110%', skewX: -16 }}
        animate={{ x: '115%', skewX: -16 }}
        transition={{ duration: 1.15, ease: [0.22, 1, 0.36, 1] }}
      />
      <motion.div
        className="absolute inset-0"
        initial={{ opacity: 0.24 }}
        animate={{ opacity: 0 }}
        transition={{ duration: 0.8, delay: 0.5 }}
        style={{
          background:
            'radial-gradient(circle at 50% 35%, rgba(56,189,248,0.16), transparent 28%), radial-gradient(circle at 50% 60%, rgba(125,211,252,0.08), transparent 34%)',
        }}
      />
    </motion.div>
  );
}

function BlurFade({ children, className, delay = 0, yOffset = 20 }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-60px' });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: yOffset, filter: 'blur(8px)' }}
      animate={inView ? { opacity: 1, y: 0, filter: 'blur(0px)' } : undefined}
      transition={{ delay, duration: 0.6, ease: 'easeOut' }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function FAQItem({ question, answer, isOpen, onToggle }) {
  return (
    <div className="border-b border-white/[0.07]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center justify-between gap-4 py-5 text-left text-white transition-colors hover:text-sky-300"
      >
        <span className="text-base font-medium">{question}</span>
        <motion.div animate={{ rotate: isOpen ? 180 : 0 }} transition={{ duration: 0.22 }}>
          <ChevronDown className="h-4 w-4 shrink-0 text-white/30" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {isOpen ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <p className="pb-5 text-sm leading-7 text-white/45">{answer}</p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const FEATURES = [
  {
    icon: Image,
    label: 'Image Generation',
    title: 'Gemini-powered. Style-locked.',
    body: 'Generate stunning images that actually look consistent. Lock your character, style atoms, and references so every output fits your brand, not some random variation.',
    accent: 'from-sky-400/20 to-sky-400/0',
    iconColor: 'text-sky-300',
  },
  {
    icon: Video,
    label: 'Video Creation',
    title: 'Reels in minutes, not hours.',
    body: 'WaveSpeed and Veo-style video workflows are built right in. Go from prompt to finished short-form video without bouncing between separate apps.',
    accent: 'from-rose-400/20 to-rose-400/0',
    iconColor: 'text-rose-300',
  },
  {
    icon: Users,
    label: 'Character Engine',
    title: 'Build once. Use forever.',
    body: 'Create AI personas with locked appearance, outfits, and expressions. Every generation stays consistent across thousands of outputs.',
    accent: 'from-violet-400/20 to-violet-400/0',
    iconColor: 'text-violet-300',
  },
  {
    icon: Camera,
    label: 'Instagram Clone',
    title: 'Turn viral content into yours.',
    body: 'Scrape any profile with Apify, analyze what makes their posts work, then recreate the exact format in your own style without their watermark.',
    accent: 'from-pink-400/20 to-pink-400/0',
    iconColor: 'text-pink-300',
  },
  {
    icon: Zap,
    label: 'Batch and Auto Plans',
    title: 'Queue 100 posts. Walk away.',
    body: 'Auto Planner builds your full content calendar and executes it automatically. Come back to a week of content already generated and ready to post.',
    accent: 'from-cyan-400/20 to-cyan-400/0',
    iconColor: 'text-cyan-300',
  },
  {
    icon: ShieldCheck,
    label: 'Hosted Access',
    title: 'Use it from the web.',
    body: 'Your team or clients can access the platform through the hosted site, while your private local setup stays separate for internal workflows and testing.',
    accent: 'from-emerald-400/20 to-emerald-400/0',
    iconColor: 'text-emerald-300',
  },
];

const STEPS = [
  { num: '01', title: 'Create your account', body: 'Open the hosted site, sign up, and get into the platform fast without installing anything.' },
  { num: '02', title: 'Add your API keys', body: 'Paste Gemini, WaveSpeed, and Apify keys from the dashboard to unlock the full workflow.' },
  { num: '03', title: 'Build your character', body: 'Create a character once with style atoms, references, and outfits. It stays consistent across the whole workflow.' },
  { num: '04', title: 'Generate at scale', body: 'Queue batch jobs, run auto plans, and clone winning formats. Build weeks of content in one session.' },
];

const FAQS = [
  {
    question: 'What is Kyros Studio actually for?',
    answer: 'It is a hosted AI creative platform for creators and agencies who need consistent branded content at volume across images, reels, cloning, and planning workflows.',
  },
  {
    question: 'Do I need my own API key?',
    answer: 'Yes. You bring your own Gemini, WaveSpeed, and Apify keys so you keep control over providers and costs.',
  },
  {
    question: 'How is this different from Midjourney or Runway?',
    answer: 'Those are single-purpose tools. Kyros Studio combines image generation, video creation, character systems, Instagram clone workflows, and batch auto-planning in one hosted workflow.',
  },
  {
    question: 'What is the Instagram Clone workflow?',
    answer: 'You point the app at a profile using Apify, it analyzes the content structure, then helps you recreate those formats in your own character and style.',
  },
  {
    question: 'Do I need to install anything?',
    answer: 'No for normal users. The main product is accessed through the hosted site. The private local app setup is only for your internal workflow and development.',
  },
  {
    question: 'Can I generate content automatically?',
    answer: 'Yes. Auto Planner builds content schedules and the Batch Generator queues large runs, so you can set everything up and let it keep producing.',
  },
];

function Orb({ className, delay = 0, size = 400, color = 'rgba(59,130,246,0.08)' }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, y: [0, -18, 0] }}
      transition={{ delay, duration: 10, repeat: Infinity, ease: 'easeInOut' }}
      className={cn('pointer-events-none absolute rounded-full blur-3xl', className)}
      style={{ width: size, height: size, background: color }}
    />
  );
}

function GlowRing({ className }) {
  return (
    <motion.div
      className={cn('pointer-events-none absolute rounded-full border border-sky-300/20', className)}
      initial={{ opacity: 0.18, scale: 0.94 }}
      animate={{ opacity: [0.14, 0.3, 0.14], scale: [0.94, 1.02, 0.94] }}
      transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

export default function LandingPage({ onNavigate }) {
  const [openFAQ, setOpenFAQ] = useState(0);

  return (
    <div
      className="min-h-screen overflow-hidden text-white"
      style={{ background: '#08080c', fontFamily: "'DM Sans', sans-serif" }}
    >
      <IntroSweep />
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;700&family=Instrument+Serif:ital@0;1&display=swap');`}</style>

      <nav
        className="fixed left-0 right-0 top-0 z-50 flex items-center justify-between px-6 py-5 sm:px-8"
        style={{
          background: 'rgba(8,8,12,0.7)',
          backdropFilter: 'blur(20px)',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}
      >
        <div style={{ fontFamily: 'Instrument Serif', fontSize: 20, letterSpacing: '-0.02em' }}>
          Kyros <span style={{ color: '#7dd3fc' }}>Studio</span>
        </div>
        <div className="hidden gap-8 md:flex">
          {['Features', 'How It Works', 'FAQ'].map((label) => (
            <a
              key={label}
              href={`#${label.toLowerCase().replace(/\s+/g, '-')}`}
              className="text-sm transition-colors hover:text-white"
              style={{ color: 'rgba(255,255,255,0.45)', textDecoration: 'none' }}
            >
              {label}
            </a>
          ))}
        </div>
        <Button
          size="sm"
          className="px-5"
          style={{ background: '#3b82f6', color: '#eff6ff', fontWeight: 600 }}
          onClick={() => onNavigate?.('register')}
        >
          Get Access
        </Button>
      </nav>

      <section className="relative flex min-h-screen flex-col items-center justify-center px-6 pb-24 pt-32 text-center">
        <Orb className="-top-40 left-1/2 -translate-x-1/2" size={700} color="rgba(59,130,246,0.08)" />
        <Orb className="-left-40 top-1/2" size={500} color="rgba(139,92,246,0.06)" delay={0.5} />
        <Orb className="-right-40 top-1/3" size={400} color="rgba(34,211,238,0.07)" delay={1} />
        <GlowRing className="left-1/2 top-[22%] h-[18rem] w-[18rem] -translate-x-1/2 sm:h-[24rem] sm:w-[24rem]" />
        <GlowRing className="left-1/2 top-[22%] h-[24rem] w-[24rem] -translate-x-1/2 sm:h-[32rem] sm:w-[32rem]" />

        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
            'linear-gradient(rgba(255,255,255,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.025) 1px,transparent 1px)',
            backgroundSize: '72px 72px',
          }}
        />

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-6 inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium"
          style={{
            background: 'rgba(59,130,246,0.12)',
            border: '1px solid rgba(59,130,246,0.22)',
            color: '#93c5fd',
          }}
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-300"
            style={{ animation: 'pulse 2s infinite' }}
          />
          v8.1.0 - Now Available
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.7 }}
          style={{
            fontFamily: 'Instrument Serif',
            fontSize: 'clamp(52px, 9vw, 100px)',
            lineHeight: 1,
            letterSpacing: '-0.03em',
            marginBottom: 24,
          }}
        >
          Create better content
          <br />
          <em style={{ color: '#7dd3fc', fontStyle: 'italic' }}>without the chaos.</em>
        </motion.h1>

        <motion.div
          initial={{ opacity: 0, scaleX: 0.7 }}
          animate={{ opacity: 1, scaleX: 1 }}
          transition={{ delay: 0.22, duration: 0.75, ease: 'easeOut' }}
          className="mb-8 h-px w-32 origin-center bg-gradient-to-r from-transparent via-sky-300/70 to-transparent"
        />

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.7 }}
          className="mx-auto mb-10 max-w-xl text-lg leading-8"
          style={{ color: 'rgba(255,255,255,0.5)' }}
        >
          One hosted platform to generate images, create videos, build characters, clone Instagram content,
          and automate your entire content workflow powered by Gemini, WaveSpeed, and Apify.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.7 }}
          className="flex flex-wrap items-center justify-center gap-3"
        >
          <Button
            size="lg"
            className="group gap-2 px-8 font-semibold"
            style={{ background: '#3b82f6', color: '#eff6ff' }}
            onClick={() => onNavigate?.('register')}
          >
            <span>Start Creating</span>
            <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="group px-8"
            style={{
              border: '1px solid rgba(255,255,255,0.12)',
              color: 'rgba(255,255,255,0.7)',
              background: 'transparent',
            }}
            onClick={() => onNavigate?.('login')}
          >
            <span className="transition-colors duration-300 group-hover:text-white">Sign In</span>
          </Button>
        </motion.div>

        <motion.p
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.38, duration: 0.6 }}
          className="mt-4 text-sm"
          style={{ color: 'rgba(255,255,255,0.42)' }}
        >
          Beta phase. Free during testing.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45, duration: 0.7 }}
          className="mt-20 flex flex-wrap justify-center gap-12"
        >
          {[
            ['8+', 'AI integrations'],
            ['24/7', 'Hosted access'],
            ['∞', 'Batch generation'],
            ['v8.1', 'Current version'],
          ].map(([value, label], heroIndex) => (
            <motion.div
              key={label}
              className="text-center"
              whileHover={{ y: -4, scale: 1.03 }}
              transition={{ duration: 0.2 }}
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              style={{ transitionDelay: `${0.58 + 0.08 * heroIndex}s` }}
            >
              <div style={{ fontFamily: 'Instrument Serif', fontSize: 36, color: '#7dd3fc', lineHeight: 1 }}>
                {value}
              </div>
              <div className="mt-1 text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
                {label}
              </div>
            </motion.div>
          ))}
        </motion.div>
      </section>

      <section id="features" className="px-6 py-28">
        <div className="mx-auto max-w-6xl">
          <BlurFade className="mb-4 text-center">
            <div className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#7dd3fc' }}>
              Features
            </div>
          </BlurFade>
          <BlurFade delay={0.08} className="mb-16 text-center">
            <h2
              style={{
                fontFamily: 'Instrument Serif',
                fontSize: 'clamp(32px,5vw,56px)',
                lineHeight: 1.1,
                letterSpacing: '-0.03em',
              }}
            >
              Replace your entire
              <br />
              <em style={{ color: '#7dd3fc' }}>content stack.</em>
            </h2>
          </BlurFade>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature, index) => (
              <BlurFade key={feature.label} delay={0.06 * index}>
                <motion.div
                  className="group relative h-full rounded-2xl p-6 transition-all duration-300 hover:-translate-y-1"
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.07)',
                  }}
                  whileHover={{ y: -8, scale: 1.01 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                >
                  <motion.div
                    className={cn(
                      'absolute inset-0 rounded-2xl bg-gradient-to-b opacity-0 transition-opacity duration-300 group-hover:opacity-100',
                      feature.accent
                    )}
                    animate={{ opacity: [0.04, 0.08, 0.04] }}
                    transition={{ duration: 4 + index, repeat: Infinity, ease: 'easeInOut' }}
                  />
                  <div className="relative">
                    <motion.div
                      className="mb-4 inline-flex rounded-xl p-2.5"
                      style={{
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.08)',
                      }}
                      whileHover={{ rotate: -6, scale: 1.06 }}
                      transition={{ duration: 0.2 }}
                    >
                      <feature.icon className={cn('h-5 w-5', feature.iconColor)} />
                    </motion.div>
                    <div
                      className="mb-1 text-xs font-semibold uppercase tracking-widest"
                      style={{ color: 'rgba(255,255,255,0.3)' }}
                    >
                      {feature.label}
                    </div>
                    <h3 className="mb-3 text-lg font-semibold leading-tight text-white">{feature.title}</h3>
                    <p className="text-sm leading-7" style={{ color: 'rgba(255,255,255,0.45)' }}>
                      {feature.body}
                    </p>
                  </div>
                </motion.div>
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="px-6 py-28" style={{ background: 'rgba(255,255,255,0.02)' }}>
        <div className="mx-auto max-w-5xl">
          <BlurFade className="mb-4 text-center">
            <div className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#7dd3fc' }}>
              How It Works
            </div>
          </BlurFade>
          <BlurFade delay={0.08} className="mb-16 text-center">
            <h2
              style={{
                fontFamily: 'Instrument Serif',
                fontSize: 'clamp(32px,5vw,52px)',
                lineHeight: 1.1,
                letterSpacing: '-0.03em',
              }}
            >
              Up and running
              <br />
              <em style={{ color: '#7dd3fc' }}>in minutes.</em>
            </h2>
          </BlurFade>

          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, index) => (
              <BlurFade key={step.num} delay={0.08 * index}>
                <motion.div
                  className="relative rounded-2xl p-6"
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.07)',
                  }}
                  whileHover={{ y: -6 }}
                  transition={{ duration: 0.2 }}
                >
                  <div
                    style={{
                      fontFamily: 'Instrument Serif',
                      fontSize: 40,
                      color: 'rgba(59,130,246,0.22)',
                      lineHeight: 1,
                      marginBottom: 16,
                    }}
                  >
                    {step.num}
                  </div>
                  <h3 className="mb-2 font-semibold text-white">{step.title}</h3>
                  <p className="text-sm leading-6" style={{ color: 'rgba(255,255,255,0.4)' }}>
                    {step.body}
                  </p>
                  {index < STEPS.length - 1 ? (
                    <div
                      className="absolute -right-3 top-1/2 hidden -translate-y-1/2 lg:block"
                      style={{ color: 'rgba(255,255,255,0.15)', fontSize: 20 }}
                    >
                      →
                    </div>
                  ) : null}
                </motion.div>
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-20">
        <div className="mx-auto max-w-4xl text-center">
          <BlurFade>
            <p className="mb-8 text-sm uppercase tracking-widest" style={{ color: 'rgba(255,255,255,0.3)' }}>
              Replaces all of these
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {['Midjourney', 'RunwayML', 'CapCut', 'Later.com', 'Character.ai', 'Apify scraper', 'Lightroom'].map(
                (tool) => (
                  <motion.span
                    key={tool}
                    className="rounded-full px-4 py-2 text-sm line-through"
                    style={{
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: 'rgba(255,255,255,0.3)',
                    }}
                    whileHover={{ y: -2 }}
                    transition={{ duration: 0.18 }}
                  >
                    {tool}
                  </motion.span>
                )
              )}
              <motion.span
                className="rounded-full px-5 py-2 text-sm font-semibold"
                style={{
                  background: 'rgba(59,130,246,0.14)',
                  border: '1px solid rgba(59,130,246,0.28)',
                  color: '#93c5fd',
                }}
                whileHover={{ y: -2, scale: 1.02 }}
                transition={{ duration: 0.18 }}
              >
                ✦ Kyros Studio
              </motion.span>
            </div>
          </BlurFade>
        </div>
      </section>

      <section id="faq" className="px-6 py-28">
        <div className="mx-auto max-w-3xl">
          <BlurFade className="mb-4 text-center">
            <div className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#7dd3fc' }}>
              FAQ
            </div>
          </BlurFade>
          <BlurFade delay={0.08} className="mb-14 text-center">
            <h2
              style={{
                fontFamily: 'Instrument Serif',
                fontSize: 'clamp(28px,4vw,48px)',
                letterSpacing: '-0.03em',
              }}
            >
              Before you sign up.
            </h2>
          </BlurFade>
          <BlurFade delay={0.12}>
            <div
              className="rounded-2xl px-6 sm:px-8"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.07)',
              }}
            >
              {FAQS.map((faq, index) => (
                <FAQItem
                  key={faq.question}
                  question={faq.question}
                  answer={faq.answer}
                  isOpen={openFAQ === index}
                  onToggle={() => setOpenFAQ(openFAQ === index ? null : index)}
                />
              ))}
            </div>
          </BlurFade>
        </div>
      </section>

      <section className="px-6 pb-32">
        <div className="mx-auto max-w-4xl">
          <BlurFade>
            <motion.div
              className="relative overflow-hidden rounded-3xl p-12 text-center"
              style={{
                background: 'linear-gradient(135deg, rgba(59,130,246,0.1), rgba(34,211,238,0.08))',
                border: '1px solid rgba(59,130,246,0.18)',
              }}
              whileHover={{ scale: 1.01 }}
              transition={{ duration: 0.25 }}
            >
              <Orb className="-right-20 -top-20" size={300} color="rgba(59,130,246,0.1)" />
              <Orb className="-bottom-20 -left-20" size={300} color="rgba(34,211,238,0.08)" />
              <div className="relative">
                <Bot className="mx-auto mb-6 h-12 w-12" style={{ color: '#7dd3fc' }} />
                <h2
                  style={{
                    fontFamily: 'Instrument Serif',
                    fontSize: 'clamp(32px,5vw,56px)',
                    lineHeight: 1.05,
                    letterSpacing: '-0.03em',
                    marginBottom: 16,
                  }}
                >
                  Ready to build at scale?
                </h2>
                <p className="mx-auto mb-10 max-w-lg text-lg" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  Create an account, connect your keys, and start generating images, videos, and full content
                  calendars today.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-4">
                  <Button
                    size="lg"
                    className="group gap-2 px-10 font-semibold"
                    style={{ background: '#3b82f6', color: '#eff6ff' }}
                    onClick={() => onNavigate?.('register')}
                  >
                    <span>Create Account</span>
                    <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
                  </Button>
                  <Button
                    size="lg"
                    variant="outline"
                    className="group px-8"
                    style={{
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: 'rgba(255,255,255,0.7)',
                      background: 'transparent',
                    }}
                    onClick={() => onNavigate?.('login')}
                  >
                    <span className="transition-colors duration-300 group-hover:text-white">Sign In</span>
                  </Button>
                </div>
                <div
                  className="mt-8 flex flex-wrap items-center justify-center gap-6 text-sm"
                  style={{ color: 'rgba(255,255,255,0.35)' }}
                >
                  {['Hosted access', 'Bring your own keys', 'Built for scale'].map((item) => (
                    <span key={item} className="flex items-center gap-1.5">
                      <Check className="h-3.5 w-3.5" style={{ color: '#7dd3fc' }} /> {item}
                    </span>
                  ))}
                </div>
              </div>
            </motion.div>
          </BlurFade>
        </div>
      </section>

      <footer
        className="px-8 pb-10 pt-2 text-center text-xs"
        style={{
          color: 'rgba(255,255,255,0.25)',
          borderTop: '1px solid rgba(255,255,255,0.05)',
        }}
      >
        <span style={{ fontFamily: 'Instrument Serif', fontSize: 16, color: 'rgba(255,255,255,0.5)' }}>
          Kyros Studio
        </span>
        <span className="mx-3">·</span>© 2025 All rights reserved
      </footer>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
        * { box-sizing: border-box; }
        html { scroll-behavior: smooth; }
      `}</style>
    </div>
  );
}
