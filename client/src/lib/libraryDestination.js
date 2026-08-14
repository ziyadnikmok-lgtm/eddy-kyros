/**
 * "Which library does this run land in?" — chosen BEFORE Generate, on every tab that makes pictures.
 *
 * Eddy Generate and Photo Match SD each grew their own copy of this control. Four more tabs need it
 * — Seedream 5 Pro, Scene Recreate, Pose Remix, Outfit Swap — and those four currently file
 * NOWHERE: they generate, the picture lands in the gallery and on the feed, and that is the end of
 * it. Getting anything into a library from them means downloading and re-uploading by hand.
 *
 * Six hand-rolled copies of the same dropdown would drift — different storage keys, different
 * default, one of them forgetting the storage-full check. So the logic lives here once and the
 * pages import it.
 *
 * The pure half is here; the hook and the <select> are in components/LibraryDestinationPicker.jsx,
 * so everything worth asserting can be asserted without a renderer.
 */

export const LIBRARY_DESTS = [
  { db: 'eddy-library', label: 'Library' },
  { db: 'eddy-base', label: 'Base Library' },
];

const KNOWN = new Set(LIBRARY_DESTS.map((d) => d.db));

/**
 * Any stored or user-supplied value, reduced to a destination that definitely exists.
 *
 * Defaults to the normal Library, never Base. A wrong default here is not a small thing: Base
 * Library is the SOURCE collection Max Outfit dresses, so silently filing ordinary results into it
 * pollutes the input set for every later run.
 */
export function normaliseDest(raw) {
  return KNOWN.has(raw) ? raw : 'eddy-library';
}

/** The name to show for a destination — the same words the nav uses for those tabs. */
export function destLabel(db) {
  return LIBRARY_DESTS.find((d) => d.db === normaliseDest(db))?.label || 'Library';
}

/**
 * File one finished picture into a library, into a named folder, and be honest when it fails.
 *
 * TWO FAILURE MODES, DELIBERATELY DIFFERENT:
 *
 *   * ensureFolder failing is survivable — the picture still files at the collection root, which is
 *     findable. Losing the picture to protect its folder would be the wrong trade.
 *   * addItems reports storage-full by RETURNING AN EMPTY ARRAY rather than throwing. Nothing about
 *     that reads as an error at the call site, so every caller that ignores the return value
 *     silently drops pictures and reports success. This throws instead, naming the library, and
 *     says the picture is still in the gallery — because it is, and it is billed either way.
 *
 * `label` is passed in rather than read off the store: createEddyCollection does not expose its own
 * dbName, so deriving it here would silently print "Library" for every destination — including the
 * one case where the message matters most, a Base Library run that did not land.
 *
 * Returns the stored rows on success.
 */
export async function fileIntoLibrary(store, item, { folder = '', label = 'Library' } = {}) {
  if (!store) throw new Error('No library selected');
  if (!item?.url) throw new Error('Nothing to file — the result has no image URL');

  let folderId = null;
  const name = String(folder || '').trim();
  if (name) {
    try { folderId = (await store.ensureFolder(name))?.id || null; } catch { folderId = null; }
  }

  const filed = await store.addItems([item], folderId);
  if (!Array.isArray(filed) || filed.length === 0) {
    throw new Error(`Browser storage is full — the picture is in the gallery but not in ${label}`);
  }
  return filed;
}

/**
 * A stable, sortable, collision-free card name.
 *
 * `${prefix}-${Date.now()}` is what the earlier tabs used and it collides the moment two results
 * from one run land in the same millisecond, which a concurrency-2 queue does routinely. The index
 * makes each one distinct without needing a counter threaded through the caller.
 */
export function cardName(prefix, index = 0) {
  return `${prefix}-${Date.now()}-${index}`;
}
