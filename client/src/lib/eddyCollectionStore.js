import { createPageStore } from './pageStateStore';

/**
 * A self-contained image collection with folders — Eddy's own storage.
 *
 * Deliberately NOT the main gallery: Eddy's Library and Outfit hold only what you put in them.
 * Each collection is its own IndexedDB database, so Library and Outfit can never see each
 * other's images.
 *
 * Layout inside a collection:
 *   'index'    -> [{ id, name, folderId, createdAt }]   (small — safe to rewrite on any change)
 *   'folders'  -> [{ id, name, createdAt }]
 *   `img:<id>` -> dataUrl                                (one key per image)
 *
 * The image bytes live under their own key on purpose. Keeping them in the index array would
 * mean rewriting every photo in the collection to add one — the mistake that made other stores
 * slow and lossy here.
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

    _createFolder: async function(name) {
      const folders = await impl.listFolders();
      const folder = { id: `f-${newId()}`, name: String(name || 'Untitled').trim().slice(0, 40), createdAt: Date.now() };
      await write('folders', [...folders, folder]);
      return folder;
    },

    /**
     * Find a folder by name or make it — as ONE serialized step. Doing find-then-create from
     * the caller lets two concurrent batches both miss and both create, which is exactly how
     * the duplicate "Grace" folders appeared.
     */
    _ensureFolder: async function(name) {
      const clean = String(name || 'Untitled').trim().slice(0, 40);
      const folders = await impl.listFolders();
      const hit = folders.find((f) => f.name === clean);
      if (hit) return hit;
      const folder = { id: `f-${newId()}`, name: clean, createdAt: Date.now() };
      await write('folders', [...folders, folder]);
      return folder;
    },

    _renameFolder: async function(id, name) {
      const folders = await impl.listFolders();
      await write('folders', folders.map((f) => (f.id === id ? { ...f, name: String(name).trim().slice(0, 40) } : f)));
    },

    // Deleting a folder keeps its images — they fall back to "All", never silently vanish.
    _deleteFolder: async function(id) {
      const [folders, index] = await Promise.all([impl.listFolders(), impl.listItems()]);
      await write('folders', folders.filter((f) => f.id !== id));
      await write('index', index.map((i) => (i.folderId === id ? { ...i, folderId: null } : i)));
    },

    async listItems() {
      const idx = await store.get('index', []);
      return Array.isArray(idx) ? idx : [];
    },

    async getImage(id) {
      return store.get(`img:${id}`, '');
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
        // url points at an image the server already stored. Generated pictures use it so a batch of
        // 25 does not pour tens of megabytes into IndexedDB just to be looked at.
        added.push({ id, srcIndex: idx, name: it.name || 'image', prompt: it.prompt || '', url: it.url || '',
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

    _updateItem: async function(id, patch) {
      const index = await impl.listItems();
      await write('index', index.map((i) => (i.id === id ? { ...i, ...patch } : i)));
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
    addItems: (...a) => serialize(() => impl._addItems.apply(impl, a)),
    removeItem: (...a) => serialize(() => impl._removeItem.apply(impl, a)),
    updateItem: (...a) => serialize(() => impl._updateItem.apply(impl, a)),
    moveItem: (...a) => serialize(() => impl._moveItem.apply(impl, a)),
  };

  _instances.set(dbName, api);
  return api;
}
