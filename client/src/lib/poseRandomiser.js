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
 * THE CHIPS ARE EXCLUSIONS (owner, 2026-08-14: "choosing which label you don't want"). Ticking one
 * REMOVES those poses. Nothing ticked means the whole grid is eligible, which is the important
 * property of this direction: the useful default costs no clicks, and you only touch a chip to
 * carve something out.
 *
 * A pose is dropped if it matches ANY ticked chip, in EITHER family. Excluding "mirror selfie" and
 * "front" leaves the poses that are neither. There is no across-family subtlety here the way there
 * was for inclusion, because "remove this, and also remove that" only ever means one thing.
 *
 * A pose with no view label counts as front — readPoseView's own default, and how the rest of the
 * app already treats it — so excluding front excludes unlabelled cards too. An untagged pose is
 * never removed by a tag exclusion, because it does not carry that tag.
 */
export function eligiblePoses(visible, { tags = [], views = [] } = {}, { readTags, readView } = {}) {
  const rows = Array.isArray(visible) ? visible : [];
  const dropTags = (Array.isArray(tags) ? tags : []).filter(Boolean);
  const dropViews = (Array.isArray(views) ? views : []).filter(Boolean);
  if (!dropTags.length && !dropViews.length) return rows;

  return rows.filter((row) => {
    if (dropTags.length) {
      const has = readTags ? readTags(row?.prompt) : [];
      if (dropTags.some((t) => has.includes(t))) return false;
    }
    if (dropViews.length) {
      const v = readView ? readView(row?.prompt) : 'front';
      if (dropViews.includes(v)) return false;
    }
    return true;
  });
}

/**
 * The number printed on each chip: HOW MANY POSES THAT CHIP COSTS YOU.
 *
 * MARGINAL, not absolute, and measured against everything else currently ticked. The number is the
 * difference the chip makes right now — flip it and the pool changes by exactly this much.
 *
 *   * unticked -> how many more you would lose by ticking it
 *   * ticked   -> how many you would get back by unticking it
 *
 * One definition serves both, which is why it is written as a difference rather than a count.
 *
 * WHY NOT JUST "how many poses carry this label": overlap. With "mirror selfie" already excluded, a
 * FRONT chip showing every front pose overstates its cost, because the front mirror selfies are
 * already gone. Ticking it would remove fewer than the number promised, and two chips would appear
 * to remove more between them than the grid contains.
 *
 * Measured over `visible`, so a folder chip or the Favorite filter is already reflected.
 */
export function chipCounts(visible, { tags = [], views = [] } = {}, readers = {}, vocab = {}) {
  const on = { tags: (tags || []).filter(Boolean), views: (views || []).filter(Boolean) };
  const sizeOf = (sel) => eligiblePoses(visible, sel, readers).length;
  const without = (list, v) => list.filter((x) => x !== v);
  const withOne = (list, v) => (list.includes(v) ? list : [...list, v]);

  const counts = { tags: {}, views: {} };
  for (const tag of vocab.tags || []) {
    counts.tags[tag] = sizeOf({ ...on, tags: without(on.tags, tag) })
      - sizeOf({ ...on, tags: withOne(on.tags, tag) });
  }
  for (const view of vocab.views || []) {
    counts.views[view] = sizeOf({ ...on, views: without(on.views, view) })
      - sizeOf({ ...on, views: withOne(on.views, view) });
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
