const express = require('express');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiBackend');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

// How each vibe is described to the vision model. Body-position language only — the pose is
// what changes; the model's identity, outfit and setting are preserved by the Seedream prompt.
const VIBE_BRIEF = {
  playful: 'playful and flirty — light, fun, cute energy',
  sexy: 'sexy and confident — strong, alluring, magazine-style',
  horny: 'aroused and wanting — heavy-lidded, flushed, needy energy',
  sexual: 'overtly sexual and suggestive — bold and provocative body positioning',
};

/**
 * POST /api/pose-remix/suggest
 * Body: { image: base64, mimeType, vibe }
 * Looks at the photo and returns ONE pose tailored to it, so the pose suits her actual
 * outfit, body and setting instead of coming from a generic list.
 */
router.post('/suggest', async (req, res, next) => {
  try {
    const { image, mimeType, vibe } = req.body || {};
    if (!image || typeof image !== 'string') throw new AppError('"image" base64 is required', 400, 'VALIDATION_ERROR');
    if (!mimeType || typeof mimeType !== 'string') throw new AppError('"mimeType" is required', 400, 'VALIDATION_ERROR');

    const brief = VIBE_BRIEF[vibe] || VIBE_BRIEF.sexy;
    let base64 = image;
    const m = image.match(/^data:image\/\w+;base64,(.+)$/);
    if (m) base64 = m[1];

    const apiKey = apiKeyManager.getActiveKeyOrNull();
    if (!apiKey && !apiKeyManager.shouldUseVertexBackend?.()) {
      throw new AppError('Add a Gemini or Vertex key to let the AI read the photo', 400, 'GEMINI_KEY_REQUIRED');
    }

    const prompt = [
      'You are a photographer directing a model for her next shot.',
      'Look at this photo of a woman.',
      `Suggest ONE ${brief} pose for her that suits her actual outfit, body and the setting in the photo.`,
      'Reply with ONE sentence describing ONLY her body position: stance or kneel or lying, back arch, hand placement, head tilt and gaze.',
      'Do not describe the background, do not mention clothing changes, no preamble, no explanation, no quotes.',
    ].join(' ');

    const raw = await geminiService.analyzeImageWithPrompt(apiKey, base64, mimeType, prompt);
    const text = String(typeof raw === 'string' ? raw : raw?.text || '').trim().replace(/^["'\s-]+|["'\s]+$/g, '');

    // The vision model can decline a suggestive brief. Report that plainly so the client can
    // fall back to its built-in pose list rather than sending an empty pose to Seedream.
    if (!text || text.length < 12) {
      return res.json({ success: true, data: { pose: null, declined: true } });
    }

    res.json({ success: true, data: { pose: text.slice(0, 400), declined: false } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
