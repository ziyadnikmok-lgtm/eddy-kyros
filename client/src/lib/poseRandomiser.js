/**
 * "I write a number of how many poses i want, choose the labels i want, click randomise" — the draw.
 *
 * Kept out of the page and pure, because everything worth getting right here is arithmetic on a
 * list, and none of it needs a browser to prove.
 *
 * The two rules that are not obvious from the ask:
 *
 *  1. It draws from what the grid is CURRENTLY SHOWING, never the whole collection. Select all is
 *     already scoped that way, for the reason written beside it: a button that picks items the grid
 *     is not showing "would silently add poses from a folder you filtered out". A randomiser that
 *     ignored the folder chip would be the same bug with a shuffle in front of it.
 *  2. Asking for more than exist is not an error and is not silently satisfied. It returns
 *     everything eligible and the caller reports the shortfall — typing 30 and receiving 4 with no
 *     explanation is the failure mode worth designing against.
 */

/**
 * The subset of `visible` a draw is allowed to pick from.
 *
 * TWO FAMILIES OF FILTER, AND THEY COMBINE DIFFERENTLY. This is the part worth getting right.
 *
 *   * WITHIN a family it is OR. front+back means "front or back", because a pose has exactly one
 *     view and an AND there can never match anything. Same for tags: "the labels of poses i want"
 *     reads as any-of.
 *   * ACROSS families it is AND. back + mirror selfie means "back-facing mirror selfies" — the
 *     query that is actually useful. Thrown into one OR bucket it would mean "everything back, plus
 *     everything mirror", which is close to no filter at all and looks broken.
 *
 * An empty family is not a filter: no views picked means any view, no tags picked means any tags
 * (including none). That is the plain "give me 12 random poses" case.
 *
 * Untagged poses drop out the moment a tag is chosen — they are not what was asked for. Views need
 * no such rule: readPoseView answers 'front' for an unlabelled card, which is how the rest of the
 * app already treats it.
 */
export function eligiblePoses(visible, { tags = [], views = [] } = {}, { readTags, readView } = {}) {
  const rows = Array.isArray(visible) ? visible : [];
  const wantTags = (Array.isArray(tags) ? tags : []).filter(Boolean);
  const wantViews = (Array.isArray(views) ? views : []).filter(Boolean);
  if (!wantTags.length && !wantViews.length) return rows;

  return rows.filter((row) => {
    if (wantTags.length) {
      const has = readTags ? readTags(row?.prompt) : [];
      if (!wantTags.some((t) => has.includes(t))) return false;
    }
    if (wantViews.length) {
      const v = readView ? readView(row?.prompt) : 'front';
      if (!wantViews.includes(v)) return false;
    }
    return true;
  });
}

/**
 * How many poses each chip would give you — the number printed on the chip itself.
 *
 * CONTEXTUAL, NOT ABSOLUTE, and that is the whole point. A chip that always showed its own total
 * would promise a number you cannot get: with "mirror selfie" already on, a BACK chip reading 12
 * is a lie, because clicking it yields the 2 poses that are both. So each chip is counted against
 * the CURRENT state of the OTHER family.
 *
 * Within its own family a chip ignores its siblings, because that family is an OR — adding a second
 * view can only grow the pool, so counting "front" against "back" would understate it.
 *
 * Counted over `visible`, so a folder chip or the Favorite filter is already reflected. Every
 * number on screen is therefore the number you would actually draw from.
 */
export function chipCounts(visible, { tags = [], views = [] } = {}, readers = {}, vocab = {}) {
  const counts = { tags: {}, views: {} };
  for (const tag of vocab.tags || []) {
    counts.tags[tag] = eligiblePoses(visible, { tags: [tag], views }, readers).length;
  }
  for (const view of vocab.views || []) {
    counts.views[view] = eligiblePoses(visible, { tags, views: [view] }, readers).length;
  }
  return counts;
}

/**
 * N ids drawn at random, without replacement.
 *
 * Fisher-Yates over a COPY — shuffling the caller's array would reorder the grid as a side effect of
 * pressing a button. `rand` is injected so the suite can assert the draw itself rather than
 * assert that shuffling is random, which is not a thing a test can do.
 */
export function drawPoses(pool, n, rand = Math.random) {
  const rows = Array.isArray(pool) ? pool : [];
  const want = Math.floor(Number(n));
  if (!rows.length || !Number.isFinite(want) || want < 1) return [];

  const ids = rows.map((r) => r.id);
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, Math.min(want, ids.length));
}

/**
 * What the row beside the button says, before and after the draw.
 *
 * Returns the pieces rather than a sentence so the page owns its own wording, and so the shortfall
 * is a boolean the UI can colour rather than a phrase it has to parse back out of a string.
 */
export function describeDraw(wanted, poolSize, outfitCount) {
  const want = Math.max(0, Math.floor(Number(wanted)) || 0);
  const taking = Math.min(want, poolSize);
  return {
    taking,
    poolSize,
    short: want > poolSize,
    // Eddy is a cross product: this is where a 30-pose draw quietly becomes 300 images. Shown at
    // the point of the click rather than at the confirm dialog.
    images: taking * Math.max(1, outfitCount || 0),
  };
}
