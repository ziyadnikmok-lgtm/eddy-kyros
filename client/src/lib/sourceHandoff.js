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

/**
 * WHICH Photo Match tab a send should open.
 *
 * There are two — SD and NB2 — sharing one page implementation and one handoff key. Every sender
 * (Library, Base Library, Frames, Instagram Frames, Pinterest) was written when there was only SD,
 * so they all navigate to 'photoMatchSeedream'. Someone working in NB2 who sent a batch was moved
 * to the SD tab, and their own tab looked as though the send had done nothing at all (owner,
 * 2026-08-17).
 *
 * The tabs record themselves as they mount; this reads that. The handoff PAYLOAD keeps the single
 * 'photoMatchSeedream' key — only one Photo Match page is mounted at a time, so one key is enough,
 * and sharing it means a stash written for either tab is picked up by whichever one opens.
 *
 * Falls back to SD, which is exactly the behaviour it replaces.
 */
export const PHOTO_MATCH_HANDOFF_KEY = 'photoMatchSeedream';

export function photoMatchTarget() {
  try {
    const last = window.localStorage.getItem('kyros.lastPhotoMatchTab');
    if (last === 'photoMatchNB2' || last === 'photoMatchSeedream') return last;
  } catch { /* private mode: SD, as before */ }
  return 'photoMatchSeedream';
}

/**
 * The page a send should navigate to, given the key it stashed under.
 *
 * Senders stash and navigate under one key. That is still true for every destination except Photo
 * Match, where two tabs share one key — so this is the one place the two can differ. Wrap the
 * navigateTo, leave the stash alone.
 */
export function handoffDestination(page) {
  return page === PHOTO_MATCH_HANDOFF_KEY ? photoMatchTarget() : page;
}

/** Record the Photo Match tab now open, so a later send lands back on it. */
export function rememberPhotoMatchTab(page) {
  try { window.localStorage.setItem('kyros.lastPhotoMatchTab', page); } catch { /* ignore */ }
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
