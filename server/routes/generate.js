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
const REALISM_DIRECTIVE = require('../utils/realismDirective');

const router = express.Router();
const VALID_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];
const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

function parseReferenceImagePayload(value, fieldName = 'referenceImage') {
  if (!value) return null;

  const source = typeof value === 'string'
    ? value
    : (typeof value === 'object' && typeof value.image === 'string' ? value.image : null);

  if (!source) {
    throw new AppError(`${fieldName} must be a data URI string or an object with { image }`, 400, 'VALIDATION_ERROR');
  }

  const dataUriMatch = source.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (dataUriMatch) {
    const mimeType = dataUriMatch[1];
    const base64Data = dataUriMatch[2];
    const byteLength = Buffer.byteLength(base64Data, 'base64');
    if (byteLength > MAX_REFERENCE_BYTES) {
      throw new AppError(`${fieldName} exceeds max size of 10MB`, 400, 'FILE_TOO_LARGE');
    }
    return { mimeType, base64Data };
  }

  if (typeof value !== 'object') {
    throw new AppError(`${fieldName} must be a valid data URI`, 400, 'VALIDATION_ERROR');
  }

  const mimeType = typeof value.mimeType === 'string' ? value.mimeType.trim() : '';
  const base64Data = typeof value.base64Data === 'string' ? value.base64Data.trim() : '';

  if (!mimeType || !base64Data) {
    throw new AppError(`${fieldName} object must include mimeType and base64Data`, 400, 'VALIDATION_ERROR');
  }
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
    throw new AppError(`${fieldName} mimeType must be one of: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}`, 400, 'INVALID_FILE_TYPE');
  }

  const byteLength = Buffer.byteLength(base64Data, 'base64');
  if (byteLength > MAX_REFERENCE_BYTES) {
    throw new AppError(`${fieldName} exceeds max size of 10MB`, 400, 'FILE_TOO_LARGE');
  }

  return { mimeType, base64Data };
}

function parseCustomReferenceImages(value) {
  if (!Array.isArray(value) || value.length === 0) return [];

  return value.map((item, index) => {
    const parsed = parseReferenceImagePayload(item, `customReferenceImages[${index}]`);
    const referenceType = (item && typeof item.referenceType === 'string')
      ? item.referenceType.trim().toLowerCase()
      : 'item';
    const note = (item && typeof item.note === 'string')
      ? item.note.trim()
      : '';

    return {
      ...parsed,
      referenceType: referenceType || 'item',
      note,
    };
  });
}

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
    const finalImageSize = VALID_IMAGE_SIZES.includes(resolutionTier) ? resolutionTier : '1K';

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
      } catch { }
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
      } catch { }
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
          ['SCENE MEMORY LOCK', `architecture: ${sceneMemory.architecture}`, `lightingProfile: ${sceneMemory.lightingProfile}`, `colorPalette: ${sceneMemory.colorPalette}`, `recurringElements: ${sceneMemory.recurringElements}`].join('\n')
        );
      }
      if (cameraProfile) {
        styleBlocks.push(
          ['CAMERA PROFILE', `lens: ${cameraProfile.lens}`, `depth: ${cameraProfile.depth}`, `lighting: ${cameraProfile.lighting}`, `realism: ${cameraProfile.realism}`].join('\n')
        );
      }
      if (poseFromMode) {
        styleBlocks.push(['POSE MODE', poseFromMode].join('\n'));
      }
      if (expressionFromMode) {
        styleBlocks.push(['EXPRESSION MODE', expressionFromMode].join('\n'));
      }
      if (outfit) {
        styleBlocks.push(
          ['OUTFIT LOCK', `top: ${outfit.top}`, `bottom: ${outfit.bottom}`, `accessories: ${outfit.accessories}`, `footwear: ${outfit.footwear}`].join('\n')
        );
      }
      if (styleLibraryBlock) {
        styleBlocks.push(`[STYLE LIBRARY]\n${styleLibraryBlock}\n[END STYLE LIBRARY]`);
      }
      finalPrompt = `${styleBlocks.join('\n\n')}\n\nUSER SCENE CONTEXT\n${finalPrompt}`;
    }

    finalPrompt = `${finalPrompt}\n\n${REALISM_DIRECTIVE}`;

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
    next(err);
  }
});

module.exports = router;
