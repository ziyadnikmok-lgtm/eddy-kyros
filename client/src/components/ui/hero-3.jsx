import React from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, CalendarRange, Clapperboard, Layers3, MessageCircle, Sparkles } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './button';

const queueItems = [
  { label: 'Instagram Clone', value: '12 posts mapped', tone: 'bg-rose-400/12 text-rose-300 border-rose-400/20' },
  { label: 'WaveSpeed Video', value: '3 reels rendering', tone: 'bg-rose-400/12 text-rose-300 border-rose-400/20' },
  { label: 'Batch Queue', value: '24 prompts running', tone: 'bg-cyan-400/12 text-cyan-300 border-cyan-400/20' },
];

const statCards = [
  { label: 'Image gen', value: 'Gemini locked output' },
  { label: 'Video', value: 'WaveSpeed reels' },
  { label: 'Planner', value: 'Weekly content flow' },
];

export function HeroSection({ onNavigate }) {
  return (
    <section className="mx-auto w-full max-w-6xl overflow-hidden px-4 pb-20 pt-10 sm:px-6 lg:pt-16">
      <div aria-hidden="true" className="absolute inset-0 size-full overflow-hidden">
        <div
          className={cn(
            'absolute inset-0 isolate -z-10',
            'bg-[radial-gradient(26%_80%_at_20%_0%,rgba(56,189,248,0.14),transparent),radial-gradient(28%_70%_at_82%_10%,rgba(59,130,246,0.1),transparent),linear-gradient(180deg,#07090f_0%,#090c13_40%,#07090f_100%)]'
          )}
        />
      </div>

      <div className="relative z-10 grid items-center gap-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <div className="flex max-w-2xl flex-col gap-5">
          <motion.a
            href="#faq"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.08 }}
            className={cn(
              'group flex w-fit items-center gap-3 rounded-full border border-white/10 bg-white/[0.04] p-1 pr-3 shadow-sm backdrop-blur-xl'
            )}
          >
            <div className="rounded-full border border-rose-300/20 bg-rose-400/10 px-2.5 py-1 shadow-sm">
              <p className="font-mono text-[0.6875rem] uppercase tracking-[0.22em] text-rose-300">Beta</p>
            </div>
            <span className="text-xs text-zinc-300 sm:text-sm">Free during testing for early users</span>
            <span className="block h-5 border-l border-white/10" />
            <div className="pr-1">
              <ArrowRight className="size-3 -translate-x-0.5 text-zinc-400 duration-150 ease-out group-hover:translate-x-0.5 group-hover:text-white" />
            </div>
          </motion.a>

          <motion.h1
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.16 }}
            className="text-balance text-4xl font-medium leading-tight tracking-[-0.06em] text-white md:text-5xl lg:text-6xl"
          >
            Build image, video, clone, and planner workflows from one place.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.24 }}
            className="max-w-xl text-sm leading-7 tracking-wide text-zinc-400 sm:text-lg sm:leading-8"
          >
            Kyros Studio combines Gemini generation, Instagram clone workflows, WaveSpeed video, batch queues,
            and Auto Planner into one hosted workspace built for fast content teams.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.32 }}
            className="flex w-fit flex-wrap items-center justify-center gap-3 pt-2"
          >
            <Button
              variant="outline"
              className="border-white/15 bg-white/5 text-white hover:bg-white/10"
              onClick={() => onNavigate?.('login')}
            >
              <MessageCircle className="mr-2 size-4" />
              Sign In
            </Button>
            <Button
              className="bg-rose-500 text-white hover:bg-rose-400"
              onClick={() => onNavigate?.('register')}
            >
              Create Account
              <ArrowRight className="ml-2 size-4" />
            </Button>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.4 }}
            className="grid max-w-xl gap-3 pt-4 sm:grid-cols-3"
          >
            {statCards.map((card) => (
              <div key={card.label} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur-xl">
                <p className="text-[0.6875rem] uppercase tracking-[0.22em] text-zinc-500">{card.label}</p>
                <p className="mt-2 text-sm font-medium text-white">{card.value}</p>
              </div>
            ))}
          </motion.div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.85, delay: 0.22 }}
          className="relative"
        >
          <div className="absolute inset-x-0 -top-10 mx-auto h-56 w-56 rounded-full bg-rose-400/10 blur-[90px]" />
          <div className="absolute -right-10 bottom-8 h-32 w-32 rounded-full bg-cyan-400/10 blur-[70px]" />

          <div className="relative mx-auto max-w-2xl overflow-hidden rounded-[28px] border border-white/10 bg-[#0c1018] p-3 shadow-[0_30px_120px_rgba(0,0,0,0.45)] ring-1 ring-white/6">
            <div className="rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-4">
              <div className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Kyros workspace</p>
                  <p className="mt-1 text-sm font-medium text-white">Content command center</p>
                </div>
                <div className="inline-flex items-center gap-2 rounded-full border border-rose-400/20 bg-rose-400/10 px-3 py-1 text-xs text-rose-300">
                  <Sparkles className="size-3.5" />
                  Beta live
                </div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                <div className="space-y-3">
                  <div className="rounded-2xl border border-white/8 bg-[#0b0f16] p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Today</p>
                        <p className="mt-1 text-lg font-semibold text-white">Production queue</p>
                      </div>
                      <div className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-300">
                        1 running
                      </div>
                    </div>

                    <div className="mt-4 space-y-3">
                      {queueItems.map((item) => (
                        <div
                          key={item.label}
                          className="flex items-center justify-between rounded-xl border border-white/8 bg-white/[0.03] px-3 py-3"
                        >
                          <div>
                            <p className="text-sm font-medium text-white">{item.label}</p>
                            <p className="mt-1 text-xs text-zinc-500">{item.value}</p>
                          </div>
                          <span className={cn('rounded-full border px-2.5 py-1 text-[0.6875rem]', item.tone)}>Live</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                      <div className="flex items-center gap-2 text-rose-300">
                        <Layers3 className="size-4" />
                        <span className="text-xs uppercase tracking-[0.22em]">Clone</span>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-zinc-300">
                        Recreate viral post formats in your own character system.
                      </p>
                    </div>

                    <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                      <div className="flex items-center gap-2 text-rose-300">
                        <CalendarRange className="size-4" />
                        <span className="text-xs uppercase tracking-[0.22em]">Planner</span>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-zinc-300">
                        Map a week of output and batch-generate without tab juggling.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/8 bg-[#0b0f16] p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Preview</p>
                      <p className="mt-1 text-sm font-medium text-white">WaveSpeed reel workflow</p>
                    </div>
                    <Clapperboard className="size-4 text-cyan-300" />
                  </div>

                  <div className="mt-4 aspect-[4/5] rounded-[20px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.18),transparent_28%),linear-gradient(180deg,#111827_0%,#0b0f16_100%)] p-3">
                    <div className="flex h-full flex-col justify-between rounded-[16px] border border-white/8 bg-black/20 p-3">
                      <div className="flex items-center justify-between">
                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[0.6875rem] text-zinc-300">
                          9:16 preview
                        </span>
                        <span className="rounded-full border border-rose-400/20 bg-rose-400/10 px-2.5 py-1 text-[0.6875rem] text-rose-300">
                          Veo / WaveSpeed
                        </span>
                      </div>

                      <div className="space-y-3">
                        <div className="h-40 rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.12),rgba(255,255,255,0.03))]" />
                        <div className="grid grid-cols-3 gap-2">
                          <div className="h-12 rounded-xl border border-white/10 bg-white/[0.05]" />
                          <div className="h-12 rounded-xl border border-white/10 bg-white/[0.05]" />
                          <div className="h-12 rounded-xl border border-white/10 bg-white/[0.05]" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
