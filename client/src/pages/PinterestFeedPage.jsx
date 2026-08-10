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

// 100 a page. 25 meant scrolling for a handful of usable shots, and Pinterest serves a page
// this size in the same single request (owner, 2026-08-10).
const PAGE_SIZE = 100;

export default function PinterestFeedPage() {
  const { notify, navigateTo } = useApp();

  const [query, setQuery] = useState('');
  const [pins, setPins] = useState([]);
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
  useEffect(() => { if (restored) store.set('picked', picked); }, [picked, restored]);
  useEffect(() => { if (restored) store.set('query', query); }, [query, restored]);
  // Capped: the grid can run to hundreds and the point is to resume a session, not to archive it.
  useEffect(() => { if (restored) store.set('pins', pins.slice(0, 200)); }, [pins, restored]);
  useEffect(() => { if (restored) store.set('seen', [...seen].slice(-2000)); }, [seen, restored]);

  // --- the rate-limit countdown ------------------------------------------------------------------
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const search = useCallback(async (term, more = false) => {
    const q = String(term || '').trim();
    if (!q) return;
    setLoading(true);
    setError('');
    try {
      const r = await pinterestFeed.search({ query: q, bookmark: more ? bookmark : '', safe, pageSize: PAGE_SIZE });
      setPins((prev) => {
        const next = more ? [...prev, ...r.pins] : r.pins;
        // Pinterest returns the same pin across pages often enough to matter; a duplicate tile is
        // a tile you can tick twice and pay for twice.
        const byId = new Map(next.map((p) => [p.id, p]));
        return [...byId.values()];
      });
      setBookmark(r.bookmark);
      if (!more && !r.pins.length) setError('No pins for that search');
    } catch (err) {
      const msg = err?.message || 'Search failed';
      // A rate limit pauses paging with a countdown. Anything else is stated as-is — the server
      // distinguishes "unreachable", "blocked" and "shape changed", and each needs a different
      // reaction from the user.
      if (/rate-limiting/i.test(msg)) {
        const secs = Number((msg.match(/wait (\d+)s/) || [])[1]) || 30;
        setCooldown(secs);
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [bookmark, safe]);

  const visible = useMemo(() => (
    minRes ? pins.filter((p) => Math.max(p.w, p.h) >= MIN_LONG_EDGE) : pins
  ), [pins, minRes]);
  const hiddenCount = pins.length - visible.length;

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
        const resp = await fetch(pinterestFeed.proxyUrl(p.orig), { credentials: 'include' });
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
    setSeen((cur) => new Set([...cur, ...chosen.map((p) => p.orig)]));
    setPicked([]);
    notify(
      failed.length
        ? `Sent ${images.length} to ${target.label} — ${failed.length} could not be downloaded`
        : `Sent ${images.length} to ${target.label}`,
      failed.length ? 'info' : 'success',
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

      {/* MASONRY via CSS columns: the real Pinterest layout, and it needs no measurement pass, so
          it cannot jank on a fast scroll the way a JS-positioned grid does. */}
      {visible.length > 0 && (
        <div className="[column-count:2] sm:[column-count:3] lg:[column-count:4] xl:[column-count:5] [column-gap:0.75rem]">
          {visible.map((p) => {
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
                <img src={pinterestFeed.proxyUrl(p.thumb)} alt="" loading="lazy" className="w-full bg-zinc-900" />
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
