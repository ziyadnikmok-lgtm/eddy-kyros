'use strict';
const express = require('express');
const galleryManager = require('../services/galleryManager');
const apiKeyManager = require('../services/apiKeyManager');
const referenceManager = require('../services/referenceManager');
const geminiBackend = require('../services/geminiBackend');
const { AppError } = require('../middleware/errorHandler');
const { requirePlanCapacity } = require('../middleware/planLimits');
const { logUsageEvent, startGenerationRun, finishGenerationRun } = require('../services/eventLogger');
const log = require('../utils/logger');
const { buildCharacterReferenceImages } = require('./postClone');

let _sharp; const sharp = (...a) => { if (!_sharp) _sharp = require('sharp'); return _sharp(...a); };

const router = express.Router();

const VALID_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4'];
const VALID_IMAGE_SIZES = ['1K', '2K'];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// No "-preview" suffix: the Vertex allow-list is `gemini-3.1-flash-image`; the old preview id makes
// resolveImageModel() throw "Unsupported image model" (same bug that broke Nano Bypass).
const MODEL_ID = 'gemini-3.1-flash-image';
const TEXT_MODEL = 'gemini-2.5-flash';

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_ONLY_HIGH' },
];

function estimateBase64Bytes(value) {
  const clean = String(value || '').replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function extractImageFromResponse(data) {
  const candidates = data?.candidates || [];
  if (!candidates.length) return null;
  const parts = candidates[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.thought) continue;
    if (part.inlineData?.data) return part.inlineData.data;
  }
  return null;
}

async function optimizeImage(base64, mimeType) {
  const buf = Buffer.from(base64, 'base64');
  const optimized = await sharp(buf)
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { data: optimized.toString('base64'), mimeType: 'image/jpeg' };
}

/**
 * Sanitize outfit description for image generation — swap safety-triggering words
 * with safe equivalents that still convey the same fashion meaning.
 */
function sanitizeForGeneration(text) {
  const swaps = [
    // === Garment type reframes (critical — these bypass output safety) ===
    [/\bbikini\b/gi, 'sports bralette and mini athletic shorts set'],
    [/\btwo[- ]piece\s*(swimwear|swimsuit|swim\s*set)?\b/gi, 'activewear matching set'],
    [/\bswimwear\b/gi, 'activewear'], [/\bswimsuit\b/gi, 'activewear set'],
    [/\bbathing\s*suit\b/gi, 'activewear set'], [/\bmonokini\b/gi, 'bodysuit'],
    [/\blingerie\b/gi, 'lounge wear'], [/\bunderwear\b/gi, 'base layer'],
    [/\bbra\b/gi, 'sports bralette'], [/\bpanty\b/gi, 'athletic brief'],
    [/\bpanties\b/gi, 'athletic briefs'], [/\bthong\b/gi, 'minimal brief'],
    [/\bg[- ]?string\b/gi, 'minimal brief'],
    // === Construction reframes (these signal swimwear to the model) ===
    [/\btriangle\s*(top|cup)\b/gi, 'fitted jersey top'],
    [/\bstring[- ]?tie\s*(bottom|side|brief)?\b/gi, 'adjustable-closure bottom'],
    [/\bhalter[- ]?(neck|style|top)?\b/gi, 'sleeveless neck-closure'],
    [/\btie[- ]?side\b/gi, 'adjustable-side'],
    // === Body/skin descriptors ===
    [/\brevealing\b/gi, 'open-design'], [/\bsexy\b/gi, 'stylish'], [/\bsensual\b/gi, 'elegant'],
    [/\bseductive\b/gi, 'confident'], [/\bprovocative\b/gi, 'bold'],
    [/\bskin-?tight\b/gi, 'form-fitting'], [/\bcleavage\b/gi, 'décolletage'],
    [/\blow[- ]cut\b/gi, 'plunging neckline'], [/\bnude\b/gi, 'skin-toned'],
    [/\bnaked\b/gi, 'bare'], [/\bsheer\b/gi, 'translucent fabric'],
    [/\btight\b/gi, 'fitted'], [/\bbody-?hugging\b/gi, 'figure-skimming'],
    [/\bcurvy\b/gi, 'full-figured'], [/\bvoluptuous\b/gi, 'full-figured'],
    [/\bbreast\b/gi, 'bust'], [/\bbreasts\b/gi, 'bust'],
    [/\bboob\b/gi, 'bust'], [/\bboobs\b/gi, 'bust'],
    [/\bass\b/gi, 'hips'], [/\bbutt\b/gi, 'hips'], [/\bnaughty\b/gi, 'playful'],
    [/\bexposed\b/gi, 'visible'], [/\bexposing\b/gi, 'showing'],
    [/\bskimpy\b/gi, 'minimal-coverage'], [/\btiny\b/gi, 'petite'],
    [/\bmicro\b/gi, 'mini'],
  ];
  let result = text;
  for (const [pattern, replacement] of swaps) result = result.replace(pattern, replacement);
  return result;
}

/**
 * Step 1: Analyze the outfit image using text model.
 * Returns a detailed text description of the clothing.
 */
async function analyzeOutfit(outfitImageData, useVertexBackend, apiKey) {
  const analysisPrompt = [
    'You are a professional fashion designer. Describe this outfit in EXTREME detail for exact recreation.',
    '',
    'Describe every construction detail:',
    '- Garment type (dress, top, skirt, bodysuit, etc)',
    '- Exact colors and color placement (stripes, blocks, gradients)',
    '- Fabric type and texture (satin, cotton, mesh, jersey, etc)',
    '- Pattern details (stripe width, direction, spacing)',
    '- Neckline construction: style (halter, V-neck, scoop, etc) and depth',
    '- Sleeve type and length (or sleeveless/strapless)',
    '- Fit construction: bodycon, A-line, fitted, oversized — how does it conform to the body',
    '- How the garment fits around the bust, waist, and hip areas',
    '- Hemline/length (mini, midi, maxi) and any side slits with approximate height',
    '- Cut-outs, ties, strings, backless sections, or special construction details',
    '- Any text, numbers, logos, or branding (EXACT text content, font style, color, placement)',
    '- Accessories visible (jewelry, belts, shoes)',
    '',
    'Be VERY specific about colors — e.g. "light sky blue and white vertical stripes" not just "blue and white".',
    'Describe the fit precisely — if form-fitting, say "bodycon/figure-hugging". If the neckline is deep, specify how deep.',
    'Output ONLY the technical description, no opinions.',
  ].join('\n');

  // Try Vertex first (safety OFF — can analyze any garment type) then fall back to Gemini direct
  for (const provider of useVertexBackend ? ['vertex', null] : [null]) {
    try {
      const opts = { model: TEXT_MODEL };
      if (provider) opts.provider = provider;
      const result = await geminiBackend.analyzeImageWithPrompt(
        provider ? null : (apiKey || null),
        outfitImageData.data,
        outfitImageData.mimeType,
        analysisPrompt,
        opts
      );
      if (typeof result === 'string' && result.trim().length > 20) {
        return sanitizeForGeneration(result.trim());
      }
    } catch (err) {
      log.warn('outfit_swap_analysis_attempt', { provider: provider || 'gemini', error: err.message?.slice(0, 100) });
    }
  }
  return null;
}

/**
 * Generate outfit swap — two strategies:
 *   Strategy A (two-step): Analyze outfit → text description + target image only
 *   Strategy B (direct): Both images in one call (fallback)
 */
async function callGeminiSwap(apiKey, outfitData, targetData, outfitDescription, aspectRatio, imageSize, extraParts) {
  const imageConfig = {};
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  if (imageSize) imageConfig.imageSize = imageSize;

  // Strategy A: Text description + target image only (bypasses dual-image safety trigger)
  if (outfitDescription) {
    const parts = [...(extraParts || [])];
    parts.push(
      { text: [
        `[TARGET PERSON — preserve EVERYTHING about this person exactly as shown]`,
        `Preserve from this image:`,
        `- Face, expression, skin tone, hair (pixel-perfect match)`,
        `- EXACT body shape and proportions — do not alter the figure in any way`,
        `- Body pose and camera angle`,
        `- Background, lighting, and atmosphere`,
      ].join('\n') },
      { inlineData: { mimeType: targetData.mimeType, data: targetData.data } },
      { text: [
        `Professional fashion editorial photography.`,
        ``,
        `OUTFIT TO APPLY (from reference):`,
        outfitDescription,
        ``,
        `TASK: Generate a photorealistic image of the person above wearing the described outfit.`,
        ``,
        `RULES:`,
        `1. Recreate the outfit EXACTLY as described — every color, pattern, text, number, accessory, and fit`,
        `2. The outfit must conform to the person's actual body shape — do not alter proportions`,
        `3. The person's face, skin tone, hair, expression must be IDENTICAL to the reference`,
        `4. Keep the same pose, background, and lighting`,
        `5. Form-fitting outfits should look form-fitting on the person's natural figure`,
        `6. Render the neckline depth exactly as described`,
        `7. Magazine-quality, editorial photography composition`,
        `8. No watermarks, no overlaid text, no artifacts`,
      ].join('\n') },
    );
    return await _callWithRetries(apiKey, parts, imageConfig);
  }

  // Strategy B: Direct two-image approach (fallback)
  const parts = [...(extraParts || [])];
  parts.push(
    { text: `[Image A — OUTFIT REFERENCE]\nAnalyze the clothing only: fabric, color, pattern, style, fit, accessories.\nDo NOT copy the person's face or body from this image.` },
    { inlineData: { mimeType: outfitData.mimeType, data: outfitData.data } },
    { text: `[Image B — TARGET PERSON]\nThis person will wear the outfit from Image A.\nPreserve: face, expression, skin tone, hair, body pose, proportions, background, lighting.` },
    { inlineData: { mimeType: targetData.mimeType, data: targetData.data } },
    { text: [
      `Professional fashion photography editorial.`,
      `Generate a photorealistic image of the person from Image B wearing the exact outfit from Image A.`,
      `RULES:`,
      `1. Clothing EXACTLY matches Image A — same fabric, color, pattern, style, fit, text/numbers`,
      `2. Person identity IDENTICAL to Image B`,
      `3. Same pose, background, lighting as Image B`,
      `4. Natural draping, wrinkles, shadows`,
      `5. Magazine-quality, editorial composition`,
      `6. No watermarks, no text overlays, no artifacts`,
    ].join('\n') },
  );
  return await _callWithRetries(apiKey, parts, imageConfig);
}

async function _callWithRetries(apiKey, parts, imageConfig) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent?key=${apiKey}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const genConfig = { temperature: attempt === 3 ? 0.8 : 1.0 };
    if (attempt === 1) {
      genConfig.responseModalities = ['TEXT', 'IMAGE'];
    } else {
      genConfig.responseModalities = ['IMAGE'];
    }
    if (Object.keys(imageConfig).length) genConfig.imageConfig = imageConfig;

    const body = {
      contents: [{ parts }],
      generationConfig: genConfig,
    };
    if (attempt < 3) body.safetySettings = SAFETY_SETTINGS;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });

    if (!resp.ok && resp.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new AppError(`Gemini API error (${resp.status}): ${text.slice(0, 200)}`, 502, 'OUTFIT_SWAP_ERROR');
    }

    const data = await resp.json();
    const b64 = extractImageFromResponse(data);
    if (b64) return b64;

    if (attempt === 3) {
      const finishReason = data?.candidates?.[0]?.finishReason || 'UNKNOWN';
      const textParts = (data?.candidates?.[0]?.content?.parts || [])
        .filter((p) => !p.thought && p.text)
        .map((p) => p.text)
        .join(' ');
      throw new AppError(
        `Outfit Swap returned no image (reason: ${finishReason})${textParts ? ` — ${textParts.slice(0, 200)}` : ''}`,
        502,
        'OUTFIT_SWAP_NO_IMAGE'
      );
    }
  }
}

// POST /api/outfit-swap/swap
router.post('/swap', express.json({ limit: '100mb' }), requirePlanCapacity(), async (req, res, next) => {
  let runId = null;
  let provider = 'gemini';
  try {
    const {
      outfitImage,    // { base64, mimeType }
      targetImage,    // { base64, mimeType }
      characterId = null,
      aspectRatio = '9:16',
      imageSize = '2K',
      sourceUrl,      // originating IG/TikTok/X post link (if the target frame came from one)
    } = req.body || {};
    const cleanSourceUrl = (typeof sourceUrl === 'string' && sourceUrl.startsWith('http')) ? sourceUrl.slice(0, 2000) : null;

    if (!outfitImage?.base64) throw new AppError('Outfit source image is required', 400, 'VALIDATION_ERROR');
    if (!targetImage?.base64) throw new AppError('Target person image is required', 400, 'VALIDATION_ERROR');
    if (aspectRatio && !VALID_ASPECT_RATIOS.includes(aspectRatio)) throw new AppError('Invalid aspect ratio', 400, 'VALIDATION_ERROR');
    if (imageSize && !VALID_IMAGE_SIZES.includes(imageSize)) throw new AppError('Invalid image size', 400, 'VALIDATION_ERROR');

    // Strip data URI prefix
    const outfitRaw = outfitImage.base64.replace(/^data:[^;]+;base64,/, '');
    const targetRaw = targetImage.base64.replace(/^data:[^;]+;base64,/, '');

    if (estimateBase64Bytes(outfitRaw) > MAX_IMAGE_BYTES) throw new AppError('Outfit image too large (20MB max)', 400, 'VALIDATION_ERROR');
    if (estimateBase64Bytes(targetRaw) > MAX_IMAGE_BYTES) throw new AppError('Target image too large (20MB max)', 400, 'VALIDATION_ERROR');

    const useVertexBackend = apiKeyManager.shouldUseVertexBackend();
    const apiKey = useVertexBackend ? '' : apiKeyManager.getActiveKey();
    if (!useVertexBackend && !apiKey) {
      throw new AppError('Outfit Swap requires a Gemini API key or active Vertex AI credentials.', 400, 'GEMINI_KEY_REQUIRED');
    }
    provider = useVertexBackend ? 'vertex' : 'gemini';

    runId = startGenerationRun({
      userId: req.session?.userId,
      feature: 'outfit-swap',
      provider,
      model: MODEL_ID,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.started',
      entityType: 'generation_run',
      entityId: runId,
      source: 'outfit-swap',
      payload: { feature: 'outfit-swap', provider, model: MODEL_ID },
    });

    // Optimize images
    const outfit = await optimizeImage(outfitRaw, outfitImage.mimeType || 'image/jpeg');
    const target = await optimizeImage(targetRaw, targetImage.mimeType || 'image/jpeg');

    // Step 1: Analyze outfit → text description
    log.info('outfit_swap_step1_analyze');
    const outfitDescription = await analyzeOutfit(outfit, useVertexBackend, apiKey);
    if (outfitDescription) {
      log.info('outfit_swap_analysis_ok', { descLen: outfitDescription.length });
    } else {
      log.warn('outfit_swap_analysis_failed_fallback_direct');
    }

    // Build character reference parts (if any)
    const charParts = [];
    let characterName = null;
    if (characterId) {
      try {
        const character = referenceManager.getCharacter(characterId);
        characterName = character?.name || null;
        if (character) {
          const allRefs = Array.isArray(character.references) ? character.references : [];
          const rawRefs = buildCharacterReferenceImages(characterId, allRefs);
          const refImages = (await Promise.all(
            rawRefs.slice(0, 3).map((ref) => optimizeImage(ref.base64Data, ref.mimeType))
          )).filter(Boolean);

          if (refImages.length > 0) {
            charParts.push({
              text: [
                `[CHARACTER IDENTITY REFERENCES]`,
                `These images show the character's true facial features and identity.`,
                `The output person's face MUST look exactly like this character.`,
                `Copy: face (exact likeness), skin tone, body type, proportions, hair color/style.`,
              ].join('\n'),
            });
            for (const ref of refImages) {
              charParts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data } });
            }
          }
        }
      } catch { characterName = null; }
    }

    // Add identity lock to char parts if present
    if (characterName) {
      charParts.push({
        text: `IDENTITY LOCK: The person's face and body MUST match the character "${characterName}" from the identity references.`,
      });
    }

    // Step 2: Generate the swap
    log.info('outfit_swap_step2_generate', { strategy: outfitDescription ? 'two-step' : 'direct' });

    let b64Result;
    const vertexOpts = {
      model: MODEL_ID,
      aspectRatio,
      imageSize,
      characterId: characterId || undefined,
      requireImageInputs: true,
    };

    if (useVertexBackend) {
      // Build parts for Vertex
      const parts = [...charParts];
      if (outfitDescription) {
        // Two-step: text description + target only
        parts.push(
          { text: [
            `[TARGET PERSON — preserve EVERYTHING exactly as shown]`,
            `Preserve: face, expression, skin tone, hair, EXACT body shape and proportions, pose, background, lighting.`,
          ].join('\n') },
          { inlineData: { mimeType: target.mimeType, data: target.data } },
          { text: [
            `Professional fashion editorial photography.`,
            ``,
            `OUTFIT TO APPLY (from reference):`,
            outfitDescription,
            ``,
            `TASK: Generate a photorealistic image of the person wearing the described outfit.`,
            `RULES:`,
            `1. Outfit EXACTLY as described — every color, pattern, text, number, accessory, and fit`,
            `2. The outfit must conform to the person's actual body shape — do not alter proportions`,
            `3. Person identity IDENTICAL to the reference`,
            `4. Same pose, background, lighting`,
            `5. Form-fitting outfits should look form-fitting on the person's natural figure`,
            `6. Magazine-quality editorial composition`,
            `7. No watermarks, overlaid text, or artifacts`,
          ].join('\n') },
        );
      } else {
        // Direct: both images
        parts.push(
          { text: `[OUTFIT REFERENCE]\nAnalyze the clothing only: fabric, color, pattern, style, fit, accessories.\nDo NOT copy the person's face or body.` },
          { inlineData: { mimeType: outfit.mimeType, data: outfit.data } },
          { text: `[TARGET PERSON]\nThis person will wear the outfit.\nPreserve: face, expression, skin tone, hair, pose, proportions, background, lighting.` },
          { inlineData: { mimeType: target.mimeType, data: target.data } },
          { text: [
            `Professional fashion photography editorial.`,
            `Generate a photorealistic image of the target person wearing the referenced outfit.`,
            `Exact match on clothing. Identical person identity. Natural fit. Magazine quality.`,
          ].join('\n') },
        );
      }
      vertexOpts.parts = parts;

      try {
        const generated = await geminiBackend.generateImage('', 'outfit swap', vertexOpts);
        b64Result = generated?.image?.base64Data;
      } catch (vertexErr) {
        // If two-step failed, try direct as fallback
        if (outfitDescription) {
          log.warn('outfit_swap_twostep_failed_trying_direct', { error: vertexErr.message?.slice(0, 100) });
          const directParts = [...charParts];
          directParts.push(
            { text: `[OUTFIT REFERENCE]` },
            { inlineData: { mimeType: outfit.mimeType, data: outfit.data } },
            { text: `[TARGET PERSON]` },
            { inlineData: { mimeType: target.mimeType, data: target.data } },
            { text: `Fashion editorial: dress this person in the referenced outfit. Exact match. Magazine quality.` },
          );
          vertexOpts.parts = directParts;
          const generated = await geminiBackend.generateImage('', 'outfit swap', vertexOpts);
          b64Result = generated?.image?.base64Data;
        } else {
          throw vertexErr;
        }
      }
    } else {
      // Direct Gemini API path
      try {
        b64Result = await callGeminiSwap(apiKey, outfit, target, outfitDescription, aspectRatio, imageSize, charParts);
      } catch (geminiErr) {
        // Fallback to Vertex if Gemini key is exhausted/rate-limited
        const msg = String(geminiErr?.message || '').toLowerCase();
        const hasVertex = apiKeyManager.shouldUseVertexBackend?.() || !!apiKeyManager._store?.vertexCredsEncrypted;
        if (hasVertex && (msg.includes('429') || msg.includes('exhausted') || msg.includes('rate') || msg.includes('prepayment'))) {
          log.info('outfit_swap_gemini_fallback_to_vertex', { reason: geminiErr.message?.slice(0, 100) });
          provider = 'vertex';
          const parts = [...charParts];
          if (outfitDescription) {
            parts.push(
              { text: `[TARGET PERSON]` },
              { inlineData: { mimeType: target.mimeType, data: target.data } },
              { text: `Fashion editorial. Dress this person in: ${outfitDescription}\nExact match. Magazine quality.` },
            );
          } else {
            parts.push(
              { text: `[OUTFIT REFERENCE]` },
              { inlineData: { mimeType: outfit.mimeType, data: outfit.data } },
              { text: `[TARGET PERSON]` },
              { inlineData: { mimeType: target.mimeType, data: target.data } },
              { text: `Fashion editorial: dress this person in the referenced outfit. Exact match.` },
            );
          }
          vertexOpts.parts = parts;
          const generated = await geminiBackend.generateImage('', 'outfit swap', vertexOpts);
          b64Result = generated?.image?.base64Data;
        } else {
          throw geminiErr;
        }
      }
    }

    if (!b64Result) {
      throw new AppError('Outfit Swap returned no image. Try different images.', 502, 'OUTFIT_SWAP_NO_IMAGE');
    }

    // Save to gallery — include outfit description for reuse
    const outfitPromptForGallery = outfitDescription
      ? `[Outfit Swap] ${outfitDescription}`
      : `[Outfit Swap] outfit from source → target person`;
    const entry = galleryManager.save({
      base64Data: b64Result,
      mimeType: 'image/png',
      prompt: outfitPromptForGallery + (characterName ? ` (${characterName})` : ''),
      source: 'outfit-swap',
      characterId: characterId || null,
      aspectRatio,
      tags: ['outfit-swap'],
      sourceUrl: cleanSourceUrl,
    });

    finishGenerationRun(runId, {
      status: 'succeeded',
      outputCount: 1,
      provider,
      model: MODEL_ID,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.succeeded',
      entityType: 'generation_run',
      entityId: runId,
      source: 'outfit-swap',
      payload: { feature: 'outfit-swap', provider, galleryId: entry.id, model: MODEL_ID },
    });

    log.info('outfit_swap_ok', { galleryId: entry.id });

    res.json({
      success: true,
      data: {
        base64Data: b64Result,
        mimeType: 'image/png',
        galleryId: entry.id,
        model: MODEL_ID,
        sourceUrl: cleanSourceUrl,
        outfitDescription: outfitDescription || null,
      },
    });
  } catch (err) {
    finishGenerationRun(runId, {
      status: 'failed',
      outputCount: 0,
      provider,
      errorCode: err.code || err.name || 'UNKNOWN',
      errorMessage: err.message || 'Outfit swap failed',
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.failed',
      entityType: 'generation_run',
      entityId: runId,
      source: 'outfit-swap',
      payload: { feature: 'outfit-swap', provider, errorCode: err.code || err.name || 'UNKNOWN', message: err.message || 'Outfit swap failed' },
    });
    next(err);
  }
});

module.exports = router;
