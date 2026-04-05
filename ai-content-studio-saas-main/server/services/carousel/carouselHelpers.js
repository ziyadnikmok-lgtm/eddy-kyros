'use strict';
const fs = require('node:fs');
const { AppError } = require('../../middleware/errorHandler');
const { asText } = require('../../utils/helpers');
const apiKeyManager = require('../apiKeyManager');
const geminiService = require('../geminiService');
const sceneAnalyzer = require('../sceneAnalyzer');
const sceneMemoryService = require('../sceneMemoryService');
const outfitMemoryService = require('../outfitMemoryService');
const batchGenerator = require('../batchGenerator');
const imageStore = require('../imageStore');
const galleryManager = require('../galleryManager');

const MAX_BATCH_PROMPTS = 20;

// ── Reference ID helpers ───────────────────────────────────────────────────────

function normalizeActiveReferenceIds(activeReferenceIds) {
  return Array.isArray(activeReferenceIds)
    ? activeReferenceIds.filter((id) => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
    : [];
}

function resolveActiveReferenceIds(activeReferenceIds, character) {
  const provided = normalizeActiveReferenceIds(activeReferenceIds);
  if (provided.length > 0) return provided;
  if (character && (character.profileImage || character.primaryImageFile)) return ['__profile__'];
  return [];
}

// ── Batch launcher ─────────────────────────────────────────────────────────────

function startMultiBatches(entries, generationOptions, characterContext = {}) {
  const jobIds = [];
  const grouped = new Map();
  for (const entry of entries) {
    const key = [entry.sceneMemoryId || '', entry.outfitId || '', entry.cameraProfileId || ''].join('::');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }
  for (const group of grouped.values()) {
    for (let i = 0; i < group.length; i += MAX_BATCH_PROMPTS) {
      const chunk = group.slice(i, i + MAX_BATCH_PROMPTS);
      if (chunk.length === 0) continue;
      const config = {
        prompts: chunk.map((e) => e.prompt),
        sceneMemoryId: chunk[0].sceneMemoryId || null,
        outfitId: chunk[0].outfitId || null,
        cameraProfileId: chunk[0].cameraProfileId || null,
        characterId: characterContext.characterId || null,
        activeReferenceIds: Array.isArray(characterContext.activeReferenceIds) ? characterContext.activeReferenceIds : [],
      };
      const job = batchGenerator.startBatch('multi', config, generationOptions);
      jobIds.push(job.jobId);
    }
  }
  return jobIds;
}

// ── Memory builders ────────────────────────────────────────────────────────────

function buildSceneMemoryForPlan(plan) {
  const anchor = asText(plan && plan.sceneAnchor);
  if (!anchor) return null;
  return sceneMemoryService.createScene({
    name: `Carousel Scene: ${anchor}`.slice(0, 120),
    architecture: anchor,
    lightingProfile: 'cinematic mixed lighting',
    colorPalette: 'balanced premium tones',
    recurringElements: anchor,
    timeOfDayBias: 'mixed',
  });
}

function getOrCreateOutfit(outfitCache, outfitLabel) {
  const key = asText(outfitLabel) || 'coordinated premium outfit';
  if (outfitCache.has(key)) return outfitCache.get(key);
  const created = outfitMemoryService.createOutfit({
    name: `Carousel Outfit: ${key}`.slice(0, 120),
    top: key,
    bottom: `Coordinated bottom aligned with ${key}`,
    accessories: `Accessories aligned with ${key}`,
    footwear: `Footwear aligned with ${key}`,
  });
  outfitCache.set(key, created);
  return created;
}

// ── Prompt builders ────────────────────────────────────────────────────────────

function buildSlidePrompt(slide, narrative) {
  const s = slide || {};
  return [
    `CAROUSEL SLIDE ${s.slide || 1}`,
    `Narrative: ${asText(narrative)}`,
    `Shot type: ${asText(s.shotType)}`,
    `Framing type: ${asText(s.framingType)}`,
    `Angle type: ${asText(s.angleType)}`,
    `Expression: ${asText(s.expressionType)}`,
    `Pose: ${asText(s.pose)}`,
    `Outfit intent: ${asText(s.outfit)}`,
    `Location hint: ${asText(s.locationHint)}`,
    `Scene context: ${asText(s.userSceneContext)}`,
  ].join('\n');
}

function withImageQualityLock(prompt, { allowMotionBlur = false } = {}) {
  const blurRule = allowMotionBlur
    ? 'Allow only intentional cinematic motion blur from movement; keep face and identity-defining details crisp.'
    : 'No motion blur. No soft focus. No haze. No lens-smear look.';
  return [
    prompt, '',
    '[IMAGE QUALITY LOCK]',
    'Target output quality: ultra-clean 2K render with high micro-contrast and crisp edge detail.',
    'Preserve realistic skin texture without waxy smoothing.',
    blurRule,
    '[END IMAGE QUALITY LOCK]',
  ].join('\n');
}

function getKineticBlurSettings(mode) {
  if (mode === 'some') return { enabled: true, ratio: 0.35 };
  if (mode === 'more') return { enabled: true, ratio: 0.55 };
  return { enabled: false, ratio: 0 };
}

function selectKineticBlurIndices(total, ratio) {
  const count = Number.isInteger(total) ? total : 0;
  if (count <= 0 || ratio <= 0) return new Set();
  const target = Math.max(1, Math.min(count, Math.round(count * ratio)));
  const candidates = Array.from({ length: count }, (_, i) => i);
  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return new Set(candidates.slice(0, target));
}

function withKineticBlurPrompt(prompt, level = 'subtle') {
  const modeLine = level === 'strong'
    ? 'Use strong cinematic kinetic motion blur from subject movement or camera pan.'
    : 'Use subtle cinematic kinetic motion blur from subject movement or camera pan.';
  return [
    prompt, '',
    '[KINETIC MOTION BLUR]',
    modeLine,
    'Keep face and key identity-defining features clear and recognizable.',
    'Do not change outfit, location, lighting identity, or character identity.',
    '[END KINETIC MOTION BLUR]',
  ].join('\n');
}

// ── Image store helpers ────────────────────────────────────────────────────────

function ensureImageInStore(imageId) {
  try {
    imageStore.get(imageId);
    return imageId;
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'IMAGE_NOT_FOUND') throw err;
    const galleryEntry = galleryManager.get(imageId);
    const { filePath, mimeType } = galleryManager.getFilePath(imageId);
    const buffer = fs.readFileSync(filePath);
    const imported = imageStore.store({
      basePrompt: galleryEntry.prompt || 'Gallery image',
      characterId: galleryEntry.characterId || null,
      activeReferenceIds: null,
      sceneDescription: galleryEntry.prompt || null,
      modelUsed: null,
      seed: galleryEntry.seed || null,
      parentImageId: null,
      variationIndex: null,
      image: { mimeType, base64Data: buffer.toString('base64') },
      source: 'generate',
    });
    return imported.imageId;
  }
}

function importInlineImageToStore({ imageBase64, mimeType }) {
  if (!imageBase64 || typeof imageBase64 !== 'string') throw new AppError('"imageBase64" is required for inline image import', 400, 'VALIDATION_ERROR');
  if (!mimeType || typeof mimeType !== 'string') throw new AppError('"mimeType" is required for inline image import', 400, 'VALIDATION_ERROR');
  let base64Data = imageBase64.trim();
  const dataUriMatch = base64Data.match(/^data:image\/[\w.+-]+;base64,(.+)$/i);
  if (dataUriMatch) base64Data = dataUriMatch[1];
  const imported = imageStore.store({
    basePrompt: 'Inline uploaded image', characterId: null, activeReferenceIds: null,
    sceneDescription: null, modelUsed: null, seed: null, parentImageId: null, variationIndex: null,
    image: { mimeType, base64Data }, source: 'generate',
  });
  return imported.imageId;
}

// ── Utility ────────────────────────────────────────────────────────────────────

function parseJsonFromText(rawText) {
  const cleaned = String(rawText || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  if (!cleaned) return null;
  try { return JSON.parse(cleaned); } catch { }
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch { } }
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch { } }
  return null;
}

function uniqueNonEmptyStrings(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const value = asText(item);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function sanitizePollOptionPrompt(prompt, { enforceHairLock = false, enforceMirrorRealism = false } = {}) {
  const raw = asText(prompt);
  if (!raw) return '';
  const hasMirrorCue = /\b(mirror|reflection|reflective|selfie mirror)\b/i.test(raw);
  const looksOutdoor = /\b(outdoor|outside|street|alley|skatepark|beach|park|forest|cemetery|rooftop|city|downtown|sidewalk|road|highway|field|mountain|desert)\b/i.test(raw);
  let parts = raw.split(',').map((p) => p.trim()).filter(Boolean).filter((p) => !/\b(hair|hairstyle|split[- ]?dye|two[- ]?tone|ombre|balayage|highlights?)\b/i.test(p));
  if (enforceMirrorRealism && hasMirrorCue && looksOutdoor) parts = parts.filter((p) => !/\b(mirror|reflection|reflective|selfie mirror)\b/i.test(p));
  const cleaned = parts.join(', ').replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
  const locks = [];
  if (enforceHairLock) locks.push('[CHARACTER CONTINUITY LOCK]', 'Do not change hair color, hairstyle, or hair length from the locked character identity and references.', '[END CHARACTER CONTINUITY LOCK]');
  if (enforceMirrorRealism && hasMirrorCue && !looksOutdoor) locks.push('[CAPTURE CONSISTENCY LOCK]', 'Mirror selfie is allowed only with a clearly visible, plausible mirror plane and matching reflected environment.', 'No impossible floating mirror geometry or outdoor random mirror insertion.', '[END CAPTURE CONSISTENCY LOCK]');
  if (locks.length === 0) return cleaned || raw;
  return [cleaned || raw, '', ...locks].join('\n');
}

// ── Follow-up direction builders ───────────────────────────────────────────────

function normalizeDeltaDirection(direction) {
  const raw = asText(direction);
  if (!raw) return '';
  let cleaned = raw
    .replace(/\b(same outfit|same scene|same style|same lighting|identity lock|strict continuity)\b/gi, '')
    .replace(/\b(phone selfie|selfie camera|camera style|camera angle|lens|focal|lighting|illumination|exposure)\b/gi, '')
    .replace(/\b(scene|background|location|environment|wardrobe|clothing|outfit)\b/gi, '')
    .replace(/\b(bright|harsh frontal light|clean white|flat illumination)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
  const chunks = cleaned.split(/[.;\n|]+/).map((p) => p.trim()).filter(Boolean);
  const allowed = chunks.filter((chunk) => {
    const lower = chunk.toLowerCase();
    const isDelta = /(pose|expression|gaze|chin|head|hand|viewer|angle|lean|turn|look|smile|relaxed|confident|upper body|close[- ]?up|framing)/i.test(lower);
    const isContinuity = /(lighting|scene|background|outfit|clothing|camera|lens|environment|location)/i.test(lower);
    return isDelta && !isContinuity;
  });
  const out = allowed.join('; ').trim();
  return out || cleaned;
}

function extractWardrobeLock(baseMetadata) {
  const candidates = [asText(baseMetadata && baseMetadata.sceneDescription), asText(baseMetadata && baseMetadata.basePrompt)].filter(Boolean);
  for (const source of candidates) {
    const outfitIntent = source.match(/Outfit intent:\s*([^\n]+)/i);
    if (outfitIntent && outfitIntent[1]) return outfitIntent[1].trim();
    const outfit = source.match(/Outfit:\s*([^\n|]+)/i);
    if (outfit && outfit[1]) return outfit[1].trim();
    const top = source.match(/top:\s*([^\n]+)/i);
    const bottom = source.match(/bottom:\s*([^\n]+)/i);
    if (top || bottom) return [top ? `top ${top[1].trim()}` : '', bottom ? `bottom ${bottom[1].trim()}` : ''].filter(Boolean).join(', ');
  }
  return '';
}

function buildLockedModificationPrompt({ direction, strictContinuityLock = true, wardrobeLock = '', rawDirection = false }) {
  const variationRequest = (rawDirection ? asText(direction) : normalizeDeltaDirection(direction)) || 'Viewer/subject angle change, hand change, head tilt change, pose change, expression change.';
  if (!strictContinuityLock) return variationRequest;
  const wardrobeLine = wardrobeLock
    ? `Exact wardrobe lock: ${wardrobeLock}. Do not change garment type, color, or silhouette.`
    : 'Exact wardrobe lock: same clothing as base image. Do not change garment type, color, or silhouette.';
  return [
    'Maintain full strict 100% identity lock.',
    'Same scene, same camera style, same lighting.',
    'Image quality lock: tack-sharp focus, crisp facial detail, high texture fidelity, no haze or soft-focus wash. Preserve the same depth-of-field as the base image — do NOT add artificial background blur or bokeh that was not in the original.',
    wardrobeLine,
    'Subtle-change mode: micro-variation only (about 5-15% change from base image).',
    'Do not introduce dramatic new composition, distance, or body-position extremes.',
    'Only change what is requested below.',
    `Change only: ${variationRequest}`,
  ].join(' ');
}

function buildFallbackFollowUpDirections(sceneData, count, manualDirection = '', strictContinuityLock = true, wardrobeLock = '') {
  const safeCount = Math.max(1, Math.min(10, Number.isInteger(count) ? count : 4));
  const framingPool = ['slight off-center framing adjustment', 'small three-quarter framing shift', 'minor crop variation with same camera distance', 'gentle headroom change', 'slight lateral framing offset', 'subtle perspective nudge at similar focal feel'];
  const posePool = ['small shoulder turn', 'slight chin tilt adjustment', 'gentle hand placement change', 'minor torso angle shift', 'light head orientation change', 'subtle posture relaxation'];
  const expressionPool = ['expression: slight confident smile', 'expression: soft neutral gaze', 'expression: very mild smirk', 'expression: calm relaxed look', 'expression: subtle look-away', 'expression: composed editorial softness'];
  const directions = [];
  for (let i = 0; i < safeCount; i += 1) {
    const variation = [`Follow-up variant ${i + 1}: ${framingPool[i % framingPool.length]}; ${posePool[i % posePool.length]}; ${expressionPool[i % expressionPool.length]}.`, manualDirection ? `Extra direction: ${normalizeDeltaDirection(manualDirection)}.` : ''].filter(Boolean).join(' ');
    directions.push(buildLockedModificationPrompt({ direction: variation, strictContinuityLock, wardrobeLock }));
  }
  return directions;
}

async function buildAIFollowUpDirections({ imageBase64, mimeType, count, manualDirection = '', strictContinuityLock = true, wardrobeLock = '' }) {
  const safeCount = Math.max(1, Math.min(10, Number.isInteger(count) ? count : 4));
  const sceneData = await sceneAnalyzer.analyzeScene(imageBase64, mimeType);
  const prompt = `You generate unique follow-up image edit instructions.\n\nInput scene analysis:\n${JSON.stringify(sceneData, null, 2)}\n\nTask:\n- Return exactly ${safeCount} unique follow-up modification prompts.\n- Each prompt MUST vary framing, posing, and expression.\n- Prompts must be DELTA-ONLY: describe only what should change.\n- Do not restate scene/outfit/camera continuity in each prompt.\n- Base wardrobe lock reference: ${wardrobeLock || 'same exact outfit as base image'}.\n- Keep variation subtle: micro-adjustments only (about 5-15% change).\n- Avoid dramatic changes in camera distance, body orientation, or composition style.\n- Prefer one primary change + one secondary tweak per prompt.\n- Keep same single female identity.\n- No male interaction, no couples.\n${manualDirection ? `- Also respect this manual direction (delta-only): ${normalizeDeltaDirection(manualDirection)}` : ''}\n\nReturn JSON only in this format:\n{\n  "prompts": ["...", "..."]\n}`;

  const apiKey = apiKeyManager.getActiveKey();
  let parsed = null;
  try {
    const raw = await geminiService.generateText(apiKey, prompt, { temperature: 0.5, responseMimeType: 'application/json' });
    parsed = parseJsonFromText(raw);
  } catch { parsed = null; }

  const fromModel = uniqueNonEmptyStrings(parsed && Array.isArray(parsed.prompts) ? parsed.prompts : []);
  const modelPrompts = fromModel.map((item) => buildLockedModificationPrompt({ direction: item, strictContinuityLock, wardrobeLock, rawDirection: true }));
  if (modelPrompts.length >= safeCount) return modelPrompts.slice(0, safeCount);
  const fallback = buildFallbackFollowUpDirections(sceneData, safeCount, manualDirection, strictContinuityLock, wardrobeLock);
  return uniqueNonEmptyStrings([...modelPrompts, ...fallback]).slice(0, safeCount);
}

module.exports = {
  normalizeActiveReferenceIds, resolveActiveReferenceIds,
  startMultiBatches,
  buildSceneMemoryForPlan, getOrCreateOutfit,
  buildSlidePrompt, withImageQualityLock,
  getKineticBlurSettings, selectKineticBlurIndices, withKineticBlurPrompt,
  ensureImageInStore, importInlineImageToStore,
  parseJsonFromText, uniqueNonEmptyStrings, sanitizePollOptionPrompt,
  normalizeDeltaDirection, extractWardrobeLock, buildLockedModificationPrompt,
  buildFallbackFollowUpDirections, buildAIFollowUpDirections,
};
