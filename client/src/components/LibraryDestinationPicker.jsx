import { useState, useEffect, useMemo } from 'react';
import { createEddyCollection } from '../lib/eddyCollectionStore';
import { LIBRARY_DESTS, normaliseDest, destLabel } from '../lib/libraryDestination';

/**
 * "Send results to [Library ▾]" — the control, and the state behind it.
 *
 * Chosen BEFORE Generate, not after. Sending afterwards already works where a results panel exists,
 * and it is the wrong moment: you know whether you are making base photos before you press the
 * button, and moving a batch of sixty afterwards is sixty tiles to tick (Eddy, via the owner,
 * 2026-08-13).
 *
 * Each tab passes its own storage key so the tabs remember separately — Scene Recreate feeding Base
 * Library should not silently redirect Pose Remix on the next click.
 */
export function useLibraryDestination(storageKey) {
  const [destDb, setDestDb] = useState(() => {
    try { return normaliseDest(localStorage.getItem(storageKey)); } catch { return 'eddy-library'; }
  });

  useEffect(() => {
    try { localStorage.setItem(storageKey, destDb); } catch { /* private mode — the session default still holds */ }
  }, [storageKey, destDb]);

  // createEddyCollection caches per dbName, so this hands back the SAME instance the Library tab
  // itself uses. Two instances of one collection would each hold their own write queue and the
  // serialisation that queue exists to provide would be gone.
  const store = useMemo(() => createEddyCollection(destDb), [destDb]);

  return { destDb, setDestDb, store, label: destLabel(destDb), isBase: destDb === 'eddy-base' };
}

/**
 * The control itself. Same markup and wording as the two tabs that already had one, so it reads as
 * the same feature rather than a second one that happens to look similar.
 */
export function LibraryDestinationPicker({ value, onChange, className = '' }) {
  return (
    <label className={`flex items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2 ${className}`}>
      <span className="text-[0.6875rem] uppercase tracking-wider text-zinc-500">Send results to</span>
      <select
        value={value}
        onChange={(e) => onChange(normaliseDest(e.target.value))}
        className="rounded-lg border border-white/[0.07] bg-zinc-900 px-2 py-1 text-xs text-zinc-200 cursor-pointer"
      >
        {LIBRARY_DESTS.map((d) => <option key={d.db} value={d.db}>{d.label}</option>)}
      </select>
    </label>
  );
}

/**
 * The confirmation line under it, shown only for Base.
 *
 * Base Library is the SOURCE set Max Outfit dresses, so a run landing there by mistake quietly
 * pollutes the input for every later run. Silence is fine for the ordinary destination; the
 * unusual one says so out loud.
 */
export function LibraryDestinationNote({ value }) {
  if (normaliseDest(value) !== 'eddy-base') return null;
  return (
    <p className="text-center text-[0.625rem] text-emerald-300/80">
      This run files into Base Library — not the Library.
    </p>
  );
}
