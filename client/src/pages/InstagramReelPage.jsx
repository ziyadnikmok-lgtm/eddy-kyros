import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { instagramReel as reelApi, characters as charApi, seedream as seedreamApi, gallery as galleryApi, video as videoApi } from '../services/api';
import { useApp } from '../context/AppContext';
import CharacterPicker from '../components/CharacterPicker';
import { Card, Btn, Select, Spinner } from '../components/UI';
import { seedreamCost, SEEDREAM_ASPECT_RATIOS, SEEDREAM_RESOLUTIONS, SEEDREAM_MAX_IMAGES } from '../config/photoModes';
import { runPool } from '../lib/runPool';
import { cn } from '../lib/utils';

// Hairline/muted tokens copied from EddyGeneratePage's GATE_* constants rather than re-derived —
// this page's empty state sits in the same visual language as the rest of the app's results
// columns, and duplicating the exact shades here would drift the moment one of them changes.
const HAIRLINE = 'border-white/[0.07]';
const MUTED = 'text-[#7d7d8c]';
const TEXT = 'text-[#e8e8f0]';

// A shot's start/end, to one decimal. Reels are short, so seconds (not mm:ss) reads cleaner, and
// the guard keeps a malformed number from rendering "NaNs" in the card header.
const secLabel = (n) => (Number(n) || 0).toFixed(1);

/* ───────────────────────────────────────────────────────────────────────────────────────────
 * Task 6 — the RECREATE stage. This is the ONLY paid step on the page, so the cost gate, the
 * amber money rule and the concurrency cap are copied VERBATIM from EddyGeneratePage.jsx rather
 * than reinvented: the same PreRunConfirmGate shape, the same Money component, the same
 * PARALLEL_REQUESTS + runPool pool, the same per-tile Regenerate/Remove failure contract.
 *
 * WHY copied and not imported: Task 6 is scoped to this one file, and the file already sets the
 * precedent of copying Eddy's GATE_* tokens (see the HAIRLINE/MUTED/TEXT note above). "Reuse
 * verbatim — do not build a second style" is the instruction; copying the exact component is what
 * satisfies it. HAIRLINE / MUTED / TEXT above are the identical Eddy tokens and are reused below.
 * ─────────────────────────────────────────────────────────────────────────────────────────── */

// How many Seedream calls run at once. Copied from EddyGeneratePage: every request re-encodes its
// source images server-side, and unthrottled fan-out has 429'd this backend before. The batch
// opens up to this many lanes; a single-tile Regenerate opens one.
const PARALLEL_REQUESTS = 6;

// The shot's keyframe always takes one of Seedream's ten image slots, so the character can supply
// at most nine identity refs — same budgeting Scene Recreate uses (its source photo takes a slot).
const MAX_CHAR_IMAGES = SEEDREAM_MAX_IMAGES - 1;

const ASPECT_OPTIONS = SEEDREAM_ASPECT_RATIOS.map((r) => ({ value: r, label: r }));
const RES_OPTIONS = SEEDREAM_RESOLUTIONS.map((r) => ({ value: r, label: r }));

// THE AMBER RULE (copied from EddyGeneratePage): amber (#f0b429) is reserved for dollar figures and
// NOTHING else — no border, no icon, no warning may use it. GATE_MONEY is the ONE place #f0b429
// appears in this file, which is what makes the rule mechanically true rather than a convention.
const GATE_SCRIM = 'bg-[#08080c]/90';
const GATE_PANEL = 'bg-[#101017]';
const GATE_MONEY = 'tabular-nums font-semibold tracking-tight text-[#f0b429]';
const GATE_EYEBROW = 'text-[10px] font-semibold uppercase tracking-[0.12em] text-[#7d7d8c]';
// Neutral (never amber) and always visible, so every gate control is reachable by keyboard alone.
const GATE_FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[#101017]';

// Shared look for the always-visible per-tile actions. Neutral until hover/focus.
const TILE_ACTION = 'rounded-lg border px-2 py-1 text-[0.625rem] font-medium transition';

// The on-screen text overlay preview — a CSS/DOM layer drawn OVER the recreated <img>, NOT baked
// into the pixels. It mirrors the lower-third, centered, bold-white look of a typical reel caption
// so the user can see what Phase 2 will burn onto each slide. The dark text-shadow acts as the
// stroke that keeps white text legible over any background; the browser renders emoji in color
// natively, so no special handling is needed. Kept purely visual — it re-calls no API.
const OVERLAY_TEXT_SHADOW = '0 1px 2px rgba(0,0,0,0.95), 0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)';

// The single money predicate: a shot is billable/recreatable ONLY when it is kept AND a real image
// (not a black text slide). Cost, the gate total and the Seedream dispatch all read this one rule,
// so a black slide can never be counted, quoted or sent — it always adds $0. Module-scoped and pure
// so it's a stable reference (no dep-array churn).
const isRecreatable = (s) => s.keep && s.kind === 'image';

// A recreatable shot needs (re)dispatching to Seedream only when it does NOT already hold a
// successful, paid-for result. This is the one predicate that keeps a retry (e.g. clicking "Make
// reel" again after the free assemble step failed) from re-billing images that already exist —
// runRecreate reads it to decide what to dispatch, and the cost gate/quote read it to decide what
// to charge, so the quoted number and the dispatched number can never drift apart. The per-tile
// Regenerate button does NOT use this predicate — it always forces a fresh generation.
const needsRecreate = (s) => isRecreatable(s) && !(s.result?.status === 'done' && s.result?.galleryId);

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  return m ? { mimeType: m[1], base64: m[2] } : null;
}

// Fetch an in-app character image URL and return it in the { base64, mimeType } shape the
// seedream/edit route requires (verified against server/routes/seedreamEdit.js, which 400s an
// image missing either field). Same loader Scene Recreate uses to pull identity refs.
async function urlToImagePayload(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error('Failed to load character image');
  const blob = await resp.blob();
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  return parseDataUrl(dataUrl);
}

/**
 * Tweens a number toward its new value over ~220ms. Copied verbatim from EddyGeneratePage — the
 * one bit of motion on the money surfaces, and it no-ops when from === value so a static total
 * never counts up from zero on open.
 */
function useCountUp(value) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const from = shownRef.current;
    if (reduced || from === value) {
      shownRef.current = value;
      setShown(value);
      return undefined;
    }
    let raf = 0;
    const start = performance.now();
    const DURATION = 220;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / DURATION);
      const eased = 1 - (1 - t) * (1 - t);
      const next = from + (value - from) * eased;
      shownRef.current = next;
      setShown(next);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return shown;
}

/**
 * Every dollar figure renders through here, which is what keeps the amber rule mechanically true.
 * Verbatim from EddyGeneratePage's Money.
 */
function Money({ amount, decimals = 2, className = '' }) {
  const shown = useCountUp(amount);
  return <span className={cn(GATE_MONEY, className)}>${shown.toFixed(decimals)}</span>;
}

/** Fades a gate panel in over ~120ms. Verbatim from EddyGeneratePage. */
function useFadeIn() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return cn('transition-opacity duration-[120ms] motion-reduce:transition-none', visible ? 'opacity-100' : 'opacity-0');
}

/** Freezes the page behind a portaled gate while it is open. Verbatim from EddyGeneratePage. */
function useScrollLock() {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
}

/**
 * The confirmation gate BEFORE anything is generated — the "see the full bill first" gate. Copied
 * verbatim from EddyGeneratePage: portaled to document.body (cards here use backdrop-filter, which
 * would trap a plain fixed overlay inside a card), z-[150], and a backdrop that CANCELS — nothing
 * is billed at this point, so a click-outside costs the user nothing and dismissing is the safe
 * default. Cancel dispatches zero requests.
 */
function PreRunConfirmGate({ imageCount, imageCost, onConfirm, onCancel }) {
  const fade = useFadeIn();
  useScrollLock();

  return createPortal(
    <div className={cn('fixed inset-0 z-[150] flex items-center justify-center p-6', GATE_SCRIM)} onClick={onCancel}>
      <div
        className={cn('w-full max-w-sm rounded-2xl border p-5', HAIRLINE, GATE_PANEL, fade)}
        onClick={(e) => e.stopPropagation()}
      >
        <p className={GATE_EYEBROW}>Confirm</p>
        <h3 className={cn('mt-1 text-sm font-semibold', TEXT)}>Before recreating</h3>
        <p className={cn('mt-1 text-xs', MUTED)}>Nothing is sent until you press Start.</p>

        <div className={cn('mt-4 border-t pt-3', HAIRLINE)}>
          <div className="flex items-baseline justify-between gap-3">
            <span className={cn('text-xs', MUTED)}>{imageCount} image{imageCount === 1 ? '' : 's'}</span>
            <Money amount={imageCost} decimals={3} className="text-xs" />
          </div>
        </div>

        {/* The hero. ~2.5x the line-item size: this is a budget decision, and this is the number
            it is made against. */}
        <div className={cn('mt-3 flex items-baseline justify-between gap-3 border-t pt-3', HAIRLINE)}>
          <span className={GATE_EYEBROW}>Total</span>
          <Money amount={imageCost} decimals={3} className="text-[1.875rem] leading-none" />
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Btn variant="ghost" className="!rounded-lg !py-2 !px-3 !text-sm" onClick={onCancel}>Cancel</Btn>
          <Btn className="!rounded-lg !py-2 !px-4 !text-sm" onClick={onConfirm}>Start</Btn>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * One recreated shot in the review grid — its recreated image plus Regenerate and Remove, mirroring
 * EddyGeneratePage's ResultTile behaviour and failure contract.
 *
 * FAILURE CONTRACT (copied from Eddy): a failed Regenerate does NOT blank the tile. The image is
 * read from `result.galleryId` (the server copy), and a failed regenerate leaves that galleryId
 * untouched and only paints `result.error` — the already-paid-for picture stays on screen. Remove
 * clears the tile from THIS panel only; the image stays in the gallery/library.
 */
function ShotResultTile({ shot, onRegenerate, onRemove, onOverlayChange }) {
  const result = shot.result;
  const busy = shot.regenerating || result?.status === 'queued' || result?.status === 'running';
  const src = result?.galleryId ? galleryApi.imageUrl(result.galleryId) : '';
  const busyLabel = shot.regenerating ? 'Regenerating' : result?.status === 'queued' ? 'Queued' : 'Recreating';
  const overlayText = shot.overlayText || '';

  // BLACK SLIDE tile: a solid black card carrying only the editable overlay text. There is no image
  // and nothing to regenerate (it was never sent to Seedream), so NO Regenerate button — only the
  // editable overlay and Remove (which drops the free slide from the assembly). $0, always.
  if (shot.kind === 'black') {
    return (
      <div className={cn('flex flex-col overflow-hidden rounded-xl border bg-white/[0.02]', 'border-zinc-800/60')}>
        <div className="relative flex aspect-[9/16] w-full items-center justify-center bg-black p-3">
          {overlayText.trim() ? (
            <span
              className="text-center text-[0.8125rem] font-bold leading-tight text-white"
              style={{ textShadow: OVERLAY_TEXT_SHADOW, wordBreak: 'break-word' }}
            >
              {overlayText}
            </span>
          ) : (
            <span className={cn('text-[0.625rem] uppercase tracking-wide', MUTED)}>Black slide</span>
          )}
        </div>
        <div className="space-y-1 p-2">
          <p className="text-[0.5625rem] font-semibold uppercase tracking-wider text-zinc-500">Shot {shot.index + 1} · Black slide (free)</p>
          <input
            type="text"
            value={overlayText}
            onChange={(e) => onOverlayChange(shot.index, e.target.value)}
            placeholder="On-screen text…"
            title="On-screen text burned onto this black slide by Phase 2. Editing only updates the preview."
            className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-2 py-1 text-[0.625rem] text-zinc-300 placeholder-zinc-600 outline-none focus:border-rose-500/50"
          />
          <button
            type="button"
            onClick={() => onRemove(shot.index)}
            title="Drops this slide from the recreation. Bring it back with the Keep toggle above."
            className={cn(TILE_ACTION, GATE_FOCUS, 'w-full cursor-pointer', HAIRLINE, MUTED, 'hover:border-[#d4736d]/50 hover:text-[#d4736d]')}
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-xl border bg-white/[0.02]', 'border-zinc-800/60')}>
      <div className="relative aspect-[9/16] w-full bg-black/40">
        {src
          ? <img src={src} alt={`Recreated shot ${shot.index + 1}`} className="h-full w-full object-cover" loading="lazy" />
          : <span className={cn('flex h-full w-full items-center justify-center text-[0.625rem]', MUTED)}>
              {result?.status === 'failed' ? 'No image' : 'No preview'}
            </span>}
        {/* LIVE overlay preview of Phase 2's burned-in text — a DOM layer over the <img>, never
            baked into the generated pixels. Lower-third, centered, bold white with a dark stroke
            (text-shadow) for legibility. Hidden while the tile is busy (spinner owns the surface)
            and when there is no text. */}
        {!busy && overlayText.trim() && src && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-2 pb-[12%]">
            <span
              className="text-center text-[0.8125rem] font-bold leading-tight text-white"
              style={{ textShadow: OVERLAY_TEXT_SHADOW, wordBreak: 'break-word' }}
            >
              {overlayText}
            </span>
          </div>
        )}
        {busy && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70">
            <Spinner size={18} />
            <span className={cn('text-[0.5625rem] uppercase tracking-wide', MUTED)}>{busyLabel}</span>
          </div>
        )}
      </div>

      <div className="space-y-1 p-2">
        <p className="text-[0.5625rem] font-semibold uppercase tracking-wider text-zinc-500">Shot {shot.index + 1}</p>
        {/* Same overlayText, editable here too so it can be tweaked while watching the preview above.
            Purely client-side — no API, no regeneration; updates only this shot's overlayText. */}
        <input
          type="text"
          value={overlayText}
          onChange={(e) => onOverlayChange(shot.index, e.target.value)}
          placeholder="On-screen text…"
          title="On-screen text burned onto this slide by Phase 2. Editing only updates the preview."
          className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-2 py-1 text-[0.625rem] text-zinc-300 placeholder-zinc-600 outline-none focus:border-rose-500/50"
        />
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={() => onRegenerate(shot.index)}
            disabled={busy}
            title="Recreate this one shot again."
            className={cn(
              TILE_ACTION, GATE_FOCUS,
              busy ? cn('cursor-not-allowed border-white/[0.05]', MUTED)
                   : cn('cursor-pointer', HAIRLINE, TEXT, 'hover:border-white/25'),
            )}
          >
            Regenerate
          </button>
          <button
            type="button"
            onClick={() => onRemove(shot.index)}
            disabled={busy}
            title="Clears this from the panel. The image stays in your gallery."
            className={cn(
              TILE_ACTION, GATE_FOCUS,
              busy ? cn('cursor-not-allowed border-white/[0.05]', MUTED)
                   : cn('cursor-pointer', HAIRLINE, MUTED, 'hover:border-[#d4736d]/50 hover:text-[#d4736d]'),
            )}
          >
            Remove
          </button>
        </div>
        {/* A failed batch item or a failed regenerate surfaces here; the tile keeps whatever image
            it already had. Never amber — this is an error, not a price. */}
        {result?.error && <p className="text-center text-[0.625rem] leading-tight text-[#d4736d]">{result.error}</p>}
      </div>
    </div>
  );
}

/**
 * One detected shot: keyframe thumbnail on the left, Gemini's analysis on the right, and a
 * Keep/Drop toggle. A shot whose analysis failed (`analysis: null` / `analysisFailed`) is shown
 * with an "Analysis failed" line rather than hidden — a silently dropped shot is exactly the kind
 * of invisible gap this codebase has been bitten by before.
 *
 * `keep` defaults true and is the single per-shot flag the kept count reads. Task 6's recreate
 * payload will filter on the same flag (`shots.filter((s) => s.keep)`), so dropping a shot here is
 * the seam that later excludes it from any paid generation.
 */
function ShotCard({ shot, onToggleKeep, onOverlayChange }) {
  const { analysis, analysisFailed, keyframeDataUrl, keep, overlayText } = shot;
  const isBlack = shot.kind === 'black';
  // A black slide always has a (synthetic) analysis and never "fails" — it's just a free text slide.
  const failed = !isBlack && (analysisFailed || !analysis);

  return (
    <div className={cn(
      'flex gap-3 rounded-xl border bg-white/[0.02] p-3 transition-colors',
      // A dropped shot dims but stays in place — the toggle has to remain visible to bring it back.
      keep ? 'border-zinc-800/60' : 'border-zinc-800/40 opacity-55',
    )}>
      <div className="w-24 shrink-0">
        {isBlack ? (
          // A black slide renders as a solid black tile with its overlay text drawn over it — there
          // is no keyframe scene worth showing (the frame IS black), and this previews the slide.
          <div className="relative flex aspect-[9/16] w-full items-center justify-center overflow-hidden rounded-lg border border-zinc-800/60 bg-black p-1.5">
            {overlayText && overlayText.trim() ? (
              <span
                className="text-center text-[0.5625rem] font-bold leading-tight text-white"
                style={{ textShadow: OVERLAY_TEXT_SHADOW, wordBreak: 'break-word' }}
              >
                {overlayText}
              </span>
            ) : (
              <span className="text-[0.5rem] uppercase tracking-wide text-zinc-600">Black slide</span>
            )}
          </div>
        ) : keyframeDataUrl ? (
          <img
            src={keyframeDataUrl}
            alt={`Shot ${shot.index + 1} keyframe`}
            className="aspect-[9/16] w-full rounded-lg border border-zinc-800/60 bg-zinc-950 object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex aspect-[9/16] w-full items-center justify-center rounded-lg border border-zinc-800/60 bg-zinc-950 text-center text-[0.625rem] text-zinc-600">
            No frame
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[0.625rem] font-semibold uppercase tracking-wider text-zinc-500">
            Shot {shot.index + 1} · {secLabel(shot.startSec)}–{secLabel((Number(shot.startSec) || 0) + (Number(shot.durationSec) || 0))}s
          </span>
          {/* Keep/Drop toggle. Emerald for kept, neutral for dropped — never amber (there is no
              money on this screen, and amber is reserved for dollar figures app-wide). */}
          <button
            type="button"
            onClick={() => onToggleKeep(shot.index)}
            aria-pressed={keep}
            className={cn(
              'shrink-0 cursor-pointer rounded-full border px-2.5 py-1 text-[0.625rem] font-semibold transition-colors',
              keep
                ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                : 'border-zinc-700/60 bg-white/[0.02] text-zinc-500 hover:text-zinc-300',
            )}
          >
            {keep ? '✓ Keep' : 'Dropped'}
          </button>
        </div>

        {failed ? (
          <p className="text-xs text-red-400">
            Analysis failed{shot.analysisError ? ` — ${shot.analysisError}` : ''}
          </p>
        ) : isBlack ? (
          <>
            {/* Black slide: no scene/pose/outfit to recreate — it's a free text slide (never sent to
                Seedream). Only the on-screen text matters, and it stays editable for Phase 2. */}
            <p className="text-xs leading-relaxed text-zinc-400">
              Black slide <span className="text-zinc-600">— no image to recreate, free. Only the on-screen text is used.</span>
            </p>
            <label className="block space-y-0.5">
              <span className="text-[0.625rem] font-semibold uppercase tracking-wider text-zinc-600">
                On-screen text <span className="font-normal normal-case text-zinc-600">shown on the slide</span>
              </span>
              <input
                type="text"
                value={overlayText || ''}
                onChange={(e) => onOverlayChange(shot.index, e.target.value)}
                placeholder="No on-screen text — add some to appear on the slide"
                className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-2 py-1 text-[0.6875rem] text-zinc-300 placeholder-zinc-600 outline-none focus:border-rose-500/50"
              />
            </label>
          </>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-zinc-300">{analysis.sceneDescription}</p>
            <div className="space-y-0.5 text-[0.6875rem]">
              <p><span className="text-zinc-600">Pose:</span> <span className="text-zinc-400">{analysis.pose}</span></p>
              <p><span className="text-zinc-600">Outfit:</span> <span className="text-zinc-400">{analysis.outfit}</span></p>
            </div>
            {/* On-screen text overlay. Seeded from the original's analysis.onScreenText and editable
                per shot — this is the text Phase 2 will burn onto the recreated slide (previewed live
                over the recreated image in the review grid). Client-side only: typing here just
                updates this shot's overlayText, never re-calls any API. */}
            <label className="block space-y-0.5">
              <span className="text-[0.625rem] font-semibold uppercase tracking-wider text-zinc-600">
                On-screen text <span className="font-normal normal-case text-zinc-600">shown on the slide</span>
              </span>
              <input
                type="text"
                value={overlayText || ''}
                onChange={(e) => onOverlayChange(shot.index, e.target.value)}
                placeholder="No on-screen text — add some to appear on the slide"
                className="w-full rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-2 py-1 text-[0.6875rem] text-zinc-300 placeholder-zinc-600 outline-none focus:border-rose-500/50"
              />
            </label>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Phase 1, Task 5: the free checkpoint. Ingest a reel (drop a file or paste a URL), pick the
 * Character whose identity will be used, then Analyze to detect shots and review each one — with a
 * Keep/Drop toggle per shot. NO paid generation happens here; the cost-gated recreation is Task 6.
 *
 * Layout mirrors EddyGeneratePage.jsx: a fixed ~460px left column for setup and a `flex-1` right
 * column for the shot list, both independently scrollable at lg+ and stacking into one scrolling
 * document below it. `min-h-0` on the columns is load-bearing (a flex item won't shrink below its
 * content without it), and the bounded height comes from App.jsx's SELF_SCROLL_PAGES, which
 * 'instagramReel' is in. The page renders no title of its own — App.jsx's topbar already shows
 * "Instagram" + the subtitle from PAGE_DESCRIPTIONS, exactly as EddyGeneratePage relies on.
 */
export default function InstagramReelPage() {
  const { notify, characters: chars = [] } = useApp();

  // ── ingest ──────────────────────────────────────────────────────────────────
  const [urlInput, setUrlInput] = useState('');
  const [runId, setRunId] = useState(null);
  const [source, setSource] = useState(null);          // 'upload' | 'url'
  const [ingestedLabel, setIngestedLabel] = useState('');
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState('');
  const [dragging, setDragging] = useState(false);

  // ── character (stored now, first USED in Task 6's recreate) ──────────────────
  const [characterId, setCharacterId] = useState(null);
  const [charDetails, setCharDetails] = useState({});

  // ── analysis ────────────────────────────────────────────────────────────────
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState('');
  const [shots, setShots] = useState([]);              // each shot + a per-shot `keep` flag
  // The whole-reel TIMED overlay-text track from /analyze: [{startSec,endSec,text}] over the reel
  // timeline. It's what ANIMATES the burned counter (17→18→…) at assembly instead of freezing one
  // value. Held in a ref (not state) because runMakeReel reads it in the SAME tick it's set — the
  // same reason the recreate galleryIds come back via a returned Map, not state. Empty = no track
  // (assembly falls back to the static per-shot overlayText).
  const reelTextTrackRef = useRef([]);

  // ── recreate (Task 6 — the ONLY paid stage) ─────────────────────────────────
  // Reels are portrait, so the keyframe and the recreated image are both 9:16 by default. Both are
  // real Seedream enum values (never 'auto', which the route 422s on).
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [resolution, setResolution] = useState('1K');
  const [showRecreateConfirm, setShowRecreateConfirm] = useState(false);
  const [recreating, setRecreating] = useState(false);
  const [recreateError, setRecreateError] = useState('');

  // ── Make reel (the express one-button pipeline: analyze → cost-gate → recreate → assemble) ────
  // `makeReelMode` decides which action the SHARED cost gate fires on confirm: the manual Recreate
  // (false) or the full pipeline (true). One gate, one money confirmation for both paths.
  const [makeReelMode, setMakeReelMode] = useState(false);
  // Progress through the pipeline stages so the button/right column isn't a dead spinner:
  // null | 'analyzing' | 'recreating' | 'assembling' | 'done'.
  const [makeReelStage, setMakeReelStage] = useState(null);
  const [makeReelError, setMakeReelError] = useState('');
  const [skippedShots, setSkippedShots] = useState([]);      // 1-based indices left out of assembly
  const [finishedVideo, setFinishedVideo] = useState(null);  // { galleryId, filename } once assembled

  // Pull the full character (with its reference images) once one is picked. Not needed for this
  // task's UI, but Task 6 recreates from these refs — fetching now leaves that seam ready and
  // matches how PhotoMatch/SceneRecreate load their character detail.
  useEffect(() => {
    if (!characterId || charDetails[characterId]) return;
    let cancelled = false;
    charApi.get(characterId)
      .then((d) => { if (!cancelled) setCharDetails((prev) => ({ ...prev, [characterId]: d })); })
      .catch(() => { /* picker still works without detail; refs are only needed at recreate time */ });
    return () => { cancelled = true; };
  }, [characterId, charDetails]);

  const onIngested = useCallback((res, label) => {
    setRunId(res.runId);
    setSource(res.source);
    setIngestedLabel(label);
    // A new reel invalidates any previously analyzed shots — clear them so the right column
    // never shows the last reel's shots against this run's id.
    setShots([]);
    reelTextTrackRef.current = []; // and drop the prior reel's overlay track
    setAnalyzeError('');
  }, []);

  const ingestFile = useCallback(async (file) => {
    if (!file) return;
    if (!/^video\//i.test(file.type)) {
      setIngestError('That is not a video file — drop an .mp4 reel.');
      return;
    }
    setIngesting(true);
    setIngestError('');
    try {
      const res = await reelApi.ingestFile(file);
      onIngested(res, file.name);
    } catch (err) {
      setIngestError(err.message || 'Could not ingest that video');
    } finally {
      setIngesting(false);
    }
  }, [onIngested]);

  const ingestUrl = useCallback(async () => {
    const url = urlInput.trim();
    if (!url) { setIngestError('Paste a reel link first.'); return; }
    setIngesting(true);
    setIngestError('');
    try {
      const res = await reelApi.ingestUrl(url);
      onIngested(res, url);
    } catch (err) {
      // On a 422 the server sends its own fallback copy ("download the reel and drop the file
      // instead"); err.message carries THAT verbatim (request() unwraps the plain-string { error }
      // body), so we show the real guidance rather than a generic failure.
      setIngestError(err.message || 'Could not download that link');
    } finally {
      setIngesting(false);
    }
  }, [urlInput, onIngested]);

  // Returns the mapped shots on success (null on failure) so the express "Make reel" flow can
  // analyze-then-gate off the FRESH shots without waiting for the async setShots to settle — React
  // state wouldn't be readable in the same tick. The manual "Analyze reel" button ignores the return.
  const analyze = useCallback(async () => {
    if (!runId) return null;
    setAnalyzing(true);
    setAnalyzeError('');
    try {
      const res = await reelApi.analyze(runId);
      // Every shot starts KEPT. `keep` is the flag the kept count reads and Task 6 will filter on.
      // `overlayText` seeds from the original's on-screen text (analysis.onScreenText, '' when the
      // shot had none). It is the editable on-screen caption Phase 2 will burn onto each recreated
      // slide — kept in each shot's in-memory shape so it survives regenerate/remove and is ready
      // for the future assembly step. Default = the original's text; the user can tweak per shot.
      const mapped = (res.shots || []).map((s) => ({ ...s, keep: true, overlayText: s.onScreenText || '' }));
      // Capture the whole-reel timed overlay track (drives the ANIMATED burn at assembly). Stored in
      // a ref so runMakeReel can read it the same tick even when analyze+assemble run back-to-back.
      reelTextTrackRef.current = Array.isArray(res.textTrack) ? res.textTrack : [];
      setShots(mapped);
      return mapped;
    } catch (err) {
      setAnalyzeError(err.message || 'Analysis failed');
      return null;
    } finally {
      setAnalyzing(false);
    }
  }, [runId]);

  const toggleKeep = useCallback((index) => {
    setShots((prev) => prev.map((s) => (s.index === index ? { ...s, keep: !s.keep } : s)));
  }, []);

  // Edits ONLY the given shot's on-screen overlay text. Purely client-side state — no API call and
  // no re-generation: the overlay is text Phase 2 will burn onto the slide, previewed live over the
  // recreated image. Changing it never touches the shot's `result` (the paid-for image).
  const updateOverlayText = useCallback((index, value) => {
    setShots((prev) => prev.map((s) => (s.index === index ? { ...s, overlayText: value } : s)));
  }, []);

  const keptCount = shots.filter((s) => s.keep).length;
  // BLACK-SLIDE money rule: a black shot is a free text slide — never sent to Seedream, never billed.
  // Only KEPT, kind==='image' shots are recreatable/billable (isRecreatable, module scope); that one
  // predicate drives the cost, the gate total and the dispatch, so the three can never disagree.
  const recreatableCount = shots.filter(isRecreatable).length;
  const blackKeptCount = shots.filter((s) => s.keep && s.kind === 'black').length;
  // Recreatable shots that still need a paid Seedream call — excludes shots that already hold a
  // successful result (needsRecreate, module scope). THIS is the count that must be quoted/billed:
  // recreatableCount describes shot composition (how many non-black kept shots exist), but a retry
  // after a successful recreate (only assembly failed) must quote and bill only the leftovers.
  const pendingRecreateCount = shots.filter(needsRecreate).length;

  // ── recreate cost + character refs ───────────────────────────────────────────
  // The bill quoted in the gate must be the bill actually charged, so imageCount here mirrors what
  // the dispatch sends: the shot's keyframe (1 slot) + the character's identity refs (capped at
  // MAX_CHAR_IMAGES). charDetail loads on selection (effect above), so by recreate time these are
  // real counts. seedreamCost / the pricing constants are reused untouched. Black slides are NOT in
  // recreatableCount, so they contribute nothing to recreateTotal.
  const charDetail = characterId ? charDetails[characterId] : null;
  const activeRefs = charDetail?.references || [];              // NOT filtered by isActive — see Scene Recreate
  const charImageCount = characterId ? 1 + activeRefs.length : 0;
  const charImagesUsed = Math.min(charImageCount, MAX_CHAR_IMAGES);
  const imagesPerShot = 1 + charImagesUsed;                    // keyframe + identity refs
  const costPerShot = seedreamCost(resolution, imagesPerShot);
  // Billed only against what will actually be dispatched (pendingRecreateCount), NOT recreatableCount
  // — the fix for the re-bill hazard: after a successful recreate, a retry quotes $0 for the shots
  // that already succeeded.
  const recreateTotal = costPerShot * pendingRecreateCount;

  const recreatedDone = shots.filter((s) => isRecreatable(s) && s.result && (s.result.status === 'done' || s.result.status === 'failed')).length;
  // The recreation grid shows recreated image tiles AND kept black slides (free tiles that still go
  // to Phase-2 assembly). A shot belongs in the grid if it has a Seedream result OR is a kept black
  // slide. The section shows once there's anything to show.
  const gridShots = shots.filter((s) => s.result || (s.kind === 'black' && s.keep));
  const anyResults = gridShots.length > 0;

  // The express pipeline is mid-flight (any stage before it finishes). Disables the express button,
  // the manual Analyze/Recreate buttons and the character Clear so the two paths can't collide on
  // the one phone-less pipeline. 'done' is a terminal state, not busy.
  const makeReelBusy = makeReelStage === 'analyzing' || makeReelStage === 'recreating' || makeReelStage === 'assembling';
  // Human-readable stage line under the express button so it's never a dead spinner. "Generating N"
  // uses pendingRecreateCount, the exact number of paid images actually in flight (excludes shots
  // that already succeeded on a prior attempt).
  const makeReelStageLabel = makeReelStage === 'analyzing' ? 'Analyzing reel…'
    : makeReelStage === 'recreating' ? `Generating ${pendingRecreateCount} image${pendingRecreateCount === 1 ? '' : 's'}…`
    : makeReelStage === 'assembling' ? 'Assembling the video…'
    : '';

  // Loads the character's identity images ONCE per run, in the { base64, mimeType } shape the
  // route needs — the character's primary image first, then each reference. Without these the ONLY
  // face Seedream could use is the source frame's, the exact fallback this feature must never do,
  // so an empty result is treated as a hard stop by the callers below (never a silent send).
  const loadCharRefs = useCallback(async () => {
    if (!characterId) return [];
    const refs = charDetails[characterId]?.references || [];
    const urls = [charApi.imageUrl(characterId), ...refs.map((r) => charApi.refImageUrl(characterId, r.id))];
    const charRefs = [];
    for (const url of urls.slice(0, MAX_CHAR_IMAGES)) {
      try {
        const img = await urlToImagePayload(url);
        if (img) charRefs.push(img);
      } catch { /* one missing reference must not kill the batch */ }
    }
    return charRefs;
  }, [characterId, charDetails]);

  // ONE shot → one Seedream edit. Both the batch and a per-tile Regenerate call this, so the image
  // ordering can never drift between the two paths.
  //
  // ORDER IS LOAD-BEARING: character identity refs come FIRST, the shot's keyframe LAST. This is
  // the Photo Match / Scene Recreate ordering — Seedream anchors identity on the leading images and
  // reads the trailing frame as scene only, which is what keeps the Character's face instead of the
  // person in the reel. The recreatePrompt (built server-side in Task 4) already states the frame
  // is a scene blueprint, never a face reference; the ordering is the second half of that contract.
  const recreateShot = useCallback(async (shot, charRefs, ratio) => {
    if (!shot.recreatePrompt) throw new Error('This shot has no analysis to recreate from');
    const keyframe = parseDataUrl(shot.keyframeDataUrl);
    if (!keyframe) throw new Error('This shot has no keyframe to recreate from');
    const data = await seedreamApi.edit({
      images: [...charRefs, keyframe],   // refs FIRST (identity), keyframe LAST (scene blueprint)
      prompt: shot.recreatePrompt,
      aspectRatio: ratio,
      resolution,
    });
    const first = (data.images || [])[0];
    if (!first) throw new Error('Seedream returned no image');
    return { galleryId: first.galleryId, imageId: first.imageId, mimeType: first.mimeType, status: 'done' };
  }, [resolution]);

  // The batch. Fired ONLY from the confirm gate's Start, so clicking Recreate never spends on its
  // own. Concurrency capped at PARALLEL_REQUESTS via runPool; one failed shot records its error and
  // does NOT abort the rest of the pool.
  // Returns a Map<shotIndex, result> of every dispatched shot's outcome (done → { galleryId, … },
  // failed → { status:'failed', error }). The batch mirrors it into setShots for the grid, but the
  // Map is what the "Make reel" pipeline reads to build assembly segments: React state set here is
  // not readable in the same tick, and a shot's galleryId is only known via this Map. Returns null
  // on a guard failure (no character / no target / no identity refs) so callers know nothing ran.
  const runRecreate = useCallback(async () => {
    // Defensive re-check of the guard (the button already blocks this, but a spend path must not
    // rely on an upstream check alone).
    if (!characterId) { setRecreateError('Pick your character first'); return null; }
    // DROPPED shots and BLACK slides are both excluded — only kept image shots are ever sent to
    // Seedream (isRecreatable). A black slide reaching this dispatch would be a mis-bill; it can't.
    const allTargets = shots.filter(isRecreatable);
    if (!allTargets.length) { setRecreateError('Keep at least one non-black shot to recreate'); return null; }

    // MONEY-WASTE FIX: skip shots that already hold a successful, paid-for result (needsRecreate,
    // module scope). Without this, retrying "Make reel" / "Recreate" after a transient failure
    // (e.g. the free assemble step erroring on ffmpeg/font) would unconditionally re-dispatch EVERY
    // recreatable shot to seedream.edit — re-billing images that already exist. Only shots that were
    // never attempted, or previously failed, are dispatched here.
    const targets = allTargets.filter(needsRecreate);
    if (!targets.length) {
      // Every kept image shot already succeeded — nothing left to spend, nothing to dispatch.
      setRecreateError('');
      return new Map();
    }

    setRecreating(true);
    setRecreateError('');

    const charRefs = await loadCharRefs();
    if (!charRefs.length) {
      // No identity images → refuse loudly rather than let Seedream fall back to the frame's face.
      setRecreating(false);
      setRecreateError('No character identity images could be loaded — add a primary image to this character.');
      notify('No character identity images could be loaded', 'error');
      return null;
    }

    const ratio = aspectRatio;
    // Reset only the shots we're actually about to (re)dispatch. Already-done shots (and dropped
    // shots / black slides) are left untouched — their galleryId must survive this call unchanged.
    const targetIndexes = new Set(targets.map((s) => s.index));
    setShots((prev) => prev.map((s) => (targetIndexes.has(s.index) ? { ...s, regenerating: false, result: { status: 'queued' } } : s)));

    const results = new Map();
    await runPool(targets, PARALLEL_REQUESTS, async (shot) => {
      setShots((prev) => prev.map((s) => (s.index === shot.index ? { ...s, result: { status: 'running' } } : s)));
      try {
        const r = await recreateShot(shot, charRefs, ratio);
        results.set(shot.index, r);
        setShots((prev) => prev.map((s) => (s.index === shot.index ? { ...s, result: r } : s)));
      } catch (err) {
        // Recorded per shot AND in the Map; the throw stops here so it can never abort the pool.
        const failed = { status: 'failed', error: err.message || 'Recreate failed' };
        results.set(shot.index, failed);
        setShots((prev) => prev.map((s) => (s.index === shot.index ? { ...s, result: failed } : s)));
      }
    });

    setRecreating(false);
    return results;
  }, [characterId, shots, loadCharRefs, aspectRatio, recreateShot, notify]);

  // GUARD + gate opener for the MANUAL Recreate button. No characterId → fail loudly and open
  // NOTHING (no gate, no dispatch): the only alternative identity would be the source frame's face,
  // which this feature must never use. makeReelMode=false so the shared gate fires plain recreate.
  const openRecreateGate = useCallback(() => {
    if (!characterId) { setRecreateError('Pick your character first'); return; }
    // Gate on recreatableCount, not keptCount: black slides are free and never recreated, so a run
    // of only black slides would spend nothing and generate nothing.
    if (!recreatableCount) { setRecreateError('Keep at least one non-black shot to recreate'); return; }
    setRecreateError('');
    setMakeReelMode(false);
    if (!pendingRecreateCount) {
      // Every kept image shot already has a successful, paid-for result — there is nothing left to
      // bill, so skip the spend-confirmation gate entirely (there's no spend to confirm) and call
      // runRecreate directly; it will dispatch zero seedream.edit calls and return immediately.
      runRecreate();
      return;
    }
    setShowRecreateConfirm(true);
  }, [characterId, recreatableCount, pendingRecreateCount, runRecreate]);

  // The full express pipeline, fired ONLY from the shared cost gate's Start when in makeReelMode.
  // Recreate (reusing runRecreate — the SAME dispatch, never duplicated) → build ordered segments →
  // assemble. Cancel on the gate never reaches here, so nothing is spent and nothing is assembled.
  const runMakeReel = useCallback(async () => {
    setMakeReelError('');
    setSkippedShots([]);
    setFinishedVideo(null);

    // 1) Recreate the kept image shots. runRecreate returns a Map<index, result>; the current
    //    `shots` closure is intentionally used only for keep/kind/timing/overlayText (unchanged by
    //    recreate) — the paid galleryIds come from the returned Map, never from stale state.
    setMakeReelStage('recreating');
    const results = await runRecreate();
    if (!results) { setMakeReelStage(null); return; } // guard failed inside runRecreate (it set the error)

    // 2) Build segments from ALL kept shots in index order. Black slides carry galleryId:null +
    //    black:true (free). Image shots carry their recreated result.galleryId. A kept image shot
    //    whose recreation FAILED has no galleryId — it is SKIPPED (never sent as galleryId:null,
    //    which assembleReel would render as a black slide) and reported, never silently dropped.
    const keptShots = shots.filter((s) => s.keep).slice().sort((a, b) => a.index - b.index);
    // The whole-reel timed overlay track (from /analyze). Attached to IMAGE segments so assembly
    // ANIMATES the counter over the recreated photo; each entry is windowed to its segment by
    // startSec server-side. Black slides keep their own static overlayText (a separate text slide),
    // so the track is NOT attached to them.
    const textTrack = reelTextTrackRef.current || [];
    const segments = [];
    const skipped = [];
    for (const shot of keptShots) {
      const base = {
        startSec: shot.startSec,
        durationSec: shot.durationSec,
        // bw: the app exposes no per-segment colour/B&W signal yet (analysis is scene/pose/outfit/
        // onScreenText only), so every segment ships colour. TODO: when analysis exposes a bw flag,
        // read it here — do NOT invent a detector in the client.
        bw: false,
        overlayText: shot.overlayText || '',
      };
      if (shot.kind === 'black') {
        segments.push({ ...base, galleryId: null, black: true });
        continue;
      }
      const galleryId = results.get(shot.index)?.galleryId ?? shot.result?.galleryId ?? null;
      if (!galleryId) { skipped.push(shot.index + 1); continue; } // failed image shot → skip + report
      // textTrack drives the timed burn; overlayText stays as the static fallback assembly uses when
      // the track is empty (kept editable per shot for manual tweaks).
      segments.push({ ...base, galleryId, black: false, textTrack });
    }

    if (skipped.length) setSkippedShots(skipped);
    if (!segments.length) {
      // Every kept shot failed to recreate — refuse loudly rather than assemble an empty/broken clip.
      setMakeReelStage(null);
      setMakeReelError(`No shots were ready to assemble${skipped.length ? ` — shot${skipped.length === 1 ? '' : 's'} ${skipped.join(', ')} failed to recreate.` : '.'}`);
      return;
    }

    // 3) Assemble. Any assemble failure surfaces the REAL server error, never a phantom success.
    setMakeReelStage('assembling');
    try {
      const out = await reelApi.assemble(runId, segments);
      setFinishedVideo(out);
      setMakeReelStage('done');
      if (skipped.length) {
        notify(`Reel assembled — shot${skipped.length === 1 ? '' : 's'} ${skipped.join(', ')} failed to recreate and ${skipped.length === 1 ? 'was' : 'were'} left out.`, 'error');
      }
    } catch (err) {
      setMakeReelStage(null);
      setMakeReelError(err.message || 'Assembly failed');
    }
  }, [runRecreate, shots, runId, notify]);

  // The shared gate's Start. Closes the gate first so a double-click can't double-fire, then routes
  // to the full pipeline or plain recreate by the mode the opener set. This is the ONE place either
  // paid path is dispatched from a confirmed gate.
  const confirmGate = useCallback(async () => {
    setShowRecreateConfirm(false);
    if (makeReelMode) await runMakeReel();
    else await runRecreate();
  }, [makeReelMode, runMakeReel, runRecreate]);

  // The EXPRESS entry point. Analyzes first if needed (free), then opens the SAME cost gate in
  // makeReelMode — the single money confirmation. Opens NOTHING without a character (same identity
  // guard as manual recreate) or without at least one recreatable shot.
  const startMakeReel = useCallback(async () => {
    setMakeReelError('');
    if (!characterId) { setMakeReelError('Pick your character first'); return; }
    if (!runId) { setMakeReelError('Ingest a reel first — drop a file or paste a link.'); return; }

    // Reuse existing shots (possibly edited: dropped/tweaked/overlay) rather than re-analyzing. Only
    // analyze when there are none yet. analyze() returns the fresh shots so the recreatable check
    // below reads real data instead of not-yet-committed state.
    let currentShots = shots;
    if (!currentShots.length) {
      setMakeReelStage('analyzing');
      currentShots = await analyze();
      setMakeReelStage(null);
      if (!currentShots) return; // analyze() surfaced its own error
    }

    if (!currentShots.some(isRecreatable)) {
      setMakeReelError('Keep at least one non-black shot to recreate.');
      return;
    }

    setMakeReelMode(true);
    // FREE RE-ASSEMBLE: if every kept image shot already has a successful, paid-for result (this is
    // a retry after the free assemble step failed — ffmpeg/font/transient — while the images from
    // the prior attempt survived in `shots`), there is nothing left to spend. Skip the cost gate
    // entirely and go straight through runMakeReel, which calls runRecreate (dispatches zero
    // seedream.edit calls since nothing needsRecreate) and proceeds directly to the free assemble.
    if (!currentShots.some(needsRecreate)) {
      await runMakeReel();
      return;
    }
    setShowRecreateConfirm(true);
  }, [characterId, runId, shots, analyze, runMakeReel]);

  // Downloads the finished reel through the metadata-stripped /clean route — the SAME contract Eddy
  // uses: the server serves the ORIGINAL if ffmpeg can't rewrite it and says so via the
  // X-Metadata-Stripped header, so the saved filename is honest (_metadatacleaned vs _NOT-cleaned)
  // and a non-stripped file warns loudly. These clips get published, so this must never lie.
  const downloadFinished = useCallback(async () => {
    const filename = finishedVideo?.filename;
    if (!filename) return;
    try {
      const resp = await fetch(videoApi.cleanFileUrl(filename), { credentials: 'include' });
      if (!resp.ok) throw new Error(`Video download failed (${resp.status})`);
      const stripped = resp.headers.get('X-Metadata-Stripped') === 'yes';
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename.replace(/(\.[^.]+)$/, `${stripped ? '_metadatacleaned' : '_NOT-cleaned'}$1`);
      a.click();
      URL.revokeObjectURL(url);
      if (!stripped) {
        notify('Metadata could NOT be removed from this clip — it saved as _NOT-cleaned. Do not publish it as-is.', 'error');
      }
    } catch (err) {
      notify(err?.message || 'Video download failed', 'error');
    }
  }, [finishedVideo, notify]);

  // Re-runs ONE shot's edit, replacing its image on success. On failure the original image is kept
  // (result.galleryId untouched) and only the error is surfaced — the Eddy per-tile contract.
  const regenerateShot = useCallback(async (shotIndex) => {
    if (!characterId) { notify('Pick your character first', 'error'); return; }
    const shot = shots.find((s) => s.index === shotIndex);
    if (!shot) return;
    const charRefs = await loadCharRefs();
    if (!charRefs.length) { notify('No character identity images could be loaded', 'error'); return; }

    // Mark busy and clear any prior error WITHOUT touching result.galleryId, so a failed retry
    // leaves the already-paid-for image on screen.
    setShots((prev) => prev.map((s) => (s.index === shotIndex ? { ...s, regenerating: true, result: { ...s.result, error: undefined } } : s)));
    try {
      const r = await recreateShot(shot, charRefs, aspectRatio);
      setShots((prev) => prev.map((s) => (s.index === shotIndex ? { ...s, regenerating: false, result: r } : s)));
    } catch (err) {
      setShots((prev) => prev.map((s) => (s.index === shotIndex ? { ...s, regenerating: false, result: { ...s.result, error: err.message || 'Regenerate failed' } } : s)));
    }
  }, [characterId, shots, loadCharRefs, recreateShot, aspectRatio, notify]);

  // Drops a shot from the recreation grid. For an IMAGE shot this clears its result from THIS panel
  // only — the picture stays in the gallery/library (Eddy's non-destructive Remove). A BLACK slide
  // has no paid image and no gallery copy, so Remove there drops the slide from the assembly
  // (keep=false); the shot-list Keep toggle brings it back.
  const removeShotResult = useCallback((shotIndex) => {
    setShots((prev) => prev.map((s) => {
      if (s.index !== shotIndex) return s;
      if (s.kind === 'black') return { ...s, keep: false };
      return { ...s, result: null, regenerating: false };
    }));
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto animate-in lg:flex-row lg:gap-5 lg:overflow-hidden">
      {/* LEFT — setup. Same fixed width as EddyGeneratePage's left column so the two self-scroll
          pages in this app share one column width, not two slightly different ones. */}
      <div className="w-full shrink-0 space-y-4 lg:w-[430px] lg:min-h-0 lg:overflow-y-auto lg:pr-2 xl:w-[460px]">
        {/* 1 · Reel — drop a file or paste a URL */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
            1 · Reel <span className="font-normal normal-case text-zinc-600">drop a file or paste a link</span>
          </h3>

          <div
            className={cn(
              'rounded-xl border-2 border-dashed p-4 text-center transition-colors',
              dragging ? 'border-rose-500 bg-rose-500/[0.06]' : 'border-zinc-800/60',
            )}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); ingestFile(e.dataTransfer?.files?.[0]); }}
          >
            <label className="cursor-pointer">
              <input
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => { ingestFile(e.target.files?.[0]); e.target.value = ''; }}
              />
              <span className="text-xs text-zinc-500">
                Drop a reel video here, or <span className="text-rose-300 underline">browse</span>
              </span>
            </label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); ingestUrl(); } }}
              placeholder="or paste a reel URL…"
              disabled={ingesting}
              className="min-w-0 flex-1 rounded-lg border border-zinc-700/60 bg-zinc-950/40 px-2.5 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-rose-500/50 disabled:opacity-50"
            />
            <Btn
              variant="secondary"
              className="!rounded-lg !py-1.5 !px-3 !text-xs"
              onClick={ingestUrl}
              disabled={ingesting || !urlInput.trim()}
            >
              Fetch
            </Btn>
          </div>

          {ingesting && (
            <div className="flex items-center gap-2 text-xs text-zinc-400"><Spinner size={14} /> Ingesting…</div>
          )}
          {!ingesting && runId && (
            <p className="truncate text-[0.6875rem] text-emerald-400/90">
              Ingested via {source === 'url' ? 'link' : 'upload'}: <span className="text-zinc-400">{ingestedLabel}</span>
            </p>
          )}
          {/* Inline, real message — a 422 from the URL path shows the server's own fallback copy. */}
          {ingestError && (
            <p className="text-[0.6875rem] leading-relaxed text-red-400">{ingestError}</p>
          )}
        </Card>

        {/* 2 · Character — the identity to recreate the shots with (used in Task 6) */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
              2 · Character <span className="font-normal normal-case text-zinc-600">who to recreate the shots as</span>
            </h3>
            {characterId && (
              <button
                onClick={() => setCharacterId(null)}
                className="cursor-pointer text-[0.6875rem] text-zinc-500 underline transition hover:text-zinc-300"
              >
                Clear
              </button>
            )}
          </div>

          {chars.length === 0 ? (
            <p className="text-xs text-zinc-600">No characters yet — create one on the Characters page.</p>
          ) : (
            <CharacterPicker
              chars={chars}
              selectedIds={characterId ? [characterId] : []}
              onToggle={(id) => setCharacterId((prev) => (prev === id ? null : id))}
              charDetails={charDetails}
              label="Whose identity goes into every shot"
              maxHeight="max-h-44"
            />
          )}
        </Card>

        {/* EXPRESS — one button, the whole pipeline. Runs analyze (if needed) → the ONE cost gate →
            recreate → assemble, and drops the finished video in the right column. Needs an ingested
            reel and a character; both are the same guards the manual path enforces. */}
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
            Make reel <span className="font-normal normal-case text-zinc-600">analyze → recreate → assemble, one click</span>
          </h3>
          <Btn onClick={startMakeReel} disabled={!runId || !characterId || makeReelBusy || recreating || analyzing} className="w-full">
            {makeReelBusy ? <Spinner size={16} /> : null}
            {makeReelBusy ? makeReelStageLabel : 'Make reel'}
          </Btn>
          <p className="text-[0.625rem] leading-relaxed text-zinc-600">
            {!runId ? 'Ingest a reel first.' : !characterId ? 'Pick your character first.' : 'One cost confirmation, then it runs to a finished video.'}
          </p>
          {makeReelStage === 'done' && finishedVideo && (
            <p className="text-[0.6875rem] text-emerald-400/90">Reel assembled — preview it on the right.</p>
          )}
          {skippedShots.length > 0 && makeReelStage === 'done' && (
            // Never silent: image shots that failed to recreate are named, not dropped invisibly.
            <p className="text-[0.6875rem] leading-relaxed text-red-400">
              Shot{skippedShots.length === 1 ? '' : 's'} {skippedShots.join(', ')} failed to recreate and {skippedShots.length === 1 ? 'was' : 'were'} left out of the video.
            </p>
          )}
          {makeReelError && (
            <p className="text-[0.6875rem] leading-relaxed text-red-400">{makeReelError}</p>
          )}
        </Card>

        {/* Manual path — analyze, then tweak shots/overlays, then Recreate. Still fully usable; Make
            reel above is the express lane and shares the same shots and cost gate. */}
        <div className={cn('flex items-center gap-2 text-[0.625rem] uppercase tracking-wider', MUTED)}>
          <span className={cn('h-px flex-1', 'bg-white/[0.07]')} /> or step through manually <span className={cn('h-px flex-1', 'bg-white/[0.07]')} />
        </div>

        {/* Analyze — disabled until a video is ingested (runId set) */}
        <Btn onClick={analyze} disabled={!runId || analyzing || makeReelBusy} className="w-full">
          {analyzing ? <Spinner size={16} /> : null}
          {analyzing ? 'Analyzing…' : 'Analyze reel'}
        </Btn>
        {analyzeError && (
          <p className="text-[0.6875rem] leading-relaxed text-red-400">{analyzeError}</p>
        )}

        {/* 3 · Recreate — the paid stage. Only shown once shots exist. */}
        {shots.length > 0 && (
          <Card className="p-4 space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
              3 · Recreate <span className="font-normal normal-case text-zinc-600">as {chars.find((c) => c.id === characterId)?.name || 'your character'}</span>
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <Select label="Aspect Ratio" options={ASPECT_OPTIONS} value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} />
              <Select label="Resolution" options={RES_OPTIONS} value={resolution} onChange={(e) => setResolution(e.target.value)} />
            </div>

            <p className="text-[0.625rem] leading-relaxed text-zinc-600">
              {imagesPerShot} image{imagesPerShot === 1 ? '' : 's'} per shot ({charImagesUsed} identity ref{charImagesUsed === 1 ? '' : 's'} + the frame).
              Character images go FIRST so Seedream keeps {chars.find((c) => c.id === characterId)?.name || 'your character'}'s face; the frame is used as the scene only.
            </p>

            {/* Cost breakdown: which kept shots are actually billed. Black slides are free and are
                called out here so the "N shots · M to recreate" gap is never a mystery. */}
            <p className="text-[0.625rem] leading-relaxed text-zinc-500">
              {keptCount} kept shot{keptCount === 1 ? '' : 's'} · {recreatableCount} to recreate
              {blackKeptCount > 0 && <> · {blackKeptCount} black slide{blackKeptCount === 1 ? '' : 's'} (free)</>}
            </p>

            {/* The button OPENS the gate — it never dispatches. Cost shown in amber via Money (the
                only amber allowed). Disabled while a batch runs or when no IMAGE shot is kept (black
                slides are free and never recreated, so they don't enable the button). */}
            <Btn
              onClick={openRecreateGate}
              disabled={recreating || makeReelBusy || !recreatableCount}
              className="w-full"
            >
              {recreating
                ? <>Recreating… ({recreatedDone}/{recreatableCount})</>
                // Quotes pendingRecreateCount (not recreatableCount): the number shown here must equal
                // the number runRecreate will actually dispatch, so a retry after success reads "0
                // shots · $0" instead of re-quoting (and re-billing) images that already exist.
                : <>Recreate {pendingRecreateCount} shot{pendingRecreateCount === 1 ? '' : 's'} · <Money amount={recreateTotal} decimals={3} /></>}
            </Btn>
            {recreateError && (
              <p className="text-[0.6875rem] leading-relaxed text-red-400">{recreateError}</p>
            )}
          </Card>
        )}
      </div>

      {/* The cost gate. Reused VERBATIM from Eddy — cancelling backdrop, z-[150] portal, amber-only
          money. Cancel closes it and dispatches ZERO requests (runRecreate only runs from Start). */}
      {showRecreateConfirm && (
        <PreRunConfirmGate
          // pendingRecreateCount, not recreatableCount: the gate must quote only what runRecreate
          // will actually dispatch, so it never over-bills shots that already succeeded.
          imageCount={pendingRecreateCount}
          imageCost={recreateTotal}
          onConfirm={confirmGate}
          onCancel={() => setShowRecreateConfirm(false)}
        />
      )}

      {/* RIGHT — the shot list. `flex-1` so the empty state fills the column instead of sitting as
          a short strip at the top, same reasoning as EddyGeneratePage. */}
      <div className="flex w-full min-w-0 flex-1 flex-col lg:min-h-0 lg:overflow-y-auto">
        {/* FINISHED REEL — shown once the express pipeline assembles a clip. Plays from the Video
            Library URL (fileUrl, no re-encode) and downloads through the metadata-stripped /clean
            path. Sits above the shots so the deliverable is the first thing seen when it's ready. */}
        {finishedVideo?.filename && (
          <div className="mb-5 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] p-3">
            <div className="flex items-center justify-between gap-2 pb-2">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-emerald-300">Finished reel</h3>
              <Btn variant="secondary" className="!rounded-lg !py-1.5 !px-3 !text-xs" onClick={downloadFinished}>
                Download
              </Btn>
            </div>
            <video
              src={videoApi.fileUrl(finishedVideo.filename)}
              controls
              playsInline
              className="mx-auto max-h-[70vh] w-auto max-w-full rounded-lg border border-zinc-800/60 bg-black"
            />
          </div>
        )}

        <div className="flex items-baseline justify-between gap-2 pb-2.5">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">Shots</h3>
          {shots.length > 0 && (
            <span className="text-xs text-zinc-500">
              {shots.length} shot{shots.length === 1 ? '' : 's'} · {keptCount} kept
            </span>
          )}
        </div>

        {analyzing ? (
          <div className={cn(
            'flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-8 text-center',
            HAIRLINE,
          )}>
            <Spinner size={22} />
            <p className={cn('text-xs', MUTED)}>Detecting shots and analyzing each frame…</p>
          </div>
        ) : shots.length === 0 ? (
          <div className={cn(
            'flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-8 text-center',
            HAIRLINE,
          )}>
            <p className={cn('text-xs font-semibold', TEXT)}>Shots will appear here</p>
            <p className={cn('max-w-xs text-[0.6875rem] leading-relaxed', MUTED)}>
              Ingest a reel on the left, then Analyze to detect its shots.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {shots.map((shot) => (
              <ShotCard key={shot.index} shot={shot} onToggleKeep={toggleKeep} onOverlayChange={updateOverlayText} />
            ))}
          </div>
        )}

        {/* The review grid — one tile per recreated shot, with Regenerate + Remove. Rendered only
            for shots that carry a result, so it appears after the first Recreate run. */}
        {anyResults && (
          <div className="mt-5 border-t border-white/[0.07] pt-4">
            <h3 className="pb-2.5 text-sm font-semibold uppercase tracking-wider text-zinc-300">
              Recreated <span className="font-normal normal-case text-zinc-500">{recreatedDone} of {recreatableCount} recreated{blackKeptCount > 0 ? ` · ${blackKeptCount} black slide${blackKeptCount === 1 ? '' : 's'}` : ''}</span>
            </h3>
            <div className="grid [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {gridShots.map((shot) => (
                <ShotResultTile
                  key={shot.index}
                  shot={shot}
                  onRegenerate={regenerateShot}
                  onRemove={removeShotResult}
                  onOverlayChange={updateOverlayText}
                />
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
