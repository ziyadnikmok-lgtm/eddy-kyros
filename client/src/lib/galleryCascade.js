/**
 * Delete a gallery image EVERYWHERE, not just from the gallery.
 *
 * Eddy's collections do not hold image bytes for generated results — they hold a URL pointing at
 * `/api/gallery/<id>/image`. So removing an image on the Library page deleted the file and the
 * gallery row, and left the Eddy Library, Base Library, Outfit, Pose and Character collections
 * holding rows whose picture no longer resolves: a tile that renders as a broken box, still
 * counted, still selectable, still generatable from (owner, 2026-08-10).
 *
 * The gallery id is the join key, and it appears in the row's `url`. Nothing else links the two
 * sides, which is also why this cannot be done on the server: those collections live in the
 * browser's IndexedDB and the server cannot see them.
 *
 * DELIBERATELY BEST-EFFORT. The gallery delete has already happened by the time this runs, so a
 * failure here must not present as "delete failed" — the picture IS gone. It reports what it
 * cleaned so the caller can say so, and swallows a collection it cannot open rather than aborting
 * the ones it can.
 */
import { createEddyCollection } from './eddyCollectionStore';

// Every collection whose rows can point at a gallery URL. Kept as one list so a new collection is
// added in one place rather than being quietly missed by the cascade.
export const CASCADE_COLLECTIONS = [
  'eddy-library',
  'eddy-base',
  'eddy-outfit',
  'eddy-pose',
  'eddy-character',
];

/**
 * Does this row point at one of the ids being deleted?
 *
 * Matched on the id as a PATH SEGMENT (`/gallery/<id>/`), not with a substring test. Gallery ids
 * are generated strings and a short one can appear inside a longer one — `abc` inside `abc123` —
 * which would delete a row that has nothing to do with the image being removed. A cascade that
 * over-deletes is far worse than one that misses.
 */
export function rowMatchesGalleryId(url, idSet) {
  const m = /\/gallery\/([^/?#]+)\//.exec(String(url || ''));
  return !!m && idSet.has(m[1]);
}

/**
 * @param {string[]} galleryIds  ids just removed from the server gallery
 * @returns {Promise<{removed: number, byCollection: Record<string, number>, failed: string[]}>}
 */
export async function cascadeDeleteFromCollections(galleryIds) {
  const ids = new Set((galleryIds || []).map(String).filter(Boolean));
  const result = { removed: 0, byCollection: {}, failed: [] };
  if (!ids.size) return result;

  await Promise.all(CASCADE_COLLECTIONS.map(async (name) => {
    try {
      const store = createEddyCollection(name);
      const items = await store.listItems();
      const doomed = items.filter((it) => rowMatchesGalleryId(it.url, ids));
      if (!doomed.length) return;
      // Sequential: removeItem rewrites the whole index each call, and the store serialises writes
      // anyway. Firing them in parallel just queues them behind each other with more moving parts.
      for (const it of doomed) {
        // eslint-disable-next-line no-await-in-loop -- see above
        await store.removeItem(it.id);
      }
      result.byCollection[name] = doomed.length;
      result.removed += doomed.length;
    } catch {
      // One unreadable collection must not stop the others. Named in the result so the caller can
      // say "cleaned 3 of 5" instead of implying everything was reached.
      result.failed.push(name);
    }
  }));

  return result;
}
