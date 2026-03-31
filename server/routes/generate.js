const express = require('express');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiService');
const referenceManager = require('../services/referenceManager');
const promptBuilder = require('../services/promptBuilder');
const sceneMemoryService = require('../services/sceneMemoryService');
const outfitMemoryService = require('../services/outfitMemoryService');
const cameraProfileService = require('../services/cameraProfileService');
const poseEngine = require('../services/poseEngine');
const expressionEngine = require('../services/expressionEngine');
const sceneModeEngine = require('../services/sceneModeEngine');
const imageStore = require('../services/imageStore');
const galleryManager = require('../services/galleryManager');
const styleLibrary = require('../services/styleLibrary');
const styleFocusStore = require('../services/styleFocusStore');
const { AppError } = require('../middleware/errorHandler');
const { logUsageEvent, startGenerationRun, finishGenerationRun } = require('../services/eventLogger');
const REALISM_DIRECTIVE = require('../utils/realismDirective');

const { parseReferenceImagePayload, parseCustomReferenceImages } = require('../utils/referenceImageParser');

const router = express.Router();
const VALID_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

function buildCharacterReferenceImages(characterId, activeRefs) {
  const parts = [];

  const primaries = referenceManager.getPrimaryImages(characterId);
  for (const primary of primaries) {
    if (primary?.buffer?.length) {
      parts.push({
        mimeType: primary.mimeType,
        base64Data: primary.buffer.toString('base64'),
      });
    }
  }

  for (const ref of activeRefs || []) {
    const data = referenceManager.getReferenceImage(characterId, ref.id);
    if (data?.buffer?.length) {
      parts.push({
        mimeType: data.mimeType,
        base64Data: data.buffer.toString('base64'),
      });
    }
  }

  return parts;
}

router.post('/', async (req, res, next) => {
  let runId = null;
  try {
    const {
      prompt,
      characterId,
      activeReferenceIds,
      sceneDescription,
      sceneMemoryId,
      outfitId,
      cameraProfileId,
      poseMode,
      expressionMode,
      sceneMode,
      aspectRatio,
      resolutionTier,
      identityValidation,
      extraReferenceImage,
      customReferenceImages,
      styleAtomIds,
      styleFocusId,
      contentType,
      imageModel,
    } = req.body;
    const finalAspectRatio = VALID_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '1:1';
    const finalImageSize = VALID_IMAGE_SIZES.includes(resolutionTier) ? resolutionTier : '2K';

    let finalPrompt;
    let characterName = null;
    let resolvedCharacterId = null;
    let resolvedRefIds = null;
    let character = null;
    let referenceImages = [];
    const placementReference = parseReferenceImagePayload(extraReferenceImage, 'extraReferenceImage');
    const specificReferences = parseCustomReferenceImages(customReferenceImages);

    if (characterId && typeof characterId === 'string') {
      character = referenceManager.getCharacter(characterId);
      characterName = character.name;
      resolvedCharacterId = characterId;

      const refIds = Array.isArray(activeReferenceIds)
        ? activeReferenceIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
        : null;
      const activeRefs = referenceManager.getActiveReferences(characterId, refIds);
      resolvedRefIds = activeRefs.map((r) => r.id);

      finalPrompt = promptBuilder.buildPrompt({
        masterPrompt: character.masterPrompt,
        activeReferences: activeRefs,
        userPrompt: (prompt && typeof prompt === 'string') ? prompt.trim() : '',
      });
      referenceImages = buildCharacterReferenceImages(characterId, activeRefs);

    } else {
      if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
        throw new AppError('A "prompt" string is required (or provide "characterId")', 400, 'VALIDATION_ERROR');
      }
      finalPrompt = prompt.trim();
    }

    if (placementReference) {
      referenceImages.push(placementReference);
      finalPrompt = `${finalPrompt}\n\n[EXTRA REFERENCE MAPPING]\nUse the first reference image as identity and subject appearance.\nUse the second reference image as the scene composition, camera framing, and subject placement.\nPlace the same character from reference image 1 naturally inside the location/context of reference image 2.\nDo not copy the person from reference image 2.`;
    }

    if (specificReferences.length > 0) {
      referenceImages.push(...specificReferences.map((ref) => ({
        mimeType: ref.mimeType,
        base64Data: ref.base64Data,
      })));
      const specificLines = specificReferences.map((ref, idx) => {
        const typeLabel = ref.referenceType || 'item';
        const noteLabel = ref.note ? ` Note: ${ref.note}.` : '';
        return `- Reference ${idx + 1} type "${typeLabel}": extract and apply this ${typeLabel} styling/item detail while preserving character identity and core scene intent.${noteLabel}`;
      });
      finalPrompt = `${finalPrompt}\n\n[SPECIFIC IMAGE REFERENCES]\n${specificLines.join('\n')}\nWhen multiple specific references are provided, combine them coherently without changing character identity.`;
    }

    const sceneMemory =
      typeof sceneMemoryId === 'string' && sceneMemoryId.trim().length > 0
        ? sceneMemoryService.getSceneById(sceneMemoryId)
        : null;
    const outfit =
      typeof outfitId === 'string' && outfitId.trim().length > 0
        ? outfitMemoryService.getOutfitById(outfitId)
        : null;
    const cameraProfile =
      typeof cameraProfileId === 'string' && cameraProfileId.trim().length > 0
        ? cameraProfileService.getProfileById(cameraProfileId)
        : null;
    const resolvedPoseMode = typeof poseMode === 'string' ? poseMode.trim() : '';
    const poseFromMode =
      resolvedPoseMode && resolvedPoseMode !== 'none' && resolvedPoseMode !== 'auto'
        ? poseEngine.poseForMode(resolvedPoseMode)
        : '';
    const resolvedExpressionMode = typeof expressionMode === 'string' ? expressionMode.trim() : '';
    const expressionFromMode =
      resolvedExpressionMode && resolvedExpressionMode !== 'none'
        ? expressionEngine.expressionForMode(resolvedExpressionMode)
        : '';
    const resolvedSceneMode = typeof sceneMode === 'string' ? sceneMode.trim() : '';
    const sceneFromMode =
      resolvedSceneMode && resolvedSceneMode !== 'none'
        ? sceneModeEngine.sceneForMode(resolvedSceneMode)
        : '';

    let styleLibraryBlock = '';
    if (Array.isArray(styleAtomIds) && styleAtomIds.length > 0) {
      try {
        styleLibraryBlock = styleLibrary.composePrompt(styleAtomIds);
        styleAtomIds.forEach(id => styleLibrary.incrementUsage(id));
      } catch (err) {
        const log = require('../utils/logger');
        log.warn('style_atom_compose_failed', { error: err.message });
      }
    }

    let styleFocusBlock = '';
    if (typeof styleFocusId === 'string' && styleFocusId.trim()) {
      try {
        const focus = styleFocusStore.get(styleFocusId);
        const attrs = Object.entries(focus.attributes || {})
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`);
        if (attrs.length > 0) {
          styleFocusBlock = `[STYLE FOCUS — Visual DNA]\n${attrs.join('\n')}\n[END STYLE FOCUS]`;
        }
      } catch (err) {
        const log = require('../utils/logger');
        log.warn('style_focus_resolve_failed', { error: err.message });
      }
    }

    if (sceneMemory || outfit || cameraProfile || poseFromMode || expressionFromMode || sceneFromMode || styleLibraryBlock || styleFocusBlock) {
      const styleBlocks = [];
      if (styleFocusBlock) {
        styleBlocks.push(styleFocusBlock);
      }
      if (sceneFromMode) {
        styleBlocks.push(['SCENE MODE', sceneFromMode].join('\n'));
      }
      if (sceneMemory) {
        styleBlocks.push(
          `[SCENE] ${sceneMemory.architecture}\nLighting: ${sceneMemory.lightingProfile}\nPalette: ${sceneMemory.colorPalette}`
        );
      }
      if (cameraProfile) {
        styleBlocks.push(
          `[CAMERA] ${cameraProfile.lens}. ${cameraProfile.realism}`
        );
      }
      if (poseFromMode) {
        styleBlocks.push(`Pose: ${poseFromMode}`);
      }
      if (expressionFromMode) {
        styleBlocks.push(`Expression: ${expressionFromMode}`);
      }
      if (outfit) {
        styleBlocks.push(
          `[OUTFIT] ${outfit.top}\nBottom: ${outfit.bottom}\nAccessories: ${outfit.accessories}\nFootwear: ${outfit.footwear}`
        );
      }
      if (styleLibraryBlock) {
        styleBlocks.push(`[STYLE LIBRARY]\n${styleLibraryBlock}\n[END STYLE LIBRARY]`);
      }
      finalPrompt = `${styleBlocks.join('\n\n')}\n\nUSER SCENE CONTEXT\n${finalPrompt}`;
    }

    finalPrompt = `${finalPrompt}\n\n${REALISM_DIRECTIVE}`;

    runId = startGenerationRun({
      userId: req.session?.userId,
      feature: 'generate',
      provider: 'gemini',
      model: imageModel || null,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.started',
      entityType: 'generation_run',
      entityId: runId,
      source: 'generate',
      payload: { feature: 'generate', model: imageModel || null, aspectRatio: finalAspectRatio },
    });

    const apiKey = apiKeyManager.getActiveKey();
    const result = await geminiService.generateImage(apiKey, finalPrompt, {
      aspectRatio: finalAspectRatio,
      imageSize: finalImageSize,
      referenceImages,
      model: imageModel,
    });

    const stored = imageStore.store({
      basePrompt: finalPrompt,
      characterId: resolvedCharacterId,
      activeReferenceIds: resolvedRefIds,
      sceneDescription: (sceneDescription && typeof sceneDescription === 'string')
        ? sceneDescription.trim()
        : (prompt && typeof prompt === 'string' ? prompt.trim() : null),
      modelUsed: result.modelUsed || null,
      seed: null,
      parentImageId: null,
      variationIndex: null,
      image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
      source: 'generate',
    });

    const autoTags = [];
    if (contentType && typeof contentType === 'string') {
      autoTags.push(contentType.trim().toLowerCase());
    }
    const galleryEntry = galleryManager.save({
      base64Data: result.image.base64Data,
      mimeType: result.image.mimeType,
      prompt: (prompt && typeof prompt === 'string') ? prompt.trim() : characterName,
      source: 'generate',
      characterId: resolvedCharacterId,
      aspectRatio: finalAspectRatio,
      seed: null,
      tags: autoTags,
    });

    finishGenerationRun(runId, {
      status: 'succeeded',
      outputCount: 1,
      provider: 'gemini',
      model: result.modelUsed || imageModel || null,
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.succeeded',
      entityType: 'generation_run',
      entityId: runId,
      source: 'generate',
      payload: { feature: 'generate', galleryId: galleryEntry.id, imageId: stored.imageId },
    });

    res.json({
      success: true,
      data: {
        imageId: stored.imageId,
        galleryId: galleryEntry.id,
        image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
        text: result.text,
        characterName,
        aspectRatio: finalAspectRatio,
        resolutionTier: finalImageSize,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    finishGenerationRun(runId, {
      status: 'failed',
      outputCount: 0,
      errorCode: err.code || err.name || 'UNKNOWN',
      errorMessage: err.message || 'Generation failed',
      provider: 'gemini',
    });
    logUsageEvent({
      userId: req.session?.userId,
      eventType: 'generation.failed',
      entityType: 'generation_run',
      entityId: runId,
      source: 'generate',
      payload: { feature: 'generate', errorCode: err.code || err.name || 'UNKNOWN', message: err.message || 'Generation failed' },
    });
    next(err);
  }
});

// --- Prompt Enhancement endpoint ---
router.post('/enhance-prompt', async (req, res, next) => {
  try {
    const { prompt, characterName, characterId, hasReferences } = req.body;
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 5) {
      return res.json({ success: true, data: { original: prompt || '', enhanced: prompt || '', changed: false } });
    }

    const apiKey = apiKeyManager.getActiveKey();
    const enhanced = await geminiService.enhancePrompt(apiKey, prompt.trim(), {
      characterName: characterName || null,
      characterId: characterId || null,
      hasReferences: !!hasReferences,
    });

    const changed = enhanced !== prompt.trim();
    res.json({
      success: true,
      data: { original: prompt.trim(), enhanced, changed },
    });
  } catch (err) {
    // On any error, return the original prompt unchanged
    if (req.body?.prompt) {
      return res.json({
        success: true,
        data: { original: req.body.prompt, enhanced: req.body.prompt, changed: false, error: err.message },
      });
    }
    next(err);
  }
});

module.exports = router;
