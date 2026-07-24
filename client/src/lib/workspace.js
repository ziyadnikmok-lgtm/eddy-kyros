/**
 * WORKSPACES — the browser-style tabs at the top of the app.
 *
 * A workspace is the SAME application with its own colour identity: Eddy and Ziyad share every
 * page, every feature and the same code, so anything either of us pushes works for both. Only the
 * skin differs, which is why this file holds nothing but an id, a label and a swatch — the actual
 * theming is one `data-workspace` attribute on <html> plus a CSS block in index.css that swaps the
 * rose ramp (see WORKSPACE THEMES there).
 *
 * Adding a third person later is one entry here + one CSS block. Nothing else needs to know.
 */
/**
 * `engines` — which tool engines this workspace offers in the sidebar switcher.
 *
 * Eddy works in Seedream only, so Gemini is not listed for him: the toggle renders just Seedream
 * and the engine can never sit on 'gemini' in his tab. This is config rather than a CSS
 * `display:none` on purpose — hiding the button alone would still leave the engine STATE on
 * 'gemini' (it is remembered in localStorage and shared between tabs), which filters every
 * Seedream section out and leaves him staring at an almost empty sidebar with no way back.
 */
export const WORKSPACES = [
  { id: 'eddy', label: 'Eddy', swatch: '#f0247d', engines: ['seedream'] },
  { id: 'ziyad', label: 'Ziyad', swatch: '#9b3df0', engines: ['seedream', 'gemini'] },
];

/** Engines a workspace offers; falls back to both so an unknown id is never left with none. */
export function workspaceEngines(id) {
  return WORKSPACES.find((w) => w.id === id)?.engines || ['seedream', 'gemini'];
}

const KEY = 'kyros.workspace';
const DEFAULT_ID = WORKSPACES[0].id;

const isValid = (id) => WORKSPACES.some((w) => w.id === id);

export function getWorkspace() {
  try {
    const v = localStorage.getItem(KEY);
    return isValid(v) ? v : DEFAULT_ID;
  } catch {
    return DEFAULT_ID;   // private mode / storage blocked
  }
}

/** Writes the attribute the CSS keys off. Safe to call before React mounts. */
export function applyWorkspace(id) {
  const next = isValid(id) ? id : DEFAULT_ID;
  try { document.documentElement.dataset.workspace = next; } catch { /* no DOM (SSR/tests) */ }
  return next;
}

export function setWorkspace(id) {
  const next = applyWorkspace(id);
  try { localStorage.setItem(KEY, next); } catch { /* storage blocked — theme still applies for this session */ }
  return next;
}
