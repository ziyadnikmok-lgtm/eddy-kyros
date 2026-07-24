/**
 * Shared record of frames that gave up on generation (failed the retry cap), keyed by the
 * frame's file NAME (preserved from Frame Library frame → source file → job). The Frame
 * Library reads this to show a "Failed" status/filter.
 *
 * On give-up we ALSO make sure the frame is present in the Frame Library — a frame imported
 * straight into a generator was never a Library item, so marking only its name wouldn't show
 * anything. Adding it (deduped by name) means every failed frame is selectable under Failed.
 */

import { loadFrames, saveAllFrames } from './frameLibraryStore';

const KEY = 'kyros.failedFrameNames';

function read() {
  try { return new Set(JSON.parse(window.localStorage.getItem(KEY) || '[]')); } catch { return new Set(); }
}
function write(set) {
  try { window.localStorage.setItem(KEY, JSON.stringify([...set])); } catch { /* ignore */ }
}

export function getFailedFrameNames() { return read(); }

// Serialize Library read-modify-write so concurrent give-ups don't clobber each other.
let writeChain = Promise.resolve();
function ensureInLibrary(name, dataUrl, source) {
  if (!name || !dataUrl) return;
  writeChain = writeChain.then(async () => {
    const frames = await loadFrames();
    if (frames.some((f) => f.name === name)) return; // already in the Library (by name)
    const entry = {
      id: `failed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name, dataUrl, source: source || 'Failed generation', createdAt: Date.now(), usage: [],
    };
    await saveAllFrames([entry, ...frames]);
  }).catch(() => { /* ignore */ });
  return writeChain;
}

export function markFrameFailed(name, dataUrl, source) {
  if (!name) return;
  const s = read();
  if (!s.has(name)) { s.add(name); write(s); }
  ensureInLibrary(name, dataUrl, source);
  // Fire after the (async) Library add kicks off; the Library refreshes on this event and on
  // focus, so a small delay before the add finishes is fine — the name is already recorded.
  try { window.dispatchEvent(new CustomEvent('kyros:frame-outcome', { detail: { name, failed: true } })); } catch { /* ignore */ }
}

export function clearFrameFailed(names) {
  const list = Array.isArray(names) ? names : [names];
  const s = read();
  let changed = false;
  for (const n of list) { if (n && s.delete(n)) changed = true; }
  if (changed) {
    write(s);
    try { window.dispatchEvent(new CustomEvent('kyros:frame-outcome', { detail: { cleared: list } })); } catch { /* ignore */ }
  }
}
