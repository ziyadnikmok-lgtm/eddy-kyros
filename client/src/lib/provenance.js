/**
 * What made a picture, and whether we have already made it.
 *
 * Kept pure and separate from the page so it can be executed in a check file without React or
 * IndexedDB. The duplicate guard decides whether money is spent, so it has to be testable on its
 * own rather than only through a running app.
 *
 * IMPORTANT: the seed is RANDOM. server/services/wavespeedService.js sends `seed: -1` because Eddy
 * never passes one, so the same recipe run twice produces two DIFFERENT pictures. A "duplicate"
 * here therefore means "already generated from this recipe", never "you already have this image".
 * Every message shown to the user must say recipe, and skipping must always be overridable.
 */

/** Join with a separator that cannot appear in an id, so two fields cannot blur into one. */
const SEP = '';

/**
 * The identity of a generation request: same key, same recipe.
 *
 * Built from explicit ids rather than the prompt text, so rewording a prompt template does not
 * orphan every existing key. Fields are always written in the same order and missing ones become
 * '', which keeps the key stable rather than embedding the string "undefined".
 */
export function comboKey({ basePhotoId, baseId, poseId, outfitId, engine, resolution } = {}) {
  // basePhotoId and baseId are tagged, not merged: they come from different collections and the
  // same id string could legitimately appear in both.
  return [
    `bp:${basePhotoId || ''}`,
    `bi:${baseId || ''}`,
    `po:${poseId || ''}`,
    `ou:${outfitId || ''}`,
    `en:${engine || ''}`,
    `re:${resolution || ''}`,
  ].join(SEP);
}

/**
 * A key for a row that predates comboKey.
 *
 * The 627 existing images have no ids but they do have prompts, and an identical recipe produces
 * an identical prompt string. Without this the guard does nothing until the Library turns over.
 *
 * Empty in, empty out -- an empty prompt must not become a key that matches every other empty one.
 */
export function promptKey(prompt) {
  return String(prompt || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Both indexes in one pass over the Library. */
export function buildSeenKeys(rows) {
  const combos = new Set();
  const prompts = new Set();
  for (const r of rows || []) {
    if (r?.comboKey) combos.add(r.comboKey);
    // Only for rows with no key: a keyed row is already covered, and adding its prompt as well
    // would make an edited prompt look like a second recipe.
    else if (r?.prompt) {
      const k = promptKey(r.prompt);
      if (k) prompts.add(k);
    }
  }
  return { combos, prompts };
}

/**
 * Split a planned batch into what is new and what already exists.
 *
 * A combo whose prompt cannot be built is KEPT, never skipped: failing to generate something the
 * owner asked for is worse than generating a second copy, and a thrown promptFor is a bug in the
 * caller rather than evidence the image exists.
 */
export function splitBySeen(combos, seen, { engine, resolution, promptFor } = {}) {
  const fresh = [];
  const skipped = [];
  for (const c of combos || []) {
    const key = comboKey({ ...c, engine, resolution });
    if (seen?.combos?.has(key)) { skipped.push(c); continue; }
    let pk = '';
    try { pk = promptKey(promptFor ? promptFor(c) : ''); } catch { pk = ''; }
    if (pk && seen?.prompts?.has(pk)) { skipped.push(c); continue; }
    fresh.push(c);
  }
  return { fresh, skipped };
}

/**
 * What today's images cost, summed from the Library itself.
 *
 * Derived, not counted in a running total, so it survives a reload and cannot drift. A row with no
 * price contributes nothing instead of NaN-ing the whole sum.
 */
export function spendToday(rows, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const from = start.getTime();
  let total = 0;
  for (const r of rows || []) {
    const at = Number(r?.createdAt);
    const price = Number(r?.price);
    if (Number.isFinite(at) && at >= from && Number.isFinite(price)) total += price;
  }
  return total;
}
