/**
 * Pinterest browse — search, masonry grid, tick pins, send them to a Seedream tab.
 *
 * THIS IS A SCRAPE. It works today; Pinterest can change or gate that endpoint without notice.
 * Every failure is named on screen rather than collapsing to an empty grid, because an empty grid
 * reads as "no matches" and sends you off to retype a query that was never the problem.
 *
 * Search is the ONLY thing offered, because it is the only thing that works: related-pins (404)
 * and board-feed (400) were both tested against the live endpoint and both fail. A "more like
 * this" button built on a guessed resource name would work today and die silently later, so the
 * pin's own description feeds a fresh search instead — the closest honest equivalent.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { pinterestFeed } from '../services/api';
import { createPageStore } from '../lib/pageStateStore';
import { stashSourceHandoff } from '../lib/sourceHandoff';
import { useApp } from '../context/AppContext';
import { Card, Btn, Spinner, Badge } from '../components/UI';
import { cn } from '../lib/utils';

const store = createPageStore('pinterest-feed-v1');

/** Where a selection can be sent. Every one of these listeners already exists — the Library uses
 *  the same events — so this is the established handoff rather than a new one. */
const DESTINATIONS = [
  { id: 'photoMatchSeedream', label: 'Photo Match', event: 'kyros:use-as-photo-match-seedream-source' },
  { id: 'sceneRecreateSeedream', label: 'Scene Recreate', event: 'kyros:use-as-scene-recreate-seedream-source' },
  { id: 'poseRemixSeedream', label: 'Pose Remix', event: 'kyros:use-as-pose-remix-seedream-source' },
  { id: 'outfitSwapSeedream', label: 'Outfit Swap', event: 'kyros:use-as-outfit-swap-seedream-source' },
];

/**
 * Hide anything too small to generate from.
 *
 * Pinterest serves 236px thumbnails beside 1200px originals, and a 400px source produces a soft
 * result with nothing on screen explaining why. 600px on the long edge is the floor; the real
 * size is on every tile so the rule is visible rather than mysterious.
 */
const MIN_LONG_EDGE = 600;

/**
 * THE FIRST SCREEN IS A DIFFERENT PROBLEM FROM THE REST.
 *
 * Measured against the live endpoint (2026-08-11), one request each:
 *
 *   page_size=25  -> 1.4s            page_size=100 -> 2.7s  (91 pins, 0.7MB)
 *   page_size=50  -> 2.8s            page_size=250 -> 6-8.5s (241 pins, 1.9MB)
 *
 * 250 was tried first and it is the reason search felt slow: seven seconds of an empty grid. 100
 * comes back in under three and is already more than a screenful, so that is what the first request
 * asks for.
 *
 * PAGE_SIZE is what continuation pages ask for, and it is mostly theatre: a bookmarked page comes
 * back with ~25 pins no matter what is requested. Left at 250 because asking costs nothing and
 * Pinterest may raise it.
 */
const FIRST_PAGE = 100;
const PAGE_SIZE = 250;

/**
 * How far the grid fills itself AFTER the first page, without being asked.
 *
 * ~25 pins per continuation page at ~1s each, so this is roughly six seconds of background work
 * that the owner never waits on -- they are already picking from page one. "Load more" then means
 * "I have been through three hundred pins", not "give me a usable screenful".
 */
const BACKFILL_TARGET = 240;
const BACKFILL_MAX_PAGES = 10;

/**
 * The identity of the PICTURE, not of the pin.
 *
 * A pinimg path carries the file's content hash (/236x/ab/cd/ef/<32 hex>.jpg), so the same image
 * repinned by five people -- five different pin ids -- collapses to one key. Falls back to the whole
 * URL if the shape ever changes, which dedupes exact repeats and nothing else: a wrong key that
 * matched too much would silently hide pins.
 */
function imageKey(url) {
  const s = String(url || '');
  const m = /\/([0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32})\./.exec(s);
  return m ? m[1] : s;
}

/** Tailwind's breakpoints, mirrored so the masonry can bucket by hand -- see `columns` below. */
function colsForWidth(w) {
  if (w >= 1280) return 5;
  if (w >= 1024) return 4;
  if (w >= 640) return 3;
  return 2;
}

/**
 * Fetch one pin through the proxy, waiting out a rate limit rather than treating it as a dead URL.
 *
 * Three tries, backing off 1s / 2s / 4s, honouring Retry-After when the server sends one. Only 429
 * is retried: a 403 or a 404 will still be a 403 or a 404 in four seconds, and retrying those would
 * turn one dead pin into a stall.
 */
async function fetchPinWithRetry(url, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- a retry is sequential by definition
    const resp = await fetch(url, { credentials: 'include' });
    if (resp.status !== 429) return resp;
    last = resp;
    const retryAfter = Number(resp.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 10_000)
      : 1000 * (2 ** i);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, waitMs); });
  }
  return last;
}

export default function PinterestFeedPage() {
  const { notify, navigateTo } = useApp();

  const [query, setQuery] = useState('');
  const [pins, setPins] = useState([]);
  // Read inside the search callback to decide whether a failed page is worth an error banner. A ref
  // rather than the state value so the callback is not rebuilt on every page that lands.
  const pinsRef = useRef([]);
  const [bookmark, setBookmark] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [picked, setPicked] = useState([]);
  const [minRes, setMinRes] = useState(true);
  const [safe, setSafe] = useState(true);
  const [dest, setDest] = useState(DESTINATIONS[0].id);
  const [restored, setRestored] = useState(false);
  const [sending, setSending] = useState(false);
  // The background top-up: shown as a quiet line, never as a blocking spinner, because the grid is
  // usable the whole time it runs.
  const [backfilling, setBackfilling] = useState(false);
  // Cancels a backfill when a newer search starts, so the previous query's pages cannot land in the
  // new query's grid.
  const runIdRef = useRef(0);
  // Replace what is already in the destination, or add to it. Remembered, because whichever
  // one you want you tend to want repeatedly.
  const [replaceTarget, setReplaceTarget] = useState(() => {
    try { return localStorage.getItem('kyros.pinterest.replaceTarget') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('kyros.pinterest.replaceTarget', replaceTarget ? '1' : '0'); } catch { /* private mode */ }
  }, [replaceTarget]);
  // Origin URLs already pulled into Kyros. Dedupe reads this; the send writes to it.
  const [seen, setSeen] = useState(() => new Set());

  // --- persistence: a selection must survive leaving the tab -------------------------------------
  useEffect(() => {
    (async () => {
      const [q, p, sel, sn] = await Promise.all([
        store.get('query', ''), store.get('pins', []), store.get('picked', []), store.get('seen', []),
      ]);
      setQuery(q || '');
      setPins(Array.isArray(p) ? p : []);
      setPicked(Array.isArray(sel) ? sel : []);
      setSeen(new Set(Array.isArray(sn) ? sn : []));
      setRestored(true);
    })();
  }, []);
  useEffect(() => { pinsRef.current = pins; }, [pins]);
  useEffect(() => { if (restored) store.set('picked', picked); }, [picked, restored]);
  useEffect(() => { if (restored) store.set('query', query); }, [query, restored]);
  // Capped: the grid can run to hundreds and the point is to resume a session, not to archive it.
  // 1000, not 200: one Load more can now add ~230, and a cap below a single page threw away the
  // session it exists to restore.
  useEffect(() => { if (restored) store.set('pins', pins.slice(0, 1000)); }, [pins, restored]);
  useEffect(() => { if (restored) store.set('seen', [...seen].slice(-2000)); }, [seen, restored]);

  // --- the rate-limit countdown ------------------------------------------------------------------
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  /**
   * Merge a page in, dropping anything already on screen. Returns how many NEW VISIBLE tiles landed.
   *
   * Deduped on the pin id AND on the image itself. Pinterest hands the same picture out under
   * different pin ids when several people have pinned it, and those are the duplicates that reach
   * the eye -- two identical tiles you can tick twice and pay for twice. `imageKey` reads the
   * content hash out of the pinimg path, so the same file matches whatever it is called.
   *
   * Appends only, never reorders: a repeat must not move the tile it repeats.
   */
  const mergePins = useCallback((incoming, { replace = false } = {}) => {
    let fresh = 0;
    setPins((prev) => {
      const base = replace ? [] : prev;
      const haveIds = new Set(base.map((p) => p.id));
      const haveImages = new Set(base.map((p) => imageKey(p.orig)));
      const add = [];
      for (const p of incoming || []) {
        const k = imageKey(p.orig);
        if (haveIds.has(p.id) || haveImages.has(k)) continue;
        haveIds.add(p.id); haveImages.add(k);
        add.push(p);
        if (Math.max(p.w, p.h) >= MIN_LONG_EDGE) fresh += 1;
      }
      return add.length ? [...base, ...add] : base;
    });
    return fresh;
  }, []);

  /**
   * SEARCH, THEN KEEP FILLING IN THE BACKGROUND.
   *
   * Measured against the live endpoint (2026-08-11), and the numbers decide the whole shape:
   *
   *   page_size=25  -> 1.4s     page_size=100 -> 2.7s (91 pins)
   *   page_size=50  -> 2.8s     page_size=250 -> 6-8.5s (241 pins, 1.9MB of JSON)
   *
   * And a CONTINUATION page ignores page_size entirely: every bookmarked page comes back with
   * ~25 pins whatever is asked for. So one big request cannot be the answer to "more content" --
   * it is only ever the answer to the FIRST screen, and it costs seven seconds of staring at
   * nothing to get it.
   *
   * So: ask for 100 first (results in under three seconds), then walk the bookmarks in the
   * background, appending each page as it arrives. The grid fills itself up to BACKFILL_TARGET
   * while the owner is already looking at it, and "Load more" becomes the thing you press when you
   * have exhausted three hundred pins rather than the thing you press to get a usable screenful.
   *
   * runIdRef cancels a backfill the moment another search starts -- otherwise the previous query's
   * pages keep landing in the new query's grid.
   */
  const search = useCallback(async (term, more = false) => {
    const q = String(term || '').trim();
    if (!q) return;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setLoading(true);
    setError('');
    try {
      const first = await pinterestFeed.search({
        query: q, bookmark: more ? bookmark : '', safe, pageSize: more ? PAGE_SIZE : FIRST_PAGE,
      });
      const added = mergePins(first.pins, { replace: !more });
      setBookmark(first.bookmark);
      if (!more && !first.pins.length) { setError('No pins for that search'); return; }
      if (more) notify(added ? `${added} more` : 'Nothing new on that page — Pinterest is repeating itself', added ? 'success' : 'info');

      // The rest arrives on its own. Not awaited: the first page is already on screen and the
      // owner can pick from it while this runs.
      setLoading(false);
      let mark = first.bookmark;
      let got = added;
      for (let page = 0; page < BACKFILL_MAX_PAGES && mark && got < BACKFILL_TARGET; page += 1) {
        if (runIdRef.current !== runId) return;        // a newer search owns the grid now
        setBackfilling(true);
        // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's bookmark
        const r = await pinterestFeed.search({ query: q, bookmark: mark, safe, pageSize: PAGE_SIZE });
        if (runIdRef.current !== runId) return;
        got += mergePins(r.pins);
        mark = r.bookmark;
        setBookmark(r.bookmark);
        if (!r.pins.length) break;
      }
    } catch (err) {
      if (runIdRef.current !== runId) return;
      const msg = err?.message || 'Search failed';
      // A rate limit pauses paging with a countdown. Anything else is stated as-is — the server
      // distinguishes "unreachable", "blocked", "shape changed" and a transient 5xx, and each needs
      // a different reaction. A backfill page that fails is NOT worth an error banner over results
      // that are already on screen, so it only speaks up when the grid is empty.
      if (/rate-limiting/i.test(msg)) {
        const secs = Number((msg.match(/wait (\d+)s/) || [])[1]) || 30;
        setCooldown(secs);
        setError(msg);
      } else if (!pinsRef.current.length) {
        setError(msg);
      }
    } finally {
      if (runIdRef.current === runId) { setLoading(false); setBackfilling(false); }
    }
  }, [bookmark, safe, notify, mergePins]);

  const visible = useMemo(() => (
    minRes ? pins.filter((p) => Math.max(p.w, p.h) >= MIN_LONG_EDGE) : pins
  ), [pins, minRes]);
  const hiddenCount = pins.length - visible.length;

  /**
   * MASONRY THAT DOES NOT RESHUFFLE.
   *
   * This was CSS `column-count`, which balances the whole flow every time content changes -- so
   * "Load more" threw every tile into a new position and the shot you were about to tick moved
   * somewhere else (owner, 2026-08-11). CSS columns cannot be told not to do that.
   *
   * Bucketing by hand instead: each pin goes to the shortest column so far, measured in aspect
   * ratio (a tile is rendered full-width, so h/w IS its relative height). The assignment depends
   * only on the pins BEFORE it, so appending can never move one that is already placed. Changing
   * the window width re-lays everything out, which is the one case where movement is expected.
   */
  const [cols, setCols] = useState(() => colsForWidth(typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setCols(colsForWidth(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const columns = useMemo(() => {
    const buckets = Array.from({ length: cols }, () => []);
    const heights = new Array(cols).fill(0);
    for (const p of visible) {
      let k = 0;
      for (let i = 1; i < cols; i += 1) if (heights[i] < heights[k]) k = i;
      buckets[k].push(p);
      // A pin with no dimensions gets a middling 4:5, so one bad row cannot collapse a column.
      heights[k] += (p.w > 0 && p.h > 0) ? p.h / p.w : 1.25;
    }
    return buckets;
  }, [visible, cols]);

  const toggle = useCallback((id) => {
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }, []);

  /**
   * Send the ticked pins to a Seedream tab.
   *
   * Fetched through the proxy because i.pinimg.com refuses a request carrying a browser Origin —
   * a direct fetch here fails for every pin, which would look like the feature being broken
   * rather than blocked.
   *
   * One pin that will not download is reported and SKIPPED; the rest still go. Abandoning a
   * selection of twenty over one dead URL is the failure worth avoiding.
   *
   * A 429 IS NOT A DEAD URL. Ticking 20 and receiving 11 was this: the grid's own thumbnails go
   * through the same proxy, they had already spent the minute's budget, and every download that
   * came back 429 was counted as "could not be downloaded" and dropped (owner, 2026-08-11). The
   * limiter has been fixed at the mount, and this retries a 429 anyway -- a rate limit is a WAIT,
   * and the pin the user ticked is not optional.
   *
   * Whatever still fails STAYS TICKED, so Send can simply be pressed again. Clearing the selection
   * on a partial send is what made the loss invisible.
   */
  const send = useCallback(async () => {
    const chosen = pins.filter((p) => picked.includes(p.id));
    if (!chosen.length) { notify('Tick at least one pin first', 'error'); return; }
    const target = DESTINATIONS.find((d) => d.id === dest);
    setSending(true);
    const images = [];
    const failed = [];
    for (const p of chosen) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential on purpose: twenty parallel
        // proxy fetches is exactly the burst that earns a rate limit.
        const resp = await fetchPinWithRetry(pinterestFeed.proxyUrl(p.orig));
        if (!resp.ok) throw new Error(String(resp.status));
        // eslint-disable-next-line no-await-in-loop
        const blob = await resp.blob();
        // eslint-disable-next-line no-await-in-loop
        const dataUrl = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = rej;
          fr.readAsDataURL(blob);
        });
        images.push({ dataUrl, name: `pinterest-${p.id}.jpg` });
      } catch {
        failed.push(p.id);
      }
    }
    setSending(false);
    if (!images.length) {
      notify('None of those pins could be downloaded — Pinterest may be blocking the proxy', 'error');
      return;
    }
    /**
     * STASH, then navigate, then fire the event -- the order Frame Grabber uses, and the reason it
     * works where this did not.
     *
     * Dispatching a CustomEvent alone dropped everything silently: the destination is lazy-loaded,
     * so the event fired into the void before its chunk had mounted. lib/sourceHandoff exists for
     * exactly this -- the destination consumes it ON MOUNT, with no timing race. The event is
     * still fired afterwards for a page that happens to be open already; the destination dedups.
     *
     * The payload key is `items`, not `images`. That is what every other sender uses and what the
     * listeners read, and getting it wrong was the other half of why nothing arrived.
     */
    const itemsPayload = images.map((im) => ({ dataUrl: im.dataUrl, name: im.name }));
    stashSourceHandoff(target.id, itemsPayload);
    // REPLACE or ADD. Replacing is the common case -- a new scene means a new set -- but appending
    // is what you want when building one batch out of several searches.
    try {
      window.sessionStorage.setItem(`kyros.pendingSourceMode.${target.id}`, replaceTarget ? 'replace' : 'add');
    } catch { /* private mode: the destination falls back to adding, which loses nothing */ }
    navigateTo(target.id);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent(target.event, { detail: { items: itemsPayload } }));
    }, 300);
    // Only what actually went is marked as imported, and only what went is unticked -- a pin that
    // failed stays selected so pressing Send again retries exactly those.
    const sentIds = new Set(chosen.filter((p) => !failed.includes(p.id)).map((p) => p.id));
    setSeen((cur) => new Set([...cur, ...chosen.filter((p) => sentIds.has(p.id)).map((p) => p.orig)]));
    setPicked((cur) => cur.filter((id) => !sentIds.has(id)));
    notify(
      failed.length
        ? `Sent ${images.length} of ${chosen.length} — ${failed.length} still selected, press Send again to retry`
        : `Sent ${images.length} to ${target.label}`,
      failed.length ? 'error' : 'success',
    );
  }, [pins, picked, dest, notify, navigateTo, replaceTarget]);

  const inputRef = useRef(null);

  return (
    <div className="space-y-4 animate-in">
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(query); }}
            placeholder="Search Pinterest — poolside bikini, mirror selfie, café outfit…"
            className="flex-1 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-rose-500/50 focus:outline-none"
          />
          <Btn onClick={() => search(query)} disabled={loading || cooldown > 0}>
            {loading ? <Spinner size={14} /> : null}
            {cooldown > 0 ? `Wait ${cooldown}s` : 'Search'}
          </Btn>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={minRes} onChange={(e) => setMinRes(e.target.checked)}
              className="cursor-pointer accent-rose-500" />
            Hide small images
            {hiddenCount > 0 && <span className="text-zinc-600">({hiddenCount} hidden)</span>}
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)}
              className="cursor-pointer accent-rose-500" />
            Safe search
          </label>
          {pins.length > 0 && <span className="text-zinc-600">{visible.length} shown</span>}
          {/* The grid keeps filling on its own after the first page. Said quietly, beside the
              count, because it is not something to wait for -- everything on screen is pickable
              while it runs. */}
          {backfilling && (
            <span className="flex items-center gap-1 text-zinc-600">
              <Spinner size={10} /> finding more…
            </span>
          )}
        </div>

        {/* Named, never an empty grid. The server distinguishes unreachable / blocked / shape-changed
            / rate-limited, and each of those wants a different reaction. */}
        {error && (
          <p className={cn('rounded-lg border px-3 py-2 text-xs',
            cooldown > 0 ? 'border-amber-500/40 bg-amber-500/[0.07] text-amber-200'
                         : 'border-red-500/40 bg-red-500/[0.07] text-red-200')}>
            {error}
            {cooldown > 0 && <span className="ml-1 font-semibold">Retrying is disabled for {cooldown}s.</span>}
          </p>
        )}
      </Card>

      {picked.length > 0 && (
        <Card className="flex flex-wrap items-center gap-2 p-3">
          <Badge color="green">{picked.length} selected</Badge>
          <select value={dest} onChange={(e) => setDest(e.target.value)}
            className="rounded-lg border border-white/[0.07] bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 cursor-pointer">
            {DESTINATIONS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <Btn onClick={send} disabled={sending} className="!py-1.5 !text-xs">
            {sending ? <Spinner size={12} /> : null}
            Send {picked.length} to {DESTINATIONS.find((d) => d.id === dest)?.label}
          </Btn>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
            <input type="checkbox" checked={replaceTarget} onChange={(e) => setReplaceTarget(e.target.checked)}
              className="cursor-pointer accent-rose-500" />
            {replaceTarget ? 'Replace what is there' : 'Add to what is there'}
          </label>
          <button onClick={() => setPicked([])}
            className="text-xs text-zinc-500 underline hover:text-zinc-300 cursor-pointer">Clear</button>
        </Card>
      )}

      {/* One flex column per bucket. Not CSS columns: those re-balance on every append and moved
          every tile out from under the cursor. Not a measured JS grid either -- nothing is
          positioned absolutely, so there is no measurement pass to jank on a fast scroll. */}
      {visible.length > 0 && (
        <div className="flex gap-3 items-start">
          {columns.map((bucket, ci) => (
          <div key={ci} className="flex-1 min-w-0">
          {bucket.map((p) => {
            const already = seen.has(p.orig);
            const on = picked.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => toggle(p.id)}
                title={`${p.w}×${p.h}${already ? ' · already imported' : ''}${p.alt ? ` · ${p.alt}` : ''}`}
                className={cn('group relative mb-3 block w-full break-inside-avoid overflow-hidden rounded-xl border-2 transition cursor-pointer',
                  on ? 'border-rose-500' : 'border-transparent hover:border-zinc-600',
                  // Dimmed, not hidden: it is still pickable, you just should not need to.
                  already && !on ? 'opacity-40' : '')}
              >
                {/* STRAIGHT FROM PINTEREST'S CDN, not through our proxy.
                    Every tile used to be a round trip through the Node server, which then fetched
                    the same file from pinimg -- and it is what spent the rate-limit budget that the
                    real downloads needed (20 pins ticked, 11 delivered). Measured: i.pinimg.com
                    answers an image request in 17-27ms and sends
                    `cache-control: immutable, max-age=31536000`, so a revisited search is instant.
                    An <img> tag is not a CORS request, so nothing blocks it -- which is exactly why
                    the SEND still goes through the proxy: fetch() sends an Origin and pinimg
                    returns no access-control-allow-origin, so the bytes cannot be read directly.
                    onError falls back to the proxy, so if Pinterest ever blocks hotlinking the grid
                    degrades to slow instead of empty. */}
                <img
                  src={p.thumb}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    const el = e.currentTarget;
                    if (el.dataset.viaProxy) return;      // already tried; leave the broken tile
                    el.dataset.viaProxy = '1';
                    el.src = pinterestFeed.proxyUrl(p.thumb);
                  }}
                  className="w-full bg-zinc-900"
                />
                {on && (
                  <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md bg-rose-500 text-xs font-bold text-white">
                    {picked.indexOf(p.id) + 1}
                  </span>
                )}
                {already && (
                  <span className="absolute left-2 top-2 rounded bg-black/80 px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-zinc-300">
                    in Kyros
                  </span>
                )}
                {/* The real pixel size, so "hide small images" is a visible rule rather than a
                    mysterious filter. */}
                <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-px text-[0.5625rem] font-mono text-zinc-400 opacity-0 transition group-hover:opacity-100">
                  {p.w}×{p.h}
                </span>
              </button>
            );
          })}
          </div>
          ))}
        </div>
      )}

      {bookmark && visible.length > 0 && (
        <Btn variant="secondary" className="w-full" onClick={() => search(query, true)}
          disabled={loading || cooldown > 0}>
          {loading ? <Spinner size={14} /> : null}
          {cooldown > 0 ? `Rate-limited — ${cooldown}s` : 'Load more'}
        </Btn>
      )}

      {!pins.length && !loading && !error && (
        <p className="py-16 text-center text-sm text-zinc-600">
          Search Pinterest, tick the shots you want, and send them straight into Photo Match.
        </p>
      )}
    </div>
  );
}
