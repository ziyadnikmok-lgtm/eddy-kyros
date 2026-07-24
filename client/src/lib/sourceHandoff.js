/**
 * Reliable in-app source handoff.
 *
 * Sending images to another page used to rely on a CustomEvent dispatched ~300ms after
 * navigating. But destination pages are lazy-loaded — if the chunk takes longer than that
 * to mount, the event fires into the void and the images are silently dropped. This stash
 * is consumed by the destination on mount instead, so there's no timing race. Paired with
 * the page's addFiles() dedup, it's safe even if the legacy event also fires.
 *
 * sessionStorage (not localStorage) so it's transient and never lingers between app runs.
 */

const KEY = (page) => `kyros.pendingSource.${page}`;

// items: [{ dataUrl, name }]
export function stashSourceHandoff(page, items) {
  try {
    if (Array.isArray(items) && items.length) {
      window.sessionStorage.setItem(KEY(page), JSON.stringify(items));
    }
  } catch { /* ignore quota/private-mode */ }
}

export function consumeSourceHandoff(page) {
  try {
    const raw = window.sessionStorage.getItem(KEY(page));
    if (!raw) return [];
    window.sessionStorage.removeItem(KEY(page));
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((it) => it && it.dataUrl) : [];
  } catch {
    return [];
  }
}
