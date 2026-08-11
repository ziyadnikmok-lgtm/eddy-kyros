/**
 * Backfill `poseView` on Library rows that predate it — offline, exact, and free.
 *
 * Max Outfit matches a back shot to a back outfit by reading `poseView` off the Library row. New
 * rows carry it; the ~500 rows generated before it existed do not, so they all read as "front" and a
 * back shot could be handed a front garment.
 *
 * There is no need to look at the pictures. Every row stores the PROMPT it was generated with, and
 * that prompt contains the pose verbatim as `POSE: <text>`. The Pose collection still holds those
 * cards, each carrying its own front/back/closeup label. So the view is recoverable by matching the
 * sentence back to the card that produced it — no vision pass, no cost, and exact wherever the card
 * is labelled.
 *
 * Two fallbacks, in order of trust, for rows whose card is gone or unlabelled:
 *   1. the BACK VIEW line, which buildPrompt emits verbatim on every back-facing generation
 *   2. front — what an unclassified pose has always behaved as
 *
 * Returns { patches, stats } and writes nothing; the caller decides.
 */
export function planPoseViewBackfill(libraryRows, poseCards, { readPoseView, poseSentence }) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  // Pose sentence -> view, built once. Cards with no usable sentence are skipped rather than
  // mapped to '' , which would swallow every row whose prompt had no POSE line.
  const bySentence = new Map();
  for (const card of poseCards) {
    const sentence = norm(poseSentence(card.prompt));
    if (!sentence) continue;
    bySentence.set(sentence, readPoseView(card.prompt));
  }

  const patches = new Map();
  const stats = { total: 0, already: 0, matched: 0, fromBackLine: 0, defaulted: 0 };

  for (const row of libraryRows) {
    stats.total += 1;
    if (row.poseView) { stats.already += 1; continue; }

    const prompt = String(row.prompt || '');
    // The POSE line runs to the end of that line; buildPrompt joins its lines with newlines.
    const m = /(?:^|\n)POSE:\s*([^\n]+)/.exec(prompt);
    const hit = m ? bySentence.get(norm(m[1])) : undefined;

    if (hit) {
      patches.set(row.id, { poseView: hit });
      stats.matched += 1;
      continue;
    }
    if (prompt.includes('BACK VIEW — HER FACING DIRECTION IS FIXED')) {
      patches.set(row.id, { poseView: 'back' });
      stats.fromBackLine += 1;
      continue;
    }
    // Stamped 'front' rather than left blank, so the next run does not re-scan every old row.
    patches.set(row.id, { poseView: 'front' });
    stats.defaulted += 1;
  }

  return { patches, stats };
}
