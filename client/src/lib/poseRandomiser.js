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
 * No tags selected means "anything on screen", which is the plain "give me 12 random poses" case.
 * With tags selected it is a UNION — a pose carrying ANY of them qualifies — because "the labels of
 * poses i want" reads as any-of, and an AND across two labels would usually return nothing.
 * Untagged poses are excluded the moment a tag is chosen: they are not the thing that was asked for.
 */
export function eligiblePoses(visible, tags, readTags) {
  const rows = Array.isArray(visible) ? visible : [];
  const want = (Array.isArray(tags) ? tags : []).filter(Boolean);
  if (!want.length) return rows;
  return rows.filter((row) => {
    const has = readTags(row?.prompt);
    return want.some((t) => has.includes(t));
  });
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
