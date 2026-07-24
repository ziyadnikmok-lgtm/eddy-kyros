import React from 'react';
import {
  ArrowRight,
  Bot,
  ChevronRight,
  Clapperboard,
  Images,
  Menu,
  Sparkles,
  Wand2,
  Workflow,
  X,
} from 'lucide-react';
import { AnimatedGroup } from '../ui/animated-group';
import { Button } from '../ui/button';
import { TextEffect } from '../ui/text-effect';
import { cn } from '../../lib/utils';

const transitionVariants = {
  item: {
    hidden: { opacity: 0, filter: 'blur(12px)', y: 14 },
    visible: {
      opacity: 1,
      filter: 'blur(0px)',
      y: 0,
      transition: {
        type: 'spring',
        bounce: 0.26,
        duration: 1.25,
      },
    },
  },
};

const menuItems = [
  { name: 'Features', href: '#features' },
  { name: 'Workflow', href: '#workflow' },
  { name: 'Proof', href: '#proof' },
  { name: 'Pricing', href: '#pricing' },
];

const featureCards = [
  {
    title: 'Character-consistent outputs',
    text: 'Keep faces, body shape, styling, and identity locked across batches, carousels, reels, and edits.',
    icon: Sparkles,
  },
  {
    title: 'Generate, match, recreate',
    text: 'Build fresh shots, clone winning scenes, or use Photo Match and Nano Bypass to rework references fast.',
    icon: Images,
  },
  {
    title: 'Full creator workflow',
    text: 'From single images to batch calendars, style libraries, reels, and edit tools, everything stays in one system.',
    icon: Workflow,
  },
];

const proofItems = [
  'Character autofill across Generate, Batch, and Carousel',
  'Queued multi-image generation without blocking the next prompt',
  'Desktop library with save-to-folder downloads',
  'Photo Match, Scene Recreate, Reel Copy, and Nano Bypass workflows',
];

const stackItems = ['Gemini', 'Apify', 'Nano Bypass', 'Photo Match', 'Reel Copy', 'Batch Studio'];

export function HeroSection({ onNavigate }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#06070a] text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(58,90,255,0.18),transparent_32%),radial-gradient(circle_at_85%_20%,rgba(0,214,201,0.12),transparent_22%),linear-gradient(180deg,#07080c_0%,#090b10_40%,#050608_100%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.16] [background-image:linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.05)_1px,transparent_1px)] [background-size:96px_96px]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-[#1e3a8a]/20 to-transparent" />

      <HeroHeader onNavigate={onNavigate} />

      <main className="relative z-10">
        <section className="px-6 pb-16 pt-28 md:px-10 md:pb-20 md:pt-36">
          <div className="mx-auto grid max-w-7xl items-center gap-14 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="max-w-3xl">
              <AnimatedGroup variants={transitionVariants}>
                <a
                  href="#proof"
                  className="group inline-flex w-fit items-center gap-3 rounded-full border border-white/12 bg-white/6 px-4 py-1.5 text-sm text-zinc-200 backdrop-blur-xl transition hover:bg-white/10"
                >
                  <span className="inline-flex items-center gap-2">
                    <Bot className="h-4 w-4 text-cyan-300" />
                    Kyros Studio is live
                  </span>
                  <span className="h-4 w-px bg-white/10" />
                  <span className="inline-flex items-center gap-1 text-zinc-300">
                    Creator workflow engine
                    <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
                  </span>
                </a>

                <TextEffect
                  as="h1"
                  per="word"
                  delay={0.15}
                  className="mt-8 max-w-4xl text-balance text-5xl font-semibold tracking-[-0.06em] text-white md:text-7xl xl:text-[5.5rem]"
                >
                  Build images, edits, scenes, and reels with one premium AI studio.
                </TextEffect>

                <p className="mt-7 max-w-2xl text-balance text-lg leading-8 text-zinc-300 md:text-xl">
                  Kyros Studio turns scattered prompt hacks into a real production system. Generate fresh shots, match real photos,
                  recreate winning scenes, and keep your character consistent across every output.
                </p>
              </AnimatedGroup>

              <AnimatedGroup
                className="mt-10 flex flex-col gap-3 sm:flex-row"
                variants={{
                  container: { visible: { transition: { staggerChildren: 0.06, delayChildren: 0.45 } } },
                  ...transitionVariants,
                }}
              >
                <Button size="lg" className="group justify-center" onClick={() => onNavigate?.('register')}>
                  Get Started
                  <ArrowRight className="ml-2 h-4 w-4 transition group-hover:translate-x-0.5" />
                </Button>
                <Button size="lg" variant="outline" className="justify-center" onClick={() => onNavigate?.('login')}>
                  Sign In
                </Button>
              </AnimatedGroup>

              <AnimatedGroup
                className="mt-12 grid gap-4 sm:grid-cols-3"
                variants={{
                  container: { visible: { transition: { staggerChildren: 0.08, delayChildren: 0.6 } } },
                  ...transitionVariants,
                }}
              >
                <Metric label="Multi-step tools" value="12+" />
                <Metric label="Character-safe flows" value="Batch, Match, Reel" />
                <Metric label="Built for" value="Creator production" />
              </AnimatedGroup>
            </div>

            <AnimatedGroup
              className="relative"
              variants={{
                container: { visible: { transition: { staggerChildren: 0.08, delayChildren: 0.2 } } },
                ...transitionVariants,
              }}
            >
              <div className="absolute inset-0 -z-10 rounded-[2rem] bg-[radial-gradient(circle_at_center,rgba(88,124,255,0.25),transparent_55%)] blur-3xl" />
              <div className="overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.045] p-4 shadow-[0_35px_120px_rgba(0,0,0,0.45)] backdrop-blur-xl">
                <div className="rounded-[1.5rem] border border-white/8 bg-[#0b0e13] p-4">
                  <div className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.3em] text-cyan-300/80">Live workflow</div>
                      <div className="mt-1 text-lg font-medium text-white">Kyros control room</div>
                    </div>
                    <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-300">
                      <span className="h-2 w-2 rounded-full bg-emerald-300" />
                      System ready
                    </div>
                  </div>

                  <div className="mt-4 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
                    <div className="rounded-[1.4rem] border border-white/8 bg-gradient-to-br from-[#0f1724] via-[#0d1118] to-[#111723] p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs uppercase tracking-[0.28em] text-zinc-500">Launch panel</div>
                          <div className="mt-1 text-base font-medium">Model-directed generation</div>
                        </div>
                        <Wand2 className="h-4 w-4 text-cyan-300" />
                      </div>

                      <div className="mt-4 overflow-hidden rounded-[1.2rem] border border-white/8">
                        <img
                          src="https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=1200&q=80"
                          alt="Generated portrait preview"
                          className="h-[320px] w-full object-cover"
                        />
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2">
                        {stackItems.map((item) => (
                          <span key={item} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-zinc-300">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="grid gap-4">
                      <MiniPanel
                        icon={Clapperboard}
                        title="Scene Recreate"
                        text="Pull winning framing from a reference and keep identity locked."
                      />
                      <MiniPanel
                        icon={Sparkles}
                        title="Photo Match"
                        text="Use a real source photo as the blueprint and generate a matching output faster."
                      />
                      <MiniPanel
                        icon={Images}
                        title="Nano Bypass"
                        text="Blend multiple refs, transform them, and keep the next prompt moving in queue."
                      />
                    </div>
                  </div>
                </div>
              </div>
            </AnimatedGroup>
          </div>
        </section>

        <section id="proof" className="px-6 pb-8 md:px-10">
          <div className="mx-auto grid max-w-6xl gap-4 rounded-[2rem] border border-white/10 bg-white/[0.035] p-6 backdrop-blur-xl md:grid-cols-4">
            {proofItems.map((item) => (
              <div key={item} className="rounded-[1.4rem] border border-white/8 bg-black/20 p-5 text-sm leading-6 text-zinc-300">
                <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-cyan-400/20 bg-cyan-400/10">
                  <ChevronRight className="h-4 w-4 text-cyan-300" />
                </div>
                {item}
              </div>
            ))}
          </div>
        </section>

        <section id="features" className="px-6 py-18 md:px-10 md:py-24">
          <div className="mx-auto max-w-6xl">
            <div className="max-w-2xl">
              <div className="inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.3em] text-zinc-400">
                Features
              </div>
              <h2 className="mt-5 text-4xl font-semibold tracking-[-0.04em] text-white md:text-5xl">
                Not just image generation. A full visual workflow stack.
              </h2>
              <p className="mt-4 max-w-xl text-lg leading-8 text-zinc-400">
                The landing page now sells the real product: creator-grade generation, matching, remixing, and output management in one system.
              </p>
            </div>

            <div className="mt-10 grid gap-4 lg:grid-cols-3">
              {featureCards.map((card) => (
                <div key={card.title} className="rounded-[1.6rem] border border-white/10 bg-white/[0.04] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.28)]">
                  <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/6">
                    <card.icon className="h-5 w-5 text-cyan-300" />
                  </div>
                  <h3 className="mt-5 text-xl font-medium text-white">{card.title}</h3>
                  <p className="mt-3 text-sm leading-7 text-zinc-400">{card.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="workflow" className="px-6 pb-18 md:px-10 md:pb-24">
          <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[0.95fr_1.05fr]">
            <div className="rounded-[2rem] border border-white/10 bg-white/[0.035] p-6">
              <div className="inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.3em] text-zinc-400">
                Workflow
              </div>
              <h3 className="mt-5 text-3xl font-semibold tracking-[-0.04em]">Built for how people actually create.</h3>
              <p className="mt-4 max-w-lg text-zinc-400 leading-8">
                You start with an idea, lock the character, reuse strong references, spin variants in queue, and move straight into edits, reels, and exports.
              </p>

              <div className="mt-8 space-y-4">
                <StepItem number="01" title="Choose a character" text="Auto-fill prompts and references so the flow starts with identity already locked." />
                <StepItem number="02" title="Generate or match" text="Use Generate, Scene Recreate, Photo Match, or Nano Bypass depending on the content goal." />
                <StepItem number="03" title="Ship faster" text="Queue more images, organize in Library, and export the exact assets you want." />
              </div>
            </div>

            <div className="rounded-[2rem] border border-white/10 bg-[#0a0d12] p-4">
              <div className="overflow-hidden rounded-[1.6rem] border border-white/8">
                <img
                  src="https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=1600&q=80"
                  alt="Creative control room background"
                  className="h-[220px] w-full object-cover"
                />
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <StatCard label="Queue multiple prompts" value="No hard wait state" />
                <StatCard label="Prompt + refs" value="Character-aware" />
                <StatCard label="Desktop exports" value="Folder save flow" />
                <StatCard label="Output styles" value="Image, reel, remix" />
              </div>
            </div>
          </div>
        </section>

        <section id="pricing" className="px-6 pb-24 md:px-10">
          <div className="mx-auto max-w-6xl rounded-[2.2rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-8 md:p-10">
            <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
              <div className="max-w-2xl">
                <div className="inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.3em] text-zinc-400">
                  Start here
                </div>
                <h3 className="mt-5 text-4xl font-semibold tracking-[-0.05em] text-white">Turn prompt chaos into a real studio.</h3>
                <p className="mt-4 text-lg leading-8 text-zinc-400">
                  The public site now feels more premium, product-led, and cinematic, while still pointing people straight into signup.
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Button size="lg" onClick={() => onNavigate?.('register')}>
                  Create Account
                </Button>
                <Button size="lg" variant="outline" onClick={() => onNavigate?.('login')}>
                  Login
                </Button>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function HeroHeader({ onNavigate }) {
  const [menuState, setMenuState] = React.useState(false);
  const [isScrolled, setIsScrolled] = React.useState(false);

  React.useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 24);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <header className="fixed inset-x-0 top-0 z-30 px-3 md:px-6">
      <nav data-state={menuState ? 'active' : 'idle'} className="group">
        <div
          className={cn(
            'mx-auto mt-3 max-w-7xl rounded-[1.4rem] border border-white/8 bg-black/20 px-5 backdrop-blur-xl transition-all duration-300 md:px-7',
            isScrolled && 'max-w-6xl bg-black/45 shadow-[0_20px_60px_rgba(0,0,0,0.35)]'
          )}
        >
          <div className="relative flex min-h-16 items-center justify-between gap-6 py-3">
            <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="flex items-center gap-3 text-left">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#a5b4fc,#22d3ee)] text-sm font-semibold text-black">
                K
              </div>
              <div>
                <div className="text-sm font-semibold tracking-tight text-white">Kyros Studio</div>
                <div className="text-[0.6875rem] uppercase tracking-[0.25em] text-zinc-500">Creator AI Suite</div>
              </div>
            </button>

            <div className="absolute left-1/2 hidden -translate-x-1/2 lg:block">
              <ul className="flex items-center gap-8 text-sm text-zinc-400">
                {menuItems.map((item) => (
                  <li key={item.name}>
                    <a href={item.href} className="transition hover:text-white">
                      {item.name}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            <div className="hidden items-center gap-3 lg:flex">
              <Button variant="ghost" size="sm" onClick={() => onNavigate?.('login')}>
                Login
              </Button>
              <Button size="sm" onClick={() => onNavigate?.('register')}>
                Sign Up
              </Button>
            </div>

            <button
              type="button"
              aria-label={menuState ? 'Close Menu' : 'Open Menu'}
              onClick={() => setMenuState((value) => !value)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-200 lg:hidden"
            >
              {menuState ? <X className="h-4.5 w-4.5" /> : <Menu className="h-4.5 w-4.5" />}
            </button>
          </div>

          {menuState ? (
            <div className="border-t border-white/8 pb-5 pt-2 lg:hidden">
              <div className="space-y-2 py-3">
                {menuItems.map((item) => (
                  <a
                    key={item.name}
                    href={item.href}
                    onClick={() => setMenuState(false)}
                    className="block rounded-2xl px-3 py-2 text-sm text-zinc-300 transition hover:bg-white/5 hover:text-white"
                  >
                    {item.name}
                  </a>
                ))}
              </div>
              <div className="mt-2 flex flex-col gap-2">
                <Button variant="outline" size="sm" onClick={() => onNavigate?.('login')}>
                  Login
                </Button>
                <Button size="sm" onClick={() => onNavigate?.('register')}>
                  Sign Up
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </nav>
    </header>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-[1.4rem] border border-white/10 bg-white/[0.045] px-5 py-4">
      <div className="text-[0.6875rem] uppercase tracking-[0.28em] text-zinc-500">{label}</div>
      <div className="mt-2 text-sm font-medium text-zinc-100 md:text-base">{value}</div>
    </div>
  );
}

function MiniPanel({ icon: Icon, title, text }) {
  return (
    <div className="rounded-[1.35rem] border border-white/8 bg-white/[0.04] p-4">
      <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-black/20">
        <Icon className="h-4.5 w-4.5 text-cyan-300" />
      </div>
      <div className="mt-4 text-sm font-medium text-white">{title}</div>
      <div className="mt-2 text-sm leading-6 text-zinc-400">{text}</div>
    </div>
  );
}

function StepItem({ number, title, text }) {
  return (
    <div className="flex gap-4 rounded-[1.4rem] border border-white/8 bg-black/15 p-4">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-sm font-semibold text-cyan-300">
        {number}
      </div>
      <div>
        <div className="text-base font-medium text-white">{title}</div>
        <div className="mt-1 text-sm leading-6 text-zinc-400">{text}</div>
      </div>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="rounded-[1.3rem] border border-white/8 bg-white/[0.04] p-4">
      <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">{label}</div>
      <div className="mt-2 text-base font-medium text-zinc-100">{value}</div>
    </div>
  );
}
