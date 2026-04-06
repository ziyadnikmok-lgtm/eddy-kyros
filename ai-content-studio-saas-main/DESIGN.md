# Design System — AI Content Studio

## Product Context
**What:** AI content generation platform for creators (OnlyFans, Instagram, TikTok)
**Type:** Dark-theme web app / creative tool
**Aesthetic:** Premium dark with glass morphism, ambient glow, subtle noise texture

## Typography

| Role | Font | Size | Weight | Treatment |
|------|------|------|--------|-----------|
| Primary sans | Outfit | — | — | All UI text |
| Mono | JetBrains Mono | — | — | Data, version badges, timers, API keys |
| Page title | Outfit | text-3xl (30px) | bold | tracking-tight, text-gradient (white→zinc) |
| Nav sections | Outfit | text-[10px] | semibold | uppercase, tracking-wider |
| Modal title | Outfit | text-lg (18px) | semibold | text-zinc-100 |
| Section header | Outfit | text-xs (12px) | medium | text-zinc-400 |
| Form label | Outfit | text-sm (14px) | medium | text-zinc-400 |
| Body | Outfit | text-sm (14px) | regular | text-zinc-200 |

**Rules:**
- Max 2 font families
- Heading scale: ~1.25 major third ratio
- No skipped heading levels
- `tabular-nums` on all number displays
- `font-variant-numeric: tabular-nums` on data columns

## Color

### Tokens (defined in index.css @theme)
| Token | Value | Usage |
|-------|-------|-------|
| `--color-accent` | #3b82f6 | Primary accent, active states, focus rings |
| `--color-accent-hover` | #2563eb | Hover states |
| `--color-accent-muted` | #3b82f620 | Muted backgrounds |
| `--color-success` | #22c55e | Success, health, completion |
| `--color-warning` | #f59e0b | Warning indicators |
| `--color-danger` | #ef4444 | Error, destructive actions |

### Surface Palette
| Surface | Value | Usage |
|---------|-------|-------|
| Background | zinc-950 | Main app background |
| Sidebar | zinc-900/95 + backdrop-blur-md | Sidebar background |
| Header | zinc-900/60 + backdrop-blur-md | Top header |
| Card (glass) | rgba(24,24,27,0.65) + blur(12px) | All cards |
| Input | zinc-900/50 + inset-depth shadow | Form inputs |

### Text Hierarchy
| Level | Color |
|-------|-------|
| Primary | zinc-100 (#f4f4f5) — off-white, not pure white |
| Secondary | zinc-300 (#d4d4d8) |
| Label | zinc-400 (#a1a1aa) |
| Placeholder | zinc-500 (#71717a) |
| Muted | zinc-600 (#52525b) |

### Borders
| Usage | Value |
|-------|-------|
| Card borders | zinc-800/60 |
| Input borders | zinc-700/60 |
| Modal borders | zinc-700/50 |
| Subtle dividers | zinc-800/40 |
| Focus ring | blue-500/40 (2px, with offset) |

**Rules:**
- One accent color (blue). No competing accents.
- Warm-neutral zinc base (not cool gray or slate)
- Semantic colors: green=success, amber=warning, red=danger
- Never pure white (#fff) for text — use zinc-100

## Spacing

**Base unit:** 4px (Tailwind default)

| Token | Value | Usage |
|-------|-------|-------|
| gap-1.5 | 6px | Tight spacing (label→input) |
| gap-2 | 8px | Standard component gap |
| gap-2.5 | 10px | Comfortable component gap |
| gap-3 | 12px | Section element spacing |
| p-4 / p-5 | 16-20px | Card internal padding |
| p-3 to p-6 | 12-24px | Page padding (responsive) |

**Layout Constants:**
- Sidebar: w-60 (240px)
- Header: h-14 (56px)
- Content max-width: max-w-6xl
- Input height: h-10 (40px)

## Border Radius Hierarchy

| Element | Radius | Class |
|---------|--------|-------|
| Cards, Modals | 12px | rounded-xl |
| Buttons, Inputs | 8px | rounded-lg |
| Badges | 6px | rounded-md |
| Toggles, Dots, Pills | 999px | rounded-full |

**Rule:** Not uniform — radius decreases with element size. Cards > buttons > badges > pills.

## Component Patterns

### Buttons (4 variants)
- **Primary:** bg-blue-600, glow shadow, hover brightens + grows shadow
- **Secondary:** bg-zinc-800/80, subtle border, hover lightens
- **Danger:** bg-red-600/90, red glow shadow
- **Ghost:** transparent, hover shows zinc-800 background
- **All:** active:scale-[0.97], focus-visible ring, disabled:opacity-50

### Inputs
- inset-depth (inner shadow) for depth
- Focus: blue border + ring + 3px outer glow
- Hover: border lightens

### Cards
- `glass` (rgba bg + backdrop-blur) + `noise` (SVG noise overlay at 3.5% opacity)
- border-zinc-800/60
- rounded-xl

### Animations
| Animation | Duration | Easing | Usage |
|-----------|----------|--------|-------|
| fade-in | 300ms | ease-out | Page content entry |
| dialog-content-show | 200ms | cubic-bezier(0.16,1,0.3,1) | Modal open |
| overlay-show | 200ms | ease-out | Backdrop fade |
| toast-slide-in | 350ms | cubic-bezier(0.16,1,0.3,1) | Toast entry |
| shimmer | 1.8s | ease-in-out infinite | Skeleton loading |
| glow-breathe | continuous | ease | Logo ambient glow |

### Special Utilities
- `glass` — rgba bg + backdrop-blur-12
- `noise` — SVG fractalNoise overlay at 3.5% opacity
- `inset-depth` — inner box-shadow for recessed inputs
- `text-gradient` — white→zinc gradient text
- `ambient-glow` — radial blue gradient in top-left corner

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-18 | Baseline captured from live site | Inferred by /plan-design-review |
| 2026-03-18 | Outfit font chosen over Inter/Roboto | Distinctive personality without being decorative |
| 2026-03-18 | Glass morphism as card treatment | Creates depth layers in dark theme |
| 2026-03-18 | Blue-only accent | Single accent prevents visual chaos in a 20-page app |
| 2026-03-18 | Off-white text (zinc-100 not white) | Reduces eye strain in dark theme |
