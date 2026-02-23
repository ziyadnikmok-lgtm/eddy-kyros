import { useState } from 'react';
import { useApp } from '../context/AppContext';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '../lib/utils';

/* ── Spinner ────────────────────────────────────────── */
export function Spinner({ size = 24, className = '' }) {
  return <div className={cn('spinner', className)} style={{ width: size, height: size }} />;
}

/* ── Button ─────────────────────────────────────────── */
export function Btn({ children, variant = 'primary', className = '', disabled, ...props }) {
  const base = cn(
    'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium',
    'transition-all duration-150 cursor-pointer',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950',
    'disabled:opacity-50 disabled:pointer-events-none',
    'active:scale-[0.97]',
  );
  const variants = {
    primary: 'bg-blue-600 hover:bg-blue-500 text-white shadow-[0_0_20px_rgba(59,130,246,0.25),0_4px_12px_rgba(59,130,246,0.15)] hover:shadow-[0_0_28px_rgba(59,130,246,0.35),0_6px_16px_rgba(59,130,246,0.2)]',
    secondary: 'bg-zinc-800/80 hover:bg-zinc-700/80 text-zinc-200 border border-zinc-700/60 hover:border-zinc-600 shadow-sm',
    danger: 'bg-red-600/90 hover:bg-red-500 text-white shadow-[0_0_16px_rgba(239,68,68,0.2),0_4px_8px_rgba(239,68,68,0.1)] hover:shadow-[0_0_24px_rgba(239,68,68,0.3)]',
    ghost: 'bg-transparent hover:bg-zinc-800/60 text-zinc-400 hover:text-zinc-200',
  };
  return (
    <button type="button" className={cn(base, variants[variant] || variants.primary, className)} disabled={disabled} {...props}>
      {children}
    </button>
  );
}

/* ── Input ──────────────────────────────────────────── */
export function Input({ label, required, className = '', ...props }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      {label && (
        <span className="text-zinc-400 font-medium">
          {label}
          {required && <span className="text-red-400 ml-0.5">*</span>}
        </span>
      )}
      <input
        className={cn(
          'h-10 rounded-lg border border-zinc-700/60 bg-zinc-900/50 px-3 text-sm text-zinc-100 placeholder-zinc-500',
          'outline-none transition-all duration-200',
          'inset-depth',
          'hover:border-zinc-600',
          'focus:border-blue-500/70 focus:ring-2 focus:ring-blue-500/20 focus:shadow-[0_0_0_3px_rgba(59,130,246,0.08)]',
          className,
        )}
        {...props}
      />
    </label>
  );
}

/* ── Textarea ───────────────────────────────────────── */
export function Textarea({ label, required, className = '', ...props }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      {label && (
        <span className="text-zinc-400 font-medium">
          {label}
          {required && <span className="text-red-400 ml-0.5">*</span>}
        </span>
      )}
      <textarea
        className={cn(
          'rounded-lg border border-zinc-700/60 bg-zinc-900/50 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-500',
          'outline-none transition-all duration-200 resize-y min-h-[80px]',
          'inset-depth',
          'hover:border-zinc-600',
          'focus:border-blue-500/70 focus:ring-2 focus:ring-blue-500/20 focus:shadow-[0_0_0_3px_rgba(59,130,246,0.08)]',
          className,
        )}
        {...props}
      />
    </label>
  );
}

/* ── Select ─────────────────────────────────────────── */
export function Select({ label, options = [], className = '', ...props }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      {label && <span className="text-zinc-400 font-medium">{label}</span>}
      <select
        className={cn(
          'h-10 rounded-lg border border-zinc-700/60 bg-zinc-900/50 px-3 text-sm text-zinc-100',
          'outline-none transition-all duration-200 cursor-pointer',
          'inset-depth',
          'hover:border-zinc-600',
          'focus:border-blue-500/70 focus:ring-2 focus:ring-blue-500/20',
          className,
        )}
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

/* ── Toggle ─────────────────────────────────────────── */
export function Toggle({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2.5 cursor-pointer select-none text-sm">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-6 w-11 rounded-full transition-all duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950',
          checked ? 'bg-blue-600 shadow-[0_0_12px_rgba(59,130,246,0.3)]' : 'bg-zinc-700',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </button>
      {label && <span className="text-zinc-300">{label}</span>}
    </label>
  );
}

/* ── Slider ─────────────────────────────────────────── */
export function Slider({ label, value, onChange, min = 0, max = 2, step = 0.1, className = '' }) {
  return (
    <label className={cn('flex flex-col gap-1.5 text-sm', className)}>
      {label && (
        <span className="text-zinc-400 font-medium">
          {label}: <span className="text-zinc-200 font-mono tabular-nums">{value}</span>
        </span>
      )}
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-blue-500 h-1.5 rounded-full appearance-none bg-zinc-700 cursor-pointer"
      />
    </label>
  );
}

/* ── Card ───────────────────────────────────────────── */
export function Card({ children, className = '', ...props }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-zinc-800/60 p-5 shadow-sm noise',
        'glass',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/* ── Badge ──────────────────────────────────────────── */
const BADGE_COLORS = {
  blue: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  green: 'bg-green-500/15 text-green-400 border-green-500/20',
  red: 'bg-red-500/15 text-red-400 border-red-500/20',
  yellow: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
  zinc: 'bg-zinc-700/30 text-zinc-400 border-zinc-600/20',
};
export function Badge({ children, color = 'blue' }) {
  return (
    <span className={cn('inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium', BADGE_COLORS[color] || BADGE_COLORS.blue)}>
      {children}
    </span>
  );
}

/* ── Progress Bar ───────────────────────────────────── */
export function ProgressBar({ value = 0, max = 100, className = '' }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className={cn('h-2 w-full rounded-full bg-zinc-800/60 overflow-hidden', className)}>
      <div
        className="h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-500 ease-out shadow-[0_0_8px_rgba(59,130,246,0.4)]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ── Skeleton ───────────────────────────────────────── */
export function Skeleton({ className = 'h-4 w-full' }) {
  return <div className={cn('skeleton rounded-lg', className)} />;
}

/* ── ImageCard ──────────────────────────────────────── */
export function ImageCard({ src, mimeType, base64, meta, onSelect, selected, className = '' }) {
  const [loaded, setLoaded] = useState(!!base64);
  const imgSrc = src || (base64 ? `data:${mimeType || 'image/png'};base64,${base64}` : null);
  const identityConfidence = Number(meta?.identityConfidence);
  const hasIdentityConfidence = Number.isFinite(identityConfidence);
  const confidenceColor = identityConfidence >= 85
    ? 'text-green-300 border-green-400/30 bg-green-500/15'
    : identityConfidence >= 70
      ? 'text-yellow-300 border-yellow-400/30 bg-yellow-500/15'
      : 'text-red-300 border-red-400/30 bg-red-500/15';
  const download = () => {
    if (!imgSrc) return;
    const a = document.createElement('a');
    a.href = imgSrc;
    a.download = `generated_${Date.now()}.png`;
    a.click();
  };
  return (
    <div
      className={cn(
        'group relative rounded-xl border overflow-hidden transition-all duration-200',
        selected
          ? 'border-blue-500 ring-2 ring-blue-500/30 shadow-lg shadow-blue-500/10'
          : 'border-zinc-800/60 hover:border-zinc-600',
        onSelect && 'cursor-pointer',
        className,
      )}
      onClick={onSelect}
    >
      {imgSrc ? (
        <div className="relative">
          {!loaded && <div className="skeleton w-full aspect-square" />}
          <img
            src={imgSrc} alt=""
            className={cn(
              'w-full aspect-square object-cover bg-zinc-900 transition-opacity duration-300',
              loaded ? 'opacity-100' : 'opacity-0 absolute inset-0',
            )}
            loading="lazy" onLoad={() => setLoaded(true)}
          />
        </div>
      ) : (
        <div className="w-full aspect-square bg-zinc-900 flex items-center justify-center text-zinc-500 text-xs">No image</div>
      )}
      {hasIdentityConfidence && (
        <div className={cn('pointer-events-none absolute left-2 top-2 rounded-md border px-2 py-1 text-[10px] font-medium backdrop-blur-sm', confidenceColor)}>
          Identity Confidence: {Math.round(identityConfidence)}%
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3 translate-y-full group-hover:translate-y-0 transition-transform duration-200">
        <div className="flex items-center justify-between text-xs text-zinc-300">
          <div className="space-y-0.5">
            {meta?.imageId && <div className="font-mono opacity-70">{String(meta.imageId).slice(0, 8)}...</div>}
            {meta?.seed != null && <div className="font-mono opacity-70">seed: {meta.seed}</div>}
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); download(); }}
            className="rounded-md bg-zinc-800/90 px-2 py-1.5 hover:bg-zinc-700 transition text-zinc-200 cursor-pointer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Modal (Radix Dialog) ──────────────────────────── */
export function Modal({ open, onClose, title, children, className = '' }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => { if (!v) onClose?.(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-[130] bg-black/70 backdrop-blur-sm data-[state=open]:animate-overlay-in"
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[131] w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
            'max-h-[calc(100vh-2rem)] overflow-y-auto',
            'rounded-xl border border-zinc-700/50 glass p-6 shadow-2xl',
            'data-[state=open]:animate-dialog-in',
            'focus:outline-none',
            className,
          )}
        >
          <div className="flex items-center justify-between mb-4">
            <DialogPrimitive.Title className="text-lg font-semibold text-zinc-100">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              className="rounded-lg p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/80 transition cursor-pointer focus:outline-none"
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ── Toasts ─────────────────────────────────────────── */
const TOAST_STYLES = {
  info: 'border-l-blue-500',
  error: 'border-l-red-500',
  success: 'border-l-green-500',
};
export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'animate-toast-in rounded-lg border border-zinc-800/60 border-l-4 glass noise px-4 py-3 text-sm text-zinc-200 shadow-xl',
            TOAST_STYLES[t.type] || TOAST_STYLES.info,
          )}
        >
          <div className="flex items-start gap-2">
            <span className="flex-1">{t.message}</span>
            <button onClick={() => dismissToast(t.id)} aria-label="Dismiss" className="text-zinc-500 hover:text-zinc-300 cursor-pointer transition">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Hint (Radix Tooltip) ──────────────────────────── */
export function Hint({ text, className = '' }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>
        <span className={cn('inline-flex items-center', className)}>
          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-zinc-600/60 text-[9px] leading-none font-bold text-zinc-500 cursor-help select-none hover:border-blue-500/50 hover:text-blue-400 transition-colors">
            ?
          </span>
        </span>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side="top"
          sideOffset={6}
          className="z-[60] w-56 rounded-lg glass border border-zinc-700/50 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-300 shadow-xl animate-tooltip-in"
        >
          {text}
          <TooltipPrimitive.Arrow className="fill-zinc-800" width={10} height={5} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* ── Collapsible Section ───────────────────────────── */
export function Section({ title, defaultOpen = false, badge, hint, children, className = '' }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn('border-t border-zinc-800/40 pt-3', className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between cursor-pointer group py-0.5"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400 font-medium group-hover:text-zinc-200 transition-colors">{title}</span>
          {hint && <Hint text={hint} />}
          {badge}
        </div>
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          className={cn('text-zinc-600 transition-transform duration-200', open && 'rotate-180')}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div
        className={cn(
          'grid transition-all duration-200 ease-out',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="overflow-hidden">
          <div className="pt-2.5 space-y-3">{children}</div>
        </div>
      </div>
    </div>
  );
}

/* ── Confirm Dialog (Radix Dialog) ─────────────────── */
export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Delete', variant = 'danger' }) {
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await Promise.resolve(onConfirm?.());
      onClose?.();
    } catch (err) {
      console.warn('[ConfirmDialog] action failed:', err?.message || err);
      // Keep dialog open on error so user sees something went wrong
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => { if (!v) onClose?.(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-[130] bg-black/70 backdrop-blur-sm data-[state=open]:animate-overlay-in"
        />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-[131] w-full max-w-sm -translate-x-1/2 -translate-y-1/2 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-zinc-700/50 glass p-6 shadow-2xl data-[state=open]:animate-dialog-in focus:outline-none"
        >
          <DialogPrimitive.Title className="text-base font-semibold text-zinc-100 mb-2">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-sm text-zinc-400 mb-5">
            {message}
          </DialogPrimitive.Description>
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={onClose} disabled={submitting} className="!px-3 !py-1.5 !text-sm">Cancel</Btn>
            <Btn variant={variant} onClick={handleConfirm} disabled={submitting} className="!px-3 !py-1.5 !text-sm">
              {submitting ? 'Working...' : confirmLabel}
            </Btn>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ── Empty State ────────────────────────────────────── */
export function Empty({ icon = '📭', title, subtitle }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="text-4xl mb-3 opacity-80">{icon}</div>
      <div className="text-zinc-400 font-medium">{title}</div>
      {subtitle && <div className="text-zinc-500 text-sm mt-1 max-w-xs">{subtitle}</div>}
    </div>
  );
}

/* ── CopyBtn ────────────────────────────────────────── */
export function CopyBtn({ text, className = '' }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };
  return (
    <button
      type="button"
      onClick={copy} title="Copy"
      className={cn(
        'inline-flex items-center gap-1 text-xs transition-colors cursor-pointer',
        copied ? 'text-green-400' : 'text-zinc-500 hover:text-blue-400',
        className,
      )}
    >
      {copied ? '✓ Copied' : '⎘ Copy'}
    </button>
  );
}

/* ── StepProgress ──────────────────────────────────── */
export function StepProgress({ steps, currentIndex, elapsedSec, className = '' }) {
  return (
    <Card className={cn('flex items-center justify-center py-12', className)}>
      <div className="flex flex-col items-center gap-4 w-full max-w-xs">
        <Spinner size={36} />
        <p className="text-zinc-200 text-sm font-medium text-center">
          {steps[currentIndex] || steps[steps.length - 1]}
        </p>
        <div className="w-full space-y-1.5">
          {steps.map((step, idx) => (
            <div
              key={step}
              className={cn(
                'flex items-center gap-2 text-xs transition-colors duration-300',
                idx < currentIndex ? 'text-green-400' : idx === currentIndex ? 'text-blue-300' : 'text-zinc-600',
              )}
            >
              <span className="w-4 text-center flex-shrink-0">
                {idx < currentIndex ? '✓' : idx === currentIndex ? '›' : '○'}
              </span>
              <span>{step}</span>
            </div>
          ))}
        </div>
        {elapsedSec != null && <p className="text-zinc-500 text-xs font-mono tabular-nums">{elapsedSec}s elapsed</p>}
      </div>
    </Card>
  );
}
