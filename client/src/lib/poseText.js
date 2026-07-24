/**
 * Reading a saved pose card down to the one sentence that belongs in a generation.
 *
 * A pose is stored as the full JSON prompt block, but only its pose_action.description belongs
 * in a generation. The rest of that block carries its OWN identity rules ("use @image1 as the
 * strict base…"), and the Generate page already states its own — sending both means two
 * competing instruction sets about which image owns the face, which is exactly the cancelling
 * conflict that has bitten every other part of that prompt.
 *
 * Anything that is not parseable JSON is already a plain sentence and passes through untouched.
 *
 * This lives in its own module rather than inside the Generate page because the Pose tab has to
 * ask the SAME question to decide whether a card is broken. Two copies of this logic would drift
 * and the badge would stop matching what generation actually does.
 */

/**
 * The pose sentence, or null when this text is JSON-shaped and no description could be recovered.
 *
 * null is a real answer here and not an error: it means "there is a prompt saved on this card and
 * it is not usable", which is different from an empty card.
 */
export function readPoseDescription(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('{')) return raw;
  try {
    const desc = JSON.parse(raw)?.pose_action?.description;
    if (typeof desc === 'string' && desc.trim()) return desc.trim();
  } catch {
    // Malformed JSON — the sheet's own template has a missing comma and a trailing comma, so
    // this happens for real. Fall back to pulling the field out with a pattern.
    const m = raw.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
  }
  return null;
}

/**
 * What actually goes into the prompt's POSE: slot.
 *
 * WHY '' AND NOT THE RAW BLOB: this used to `return raw` when extraction failed, which put an
 * unparsed JSON fragment straight into the prompt. That fragment's leading key is a
 * `reference_priority` block declaring itself `"priority":"highest"` and demanding the reference
 * image be copied with nothing changed — the exact opposite of applying a pose, standing directly
 * against the page's own "Recreate her pose EXACTLY". The model honoured neither and silently
 * returned the character in her original pose.
 *
 * Returning '' drops the POSE: line entirely, which is not a degradation: the pose IMAGE is still
 * sent alongside "Recreate her pose EXACTLY", so the picture does the work on its own. That is
 * already the everyday path for the majority of saved cards, which carry no prompt text at all.
 * A missing line is recoverable; a contradictory line is not.
 *
 * The failure is surfaced to the user by the callers (a pre-run warning on Generate, a badge on
 * the Pose card) rather than swallowed here — this stays a pure function.
 */
export function poseSentence(text) {
  return readPoseDescription(text) ?? '';
}

/**
 * True when a card HAS a saved prompt that yields no usable pose. Used to flag the card in the
 * Pose tab, where it would otherwise show a plausible-looking preview of a prompt that generation
 * silently ignores — the only reason this bug was ever noticed is that someone read that preview.
 */
export function isPosePromptBroken(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;                       // an empty card is a normal, image-only pose
  return readPoseDescription(raw) === null;
}
