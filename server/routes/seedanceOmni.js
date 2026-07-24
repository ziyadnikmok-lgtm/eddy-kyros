const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const router = express.Router();

// Shared by both backends (Vertex inline + Gemini Files API) so the analysis is identical.
const SYSTEM_PROMPT = [
  'You are an expert prompt writer for the Seedance Omni video model. Watch this reference video and write ONE structured generation prompt.',
  'Use EXACTLY these section headers, in this order, as plain text:',
  'CHARACTERS and ENVIRONMENT / SETTING / CAMERA / STORY BEATS / STYLE / IMPORTANT.',
  '',
  'CRITICAL IDENTITY RULE: the woman in the OUTPUT is the woman from reference image 1 (@image1).',
  'NEVER describe the face, hair, body, skin or any physical appearance of the woman in THIS video — her looks are irrelevant and must not appear.',
  'A photo of reference image 1 (the woman who must appear in the output) may be attached. If it is, LOOK at her and state her real hair colour, length and style, and her build, in CHARACTERS and ENVIRONMENT — e.g. "long black hair". Her appearance comes from THAT photo, never from the video.',
  'In CHARACTERS and ENVIRONMENT write that the exact woman from reference image 1 is used, a perfect identity match, and describe only the ENVIRONMENT and her CLOTHING as seen in the video.',
  '',
  'STORY BEATS must be timestamped across the clip (for example 0-1.5s, 1.5-3s, 3-5s) and describe her ACTIONS: body movement, hand placement, posture changes, facial expression and micro-movements. Be specific and sensual where the clip is.',
  'CAMERA: describe shot type, framing, movement (or that it is static), and duration.',
  'STYLE: hyper-realistic photorealism, natural skin texture, authentic energy, no glossy AI look.',
  'IMPORTANT: preserve exact identity from reference image 1, natural body language, believable micro-expressions, avoid overacting, avoid glossy AI skin.',
  'End IMPORTANT with: "Silent video, no audio, no speech, no music."',
  '',
  'Output only the prompt itself — no preamble, no markdown, no commentary.',
    ].join(String.fromCharCode(10));
const { AppError } = require('../middleware/errorHandler');
const muapi = require('../services/muapiService');
const videoHistory = require('../services/videoHistoryStore');
const apiKeyManager = require('../services/apiKeyManager');
const { startGenerationRun, logUsageEvent } = require('../services/eventLogger');
const log = require('../utils/logger');

/**
 * POST /api/seedance-omni/generate
 * Submit an Omni Reference job (reference videos + images + trained characters).
 *
 * Returns { taskId } — poll it with the EXISTING GET /api/video/:taskId/status, which already
 * handles provider 'muapi' (polls, downloads the mp4, tracks spend). No duplicate poller.
 */
router.post('/generate', async (req, res, next) => {
  try {
    const { model, prompt, images = [], videos = [], videoUrls = [], aspectRatio, duration, quality } = req.body || {};

    if (!model || !muapi.OMNI_MODELS[model]) {
      throw new AppError('A valid Omni model is required', 400, 'VALIDATION_ERROR');
    }
    if (!prompt || !String(prompt).trim()) {
      throw new AppError('prompt is required', 400, 'VALIDATION_ERROR');
    }
    for (const img of images) {
      if (!img?.base64) throw new AppError('Each reference image needs base64 data', 400, 'VALIDATION_ERROR');
    }
    for (const v of videos) {
      if (!v?.base64) throw new AppError('Each reference video needs base64 data', 400, 'VALIDATION_ERROR');
    }

    const { taskId, status } = await muapi.createOmniTask(model, {
      prompt: String(prompt).slice(0, 4000),
      images,
      videos,
      videoUrls,
      aspectRatio,
      duration,
      quality,
    });

    const runId = startGenerationRun({
      id: taskId,
      userId: req.session?.userId,
      feature: 'video',
      provider: 'muapi',
      model,
      status: status || 'processing',
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.started',
      entityType: 'generation_run',
      entityId: runId,
      source: 'seedance-omni',
      payload: { feature: 'video', provider: 'muapi', model, duration: Number(duration) || null },
    });

    // provider 'muapi' is what makes the shared video status route pick this up.
    const historyEntry = videoHistory.add({
      taskId,
      provider: 'muapi',
      model,
      prompt: String(prompt).slice(0, 2500),
      status: status || 'processing',
      duration: Number(duration) || null,
    });

    res.json({ success: true, data: { taskId, historyId: historyEntry.id, status: status || 'processing' } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/seedance-omni/train-character
 * Train a reusable character ($0.50 flat). Returns a requestId to poll, or a characterId
 * if Muapi answers immediately.
 */
router.post('/train-character', async (req, res, next) => {
  try {
    const { imageBase64, mimeType, characterName, description } = req.body || {};
    if (!imageBase64) throw new AppError('A reference photo is required', 400, 'VALIDATION_ERROR');
    if (!characterName || !String(characterName).trim()) throw new AppError('A character name is required', 400, 'VALIDATION_ERROR');

    const result = await muapi.trainOmniCharacter({ imageBase64, mimeType, characterName, description });

    try {
      apiKeyManager.addExternalSpend(muapi.OMNI_TRAIN_COST, 'omni-character-train');
    } catch (e) {
      log.warn('omni_train_spend_track_failed', { error: e.message });
    }

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/seedance-omni/train-status/:requestId
 * Poll a training job until the character_id appears.
 */
router.get('/train-status/:requestId', async (req, res, next) => {
  try {
    const result = await muapi.getTaskStatus(req.params.requestId);
    let characterId = null;
    if (result.status === 'completed') {
      // The id may arrive as a bare string output or inside an object.
      const first = result.outputs?.[0];
      if (typeof first === 'string' && /^char_/.test(first)) characterId = first;
      else characterId = first?.character_id || first?.characterId || first?.id || null;
    }
    res.json({ success: true, data: { status: result.status, characterId, error: result.error } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/seedance-omni/analyze-video
 * Body: { videoBase64, mimeType }
 * Watches the reference clip with Gemini and writes a full structured Omni prompt
 * (CHARACTERS/ENVIRONMENT, SETTING, CAMERA, STORY BEATS, STYLE, IMPORTANT).
 *
 * Identity deliberately comes from @image1, never from the clip: the prompt is told to NEVER
 * describe the appearance of the woman in the video, so the reference performer cannot leak
 * into the output — the same protection the image tools use.
 *
 * Same upload path Pinterest's analyzer uses: temp file -> Gemini File API -> poll ACTIVE.
 */
router.post('/analyze-video', async (req, res, next) => {
  const { GoogleGenAI } = require('@google/genai');
  const { videoBase64, mimeType, imageBase64, imageMimeType } = req.body || {};
  if (!videoBase64 || typeof videoBase64 !== 'string') {
    throw new AppError('"videoBase64" is required', 400, 'VALIDATION_ERROR');
  }

  // Works on EITHER backend: Vertex sends the clip inline (no Files API there), the direct
  // Gemini API uses its Files API. Requiring a Gemini key outright locked out Vertex users.
  const useVertex = apiKeyManager.shouldUseVertexBackend?.() || apiKeyManager.hasVertexCredentials?.();
  const apiKey = apiKeyManager.getActiveKeyOrNull();
  if (!useVertex && !apiKey) {
    throw new AppError('Add a Gemini or Vertex key to analyse the clip', 400, 'GEMINI_KEY_REQUIRED');
  }

  let raw = videoBase64;
  const dataMatch = raw.match(/^data:[^;]+;base64,(.+)$/);
  if (dataMatch) raw = dataMatch[1];

  const tmpFile = path.join(os.tmpdir(), `omni-analyze-${Date.now()}.mp4`);
  let uploadedName = null;
  try {
    if (useVertex) {
      const vertex = require('../services/geminiVertexService');
      let modelImg = imageBase64 || '';
      const im = modelImg.match(/^data:[^;]+;base64,(.+)$/);
      if (im) modelImg = im[1];
      const text = await vertex.analyzeVideoWithPrompt(
        null, raw, mimeType || 'video/mp4', SYSTEM_PROMPT,
        modelImg ? { base64: modelImg, mimeType: imageMimeType || 'image/png' } : null,
      );
      return res.json({ success: true, data: { prompt: String(text || '').trim() } });
    }

    fs.writeFileSync(tmpFile, Buffer.from(raw, 'base64'));

    const genAI = new GoogleGenAI({ apiKey });
    const uploaded = await genAI.files.upload({ file: tmpFile, config: { mimeType: mimeType || 'video/mp4' } });
    uploadedName = uploaded.name;

    let info = uploaded;
    const deadline = Date.now() + 120_000;
    while (info.state !== 'ACTIVE') {
      if (Date.now() > deadline) throw new AppError('Gemini took too long to process the clip', 504, 'ANALYZE_TIMEOUT');
      if (info.state === 'FAILED') throw new AppError('Gemini could not process the clip', 502, 'ANALYZE_FAILED');
      await new Promise((r) => setTimeout(r, 3000));
      info = await genAI.files.get({ name: uploadedName });
    }



    const response = await genAI.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [{ role: 'user', parts: [
        { fileData: { fileUri: info.uri, mimeType: info.mimeType } },
        ...(imageBase64 ? [{ inlineData: { mimeType: imageMimeType || 'image/png', data: String(imageBase64).replace(/^data:[^;]+;base64,/, '') } }] : []),
        { text: SYSTEM_PROMPT },
      ] }],
    });

    const text = String(response?.text || '').trim();
    if (!text) throw new AppError('Gemini returned no prompt for this clip', 502, 'ANALYZE_EMPTY');

    res.json({ success: true, data: { prompt: text } });
  } catch (err) {
    next(err);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
    // Best-effort remote cleanup so uploads don't pile up in the Gemini file store.
    if (uploadedName) {
      try {
        const { GoogleGenAI: G } = require('@google/genai');
        await new G({ apiKey }).files.delete({ name: uploadedName });
      } catch { /* ignore */ }
    }
  }
});

module.exports = router;
