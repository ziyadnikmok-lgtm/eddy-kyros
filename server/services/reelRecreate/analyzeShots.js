'use strict';

// Per-shot Gemini analysis + recreate-prompt builder for the Instagram-reel pipeline
// (Phase 1, Task 4). detectShots now samples at 200ms and dedups into distinct BASE images; the
// route converts those bases into the per-shot shape below (one shot per base, black base ->
// kind:'black'), so "shot" here means "one base image to recreate". For each base's keyframe we ask
// describe the frame as strict JSON, then turn that description into a Seedream "Scene Recreate"
// prompt whose IDENTITY comes ONLY from the user's Character reference images — the source frame
// is a scene blueprint, never a face reference.
//
// SAFETY CONTRACT (load-bearing): buildRecreatePrompt must NEVER emit wording that tells the model
// to copy/keep the source frame's face. The only place "face" may appear is in the negative
// "do not take the face from the source" rule. This is the whole point of the recreate pipeline:
// no code path may render the source person. See SceneRecreateSeedreamPage.jsx for the wording
// contract this mirrors (identity from refs, scene from source, "recreate her pose exactly",
// source person is an anonymous stand-in whose appearance is discarded).

const fs = require('node:fs');
const sharp = require('sharp'); // existing dep — same one detectShots uses for hashing
const { FRAME_INTERVAL_SEC } = require('./detectShots');

// The instruction sent to Gemini alongside each keyframe. We demand STRICT JSON so the reply is
// machine-parseable; the parser below still tolerates a malformed reply rather than throwing.
const ANALYSIS_PROMPT = [
  'You are analysing a single frame from an Instagram reel to help recreate its SCENE (not its person).',
  'Return ONLY strict JSON with exactly these keys and no extra text:',
  '{ "sceneDescription": "", "pose": "", "outfit": "", "onScreenText": "" }',
  '',
  'For the single main person in the frame:',
  '- "pose": her exact pose, stance, gesture and action.',
  '- "outfit": what she is wearing (garment type, colour, cut, coverage).',
  '- "sceneDescription": the background/setting, the framing and crop, and the camera angle/lens.',
  '- "onScreenText": any on-screen caption, emoji or text overlay, transcribed VERBATIM. Use "" if there is none.',
  '',
  'Describe only what you see. Do not add commentary. Output the JSON object and nothing else.',
].join('\n');

// A BLACK-SLIDE frame carries no scene/pose/outfit to recreate — the ONLY thing to salvage is its
// on-screen text/emoji, which Phase 2 re-renders onto the black slide. We ask ONLY for that, so the
// reply is a short verbatim string (no JSON to parse, nothing describing a person). Empty is valid.
const BLACK_TEXT_PROMPT = [
  'This is a single frame from an Instagram reel: a solid black slide whose only content is on-screen text and/or emoji.',
  'Transcribe ONLY the on-screen text and emoji shown on this frame, VERBATIM.',
  'Do not describe the frame, do not add quotes, labels, punctuation or commentary of your own.',
  'If the frame has no text at all, reply with nothing (an empty response).',
].join('\n');

/**
 * PURE. Pull the verbatim on-screen text out of the BLACK_TEXT_PROMPT reply. The prompt asks for
 * plain text, but Gemini sometimes wraps it in a code fence or a `{ "onScreenText": "…" }` object,
 * so we peel both before falling back to the trimmed raw reply. Returns '' for an empty/blank reply.
 *
 * @param {string} reply raw Gemini reply
 * @returns {string}
 */
function parseBlackSlideText(reply) {
  const raw = String(reply || '').trim();
  if (!raw) return '';
  const unfenced = raw.replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/, '').trim();
  // If it happens to be JSON with an onScreenText field, prefer that.
  const m = unfenced.match(/"onScreenText"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
  return unfenced;
}

/**
 * PURE. Compose the Seedream Scene-Recreate prompt from a parsed analysis.
 *
 * Identity is locked to the user's Character (the reference images sent FIRST to Seedream); the
 * source frame (sent LAST) is a SCENE BLUEPRINT ONLY. The wording mirrors
 * SceneRecreateSeedreamPage.jsx's buildSceneInstruction.
 *
 * INVARIANT: the returned string contains the sceneDescription, the pose, the literal phrase
 * "scene blueprint", and NO instruction to copy/keep the source frame's face — the word "face"
 * only ever appears in the negative "do not take the face from the source" rule.
 *
 * @param {{sceneDescription?:string,pose?:string,outfit?:string,onScreenText?:string}} analysis
 * @returns {string}
 */
function buildRecreatePrompt(analysis) {
  const a = analysis && typeof analysis === 'object' ? analysis : {};
  const scene = String(a.sceneDescription || '').trim() || 'a natural, flattering setting';
  const pose = String(a.pose || '').trim() || 'her natural pose from the source frame';
  const outfit = String(a.outfit || '').trim();

  // The earlier images = the Character (identity); the last image = the source frame (scene only).
  const parts = [
    'The reference images are the user\'s Character and are the ONLY identity reference — her likeness, body and appearance come entirely from those reference images.',
    // "scene blueprint" is the load-bearing phrase asserted by the verify step and the safety contract.
    'The LAST image is the SOURCE FRAME: a scene blueprint only. Use it for scene layout, framing and pose composition — NEVER as an identity reference.',
    `Recreate her pose exactly: ${pose}.`,
    outfit
      ? `Place her in this scene: ${scene}. She is wearing: ${outfit}.`
      : `Place her in this scene: ${scene}.`,
    // Negative identity rule — the ONLY mention of "face" in the whole prompt, and it forbids
    // taking it from the source. Never invert this into a copy instruction.
    'Identity is non-negotiable and comes only from the Character reference images. Do NOT take the face, facial structure, skin tone, hair or body from the source frame — that person is an anonymous stand-in whose appearance must be discarded completely. Wherever the source frame and the reference images disagree, the reference images win 100%.',
    'Photorealistic: real pores, natural hair strands, fabric weave, slight asymmetry. No plastic skin, no CGI look.',
  ];
  return parts.join('\n\n');
}

/**
 * PURE. Coerce a parsed JSON object into the analysis shape, or null if it carries none of the
 * meaningful fields (scene/pose/outfit). null means "reply parsed but was not usable".
 */
function normalizeAnalysis(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const out = {
    sceneDescription: s(obj.sceneDescription),
    pose: s(obj.pose),
    outfit: s(obj.outfit),
    onScreenText: s(obj.onScreenText),
  };
  // A reply with no scene, pose AND outfit tells us nothing to recreate — treat as unusable.
  if (!out.sceneDescription && !out.pose && !out.outfit) return null;
  return out;
}

/**
 * PURE. Parse Gemini's reply into an analysis object, or null if truly unparseable.
 *
 * Path 1: strict JSON.parse of the first {...} block (after stripping any ```json fences).
 * Path 2 (fallback): pull each field out with a regex — mirrors the malformed-JSON recovery in
 * client/src/lib/poseText.js, so a reply with a stray/missing comma still yields fields instead
 * of throwing. A reply that yields no usable field at all returns null (caller flags it).
 */
function parseAnalysis(reply) {
  const raw = String(reply || '').trim();
  if (!raw) return null;
  // Strip a leading/trailing markdown code fence Gemini often wraps JSON in.
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  // Path 1 — strict JSON.
  const block = unfenced.match(/\{[\s\S]*\}/);
  if (block) {
    try {
      const normalized = normalizeAnalysis(JSON.parse(block[0]));
      if (normalized) return normalized;
    } catch {
      // Malformed JSON (bad comma, unquoted value, …) — fall through to the regex recovery.
    }
  }

  // Path 2 — regex field recovery (same shape as poseText.js's fallback).
  const field = (name) => {
    const m = unfenced.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim() : '';
  };
  const recovered = {
    sceneDescription: field('sceneDescription'),
    pose: field('pose'),
    outfit: field('outfit'),
    onScreenText: field('onScreenText'),
  };
  if (recovered.sceneDescription || recovered.pose || recovered.outfit) return recovered;

  // Truly unparseable (e.g. a refusal sentence with no JSON) — the caller sets analysis: null.
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// TIMED OVERLAY-TEXT TRACK
//
// These reels hold ONE base photo while an OVERLAY animates on top: a counter that ticks up
// (17→18→19→20→21) and rotating emoji, changing every ~100-200ms. The old pipeline read the
// on-screen text ONCE per base and burned that single frozen value over the whole clip. To animate
// it we sample at 100ms (detectShots) and, PER FRAME, read the overlay TEXT — but calling Gemini on
// all ~115 frames would be ~115 vision bills for a track that only changes a handful of times.
//
// So we DEDUP FIRST: hash a crop of the OVERLAY REGION each frame and only call Gemini when that
// region CHANGES from the last frame we read; for unchanged frames we carry the previous text
// forward. Emoji are STRIPPED here (they're a separate later task — a compositing pass, not
// drawtext), so the track carries only the counter digits and any caption words. The result is a
// list of contiguous {startSec,endSec,text} segments the assembly stage renders with timed
// drawtext, so the burned text changes at the right timestamps instead of freezing on one value.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// The overlay region to hash for change-detection: full width, the upper-middle band (y 22%–52%).
// WHY this band: in these "counting" reels the numbers sit over the subjects' heads and the centred
// counter/emoji cluster all live in that band; the lower half is the mostly-static base photo whose
// compression flicker would trigger false changes. Hashing just the band raises signal (overlay
// ticks) over noise (base jpeg wobble). Fractions of the frame so it's resolution-independent.
const OVERLAY_REGION = { left: 0, top: 0.22, width: 1, height: 0.30 };

// dHash side length for the overlay crop. 16 → a 17x16 downscale = 256 bits. Higher than the base
// dedup's 8 because a one-digit counter tick (17→18) is a SMALL, localized change; 256 bits over the
// narrow band gives enough resolution that a single changed digit moves several bits.
const OVERLAY_HASH_SIZE = 16;

// A crop whose grayscale dHash moves more than this many bits from the last-read frame counts as a
// CHANGED overlay → one Gemini read. Tuned on the reference mia reel: 4/256 catches every counter
// tick (and the emoji-cluster changes) while ignoring base jpeg flicker. Lower = more sensitive =
// more (redundant) calls that merge back to the same text; higher can miss a fast tick. 4 gave 18
// reads over that reel's 115 frames (≈6.5x fewer than one-call-per-frame). grayscale, so the
// mid-reel colour→B&W filter switch does NOT count as a text change (same luminance structure).
const OVERLAY_HASH_THRESHOLD = 4;

// Hard ceiling on Gemini vision reads for ONE track, so a pathological reel whose overlay changes
// every single frame can't bill 240 vision calls. Past the cap we STOP reading and carry the last
// text forward, logging that we capped — never a silent freeze. 60 comfortably covers a normal
// reel's distinct overlay states.
const MAX_TEXT_CALLS = 60;

// The prompt for reading ONE frame's overlay text. We ask for the counter/number and any caption
// words ONLY — explicitly NOT the emoji (handled by a separate task) and NOT a description of the
// photo. A short verbatim string; empty is valid (a frame with no overlay text).
const OVERLAY_TEXT_PROMPT = [
  'This is one frame from an Instagram reel. On top of the photo there is animated overlay text —',
  'usually a number or counter, and sometimes a few caption words.',
  'Transcribe ONLY that overlay text: the number(s) and any words drawn ON TOP of the image.',
  'Do NOT include emoji. Do NOT describe the photo, the people, or the scene.',
  'If several numbers are shown, list them separated by single spaces in reading order.',
  'If there is no overlay text at all, reply with nothing (an empty response).',
].join('\n');

/**
 * PURE. Strip color-emoji (and their joiners/modifiers) from a text string. Mirrors the same
 * removal assembleReel.sanitizeOverlayText does at burn time — done here too so the TRACK itself
 * carries only counter/words (emoji are a separate compositing task). Kept local (a tiny pure regex)
 * rather than importing assembleReel, which would drag in galleryManager/videoHistory for no reason.
 *
 * @param {string} text
 * @returns {string} text with emoji removed and collapsed whitespace trimmed
 */
function stripEmoji(text) {
  const src = typeof text === 'string' ? text : '';
  const emojiRe = /[\p{Extended_Pictographic}‍️\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]/gu;
  return src.replace(emojiRe, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Compute a GRAYSCALE dHash of the overlay-region CROP of one frame, using sharp. Same dHash idea as
 * detectShots.computeFrameHash but over an extracted band, so it tracks the overlay, not the whole
 * frame. Region fractions are converted to integer pixels bounded to the image so extract never
 * throws on rounding.
 *
 * @param {string} imgPath
 * @param {{left:number,top:number,width:number,height:number}} region  fractions of the frame
 * @param {number} size  dHash side length
 * @returns {Promise<number[]>} size*size bit array
 */
async function computeOverlayHash(imgPath, region = OVERLAY_REGION, size = OVERLAY_HASH_SIZE) {
  const meta = await sharp(imgPath).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  // Clamp the crop to the image bounds (rounding can push a fraction one pixel past the edge).
  const left = Math.min(W - 1, Math.max(0, Math.round(region.left * W)));
  const top = Math.min(H - 1, Math.max(0, Math.round(region.top * H)));
  const width = Math.max(1, Math.min(W - left, Math.round(region.width * W)));
  const height = Math.max(1, Math.min(H - top, Math.round(region.height * H)));
  const raw = await sharp(imgPath)
    .extract({ left, top, width, height })
    .grayscale()
    .resize(size + 1, size, { fit: 'fill' })
    .raw()
    .toBuffer();
  const hash = [];
  const rowStride = size + 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      hash.push(raw[y * rowStride + x] > raw[y * rowStride + x + 1] ? 1 : 0);
    }
  }
  return hash;
}

/**
 * PURE. Hamming distance between two equal-length bit arrays. (Local copy so this module doesn't
 * depend on detectShots' hamming; both are trivial and pure.)
 */
function bitDistance(a, b) {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  return d + Math.abs(a.length - b.length);
}

/**
 * PURE. Collapse a per-frame text array into contiguous {startSec,endSec,text} segments — one
 * segment per run of frames sharing the SAME text. Empty-text runs are dropped (no overlay =
 * nothing to burn). Times are the frames' real video times; the first segment is clamped to start at
 * 0 (the overlay is on screen from the reel start even though sampling begins at 0.1s) and the last
 * segment's end is clamped to totalDuration.
 *
 * @param {Array<{timeSec:number, text:string}>} perFrame  ordered by time
 * @param {number} frameInterval  seconds each sample covers
 * @param {number|null} totalDuration  reel length to clamp the final segment to
 * @returns {Array<{startSec:number,endSec:number,text:string}>}
 */
function collapseTextSegments(perFrame, frameInterval, totalDuration) {
  const segs = [];
  for (let i = 0; i < perFrame.length; i++) {
    const f = perFrame[i];
    const last = segs.length ? segs[segs.length - 1] : null;
    // Extend the current segment's end to cover this frame's interval.
    const end = Number((f.timeSec + frameInterval).toFixed(3));
    if (last && last.text === f.text) {
      last.endSec = end;
    } else {
      // First segment starts at reel 0 (overlay is up from the start); others at their real time.
      const start = segs.length === 0 ? 0 : f.timeSec;
      segs.push({ startSec: start, endSec: end, text: f.text });
    }
  }
  // Clamp the last segment to the reel length, and drop empty-text segments (nothing to burn).
  if (segs.length && totalDuration != null) {
    segs[segs.length - 1].endSec = Math.min(segs[segs.length - 1].endSec, Number(totalDuration));
  }
  return segs.filter((s) => s.text && s.endSec > s.startSec);
}

/**
 * Build the TIMED overlay-text track for a reel from its 100ms sampled frames. Dedups on an
 * overlay-region crop hash so Gemini is called ONLY when the overlay text region changes; unchanged
 * frames carry the last text forward. Emoji are stripped from every read. Returns the collapsed
 * segments plus how many Gemini reads it actually took (for cost transparency).
 *
 * @param {Array<{index:number,timeSec:number,keyframePath:string}>} frames  detectShots().frames
 * @param {string|null} apiKey
 * @param {{service?:object, region?:object, hashThreshold?:number, hashSize?:number,
 *          frameInterval?:number, totalDuration?:number, maxCalls?:number}} [opts]
 * @returns {Promise<{textTrack:Array<{startSec:number,endSec:number,text:string}>, geminiCalls:number, capped:boolean}>}
 */
async function buildTextTrack(frames, apiKey, opts = {}) {
  const gemini = opts.service || require('../geminiVertexService');
  const region = opts.region || OVERLAY_REGION;
  const hashThreshold = Number.isFinite(opts.hashThreshold) ? opts.hashThreshold : OVERLAY_HASH_THRESHOLD;
  const hashSize = Number.isFinite(opts.hashSize) ? opts.hashSize : OVERLAY_HASH_SIZE;
  const frameInterval = Number.isFinite(opts.frameInterval) ? opts.frameInterval : FRAME_INTERVAL_SEC;
  const totalDuration = Number.isFinite(opts.totalDuration) ? opts.totalDuration : null;
  const maxCalls = Number.isFinite(opts.maxCalls) ? opts.maxCalls : MAX_TEXT_CALLS;

  const list = Array.isArray(frames) ? frames : [];
  const perFrame = [];
  let refHash = null;     // crop hash of the last frame we READ (called Gemini on)
  let curText = '';       // text of that last read, carried forward for unchanged frames
  let geminiCalls = 0;
  let capped = false;

  for (const f of list) {
    let changed = false;
    let hash = null;
    try {
      hash = await computeOverlayHash(f.keyframePath, region, hashSize);
      // First frame always reads; later frames read only when the crop moved past the threshold.
      changed = refHash === null || bitDistance(hash, refHash) > hashThreshold;
    } catch (err) {
      // A crop-hash failure must NOT silently freeze the track: treat the frame as CHANGED so we
      // re-read it (up to the cap), and log why. Better one extra read than a stale carried value.
      log().warn('reel_texttrack_hash_failed', { index: f.index, error: err && err.message ? err.message : String(err) });
      changed = true;
    }

    if (changed) {
      if (geminiCalls >= maxCalls) {
        // Cost ceiling hit: stop calling and carry the last text forward. Loud, not silent.
        if (!capped) log().warn('reel_texttrack_call_cap', { maxCalls, note: 'overlay changed past cap — carrying last text forward' });
        capped = true;
      } else {
        try {
          const b64 = fs.readFileSync(f.keyframePath).toString('base64');
          const reply = await gemini.analyzeImageWithPrompt(apiKey, b64, 'image/jpeg', OVERLAY_TEXT_PROMPT);
          // Reuse the black-slide plain-text peeler (handles fences / stray JSON), then strip emoji.
          curText = stripEmoji(parseBlackSlideText(reply));
          geminiCalls++;
          if (hash) refHash = hash; // advance the reference only on a successful read
        } catch (err) {
          // A failed read keeps the previous text (no worse than a carry-forward) but is recorded.
          log().warn('reel_texttrack_read_failed', { index: f.index, error: err && err.message ? err.message : String(err) });
          if (hash) refHash = hash; // still advance so we don't re-hit the same failing frame forever
        }
      }
    }
    perFrame.push({ timeSec: f.timeSec, text: curText });
  }

  const textTrack = collapseTextSegments(perFrame, frameInterval, totalDuration);
  log().info('reel_texttrack_built', { frames: list.length, geminiCalls, segments: textTrack.length, capped });
  return { textTrack, geminiCalls, capped };
}

// Lazy logger require so the pure helpers above stay require-cheap for extract-run verification.
function log() { return require('../../utils/logger'); }

/**
 * Analyse every shot. Each returned shot gains `analysis` ({sceneDescription,pose,outfit,onScreenText}
 * or null) and `recreatePrompt` (string, or null when analysis is null). A shot whose analysis
 * cannot be parsed is FLAGGED (`analysisFailed: true`, `analysisError`) and kept — never dropped.
 *
 * @param {Array} shots  one shot per base (from basesToShots(detectShots().bases)), each with a keyframePath
 * @param {string|null} apiKey  from apiKeyManager.getActiveKeyOrNull()
 * @param {{service?:object}} [deps]  inject a stub geminiService for verification (no live bill)
 * @returns {Promise<Array>}
 */
async function analyzeShots(shots, apiKey, { service } = {}) {
  // Default to the singleton; injectable so the verify step can stub the reply and avoid billing.
  const gemini = service || require('../geminiVertexService');
  const out = [];
  for (const shot of Array.isArray(shots) ? shots : []) {
    // ── BLACK SLIDE ─────────────────────────────────────────────────────────────
    // A black shot has no scene/pose/outfit to describe and is NEVER sent to Seedream, so we skip
    // the full scene analysis (saving that Gemini call's descriptive work) and only read the
    // on-screen text so Phase 2 can re-render it. recreatePrompt is null: the money path filters on
    // it — a null prompt is a shot that cannot be, and never is, billed to Seedream.
    if (shot.kind === 'black') {
      let onScreenText = '';
      let textError = null;
      try {
        const b64 = fs.readFileSync(shot.keyframePath).toString('base64');
        const reply = await gemini.analyzeImageWithPrompt(apiKey, b64, 'image/jpeg', BLACK_TEXT_PROMPT);
        onScreenText = parseBlackSlideText(reply);
      } catch (err) {
        // A failed text read is NOT a failed shot: the slide is still a valid (free) black slide,
        // just without recovered text. Record why, but keep analysisFailed:false — nothing here can
        // mis-bill, and the user can type the overlay text in by hand.
        textError = err && err.message ? err.message : 'black-slide text read failed';
      }
      out.push({
        ...shot,
        analysis: { sceneDescription: 'black slide', pose: '', outfit: '', onScreenText },
        recreatePrompt: null,
        analysisFailed: false,
        ...(textError ? { analysisError: textError } : {}),
      });
      continue;
    }

    // ── NORMAL IMAGE SHOT ───────────────────────────────────────────────────────
    let analysis = null;
    let analysisError = null;
    try {
      const b64 = fs.readFileSync(shot.keyframePath).toString('base64');
      const reply = await gemini.analyzeImageWithPrompt(apiKey, b64, 'image/jpeg', ANALYSIS_PROMPT);
      analysis = parseAnalysis(reply);
      if (!analysis) analysisError = 'Gemini reply could not be parsed into analysis fields';
    } catch (err) {
      // Loud, not silent: keep the shot but record WHY it has no analysis so the UI can flag it.
      analysisError = err && err.message ? err.message : 'analysis failed';
    }
    out.push({
      ...shot,
      analysis,
      recreatePrompt: analysis ? buildRecreatePrompt(analysis) : null,
      analysisFailed: !analysis,
      // Only set when something went wrong, so a healthy shot stays clean.
      ...(analysis ? {} : { analysisError }),
    });
  }
  return out;
}

module.exports = {
  buildRecreatePrompt, analyzeShots, parseAnalysis, normalizeAnalysis, parseBlackSlideText,
  ANALYSIS_PROMPT, BLACK_TEXT_PROMPT,
  // Timed overlay-text track (+ pure helpers exported for extract-run verification).
  buildTextTrack, collapseTextSegments, stripEmoji, computeOverlayHash, bitDistance,
  OVERLAY_REGION, OVERLAY_HASH_SIZE, OVERLAY_HASH_THRESHOLD, MAX_TEXT_CALLS, OVERLAY_TEXT_PROMPT,
};
