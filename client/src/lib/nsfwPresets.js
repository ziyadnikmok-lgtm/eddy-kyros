/**
 * The NSFW switch, shared by every Seedream page.
 *
 * Two hard-won rules live here, both learned from the toggle silently doing nothing:
 *
 * 1. Undressing is an ACTION, not a description. An edit model keeps what it can see, so
 *    "she is nude" alongside a photo of a dressed woman changes nothing — it has to be told to
 *    take the clothes OFF.
 * 2. A base rule that pins the outfit CANCELS the nude line, and the model does neither. Every
 *    page that pins clothing must stand that rule down when `wantsNude` is true. That is why
 *    this exports the flag helper too, rather than only the text.
 */

/** The instruction that actually removes clothing. Absolute, itemised, no comparatives. */
export const NUDE_LINE = 'REMOVE ALL CLOTHING: she is completely naked. Take off every garment she is wearing — top, bottom, underwear, straps, everything. Bare skin where those clothes were, with her natural body underneath. No fabric anywhere on her.';

export const TOPLESS_LINE = 'Remove her top and bra completely — she is topless, bare breasts fully exposed, no fabric above the waist.';

/**
 * Chips that only make sense once NSFW is on. Kept out of the per-page PRESETS arrays so all
 * pages offer the same set and a wording fix lands everywhere at once.
 */
export const NSFW_PRESETS = [
  { group: 'Sexual', nsfwOnly: true, undress: true, label: 'Topless', text: TOPLESS_LINE },
  { group: 'Sexual', nsfwOnly: true, undress: true, label: 'Fully nude', text: NUDE_LINE },
  { group: 'Sexual', nsfwOnly: true, label: 'Legs spread', text: 'She is lying back with her legs spread wide open.' },
  { group: 'Sexual', nsfwOnly: true, label: 'Arched back', text: 'Her back is deeply arched, chest pushed forward and hips raised.' },
  { group: 'Sexual', nsfwOnly: true, label: 'On all fours', text: 'She is on all fours, looking back over her shoulder at the camera.' },
  { group: 'Sexual', nsfwOnly: true, label: 'Hands on breasts', text: 'Her hands cup her bare breasts, fingers pressing into them.' },

  { group: 'Expression', expressionChange: true, label: 'Moaning', text: 'Her mouth is open in a soft moan, eyes half-closed, head tilted back in pleasure.' },
  { group: 'Expression', expressionChange: true, label: 'Flushed', text: 'Flushed cheeks, breathless parted lips, aroused heavy-lidded eyes.' },
  { group: 'Expression', expressionChange: true, label: 'Innocent', text: 'Wide innocent doe eyes and softly parted lips, looking up at the camera.' },
  { group: 'Expression', expressionChange: true, label: 'Tongue out', text: 'Her tongue is out, extended past her lower lip, eyes on the camera.' },
  { group: 'Expression', expressionChange: true, label: 'Mouth open', text: 'Her mouth is open wide, jaw relaxed, looking straight at the camera.' },
];

/** Every chip text that removes clothing — used to detect an undress chip in free text. */
export const UNDRESS_TEXTS = NSFW_PRESETS.filter((c) => c.undress).map((c) => c.text);

/**
 * Does this run undress her?
 *
 * The toggle IS an instruction: NSFW on with no chip picked still means naked. A picked undress
 * chip narrows it (topless vs fully nude), so the generic line stands down to avoid stacking two
 * conflicting clothing instructions.
 */
export function nudeState({ nsfw, instruction = '' }) {
  const undressChip = UNDRESS_TEXTS.some((t) => instruction.includes(t));
  return { undressChip, wantsNude: !!nsfw || undressChip, addGenericNudeLine: !!nsfw && !undressChip };
}
