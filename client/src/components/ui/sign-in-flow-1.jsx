"use client";

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { AnimatePresence, motion } from 'framer-motion';
import * as THREE from 'three';
import {
  ArrowRight,
  Clapperboard,
  ImagePlus,
  Layers3,
  Menu,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';

function ShaderPlane({ source, uniforms }) {
  const meshRef = useRef(null);
  const { size } = useThree();

  const material = useMemo(() => {
    const preparedUniforms = {};

    Object.entries(uniforms).forEach(([name, uniform]) => {
      switch (uniform.type) {
        case 'uniform1f':
        case 'uniform1i':
        case 'uniform1fv':
          preparedUniforms[name] = { value: uniform.value };
          break;
        case 'uniform3fv':
          preparedUniforms[name] = {
            value: uniform.value.map((value) => new THREE.Vector3().fromArray(value)),
          };
          break;
        default:
          preparedUniforms[name] = { value: uniform.value };
      }
    });

    preparedUniforms.u_time = { value: 0 };
    preparedUniforms.u_resolution = { value: new THREE.Vector2(size.width * 2, size.height * 2) };

    return new THREE.ShaderMaterial({
      vertexShader: `
        precision mediump float;
        uniform vec2 u_resolution;
        out vec2 fragCoord;
        void main() {
          gl_Position = vec4(position, 1.0);
          fragCoord = (position.xy + vec2(1.0)) * 0.5 * u_resolution;
          fragCoord.y = u_resolution.y - fragCoord.y;
        }
      `,
      fragmentShader: source,
      uniforms: preparedUniforms,
      glslVersion: THREE.GLSL3,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }, [size.height, size.width, source, uniforms]);

  useEffect(() => {
    material.uniforms.u_resolution.value = new THREE.Vector2(size.width * 2, size.height * 2);
  }, [material, size.height, size.width]);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    meshRef.current.material.uniforms.u_time.value = clock.getElapsedTime();
  });

  return (
    <mesh ref={meshRef}>
      <planeGeometry args={[2, 2]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

function Shader({ source, uniforms }) {
  return (
    <Canvas className="absolute inset-0 h-full w-full">
      <ShaderPlane source={source} uniforms={uniforms} />
    </Canvas>
  );
}

function DotMatrix({
  colors = [[255, 255, 255]],
  opacities = [0.04, 0.04, 0.04, 0.08, 0.08, 0.12, 0.12, 0.18, 0.2, 0.3],
  totalSize = 20,
  dotSize = 3,
  reverse = false,
}) {
  const uniforms = useMemo(() => {
    let colorsArray = [colors[0], colors[0], colors[0], colors[0], colors[0], colors[0]];
    if (colors.length === 2) {
      colorsArray = [colors[0], colors[0], colors[0], colors[1], colors[1], colors[1]];
    } else if (colors.length >= 3) {
      colorsArray = [colors[0], colors[0], colors[1], colors[1], colors[2], colors[2]];
    }

    return {
      u_colors: {
        value: colorsArray.map((color) => [color[0] / 255, color[1] / 255, color[2] / 255]),
        type: 'uniform3fv',
      },
      u_opacities: {
        value: opacities,
        type: 'uniform1fv',
      },
      u_total_size: {
        value: totalSize,
        type: 'uniform1f',
      },
      u_dot_size: {
        value: dotSize,
        type: 'uniform1f',
      },
      u_reverse: {
        value: reverse ? 1 : 0,
        type: 'uniform1i',
      },
    };
  }, [colors, dotSize, opacities, reverse, totalSize]);

  return (
    <Shader
      uniforms={uniforms}
      source={`
        precision mediump float;
        in vec2 fragCoord;
        uniform float u_time;
        uniform float u_opacities[10];
        uniform vec3 u_colors[6];
        uniform float u_total_size;
        uniform float u_dot_size;
        uniform vec2 u_resolution;
        uniform int u_reverse;
        out vec4 fragColor;

        float PHI = 1.61803398874989484820459;

        float random(vec2 xy) {
          return fract(tan(distance(xy * PHI, xy) * 0.45) * xy.x);
        }

        void main() {
          vec2 st = fragCoord.xy;
          st.x -= abs(floor((mod(u_resolution.x, u_total_size) - u_dot_size) * 0.5));
          st.y -= abs(floor((mod(u_resolution.y, u_total_size) - u_dot_size) * 0.5));

          float opacity = step(0.0, st.x) * step(0.0, st.y);
          vec2 cell = vec2(int(st.x / u_total_size), int(st.y / u_total_size));

          float frequency = 5.0;
          float showOffset = random(cell);
          float rand = random(cell * floor((u_time / frequency) + showOffset + frequency));

          opacity *= u_opacities[int(rand * 10.0)];
          opacity *= 1.0 - step(u_dot_size / u_total_size, fract(st.x / u_total_size));
          opacity *= 1.0 - step(u_dot_size / u_total_size, fract(st.y / u_total_size));

          vec3 color = u_colors[int(showOffset * 6.0)];

          vec2 centerGrid = u_resolution / 2.0 / u_total_size;
          float distFromCenter = distance(centerGrid, cell);
          float maxGridDist = distance(centerGrid, vec2(0.0, 0.0));
          float timingOffsetIntro = distFromCenter * 0.011 + (random(cell) * 0.15);
          float timingOffsetOutro = (maxGridDist - distFromCenter) * 0.02 + (random(cell + 42.0) * 0.18);

          float speed = 0.7;
          float currentTimingOffset = u_reverse == 1 ? timingOffsetOutro : timingOffsetIntro;

          if (u_reverse == 1) {
            opacity *= 1.0 - step(currentTimingOffset, u_time * speed);
          } else {
            opacity *= step(currentTimingOffset, u_time * speed);
          }

          fragColor = vec4(color, opacity);
          fragColor.rgb *= fragColor.a;
        }
      `}
    />
  );
}

export function CanvasRevealEffect({
  colors = [[255, 255, 255]],
  dotSize = 4,
  reverse = false,
  containerClassName,
  showGradient = true,
}) {
  return (
    <div className={cn('relative h-full w-full', containerClassName)}>
      <DotMatrix colors={colors} dotSize={dotSize} reverse={reverse} />
      {showGradient ? <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" /> : null}
    </div>
  );
}

function AnimatedNavLink({ href, children }) {
  return (
    <a href={href} className="group relative inline-flex h-5 items-center overflow-hidden text-sm text-zinc-400">
      <span className="flex flex-col transition-transform duration-300 ease-out group-hover:-translate-y-1/2">
        <span>{children}</span>
        <span className="text-white">{children}</span>
      </span>
    </a>
  );
}

function BrandMark() {
  return (
    <div className="relative flex h-5 w-5 items-center justify-center">
      <span className="absolute top-0 h-1.5 w-1.5 rounded-full bg-white/90" />
      <span className="absolute bottom-0 h-1.5 w-1.5 rounded-full bg-white/90" />
      <span className="absolute left-0 h-1.5 w-1.5 rounded-full bg-cyan-300" />
      <span className="absolute right-0 h-1.5 w-1.5 rounded-full bg-cyan-300" />
    </div>
  );
}

export function MiniNavbar({ onNavigate }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <header className="fixed left-1/2 top-5 z-30 w-[calc(100%-1.5rem)] max-w-5xl -translate-x-1/2 rounded-full border border-white/10 bg-black/30 px-5 py-3 backdrop-blur-xl">
      <div className="flex items-center justify-between gap-5">
        <button type="button" onClick={() => onNavigate?.('landing')} className="flex items-center gap-3 text-left">
          <BrandMark />
          <div>
            <div className="text-sm font-semibold tracking-tight text-white">Kyros Studio</div>
            <div className="text-[0.625rem] uppercase tracking-[0.25em] text-zinc-500">Visual workflow AI</div>
          </div>
        </button>

        <nav className="hidden items-center gap-6 sm:flex">
          <AnimatedNavLink href="#product">Product</AnimatedNavLink>
          <AnimatedNavLink href="#flows">Flows</AnimatedNavLink>
          <AnimatedNavLink href="#proof">Proof</AnimatedNavLink>
        </nav>

        <div className="hidden items-center gap-2 sm:flex">
          <button
            type="button"
            onClick={() => onNavigate?.('login')}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-200 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
          >
            Log In
          </button>
          <button
            type="button"
            onClick={() => onNavigate?.('register')}
            className="rounded-full bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-zinc-200"
          >
            Sign Up
          </button>
        </div>

        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-200 sm:hidden"
          onClick={() => setIsOpen((value) => !value)}
          aria-label={isOpen ? 'Close menu' : 'Open menu'}
        >
          {isOpen ? <X className="h-4.5 w-4.5" /> : <Menu className="h-4.5 w-4.5" />}
        </button>
      </div>

      <AnimatePresence>
        {isOpen ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden sm:hidden"
          >
            <div className="mt-4 space-y-3 border-t border-white/8 pt-4">
              <a href="#product" className="block text-sm text-zinc-300">Product</a>
              <a href="#flows" className="block text-sm text-zinc-300">Flows</a>
              <a href="#proof" className="block text-sm text-zinc-300">Proof</a>
              <div className="flex flex-col gap-2 pt-2">
                <button type="button" onClick={() => onNavigate?.('login')} className="rounded-full border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-zinc-200">
                  Log In
                </button>
                <button type="button" onClick={() => onNavigate?.('register')} className="rounded-full bg-white px-4 py-2.5 text-sm font-medium text-black">
                  Sign Up
                </button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}

function ProductFeature({ icon: Icon, title, text }) {
  return (
    <div className="rounded-[1.35rem] border border-white/10 bg-white/[0.04] p-4">
      <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-black/30">
        <Icon className="h-4.5 w-4.5 text-cyan-300" />
      </div>
      <div className="mt-4 text-sm font-medium text-white">{title}</div>
      <div className="mt-2 text-sm leading-6 text-zinc-400">{text}</div>
    </div>
  );
}

export function AuthShowcase({ compact = false, title, subtitle, ctaLabel, onCta }) {
  const features = compact
    ? [
        { icon: Sparkles, title: 'Character lock', text: 'Keep prompt + refs aligned across every output.' },
        { icon: ImagePlus, title: 'Photo Match', text: 'Use real source photos as the scene blueprint.' },
        { icon: Layers3, title: 'Nano Bypass', text: 'Blend refs, remix scenes, queue the next shot faster.' },
      ]
    : [
        { icon: Sparkles, title: 'Generate with identity lock', text: 'Characters now auto-seed prompts and references where the workflow needs them.' },
        { icon: ImagePlus, title: 'Match and recreate', text: 'Photo Match, Scene Recreate, and Reel Copy turn real references into usable production flows.' },
        { icon: Wand2, title: 'Edit and remix', text: 'Nano Bypass and multi-image tools let you move from concept to output without leaving the studio.' },
        { icon: Clapperboard, title: 'Ship faster', text: 'Queue multiple generations, save real folders from Library, and keep the whole workflow in one place.' },
      ];

  return (
    <div className="space-y-7">
      <div className="space-y-4">
        <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs uppercase tracking-[0.28em] text-cyan-200">
          Kyros Studio
        </div>
        <h1 className="max-w-2xl text-balance text-5xl font-semibold tracking-[-0.06em] text-white md:text-6xl">
          {title || 'The AI studio for character-driven visual production.'}
        </h1>
        <p className="max-w-xl text-lg leading-8 text-zinc-300">
          {subtitle || 'Generate, match, remix, and export inside one workflow built for consistent image, reel, and scene creation.'}
        </p>
      </div>

      {!compact ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {features.map((feature) => (
            <ProductFeature key={feature.title} icon={feature.icon} title={feature.title} text={feature.text} />
          ))}
        </div>
      ) : null}

      <div id="proof" className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-[1.3rem] border border-white/10 bg-black/20 px-4 py-3">
          <div className="text-[0.6875rem] uppercase tracking-[0.28em] text-zinc-500">Flows</div>
          <div className="mt-2 text-sm text-zinc-100">Generate, Match, Remix, Reel</div>
        </div>
        <div className="rounded-[1.3rem] border border-white/10 bg-black/20 px-4 py-3">
          <div className="text-[0.6875rem] uppercase tracking-[0.28em] text-zinc-500">Updated</div>
          <div className="mt-2 text-sm text-zinc-100">Queue, folder downloads, prompt autofill</div>
        </div>
        <div className="rounded-[1.3rem] border border-white/10 bg-black/20 px-4 py-3">
          <div className="text-[0.6875rem] uppercase tracking-[0.28em] text-zinc-500">Built for</div>
          <div className="mt-2 text-sm text-zinc-100">Fast creator production</div>
        </div>
      </div>

      {ctaLabel ? (
        <button
          type="button"
          onClick={onCta}
          className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-medium text-black transition hover:bg-zinc-200"
        >
          {ctaLabel}
          <ArrowRight className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

export function AuthShell({ children, onNavigate, compact = false, title, subtitle, ctaLabel, onCta }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-black text-white">
      <div className="absolute inset-0 z-0">
        <CanvasRevealEffect
          containerClassName="bg-black"
          colors={[[255, 255, 255], [74, 222, 255], [255, 255, 255]]}
          dotSize={5}
        />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(0,0,0,0.78)_0%,rgba(0,0,0,0.92)_55%,rgba(0,0,0,1)_100%)]" />
        <div className="absolute inset-x-0 top-0 h-52 bg-gradient-to-b from-black via-black/70 to-transparent" />
      </div>

      <div className="relative z-10">
        <MiniNavbar onNavigate={onNavigate} />

        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-10 px-6 pb-10 pt-32 lg:flex-row lg:items-center lg:gap-16">
          <section id="product" className="flex-1">
            <AuthShowcase compact={compact} title={title} subtitle={subtitle} ctaLabel={ctaLabel} onCta={onCta} />
          </section>

          <section id="flows" className="w-full max-w-xl lg:max-w-md">
            {children}
          </section>
        </div>
      </div>
    </div>
  );
}
