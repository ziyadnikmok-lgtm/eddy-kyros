/**
 * How several picked pins become one feed.
 *
 * Kept out of the page so the rule that decides what the owner sees first can be executed in a
 * check file without React. Both functions are pure.
 */

/**
 * Deal the sets out like cards: seed 1's first pin, seed 2's first, seed 3's first, then round
 * again.
 *
 * Concatenating instead would put one seed's hundred pins above everything else, and a mix of four
 * picks would only become visible after a lot of scrolling — which reads as "it ignored three of
 * the four I chose". A seed that runs out simply stops being dealt to.
 */
export function interleave(sets) {
  const lists = (sets || []).filter((s) => Array.isArray(s) && s.length);
  const out = [];
  const longest = lists.reduce((m, s) => Math.max(m, s.length), 0);
  for (let i = 0; i < longest; i += 1) {
    for (const list of lists) {
      if (i < list.length) out.push(list[i]);
    }
  }
  return out;
}

/**
 * The pins a Refresh actually uses.
 *
 * Capped at eight: past that the mix stops meaning anything and it is eight simultaneous requests
 * at a service that can rate-limit us. The MOST RECENT are kept, because the last thing ticked is
 * the clearest statement of what is wanted now.
 */
export function topSeeds(picked, max = 8) {
  const all = Array.isArray(picked) ? picked : [];
  return all.slice(Math.max(0, all.length - max));
}
