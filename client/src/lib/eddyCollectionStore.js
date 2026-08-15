import { createPageStore } from './pageStateStore';

/**
 * A self-contained image collection with folders — Eddy's own storage.
 *
 * Deliberately NOT the main gallery: Eddy's Library and Outfit hold only what you put in them.
 * Each collection is its own IndexedDB database, so Library and Outfit can never see each
 * other's images.
 *
 * Layout inside a collection:
 *   'index'     -> [{ id, name, folderId, createdAt }]  (small — safe to rewrite on any change)
 *   'folders'   -> [{ id, name, createdAt }]
 *   'favorites' -> [id, ...]                             (tiny — a flat list of favorited item ids)
 *   `img:<id>`  -> dataUrl                               (one key per image)
 *
 * The image bytes live under their own key on purpose. Keeping them in the index array would
 * mean rewriting every photo in the collection to add one — the mistake that made other stores
 * slow and lossy here.
 *
 * Favorites live under their OWN tiny key for the same reason — never as a `favorite` field on each
 * index row. The pose index is 96 items and some carry big data, so flipping one star used to
 * rewrite the whole index, which was slow and dropped the flag on reload. A separate flat id list
 * makes a star toggle a tiny write that the index's size can never clobber.
 */
const STORAGE_FULL = 'Browser storage is full — delete some images and try again';

// One instance per database. The write queue below is a closure variable, so two instances
// pointed at the same DB would each have their own queue and clobber each other — which is
// reachable today: Recover creates its own eddy-library handle while the Library page holds
// one. Sharing the instance shares the queue.
const _instances = new Map();

export function createEddyCollection(dbName) {
  const cached = _instances.get(dbName);
  if (cached) return cached;

  const store = createPageStore(dbName);

  // createPageStore.set() reports a quota failure by returning false rather than throwing, so
  // every mutation has to check it. Ignoring it is how an edit can look saved and be gone on
  // reload — the write never happened and refresh() re-reads the old value.
  const write = async (key, value) => {
    const ok = await store.set(key, value);
    if (!ok) throw new Error(STORAGE_FULL);
    return true;
  };
  const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Every index write is read-modify-write, so two overlapping callers can each read the old
  // index and the second overwrites the first's entries. Concurrent generation batches all
  // append to the Library at once, which makes that a real loss, not a theoretical one.
  // Chaining the writes costs nothing and removes the race.
  let chain = Promise.resolve();
  const serialize = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.then(() => {}, () => {});
    return next;
  };

  const impl = {
    async listFolders() {
      const f = await store.get('folders', []);
      return Array.isArray(f) ? f : [];
    },

    /**
     * `parentId` makes folders a tree. It is OPTIONAL and defaults to null, so every folder saved
     * before this existed reads as a root folder and nothing needs migrating.
     *
     * Only the parent link is stored — no path, no child list. A denormalised path would have to be
     * rewritten on every rename and would rot the moment one write failed; children are derived by
     * filtering on parentId, which cannot disagree with itself.
     */
    _createFolder: async function(name, parentId = null) {
      const folders = await impl.listFolders();
      const folder = {
        id: `f-${newId()}`,
        name: String(name || 'Untitled').trim().slice(0, 40),
        parentId: parentId || null,
        createdAt: Date.now(),
      };
      await write('folders', [...folders, folder]);
      return folder;
    },

    /**
     * Find a folder by name or make it — as ONE serialized step. Doing find-then-create from
     * the caller lets two concurrent batches both miss and both create, which is exactly how
     * the duplicate "Grace" folders appeared.
     */
    /**
     * Match is by name WITHIN a parent, not globally: two different parents are each allowed a
     * "Bikini" child, and merging them because the names collide would silently pool unrelated
     * items. A folder saved before parentId existed has none, which reads as null — so the
     * top-level lookup still finds it.
     */
    _ensureFolder: async function(name, parentId = null) {
      const clean = String(name || 'Untitled').trim().slice(0, 40);
      const pid = parentId || null;
      const folders = await impl.listFolders();
      /**
       * Case-INSENSITIVE match, so one character can never end up with two folders.
       *
       * A live Eddy run files under the character's name as typed ("Chloe"). Recovery from the
       * gallery reads her name back off the generation's TAGS -- and galleryManager.save()
       * lowercases every tag -- so it asked for "chloe", missed "Chloe" on an exact compare, and
       * created a second folder beside it. 25 recovered images landed there on 2026-08-15, looking
       * for all the world like they had never come back.
       *
       * That is the ONE FOLDER PER CHARACTER rule, and it is also the rule that recovery must file
       * exactly the way a live run files -- a near-miss folder just moves the problem somewhere
       * less visible. The first folder created keeps its capitalisation; later spellings join it.
       */
      const hit = folders.find((f) => (
        String(f.name).toLowerCase() === clean.toLowerCase() && (f.parentId || null) === pid
      ));
      if (hit) return hit;
      const folder = { id: `f-${newId()}`, name: clean, parentId: pid, createdAt: Date.now() };
      await write('folders', [...folders, folder]);
      return folder;
    },

    /**
     * Re-parent an existing folder — how a collection that was flat before subfolders existed
     * becomes a tree without re-importing anything.
     *
     * Refuses to make a folder its own ancestor. Dropping a parent into its own child would leave
     * both unreachable from the root and give the traversals a cycle to walk; the pass-limited
     * loops elsewhere survive that, but the folders would simply vanish from every view while
     * still sitting in the store. Rejecting the move is the only outcome that keeps them visible.
     */
    _setFolderParent: async function(id, parentId) {
      const pid = parentId || null;
      if (id === pid) return false;
      const folders = await impl.listFolders();
      if (pid) {
        const byId = new Map(folders.map((f) => [f.id, f]));
        let cur = byId.get(pid);
        const seen = new Set();
        while (cur && !seen.has(cur.id)) {
          if (cur.id === id) return false;        // pid sits beneath id — that is the cycle
          seen.add(cur.id);
          cur = cur.parentId ? byId.get(cur.parentId) : null;
        }
      }
      await write('folders', folders.map((f) => (f.id === id ? { ...f, parentId: pid } : f)));
      return true;
    },

    _renameFolder: async function(id, name) {
      const folders = await impl.listFolders();
      await write('folders', folders.map((f) => (f.id === id ? { ...f, name: String(name).trim().slice(0, 40) } : f)));
    },

    // Deleting a folder keeps its images — they fall back to "All", never silently vanish.
    /**
     * Deletes the folder AND every folder beneath it — but never an image.
     *
     * Removing only the named folder left its children pointing at an id that no longer exists:
     * not root, not under anything real, so they and their contents disappeared from the UI while
     * still sitting in the store. Unreachable data is worse than deleted data, because nothing
     * tells you it is there.
     *
     * Items in any removed folder are unfiled (folderId null), matching what deleting a flat
     * folder has always done: the pictures survive, the grouping does not.
     */
    _deleteFolder: async function(id) {
      const [folders, index] = await Promise.all([impl.listFolders(), impl.listItems()]);
      const doomed = new Set([id]);
      // Repeat until nothing new is caught — a tree of any depth settles in a few passes, and
      // this cannot loop forever even if a bad parentId cycle ever got written.
      for (let pass = 0; pass < 50; pass += 1) {
        const before = doomed.size;
        for (const f of folders) if (f.parentId && doomed.has(f.parentId)) doomed.add(f.id);
        if (doomed.size === before) break;
      }
      await write('folders', folders.filter((f) => !doomed.has(f.id)));
      await write('index', index.map((i) => (doomed.has(i.folderId) ? { ...i, folderId: null } : i)));
    },

    async listItems() {
      const idx = await store.get('index', []);
      return Array.isArray(idx) ? idx : [];
    },

    async getImage(id) {
      return store.get(`img:${id}`, '');
    },

    /**
     * WHICH rows have a picture stored here — read from the key list, so it costs no bytes.
     *
     * A row either carries its own image (`img:<id>`) or points at one the server already holds
     * (`url` on the index row, nothing stored here). Asking `getImage` to tell them apart means
     * paying a read per row to be told "nothing", and the Eddy Library is 2,298 rows of exactly
     * that: every single one is server-backed, so every single read came back empty after ~34 ms.
     * That is the wait when the Library opens (owner, 2026-08-15).
     *
     * Returns { front, back } — `back` is the outfit back-crop under `img:<id>:back`, which the
     * second pump pass would otherwise probe row by row for the same nothing.
     *
     * An id blanked by removeItem keeps its key with an empty value; that row is gone from the
     * index, so nothing ever asks for it.
     */
    async storedImageIds() {
      const keys = await store.keys();
      const front = new Set();
      const back = new Set();
      for (const k of keys) {
        if (typeof k !== 'string' || !k.startsWith('img:')) continue;
        const rest = k.slice(4);
        // Item ids carry no colon, so the suffix is unambiguous: `:alt` and `:preplate` are
        // spare copies nothing renders, and are deliberately not reported.
        if (rest.endsWith(':back')) back.add(rest.slice(0, -5));
        else if (!rest.includes(':')) front.add(rest);
      }
      return { front, back };
    },

    /** Several pictures in ONE transaction — positional, '' where a row has none. */
    async getImages(ids) {
      const vals = await store.getMany(ids.map((id) => `img:${id}`), '');
      return vals.map((v) => v || '');
    },

    /** The same, for outfit back-crops. */
    async getBackImages(ids) {
      const vals = await store.getMany(ids.map((id) => `img:${id}:back`), '');
      return vals.map((v) => v || '');
    },

    // --- Favorites: their own small key, read straight through, never mixed into `index`. ---

    async listFavorites() {
      const f = await store.get('favorites', []);
      return Array.isArray(f) ? f : [];
    },

    async isFavorite(id) {
      const favs = await impl.listFavorites();
      return favs.includes(id);
    },

    // Flip membership and persist ONLY the tiny favorites key — the big `index` is never touched.
    // Serialized through the same write queue as the other mutations (see `api` below) so a rapid
    // double-tap cannot read-modify-write over itself and lose the flip. Returns the NEW boolean so
    // the caller can reflect the star without an extra read. A quota failure throws (write() above),
    // so a favorite that did not persist surfaces instead of silently showing as saved.
    _toggleFavorite: async function(id) {
      const favs = await impl.listFavorites();
      const on = favs.includes(id);
      const next = on ? favs.filter((x) => x !== id) : [...favs, id];
      await write('favorites', next);
      return !on;
    },

    /** items: [{ dataUrl, name, prompt }] — prompt is optional (Pose saves one with the image) */
    _addItems: async function(items, folderId = null) {
      const index = await impl.listItems();
      const added = [];
      let failed = 0;
      // createdAt is what "base image first" sorts on, so a batch must not share one timestamp:
      // Date.now() is millisecond-resolution and several images land inside the same tick,
      // which would make the order of an imported character arbitrary.
      const t0 = Date.now();
      for (const [idx, it] of items.entries()) {
        // A pose may be prompt-only — an item needs an image OR a prompt slot, not both.
        if (!it || (!it.dataUrl && !it.url && it.prompt === undefined)) continue;
        const id = `i-${newId()}`;
        // set() returns false on a quota failure instead of throwing. Skip that ONE item rather
        // than aborting: the index is written once at the end, so throwing here discarded every
        // item in the batch — a 30-row import could vanish because image 29 was too big.
        // Indexing it anyway would be worse: a tile with no bytes behind it, blank forever.
        if (it.dataUrl) {
          const ok = await store.set(`img:${id}`, it.dataUrl);
          if (!ok) { failed += 1; continue; }   // skipped: srcIndex on the rest keeps pairing correct
          // An item blurred on the way in carries its untouched original, so the blur stays
          // reversible and an unblurred copy can still be shared.
          if (it.original) await store.set(`img:${id}:alt`, it.original);
        }
        // An outfit's back-view photo rides in under its own key, exactly where attachBackTo
        // writes it, so an imported outfit arrives with the same two pictures it was exported
        // with. Its failure is non-fatal on purpose: losing the back photo is a degraded outfit,
        // where skipping the item would lose the front one too.
        if (it.backImage) await store.set(`img:${id}:back`, it.backImage);
        // url points at an image the server already stored. Generated pictures use it so a batch of
        // 25 does not pour tens of megabytes into IndexedDB just to be looked at.
        // videoPrompt travels with the item the same way prompt does — without it here, importing
        // a pose sheet (or re-importing an exported one) would silently drop the video prompt even
        // though the importer built it correctly, because this allowlist never carried it through.
        // poseView travels the same way, and for the same reason the note above describes: this is an
          // ALLOWLIST, so a field absent from it is dropped without a word. Max Outfit reads it to match
          // a back shot to a back outfit, and without this line every row would arrive unclassified.
          // PROVENANCE: what made this picture. A field absent from this allowlist is dropped
          // with no error -- see the note above, which is how poseView was nearly lost. comboKey
          // is what the duplicate guard matches on; price is what the spend total sums.
          added.push({ id, srcIndex: idx, name: it.name || 'image', prompt: it.prompt || '', videoPrompt: it.videoPrompt || '', poseView: it.poseView || '', url: it.url || '',
          ...(it.basePhotoId ? { basePhotoId: it.basePhotoId } : {}),
          ...(it.baseId ? { baseId: it.baseId } : {}),
          ...(it.poseId ? { poseId: it.poseId } : {}),
          ...(it.outfitId ? { outfitId: it.outfitId } : {}),
          ...(it.comboKey ? { comboKey: it.comboKey } : {}),
          ...(it.charName ? { charName: it.charName } : {}),
          ...(Number.isFinite(it.price) ? { price: it.price } : {}),
          ...(it.backPrompt ? { backPrompt: it.backPrompt } : {}),
          ...(it.original ? { blurred: true } : {}),
          folderId: folderId || null, createdAt: t0 + added.length });
      }
      if (added.length) {
        // Without the index nothing is visible, so a silent false here is the difference
        // between "imported 30" and a collection that still reads empty.
        await write('index', [...added, ...index]);
      }
      added.failed = failed;
      return added;
    },

    _removeItem: async function(id) {
      const index = await impl.listItems();
      await write('index', index.filter((i) => i.id !== id));
      // No delete-key primitive; blanking releases the bytes and the id is gone from the index.
      await store.set(`img:${id}`, '');
      await store.set(`img:${id}:alt`, '');   // the spare copy goes too, or its bytes linger
      await store.set(`img:${id}:back`, '');  // and the back-view copy, on outfits that have one
      await store.set(`img:${id}:preplate`, ''); // and the pre-white-plate original
    },

    /**
     * Replace the picture and keep the one being replaced under `img:<id>:preplate`.
     *
     * A SEPARATE slot from `:alt`, deliberately. On the Pose tab autoBlur already owns `:alt` — it
     * holds the UNBLURRED original. Writing a plate through setImageKeepingAlt would overwrite that
     * with the blurred copy, so undoing the blur would silently stop working and the unblurred
     * picture would be gone with nothing on screen saying so.
     *
     * Plating replaces curated reference images with paid, generated ones. This slot is what makes
     * that reversible.
     */
    setImageKeepingPreplate: async function(id, dataUrl) {
      const current = await store.get(`img:${id}`, '');
      // Stashed only the FIRST time. Plating twice must not overwrite the true original with an
      // already-plated copy — that turns Revert into a no-op that still reports success.
      const stashed = await store.get(`img:${id}:preplate`, '');
      if (current && !stashed) await write(`img:${id}:preplate`, current);
      await write(`img:${id}`, dataUrl);
      return true;
    },

    /** Put the pre-plate original back and drop the stash. False if there was nothing stashed. */
    restorePreplate: async function(id) {
      const original = await store.get(`img:${id}:preplate`, '');
      if (!original) return false;
      await write(`img:${id}`, original);
      await write(`img:${id}:preplate`, '');
      return true;
    },

    hasPreplate: async function(id) {
      return Boolean(await store.get(`img:${id}:preplate`, ''));
    },

    /**
     * Replace the picture but keep the one being replaced, under `img:<id>:alt`.
     *
     * Blurring is destructive and there was no way back from a bad box. Holding both means the
     * blur can be undone, and an unblurred copy stays available for anyone who wants it.
     */
    async setImageKeepingAlt(id, dataUrl) {
      const current = await store.get(`img:${id}`, '');
      if (current) await write(`img:${id}:alt`, current);
      await write(`img:${id}`, dataUrl);
      return true;
    },

    /** Swap the active picture with the one held alongside it. */
    async swapAlt(id) {
      const [active, alt] = await Promise.all([
        store.get(`img:${id}`, ''),
        store.get(`img:${id}:alt`, ''),
      ]);
      if (!alt) return false;
      await write(`img:${id}`, alt);
      await write(`img:${id}:alt`, active);
      return true;
    },

    async hasAlt(id) {
      return Boolean(await store.get(`img:${id}:alt`, ''));
    },

    /** Attach or replace the picture on an item that already exists (its prompt is kept). */
    async setImage(id, dataUrl) {
      await write(`img:${id}`, dataUrl);
      return true;
    },

    /**
     * The back-view crop of an outfit, held under its own key alongside the front picture in
     * `img:<id>` — a separate slot, not a swap like alt: generation needs BOTH available at once
     * (front by default, back when the picked pose is back-facing — see readPoseView), not one
     * active copy at a time.
     */
    async setBackImage(id, dataUrl) {
      await write(`img:${id}:back`, dataUrl);
      return true;
    },

    async getBackImage(id) {
      return store.get(`img:${id}:back`, '');
    },

    async hasBackImage(id) {
      return Boolean(await store.get(`img:${id}:back`, ''));
    },

    _updateItem: async function(id, patch) {
      const index = await impl.listItems();
      await write('index', index.map((i) => (i.id === id ? { ...i, ...patch } : i)));
    },

    /**
     * Patch MANY items in one index write.
     *
     * updateItem rewrites the whole index per call, so backfilling a field across 522 rows would
     * be 522 read-modify-writes of a list that carries every prompt -- slow, and 522 chances for
     * one to land out of order. This does it once.
     *
     * `patches` is a Map of id -> partial row. Ids not in the index are ignored rather than
     * added: this patches what exists, it is not an upsert.
     */
    _updateItems: async function(patches) {
      const index = await impl.listItems();
      let changed = 0;
      const next = index.map((i) => {
        const patch = patches.get(i.id);
        if (!patch) return i;
        changed += 1;
        return { ...i, ...patch };
      });
      if (changed) await write('index', next);
      return changed;
    },

    _moveItem: async function(id, folderId) {
      const index = await impl.listItems();
      await write('index', index.map((i) => (i.id === id ? { ...i, folderId: folderId || null } : i)));
    },

    async clearAll() {
      await store.clear();
    },
  };

  // Reads pass through; writes queue behind one another.
  const api = {
    ...impl,
    createFolder: (...a) => serialize(() => impl._createFolder.apply(impl, a)),
    ensureFolder: (...a) => serialize(() => impl._ensureFolder.apply(impl, a)),
    renameFolder: (...a) => serialize(() => impl._renameFolder.apply(impl, a)),
    deleteFolder: (...a) => serialize(() => impl._deleteFolder.apply(impl, a)),
    setFolderParent: (...a) => serialize(() => impl._setFolderParent.apply(impl, a)),
    addItems: (...a) => serialize(() => impl._addItems.apply(impl, a)),
    removeItem: (...a) => serialize(() => impl._removeItem.apply(impl, a)),
    updateItem: (...a) => serialize(() => impl._updateItem.apply(impl, a)),
    updateItems: (...a) => serialize(() => impl._updateItems.apply(impl, a)),
    moveItem: (...a) => serialize(() => impl._moveItem.apply(impl, a)),
    toggleFavorite: (...a) => serialize(() => impl._toggleFavorite.apply(impl, a)),
  };

  _instances.set(dbName, api);
  return api;
}
