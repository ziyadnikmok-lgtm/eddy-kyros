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
 * Recovers a usable JS object from a saved pose block, tolerating the ONE malformed shape that
 * shows up for real: a Sheets/CSV import whose own quote-escaping was never undone. A CSV cell
 * holding JSON gets wrapped in an outer `"..."` and every internal `"` doubled to `""` — so a
 * card imported that way is saved as `"{\n  ""reference_priority"": ...}"` instead of
 * `{\n  "reference_priority": ...}`. That string does not even START with `{` (it starts with
 * the wrapping `"`), so the plain `JSON.parse` path below never had a chance at it, and — before
 * this function existed — every caller's "not valid JSON, must be plain prose" fallback treated
 * the WHOLE garbled blob as if it were the pose sentence itself, which is what actually reached
 * generation for every affected card (owner, 2026-08-06 — traced from real exported data, ~30 of
 * 60 saved poses were in this shape).
 *
 * Tries, in order: parse as-is; strip one layer of wrapping quotes + un-double internal quotes,
 * then parse. Returns null if neither works, meaning the text is genuinely not a pose JSON block
 * (an old plain-sentence card, or truly malformed) rather than a recoverable import artifact.
 */
function tryParsePoseJson(raw) {
  if (raw.startsWith('{')) {
    try { return JSON.parse(raw); } catch { /* fall through to the CSV-unescape attempt below */ }
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw.slice(1, -1).replace(/""/g, '"')); } catch { /* still not recoverable */ }
  }
  return null;
}

/**
 * The pose sentence, or null when this text is JSON-shaped and no description could be recovered.
 *
 * null is a real answer here and not an error: it means "there is a prompt saved on this card and
 * it is not usable", which is different from an empty card.
 */
export function readPoseDescription(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('{') && !raw.startsWith('"')) return raw;
  const parsed = tryParsePoseJson(raw);
  if (parsed) {
    const desc = parsed?.pose_action?.description;
    if (typeof desc === 'string' && desc.trim()) return desc.trim();
  } else {
    // Malformed JSON that isn't the CSV-quoting shape either — the sheet's own template has a
    // missing comma and a trailing comma sometimes, so this happens for real. Fall back to
    // pulling the field out with a pattern rather than giving up.
    const m = raw.match(/""?description""?\s*:\s*""?((?:[^"\\]|\\.)*?)""?\s*[,}\n]/);
    if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
  }
  return null;
}

/**
 * The FACIAL EXPRESSION the pose photo shows — subject.features from the same saved block.
 *
 * The vision brief has always written this field (59 of 60 real poses carry it: "Subtle smirk with
 * a direct, seductive gaze", "playful expression with her tongue sticking out") and nothing has
 * ever read it, so every pose's expression was captured and then discarded — a pose picked FOR its
 * look generated with whatever face the model felt like (owner, 2026-08-06).
 *
 * Returns '' when the field is missing, unreadable, or is one of the placeholder/faceless values
 * that must never reach a prompt: the template ships a literal "<her facial expression and gaze,
 * read from the photo>" placeholder, and a faceless pose's features say so rather than describing
 * a face. Both are worse than saying nothing.
 */
export function readPoseExpression(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('{') && !raw.startsWith('"')) return '';
  const parsed = tryParsePoseJson(raw);
  const v = parsed?.subject?.features;
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t || t.startsWith('<')) return '';           // unfilled template placeholder
  if (/^faceless/i.test(t)) return '';              // no face to describe
  return t;
}

const POSE_VIEWS = new Set(['front', 'back', 'closeup']);

/**
 * "front", "back" or "closeup" — read off the same saved JSON block readPoseDescription parses,
 * so the two never disagree about what a card's photo actually shows. Defaults to "front"
 * whenever the field is missing, unparseable, or anything other than one of the three known
 * values: a pose with no saved classification (an older card, a plain-text prompt, a malformed
 * reply) behaves exactly like a normal/front-facing one always did, rather than silently losing
 * its outfit crop.
 */
export function readPoseView(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('{') && !raw.startsWith('"')) return 'front';
  const parsed = tryParsePoseJson(raw);
  if (parsed) {
    const v = parsed?.pose_action?.view;
    return POSE_VIEWS.has(v) ? v : 'front';
  }
  const m = raw.match(/""?view""?\s*:\s*""?(front|back|closeup)""?/);
  return POSE_VIEWS.has(m?.[1]) ? m[1] : 'front';
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

/**
 * True only when the saved JSON EXPLICITLY carries a pose_action.view — distinct from
 * readPoseView's safe "front" default, which also fires for a card that was simply saved before
 * this field existed. Used to find cards that still need labelling (see labelViews in
 * EddyCollection.jsx) without re-touching ones that already have a real answer, even "front".
 */
export function hasPoseView(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('{') && !raw.startsWith('"')) return false;
  const parsed = tryParsePoseJson(raw);
  if (parsed) return POSE_VIEWS.has(parsed?.pose_action?.view);
  return /""?view""?\s*:\s*""?(front|back|closeup)""?/.test(raw);
}

/**
 * Merge a freshly-classified view into an EXISTING saved pose JSON, touching nothing else in the
 * DATA — used by the bulk "Label poses" action so it can backfill pose_action.view on old cards
 * without overwriting a description the user may have hand-edited. Returns the raw text unchanged
 * if it was never a recoverable JSON pose block, since there is no `pose_action` object to attach
 * a view to in that case — the whole point of the label pass is to leave everything but the view
 * exactly as it was.
 *
 * One deliberate side effect: a card recovered via the CSV-unescape path in tryParsePoseJson gets
 * WRITTEN BACK as clean JSON (JSON.stringify on the parsed object), not re-wrapped in the original
 * `"..."` / doubled-quote shape. So labelling a previously-garbled card also permanently repairs
 * its storage format — worth knowing, but not a reason to skip labelling it.
 */
export function mergePoseView(oldText, newView) {
  const raw = String(oldText || '').trim();
  if ((!raw.startsWith('{') && !raw.startsWith('"')) || !POSE_VIEWS.has(newView)) return raw;
  const parsed = tryParsePoseJson(raw);
  if (!parsed || !parsed.pose_action || typeof parsed.pose_action !== 'object') return raw;
  parsed.pose_action.view = newView;
  return JSON.stringify(parsed);
}

/**
 * TAGS — a second, INDEPENDENT label family on the same saved block (owner, 2026-08-14).
 *
 * WHY NOT A FOURTH VIEW: the obvious way to add "mirror selfie" is another value in POSE_VIEWS, and
 * it would quietly break outfit matching. `view` answers ONE question -- which side of her GARMENT
 * the camera sees (see VIEW_RULE in server/routes/eddyVision.js) -- and three things depend on that
 * answer: Max Outfit pairs a back shot with the back-view outfit description, smartMatch pairs a
 * close-up pose with a close-up outfit, and the generation prompt picks its body clause from it.
 * A mirror selfie is orthogonal to all three: she can face the mirror (front of the outfit to the
 * camera) or turn away from it (back of the outfit to the camera). Folding it into `view` forces
 * every mirror pose to give up its front/back answer, and those poses start being described with
 * the wrong side of the garment -- the exact mismatch `view` exists to prevent.
 *
 * WHY AN ARRAY AND NOT A `mirrorSelfie` BOOLEAN: the randomiser that motivated this filters by
 * "the labels I want", plural. A boolean makes the second label a rebuild; an array makes it one
 * more string in POSE_TAGS.
 *
 * WHY IN THE JSON AND NOT A ROW FIELD: `_addItems` in eddyCollectionStore.js has an ALLOWLIST and
 * drops any field not named in it, with no error -- that is how poseView was nearly lost. Storing
 * inside pose_action sidesteps it. (Outfits do keep their view as a row field. That split is
 * deliberate and is not widened here.)
 */
export const POSE_TAGS = ['mirror selfie'];

const POSE_TAG_SET = new Set(POSE_TAGS);

/** Normalise a caller's list to the stored shape: lowercased, trimmed, known-only, deduped. */
function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const v = String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (POSE_TAG_SET.has(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * The tags on a card, always an array. [] covers three different situations on purpose — never
 * asked, asked and answered no, and unparseable — because no caller needs to tell them apart for
 * FILTERING. The one place the difference matters (deciding what still needs labelling) asks
 * hasPoseTags instead, exactly as hasPoseView exists beside readPoseView's 'front' default.
 */
export function readPoseTags(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('{') && !raw.startsWith('"')) return [];
  const parsed = tryParsePoseJson(raw);
  return cleanTags(parsed?.pose_action?.tags);
}

/**
 * True only when the saved JSON EXPLICITLY carries a pose_action.tags ARRAY — including an empty
 * one. An empty array is a real answer ("we looked, it is not a mirror selfie") and must stop the
 * card being re-scanned and re-charged on every later labelling pass.
 */
export function hasPoseTags(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('{') && !raw.startsWith('"')) return false;
  const parsed = tryParsePoseJson(raw);
  return Array.isArray(parsed?.pose_action?.tags);
}

/**
 * Write tags into an existing saved pose JSON, touching nothing else — the sibling of
 * mergePoseView, with the same contract and the same deliberate side effect (a CSV-garbled card
 * gets written back as clean JSON). Unknown tag strings are dropped rather than stored, so a typo
 * or a stale vocabulary can never create a label the filter UI has no chip for.
 */
export function mergePoseTags(oldText, tags) {
  const raw = String(oldText || '').trim();
  if (!raw.startsWith('{') && !raw.startsWith('"')) return raw;
  const parsed = tryParsePoseJson(raw);
  if (!parsed || !parsed.pose_action || typeof parsed.pose_action !== 'object') return raw;
  parsed.pose_action.tags = cleanTags(tags);
  return JSON.stringify(parsed);
}
