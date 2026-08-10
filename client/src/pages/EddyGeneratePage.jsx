import { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { seedream as seedreamApi, gallery as galleryApi, video as videoApi, library as libraryApi } from '../services/api';
import { useApp } from '../context/AppContext';
import { Card, Btn, Select, Textarea, Spinner } from '../components/UI';
import {
  SEEDREAM_ASPECT_RATIOS,
  SEEDREAM_RESOLUTIONS,
  SEEDREAM_MAX_IMAGES,
  seedreamCost,
  SEEDANCE_ASPECT_RATIOS,
  SEEDANCE_MODELS,
  SEEDANCE_DURATION_MIN,
  SEEDANCE_DURATION_MAX,
} from '../config/photoModes';
import { pushPending, resolvePending, failPending, attachTaskId, subscribeFeed } from '../lib/generationFeed';
import { detectAspectRatio } from '../lib/detectAspectRatio';
import { parseDurationSeconds } from '../lib/parseVideoDuration';
import { createEddyCollection } from '../lib/eddyCollectionStore';
import { createPageStore } from '../lib/pageStateStore';
// isPosePromptBroken is deliberately no longer imported here: the broken-prompt notice was demoted
// out of the generate flow and now lives only on the Pose tab, where it can be acted on.
import { poseSentence, readPoseView, readPoseExpression } from '../lib/poseText';
import { runPool } from '../lib/runPool';
import { cn } from '../lib/utils';
import { downloadBlob, stripEnabled } from '../lib/stripMetadata';

/**
 * How many generations are in flight at once.
 *
 * Raised 6 -> 12 (owner, 2026-08-09) for large runs where wall-clock matters more than caution.
 *
 * THE CEILING THAT ACTUALLY BINDS is the server's own generateLimiter: 60 requests per 60 seconds
 * on /api/seedream, shared with Photo Match, Base and every Regenerate. A lane does not issue
 * requests continuously — it issues one and waits out the whole generation — so the request RATE is
 * lanes / duration, not lanes. At ~45s per Seedream image, 12 lanes is ~16 requests/minute, and
 * Photo Match's 4 add ~5. About 21 of the 60 available, so a run can still be regenerating and
 * generating a base while both batches are going without tripping it.
 *
 * Going higher is where it stops being free: at 30 concurrent workers the friend's pipeline reports
 * 429s (its 09_gotchas.md), and runPool exists because this codebase has been burned by unthrottled
 * fan-out before. 12 keeps a 3x margin under the limiter.
 */
const PARALLEL_REQUESTS = 12;

// Vertex allows far fewer concurrent image calls than our own backend does, and going over does not
// slow down — it 429s (RESOURCE_EXHAUSTED) and the image is LOST, because nothing in this stack
// retries a 429. At 6 in flight a Gemini batch burned its quota in the first few seconds and the
// rest failed (owner, 2026-08-06). runPool queues the remainder either way, so a lower cap costs
// wall-clock, not images.
// Nano Banana 2 runs ~3 minutes per image, so a wide fan-out mostly buys queue depth rather than
// throughput. Raised 3 -> 6 (owner, 2026-08-09): at 180s each, 6 lanes is only ~2 requests/minute,
// which is nothing against the limiter, and it halves the wall-clock on a long nano run. Kept well
// under the Seedream lane count on purpose — these requests hold a connection for three minutes.
const NANO2_PARALLEL_REQUESTS = 6;

// Above the server's own 10-minute poll, so a slow job ends with the server's specific message
// (which names the prediction id) rather than a bare client abort.
const NANO2_CLIENT_TIMEOUT_MS = 11 * 60_000;

// WaveSpeed's published per-image rate for nano-banana-2, read off their model page for this
// endpoint: 1k $0.07, 2k $0.105 (2K is the standard rate x1.5). Both search flags are sent false
// by the service, so neither surcharge applies.
const NANO2_COST = { '1K': 0.07, '2K': 0.105 };
// How many times one image is attempted on Nano Banana 2 before it falls back to Seedream 5.0
// Pro. Four, because the failure this exists for is the content guard, which samples: a refusal
// is not a verdict on the prompt, it is one roll. Terminal errors (no key, bad request) skip the
// retries entirely -- see TERMINAL_CODES -- so this never multiplies a misconfiguration.
const NANO2_ATTEMPTS = 4;

// Above this many picked items the summary list becomes a thumbnail grid instead of text rows.
// Eight is about what fits without the Generate button leaving the screen.
const COMPACT_PICKED = 8;

// Where Max Nano files what it makes. Its own folder, so a Max run never mixes into the Eddy pile.
const MAX_NANO_FOLDER = 'Max Nano';
// Where Max Outfit files its results. Its own pile, like Max Nano's: these are stage-2 swaps
// off finished stage-1 images, not fresh generations, and mixing them in with everything else
// makes a batch impossible to find afterwards.
const MAX_OUTFIT_FOLDER = 'Max Outfit';

/**
 * One representative photo per character (folder): the one tagged `role`, else her earliest.
 *
 * A plain `role === 'base'` filter DROPPED any character with nothing tagged — she was in the
 * Character tab and simply absent from Eddy's face picker, with nothing saying why (owner,
 * 2026-08-08). Tagging is optional and most imports arrive untagged, so absence of a tag has to
 * mean "pick one for me", never "hide her".
 *
 * Earliest rather than newest for the fallback: the Character tab treats the first image as her
 * base face, so this agrees with what that tab already shows.
 */
/**
 * Which Library folder a result is filed into.
 *
 * THE CHARACTER WINS. Results used to land in a flat "Eddy" folder no matter whose face was in
 * them, so a whole fleet of characters piled into one bucket -- reported 2026-08-09. The comment at
 * the filing site already claimed results filed under the character's name; the code beneath it did
 * nothing of the sort. Now Grace's go to "Grace" and Gwen's to "Gwen".
 *
 * Max Nano NESTS rather than replaces: its output still gathers under "Max Nano" (asked for by
 * name) with a per-character folder inside it, so that tab keeps its own pile AND stays sorted.
 *
 * With no character chosen the old behaviour stands, NSFW split included -- there is no name to
 * file under, and inventing one would be worse than the generic folder.
 */
/**
 * Which Library folder a result is filed into.
 *
 * ONE FOLDER PER CHARACTER, AND NOTHING BELOW IT. Generating for Arya puts the pictures in "Arya" —
 * that is the whole rule (owner, 2026-08-09).
 *
 * This deliberately replaced two earlier schemes, both of which split a character's work up:
 * flat "Arya Seedream" siblings (which sorted away from the "Arya" folder she already had, so
 * opening Arya showed none of the batch), and then "Arya / Seedream" subfolders. Separating by
 * engine or by tab is not worth a character's pictures living in more than one place — if which
 * model made a picture ever needs to be known, that belongs on the item, not in the folder tree.
 *
 * With no character chosen the generic buckets still apply, NSFW split included: there is no name
 * to file under, and inventing one would be worse than a generic folder.
 */
/**
 * The tags a generation is filed under, server side.
 *
 * HER NAME IS IN HERE ON PURPOSE. "Recover missing" reads the character back off these tags to work
 * out which folder a stranded picture belongs in, and the name was never being sent -- so recovery
 * picked the first tag that was not an engine name and filed images into folders called
 * "nano-banana-2", "edit", or nothing at all (audit, 2026-08-09).
 *
 * The server keeps at most 4 extra tags, so this stays short deliberately.
 */
function eddyTags(isEdit, characterName) {
  const who = String(characterName || '').trim();
  return [...(isEdit ? ['eddy', 'edit'] : ['eddy']), ...(who ? [who] : [])];
}

async function resolveLibraryFolder(libraryStore, { maxNano, maxOutfit, nsfw, characterName }) {
  const who = String(characterName || '').trim();
  // Every branch falls back to the generic bucket rather than to null.
  //
  // NOTHING MAY BE FILED NOWHERE. A null folderId is not "unsorted", it is INVISIBLE: the Library
  // lists items by folder, so a row with no folder shows up under "All" and in no folder at all.
  // 89 pictures ended up in that state and read as never having reached the Library — the images
  // were safe the whole time, just unreachable (owner, 2026-08-09).
  //
  // The generic folder is the floor, and it is created here rather than left to chance, so the
  // worst case is "in the wrong folder" — recoverable by dragging — instead of "gone".
  const generic = async () => (await libraryStore.ensureFolder(nsfw ? 'Eddy NSFW' : 'Eddy'))?.id || null;
  /**
   * ONE FOLDER PER CHARACTER. Nothing below it, and no tab above it.
   *
   * "Max Nano > Grace" and "Grace > Seedream" were both tried and both removed at the owner's call
   * (2026-08-09). Splitting her work by the tab that made it, or the model that made it, is a
   * distinction that matters while you are comparing them and gets in the way every other day. Her
   * name is the whole answer, and it is the same answer on every tab — Eddy, Max Nano, Max Outfit
   * and Photo Match all put her pictures in one place.
   */
  if (who) return (await libraryStore.ensureFolder(who))?.id || await generic();


  // No character picked. Max Nano / Max Outfit still keep their own pile rather than falling into
  // the shared Eddy bucket — with no name to file under, the tab is the only thing left to sort by.
  const ownRoot = maxOutfit ? MAX_OUTFIT_FOLDER : (maxNano ? MAX_NANO_FOLDER : '');
  if (ownRoot) return (await libraryStore.ensureFolder(ownRoot))?.id || await generic();
  return generic();
}

/**
 * SMART OUTFIT MATCHING — a back shot gets a back outfit, a close-up gets a close-up outfit.
 *
 * This is the rule the friend's pipeline runs on: cloth_swap_paired.py keeps three separate outfit
 * pools and picks from the one matching the pose's angle, because a front product photo swapped
 * onto a shot taken from behind produces a garment that cannot exist. Kyros had all the information
 * to do the same and was ignoring it.
 *
 * WHERE THE ANSWER COMES FROM, in order of trust:
 *   1. `poseView` stamped on the Library row when it was generated. Exact — it is the view the pose
 *      itself declared, not a guess.
 *   2. The assembled prompt saved with the row. Every back-facing generation carries the BACK VIEW
 *      line verbatim, so its presence is a fact about that image rather than an inference.
 * Anything else is treated as front, which is what an unclassified pose has always behaved as.
 */
function libraryRowView(row) {
  if (row?.poseView === 'back' || row?.poseView === 'closeup' || row?.poseView === 'front') return row.poseView;
  const prompt = String(row?.prompt || '');
  if (prompt.includes('BACK VIEW — HER FACING DIRECTION IS FIXED')) return 'back';
  // No equivalent marker exists for close-ups: buildPrompt never emitted one. Rows generated from
  // here on carry poseView and will classify exactly; older close-ups read as front, which is the
  // same thing they did before this feature existed.
  return 'front';
}

/**
 * An outfit's angle, from the folder it lives in.
 *
 * Folder placement is the only reliable signal — 07_outfits.md says so outright ("front/ vs back/
 * subfolder placement is the ONLY reliable signal for angle") — and the import writes it into the
 * folder NAME ("1. Lingerie - back", "7. CloseUps - Underboob"). Read from the name so the rule
 * survives folders being renamed or re-nested by hand.
 */
function outfitView(folderName) {
  const n = String(folderName || '').toLowerCase();
  if (n.includes('closeup') || n.includes('close-up') || n.includes('underboob')) return 'closeup';
  if (n.includes('back')) return 'back';
  return 'front';
}

/**
 * Least-used picker — a port of RotationPicker from cloth_swap_paired.py.
 *
 * Least-used wins, ties broken at RANDOM. Not a round-robin cursor, which is what this used to be:
 * a cursor is fair only if every pick comes in the same order, and pairing means some pools get
 * pulled from twice as often as others. Least-used is fair regardless of call order.
 *
 * Usage is NOT persisted, matching theirs exactly — the counter resets every run, and within a run
 * it is global across every character and every pair.
 */
function makeRotationPicker(pool, rng) {
  const usage = new Map(pool.map((p) => [p, 0]));
  return {
    pick() {
      if (!pool.length) return null;
      const min = Math.min(...pool.map((p) => usage.get(p)));
      const candidates = pool.filter((p) => usage.get(p) === min);
      const choice = candidates[Math.floor(rng() * candidates.length) % candidates.length];
      usage.set(choice, usage.get(choice) + 1);
      return choice;
    },
    usage,
  };
}

/**
 * [a, b, c, d] -> [(a,b), (c,d)]. An odd tail pairs with ITSELF, so it still gets an assignment.
 * Verbatim behaviour from sequential_pairs().
 */
function sequentialPairs(items) {
  const out = [];
  for (let i = 0; i < items.length; i += 2) {
    out.push(i + 1 < items.length ? [items[i], items[i + 1]] : [items[i], items[i]]);
  }
  return out;
}

/**
 * Deal outfits to photos exactly the way cloth_swap_paired.py deals them to poses.
 *
 * THE RULES, from the friend's source rather than from his docs (which had drifted — his README
 * corrects three of them by name):
 *
 *   1. Three FLAT pools: front, back, closeup. No per-category fairness — he chose flat pools on
 *      purpose because the categories are not balanced anyway. Each individual FILE still gets used
 *      roughly equally, which is the actual guarantee.
 *   2. Close-ups are separated FIRST and paired among themselves, against their own pool.
 *   3. Photos are walked in order, in pairs of two, and EACH PAIR SHARES ITS PICK — one outfit per
 *      two shots. Cheaper, and it reads as a mini look rather than a new outfit every image.
 *   4. A mixed front/back pair pulls from BOTH pools INDEPENDENTLY. Those are two different
 *      garments, not one garment in two views: the front and back libraries are not 1:1 matched, so
 *      pretending they are gives worse swaps than letting each pool serve its own best file.
 *   5. Least-used picking, ties random, non-persistent, global across the run.
 *
 * `rng` is injectable so the checks can drive it deterministically; it defaults to Math.random.
 *
 * A photo whose pool is EMPTY falls back to the whole selection rather than being skipped — his
 * script raises and dies there, which is right for a batch script and wrong for a UI. The count is
 * returned so the caller can say how many fell back.
 */
function matchOutfits(bases, outfits, viewOfBase, viewOfOutfit, rng = Math.random) {
  const pools = { front: [], back: [], closeup: [] };
  for (const o of outfits) pools[viewOfOutfit(o)].push(o);
  const pickers = {
    front: makeRotationPicker(pools.front, rng),
    back: makeRotationPicker(pools.back, rng),
    closeup: makeRotationPicker(pools.closeup, rng),
  };
  const anyPicker = makeRotationPicker(outfits, rng);

  const closeupBases = bases.filter((b) => viewOfBase(b) === 'closeup');
  const normalBases = bases.filter((b) => viewOfBase(b) !== 'closeup');

  const assigned = new Map();
  let fellBack = 0;

  // Normal pairs: one pick per pool the pair actually needs.
  for (const [a, b] of sequentialPairs(normalBases)) {
    const views = new Set([viewOfBase(a), viewOfBase(b)]);
    const frontPick = views.has('front') ? pickers.front.pick() : null;
    const backPick = views.has('back') ? pickers.back.pick() : null;
    for (const id of a === b ? [a] : [a, b]) {
      const want = viewOfBase(id) === 'back' ? backPick : frontPick;
      if (want) { assigned.set(id, { outfitId: want, matched: true }); continue; }
      const fallback = anyPicker.pick();
      if (fallback) fellBack += 1;
      assigned.set(id, { outfitId: fallback, matched: false });
    }
  }

  // Close-up pairs: one pick from the close-up pool, shared by both shots.
  for (const [a, b] of sequentialPairs(closeupBases)) {
    const pick = pickers.closeup.pick();
    for (const id of a === b ? [a] : [a, b]) {
      if (pick) { assigned.set(id, { outfitId: pick, matched: true }); continue; }
      const fallback = anyPicker.pick();
      if (fallback) fellBack += 1;
      assigned.set(id, { outfitId: fallback, matched: false });
    }
  }

  // Original order out, so the results column matches the order you picked in.
  const rows = bases.map((b) => ({
    baseId: b,
    outfitId: assigned.get(b)?.outfitId ?? null,
    matched: assigned.get(b)?.matched ?? false,
  }));
  return { rows, fellBack };
}

function oneRowPerFolder(items, role) {
  const byFolder = new Map();
  for (const it of items) {
    const key = it.folderId || `__loose:${it.id}`;
    const cur = byFolder.get(key);
    if (!cur) { byFolder.set(key, it); continue; }
    const curTagged = cur.role === role;
    const itTagged = it.role === role;
    if (itTagged && !curTagged) { byFolder.set(key, it); continue; }
    if (itTagged === curTagged && (it.createdAt || 0) < (cur.createdAt || 0)) byFolder.set(key, it);
  }
  return [...byFolder.values()];
}

/**
 * Folder-tree helpers for the pickers.
 *
 * Once collections gained subfolders, this picker listed EVERY folder in one flat row — parents
 * and children side by side — and clicking a parent showed nothing, because its items live in its
 * children and the filter was an exact folderId match (owner, 2026-08-08: "so ugly and show
 * nothing when they all have").
 */
const childrenOfIn = (folders, pid) => folders.filter((f) => (f.parentId || null) === (pid || null));

/** A folder's id plus every id beneath it. Cycle-safe, so bad data cannot hang the render. */
function subtreeOf(folders, id) {
  const out = new Set([id]);
  for (let pass = 0; pass < 50; pass += 1) {
    const before = out.size;
    for (const f of folders) if (f.parentId && out.has(f.parentId)) out.add(f.id);
    if (out.size === before) break;
  }
  return out;
}

/**
 * The chip row for a level: the active folder's children, or — when it has none — its SIBLINGS.
 *
 * Showing only children meant a leaf folder rendered a row containing nothing but "All", which
 * reads as "everything disappeared" rather than "this folder has no subfolders" (owner,
 * 2026-08-08). Falling back to siblings keeps the row useful and lets you move sideways between
 * folders at the same level instead of going back to All every time.
 */
function levelFor(folders, activeId) {
  const kids = folders.filter((f) => (f.parentId || null) === (activeId || null));
  if (kids.length || !activeId) return kids;
  const me = folders.find((f) => f.id === activeId);
  return folders.filter((f) => (f.parentId || null) === (me?.parentId || null));
}

/** Root → … → active, for the breadcrumb. */
function pathTo(folders, id) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path = [];
  const seen = new Set();
  let cur = id ? byId.get(id) : null;
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); path.unshift(cur); cur = cur.parentId ? byId.get(cur.parentId) : null; }
  return path;
}
const parallelFor = (engine) => (engine === 'nano2' ? NANO2_PARALLEL_REQUESTS : PARALLEL_REQUESTS);

/**
 * Retry a generation call that came back rate-limited, backing off between attempts.
 *
 * Nothing else in this stack retries a 429: wavespeedService._fetchWithRetry retries connection
 * failures only, and Vertex's RESOURCE_EXHAUSTED surfaces straight through as a thrown error. So a
 * quota bump did not slow a batch down, it DELETED images from it — and until the retry panel
 * existed you could not even tell which ones. Lowering concurrency makes that rarer; it cannot make
 * it impossible, because quota is shared with everything else hitting the same project.
 *
 * Only 429 / RATE_LIMITED is retried. Every other failure is returned to the caller untouched: a
 * bad prompt or a missing key fails the same way on attempt four as on attempt one, and retrying it
 * would just spend three more calls to reach the same place.
 */
async function withRateLimitRetry(fn, { attempts = 4, baseDelayMs = 4000 } = {}) {
  for (let i = 0; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      const limited = err?.status === 429 || err?.code === 'RATE_LIMITED';
      if (!limited || i >= attempts - 1) throw err;
      // Linear, not exponential: quota windows here refill on a clock rather than easing off under
      // load, so a long tail of doubling waits buys nothing over an even spacing.
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
}

/**
 * Failures that will fail identically forever, so neither a retry nor an engine swap can help.
 *
 * This list is what keeps "try 4 times, then fall back" from turning a missing API key into five
 * pointless calls per image — on an 81-image batch that is 405 requests to reach the same place.
 * Every one of these is a configuration or request problem, not a generation problem. Note the key
 * codes especially: the Seedream fallback bills the SAME WaveSpeed key, so falling back with a bad
 * or absent key cannot possibly succeed.
 */
const TERMINAL_CODES = new Set([
  'VALIDATION_ERROR', 'WAVESPEED_KEY_REQUIRED', 'NO_WAVESPEED_KEY', 'INVALID_API_KEY', 'INVALID_MODEL',
]);
const isTerminalError = (err) => TERMINAL_CODES.has(err?.code) || err?.status === 401;

/**
 * Retry anything that is not terminal — rate limits, connection drops, timeouts, empty results, and
 * the content guard.
 *
 * The guard is the reason this exists alongside withRateLimitRetry. A refusal comes back as
 * WAVESPEED_FAILED, which the rate-limit-only retry treated as final, so a single guard hit deleted
 * that image from the batch. Nano Banana 2 samples, so the same prompt often passes on a later
 * attempt (owner, 2026-08-09). onRetry reports each attempt so the tile can say what is happening
 * rather than sitting silent for four rounds of backoff.
 */
async function withEngineRetry(fn, { attempts = 4, baseDelayMs = 4000, onRetry } = {}) {
  for (let i = 0; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (isTerminalError(err) || i >= attempts - 1) throw err;
      if (onRetry) onRetry(i + 2, attempts, err);
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
}

// Videos are heavier per-request than images (each submission reads the full source image off
// disk, base64s it, and waits on Muapi's create-task call) and the render itself is slow — a
// separate, smaller cap so raising PARALLEL_REQUESTS can never accidentally raise this too.
const VIDEO_PARALLEL_REQUESTS = 2;

// Fast, not VIP: VIP bills 40% more per second ($0.21 vs $0.15) for a tier nobody asked for.
//
// WHAT THIS IS ACTUALLY COUPLED TO: the `model` posted from submitVideo() below IS what the
// server bills, priced by MUAPI_VIDEO_PRICES in server/config/muapiVideoModels.js. That map is
// the only thing this id has to agree with. (It is NOT coupled to VIDEO_MODEL in
// server/services/runVideo.js — nothing calls that module; see its header.)
const VIDEO_MODEL_ID = 'seedance-2-fast';
// Price AND label both come off the one SEEDANCE_MODELS entry, so the tier shown in the
// Generation Feed can never drift from the tier being billed — a hand-written label said
// "Seedance 2 VIP" for a whole release while Fast was what was dispatched and charged.
const VIDEO_MODEL_SPEC = SEEDANCE_MODELS.find((m) => m.id === VIDEO_MODEL_ID);
const VIDEO_PRICE_PER_SECOND = VIDEO_MODEL_SPEC?.pricePerSecond ?? 0.15;
const VIDEO_MODEL_LABEL = VIDEO_MODEL_SPEC?.label ?? VIDEO_MODEL_ID;

/**
 * The ONE place a clip's length is decided.
 *
 * A pose prompt is free text, so its "Duration:" line can say anything — "exactly 60 seconds"
 * quoted $9.00 a clip and dispatched 60, and a prompt parsing to 0 quoted $0.00 while the
 * server's `Number(duration) || 5` silently rendered (and billed) 5 seconds. Both the quote and
 * the dispatch call this, so the number the user is shown is always the number that is sent.
 * Same 4-15s bounds SeedanceVideoPage and SeedanceOmniPage clamp to, from the shared constants.
 */
function clipDurationFor(videoPrompt) {
  const requested = Math.round(Number(parseDurationSeconds(videoPrompt)) || 0);
  const seconds = Math.min(SEEDANCE_DURATION_MAX, Math.max(SEEDANCE_DURATION_MIN, requested));
  return { seconds, requested, clamped: seconds !== requested };
}

// A fixed instruction appended to EVERY dispatched video prompt while the page's "Static camera"
// toggle is ON (the user's default — they want handheld drift/zoom locked out fleet-wide). It rides
// ONLY in the `prompt` string sent to Muapi in submitVideoJob; it is NEVER fed to clipDurationFor.
//
// MONEY-SAFETY, verified by eye: this line contains no "Duration:" label and no "<N> seconds"
// phrase — nothing parseDurationSeconds() keys on — so even if it were ever parsed by accident the
// billed length could not move. The duration is always taken from the ORIGINAL pose prompt; this
// text only changes what the camera does, never what the clip costs.
const CAMERA_LOCK_INSTRUCTION = '\n\nCAMERA LOCK: perfectly static locked-off camera — no camera movement, no pan, no tilt, no zoom, no push-in or pull-out, no handheld shake. Only the subject moves.';

// Appended LAST to every dispatched video prompt, always.
//
// Removing music from the prompt text (stripAudioCues below) was not enough: this model GENERATES
// its own soundtrack when nothing forbids it, so clips kept coming back with music over them even
// though the prompt never mentioned any. Saying nothing about audio is read as "your choice" — the
// ban has to be explicit, and last, so it is the final word.
//
// THE BAN IS MUSIC ONLY. An earlier version banned ALL audio ("completely silent") and the clips
// came back with no voice, no breathing, no room tone — which is not what was wanted. Her sound is
// the point; only the invented backing track is not. Keep this wording narrow.
//
// MONEY-SAFETY, same rule as the camera lock: no "Duration:" label and no "<N> seconds" phrase, so
// parseDurationSeconds() cannot key on it and the billed length cannot move.
const NO_AUDIO_INSTRUCTION = '\n\nNO MUSIC — CRITICAL: do NOT add any music, soundtrack, score, song or backing beat. Natural sound is fine and wanted — her voice, speech, breathing and the room\'s own ambience. The ban is on MUSIC only, not on audio.';

// Strips music / audio / sound cues out of a video prompt before it is dispatched. Seedance is
// image-to-video and renders a SILENT clip, so any "Audio:/Music:/Sound:" bullet or a "background
// music" phrase describes nothing that can appear in the output — worse, it nudges the motion model
// toward music-video behaviour (bobbing/dancing to a beat that isn't there). Requested: "delete any
// music... only real stuff not music". Applied to EVERY dispatched prompt in submitVideoJob, so it
// covers every pose regardless of how its prompt was written.
//
// Deliberately conservative so it never eats visible action:
//  - A whole line is dropped ONLY when it is an audio-LABELLED bullet/header ("* Audio: ...",
//    "Music:", "Sound design:", "Soundtrack:", "Voiceover:") — those lines are entirely about sound.
//  - Otherwise only the music/audio PHRASE is removed from inside a line, leaving the visible action.
//  - "moans"/"breathy" (a visible facial action) and "beat" (a rhythm/movement word) are NOT touched
//    — the request was music, not the performance.
//  - "Duration:" is never an audio label, so the billed length is never removed. MONEY-SAFE.
// The prompts carry an "Avoid overacting / no exaggerated expressions" bullet in their IMPORTANT
// block. It directly CANCELS the FACIAL PERFORMANCE block above it — one asks for a mobile, reacting
// face (lip bites, brow flicks, blinks, a visible swallow), the other tells the model to keep the
// face still. Given a preserve rule and a contradicting rule the model splits the difference and you
// get neither, so the contradiction is deleted rather than argued with. Only the acting ban goes;
// "Avoid AI glossy look / plastic skin" and the rest of the IMPORTANT bullets are untouched.
const OVERACTING_LINE = /^\s*[*\-•·]?\s*avoid\s+over-?acting\b/i;
const AUDIO_LABEL_LINE = /^\s*[*\-•·]?\s*(audio|music|soundtrack|sound design|sound effects?|sfx|song|voice ?over)\s*:/i;
const AUDIO_PHRASE = /\b(?:background |soft |upbeat |sensual |ambient |gentle )?music(?:al)?\b|\bsoundtrack\b|\ba song\b|\bsings? along\b|\bsinging along\b|\bhumming a tune\b|\bto the beat of the music\b|\bset to music\b|\bASMR\b/gi;
function stripAudioCues(text) {
  if (!text) return text;
  const out = [];
  for (const line of String(text).split('\n')) {
    if (AUDIO_LABEL_LINE.test(line)) continue;               // whole sound-labelled bullet/header goes
    if (OVERACTING_LINE.test(line)) continue;                // the expression-killing bullet goes too
    let l = line.replace(AUDIO_PHRASE, '');
    // Tidy the artifacts a removed mid-sentence phrase leaves behind ("  ", " ,", " .", "to the .").
    l = l.replace(/\bto the\s+([.,;])/gi, '$1').replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/,\s*,/g, ',');
    out.push(l);
  }
  return out.join('\n');
}

// Seedance's image-to-video aspect-ratio enum is a near-miss of Seedream's — every Seedream
// ratio maps straight across except 2:3/3:2, which Seedance has no slot for at all. Snapping
// those to their closest portrait/landscape neighbour beats letting the server silently fall
// back to 16:9, which would render a vertical pose photo into a horizontal video.
const SEEDANCE_RATIO_FALLBACK = { '2:3': '3:4', '3:2': '4:3' };
function toVideoAspectRatio(seedreamRatio) {
  if (SEEDANCE_ASPECT_RATIOS.includes(seedreamRatio)) return seedreamRatio;
  return SEEDANCE_RATIO_FALLBACK[seedreamRatio] || '16:9';
}

// LEGACY name prefix. A PREVIOUS version of the result-favorite star filed a NEW, blank pose item
// under `eddy-result-<galleryId>` (empty prompt / video prompt / title) and favorited THAT — creating
// a duplicate row with no content. That path is gone: favoriting a result now moves its actual SOURCE
// pose (result.combo.poseId) into Favorites, fully populated. This constant survives only so the mount
// cleanup below can find and delete those orphaned blank rows the old version left behind.
const RESULT_POSE_PREFIX = 'eddy-result-';

const ASPECT_OPTIONS = [{ value: 'auto', label: 'Auto (match photo 1)' }, ...SEEDREAM_ASPECT_RATIOS.map((r) => ({ value: r, label: r }))];
const RES_OPTIONS = SEEDREAM_RESOLUTIONS.map((r) => ({ value: r, label: r }));

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  return m ? { mimeType: m[1], base64: m[2] } : null;
}

/**
 * Fetches a server-hosted image (a gallery URL) and returns it as a base64 data URL.
 *
 * The regenerate/edit path needs the CURRENT result's bytes to send back as image 1, but a result
 * only carries a `galleryId` (a reference to the server copy), never the bytes — see the "ONLY
 * these light fields" persist note below. So the picture has to be pulled before it can be re-sent.
 * Self-contained (its own FileReader, no fileToDataUrl import) to match the module's parseDataUrl.
 * Throws on a non-OK response so the caller can fall back to the re-roll path rather than dispatch
 * an edit with no base image.
 */
async function urlToDataUrl(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`Could not download that image (${resp.status})`);
  const blob = await resp.blob();
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// The clothed-figure lock, extracted so the batch prompt (buildPrompt) and the edit prompt
// (buildEditPrompt) append the EXACT same sentence — a bust/figure enlargement with NSFW OFF must
// happen UNDER the clothes on both paths, and two hand-copied strings would drift. Verbatim the
// wording that was reported-and-fixed (a hoodie, breasts out); do not soften it.
const CLOTHED_FIGURE_LOCK = 'CLOTHED FIGURE — CRITICAL, OVERRIDES THE BUST INSTRUCTION ABOVE: she stays FULLY DRESSED. The garment stays completely on and covers her breasts and torso exactly as much as the outfit does — the neckline and coverage are unchanged. Any increase in bust or figure shows ONLY as the fabric stretching and straining over a fuller shape underneath. Do NOT open, lower, lift, unzip, pull up, pull aside or remove any clothing; do NOT expose breasts, nipples, areola or any skin the outfit covers. Read "cleavage" and "fuller bust" as the silhouette THROUGH the clothing, never as bare skin.';

// Scopes a body/bust instruction to what a BACK-facing pose can actually show.
//
// WHY THIS IS NEEDED: the body chips are written in front-of-body language — "deep cleavage",
// "the neckline is pushed out by them", "fuller chest". On a back-facing pose none of that is in
// frame, and the model has only two ways to satisfy the words: ignore them, or TURN HER AROUND to
// bring her chest into view. The second one silently destroys the pose, which is the one thing the
// pose label exists to protect (owner, 2026-08-06). So the instruction is not dropped — hips, waist
// and build read perfectly well from behind, and dropping it would ignore a chip that was
// deliberately clicked — it is re-aimed, and the re-orientation is banned outright.
const BACK_VIEW_BODY_SCOPE = 'BACK VIEW — HER FACING DIRECTION IS FIXED: this shot is taken from BEHIND her. Her back, shoulders and the BACK of the outfit face the camera, exactly as the pose shows. Any figure or bust wording above applies ONLY to what is visible from behind: her overall build and weight, her hips, her waist, the width of her back and shoulders. Words like "cleavage", "neckline", "fuller chest" and "deep cleavage" describe a side of her body this shot does not show — express them through her build alone. Do NOT turn, twist, rotate or re-angle her toward the camera, do NOT bring her chest or the front of the garment into frame, and do NOT change the pose in any way to make a bust instruction visible.';

/**
 * Resolves a result's SOURCE pose id, with a fallback for results that predate `combo` — pure and
 * synchronous so it can run either against a fresh `poseStore.listItems()` read or the page's
 * already-loaded `poses` state, with no store call of its own.
 *
 * 1. `result.combo.poseId`, but only if it still resolves to a real row in `poseItems` — the direct,
 *    unchanged path. A stale id (the pose was since deleted) does NOT count as resolved here; it
 *    falls through to the text match below instead of dead-ending on a deleted pose.
 * 2. Else, match by exact (trimmed) `videoPrompt` text against every pose's `videoPrompt` — the same
 *    fallback idea `clearVideoPromptFor` above already uses for results saved before poseId existed,
 *    or rehydrated with a dangling one. The result's videoPrompt is inherited from its source pose and
 *    persisted on the result, so an identical trimmed string is almost certainly the same pose.
 *    If more than one pose shares that exact videoPrompt, the FIRST match is used — acceptable for a
 *    favorite (it still lands on a real, fully-populated pose), just not guaranteed to be the exact
 *    one that was picked at generation time.
 * 3. Else null — genuinely nothing to favorite (no combo AND no matching pose).
 */
function resolveSourcePoseId(result, poseItems) {
  const comboPoseId = result?.combo?.poseId;
  if (comboPoseId && poseItems.some((p) => p.id === comboPoseId)) return comboPoseId;
  const needle = (result?.videoPrompt || '').trim();
  if (!needle) return null;
  const match = poseItems.find((p) => (p.videoPrompt || '').trim() === needle);
  return match ? match.id : null;
}

/**
 * The prompt is built here, not typed. Seedream anchors on image 1, so the subject goes first
 * and the outfit/pose images follow as things to TAKE FROM — the order is what stops her
 * identity being replaced by whoever is wearing the outfit.
 *
 * `poseText` arrives already reduced to a sentence by poseSentence() in lib/poseText.js — that
 * helper is what keeps a saved pose's own identity rules out of this prompt.
 */
// A pose is "faceless" when its own text says so — many of these cards are cropped torso/body shots
// ("Faceless upper body", "Faceless body shot", face turned away / below frame). For those, forcing
// the face in (via the FINAL CHECK identity lock) fights the pose's framing and the model zooms out
// to reveal a face the reference never showed. Detected from the RAW pose prompt (the JSON blob's
// subject.features field carries "Faceless…", which poseSentence strips out), so it must be read
// before that reduction. Kept broad but literal to avoid false positives on a normal face-forward pose.
/**
 * Pose cards carry their own trailing "LIGHTING: …" clause (the pose sheets were written with one
 * baked in). The page now has its own Lighting control, so leaving it in means two lighting
 * instructions in the same prompt pulling different ways. The pose contributes the POSE; lighting
 * comes from the page. Only a trailing clause is removed, so a pose that merely mentions light
 * mid-sentence is untouched.
 */
function stripPoseLighting(text) {
  return String(text || '').replace(/\s*LIGHTING\s*:.*$/is, '').trim();
}

// How many gallery images the picker mounts per page (see libraryShown).
const LIBRARY_PAGE = 200;

// How wide the setup column may get, in px. Stepped so a click always lands somewhere sensible.
const SETUP_W_MIN = 360;
const SETUP_W_MAX = 900;
const SETUP_W_STEP = 40;
const SETUP_W_KEY = 'eddy.setupWidth';

const POSE_FACELESS_RE = /faceless|face (?:is )?(?:out of frame|not (?:visible|shown|in frame)|cropped)|no face(?: shown| visible)?|head (?:is )?(?:out of frame|cropped|not (?:visible|shown))|cropped (?:at|above) the (?:neck|chin|shoulders?)|below the (?:neck|chin|face)|face turned (?:away|out of frame)/i;

// Lighting choices offered above the Generate button. 'auto' keeps image 1's own lighting (the old
// behaviour); any other RELIGHTS the scene with a soft, natural description — the setting/background
// still come from image 1, only the light changes. `text` is what buildPrompt splices in.
const LIGHTING_OPTIONS = [
  { value: 'auto', label: 'Match photo', text: '' },
  // Moody / commanding — her vibe (dominatrix, BDSM). All still NATURAL and photorealistic: dim and
  // low-key, but skin is rendered with real texture and never crushed to black.
  { value: 'moody', label: 'Moody low-key', text: 'Moody low-key natural light: dim and intimate, a single soft source carving gentle directional shadow across her, dark sensual atmosphere and deep soft shadows — commanding mood, but her skin stays naturally rendered with real texture, never crushed to pure black.' },
  { value: 'dramatic', label: 'Dramatic side light', text: 'One soft directional light from the side, natural falloff carving a strong but soft shadow across her body and face, moody and dominant — photorealistic skin, not a hard studio strobe.' },
  { value: 'candlelit', label: 'Candlelit warm', text: 'Warm dim candlelit glow, soft flickering warmth pooling on her skin, intimate deep shadows around her, low and sensual — natural warm tones, nothing harsh.' },
  { value: 'night', label: 'Cool night', text: 'Cool dim night light from a bedroom window with a soft city glow, moody low blue-toned light, deep soft shadows and quiet intimate atmosphere — natural, true skin under the cool cast.' },
  // Softer / brighter naturals, for variety.
  { value: 'soft', label: 'Soft diffused', text: 'Soft, diffused natural light with a gentle even wrap across her skin, soft shadow edges and low contrast — no harsh highlights or hard shadows.' },
  { value: 'window', label: 'Window daylight', text: 'Soft daylight through a large window from one side, natural falloff across her body, soft shadows and true-to-life skin tones.' },
  { value: 'golden', label: 'Golden hour', text: 'Warm golden-hour light from a low angle, soft and flattering, a gentle warm glow on her skin with soft long shadows.' },
  { value: 'studio', label: 'Studio softbox', text: 'Soft studio softbox lighting, even and flattering, small round catchlights in the eyes and clean natural skin texture.' },
  { value: 'bright', label: 'Bright & clean', text: 'Bright, clean, even natural lighting with true-to-life skin tones and no colour cast.' },
];
const lightingTextFor = (v) => (LIGHTING_OPTIONS.find((o) => o.value === v)?.text || '');

/**
 * HER BUILD — a standing fact about the character, NOT a change to her.
 *
 * This is deliberately separate from the BODY instruction chips, and the difference is the whole
 * point. A chip sets `wantsBody`, which SWITCHES OFF both bust-preservation locks (the early
 * "her BREAST size … match image 1" and the final "BUST AND BODY — FINAL"), because those locks
 * exist to stop a deliberate enlargement being cancelled. That is right for "make her bigger than
 * the photo" and wrong for "this is what she looks like": a character whose reference photo ALREADY
 * shows the target build was losing her strongest protection in order to state a size she already
 * had (owner, 2026-08-06 — Grace is large, another model is medium, and each wants her own build
 * held, not altered).
 *
 * So these options never touch `wantsBody`. They ride WITH the preservation locks, naming the size
 * the locks are holding, which is exactly what a lock cannot do on its own — "the size in image 1"
 * is unfalsifiable to the model when a slimmer pose stand-in is also in the payload.
 *
 * 'auto' is the default and emits nothing: the locks alone, i.e. the behaviour that shipped before
 * this existed.
 */
const BUILD_OPTIONS = [
  { value: 'auto', label: 'From photo', text: '', backText: '' },
  { value: 'petite', label: 'Petite',
    text: 'She is petite and slim with a small bust — that is her natural build, exactly as in image 1, and it is preserved, not changed.',
    backText: 'She is petite and slim with narrow hips and a slender back — that is her natural build, exactly as in image 1, and it is preserved, not changed.' },
  { value: 'medium', label: 'Medium',
    text: 'She has a medium, natural bust and an average build — that is her natural figure, exactly as in image 1, and it is preserved, not changed.',
    backText: 'She has an average, natural build with proportionate hips and waist — that is her natural figure, exactly as in image 1, and it is preserved, not changed.' },
  { value: 'full', label: 'Full',
    text: 'She has a full, shapely bust and curvy figure — that is her natural build, exactly as in image 1, and it is preserved, not changed.',
    backText: 'She has a full, curvy figure with shapely hips and a narrow waist — that is her natural build, exactly as in image 1, and it is preserved, not changed.' },
  { value: 'large', label: 'Large',
    text: 'She has a LARGE, heavy, full bust with deep natural cleavage and a curvy figure — that is her natural build, exactly as in image 1, and it is preserved, not changed. Never render her smaller, flatter or more athletic than this.',
    backText: 'She has a full, curvy figure with wide shapely hips and a narrow waist — that is her natural build, exactly as in image 1, and it is preserved, not changed. Never render her slimmer or more athletic than this.' },
  { value: 'verylarge', label: 'Very large',
    text: 'She has a VERY LARGE, heavy, extremely full bust — big, weighty and rounded, sitting wide on her chest with deep natural cleavage between them — and a strongly curvy figure. That is her natural build, exactly as in image 1, and it is preserved, not changed. Never render her smaller, flatter, perkier or more athletic than this.',
    backText: 'She has a strongly curvy figure with wide shapely hips and a narrow waist — that is her natural build, exactly as in image 1, and it is preserved, not changed. Never render her slimmer or more athletic than this.' },
];

/**
 * The build line for a given view.
 *
 * BACK POSES GET A DIFFERENT SENTENCE, NOT THE SAME ONE. Every front variant above names the bust
 * and, at the larger sizes, "deep natural cleavage" — and a back-facing shot shows none of that.
 * Feeding it anyway recreates precisely the failure BACK_VIEW_BODY_SCOPE was written to stop: the
 * model can only satisfy cleavage wording by twisting her toward the camera, which destroys the
 * pose (owner, 2026-08-06 — "ignore it if it is a back pose").
 *
 * Suppressing it outright was the other option and is worse: hips, waist and back width DO read
 * from behind, and those are exactly what a slimmer pose stand-in pulls her toward. So the back
 * variants keep the same anchoring job using only what the camera can actually see.
 */
const buildTextFor = (v, view) => {
  const o = BUILD_OPTIONS.find((x) => x.value === v);
  if (!o) return '';
  return view === 'back' ? (o.backText || '') : (o.text || '');
};

function buildPrompt({ instruction, outfitText, poseText, outfitIndex, poseIndex, faceIndex, nsfw, wantsNude, wantsBody, undressChip, tweak, poseFaceless, lightingText, poseView = 'front', buildText = '', expressionText = '', lockOutfitToBase = false }) {
  // Back-facing poses take a different final body clause — see BACK_VIEW_BODY_SCOPE.
  const isBackView = poseView === 'back';
  const lines = [];

  // A per-image retry note typed on the review gate's card ("her hand is broken", "make the light
  // warmer"). It ADDS to this prompt, it does not replace it: the pose, the character, the outfit
  // and the page instruction all still apply. The normal batch path passes nothing, and every
  // line below must then be byte-identical to what it was before tweaks existed — which is why
  // each variant is spliced in rather than the line being rewritten wholesale.
  const tweakText = String(tweak || '').trim();
  const hasTweak = Boolean(tweakText);

  // WHY the absolutes below stand down when a tweak is present: this prompt is full of rules that
  // preserve something ("recreate her pose EXACTLY", "the setting comes from image 1 AND NOTHING
  // ELSE"). A free-text tweak is almost always asking to change one of exactly those things — the
  // two examples the feature was asked for, a broken hand and warmer light, land on the pose lock
  // and the setting/lighting lock respectively. Left as written, the tweak and the lock are two
  // absolute contradictory orders and Seedream honours NEITHER faithfully — the same cancelling
  // conflict already handled for outfit-vs-nude above. So when a tweak exists the absolute form
  // of each rule it could contradict is switched off and replaced with one that names the
  // correction as the single authorised exception. They are not simply deleted: a tweak about
  // lighting must not also cost the user the pose they chose, so the rule stays and only its
  // absolutism goes. The identity/face lock is deliberately NOT softened — see FINAL CHECK below.
  const exceptCorrection = hasTweak ? ', except where the CORRECTION at the end says otherwise' : '';

  // Image 1 carries who she is AND where she is; image 2 is a close-up used only to lock the
  // face. Naming each one's job stops the two references competing over the same features.
  // With a custom lighting choice the lighting no longer "comes from image 1" — say so here and relight
  // it below, so the two statements do not contradict (the same conflict a "warmer light" tweak hits).
  const keepsLighting = !lightingText;
  const settingParts = keepsLighting ? 'location, background and lighting' : 'location and background';
  // "…and NOT her pose" is load-bearing. Image 1 is named as the source of identity, body, skin AND
  // the setting, and with nothing excluded the model kept her image-1 POSE and framing too and
  // ignored the pose diagram entirely — every result came back as the base photo's shot. The outfit
  // has always had its own "ignore what she is wearing in the references" rule; pose had none.
  lines.push(`The woman in image 1 is the subject. Her identity, body and skin come from image 1${poseIndex || poseText ? ' — but NOT her pose and NOT her framing' : ''}. The ${settingParts} of image 1 are kept as the setting${hasTweak ? ', unless the CORRECTION at the end changes them' : ''}.${wantsNude ? ' Her CLOTHING is NOT kept — see the clothing instruction below.' : ''}`);
  if (faceIndex) {
    // Only when the FACELESS toggle is on does the face reference become conditional ("if in frame,
    // match it") — that is what lets a cropped pose keep her face out. With the toggle off the lock is
    // absolute, so a normal pose renders her exact face.
    lines.push(poseFaceless
      ? `Image ${faceIndex} is a close-up of the SAME woman. IF her face is visible in this shot's framing, it must match image ${faceIndex} exactly — bone structure, eyes, nose, lips, hairline. If the pose's framing crops her face out of frame, do NOT add her face to reveal it. Take nothing else from this close-up.`
      : `Image ${faceIndex} is a close-up of the SAME woman. Use it as the exact reference for her face — bone structure, eyes, nose, lips and hairline must match it precisely. Take nothing else from it: not its background, framing, clothing or pose.`);
  }
  if (wantsBody) {
    lines.push('Her FIGURE changes as directed below, while her face and identity stay exactly as above.');
  } else {
    // Default path: her figure is part of her identity and must be carried over from image 1, not
    // redrawn. Without this, the pose diagram (a DIFFERENT, often slimmer / smaller-busted stand-in)
    // pulls the result toward that build and her distinctive figure is lost — reported as "not using
    // the base body and breast size". The generic "body and skin come from image 1" above is not
    // strong enough to hold the bust against a competing pose reference, so name the figure
    // explicitly. Fires ONLY when no body chip is active (wantsBody) — a deliberate enlargement or
    // slim must not be cancelled by this lock.
    lines.push(`Her whole BODY comes from image 1 and must be preserved exactly: her body WEIGHT and build, her overall SIZE, her BREAST size and chest fullness, her waist, her hips and her figure all match image 1.${poseIndex ? ' Copy ONLY the POSITION and camera from the pose diagram — take NOTHING about the pose stand-in’s body: not her weight, not her size, not her bust, not her build.' : ''} Do NOT slim her down, shrink her bust, or average her figure toward a thinner or smaller-busted default: if image 1 shows a full, heavy, curvy figure, the result shows exactly that same weight and fullness.`);
    // Names the build the lock above is holding. "The size in image 1" is unfalsifiable to the
    // model when a slimmer pose stand-in sits in the same payload; a stated size is not. Suppressed
    // when a BODY chip is active — a chip is an explicit change, and describing her current build
    // beside it would be the same contradiction that broke 'Bigger bust, clothed'.
    if (buildText) lines.push(`HER BUILD: ${buildText}`);
  }

  // Outfit and pose are prompts that MIX into one image. Any attached picture is only an
  // example of what the words mean, so the text leads and the image is pointed at afterwards.
  // Undressing her and dressing her cannot both be requested. If the instruction says nude,
  // the outfit stands down entirely — otherwise the prompt asks for a lace bodysuit AND for no
  // clothing at all, and the model resolves that by doing neither properly.
  if (outfitText && !wantsNude) lines.push(`OUTFIT: ${outfitText}`);

  if (outfitIndex && !wantsNude) {
    // Outfit images used to be withheld entirely because these are PRODUCT shots — a garment on a
    // mannequin with a room behind it — and that background kept arriving with the garment. Sending
    // it is worth it for garment accuracy, but only with the leak named explicitly: take the clothing
    // and nothing else. Stated right next to the image so the two are read together.
    lines.push(`Image ${outfitIndex} is a PRODUCT PHOTO OF THE OUTFIT — a garment shown on its own, on a mannequin or on a hanger. It is NOT a person and NOT the subject. Take ONLY the garment from it: its cut, neckline, colour, material, sheen, straps, zips and detailing. Take NOTHING else from it — not its background, not its room, not the mannequin or any body in it, not its lighting, not its framing. Nobody from that image appears in the result.`);
    // The garment must be re-fitted to HER, not copied at the product photo's proportions. Sending the
    // outfit image made the chest come back flat: the mannequin's shape was being reproduced along with
    // the garment, overriding her bust. The garment is a template for the CLOTHING only; the BODY
    // inside it is always image 1's.
    lines.push(`That garment is worn by HER and takes HER shape — it is NOT copied at the product photo's proportions. The mannequin's or flat-lay's chest, waist and hips mean nothing here. The clothing stretches and fills out over the body from image 1: her FULL bust fills the top, the fabric strains over her chest, the neckline sits where her cleavage pushes it. Never flatten, shrink or reshape her breasts to match the garment's shape in image ${outfitIndex}.`);
    /**
     * The line the friend's pipeline leans on hardest, in its own words.
     *
     * cloth_swap_paired.py's PROMPT_FRONT/PROMPT_BACK say the same thing three times, twice in
     * quotes -- "Only use the outfit from @image2 DON'T use the person, body, skin or sizes" --
     * and its note explains why: 'Seedream needs this reinforced or it will re-render the body.'
     * That pipeline has run this exact swap over thousands of images, so the repetition is
     * evidence, not superstition. Stated last among the outfit lines, where it is read closest
     * to the generation.
     */
    lines.push(`ONLY the outfit comes from image ${outfitIndex}. Nothing else about that photo is used: not the person in it, not her body, not her skin, not her size or proportions. Everything else in the result is unchanged -- same face, same skin quality, same body, same pose, same background, same lighting, same composition and the same aspect ratio.`);
  }
  if ((outfitText || outfitIndex) && !wantsNude) {
    lines.push(`Ignore whatever she is wearing in her reference photos — her clothing comes only from the outfit${outfitIndex ? ` in image ${outfitIndex} and the description` : ' described'} above${exceptCorrection}.`);
    // A detailed garment description reads as "show off this garment", and the model answers it by
    // pulling the camera back to fit the whole outfit in — which quietly destroys a close-up pose.
    // Say outright that the outfit dresses her and nothing more.
    if (poseIndex) {
      lines.push(`The outfit description only says what she is WEARING. It does NOT decide the shot: do not zoom out, step back or widen the framing to show the whole garment. If the pose diagram crops the outfit, the outfit stays cropped.`);
    }
  }
  if (poseText) lines.push(`POSE: ${poseText}`);
  /**
   * THE POSE TEXT DESCRIBES A ROOM, and the model builds it.
   *
   * The vision pass that writes these descriptions does not restrict itself to the body — it writes
   * what it sees, furniture and all: "She is seated in a PINK VELVET ARMCHAIR with her torso leaning
   * back slightly and her arms resting out on the armrests…". So the prompt says the setting comes
   * from image 1 and then, in the very next breath, names a pink velvet armchair. The model resolves
   * that by building the armchair — reported as backgrounds coming from the pose instead of the base
   * (owner, 2026-08-09), and the surviving half of that report after the pose IMAGE's room was
   * already banned: this half leaks through the WORDS, so banning the picture did nothing.
   *
   * Not fixed by stripping the nouns out of the description. "Seated in an armchair" with the
   * armchair deleted is a woman sitting on nothing, and the pose stops being physically readable.
   * The furniture has to stay in the sentence and be re-pointed at image 1's own surfaces instead.
   *
   * Stated immediately after the POSE line so the two are read together, and again in the SETTING
   * block below — the same restate-where-it-competes pattern the body lock needed.
   */
  if (poseText) {
    lines.push(`The POSE description above may name furniture, props, surfaces or a location — a chair, a bed, a wall, a floor, a room. Those words describe ONLY how her body is arranged and supported. They are NOT part of the scene and must NOT be built: do not add that furniture, those props or that location to the image.`);
    lines.push(`Put the same body position into image 1's own setting instead${exceptCorrection}. If the pose rests on something that is not in image 1, she takes the same position on whatever image 1 actually has — its own seat, surface, floor or ground — at the same angle and the same height. The shape of her body is copied; the room around it is never copied.`);
  }
  // The pose photo's own facial expression. Stated next to the pose it came from, and kept to the
  // one sentence the vision pass wrote — this is a look to copy, not a second identity rule, so it
  // deliberately sits BEFORE the face-lock and FINAL CHECK lines that pin who she is.
  if (expressionText) lines.push(`EXPRESSION — copy the face she is making: ${expressionText}`);
  // TEXT-ONLY POSE — what makes the "pose photo NOT sent" toggle actually change the result.
  //
  // Every pose enforcement line below is gated on poseIndex because each one points at "image N".
  // With no pose image there is no N, so ALL of them drop — and what remains is a bare "POSE: ..."
  // sentence with nothing telling the model that image 1's own pose is not to be kept. The reliably
  // observed outcome of that is image 1's pose surviving untouched, which reads as "the toggle does
  // nothing" when in fact the prompt simply stopped asking. So the diagram's job is restated in
  // words: same three demands (ignore the reference pose, own the camera, own the framing), sourced
  // from the description instead of from a picture.
  if (poseText && !poseIndex) {
    lines.push(`IGNORE THE POSE SHE IS IN IN HER REFERENCE PHOTOS. Whatever she is doing in image 1 — how she sits, leans, holds her arms, where the camera was standing, how close it was — is NOT used. Her body position, her limbs, the CAMERA ANGLE and the crop come ONLY from the POSE description above.`);
    lines.push(hasTweak
      ? `POSE MATCH: build the shot from the POSE description — her body position, the camera angle it implies and how much of her is in frame — except where the CORRECTION at the end says otherwise.`
      : `POSE MATCH — TOP PRIORITY FOR THE SHOT: build the shot from the POSE description above and follow it exactly — every limb angle, the hands, the feet, the head tilt, the torso arch and twist, and the camera position and framing it describes. Do NOT default to a level, straight-on camera or to a standard full-body crop, and do NOT fall back to the pose in image 1.`);
  }
  if (poseIndex) {
    lines.push(`Image ${poseIndex} is a POSE DIAGRAM, not a person. A DIFFERENT woman appears in it and she is NOT the subject — she is a stand-in showing the shape to copy.`);
    // The pose counterpart to "ignore what she is wearing in the references". Without it image 1's
    // pose survives into the result and the diagram is ignored — the exact failure reported.
    lines.push(`IGNORE THE POSE SHE IS IN IN HER REFERENCE PHOTOS. Whatever she is doing in image 1 — how she sits, leans, holds her arms, where the camera was standing, how close it was — is NOT used. Her body position, her limbs, the CAMERA ANGLE and the crop come ONLY from image ${poseIndex}. Image 1 supplies who she is and the room; image ${poseIndex} supplies the shot, including where the camera is.`);
    // The absolute "EXACTLY" is dropped when a tweak exists: it is the line most likely to be
    // the thing the user is trying to override ("her hand is broken", "turn her head towards me")
    // and an unqualified EXACTLY standing against that produces neither the pose nor the fix.
    lines.push(hasTweak
      ? `Recreate her pose: the same body position, limb placement, arch and twist, head angle and gaze direction, and the same camera angle, distance and framing — except where the CORRECTION at the end says otherwise. Where the CORRECTION and this pose disagree, the CORRECTION wins.`
      : `Recreate her pose EXACTLY: same body position, same limb placement, same arch and twist, same head angle and gaze direction, and the same camera angle, distance and framing.`);
    // Stated after the pose clause on purpose. The face lock was being set out early and then
    // buried under later instructions, and the model kept taking the stand-in's face.
    lines.push(`The face and body of the woman in image ${poseIndex} must NOT appear in the result. Her face is not the subject's face. Copy her POSITION and the CAMERA, nothing about who she is.`);
    // "Nothing about who she is" was being read as face-only in practice — reported: the output's
    // BODY SIZE (chest, waist, hips, overall build) was drifting toward the pose diagram woman's
    // proportions instead of staying locked to the character. Naming size/proportions explicitly,
    // separately from the pose/position instruction above, is the same fix pattern that worked for
    // Scene Recreate's identical chest-size leak (owner, 2026-08-06).
    lines.push(`Body SIZE is NOT part of the pose. Her chest size, waist, hips and overall build come ONLY from image 1 — take her exact proportions from there and hold them. The pose diagram's proportions are irrelevant and must never be copied, matched or averaged toward, even though her position, limbs and camera angle come from image ${poseIndex}.`);
  }

  /**
   * WITH NO OUTFIT CHOSEN, nothing pins her clothing — deliberately, on the Eddy page. The model is
   * left free to follow the pose and the references, which sometimes undresses her. That was
   * reported as a bug once and then asked for on purpose: pick an outfit to be sure, or leave it
   * open.
   *
   * Max Nano has no outfit picker AT ALL, so "pick an outfit to be sure" is not available there and
   * that freedom is never what the user chose — it is just an unclaimed slot. Left unclaimed, the
   * pose diagram is the only other picture in the payload carrying clothes, and it won: poses shot
   * in a grey gym set and red lingerie came back dressed that way instead of in image 1's black lace
   * (owner, 2026-08-09). lockOutfitToBase closes the slot by naming image 1 as the source.
   *
   * Suppressed under wantsNude for the same reason the OUTFIT lines are: asking to keep her clothes
   * and to take them off at once is the contradiction the model resolves by doing neither properly.
   */
  if (lockOutfitToBase && !wantsNude && !outfitText && !outfitIndex) {
    lines.push(`Her CLOTHING comes from image 1 and is kept exactly as it is there: the same garments, the same cut and neckline, the same colour, the same material and the same amount of coverage${exceptCorrection}. She is NOT re-dressed and NOT undressed.`);
    if (poseIndex) {
      lines.push(`Whatever the stand-in in image ${poseIndex} is wearing is IRRELEVANT and must not appear — not her garments, not her colours, not her fabrics, not how much skin she shows. Clothing is not part of the pose.`);
      // Restated here, beside the pose diagram, rather than relying on the SETTING line further
      // down. That line has always existed and the room still drifted; the fix pattern that worked
      // for the identical body-size leak is to put the ban next to the thing it is competing with.
      lines.push(`The room in image ${poseIndex} is IRRELEVANT too — its background, furniture, surfaces, props and location contribute NOTHING. She stays in image 1's location. Only her body position and the camera come from image ${poseIndex}.`);
    }
  }

  if (instruction.trim()) lines.push(instruction.trim());

  // A bust/figure enlargement with NSFW OFF must happen UNDER the clothes. Without this, the
  // "VERY LARGE bust / deep cleavage" wording in the body instruction above fights the outfit
  // rule, and the model resolves it by pulling the top up and exposing her — reported as exactly
  // that (a hoodie, breasts out). Stated AFTER the instruction so it is the final, overriding
  // word: bigger shape, same coverage, nothing bare. Only when dressed (NSFW off) — with NSFW on,
  // exposure is the point and this must not fire.
  if (wantsBody && !nsfw) {
    lines.push(CLOTHED_FIGURE_LOCK);
  }

  // NSFW off otherwise adds nothing: the outfit rules keep her dressed for non-body changes, and a
  // "no nudity" line there only spends prompt on a restriction nobody asked for.
  if (nsfw && !undressChip) {
    // NSFW with no undress chip picked still means naked — the toggle IS the instruction.
    // Passed in rather than read from a module const so this function stays self-contained.
    lines.push('REMOVE ALL CLOTHING: she is completely naked. Take off every garment she is wearing in image 1 — top, bottom, underwear, straps, everything. Bare skin where those clothes were, with her natural body underneath. No fabric anywhere on her.');
  }

  // Seedream defaults to a shallow portrait look and blurs whatever is behind her. Stated as a
  // positive instruction AND a ban, because naming the effect alone tends to invite it.
  // "AND NOTHING ELSE" and the lighting clause are the pair a "make the light warmer" tweak runs
  // straight into, so the absolute stands down too. The ban on OTHER reference images feeding the
  // scene is kept either way — that guards against the pose diagram's room leaking in, which no
  // tweak is ever asking for.
  // The lighting clause here only holds when lighting is kept from image 1. With a custom lighting
  // choice the props/room still come from image 1 but the LIGHT is replaced — stated right after so it
  // is the last word on lighting and does not fight the "lighting comes from image 1" phrasing.
  if (keepsLighting) {
    lines.push(hasTweak
      ? 'THE SETTING COMES FROM IMAGE 1: the room, background, surfaces, props and lighting all come from image 1, except where the CORRECTION at the end changes them. Nothing else contributes any part of the scene: not another reference image, and not any room, furniture, prop or location named in the POSE description.'
      : 'THE SETTING COMES FROM IMAGE 1 AND NOTHING ELSE: the room, background, surfaces, props and lighting all come from image 1. Nothing else contributes any part of the scene: not another reference image, and not any room, furniture, prop or location named in the POSE description.');
  } else {
    lines.push(hasTweak
      ? 'THE SETTING COMES FROM IMAGE 1: the room, background, surfaces and props come from image 1, except where the CORRECTION at the end changes them. Nothing else contributes any part of the scene: not another reference image, and not any room, furniture, prop or location named in the POSE description.'
      : 'THE SETTING COMES FROM IMAGE 1: the room, background, surfaces and props come from image 1. Nothing else contributes any part of the scene: not another reference image, and not any room, furniture, prop or location named in the POSE description.');
    lines.push(`LIGHTING — relight the scene: ${lightingText} This lighting REPLACES the lighting in image 1; keep it natural and realistic on her skin. Everything else about the scene stays as image 1.`);
  }
  lines.push(hasTweak
    ? 'Keep the ENTIRE background sharp and in focus, fully detailed edge to edge — no bokeh, no depth-of-field blur, no soft or out-of-focus background, unless the CORRECTION at the end asks otherwise.'
    : 'Keep the ENTIRE background sharp and in focus, fully detailed edge to edge — no bokeh, no depth-of-field blur, no soft or out-of-focus background.');
  // BODY LOCK, RESTATED LAST — same reasoning as FRAMING below, and it took the same fix. The bust
  // instruction near the top kept losing: her chest came back small no matter how firmly it was
  // worded up there, because everything after it (outfit, pose, setting, background) had its say
  // later. It is repeated here, close to the end, where it competes with nothing. Deliberate
  // duplication: the early line establishes it, this one enforces it.
  // Only when no body chip is active — a deliberate enlargement/slim must not be overridden.
  if (!wantsBody) {
    // The neckline half of this only makes sense front-on. On a back view it is replaced with the
    // build-and-hips wording, so the lock still holds her figure without describing a neckline the
    // camera cannot see — which would invite the same turn-her-around failure BACK_VIEW_BODY_SCOPE
    // exists to stop.
    lines.push(isBackView
      ? `BUST AND BODY — FINAL, OVERRIDES THE OUTFIT AND THE POSE: her body is the body in image 1 — the same weight, the same build, the same hips, waist and back. Full and heavy if that is what image 1 shows.${poseIndex ? ` The woman in image ${poseIndex} is only a shape to copy — her build and her weight are NOT hers.` : ''} Do NOT slim her down or average her toward a thinner or more athletic default. Do NOT let a garment, a pose or a default body shape reshape her figure.`
      : `BUST AND BODY — FINAL, OVERRIDES THE OUTFIT AND THE POSE: her breasts are the size they are in image 1. Large, heavy and full if that is what image 1 shows. The clothing stretches over them; the neckline is pushed out by them.${poseIndex ? ` The woman in image ${poseIndex} is only a shape to copy — her chest, her build and her weight are NOT hers.` : ''} Do NOT render a smaller, flatter or more athletic chest than image 1. Do NOT let a garment, a pose or a default body shape reduce her bust.`);
    // Restated last with the lock it belongs to, same reason the lock itself is restated here.
    if (buildText) lines.push(`HER BUILD — FINAL: ${buildText}`);
    // What the GARMENT does about that build. HER BUILD describes her body; nothing was telling the
    // clothing to show it, so a large build under an outfit came back flattened — the shape was
    // stated and then hidden (owner, 2026-08-06, "under clothes it doesn't boost the volume").
    // CLOTHED_FIGURE_LOCK covers this on the chip path, but it is gated on wantsBody, so the build
    // dropdown — the whole point of which is to avoid setting wantsBody — never got it.
    // Skipped when she is undressed: there is no garment to strain. Kept short on purpose, this
    // prompt runs close to Seedream's ~5.3k 422 cap.
    if (buildText && !wantsNude) {
      lines.push(isBackView
        ? 'THROUGH THE CLOTHES: the garment takes HER shape — the fabric pulls taut across her hips and seat and her full curves read clearly through it. Never flatten her under the outfit.'
        : 'THROUGH THE CLOTHES: the garment takes HER shape — the fabric strains and pulls across her chest, the neckline is pushed out and open by her bust, and her full volume reads clearly through the material. Never flatten her under the outfit.');
    }
  }
  // Stated AFTER the bust block on purpose, following this file's own rule that the later line
  // wins: whatever front-of-body wording survived above, this is the last word on which way she
  // faces. Fires on every back pose, not only when a body chip is on — the block above ships
  // chest language either way.
  if (isBackView) lines.push(BACK_VIEW_BODY_SCOPE);

  // FRAMING IS STATED LAST, on purpose. It used to sit up with the pose block, where the setting
  // rules, the background rule and the final check all came AFTER it — and this file already learned
  // once (see the face-lock comment on the pose block) that an instruction stated early gets buried
  // under the ones that follow. A tight close-up pose kept coming back as a wide shot. Placed here it
  // is the last thing read before the identity check, competing with nothing.
  if (poseIndex) {
    // CAMERA ANGLE is a separate fact from framing and was the missing piece: framing says how much
    // of her is in frame, ANGLE says where the camera is standing. A chest close-up shot from below
    // and the same close-up shot from above are identical in framing and completely different
    // images. Stated first of the two, both at the end where nothing competes with them.
    lines.push(hasTweak
      ? `CAMERA ANGLE: put the camera where the pose diagram's camera is — same height, same direction, same tilt — except where the CORRECTION at the end says otherwise.`
      : `CAMERA ANGLE — MATCH THE POSE DIAGRAM EXACTLY: the camera sits in the SAME position relative to her as in the diagram. Same HEIGHT (below her looking up, level with her, or above her looking down), same DIRECTION (from the front, from the side, from behind, or overhead), same TILT and the same perspective. If the diagram looks UP at her from below, the result looks up at her from below. If it looks DOWN from above, the result looks down from above. If it is a POV down her own body, the result is that same POV. Do NOT re-shoot the pose from a different position, and do NOT default to a level, straight-on camera.`);
    lines.push(hasTweak
      ? `FRAMING: match the pose diagram's crop and camera distance — the same part of her body fills the frame — except where the CORRECTION at the end says otherwise.`
      : `FRAMING — THIS OVERRIDES EVERYTHING ABOUT THE SHOT: match the pose diagram's crop EXACTLY. The result is framed on the SAME part of her body, at the SAME camera distance and zoom. If the diagram is a tight close-up of her chest and torso, the result is that same tight close-up — do NOT zoom out, step back or widen to show more of her, and do NOT widen to show the outfit. If the diagram is a full-body shot, the result is full-body. How much of her body is visible, and where the frame cuts her, must match the diagram.`);
    // The FACE side of framing is the only part gated on the toggle: allowing her face out of frame
    // is a deliberate choice, while matching the crop is not.
    if (poseFaceless) {
      lines.push(`If her face is OUT of frame in the pose diagram — cropped above the chin, turned away, or below the frame — keep it out of frame in the result too. Do NOT pan, tilt up or re-frame to bring her face into view.`);
    }
    // POSE MATCH, stated LAST of the pose group and kept SHORT on purpose: this prompt already runs
    // near Seedream's length cap (~5.3k chars = a 422), so this is a tight final reinforcement, not a
    // re-statement. The camera/framing locks above cover WHERE the camera is and HOW MUCH is in frame;
    // this is the blunt final word on the body silhouette — trace it, do not reinterpret it. Softened
    // under a tweak so a correction ("turn her head") is not fighting an absolute EXACT.
    lines.push(hasTweak
      ? `POSE MATCH: trace image ${poseIndex}'s silhouette — limb angles, hands, feet, head tilt, torso twist — except where the CORRECTION says otherwise.`
      : `POSE MATCH — TOP PRIORITY FOR THE SHOT: reproduce image ${poseIndex}'s pose EXACTLY, joint for joint — every limb angle, the hands, the feet, the head tilt, the torso arch and twist. Trace the silhouette; do NOT reinterpret or "improve" it.`);
  }

  // The identity lock demands a face by default (portrait or a normal pose). ONLY when the FACELESS
  // toggle is on does it stop demanding one — that demand is exactly what reframes a cropped pose to
  // grow a face the reference never had.
  lines.push(poseFaceless
    ? `FINAL CHECK: the woman in the result is the woman from image 1 — her body, skin, hair and figure match image 1${faceIndex ? `, and her face IF in frame matches image ${faceIndex}` : ''}. This is a cropped / faceless shot: if her face is not in the pose's framing, do NOT add it or reframe to reveal it. No other person may appear.`
    : (faceIndex
      // Indexed, never hard-coded: the close-up is no longer always image 2 — the pose diagram now
      // takes slot 2 (it needs the weight) and the close-up moves after it.
      ? `FINAL CHECK: the woman in the result is the woman from image 1 and image ${faceIndex}. Her face must match image ${faceIndex}. No other face from any reference may appear.`
      : 'FINAL CHECK: the woman in the result is the woman from image 1. Her face must match image 1. No other face from any reference may appear.'));
  lines.push('Photorealistic: real skin texture with pores, natural hair, slight asymmetry. No plastic or CGI look.');

  // Stated LAST, and the softened rules above point forward to it by name. Two reasons it goes
  // here rather than next to the page instruction: the rules it overrides have to have been read
  // first for "except where the CORRECTION says otherwise" to resolve to anything, and this file
  // already learned once (see the face-lock comment on the pose block) that an instruction stated
  // early gets buried under the ones that follow it. The FINAL CHECK above is intentionally left
  // in front of it and intentionally left absolute: a tweak may change what she is doing, not who
  // she is, and every image in this app depends on her face not drifting between retries.
  if (hasTweak) {
    lines.push(`CORRECTION — this image is being generated again because it came out wrong. Fix exactly this: ${tweakText}. This correction OVERRIDES any instruction above that contradicts it. Everything else — her identity and face, the outfit, the setting and the rest of the pose — stays exactly as instructed above.`);
  }

  return lines.join(' ');
}

/**
 * The prompt for a REGENERATE, which EDITS the current result rather than re-rolling a fresh image
 * from the character source photos. It is deliberately NOT buildPrompt: buildPrompt assembles a
 * scene from a character + outfit + pose diagram, whereas here image 1 IS the finished photo and
 * everything about it — person, pose, outfit, background, framing — must be preserved, with only
 * the one requested change applied. Sharing buildPrompt would drag in the pose/outfit/setting locks
 * that only make sense when those references are being sent, which they are not on the edit path.
 *
 * <CHANGE> precedence: the per-tile `tweak` (what the user typed on THIS result) wins; else the
 * page's current `instruction` (the chips/text) so a plain Regenerate still applies the page's
 * intent; else a no-op refinement so an empty regenerate re-rolls the same look instead of sending
 * an empty instruction. When NSFW is off and the change is a body/bust enlargement, the same
 * clothed-lock the batch prompt uses is appended so an edit can no more undress her than a fresh
 * generation can.
 */
function buildEditPrompt({ tweak, instruction, nsfw, wantsBody }) {
  const change = String(tweak || '').trim()
    || String(instruction || '').trim()
    || 'a subtle natural refinement, keeping everything exactly the same';
  let prompt = `Image 1 is a photo to EDIT. Keep the woman's identity, face, body, pose, outfit, hair, background, lighting, camera angle and framing EXACTLY as in image 1. Apply ONLY this change: ${change}. Change nothing else. Photorealistic — real skin texture and detail, no CGI look.`;
  if (wantsBody && !nsfw) prompt += ` ${CLOTHED_FIGURE_LOCK}`;
  return prompt;
}


// Built-in outfits and poses, always offered in the pickers alongside anything you save in the
// Eddy tabs. They exist so Generate is usable with zero setup — an empty picker reads as
// "broken" even when it is only empty. They carry no image: a preset is words, and attaching a
// stock photo would send a stranger's body into the edit.

// One-tap additions to the instruction. Each states the change in ABSOLUTE terms — "a LARGE
// bust" rather than "bigger" — because Seedream reads comparatives against nothing and ignores
// them.
const INSTRUCTION_PRESETS = [
  { group: 'Body', chips: [
    ['Bigger bust', 'She has a LARGE full bust with deep natural cleavage.'],
    ['Much bigger bust', 'She has a VERY LARGE heavy bust, noticeably fuller than in the photo, with deep cleavage.'],
    // Says what the GARMENT does, not just what the body is. Asking only for a larger bust lets
    // the model reach for the shortest route to "larger" and open or remove the top, which is the
    // opposite of the point — this chip is for the clothed pages.
    ['Bigger bust, clothed', 'She has a LARGE full bust that fills out the top she is already wearing — the same garment, unchanged and still fully covering her, stretched taut across a fuller chest with a visible strain in the fabric. Do not open, remove, lower or replace any clothing.'],
    ['Curvier', 'She has a curvier hourglass figure — fuller bust and hips with a narrow waist.'],
    ['Slimmer', 'She has a slimmer, more slender figure.'],
  ] },
  { group: 'Sexual', nsfwOnly: true, chips: [
    ['Topless', 'Remove her top and bra completely — she is topless, bare breasts fully exposed, no fabric above the waist.'],
    ['Fully nude', 'Remove every garment she is wearing — she is completely naked, no clothing anywhere on her body.'],
    ['Legs spread', 'She is lying back with her legs spread wide open.'],
    ['Arched back', 'Her back is deeply arched, chest pushed forward and hips raised.'],
    ['On all fours', 'She is on all fours, looking back over her shoulder at the camera.'],
  ] },
  { group: 'Expression', chips: [
    ['Seductive', 'A sultry heavy-lidded seductive look straight down the lens, lips slightly parted.'],
    ['Biting lip', 'She is biting her lower lip, heavy-lidded eyes locked on the camera.'],
    ['Moaning', 'Her mouth is open in a soft moan, eyes half-closed, head tilted back in pleasure.'],
    ['Flushed', 'Flushed cheeks, breathless parted lips, aroused heavy-lidded eyes.'],
    ['Innocent', 'Wide innocent doe eyes and softly parted lips, looking up at the camera.'],
    ['Tongue out', 'Her tongue is out, extended past her lower lip, eyes on the camera.'],
    ['Mouth open', 'Her mouth is open wide, jaw relaxed, looking straight at the camera.'],
  ] },
  { group: 'Skin', chips: [
    ['Oiled', 'Her skin is glistening with body oil, catching the light.'],
    ['Wet look', 'She is soaking wet, water running over her skin and hair.'],
    ['Sweaty glow', 'A light sheen of sweat across her skin, glowing under the light.'],
    ['Deeper tan', 'She has a deep sun-kissed tan.'],
  ] },
];

// The chips that REMOVE clothing. If one of these is in the instruction, the "keep her outfit"
// rule must stand down instead of fighting it.
// The Expression chips' expanded texts. A chip is an explicit choice and must WIN over the pose
// photo's own expression — otherwise clicking "Biting lip" and picking a tongue-out pose sends
// both, and the model averages two faces. Same wants*/suppress pattern as BODY_CHANGE_TEXTS.
const EXPRESSION_TEXTS = [
  'A sultry heavy-lidded seductive look straight down the lens, lips slightly parted.',
  'She is biting her lower lip, heavy-lidded eyes locked on the camera.',
  'Her mouth is open in a soft moan, eyes half-closed, head tilted back in pleasure.',
  'Flushed cheeks, breathless parted lips, aroused heavy-lidded eyes.',
  'Wide innocent doe eyes and softly parted lips, looking up at the camera.',
  'Her tongue is out, extended past her lower lip, eyes on the camera.',
  'Her mouth is open wide, jaw relaxed, looking straight at the camera.',
];

const BODY_CHANGE_TEXTS = [
  'She has a LARGE full bust with deep natural cleavage.',
  'She has a VERY LARGE heavy bust, noticeably fuller than in the photo, with deep cleavage.',
  // 'Bigger bust, clothed' was MISSING from this list, and its absence inverted the chip.
  // wantsBody stayed false, so buildPrompt took its no-body-change path and stated — twice, the
  // second time in the final, winning position — "her breasts are the size they are in image 1,
  // do NOT render a larger or smaller chest". The chip asked for a bigger bust and the prompt
  // answered "keep it exactly as it is", with the keep-it line read last. Worse, CLOTHED_FIGURE_LOCK
  // is gated on wantsBody too, so the ONE chip whose whole purpose is "bigger, but stay dressed"
  // was the one chip that never got the stay-dressed lock (owner, 2026-08-06).
  'She has a LARGE full bust that fills out the top she is already wearing',
  'She has a curvier hourglass figure — fuller bust and hips with a narrow waist.',
  'She has a slimmer, more slender figure.',
];

const UNDRESS_TEXTS = [
  'Remove her top and bra completely — she is topless, bare breasts fully exposed, no fabric above the waist.',
  'Remove every garment she is wearing — she is completely naked, no clothing anywhere on her body.',
];

/**
 * One source photo, with the ones you have used before kept underneath it.
 *
 * Image 1 sets identity AND the setting; image 2 is a close-up that pins the face. Both keep
 * their own history in IndexedDB, so a face you shot once is one click away forever instead of
 * being re-dropped every session. Anything in Eddy's Library can be pulled in too.
 */
/**
 * pickerDb / pickerLabel / pickerFolders — where the "Library" button looks.
 *
 * The two slots want DIFFERENT sources and always did: the Main photo is a BASE photo (Base
 * Library, filed per character) and the Face close-up is one of a character's own references
 * (Character tab, browsed per character). Pointing both at the general Eddy Library meant
 * scrolling hundreds of finished results to find either (owner, 2026-08-07). pickerFolders adds
 * the folder chips, which is what makes "pick HER face" a two-click job.
 */
function ImageSlot({ title, hint, value, onChange, dbName, libraryStore, pickerDb, pickerLabel, pickerFolders, pickerRole, pickerStrip, onPickFolder }) {
  const { notify } = useApp();
  const store = useMemo(() => createEddyCollection(dbName), [dbName]);
  // The collection the Library button browses. Falls back to the page's general library so a slot
  // with no pickerDb behaves exactly as before.
  const pickStore = useMemo(() => (pickerDb ? createEddyCollection(pickerDb) : libraryStore), [pickerDb, libraryStore]);
  const [pickFolders, setPickFolders] = useState([]);
  const [pickFolder, setPickFolder] = useState(null);
  const [saved, setSaved] = useState([]);          // [{ id, dataUrl }]
  const [over, setOver] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);

  /**
   * A row of one-click choices under the slot, for slots that opt in (pickerStrip).
   *
   * Removed from the Main photo on request — Base Library is browsed, not skimmed — but the FACE
   * slot wants it back: with pickerRole="base" it is exactly one photo per character, so the row
   * IS the character list and picking her is a single click instead of opening the picker
   * (owner, 2026-08-08).
   */
  const [pickRecent, setPickRecent] = useState([]);
  useEffect(() => {
    if (!pickerStrip || !pickerDb) { setPickRecent([]); return undefined; }
    let alive = true;
    (async () => {
      try {
        const all = await pickStore.listItems();
        const items = pickerRole ? oneRowPerFolder(all, pickerRole) : all;
        const rows = await Promise.all(
          [...items].sort((a2, b2) => (b2.createdAt || 0) - (a2.createdAt || 0)).slice(0, 12)
            .map(async (it) => ({ id: it.id, folderId: it.folderId || null, src: it.url || await pickStore.getImage(it.id) })),
        );
        if (alive) setPickRecent(rows.filter((r) => r.src));
      } catch { if (alive) setPickRecent([]); }
    })();
    return () => { alive = false; };
    // showLibrary is a dep so adding a character in the picker refreshes the row on close.
  }, [pickStore, pickerDb, pickerRole, pickerStrip, showLibrary]);

  const [library, setLibrary] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  // The gallery runs to thousands of images; mounting every <img> at once janks the open. Render a
  // page at a time — `loading="lazy"` alone does not stop thousands of DOM nodes being created.
  const [libraryShown, setLibraryShown] = useState(LIBRARY_PAGE);

  const refresh = useCallback(async () => {
    const items = await store.listItems();
    const rows = await Promise.all(items.map(async (it) => ({ id: it.id, dataUrl: it.url || await store.getImage(it.id) })));
    setSaved(rows.filter((r) => r.dataUrl));
  }, [store]);

  useEffect(() => { refresh(); }, [refresh]);

  // Remember every photo that gets used here, but never twice.
  const use = useCallback(async (dataUrl) => {
    if (!dataUrl) return;
    onChange(dataUrl);
    try {
      const items = await store.listItems();
      const existing = await Promise.all(items.map((it) => store.getImage(it.id)));
      if (existing.includes(dataUrl)) return;
      await store.addItems([{ dataUrl, name: dbName }]);
      await refresh();
    } catch (err) {
      // Failing to remember it must not stop you using it.
      notify(err.message || 'Could not save that to the strip', 'error');
    }
  }, [onChange, store, dbName, refresh, notify]);

  const take = (file) => {
    if (!file || !/^image\/(png|jpe?g|webp)$/i.test(file.type)) return;
    const r = new FileReader();
    r.onload = () => use(r.result);
    r.readAsDataURL(file);
  };

  /**
   * Opens the picker over the WHOLE gallery — every image in the app — not just the small
   * Eddy collection this slot used to list. That collection is a handful of items; the gallery is
   * thousands, and "pick a photo" should mean any of them.
   *
   * Newest first, videos dropped (this slot is a photo), and the Eddy collection is appended after
   * so nothing that used to be reachable here disappeared. If the gallery request fails the picker
   * still opens on the local collection rather than showing nothing.
   */
  /**
   * Download every saved photo in this slot.
   *
   * Sequential with a small gap: browsers silently drop rapid-fire programmatic downloads, and a
   * partial save that reports success is worse than a slow one. Goes through downloadBlob so these
   * get the same metadata strip + fresh capture time as any other download.
   */
  const saveAll = async () => {
    const slot = dbName.replace('eddy-slot-', '');
    let n = 0;
    for (const sv of saved) {
      const m = /^data:([^;]+);base64,(.+)$/.exec(sv.dataUrl || '');
      if (!m) continue;
      const bin = atob(m[2]);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
      const ext = (m[1].split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      n += 1;
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose, see above
      await downloadBlob(new Blob([buf], { type: m[1] }), `${slot}-${String(n).padStart(2, '0')}.${ext}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
    }
    notify(n ? `Saved ${n} ${slot} photo${n === 1 ? '' : 's'}` : 'Nothing to save', n ? 'success' : 'error');
  };

  const openLibrary = async () => {
    if (showLibrary) { setShowLibrary(false); return; }
    setShowLibrary(true);
    setLibraryLoading(true);
    setLibraryShown(LIBRARY_PAGE);   // every open starts at the first page, not where you left off
    const rows = [];
    // The server gallery is only worth mixing in for the GENERAL library. A slot pointed at Base
    // Library or Character wants that collection and nothing else — folding thousands of gallery
    // rows in would bury the handful you came for.
    if (!pickerDb) {
      try {
        const data = await libraryApi.list();
        for (const it of (data?.items || [])) {
          if (it.mediaType === 'image' && it.previewUrl) rows.push({ id: it.id, src: it.previewUrl });
        }
      } catch {
        // Gallery unreachable — fall through to the local collection below.
      }
    }
    try {
      if (pickerFolders) {
        try { setPickFolders(await pickStore.listFolders()); } catch { setPickFolders([]); }
      }
      const all = await pickStore.listItems();
      // Same narrowing as the strip, so opening the picker cannot show a different set to the row
      // that sits under the slot.
      const items = pickerRole ? oneRowPerFolder(all, pickerRole) : all;
      const local = await Promise.all(items.map(async (it) => ({
        id: `eddy:${it.id}`, folderId: it.folderId || null, src: it.url || await pickStore.getImage(it.id),
      })));
      rows.push(...local.filter((r) => r.src));
    } catch { /* local collection unreadable — the gallery rows above still stand */ }
    setLibrary(rows);
    setLibraryLoading(false);
  };

  // A Library entry is a URL to the server copy, so it has to be fetched before it can be sent.
  const pickFromLibrary = async (src, folderId = null) => {
    /**
     * Reports the folder the picture came from, not just the picture.
     *
     * In the Character collection a FOLDER IS A CHARACTER, so its name is the only thing that says
     * which character was chosen. Without this the Generate page had the face but no idea whose it
     * was, and every result filed under a generic "Eddy" folder -- the bug reported on 2026-08-09,
     * where the comment at the filing site claimed "results file under the character's name" while
     * the code beneath it did nothing of the sort.
     */
    const report = async () => {
      if (!onPickFolder) return;
      if (!folderId) { onPickFolder(''); return; }
      try {
        const fs = await pickStore.listFolders();
        onPickFolder(fs.find((f) => f.id === folderId)?.name || '');
      } catch { onPickFolder(''); }
    };
    try {
      if (src.startsWith('data:')) { await use(src); await report(); setShowLibrary(false); return; }
      const blob = await (await fetch(src, { credentials: 'include' })).blob();
      const reader = new FileReader();
      reader.onload = async () => { await use(reader.result); await report(); setShowLibrary(false); };
      reader.readAsDataURL(blob);
    } catch {
      notify('Could not load that image', 'error');
    }
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); take(e.dataTransfer?.files?.[0]); }}
      onPaste={(e) => {
        const f = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
        if (f) { e.preventDefault(); take(f); }
      }}
      tabIndex={0}
      className={cn('rounded-xl border p-2 transition outline-none',
        over ? 'border-rose-500 ring-2 ring-rose-500/40' : 'border-white/[0.07] focus:border-rose-500/60')}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-zinc-300">{title}</span>
        <span className="flex items-center gap-2">
          <button onClick={openLibrary} className="text-[0.6875rem] text-zinc-500 hover:text-white cursor-pointer">
            {showLibrary ? 'Close' : (pickerLabel || 'Library')}
          </button>
          {/* SAVE ALL — writes this slot's saved reference photos to disk.
              These live ONLY in IndexedDB: they are not in the gallery, not in uploads/, and the
              blob store keeps them in a wrapped form that cannot be read back out of the profile
              directory. So there was no way to hand a character's own reference set to anyone
              without re-uploading it by hand (owner, 2026-08-07 — wanted Grace's base and face
              refs in a folder for a partner). Files are named <slot>-01.jpg… so base and face stay
              apart once they are sitting in the same download folder. */}
          {saved.length > 0 && (
            <button onClick={saveAll} className="text-[0.6875rem] text-zinc-500 hover:text-white cursor-pointer"
              title={`Download all ${saved.length} saved photos in this slot`}>
              Save all {saved.length}
            </button>
          )}
          {value && (
            <button onClick={() => onChange('')} className="text-[0.6875rem] text-zinc-500 hover:text-red-400 cursor-pointer">Clear</button>
          )}
        </span>
      </div>

      {value ? (
        <img src={value} alt="" className="aspect-[3/4] w-full rounded-lg object-cover bg-zinc-950" />
      ) : (
        <div className="flex aspect-[3/4] flex-col items-center justify-center gap-3 rounded-lg bg-white/[0.02] px-3 text-center">
          {/* The collection comes FIRST on an empty slot: picking a saved base (or her face) is
              the normal way to fill this, and dropping a file is the exception. Before this the
              only affordance was a file input, so the Base Library you just generated into was
              invisible from the one place it is meant to be used (owner, 2026-08-07). */}
          {pickerDb && (
            <button type="button" onClick={openLibrary}
              className="rounded-lg border border-rose-500/60 bg-rose-500/10 px-4 py-2 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20 cursor-pointer">
              Select from {pickerLabel || 'Library'}
            </button>
          )}
          <label className="cursor-pointer">
            <span className="text-[0.6875rem] text-zinc-500 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-300">
              or drop, paste or click to upload
            </span>
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
              onChange={(e) => { take(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          <span className="text-[0.625rem] text-zinc-600">{hint}</span>
        </div>
      )}

      {/* The picker used to be a 56px-thumbnail grid crammed into this slot at 180px tall — far too
          small to actually recognise a photo in. It is now a full-screen gallery: big tiles, the
          whole viewport to scroll, so you can SEE what you are choosing.
          Portaled to <body> because this slot sits inside a glass card, and a `position:fixed`
          overlay inside one of those is trapped by its transform/filter context. */}
      {showLibrary && createPortal(
        <div
          className="fixed inset-0 z-[150] flex flex-col bg-black/85 backdrop-blur-sm"
          onClick={() => setShowLibrary(false)}
          role="dialog"
          aria-modal="true"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 px-6 py-4" onClick={(e) => e.stopPropagation()}>
            <div>
              <h3 className="text-lg font-bold text-white">Pick a photo — {title}</h3>
              <p className="text-xs text-zinc-400">
                {libraryLoading
                  ? 'Loading your gallery…'
                  : `${library.length} image${library.length === 1 ? '' : 's'} · showing ${Math.min(libraryShown, library.length)} · click one to use it`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowLibrary(false)}
              className="rounded-lg border border-zinc-600 bg-zinc-800 px-4 py-2 text-sm font-semibold text-zinc-100 transition hover:border-zinc-500 cursor-pointer"
            >
              Close
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6" onClick={(e) => e.stopPropagation()}>
            {libraryLoading ? (
              <p className="py-16 text-center text-sm text-zinc-500">Loading your gallery…</p>
            ) : !library.length ? (
              <p className="py-16 text-center text-sm text-zinc-500">No images found.</p>
            ) : (
              <>
                {/* FOLDER CHIPS — the character (or base-library) folders. This is what turns
                    "find her face close-up" into two clicks instead of scrolling a whole
                    collection. Only rendered for a slot that asked for them. */}
                {pickerFolders && pickFolders.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => setPickFolder(null)}
                      className={cn('rounded-full border px-3 py-1 text-xs font-semibold transition cursor-pointer',
                        pickFolder === null ? 'border-rose-500 bg-rose-500/15 text-rose-300'
                                            : 'border-white/[0.07] bg-white/[0.02] text-zinc-400 hover:border-zinc-600')}>
                      All
                    </button>
                    {pickFolders.map((f) => (
                      <button key={f.id} type="button" onClick={() => setPickFolder(f.id)}
                        className={cn('rounded-full border px-3 py-1 text-xs font-semibold transition cursor-pointer',
                          pickFolder === f.id ? 'border-rose-500 bg-rose-500/15 text-rose-300'
                                              : 'border-white/[0.07] bg-white/[0.02] text-zinc-400 hover:border-zinc-600')}>
                        {f.name}
                      </button>
                    ))}
                  </div>
                )}
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
                  {library.filter((l) => !pickFolder || l.folderId === pickFolder).slice(0, libraryShown).map((l) => (
                    <button
                      key={l.id}
                      onClick={() => pickFromLibrary(l.src, l.folderId)}
                      className="group aspect-[3/4] overflow-hidden rounded-xl border-2 border-zinc-700 bg-zinc-950 transition hover:border-rose-500 cursor-pointer"
                    >
                      <img src={l.src} alt="" className="h-full w-full object-cover transition group-hover:scale-[1.03]" loading="lazy" />
                    </button>
                  ))}
                </div>
                {libraryShown < library.filter((l) => !pickFolder || l.folderId === pickFolder).length && (
                  <button
                    type="button"
                    onClick={() => setLibraryShown((n) => n + LIBRARY_PAGE)}
                    className="mx-auto mt-5 block rounded-lg border border-zinc-600 bg-zinc-800 px-6 py-2.5 text-sm font-semibold text-zinc-100 transition hover:border-zinc-500 cursor-pointer"
                  >
                    Load {Math.min(LIBRARY_PAGE, library.length - libraryShown)} more ({library.length - libraryShown} left)
                  </button>
                )}
              </>
            )}
          </div>
        </div>,
        document.body,
      )}

      {pickRecent.length > 0 && (
        <>
          <p className="mt-2 text-[0.625rem] uppercase tracking-wider text-zinc-600">
            {pickerLabel || 'Library'} — click to use
          </p>
          <div className="mt-1 flex gap-1.5 overflow-x-auto pb-1">
            {pickRecent.map((r) => (
              <button key={r.id} type="button" onClick={() => pickFromLibrary(r.src, r.folderId)}
                title={`Use this ${(pickerLabel || 'library').toLowerCase()} image`}
                className={cn('h-14 w-14 shrink-0 overflow-hidden rounded-md border-2 bg-zinc-950 cursor-pointer',
                  value === r.src ? 'border-rose-500' : 'border-transparent hover:border-rose-500')}>
                <img src={r.src} alt="" loading="lazy" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        </>
      )}

      {/* Always offered once the slot is FILLED too, not just when empty. Swapping the base photo
          is the common action on this page, and with Base Library empty the row below the picture
          was simply dead space (owner, 2026-08-07). Full width so it reads as part of the slot
          rather than a stray control. */}
      {pickerDb && value && (
        <button type="button" onClick={openLibrary}
          className="mt-2 w-full rounded-lg border border-rose-500/40 bg-rose-500/[0.07] px-3 py-2 text-xs font-semibold text-rose-300 transition hover:border-rose-500 hover:bg-rose-500/15 cursor-pointer">
          Select from {pickerLabel || 'Library'}
        </button>
      )}
    </div>
  );
}

/**
 * A tile you click to pick things out of one of Eddy's collections.
 *
 * onToggleFavorite is OPTIONAL — passed only for collections that carry favorites (the pose and
 * outfit pickers), together with `favIds` (a Set of favorited item ids read from the store's small
 * favorites key). The star's fill is derived from `favIds.has(it.id)`, NOT from item.favorite, so it
 * matches the same source the count and filter read. The star is a SEPARATE button rendered as a
 * sibling of the tile button inside a relative wrapper, never nested inside it: a <button> inside a
 * <button> is invalid HTML and the inner click would not fire reliably. stopPropagation keeps a star
 * click from also toggling the pick.
 */
function PickerGrid({ items, thumbs, selected, favIds, onToggle, onToggleFavorite, empty }) {
  if (!items.length) return <p className="py-6 text-center text-xs text-zinc-600">{empty}</p>;
  return (
    // data-picker-grid: the hook a workspace CSS file uses to set its own columns / height.
    <div data-picker-grid className="grid grid-cols-3 gap-2 max-h-[860px] overflow-y-auto pr-1">
      {items.map((it) => {
        const on = selected.includes(it.id);
        return (
          <div key={it.id} className="relative">
            <button onClick={() => onToggle(it.id)}
              className={cn('relative block aspect-square w-full overflow-hidden rounded-lg border transition cursor-pointer',
                on ? 'border-rose-500 ring-2 ring-rose-500/40' : 'border-zinc-800/60 hover:border-zinc-600')}>
              {thumbs[it.id] ? (
                <img src={thumbs[it.id]} alt="" className="h-full w-full object-cover bg-zinc-950" loading="lazy" />
              ) : (
                // Prompt-only entry: show the words, since there is no picture to show.
                <span className="flex h-full w-full items-center bg-white/[0.03] p-1.5 text-left text-[0.5625rem] leading-tight text-zinc-400 line-clamp-5">
                  {it.prompt || 'Empty prompt'}
                </span>
              )}
              {on && <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[0.625rem] font-bold text-white">✓</span>}
              {/* Hover reveals the card's prompt. KEPT deliberately: several poses look nearly
                  identical as thumbnails (the Riding set, the Feet set) and the prompt text is the
                  only thing that tells them apart from the picker — more so now that every pose
                  carries readable text instead of an unparseable JSON blob. Text is larger than the
                  original 9px since the tiles are wider in the 3-column layout. */}
              {thumbs[it.id] && it.prompt && (
                <span className="absolute inset-0 flex items-center bg-black/85 p-2 text-left text-[0.625rem] leading-snug text-zinc-100 opacity-0 transition-opacity hover:opacity-100 line-clamp-6">
                  {it.prompt}
                </span>
              )}
            </button>
            {onToggleFavorite && (
              <button type="button"
                // Pure favorite toggle: stopPropagation + preventDefault so the click never also
                // toggles the pick (the sibling tile button) or triggers any default — the user saw
                // "nothing happen" and this keeps it a clean, single-purpose action.
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggleFavorite(it.id); }}
                aria-pressed={favIds.has(it.id)}
                title={favIds.has(it.id) ? 'Remove from favorites' : 'Mark as favorite'}
                className={cn('absolute bottom-1 right-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 transition cursor-pointer',
                  favIds.has(it.id) ? 'text-rose-400' : 'text-zinc-300 hover:text-rose-300')}>
                <StarIcon filled={favIds.has(it.id)} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Shared visual language for the money surfaces: the two confirmation gates
 * (PreRunConfirmGate + VideoConfirmGate) and the inline results action bar.
 *
 * WHY these live as constants rather than inline strings: every surface that quotes a price must
 * read as one system, and the amber rule below only works if it is enforced in exactly one place.
 *
 * THE AMBER RULE: `GATE_MONEY`'s amber (#f0b429) is reserved for dollar figures and nothing else.
 * No border, no icon, no warning, no focus ring may use it. That exclusivity is the entire
 * mechanism — in a grid of twenty cards the eye finds the bill by hue alone, without reading.
 * (The clamped-duration notice is deliberately neutral, because it is a note about length, not a
 * price.)
 *
 * Quietness of a money figure is expressed by SIZE, never by hue — a small amber figure is a
 * small amount, not a different kind of thing.
 * --------------------------------------------------------------------------------------------- */
const GATE_SCRIM = 'bg-[#08080c]/90';
const GATE_PANEL = 'bg-[#101017]';
const GATE_HAIRLINE = 'border-white/[0.07]';
const GATE_TEXT = 'text-[#e8e8f0]';
const GATE_MUTED = 'text-[#7d7d8c]';
// tabular-nums is functional, not decorative: the action bar's totals recount on every selection
// change, and proportional digits make them jitter horizontally as they change width.
const GATE_MONEY = 'tabular-nums font-semibold tracking-tight text-[#f0b429]';
const GATE_EYEBROW = 'text-[10px] font-semibold uppercase tracking-[0.12em] text-[#7d7d8c]';
// Neutral (never amber — see the amber rule) and always visible, so every control in these gates
// is reachable and locatable by keyboard alone.
const GATE_FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[#101017]';

// Which INSTRUCTION_PRESETS groups the inline action bar offers as one-tap fills. Body and
// Expression are the obvious fix-ups; Skin (oiled / wet / sweaty glow) is here too because the
// user regenerates for exactly that look and expected the chips in the results bar, not only in
// the up-front instruction. The Sexual group is filtered by the page's own `nsfw` toggle at the
// call site, so undress chips never appear inside a clothed run.
const BAR_PRESET_GROUPS = ['Body', 'Expression', 'Skin'];

/**
 * Tweens a number toward its new value over ~220ms.
 *
 * This is the ONLY motion on the money surfaces beyond a panel's fade-in: the action bar's totals
 * recounting as images are selected and deselected is the one change worth pointing at, and it is
 * invisible if it snaps. Values that never change (a confirmation gate's total) never animate,
 * because the first render seeds the shown value and the effect no-ops when from === value — so
 * the hook can be used unconditionally without a gate counting up from zero on open.
 *
 * `shownRef` tracks what is actually on screen (not the last target) so an interrupted tween
 * resumes from where it visually is rather than snapping back to the previous target.
 */
function useCountUp(value) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const from = shownRef.current;
    if (reduced || from === value) {
      shownRef.current = value;
      setShown(value);
      return undefined;
    }
    let raf = 0;
    const start = performance.now();
    const DURATION = 220;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / DURATION);
      const eased = 1 - (1 - t) * (1 - t); // ease-out: fast commit, soft landing
      const next = from + (value - from) * eased;
      shownRef.current = next;
      setShown(next);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return shown;
}

/**
 * Every dollar figure on this page renders through here, which is what makes the amber rule
 * mechanically true rather than a convention someone has to remember.
 *
 * `strike` dims and strikes a figure while keeping it amber and legible — it is still a price,
 * just one that no longer applies.
 */
function Money({ amount, decimals = 2, className = '', strike = false }) {
  const shown = useCountUp(amount);
  return (
    <span className={cn(GATE_MONEY, strike && 'line-through opacity-45', className)}>
      ${shown.toFixed(decimals)}
    </span>
  );
}

/**
 * Fades a gate panel in over ~120ms. Returns the class pair to spread onto the panel.
 * `motion-reduce:transition-none` honours prefers-reduced-motion without a media query in JS.
 */
function useFadeIn() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return cn('transition-opacity duration-[120ms] motion-reduce:transition-none', visible ? 'opacity-100' : 'opacity-0');
}

/**
 * Freezes the page behind a gate while it is open.
 *
 * WHY: these gates are portaled to document.body and sit over a results grid that can be many
 * screens tall. Without this the wheel falls through to the document once the pointer is over the
 * backdrop, and dismissing the gate drops you somewhere else entirely in a long batch. Restores
 * whatever `overflow` was there rather than assuming '' — another overlay may have set it.
 */
function useScrollLock() {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
}

/**
 * The confirmation gate BEFORE anything is generated — fires the instant Generate is clicked,
 * ahead of every image request. It is the "see the full bill first" gate the user asked for after
 * a batch fired before they could stop it.
 *
 * Quotes the bill for the run about to start. A generate run produces images and nothing else, so
 * this quotes images and nothing else — there is no video line, because no video request can be
 * issued as a consequence of pressing Start. Animating is a separate, deliberate action taken on a
 * finished result, and it is quoted by VideoConfirmGate at the moment it is asked for.
 *
 * Portaled to document.body because this page's cards use
 * backdrop-filter, which traps a plain `position: fixed` overlay inside whichever card it
 * happens to render in instead of covering the screen. Same z-[150] so it matches the gate it
 * sits in front of.
 */
function PreRunConfirmGate({ imageCount, imageCost, onConfirm, onCancel }) {
  const fade = useFadeIn();
  useScrollLock();

  return createPortal(
    // The backdrop DOES cancel here, and deliberately so. Nothing has been generated, billed or
    // saved at this point, so a click outside costs the user nothing and dismissing is the safe
    // default — cancelling can only ever prevent a spend, never discard work already paid for.
    <div className={cn('fixed inset-0 z-[150] flex items-center justify-center p-6', GATE_SCRIM)} onClick={onCancel}>
      {/* A receipt: narrow, line items quiet, one number that matters. */}
      <div
        className={cn('w-full max-w-sm rounded-2xl border p-5', GATE_HAIRLINE, GATE_PANEL, fade)}
        onClick={(e) => e.stopPropagation()}
      >
        <p className={GATE_EYEBROW}>Confirm</p>
        <h3 className={cn('mt-1 text-sm font-semibold', GATE_TEXT)}>Before generating</h3>
        <p className={cn('mt-1 text-xs', GATE_MUTED)}>Nothing is sent until you press Start.</p>

        <div className={cn('mt-4 border-t pt-3', GATE_HAIRLINE)}>
          <div className="flex items-baseline justify-between gap-3">
            <span className={cn('text-xs', GATE_MUTED)}>{imageCount} image{imageCount === 1 ? '' : 's'}</span>
            <Money amount={imageCost} decimals={3} className="text-xs" />
          </div>
        </div>

        {/* The hero. ~2.5x the line-item size: the decision here is a budget decision, and this
            is the number that decision is made against. Everything above it is supporting detail. */}
        <div className={cn('mt-3 flex items-baseline justify-between gap-3 border-t pt-3', GATE_HAIRLINE)}>
          <span className={GATE_EYEBROW}>Total</span>
          <Money amount={imageCost} decimals={3} className="text-[1.875rem] leading-none" />
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Btn variant="ghost" className="!rounded-lg !py-2 !px-3 !text-sm" onClick={onCancel}>Cancel</Btn>
          <Btn className="!rounded-lg !py-2 !px-4 !text-sm" onClick={onConfirm}>Start</Btn>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The confirmation between clicking Generate video on a selection and actually dispatching it.
 *
 * WHY this exists at all when Regenerate has no confirmation: video is the expensive step by an
 * order of magnitude — a single 10s clip at $0.15/s costs more than thirty regenerated images —
 * and removing the old modal review gate removed the one thing that used to stand between a click
 * and that spend. Regeneration deliberately keeps NO confirmation: it bills the same per-image
 * price the page has always charged without asking, and adding a dialog to the fix-it-again loop
 * would put a click in front of exactly the action this whole flow exists to make cheap.
 *
 * Deliberately built from the same GATE_* constants, the same Money component and the same receipt
 * shape as PreRunConfirmGate rather than a second style — a user should not have to learn two
 * different-looking ways to be told what something costs.
 */
function VideoConfirmGate({ clipCount, cost, clips = [], clampedClips = [], skipped = 0, alreadyAnimated = 0, onConfirm, onCancel }) {
  // How the per-clip seconds read out: all-same shows "6s each", a mix shows "6s, 10s" so the
  // user can see the price is per-second (a 6s clip is $0.90, a 10s clip $1.50) rather than a
  // flat fee. Total seconds too, since that is what the bill is.
  const uniqueSecs = [...new Set(clips)];
  const totalSecs = clips.reduce((a, b) => a + b, 0);
  const secondsLabel = clips.length === 0 ? ''
    : uniqueSecs.length === 1 ? `${uniqueSecs[0]}s each`
    : `${clips.join('s, ')}s`;
  const fade = useFadeIn();
  useScrollLock();

  return createPortal(
    // Backdrop cancels, same as PreRunConfirmGate and for the same reason: nothing has been
    // dispatched yet, so dismissing costs nothing and is the safe default.
    <div className={cn('fixed inset-0 z-[150] flex items-center justify-center p-6', GATE_SCRIM)} onClick={onCancel}>
      <div
        className={cn('w-full max-w-sm rounded-2xl border p-5', GATE_HAIRLINE, GATE_PANEL, fade)}
        onClick={(e) => e.stopPropagation()}
      >
        <p className={GATE_EYEBROW}>Confirm</p>
        <h3 className={cn('mt-1 text-sm font-semibold', GATE_TEXT)}>Before animating</h3>
        <p className={cn('mt-1 text-xs', GATE_MUTED)}>Nothing is sent until you press Animate.</p>

        <div className={cn('mt-4 border-t pt-3', GATE_HAIRLINE)}>
          <div className="flex items-baseline justify-between gap-3">
            <span className={cn('text-xs', GATE_MUTED)}>
              {clipCount} clip{clipCount === 1 ? '' : 's'}
              {secondsLabel && <span className={GATE_MUTED}> · {secondsLabel}</span>}
            </span>
            <Money amount={cost} decimals={3} className="text-xs" />
          </div>
          {clips.length > 1 && (
            <p className={cn('mt-1 text-[0.6875rem]', GATE_MUTED)}>{totalSecs}s total × ${VIDEO_PRICE_PER_SECOND.toFixed(2)}/s</p>
          )}
        </div>

        <div className={cn('mt-3 flex items-baseline justify-between gap-3 border-t pt-3', GATE_HAIRLINE)}>
          <span className={GATE_EYEBROW}>Total</span>
          <Money amount={cost} decimals={3} className="text-[1.875rem] leading-none" />
        </div>

        {/* THE DOUBLE-SPEND GUARD. Every clip is now dispatched from this gate, so the way a result
            comes to already carry one is that it was animated here before — easy to lose track of
            across a big selection, which makes "Generate video" the one action that can quietly bill
            twice for the same picture. Re-animating is NOT blocked (a clip that came out wrong is a legitimate re-roll, and the
            price is quoted above either way); it is stated, in the confirmation, in the exact count
            the user is about to pay for a second time. Emphasis is carried by WEIGHT, not by hue —
            amber belongs to the dollar figures alone. */}
        {alreadyAnimated > 0 && (
          <p className={cn('mt-3 border-t pt-3 text-[0.6875rem] font-medium leading-relaxed', GATE_HAIRLINE, GATE_TEXT)}>
            {alreadyAnimated} of these {alreadyAnimated === 1 ? 'already has a video' : 'already have videos'}.
            Animating {alreadyAnimated === 1 ? 'it' : 'them'} again renders a new clip and is billed
            again — the total above includes {alreadyAnimated === 1 ? 'it' : 'them'}.
          </p>
        )}

        {/* Selected images whose pose carries no video prompt. Stated here rather than quietly
            dropped from the count: the user selected them expecting them to animate, and a total
            that silently covers fewer images than were picked is the surprise this line removes.
            No figure is shown for them because none will ever be billed. */}
        {skipped > 0 && (
          <p className={cn('mt-3 border-t pt-3 text-[0.6875rem] leading-relaxed', GATE_HAIRLINE, GATE_MUTED)}>
            {skipped} selected image{skipped === 1 ? ' has' : 's have'} no video prompt on their pose
            and cannot be animated — {skipped === 1 ? 'it is' : 'they are'} not included above and
            will not be charged. Add a video prompt on the Pose card to animate {skipped === 1 ? 'it' : 'them'}.
          </p>
        )}

        {/* Same calm note, same wording rule as the pre-run gate: the price above is already the
            clamped price, so this is information, not a warning. Never amber. */}
        {clampedClips.length > 0 && (
          <p className={cn('mt-3 border-t pt-3 text-[0.6875rem] leading-relaxed', GATE_HAIRLINE, GATE_MUTED)}>
            {clampedClips.length} clip{clampedClips.length === 1 ? '' : 's'} ask
            {clampedClips.length === 1 ? 's' : ''} for a length outside the{' '}
            {SEEDANCE_DURATION_MIN}–{SEEDANCE_DURATION_MAX}s limit and will render clamped:{' '}
            {[...new Set(clampedClips.map((c) => `${c.requested}s → ${c.seconds}s`))].join(', ')}.
            The price above is for the clamped length.
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Btn variant="ghost" className="!rounded-lg !py-2 !px-3 !text-sm" onClick={onCancel}>Cancel</Btn>
          <Btn className="!rounded-lg !py-2 !px-4 !text-sm" disabled={!clipCount} onClick={onConfirm}>Animate</Btn>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Has this result already had a clip rendered (or paid for and still rendering)?
 *
 * Derived from videoStatus rather than kept as a second boolean, so there is exactly one source of
 * truth about a result's clip and no way for the badge and the confirmation's count to disagree.
 * 'error' is deliberately NOT counted: a clip that never started was never billed, so animating it
 * again is a first attempt, not a second charge. A regenerate clears videoStatus (the new picture's
 * clip does not exist yet), which is correct — that IS a fresh image needing a fresh clip.
 */
const hasClip = (r) => r.videoStatus === 'pending' || r.videoStatus === 'done';

/**
 * The server-side filename behind a finished clip's URL, or '' when the clip is provider-hosted.
 *
 * WHY it is parsed back out of the URL instead of being plumbed through: the shared generation feed
 * resolves a video job to a videoUrl ONLY (it never carries localFilename onto the feed item), and
 * this page mirrors that field. The clean route is addressed by filename, so the filename has to
 * come from somewhere — and the URL the feed built is `videoApi.fileUrl(localFilename)`, which
 * still contains it.
 */
function localClipFilename(url) {
  const m = String(url || '').match(/\/video\/file\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

// Shared look for the always-visible per-tile actions. A tile is ~160px wide, so these are the
// smallest control that still reads as a button. Neutral until hover/focus — a results grid of
// twenty permanently-outlined buttons reads as chrome, not as pictures.
const TILE_ACTION = 'rounded-lg border px-2 py-1 text-[0.625rem] font-medium transition';
// The tile buttons used to be bare bordered text on a dark tile — nearly invisible. These give a
// real fill so the button shape reads: a solid secondary for Regenerate/Download, a rose PRIMARY
// for the main action (Generate video) so it stands out, and a red-tinted destructive for Remove.
// Rose (the app's brand accent, used on the main Generate button) is fine here — amber stays
// reserved for the dollar figures alone.
// OPAQUE fills — a semi-transparent white sat on the page's pink gradient and stayed muddy. Solid
// slate reads as a real button on any background; rose (opaque) is the unmistakable primary;
// danger is slate that turns solid red on hover.
const TILE_BTN = 'cursor-pointer bg-zinc-800 border-zinc-600 text-zinc-100 hover:bg-zinc-700 hover:border-zinc-500';
// The results-header controls (Select all / Unselect / Clear all / Download all). Real buttons at a
// readable size, NOT the 10px muted underlined links they used to be — those were reported as
// unreadable ("I CANT SEE THE UNSELECT"). Opaque fill for the same reason every tile button is
// opaque: a translucent chip over the pink page washes out to nothing.
const HDR_BTN = 'rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-sm font-semibold text-zinc-100 transition';

const TILE_BTN_PRIMARY = 'cursor-pointer bg-rose-500 border-rose-400 text-white hover:bg-rose-400';
const TILE_BTN_DANGER = 'cursor-pointer bg-zinc-800 border-zinc-600 text-zinc-200 hover:bg-[#5a2323] hover:border-red-500/70 hover:text-red-200';

/**
 * A five-point star, FILLED when favorited and OUTLINE otherwise — the whole visual language of the
 * favorite toggle. `fill`/`stroke` are both `currentColor` so the button around it decides the hue
 * (rose when on, muted white when off); this stays a pure glyph. Shared by the tile and the lightbox
 * so the two favorite controls can never drift into looking like different actions.
 *
 * WHY rose and never amber: amber is reserved on this page for dollar figures alone (see the amber
 * rule by GATE_MONEY). Favoriting spends nothing, so it must carry the brand ROSE accent, never the
 * money hue — an amber star would read as a price.
 */
function StarIcon({ filled }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path d="M12 3.5l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 16.77l-5.2 2.73.99-5.79-4.21-4.1 5.82-.85z" />
    </svg>
  );
}

/**
 * The click-to-open large view for one result — an ADDITIONAL way into the exact same controls the
 * tile already carries, not a second money path.
 *
 * WHY it exists: a results tile is ~160px wide, and deciding "what to change on this one" against a
 * thumbnail that small is guesswork — a broken hand or soft light is invisible until the picture is
 * big. So a click on the IMAGE opens it full-size, and the per-image decision (the correction note,
 * Regenerate, Generate video, Remove, Download) is reachable RIGHT THERE, against the large view.
 *
 * WHY IT FORKS NOTHING: `note`/`setNote`, `onRegenerate`, `onAnimate`, `onRemove` and `onDownload`
 * are all PASSED DOWN FROM ResultTile — they are the tile's own state and the tile's own handlers,
 * which are themselves the page's single `regenerateUids`/`openVideoConfirmFor`/`removeUids` paths.
 * So Regenerate here bills exactly what the tile bills, and Generate video here opens the SAME
 * VideoConfirmGate (the cost gate) the tile and the bulk bar open — Cancel there still spends
 * nothing, character-refs-first ordering and kept-only dispatch are untouched, because this reaches
 * none of that logic directly; it only calls the same two functions.
 *
 * Portaled to document.body at z-[150] — the same escape hatch and the same stacking level as the
 * two confirmation gates, because this page's cards use backdrop-filter, which traps a plain
 * position:fixed overlay inside whichever glass card it renders in. useScrollLock freezes the body
 * behind it and restores the previous overflow on close (it mounts only while open, so the hook's
 * unmount cleanup IS the close path). When Generate video is pressed the gate portals ON TOP of
 * this (appended to body later, equal z-index) and its own scroll-lock nests cleanly over this one.
 */
function ResultLightbox({ src, item, busy, favorited, onToggleFavorite, note, setNote, canRegenerate, canAnimate, canClearVideoPrompt, noVideo, vpOpen, setVpOpen, vpText, setVpText, onRegenerate, onAnimate, onClearVideoPrompt, onDuplicateWithPrompt, onRemove, onDownload, onClose, onStep, pos }) {
  const fade = useFadeIn();
  useScrollLock();
  const inputRef = useRef(null);

  // Escape closes, matching every other overlay and gate in this app. Focus the note on open so the
  // large view is immediately a "type the correction" surface, the same intent as the tile's note.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (!onStep) return;
      /**
       * Arrows step between results — unless you are actually editing text.
       *
       * "Focused" is not the test. This lightbox focuses the correction box the moment it opens,
       * so a blanket typing-check meant the arrows NEVER worked: focus was always in an input
       * (owner, 2026-08-08). The honest question is whether the caret has anything to move over.
       * An EMPTY box has nothing to navigate, so the arrow belongs to the gallery; once there is
       * text in it the arrow belongs to the caret, and a correction containing "left" is safe.
       */
      const t = e.target;
      const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (editable && String(t.value ?? t.textContent ?? '').length > 0) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); onStep(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); onStep(-1); }
    };
    window.addEventListener('keydown', onKey);
    inputRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onStep]);

  /**
   * Swipe, for the trackpad/touch half of "slide to the other one".
   *
   * Threshold on X and a cap on Y so a vertical scroll through a long correction box is never
   * read as a swipe. Pointer events rather than touch events so a trackpad drag works too.
   */
  const swipe = useRef(null);
  const onPointerDown = (e) => { swipe.current = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = (e) => {
    const st = swipe.current;
    swipe.current = null;
    if (!st || !onStep) return;
    const dx = e.clientX - st.x;
    const dy = e.clientY - st.y;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
    onStep(dx < 0 ? 1 : -1);        // drag left = go forward, as every gallery behaves
  };

  return createPortal(
    // Backdrop closes — nothing here spends money, so dismissing is the safe default (same rule as
    // the gates). Column layout: the image takes the room, the controls sit under it.
    <div className={cn('fixed inset-0 z-[150] flex flex-col items-center justify-center gap-4 p-4 sm:p-6', GATE_SCRIM)} onClick={onClose}>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className={cn('absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border text-lg', GATE_FOCUS, GATE_HAIRLINE, GATE_PANEL, GATE_MUTED, 'cursor-pointer hover:text-[#e8e8f0]')}
      >
        ×
      </button>

      {/* FAVORITE STAR — the SAME control as the tile's, sharing the tile's `favorited` state and
          onToggleFavorite handler, so starring here moves this result's SOURCE pose into the same Pose
          "★ Favorite". Top-LEFT, clear of the close button (top-right). Rose when on, muted outline off —
          never amber (amber is dollar figures only). stopPropagation + preventDefault so a click never
          reaches the backdrop's onClose. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggleFavorite(); }}
        aria-pressed={favorited}
        aria-label={favorited ? 'Remove source pose from Favorites' : 'Add source pose to Favorites'}
        title={favorited ? 'Favorited — click to remove this result’s pose from your Pose favorites' : 'Favorite this result’s pose — sends the pose it was made from to ★ Favorite in your Pose tab'}
        className={cn(
          'absolute left-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border', GATE_FOCUS, GATE_HAIRLINE, GATE_PANEL,
          'cursor-pointer transition-colors', favorited ? 'text-rose-400' : cn(GATE_MUTED, 'hover:text-rose-300'),
        )}
      >
        <StarIcon filled={favorited} />
      </button>

      {/* PREV / NEXT. Rendered only when the parent supplied a stepper, so nothing changes for a
          single-result view. Positioned over the image area rather than the controls, and they
          stopPropagation like every other control here so a click never reaches the backdrop. */}
      {onStep && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onStep(-1); }}
            aria-label="Previous image"
            title="Previous (←)"
            className={cn('absolute left-2 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border text-2xl sm:left-4', GATE_FOCUS, GATE_HAIRLINE, GATE_PANEL, GATE_MUTED, 'cursor-pointer hover:text-[#e8e8f0]')}
          >
            ‹
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onStep(1); }}
            aria-label="Next image"
            title="Next (→)"
            className={cn('absolute right-2 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border text-2xl sm:right-4', GATE_FOCUS, GATE_HAIRLINE, GATE_PANEL, GATE_MUTED, 'cursor-pointer hover:text-[#e8e8f0]')}
          >
            ›
          </button>
        </>
      )}

      {/* The large image. stopPropagation so a click ON the picture does not close the view.
          Pointer handlers here (not on the backdrop) so a swipe starts on the picture itself. */}
      <div
        className="flex min-h-0 w-full flex-1 items-center justify-center"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        {src
          ? <img src={src} alt="" draggable={false}
              className={cn('max-h-full max-w-full select-none rounded-xl object-contain', fade)} />
          : <span className={GATE_MUTED}>No preview</span>}
      </div>

      {/* Where you are in the batch — without it, stepping through 60 results gives no sense of
          progress or of having reached the end. */}
      {pos && (
        <span className={cn('shrink-0 rounded-full px-3 py-1 text-xs', GATE_PANEL, GATE_MUTED)}>
          {pos} — ← → or swipe
        </span>
      )}

      {/* The per-image controls — the SAME note state and the SAME handlers the tile uses. */}
      <div
        className={cn('w-full max-w-xl shrink-0 space-y-2 rounded-2xl border p-3', GATE_HAIRLINE, GATE_PANEL, fade)}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          // Enter regenerates THIS image, exactly like the tile's note. It deliberately never routes
          // to video — as everywhere on this page, the expensive action is not reachable by a keystroke.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canRegenerate && !busy) { e.preventDefault(); onRegenerate(note); }
          }}
          placeholder="What to change on this one? (optional)"
          title="Left empty, Regenerate re-rolls this image's prompt exactly as before."
          className={cn(
            'w-full rounded-lg border bg-black/30 px-2.5 py-2 text-sm outline-none transition placeholder:text-[#5a5a67]',
            GATE_FOCUS, GATE_HAIRLINE, GATE_TEXT, 'focus:border-white/25',
          )}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onRegenerate(note)}
            disabled={Boolean(busy) || !canRegenerate}
            title={canRegenerate
              ? 'Make this one again — optionally saying what to change.'
              : 'Regenerate needs a fresh generation — reload cleared its settings.'}
            className={cn(
              'rounded-lg border px-3 py-2 text-xs font-medium transition', GATE_FOCUS,
              busy || !canRegenerate
                ? cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED)
                : TILE_BTN,
            )}
          >
            {/* Same Money component as every figure on this page — keeps the amber rule mechanical. */}
            Regenerate <Money amount={item.regenCost || 0} decimals={3} className="text-xs" />
          </button>
          <button
            type="button"
            onClick={onAnimate}
            disabled={Boolean(busy) || !canAnimate}
            title={canAnimate ? 'Render a video from this image — you will be shown the price first.' : 'This pose has no video prompt, so it cannot be animated.'}
            className={cn(
              'rounded-lg border px-3 py-2 text-xs font-medium transition', GATE_FOCUS,
              busy || !canAnimate
                ? cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED)
                : TILE_BTN_PRIMARY,
            )}
          >
            Generate video
          </button>
          {/* FEATURE 2 — same "Clear video prompt" action as the tile, sharing the exact handler, so
              the large view can reject a bad animation idea too. Only shown when there IS a prompt to
              clear. No money moves, so no amber. Stays open afterward: the image is untouched and the
              user may still want to Regenerate/Download it. */}
          {canClearVideoPrompt && (
            <button
              type="button"
              onClick={onClearVideoPrompt}
              disabled={Boolean(busy)}
              title="Deletes the video prompt for this pose so it won't animate (image is kept). Also clears it on the source pose."
              className={cn(
                'rounded-lg border px-3 py-2 text-xs font-medium transition', GATE_FOCUS,
                busy
                  ? cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED)
                  : TILE_BTN_DANGER,
              )}
            >
              Clear video prompt
            </button>
          )}
          {/* Same paste-a-different-video-prompt control as the tile, sharing its vpOpen/vpText state
              so opening it from the tile or from here shows the same in-progress text. */}
          <button
            type="button"
            onClick={() => { setVpText(''); setVpOpen((v) => !v); }}
            disabled={Boolean(busy)}
            title="Makes a new copy of this image with your pasted video prompt — the original and its own video prompt are left untouched."
            className={cn('rounded-lg border px-3 py-2 text-xs font-medium transition', GATE_FOCUS, TILE_BTN)}
          >
            {noVideo ? 'Duplicate with a video prompt' : 'Duplicate with a different video prompt'}
          </button>
          <button
            type="button"
            onClick={onDownload}
            className={cn('rounded-lg border px-3 py-2 text-xs font-medium transition', GATE_FOCUS, TILE_BTN)}
          >
            Download
          </button>
          {/* Removes from the results list only (image stays in the Library) — then closes, since the
              tile it belonged to is gone. Carries no dollar figure, so per the amber rule, no amber. */}
          <button
            type="button"
            onClick={() => { onRemove(); onClose(); }}
            disabled={Boolean(busy)}
            title="Clears this from the results list. The image stays in your Library."
            className={cn(
              'ml-auto rounded-lg border px-3 py-2 text-xs font-medium transition', GATE_FOCUS,
              busy
                ? cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED)
                : TILE_BTN_DANGER,
            )}
          >
            Remove
          </button>
        </div>
        {vpOpen && !busy && (
          <div className="space-y-1.5 rounded-lg border border-white/[0.07] bg-black/25 p-2">
            {/* The prompt it HAS today, for reference only — the box below is not seeded from it. */}
            {item.videoPrompt && (
              <p className={cn('text-xs leading-snug line-clamp-2', GATE_MUTED)}>This image currently has: {item.videoPrompt}</p>
            )}
            <textarea
              autoFocus
              value={vpText}
              onChange={(e) => setVpText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setVpOpen(false); } }}
              rows={5}
              placeholder="Paste your video prompt here..."
              className={cn(
                'w-full resize-y rounded-lg border bg-black/30 px-2.5 py-2 text-sm outline-none transition placeholder:text-[#5a5a67]',
                GATE_FOCUS, GATE_HAIRLINE, GATE_TEXT, 'focus:border-white/25',
              )}
            />
            <div className="flex gap-2">
              {/* Disabled on empty so an accidental click can't silently wipe an existing prompt —
                  clearing on purpose is still "Clear video prompt" above. */}
              <button
                type="button"
                onClick={() => { onDuplicateWithPrompt(vpText); setVpOpen(false); }}
                disabled={!vpText.trim()}
                className={cn(
                  'flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition', GATE_FOCUS,
                  vpText.trim() ? TILE_BTN : cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED),
                )}
              >
                Create duplicate
              </button>
              <button
                type="button"
                onClick={() => setVpOpen(false)}
                className={cn('rounded-lg border px-3 py-2 text-xs font-medium transition', GATE_FOCUS, GATE_HAIRLINE, GATE_MUTED)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {busy && <p className={cn('text-[0.6875rem]', GATE_MUTED)}>{busy}…</p>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * One generated image in the inline results area — its own actions, and the control that selects it.
 *
 * WHY EVERY TILE CARRIES ITS OWN ACTIONS: they used to live ONLY in the bulk bar below the grid,
 * which only appears once something is selected — and selecting meant clicking the picture, an
 * affordance nothing on screen announced. A user who generated their first image saw a photo and
 * no controls, and reported exactly that ("it not showing the ui good and it for i click animate
 * or retry"). A single result now has to be fully operable — animate, regenerate, remove — without
 * the user ever discovering that images are clickable. The bulk bar is a good tool for twenty
 * results; it was the wrong and only tool for one.
 *
 * WHY THE WORDING IS COPIED FROM THE BULK BAR VERBATIM ("Regenerate", "Generate video", "Remove"):
 * the same action must not be called two things depending on where you press it. "Animate" was the
 * obvious per-tile label and is deliberately NOT used — the bar says Generate video, so the tile
 * says Generate video.
 *
 * WHY a real <button> around the picture rather than ImageCard's `onSelect` (which hangs a click
 * handler off a plain <div>): selecting is tabbable, Enter/Space-activatable and announced as a
 * toggle. aria-pressed carries the state that the outline alone does not. The actions stay
 * reachable as SIBLING buttons below the image rather than nested inside the selection button —
 * nesting one interactive element inside another is invalid, and it is why ImageCard is not reused.
 *
 * WHY the tile never changes size or leaves the grid: regenerating in place must not reflow the
 * results. A busy tile shows its spinner over its existing image, keeping its exact box, so the
 * grid you were looking at is the grid you are still looking at when the work lands. The
 * regenerate note below expands INSIDE the tile's own cell for the same reason — the grid rows
 * are auto-sized, so one tile growing never moves the tiles beside it out from under the cursor.
 */
function ResultTile({ item, src, thumbSrc, selected, busy, error, favorited, onToggleFavorite, onToggle, onRegenerate, onAnimate, onRemove, onClearVideoPrompt, onDuplicateWithPrompt, openLightbox, onOpenLightbox, onCloseLightbox, onStepLightbox, lightboxPos }) {
  // Needed here so a download that could not be cleaned can SAY so — the old empty catch is how a
  // raw file left this page unnoticed.
  const { notify } = useApp();
  const noVideo = !item.videoPrompt;
  // The same predicate the bulk bar and the confirmation both filter on, so a tile whose button is
  // enabled is exactly a tile the gate will quote and dispatch for.
  const canAnimate = Boolean(item.videoPrompt && item.galleryId && item.submitVideo);
  // FEATURE 2: only offer "Clear video prompt" when there IS one to clear. Independent of galleryId /
  // submitVideo — clearing is a pure text edit and must work even on a rehydrated tile that can't animate.
  const canClearVideoPrompt = Boolean(item.videoPrompt);
  // Regenerate needs the run's face reference and combo, which are closures that cannot be
  // persisted — so a REHYDRATED tile (loaded from IndexedDB after a reload) has none, and its
  // Regenerate control is disabled rather than crashing on a missing closure. A current-session
  // tile carries a real `regenerate` and keeps the full control. Animate is unaffected: it was
  // rebuilt from persisted fields, so it works on rehydrated tiles too.
  const canRegenerate = Boolean(item.regenerate);
  // A clip that is FINISHED and lives on our disk — the only case where Download can hand back a
  // video. `videoStatus === 'done'` alone is not enough: a provider-hosted clip has no local file,
  // so downloadVideo would refuse it (it cannot be metadata-stripped) and the button would do
  // nothing. Falling back to the image there is the honest behaviour.
  const readyClip = item.videoStatus === 'done' && Boolean(localClipFilename(item.videoUrl));

  // THE PER-TILE CORRECTION NOTE, and the one place the precedence question is settled.
  //
  // A per-tile regenerate needs somewhere to say what to change, and the shared box lives in the
  // bulk bar — which does not exist until something is selected. Rather than duplicate the shared
  // box onto every tile (twenty always-visible inputs in a results grid, and a real ambiguity about
  // which one wins), the tile's Regenerate is a DISCLOSURE: it opens this tile's own note, focused,
  // with the button that actually spends money sitting inside it.
  //
  // PRECEDENCE, stated once and true by construction: an instruction belongs to the button that
  // was pressed. This note is read ONLY by this tile's Regenerate; the bulk bar's box is read ONLY
  // by the bar's Regenerate. They are never merged, never concatenated, and neither ever falls back
  // to the other — so there is no case where a user has to guess which text is in play. Held local
  // to the tile (keyed by uid, which never changes) so a half-typed fix survives other tiles
  // landing around it.
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const noteRef = useRef(null);
  // A user-PASTED VIDEO PROMPT, wholesale replacing whatever this tile inherited from its pose. Its
  // own disclosure, independent of the regenerate note above (different action, different money path
  // — this one drives Generate video, not Regenerate). Deliberately starts EMPTY every time it opens
  // — this is "drop in a different prompt", not "edit the existing one" — so a paste lands clean with
  // no old text to select-and-delete first. The current prompt (if any) is shown as a small reference
  // caption instead, so overwriting it isn't done blind.
  const [vpOpen, setVpOpen] = useState(false);
  const [vpText, setVpText] = useState('');
  const vpRef = useRef(null);
  // The click-to-open large view. Opened by clicking the IMAGE (below); the tile's own inline
  // actions stay exactly where they were, so the lightbox is an additional way in, not a
  // replacement. It renders `note`/`setNote` and this tile's handlers, so it shares the tile's
  // state rather than forking a second correction box.
  // OWNED BY THE PARENT, not by the tile. It used to be tile-local `useState`, which made
  // stepping to the next image impossible: a tile knows nothing about its neighbours, so the
  // large view was a dead end you had to close before opening another (owner, 2026-08-07).
  // The parent holds the open uid and the ordering; the tile still RENDERS the lightbox, so it
  // keeps sharing this tile's note/handlers rather than forking a second correction box.
  const lightboxOpen = openLightbox;
  const setLightboxOpen = (v) => (v ? onOpenLightbox?.() : onCloseLightbox?.());
  // Whether the picture has actually arrived over the wire.
  //
  // A finished tile draws its buttons the moment the result exists, but the image itself is a
  // separate HTTP fetch — and a 60-image batch fires 60 of them at once, so tiles sat blank for
  // seconds looking like a bug ("WTF there is some bug I can't see it" — owner, 2026-08-06; the
  // pictures did arrive, just slowly). Nothing was broken and nothing said so. Keyed on `src` so
  // a regenerate that swaps in a new picture shows the placeholder again instead of holding the
  // old image's "loaded" state.
  const [imgLoaded, setImgLoaded] = useState(false);
  const imgRef = useRef(null);
  useEffect(() => {
    setImgLoaded(false);
    // A CACHED image completes BEFORE React attaches onLoad, so that event never fires and the
    // tile stays at opacity-0 behind a permanent "Loading…" — which is exactly what leaving Eddy
    // and coming back looked like: every picture present, none of them visible, reported as data
    // loss (owner, 2026-08-06). Nothing was lost; the reveal was just waiting on an event that had
    // already happened. Asking the element directly is the only reliable answer.
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth > 0) setImgLoaded(true);
  }, [src]);

  // Focus the note the moment it opens. Regenerate-with-a-fix is a "type the correction" action,
  // and making the user hunt for the field they just revealed is the friction this flow removes.
  useEffect(() => { if (noteOpen) noteRef.current?.focus(); }, [noteOpen]);

  // Every save from this tile goes through downloadBlob — the app's single save path, which strips
  // generator/C2PA metadata before the file lands. A bare `<a download>` here is what let raw files
  // out of this page, so neither of these two functions builds its own anchor.
  const download = async () => {
    if (!src) return;
    try {
      const resp = await fetch(src, { credentials: 'include' });
      if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
      const blob = await resp.blob();
      // Extension follows the ACTUAL bytes. This used to be a hardcoded .png, which mislabels a
      // JPEG or WebP the gallery served.
      const type = blob.type || item.mimeType || 'image/png';
      const ext = type.includes('jpeg') || type.includes('jpg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png';
      const info = await downloadBlob(blob, `eddy_${Date.now()}.${ext}`);
      // downloadBlob only puts `_metadatacleaned` on a file it actually cleaned, so the name is
      // never a lie — but a silent pass-through would still leave the user believing this file was
      // cleaned like every other download here. Say it out loud. (Stripping switched OFF is a
      // deliberate user setting, not a failure, so it is not reported as one.)
      if (stripEnabled() && !info.cleaned) {
        notify(`Metadata could NOT be removed (${info.reason || 'unknown'}) — saved as-is. Do not publish it without checking.`, 'error');
      }
    } catch (err) {
      notify(err?.message || 'Download failed', 'error');
    }
  };

  // Clips are stripped SERVER-side: rewriting an MP4 container needs ffmpeg, which is why
  // stripMetadata passes video through untouched and the /clean route exists.
  const downloadVideo = async () => {
    const filename = localClipFilename(item.videoUrl);
    // A provider-hosted clip never reached our disk, so there is nothing the clean route can rewrite.
    // Refused rather than handed over: an unstripped file downloaded from Kyros looks exactly like
    // a stripped one, and these files get published.
    if (!filename) {
      notify('That clip is hosted by the provider, so its metadata cannot be removed here — not downloading. Fetch it from the Library instead.', 'error');
      return;
    }
    try {
      const resp = await fetch(videoApi.cleanFileUrl(filename), { credentials: 'include' });
      if (!resp.ok) throw new Error(`Video download failed (${resp.status})`);
      // The route deliberately serves the ORIGINAL when ffmpeg fails and reports that in this
      // header. The bytes alone cannot be distinguished, so the header is the only honest signal.
      const stripped = resp.headers.get('X-Metadata-Stripped') === 'yes';
      const ext = (filename.match(/\.[a-z0-9]+$/i) || ['.mp4'])[0];
      const stem = filename.slice(0, filename.length - ext.length) || 'eddy-video';
      const blob = await resp.blob();
      // Still through downloadBlob so there is one save path in the app; it leaves video bytes
      // alone (already cleaned upstream) and keeps the name we set.
      await downloadBlob(blob, `${stem}${stripped ? '_metadatacleaned' : '_NOT-cleaned'}${ext}`);
      if (!stripped) {
        notify('Metadata could NOT be removed from this clip — it saved as _NOT-cleaned. Do not publish it as-is.', 'error');
      }
    } catch (err) {
      notify(err?.message || 'Video download failed', 'error');
    }
  };

  return (
    <div className={cn(
      'flex flex-col overflow-hidden rounded-xl border bg-white/[0.02] transition-colors',
      selected ? 'border-white/60' : 'border-zinc-800/60',
    )}>
      {/* The image AREA. A plain <div>, not a button: the image opens the large view and the
          selection tick is its own control, and nesting a button inside a button is invalid — so
          the two live as SIBLINGS over one relative box rather than one nested in the other. */}
      <div className="relative aspect-square w-full bg-black/40">
        {item.videoStatus === 'done' && item.videoUrl ? (
          // THE FINISHED CLIP, PLAYABLE IN PLACE. Per user request a completed animation now STAYS in
          // the grid as something the user can click and watch — the tile is no longer removed the
          // moment its video finished. <video controls> so it plays and scrubs on click. The src is
          // the RAW playback URL on purpose: scrubbing must not pay the clean route's audio re-encode.
          // The metadata-stripped copy is what the Download control below serves (downloadVideo →
          // downloadBlob(cleanFileUrl)). This preview is view-only — a browser's native "save video
          // as" here would fetch the raw file, which is exactly why the tile's own Download button, not
          // this element, is the sanctioned way the clip leaves the page.
          <video
            src={item.videoUrl}
            controls
            playsInline
            preload="metadata"
            className="h-full w-full bg-black object-contain"
          />
        ) : (
        /* THE IMAGE opens the large view. A ~160px thumbnail is too small to judge "what to change
            on this one" against — the large view is where that decision is actually made. Kept
            openable even while busy: viewing a regenerating tile big is safe and useful. */
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          aria-label="Open this image large"
          title="Open large — regenerate, animate, remove or download from there"
          className={cn(
            'block h-full w-full transition-[filter,opacity] duration-150 motion-reduce:transition-none',
            GATE_FOCUS,
            busy ? 'cursor-wait' : 'cursor-zoom-in',
          )}
        >
          {src
            ? (
              <span className="relative block h-full w-full">
                {/* Sits BEHIND the image and is removed on load, so a slow fetch reads as
                    "loading" rather than as a broken tile. eager, not lazy: these are the
                    images you just paid for and are waiting on — deferring the ones below the
                    fold is what made a long batch look half-empty while scrolling. */}
                {!imgLoaded && (
                  <span className={cn('absolute inset-0 flex animate-pulse items-center justify-center bg-white/[0.04] text-[0.625rem]', GATE_MUTED)}>
                    Loading…
                  </span>
                )}
                <img
                  ref={imgRef}
                  /**
                   * THE THUMBNAIL, not the full picture.
                   *
                   * A 2K generation decodes to roughly 2048x2732x4 = 22 MB of bitmap in
                   * memory, and this grid held every result at full size. Ninety-two tiles is
                   * on the order of 2 GB of decoded images -- which is what "the app goes
                   * black" is: the Electron renderer running out of memory (owner,
                   * 2026-08-09).
                   *
                   * /thumb is 400px wide at JPEG 70 -- about 0.85 MB decoded, roughly 26x
                   * less -- and a tile is a few hundred pixels wide, so nothing visible is
                   * lost. The lightbox still gets `src`, the full-resolution one, because
                   * that is the view where resolution actually matters.
                   */
                  src={thumbSrc || src}
                  alt=""
                  // LAZY, NOT EAGER. A browser opens ~6 connections per host, so 120 eager tiles
                  // queue 120 fetches and every one of them sits on "Loading…" for a long time —
                  // observed on a 120-image run (owner, 2026-08-06). eager was set here when a
                  // batch meant a handful of tiles and it did not survive contact with a real
                  // batch: lazy fetches what is on screen, which is the only part you can look at.
                  loading="lazy"
                  decoding="async"
                  onLoad={() => setImgLoaded(true)}
                  // A broken/expired URL must not leave the shimmer pulsing forever — clearing the
                  // flag lets the empty tile settle instead of animating a picture that will never come.
                  onError={() => setImgLoaded(true)}
                  className={cn('h-full w-full object-cover transition-opacity duration-200 motion-reduce:transition-none',
                    imgLoaded ? 'opacity-100' : 'opacity-0')}
                />
              </span>
            )
            : <span className={cn('flex h-full w-full items-center justify-center text-xs', GATE_MUTED)}>No preview</span>}
        </button>
        )}
        {/* THE SELECTION CONTROL, ALWAYS DRAWN — an empty checkbox when unselected, a filled tick
            when selected, so an unselected grid still announces "these are selectable" without a
            click. It is now a REAL button (the image no longer toggles selection — it opens the
            large view), sitting as a sibling of the image button, which keeps both valid. Still
            white, never amber — amber is dollar figures only. */}
        {!busy && (
          <button
            type="button"
            onClick={onToggle}
            aria-pressed={selected}
            aria-label={selected ? 'Deselect this image' : 'Select this image'}
            title={selected ? 'Selected — click to deselect' : 'Select this image'}
            className={cn(
              'absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md border text-[0.75rem] font-bold transition-colors cursor-pointer',
              GATE_FOCUS,
              selected ? 'border-white bg-white text-[#101017]' : 'border-white/70 bg-black/45 text-transparent hover:text-white/70',
            )}
          >
            ✓
          </button>
        )}
        {/* FAVORITE STAR — moves this result's SOURCE pose (the pose it was generated from) into the
            Pose tab's "★ Favorite", fully populated with its existing image / pose prompt / video prompt /
            title. Top-LEFT so it never overlaps the selection tick (top-right, above) — the two controls
            sit in opposite corners as siblings over the one relative box. Rose when on, muted outline off
            — never amber (amber is dollar figures only). stopPropagation + preventDefault so a click never
            opens the large view (the image button beneath it) nor toggles selection. Drawn even while busy
            so a regenerating tile can still be marked. */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggleFavorite(); }}
          aria-pressed={favorited}
          aria-label={favorited ? 'Remove source pose from Favorites' : 'Add source pose to Favorites'}
          title={favorited ? 'Favorited — click to remove this result’s pose from your Pose favorites' : 'Favorite this result’s pose — sends the pose it was made from to ★ Favorite in your Pose tab'}
          className={cn(
            'absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-md border transition-colors cursor-pointer',
            GATE_FOCUS,
            favorited ? 'border-rose-400 bg-black/45 text-rose-400' : 'border-white/70 bg-black/45 text-white/70 hover:text-rose-300',
          )}
        >
          <StarIcon filled={favorited} />
        </button>
        {/* The already-animated mark, on the picture itself so it is readable BEFORE the tile is
            selected and counted — the caption below only says so once you are reading the tile in
            detail. Bottom-left, clear of the selection tick. pointer-events-none so it never eats a
            click meant for the image button underneath it. Neutral, never amber. */}
        {hasClip(item) && !busy && (
          <span className={cn(
            'pointer-events-none absolute bottom-2 left-2 rounded-full bg-black/75 px-2 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide',
            item.videoStatus === 'done' ? 'text-emerald-300' : 'text-zinc-300',
          )}>
            {item.videoStatus === 'done' ? '● Video' : '◌ Video'}
          </span>
        )}
        {busy && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70">
            <Spinner size={20} />
            <span className={cn('text-[0.625rem] uppercase tracking-wide', GATE_MUTED)}>{busy}</span>
          </div>
        )}
      </div>

      <div className="space-y-1 p-2">
        {/* THE PER-TILE ACTIONS. Always rendered, never revealed on hover and never behind
            selection — a hover-gated control is unreachable by keyboard and invisible on a
            touchpad sweep, and a selection-gated one is invisible full stop until you have already
            guessed the interaction. Two-up so four controls fit a ~160px tile without turning the
            column into a stack of buttons with photos between them. */}
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            // Guarded so the disclosure never opens on a tile that cannot regenerate — the note's
            // own Regenerate button would otherwise call a null closure.
            onClick={() => { if (canRegenerate) setNoteOpen((v) => !v); }}
            disabled={Boolean(busy) || !canRegenerate}
            aria-expanded={noteOpen}
            title={canRegenerate
              ? 'Make this one again — optionally saying what to change.'
              : 'Regenerate needs a fresh generation — reload cleared its settings.'}
            className={cn(
              TILE_ACTION, GATE_FOCUS,
              busy || !canRegenerate
                ? cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED)
                : TILE_BTN,
            )}
          >
            Regenerate
          </button>
          <button
            type="button"
            onClick={onAnimate}
            // Disabled for exactly the reason spelled out under the tile ("No video prompt on this
            // pose"), so a dead button is never unexplained.
            disabled={Boolean(busy) || !canAnimate}
            title={canAnimate ? 'Render a video from this image — you will be shown the price first.' : 'This pose has no video prompt, so it cannot be animated.'}
            className={cn(
              TILE_ACTION, GATE_FOCUS,
              busy || !canAnimate
                ? cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED)
                : TILE_BTN_PRIMARY,
            )}
          >
            Generate video
          </button>
          {/* VIDEO WINS. Once a tile has been animated the clip IS the tile — saving its still frame
              instead was the reported bug (Download handed back a PNG on a finished video). Matches
              what "Download all" already does. Falls back to the image while the clip is still
              rendering or when the tile was never animated, and the label says which you will get. */}
          <button
            type="button"
            onClick={readyClip ? downloadVideo : download}
            title={readyClip ? 'Saves the video (metadata removed)' : 'Saves the image (metadata removed)'}
            className={cn(TILE_ACTION, GATE_FOCUS, TILE_BTN)}
          >
            {readyClip ? 'Download video' : 'Download'}
          </button>
          {/* Same muted-red-on-hover treatment and the same promise as the bulk bar's Remove: it
              clears the tile off this column and the picture stays in the Library. Carries no
              dollar figure because nothing is billed or refunded — so, per the amber rule, no
              amber. */}
          <button
            type="button"
            onClick={onRemove}
            disabled={Boolean(busy)}
            title="Clears this from the results list. The image stays in your Library."
            className={cn(
              TILE_ACTION, GATE_FOCUS,
              busy
                ? cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED)
                : TILE_BTN_DANGER,
            )}
          >
            Remove
          </button>
        </div>

        {/* FEATURE 2 — "Clear video prompt". Sits under the actions, next to the video note it governs,
            and only appears when there is a prompt to clear. Removes the text that drives animation
            (this result AND its source pose) without touching the image, the result or any clip — so
            it carries no dollar figure and, per the amber rule, no amber. A muted trash-style link,
            not a primary button: it's a corrective, not one of the four main actions. */}
        {canClearVideoPrompt && (
          <button
            type="button"
            onClick={onClearVideoPrompt}
            disabled={Boolean(busy)}
            title="Deletes the video prompt for this pose so it won't animate (image is kept). Also clears it on the source pose."
            className={cn(
              'w-full rounded-md border px-2 py-1 text-[0.625rem] transition', GATE_FOCUS,
              busy
                ? cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED)
                : TILE_BTN_DANGER,
            )}
          >
            Clear video prompt
          </button>
        )}

        {/* PASTE a different video prompt onto this tile — wholesale replacement, not an edit of
            what's there. Always offered: a pose-less tile can get a first prompt, and a tile with
            one can be handed a completely different one. Opens EMPTY (see the vpText comment above)
            and autofocuses, so pasting is the only step. */}
        <button
          type="button"
          onClick={() => { setVpText(''); setVpOpen((v) => !v); }}
          disabled={Boolean(busy)}
          title="Makes a new copy of this image with your pasted video prompt — the original and its own video prompt are left untouched."
          className={cn(
            'w-full rounded-md border px-2 py-1 text-[0.625rem] transition', GATE_FOCUS,
            busy
              ? cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED)
              : cn(GATE_HAIRLINE, GATE_TEXT, 'hover:border-white/25'),
          )}
        >
          {noVideo ? 'Duplicate with a video prompt' : 'Duplicate with a different video prompt'}
        </button>

        {vpOpen && !busy && (
          <div className="space-y-1 rounded-lg border border-white/[0.07] bg-black/25 p-1.5">
            {/* The prompt it HAS today, for reference only — the box below is not seeded from it. */}
            {item.videoPrompt && (
              <p className={cn('text-[0.5625rem] leading-tight line-clamp-2', GATE_MUTED)}>
                This image currently has: {item.videoPrompt}
              </p>
            )}
            <textarea
              ref={vpRef}
              autoFocus
              value={vpText}
              onChange={(e) => setVpText(e.target.value)}
              // Escape closes without saving, matching the regenerate note. Enter is left alone (a
              // real newline) since a video prompt is prose, not a one-line correction.
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setVpOpen(false); } }}
              rows={4}
              placeholder="Paste your video prompt here..."
              className={cn(
                'w-full resize-y rounded-md border bg-black/30 px-2 py-1.5 text-[0.625rem] leading-snug outline-none transition placeholder:text-[#5a5a67]',
                GATE_FOCUS, GATE_HAIRLINE, GATE_TEXT, 'focus:border-white/25',
              )}
            />
            <div className="flex gap-1.5">
              {/* Disabled on empty so an accidental click here can't silently wipe an existing
                  prompt — clearing on purpose is still "Clear video prompt" above. */}
              <button
                type="button"
                onClick={() => { onDuplicateWithPrompt(vpText); setVpOpen(false); }}
                disabled={!vpText.trim()}
                className={cn(
                  TILE_ACTION, GATE_FOCUS, 'flex-1',
                  vpText.trim() ? cn('cursor-pointer', GATE_HAIRLINE, GATE_TEXT, 'hover:border-white/25') : cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED),
                )}
              >
                Create duplicate
              </button>
              <button
                type="button"
                onClick={() => setVpOpen(false)}
                className={cn(TILE_ACTION, GATE_FOCUS, 'cursor-pointer', GATE_MUTED, GATE_HAIRLINE)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* This tile's own correction note — see the precedence comment at the top of the
            component. Rendered only while open so a grid of twenty tiles is not a grid of twenty
            text fields. */}
        {noteOpen && !busy && (
          <div className="space-y-1 rounded-lg border border-white/[0.07] bg-black/25 p-1.5">
            <input
              ref={noteRef}
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              // Enter regenerates THIS tile, mirroring the bulk bar's box. Escape closes without
              // spending anything. Enter deliberately never routes to video — as in the bar, the
              // expensive action is not reachable by a keystroke.
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); onRegenerate(note); setNoteOpen(false); }
                if (e.key === 'Escape') { e.preventDefault(); setNoteOpen(false); }
              }}
              placeholder="What to change on this one? (optional)"
              title="Left empty, Regenerate re-rolls this image's prompt exactly as before."
              className={cn(
                'w-full rounded-md border bg-black/30 px-2 py-1 text-[0.625rem] outline-none transition placeholder:text-[#5a5a67]',
                GATE_FOCUS, GATE_HAIRLINE, GATE_TEXT, 'focus:border-white/25',
              )}
            />
            <button
              type="button"
              onClick={() => { onRegenerate(note); setNoteOpen(false); }}
              className={cn(
                TILE_ACTION, GATE_FOCUS, 'w-full cursor-pointer', GATE_HAIRLINE, GATE_TEXT,
                'hover:border-white/25',
              )}
            >
              {/* Through the same Money component as every other figure on this page, which is what
                  keeps the amber rule mechanically true rather than a convention to remember. */}
              Regenerate <Money amount={item.regenCost || 0} decimals={3} className="text-[0.625rem]" />
            </button>
          </div>
        )}

        {/* Stated on the tile, not only in the confirmation: an image that can never animate
            should be obvious BEFORE it is selected and counted. */}
        {noVideo && !vpOpen && (
          <p className={cn('text-center text-[0.5625rem] leading-tight', GATE_MUTED)}>No video prompt on this pose — paste one above to create an animatable copy</p>
        )}

        {error && <p className="text-center text-[0.625rem] leading-tight text-[#d4736d]">{error}</p>}

        {/* These captions used to read "see Generation Feed". That panel is hidden on this page
            now, so the old text pointed at something not on screen. The finished video is the one
            feed capability with no inline equivalent, so surface it as a real link rather than a
            dead instruction; pending/failed states just describe themselves. */}
        {item.videoStatus && (
          <p className={cn('text-center text-[0.625rem]',
            item.videoStatus === 'error' ? 'text-red-400' : item.videoStatus === 'done' ? 'text-emerald-400' : 'text-zinc-500')}>
            {item.videoStatus === 'pending' && 'Animating…'}
            {/* Was an `<a href={item.videoUrl} target="_blank">`, which handed the RAW file
                straight to the browser — opening it in a tab and saving from there bypassed
                stripping entirely, and is how an unstripped .mp4 got out. A button that routes
                through the clean route is the only way this clip leaves the page. */}
            {item.videoStatus === 'done' && (item.videoUrl
              ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); downloadVideo(); }}
                  className="underline underline-offset-2 outline-none focus-visible:ring-1 focus-visible:ring-emerald-400 focus-visible:ring-offset-1 focus-visible:ring-offset-black rounded-sm"
                  title="Download the clip with its metadata removed."
                >
                  Video ready — download
                </button>
              )
              : 'Video ready — check Library')}
            {item.videoStatus === 'error' && `Video failed: ${item.videoError || 'unknown error'}`}
          </p>
        )}
      </div>

      {/* The click-to-open large view — shares this tile's own `note` state and its own handlers, so
          Regenerate/Generate video/Remove from the large view are literally the same calls (and the
          same money path and gate) as the buttons above. Mounted only while open, so its scroll-lock
          hook mounts on open and restores on close. */}
      {lightboxOpen && (
        <ResultLightbox
          src={src}
          item={item}
          busy={busy}
          favorited={favorited}
          onToggleFavorite={onToggleFavorite}
          note={note}
          setNote={setNote}
          canRegenerate={canRegenerate}
          canAnimate={canAnimate}
          canClearVideoPrompt={canClearVideoPrompt}
          noVideo={noVideo}
          vpOpen={vpOpen}
          setVpOpen={setVpOpen}
          vpText={vpText}
          setVpText={setVpText}
          onRegenerate={onRegenerate}
          onAnimate={onAnimate}
          onClearVideoPrompt={onClearVideoPrompt}
          onDuplicateWithPrompt={onDuplicateWithPrompt}
          onRemove={onRemove}
          onDownload={download}
          onClose={() => setLightboxOpen(false)}
          onStep={onStepLightbox}
          pos={lightboxPos}
        />
      )}
    </div>
  );
}

/**
 * A placeholder for an image that has been dispatched but has not landed yet.
 *
 * WHY it exists: with the shared Generation Feed hidden on this page, a batch used to leave the
 * results column completely blank for the thirty-plus seconds before the first image returned —
 * the user had no on-screen evidence that anything was happening at all.
 *
 * WHY it is this quiet: a grid of spinners reads as an error state, and the honest signal here is
 * "a slot is reserved for a picture", not "something is churning". A dashed box that breathes says
 * that with one very slow pulse and no chrome. It is deliberately the SAME box as a ResultTile
 * (aspect-square, same rounding, same grid cell) so that when the image lands and a placeholder is
 * dropped, nothing on screen changes size or position.
 */
function PendingTile() {
  return (
    <div
      // aria-hidden: the count is announced once by the live region above the grid rather than
      // N times by N identical placeholders, which is noise in a screen reader.
      aria-hidden="true"
      className={cn(
        'flex aspect-square w-full items-center justify-center rounded-xl border border-dashed border-white/[0.09] bg-white/[0.015]',
        'motion-safe:animate-pulse [animation-duration:2.4s]',
      )}
    >
      <span className={cn('text-[0.625rem] uppercase tracking-wide', GATE_MUTED)}>Generating</span>
    </div>
  );
}

const stateStore = createPageStore('eddy-generate-state');

// The RESULTS panel is a PERSISTENT working queue, not ephemeral state. A generated image stays
// on screen — surviving reloads and navigation — until the user removes it or its video finishes
// rendering. Its own IndexedDB store, separate from the form-field store above, so clearing one
// never clears the other.
//
// WHAT IS PERSISTED, and nothing else: only the light fields needed to redraw a tile (which reads
// its picture from the SAVED server copy via galleryId, not from bytes) and to re-animate it. The
// base64 image data, the face reference and the run closures (regenerate/submitVideo) are NEVER
// written here — base64 would blow IndexedDB the way it once blew localStorage, and a closure is
// not structured-cloneable at all. Both Animate and Regenerate are RECONSTRUCTED on rehydrate from
// these light fields: Animate from galleryId + aspectRatio, Regenerate from the persisted `combo`
// (or, for older data with no saved combo, the page's current outfit/pose selection) rebound to the
// live generateCombo via a ref — so the button works after a reload, never a dead control.
const resultsStore = createPageStore('eddy-results-v1');

/**
 * THE UNFINISHED RUN — what was still owed when the app last closed.
 *
 * A batch lived entirely in memory: runPool walked an array, and closing the app mid-run threw away
 * every combo that had not been dispatched yet. Forty images in, twenty to go, and the twenty were
 * simply gone with nothing on screen to say so (owner, 2026-08-09).
 *
 * Each job carries its own status, and the status is the whole point, because the two failure modes
 * cost very different things:
 *
 *   'queued' — never sent, never billed. Safe to run on reopen, and it IS run: this is the queue
 *              that must not get cut off.
 *   'sent'   — the request left the machine. The server finishes and BILLS it whether or not this
 *              app is alive to receive the reply, so re-sending pays twice for one picture. These
 *              are never re-dispatched automatically. They are shown, and the Library's own
 *              recovery sweep (EddyTabs) pulls in whichever ones actually landed, because the
 *              server saved them to the gallery regardless. A Retry is offered for any that truly
 *              never arrived — a decision worth money, so it stays the user's.
 *
 * Scoped by `mode`. All three tabs (Eddy, Max Nano, Max Outfit) render this page and share these
 * module-level stores, so without the mode a queue left by Eddy would resume the moment Max Nano
 * was opened, spending money in the wrong tab on a batch nobody asked for there.
 *
 * Only ids and scalars are stored — combos are {outfitId, poseId, baseId}. The reference PHOTOS are
 * deliberately not: they already persist with the page state, and a resumed run rebuilds its
 * context from whatever is in the slots at resume time. Worth knowing rather than hiding: swap the
 * character before resuming and the rest of the batch is generated as HER.
 */
const jobQueueStore = createPageStore('eddy-jobqueue-v1');
const JOB_QUEUE_KEY = 'unfinished';

/** Newest-wins read of the stored run, or null when there is nothing outstanding. */
async function readJobQueue(mode) {
  try {
    const rec = await jobQueueStore.get(JOB_QUEUE_KEY, null);
    if (!rec || !Array.isArray(rec.jobs) || !rec.jobs.length) return null;
    if ((rec.mode || 'eddy') !== mode) return null;   // another tab's run — not ours to resume
    return rec;
  } catch { return null; }
}

/**
 * Patch one job's status in place. Read-modify-write on every transition, which is the point: the
 * record has to survive a kill at ANY instant, and a kill between "sent" and "done" must read as
 * sent (possibly billed) rather than queued (safe to re-run).
 */
async function markJob(jid, status) {
  try {
    const rec = await jobQueueStore.get(JOB_QUEUE_KEY, null);
    if (!rec || !Array.isArray(rec.jobs)) return;
    const jobs = rec.jobs.map((j) => (j.jid === jid ? { ...j, status } : j));
    // Nothing left to owe — clear rather than leave an empty husk that reads as an unfinished run.
    if (jobs.every((j) => j.status === 'done' || j.status === 'failed')) await jobQueueStore.set(JOB_QUEUE_KEY, null);
    else await jobQueueStore.set(JOB_QUEUE_KEY, { ...rec, jobs });
  } catch { /* bookkeeping only — never fail a generation over it */ }
}

async function clearJobQueue() {
  try { await jobQueueStore.set(JOB_QUEUE_KEY, null); } catch { /* nothing to do */ }
}

/**
 * Saved MODELS — a named set of {main photo, face close-up, build}.
 *
 * The page has never known a character's NAME: "Grace" was only ever whichever photos happened to
 * be in the two slots, and `Her build` was one global setting. That works while there is exactly
 * one character and breaks the moment there are two — swap Grace's photos for Sienna's and Grace's
 * "Very large" silently applies to Sienna until you remember to change it (owner, 2026-08-06).
 * Binding the build to the model is the whole point of saving them together.
 *
 * IndexedDB rather than localStorage: these hold two full data-URL photos each, which would blow
 * a 5MB localStorage quota after a couple of models.
 */
const modelsStore = createPageStore('eddy-models-v1');

/**
 * The persisted shape of one result tile.
 *
 * ONLY light fields — deliberately NOT base64Data, NOT the face reference, NOT the regenerate/
 * submitVideo closures (a closure isn't even structured-cloneable). galleryId is all a tile needs to
 * redraw; the rest is what Animate, Regenerate and the cost labels need.
 *
 * Extracted to module scope because TWO paths write it now: the debounced persist effect (mirrors
 * `results` while the page is open) and generateCombo's completion, which writes a finished tile
 * straight to storage when the page has been navigated away from — see the unmount note there.
 */
function liteResult(r) {
  return {
    uid: r.uid,
    galleryId: r.galleryId,
    imageId: r.imageId,
    prompt: r.prompt,
    videoPrompt: r.videoPrompt,
    // Persisted so a rehydrated tile can still propagate a "clear video prompt" to its source pose.
    poseId: r.poseId,
    // The outfit+pose ids this image was generated from — the ONE run input a rebuilt Regenerate
    // needs. Two small ids, plain and structured-cloneable.
    combo: r.combo || null,
    regenCost: r.regenCost,
    aspectRatio: r.aspectRatio,
    resolutionTier: r.resolutionTier,
    videoStatus: r.videoStatus,
    // Carry the clip fields so a reload rehydrates a PLAYABLE done tile (videoUrl) instead of a
    // stuck spinner, and so a still-pending tile keeps the taskId the reconcile poll needs.
    videoUrl: r.videoUrl,
    videoTaskId: r.videoTaskId,
    videoError: r.videoError,
    hasClip: hasClip(r),
  };
}
// Newest results are prepended, so the queue is capped from the OLD end. A working tray this large
// is already unusual; the cap only exists so a user who never clears can't grow the store forever.
/**
 * How many results the panel KEEPS. Nothing is dropped any more.
 *
 * It was 120, and the drop was silent: a 32,520-image run generated and BILLED every one, then
 * quietly threw all but the newest 120 out of the panel (owner, 2026-08-08: "make it never have a
 * cap"). Persisted rows carry no image bytes — a handful of light fields each — so even an absurd
 * run is single-digit megabytes in the store. The real cost of keeping them is DOM nodes, and that
 * is handled by rendering a page at a time (RESULTS_PAGE) rather than by deleting your work.
 */
const RESULTS_CAP = Infinity;

// How many tiles are mounted at once. 32,000 <img> elements would kill the tab; a page plus a
// "show more" keeps every result reachable without ever mounting them all.
const RESULTS_PAGE = 120;

/**
 * Above this many images in one click, the run has to be confirmed.
 *
 * combos is outfits x poses, so the number grows by MULTIPLICATION while the UI only ever shows
 * two innocent-looking "Select all" buttons. Picking every outfit and every pose in a real
 * collection is 542 x 60 = 32,520 images — roughly $1,700 at 1K, $3,100 at 2K, and about 18 hours
 * of wall clock. Nothing stopped that: overCap only limits REFERENCE images per request, not the
 * size of the batch (owner asked directly, 2026-08-08 — the honest answer was no).
 *
 * Set well above normal use (a full pose sweep is 60) so the fast path the owner asked for stays
 * unchanged, and only a genuinely unusual batch is interrupted.
 */
const CONFIRM_ABOVE = 150;

/**
 * Batch progress, held OUTSIDE the component.
 *
 * run() keeps going after you navigate away — the requests are in flight, they are billed, and
 * generateCombo writes each finished tile straight to the store. But the counters were component
 * state, so coming back showed nothing running and the page looked idle while six requests were
 * still out (owner, 2026-08-08).
 *
 * A module-level object with subscribers survives the unmount, and run() updates it through the
 * same closure it already uses. useSyncExternalStore reads it, so a page that mounts mid-batch
 * picks up the live numbers instead of starting from zero.
 */
const _run = { inFlight: 0, queued: 0, done: 0 };
const _runListeners = new Set();
function _emitRun() { for (const fn of _runListeners) fn(); }
function _bumpRun(patch) {
  for (const k of Object.keys(patch)) _run[k] = Math.max(0, patch[k](_run[k]));
  _emitRun();
}
function _subscribeRun(fn) { _runListeners.add(fn); return () => _runListeners.delete(fn); }
// A stable snapshot: useSyncExternalStore compares by reference, so a fresh object every read
// would loop forever. Rebuilt only when a counter actually changes.
let _runSnap = { ..._run };
function _getRunSnap() {
  if (_runSnap.inFlight !== _run.inFlight || _runSnap.queued !== _run.queued || _runSnap.done !== _run.done) {
    _runSnap = { ..._run };
  }
  return _runSnap;
}

const _cache = {
  baseImage: '', faceImage: '', characterName: '', pickedOutfits: [], pickedPoses: [], pickedBases: [], outfitRotation: true, smartMatch: true, instruction: '',
  // staticCamera defaults ON: the user asked for the camera lock to be the standing default, so a
  // fresh page (or one whose stored value predates this feature) starts with movement/zoom locked out.
  nsfw: false, aspectRatio: 'auto', resolution: '1K', staticCamera: true,
  // faceless is OPT-IN (default off): only then is a pose allowed to crop her face out. lighting
  // defaults to 'auto' (keep image 1's own light).
  faceless: false, lighting: 'auto',
  // sendPoseImage defaults ON because that is what this page has always done — the pose PHOTO is
  // sent to Seedream alongside the pose sentence. Left as the default so flipping this feature on
  // does not silently change the output of every existing workflow; the toggle is one click away
  // for testing text-only poses (owner, 2026-08-06, "I will test with send image or no").
  sendPoseImage: true,
  // sendOutfitImage defaults ON, on every engine (owner, 2026-08-09). It was tried and reverted
  // once because the product photo's background and the mannequin's shape arrived with the garment
  // — both of which the prompt now bans by name. The picture carries the cut, colour, fabric and
  // straps that words cannot, so defaulting OFF meant most runs dressed her from a description.
  sendOutfitImage: true,
  // 'auto' emits nothing, i.e. exactly the behaviour that shipped before HER BUILD existed.
  build: 'auto',
  // Which image engine runs the generation. Seedream is the default because it is what this
  // page has always used and what its cost quote is priced for.
  // Nano Banana 2 is the default engine (owner, 2026-08-09).
  engine: 'nano2',
};

/**
 * `mode` — 'eddy' (default) or 'maxNano'.
 *
 * Max Nano is the same page with three things settled for you: no outfit (she keeps what the base
 * photo has on), Nano Banana 2 always, 2K always, and results filed into a Library folder of its
 * own. It is a MODE rather than a copied file on purpose — this page carries every dup-guard,
 * retry, failure-reason and persistence rule built over the last days, and a second copy would
 * need each of them re-applied by hand and would drift the first time one was not (owner asked for
 * "a duplicate of Eddy", 2026-08-09; the behaviour is duplicated, the code is not).
 */
export default function EddyGeneratePage({ mode = 'eddy' }) {
  const maxNano = mode === 'maxNano';
  /**
   * MAX OUTFIT — stage 2, in the app.
   *
   * Max Nano puts her in a pose; this dresses that result. So its SOURCE is not a base photo
   * and a pose diagram, it is a folder of finished Library images — each already carries her,
   * her pose and her room, and the only thing changing is the garment.
   *
   * No pose picker: the pose is baked into the picture. Seedream only: this is exactly the
   * 'change one thing, keep everything else identical' job Seedream has always done in the
   * friend's cloth_swap_paired.py, and it is cheaper than nano2 per image.
   */
  const maxOutfit = mode === 'maxOutfit';
  const { notify } = useApp();
  const outfitStore = useMemo(() => createEddyCollection('eddy-outfit'), []);
  const poseStore = useMemo(() => createEddyCollection('eddy-pose'), []);
  const libraryStore = useMemo(() => createEddyCollection('eddy-library'), []);
  // Read only by the character lookup above: a folder in each IS a character.
  const charStore = useMemo(() => createEddyCollection('eddy-character'), []);
  const baseStore = useMemo(() => createEddyCollection('eddy-base'), []);

  const [outfits, setOutfits] = useState([]);
  const [outfitThumbs, setOutfitThumbs] = useState({});
  const [poses, setPoses] = useState([]);
  // Folder chips above each picker. null = All, so an unfiltered picker behaves as before.
  const [outfitFolders, setOutfitFolders] = useState([]);
  const [poseFolders, setPoseFolders] = useState([]);
  const [folderFilter, setFolderFilter] = useState({ outfit: null, pose: null });
  // "★ Favorite" FILTER per picker — when on, the grid shows only favorited items ACROSS folders
  // (the flag cuts across categories). Separate from folderFilter so the two are one exclusive view:
  // turning Favorite on ignores the folder, and picking any folder turns Favorite off.
  const [favFilter, setFavFilter] = useState({ outfit: false, pose: false });
  // The favorited item ids per picker store, read from each store's small `favorites` key — NOT from
  // item.favorite. A Set per slot so the picker star fill, the "★ Favorite" count and the favorite
  // filter all derive from the same source a big-index rewrite can never clobber. Loaded in loadAll.
  const [favSets, setFavSets] = useState({ outfit: new Set(), pose: new Set(), base: new Set() });
  const [poseThumbs, setPoseThumbs] = useState({});
  const [loading, setLoading] = useState(true);

  const [baseImage, setBaseImage] = useState(_cache.baseImage);   // identity + setting
  const [faceImage, setFaceImage] = useState(_cache.faceImage);   // close-up, face only
  // WHOSE face it is -- the Character collection's folder name. Set when a face is picked, and
  // the only thing that lets a result be filed under her name instead of a generic bucket.
  const [characterName, setCharacterName] = useState(_cache.characterName || '');
  const [pickedOutfits, setPickedOutfits] = useState(_cache.pickedOutfits);
  const [pickedPoses, setPickedPoses] = useState(_cache.pickedPoses);
  // Max Outfit's sources: ids of Library items, each becoming one generation.
  const [pickedBases, setPickedBases] = useState(_cache.pickedBases || []);
  const [libItems, setLibItems] = useState([]);
  const [libItemFolders, setLibItemFolders] = useState([]);
  const [libThumbs, setLibThumbs] = useState({});
  /**
   * ONE OUTFIT PER IMAGE, cycling — the default, and it is a 10x decision.
   *
   * 81 images x 5 outfits is 405 generations and about $18. Rotation gives 81 and about $3.65,
   * and it is what the pipeline this mirrors actually does (RotationPicker: least-used wins, no
   * outfit repeats until every one has been used). Cross-product is there for when you want
   * every combination on purpose, with the count and the price on the button either way.
   */
  const [outfitRotation, setOutfitRotation] = useState(_cache.outfitRotation !== false);
  // Angle-aware dealing, on by default (owner, 2026-08-09: "if selected always on okey").
  const [smartMatch, setSmartMatch] = useState(_cache.smartMatch !== false);
  // Both pickers start open — the work is choosing, so hiding it behind a click was friction.
  const [openPickers, setOpenPickers] = useState({ outfit: true, pose: true });
  const [instruction, setInstruction] = useState(_cache.instruction);

  /**
   * A new base photo starts a new shoot, so the instruction clears with it.
   *
   * The instruction is the one field written FOR a particular picture — "much bigger bust",
   * "oiled", a correction aimed at that shot. Carrying it onto the next base silently applied the
   * last shoot's edits to a different photo, which is invisible until you read the FINAL PROMPT
   * panel (owner, 2026-08-08). Clearing the text clears the chips too: they only ever append to it.
   *
   * Deliberately narrow. It fires ONLY when the base changes from one real photo to a DIFFERENT
   * real photo:
   *   - not on mount, or the saved instruction would be wiped by its own restore;
   *   - not when the slot is cleared, so Clear does not also throw away what you typed;
   *   - not when the same photo is re-picked.
   */
  const prevBaseRef = useRef(null);
  useEffect(() => {
    const prev = prevBaseRef.current;
    prevBaseRef.current = baseImage;
    if (prev === null) return;                    // first run: this is the restore, not a change
    if (!baseImage || !prev) return;              // cleared, or filled for the first time
    if (baseImage === prev) return;               // same picture
    setInstruction('');
  }, [baseImage]);
  const [nsfw, setNsfw] = useState(_cache.nsfw);
  // FACELESS toggle — when ON, a pose is allowed to keep her face cropped out (honours the pose's
  // framing). OFF (default) renders her exact face and copies the pose normally.
  const [faceless, setFaceless] = useState(_cache.faceless);
  // Whether the pose PHOTO goes to the provider, or only the one-sentence pose description.
  // The picture stays visible in the picker either way — this governs the payload, nothing else.
  const [sendPoseImage, setSendPoseImage] = useState(_cache.sendPoseImage ?? true);
  // Whether the outfit's PRODUCT photo goes to the model alongside its description.
  // ON by default, on every engine. The picture is the garment reference — cut, colour, fabric,
  // straps — and the words alone lose all of it. It was defaulting OFF, so every run that did not
  // remember to flip it was dressing her from a description (owner, 2026-08-09).
  const [sendOutfitImage, setSendOutfitImage] = useState(_cache.sendOutfitImage ?? true);
  // Her standing build — describes the character, never changes her. See BUILD_OPTIONS.
  const [build, setBuild] = useState(_cache.build ?? 'auto');
  // 'seedream' | 'nano2' — see the ENGINE switch in the UI and the branch in generateCombo.
  const [engine, setEngine] = useState(_cache.engine ?? 'nano2');

  /**
   * Picking Nano Banana 2 selects 2K.
   *
   * Its 1K tier exists but the owner wants 2K whenever this engine runs (2026-08-09), and having
   * the resolution silently stay wherever Seedream left it is the kind of mismatch you only notice
   * in the output. Switching away leaves the choice alone — Seedream's own default is 1K and
   * forcing it back would fight anyone who deliberately picked 2K there.
   */

  // Bumped by "Reload images". Appended to every tile's URL so the browser re-requests pictures it
  // has cached or given up on — a stalled fetch otherwise leaves a tile on "Loading…" with no way
  // to retry short of reloading the whole app and losing the results column.
  const [imgNonce, setImgNonce] = useState(0);
  // Which result is showing in the large view, by uid. Held here rather than in the tile because
  // stepping to the next image needs the ORDERING, which only the grid knows.
  const [lightboxUid, setLightboxUid] = useState(null);
  // Folder drag-to-nest inside the pickers — the same gesture the collection tabs use, so a folder
  // can be organised from wherever you happen to notice it needs organising.
  const [dragFolderId, setDragFolderId] = useState(null);
  const [dropFolderId, setDropFolderId] = useState(null);
  const moveFolderInSlot = useCallback(async (store, id, parentId, reload) => {
    setDragFolderId(null);
    setDropFolderId(null);
    if (!id || id === parentId) return;
    const ok = await store.setFolderParent(id, parentId);
    if (!ok) { notify('A folder cannot go inside itself', 'error'); return; }
    await reload();
  }, [notify]);
  // [{ name, baseImage, faceImage, build }] — see modelsStore.
  const [models, setModels] = useState([]);
  const [activeModel, setActiveModel] = useState('');
  // Set by Cancel, cleared when a run starts. A ref, not state: runPool reads it through a closure
  // on every claim and must see the CURRENT value — a state variable captured when run() was
  // called would still read false long after the click. `cancelTick` exists only to re-render the
  // button; nothing reads it for the decision.
  const cancelRef = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  // Lighting choice — 'auto' keeps image 1's light; any other relights the scene (see LIGHTING_OPTIONS).
  const [lighting, setLighting] = useState(_cache.lighting);
  // FEATURE 1 — "Static camera": when ON, CAMERA_LOCK_INSTRUCTION is appended to every dispatched
  // video prompt. Default ON (see _cache). Persisted in the page-state store alongside nsfw et al.
  const [staticCamera, setStaticCamera] = useState(_cache.staticCamera);
  // Mirror of staticCamera read by submitVideoJob. submitVideoJob is a `useCallback([])` on purpose
  // (every result tile holds its own bound copy — see its header), so it must NOT close over a piece
  // of state that would force it into a dep array and churn its identity. A ref lets the dispatch
  // read the LIVE toggle without the callback re-creating, exactly like videoFeedMap/hydratedRef.
  const staticCameraRef = useRef(staticCamera);
  useEffect(() => { staticCameraRef.current = staticCamera; }, [staticCamera]);
  useEffect(() => { libItemsRef.current = libItems; }, [libItems]);
  const [aspectRatio, setAspectRatio] = useState(_cache.aspectRatio);
  const [resolution, setResolution] = useState(_cache.resolution);

  // Nano Banana 2 is used at 2K here; picking it selects that rather than leaving whatever
  // Seedream was last set to, which is a mismatch you only notice in the output.
  useEffect(() => { if (engine === 'nano2') setResolution('2K'); }, [engine]);

  /**
   * Max Nano pins the ENGINE. Enforced here rather than only in the UI: the settings are shared and
   * persisted across every workspace, so an engine left over from an Eddy run would otherwise follow
   * you into Max and generate on the wrong one with nothing on screen disagreeing.
   */
  useEffect(() => {
    if (maxNano) setEngine('nano2');
  }, [maxNano, engine]);

  // Max Outfit is Seedream-only, enforced here and not just in the UI: engine is shared and
  // persisted across every workspace, so a nano2 left over from a Max Nano run would otherwise
  // follow you in and swap outfits on the wrong model at the wrong price.
  useEffect(() => {
    if (maxOutfit) setEngine('seedream');
  }, [maxOutfit, engine]);

  /**
   * The Eddy tab arrives on SEEDREAM; Max Nano arrives on Nano Banana 2.
   *
   * `engine` is one shared, persisted value, so whichever tab you used last decided what the next
   * one opened with — land on Eddy after a Max Nano run and it was silently set to nano2, at nano2's
   * price. Set on ARRIVAL only, so switching engine on Eddy still sticks for that session.
   */
  useEffect(() => {
    if (!maxNano && !maxOutfit) setEngine('seedream');
  }, [maxNano, maxOutfit]);

  /**
   * 2K is Max Nano's DEFAULT, not a lock — it is set on arrival and then left alone.
   *
   * Keying this to `resolution` as well would re-fire the moment you picked 1K and put it straight
   * back, which is exactly how it behaved: the button appeared dead and the price stayed at the 2K
   * rate because the setting never actually changed (owner, 2026-08-09).
   */
  useEffect(() => {
    if (maxNano) setResolution('2K');
  }, [maxNano]);
  // Read from the module-level store, so a batch started before you navigated away is still
  // reported when you come back. The setters keep their old names and signatures.
  const runProgress = useSyncExternalStore(_subscribeRun, _getRunSnap, _getRunSnap);
  const { inFlight, queued, done } = runProgress;
  const setInFlight = useCallback((fn) => _bumpRun({ inFlight: typeof fn === 'function' ? fn : () => fn }), []);
  const setQueued = useCallback((fn) => _bumpRun({ queued: typeof fn === 'function' ? fn : () => fn }), []);
  const setDone = useCallback((fn) => _bumpRun({ done: typeof fn === 'function' ? fn : () => fn }), []);
  // Combos that threw, kept so they can be re-run.
  //
  // A failed combo used to vanish: runCombo swallowed the throw, `done` still ticked, and the run
  // ended on "52 of 60 done — the rest failed". Which eight? No tile, no record, nothing to click.
  // On a 60-image run that is the difference between re-running 8 combos and re-running all 60 at
  // full price. Each entry keeps the combo itself, so a retry reproduces exactly that pose/outfit
  // pair rather than asking you to find it again by eye (owner, 2026-08-06).
  const [failedCombos, setFailedCombos] = useState([]);
  const [results, setResults] = useState([]);

  // Tiles currently mounted. Grows by RESULTS_PAGE on demand — nothing is discarded, it just is
  // not all in the DOM at once. Reset when the panel is emptied so a cleared tray starts fresh.
  const [shown, setShown] = useState(RESULTS_PAGE);
  useEffect(() => { if (results.length === 0) setShown(RESULTS_PAGE); }, [results.length]);
  // A result's favorite state is NOT stored on the result object and needs no dedicated set of its own:
  // a result is favorited iff its SOURCE pose is favorited, and pose favorites already live in
  // `favSets.pose` (poseStore.listFavorites(), loaded by loadAll on mount and re-read after every
  // toggle). The source pose id itself is resolved by resolveSourcePoseId (combo.poseId, falling back
  // to a videoPrompt text match for older/rehydrated results with no combo) — see resultSourcePoseIds
  // below, which memoizes that resolution once per render instead of per tile. Reading the exact same
  // `favorites` key the Pose tab's "★ Favorite" filter reads means the two can never disagree. (The old
  // eddy-result-<galleryId> name-based derivation is gone with the blank-item path.)
  // How many results render per row — the results grid's size control, mirroring the "Per row"
  // buttons EddyCollection uses on every Eddy tab (same 2–6 range, same look). Fewer per row =
  // bigger images. Persisted synchronously to localStorage exactly as EddyCollection's `cols` is
  // (its own key, since a square results tile is a different grid from the collection cards), so the
  // choice survives a reload with no first-paint flash. The grid columns are applied via inline
  // style because Tailwind cannot emit a dynamic `grid-cols-${n}`.
  // Setup-column width. Read synchronously from localStorage so the column never flashes at the
  // default width and then jump — same approach as resultCols below.
  const [setupWidth, setSetupWidth] = useState(() => {
    const v = parseInt(localStorage.getItem(SETUP_W_KEY) || '', 10);
    return Number.isFinite(v) && v >= SETUP_W_MIN && v <= SETUP_W_MAX ? v : 430;
  });
  useEffect(() => {
    try { localStorage.setItem(SETUP_W_KEY, String(setupWidth)); } catch { /* private mode */ }
  }, [setupWidth]);

  const [resultCols, setResultCols] = useState(() => {
    const v = parseInt(localStorage.getItem('eddy.results.cols') || '', 10);
    return Number.isFinite(v) && v >= 2 && v <= 6 ? v : 4;
  });
  useEffect(() => {
    try { localStorage.setItem('eddy.results.cols', String(resultCols)); } catch { /* private mode */ }
  }, [resultCols]);
  // Which results the action bar acts on, by `uid`. A Set of uids and NOT of array indices or
  // galleryIds: results are prepended as new batches land (so every index shifts) and a
  // regenerate replaces a result's galleryId in place. `uid` is assigned once at creation and
  // never changes, which is what keeps a selection made during batch A pointing at exactly the
  // same pictures after batch B's images arrive on top of them.
  const [selectedUids, setSelectedUids] = useState(() => new Set());
  // The one instruction every selected image regenerates with. Deliberately never cleared by an
  // action: fixing a bad hand takes two or three attempts, and retyping the note each time is the
  // annoyance this exists to remove.
  const [barInstruction, setBarInstruction] = useState('');
  // uid -> a short label of what is happening to that tile ('Regenerating' / 'Animating'). Its
  // presence is also what marks a tile busy, so there is one source of truth rather than a
  // separate boolean set that could disagree with the label.
  const [busyUids, setBusyUids] = useState(() => ({}));
  // uid -> message. A failure lands here instead of clearing the tile, so the image that was
  // already paid for stays on screen.
  const [tileErrors, setTileErrors] = useState(() => ({}));
  // The pending video confirmation: the resolved job list plus what it costs. Held in state (not
  // computed at render) so the jobs confirmed are exactly the jobs that were quoted, even if the
  // selection changes behind the dialog.
  const [videoConfirm, setVideoConfirm] = useState(null);
  // Once per batch, not once per combo: 25 identical toasts would bury the message.
  const warnedProvider = useRef(false);
  // Said once per batch, not once per image: on a run where the guard rejects everything, one
  // toast per fallback would bury the screen in identical warnings.
  const warnedFallback = useRef(false);
  // feedId -> the `uid` of the result it belongs to. Populated when a video job is submitted,
  // drained as each one resolves — lets the shared generation feed's own poll
  // (GenerationFeedPanel is mounted app-wide and already checks every pending video job every few
  // seconds) finish this page's per-image captions too, instead of running a second poller
  // against the same endpoint. Keyed by uid rather than galleryId because a regenerate replaces
  // the galleryId, which would orphan the caption update.
  const videoFeedMap = useRef(new Map());
  // Guards the persist effect from writing an empty queue over a good stored one BEFORE the
  // rehydrate read has finished: on mount `results` is [] and the persist effect would otherwise
  // fire and wipe IndexedDB before we ever loaded it. Flipped true once the rehydrate read
  // completes (with or without data), which is the only point after which `results` reflects
  // everything that should be stored.
  const hydratedRef = useRef(false);
  // False once this page has been navigated away from. Generation keeps running after that (the
  // request is never aborted and the image is still billed, saved to the gallery and filed into
  // Eddy's Library) — but setResults is a no-op on an unmounted component, so the finished TILE was
  // being dropped and you came back to "Nothing generated yet". generateCombo checks this and writes
  // the finished tile straight to the store instead.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  // Always points at the LATEST component-level generateCombo (assigned every render just below its
  // definition). The mount-time rehydrate effect runs long before that definition executes and must
  // NOT depend on generateCombo directly — generateCombo changes identity on every keystroke into
  // the instruction box, and depending on it would re-run the rehydrate (re-reading IndexedDB) on
  // each one. A ref lets a rehydrated tile's Regenerate call through to the current generateCombo at
  // CLICK time (always long after mount, when the ref is set) with neither a stale closure nor an
  // ordering bug. This is the "or a ref" stabilisation the fix calls for.
  /**
   * WHO IS IN THE PHOTO, worked out from the photo itself.
   *
   * The name was only ever captured at pick time, so it was empty for every session that started
   * with a photo already in the slot — a reload, an app restart, or a photo dropped in rather than
   * picked. That is why Eddy kept filing into the generic folder while Max Nano and Base looked
   * fine: those two have their own named roots and never needed the name at all.
   *
   * So instead of trusting a click that may never have happened, the picture is looked up. Both
   * collections keep a folder per character, and the slot holds the exact bytes that were stored,
   * so an identity match is exact — no guessing.
   *
   * The FACE wins over the base photo: a close-up is only ever of one person, while a base photo can
   * be reused. Runs only while the name is empty, so it never overrides a deliberate choice.
   */
  useEffect(() => {
    if (characterName) return undefined;
    if (!baseImage && !faceImage) return undefined;
    let alive = true;
    (async () => {
      for (const [store, img] of [[charStore, faceImage], [baseStore, baseImage]]) {
        if (!img) continue;
        try {
          const [folders, items] = await Promise.all([store.listFolders(), store.listItems()]);
          if (!folders.length) continue;
          for (const it of items) {
            if (!it.folderId) continue;
            // eslint-disable-next-line no-await-in-loop -- stops at the first hit; these collections
            // are a character's reference photos, not the thousands-of-rows Library.
            const src = await store.getImage(it.id);
            if (src && src === img) {
              const name = folders.find((f) => f.id === it.folderId)?.name || '';
              if (alive && name) setCharacterName(name);
              return;
            }
          }
        } catch { /* an unreadable collection just means no name — the banner says so */ }
      }
    })();
    return () => { alive = false; };
  }, [characterName, baseImage, faceImage, charStore, baseStore]);

  // Read inside generateCombo. A ref rather than a dep, so a Library write mid-batch cannot
  // rebuild the callback underneath a running run.
  const libItemsRef = useRef([]);
  const generateComboRef = useRef(null);
  // Points at the latest run(), for the resume-the-unfinished-queue effect. See its assignment
  // below run()'s definition for why it cannot be a plain dependency.
  const runRef = useRef(null);
  // A live mirror of `results`, kept in sync every render (below, next to generateComboRef.current).
  // The regenerate/edit branch of generateCombo needs the CURRENT image of the tile being regenerated
  // to send it back as image 1, but generateCombo is a useCallback that deliberately does NOT depend
  // on `results` (adding it would churn the callback's identity on every batch and re-bind every
  // tile's regenerate closure). Reading through this ref gets the up-to-date galleryId at CLICK time
  // with no stale closure — the same "or a ref" stabilisation generateComboRef uses.
  const resultsRef = useRef(results);
  // Same stabilisation as generateComboRef, for the CURRENT outfit/pose selection. A rehydrated
  // result that saved NO combo (older data) falls back to the page's live selection when regenerated,
  // and it must read that selection at CLICK time — not at mount, when both are still empty. Refs let
  // the fallback closure below reach the latest picked* without listing them as effect deps (which
  // would re-run the mount rehydrate on every pick and re-read IndexedDB).
  const pickedOutfitsRef = useRef([]);
  const pickedPosesRef = useRef([]);
  // Picking an outfit/pose tile mounts a new thumbnail-summary row directly ABOVE the still-open
  // picker grid (the "picked" preview block), pushing the grid — and everything below it — down
  // inside whichever element is actually scrolling. toggle() below captures+restores that
  // element's scrollTop across the click so the picker visually stays put instead of jumping.
  // Both refs are set because which one scrolls depends on breakpoint: the inner setup column
  // scrolls independently at lg+, the outer page scrolls as one document below it (see the
  // layout comment further down).
  const setupScrollRef = useRef(null);
  const pageScrollRef = useRef(null);

  // Re-read on every open, not just on mount. The page keeps a snapshot of the collections,
  // so an outfit added AFTER this page first loaded was invisible until a full reload.
  const loadAll = useCallback(async () => {
    // A character IS a folder in Eddy's Character tab; her images are its contents, oldest
    // first so the base image she was built from stays image 1.
    const [oItems, pItems, oFolders, pFolders, oFav, pFav] = await Promise.all([
      outfitStore.listItems(), poseStore.listItems(),
      outfitStore.listFolders(), poseStore.listFolders(),
      outfitStore.listFavorites(), poseStore.listFavorites(),
    ]);
    setOutfitFolders(oFolders);
    setPoseFolders(pFolders);
    // Favorites from each store's own tiny key, re-read here so a toggle (and a reload) is reflected
    // in the star fill, the count and the filter immediately.
    // `base` stays empty: the Library has no favourites list of its own, and slot.favIds is
    // dereferenced unconditionally below.
    setFavSets({ outfit: new Set(oFav), pose: new Set(pFav), base: new Set() });
    // An outfit is only usable if it has an image; a pose is usable with an image OR a prompt.
    setOutfits(oItems);
    setPoses(pItems);
    const oT = {}; const pT = {};
    await Promise.all([
      ...oItems.map(async (i) => { oT[i.id] = await outfitStore.getImage(i.id); }),
      // `i.url ||` so a URL-reference pose (e.g. a starred result saved as `eddy-result-<id>`, which
      // carries a gallery url and NO local bytes) still shows its picture in the picker, matching how
      // the Pose tab renders `thumbs[id] || it.url`. Normal image poses have no url and fall through
      // to getImage exactly as before.
      ...pItems.map(async (i) => { pT[i.id] = i.url || await poseStore.getImage(i.id); }),
    ]);
    setOutfitThumbs(oT);
    setPoseThumbs(pT);
    /**
     * Max Outfit's source collection.
     *
     * Loaded ONLY in that mode. The Library runs to thousands of rows and reading a thumbnail
     * for each costs a call — on Eddy and Max Nano, which never pick from it, that is pure
     * waste on every page open.
     *
     * `i.url ||` first: a Library row stores a gallery URL and no local bytes (see the addItems
     * call in run()), so getImage returns nothing for almost all of them.
     */
    if (maxOutfit) {
      try {
        const [lItems, lFolders] = await Promise.all([libraryStore.listItems(), libraryStore.listFolders()]);
        const lT = {};
        await Promise.all(lItems.map(async (i) => { lT[i.id] = i.url || await libraryStore.getImage(i.id); }));
        setLibItems(lItems);
        setLibItemFolders(lFolders);
        setLibThumbs(lT);
      } catch { /* an unreadable Library leaves the picker empty rather than breaking the page */ }
    }
    setLoading(false);
  }, [outfitStore, poseStore, libraryStore, maxOutfit]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ONE-TIME CLEANUP of the blank duplicates the PREVIOUS version created. That version, on every
  // result-favorite, added a new pose item named `eddy-result-<galleryId>` with an empty prompt / video
  // prompt / title and no real image bytes (just a gallery url) — clutter in the user's Pose library.
  // These rows are the APP's OWN auto-created artifacts, never something the user authored, so deleting
  // them is safe: an eddy-result-* name is a signature only this code writes. We remove every such row
  // from the REUSED poseStore instance (a second handle would own a separate write queue and clobber
  // this one; see eddyCollectionStore) and log how many went. `once` guards React 18 StrictMode's
  // double-invoke so we don't fire two overlapping delete passes. A read failure leaves the poses
  // untouched rather than throwing on mount. Runs after loadAll so the picker reflects the removals.
  const cleanupRanRef = useRef(false);
  useEffect(() => {
    if (cleanupRanRef.current) return;
    cleanupRanRef.current = true;
    (async () => {
      let items;
      try {
        items = await poseStore.listItems();
      } catch {
        return; // transient read failure — leave the poses alone, try again next mount
      }
      const orphans = items.filter((it) => typeof it.name === 'string' && it.name.startsWith(RESULT_POSE_PREFIX));
      if (!orphans.length) return;
      for (const it of orphans) {
        try { await poseStore.removeItem(it.id); } catch { /* skip the one that failed, keep going */ }
      }
      console.info(`[Eddy] Removed ${orphans.length} leftover blank ${RESULT_POSE_PREFIX}* pose item(s) from a previous version.`);
      await loadAll(); // refresh the pose picker / favorites now that the blanks are gone
    })();
  }, [poseStore, loadAll]);

  // Reset the tally once everything has drained, from an effect rather than from inside a
  // state updater — updaters must be pure, and React replays them.
  useEffect(() => {
    if (inFlight === 0) { setDone(0); setQueued(0); }
  }, [inFlight]);

  // A reload aborts the in-flight request, and it is the browser that files the result into
  // the Library. The picture is still saved server side, but the tab has to be told.
  useEffect(() => {
    if (!inFlight) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [inFlight]);

  // Restore the last selection once on mount. Only fills fields still at their defaults, so a
  // slow read can't overwrite something typed while it was in flight.
  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = await stateStore.get('state', null);
      if (!alive || !saved) return;
      setBaseImage((v) => v || saved.baseImage || '');
      setFaceImage((v) => v || saved.faceImage || '');
      setCharacterName((v) => v || saved.characterName || '');
      setPickedOutfits((v) => (v.length ? v : saved.pickedOutfits || []));
      setPickedPoses((v) => (v.length ? v : saved.pickedPoses || []));
      setPickedBases((v) => (v.length ? v : saved.pickedBases || []));
      setOutfitRotation((v) => (v === true && typeof saved.outfitRotation === 'boolean' ? saved.outfitRotation : v));
      setSmartMatch((v) => (v === true && typeof saved.smartMatch === 'boolean' ? saved.smartMatch : v));
      setInstruction((v) => (v ? v : saved.instruction || ''));
      setNsfw((v) => v || !!saved.nsfw);
      // Default is ON, so unlike nsfw the saved value must be able to turn it OFF. Only applied while
      // still at the default (v === true), so a slow read can't clobber a toggle the user flipped
      // to OFF while it was in flight. A store predating this feature has no key → v is kept (ON).
      setStaticCamera((v) => (v === true && typeof saved.staticCamera === 'boolean' ? saved.staticCamera : v));
      setAspectRatio((v) => (v !== 'auto' ? v : saved.aspectRatio || 'auto'));
      setResolution((v) => (v !== '1K' ? v : saved.resolution || '1K'));
      setFaceless((v) => v || !!saved.faceless);
      setLighting((v) => (v !== 'auto' ? v : saved.lighting || 'auto'));

      /**
       * These four were WRITTEN to the snapshot and never read back.
       *
       * Within one session they survived anyway — `_cache` is module-level and switching workspace
       * tabs does not remount the page — so the miss only showed as "it is still on over here"
       * (owner, 2026-08-09, on the Max tab). Across a real reload it was worse and quieter: Her
       * build silently reverted to "From photo", which changes the prompt on every generation with
       * nothing on screen saying so.
       *
       * Same guarded shape as staticCamera above: apply the saved value only while the state is
       * still at its default, so a slow read cannot clobber something toggled while it was in
       * flight, and a store predating a key leaves that default alone.
       */
      setSendPoseImage((v) => (v === true && typeof saved.sendPoseImage === 'boolean' ? saved.sendPoseImage : v));
      setSendOutfitImage((v) => (v === true && typeof saved.sendOutfitImage === 'boolean' ? saved.sendOutfitImage : v));
      setBuild((v) => (v === 'auto' ? saved.build || 'auto' : v));
      setEngine((v) => (v === 'nano2' ? saved.engine || 'nano2' : v));
    })();
    return () => { alive = false; };
  }, []);

  // Saved models, read once on mount. Kept in its own store so a corrupt page-state read can never
  // take the model list with it.
  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await modelsStore.get('models', []);
      const active = await modelsStore.get('active', '');
      if (!alive) return;
      if (Array.isArray(list)) setModels(list);
      if (typeof active === 'string') setActiveModel(active);
    })();
    return () => { alive = false; };
  }, []);

  /**
   * Load a saved model into the page: both photos AND its build.
   *
   * The build travels with the model deliberately — that pairing is the reason this exists. Loading
   * Sienna while Grace's "Very large" stayed selected is precisely the silent mistake a name-less
   * page made unavoidable.
   */
  const loadModel = useCallback((name) => {
    const m = models.find((x) => x.name === name);
    if (!m) return;
    setBaseImage(m.baseImage || '');
    setFaceImage(m.faceImage || '');
    // A saved model IS a character, so loading one names her too -- otherwise picking Grace from
    // the model row filed her results in the generic folder while picking her face did not.
    setCharacterName(m.name || '');
    setBuild(m.build || 'auto');
    setActiveModel(name);
    modelsStore.set('active', name);
    notify(`Loaded ${name}`, 'success');
  }, [models, notify]);

  /**
   * Save the current photos + build under a name, replacing that name if it already exists.
   *
   * Overwrite is by NAME rather than appending, so re-saving after swapping a face close-up updates
   * the model instead of leaving two entries called "Sienna" and no way to tell which is current.
   */
  const saveModel = useCallback(async () => {
    const name = (window.prompt('Save these photos and build as a model:', activeModel || '') || '').trim();
    if (!name) return;
    if (maxOutfit && !pickedBases.length) { notify('Pick the photos to dress first', 'error'); return; }
    // Second gate. The button being disabled is a UI state, not a guarantee — Retry failed and
    // any other caller reach run() directly.
    if (missingOutfitKinds.length) {
      notify(`No ${missingOutfitKinds.map((k) => k.label).join(' or ')} outfit picked — those photos would get the wrong kind of garment`, 'error');
      return;
    }
    // Max Outfit has no single main photo: every combo carries its own Library picture.
    if (!maxOutfit && !baseImage) { notify('Add the main photo first', 'error'); return; }
    const entry = { name, baseImage, faceImage, build };
    const next = [...models.filter((m) => m.name !== name), entry].sort((a, b) => a.name.localeCompare(b.name));
    setModels(next);
    setActiveModel(name);
    const ok = await modelsStore.set('models', next);
    await modelsStore.set('active', name);
    // A quota refusal must not look like a save: these are two full photos and the store CAN fill.
    notify(ok ? `Saved ${name}` : `Could not save ${name} — storage is full`, ok ? 'success' : 'error');
  }, [activeModel, baseImage, faceImage, build, models, notify]);

  const deleteModel = useCallback(async () => {
    if (!activeModel) return;
    if (!window.confirm(`Delete the saved model "${activeModel}"? The photos stay in your Library.`)) return;
    const next = models.filter((m) => m.name !== activeModel);
    setModels(next);
    setActiveModel('');
    await modelsStore.set('models', next);
    await modelsStore.set('active', '');
    notify(`Deleted ${activeModel}`, 'success');
  }, [activeModel, models, notify]);

  useEffect(() => {
    const snap = { baseImage, faceImage, characterName, pickedOutfits, pickedPoses, pickedBases, outfitRotation, smartMatch, instruction, nsfw, aspectRatio, resolution, staticCamera, faceless, lighting, sendPoseImage, sendOutfitImage, build, engine };
    Object.assign(_cache, snap);
    stateStore.set('state', snap);
  // pickedBases / outfitRotation / smartMatch are IN the snapshot above, so they have to be in
  // these deps too. Without them this effect never re-ran when only a Max Outfit control changed,
  // and the whole selection was gone on the next app start — the snapshot is only written from
  // here.
  }, [baseImage, faceImage, characterName, pickedOutfits, pickedPoses, pickedBases, outfitRotation, smartMatch, instruction, nsfw, aspectRatio, resolution, staticCamera, faceless, lighting, sendPoseImage, sendOutfitImage, build, engine]);

  /**
   * Submits ONE video job and returns as soon as Muapi accepts it (a taskId) — the render finishes
   * asynchronously in the shared feed's own poll (see subscribeFeed below). Hoisted to page level,
   * out of run(), for one reason: a rehydrated tile has no run() closure to carry, and video is the
   * one action that CAN be safely reconstructed after a reload — it needs only the saved gallery
   * image (galleryId), the pose's videoPrompt and a target ratio, none of which are run-scoped.
   * Both a fresh tile (closure passes the batch's own videoRatio) and a rehydrated one (passes the
   * ratio its image was made at, recovered from the persisted aspectRatio) call THIS same body, so
   * there is exactly one video-submit implementation and no second one to drift.
   *
   * Declared ABOVE the rehydrate effect on purpose: that effect lists it as a dependency, and a
   * const referenced in a dep array before its own declaration is a temporal-dead-zone crash.
   *
   * `videoRatio` is a parameter, not read from live controls: a clip animated hours later must use
   * the ratio ITS image was made at, not whatever the aspect selector happens to say now.
   *
   * Stable ([] deps): it touches only setState/refs (stable) and module/import-level constants, so
   * every result can hold `(job) => submitVideoJob(job, ratio)` without the identity churning.
   */
  const submitVideoJob = useCallback(async (job, videoRatio) => {
    // The clamped length, from the same helper the confirmation quoted with — so what is dispatched
    // (and billed) is exactly the number the user was shown, in both directions.
    //
    // CRITICAL: parse the duration off the ORIGINAL job.videoPrompt, BEFORE the camera-lock line is
    // appended below. The lock text only ever rides in the `prompt` sent to Muapi; the billed seconds
    // are decided here, from the pose's own prompt, and cannot be shifted by the appended instruction.
    // Remove music/audio/sound cues before anything else. Seedance renders silent video, so this
    // changes nothing about the length (Duration lines are preserved) — it only stops music text
    // driving music-video motion. Duration is parsed off the CLEANED prompt, which is identical to the
    // original for billing since no "Duration:"/"<N> seconds" text is ever an audio cue.
    const cleanVideoPrompt = stripAudioCues(job.videoPrompt);
    const { seconds: duration } = clipDurationFor(cleanVideoPrompt);
    // FEATURE 1: append the fixed camera-lock line when the toggle is ON (read live from the ref so
    // this callback stays identity-stable). Nothing about cost/model/duration changes — only the
    // prompt text the render is driven by. When OFF, the prompt is the cleaned prompt as-is.
    // NO_AUDIO goes on unconditionally and LAST — the model invents a soundtrack unless it is told
    // not to, and the ban has to be the final line to hold.
    const dispatchPrompt = `${staticCameraRef.current ? `${cleanVideoPrompt}${CAMERA_LOCK_INSTRUCTION}` : cleanVideoPrompt}${NO_AUDIO_INSTRUCTION}`;
    const feedId = `eddy-video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pushPending({
      id: feedId,
      // The feed card shows what was actually SENT, so the camera line isn't a hidden mutation.
      prompt: dispatchPrompt,
      // Derived from VIDEO_MODEL_ID, never hand-written: a literal here once read "VIP" while Fast
      // was being billed.
      imageModel: VIDEO_MODEL_LABEL,
      aspectRatio: videoRatio,
      resolutionTier: `${duration}s`,
      isVideo: true,
    });
    videoFeedMap.current.set(feedId, job.uid);

    let res;
    try {
      res = await videoApi.generate({
        model: VIDEO_MODEL_ID,
        duration,
        prompt: dispatchPrompt.slice(0, 2500), // same cap the server applies before Muapi
        aspectRatio: videoRatio,
        galleryId: job.galleryId,
      });
    } catch (err) {
      // The image this video was for is already generated, billed and saved — only the animation
      // step failed, so only its own feed card (and this tile's caption) says so.
      failPending(feedId, err?.message || 'Video failed to start');
      videoFeedMap.current.delete(feedId);
      setResults((prev) => prev.map((r) => (r.uid === job.uid ? { ...r, videoStatus: 'error', videoError: err?.message || 'Failed to start' } : r)));
      return { ok: false };
    }
    if (res.status === 'failed') {
      failPending(feedId, 'Muapi returned an error starting the video');
      videoFeedMap.current.delete(feedId);
      setResults((prev) => prev.map((r) => (r.uid === job.uid ? { ...r, videoStatus: 'error', videoError: 'Muapi returned an error' } : r)));
      return { ok: false };
    }
    // Hand the feed the taskId so it finishes this card itself even if the page is navigated away
    // from before the render completes — same handoff SeedanceVideoPage.jsx uses.
    attachTaskId(feedId, res.taskId);
    // Persist the taskId ON the tile, not only in the in-memory videoFeedMap. That map is a useRef
    // and is EMPTY after any reload, so a tile still pending at reload can no longer be matched to
    // its feed event by the subscribeFeed mirror below — the reconcile effect further down re-derives
    // completion straight from this taskId via a STATUS poll (no charge), which is what unsticks the
    // "Animating…" freeze after a reload or a tab close+reopen.
    setResults((prev) => prev.map((r) => (r.uid === job.uid ? { ...r, videoStatus: 'pending', videoTaskId: res.taskId, videoError: undefined } : r)));
    return { ok: true };
  }, []);

  // REHYDRATE the results queue once on mount, so the panel is populated after a reload instead of
  // going blank (the bug this whole feature fixes: the images WERE saved, but the in-memory
  // `results` cleared and it looked like they were lost). Tiles render from galleryId exactly as
  // fresh ones do. Regenerate IS reconstructed now, from the persisted `combo` ({outfitId, poseId})
  // — the only run input a fresh result's regenerate closure actually needs — rebound to the same
  // component-level generateCombo the fresh path uses (via generateComboRef, always the latest).
  // Animate is likewise reconstructed, binding the shared submitVideoJob to the ratio the image was
  // made at. Regenerate ALWAYS works now: a pre-`combo` stored result (older data) falls back to a
  // combo built from the page's current outfit/pose selection instead of a dead button.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const saved = await resultsStore.get('queue', []);
        if (!alive || !Array.isArray(saved) || !saved.length) return;
        setResults((prev) => {
          // Never clobber results that already landed this session (a fast batch could finish
          // before this async read returns); append the restored ones behind them, skipping any
          // uid already present. A stored entry with no galleryId can't render or animate, so drop it.
          const have = new Set(prev.map((r) => r.uid));
          const restored = saved
            .filter((s) => s && s.galleryId && !have.has(s.uid))
            .map((s) => ({
              ...s,
              rehydrated: true,
              // Regenerate rebuilt from the persisted combo, going through the EXACT same
              // generateCombo the fresh path uses (via the ref, so it is never stale). This is the
              // identical closure shape a fresh result gets — `(tweak) => generateCombo(combo, {
              // tweak, replaceUid: uid })` — so canRegenerate is true and the button works after a
              // reload. Called with no runCtx, so generateCombo derives ratio/cost/char refs/folder
              // from the CURRENT page state.
              //
              // BEHAVIOUR (honest, not a bug): a rehydrated regenerate re-runs generateCombo with
              // the stored outfit/pose combo but the CURRENT character, face, aspect ratio and
              // resolution — that is simply how generateCombo reads them when no batch snapshot is
              // handed in. If the user changed their character or settings since this image was made,
              // the regenerate uses the new ones. That is expected ("regenerate uses your current
              // setup"), and it still spends the same one-image price and follows the same path.
              //
              // Results saved BEFORE `combo` was persisted have s.combo === undefined. Those used to
              // get `regenerate: null`, which made both the per-tile and bulk Regenerate a SILENT
              // no-op (regenerateUids filters on `r.regenerate` and early-returns) while the button
              // still looked enabled — the bug this fixes. Now every rehydrated result gets a working
              // closure: with a stored combo we use it; WITHOUT one we fall back to a combo built from
              // the page's CURRENT selection ({ outfitId: pickedOutfits[0], poseId: pickedPoses[0] }),
              // read via refs at CLICK time so it reflects whatever the user has picked now. Either way
              // it routes through the SAME generateCombo — character + outfit/pose + instruction, one
              // billed image, regenCost shown, char-refs-first, and the character-required guard inside
              // generateCombo still throws if no character is selected (the fallback cannot bypass it).
              // An older result regenerating with the current outfit/pose is expected, not a bug: the
              // original combo simply was not saved.
              regenerate: s.combo
                ? (tweak) => generateComboRef.current(s.combo, { tweak, replaceUid: s.uid })
                : (tweak) => generateComboRef.current(
                    { outfitId: pickedOutfitsRef.current[0] ?? null, poseId: pickedPosesRef.current[0] ?? null },
                    { tweak, replaceUid: s.uid },
                  ),
              // Animate rebuilt from persisted fields alone: galleryId is the saved image, the ratio
              // comes from the persisted aspectRatio (toVideoAspectRatio handles a missing/odd one).
              submitVideo: (job) => submitVideoJob(job, toVideoAspectRatio(s.aspectRatio || 'auto')),
            }));
          return restored.length ? [...prev, ...restored] : prev;
        });
      } finally {
        // Set in ALL paths (data, no data, or read failure) so the persist effect is never blocked
        // forever — otherwise a first-ever visit with an empty store would never persist anything.
        if (alive) hydratedRef.current = true;
      }
    })();
    return () => { alive = false; };
  }, [submitVideoJob]);

  // PERSIST the queue on every change (debounced), the single source of truth for what is stored —
  // Remove, a completed-video removal and a new batch all flow through `results`, so mirroring
  // `results` here means every one of them updates IndexedDB without its own write call.
  useEffect(() => {
    // Blocked until the rehydrate read has run, so mount's initial [] can't erase the stored queue.
    if (!hydratedRef.current) return undefined;
    const t = setTimeout(() => {
      // Everything is persisted — see RESULTS_CAP. Rows carry no image bytes, so this stays small.
      resultsStore.set('queue', results.map(liteResult));
    }, 400);
    return () => clearTimeout(t);
  }, [results]);

  // Re-reading when the window regains focus covers adding an outfit in another tab/window.
  useEffect(() => {
    const onFocus = () => { loadAll(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadAll]);

  // Mirrors a video job's outcome from the shared feed onto its result card here. The feed
  // itself (GenerationFeedPanel, mounted for the whole app) is what actually polls Muapi for
  // completion — this just watches for the entries this page is waiting on and updates their
  // caption once the feed marks them done or failed, so nothing here opens a second poller
  // against the same status endpoint.
  useEffect(() => subscribeFeed((items) => {
    if (!videoFeedMap.current.size) return;
    for (const item of items) {
      const uid = videoFeedMap.current.get(item.id);
      if (!uid) continue;
      if (item.status === 'done') {
        // The clip finished. CHANGED DELIBERATELY per user request: the tile now STAYS in the grid
        // and becomes a PLAYABLE video (done-render path shows an inline <video>), rather than being
        // removed the instant its render completed — users want to click and watch the finished clip
        // right here. A result therefore leaves this working queue at exactly ONE moment now: the
        // user presses Remove. We mirror the feed's resolved videoUrl onto the tile; the feed item's
        // videoUrl is videoApi.fileUrl(localFilename) — the same URL the clean-download route is
        // parsed back out of (localClipFilename). The persist effect writes videoStatus+videoUrl to
        // IndexedDB, so a reload rehydrates the playable clip. (error, below: image paid for but no
        // clip, so it stays for a retry.)
        const url = item.videoUrl || '';
        setResults((prev) => prev.map((r) => (r.uid === uid ? { ...r, videoStatus: 'done', videoUrl: url, videoError: undefined } : r)));
        videoFeedMap.current.delete(item.id);
      } else if (item.status === 'error') {
        setResults((prev) => prev.map((r) => (r.uid === uid ? { ...r, videoStatus: 'error', videoError: item.error } : r)));
        videoFeedMap.current.delete(item.id);
      }
    }
  }), []);

  // THE FALLBACK THAT UNSTICKS "Animating…". Root cause of the freeze: videoFeedMap is a useRef,
  // so after ANY reload (or a tab close+reopen) it is empty — a tile that was still pending at that
  // moment has no feedId→uid entry, so the subscribeFeed mirror above can never match its completion
  // and the tile spins forever. This effect closes that gap without a second live poller for
  // in-session jobs: it only touches pending tiles the feed map is NOT already tracking (i.e.
  // rehydrated ones), asks the video STATUS endpoint by the taskId persisted with the tile — a
  // read-only status check, NO generation and NO charge — and flips the tile to done+videoUrl or
  // error. It covers both reload (feed's sessionStorage may still have the job) and tab-close (feed
  // record gone, but IndexedDB kept the tile + its taskId), because it depends on neither the feed
  // nor the map. Keyed by uid:taskId so the effect only re-runs when the SET of untracked pending
  // tiles changes, not on every persist write.
  const untrackedPendingKey = useMemo(() => {
    const tracked = new Set(videoFeedMap.current.values());
    return results
      .filter((r) => r.videoStatus === 'pending' && r.videoTaskId && !tracked.has(r.uid))
      .map((r) => `${r.uid}:${r.videoTaskId}`)
      .join('|');
  }, [results]);
  useEffect(() => {
    if (!untrackedPendingKey) return undefined;
    let alive = true;
    const tasks = untrackedPendingKey.split('|').map((k) => {
      const i = k.indexOf(':');
      return { uid: k.slice(0, i), taskId: k.slice(i + 1) };
    });
    const reconcile = async () => {
      for (const { uid, taskId } of tasks) {
        try {
          const data = await videoApi.status(taskId);
          if (!alive) return;
          if (data.status === 'completed') {
            const url = data.localFilename
              ? videoApi.fileUrl(data.localFilename)
              : (data.outputs?.[0] || data.videoUrl || '');
            if (url) setResults((prev) => prev.map((r) => (r.uid === uid ? { ...r, videoStatus: 'done', videoUrl: url, videoError: undefined } : r)));
          } else if (data.status === 'failed') {
            // Named, never silent: a failed render becomes a visible error caption, not a spinner
            // that quietly never ends.
            setResults((prev) => prev.map((r) => (r.uid === uid ? { ...r, videoStatus: 'error', videoError: data.error || 'Video failed' } : r)));
          }
        } catch { /* transient/network — leave the tile pending and retry next tick */ }
      }
    };
    reconcile();
    const iv = setInterval(reconcile, 8000);
    return () => { alive = false; clearInterval(iv); };
  }, [untrackedPendingKey]);


  // No outfit or no pose still counts as one run — the cross product just collapses to 1.
  /**
   * WHICH KINDS OF OUTFIT THIS SELECTION IS MISSING.
   *
   * A close-up shot needs a close-up outfit; a back shot needs a back one. With none selected the
   * matcher used to quietly borrow from the rest of the selection, so a close-up got a full-body
   * garment and nothing said so — you only found out by looking at the finished images.
   *
   * This turns that into a hard stop: the kinds are named, the photo counts are shown, and Generate
   * is disabled until you tick one. Better to be told now than to pay for 40 wrong swaps.
   *
   * Only in Max Outfit, only with smart pairing ON, and only once you have picked some outfits —
   * before that there is nothing to warn about yet.
   */
  const missingOutfitKinds = useMemo(() => {
    if (!maxOutfit || !smartMatch || !pickedBases.length || !pickedOutfits.length) return [];
    const byId = new Map(libItems.map((i) => [i.id, i]));
    const outfitFolderName = (id) => outfitFolders.find((f) => f.id === outfits.find((o) => o.id === id)?.folderId)?.name || '';
    const covered = new Set(pickedOutfits.map((o) => outfitView(outfitFolderName(o))));
    const need = new Map();
    for (const b of pickedBases) {
      const v = libraryRowView(byId.get(b));
      if (!covered.has(v)) need.set(v, (need.get(v) || 0) + 1);
    }
    const LABEL = { closeup: 'close-up', back: 'back', front: 'front' };
    return [...need.entries()].map(([view, count]) => ({ view, count, label: LABEL[view] || view }));
  }, [maxOutfit, smartMatch, pickedBases, pickedOutfits, libItems, outfits, outfitFolders]);

  /**
   * ON THE EDDY TAB: which of the combos you are about to make pair a mismatched kind.
   *
   * Eddy is a CROSS PRODUCT — every outfit you tick is applied to every pose you tick, on purpose.
   * So a mismatch is not a dead end the way it is in Max Outfit; you may have picked one close-up
   * outfit alongside five poses and only want the close-up one. Blocking would stop a run that is
   * two-thirds legitimate.
   *
   * It is still worth saying out loud. A close-up garment on a full-body pose is a wasted image you
   * would only notice by opening it, and at 12 lanes a bad cross product is 40 of them.
   *
   * Angle awareness on the PROMPT side already exists here and is untouched: a back pose has always
   * used the outfit's back description (backPrompt) rather than its front one.
   */
  const eddyMismatches = useMemo(() => {
    if (maxOutfit || maxNano || !pickedOutfits.length || !pickedPoses.length) return null;
    const outfitFolderName = (id) => outfitFolders.find((f) => f.id === outfits.find((o) => o.id === id)?.folderId)?.name || '';
    const poseById = new Map(poses.map((x) => [x.id, x]));
    let bad = 0;
    const kinds = new Set();
    for (const o of pickedOutfits) {
      const ov = outfitView(outfitFolderName(o));
      for (const pid of pickedPoses) {
        const pv = readPoseView(poseById.get(pid)?.prompt);
        // front vs back is handled by backPrompt and is NOT a mismatch. Close-up is: a close-up
        // garment reference has no lower half to give a full-body shot, and vice versa.
        if ((ov === 'closeup') !== (pv === 'closeup')) { bad += 1; kinds.add(ov === 'closeup' ? 'closeup-outfit' : 'closeup-pose'); }
      }
    }
    return bad ? { bad, total: pickedOutfits.length * pickedPoses.length, kinds: [...kinds] } : null;
  }, [maxOutfit, maxNano, pickedOutfits, pickedPoses, outfits, outfitFolders, poses]);

  const combos = useMemo(() => {
    // Max Nano never sends an outfit — a stale selection from an Eddy session would otherwise
    // multiply the run and dress her in something this page does not even show.
    const os = (!maxNano && pickedOutfits.length) ? pickedOutfits : [null];
    const ps = (!maxOutfit && pickedPoses.length) ? pickedPoses : [null];
    if (maxOutfit) {
      // One row per SOURCE image. Cross-product multiplies instead — the expensive branch, opt-in.
      const bases = pickedBases.length ? pickedBases : [];
      if (!outfitRotation) return bases.flatMap((b) => os.map((o) => ({ outfitId: o, poseId: null, baseId: b })));
      const chosen = pickedOutfits.length ? pickedOutfits : [];
      if (smartMatch && chosen.length) {
        // Angle-aware, pairs of two, least-used pools -- the algorithm ported from
        // cloth_swap_paired.py. See matchOutfits for the rules and where they came from.
        const byId = new Map(libItems.map((i) => [i.id, i]));
        const outfitFolderName = (id) => outfitFolders.find((f) => f.id === outfits.find((o) => o.id === id)?.folderId)?.name || '';
        const { rows } = matchOutfits(
          bases, chosen,
          (b) => libraryRowView(byId.get(b)),
          (o) => outfitView(outfitFolderName(o)),
        );
        return rows.map((r) => ({ outfitId: r.outfitId, poseId: null, baseId: r.baseId, matched: r.matched }));
      }
      // Plain rotation: round-robin across the whole selection, no angle awareness.
      return bases.map((b, i) => ({ outfitId: os[i % os.length], poseId: null, baseId: b }));
    }
    /**
     * SKIP the pairs that cannot work rather than generating them.
     *
     * Eddy is a cross product, so "select all poses, select all outfits" paired every close-up
     * outfit with every full-body pose and the reverse -- images that are wrong before they start,
     * at full price. Close-up outfits now generate only for close-up poses, and front/back outfits
     * only for front/back poses.
     *
     * FRONT vs BACK is deliberately NOT filtered. A back pose already swaps in the outfit's
     * back-view description (backPrompt), so that pairing works, and filtering it would delete
     * legitimate combinations.
     *
     * If the filter would leave NOTHING, the unfiltered product is returned instead. A Generate
     * button silently reading 0 images is worse than a banner you can read, and the banner above
     * already names what is mismatched.
     */
    const outfitFolderName = (id) => outfitFolders.find((f) => f.id === outfits.find((o) => o.id === id)?.folderId)?.name || '';
    const poseById = new Map(poses.map((x) => [x.id, x]));
    const all = os.flatMap((o) => ps.map((p) => ({ outfitId: o, poseId: p })));
    if (!pickedOutfits.length || !pickedPoses.length) return all;
    const compatible = all.filter((c) => (
      (outfitView(outfitFolderName(c.outfitId)) === 'closeup')
      === (readPoseView(poseById.get(c.poseId)?.prompt) === 'closeup')
    ));
    return compatible.length ? compatible : all;
  }, [pickedOutfits, pickedPoses, pickedBases, outfitRotation, smartMatch, libItems, outfits, outfitFolders, poses, maxNano, maxOutfit]);

  /**
   * THE BREAKDOWN: how many of the images about to be made are front, back and close-up.
   *
   * The button says "Generate 92 images". That total hides the thing that actually matters once
   * pairings started being skipped -- whether the close-ups are in there at all. A run that quietly
   * dropped every close-up looks identical to one that kept them, right up until you open the
   * results.
   *
   * Counted off the COMBOS, not the selection, so it reflects what will really run: skipped
   * pairings are already gone by this point.
   *
   * The view comes from whichever side carries it in this mode -- the pose card on Eddy and Max
   * Nano, the source photo on Max Outfit.
   */
  const viewBreakdown = useMemo(() => {
    if (!combos.length) return null;
    const poseById = new Map(poses.map((x) => [x.id, x]));
    const libById = new Map(libItems.map((i) => [i.id, i]));
    const counts = { front: 0, back: 0, closeup: 0 };
    for (const c of combos) {
      const v = c.baseId ? libraryRowView(libById.get(c.baseId))
        : (c.poseId ? readPoseView(poseById.get(c.poseId)?.prompt) : 'front');
      counts[v] = (counts[v] || 0) + 1;
    }
    // Nothing to say when it is all one kind -- the total already said it.
    return Object.values(counts).filter(Boolean).length > 1 ? counts : null;
  }, [combos, poses, libItems]);

  const sourceImages = [baseImage, faceImage].filter(Boolean);
  const perRunImages = sourceImages.length + (pickedPoses.length ? 1 : 0);
  const overCap = perRunImages > SEEDREAM_MAX_IMAGES;
  // Priced per ENGINE. Showing Seedream's rate while Nano Banana 2 runs would misstate the bill on
  // the one control where spend is agreed.
  const perImagePrice = engine === 'nano2'
    ? (NANO2_COST[resolution] ?? NANO2_COST['1K'])
    : seedreamCost(resolution, Math.max(1, perRunImages));
  const totalCost = combos.length * perImagePrice;

  // Shows the real assembled prompt for the first combo, so what lands at Seedream is never a
  // mystery. Built with the same buildPrompt the run loop uses -- a separate "preview" version
  // would drift out of sync with what is actually sent.
  // The toggle is the switch: NSFW on means she is undressed. The Topless chip narrows that to
  // topless; with no chip at all it is full nudity.
  const undressChip = UNDRESS_TEXTS.some((t) => instruction.includes(t));
  const wantsNude = nsfw || undressChip;
  const wantsBody = BODY_CHANGE_TEXTS.some((t) => instruction.includes(t));
  const wantsExpression = EXPRESSION_TEXTS.some((t) => instruction.includes(t));

  const previewPrompt = useMemo(() => {
    const first = combos[0];
    if (!first) return '';
    const o = outfits.find((x) => x.id === first.outfitId);
    const ps = poses.find((x) => x.id === first.poseId);
    // Mirrors generateCombo's slot order exactly (main, pose, face, outfit) so the FINAL PROMPT panel
    // shows the real image numbers. An item only takes a slot when it has a stored image.
    let n = baseImage ? 1 : 0;
    const poseIndex = sendPoseImage && ps && poseThumbs[ps.id] ? (n += 1) : 0;
    const faceIndex = faceImage ? (n += 1) : 0;
    const outfitIndex = sendOutfitImage && o && outfitThumbs[o.id] && !wantsNude ? (n += 1) : 0;
    const previewPoseView = readPoseView(ps?.prompt);
    const previewBackText = previewPoseView === 'back' ? o?.backPrompt?.trim() : '';
    return buildPrompt({
      instruction,
      outfitText: previewBackText || o?.prompt?.trim() || '',
      poseText: stripPoseLighting(ps?.prompt || ''),
      outfitIndex,
      poseIndex,
      faceIndex,
      nsfw,
      wantsNude,
      wantsBody,
      poseView: previewPoseView,
      buildText: wantsBody ? '' : buildTextFor(build, previewPoseView),
      // Suppressed when an Expression chip is active (the chip is the explicit choice) or when
      // FACELESS is on for this pose — there is no face in frame to give an expression to.
      expressionText: (wantsExpression || (faceless || POSE_FACELESS_RE.test(String(ps?.prompt || '')))) ? '' : readPoseExpression(ps?.prompt),
      undressChip,
      poseFaceless: !!poseIndex && (faceless || POSE_FACELESS_RE.test(String(ps?.prompt || ''))),
      lightingText: lightingTextFor(lighting),
      // The preview is only worth having if it is the SAME prompt. Omitting this here would show
      // an Eddy-shaped prompt on a page that sends a Max Nano one.
      lockOutfitToBase: maxNano,
    });
  }, [combos, outfits, poses, instruction, baseImage, faceImage, outfitThumbs, poseThumbs, nsfw, wantsNude, wantsBody, undressChip, faceless, lighting, sendPoseImage, sendOutfitImage, build, wantsExpression, maxNano]);

  const addChip = (text) => setInstruction((prev) => (prev.includes(text) ? prev : `${prev} ${text}`.trim()));

  // Run a picker state change without the page jumping. Capture BEFORE the state update, restore
  // on the next frame (after React has re-rendered the new summary row and the browser would
  // otherwise have scrolled) — see the setupScrollRef/pageScrollRef comment above for why both
  // are captured. Shared by every pick action, so a new one cannot forget it and reintroduce the
  // jump: picking the 40th tile in a long grid used to throw you back to the top of the page.
  const keepScroll = (fn) => {
    const setupEl = setupScrollRef.current;
    const pageEl = pageScrollRef.current;
    const setupTop = setupEl ? setupEl.scrollTop : null;
    const pageTop = pageEl ? pageEl.scrollTop : null;
    fn();
    requestAnimationFrame(() => {
      if (setupEl && setupTop !== null) setupEl.scrollTop = setupTop;
      if (pageEl && pageTop !== null) pageEl.scrollTop = pageTop;
    });
  };

  const toggle = (setter) => (id) => keepScroll(() => {
    setter((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  });

  // Star / un-star a collection item from inside the picker. The favorite is stored in the same
  // store the collection tab uses, under its small `favorites` key (store.toggleFavorite) — NOT as a
  // field on the big index — so a pose starred here shows starred in Eddy · Pose and vice versa, and
  // the write is a tiny one the index's size can never clobber. It PERSISTS, so it survives a reload
  // and the "★ Favorite" (favFilter) filter then lists this pose. loadAll re-reads the favorites key
  // so the star fills and the "★ Favorite (N)" count updates immediately, and a toast confirms the
  // click landed. A failed/quota-refused write throws and is surfaced; we do NOT refresh or claim
  // success, so the star can never look flipped for a favorite that did not persist.
  const togglePickFavorite = async (store, id) => {
    if (!id) return;
    let nowFav;
    try {
      nowFav = await store.toggleFavorite(id);
    } catch (err) {
      notify(err.message || 'Could not update favorite', 'error');
      return; // write failed — do not refresh or claim success
    }
    await loadAll();
    notify(nowFav ? '★ Added to Favorites' : 'Removed from Favorites', 'success');
  };

  // Star / un-star a finished RESULT by moving its SOURCE pose into the Pose tab's "★ Favorite".
  //
  // Most results carry `result.combo.poseId` (the same combo the Regenerate path persists).
  // Favoriting the result = favoriting THAT pose — the real one, which already owns its image, pose
  // prompt, video prompt and title, so it shows in the Pose "★ Favorite" filter fully populated. This
  // is the fix for the OLDER version, which instead added a NEW blank `eddy-result-*` pose (empty
  // everything) and favorited that — a duplicate with no content.
  //
  // Results generated before `combo` was persisted (or rehydrated without it) have no poseId at all —
  // resolveSourcePoseId's fallback covers exactly those: the result still carries the videoPrompt it
  // inherited from its pose, so matching that text (trimmed, exact) recovers the same pose. Same idea
  // clearVideoPromptFor above already relies on for the identical problem.
  //
  // Purely a favorites toggle on an EXISTING item: no addItems, no new row, nothing touched on the cost
  // gate / dispatch / regenerate / animate, the Library, or poses the user favorited by hand. The write
  // is poseStore.toggleFavorite(poseId) — the exact tiny `favorites` key the Pose tab and the Eddy pose
  // picker read, and the same call the pose-card star uses — so a result star and its pose card can
  // never disagree.
  //
  // One honest dead-end, which neither fakes success nor invents a blank pose: resolveSourcePoseId
  // returns null (no combo.poseId that still resolves, AND no pose with a matching videoPrompt) — say
  // so plainly rather than guessing. The star button itself is never disabled (it is always clickable,
  // even mid-batch), so this guard is the only thing standing between that click and a fake success.
  // A failed / quota-refused write throws and is surfaced; we never refresh or toast success on it.
  // On success loadAll re-reads poseStore.listFavorites() into favSets.pose, which drives both this
  // result's star fill (via resultSourcePoseIds below) and the pose picker's Favorite filter — so both
  // update immediately.
  const toggleResultFavorite = async (result) => {
    let items;
    try {
      items = await poseStore.listItems();
    } catch (err) {
      notify(err?.message || 'Could not read your poses', 'error');
      return;
    }
    const poseId = resolveSourcePoseId(result, items);
    if (!poseId) {
      notify('No source pose to favorite for this one — it was generated without a saved pose', 'error');
      return;
    }
    let nowFav;
    try {
      nowFav = await poseStore.toggleFavorite(poseId);
    } catch (err) {
      notify(err?.message || 'Could not update favorite', 'error');
      return; // write failed — do not refresh or claim success
    }
    await loadAll();
    notify(nowFav ? '★ Pose added to Favorites' : 'Removed from Favorites', 'success');
  };

  // Memoized resolution of every VISIBLE result's source pose id, recomputed only when the results
  // list or the loaded pose list changes (loadAll refreshes `poses` on mount, on focus and after every
  // favorite toggle). This is what keeps the render path a plain Map read per tile instead of an
  // async poseStore.listItems() call per tile — resolveSourcePoseId itself is synchronous and only
  // ever runs against the already-loaded `poses` state here (toggleResultFavorite above does its own
  // fresh listItems() read at click time, since a write needs the freshest data; this memo is read-only
  // display and `poses` is refreshed right after every write via loadAll, so it never lags for long).
  const resultSourcePoseIds = useMemo(() => {
    const map = new Map();
    for (const r of results) map.set(r.uid, resolveSourcePoseId(r, poses));
    return map;
  }, [results, poses]);


  // The core of ONE generation, HOISTED to component scope so BOTH the batch run() below and a
  // REHYDRATED tile's rebuilt Regenerate call the very same function — one prompt builder, one
  // billing path, zero drift. It builds the prompt, calls Seedream, and files the result into the
  // generation feed, the results grid and Eddy's Library. It deliberately does NOT touch the batch
  // bookkeeping (`out`, the done counter); the inline Regenerate needs exactly this and none of that.
  // Throws on failure so Regenerate can surface the reason; the batch pool below swallows it as always.
  //
  // `tweak` is the shared instruction typed on the results action bar, empty for every batch
  // generation — which keeps the batch prompt byte-identical to before. It routes into buildPrompt's
  // tweak handling (the five preserve rules soften when a tweak is present); neither duplicated nor
  // bypassed anywhere, a bulk regenerate is N of exactly this call.
  //
  // `replaceUid` is the ONLY difference between generating and regenerating. Given one, the new image
  // swaps into the existing result in place instead of being prepended as a new tile — same
  // generation, same billing, same Library save. Without it a regenerate would both replace the tile
  // AND add a duplicate one.
  //
  // `runCtx` is the batch's per-run SNAPSHOT — character payload, aspect ratio, video ratio, per-image
  // cost and Library folder, resolved once in run() so a 25-image batch is internally consistent and
  // cheap. run() (and therefore a FRESH tile's Regenerate, which captures it) passes it, reproducing
  // THAT batch exactly — the money path is untouched. A REHYDRATED tile's Regenerate passes NOTHING,
  // so the ctx is derived here from the CURRENT page state: character, face, aspect ratio, resolution.
  // That is the documented, expected behaviour — "regenerate uses your current setup" — not a bug: a
  // reload has no batch snapshot to restore (closures aren't serialisable), so the live controls are
  // the only honest source. It still spends the same one-image price and follows the same path.
  const generateCombo = useCallback(async (combo, { tweak = '', replaceUid = null, runCtx = null } = {}) => {
    // Character refs first, exactly as the batch builds them. From the snapshot when run() handed one
    // in; otherwise resolved now from the live controls the same way run() resolves it, so a derived
    // ctx is byte-identical to a batch ctx for the same settings.
    const charPayload = runCtx ? runCtx.charPayload : sourceImages.map(parseDataUrl).filter(Boolean);

    // --- REGENERATE = EDIT THE CURRENT RESULT (not a re-roll) ---
    // A regenerate (replaceUid set) must EDIT the picture already on that tile — keep the exact
    // person, pose, outfit, background, framing and identity and apply ONLY the requested change —
    // NOT re-roll a fresh image from the character source photos + pose diagram. We resolve the
    // tile's CURRENT image through resultsRef (a live mirror of `results`, so no stale closure and
    // `results` stays out of this callback's deps) → its galleryId → fetch the bytes → parse. A
    // fresh BATCH generation (replaceUid null) never enters here and is byte-identical to before.
    //
    // Fallback, never a dead-end: if the base can't be resolved (no galleryId, or the fetch/parse
    // fails), editBase stays null and we drop through to the existing character+pose re-roll below,
    // logging why so the degrade (edit → re-roll) is diagnosable rather than silent.
    let editBase = null;
    if (replaceUid) {
      try {
        const current = resultsRef.current.find((r) => r.uid === replaceUid);
        const galleryId = current?.galleryId;
        if (!galleryId) throw new Error('current result has no galleryId');
        const baseDataUrl = await urlToDataUrl(galleryApi.imageUrl(galleryId));
        const img = parseDataUrl(baseDataUrl);
        if (!img) throw new Error('current result image could not be parsed');
        // ratio taken from the tile so the edit keeps the same frame; dataUrl kept only as a
        // fallback source for aspect detection when the tile never persisted a ratio.
        editBase = { img, dataUrl: baseDataUrl, ratio: current.aspectRatio };
      } catch (err) {
        editBase = null;
        console.warn(`[eddy] Regenerate could not edit the current image, falling back to re-roll: ${err?.message || err}`);
      }
    }
    const isEdit = Boolean(editBase);

    // Guard: an EDIT uses the current result itself as the identity anchor, so it does NOT need the
    // character source photos — do not block it for a missing main photo. A RE-ROLL does need them
    // (with none, Seedream would edit nothing yet still bill). So block only when there is NEITHER a
    // resolvable base image NOR a character photo. Thrown before any pushPending/charge.
    if (!isEdit && !charPayload.length) throw new Error('Add the main character photo first');

    let ratio;
    if (isEdit) {
      // The current result's own ratio, so the edit reframes nothing. Detect from the base image
      // (then '1:1') only if the tile never persisted one — older/rehydrated data.
      ratio = editBase.ratio;
      if (!ratio) {
        try { ratio = await detectAspectRatio(editBase.dataUrl, SEEDREAM_ASPECT_RATIOS, '1:1'); } catch { ratio = '1:1'; }
      }
    } else if (runCtx) {
      ratio = runCtx.ratio;
    } else if (aspectRatio === 'auto') {
      // The same auto-detect run() does, with the same '1:1' fallback.
      try { ratio = await detectAspectRatio(baseImage, SEEDREAM_ASPECT_RATIOS, '1:1'); } catch { ratio = '1:1'; }
    } else {
      ratio = aspectRatio;
    }
    const videoRatio = runCtx ? runCtx.videoRatio : toVideoAspectRatio(ratio);
    const perImageCost = runCtx ? runCtx.perImageCost : seedreamCost(resolution, Math.max(1, perRunImages));
    let libFolderId = runCtx ? runCtx.libFolderId : null;
    if (!runCtx) {
      try {
        libFolderId = await resolveLibraryFolder(libraryStore, { maxNano, maxOutfit, nsfw, characterName });
      } catch (err) {
        // Still never fails the generation — but it is no longer SILENT. Swallowing this is what
        // let 89 pictures file to no folder without a word on screen; "in the wrong place" is
        // recoverable, "nowhere, and nobody said so" is not.
        notify(`Saved, but could not put it in a folder — look under All in the Library. (${err?.message || 'unknown error'})`, 'error');
      }
    }

    let payload;
    let prompt;
    // Carried only by the re-roll path (read from the source pose); the edit path replaces an
    // existing tile whose videoPrompt is already set and never reaches the fresh-tile branch, so ''
    // is correct there.
    let poseVideoPrompt = '';
    /**
     * DECLARED OUT HERE, not inside the branch that computes it, because the Library write at
     * the end of this function reads it.
     *
     * It was block-scoped to that branch, 217 lines above the use, so EVERY generation threw
     * ReferenceError at the addItems call. The throw was caught and surfaced as 'Saved to the
     * gallery but not to Eddy' — while the result tile rendered normally, because that happens
     * earlier. So the image looked fine and simply never reached the Library (audit,
     * 2026-08-09). Nothing else was wrong with the filing path.
     *
     * An edit keeps 'front': it re-renders an existing picture rather than applying a pose, so
     * there is no pose view to inherit.
     */
    let poseView = 'front';

    if (isEdit) {
      // Image 1 = the CURRENT result, and it is the ONLY image sent. It already carries her exact
      // face, body, outfit and setting, so an edit needs nothing else. The face close-up is NOT
      // sent: buildEditPrompt speaks only about "image 1", so a second image arrives with no
      // instruction attached and Seedream MERGES it into the result — reported as a regenerate that
      // came back as the face-close-up woman (wrong outfit, wrong body) instead of an edit of the
      // current photo. The character SOURCE photos and the pose diagram are likewise omitted, for
      // the same reason the comment always intended: re-introducing any source lets her drift off
      // this exact photo.
      payload = [editBase.img];
      prompt = buildEditPrompt({ tweak, instruction, nsfw, wantsBody });
    } else {
      /**
       * IMAGE ORDER IS THE POINT HERE. Seedream weights the earliest images far more heavily, and
       * the pose diagram used to sit THIRD (main photo, face close-up, pose) — where it lost to the
       * main photo every time and the result kept coming back in the base photo's pose no matter
       * what the prompt said. Order is now:
       *
       *   1 main photo   — identity, body and the room (must stay first; it anchors everything)
       *   2 POSE diagram — the shot we are actually trying to copy, promoted for the weight
       *   3 face close-up — identity top-up, still early enough to hold the face
       *   4 outfit photo  — garment reference, weakest slot because the outfit TEXT already works
       *
       * Every index below is computed from payload.length rather than hard-coded, and buildPrompt
       * refers to each image by its passed-in index, so nothing breaks when a slot is absent.
       */
      /**
       * MAX OUTFIT swaps the main image PER COMBO.
       *
       * Every other mode has one main photo for the whole batch, snapshotted into runCtx. Here
       * each combo carries its own finished Library picture — she, her pose and her room are
       * already in it and only the garment changes — so image 1 is resolved per generation
       * instead of read from that snapshot. A row holding a gallery URL is fetched; one with
       * local bytes is used directly.
       */
      let comboMain = null;
      if (combo?.baseId) {
        const row = libItemsRef.current.find((i) => i.id === combo.baseId);
        const src = row?.url || (row ? await libraryStore.getImage(row.id) : '');
        if (!src) throw new Error('That Library image could not be read');
        comboMain = parseDataUrl(src.startsWith('data:') ? src : await urlToDataUrl(src));
        if (!comboMain) throw new Error('That Library image could not be decoded');
        /**
         * THE SOURCE PHOTO'S VIEW BECOMES THE POSE VIEW.
         *
         * Everywhere else poseView comes from the pose diagram, and Max Outfit has no pose -- so
         * it stayed 'front' for every image, including shots taken from behind. Two things then
         * silently did not happen: the outfit's BACK-VIEW description (backPrompt, written by the
         * Outfit tab precisely for this) was never used, and the BACK VIEW body-scope line never
         * fired -- so bust and cleavage wording was still being applied to a picture showing her
         * back.
         *
         * Smart matching already worked this out to pick a back OUTFIT. The same answer just was
         * not reaching the prompt.
         */
        poseView = libraryRowView(row);
      }
      const mainImg = comboMain || charPayload[0] || null;      // sourceImages = [baseImage, faceImage]
      const faceImg = charPayload[1] || null;
      payload = mainImg ? [mainImg] : [];
      let outfitIndex = 0;
      let poseIndex = 0;
      let faceIndex = 0;

      let poseText = '';
      let poseFaceless = false;
      let poseExpression = '';
      if (combo.poseId) {
        const poseItem = poses.find((p) => p.id === combo.poseId);
        // The pose photo IS sent: a body position is far easier to copy than to describe, so
        // the picture does the work the words cannot.
        poseText = stripPoseLighting(poseSentence(poseItem?.prompt));
        // front/back/closeup, read off the same saved JSON the description comes from — decides
        // below whether the outfit's back-view text is used instead of its front one.
        poseView = readPoseView(poseItem?.prompt);
        poseExpression = readPoseExpression(poseItem?.prompt);
        // Faceless is the page TOGGLE. The text detector adds a second way in — if a pose's own
        // prompt says faceless, honour it even with the toggle off — but the toggle is the main switch.
        poseFaceless = faceless || POSE_FACELESS_RE.test(String(poseItem?.prompt || ''));
        // Always read now, never conditionally: video is a deliberate action taken on a finished
        // result, so every result has to carry whether it CAN be animated. An empty one is not an
        // error — it means this image's pose has no video prompt, which the tile says outright.
        poseVideoPrompt = (poseItem?.videoPrompt || '').trim();
        // THE toggle's only job. poseIndex stays 0 when it is off, and buildPrompt keys every
        // pose-image clause off poseIndex — so the prompt stops referring to an image that is not
        // in the payload, rather than pointing at a slot that no longer exists.
        const img = sendPoseImage ? parseDataUrl(await poseStore.getImage(combo.poseId)) : null;
        if (img) { payload.push(img); poseIndex = payload.length; }
      }

      // The outfit's back-view description is used ONLY when the picked pose is back-facing and
      // that description actually exists — an outfit with no back crop described yet just keeps
      // using its front text, exactly as it always has. See attachBackTo in EddyCollection.jsx
      // for where backPrompt gets written (owner, 2026-08-06).
      let outfitText = '';
      if (combo.outfitId) {
        const outfitItem = outfits.find((o) => o.id === combo.outfitId);
        const backText = poseView === 'back' ? outfitItem?.backPrompt?.trim() : '';
        outfitText = backText || outfitItem?.prompt?.trim() || '';
      }
      if (faceImg) { payload.push(faceImg); faceIndex = payload.length; }
      /**
       * The outfit's PRODUCT photo, only when asked for (OUTFIT PHOTO toggle).
       *
       * It used to be sent, and was removed: the photo shows the garment flat or on a mannequin,
       * and that flat chest came back on HER — the bust rendered to the garment's shape instead of
       * her own. buildPrompt now answers that directly whenever outfitIndex is set ("That garment
       * is worn by HER and takes HER shape … never flatten, shrink or reshape her breasts to match
       * the garment"), and pairs it with the take-only-the-clothing rule that keeps the product
       * shot's background and mannequin out. So this is a real choice now rather than a decision
       * made for you: OFF keeps the words-only path that has been the default, ON buys garment
       * accuracy at the cost of leaning on those guards (owner, 2026-08-09).
       *
       * Never sent when NSFW/undress is on — there is no garment to reproduce, and the picture
       * would only pull clothing back toward a body meant to be bare.
       */
      if (sendOutfitImage && combo.outfitId && !wantsNude) {
        const oImg = parseDataUrl(await outfitStore.getImage(combo.outfitId));
        if (oImg) { payload.push(oImg); outfitIndex = payload.length; }
      }

      // poseFaceless only bites when the pose IMAGE is actually sent (poseIndex) — a text-only pose
      // has no framing to match.
      prompt = buildPrompt({ instruction, outfitText, poseText, outfitIndex, poseIndex, faceIndex, nsfw, wantsNude, wantsBody, undressChip, tweak, poseFaceless: poseFaceless && !!poseIndex, lightingText: lightingTextFor(lighting), poseView, buildText: wantsBody ? '' : buildTextFor(build, poseView), expressionText: (wantsExpression || poseFaceless) ? '' : poseExpression, lockOutfitToBase: maxNano });
    }

    const feedId = `eddy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const engineLabel = engine === 'nano2' ? 'Nano Banana 2 (WaveSpeed)' : 'Seedream 5.0 Pro Edit';
    pushPending({ id: feedId, prompt, imageModel: engineLabel, aspectRatio: ratio, resolutionTier: resolution });

    // Only the API call is in the try. Wrapping the success path too meant a throw AFTER the
    // image came back marked a generation you already paid for as failed.
    let data;
    // Set when nano2 gave up and Seedream produced the image instead, so everything downstream
    // labels it with the engine that ACTUALLY made it rather than the one that was selected.
    let usedFallback = false;
    try {
      if (engine === 'nano2') {
        /**
         * Nano Banana 2 on WaveSpeed — the Vertex / Nano-Bypass path this replaces is gone.
         *
         * It goes through the shared /api/seedream/edit route with model:'nano2', exactly as the
         * Base tab does, so a result gets the same imageStore write, gallery row and tagging as any
         * other generation rather than a side channel of its own. That route also fails loudly with
         * no WaveSpeed key instead of quietly billing Seedream for a model you did not ask for.
         *
         * timeoutMs is raised above the server's own 10-minute poll: a measured run spent 182.8s in
         * inference alone, and the client aborting first would throw away an image that had already
         * been generated and billed.
         */
        const callNano2 = async () => {
          const res = await seedreamApi.edit({
            images: payload,
            prompt,
            model: 'nano2',
            aspectRatio: ratio,
            resolution,
            tags: eddyTags(isEdit, characterName),
          }, { timeoutMs: NANO2_CLIENT_TIMEOUT_MS });
          // Asserted INSIDE the retried call on purpose. An empty result is a failed generation, and
          // leaving the check downstream made it the one failure mode that never got a second
          // attempt — it threw after the retry wrapper had already returned.
          if (!(res.images || []).length) {
            const empty = new Error('Nano Banana 2 returned no image');
            empty.code = 'WAVESPEED_EMPTY';
            throw empty;
          }
          return res;
        };
        try {
          data = await withEngineRetry(callNano2, { attempts: NANO2_ATTEMPTS });
        } catch (err) {
          // A terminal error (no key, malformed request) fails the same way on every engine, so
          // there is nothing to fall back TO — rethrow rather than spend a Seedream call proving it.
          if (isTerminalError(err)) throw err;
          /**
           * Four refusals in a row is the engine, not the request — so try the other one.
           *
           * Seedream 5.0 Pro is a different model behind the same WaveSpeed key on the same
           * /api/seedream/edit route, and it already reads this exact prompt shape (it is what the
           * branch below sends). Its content guard draws the line in a different place, which is the
           * point: the images nano refuses are often ones it passes (owner, 2026-08-09).
           *
           * Tagged 'fallback' so they stay identifiable in the gallery — a picture that came from a
           * different model than the one named on the button should never be silent about it.
           */
          data = await withRateLimitRetry(() => seedreamApi.edit({
            images: payload, prompt, aspectRatio: ratio, resolution,
            tags: [...eddyTags(isEdit, characterName), 'fallback'],
          }));
          usedFallback = true;
          if (!warnedFallback.current) {
            warnedFallback.current = true;
            notify(`Nano Banana 2 failed ${NANO2_ATTEMPTS}x on an image — finished it on Seedream 5.0 Pro. Those are tagged "fallback".`, 'error');
          }
        }
      } else {
        // Same model, same per-image price on both paths — an edit is tagged so it is distinguishable
        // in the gallery without changing what it costs.
        data = await withRateLimitRetry(() => seedreamApi.edit({ images: payload, prompt, aspectRatio: ratio, resolution, tags: eddyTags(isEdit, characterName) }));
      }
    } catch (err) {
      // Marked failed on the feed here (the feed card belongs to this call), then rethrown so
      // the caller decides what a failure means: the batch pool keeps going, Regenerate shows
      // the message on the card and keeps the original image.
      failPending(feedId, err?.message || 'Generation failed');
      throw err;
    }

    if (data.provider === 'muapi' && !warnedProvider.current) {
      warnedProvider.current = true;
      notify('No WaveSpeed key — running on Muapi, which rejects long prompts. Add the key in API Keys.', 'error');
    }

    const first = (data.images || [])[0];
    if (!first) {
      const who = engine === 'nano2' && !usedFallback ? 'Nano Banana 2' : 'Seedream';
      failPending(feedId, `${who} returned no image`);
      throw new Error(`${who} returned no image`);
    }
    // The tile this image ended up on. A regenerate swaps into an existing tile, so its uid is
    // the one it was given; a fresh image gets a new one below. Returned to the caller so it can
    // address exactly this tile without ever re-deriving identity from an array position. Stays
    // null if the bookkeeping below throws before the tile exists.
    let resultUid = replaceUid;
    try {
      resolvePending(feedId, {
        galleryId: first.galleryId,
        imageId: first.imageId,
        prompt,
        imageModel: engineLabel,
        aspectRatio: ratio,
        resolutionTier: resolution,
        mimeType: first.mimeType,
        generatedAt: Date.now(),
      });
      // A regenerate REPLACES the picture behind an existing tile and leaves everything else
      // alone. videoPrompt, combo, cost and the closures all come from the pose and the batch, and
      // regenerating an image touches neither — so they are carried across untouched rather than
      // rebuilt. videoStatus is cleared: whatever the previous picture's clip did has nothing to do
      // with this new one.
      //
      // A new image is PREPENDED, and never replaces anything, so an in-flight selection made
      // against earlier results keeps pointing at the same tiles.
      if (replaceUid) {
        setResults((prev) => prev.map((r) => (r.uid === replaceUid
          ? { ...r, galleryId: first.galleryId, imageId: first.imageId, mimeType: first.mimeType, base64Data: first.base64Data, videoStatus: undefined, videoError: undefined }
          : r)));
      } else {
        // Assigned once, here, and never reassigned — not by a regenerate, which only swaps the
        // picture behind it. Every selection, busy flag, error and video-feed entry is keyed by
        // this, so nothing can be re-paired with its neighbour by an index shift.
        const uid = `eddy-res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        resultUid = uid;
        setResults((prev) => [{
          ...first,
          uid,
          // Carried on the result itself (not only on the feed card) so they survive into the
          // persisted queue. `aspectRatio` is what lets a REHYDRATED tile reconstruct its video
          // ratio after a reload — it is the ratio this image was actually made at, which is
          // exactly the `videoRatio` this batch's own submitVideo closure captures below.
          prompt,
          aspectRatio: ratio,
          resolutionTier: resolution,
          videoPrompt: poseVideoPrompt,
          // The pose this image came from, carried as a plain field. FEATURE 2 uses it to blank the
          // SOURCE pose's videoPrompt so a rejected clip idea isn't re-inherited. null for a
          // pose-less combo.
          poseId: combo.poseId || null,
          // The outfit+pose ids this image was generated from — the ONE run input a rebuilt
          // Regenerate needs after a reload. Persisted with the lite shape (it's just two ids); the
          // rehydrate effect turns it back into a working regenerate closure. Stored as a fresh plain
          // copy so nothing here can be mutated by a later combos rebuild.
          combo: { outfitId: combo.outfitId || null, poseId: combo.poseId || null },
          regenCost: perImageCost,
          // THE closures this result was made by, capturing this batch's runCtx snapshot. A fresh
          // result therefore carries the batch that produced it — its face reference, aspect ratio,
          // resolution and Library folder — so regenerating or animating it long after the run has
          // finished reproduces THAT batch rather than whatever the page's controls now say. This is
          // also what makes concurrent batches correct: two results side by side hold two different
          // snapshots, and neither can be billed against the other's settings.
          //
          // generateCombo is a stable component-level useCallback now (not a run-local const), so a
          // rehydrated tile can bind the SAME function; passing runCtx here is what keeps a FRESH
          // regenerate snapshot-exact while a rehydrated one (no runCtx) reads the current controls.
          regenerate: (t) => generateCombo(combo, { tweak: t, replaceUid: uid, runCtx }),
          // The batch's own videoRatio, snapshotted at run() time, bound into the shared
          // page-level submitVideoJob. A rehydrated tile binds the SAME function with the ratio
          // recovered from its persisted aspectRatio, so both paths dispatch identically.
          submitVideo: (job) => submitVideoJob(job, videoRatio),
        }, ...prev]);

        // NAVIGATED AWAY MID-GENERATION. setResults above did nothing (the component is gone) and
        // the debounced persist effect will never run, so without this the finished tile is lost and
        // the page reads "Nothing generated yet" on return — even though the image was billed and
        // saved. Write it to the SAME store the rehydrate reads, newest-first, capped identically.
        // Read-modify-write is safe here: the effect that also writes this key only runs while the
        // page is mounted, which is exactly when this branch does not fire.
        if (!mountedRef.current) {
          try {
            const stored = await resultsStore.get('queue', []);
            const row = liteResult({
              uid,
              galleryId: first.galleryId,
              imageId: first.imageId,
              prompt,
              videoPrompt: poseVideoPrompt,
              poseId: combo.poseId || null,
              combo: { outfitId: combo.outfitId || null, poseId: combo.poseId || null },
              regenCost: perImageCost,
              aspectRatio: ratio,
              resolutionTier: resolution,
            });
            await resultsStore.set('queue', [row, ...stored]);
          } catch {
            // Best-effort recovery only — the image is already safe in the gallery and Eddy's
            // Library, so a failed write here must never turn a paid generation into an error.
          }
        }
      }
      // Everything Eddy makes shows up in Eddy's Library. Stored as a reference to the
      // server copy, not as bytes, so a 25-image batch costs the browser almost nothing.
      // A regenerate lands here too: that image is generated and billed like any other, so it
      // gets saved like any other — the one it replaces is left alone rather than deleted.
      if (first.galleryId) {
        /**
         * NOT wrapped in its own catch any more.
         *
         * It used to be, with the note "the picture is safe in the main gallery either way". That is
         * true, and it is exactly the problem: the swallow meant the outer handler's "Saved to the
         * gallery but not to Eddy" toast -- written for precisely this failure -- could never fire.
         * A picture that failed to file was invisible AND silent, which is the reported symptom:
         * "it generates and doesn't send to Library" (audit, 2026-08-09).
         *
         * Letting it reach the outer catch keeps the image -- that handler swallows and returns it --
         * and makes the miss audible.
         *
         * poseView is stamped so Max Outfit can match a back shot to a back outfit exactly rather
         * than inferring it from the prompt text.
         */
        const filed = await libraryStore.addItems(
          [{ url: galleryApi.imageUrl(first.galleryId), prompt, poseView, name: `eddy-${Date.now()}` }],
          libFolderId,
        );
        // addItems reports per-item failures instead of throwing: a quota failure SKIPS the row and
        // returns normally, with the count on `added.failed`. No caller has ever read it, so a
        // skipped row looked exactly like a success.
        if (!Array.isArray(filed) || filed.length === 0) {
          throw new Error(filed?.failed
            ? 'Browser storage is full - the picture is in the gallery but not in Eddy Library'
            : 'Eddy Library did not accept the row');
        }
      }
    } catch (err) {
      // The picture exists and is billed; only the bookkeeping broke. Swallowed, not rethrown:
      // the image is real and must still be returned to the caller.
      notify(`Saved to the gallery but not to Eddy: ${err?.message || 'unknown error'}`, 'error');
    }

    return { image: first, videoPrompt: poseVideoPrompt, uid: resultUid };
    // maxNano belongs here as much as maxOutfit: both decide which Library folder a result lands
    // in (see resolveLibraryFolder), and leaving it out means a stale closure can file a Max Nano
    // run as though it were an Eddy one. It only escaped notice because sourceImages is rebuilt
    // every render, which happens to rebuild this callback too — an accident, not a guarantee.
  }, [sourceImages, aspectRatio, baseImage, resolution, perRunImages, nsfw, characterName, maxNano, maxOutfit, libraryStore, wantsNude, wantsBody, undressChip, instruction, faceImage, outfits, poses, poseStore, outfitStore, submitVideoJob, notify, sendPoseImage, sendOutfitImage, faceless, lighting, build, engine, wantsExpression]);

  // Keep the ref pointed at the latest generateCombo every render, so the mount-time rehydrate
  // effect's rebuilt regenerate closures reach the current one at click time (see the ref's comment).
  generateComboRef.current = generateCombo;
  // Keep the results mirror current every render, so a regenerate's edit branch reads the tile's
  // latest galleryId (a fresh generation or a prior regenerate may have replaced it) at click time.
  resultsRef.current = results;
  // Keep the selection refs current every render, so a comboless rehydrated tile's fallback
  // regenerate reads the outfit/pose picked RIGHT NOW at click time (see the refs' comment).
  pickedOutfitsRef.current = pickedOutfits;
  pickedPosesRef.current = pickedPoses;

  // `only` re-runs an explicit list instead of the live pose × outfit grid — that is how "Retry N
  // failed" replays exactly the combos that threw, at the price of those combos alone, without
  // touching what is currently picked in the pickers.
  const run = useCallback(async (only) => {
    const batch = Array.isArray(only) && only.length ? only : combos;
    if (!baseImage) { notify('Add the main photo first', 'error'); return; }
    if (overCap) { notify(`That's ${perRunImages} images per run — Seedream takes ${SEEDREAM_MAX_IMAGES}`, 'error'); return; }

    // A big batch is confirmed with its real cost in the message, because the number is reached by
    // multiplying two selections and is easy to arrive at without meaning to. The panel cap is
    // stated too: images past it are still generated and BILLED, they just stop being listed here.
    if (batch.length > CONFIRM_ABOVE) {
      const each = seedreamCost(resolution, Math.max(1, perRunImages));
      const lines = [
        `${batch.length.toLocaleString()} images — about $${(batch.length * each).toFixed(2)}.`,
        `${pickedOutfits.length || 1} outfit${(pickedOutfits.length || 1) === 1 ? '' : 's'} x ${pickedPoses.length || 1} pose${(pickedPoses.length || 1) === 1 ? '' : 's'}.`,
        batch.length > RESULTS_PAGE
          ? `All of them stay in the panel — ${RESULTS_PAGE} show at a time, with a button for the rest.`
          : '',
        'Start this run?',
      ].filter(Boolean);
      if (!window.confirm(lines.join('\n\n'))) return;
    }

    // DELIBERATELY NOT WARNED ABOUT HERE — an unreadable pose prompt used to fire an error toast
    // from this spot on every single generate.
    //
    // It was factually correct and it was still wrong to put here. poseSentence() drops the
    // unreadable text and the pose IMAGE carries the shot on its own, so nothing about the
    // generation is broken and there is nothing to decide at this moment; the toast interrupted
    // the one flow it could not be acted on from, one card at a time, every run, forever. A
    // warning that fires on a healthy path and cannot be actioned where it fires is noise, and
    // noise is what makes real warnings ignorable.
    //
    // The information is NOT lost — it lives where it can actually be fixed, which is where it was
    // always more useful: EddyCollection's Pose tab renders `isPosePromptBroken` as a badge on the
    // offending card, right beside the text it is talking about and directly under that card's
    // "Re-describe with AI" button, plus a "Re-describe N unreadable" sweep in the tab toolbar.
    // Both read the same isPosePromptBroken() this used to, so the two can never disagree.

    // Outside any try before, so a rejection here made the Generate button look dead.
    let ratio = aspectRatio;
    if (aspectRatio === 'auto') {
      try {
        ratio = await detectAspectRatio(baseImage, SEEDREAM_ASPECT_RATIOS, '1:1');
      } catch {
        ratio = '1:1';
      }
    }

    // Snapshotted per run, not read live. Every result this batch produces captures it, so a clip
    // animated from one of these images hours later still uses the ratio its image was made at
    // rather than whatever the controls happen to say by then.
    const videoRatio = toVideoAspectRatio(ratio);

    // Nothing is reset here: another batch may still be running and its results and counters
    // must survive this one starting.
    cancelRef.current = false;
    setCancelling(false);
    setInFlight((n) => n + 1);
    setQueued((n) => n + batch.length);
    warnedProvider.current = false;

    const charPayload = sourceImages.map(parseDataUrl).filter(Boolean);
    // Every image THIS batch landed. Scoped to this run's closure and never read by any other
    // batch, so two overlapping runs each report their own tally rather than each other's.
    const out = [];
    // What one image costs to make — carried onto every result so the action bar can quote a
    // Regenerate across a mixed selection correctly. It is stored PER RESULT rather than read
    // from the live controls because a selection can span batches generated at different
    // resolutions, and each image re-rolls at the price of the batch that made it.
    const perImageCost = seedreamCost(resolution, Math.max(1, perRunImages));

    // Results file themselves under the character's name — Grace's go to "Grace", Gwen's to
    // "Gwen". Resolved once per run so a 25-image batch doesn't hunt for it 25 times.
    let libFolderId = null;
    try {
      libFolderId = await resolveLibraryFolder(libraryStore, { maxNano, maxOutfit, nsfw, characterName });
    } catch (err) {
      // Resolved ONCE per run, so a failure here strands the WHOLE batch in no folder — which is
      // exactly how a 25-image run can vanish from every folder at once. Never silent.
      notify(`Saved, but this batch could not be put in a folder — look under All in the Library. (${err?.message || 'unknown error'})`, 'error');
    }

    // Every per-run value the shared generateCombo needs, resolved ONCE here so a 25-image batch is
    // internally consistent and doesn't re-detect the ratio or re-look-up the folder per combo. This
    // snapshot is handed to the component-level generateCombo (and captured by each fresh result's
    // regenerate closure), so the batch — and a FRESH tile's later regenerate — reproduce exactly
    // THESE settings: the money path is unchanged. A rehydrated tile's regenerate passes no runCtx
    // and reads the live controls instead (see generateCombo's header).
    const runCtx = { charPayload, ratio, videoRatio, perImageCost, libFolderId };

    // Identifies THIS run's jobs. Read once so every jid in the batch shares it.
    const runStamp = Date.now();

    /**
     * Write the whole batch down BEFORE a single request leaves, all 'queued'.
     *
     * Up front, not as each one starts: the combos that must survive a kill are exactly the ones
     * that have not run yet, so a record written progressively would be missing precisely the part
     * worth keeping. Each job gets a jid so its status can be patched without matching on combo
     * identity, which is not unique — the same outfit×pose can legitimately appear twice in a run.
     *
     * A retry run ("only") overwrites the record rather than appending: it IS the outstanding work.
     */
    const jidOf = (i) => `j-${runStamp}-${i}`;
    try {
      await jobQueueStore.set(JOB_QUEUE_KEY, {
        mode, startedAt: runStamp,
        jobs: batch.map((combo, i) => ({ jid: jidOf(i), combo, status: 'queued' })),
      });
    } catch { /* the run still goes ahead unrecorded rather than not at all */ }

    // The batch wrapper: everything generateCombo deliberately leaves out. One bad combo must
    // not abandon the rest, so a throw is absorbed here — generateCombo has already marked its
    // own feed card failed with the real reason.
    let attempted = 0;
    const runCombo = async (combo, idx) => {
      attempted += 1;
      // Marked SENT before the request, never after: a kill lands between these two lines often
      // enough to matter, and the safe reading of "we don't know" is "it may have been billed".
      // Under-claiming here costs a duplicate image; over-claiming costs nothing but a Retry click.
      const jid = jidOf(idx);
      await markJob(jid, 'sent');
      try {
        const res = await generateCombo(combo, { runCtx });
        out.push(res);
        await markJob(jid, 'done');
        // A retry that SUCCEEDS clears its own entry, so the "Retry N failed" count always equals
        // what is still outstanding rather than what has ever failed.
        setFailedCombos((prev) => prev.filter((f) => f.combo !== combo));
      } catch (err) {
        await markJob(jid, 'failed');
        // The reason is already on the feed card; this keeps the COMBO so it can be re-run.
        // Deduped by combo identity — retrying a combo that fails again must not stack a second
        // entry and inflate the count.
        setFailedCombos((prev) => [
          ...prev.filter((f) => f.combo !== combo),
          { combo, message: err?.message || 'Generation failed' },
        ]);
      }
      setDone((n) => n + 1);
    };

    // Fire them together rather than one after another. Capped, not unlimited: each request
    // makes the backend re-encode every source image with sharp, so 30 at once meant ~150
    // simultaneous conversions — and this backend has already died twice today. The cap keeps
    // a big batch fast without knocking the server over.
    //
    // THIS IS THE WHOLE RUN: it generates images and stops. A generate run must never dispatch a
    // video, because by the time an image exists a clip fired from here would already be billed —
    // leaving no moment at which the user could look at the picture and decide whether to pay for
    // its animation. That decision is the point, so animating is only ever a deliberate action
    // taken on a finished result (the per-tile Animate button and the bulk Generate video action),
    // and both of those quote their cost and wait for a confirmation first.
    try {
      await runPool(batch, parallelFor(engine), runCombo, () => cancelRef.current);
    } finally {
      // finally, always: a rejection anywhere in the pool skipped this, leaving the counter
      // stuck above zero -- permanent "1 batch running" plus a beforeunload warning on every
      // navigation for the rest of the session.
      setInFlight((n) => n - 1);
    }
    // The run is over one way or another, so nothing is owed. Cleared on CANCEL too: cancelling is
    // a deliberate "don't send the rest", and resuming it on the next launch would be the opposite
    // of what was asked — and would spend money doing it.
    await clearJobQueue();

    if (cancelRef.current) {
      // Cancelled is NOT failed: the unsent combos were never attempted and never charged, so they
      // must not be reported as failures (nor land in the retry panel, which prices a re-run).
      notify(`Cancelled — ${out.length} image${out.length === 1 ? '' : 's'} kept, ${Math.max(0, batch.length - attempted)} never sent`, 'success');
    } else if (out.length === batch.length) notify(`${out.length} image${out.length === 1 ? '' : 's'} done ✨`, 'success');
    else if (out.length) notify(`${out.length} of ${batch.length} done — the rest failed`, 'error');
    else notify('Every generation failed', 'error');
    // run() now only builds the batch snapshot (runCtx) and drives the pool; the prompt/face/outfit/
    // pose reads moved into the hoisted generateCombo, so those are its deps, not run's. What remains
    // here is exactly what run() itself reads: the guards, the ctx inputs, and generateCombo. sourceImages
    // is an unmemoized array literal today, so it rebuilds run() every render — listed anyway so
    // memoizing it later can't silently turn charPayload into a stale (previous-face) closure.
    // mode and maxNano are read when the queue record is written and when the folder is resolved.
  }, [baseImage, overCap, perRunImages, aspectRatio, combos, sourceImages, resolution, nsfw, characterName, mode, maxNano, maxOutfit, pickedBases, missingOutfitKinds, libraryStore, notify, generateCombo, engine, pickedOutfits, pickedPoses]);

  // Assigned AFTER run() exists — `run` is a const, so touching it any earlier is a temporal dead
  // zone error that takes the whole page down. Same stabilisation generateComboRef uses: the resume
  // effect reads run() through this instead of depending on it and re-firing the batch every render.
  runRef.current = run;

  /**
   * PICK THE UNFINISHED RUN BACK UP, once, on open.
   *
   * Two different jobs, because 'queued' and 'sent' cost different things — see jobQueueStore.
   *
   *   queued -> RESUMED. Never sent, never billed, so finishing them is free of surprises and is
   *             exactly what "it should stay in queue and not get cut off" asks for.
   *   sent   -> REPORTED, never re-sent. The server bills those whether or not this app survived to
   *             hear back, so re-dispatching buys the same picture twice. The Library's own
   *             recovery sweep collects the ones that finished; the toast says how many were in
   *             flight so a genuine loss is visible rather than assumed.
   *
   * GATED ON `loading` AND `baseImage`, and both matter for money rather than tidiness:
   *   - `loading` false means loadAll has finished, so `poses` and `outfits` are populated.
   *     Resuming before that generates every remaining image with NO pose or outfit text — wrong
   *     pictures, produced and billed at full price.
   *   - `baseImage` is what the page rehydrates asynchronously; without it run() bails on
   *     "Add the main photo first" and the queue would be cleared having done nothing.
   *
   * runRef, not run, in the dependency list: run() is rebuilt on nearly every render, and depending
   * on it directly would re-enter this effect constantly and fire the batch more than once.
   */
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current || loading || !baseImage) return undefined;
    let alive = true;
    (async () => {
      const rec = await readJobQueue(mode);
      if (!alive || !rec) return;
      resumedRef.current = true;               // one attempt per mount, whatever the outcome

      const queued = rec.jobs.filter((j) => j.status === 'queued').map((j) => j.combo);
      const sent = rec.jobs.filter((j) => j.status === 'sent');

      if (sent.length) {
        // Surfaced as a plain statement of fact, not an error: the pictures are very likely fine
        // and already in the gallery — the sweep on the Library files them.
        notify(`${sent.length} image${sent.length === 1 ? ' was' : 's were'} still generating when the app closed. They finish on the server — open the Library and they are pulled in.`, 'success');
      }
      if (!queued.length) { await clearJobQueue(); return; }

      notify(`Picking up where the last run stopped — ${queued.length} still to generate.`, 'success');
      // Straight into the normal path: same pool, same prices, same bookkeeping. run() rewrites the
      // queue record from this shorter list, so a second interruption resumes what is left of it.
      runRef.current?.(queued);
    })();
    return () => { alive = false; };
  }, [loading, baseImage, mode, notify]);

  /* -------------------------------------------------------------------------------------------
   * The inline results flow. Everything below acts on RESULTS, never on the page's live controls:
   * each result carries the closures of the batch that made it, so a selection spanning two
   * batches regenerates each image at its own batch's settings and price.
   * ----------------------------------------------------------------------------------------- */

  const anyBusy = Object.keys(busyUids).length > 0;
  // Images dispatched but not yet landed, across every running batch. Drives the placeholder tiles
  // so the column shows reserved slots instead of staying blank until the first image returns.
  // Clamped at zero because `done` and `queued` are updated from separate state updaters and can
  // be observed a render apart.
  const pendingCount = Math.max(0, queued - done);
  /**
   * Move the large view N places through the CURRENT results order.
   *
   * Clamped rather than wrapping: arriving back at the first image after the last one reads as a
   * bug, and the position counter makes the end obvious. Reads `results` at call time via the
   * functional update, so a batch that lands while the view is open steps into the new images
   * instead of a stale snapshot.
   */
  const stepLightbox = useCallback((delta) => {
    setLightboxUid((cur) => {
      const i = results.findIndex((r) => r.uid === cur);
      if (i < 0) return cur;
      const next = results[i + delta];
      return next ? next.uid : cur;
    });
  }, [results]);

  // A result can be removed while its large view is open. Close rather than leaving an overlay
  // pinned over an image that no longer exists.
  useEffect(() => {
    if (lightboxUid && !results.some((r) => r.uid === lightboxUid)) setLightboxUid(null);
  }, [lightboxUid, results]);

  const selectedResults = useMemo(
    () => results.filter((r) => selectedUids.has(r.uid)),
    [results, selectedUids],
  );
  // Drives the header control's label so one button covers both directions. Guarded on
  // results.length so an empty column never reads as "everything is selected".
  const allSelected = results.length > 0 && selectedResults.length === results.length;
  // Summed per result, not count × one price: a selection can span batches run at different
  // resolutions, and each image re-rolls at the price of the batch that made it.
  const regenTotal = useMemo(
    () => selectedResults.reduce((sum, r) => sum + (r.regenCost || 0), 0),
    [selectedResults],
  );
  // Only a result whose pose carried a videoPrompt can ever animate. Split out rather than
  // filtered silently, so the ones that cannot are counted and named in the bar and again in the
  // confirmation — never dropped without saying so, and never billed a default duration.
  const animatable = useMemo(
    () => selectedResults.filter((r) => r.videoPrompt && r.galleryId && r.submitVideo),
    [selectedResults],
  );
  const notAnimatable = selectedResults.length - animatable.length;
  // Resolved through clipDurationFor, the same helper submitVideo dispatches with, so the quote
  // is the clamped length and cannot diverge from what is actually billed.
  const animatableClips = useMemo(
    () => animatable.map((r) => clipDurationFor(r.videoPrompt)),
    [animatable],
  );
  const videoTotal = useMemo(
    () => animatableClips.reduce((sum, c) => sum + c.seconds * VIDEO_PRICE_PER_SECOND, 0),
    [animatableClips],
  );

  const toggleResult = useCallback((uid) => setSelectedUids((prev) => {
    const next = new Set(prev);
    if (next.has(uid)) next.delete(uid); else next.add(uid);
    return next;
  }), []);

  const addBarChip = (text) => setBarInstruction((prev) => (prev.includes(text) ? prev : `${prev} ${text}`.trim()));

  /**
   * Regenerates the given tiles with ONE instruction, each replacing its own tile in place as it
   * returns.
   *
   * THE ONE regenerate path. The bulk bar and a single tile's Regenerate both land here — same
   * pool, same cap, same in-place replacement, same error handling — so a per-tile regenerate is
   * literally a bulk regenerate of one, not a second implementation that can drift. `uids` and
   * `text` are passed IN rather than read from state, which is what lets a tile supply its own note
   * without touching the shared box (see ResultTile's precedence comment).
   *
   * No confirmation: this bills the same per-image price the page has always charged without
   * asking, and it is the action the whole flow exists to make cheap to repeat — see
   * VideoConfirmGate's header for why video is treated differently.
   */
  const regenerateUids = useCallback(async (uids, text) => {
    // Snapshotted before the first await: the user can keep clicking during a long run, and a set
    // read later would regenerate images they selected after pressing the button.
    const wanted = new Set(uids);
    const targets = results.filter((r) => wanted.has(r.uid) && !busyUids[r.uid] && r.regenerate);
    if (!targets.length) return;
    const tweak = String(text || '').trim();
    // Capped at PARALLEL_REQUESTS — the same ceiling the batch pool uses. Twenty selected images
    // must not become twenty simultaneous Seedream calls; that is the 429 quota storm this repo
    // has hit repeatedly. A single-tile call passes one item, so the pool opens one lane.
    await runPool(targets, PARALLEL_REQUESTS, async (item) => {
      setBusyUids((prev) => ({ ...prev, [item.uid]: 'Regenerating' }));
      setTileErrors((prev) => { const next = { ...prev }; delete next[item.uid]; return next; });
      try {
        // Routes into buildPrompt's `tweak` handling — the five preserve rules that soften when an
        // instruction is present. Reached through the result's own regenerate closure, the same one
        // the bulk path uses, so that logic is neither duplicated nor bypassed by the per-tile route.
        const res = await item.regenerate(tweak);
        if (!res?.image?.galleryId) {
          setTileErrors((prev) => ({ ...prev, [item.uid]: 'Nothing came back — kept the original' }));
        }
      } catch (err) {
        // Deliberately does not touch this result's image: a failed regenerate leaves the
        // original — already generated and paid for — on screen. The throw stops here, so one
        // failure can never abort the rest of the pool.
        setTileErrors((prev) => ({ ...prev, [item.uid]: err?.message || 'Regenerate failed' }));
      } finally {
        setBusyUids((prev) => { const next = { ...prev }; delete next[item.uid]; return next; });
      }
    });
    // Selection and the typed instruction deliberately survive: the second attempt at a bad hand
    // is usually the same images with a nudged instruction.
  }, [results, busyUids]);

  // The bulk bar's Regenerate: the selection, with the bar's shared box as the instruction. The
  // ONLY reader of `barInstruction` — a tile's Regenerate never sees it.
  const regenerateSelected = useCallback(
    () => regenerateUids([...selectedUids], barInstruction),
    [regenerateUids, selectedUids, barInstruction],
  );

  /**
   * Removes the selected results FROM THIS COLUMN ONLY. The pictures stay in the Library and in
   * the main gallery, untouched.
   *
   * WHY non-destructive, deliberately: every image in this column is already generated, already
   * billed and already saved server-side. A Delete that also reached into the Library would make a
   * single misclick destroy paid work with no way back — and this button sits directly beside
   * Regenerate in a bar the user is clicking repeatedly during a fix-it loop, which is exactly the
   * place a misclick happens. Clearing the tray is cheap and reversible (regenerate, or open the
   * Library); deleting the asset is neither. So this is a "clear it off my workspace" action, and
   * the button and its subtext both say so rather than leaving the user to guess.
   *
   * There is no confirmation gate for the same reason: nothing is lost, so a dialog would be
   * ceremony in front of a harmless action.
   *
   * Busy tiles are skipped rather than removed: a tile mid-regenerate or mid-animate has a request
   * in flight that will call back into `setResults` for its uid, and pulling it out from under that
   * would strand the callback and leave the user paying for an image with nowhere to land.
   */
  // Bulk save. Goes through downloadBlob exactly like a tile's own Download button — the app's single
  // save path, which strips generator/C2PA metadata before the file lands. Never builds a bare
  // `<a download>`: that is what let RAW files out of this page once.
  //
  // Sequential, with a small gap between saves: browsers throttle (and Chrome silently drops) a burst
  // of simultaneous downloads, so firing 18 at once would quietly lose most of them.
  //
  // VIDEO WINS over the image. A tile that has been animated IS a clip — that finished clip is the
  // thing worth saving, and pulling its still frame instead would be the wrong file. So each result
  // saves its video when it has a local one, and only falls back to the image when it has none.
  // Clips go through the server /clean route (an MP4 container needs ffmpeg, which is why
  // stripMetadata passes video through untouched); images go through downloadBlob. Both end at
  // downloadBlob so the app keeps ONE save path.
  const [downloading, setDownloading] = useState(false);
  const downloadResults = useCallback(async (list) => {
    const targets = list.filter((r) => r.videoUrl || r.galleryId || r.base64Data);
    if (!targets.length) { notify('Nothing to download', 'error'); return; }
    setDownloading(true);
    let videos = 0;
    let images = 0;
    let dirty = 0;    // saved but NOT metadata-stripped
    let failed = 0;
    let remote = 0;   // provider-hosted clip we refuse to hand over unstripped
    for (const r of targets) {
      try {
        const clip = localClipFilename(r.videoUrl);
        if (r.videoUrl && !clip) {
          // Same refusal as the tile's own video download: a provider-hosted clip never reached our
          // disk, so nothing can strip it, and an unstripped file looks identical to a stripped one.
          remote += 1;
        } else if (clip) {
          const resp = await fetch(videoApi.cleanFileUrl(clip), { credentials: 'include' });
          if (!resp.ok) throw new Error(String(resp.status));
          // The route serves the ORIGINAL when ffmpeg fails and says so ONLY in this header — the
          // bytes alone cannot be told apart, so the header is the only honest signal.
          const stripped = resp.headers.get('X-Metadata-Stripped') === 'yes';
          const ext = (clip.match(/\.[a-z0-9]+$/i) || ['.mp4'])[0];
          const stem = clip.slice(0, clip.length - ext.length) || 'eddy-video';
          await downloadBlob(await resp.blob(), `${stem}${stripped ? '_metadatacleaned' : '_NOT-cleaned'}${ext}`);
          if (!stripped) dirty += 1;
          videos += 1;
        } else {
          const src = r.galleryId
            ? galleryApi.imageUrl(r.galleryId)
            : `data:${r.mimeType || 'image/png'};base64,${r.base64Data}`;
          const resp = await fetch(src, { credentials: 'include' });
          if (!resp.ok) throw new Error(String(resp.status));
          const blob = await resp.blob();
          const type = blob.type || r.mimeType || 'image/png';
          const ext = type.includes('jpeg') || type.includes('jpg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png';
          const info = await downloadBlob(blob, `eddy_${Date.now()}_${images + 1}.${ext}`);
          if (stripEnabled() && !info.cleaned) dirty += 1;
          images += 1;
        }
      } catch {
        failed += 1;
      }
      await new Promise((res) => setTimeout(res, 350));
    }
    setDownloading(false);
    // Same honesty rule as the single-tile save: anything that could NOT be cleaned is called out, so
    // "downloaded" is never quietly read as "safe to publish".
    const parts = [];
    if (videos) parts.push(`${videos} video${videos === 1 ? '' : 's'}`);
    if (images) parts.push(`${images} image${images === 1 ? '' : 's'}`);
    const what = parts.join(' + ') || 'nothing';
    if (dirty > 0) {
      notify(`Saved ${what} — but ${dirty} could NOT have metadata removed. Check before publishing.`, 'error');
    } else if (failed || remote) {
      notify(`Saved ${what}${failed ? ` · ${failed} failed` : ''}${remote ? ` · ${remote} provider-hosted clip(s) skipped (metadata can't be removed here)` : ''}`, 'error');
    } else {
      notify(`Saved ${what}${stripEnabled() ? ' — metadata cleaned' : ''}`, 'success');
    }
  }, [notify]);

  const [libFolders, setLibFolders] = useState([]);
  const [filingTo, setFilingTo] = useState(false);

  // The Library's folders, for the "file these into…" picker. Re-read when the picker opens so a
  // folder created in the Library tab since this page mounted is offered.
  const openFilePicker = useCallback(async () => {
    try { setLibFolders(await libraryStore.listFolders()); } catch { setLibFolders([]); }
    setFilingTo(true);
  }, [libraryStore]);

  /**
   * File results into a Library folder and clear them out of the results panel.
   *
   * MOVES, it does not copy. Every result was ALREADY added to the Library at generation time
   * (see the libraryStore.addItems call in generateCombo, which files into "Eddy" / "Eddy NSFW"),
   * so adding again would leave two entries for one picture. This finds the existing Library row
   * by its gallery URL and re-points its folderId; only a result with no Library row yet — one
   * whose filing failed at generation — gets added fresh.
   *
   * The image itself is untouched on the server. "Delete from here" means the results panel only;
   * the picture lives in the Library, which is the whole point of moving it there.
   */
  const fileToLibrary = useCallback(async (folderId, list) => {
    const targets = (list || []).filter((r) => r.galleryId);
    if (!targets.length) { notify('Nothing to file — these have no saved image yet', 'error'); return; }
    let moved = 0, added = 0;
    try {
      const existing = await libraryStore.listItems();
      const byUrl = new Map(existing.filter((i) => i.url).map((i) => [i.url, i]));
      for (const r of targets) {
        const url = galleryApi.imageUrl(r.galleryId);
        const hit = byUrl.get(url);
        // eslint-disable-next-line no-await-in-loop -- serialized store, and these are small writes
        if (hit) { await libraryStore.updateItem(hit.id, { folderId }); moved += 1; }
        // eslint-disable-next-line no-await-in-loop
        else { await libraryStore.addItems([{ url, prompt: r.prompt || '', name: `eddy-${r.uid}` }], folderId); added += 1; }
      }
    } catch (err) {
      notify(err?.message || 'Could not file those', 'error');
      return;
    }
    removeUidsRef.current?.(targets.map((r) => r.uid));
    setSelectedUids(new Set());
    setFilingTo(false);
    notify(`${moved + added} sent to the Library${added ? ` (${added} newly added)` : ''}`, 'success');
  }, [libraryStore, notify]);

  const removeUids = useCallback((uids) => {
    // Only ever keyed by uid. A result's videoPrompt, regenerate closure and submitVideo closure
    // all live on the result object itself, so filtering the array cannot re-pair any surviving
    // result with a neighbour's pose or video prompt the way an index-based removal could.
    const doomed = new Set([...uids].filter((uid) => !busyUids[uid]));
    if (!doomed.size) return;

    // The persisted queue is dropped along with the in-memory one: this setResults triggers the
    // persist effect, which rewrites IndexedDB from the surviving results — so a removed image does
    // not come back on the next reload. Removal is the ONLY user action that takes an image out of
    // the panel (the other exit is its video completing); nothing here clears on reload or navigation.
    setResults((prev) => prev.filter((r) => !doomed.has(r.uid)));
    setSelectedUids((prev) => {
      const next = new Set(prev);
      for (const uid of doomed) next.delete(uid);
      return next;
    });
    setTileErrors((prev) => {
      const next = { ...prev };
      for (const uid of doomed) delete next[uid];
      return next;
    });
    // Drop the feed→tile mappings for tiles that no longer exist. Not strictly required (the
    // subscribeFeed handler's setResults would simply match nothing), but leaving them behind means
    // the map grows for the life of the session and keeps re-scanning entries that can never
    // resolve. Deleting during iteration is safe on a Map.
    for (const [feedId, uid] of videoFeedMap.current) {
      if (doomed.has(uid)) videoFeedMap.current.delete(feedId);
    }

    notify(`Removed ${doomed.size} from results — still in your Library`, 'success');
  }, [busyUids, notify]);

  // Always points at the CURRENT removeUids. fileToLibrary is defined above it (it owns the
  // picker state that sits with the other results controls) and must clear the tiles it just
  // filed — reading through a ref avoids reordering the file or listing a not-yet-defined
  // callback in a dependency array, which is the temporal-dead-zone crash this page has already
  // shipped once today.
  const removeUidsRef = useRef(null);
  removeUidsRef.current = removeUids;

  const removeSelected = useCallback(() => removeUids([...selectedUids]), [removeUids, selectedUids]);

  /**
   * FEATURE 2 — clear a result's video prompt when the user dislikes what the animation does.
   *
   * This removes ONLY the text that drives future animation. It is deliberately NOT a delete: the
   * result, its image and any clip it already produced all stay exactly where they are. After this:
   *   - the tile's videoPrompt is empty → Generate video / Animate goes disabled and the same muted
   *     "No video prompt on this pose" note a prompt-less pose shows appears (canAnimate keys on it);
   *   - the persist effect mirrors the emptied videoPrompt to IndexedDB, so it stays cleared on reload;
   *   - the SOURCE pose's videoPrompt is blanked in the pose store, so a fresh generation from that
   *     pose no longer re-inherits the bad prompt (generateCombo reads poseItem.videoPrompt).
   *
   * poseId isn't always there to key off: results generated before poseId existed, or rehydrated
   * from the persisted queue, can carry a videoPrompt with no (or a dangling) poseId. This USED TO
   * fall back to clearing every pose whose videoPrompt was identical (trimmed) text — removed. That
   * heuristic assumes identical text means the same pose, which silently clears OTHER, unrelated
   * poses too whenever more than one happens to share the same wording (a copy-pasted template, a
   * short generic phrase) — an ambiguous match spreading a supposedly single-tile action onto data
   * the user never selected. Reported as "it deleted things too". Now: a poseId that resolves to a
   * real pose is the ONLY case that touches the pose store; anything else clears the result alone
   * and says so honestly, rather than guessing which pose(s) to mutate.
   *
   * No money path is touched — nothing is billed, dispatched or refunded here; it only edits strings.
   */
  const clearVideoPromptFor = useCallback((uid) => {
    const target = results.find((r) => r.uid === uid);
    // Nothing to clear if the tile has no prompt (or doesn't exist), so this is a no-op then — the
    // control is disabled in that state too, but guarding here keeps it safe if called any other way.
    if (!target || !target.videoPrompt) return;

    const poseId = target.poseId;

    // Clear on the result first — this is the source of truth the tile renders and the persist
    // effect stores, so the tile updates and the change survives a reload regardless of the pose write.
    setResults((prev) => prev.map((r) => (r.uid === uid ? { ...r, videoPrompt: '' } : r)));

    // Propagate to the source pose ONLY when poseId resolves to a real, still-existing pose — a
    // positive identification, not a guess. Only the videoPrompt field is patched — a pose's image
    // and text prompt are left untouched (this is never a pose delete). updateItem goes through the
    // store's serialized write queue, so concurrent clears don't clobber each other's index writes.
    (async () => {
      try {
        const poseItems = await poseStore.listItems();
        const direct = poseId ? poseItems.find((p) => p.id === poseId) : null;

        if (direct) {
          await poseStore.updateItem(direct.id, { videoPrompt: '' });
          notify('Video prompt cleared — this pose won’t animate until you give it a new one', 'success');
          return;
        }

        // No poseId, or it pointed at a pose that no longer exists: there is no reliable single pose
        // to identify, so nothing in the Pose tab is touched — only this result's own copy is cleared.
        notify('Video prompt cleared on this result (no source pose found, so nothing there was changed)', 'success');
      } catch (err) {
        // The tile is already cleared regardless; surface the pose-write failure rather than swallow it.
        notify(`Cleared it here, but couldn't update the source pose: ${err?.message || 'unknown error'}`, 'error');
      }
    })();
  }, [results, poseStore, notify]);

  /**
   * DUPLICATE a result with a pasted-in video prompt — same image, same character, same outfit/pose,
   * as a brand NEW tile. The original is never touched: its own videoPrompt, video status and any
   * clip it already made stay exactly as they were. This is "give me a second copy of this image so
   * I can try a different video idea on it", not an edit of the one that's already there.
   *
   * regenerate/submitVideo are REBUILT to target the NEW uid rather than copied from the source —
   * copying the source's `regenerate` as-is would silently regenerate (overwrite the picture behind)
   * the ORIGINAL tile the first time it was pressed on the duplicate, since that closure was built
   * closing over the original's own uid. Rebuilt via generateComboRef + the persisted combo, the
   * exact same shape a RELOAD-rehydrated tile uses (see the rehydrate effect above) — a real,
   * already-exercised path, not a one-off hack.
   */
  const duplicateResultWithPrompt = useCallback((uid, text) => {
    const clean = String(text || '').trim();
    if (!clean) return;   // the Save button is disabled on empty; guard here too if ever called otherwise
    const src = results.find((r) => r.uid === uid);
    if (!src) return;
    const newUid = `eddy-res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Resolve the source pose NOW, from the ORIGINAL, before its videoPrompt is overwritten below.
    // resolveSourcePoseId's fallback path matches by videoPrompt TEXT when combo.poseId is missing or
    // stale — exactly the case for an older/rehydrated result — and that text is the very thing this
    // duplicate is about to replace. Left alone, the duplicate would carry a pasted prompt that
    // matches no pose's text, and favoriting it would dead-end with "generated without a saved pose"
    // even though the ORIGINAL still resolved fine. Baking the resolved id into combo.poseId (and the
    // legacy top-level poseId clearVideoPromptFor reads) fixes it for good, not just this once.
    const resolvedPoseId = resolveSourcePoseId(src, poses);
    const combo = { outfitId: src.combo?.outfitId ?? null, poseId: resolvedPoseId ?? src.combo?.poseId ?? null };
    setResults((prev) => [{
      ...src,
      uid: newUid,
      combo,
      poseId: resolvedPoseId ?? src.poseId ?? null,
      videoPrompt: clean,
      // A fresh copy has made no clip of its own — the ORIGINAL keeps whatever video status it had;
      // this one starts exactly like a brand-new, never-animated result.
      videoStatus: undefined,
      videoUrl: undefined,
      videoTaskId: undefined,
      videoError: undefined,
      regenerate: (tweak) => generateComboRef.current(combo, { tweak, replaceUid: newUid }),
      submitVideo: (job) => submitVideoJob(job, toVideoAspectRatio(src.aspectRatio || 'auto')),
    }, ...prev]);
    notify('Duplicated with your new video prompt ✨', 'success');
  }, [results, poses, notify, submitVideoJob]);

  /**
   * Resolves the jobs FIRST and parks them on the confirmation, so what is confirmed is exactly
   * what was quoted even if a second batch lands (or the selection changes) behind the dialog.
   *
   * Takes the uids rather than reading the selection, so a single tile's Generate video opens THE
   * SAME VideoConfirmGate — same quote, same clamp note, same already-animated "will be billed
   * again" line, same Cancel — scoped to one image. Per-tile animate costs money and gets exactly
   * the confirmation the bulk action gets; there is deliberately no second, cheaper-looking dialog.
   */
  const openVideoConfirmFor = useCallback((uids) => {
    const wanted = new Set(uids);
    const targets = results.filter((r) => wanted.has(r.uid) && !busyUids[r.uid]);
    const jobs = targets
      .filter((r) => r.videoPrompt && r.galleryId && r.submitVideo)
      .map((r) => ({ uid: r.uid, galleryId: r.galleryId, videoPrompt: r.videoPrompt, submitVideo: r.submitVideo }));
    const clips = jobs.map((j) => clipDurationFor(j.videoPrompt));
    setVideoConfirm({
      jobs,
      cost: clips.reduce((sum, c) => sum + c.seconds * VIDEO_PRICE_PER_SECOND, 0),
      // The per-clip lengths, so the gate can SHOW how many seconds each clip is (parsed from its
      // prompt) and why the price is what it is — a 6s clip is $0.90, a 10s clip $1.50. Without
      // this the user only saw a flat total and could not tell the price was per-second.
      clips: clips.map((c) => c.seconds),
      clamped: clips.filter((c) => c.clamped),
      skipped: targets.length - jobs.length,
      // Counted off the SAME resolved job list that is about to be dispatched, not off the live
      // selection — so the number the confirmation states is exactly the number of second clips
      // the user is about to be billed for, even if the selection changes behind the dialog.
      alreadyAnimated: targets.filter((r) => hasClip(r) && r.videoPrompt && r.galleryId && r.submitVideo).length,
    });
  }, [results, busyUids]);

  const openVideoConfirm = useCallback(
    () => openVideoConfirmFor([...selectedUids]),
    [openVideoConfirmFor, selectedUids],
  );

  const confirmVideo = useCallback(async () => {
    const pending = videoConfirm;
    // Closed before anything is dispatched, so the dialog cannot be double-confirmed by a second
    // click landing while the first submission is still in flight.
    setVideoConfirm(null);
    if (!pending?.jobs?.length) return;
    let started = 0;
    let failed = 0;
    // Capped at VIDEO_PARALLEL_REQUESTS — the separate, smaller ceiling, so raising the image cap
    // can never accidentally raise this one.
    await runPool(pending.jobs, VIDEO_PARALLEL_REQUESTS, async (job) => {
      setBusyUids((prev) => ({ ...prev, [job.uid]: 'Animating' }));
      setTileErrors((prev) => { const next = { ...prev }; delete next[job.uid]; return next; });
      try {
        // The batch's OWN submitVideo, so the clip uses the aspect ratio its image was made at.
        const res = await job.submitVideo(job);
        if (res?.ok) started += 1; else failed += 1;
      } catch (err) {
        // One clip failing to start leaves its image untouched and the rest of the pool running.
        failed += 1;
        setTileErrors((prev) => ({ ...prev, [job.uid]: err?.message || 'Video failed to start' }));
      } finally {
        setBusyUids((prev) => { const next = { ...prev }; delete next[job.uid]; return next; });
      }
    });
    if (started) notify(`${started} video${started === 1 ? '' : 's'} animating — watch the Generation Feed`, 'success');
    if (failed) notify(`${failed} video${failed === 1 ? '' : 's'} failed to start — the image${failed === 1 ? ' is' : 's are'} still saved`, 'error');
    // Selection and instruction survive here too, for the same reason as above.
  }, [videoConfirm, notify]);

  if (loading) return <div className="flex justify-center py-16"><Spinner size={28} /></div>;

  return (
    /* Two columns: set it up on the left, watch it arrive on the right.
     *
     * The right column occupies the space the shared Generation Feed used to hold before it was
     * hidden here — which is both where the user already looks for results and the "dead margin"
     * this page was left with when the feed went away.
     *
     * SCROLLING: at lg and up each column scrolls independently (`lg:overflow-y-auto` on both,
     * `lg:overflow-hidden` on the row) so results can be scrolled through while the form stays
     * exactly where it was. `min-h-0` on the columns is load-bearing — without it a flex item
     * refuses to shrink below its content and the columns grow instead of scrolling.
     *
     * BELOW lg the row becomes a single column and the page scrolls as one document again
     * (`overflow-y-auto` here, no per-column scroller). Two independently scrolling panes side by
     * side on a narrow screen would leave each one a few centimetres tall; stacking is the honest
     * answer at that width. App.jsx's SELF_SCROLL_PAGES is what gives this element a real height
     * to divide up in the first place.
     */
    <div ref={pageScrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto animate-in lg:flex-row lg:gap-5 lg:overflow-hidden">
      {/* LEFT — the setup form. Fixed width at lg+: it is a form, and a form stretched across a
          wide monitor is harder to read, not easier. The right column takes the rest.

          PIXELS, NOT REM, and measured rather than assumed: the app has a user-facing TEXT size
          control that moves the root font-size (20px on the machine this was checked on, = 1.25x).
          A rem width rides that multiplier, so `27rem` measured 600px and left the results column
          only 513px — the form ended up WIDER than the results on a page whose whole point is the
          results. A px width is immune to it. These are the same steps App.jsx uses for the
          control column on feed-dominant pages, so the two fixed columns in this app now match. */}
      {/* Width is USER-CONTROLLED (the Panel width buttons below) rather than the old fixed
          430/460px, because that fixed width was immune to the app's TEXT size control: turning
          type up made everything inside bigger while the column stayed the same, so the setup side
          just got more cramped. Driven by a CSS var so the value can live in state. */}
      <div
        ref={setupScrollRef}
        style={{ '--eddy-setup-w': `${setupWidth}px` }}
        className="w-full shrink-0 space-y-4 lg:w-[var(--eddy-setup-w)] lg:min-h-0 lg:overflow-y-auto lg:pr-2"
      >
      {/* Panel width — how much of the page the setup side takes. Stepped rather than a slider so
          it cannot land on a useless in-between value, and persisted so it survives a reload. */}
      <div className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2">
        <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">Panel width</span>
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSetupWidth((w) => Math.max(SETUP_W_MIN, w - SETUP_W_STEP))}
            disabled={setupWidth <= SETUP_W_MIN}
            className="h-8 w-8 rounded-md border border-zinc-600 bg-zinc-800 text-lg font-bold leading-none text-zinc-100 transition hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            title="Narrower"
          >
            −
          </button>
          <span className="w-16 text-center text-xs font-semibold text-zinc-300">{setupWidth}px</span>
          <button
            type="button"
            onClick={() => setSetupWidth((w) => Math.min(SETUP_W_MAX, w + SETUP_W_STEP))}
            disabled={setupWidth >= SETUP_W_MAX}
            className="h-8 w-8 rounded-md border border-zinc-600 bg-zinc-800 text-lg font-bold leading-none text-zinc-100 transition hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            title="Wider"
          >
            +
          </button>
        </span>
      </div>

      {/* The two source photos */}
      {/**
       * HIDDEN IN MAX OUTFIT.
       *
       * Neither slot does anything there. Each combo brings its own finished Library picture as
       * image 1 -- her body, her pose and her room are already in it -- so the main photo is
       * ignored, and the face close-up is redundant because that picture already IS her face. Two
       * large controls that change nothing sat above the one that matters (owner, 2026-08-09).
       */}
      {!maxOutfit && (
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">Photos</h3>
          {/* MODEL — a named {main photo, face close-up, build} set. Selecting one loads all three
              together, which is the point: the build has to travel with the model or Grace's
              "Very large" silently follows Sienna's photos in. */}
          <span className="flex items-center gap-2">
            {models.length > 0 && (
              <select
                value={activeModel}
                onChange={(e) => (e.target.value ? loadModel(e.target.value) : setActiveModel(''))}
                title="Load a saved model — photos and build together"
                className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1 text-xs text-zinc-300 cursor-pointer"
              >
                <option value="">Model…</option>
                {models.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
            )}
            <Btn variant="secondary" className="!rounded-lg !py-1 !px-3 !text-xs" onClick={saveModel}
              title="Save the current photos and build under a name">
              {activeModel ? `Save / update ${activeModel}` : 'Save as model'}
            </Btn>
            {activeModel && (
              <button type="button" onClick={deleteModel} title={`Delete ${activeModel}`}
                className="px-1 text-xs text-zinc-600 hover:text-red-400 cursor-pointer">×</button>
            )}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <ImageSlot
            title="1 · Main photo"
            hint="Her body, and the room this shot happens in"
            value={baseImage}
            onChange={setBaseImage}
            onPickFolder={(n) => n && setCharacterName(n)}
            dbName="eddy-slot-base"
            libraryStore={libraryStore}
            pickerDb="eddy-base"
            pickerLabel="Base"
            pickerFolders
          />
          <ImageSlot
            title="2 · Face close-up"
            hint="Optional — locks her face"
            value={faceImage}
            onChange={setFaceImage}
            dbName="eddy-slot-face"
            libraryStore={libraryStore}
            pickerDb="eddy-character"
            pickerLabel="Character"
            pickerFolders
            pickerRole="base"
            onPickFolder={(n) => n && setCharacterName(n)}
            pickerStrip
          />
        </div>
      </Card>
      )}

      {/* Pose + outfit slots — stacked vertically (pose on top, outfit below), each full width
          of the control column. Single-column grid instead of sm:grid-cols-2 so they sit one
          above another rather than side by side.
          data-picker-slots / data-picker-slot are hooks: a workspace CSS file can put the two
          side by side again and re-order them with `order` (see ziyad.css). */}
      <div data-picker-slots className="grid gap-3">
        {[
          // Max Outfit picks its SOURCES from the Library — a whole folder of finished Max Nano
          // results — instead of a pose. Same slot machinery, so it gets folder navigation, the
          // breadcrumb, subtree counts and Select-all for free.
          ...(maxOutfit
            ? [{ key: 'base', label: 'Photos to dress', picked: pickedBases, items: libItems, thumbs: libThumbs, folders: libItemFolders, store: libraryStore, favIds: favSets.base, empty: 'Nothing in Eddy · Library yet — generate some in Max Nano first.' }]
            : [{ key: 'pose', label: 'Pose', picked: pickedPoses, items: poses, thumbs: poseThumbs, folders: poseFolders, store: poseStore, favIds: favSets.pose, empty: 'Nothing in Eddy · Pose yet.' }]),
          ...(maxNano ? [] : [{ key: 'outfit', label: 'Outfit', picked: pickedOutfits, items: outfits, thumbs: outfitThumbs, folders: outfitFolders, store: outfitStore, favIds: favSets.outfit, empty: 'Nothing in Eddy · Outfit yet.' }]),
        ].map((slot) => {
          // What the grid is actually showing right now, computed ONCE and handed to both the
          // grid and the select-all button. The two must never disagree: a button that selects
          // items the grid is not showing would silently add poses from a folder you filtered out.
          // Favorite is a MOVE, not a copy: starring an item pulls it OUT of All and its folder so
          // it is never picked again by accident — it lives ONLY under the Favorite filter until
          // un-starred. So the two non-favorite views exclude favorited ids; the Favorite view is
          // the only place they appear. (Requested: "move them from any folder... i dont use them
          // again unless i click favorite".)
          const visible = favFilter[slot.key]
            ? slot.items.filter((i) => slot.favIds.has(i.id))
            : (folderFilter[slot.key]
              // Subtree, not an exact match: a parent whose items all sit in its children showed
              // an empty grid.
              ? (() => { const ids = subtreeOf(slot.folders, folderFilter[slot.key]);
                  return slot.items.filter((i) => ids.has(i.folderId) && !slot.favIds.has(i.id)); })()
              : slot.items.filter((i) => !slot.favIds.has(i.id)));
          const setPicked = slot.key === 'outfit' ? setPickedOutfits
            : slot.key === 'base' ? setPickedBases
            : setPickedPoses;
          const allVisiblePicked = visible.length > 0 && visible.every((i) => slot.picked.includes(i.id));
          return (
          <Card key={slot.key} data-picker-slot={slot.key} className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
                {slot.label} {slot.picked.length > 0 && <span className="text-rose-400">· {slot.picked.length}</span>}
              </h3>
              <span className="flex items-center gap-2">
                {/* Picking a whole folder one tile at a time is the slowest thing in this page —
                    60 poses is 60 clicks. Scoped to the CURRENT filter, not the whole collection,
                    so "All" plus this button is the only way to take everything; a folder chip
                    plus this button takes just that folder. Flips to Clear once everything on
                    screen is picked, so the same button undoes it. */}
                {openPickers[slot.key] && visible.length > 0 && (
                  <Btn variant="secondary" className="!rounded-lg !py-1 !px-3 !text-xs"
                    title={allVisiblePicked
                      ? `Unpick these ${visible.length}`
                      : `Pick all ${visible.length} shown${favFilter[slot.key] || folderFilter[slot.key] ? ' in this filter' : ''}`}
                    onClick={() => keepScroll(() => {
                      const ids = visible.map((i) => i.id);
                      setPicked((prev) => (allVisiblePicked
                        ? prev.filter((x) => !ids.includes(x))
                        // Existing picks from OTHER filters are kept — this adds, it does not replace.
                        : [...prev, ...ids.filter((id) => !prev.includes(id))]));
                    })}>
                    {allVisiblePicked ? 'Clear' : `Select all ${visible.length}`}
                  </Btn>
                )}
                {/* CLEAR ALL — drops every pick in this slot, whatever filter they were made under.
                    The button above only ever clears what is ON SCREEN, and only once all of it is
                    picked: with 3 of 60 chosen it reads "Select all 60" and there was no way back
                    short of unpicking each one by hand (owner, 2026-08-09). Shown whenever there is
                    something to clear, including while the picker is hidden — that is exactly when
                    a stale pick from an earlier session is easiest to miss. */}
                {slot.picked.length > 0 && (
                  <Btn variant="secondary" className="!rounded-lg !py-1 !px-3 !text-xs"
                    title={`Unpick all ${slot.picked.length} — including any picked under another folder or filter`}
                    onClick={() => keepScroll(() => setPicked([]))}>
                    Clear all
                  </Btn>
                )}
                <Btn variant="secondary" className="!rounded-lg !py-1 !px-3 !text-xs"
                  onClick={() => { if (!openPickers[slot.key]) loadAll(); setOpenPickers((o) => ({ ...o, [slot.key]: !o[slot.key] })); }}>
                  {openPickers[slot.key] ? 'Hide' : 'Choose'}
                </Btn>
              </span>
            </div>

            {/* THE PICKED LIST.
                Above COMPACT_PICKED it switches to a thumbnail grid. Sixty picked poses rendered as
                sixty 3-line rows is roughly a metre of scrolling between the picker and the
                Generate button — reported as exactly that ("for pose i scroll too much").
                The grid says the same thing (which ones, and remove) in a fraction of the height.

                And the text is poseSentence(), NOT it.prompt: a pose stores the whole JSON block,
                so these rows were showing three lines of `{"reference_priority": {"instruction":
                "This is the FIRST and MOST IMPORTANT rule…` — identical on every card and telling
                you nothing about which pose it is. Outfits keep their raw text, which IS prose. */}
            {slot.picked.length > 0 && (
              slot.picked.length > COMPACT_PICKED ? (
                <div className="flex flex-wrap gap-1.5">
                  {slot.picked.map((id) => (
                    <button key={id} type="button" title="Click to remove"
                      onClick={() => toggle(setPicked)(id)}
                      className="group relative h-12 w-12 shrink-0 overflow-hidden rounded-md bg-white/[0.04] cursor-pointer">
                      {slot.thumbs[id]
                        ? <img src={slot.thumbs[id]} alt="" loading="lazy" className="h-full w-full object-cover" />
                        : <span className="flex h-full w-full items-center justify-center text-[0.5rem] uppercase text-zinc-600">No pic</span>}
                      <span className="absolute inset-0 hidden items-center justify-center bg-black/70 text-sm font-bold text-red-300 group-hover:flex">×</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {slot.picked.map((id) => {
                    const it = slot.items.find((i) => i.id === id);
                    const label = slot.key === 'pose'
                      ? (poseSentence(it?.prompt) || 'No pose text — the picture carries it')
                      : (it?.prompt || 'Empty prompt');
                    return (
                      <div key={id} className="flex items-start gap-2 rounded-lg bg-white/[0.02] p-1.5">
                        {slot.thumbs[id]
                          ? <img src={slot.thumbs[id]} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-md object-cover bg-zinc-950" />
                          : <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-[0.5rem] uppercase text-zinc-600">No pic</span>}
                        <p className="line-clamp-3 text-[0.625rem] leading-tight text-zinc-400">{label}</p>
                        <button onClick={() => toggle(setPicked)(id)}
                          className="ml-auto shrink-0 px-1 text-xs text-zinc-600 hover:text-red-400 cursor-pointer" title="Remove">×</button>
                      </div>
                    );
                  })}
                </div>
              )
            )}

            {openPickers[slot.key] && (slot.folders.length > 0 || slot.favIds.size > 0) && (
              <div className="flex flex-wrap gap-1.5">
                {/* Favorite FILTER — a star-marked flag view across ALL folders, distinct from the
                    folder chips. Offered as soon as anything is starred (or there are folders). */}
                <button type="button"
                  onClick={() => setFavFilter((prev) => ({ ...prev, [slot.key]: !prev[slot.key] }))}
                  aria-pressed={favFilter[slot.key]}
                  title="Show only favorited — across every folder"
                  className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[0.625rem] font-semibold transition cursor-pointer',
                    favFilter[slot.key] ? 'border-rose-500 bg-rose-500/15 text-rose-300'
                                        : 'border-white/[0.07] bg-white/[0.02] text-zinc-400 hover:border-zinc-600')}>
                  <StarIcon filled={favFilter[slot.key]} /> Favorite <span className="text-zinc-600">{slot.items.filter((i) => slot.favIds.has(i.id)).length}</span>
                </button>
                {/* BREADCRUMB, then the CURRENT level only. Listing every folder flat is what turned
                      this into a wall of chips once subfolders existed; each crumb walks back up. */}
                  {pathTo(slot.folders, folderFilter[slot.key]).slice(0, -1).map((f) => (
                    <button key={`crumb-${f.id}`} type="button"
                      onClick={() => { setFolderFilter((prev) => ({ ...prev, [slot.key]: f.id })); setFavFilter((prev) => ({ ...prev, [slot.key]: false })); }}
                      className="rounded-full border border-white/[0.07] bg-white/[0.02] px-2.5 py-1 text-[0.625rem] font-semibold text-zinc-500 hover:border-zinc-600 cursor-pointer">
                      {f.name} ›
                    </button>
                  ))}
                  {[{ id: null, name: 'All' }, ...levelFor(slot.folders, folderFilter[slot.key])].map((f) => {
                    // A folder is active only while Favorite is OFF — the two are one exclusive view.
                    const active = folderFilter[slot.key] === f.id && !favFilter[slot.key];
                    // Counts span the SUBTREE, so a parent never reads 0 while its children hold the
                    // items. Favorited items stay excluded — they have MOVED to the Favorite view — so
                    // the badge equals what the grid actually shows.
                    const n = f.id
                      ? (() => { const ids = subtreeOf(slot.folders, f.id);
                          return slot.items.filter((i) => ids.has(i.folderId) && !slot.favIds.has(i.id)).length; })()
                      : slot.items.filter((i) => !slot.favIds.has(i.id)).length;
                    const kids = f.id ? childrenOfIn(slot.folders, f.id).length : 0;
                    return (
                      <button key={f.id || 'all'} type="button"
                        draggable={!!f.id}
                        onDragStart={() => f.id && setDragFolderId(f.id)}
                        onDragEnd={() => { setDragFolderId(null); setDropFolderId(null); }}
                        onDragOver={(e) => { if (dragFolderId && dragFolderId !== f.id) { e.preventDefault(); setDropFolderId(f.id || '__root'); } }}
                        onDragLeave={() => setDropFolderId(null)}
                        onDrop={(e) => { e.preventDefault(); moveFolderInSlot(slot.store, dragFolderId, f.id || null, loadAll); }}
                        title={f.id ? 'Drag onto another folder to nest it' : 'Drop a folder here to un-nest it'}
                        onClick={() => { setFolderFilter((prev) => ({ ...prev, [slot.key]: f.id })); setFavFilter((prev) => ({ ...prev, [slot.key]: false })); }}
                        className={cn('rounded-full border px-2.5 py-1 text-[0.625rem] font-semibold transition cursor-pointer',
                          dropFolderId === (f.id || '__root') ? 'border-rose-500 bg-rose-500/30 text-white'
                            : active ? 'border-rose-500/60 bg-rose-500/15 text-rose-300'
                                     : 'border-white/[0.07] bg-white/[0.02] text-zinc-400 hover:border-zinc-600')}>
                        {f.name} <span className="text-zinc-600">{n}</span>
                        {kids > 0 && <span className="ml-0.5 text-zinc-600">›{kids}</span>}
                      </button>
                    );
                  })}
              </div>
            )}

            {openPickers[slot.key] && (
              <PickerGrid
                items={visible}
                thumbs={slot.thumbs}
                selected={slot.picked}
                favIds={slot.favIds}
                onToggle={toggle(setPicked)}
                onToggleFavorite={(id) => togglePickFavorite(slot.store, id)}
                empty={slot.empty}
              />
            )}
          </Card>
          );
        })}
      </div>

      {/* Instruction — the only text you write */}
      <Card className="p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
          Instruction <span className="font-normal normal-case text-zinc-600">optional</span>
        </h3>
        <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setNsfw((v) => !v)}
          aria-pressed={nsfw}
          className={cn(
            'group flex items-center gap-3 rounded-xl border px-3 py-2 transition cursor-pointer',
            nsfw
              ? 'border-rose-500/60 bg-rose-500/10 shadow-[0_0_22px_-6px] shadow-rose-500/70'
              : 'border-white/[0.07] bg-white/[0.02] hover:border-zinc-600',
          )}
        >
          <span className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors',
            nsfw ? 'bg-rose-500' : 'bg-zinc-700')}>
            <span className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
              nsfw ? 'left-[22px]' : 'left-0.5',
            )} />
          </span>
          <span className="text-left leading-tight">
            <span className={cn('block text-sm font-bold tracking-wide',
              nsfw ? 'text-rose-300' : 'text-zinc-400')}>
              NSFW {nsfw ? 'ON' : 'OFF'}
            </span>
            <span className="block text-[0.625rem] text-zinc-500">
              {nsfw ? 'She is NUDE · files under Eddy NSFW' : 'She stays clothed'}
            </span>
          </span>
        </button>
        {/* FACELESS toggle — opt-in. ON lets a pose keep her face cropped out (honours the pose's
            framing); OFF copies the pose normally with her exact face. */}
        <button
          onClick={() => setFaceless((v) => !v)}
          aria-pressed={faceless}
          className={cn(
            'group flex items-center gap-3 rounded-xl border px-3 py-2 transition cursor-pointer',
            faceless
              ? 'border-rose-500/60 bg-rose-500/10 shadow-[0_0_22px_-6px] shadow-rose-500/70'
              : 'border-white/[0.07] bg-white/[0.02] hover:border-zinc-600',
          )}
        >
          <span className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors',
            faceless ? 'bg-rose-500' : 'bg-zinc-700')}>
            <span className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
              faceless ? 'left-[22px]' : 'left-0.5',
            )} />
          </span>
          <span className="text-left leading-tight">
            <span className={cn('block text-sm font-bold tracking-wide',
              faceless ? 'text-rose-300' : 'text-zinc-400')}>
              FACELESS {faceless ? 'ON' : 'OFF'}
            </span>
            <span className="block text-[0.625rem] text-zinc-500">
              {faceless ? 'Keep her face cropped out if the pose is' : 'Copy the pose, show her face'}
            </span>
          </span>
        </button>
        {/* OUTFIT PHOTO toggle. OFF is the long-standing default: the product shot is a garment on a
            mannequin, and sending it once made the bust render to the GARMENT's shape instead of
            hers. buildPrompt now states the counter-rule whenever the image is present, so this is
            offered as a real choice — ON when the garment has detail the words cannot carry
            (a print, an unusual cut), OFF when her figure matters more. Suppressed automatically
            with NSFW, where there is no garment to reproduce. */}
        <button
          onClick={() => setSendOutfitImage((v) => !v)}
          aria-pressed={sendOutfitImage}
          disabled={wantsNude}
          title={wantsNude
            ? 'Not used while she is undressed — there is no garment to send'
            : (sendOutfitImage
              ? 'The outfit product photo is sent with its description'
              : 'Only the outfit description is sent')}
          className={cn(
            'group flex items-center gap-3 rounded-xl border px-3 py-2 transition',
            wantsNude ? 'cursor-not-allowed opacity-40 border-white/[0.07] bg-white/[0.02]'
              : sendOutfitImage
                ? 'cursor-pointer border-rose-500/60 bg-rose-500/10 shadow-[0_0_22px_-6px] shadow-rose-500/70'
                : 'cursor-pointer border-white/[0.07] bg-white/[0.02] hover:border-zinc-600',
          )}
        >
          <span className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors',
            sendOutfitImage && !wantsNude ? 'bg-rose-500' : 'bg-zinc-700')}>
            <span className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
              sendOutfitImage && !wantsNude ? 'left-[22px]' : 'left-0.5',
            )} />
          </span>
          <span className="text-left leading-tight">
            <span className={cn('block text-sm font-bold tracking-wide',
              sendOutfitImage && !wantsNude ? 'text-rose-300' : 'text-zinc-400')}>
              OUTFIT PHOTO {sendOutfitImage && !wantsNude ? 'SENT' : 'NOT SENT'}
            </span>
            <span className="block text-[0.625rem] text-zinc-500">
              {sendOutfitImage && !wantsNude
                ? 'Photo + description — better garment accuracy'
                : 'Description only — safer for her figure'}
            </span>
          </span>
        </button>
        {/* POSE PHOTO toggle — governs the PAYLOAD only. ON sends the pose picture to the provider
            alongside its description (what this page has always done); OFF sends the one-sentence
            description alone and the picture never leaves your machine. The pose card keeps showing
            its image either way — this is not a "hide the thumbnail" switch.
            Worth actually A/B-ing: a picture carries arch depth and hand placement that one sentence
            cannot, but it also drags its own body along, which is what every BUST/BODY lock in
            buildPrompt is fighting. With it OFF those locks have no competing reference at all. */}
        <button
          onClick={() => setSendPoseImage((v) => !v)}
          aria-pressed={sendPoseImage}
          title={sendPoseImage
            ? 'The pose photo is uploaded with each generation'
            : 'Only the pose description is sent — the photo stays local'}
          className={cn(
            'group flex items-center gap-3 rounded-xl border px-3 py-2 transition cursor-pointer',
            sendPoseImage
              ? 'border-rose-500/60 bg-rose-500/10 shadow-[0_0_22px_-6px] shadow-rose-500/70'
              : 'border-white/[0.07] bg-white/[0.02] hover:border-zinc-600',
          )}
        >
          <span className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors',
            sendPoseImage ? 'bg-rose-500' : 'bg-zinc-700')}>
            <span className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
              sendPoseImage ? 'left-[22px]' : 'left-0.5',
            )} />
          </span>
          <span className="text-left leading-tight">
            <span className={cn('block text-sm font-bold tracking-wide',
              sendPoseImage ? 'text-rose-300' : 'text-zinc-400')}>
              POSE PHOTO {sendPoseImage ? 'SENT' : 'NOT SENT'}
            </span>
            <span className="block text-[0.625rem] text-zinc-500">
              {sendPoseImage ? 'Photo + description go to the model' : 'Description only — photo stays local'}
            </span>
          </span>
        </button>
        </div>
        </div>
        <div className="space-y-2">
          {INSTRUCTION_PRESETS.filter((g) => nsfw || !g.nsfwOnly).map((g) => (
            <div key={g.group} className="flex flex-wrap items-center gap-1.5">
              <span className="w-16 shrink-0 text-[0.625rem] font-semibold uppercase tracking-wider text-zinc-600">{g.group}</span>
              {g.chips.map(([label, text]) => (
                <button key={label} onClick={() => addChip(text)}
                  className="rounded-full border border-zinc-700/60 bg-white/[0.02] px-2.5 py-1 text-[0.6875rem] text-zinc-400 transition hover:border-rose-500/60 hover:text-white cursor-pointer">
                  + {label}
                </button>
              ))}
            </div>
          ))}
        </div>
        <Textarea rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)}
          placeholder="Tap a preset above, or describe it yourself…" className="!text-sm" />
      </Card>

      {/* The prompt that will actually be sent */}
      <Card className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">Final prompt</h3>
          {combos.length > 1 && <span className="text-[0.6875rem] text-zinc-600">first of {combos.length} — each combo differs</span>}
        </div>
        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white/[0.02] p-3 text-xs leading-relaxed text-zinc-400">
          {previewPrompt || 'Add the main photo to see the prompt.'}
        </p>
      </Card>

      {/* Settings + go */}
      <Card className="p-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Aspect Ratio" options={ASPECT_OPTIONS} value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} />
          <Select label="Resolution" options={RES_OPTIONS} value={resolution} onChange={(e) => setResolution(e.target.value)} />
        </div>
        {/* Lighting — 'Match photo' keeps image 1's own light; the others relight the scene with a
            soft, natural look while keeping the same background. */}
        <Select label="Lighting" options={LIGHTING_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} value={lighting} onChange={(e) => setLighting(e.target.value)} />
        {/* HER BUILD — per-character, and the reason it is a SELECT and not another BODY chip: it
            states her figure without setting wantsBody, so the bust-preservation locks stay ON.
            Grace sits on Large/Very large, a medium model on Medium; each keeps her own build held.
            Ignored while a BODY chip is active — a chip is an explicit change and wins. */}
        <Select label="Her build" options={BUILD_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} value={build} onChange={(e) => setBuild(e.target.value)} />

        {overCap && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            {perRunImages} images per run — Seedream takes {SEEDREAM_MAX_IMAGES}. Use fewer outfits or poses.
          </p>
        )}

        <p className="text-xs text-zinc-500">
          {pickedOutfits.length || 1} outfit{(pickedOutfits.length || 1) === 1 ? '' : 's'} × {pickedPoses.length || 1} pose{(pickedPoses.length || 1) === 1 ? '' : 's'} = <span className="text-zinc-300">{combos.length} image{combos.length === 1 ? '' : 's'}</span>
        </p>

          {/* Which KINDS those images are. The total alone cannot tell you whether the close-ups
              survived the pairing filter, and that is the number worth seeing before spending. */}
          {viewBreakdown && (
            <p className="text-xs text-zinc-500">
              {[['front', 'front'], ['back', 'back'], ['closeup', 'close-up']]
                .filter(([k]) => viewBreakdown[k])
                .map(([k, label]) => `${viewBreakdown[k]} ${label}`)
                .join('  ·  ')}
            </p>
          )}

        {/* There is deliberately no output-mode toggle here. Generation makes images, full stop —
            so the button below quotes images, and video is chosen per result once you can see what
            you would be animating. */}
        {/* Generates immediately — no confirm popup (user removed it). The price stays ON the button
            so the cost is still shown before the click; only the extra modal is gone. The VIDEO gate
            is untouched: video is the expensive path and still confirms per result. */}
        {/* ENGINE — the SAME page, run through a different image model. One page rather than a
            duplicated file so every fix to the pose/outfit/prompt logic lands on both engines at
            once; the two would otherwise drift, which is exactly how the pose-body-size fix ended
            up applied on one branch and not the other.
            Gemini routes through Nano Bypass, which selects Vertex on its own when credentials
            exist — no bypass flag is passed from here. Every other control on this page (pose
            photo toggle, Her build, NSFW, faceless, framing) is engine-agnostic and applies to
            both, because they all shape the PROMPT, not the request. */}
        {/* No engine choice in Max Nano — it is the whole point of the tab. A switch that cannot
            change anything is worse than no switch. */}
        {!maxNano && (
        <div className="flex gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
          {[['seedream', 'Seedream'], ['nano2', 'Nano Banana 2']].map(([id, label]) => (
            <button key={id} type="button" onClick={() => setEngine(id)} aria-pressed={engine === id}
              className={cn('flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition cursor-pointer',
                engine === id ? 'bg-rose-500/20 text-rose-300' : 'text-zinc-500 hover:text-zinc-300')}>
              {label}
            </button>
          ))}
        </div>
        )}
        {/* ONE OUTFIT PER PHOTO vs EVERY COMBINATION — a 10x decision, so it is a visible switch
            and not a hidden default. 81 photos x 5 outfits is 405 generations and about $18;
            rotation gives 81 and about $3.65, and is what the pipeline this mirrors actually does
            (least-used wins, no outfit repeats until every one has been used). */}
        {/* ANGLE-AWARE DEALING. cloth_swap_paired.py keeps three outfit pools and picks from
            the one matching the pose angle, because a front product photo swapped onto a shot taken
            from behind produces a garment that cannot exist. Kyros had the information and was
            ignoring it. */}
        {maxOutfit && outfitRotation && (
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5">
            <input type="checkbox" checked={smartMatch} onChange={(e) => setSmartMatch(e.target.checked)}
              className="mt-0.5 cursor-pointer accent-rose-500" />
            <span className="text-xs leading-relaxed text-zinc-400">
              <span className="font-semibold text-zinc-200">Smart pairing</span>
              {" — the friend's pipeline rules: photos are taken two at a time and each PAIR shares one outfit; a back shot gets a back outfit, a close-up gets a close-up one; and the least-used outfit always wins, so none repeats before the rest have had a turn."}
            </span>
          </label>
        )}
        {maxOutfit && (
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5">
            <input type="checkbox" checked={outfitRotation} onChange={(e) => setOutfitRotation(e.target.checked)}
              className="mt-0.5 cursor-pointer accent-rose-500" />
            <span className="text-xs leading-relaxed text-zinc-400">
              <span className="font-semibold text-zinc-200">One outfit per photo</span>
              {' — outfits are dealt round-robin, so each is used about equally. Uncheck to make EVERY '}
              <span className="text-zinc-300">photo x outfit</span> combination
              {pickedBases.length > 0 && pickedOutfits.length > 1 && (
                <span className="text-amber-300">
                  {` (${pickedBases.length} instead of ${pickedBases.length * pickedOutfits.length})`}
                </span>
              )}.
            </span>
          </label>
        )}
        {/* WHERE THIS BATCH LANDS, stated before you spend anything.
            The character name is invisible state -- it comes from whichever folder the photo you
            picked lives in -- and when it was empty every result quietly filed under the generic
            "Eddy" folder with nothing on screen disagreeing. That is exactly how a Grace batch
            ended up in "Eddy" (owner, 2026-08-09). */}
        <p className="text-center text-xs text-zinc-500">
          Saving into Library ›{' '}
          {characterName ? (
            <>
              {/* The FULL path this lands in, exactly as it reads in the Library. Her name alone
                  was not the answer: plain Eddy nests the engine under her, and the two Max tabs
                  file tab-first. A line that says "Grace" while the picture goes to
                  "Grace › Seedream" is the same invisible-state problem this banner exists to end. */}
              <span className="font-semibold text-rose-300">
                {/* Her name, on every tab. There is nothing above or below it any more. */}
                {characterName}
              </span>
              <button type="button" onClick={() => setCharacterName('')}
                title="File this batch in the generic folder instead"
                className="ml-1.5 text-zinc-600 hover:text-zinc-300 cursor-pointer">×</button>
            </>
          ) : (
            <span className="text-amber-300/90">
              {maxNano ? 'Max Nano' : maxOutfit ? 'Max Outfit' : (nsfw ? 'Eddy NSFW' : 'Eddy')}
              {' — no character picked, so these will not be filed under her name'}
            </span>
          )}
        </p>
        {/* Named, counted, and BLOCKING. A silent fallback here costs a whole batch of wrong
            swaps that you only notice by opening the images. */}
        {/* WARNS, does not block. Eddy is a cross product on purpose, so a partly-mismatched
            selection can still be exactly what you meant. Max Outfit blocks instead, because
            there the matching is automatic and a missing pool is a dead end. */}
        {eddyMismatches && (
          <div className="rounded-lg border border-sky-500/40 bg-sky-500/[0.07] p-3 text-xs leading-relaxed text-sky-200">
            <span className="font-semibold">{eddyMismatches.bad} pairing{eddyMismatches.bad === 1 ? '' : 's'} skipped — close-up and full-body do not mix.</span>
            <span className="mt-1 block text-sky-300/80">
              A close-up outfit has no lower half to give a full-body pose, and a full-body outfit gets
              cropped away by a close-up. Those combinations are not generated; the count on the button
              is what will actually run.
            </span>
          </div>
        )}
        {missingOutfitKinds.length > 0 && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.07] p-3 text-xs leading-relaxed text-amber-200">
            <span className="font-semibold">Pick an outfit for every kind of shot.</span>
            {missingOutfitKinds.map((k) => (
              <span key={k.view} className="mt-1 block">
                {k.count} {k.label} photo{k.count === 1 ? '' : 's'} selected, but no <span className="font-semibold">{k.label}</span> outfit —
                {k.view === 'closeup'
                  ? ' tick something from a "7. CloseUps" folder.'
                  : k.view === 'back'
                    ? ' tick something from a "- back" folder.'
                    : ' tick something from a "- front" folder.'}
              </span>
            ))}
            <span className="mt-1.5 block text-amber-300/80">
              Or untick those photos. Turning off Smart pairing also lets it run, but then a close-up can get a full-body garment.
            </span>
          </div>
        )}
        <Btn className="w-full" disabled={(maxOutfit ? !pickedBases.length : !baseImage) || overCap || missingOutfitKinds.length > 0} onClick={() => run()}>
          {/* NO DOLLAR FIGURE ON GEMINI, deliberately. seedreamCost prices Muapi's published
              Seedream rates; this repo has no ground truth for Gemini/Vertex image cost, and the
              amber money rule means a number shown here is read as authoritative. An absent price
              is honest; a guessed one is not. */}
          Generate {combos.length} image{combos.length === 1 ? '' : 's'} · ${totalCost.toFixed(3)}
        </Btn>
        {inFlight > 0 && (
          <div className="space-y-1.5">
            <p className="text-center text-xs text-zinc-500">
              {done}/{queued} done · {inFlight} batch{inFlight === 1 ? '' : 'es'} running, {parallelFor(engine)} at a time — start another whenever
            </p>
            {/* CANCEL — stops the QUEUE, not the requests already sent. Those are billed the moment
                they leave, so aborting them would pay for images you never see; they finish and are
                kept. Everything still waiting is never sent and never charged. Labelled to say so,
                because "Cancel" on a paid run has to be unambiguous about what it costs. */}
            <Btn variant="secondary" className="w-full !py-1.5 !text-xs" disabled={cancelling}
              onClick={() => { cancelRef.current = true; setCancelling(true); }}>
              {cancelling
                ? 'Cancelling — letting the in-flight ones finish…'
                : `Cancel the ${Math.max(0, queued - done)} not sent yet`}
            </Btn>
          </div>
        )}
        {/* The failures from the last run, and the one click that replays them. Shown once the
            batch is idle so it cannot be mistaken for live progress, and it survives until the
            retry succeeds or you dismiss it — a 60-image run that loses 8 is otherwise 8 images
            you cannot identify, let alone re-make without paying for all 60 again. */}
        {failedCombos.length > 0 && inFlight === 0 && (
          <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-2.5">
            <p className="text-xs text-amber-200/80">
              {failedCombos.length} image{failedCombos.length === 1 ? '' : 's'} failed
              <span className="text-amber-200/50"> · {failedCombos[0].message}</span>
            </p>
            <div className="flex gap-2">
              <Btn className="flex-1 !py-1.5 !text-xs" disabled={!baseImage}
                onClick={() => run(failedCombos.map((f) => f.combo))}>
                Retry {failedCombos.length} failed · ${(failedCombos.length * perImagePrice).toFixed(3)}
              </Btn>
              <Btn variant="secondary" className="!py-1.5 !px-3 !text-xs" onClick={() => setFailedCombos([])}>
                Dismiss
              </Btn>
            </div>
          </div>
        )}
      </Card>
      </div>

      {/* RIGHT — the results column, in the space the shared Generation Feed used to occupy.
          `flex-1` so the empty state fills the column rather than sitting as a short strip at the
          top of a tall blank area. */}
      <div className="flex w-full min-w-0 flex-1 flex-col lg:min-h-0 lg:overflow-y-auto">
        <div className="flex items-baseline justify-between gap-3 pb-2.5">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
            Results {results.length > 0 && <span className="font-normal text-zinc-600">· {results.length}</span>}
          </h3>
          {/* Selection is no longer the only route to anything — every tile carries its own
              actions — so this is now what it should always have been: an explicitly offered tool
              for acting on MANY at once, named on screen rather than left to be discovered by
              clicking a picture and seeing what happens. Paired with the empty checkbox drawn on
              every tile, a user can tell tiles are selectable without selecting one. */}
          {results.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              {/* Select all — always selects everything (no longer a toggle, since Unselect below is
                  the explicit deselect that also works on a PARTIAL selection, which the toggle could
                  not). */}
              <button
                type="button"
                onClick={() => setSelectedUids(new Set(results.map((r) => r.uid)))}
                disabled={anyBusy}
                className={cn(HDR_BTN, GATE_FOCUS,
                  anyBusy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-zinc-500')}
              >
                Select all {results.length}
              </button>
              {/* Unselect — shown whenever ANY tile is ticked (partial OR full), so a selection can
                  always be cleared without first selecting everything. Names the count so it is clear
                  what will be deselected. */}
              {selectedUids.size > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedUids(new Set())}
                  disabled={anyBusy}
                  className={cn(HDR_BTN, 'border-rose-400 bg-rose-500/20 text-rose-200', GATE_FOCUS,
                    anyBusy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-rose-500/30')}
                >
                  Unselect ({selectedUids.size})
                </button>
              )}
              {/* Clear all — empties the whole results panel in one go (the images stay in the
                  Library, same promise as a single Remove). Confirmed, since it drops the working
                  queue; routed through removeUids so the persistence store is updated too. */}
              <button
                type="button"
                onClick={() => { if (window.confirm(`Remove all ${results.length} from the results panel? Your images stay in the Library.`)) removeUids(results.map((r) => r.uid)); }}
                disabled={anyBusy}
                className={cn(HDR_BTN, GATE_FOCUS,
                  anyBusy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-red-400 hover:text-red-300')}
              >
                Clear all
              </button>
              {/* SEND TO LIBRARY — files the ticked results (or all of them) into a Library folder
                  and clears them out of this panel. A MOVE, not a copy: see fileToLibrary. */}
              <button
                type="button"
                onClick={openFilePicker}
                disabled={anyBusy || !results.length}
                title="Move these into a Library folder and clear them from here"
                className={cn(HDR_BTN, GATE_FOCUS,
                  anyBusy || !results.length ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-zinc-400 hover:text-zinc-200')}
              >
                Send {selectedResults.length || results.length} to Library
              </button>
              {/* RELOAD IMAGES — re-requests every tile's picture. Not a page refresh: the results
                  column, the selection and the pending queue all survive, which a browser reload
                  would throw away. For the case where a fetch stalled or failed and the tile is
                  stuck on "Loading…" with nothing to click. */}
              <button
                type="button"
                onClick={() => setImgNonce((n) => n + 1)}
                title="Re-request every image — use if tiles are stuck on Loading…"
                className={cn(HDR_BTN, GATE_FOCUS, 'cursor-pointer hover:border-zinc-400 hover:text-zinc-200')}
              >
                Reload images
              </button>
              {/* DOWNLOAD ALL — saves every result: its VIDEO when it has one, else its image. Same
                  metadata-clean path as a tile's own Download, so a bulk save is never the raw file. */}
              <button
                type="button"
                onClick={() => downloadResults(results)}
                disabled={downloading}
                className={cn(HDR_BTN, 'border-rose-400 bg-rose-500 text-white', GATE_FOCUS,
                  downloading ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-rose-400')}
              >
                {downloading ? 'Downloading…' : `Download all ${results.length}`}
              </button>
              <p className={cn('text-xs', GATE_MUTED)}>or tick any image to act on several</p>
              {/* The size control, copied from EddyCollection's "Per row" buttons (its exact 2–6
                  range, sizing and active/inactive styling) so it reads as the same control the
                  other Eddy tabs already have. It sets the results grid's tile size by driving the
                  column count in the inline style below. */}
              <span className="flex items-center gap-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">Per row</span>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <button key={n} type="button" onClick={() => setResultCols(n)}
                    className={cn('h-8 w-8 rounded-md border text-sm font-bold transition cursor-pointer',
                      resultCols === n ? 'border-rose-400 bg-rose-500 text-white'
                                       : 'border-zinc-600 bg-zinc-800 text-zinc-200 hover:border-zinc-500')}>
                    {n}
                  </button>
                ))}
              </span>
            </div>
          )}
        </div>

        {/* FEATURE 1 — the "Static camera" toggle. Placed in the results/video column because it
            governs every Generate-video dispatch on this page. Same pill-and-knob shape as the NSFW
            toggle above (reused verbatim), in a neutral sky accent — NOT amber, which is money only.
            Default ON; the sub-line states what it does so a locked-off camera is never a surprise. */}
        <button
          type="button"
          onClick={() => setStaticCamera((v) => !v)}
          aria-pressed={staticCamera}
          className={cn(
            'group mb-2.5 flex w-full items-center gap-3 rounded-xl border px-3 py-2 transition cursor-pointer',
            staticCamera
              ? 'border-sky-500/50 bg-sky-500/10'
              : 'border-white/[0.07] bg-white/[0.02] hover:border-zinc-600',
          )}
        >
          <span className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors',
            staticCamera ? 'bg-sky-500' : 'bg-zinc-700')}>
            <span className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
              staticCamera ? 'left-[22px]' : 'left-0.5',
            )} />
          </span>
          <span className="text-left leading-tight">
            <span className={cn('block text-sm font-bold tracking-wide',
              staticCamera ? 'text-sky-300' : 'text-zinc-400')}>
              Static camera — no movement/zoom {staticCamera ? 'ON' : 'OFF'}
            </span>
            <span className="block text-[0.625rem] text-zinc-500">
              {staticCamera
                ? 'Every video is dispatched with a locked-off camera — only the subject moves'
                : 'Videos may pan, tilt, zoom or drift as the prompt describes'}
            </span>
          </span>
        </button>

        {/* Announced once for the whole column rather than per tile — N identical placeholder
            elements announcing themselves individually is noise, which is why PendingTile is
            aria-hidden. */}
        <p className="sr-only" role="status" aria-live="polite">
          {pendingCount > 0
            ? `${pendingCount} image${pendingCount === 1 ? '' : 's'} generating, ${results.length} finished`
            : `${results.length} result${results.length === 1 ? '' : 's'}`}
        </p>

        {results.length === 0 && pendingCount === 0 ? (
          /* A real empty state, not a blank column. Before this the right-hand space simply
              looked broken until the first batch finished. */
          <div className={cn(
            'flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-8 text-center',
            GATE_HAIRLINE,
          )}>
            <p className={cn('text-xs font-semibold', GATE_TEXT)}>Nothing generated yet</p>
            <p className={cn('max-w-xs text-[0.6875rem] leading-relaxed', GATE_MUTED)}>
              {/* Names the actions in the same words the tile buttons use, and no longer tells the
                  user to select first — selection is for acting on several at once, not the way in. */}
              Set up the photos, outfit and pose on the left, then press Generate. Images arrive
              here as they finish, each with its own Regenerate, Generate video and Remove.
            </p>
          </div>
        ) : (
        <div className="space-y-3">
          {/* Columns come from the "Per row" size control via inline style — Tailwind cannot emit a
              dynamic grid-cols-${n}. Same `repeat(n, minmax(0, 1fr))` shape EddyCollection's grid uses. */}
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${resultCols}, minmax(0, 1fr))` }}>
            {/* Placeholders lead the grid because new results are PREPENDED — so each image that
                lands takes the slot a placeholder just vacated and every tile already on screen
                keeps its exact position. The cell count never changes mid-batch, which is what
                stops the grid reflowing while work is in flight.

                Keyed by index on purpose: these are interchangeable empty slots with no identity
                and no state, so a stable positional key is exactly right here and avoids
                remounting the whole run of them each time one is removed. */}
            {Array.from({ length: pendingCount }, (_, i) => <PendingTile key={`pending-${i}`} />)}
            {results.slice(0, shown).map((r) => {
              // Resolved once above via resultSourcePoseIds (combo.poseId, or a videoPrompt text-match
              // fallback for older/rehydrated results with no combo) — a plain Map read, not a store call.
              const srcPoseId = resultSourcePoseIds.get(r.uid);
              return (
              <ResultTile
                // Keyed by uid, NOT by galleryId: a regenerate replaces the galleryId, and a key
                // that changes under an in-place swap remounts the tile and loses its scroll
                // position — the reflow this flow exists to avoid.
                key={r.uid}
                item={r}
                // The saved server copy, which is what exists after a regenerate too. base64Data
                // is only a fallback for whatever the response happened to carry.
                // imgNonce is appended so "Reload images" produces a URL the browser has not
                // cached, which is the only way to make it re-request a picture it believes it
                // already has (or already failed on). Left off entirely at nonce 0 so the normal
                // URL stays cacheable across renders.
                src={r.galleryId
                  ? `${galleryApi.imageUrl(r.galleryId)}${imgNonce ? `${galleryApi.imageUrl(r.galleryId).includes('?') ? '&' : '?'}r=${imgNonce}` : ''}`
                  : (r.base64Data ? `data:${r.mimeType || 'image/png'};base64,${r.base64Data}` : null)}
                /* What the GRID shows. A locally-held base64 result has no server copy to
                   thumbnail, so it falls through to the full one -- there are only ever a
                   handful of those, from the pre-gallery path. */
                thumbSrc={r.galleryId
                  ? `${galleryApi.thumbUrl(r.galleryId)}${imgNonce ? `${galleryApi.thumbUrl(r.galleryId).includes('?') ? '&' : '?'}r=${imgNonce}` : ''}`
                  : null}
                selected={selectedUids.has(r.uid)}
                busy={busyUids[r.uid]}
                error={tileErrors[r.uid]}
                // Filled iff THIS result's SOURCE pose (srcPoseId — combo.poseId, or the videoPrompt
                // fallback match) is favorited — read from the same favSets.pose the pose picker uses.
                // A result with no resolvable source pose reads un-favorited; clicking its star then
                // hits the honest "no source pose" soft error rather than a fake success.
                favorited={srcPoseId ? favSets.pose.has(srcPoseId) : false}
                onToggleFavorite={() => toggleResultFavorite(r)}
                onToggle={() => toggleResult(r.uid)}
                openLightbox={lightboxUid === r.uid}
                onOpenLightbox={() => setLightboxUid(r.uid)}
                onCloseLightbox={() => setLightboxUid(null)}
                onStepLightbox={results.length > 1 ? stepLightbox : undefined}
                lightboxPos={`${results.findIndex((x) => x.uid === r.uid) + 1} / ${results.length}`}
                // Each scoped to this ONE result and routed through the same three functions the
                // bulk bar calls — so a lone result is fully operable without ever being selected,
                // and there is no second implementation of any of them to drift.
                onRegenerate={(text) => regenerateUids([r.uid], text)}
                onAnimate={() => openVideoConfirmFor([r.uid])}
                onRemove={() => removeUids([r.uid])}
                onClearVideoPrompt={() => clearVideoPromptFor(r.uid)}
                onDuplicateWithPrompt={(text) => duplicateResultWithPrompt(r.uid, text)}
              />
              );
            })}
          </div>

            {/* Nothing is hidden — only unmounted. The button says exactly how many are waiting, so
                a long run never looks truncated. */}
            {results.length > shown && (
              <button
                type="button"
                onClick={() => setShown((n) => n + RESULTS_PAGE)}
                className={cn('mt-3 w-full rounded-xl border py-2.5 text-sm font-semibold', GATE_HAIRLINE, GATE_PANEL, GATE_FOCUS,
                  'cursor-pointer text-zinc-300 hover:border-zinc-500')}
              >
                Show {Math.min(RESULTS_PAGE, results.length - shown)} more
                <span className={cn('ml-2 font-normal', GATE_MUTED)}>
                  {shown.toLocaleString()} of {results.length.toLocaleString()} shown
                </span>
              </button>
            )}

          {/* The action bar. Only exists while something is selected: with nothing picked it would
              be a dead strip of controls permanently eating the height the images need. Sticky so
              it stays reachable while scrolling a long results grid.

              It appears BELOW the grid and never between the tiles, so selecting something can
              never reflow the images themselves. */}
          {selectedResults.length > 0 && (
            <div className={cn(
              'sticky bottom-3 z-30 space-y-2.5 rounded-xl border p-3 backdrop-blur',
              GATE_HAIRLINE, 'bg-[#101017]/95',
            )}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className={GATE_EYEBROW}>{selectedResults.length} selected</p>
                <button
                  type="button"
                  onClick={() => setSelectedUids(new Set())}
                  disabled={anyBusy}
                  className={cn(
                    'rounded text-[0.625rem] underline underline-offset-2 transition',
                    GATE_FOCUS, GATE_MUTED,
                    anyBusy ? 'cursor-not-allowed' : 'cursor-pointer hover:text-[#e8e8f0]',
                  )}
                >
                  Clear
                </button>
              </div>

              {/* One-tap fills for the box below. Same chip pattern and the SAME preset text the
                  main instruction panel uses — a correction phrased differently to the thing that
                  generated the image is a new bug source. Filtered by the page's own nsfw toggle,
                  so undress chips never appear inside a clothed run. */}
              <div className="space-y-1.5">
                {INSTRUCTION_PRESETS
                  .filter((g) => BAR_PRESET_GROUPS.includes(g.group) && (nsfw || !g.nsfwOnly))
                  .map((g) => (
                    <div key={g.group} className="flex flex-wrap items-center gap-1.5">
                      <span className={cn('w-14 shrink-0', GATE_EYEBROW)}>{g.group}</span>
                      {g.chips.map(([label, text]) => (
                        <button
                          key={label}
                          type="button"
                          // Appends rather than replaces, and never twice — tapping two chips
                          // builds one instruction, and a double-tap is a misclick, not a request
                          // to say it again. Mirrors addChip on the main panel.
                          onClick={() => addBarChip(text)}
                          disabled={anyBusy}
                          className={cn(
                            'rounded-full border px-2.5 py-1 text-[0.6875rem] transition',
                            GATE_FOCUS, GATE_HAIRLINE,
                            anyBusy
                              ? cn('cursor-not-allowed', GATE_MUTED)
                              : cn('cursor-pointer', GATE_MUTED, 'hover:border-white/25 hover:text-[#e8e8f0]'),
                          )}
                        >
                          + {label}
                        </button>
                      ))}
                    </div>
                  ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={barInstruction}
                  onChange={(e) => setBarInstruction(e.target.value)}
                  // Enter regenerates: typing the fix and then hunting for the button is the slow
                  // half of a three-attempt retry loop. It deliberately does NOT trigger video —
                  // Enter must never be a route to the expensive action.
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !anyBusy) { e.preventDefault(); regenerateSelected(); }
                  }}
                  disabled={anyBusy}
                  placeholder="What to change on all of them? (optional)"
                  title="Left empty, Regenerate re-rolls the same prompts exactly as before."
                  className={cn(
                    'min-w-[12rem] flex-1 rounded-lg border bg-black/30 px-2.5 py-2 text-xs outline-none transition placeholder:text-[#5a5a67]',
                    GATE_FOCUS,
                    anyBusy
                      ? cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED)
                      : cn(GATE_HAIRLINE, GATE_TEXT, 'focus:border-white/25'),
                  )}
                />
                <button
                  type="button"
                  onClick={regenerateSelected}
                  disabled={anyBusy}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-xs font-medium transition',
                    GATE_FOCUS,
                    anyBusy
                      ? cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED)
                      : cn('cursor-pointer', GATE_HAIRLINE, GATE_TEXT, 'hover:border-white/25'),
                  )}
                >
                  {/* Every figure through the same Money component — which is what keeps the amber
                      rule mechanically true rather than a convention someone has to remember. */}
                  {anyBusy ? 'Working…' : <>Regenerate {selectedResults.length} <Money amount={regenTotal} decimals={3} className="text-xs" /></>}
                </button>
                <button
                  type="button"
                  onClick={openVideoConfirm}
                  disabled={anyBusy || animatable.length === 0}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-xs font-medium transition',
                    GATE_FOCUS,
                    anyBusy || animatable.length === 0
                      ? cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED)
                      : cn('cursor-pointer', GATE_HAIRLINE, GATE_TEXT, 'hover:border-white/25'),
                  )}
                >
                  Generate video {animatable.length > 0 && <>{animatable.length} <Money amount={videoTotal} decimals={3} className="text-xs" /></>}
                </button>
                {/* Delete. Last in the row and pushed away from the two spending buttons by
                    `ml-auto`, because it is the one action here you do NOT want to hit while
                    hammering Regenerate. It carries no dollar figure — nothing is billed and
                    nothing is refunded — so there is no Money component and, per the amber rule,
                    no amber. The muted red appears on hover/focus only: a permanently red control
                    in a bar you use constantly reads as a warning that is always shouting. */}
                {/* Download the SELECTED ones — video where a tile has one, image otherwise. Sits
                    before Remove so the destructive control keeps its ml-auto spot at the far end. */}
                <button
                  type="button"
                  onClick={() => downloadResults(selectedResults)}
                  disabled={downloading}
                  title="Saves these — the video when a tile has one, otherwise the image. Metadata removed."
                  className={cn(
                    'rounded-lg border px-3 py-2 text-xs font-semibold transition',
                    GATE_FOCUS,
                    downloading
                      ? 'cursor-not-allowed border-white/[0.05] opacity-60 text-zinc-400'
                      : 'cursor-pointer border-zinc-600 bg-zinc-800 text-zinc-100 hover:border-zinc-500',
                  )}
                >
                  {downloading ? 'Downloading…' : `Download ${selectedResults.length}`}
                </button>
                <button
                  type="button"
                  onClick={removeSelected}
                  disabled={anyBusy}
                  title="Clears these from the results list. The images stay in your Library."
                  className={cn(
                    'ml-auto rounded-lg border px-3 py-2 text-xs font-medium transition',
                    GATE_FOCUS,
                    anyBusy
                      ? cn('cursor-not-allowed border-white/[0.05]', GATE_MUTED)
                      : cn('cursor-pointer', GATE_HAIRLINE, GATE_MUTED, 'hover:border-[#d4736d]/50 hover:text-[#d4736d]'),
                  )}
                >
                  Remove {selectedResults.length}
                </button>
              </div>

              {/* Says outright what Delete does and does not touch. The whole reason this action is
                  safe is that it is list-only, and a user who cannot tell that from the button will
                  either avoid it or be alarmed by it — so it is stated in the bar, every time,
                  rather than hidden in a tooltip. */}
              <p className={cn('text-[0.625rem] leading-relaxed', GATE_MUTED)}>
                Remove clears {selectedResults.length === 1 ? 'it' : 'them'} from this list only —
                {selectedResults.length === 1 ? ' the image stays' : ' the images stay'} in your
                Library and can be found there any time.
              </p>

              {/* Said in the bar as well as in the confirmation. A selected image that cannot
                  animate is stated outright rather than quietly excluded from the count — and
                  never billed a default duration to make it fit. */}
              {notAnimatable > 0 && (
                <p className={cn('text-[0.625rem] leading-relaxed', GATE_MUTED)}>
                  {notAnimatable} of these {notAnimatable === 1 ? 'has' : 'have'} no video prompt on
                  their pose and cannot be animated
                  {animatable.length === 0 ? ' — add one on the Pose card to animate them.' : ' — they are not included above.'}
                </p>
              )}
            </div>
          )}
        </div>
        )}
      </div>

      {/* FOLDER PICKER for Send to Library. Parent scope, beside the other page-level overlays —
          it reads results/selectedResults/libraryStore, none of which exist inside a tile.
          Writes into the SAME store the Library tab reads, so a folder made here shows up there. */}
      {filingTo && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/70 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setFilingTo(false); }}>
          <div className={cn('w-full max-w-sm space-y-2 rounded-2xl border p-4', GATE_HAIRLINE, GATE_PANEL)}>
            <h3 className="text-sm font-semibold text-zinc-200">
              Send {selectedResults.length || results.length} image{(selectedResults.length || results.length) === 1 ? '' : 's'} to…
            </h3>
            <p className={cn('text-xs', GATE_MUTED)}>They move into the Library and leave this panel. The pictures are not deleted.</p>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {libFolders.map((f) => (
                <button key={f.id} type="button"
                  onClick={() => fileToLibrary(f.id, selectedResults.length ? selectedResults : results)}
                  className="w-full rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-left text-xs text-zinc-300 hover:border-rose-500/60 cursor-pointer">
                  {f.name}
                </button>
              ))}
              {!libFolders.length && <p className={cn('px-1 py-2 text-xs', GATE_MUTED)}>No folders yet — make one below.</p>}
            </div>
            <div className="flex gap-2 pt-1">
              <Btn variant="secondary" className="flex-1 !py-1.5 !text-xs"
                onClick={async () => {
                  const name = (window.prompt('New Library folder name:') || '').trim();
                  if (!name) return;
                  try {
                    const f = await libraryStore.ensureFolder(name);
                    await fileToLibrary(f.id, selectedResults.length ? selectedResults : results);
                  } catch (err) { notify(err?.message || 'Could not make that folder', 'error'); }
                }}>
                + New folder
              </Btn>
              <Btn variant="ghost" className="!py-1.5 !px-3 !text-xs" onClick={() => setFilingTo(false)}>Cancel</Btn>
            </div>
          </div>
        </div>
      )}

      {videoConfirm && (
        // Cancelling simply drops the parked jobs — setVideoConfirm(null) is the only thing that
        // happens, and submitVideo is never reached, so zero video requests are dispatched.
        <VideoConfirmGate
          clipCount={videoConfirm.jobs.length}
          cost={videoConfirm.cost}
          clips={videoConfirm.clips}
          clampedClips={videoConfirm.clamped}
          skipped={videoConfirm.skipped}
          alreadyAnimated={videoConfirm.alreadyAnimated}
          onConfirm={confirmVideo}
          onCancel={() => setVideoConfirm(null)}
        />
      )}

    </div>
  );
}
