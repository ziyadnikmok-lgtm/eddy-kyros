import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Card, Btn, Input, Spinner, Textarea } from './UI';
import { useApp } from '../context/AppContext';
import { createEddyCollection } from '../lib/eddyCollectionStore';
import { autoBlurFace } from '../lib/autoBlurFace';
import BlurByHand from './BlurByHand';
import { eddyVision, gallery as galleryApi, video as videoApi, seedream as seedreamApi } from '../services/api';
import { cn } from '../lib/utils';
import { downloadBlob, stripMetadata, stripEnabled } from '../lib/stripMetadata';
import { isPosePromptBroken, hasPoseView, readPoseView, mergePoseView, poseSentence } from '../lib/poseText';

/**
 * Eddy's shared collection UI — folders on top, items below, drop/paste/upload to add.
 *
 * Library, Outfit, Pose and Character are all the same thing with different labels:
 *   Library / Outfit  — folders of images
 *   Pose              — prompts, each optionally with a reference image (withPrompt)
 *   Character         — a "folder" IS a character; its images are her reference photos
 * One component means a fix to folders or drag-and-drop lands in all four at once.
 */
/**
 * A five-point star — FILLED when favorited, OUTLINE otherwise. Both fill and stroke are
 * currentColor so the button around it decides the hue (rose when on, muted when off). Kept as a
 * local glyph rather than imported from EddyGeneratePage so this shared component has no page
 * dependency; the two stars are intentionally drawn identically so a favorite reads the same in the
 * Pose tab and in the Eddy pose picker.
 *
 * WHY rose and never amber: the filled star must not read as a price. Nothing here uses amber, so
 * there is no clash, but the rule is kept deliberately so a copied style never drifts into money hue.
 */
function StarIcon({ filled }) {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path d="M12 3.5l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 16.77l-5.2 2.73.99-5.79-4.21-4.1 5.82-.85z" />
    </svg>
  );
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}


/** Fetch a URL and hand back a data URL — the picker's items are links, not stored bytes. */
async function urlToDataUrl(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`Could not download that file (${resp.status})`);
  const blob = await resp.blob();
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/**
 * Everything in the MAIN gallery, which is where generations land — not Eddy's own collections.
 * Images and clips live in separate stores server side, so the source depends on the tab.
 */
async function listMainLibrary(kind) {
  if (kind === 'video') {
    const res = await videoApi.history();
    const rows = Array.isArray(res) ? res : (res?.history || res?.videos || res?.data || []);
    return rows
      .filter((v) => v.filename)
      .map((v) => ({ id: String(v.id ?? v.filename), url: videoApi.fileUrl(v.filename), prompt: v.prompt || '' }));
  }
  const res = await galleryApi.list();
  const rows = Array.isArray(res) ? res : (res?.images || res?.gallery || res?.data || []);
  return rows.map((g) => ({ id: String(g.id), url: galleryApi.imageUrl(g.id), prompt: g.prompt || '' }));
}


/**
 * Pull the clip length out of a prompt so it can be read at a glance.
 *
 * Prefers an explicit "Duration: exactly 6 seconds" line — every imported video prompt carries
 * one — and only falls back to a bare "N seconds" elsewhere in the text, which could be
 * describing a beat rather than the clip.
 */
function durationFromPrompt(prompt) {
  const text = String(prompt || '');
  const labelled = text.match(/duration[^\n]*?(\d+(?:\.\d+)?)\s*second/i);
  const any = labelled || text.match(/(\d+(?:\.\d+)?)\s*second/i);
  return any ? `${any[1]}s` : '';
}

// How many tiles are mounted at once. A page plus a "show more" keeps a large collection
// usable without ever mounting all of it.
const COLLECTION_PAGE = 120;

/**
 * The GRID version of a row's picture.
 *
 * A Library row points at the full-resolution file. A 2K image decodes to roughly 22 MB of bitmap,
 * and a folder of 500 held every one of them at full size — which is what "the app goes black" is:
 * the Electron renderer running out of memory (owner, 2026-08-09).
 *
 * /thumb is 400px wide at JPEG 70, about 26x less, and a card is a few hundred pixels wide. Only
 * gallery-backed rows have one; a locally-stored data URL is returned untouched, because there is
 * no server copy to ask for and those are already small.
 */
function gridSrc(src) {
  const m = /\/gallery\/([^/?#]+)\/image(\?.*)?$/.exec(String(src || ''));
  return m ? `${galleryApi.thumbUrl(m[1])}${m[2] || ''}` : src;
}

export default function EddyCollection({
  dbName,
  title,
  subtitle,
  folderLabel = 'Folder',
  withPrompt = false,
  // A second prompt on the card. Pose uses it for the motion that goes with the shot, so one
  // card holds the image, how she is positioned, and how she moves.
  withVideoPrompt = false,
  oldestFirst = false,
  autoBlur = false,
  refreshKey = 0,
  promptLabel = 'prompt',
  describeKind = null,
  // 'video' swaps the card media to a <video> and accepts video files. Everything else —
  // folders, prompts, select/move/delete, export — is identical, so a clip collection behaves
  // exactly like the pose and outfit ones people already know.
  mediaKind = 'image',
  // Shows the White plate controls. Pose only: it is the only collection whose images are a
  // SCENE that competes with the base photo. An outfit product shot has no room to remove and a
  // Library result is finished work.
  enablePlate = false,
}) {
  const { notify } = useApp();
  const store = useMemo(() => createEddyCollection(dbName), [dbName]);

  const [folders, setFolders] = useState([]);
  const [items, setItems] = useState([]);
  const [thumbs, setThumbs] = useState({});      // id -> dataUrl ('' for prompt-only items)
  // Outfits only: the back-view crop alongside the front one in `thumbs`, keyed the same way.
  // '' means no back image saved yet — the generate page falls back to the front crop for those.
  const [backThumbs, setBackThumbs] = useState({});

  /**
   * The image loader: what is on screen, then everything else.
   *
   * `wantRef` is the ids the grid is rendering right now, refreshed by an effect below. The pump
   * reads it before every batch, so scrolling changes what loads NEXT rather than waiting behind a
   * queue built when the page opened.
   *
   * `thumbsRef` mirrors the state because the pump runs across many awaits and cannot read a stale
   * closure to decide what is already loaded. `runRef` cancels a pump when the collection is
   * refreshed or switched, so two pumps cannot interleave into one map.
   */
  const thumbsRef = useRef({});
  const wantRef = useRef([]);
  const pumpRunRef = useRef(0);
  const [imagesPending, setImagesPending] = useState(0);
  useEffect(() => { thumbsRef.current = thumbs; }, [thumbs]);

  const pumpImages = useCallback(async (allItems, alsoBack) => {
    const run = pumpRunRef.current + 1;
    pumpRunRef.current = run;
    // Anything already in the cache stays: switching folders must not re-read what it just read.
    // But a picture whose ITEM is gone (deleted, moved to another collection) is dropped, or a long
    // session of deletions would hold every one of them in memory forever.
    const live = new Set(allItems.map((i) => i.id));
    const stale = Object.keys(thumbsRef.current).filter((id) => !live.has(id));
    if (stale.length) {
      const kept = { ...thumbsRef.current };
      for (const id of stale) delete kept[id];
      thumbsRef.current = kept;
      setThumbs(kept);
    }
    const remaining = new Set([...live].filter((id) => !(id in thumbsRef.current)));
    setImagesPending(remaining.size);
    const BATCH = 8;
    while (remaining.size) {
      if (pumpRunRef.current !== run) return;
      // On screen first. wantRef is re-read every batch, so a scroll re-prioritises immediately.
      const onScreen = wantRef.current.filter((id) => remaining.has(id));
      const batch = (onScreen.length ? onScreen : [...remaining]).slice(0, BATCH);
      // eslint-disable-next-line no-await-in-loop -- batching IS the point; all at once is the bug
      const pairs = await Promise.all(batch.map(async (id) => [id, await store.getImage(id)]));
      if (pumpRunRef.current !== run) return;
      for (const [id] of pairs) remaining.delete(id);
      const patch = Object.fromEntries(pairs);
      thumbsRef.current = { ...thumbsRef.current, ...patch };
      setThumbs((t) => ({ ...t, ...patch }));
      setImagesPending(remaining.size);
      // Hand the frame back so the tiles that just arrived actually paint.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 0); });
    }
    // Outfit back-crops are a second, smaller pass — nothing renders them until the front is there.
    if (alsoBack) {
      const backMap = {};
      for (const it of allItems) {
        if (pumpRunRef.current !== run) return;
        // eslint-disable-next-line no-await-in-loop
        backMap[it.id] = await store.getBackImage(it.id);
      }
      if (pumpRunRef.current !== run) return;
      setBackThumbs(backMap);
    }
  }, [store]);
  // The favorited item ids, read from the store's small `favorites` key — NOT from item.favorite.
  // A Set so the per-card star fill, the "★ Favorite (N)" count and the favOnly filter all derive
  // from one source that a big-index rewrite can never clobber. Loaded in refresh() below.
  const [favIds, setFavIds] = useState(() => new Set());
  const [activeFolder, setActiveFolder] = useState(null); // null = All

  /**
   * Folders are a tree now. Everything below derives from `parentId` alone — no stored path, no
   * child lists — so nothing can drift out of step with the folder records themselves.
   */
  const childrenOf = useCallback(
    (pid) => folders.filter((f) => (f.parentId || null) === (pid || null)),
    [folders],
  );

  /**
   * The chip row for the current level: children, or SIBLINGS when there are none.
   *
   * A leaf folder otherwise rendered a row with nothing but "All", which reads as "everything
   * disappeared" rather than "no subfolders here" (owner, 2026-08-08). Siblings also let you move
   * across a level without going back to All each time.
   */
  const levelFolders = useCallback((activeId) => {
    const kids = folders.filter((f) => (f.parentId || null) === (activeId || null));
    if (kids.length || !activeId) return kids;
    const me = folders.find((f) => f.id === activeId);
    return folders.filter((f) => (f.parentId || null) === (me?.parentId || null));
  }, [folders]);

  // A folder's own id plus every id beneath it. Used for counts and for "show everything in here",
  // which is what you want when a parent's items all live in its children.
  const subtreeIds = useCallback((id) => {
    if (!id) return null;
    const out = new Set([id]);
    for (let pass = 0; pass < 50; pass += 1) {
      const before = out.size;
      for (const f of folders) if (f.parentId && out.has(f.parentId)) out.add(f.id);
      if (out.size === before) break;
    }
    return out;
  }, [folders]);

  // Root → … → active, for the breadcrumb. Guarded against a cycle so a bad parentId can never
  // hang the render.
  const folderPath = useMemo(() => {
    const path = [];
    const byId = new Map(folders.map((f) => [f.id, f]));
    let cur = activeFolder ? byId.get(activeFolder) : null;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return path;
  }, [folders, activeFolder]);
  // The "★ Favorite" FILTER — a flag view that cuts ACROSS folders, not a folder itself. A favorite
  // keeps its category (Feet/Tease/…) AND shows here, so this is a separate toggle from activeFolder
  // rather than a folder value: when it is on, the visible list is every favorited item regardless of
  // folder; picking All or any folder turns it off and restores the plain folder view.
  const [favOnly, setFavOnly] = useState(false);
  // Pulling from Eddy's Library is how a tab gets filled without re-uploading a picture that is
  // already in the app. Loaded on open rather than on mount — the Library grows while you work.
  const [libOpen, setLibOpen] = useState(false);
  const [libItems, setLibItems] = useState([]);
  const [libPicked, setLibPicked] = useState([]);
  const [libBusy, setLibBusy] = useState(false);
  // Set when the picker was opened from a card's Change image button — that card's picture gets
  // replaced instead of new items being added.
  const [libSwapId, setLibSwapId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [blurring, setBlurring] = useState(false);
  const [handBlur, setHandBlur] = useState(null);   // the item being blurred by hand
  const [dropOn, setDropOn] = useState(null);      // card currently under a dragged file
  const [newFolder, setNewFolder] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [describing, setDescribing] = useState({});
  const [describeProgress, setDescribeProgress] = useState(null);
  const [describingAll, setDescribingAll] = useState(false);
  const [labelingViews, setLabelingViews] = useState(false);
  const [labelingOne, setLabelingOne] = useState({});
  // Checked once per loop iteration rather than aborting the in-flight fetch — Stop means "don't
  // start the next one", not "cut off the request already in the air".
  const describeAllStopRef = useRef(false);
  const [selected, setSelected] = useState([]);
  // Layout is a per-person preference, not a per-collection one, so it is shared by every tab
  // and kept across launches.
  const [cols, setCols] = useState(() => {
    const v = parseInt(localStorage.getItem('eddy.grid.cols') || '', 10);
    return Number.isFinite(v) && v >= 1 && v <= 8 ? v : 4;
  });
  /**
   * SHOW THE PROMPT under each card.
   *
   * Separate from `withPrompt`, which is a different thing: that one turns a collection INTO a
   * prompt list and changes the card layout (object-contain, an add-prompt row, a duration badge).
   * Base Library is a picture grid and should stay one -- what was missing is only being able to
   * READ the prompt a base photo was generated with (owner, 2026-08-10).
   *
   * Remembered per collection, so turning it on in Base Library does not switch it on in Pose.
   */
  const [showPrompts, setShowPrompts] = useState(() => {
    // ON by default, like the Gallery page. Off-by-default meant the prompt was there and looked
    // missing -- you had to know a toggle existed to find out (owner, 2026-08-11). The stored
    // value still wins once it has been set either way.
    /**
     * A NEW KEY, deliberately.
     *
     * The first version defaulted to OFF, and its write-back effect stamped '0' into storage on
     * the very first mount -- before anyone had touched the toggle. Flipping the default to ON
     * therefore changed nothing: the stale '0' won, and the owner still saw no prompts after the
     * fix (2026-08-11). Versioning the key retires that value instead of trying to guess whether
     * a stored '0' was a real choice or an artefact.
     */
    try {
      const v = localStorage.getItem(`eddy.showPrompts.v2.${dbName}`);
      return v === null ? true : v === '1';
    } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(`eddy.showPrompts.v2.${dbName}`, showPrompts ? '1' : '0'); } catch { /* private mode */ }
  }, [showPrompts, dbName]);

  /**
   * Which prompts are expanded, and the text being searched for.
   *
   * A prompt here runs to a couple of thousand characters, so three clamped lines are a teaser, not
   * a read. And a 627-image library is unsearchable by eye -- the prompt is the only thing that
   * distinguishes two pictures of the same woman in the same room.
   */
  const [openPrompts, setOpenPrompts] = useState(() => new Set());
  const [promptQuery, setPromptQuery] = useState('');

  const [imgH, setImgH] = useState(() => {
    const v = parseInt(localStorage.getItem('eddy.grid.imgH') || '', 10);
    return Number.isFinite(v) && v >= 120 && v <= 720 ? v : 320;
  });
  useEffect(() => { try { localStorage.setItem('eddy.grid.cols', String(cols)); } catch { /* private mode */ } }, [cols]);
  useEffect(() => { try { localStorage.setItem('eddy.grid.imgH', String(imgH)); } catch { /* private mode */ } }, [imgH]);

  const refresh = useCallback(async () => {
    const [f, i, favs] = await Promise.all([store.listFolders(), store.listItems(), store.listFavorites()]);
    setFolders(f);
    setItems(i);
    // Favorites come from their own tiny key, re-read on every refresh so the stars and the count
    // reflect the store right after a toggle and after a reload.
    setFavIds(new Set(favs));
    /**
     * THE PICTURES ARRIVE AFTER THE GRID, ON-SCREEN ONES FIRST.
     *
     * This used to `await Promise.all(...)` every image in the collection before the page rendered
     * anything -- six hundred full-size data URLs read out of IndexedDB, held in one state object,
     * while the grid shows a hundred and twenty. That is the wait, and the black tiles are the
     * browser being handed more base64 than it can decode at once (owner, 2026-08-11).
     *
     * The grid now paints immediately and `pumpImages` fills it in small batches, always taking
     * what is ON SCREEN next (see wantRef). Scrolling to page two pulls page two's pictures ahead
     * of the rest. Nothing else had to change: every sweep and bulk action still reads `thumbs`,
     * it just fills in over a second or two instead of blocking the first paint.
     */
    setLoading(false);
    pumpImages(i, describeKind === 'outfit');
  }, [store, describeKind, pumpImages]);

  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  // Ticks belong to the folder they were made in. Keeping them across a switch left the bulk
  // bar acting on items no longer on screen — Delete could remove things you could not see.
  useEffect(() => { setSelected([]); }, [activeFolder, favOnly]);

  /**
   * Tiles mounted at once. The grid rendered every visible item, which is fine at 50 and heavy at
   * 850 — and a single run can now add hundreds, since the results panel no longer caps anything
   * (owner, 2026-08-08). Nothing is hidden: "Show N more" reveals the rest and the header states
   * the true total either way.
   */
  const [shown, setShown] = useState(COLLECTION_PAGE);
  // Back to the first page whenever the view changes, so switching folders does not land you
  // deep in a previous folder's scroll.
  useEffect(() => { setShown(COLLECTION_PAGE); }, [activeFolder, favOnly, oldestFirst]);

  const visible = useMemo(() => {
    // Favorite wins over the folder: it is a cross-folder view of every starred item. Otherwise the
    // original folder behaviour is untouched (null = All).
    const base = favOnly
      ? items.filter((i) => favIds.has(i.id))
      : (activeFolder
        // Descendants included: a parent whose items all sit in its children would otherwise look
        // empty, which is the first thing you check after making subfolders.
        ? (() => { const ids = subtreeIds(activeFolder); return items.filter((i) => ids.has(i.folderId)); })()
        : items);
    /**
     * Text search over the PROMPT, applied here rather than at render.
     *
     * `visible` is what Select all, the counts, Download and Save all act on, so filtering here
     * means "select all" means "all of these" -- filtering only the rendered grid would have those
     * buttons quietly act on hidden items too.
     */
    const q = promptQuery.trim().toLowerCase();
    const searched = q
      ? base.filter((i) => `${i.prompt || ''} ${i.name || ''}`.toLowerCase().includes(q))
      : base;
    return oldestFirst ? [...searched].sort((a, b) => a.createdAt - b.createdAt) : searched;
  }, [items, activeFolder, favOnly, favIds, oldestFirst, subtreeIds, promptQuery]);

  /**
   * What the grid is rendering RIGHT NOW, handed to the image pump as its priority list.
   *
   * A ref, not state: this changes on every scroll-to-load and folder switch, and the pump reads it
   * between batches. Making it state would rebuild the pump instead of steering it.
   *
   * BELOW `visible`, not above it. A dependency array is evaluated during RENDER, so naming a const
   * declared further down the file is a temporal-dead-zone ReferenceError that blanks the whole
   * page -- the fourth time that shape has come up in this repo. check-tdz-deps.js catches it.
   */
  useEffect(() => { wantRef.current = visible.slice(0, shown).map((i) => i.id); }, [visible, shown]);

  // field: which index column the result is written to. Outfits write their normal front
  // description to 'prompt' (the default) and their back-view crop's description to
  // 'backPrompt' — same brief, same kind ('outfit' reads only the garment either way), just a
  // second column so generation can pick whichever matches the selected pose's view.
  const describe = useCallback(async (id, dataUrl, { retries = 3, field = 'prompt', kind } = {}) => {
    const mt = (dataUrl.match(/^data:([^;]+);base64,/) || [])[1] || 'image/jpeg';
    setDescribing((d) => ({ ...d, [id]: true }));
    try {
      // Vertex rate-limits on a long run — a 50-image batch will hit 429 partway through.
      // Backing off and retrying is the difference between finishing and stopping half done.
      let r;
      for (let attempt = 0; ; attempt += 1) {
        try {
          r = await eddyVision.describe({ image: dataUrl, mimeType: mt, kind: kind || describeKind });
          break;
        } catch (err) {
          const rateLimited = /429|quota|exhaust|rate/i.test(err?.message || '');
          if (!rateLimited || attempt >= retries) throw err;
          await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
        }
      }
      const text = r?.text ?? r?.data?.text ?? '';
      // The server refuses an over-long structured reply outright instead of saving a fragment of
      // it (see RESPONSE_LIMITS in server/routes/eddyVision.js). Pass its explanation on: without
      // this the user sees only "nothing happened" on a card that still has no prompt.
      const reason = r?.reason ?? r?.data?.reason ?? '';
      if (!text && reason) notify(reason, 'error');
      // A refusal must not overwrite the prompt with an empty string -- that would quietly
      // weaken every generation that used this item.
      if (text) await store.updateItem(id, { [field]: text });
      await refresh();
      return Boolean(text);
    } catch (err) {
      notify(err.message || 'Could not read that image', 'error');
      return false;
    } finally {
      setDescribing((d) => ({ ...d, [id]: false }));
    }
  }, [store, describeKind, refresh, notify]);

  /**
   * Describe an outfit twice from ONE photo: the garment as shown (-> prompt) and the same garment
   * seen from behind (-> backPrompt, via the `outfitBack` brief).
   *
   * Generation picks between them by the selected pose's view label, so an outfit with no back
   * description silently falls back to its front text on a back-facing pose — the mismatch this
   * whole feature exists to remove. Doing it at upload time is what makes that never happen: the
   * alternative was a second photo per outfit, and most outfits only ever have the one product shot.
   *
   * The front description is awaited FIRST and its result is what the caller gets. The back pass is
   * a bonus: if it fails (rate limit, refusal) the outfit is still fully usable, so its failure is
   * swallowed rather than reported as the upload failing.
   */
  const describeOutfitBothViews = useCallback(async (id, dataUrl) => {
    const ok = await describe(id, dataUrl);
    try { await describe(id, dataUrl, { field: 'backPrompt', kind: 'outfitBack' }); } catch { /* front is enough */ }
    return ok;
  }, [describe]);

  // The single entry point every add/import/describe path uses, so "an outfit gets both views"
  // is decided in ONE place. Adding a new upload route later cannot silently skip the back pass.
  // Outfits that have a front description but no back-view one. Only meaningful in the Outfit tab.
  //
  // WHY A SWEEP AND NOT JUST NEW UPLOADS: describeAuto writes both views from now on, but a
  // collection built before that exists entirely without back text — 113 outfits here — and every
  // back-facing pose using one of them silently falls back to the front description. That is the
  // exact mismatch the view labels were added to remove, so the existing library has to be
  // backfillable or the feature only works for outfits added later (owner, 2026-08-06).
  const missingBackTargets = useMemo(() => {
    if (describeKind !== 'outfit') return [];
    return visible.filter((i) => (thumbs[i.id] || i.url) && i.prompt?.trim() && !i.backPrompt?.trim());
  }, [describeKind, visible, thumbs]);

  /**
   * The item shown full-size, or '' for none.
   *
   * Clicking a tile did NOTHING here — the Generate page has had a large view for ages, so a
   * Library of 505 images was the one place you could not actually look at one, and there was
   * nothing to dismiss either (owner, 2026-08-06: "i click image doesnt show and i can click in
   * nothing for it go out"). Held as an ID rather than an index so arrowing through the grid
   * survives a delete or a folder-filter change mid-view.
   */
  const [lightboxId, setLightboxId] = useState('');

  /**
   * Freeze the page behind the large view.
   *
   * Without it the grid keeps scrolling under the overlay, so a wheel or trackpad gesture moves
   * the page instead of doing nothing — which, together with the missing portal, is what made the
   * large view feel like something you had to scroll to (owner, 2026-08-09).
   */
  useEffect(() => {
    if (!lightboxId) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [lightboxId]);

  const [describingBacks, setDescribingBacks] = useState(false);

  /**
   * Backfill backPrompt across the visible outfits, one at a time.
   *
   * Sequential on purpose — the same reason every other sweep in this file is: Vertex rate-limits a
   * parallel fan-out and half the descriptions come back empty. describe() already retries a 429
   * with backoff, so a long run finishes rather than stopping partway.
   *
   * Re-reads the store per item instead of trusting the memo: the list it started from is a stale
   * closure the moment the first write lands.
   */
  const describeBackViews = useCallback(async () => {
    const targets = missingBackTargets;
    if (!targets.length) return;
    setDescribingBacks(true);
    let ok = 0;
    try {
      for (const it of targets) {
        const src = thumbs[it.id];
        if (!src) continue;
        // eslint-disable-next-line no-await-in-loop -- sequential on purpose, see above
        if (await describe(it.id, src, { field: 'backPrompt', kind: 'outfitBack' })) ok += 1;
      }
    } finally {
      setDescribingBacks(false);
      await refresh();
    }
    notify(`Described ${ok} of ${targets.length} back views`, ok ? 'success' : 'error');
  }, [missingBackTargets, thumbs, describe, refresh, notify]);

  // Esc closes, arrows step. Bound only while the lightbox is open so the grid's own keyboard
  // behaviour is untouched the rest of the time.
  const stepLightbox = useCallback((delta) => {
    setLightboxId((cur) => {
      const i = visible.findIndex((x) => x.id === cur);
      if (i < 0) return cur;
      const next = visible[i + delta];
      return next ? next.id : cur;      // stop at the ends rather than wrapping
    });
  }, [visible]);

  useEffect(() => {
    if (!lightboxId) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setLightboxId('');
      else if (e.key === 'ArrowRight') stepLightbox(1);
      else if (e.key === 'ArrowLeft') stepLightbox(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxId, stepLightbox]);

  // An item can vanish under the lightbox — deleted, or filtered out by a folder change. Close
  // rather than leaving an overlay pinned over nothing.
  /**
   * Swipe between images, same rules as the Generate page's large view so the two behave alike.
   *
   * Pointer events rather than touch, so a trackpad drag counts. A 60px threshold on X with the
   * vertical delta required to be smaller keeps a scroll from registering as a swipe.
   */
  const swipe = useRef(null);
  const onPointerDown = (e) => { swipe.current = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = (e) => {
    const st = swipe.current;
    swipe.current = null;
    if (!st) return;
    const dx = e.clientX - st.x;
    const dy = e.clientY - st.y;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
    stepLightbox(dx < 0 ? 1 : -1);        // drag left = forward, as every gallery behaves
  };

  useEffect(() => {
    if (lightboxId && !visible.some((x) => x.id === lightboxId)) setLightboxId('');
  }, [lightboxId, visible]);

  const describeAuto = useCallback(
    (id, dataUrl) => (describeKind === 'outfit' ? describeOutfitBothViews(id, dataUrl) : describe(id, dataUrl)),
    [describeKind, describe, describeOutfitBothViews],
  );

  // Items with a picture but no pose prompt yet — what a Pose folder accumulates by the dozen
  // when reference images get added ahead of writing what they show. Scoped to `visible`, not
  // `selected` like Blur all faces / Export all: the point of this button is to sweep every
  // missing prompt in the current view without first having to tick 97 boxes.
  const missingDescribeTargets = useMemo(() => {
    if (!describeKind) return [];
    // Same "has a picture" check the per-card button uses (thumbs OR a server url) — an item
    // with neither is prompt-only and was never a candidate for AI description.
    return visible.filter((i) => (thumbs[i.id] || i.url) && !i.prompt?.trim());
  }, [describeKind, visible, thumbs]);

  // Cards that DO have a prompt but whose prompt yields no pose. Deliberately separate from
  // missingDescribeTargets and given its own button rather than folded into "Describe N missing":
  // these carry text the user may have written or edited, and a sweep that rewrites saved text
  // has to be asked for by name, not ridden in on a button about empty cards.
  const brokenPromptTargets = useMemo(() => {
    if (describeKind !== 'pose') return [];
    return visible.filter((i) => (thumbs[i.id] || i.url) && isPosePromptBroken(i.prompt));
  }, [describeKind, visible, thumbs]);

  // Cards with a usable pose but no front/back/closeup classification yet — every pose saved
  // before this feature existed (2026-08-06). Deliberately separate from brokenPromptTargets:
  // these have a GOOD description already, so labelling them must never touch it (see labelViews
  // / mergePoseView) the way redescribeBroken's full rewrite is allowed to for a broken card.
  const unlabeledViewTargets = useMemo(() => {
    if (describeKind !== 'pose') return [];
    return visible.filter((i) => (thumbs[i.id] || i.url) && !isPosePromptBroken(i.prompt) && i.prompt?.trim() && !hasPoseView(i.prompt));
  }, [describeKind, visible, thumbs]);

  // Duplicate STARS: several cards sharing one title all ended up favorited, because a collection
  // with repeated titles gets a star on every copy (12 favourites became 23 on the last import).
  // This only UN-STARS the extras. No card is ever deleted: same-title cards can still hold
  // DIFFERENT pose images, and removing one would lose real work. Scoped to the whole collection,
  // not `visible` - a starred twin in another folder is the one you cannot see to unstar by hand.
  const dupeFavGroups = useMemo(() => {
    const by = new Map();
    for (const i of items) {
      if (!favIds.has(i.id)) continue;
      const key = (i.name || '').trim().toLowerCase();
      if (!key) continue;
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(i);
    }
    return [...by.values()].filter((g) => g.length > 1);
  }, [items, favIds]);
  const dupeFavCount = useMemo(() => dupeFavGroups.reduce((n, g) => n + g.length - 1, 0), [dupeFavGroups]);

  const tidyFavorites = useCallback(async () => {
    if (!dupeFavCount) return;
    if (!window.confirm(`${dupeFavCount} extra star(s) sit on cards sharing a title with another favourite. Un-star the extras, keeping ONE per title? No card is deleted.`)) return;
    let cleared = 0;
    for (const group of dupeFavGroups) {
      for (const g of group.slice(1)) {          // keep the first, un-star the rest
        await store.toggleFavorite(g.id);
        cleared += 1;
      }
    }
    notify(`Un-starred ${cleared} duplicate favourite${cleared === 1 ? '' : 's'}`, 'success');
    // `refresh`, not `load` — there is no `load` in this scope, so this threw every time and the
    // grid never re-read: the stars just cleared stayed on screen until you navigated away.
    await refresh();
  }, [dupeFavGroups, dupeFavCount, store, notify, refresh]);

  const redescribeBroken = useCallback(async () => {
    if (!brokenPromptTargets.length) return;
    if (!window.confirm(`Re-describe ${brokenPromptTargets.length} pose card${brokenPromptTargets.length === 1 ? '' : 's'} whose prompt cannot be read? The AI rewrites the prompt text on ${brokenPromptTargets.length === 1 ? 'that card' : 'those cards'}. Images and titles are untouched.`)) return;
    let ok = 0;
    for (const it of brokenPromptTargets) {
      // Sequential for the same reason describeAllMissing is: parallel vision calls on a batch
      // this size trip the rate limit and half of them come back empty.
      if (await describe(it.id, thumbs[it.id])) ok += 1;
    }
    notify(`Re-described ${ok} of ${brokenPromptTargets.length}`, ok ? 'success' : 'error');
  }, [brokenPromptTargets, describe, thumbs, notify]);

  /**
   * Classifies front/back/closeup on ONE card WITHOUT touching its existing description — calls
   * the dedicated /classify-pose-view endpoint (NOT the shared `describe()` helper, which
   * regenerates and overwrites the whole pose_action block) and merges only the returned view
   * into the saved JSON via mergePoseView. The existing description is sent along as context (its
   * words — "facing away", "over her shoulder" — often settle what the bare image leaves
   * ambiguous), read via poseSentence so the classifier sees the plain sentence, not raw JSON.
   * Shared by the bulk sweep below and the per-card "Retry label" button so the two can never
   * drift.
   */
  /**
   * Set a pose's view by hand -- no model call, no wait, no doubt about what it decided.
   *
   * Writes ONLY pose_action.view via mergePoseView, so the description the card already carries is
   * left byte-identical. A card whose prompt is not the JSON shape cannot hold a view at all, and
   * says so rather than appearing to work.
   */
  const setPoseView = useCallback(async (it, view) => {
    const next = mergePoseView(it.prompt, view);
    if (next === it.prompt) {
      notify('This card has no readable pose text yet — use "Re-describe with AI" first', 'error');
      return;
    }
    await store.updateItem(it.id, { prompt: next });
    await refresh();
  }, [store, refresh, notify]);

  /**
   * An OUTFIT's angle, written to the row.
   *
   * Poses keep theirs inside the prompt JSON (mergePoseView). Outfits cannot: theirs is routinely
   * "Empty prompt" -- the garment is the picture, and there is no sentence to merge into. So this
   * writes the row's own poseView field, which outfitViewOf reads ahead of the folder name.
   *
   * Needed because folder placement was the ONLY signal, and an outfit in an unnamed folder read
   * as "front" in silence -- two close-up crops ticked that way put a crop on every full-body
   * photo (owner, 2026-08-10).
   */
  const setOutfitView = useCallback(async (it, view) => {
    // Clicking the active one clears it, so a wrong label can be undone back to the folder's
    // answer rather than only swapped for another wrong one.
    await store.updateItem(it.id, { poseView: it.poseView === view ? '' : view });
    await refresh();
  }, [store, refresh]);

  const labelOneView = useCallback(async (it, dataUrl) => {
    if (!dataUrl) return false;
    const mt = (dataUrl.match(/^data:([^;]+);base64,/) || [])[1] || 'image/jpeg';
    let r;
    for (let attempt = 0; ; attempt += 1) {
      try {
        r = await eddyVision.classifyPoseView({ image: dataUrl, mimeType: mt, description: poseSentence(it.prompt) });
        break;
      } catch (err) {
        const rateLimited = /429|quota|exhaust|rate/i.test(err?.message || '');
        if (!rateLimited || attempt >= 3) throw err;
        await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      }
    }
    const view = r?.view ?? r?.data?.view ?? '';
    if (!view) return false;
    await store.updateItem(it.id, { prompt: mergePoseView(it.prompt, view) });
    return true;
  }, [store]);

  const retryLabelOne = useCallback(async (it) => {
    setLabelingOne((s) => ({ ...s, [it.id]: true }));
    try {
      const ok = await labelOneView(it, thumbs[it.id]);
      await refresh();
      notify(ok ? 'Labelled' : 'Could not classify that pose', ok ? 'success' : 'error');
    } catch (err) {
      notify(err.message || 'Could not classify that pose', 'error');
    } finally {
      setLabelingOne((s) => ({ ...s, [it.id]: false }));
    }
  }, [labelOneView, thumbs, refresh, notify]);

  // Loops passes until either every card is labelled or a whole pass makes zero progress — a
  // card can fail for a reason a retry fixes (a dropped connection, a malformed reply) or for one
  // it can't (no image ever attached), and the only way to tell the two apart is to keep going
  // until progress actually stops. Re-reads the store fresh each pass rather than trusting the
  // memoized unlabeledViewTargets, which is a stale closure once a pass starts writing labels.
  // Sequential within a pass for the same rate-limit reason as redescribeBroken/
  // describeAllMissing: a batch this size in parallel trips Vertex's 429 and half come back empty.
  const labelViews = useCallback(async () => {
    const total = unlabeledViewTargets.length;
    if (!total) return;
    setLabelingViews(true);
    let done = 0;
    for (let pass = 1; ; pass += 1) {
      const remaining = (await store.listItems()).filter(
        (i) => !isPosePromptBroken(i.prompt) && i.prompt?.trim() && !hasPoseView(i.prompt)
      );
      if (!remaining.length) break;
      let progressed = 0;
      for (const it of remaining) {
        try {
          const dataUrl = await store.getImage(it.id);
          if (await labelOneView(it, dataUrl)) { progressed += 1; done += 1; }
        } catch { /* one failed card should not stop the pass — the stall check below catches it */ }
      }
      if (!progressed) {
        notify(`Labelled ${done} of ${total} — ${remaining.length} stuck (no image, or the AI keeps refusing them)`, done ? 'success' : 'error');
        break;
      }
      if (done >= total) { notify(`Labelled all ${total}`, 'success'); break; }
    }
    setLabelingViews(false);
    await refresh();
  }, [unlabeledViewTargets, store, labelOneView, refresh, notify]);

  /**
   * WHITE PLATE — regenerate a pose reference with its room removed, and paste it back in place.
   *
   * WHY: the pose reference carries a whole scene, and that scene leaks. The prompt already argues
   * against it ("THE SETTING COMES FROM IMAGE 1", "the room in image N is IRRELEVANT") and it still
   * leaks, because the picture is louder than the sentence. A plate removes the argument: there is
   * no room in the reference, so there is no room to copy. It kills the lighting leak too, which no
   * prompt line addresses at all.
   *
   * WHY SEEDREAM AND NOT NANO BANANA 2: this is the same instruction shape as the outfit swap that
   * has always run on Seedream — "change exactly one thing, keep everything else identical" — and
   * it is $0.045 against nano2's $0.07. Cheaper AND the model with the track record on this task.
   *
   * WHAT IT KEEPS: the surface she is touching. Cutting to pure white everywhere leaves a woman
   * sitting on nothing, and the model then invents a support nobody chose. The prompt asks for the
   * room to go and the contact surface plus its shadow to stay.
   */
  const PLATE_PROMPT = [
    'Keep the woman in this image EXACTLY as she is: identical face, identical body, identical pose,',
    'identical limb positions, identical clothing, identical camera angle, identical framing and',
    'identical crop. Do not move her, re-pose her, re-dress her, resize her or re-frame the shot.',
    '',
    'Change ONLY the background. Replace the entire room, location, scenery, furniture, walls, floor,',
    'windows, decor and props with a plain PURE WHITE background — a clean empty studio backdrop with',
    'no texture, no gradient, no horizon line and no visible corners.',
    '',
    'ONE EXCEPTION: whatever she is physically resting on, sitting on, lying on or leaning against',
    'must STAY, because her pose depends on it. Keep that surface, but render it as a plain neutral',
    'light-grey form with no pattern, no material, no colour and no branding. Keep the soft contact',
    'shadow where her body meets it, so she is grounded and not floating.',
    '',
    'Real photograph, raw camera quality, natural skin with pores and texture. No smoothing, no',
    'beauty filter, no AI gloss, no added text, no watermark.',
  ].join(' ').replace(/\s+/g, ' ').trim();

  // Seedream 5.0 Pro edit, 1K, one reference image. Named here rather than imported so the number
  // shown on the button and the number actually billed cannot drift apart.
  const PLATE_COST_PER_IMAGE = 0.045;

  const [plating, setPlating] = useState(false);
  const [plateProgress, setPlateProgress] = useState(null);
  const plateStopRef = useRef(false);

  // Selected cards that have a picture to plate. Scoped to `selected`, not `visible`: this spends
  // money and overwrites curated reference images, so it never runs on anything you did not tick.
  const plateTargets = useMemo(() => {
    if (!enablePlate) return [];
    return items.filter((i) => selected.includes(i.id) && thumbs[i.id]);
  }, [enablePlate, items, selected, thumbs]);

  /**
   * Mirror poses are excluded, and it is not a detail.
   *
   * In a mirror selfie the mirror is not decor — it IS the shot. It decides where the camera is,
   * where she looks, and what the framing means. Plate it away and the pose becomes unreadable.
   * 22 of the owner's 58 poses are mirror selfies, so a blind sweep would destroy a third of the
   * collection for $1 and look like it worked.
   */
  const plateMirrorSkips = useMemo(
    () => plateTargets.filter((i) => /\bmirror\b/i.test(String(i.prompt || '') + ' ' + String(i.name || ''))),
    [plateTargets],
  );
  const plateRunnable = useMemo(
    () => plateTargets.filter((i) => !plateMirrorSkips.includes(i)),
    [plateTargets, plateMirrorSkips],
  );
  const platedCount = useMemo(
    () => items.filter((i) => i.plated).length,
    [items],
  );

  const stopPlating = useCallback(() => { plateStopRef.current = true; }, []);

  const plateSelected = useCallback(async () => {
    const targets = plateRunnable;
    if (!targets.length) return;

    const cost = (targets.length * PLATE_COST_PER_IMAGE).toFixed(2);
    const lines = [
      `White-plate ${targets.length} pose${targets.length === 1 ? '' : 's'} on Seedream 5.0 Pro?`,
      `This costs about $${cost} and REPLACES each picture in place.`,
      plateMirrorSkips.length
        ? `${plateMirrorSkips.length} mirror pose${plateMirrorSkips.length === 1 ? ' is' : 's are'} skipped — the mirror is the shot, not the background.`
        : '',
      'Every original is kept. "Revert plates" puts them back.',
    ].filter(Boolean);
    if (!window.confirm(lines.join('\n\n'))) return;

    plateStopRef.current = false;
    setPlating(true);
    let done = 0;
    let failed = 0;
    let stopped = false;
    try {
      for (let n = 0; n < targets.length; n += 1) {
        if (plateStopRef.current) { stopped = true; break; }
        const it = targets[n];
        setPlateProgress({ done: n, total: targets.length });
        const m = /^data:([^;]+);base64,(.+)$/.exec(thumbs[it.id] || '');
        if (!m) { failed += 1; continue; }
        try {
          // Sequential for the same reason describeAllMissing is: a parallel sweep over a batch this
          // size trips the rate limiter and half come back empty.
          // eslint-disable-next-line no-await-in-loop -- sequential on purpose, see above
          const data = await seedreamApi.edit({
            images: [{ base64: m[2], mimeType: m[1] }],
            prompt: PLATE_PROMPT,
            aspectRatio: 'auto',
            resolution: '1K',
            tags: ['eddy', 'pose', 'plate'],
          });
          const first = (data.images || [])[0];
          if (!first?.base64Data) { failed += 1; continue; }
          const plated = `data:${first.mimeType || 'image/png'};base64,${first.base64Data}`;
          // eslint-disable-next-line no-await-in-loop -- part of the same sequential pass
          await store.setImageKeepingPreplate(it.id, plated);
          // eslint-disable-next-line no-await-in-loop -- part of the same sequential pass
          await store.updateItem(it.id, { plated: true });
          done += 1;
        } catch {
          // Counted, not thrown: one refusal must not abandon the rest of the batch, and the
          // untouched original is still on the card.
          failed += 1;
        }
      }
    } finally {
      setPlateProgress(null);
      setPlating(false);
      await refresh();
    }

    const left = targets.length - done - failed;
    if (stopped) {
      notify(`Stopped — plated ${done}, ${failed} failed, ${left} not started. Click again to pick up the rest.`, 'success');
    } else if (failed) {
      notify(`Plated ${done} of ${targets.length} — ${failed} failed. Their originals are untouched; click again to retry.`, 'error');
    } else {
      notify(`Plated ${done} pose${done === 1 ? '' : 's'} — about $${(done * PLATE_COST_PER_IMAGE).toFixed(2)}. "Revert plates" undoes it.`, 'success');
    }
  }, [plateRunnable, plateMirrorSkips, thumbs, store, refresh, notify, PLATE_PROMPT]);

  const revertPlates = useCallback(async () => {
    // Scoped to selection when there is one, so a single bad plate can be put back without
    // undoing a whole good batch.
    const scope = selected.length ? items.filter((i) => selected.includes(i.id)) : items;
    const targets = scope.filter((i) => i.plated);
    if (!targets.length) { notify('Nothing plated to revert', 'error'); return; }
    if (!window.confirm(`Put back the original picture on ${targets.length} pose${targets.length === 1 ? '' : 's'}? The plated version is discarded.`)) return;
    let back = 0;
    for (const it of targets) {
      // eslint-disable-next-line no-await-in-loop -- IndexedDB writes, kept in order
      const ok = await store.restorePreplate(it.id);
      // The flag is cleared either way: if no original was stashed there is nothing to revert TO,
      // and leaving the card labelled "plated" would offer an undo that can never work.
      // eslint-disable-next-line no-await-in-loop -- same pass
      await store.updateItem(it.id, { plated: false });
      if (ok) back += 1;
    }
    await refresh();
    notify(back === targets.length
      ? `Reverted ${back} pose${back === 1 ? '' : 's'}`
      : `Reverted ${back} of ${targets.length} — ${targets.length - back} had no saved original`,
      back ? 'success' : 'error');
  }, [selected, items, store, refresh, notify]);

  const stopDescribeAll = useCallback(() => {
    describeAllStopRef.current = true;
  }, []);

  const describeAllMissing = useCallback(async () => {
    const targets = missingDescribeTargets;
    if (!targets.length) return;
    describeAllStopRef.current = false;
    setDescribingAll(true);
    let succeeded = 0;
    let failed = 0;
    let stopped = false;
    try {
      for (let n = 0; n < targets.length; n += 1) {
        if (describeAllStopRef.current) { stopped = true; break; }
        const it = targets[n];
        setDescribeProgress({ done: n, total: targets.length });
        // Sequential, not Promise.all: a 4-worker parallel pass over this exact kind of batch
        // finished 14 of 48 before Vertex's quota cut it off, while one paced stream ran clean.
        //
        // Reads thumbs[id] — the same source the per-card "Describe with AI" button reads, i.e.
        // the ACTIVE (possibly blurred) copy. The unblurred original lives under `img:<id>:alt`
        // when autoBlur made one, but eddyCollectionStore exposes no read of its contents — only
        // hasAlt() (a boolean) and swapAlt() (which mutates the collection by swapping them).
        // Matching the existing single-item button beats inventing a new store method for one
        // caller.
        // eslint-disable-next-line no-await-in-loop -- sequential on purpose, see above
        const ok = await describeAuto(it.id, thumbs[it.id]);
        if (ok) succeeded += 1; else failed += 1;
      }
    } finally {
      setDescribeProgress(null);
      setDescribingAll(false);
    }
    const left = targets.length - succeeded - failed;
    if (stopped) {
      notify(`Stopped — described ${succeeded}, ${failed} failed, ${left} not started. Click Describe again to pick up the rest.`, 'success');
    } else if (failed) {
      // Rate-limit is the near-certain cause on a batch this size — retries inside describe()
      // already absorbed the transient 429s, so what's left failing rode out the backoff too.
      notify(`Described ${succeeded} of ${targets.length} — ${failed} failed, most likely Vertex quota. Click "Describe missing" again to pick up the rest.`, 'error');
    } else {
      notify(`Described ${succeeded} missing prompt${succeeded === 1 ? '' : 's'}`, 'success');
    }
  }, [missingDescribeTargets, describe, thumbs, notify]);

  const addFiles = useCallback(async (files) => {
    const isVideo = mediaKind === 'video';
    const accepts = isVideo ? /^video\/(mp4|webm|quicktime|x-matroska)$/i : /^image\/(png|jpe?g|webp)$/i;
    const valid = Array.from(files || []).filter((f) => accepts.test(f.type));
    if (!valid.length) { notify(isVideo ? 'Use MP4, WebM or MOV' : 'Use PNG, JPG or WebP', 'error'); return; }
    if (isVideo) {
      const heavy = valid.filter((f) => f.size > 40 * 1024 * 1024);
      if (heavy.length) {
        notify(`${heavy.length} clip(s) over 40 MB — browser storage may reject them. Trim or compress if they fail.`, 'error');
      }
    }
    // Settle per file. Promise.all let ONE unreadable file reject the whole call from handlers
    // that do not catch, so every image was dropped and no message appeared at all.
    const read = await Promise.allSettled(valid.map(async (f) => ({ dataUrl: await fileToDataUrl(f), name: f.name })));
    let payload = read.filter((r) => r.status === 'fulfilled').map((r) => r.value);

    // Pose references get their face removed before they are stored. Seedream copies any face
    // it is shown, and the woman in a pose photo is not the subject.
    if (autoBlur && !isVideo && payload.length) {
      let missed = 0;
      payload = await Promise.all(payload.map(async (item) => {
        const out = await autoBlurFace(item.dataUrl);
        if (!out.blurred) missed += 1;
        // original travels alongside so the blur can be undone or shared unblurred
        return { ...item, dataUrl: out.dataUrl, original: out.blurred ? item.dataUrl : '' };
      }));
      if (missed) notify(`${missed} image(s): no face found to blur — check them yourself`, 'error');
    }
    const unreadable = read.length - payload.length;
    if (!payload.length) { notify('None of those files could be read', 'error'); return; }

    let stored = [];
    try {
      stored = await store.addItems(payload, activeFolder);
    } catch (err) {
      notify(err.message || 'Could not save those images', 'error');
      await refresh();
      return;
    }

    const lost = unreadable + (stored.failed || 0);
    if (lost) notify(`Added ${stored.length} of ${valid.length} — ${lost} could not be saved`, 'error');
    else notify(`Added ${stored.length} image${stored.length === 1 ? '' : 's'}`, 'success');

    await refresh();
    // Write each new picture's prompt for you. Sequential on purpose: parallel vision calls on
    // a bulk upload would hammer the API and race each other's index writes.
    //
    // Paired by srcIndex, NOT by position: one skipped image used to shift every later pairing,
    // so each description was written onto the following picture.
    if (describeKind) {
      let failed = 0;
      for (let n = 0; n < stored.length; n += 1) {
        const item = stored[n];
        const src = payload[item.srcIndex];
        if (!src) continue;
        setDescribeProgress({ done: n, total: stored.length });
        // eslint-disable-next-line no-await-in-loop -- sequential on purpose: parallel vision
        // calls on a 50-image batch trip the rate limit immediately.
        const ok = await describeAuto(item.id, src.dataUrl);
        if (ok === false) failed += 1;
      }
      setDescribeProgress(null);
      if (failed) notify(`${failed} of ${stored.length} could not be described — use Re-describe on those`, 'error');
    }
  }, [store, activeFolder, refresh, notify, describeKind, describe, autoBlur]);

  // A pose or outfit can be pure text — the prompt is the point, the image is only an example.
  const openLibrary = useCallback(async (swapId = null) => {
    setLibSwapId(swapId); setLibOpen(true); setLibPicked([]); setLibBusy(true);
    try {
      setLibItems(await listMainLibrary(mediaKind));
    } catch (err) {
      notify(err.message || 'Could not read the gallery', 'error');
    } finally { setLibBusy(false); }
  }, [notify, mediaKind]);

  const importFromLibrary = useCallback(async () => {
    if (!libPicked.length) return;
    setLibBusy(true);
    try {
      // Swapping one card's picture: take the first pick and replace, rather than adding items.
      if (libSwapId) {
        const srcItem = libItems.find((x) => x.id === libPicked[0]);
        if (!srcItem?.url) { notify('Could not read that file', 'error'); return; }
        let dataUrl = await urlToDataUrl(srcItem.url);
        if (!dataUrl) { notify('Could not read that image', 'error'); return; }
        if (autoBlur) {
          const out = await autoBlurFace(dataUrl);
          dataUrl = out.dataUrl;
          if (!out.blurred) notify('No face found to blur — check it yourself', 'error');
        }
        // setImage, not setImageKeepingAlt: this is a different picture, so the old unblurred
        // spare belongs to an image that is no longer here.
        await store.setImage(libSwapId, dataUrl);
        setLibOpen(false); setLibPicked([]); setLibSwapId(null);
        await refresh();
        // Deliberately no re-describe: the prompt beside this card was written on purpose and
        // swapping the picture is not a request to rewrite it. Use "Re-describe with AI" for that.
        notify('Image changed · prompt kept', 'success');
        return;
      }

      let payload = [];
      for (const id of libPicked) {
        const src0 = libItems.find((i) => i.id === id);
        if (!src0?.url) continue;
        const dataUrl = await urlToDataUrl(src0.url);
        if (!dataUrl) continue;
        payload.push({ dataUrl, prompt: '', name: src0.id ? `gallery-${src0.id}` : 'from library' });
      }
      if (!payload.length) { notify('Could not read those images', 'error'); return; }

      // A pose or environment reference gets the same face treatment as an upload — Seedream
      // copies any face it is shown, and a Library picture usually has one.
      if (autoBlur) {
        payload = await Promise.all(payload.map(async (item) => {
          const out = await autoBlurFace(item.dataUrl);
          return { ...item, dataUrl: out.dataUrl, original: out.blurred ? item.dataUrl : '' };
        }));
      }

      const stored = await store.addItems(payload, activeFolder);
      // Copies, not moves: the picture stays in the Library too.
      notify(`Added ${stored.length || payload.length} from Gallery`, 'success');
      setLibOpen(false); setLibPicked([]);
      await refresh();
      if (describeKind) for (const it of (stored || [])) { await describeAuto(it.id, payload[0]?.dataUrl); }
    } catch (err) {
      notify(err.message || 'Could not add those', 'error');
    } finally { setLibBusy(false); }
  }, [libPicked, libItems, libSwapId, store, activeFolder, autoBlur, notify, refresh, describeKind, describe, mediaKind]);

  const addPromptOnly = useCallback(async () => {
    await store.addItems([{ prompt: '', name: promptLabel }], activeFolder);
    await refresh();
  }, [store, activeFolder, refresh, promptLabel]);

  const attachTo = useCallback(async (id, file) => {
    const isVid = mediaKind === 'video';
    const accepts = isVid ? /^video\/(mp4|webm|quicktime|x-matroska)$/i : /^image\/(png|jpe?g|webp)$/i;
    if (!accepts.test(file.type)) {
      notify(isVid ? 'Use MP4, WebM or MOV' : 'Use PNG, JPG or WebP', 'error');
      return;
    }
    // Replacing an item that already carries a prompt must not rewrite that text — dropping a
    // new picture is a swap, not a request to re-describe. Only a card with no prompt yet gets
    // one written for it.
    const existing = items.find((i) => i.id === id);
    const hadPrompt = Boolean(existing?.prompt?.trim());
    const hadImage = Boolean(thumbs[id] || existing?.url);
    try {
      let dataUrl = await fileToDataUrl(file);
      // Kept so the DESCRIPTION reads the unblurred picture while the STORED one stays blurred.
      // A pose brief ignores the face entirely, and a blur over it only makes the body harder
      // to read.
      const original = dataUrl;
      if (autoBlur && !isVid) {
        const out = await autoBlurFace(dataUrl);
        dataUrl = out.dataUrl;
        if (!out.blurred) notify('No face found to blur in that image — check it yourself', 'error');
      }
      await store.setImage(id, dataUrl);
      await refresh();
      notify(hadImage ? `${isVid ? 'Video' : 'Image'} changed${hadPrompt ? ' · prompt kept' : ''}` : `${isVid ? 'Video' : 'Image'} attached`, 'success');
      // Writing a description is only wanted for a card that has no prompt of its own.
      if (describeKind && !hadPrompt) await describeAuto(id, original);
    } catch (err) {
      notify(err.message || 'Could not attach that image', 'error');
    }
  }, [store, refresh, notify, describeKind, describe, autoBlur, mediaKind, items, thumbs]);

  /**
   * Outfits only: attach the BACK view crop, held alongside the front picture rather than
   * replacing it — and auto-describe it into its OWN `backPrompt` field. This matters because
   * EddyGeneratePage never sends the outfit picture itself (a flat product photo flattened the
   * bust when it was tried — see that page's comment), only the outfit TEXT. So the back crop's
   * job is entirely to produce a back-view description; without describing it here, attaching a
   * back image would do nothing for generation at all. readPoseView picks backPrompt over prompt
   * when the selected pose is back-facing.
   */
  const attachBackTo = useCallback(async (id, file) => {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      notify('Use PNG, JPG or WebP', 'error');
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      await store.setBackImage(id, dataUrl);
      await refresh();
      notify('Back view attached', 'success');
      if (describeKind === 'outfit') await describe(id, dataUrl, { field: 'backPrompt' });
    } catch (err) {
      notify(err.message || 'Could not attach that image', 'error');
    }
  }, [store, refresh, notify, describeKind, describe]);

  /**
   * Drop a FOLDER and get the same folder structure back.
   *
   * `dataTransfer.files` flattens a directory drop into a bare file list, losing the very thing
   * you dragged it for. webkitGetAsEntry() exposes the real tree, so a dropped folder becomes a
   * folder here, its subfolders become subfolders, and each image lands in the one it came from
   * (owner, 2026-08-08).
   *
   * Created relative to wherever you are standing, so dropping into an open folder nests under it
   * rather than at the root. ensureFolder matches by name WITHIN a parent, so re-dropping the same
   * tree refills the folders you already have instead of making a second set.
   *
   * Entries are read depth-first and awaited one directory at a time: a wide tree read in parallel
   * opens hundreds of file handles at once, and the store's writes are serialized anyway.
   */
  const addDroppedTree = useCallback(async (entries, parentId) => {
    const readDir = (reader) => new Promise((res, rej) => reader.readEntries(res, rej));
    const asFile = (entry) => new Promise((res, rej) => entry.file(res, rej));

    let files = 0;
    let madeFolders = 0;

    const walk = async (entry, pid) => {
      if (entry.isFile) {
        const f = await asFile(entry);
        if (!f.type.startsWith(mediaKind === 'video' ? 'video/' : 'image/')) return;
        const dataUrl = await fileToDataUrl(f);
        await store.addItems([{ dataUrl, name: f.name.replace(/\.[^.]+$/, '') }], pid);
        files += 1;
        return;
      }
      if (!entry.isDirectory) return;
      const folder = await store.ensureFolder(entry.name, pid);
      madeFolders += 1;
      const reader = entry.createReader();
      // readEntries returns at most ~100 per call, so it has to be drained in a loop — a single
      // call silently truncates a big folder and you would never know images were missing.
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const batch = await readDir(reader);
        if (!batch.length) break;
        for (const child of batch) {
          // eslint-disable-next-line no-await-in-loop
          await walk(child, folder.id);
        }
      }
    };

    for (const e of entries) {
      // eslint-disable-next-line no-await-in-loop
      await walk(e, parentId);
    }
    await refresh();
    notify(
      files
        ? `Added ${files} image${files === 1 ? '' : 's'} across ${madeFolders} folder${madeFolders === 1 ? '' : 's'}`
        : 'Nothing usable in that folder',
      files ? 'success' : 'error',
    );
  }, [store, mediaKind, refresh, notify]);

  // Drag anywhere on the page, not only over the drop card. A file dropped outside a handler
  // makes the window navigate to it, which looks like the app crashing.
  useEffect(() => {
    const over = (e) => { e.preventDefault(); if (e.dataTransfer?.types?.includes('Files')) setDragging(true); };
    const leave = (e) => { if (!e.relatedTarget) setDragging(false); };
    const drop = (e) => {
      e.preventDefault();
      setDragging(false);
      // Directories first: a folder drop also populates dataTransfer.files with its contents
      // flattened, so checking files first would take the flat path and throw the structure away.
      const items = Array.from(e.dataTransfer?.items || []);
      const entries = items
        .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
        .filter(Boolean);
      if (entries.some((en) => en.isDirectory)) { addDroppedTree(entries, activeFolder); return; }
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [addFiles, mediaKind, addDroppedTree, activeFolder]);

  // Paste anywhere on the page drops into the folder you're looking at.
  useEffect(() => {
    const onPaste = (e) => {
      const files = [...(e.clipboardData?.items || [])]
        .filter((i) => i.type.startsWith(mediaKind === 'video' ? 'video/' : 'image/'))
        .map((i) => i.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); addFiles(files); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles]);

  /**
   * Drag one folder chip onto another to nest it.
   *
   * Subfolders only helped NEW folders until now: a collection built before they existed was flat
   * and had no way to become a tree short of re-importing everything (owner, 2026-08-08 — 500+
   * outfit folders already in place). Dragging is the whole feature — no dialog, no move-to menu.
   *
   * The breadcrumb doubles as the un-nest target: drop a chip on a crumb to move it there, or on
   * "All" to send it back to the root.
   */
  /**
   * Items whose picture failed to load.
   *
   * A Library row stores a gallery URL, not the bytes — `url: /api/gallery/<id>/image`. That is
   * right for images this machine generated, and useless for a row that arrived in someone else's
   * export: the id points at THEIR gallery, so it 404s here and the tile renders black with no
   * explanation (owner, 2026-08-08 — a folder of 94 of them). The bytes cannot be recovered from
   * this side, so the honest thing is to name them and let them be cleared.
   */
  const [brokenIds, setBrokenIds] = useState(() => new Set());
  const markBroken = useCallback((id) => {
    setBrokenIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  // Cleared on refresh so a fixed or re-added image is not stuck looking broken.
  useEffect(() => { setBrokenIds(new Set()); }, [items]);

  const removeBroken = async () => {
    const doomed = visible.filter((i) => brokenIds.has(i.id));
    if (!doomed.length) return;
    if (!window.confirm(`Remove ${doomed.length} card${doomed.length === 1 ? '' : 's'} whose image cannot be loaded? The cards go, nothing else is deleted.`)) return;
    for (const it of doomed) {
      // eslint-disable-next-line no-await-in-loop -- serialized store
      try { await store.removeItem(it.id); } catch { /* keep going */ }
    }
    await refresh();
    notify(`Removed ${doomed.length} unloadable card${doomed.length === 1 ? '' : 's'}`, 'success');
  };

  const [dragFolder, setDragFolder] = useState(null);
  const [dropFolder, setDropFolder] = useState(null);

  const moveFolder = async (id, parentId) => {
    setDragFolder(null);
    setDropFolder(null);
    if (!id || id === parentId) return;
    const ok = await store.setFolderParent(id, parentId);
    if (!ok) { notify('A folder cannot go inside itself', 'error'); return; }
    await refresh();
  };

  const createFolder = async () => {
    if (!newFolder.trim()) return;
    // Created INSIDE wherever you are standing — that is what makes a subfolder a subfolder.
    await store.createFolder(newFolder, activeFolder);
    setNewFolder('');
    setShowNewFolder(false);
    await refresh();
  };

  // Works for both kinds of item: a data: URL carries its own bytes, a server URL is fetched
  // with credentials so the session cookie goes along.
  /**
   * Save one item to disk.
   *
   * Three things went wrong here at once once titles became the filename:
   *   - a title can be 592 characters, and Windows refuses a filename over 255, so the save
   *     failed with no error at all;
   *   - the object URL was revoked in the same tick as the click, which cancels the download
   *     before the browser has read it;
   *   - a stored item is already a data URL, so fetching it just to get a blob was a pointless
   *     round trip that could itself fail.
   */
  const download = async (it) => {
    const src = thumbs[it.id] || it.url;
    if (!src) { notify('Nothing to download on that card', 'error'); return false; }

    // Keep it recognisable but well inside the OS limit, and never end on a separator.
    const base = (it.name || it.prompt || 'image')
      .split(/\r?\n/)[0]
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 80)
      // Trim separators AFTER the cut — slicing mid-word otherwise leaves a trailing underscore.
      .replace(/^[_.-]+|[_.-]+$/g, '') || 'image';

    try {
      let href = src;
      let revoke = false;
      let ext = 'png';

      if (/^data:/.test(src)) {
        // data URLs can be handed straight to the anchor; the mime is already in the string.
        ext = (src.match(/^data:([^;/]+)\/([^;]+)/) || [])[2] || 'png';
      } else {
        /**
         * ABSOLUTE url, built from the window's own origin.
         *
         * A relative "/api/…" resolves against the document, and this window starts life on a
         * file:// temp page before redirecting to http://127.0.0.1:<port>. Any fetch that races
         * that redirect -- or any renderer that kept the file:// base -- resolves to
         * file:///api/gallery/… , which cannot be fetched and reports the bare "Failed to fetch"
         * the owner saw, while the very same URL returned 200 from curl and the grid <img> beside
         * it rendered fine (2026-08-10).
         *
         * The <img> works because the HTML parser resolves against the CURRENT base at paint time;
         * a fetch() built earlier does not. Pinning the origin removes the difference.
         */
        const absolute = /^https?:/i.test(src)
          ? src
          : new URL(src, window.location.origin).toString();
        const resp = await fetch(absolute, { credentials: 'include' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        href = URL.createObjectURL(blob);
        revoke = true;
        ext = (blob.type.split('/')[1] || 'png');
      }
      ext = ext.replace('jpeg', 'jpg').replace('quicktime', 'mov');

      // downloadBlob strips generator metadata and stamps a fresh capture time before saving, so
      // nothing posted carries the prompt or the model name. It needs a Blob, which a data URL is
      // not — but do NOT fetch() a data: URL to get one. Electron's CSP blocks that, and every
      // download of a locally-stored image died on "Failed to fetch" while remote ones worked
      // (owner, 2026-08-08). Decoding the base64 is both allowed and cheaper.
      let blob;
      if (revoke) {
        blob = await (await fetch(href)).blob();
        URL.revokeObjectURL(href);
      } else {
        const m2 = /^data:([^;]+);base64,(.+)$/.exec(src);
        if (!m2) throw new Error('unreadable image data');
        const bin = atob(m2[2]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        blob = new Blob([bytes], { type: m2[1] });
      }
      await downloadBlob(blob, `${base}.${ext}`);
      return true;
    } catch (err) {
      /**
       * Say WHICH url failed, not just that something did.
       *
       * "Could not download that file — Failed to fetch" was true and useless: it named neither
       * the request nor the reason, and diagnosing it meant reading five layers of source to
       * guess (owner, 2026-08-10). A fetch failure is almost always a wrong or unreachable URL,
       * so the URL is the one thing worth printing.
       */
      /**
       * LAST RESORT: take the pixels off the <img> that is ALREADY ON SCREEN.
       *
       * The picture is visibly rendered in the grid, so the bytes are in the renderer whatever the
       * fetch did. Reading them off the element cannot fail the way a request can -- no network,
       * no origin, no CSP, no cache. It re-encodes rather than copying the original file, which is
       * a fair trade against not getting the file at all, and downloadBlob strips metadata either
       * way.
       *
       * Used only after the fetch has already failed. The fetch stays first because it returns the
       * ORIGINAL bytes at original quality (owner, 2026-08-10, after "Failed to fetch" on a URL
       * that returned 200 from curl in the same second).
       */
      try {
        const el = document.querySelector(`img[data-eddy-img="${it.id}"]`);
        if (el && el.naturalWidth) {
          const canvas = document.createElement('canvas');
          canvas.width = el.naturalWidth;
          canvas.height = el.naturalHeight;
          canvas.getContext('2d').drawImage(el, 0, 0);
          const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
          if (blob) {
            await downloadBlob(blob, `${base}.png`);
            return true;
          }
        }
      } catch { /* fall through to the error below */ }
      // eslint-disable-next-line no-console -- the toast is short; the console carries the detail
      console.error('[eddy] download failed', { id: it.id, src: String(src).slice(0, 200), err });
      const where = /^data:/.test(String(src)) ? 'stored image data' : String(src).slice(0, 60);
      notify(`Could not download — ${err.message || 'unknown error'} (${where})`, 'error');
      return false;
    }
  };

  /**
   * Remove each image from the collection once it has been saved to disk.
   *
   * OFF by default and remembered per collection. It turns a folder into a QUEUE — save a batch,
   * they leave, what remains is what still needs doing — which is the point when a folder is a
   * to-post pile rather than an archive (owner, 2026-08-07).
   *
   * Only ever removes files that actually SAVED. A 401 or a failed fetch leaves the image exactly
   * where it was, because deleting on a failed download is unrecoverable: these live in IndexedDB
   * and nowhere else, so there is no copy to restore from.
   */
  const [purgeOnDownload, setPurgeOnDownload] = useState(() => {
    try { return localStorage.getItem(`kyros.purgeOnDownload.${dbName}`) === 'on'; } catch { return false; }
  });
  const togglePurge = () => {
    setPurgeOnDownload((v) => {
      const next = !v;
      try { localStorage.setItem(`kyros.purgeOnDownload.${dbName}`, next ? 'on' : 'off'); } catch { /* storage blocked */ }
      return next;
    });
  };

  const isElectron = Boolean(window.electronAPI?.isElectron);

  /**
   * The bytes for one card, however that card happens to store them.
   *
   * A row holds EITHER a data: URL (hand-added) or a gallery URL (generated), and the two need
   * different handling -- getting this wrong is what made bulk save skip every generated image.
   * When neither works, the picture on screen is read off its <img>, which cannot fail the way a
   * request can.
   *
   * Returns { data, ext } or null. Never throws: the caller counts failures and names them.
   */
  const bytesForItem = async (it) => {
    const src = thumbs[it.id] || it.url;
    const toBytes = (b64) => {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
      return out;
    };
    const clean = async (bytes, mime) => {
      if (!stripEnabled()) return bytes;
      try {
        const r = await stripMetadata(new Blob([bytes], { type: mime }));
        return new Uint8Array(await r.blob.arrayBuffer());
      } catch { return bytes; }
    };

    const m = /^data:([^;]+);base64,(.+)$/.exec(src || '');
    if (m) {
      const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg');
      return { data: await clean(toBytes(m[2]), m[1]), ext };
    }

    if (src) {
      try {
        const abs = /^https?:/i.test(src) ? src : new URL(src, window.location.origin).toString();
        const resp = await fetch(abs, { credentials: 'include' });
        if (resp.ok) {
          const blob = await resp.blob();
          const ext = ((blob.type.split('/')[1]) || 'png').replace('jpeg', 'jpg');
          const bytes = new Uint8Array(await blob.arrayBuffer());
          return { data: await clean(bytes, blob.type), ext };
        }
      } catch { /* fall through to the on-screen copy */ }
    }

    // The picture is already rendered, so the pixels are here regardless of what the fetch did.
    try {
      const el = document.querySelector(`img[data-eddy-img="${it.id}"]`);
      if (el && el.naturalWidth) {
        const canvas = document.createElement('canvas');
        canvas.width = el.naturalWidth;
        canvas.height = el.naturalHeight;
        canvas.getContext('2d').drawImage(el, 0, 0);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        if (blob) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          return { data: await clean(bytes, 'image/png'), ext: 'png' };
        }
      }
    } catch { /* nothing left to try */ }
    return null;
  };

  const downloadSelected = async () => {
    const picked = visible.filter((i) => selected.includes(i.id));

    /**
     * ASK WHERE. Saving straight to Downloads is fine for one image off a tile, but a deliberate
     * multi-select is usually headed somewhere specific -- a character's folder, a client folder,
     * a drive (owner, 2026-08-10).
     *
     * Cancelling the dialog cancels the save; it does not fall back to Downloads. Picking a
     * destination and getting a different one is worse than nothing happening.
     */
    if (isElectron && window.electronAPI?.chooseDownloadFolder && window.electronAPI?.saveFileToFolder) {
      const directory = await window.electronAPI.chooseDownloadFolder({
        title: `Choose where to save ${picked.length} image${picked.length === 1 ? '' : 's'}`,
        folderName: activeFolder
          ? String(folders.find((f) => f.id === activeFolder)?.name || 'eddy').replace(/[^\w -]+/g, '')
          : 'eddy-images',
      });
      if (!directory) return;                       // cancelled -- do nothing at all
      let ok = 0;
      let lastErr = '';
      const written = [];
      for (const it of picked) {
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential; the store and disk are both serial
          const bytes = await bytesForItem(it);
          if (!bytes) { lastErr = 'could not read the image'; continue; }
          const nm = String(it.name || it.prompt || it.id).replace(/[^a-z0-9._-]+/gi, '_').replace(/^[_.-]+|[_.-]+$/g, '').slice(0, 60) || 'image';
          // eslint-disable-next-line no-await-in-loop
          await window.electronAPI.saveFileToFolder({ directory, fileName: `${nm}.${bytes.ext}`, data: bytes.data });
          ok += 1;
          written.push(it.id);
        } catch (e) { lastErr = e?.message || 'unknown error'; }
      }
      if (purgeOnDownload && written.length) {
        for (const id of written) {
          // eslint-disable-next-line no-await-in-loop -- serialized store
          try { await store.removeItem(id); } catch { /* a stuck row is not worth losing the rest */ }
        }
        setSelected((prev) => prev.filter((id) => !written.includes(id)));
        await refresh();
      }
      const gone = purgeOnDownload && written.length ? ` · ${written.length} removed from this folder` : '';
      if (!ok) notify(`Nothing could be saved${lastErr ? ` — ${lastErr}` : ''}`, 'error');
      else if (ok < picked.length) notify(`Saved ${ok} of ${picked.length}${gone} — ${picked.length - ok} failed${lastErr ? `: ${lastErr}` : ''}`, 'info');
      else notify(`Saved ${ok} image${ok === 1 ? '' : 's'}${gone}`, 'success');
      return;
    }

    // Plain browser: no folder picker exists, so the per-file path stands.
    let saved = 0;
    const done = [];
    for (const it of picked) {
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose, see the gap below
      if (await download(it)) { saved += 1; done.push(it.id); }
      // Browsers drop rapid-fire downloads; a short gap makes a multi-file save reliable.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
    }
    if (purgeOnDownload && done.length) {
      for (const id of done) {
        // eslint-disable-next-line no-await-in-loop -- serialized store
        try { await store.removeItem(id); } catch { /* keep going; a stuck row is not worth losing the rest */ }
      }
      setSelected((prev) => prev.filter((id) => !done.includes(id)));
      await refresh();
    }
    // An expired session 401s every fetch. Announcing the selection size put a success toast on
    // top of twenty failures, and it was the one left on screen.
    const gone = purgeOnDownload && done.length ? ` · ${done.length} removed from this folder` : '';
    if (saved === picked.length) notify(`Downloaded ${saved} image${saved === 1 ? '' : 's'}${gone}`, 'success');
    else notify(`Downloaded ${saved} of ${picked.length} — the rest failed${gone}`, 'error');
  };

  // Save every image (or just the selected ones) into a FOLDER. These images live in IndexedDB, not
  // as files, so this is the only way to get them onto disk. In Electron the user picks/names the
  // folder and each file is written into it; a plain browser has no folder API, so it falls back to
  // individual downloads (they all land in Downloads).
  /**
   * Fold "Grace 1", "Grace 2", "Grace Outfit 1" back into "Grace".
   *
   * The Max tabs open a numbered folder per click, which is right while a batch is fresh and wrong
   * a week later -- twelve folders holding one picture each (owner, 2026-08-10). This moves every
   * image into the plain folder of the same name and removes the empties.
   *
   * MOVES, never deletes. deleteFolder alone would orphan the pictures to no folder at all, which
   * looks identical to losing them: the Library lists by folder, so a row with a null folderId is
   * visible under "All" and nowhere else. The move happens FIRST and is verified before any folder
   * is removed.
   */
  const mergeNumberedFolders = async () => {
    const all = await store.listFolders();
    // "Grace 3" and "Grace Outfit 3" both fold into "Grace". Split on the last space; the number
    // must be the whole tail, so "Grace cosplay" is not mistaken for a batch of "Grace".
    const parentOf = (name) => {
      const n = String(name || '').trim();
      const cut = n.lastIndexOf(' ');
      if (cut <= 0 || !/^[0-9]+$/.test(n.slice(cut + 1))) return null;
      return n.slice(0, cut).replace(/\s+Outfit$/i, '').trim() || null;
    };

    const groups = new Map();          // target name -> [folder, ...]
    for (const f of all) {
      const parent = parentOf(f.name);
      if (parent) {
        if (!groups.has(parent)) groups.set(parent, []);
        groups.get(parent).push(f);
      }
    }
    if (!groups.size) { notify('No numbered folders to merge', 'error'); return; }

    const total = [...groups.values()].reduce((n, fs) => n + fs.length, 0);
    const names = [...groups.keys()].sort().join(', ');
    if (!window.confirm(
      `Merge ${total} numbered folder${total === 1 ? '' : 's'} into ${names}?

`
      + 'Every picture moves into the plain folder of the same name. Nothing is deleted.',
    )) return;

    let moved = 0;
    let removed = 0;
    for (const [parent, fs] of groups) {
      // eslint-disable-next-line no-await-in-loop -- serialized store
      const target = await store.ensureFolder(parent);
      if (!target?.id) continue;
      for (const f of fs) {
        if (f.id === target.id) continue;
        // eslint-disable-next-line no-await-in-loop
        const rows = (await store.listItems()).filter((i) => i.folderId === f.id);
        const patches = new Map(rows.map((i) => [i.id, { folderId: target.id }]));
        // eslint-disable-next-line no-await-in-loop
        if (patches.size) await store.updateItems(patches);
        // Verified before the folder goes: if the move did not take, removing the folder would
        // orphan exactly the rows it failed on.
        // eslint-disable-next-line no-await-in-loop
        const left = (await store.listItems()).filter((i) => i.folderId === f.id).length;
        if (left) continue;
        moved += rows.length;
        // eslint-disable-next-line no-await-in-loop
        await store.deleteFolder(f.id);
        removed += 1;
      }
    }
    await refresh();
    setActiveFolder(null);
    notify(`Moved ${moved} image${moved === 1 ? '' : 's'} and removed ${removed} folder${removed === 1 ? '' : 's'}`, 'success');
  };

  const saveToFolder = async () => {
    // `visible`, NOT `items`: inside a folder, "Save all" must mean this folder. Using the
    // whole collection meant standing in a 12-image folder and getting all 500 back, with no
    // way to download just the folder you were looking at (owner, 2026-08-08).
    const picked = selected.length ? visible.filter((i) => selected.includes(i.id)) : visible;
    const files = [];
    for (let idx = 0; idx < picked.length; idx += 1) {
      const it = picked[idx];
      /**
       * A row can hold BYTES or a URL, and only bytes were handled.
       *
       * Generated results are stored as a URL to /api/gallery/<id>/image, not as a data URL — so
       * this regex failed on every one of them, every row `continue`d, and a Library full of
       * pictures reported "No images to save" (owner, 2026-08-10). Only hand-added rows, which
       * really are data URLs, ever worked.
       *
       * Fetched here rather than earlier: this is the one place that needs the FULL image, and
       * fetching every row up front would pull hundreds of megabytes for a save of twelve.
       */
      let dataUrl = thumbs[it.id] || await store.getImage(it.id);
      if (dataUrl && !/^data:/.test(dataUrl)) {
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential; a parallel burst of 500
          // fetches is what took the renderer down before.
          // Same origin pinning as the tile download above -- see the comment there.
          const abs = /^https?:/i.test(dataUrl) ? dataUrl : new URL(dataUrl, window.location.origin).toString();
          const resp = await fetch(abs, { credentials: 'include' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          // eslint-disable-next-line no-await-in-loop
          const blob = await resp.blob();
          // eslint-disable-next-line no-await-in-loop
          dataUrl = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.onerror = rej;
            fr.readAsDataURL(blob);
          });
        } catch {
          continue;   // named in the count below rather than silently vanishing
        }
      }
      const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
      if (!m) continue;   // a prompt-only card with no picture — nothing to save
      const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg');
      const nm = String(it.name || it.prompt || it.id).replace(/[^a-z0-9._-]+/gi, '_').replace(/^[_.-]+|[_.-]+$/g, '').slice(0, 50) || 'image';
      files.push({ fileName: `${String(idx + 1).padStart(3, '0')}_${nm}.${ext}`, b64: m[2], mime: m[1] });
    }
    if (!files.length) { notify('No images to save — these cards have no picture', 'error'); return; }
    // A row whose picture could not be fetched is dropped above. Say so, rather than letting the
    // save look complete at a smaller number than was selected.
    if (files.length < picked.length) {
      notify(`${picked.length - files.length} of ${picked.length} could not be read and will be skipped`, 'info');
    }
    const bytesOf = (b64) => { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i += 1) a[i] = bin.charCodeAt(i); return a; };

    /**
     * Bytes with the metadata stripped and a fresh capture time stamped — the SAME treatment the
     * browser download path gets from downloadBlob.
     *
     * The Electron branches below handed `bytesOf(f.b64)` straight to disk, so the one-click bulk
     * export — the path actually used on the desktop app — wrote files that still carried their
     * C2PA provenance, generator name and prompt, while the per-card download beside it wrote
     * clean ones (owner, 2026-08-08). Same button, same expectation, opposite result.
     *
     * Falls back to the raw bytes if stripping fails or is switched off: an unstripped file is
     * better than no file, and stripEnabled() is a deliberate user setting.
     */
    const cleanBytes = async (f) => {
      if (!stripEnabled()) return bytesOf(f.b64);
      try {
        const res = await stripMetadata(new Blob([bytesOf(f.b64)], { type: f.mime || 'image/png' }));
        return new Uint8Array(await res.blob.arrayBuffer());
      } catch {
        return bytesOf(f.b64);
      }
    };

    const folderName = `${String(title || 'eddy').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-images`;

    if (isElectron && window.electronAPI?.autoDownloadFolder && window.electronAPI?.saveFileToFolder) {
      // Zero-dialog path: goes straight to Downloads/<name>-images, no picker, one click.
      const directory = await window.electronAPI.autoDownloadFolder({ folderName });
      if (!directory) { notify('Could not create a folder in Downloads', 'error'); return; }
      let n = 0;
      let lastErr = '';
      for (const f of files) {
        // eslint-disable-next-line no-await-in-loop -- sequential writes, and cleanBytes is async
        try { await window.electronAPI.saveFileToFolder({ directory, fileName: f.fileName, data: await cleanBytes(f) }); n += 1; }
        catch (e) { lastErr = e?.message || 'unknown error'; }   // skip a bad one, keep the rest
      }
      /**
       * A run that saved NOTHING must not report success.
       *
       * Every failure was swallowed and the toast said "Saved 0 images ✨" — which reads as done,
       * so the missing files look like a mystery rather than an error (owner, 2026-08-10). The
       * count is now checked, and the reason for the last failure is carried out of the loop.
       */
      if (!n) notify(`Nothing could be saved${lastErr ? ` — ${lastErr}` : ''}`, 'error');
      else if (n < files.length) notify(`Saved ${n} of ${files.length} to Downloads/${folderName} — ${files.length - n} failed${lastErr ? `: ${lastErr}` : ''}`, 'info');
      else notify(`Saved ${n} image${n === 1 ? '' : 's'} to Downloads/${folderName} ✨`, 'success');
    } else if (isElectron && window.electronAPI?.chooseDownloadFolder && window.electronAPI?.saveFileToFolder) {
      const directory = await window.electronAPI.chooseDownloadFolder({
        title: `Choose where to save the ${(title || 'these').toLowerCase()} images`,
        folderName,
      });
      if (!directory) return;
      let n = 0;
      let lastErr = '';
      for (const f of files) {
        // eslint-disable-next-line no-await-in-loop -- sequential writes, and cleanBytes is async
        try { await window.electronAPI.saveFileToFolder({ directory, fileName: f.fileName, data: await cleanBytes(f) }); n += 1; }
        catch (e) { lastErr = e?.message || 'unknown error'; }   // skip a bad one, keep the rest
      }
      // Same as above: zero saved is a failure, not a quiet success.
      if (!n) notify(`Nothing could be saved${lastErr ? ` — ${lastErr}` : ''}`, 'error');
      else if (n < files.length) notify(`Saved ${n} of ${files.length} — ${files.length - n} failed${lastErr ? `: ${lastErr}` : ''}`, 'info');
      else notify(`Saved ${n} image${n === 1 ? '' : 's'} to the folder ✨`, 'success');
    } else {
      let n = 0;
      for (const f of files) {
        await downloadBlob(new Blob([bytesOf(f.b64)], { type: f.mime || 'image/png' }), f.fileName);
        await new Promise((r) => setTimeout(r, 200));   // browsers drop rapid-fire downloads
        n += 1;
      }
      notify(`Downloaded ${n} image${n === 1 ? '' : 's'} to your Downloads`, 'success');
    }
  };

  // Export the whole collection as the same JSON shape the importer takes, so a file exported
  // here can be handed to someone else and imported straight into their app.
  const exportAll = async () => {
    try {
      // Selection wins when there is one, so you can send just the batch you added rather
      // than your whole collection every time.
      const source = selected.length ? items.filter((i) => selected.includes(i.id)) : items;
      const rows = source.map((it) => ({
        // The title was being dropped, so an exported set came back headless and every card
        // had to be renamed by hand. The importer already reads `title`.
        title: it.name || '',
        prompt: it.prompt || '',
        // Pose cards carry a video prompt alongside the pose prompt. Without it here, an export
        // of 36 poses would come back needing 36 video prompts retyped by hand.
        videoPrompt: it.videoPrompt || '',
        // An outfit card can carry a second, back-view description, which generation picks over
        // `prompt` whenever the chosen pose is labelled back-facing. It is written by describing
        // a separately uploaded back photo, so leaving it out of the export means the receiving
        // side silently falls back to the front description for every back pose — the exact
        // mismatch the back image was uploaded to prevent.
        backPrompt: it.backPrompt || '',
        image: thumbs[it.id] || '',   // data URL for a stored image, '' for prompt-only
        backImage: backThumbs[it.id] || '',
        folder: folders.find((f) => f.id === it.folderId)?.name || '',
        // Stars travel WITH the export. Favorites live in their own key keyed by item id, and an
        // import mints new ids — so without this the ★ set had to be rebuilt by hand every time a
        // sheet came back. The importer reads this field.
        favorite: favIds.has(it.id),
      }));
      if (!rows.length) { notify('Nothing to export', 'error'); return; }
      const blob = new Blob([JSON.stringify(rows)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `${dbName}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      notify(`Exported ${rows.length} ${promptLabel}s`, 'success');
    } catch (err) {
      notify(err.message || 'Could not export', 'error');
    }
  };

  // Blur faces on images already in the collection. Auto-blur only runs on the way in, so
  // anything added before it existed keeps its face — which is most of them.
  const blurExisting = async () => {
    const targets = (selected.length ? visible.filter((i) => selected.includes(i.id)) : visible)
      .filter((i) => thumbs[i.id] && !i.url);      // server-hosted entries have no local bytes
    if (!targets.length) { notify('No stored images to blur here', 'error'); return; }

    setBlurring(true);
    let done = 0;
    let missed = 0;
    try {
      for (const it of targets) {
        const out = await autoBlurFace(thumbs[it.id]);
        if (out.blurred) {
          await store.setImageKeepingAlt(it.id, out.dataUrl);
          await store.updateItem(it.id, { blurred: true });
          done += 1;
        } else missed += 1;
      }
      await refresh();
      if (!done) notify(`No face found in any of the ${targets.length} — nothing changed`, 'error');
      else if (missed) notify(`Blurred ${done}; no face found in ${missed}`, 'success');
      else notify(`Blurred ${done} face${done === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      notify(err.message || 'Blur failed', 'error');
    } finally {
      setBlurring(false);
    }
  };

  // Per-item retry, with the detector loosened. Some faces are turned away or half-hidden and
  // the confident pass walks past them.
  const blurOne = async (it) => {
    setBlurring(true);
    try {
      const out = await autoBlurFace(thumbs[it.id], { aggressive: true });
      if (!out.blurred) { notify('Still no face found in that one', 'error'); return; }
      await store.setImageKeepingAlt(it.id, out.dataUrl);
      await store.updateItem(it.id, { blurred: true });
      await refresh();
      notify('Blurred', 'success');
    } catch (err) {
      notify(err.message || 'Blur failed', 'error');
    } finally {
      setBlurring(false);
    }
  };

  // Swap between the blurred copy and the original. Export and generation both read whichever
  // is active, so this is also how you share an unblurred set.
  const toggleBlurred = async (it) => {
    const ok = await store.swapAlt(it.id);
    if (!ok) { notify('No other version stored for that one', 'error'); return; }
    await store.updateItem(it.id, { blurred: !it.blurred });
    await refresh();
  };

  // Flip the whole collection at once. Sharing an unblurred set means switching every pose,
  // and doing that one card at a time across thirty of them is not a workflow.
  const setAllBlurred = async (wantBlurred) => {
    const targets = (selected.length ? visible.filter((i) => selected.includes(i.id)) : visible)
      .filter((i) => i.blurred !== undefined && i.blurred !== wantBlurred);
    if (!targets.length) {
      notify(wantBlurred ? 'All already blurred' : 'All already showing originals', 'success');
      return;
    }
    setBlurring(true);
    let moved = 0;
    try {
      for (const it of targets) {
        if (await store.swapAlt(it.id)) {
          await store.updateItem(it.id, { blurred: wantBlurred });
          moved += 1;
        }
      }
      await refresh();
      notify(`${moved} switched to ${wantBlurred ? 'blurred' : 'original'}`, 'success');
    } catch (err) {
      notify(err.message || 'Could not switch those', 'error');
    } finally {
      setBlurring(false);
    }
  };

  const removeItem = async (id) => {
    try { await store.removeItem(id); } catch (err) { notify(err.message || 'Could not delete', 'error'); }
    await refresh();
  };

  const toggleSelect = (id) => setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  /**
   * DRAG TO SELECT — hold the mouse down on a picture and glide across the others.
   *
   * Ticking a 40-image batch one checkbox at a time is the slow part of every clean-up, and the
   * checkbox is a 20px target on a 320px tile (owner, 2026-08-09).
   *
   * A PLAIN CLICK IS UNTOUCHED and still opens the large view. The drag only begins once a SECOND
   * tile is entered with the button still down, so nothing about single-clicking changes — that is
   * why mousedown alone does not select. `paintedRef` then suppresses the click that the browser
   * fires at the end of a drag, which would otherwise open the large view on whatever tile you
   * finished on.
   *
   * The direction is set by the tile you START on: begin on an unselected picture and the drag
   * selects, begin on a selected one and it clears — so a mis-drag is undone by dragging back over
   * it rather than by starting again.
   *
   * Each drag only ADDS to what is already ticked, never replaces it, so several sweeps in
   * different parts of the grid build one selection — which is the whole point of the request.
   */
  const paintRef = useRef(null);      // { mode: 'select' | 'deselect', startId } while the button is down
  const paintedRef = useRef(false);   // did this gesture actually paint? -> swallow the trailing click

  useEffect(() => {
    // Listens on the WINDOW, not the tile: releasing outside the grid (or outside the app) must end
    // the gesture too, or the next hover would carry on painting with no button held.
    const end = () => { paintRef.current = null; };
    window.addEventListener('mouseup', end);
    window.addEventListener('dragend', end);
    return () => { window.removeEventListener('mouseup', end); window.removeEventListener('dragend', end); };
  }, []);

  const paintStart = (id) => {
    // Left button only — a right-click opens the context menu and must not arm a selection.
    paintRef.current = { mode: selected.includes(id) ? 'deselect' : 'select', startId: id };
    paintedRef.current = false;
  };

  const paintOver = (id) => {
    const p = paintRef.current;
    if (!p) return;
    // First tile entered since mousedown: this is a drag, so commit the tile it started on too.
    const ids = p.startId && p.startId !== id ? [p.startId, id] : [id];
    if (p.startId === id) return;     // re-entering the origin adds nothing
    paintedRef.current = true;
    p.startId = null;                 // the origin is committed once, not on every re-entry
    setSelected((prev) => {
      const set = new Set(prev);
      for (const x of ids) { if (p.mode === 'select') set.add(x); else set.delete(x); }
      return [...set];
    });
  };

  // Star / un-star an item. The favorite is a FLAG stored on the item via the existing store — no
  // folder move, so the item keeps its category. The write PERSISTS the flag (survives reload), so the
  // "★ Favorite" (favOnly) filter then lists this item. Errors surface (a silent false here would leave
  // the star looking flipped while nothing was written) AND skip the refresh/toast so we never claim a
  // favorite that did not persist. On success refresh re-reads so the star fills and the "★ Favorite
  // (N)" count updates immediately, and a toast confirms the click landed — the user reported clicking
  // the star and seeing nothing move it to Favorites, so visible feedback is required.
  const toggleFavorite = async (it) => {
    let nowFav;
    try {
      // Writes ONLY the small favorites key (store.toggleFavorite) — never the big index. Returns the
      // new boolean. A failed/quota-refused write throws and is surfaced below; we do NOT refresh or
      // toast, so the star can never look flipped for a favorite that did not persist.
      nowFav = await store.toggleFavorite(it.id);
    } catch (err) {
      notify(err.message || 'Could not update favorite', 'error');
      return;
    }
    await refresh();
    notify(nowFav ? '★ Added to Favorites' : 'Removed from Favorites', 'success');
  };

  const moveSelected = async (raw) => {
    const folderId = raw === 'none' ? null : raw;
    let moved = 0;
    let failure = '';
    for (const id of selected) {
      try { await store.moveItem(id, folderId); moved += 1; } catch (err) { failure = err.message; }
    }
    const total = selected.length;
    setSelected([]);
    await refresh();
    const where = folders.find((f) => f.id === folderId)?.name || 'No folder';
    // Count what landed. Announcing the selection size claimed success for writes that a full
    // quota had silently refused.
    if (moved === total) notify(`Moved ${moved} to ${where}`, 'success');
    else notify(`Moved ${moved} of ${total} — ${failure || 'some writes failed'}`, 'error');
  };

  const deleteSelected = async () => {
    let gone = 0;
    let failure = '';
    for (const id of selected) {
      try { await store.removeItem(id); gone += 1; } catch (err) { failure = err.message; }
    }
    const total = selected.length;
    setSelected([]);
    await refresh();
    if (gone === total) notify(`Deleted ${gone} item${gone === 1 ? '' : 's'}`, 'success');
    else notify(`Deleted ${gone} of ${total} — ${failure || 'some writes failed'}`, 'error');
  };
  const moveItem = async (id, folderId) => { await store.moveItem(id, folderId); await refresh(); };
  const savePrompt = async (id, prompt) => {
    try {
      await store.updateItem(id, { prompt });
    } catch (err) {
      // Uncontrolled Textarea: a failed write leaves your text on screen with nothing behind
      // it, so without this it looks saved until the next reload.
      notify(err.message || 'Could not save that prompt', 'error');
    }
    await refresh();
  };

  const deleteFolder = async (id) => {
    await store.deleteFolder(id);
    if (activeFolder === id) setActiveFolder(null);
    await refresh();
    notify(`${folderLabel} deleted — its items moved to All`, 'success');
  };

  // Items added together get consecutive createdAt values (t0, t0+1, …), so a real gap marks
  // the boundary between one add and the next. Walk back from the newest until the gap opens.
  /**
   * Select everything generated in the last hour / day.
   *
   * "Select last added" catches ONE batch -- it stops at a 60s gap -- which is the wrong tool
   * after an afternoon of runs. Age is what you actually remember: "the stuff from today"
   * (owner, 2026-08-10).
   *
   * Counted from the CURRENT VIEW, so inside a folder it means that folder. Anything with no
   * createdAt is excluded rather than swept in on a falsy comparison.
   */
  const selectSince = useCallback((ms) => {
    const cutoff = Date.now() - ms;
    const ids = visible.filter((i) => Number(i.createdAt) > cutoff).map((i) => i.id);
    if (!ids.length) { notify('Nothing that recent in this view', 'error'); return; }
    setSelected(ids);
  }, [visible, notify]);

  const recentCounts = useMemo(() => {
    const now = Date.now();
    return {
      hour: visible.filter((i) => Number(i.createdAt) > now - 3_600_000).length,
      day: visible.filter((i) => Number(i.createdAt) > now - 86_400_000).length,
    };
  }, [visible]);

  const newestBatch = useMemo(() => {
    if (!visible.length) return [];
    const sorted = [...visible].sort((a, b) => b.createdAt - a.createdAt);
    const batch = [sorted[0]];
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i - 1].createdAt - sorted[i].createdAt > 60_000) break;   // a minute apart = a different session
      batch.push(sorted[i]);
    }
    return batch.map((i) => i.id);
  }, [visible]);

  // Membership, not length: equal counts across different sets flipped the label wrongly.
  const allShownSelected = visible.length > 0 && visible.every((i) => selected.includes(i.id));

  if (loading) return <div className="flex justify-center py-16"><Spinner size={28} /></div>;

  return (
    <div className="w-full space-y-4 animate-in">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
        {subtitle && <p className="text-sm text-zinc-500">{subtitle}</p>}
      </div>

      {/* Folders */}
      {folders.length > 1 && (
        <p className="text-[0.625rem] text-zinc-600">
          Drag a folder onto another to nest it · drop on “All” to bring it back out
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => { setActiveFolder(null); setFavOnly(false); }}
          onDragOver={(e) => { if (dragFolder) { e.preventDefault(); setDropFolder('__root'); } }}
          onDragLeave={() => setDropFolder((d) => (d === '__root' ? null : d))}
          onDrop={(e) => { e.preventDefault(); moveFolder(dragFolder, null); }}
          className={cn('rounded-full border px-3 py-1.5 text-xs font-medium transition cursor-pointer',
            dropFolder === '__root' ? 'border-rose-500 bg-rose-500/30 text-white'
              : activeFolder === null && !favOnly ? 'border-rose-500 bg-rose-500/15 text-white' : 'border-zinc-700/60 bg-white/[0.02] text-zinc-400 hover:text-white')}
        >
          {/* Doubles as the ROOT drop target — without a way back out, nesting would be one-way. */}
          {dragFolder ? 'Drop here to un-nest' : `All (${items.length})`}
        </button>
        {/* Favorite FILTER — distinct from folders by its star. It is a flag view across ALL folders,
            so it sits beside All rather than in the folder list. Always offered so it is discoverable
            even before the first star; harmless on Library/Outfit/Character where nobody stars. */}
        <button
          onClick={() => setFavOnly((v) => !v)}
          aria-pressed={favOnly}
          title="Show only favorited items — across every folder"
          className={cn('inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition cursor-pointer',
            favOnly ? 'border-rose-500 bg-rose-500/15 text-rose-300' : 'border-zinc-700/60 bg-white/[0.02] text-zinc-400 hover:text-white')}
        >
          <StarIcon filled={favOnly} /> Favorite ({items.filter((i) => favIds.has(i.id)).length})
        </button>
        {/* BREADCRUMB — only while you are inside something. Each crumb jumps back to that
            level, so getting out of a deep tree is one click rather than a hunt. */}
        {folderPath.slice(0, -1).map((f) => (
          <button key={`crumb-${f.id}`} onClick={() => setActiveFolder(f.id)}
            className="rounded-full border border-zinc-700/60 bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-400 hover:text-white cursor-pointer">
            {f.name} ›
          </button>
        ))}
        {/* Only the CURRENT level is listed, not every folder in the collection — a flat list of
            every subfolder is exactly what subfolders exist to get rid of. Counts include the
            subtree, so a parent whose items all live in its children does not read as empty. */}
        {levelFolders(activeFolder).map((f) => {
          const ids = subtreeIds(f.id);
          const count = items.filter((i) => ids.has(i.folderId)).length;
          const kids = childrenOf(f.id).length;
          return (
            <span key={f.id} className="group relative inline-flex">
              <button
                draggable
                onDragStart={() => setDragFolder(f.id)}
                onDragEnd={() => { setDragFolder(null); setDropFolder(null); }}
                onDragOver={(e) => { if (dragFolder && dragFolder !== f.id) { e.preventDefault(); setDropFolder(f.id); } }}
                onDragLeave={() => setDropFolder((d) => (d === f.id ? null : d))}
                onDrop={(e) => { e.preventDefault(); moveFolder(dragFolder, f.id); }}
                title="Drag onto another folder to nest it inside"
                onClick={() => { setActiveFolder(f.id); setFavOnly(false); }}
                className={cn('rounded-full border px-3 py-1.5 text-xs font-medium transition cursor-pointer',
                  dropFolder === f.id ? 'border-rose-500 bg-rose-500/30 text-white'
                    : activeFolder === f.id && !favOnly ? 'border-rose-500 bg-rose-500/15 text-white' : 'border-zinc-700/60 bg-white/[0.02] text-zinc-400 hover:text-white')}
              >
                {f.name} ({count}){kids > 0 && <span className="ml-1 text-zinc-500">›{kids}</span>}
              </button>
              <button
                onClick={() => deleteFolder(f.id)}
                title={`Delete ${folderLabel.toLowerCase()} (its items are kept)`}
                className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-zinc-600 bg-zinc-800 text-[0.5625rem] text-zinc-400 hover:text-red-400 group-hover:flex cursor-pointer"
              >×</button>
            </span>
          );
        })}
        {showNewFolder ? (
          <span className="inline-flex items-center gap-1.5">
            <Input value={newFolder} onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createFolder(); }}
              placeholder={activeFolder ? `Subfolder in ${folderPath[folderPath.length - 1]?.name || ''}` : `${folderLabel} name`} className="!h-8 !py-1 !text-xs w-40" autoFocus />
            <Btn className="!rounded-lg !py-1 !px-3 !text-xs" onClick={createFolder}>Add</Btn>
            <Btn variant="ghost" className="!rounded-lg !py-1 !px-2 !text-xs" onClick={() => setShowNewFolder(false)}>×</Btn>
          </span>
        ) : (
          <Btn variant="secondary" className="!rounded-full !py-1.5 !px-3 !text-xs" onClick={() => setShowNewFolder(true)}>
            + New {activeFolder ? 'subfolder' : folderLabel.toLowerCase()}
          </Btn>
        )}
      </div>

      {libOpen && createPortal(
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/70 p-4"
             onClick={(e) => { if (e.target === e.currentTarget) { setLibOpen(false); setLibSwapId(null); } }}>
          <Card className="flex max-h-[86vh] w-full max-w-4xl flex-col p-4">
            <div className="flex items-center justify-between gap-3 pb-3">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
                {libSwapId ? `Change ${mediaKind === 'video' ? 'video' : 'image'} · pick from Gallery` : (mediaKind === 'video' ? 'Add from Video Gallery' : 'Add from Gallery')}
                {libPicked.length > 0 && <span className="ml-2 text-rose-400">· {libSwapId ? 1 : libPicked.length} selected</span>}
              </h3>
              <button onClick={() => setLibOpen(false)}
                      className="cursor-pointer px-2 text-lg text-zinc-500 hover:text-zinc-200">×</button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {libBusy && !libItems.length ? (
                <div className="flex justify-center py-10"><Spinner size={20} /></div>
              ) : !libItems.length ? (
                <p className="py-10 text-center text-sm text-zinc-500">
                  {mediaKind === 'video' ? 'No videos in the Video Gallery yet — generate one first.' : 'The Gallery is empty — generate something first.'}
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
                  {libItems.map((it) => {
                    const on = libPicked.includes(it.id);
                    return (
                      <button key={it.id} type="button"
                        onClick={() => setLibPicked((prev) => (libSwapId ? [it.id] : on ? prev.filter((x) => x !== it.id) : [...prev, it.id]))}
                        className={cn('relative overflow-hidden rounded-lg border transition cursor-pointer',
                          on ? 'border-rose-500 ring-2 ring-rose-500/50' : 'border-white/[0.07] hover:border-zinc-600')}>
                        {it.url
                          ? (mediaKind === 'video'
                            ? <video src={it.url} muted preload="metadata" className="aspect-square w-full object-cover bg-zinc-950" />
                            : <img src={it.url} alt="" className="aspect-square w-full object-cover bg-zinc-950" />)
                          : <span className="flex aspect-square w-full items-center justify-center bg-white/[0.03] text-[0.5rem] uppercase text-zinc-600">no pic</span>}
                        {on && <span className="absolute right-1 top-1 rounded-full bg-rose-500 px-1.5 text-[0.625rem] font-bold text-white">✓</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 pt-3">
              <p className="text-[0.625rem] text-zinc-600">
                {libSwapId
                  ? 'Replaces this card’s picture. Its prompt is kept.'
                  : `Copies into ${title}${activeFolder ? ` → “${folders.find((f) => f.id === activeFolder)?.name}”` : ''}. The Library keeps its copy.`}
                {autoBlur && ' Faces are blurred on the way in.'}
              </p>
              <div className="flex gap-2">
                <Btn variant="ghost" className="!rounded-lg !py-2 !px-4 !text-sm" onClick={() => { setLibOpen(false); setLibSwapId(null); }}>Cancel</Btn>
                <Btn className="!rounded-lg !py-2 !px-4 !text-sm" onClick={importFromLibrary} disabled={!libPicked.length || libBusy}>
                  {libBusy ? <><Spinner size={14} /><span className="ml-2">{libSwapId ? 'Changing…' : 'Adding…'}</span></> : (libSwapId ? 'Use this image' : `Add ${libPicked.length || ''}`)}
                </Btn>
              </div>
            </div>
          </Card>
        </div>,
        document.body,
      )}

      {/* Drop zone */}
      <Card className={cn('p-4 transition', dragging && 'ring-2 ring-rose-500/60')}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-zinc-500">
            {withPrompt ? 'Drop or paste an image anywhere to add one — or drop onto a card to attach it there' : 'Drop or paste images anywhere on this page'}
            {activeFolder ? ` — into “${folders.find((f) => f.id === activeFolder)?.name}”` : ''}.
          </p>
          <div className="flex items-center gap-2">
            {autoBlur && items.length > 0 && (
              <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm" onClick={blurExisting} disabled={blurring}>
                {blurring ? 'Blurring…' : selected.length ? `Blur ${selected.length} face(s)` : 'Blur all faces'}
              </Btn>
            )}
            {autoBlur && items.some((i) => i.blurred !== undefined) && (
              <>
                <Btn variant="ghost" className="!rounded-lg !py-2 !px-3 !text-sm" disabled={blurring}
                  onClick={() => setAllBlurred(false)}>
                  Unblur all
                </Btn>
                <Btn variant="ghost" className="!rounded-lg !py-2 !px-3 !text-sm" disabled={blurring}
                  onClick={() => setAllBlurred(true)}>
                  Re-blur all
                </Btn>
              </>
            )}
            {/* White plate — only on Pose, and only with something ticked. It spends money and
                replaces the picture, so it is never a one-click sweep over the whole view the way
                Describe missing is. The count and the price are both on the button. */}
            {enablePlate && (plating ? (
              <Btn variant="ghost" className="!rounded-lg !py-2 !px-4 !text-sm" onClick={stopPlating}>
                Stop plating{plateProgress ? ` (${plateProgress.done}/${plateProgress.total})` : ''}
              </Btn>
            ) : plateRunnable.length > 0 && (
              <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm !border-sky-500/40 !text-sky-200"
                onClick={plateSelected}
                title="Regenerate on Seedream with the room removed and paste it back in place. Originals are kept.">
                White plate {plateRunnable.length} · ${(plateRunnable.length * PLATE_COST_PER_IMAGE).toFixed(2)}
              </Btn>
            ))}
            {enablePlate && !plating && platedCount > 0 && (
              <Btn variant="ghost" className="!rounded-lg !py-2 !px-3 !text-sm" onClick={revertPlates}
                title="Put the original pictures back">
                Revert {selected.length ? 'selected' : `all ${platedCount}`} plate{platedCount === 1 && !selected.length ? '' : 's'}
              </Btn>
            )}
            {describeKind && (describingAll || missingDescribeTargets.length > 0) && (
              describingAll ? (
                <Btn variant="ghost" className="!rounded-lg !py-2 !px-4 !text-sm" onClick={stopDescribeAll}>
                  Stop describing
                </Btn>
              ) : (
                <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm" onClick={describeAllMissing}>
                  Describe {missingDescribeTargets.length} missing
                </Btn>
              )
            )}
            {/* Only appears when there is something to fix, and states the count so a collection
                with broken cards cannot look clean. */}
            {!describingAll && brokenPromptTargets.length > 0 && (
              <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm !border-amber-500/40 !text-amber-200" onClick={redescribeBroken}>
                Re-describe {brokenPromptTargets.length} unreadable
              </Btn>
            )}
            {/* front/back/closeup classification (2026-08-06) — only shown when there is
                something to label, and never touches an existing description (mergePoseView). */}
            {!describingAll && unlabeledViewTargets.length > 0 && (
              <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm !border-blue-500/40 !text-blue-200" onClick={labelViews} disabled={labelingViews}>
                {labelingViews ? 'Labelling…' : `Label ${unlabeledViewTargets.length} pose${unlabeledViewTargets.length === 1 ? '' : 's'}`}
              </Btn>
            )}
            {/* Back-view descriptions for outfits that predate the two-prompt upload (2026-08-06).
                Writes ONLY backPrompt — the front description is never touched. */}
            {!describingAll && missingBackTargets.length > 0 && (
              <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm !border-blue-500/40 !text-blue-200" onClick={describeBackViews} disabled={describingBacks}>
                {describingBacks ? 'Describing backs…' : `Describe ${missingBackTargets.length} back view${missingBackTargets.length === 1 ? '' : 's'}`}
              </Btn>
            )}
            {/* Same rule as the unreadable sweep: only shown when there is something to clean, and it
                names the count so a collection full of duplicates cannot look tidy. */}
            {dupeFavCount > 0 && (
              <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm !border-amber-500/40 !text-amber-200" onClick={tidyFavorites}>
                Fix {dupeFavCount} duplicate star{dupeFavCount === 1 ? '' : 's'}
              </Btn>
            )}
            {withPrompt && (
              <Btn className="!rounded-lg !py-2 !px-4 !text-sm" onClick={addPromptOnly}>+ Add {promptLabel}</Btn>
            )}
            {items.length > 0 && (
              <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm" onClick={exportAll}>
                {selected.length ? `Export ${selected.length}` : 'Export all'}
              </Btn>
            )}
            {brokenIds.size > 0 && (
              <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm !border-amber-500/40 !text-amber-200" onClick={removeBroken}>
                Remove {visible.filter((i) => brokenIds.has(i.id)).length} unloadable
              </Btn>
            )}
            {/* The top-toolbar "Save N to Downloads" was REMOVED. It did the same job as Download
                in the selection bar, so a selection offered two buttons for one action and you had
                to scroll back to the top to reach one of them (owner, 2026-08-10).
                Two ways to download, and only two: the arrow on a card, and Download in the
                selection bar — which follows the selection rather than living at the top. */}
            {false && (
              <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm" onClick={saveToFolder}>
                {selected.length ? `Save ${selected.length} to Downloads` : 'Save to Downloads'}
              </Btn>
            )}
            <Btn variant="secondary" className="!rounded-lg !py-2 !px-4 !text-sm" onClick={openLibrary}>
              {mediaKind === 'video' ? 'From Video Gallery' : 'From Gallery'}
            </Btn>
            <label className="inline-flex cursor-pointer items-center rounded-lg border border-white/[0.06] bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-white/[0.07]">
              Upload
              <input type="file" accept={mediaKind === 'video' ? 'video/mp4,video/webm,video/quicktime' : 'image/png,image/jpeg,image/webp'} multiple className="hidden"
                onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            </label>
          </div>
        </div>
      </Card>

      {/* Always reachable — Select all used to live inside the bulk bar, which only appeared
          once something was already ticked, so there was no way to start a select-all. */}
      {visible.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 px-1 text-xs text-zinc-500">
          <span>{visible.length} item{visible.length === 1 ? '' : 's'}{activeFolder ? ' in this folder' : ''}</span>
          <button
            onClick={() => setSelected(allShownSelected ? [] : visible.map((i) => i.id))}
            className="text-zinc-400 hover:text-white cursor-pointer underline underline-offset-2"
          >
            {allShownSelected ? 'Clear selection' : 'Select all'}
          </button>
          <span className="ml-auto flex items-center gap-2">
            <span className="text-[0.625rem] font-bold uppercase tracking-wider text-zinc-600">Per row</span>
            {[2, 3, 4, 5, 6].map((n) => (
              <button key={n} type="button" onClick={() => setCols(n)}
                className={cn('h-6 w-6 rounded-md border text-[0.6875rem] font-semibold transition cursor-pointer',
                  cols === n ? 'border-rose-500 bg-rose-500/15 text-rose-300'
                             : 'border-white/[0.07] text-zinc-500 hover:border-zinc-600')}>
                {n}
              </button>
            ))}
          </span>
          <span className="flex items-center gap-2">
            <span className="text-[0.625rem] font-bold uppercase tracking-wider text-zinc-600">Size</span>
            <input type="range" min="120" max="720" step="20" value={imgH}
              onChange={(e) => setImgH(parseInt(e.target.value, 10))}
              className="h-1 w-28 cursor-pointer accent-rose-500" />
            <span className="w-10 tabular-nums text-zinc-500">{imgH}px</span>
          </span>
          {/* Only offered where a prompt is worth reading but the card is not a prompt card.
              On a withPrompt collection the text is already the point and is always shown. */}
          {!withPrompt && items.some((i) => (i.prompt || '').trim()) && (
            <button
              type="button"
              onClick={() => setShowPrompts((v) => !v)}
              aria-pressed={showPrompts}
              title="Show the prompt each image was generated with"
              className={cn('rounded-full border px-2.5 py-1 text-[0.625rem] font-semibold transition cursor-pointer',
                showPrompts ? 'border-rose-500 bg-rose-500/15 text-rose-300'
                            : 'border-white/[0.07] bg-white/[0.02] text-zinc-400 hover:border-zinc-600')}
            >
              {showPrompts ? '✓ Prompts' : 'Show prompts'}
            </button>
          )}
          {/* SEARCH THE PROMPTS. In a folder of near-identical shots the prompt is the only thing
              that tells two apart, and scrolling 627 of them is not a search. Filters `visible`,
              so Select all and the counts mean what is on screen. */}
          {items.some((i) => (i.prompt || '').trim()) && (
            <span className="flex items-center gap-1">
              <input
                value={promptQuery}
                onChange={(e) => setPromptQuery(e.target.value)}
                placeholder="Search prompts…"
                className="w-36 rounded-full border border-white/[0.07] bg-white/[0.02] px-2.5 py-1 text-[0.625rem] text-zinc-300 placeholder:text-zinc-600 focus:border-rose-500/50 focus:outline-none"
              />
              {promptQuery && (
                <button type="button" onClick={() => setPromptQuery('')}
                  title="Clear the search"
                  className="text-[0.625rem] text-zinc-500 hover:text-zinc-200 cursor-pointer">×</button>
              )}
            </span>
          )}
          {newestBatch.length > 0 && newestBatch.length < visible.length && (
            <button
              onClick={() => setSelected(newestBatch)}
              className="text-zinc-400 hover:text-white cursor-pointer underline underline-offset-2"
            >
              Select last added ({newestBatch.length})
            </button>
          )}
          {/* Only offered when it would select something OTHER than everything -- a button that
              does the same as "Select all" is a button that teaches you to ignore it. */}
          {recentCounts.hour > 0 && recentCounts.hour < visible.length && (
            <button
              onClick={() => selectSince(3_600_000)}
              title="Select everything generated in the last hour"
              className="text-zinc-400 hover:text-white cursor-pointer underline underline-offset-2"
            >
              Last hour ({recentCounts.hour})
            </button>
          )}
          {recentCounts.day > 0 && recentCounts.day < visible.length && recentCounts.day !== recentCounts.hour && (
            <button
              onClick={() => selectSince(86_400_000)}
              title="Select everything generated in the last 24 hours"
              className="text-zinc-400 hover:text-white cursor-pointer underline underline-offset-2"
            >
              Last 24h ({recentCounts.day})
            </button>
          )}
          {/* Tidy-up, offered only when there is something to tidy. */}
          {folders.some((f) => /\s[0-9]+$/.test(String(f.name || '').trim())) && (
            <button
              onClick={mergeNumberedFolders}
              title="Fold Grace 1, Grace 2… back into Grace. Moves the pictures, deletes nothing."
              className="text-zinc-500 hover:text-white cursor-pointer underline underline-offset-2"
            >
              Merge numbered folders
            </button>
          )}
          {describeProgress && (
        <p className="px-1 text-xs text-zinc-400">
          Describing with AI — {describeProgress.done + 1} of {describeProgress.total}…
        </p>
      )}

      {selected.length > 0 && (
            <span className="ml-auto text-zinc-600">Export sends the {selected.length} selected</span>
          )}
        </div>
      )}

      {selected.length > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2">
          <span className="text-xs text-zinc-300">{selected.length} selected</span>
          <select
            defaultValue=""
            onChange={(e) => { if (e.target.value !== '') { moveSelected(e.target.value || null); e.target.value = ''; } }}
            className="rounded-lg border border-white/[0.06] bg-[#0b0b0f] px-2 py-1 text-xs text-zinc-300 outline-none cursor-pointer"
          >
            <option value="" disabled>Move to…</option>
            <option value="none">No {folderLabel.toLowerCase()}</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {/* Says the COUNT. "Download" beside "2 selected" left it ambiguous whether it meant
              the selection or everything, which is the question you want answered before clicking
              a thing that writes files. */}
          {/* downloadSelected, NOT saveToFolder. It is the one that honours "Remove after
              download" -- swapping them would have quietly dropped that feature. Says the COUNT
              because "Download" beside "2 selected" left it ambiguous whether it meant the
              selection or everything, which is the question worth answering before clicking a
              thing that writes files. */}
          <Btn variant="secondary" className="!rounded-lg !py-1 !px-3 !text-xs" onClick={downloadSelected}>
            Download {selected.length}
          </Btn>
          {/* WHITE PLATE LIVES HERE, with the selection it acts on.
              It was only in the toolbar at the very top of the page, which is where you are not: you
              tick cards while scrolled down among them, so the button sat off-screen the entire time
              it was waiting to be pressed (owner, 2026-08-09). This bar follows the selection, so it
              is on screen whenever there is something to plate. */}
          {enablePlate && (plating ? (
            <Btn variant="ghost" className="!rounded-lg !py-1 !px-3 !text-xs" onClick={stopPlating}>
              Stop{plateProgress ? ` ${plateProgress.done}/${plateProgress.total}` : ''}
            </Btn>
          ) : plateRunnable.length > 0 && (
            <Btn variant="secondary" className="!rounded-lg !py-1 !px-3 !text-xs !border-sky-500/40 !text-sky-200"
              onClick={plateSelected}
              title="Regenerate on Seedream with the room removed, and paste it back onto the card. Originals are kept.">
              White plate {plateRunnable.length} · ${(plateRunnable.length * PLATE_COST_PER_IMAGE).toFixed(2)}
            </Btn>
          ))}
          {/* Says WHY the count is lower than what you ticked, rather than leaving you to wonder. */}
          {enablePlate && !plating && plateMirrorSkips.length > 0 && (
            <span className="text-[0.6875rem] text-amber-300/80">
              {plateMirrorSkips.length} mirror skipped — the mirror is the shot
            </span>
          )}
          {/* Turns this folder into a queue: saved images leave, what remains is what is still to
              do. Off by default, remembered per collection, and it only ever drops files that
              actually saved — these live in IndexedDB alone, so a delete on a failed download
              could not be undone. */}
          <button type="button" onClick={togglePurge} aria-pressed={purgeOnDownload}
            title={purgeOnDownload
              ? 'Downloaded images are removed from this folder'
              : 'Downloaded images stay in this folder'}
            className={cn('rounded-lg border px-2.5 py-1 text-[0.625rem] font-semibold transition cursor-pointer',
              purgeOnDownload ? 'border-rose-500 bg-rose-500/15 text-rose-300'
                              : 'border-white/[0.07] bg-white/[0.02] text-zinc-500 hover:border-zinc-600')}>
            {purgeOnDownload ? '✓ Remove after download' : 'Remove after download'}
          </button>
          <Btn className="!rounded-lg !py-1 !px-3 !text-xs" onClick={deleteSelected}>Delete selected</Btn>
          <Btn variant="ghost" className="!rounded-lg !py-1 !px-3 !text-xs" onClick={() => setSelected([])}>Cancel</Btn>
          <button onClick={() => setSelected(visible.map((i) => i.id))}
            className="ml-auto text-xs text-zinc-500 hover:text-white cursor-pointer">Select all shown</button>
          {/* The pictures stream in after the grid. Said out loud because a sweep or a bulk
              download run in the first second would otherwise see fewer images than the collection
              holds, and there would be nothing on screen explaining why. */}
          {imagesPending > 0 && (
            <span className="text-xs text-zinc-600">loading {imagesPending} picture{imagesPending === 1 ? '' : 's'}…</span>
          )}
        </div>
      )}

      {/* Items */}
      {!visible.length ? (
        <p className="py-10 text-center text-sm text-zinc-600">
          Nothing here yet. {withPrompt ? 'Add a prompt, or drop an image.' : 'Drop, paste or upload an image.'}
        </p>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {visible.slice(0, shown).map((it) => (
            <Card key={it.id}
              className={cn('p-2 space-y-2 transition',
                dropOn === it.id
                  ? 'ring-2 ring-rose-500 bg-rose-500/[0.06]'
                  : 'hover:ring-1 hover:ring-rose-500/30')}
              onDragOver={(e) => {
                if (!e.dataTransfer?.types?.includes('Files')) return;
                e.preventDefault(); e.stopPropagation();
                // Highlight the card being aimed at, so a drop meant to REPLACE this one is
                // visibly different from a drop that adds a new item to the page.
                setDropOn(it.id);
              }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropOn(null); }}
              onDrop={(e) => {
                const f = e.dataTransfer?.files?.[0];
                setDropOn(null);
                if (!f) return;
                // Stop the window handler, or this would ALSO add a brand new item.
                e.preventDefault();
                e.stopPropagation();
                setDragging(false);
                attachTo(it.id, f);
              }}>
              <div className="relative">
                {withPrompt && durationFromPrompt(it.prompt) && (thumbs[it.id] || it.url) && (
                  <span className="absolute bottom-2 left-2 z-10 rounded-lg border border-rose-400/40 bg-black/80 px-3 py-1.5 text-lg font-extrabold leading-none tabular-nums text-rose-200 shadow-lg">
                    {durationFromPrompt(it.prompt)}
                  </span>
                )}
                {brokenIds.has(it.id) && (
                  <span className="pointer-events-none absolute inset-x-2 top-8 z-10 rounded-md bg-amber-500/90 px-2 py-1 text-center text-[0.625rem] font-bold text-black">
                    Image not on this machine
                  </span>
                )}
                {dropOn === it.id && (thumbs[it.id] || it.url) && (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/60 text-xs font-semibold text-rose-200">
                    Drop to replace{it.prompt?.trim() ? ' · prompt kept' : ''}
                  </div>
                )}
                {(thumbs[it.id] || it.url) ? (
                  mediaKind === 'video' ? (
                  <video
                    src={thumbs[it.id] || it.url}
                    controls
                    preload="metadata"
                    className="w-full rounded-lg bg-zinc-950 object-contain"
                    style={{ maxHeight: 260 }}
                  />
                  ) : (
                  <img
                    data-eddy-img={it.id}
                    // crossOrigin so the canvas fallback above can read the pixels back. Same
                    // origin here, but an untainted canvas is what makes toBlob legal at all.
                    crossOrigin="anonymous"
                    src={gridSrc(thumbs[it.id] || it.url)}
                    alt={it.name}
                    // A 404 on a gallery URL is otherwise indistinguishable from a very slow load.
                    onError={() => markBroken(it.id)}
                    // contain, not cover, on prompt cards: a pose is judged by the whole body,
                    // and h-28 + cover cropped every image down to a thin band of its middle.
                    style={withPrompt ? { maxHeight: imgH } : undefined}
                    // Drag across pictures to tick them; a plain click still opens the large view.
                    // See paintStart/paintOver. draggable=false so the browser's own image drag
                    // does not start and cancel the gesture halfway across the grid.
                    draggable={false}
                    onMouseDown={(e) => { if (e.button === 0) paintStart(it.id); }}
                    onMouseEnter={() => paintOver(it.id)}
                    onClick={() => {
                      // Swallow the click that ends a drag — otherwise the large view opens on
                      // whichever tile the sweep finished on.
                      if (paintedRef.current) { paintedRef.current = false; return; }
                      setLightboxId(it.id);
                    }}
                    title="Click to view large · drag across to select"
                    className={cn('w-full select-none rounded-lg bg-zinc-950 cursor-zoom-in',
                      withPrompt ? 'object-contain' : 'aspect-[3/4] object-cover')}
                  />
                  )
                ) : (
                  // Prompt-only item: offer an explicit way in, not just drag-and-drop.
                  <label className="flex h-9 cursor-pointer items-center justify-between rounded-lg bg-white/[0.02] px-3 text-[0.6875rem] text-zinc-500 transition hover:bg-white/[0.05] hover:text-zinc-300">
                    <span>Prompt only</span>
                    <span className="text-rose-400">+ Add image</span>
                    <input type="file" accept={mediaKind === 'video' ? 'video/mp4,video/webm,video/quicktime' : 'image/png,image/jpeg,image/webp'} className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) attachTo(it.id, f); }} />
                  </label>
                )}
                {/* The prompt, under the picture rather than over it: an overlay would cover the
                    thing you are looking at, and this text is read deliberately, not glanced at.
                    Click to copy -- reusing a prompt is the reason to look at one. */}
                {/* A row with NO prompt gets a muted line rather than nothing. Blank is
                    ambiguous -- it reads as "the feature is broken" when the truth is "this
                    picture was added before prompts were saved". */}
                {showPrompts && !withPrompt && !(it.prompt || '').trim() && (thumbs[it.id] || it.url) && (
                  <p className="mt-1 rounded-md bg-black/20 px-2 py-1 text-[0.625rem] italic text-zinc-600">
                    no prompt saved for this one
                  </p>
                )}
                {showPrompts && !withPrompt && (it.prompt || '').trim() && (
                  <div className="mt-1 rounded-md bg-black/40 px-2 py-1.5">
                    {/* Clamped to three lines until asked. A Kyros prompt runs to a couple of
                        thousand characters, so showing it all by default would bury the pictures --
                        but three lines is a teaser, not a read, so expanding has to be one click. */}
                    <p
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenPrompts((cur) => {
                          const next = new Set(cur);
                          if (next.has(it.id)) next.delete(it.id); else next.add(it.id);
                          return next;
                        });
                      }}
                      title={openPrompts.has(it.id) ? 'Click to collapse' : 'Click to read it all'}
                      className={cn('cursor-pointer text-[0.625rem] leading-snug text-zinc-400 transition hover:text-zinc-200',
                        openPrompts.has(it.id) ? 'max-h-64 overflow-y-auto' : 'line-clamp-3')}
                    >
                      {it.prompt.trim()}
                    </p>
                    <span className="mt-1 flex items-center gap-2">
                      <button type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard?.writeText(it.prompt.trim());
                          notify('Prompt copied', 'success');
                        }}
                        className="text-[0.5625rem] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-200 cursor-pointer">
                        Copy
                      </button>
                      {/* REUSE IT. Seeing a result you like and wanting another is the whole reason
                          to read a prompt, and retyping it by hand was the only way. Lands in the
                          Generate tab's instruction box. */}
                      <button type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          try { window.sessionStorage.setItem('kyros.reusePrompt', it.prompt.trim()); } catch { /* private mode */ }
                          window.dispatchEvent(new CustomEvent('kyros:reuse-prompt', { detail: { prompt: it.prompt.trim() } }));
                          notify('Prompt sent to Generate', 'success');
                        }}
                        className="text-[0.5625rem] font-semibold uppercase tracking-wider text-rose-400/80 hover:text-rose-300 cursor-pointer">
                        Use in Generate
                      </button>
                      {/* Find every other picture made from the same idea. */}
                      <button type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPromptQuery(it.prompt.trim().split(/\s+/).slice(0, 4).join(' '));
                        }}
                        title="Find other images with a similar prompt"
                        className="text-[0.5625rem] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-200 cursor-pointer">
                        Similar
                      </button>
                    </span>
                  </div>
                )}
                <button onClick={() => removeItem(it.id)} title="Delete"
                  className="absolute right-1 top-1 h-6 w-6 rounded-full bg-black/70 text-xs text-zinc-300 hover:text-red-400 cursor-pointer">×</button>
                {(thumbs[it.id] || it.url) && (
                  <button onClick={() => download(it)} title="Download"
                    className="absolute right-8 top-1 h-6 w-6 rounded-full bg-black/70 text-xs text-zinc-300 hover:text-white cursor-pointer">↓</button>
                )}
                {/* A 16px checkbox on a 320px tile is a pixel hunt. The padded label gives it a
                    32px hit area without making the box itself huge, and the whole strip is
                    clickable rather than just the square (owner, 2026-08-08). */}
                <label title="Select"
                  className="absolute left-0 top-0 flex h-9 w-9 cursor-pointer items-center justify-center rounded-tl-lg">
                  <input type="checkbox" checked={selected.includes(it.id)}
                    onChange={() => toggleSelect(it.id)}
                    className="h-5 w-5 cursor-pointer accent-rose-500" />
                </label>
                {oldestFirst && visible[0]?.id === it.id && (
                  <span className="absolute left-1 top-1 rounded-md bg-rose-500 px-1.5 py-0.5 text-[0.5625rem] font-bold text-white">BASE</span>
                )}
                {/* Favorite star — top strip, beside the select checkbox (left-1). Kept OUT of the
                    bottom strip on purpose: a video card's native controls live there, so bottom
                    placement would fight the scrubber on the clips tab. Clear of delete/download
                    (top-right) and the duration badge (bottom-left). Rose+filled when favorited,
                    muted outline otherwise. A real button, so it is keyboard-focusable and toggles
                    on Enter/Space; title states the action for screen readers. */}
                <button
                  // Pure favorite toggle: stopPropagation + preventDefault so the click only stars the
                  // item — never bubbles to the card's drag/drop handlers or the window drop handler,
                  // and never triggers a default. This is the click the user said "did nothing".
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleFavorite(it); }}
                  aria-pressed={favIds.has(it.id)}
                  title={favIds.has(it.id) ? 'Remove from favorites' : 'Mark as favorite'}
                  className={cn('absolute left-8 top-1 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 transition cursor-pointer',
                    favIds.has(it.id) ? 'text-rose-400' : 'text-zinc-300 hover:text-rose-300')}
                >
                  <StarIcon filled={favIds.has(it.id)} />
                </button>
              </div>

              {/* Outfits only: the back-view crop, alongside the front picture above rather than
                  replacing it. See attachBackTo / store.setBackImage — generation picks whichever
                  matches the selected pose's view. */}
              {describeKind === 'outfit' && (
                backThumbs[it.id] ? (
                  <div className="relative">
                    <img src={backThumbs[it.id]} alt="Back view" className="w-full rounded-lg bg-zinc-950 object-contain" style={{ maxHeight: 120 }} />
                    <span className="absolute bottom-1 left-1 rounded bg-black/80 px-1.5 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wide text-zinc-300">Back view</span>
                    <label className="absolute right-1 top-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-black/70 text-xs text-zinc-300 hover:text-rose-300" title="Replace back view">
                      ↻
                      <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) attachBackTo(it.id, f); }} />
                    </label>
                  </div>
                ) : (
                  <label className="flex h-9 cursor-pointer items-center justify-between rounded-lg bg-white/[0.02] px-3 text-[0.6875rem] text-zinc-500 transition hover:bg-white/[0.05] hover:text-zinc-300">
                    <span>No back view</span>
                    <span className="text-rose-400">+ Add back view</span>
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) attachBackTo(it.id, f); }} />
                  </label>
                )
              )}

              {withPrompt && (
                <Input
                  value={it.name || ''}
                  placeholder="Title — what the shot is"
                  onChange={(e) => store.updateItem(it.id, { name: e.target.value }).then(refresh)}
                  className="!py-1 !text-[0.75rem] !font-semibold"
                />
              )}
              {autoBlur && thumbs[it.id] && !it.url && (
                <div className="grid grid-cols-2 gap-1">
                  <Btn variant="secondary" className="!w-full !rounded-lg !py-1 !px-0 !text-[0.6875rem]"
                    disabled={blurring} onClick={() => blurOne(it)}>
                    Retry blur
                  </Btn>
                  <Btn variant="secondary" className="!w-full !rounded-lg !py-1 !px-0 !text-[0.6875rem]"
                    onClick={() => setHandBlur(it)}>
                    Blur by hand
                  </Btn>
                </div>
              )}
              {/* Swap the picture without losing the prompt written beside it. */}
              {(thumbs[it.id] || it.url) && (
                <Btn variant="secondary" className="!w-full !rounded-lg !py-1 !text-[0.6875rem]"
                  onClick={() => openLibrary(it.id)}>
                  {mediaKind === 'video' ? 'Change video · from Gallery' : 'Change image · from Gallery'}
                </Btn>
              )}
              {autoBlur && it.blurred !== undefined && (
                <Btn variant="ghost" className="!w-full !rounded-lg !py-1 !text-[0.6875rem]"
                  onClick={() => toggleBlurred(it)}>
                  {it.blurred ? 'Showing blurred · use original' : 'Showing original · use blurred'}
                </Btn>
              )}
              {withPrompt && describeKind && (thumbs[it.id] || it.url) && (
                <Btn variant="secondary" className="!w-full !rounded-lg !py-1 !text-[0.6875rem]"
                  disabled={describing[it.id]} onClick={() => describeAuto(it.id, thumbs[it.id])}>
                  {describing[it.id] ? 'Reading…' : it.prompt ? 'Re-describe with AI' : 'Describe with AI'}
                </Btn>
              )}
              {/* front/back/closeup — shows what generation will actually pick the outfit crop
                  by (see readPoseView in EddyGeneratePage). "Retry label" re-classifies WITHOUT
                  touching the description above (labelOneView / mergePoseView), unlike
                  Re-describe with AI which rewrites everything. */}
              {/* OUTFITS get the same three buttons, for the same reason the Pose tab needed them:
                  the automatic answer is a guess you cannot see. Shown regardless of prompt text,
                  because an outfit's prompt is routinely empty and that is not a problem here. */}
              {describeKind === 'outfit' && (thumbs[it.id] || it.url) && (
                <div className="flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1">
                  {['front', 'back', 'closeup'].map((v) => (
                    <button key={v} type="button" onClick={() => setOutfitView(it, v)}
                      title={it.poseView === v ? `Clear this label — fall back to the folder` : `Mark this outfit as ${v}`}
                      className={cn('rounded px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide transition cursor-pointer',
                        it.poseView === v ? 'bg-blue-500/25 text-blue-200' : 'text-zinc-600 hover:text-zinc-300')}>
                      {v === 'closeup' ? 'close-up' : v}
                    </button>
                  ))}
                  {!it.poseView && <span className="ml-0.5 text-[0.625rem] text-zinc-600">from folder</span>}
                </div>
              )}
              {withPrompt && describeKind === 'pose' && !isPosePromptBroken(it.prompt) && it.prompt?.trim() && (thumbs[it.id] || it.url) && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1">
                  {/* SET IT BY HAND. The AI label was the only way to set this, and it is a paid
                      call whose answer you cannot see before it lands. On a shot that is borderline
                      between a crop and a whole scene it is close to a coin flip, and the cost of a
                      wrong one is a full-body garment on a close-up. Three buttons cost nothing and
                      are certain.
                      setPoseView writes ONLY pose_action.view (mergePoseView) -- the description
                      above is never touched, unlike Re-describe with AI which rewrites the lot. */}
                  <span className="flex items-center gap-1">
                    {['front', 'back', 'closeup'].map((v) => {
                      const active = hasPoseView(it.prompt) && readPoseView(it.prompt) === v;
                      return (
                        <button key={v} type="button" onClick={() => setPoseView(it, v)}
                          disabled={labelingOne[it.id]}
                          title={`Mark this pose as ${v}`}
                          className={cn('rounded px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide transition cursor-pointer disabled:opacity-40',
                            active ? 'bg-blue-500/25 text-blue-200' : 'text-zinc-600 hover:text-zinc-300')}>
                          {v === 'closeup' ? 'close-up' : v}
                        </button>
                      );
                    })}
                    {!hasPoseView(it.prompt) && <span className="ml-0.5 text-[0.625rem] text-amber-400/80">unlabeled</span>}
                  </span>
                  <button className="text-[0.6875rem] text-zinc-500 hover:text-blue-300 cursor-pointer disabled:opacity-40"
                    disabled={labelingOne[it.id]} onClick={() => retryLabelOne(it)}>
                    {labelingOne[it.id] ? 'Labelling…' : 'Ask AI'}
                  </button>
                </div>
              )}
              {/* A pose whose saved prompt yields no pose_action.description is silently dropped
                  from the generation prompt. Without this the card looks fine — it shows a
                  plausible block of JSON in the box below — and the only symptom is that the pose
                  never comes out. Said on the card, next to the text it is talking about, with
                  the fix named. Nothing is deleted or rewritten: the text stays exactly as saved
                  so the original wording is never lost. */}
              {withPrompt && describeKind === 'pose' && isPosePromptBroken(it.prompt) && (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[0.6875rem] leading-snug text-amber-200">
                  Prompt unreadable — no pose can be read out of it, so generations use this
                  card’s image only. {(thumbs[it.id] || it.url) ? 'Press “Re-describe with AI” above to rewrite it.' : 'Attach the pose image, then press “Describe with AI”.'}
                </p>
              )}
              {withPrompt && (
                <Textarea
                  key={`${it.id}-${it.prompt}`}
                  rows={3}
                  defaultValue={it.prompt}
                  placeholder={`Paste the ${promptLabel} prompt here…`}
                  onBlur={(e) => { if (e.target.value !== it.prompt) savePrompt(it.id, e.target.value); }}
                  className="!text-xs"
                />
              )}
              {withVideoPrompt && (
                <Textarea
                  defaultValue={it.videoPrompt || ''}
                  rows={2}
                  placeholder="Video prompt — how this shot moves"
                  onBlur={(e) => store.updateItem(it.id, { videoPrompt: e.target.value }).then(refresh)}
                  className="!text-[0.6875rem]"
                />
              )}

              {folders.length > 0 && (
                <select
                  value={it.folderId || ''}
                  onChange={(e) => moveItem(it.id, e.target.value || null)}
                  className="w-full rounded-lg border border-white/[0.06] bg-[#0b0b0f] px-2 py-1 text-[0.6875rem] text-zinc-300 outline-none cursor-pointer"
                >
                  <option value="">No {folderLabel.toLowerCase()}</option>
                  {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Nothing is hidden — only unmounted. The count names the true total, so a big folder never
          looks truncated. Sits AFTER the empty/grid ternary rather than inside it. */}
      {visible.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + COLLECTION_PAGE)}
          className="mt-3 w-full rounded-xl border border-zinc-700/60 bg-white/[0.02] py-2.5 text-sm font-semibold text-zinc-300 transition hover:border-zinc-500 cursor-pointer"
        >
          Show {Math.min(COLLECTION_PAGE, visible.length - shown)} more
          <span className="ml-2 font-normal text-zinc-500">
            {shown.toLocaleString()} of {visible.length.toLocaleString()} shown
          </span>
        </button>
      )}

      {handBlur && (
        <BlurByHand
          src={thumbs[handBlur.id]}
          onClose={() => setHandBlur(null)}
          onApply={async (dataUrl) => {
            try {
              await store.setImageKeepingAlt(handBlur.id, dataUrl);
              await store.updateItem(handBlur.id, { blurred: true });
              await refresh();
              notify('Blurred', 'success');
            } catch (err) {
              notify(err.message || 'Could not save that', 'error');
            }
          }}
        />
      )}

      {/* LARGE VIEW. Deliberately view-only — every action already lives on the card behind it, and
          a second set here would be two places to keep in step. Dismisses on the backdrop, on ×,
          and on Escape; arrows step through the CURRENT filter. */}
      {lightboxId && (() => {
        const it = visible.find((x) => x.id === lightboxId);
        // NOT `if (!src) return null`. That made a click on an item whose picture cannot load do
        // absolutely nothing — no overlay, no message — which is indistinguishable from the click
        // not registering at all (owner, 2026-08-09: "i click picture nothing open"). The overlay
        // opens either way and says what is wrong, so the click always has a visible result.
        if (!it) return null;
        const src = thumbs[it.id] || it.url || '';
        const i = visible.findIndex((x) => x.id === lightboxId);
        /**
         * PORTALLED to <body>, like the Generate page's large view.
         *
         * `position: fixed` anchors to the nearest ancestor carrying a transform, filter or
         * backdrop-filter — NOT the viewport. This page sits inside such an ancestor, so the
         * overlay was positioned against the scrolled grid instead: it opened somewhere down the
         * page and had to be scrolled to (owner, 2026-08-09). A portal takes it out of that
         * subtree entirely, which is why the Generate page never had this.
         */
        return createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
            // Backdrop-only: the check keeps a click that STARTED on the image from closing when
            // the pointer drifts off it, which makes a large view feel broken.
            onClick={(e) => { if (e.target === e.currentTarget) setLightboxId(''); }}
          >
            {src ? (
              <img src={src} alt={it.name} draggable={false}
                onPointerDown={onPointerDown} onPointerUp={onPointerUp}
                onClick={(e) => e.stopPropagation()}
                className="max-h-full max-w-full select-none rounded-xl object-contain" />
            ) : (
              <div onClick={(e) => e.stopPropagation()}
                className="max-w-sm rounded-xl border border-amber-500/40 bg-amber-500/[0.08] p-6 text-center">
                <p className="text-sm font-semibold text-amber-200">Image not on this machine</p>
                <p className="mt-2 text-xs text-zinc-400">
                  This card stores a link to a picture in another gallery, so there is nothing here to show.
                  Arrows and swipe still work — use “Remove unloadable” in the toolbar to clear cards like this.
                </p>
              </div>
            )}

            <button type="button" onClick={() => setLightboxId('')} aria-label="Close"
              className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-lg text-white hover:bg-white/20 cursor-pointer">×</button>

            {i > 0 && (
              <button type="button" onClick={() => stepLightbox(-1)} aria-label="Previous"
                className="absolute left-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-xl text-white hover:bg-white/20 cursor-pointer">‹</button>
            )}
            {i < visible.length - 1 && (
              <button type="button" onClick={() => stepLightbox(1)} aria-label="Next"
                className="absolute right-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-xl text-white hover:bg-white/20 cursor-pointer">›</button>
            )}

            <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-zinc-300">
              {i + 1} / {visible.length}{it.name ? ` · ${it.name}` : ''} — Esc to close, ← → or swipe
            </span>
          </div>,
          document.body,
        );
      })()}
    </div>
  );
}
