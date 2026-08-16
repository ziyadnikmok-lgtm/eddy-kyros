/**
 * Turn a Kyros collection export (.json) into real folders of real images.
 *
 * WHY THIS EXISTS: the export is one JSON file with every picture inlined as a base64 data URL. That
 * is the right shape for re-importing into Kyros and the wrong shape for everything else — you
 * cannot look at it, drop it into a tool, or hand it to someone. This writes it back out as files,
 * keeping the folder each card was filed under.
 *
 *   node tools/export-to-folders.js <export.json> <output-folder> [--flat] [--dry]
 *
 * Example:
 *   node tools/export-to-folders.js D:\Downloads\eddy-outfit.json D:\Content\outfits
 *     -> D:\Content\outfits\bikini\black-lace-set.jpg
 *        D:\Content\outfits\dresses\red-slip.jpg
 *        D:\Content\outfits\_unfiled\outfit-12.png
 *
 * The subfolders are the ones the collection already had. A card with no folder goes to _unfiled
 * rather than the root, so "everything that still needs sorting" is one folder rather than a mess
 * mixed in with the sorted ones.
 *
 * Works on ANY Kyros collection export — outfit, pose, base, character, library, Pinterest — because
 * they all share the same row shape: { title, prompt, image, folder }.
 */
const fs = require('fs');
const path = require('path');

const [, , srcArg, outArg, ...flags] = process.argv;
const FLAT = flags.includes('--flat');
const DRY = flags.includes('--dry');

if (!srcArg || !outArg) {
  console.error('usage: node tools/export-to-folders.js <export.json> <output-folder> [--flat] [--dry]');
  process.exit(1);
}

const src = path.resolve(srcArg);
const outRoot = path.resolve(outArg);
if (!fs.existsSync(src)) { console.error(`no such file: ${src}`); process.exit(1); }

let rows;
try {
  // A BOM here is common — the file may have been through a text editor on the way.
  rows = JSON.parse(fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, ''));
} catch (err) {
  console.error(`could not read that JSON: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(rows)) { console.error('that file is not a Kyros export (expected an array of cards)'); process.exit(1); }

/** Anything the filesystem will refuse, plus the leading dots that make a folder hidden. */
function safeName(s, fallback) {
  const clean = String(s || '')
    .split(/\r?\n/)[0]
    .replace(/[<>:"|?*\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80);
  return clean || fallback;
}

/**
 * The readable sentence out of a prompt.
 *
 * Pose and character cards store a whole JSON block, not prose, so using it raw names files things
 * like "{ reference_priority { instruction This is the FIRST and MOS". The sentence worth naming a
 * file after is pose_action.description — the same field the app reads for the same reason.
 */
function readablePrompt(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('{') && !text.startsWith('"')) return text;
  try {
    const parsed = JSON.parse(text.startsWith('"') ? text.slice(1, -1).replace(/""/g, '"') : text);
    return parsed?.pose_action?.description || parsed?.subject?.features || '';
  } catch {
    // A malformed block (common in sheet exports) simply has no readable name in it; the caller
    // falls back to item-N, which is better than naming a file after a brace.
    return '';
  }
}

/**
 * The prompt makes a far better filename than the title when the title is a bare id.
 * "import-12" tells you nothing; the first few words of the prompt tell you what the picture is.
 */
function nameFor(row, i) {
  /**
   * A CHARACTER card names itself, and that name beats everything else.
   *
   * Character exports carry `character: "Arya"` and no title at all, so all sixteen came out as
   * item-1..item-16 — sixteen faces and not one of them saying whose it was, which is the single
   * thing that export is for (owner, 2026-08-15). Checked before title on purpose: when a card
   * knows who it is, nothing derived from a prompt is going to beat that.
   */
  const character = safeName(row.character, '').trim();
  if (character) return character;

  // Strip an extension the title is already carrying, or "image.png" becomes "image.png.jpg".
  const title = safeName(row.title, '').replace(/\.(png|jpe?g|webp|gif|bmp)$/i, '').trim();
  // A title that is only a placeholder is worse than no title: "image", "import-12", "untitled 3"
  // name a hundred files the same thing and tell you nothing about any of them.
  const placeholder = /^(import|image|img|untitled|photo|file|pin)[-_ ]?\d*$/i.test(title);
  if (title && !placeholder) return title;
  const fromPrompt = safeName(readablePrompt(row.prompt), '');
  if (fromPrompt) return fromPrompt.slice(0, 60);
  return `item-${i + 1}`;
}

const stats = { total: rows.length, written: 0, noImage: 0, folders: new Set() };
const used = new Set();

for (const [i, row] of rows.entries()) {
  const m = String(row.image || '').match(/^data:image\/([\w+.-]+);base64,(.+)$/);
  if (!m) { stats.noImage += 1; continue; }

  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const folder = FLAT ? '' : safeName(row.folder, '') || '_unfiled';
  const dir = folder ? path.join(outRoot, folder) : outRoot;

  // Two cards can legitimately share a title. Suffix rather than overwrite — silently losing the
  // second one is exactly the kind of thing nobody notices until the count is wrong.
  let base = nameFor(row, i);
  let file = path.join(dir, `${base}.${ext}`);
  let n = 2;
  while (used.has(file.toLowerCase()) || fs.existsSync(file)) {
    file = path.join(dir, `${base} (${n}).${ext}`);
    n += 1;
  }
  used.add(file.toLowerCase());
  stats.folders.add(folder || '(root)');

  if (!DRY) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  }
  stats.written += 1;
}

console.log(`${DRY ? 'would write' : 'wrote'} ${stats.written} of ${stats.total} cards`);
console.log(`folders: ${[...stats.folders].sort().join(', ') || '(none)'}`);
if (stats.noImage) console.log(`${stats.noImage} card(s) had no image (prompt-only) and were skipped`);
if (!DRY) console.log(`-> ${outRoot}`);
