/**
 * Tag the existing pose library with "mirror selfie" — offline, exact, and free.
 *
 * Same trade this repo already made for poseView (see poseViewBackfill.js): do not pay for a vision
 * pass to answer something the SAVED TEXT already says. Every pose card stores the description it
 * was written with, and a mirror selfie is described as one — "taking a mirror selfie", "phone
 * raised to the mirror", "her reflection in the full-length mirror". Reading the sentence costs
 * nothing and is exact wherever it speaks.
 *
 * It deliberately does NOT answer for cards whose description is silent. Those are left with no
 * tags array at all, which is what the AI pass looks for. A card this function tags is a card the
 * AI never has to be asked about.
 *
 * Returns { patches, stats } and writes nothing; the caller decides.
 */

/**
 * Two conditions, both required: the word, and a sign the photo is being taken INTO it.
 *
 * WHY THE NOUN IS NOT ENOUGH: a mirror being present in the room is not a mirror selfie. "A
 * smoked-mirror wall runs behind the sofa" is a scene description, and tagging it would put a
 * non-selfie into every draw that asks for mirror selfies. So the noun has to sit beside an
 * indicator -- a selfie, a phone, a reflection, or her facing/turning into it.
 *
 * \bmirror\b, word-bounded on BOTH sides, is doing real work: it excludes "mirrored" and
 * "mirroring", which describe a pose copied from a reference and have nothing to do with a mirror.
 *
 * WHY IT ERRS TOWARD SILENCE: the two failures are not symmetrical. A missed card falls through to
 * the AI pass, which answers it for a fraction of a cent -- the safety net this pass was designed
 * against. A wrongly-tagged card is permanent and silent: nothing ever re-reads it, and it turns up
 * in draws asking for mirror selfies forever. So "her reflection" on its own does NOT qualify --
 * a reflection in water, a window or a pool is not this -- and any phrasing that needs a judgement
 * call is left for the AI rather than guessed at here.
 */
const MIRROR_NOUN = /\bmirror\b/i;

const SHOT_INTO_IT = [
  /\bselfie\b/i,
  /\bphone\b/i,
  /\breflect(?:ion|ions|ed|ing)\b/i,
  /\bfacing\b|\bfaces\b/i,              // "facing the mirror", "she faces the mirror"
  /\bin front of\b/i,
  /\binto\b/i,
  /\btowards?\b/i,
];

/**
 * True when this pose description says the photo is a mirror selfie. Exported so the check suite
 * and any future caller ask the identical question — a second copy of these patterns would drift
 * from the ones that actually tagged the library.
 */
export function readsAsMirrorSelfie(description) {
  const s = String(description || '');
  if (!s.trim()) return false;
  // "mirror selfie" written out is unambiguous on its own; everything else needs both halves.
  if (/\bmirror\s*-?\s*selfies?\b/i.test(s)) return true;
  return MIRROR_NOUN.test(s) && SHOT_INTO_IT.some((re) => re.test(s));
}

/**
 * @param poseCards rows from the eddy-pose collection ({ id, prompt })
 * @param deps      { readPoseDescription, hasPoseTags } — injected so this module stays pure and
 *                  the suite can drive it without an ESM loader
 * @returns { patches: Map<id, { prompt }>, stats }
 */
export function planPoseTagBackfill(poseCards, { readPoseDescription, hasPoseTags, mergePoseTags }) {
  const patches = new Map();
  const stats = { total: 0, already: 0, matched: 0, silent: 0, unreadable: 0 };

  for (const card of poseCards || []) {
    stats.total += 1;

    // Already answered — including answered "no" with an empty array. Re-deciding would overwrite a
    // hand-set chip with a regex's opinion, which is the wrong way round.
    if (hasPoseTags(card.prompt)) { stats.already += 1; continue; }

    const desc = readPoseDescription(card.prompt);
    if (desc === null) { stats.unreadable += 1; continue; }   // broken card — nothing to read

    if (readsAsMirrorSelfie(desc)) {
      patches.set(card.id, { prompt: mergePoseTags(card.prompt, ['mirror selfie']) });
      stats.matched += 1;
      continue;
    }

    // Silent on the question. NOT stamped [] — that is the AI pass's job, and stamping it here
    // would mark the card answered and stop the paid pass from ever looking at it.
    stats.silent += 1;
  }

  return { patches, stats };
}
