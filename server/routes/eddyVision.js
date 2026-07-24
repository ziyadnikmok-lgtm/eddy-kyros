const express = require('express');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiBackend');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

/**
 * Turns a dropped picture into the prompt that goes with it, so Eddy's Outfit and Pose tabs
 * fill themselves in instead of being typed by hand.
 *
 * geminiService routes to Vertex or direct Gemini depending on what is configured — this does
 * not care which.
 */
// The prompt shape the Seedream pose flows expect. Only pose_action.description and
// subject.features are written per image; everything else is constant so identity stays pinned.
const POSE_TEMPLATE = {
  "reference_priority": {
    "instruction": "This is the FIRST and MOST IMPORTANT rule: Use reference @image1 as the strict, exact base for the entire subject. Use close up reference @image2 as exact base for the face of the girl. Keep identical: face, hair, body proportions, skin tone, outfit, and all details from the reference. Do NOT change face, body type, proportions, skin tone, or hair under ANY circumstances. Perfect match required.",
    "priority": "highest"
  },
  "subject": {
    "features": "<her facial expression and gaze, read from the photo>",
    "body": {
      "physique": "Toned athletic figure"
    }
  },
  "wardrobe": {
    "clothing": "Same outfit as reference image"
  },
  "pose_action": {
    "description": "<THE POSE \u2014 the one field that must be written from the photo>"
  },
  "scene": {
    "environment": "Same background and setting as the reference image",
    "atmosphere": "Confident influencer moment, fully SFW"
  },
  "lighting": {
    "setup": "Soft ambient lighting with highlights on skin and outfit that matches the reference image",
    "shadows": "Soft flattering shadows"
  },
  "camera": {
    "camera": "Made on Iphone 16 pro",
    "aspect_ratio": "3:4",
    "settings": "High quality, sharp details, cinematic, 8k"
  },
  "negative_constraints": [
    "no distorted proportions",
    "no extra limbs",
    "no different face or hair",
    "no different outfit",
    "no low quality, no blur, no artifacts"
  ]
};

const BRIEFS = {
  // An outfit reference is usually a product shot: a garment on a mannequin, flat on a bed, or
  // worn. Only the CLOTHING matters — describing the body or setting would drag them into the
  // generation as if they were requested.
  outfit: [
    'Look at this photo of a clothing item.',
    'Describe ONLY the garment, in one or two sentences, so it can be recreated on a different person.',
    'Cover: type of garment, colour, fabric and transparency, cut and neckline, straps or fastenings, any lace, embroidery or pattern, and length.',
    'Do NOT describe the mannequin, the body, the person, the background, the bedding or any label or watermark.',
    'Do not start with "This is" — just describe the garment. No preamble, no quotes.',
  ].join(' '),
  // Returns coordinates, not prose. The client blurs the region on canvas — Gemini cannot edit
  // an image here, but it can say where the face is, which is all that is needed.
  facebox: [
    'Look at this photo and find the human face.',
    'Reply with ONLY a JSON object: {"x0":0.0,"y0":0.0,"x1":0.0,"y1":0.0}',
    'The values are the bounding box of the face as fractions of image width and height,',
    'where x0,y0 is the top-left corner and x1,y1 the bottom-right.',
    'Include the whole head: hair, forehead, chin and jaw, with a little margin.',
    'If there is no visible face, reply exactly: {"none":true}',
    'No explanation, no markdown, no code fences — just the JSON object.',
  ].join(' '),
  // An environment reference is a PLACE. Describing the person in it would leak a body into a
  // prompt whose only job is the room.
  environment: [
    'Look at this photo of a location.',
    'Describe ONLY the place in one or two sentences, so the same setting could be rebuilt.',
    'Cover: the room or location type, key furniture and surfaces, wall and floor materials, the light source and its mood, and the time of day.',
    'Do NOT describe any person, their clothing, their pose or their face.',
    'No preamble, no quotes.',
  ].join(' '),
  // A pose comes back as the full JSON prompt shape the Seedream flows already use, not prose:
  // the sheet importer reads pose_action.description out of exactly this structure, so a
  // described pose and an imported one end up identical.
  //
  // Only two fields are written from the picture — the pose itself and her expression. The rest
  // is fixed boilerplate that pins identity to the reference images, and letting the model
  // rewrite it would quietly weaken every generation using that pose.
  pose: [
    'Look at this photo and describe the POSE.',
    'Reply with ONLY a JSON object in exactly this shape, no markdown and no code fences:',
    JSON.stringify(POSE_TEMPLATE),
    'Fill "pose_action.description" with a precise description of her body position, written so',
    'someone else could recreate it: stance or kneel or recline, back arch, where each arm and',
    'hand is, leg and knee position, foot position, head tilt and gaze direction. One flowing',
    'sentence, no bullet points.',
    'Fill "subject.features" with her facial expression, gaze and makeup only.',
    'Copy EVERY other field exactly as given — do not reword, translate or add fields.',
    'Do NOT describe her clothing, the background or the lighting anywhere: those fields already',
    'say to take them from the reference image.',
    'Output must be valid JSON that parses.',
  ].join(' '),
};

// How long a reply each brief is allowed to produce.
//
// WHY THIS IS PER-KIND AND NOT ONE NUMBER: a single blind `text.slice(0, 600)` used to be applied
// to every kind. That size was written for the prose briefs, and nobody re-checked it when the
// pose brief was changed to return the JSON template. The template alone stringifies to ~1295
// chars and `pose_action.description` — the ONE field that carries the pose — begins at index 640,
// i.e. 40 chars past the old cut. Every pose ever described was therefore stored as a 599-char
// fragment that could not parse and contained no pose at all, and the client pasted that fragment
// into the generation prompt where its `reference_priority` block ("do NOT change ... under ANY
// circumstances") fought the page's own "recreate her pose EXACTLY". The cap is now derived from
// what each brief actually asks for.
const POSE_TEMPLATE_JSON = JSON.stringify(POSE_TEMPLATE);

// outfit/environment ask for "one or two sentences"; 600 is already several times that, and a
// prose reply longer than this is padding rather than detail.
const PROSE_LIMIT = 600;

// The pose brief asks for the whole template back with two placeholder fields rewritten from the
// photo. Derived rather than guessed: the template as sent, plus 2000 chars of headroom for those
// two fields (the longest genuine description across the 118 saved pose cards is 361). A reply
// past this is not a more detailed pose, it is the model ignoring "ONLY a JSON object" and adding
// commentary or code fences, which is exactly what a cap should catch.
const POSE_LIMIT = POSE_TEMPLATE_JSON.length + 2000;

const RESPONSE_LIMITS = {
  outfit: PROSE_LIMIT,
  environment: PROSE_LIMIT,
  // A bounding box is ~50 chars. The cap here is a pure abuse guard, never a real ceiling.
  facebox: PROSE_LIMIT,
  pose: POSE_LIMIT,
};

// Prose survives being cut mid-sentence — it is still usable text. Structured replies do not: a
// truncated object parses as nothing, and saving the pieces is how a silent fragment became a
// competing instruction set in the first place. So for the JSON-shaped briefs an over-length
// reply is refused outright and nothing is stored, rather than being trimmed to fit.
const JSON_KINDS = new Set(['pose', 'facebox']);

/**
 * POST /api/eddy/describe
 * Body: { image: base64 | dataUrl, mimeType, kind: 'outfit' | 'pose' }
 * -> { text, declined, reason? }
 */
router.post('/describe', async (req, res, next) => {
  try {
    const { image, mimeType, kind } = req.body || {};
    if (!image || typeof image !== 'string') throw new AppError('"image" base64 is required', 400, 'VALIDATION_ERROR');
    if (!mimeType || typeof mimeType !== 'string') throw new AppError('"mimeType" is required', 400, 'VALIDATION_ERROR');

    // Resolved once and reused for the cap below, so the brief that was sent and the limit it is
    // measured against can never disagree.
    const briefKind = BRIEFS[kind] ? kind : 'outfit';
    const brief = BRIEFS[briefKind];
    const m = image.match(/^data:image\/\w+;base64,(.+)$/);
    const base64 = m ? m[1] : image;

    const apiKey = apiKeyManager.getActiveKeyOrNull();
    if (!apiKey && !apiKeyManager.shouldUseVertexBackend?.()) {
      throw new AppError('Add a Gemini or Vertex key to let the AI read the image', 400, 'GEMINI_KEY_REQUIRED');
    }

    const raw = await geminiService.analyzeImageWithPrompt(apiKey, base64, mimeType, brief);
    const text = String(typeof raw === 'string' ? raw : raw?.text || '')
      .trim()
      .replace(/^["'\s-]+|["'\s]+$/g, '');

    // The vision model can refuse a revealing garment. Say so plainly rather than saving an
    // empty prompt that would silently weaken every generation using this item.
    if (!text || text.length < 12) {
      return res.json({ success: true, data: { text: '', declined: true } });
    }

    const limit = RESPONSE_LIMITS[briefKind];
    if (text.length > limit) {
      // Told plainly, with the numbers, because the alternative is what this whole route did
      // before: hand back something that looks like a prompt and is not one.
      if (JSON_KINDS.has(briefKind)) {
        return res.json({
          success: true,
          data: {
            text: '',
            declined: true,
            reason: `The AI replied with ${text.length} characters where a ${briefKind} needs at most ${limit}. Nothing was saved — try again.`,
          },
        });
      }
      return res.json({ success: true, data: { text: text.slice(0, limit), declined: false } });
    }

    res.json({ success: true, data: { text, declined: false } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
