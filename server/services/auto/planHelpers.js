'use strict';
const { asText } = require('../../utils/helpers');
const batchGenerator = require('../batchGenerator');
const styleLibrary = require('../styleLibrary');
const sceneMemoryService = require('../sceneMemoryService');
const outfitMemoryService = require('../outfitMemoryService');
const poseEngine = require('../poseEngine');
const externalProfileMemory = require('./externalProfileMemory');
const { buildFinalPrompt } = require('./promptBuilder');
const { buildDayImages } = require('./sampler');

const MAX_BATCH_PROMPTS = 20;
const DIVERSITY_SIMILARITY_THRESHOLD = 0.78;
const DIVERSITY_LOOKBACK = 12;

// ── Batch launching ────────────────────────────────────────────────────────────

function startMultiBatches(entries, generationOptions, characterContext = {}, styleAtomIds = [], { anchorFirst = false, specificReferences = [] } = {}) {
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
        styleAtomIds: Array.isArray(styleAtomIds) && styleAtomIds.length > 0 ? styleAtomIds : undefined,
        specificReferences: Array.isArray(specificReferences) && specificReferences.length > 0 ? specificReferences : undefined,
      };
      const job = batchGenerator.startBatch('multi', config, { ...generationOptions, anchorFirst });
      jobIds.push(job.jobId);
    }
  }
  return jobIds;
}

// ── Diversity / similarity ─────────────────────────────────────────────────────

function normalizePromptText(value) {
  return asText(value).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenizePromptText(prompt) {
  const normalized = normalizePromptText(prompt);
  if (!normalized) return [];
  const stop = new Set([
    'the', 'and', 'with', 'from', 'that', 'this', 'into', 'for', 'you', 'your', 'are', 'was',
    'she', 'her', 'his', 'their', 'have', 'has', 'had', 'only', 'very', 'more', 'less', 'over',
    'under', 'near', 'just', 'than', 'then', 'about', 'onto', 'across', 'image', 'photo',
    'single', 'subject', 'style', 'look', 'scene', 'context', 'wearing', 'showing',
  ]);
  return normalized.split(' ').filter((t) => t.length >= 3 && !stop.has(t));
}

function jaccardSimilarity(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let intersection = 0;
  for (const token of a) { if (b.has(token)) intersection += 1; }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function pickByIndex(list, index) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list[index % list.length];
}

function buildDiversityCue(indexSeed) {
  const cameraAngles = [
    'low-angle composition with stronger foreground depth',
    'eye-level candid framing with natural negative space',
    'slight overhead framing emphasizing environment layers',
    'tight three-quarter crop with edge lighting contrast',
    'wide establishing composition with subject offset',
  ];
  const framingChanges = [
    'place subject off-center using rule-of-thirds balance',
    'switch to asymmetrical composition with leading lines',
    'prioritize architectural geometry around the subject',
    'separate subject from background using depth and spacing',
    'use reflective or layered foreground elements',
  ];
  const microActions = [
    'capture a mid-motion transition instead of static posing',
    'introduce a subtle hand interaction with accessory or hair',
    'shift torso angle to create a fresh silhouette',
    'change gaze direction to a candid non-camera moment',
    'add a natural pause gesture between movements',
  ];
  return [
    'DIVERSITY COOL-DOWN:',
    `- Camera angle change: ${pickByIndex(cameraAngles, indexSeed)}`,
    `- Framing change: ${pickByIndex(framingChanges, indexSeed + 1)}`,
    `- Action change: ${pickByIndex(microActions, indexSeed + 2)}`,
    '- Avoid repeating previous prompt composition and wording.',
  ].join('\n');
}

function applySimilarityCooldown(prompt, cooldownState, indexSeed = 0) {
  const state = cooldownState || { recentTokenSets: [] };
  const tokens = tokenizePromptText(prompt);
  if (tokens.length === 0) return prompt;

  let maxSimilarity = 0;
  for (const prev of state.recentTokenSets.slice(-DIVERSITY_LOOKBACK)) {
    const score = jaccardSimilarity(tokens, prev);
    if (score > maxSimilarity) maxSimilarity = score;
  }

  let finalPrompt = prompt;
  let finalTokens = tokens;
  if (maxSimilarity >= DIVERSITY_SIMILARITY_THRESHOLD) {
    const cue = buildDiversityCue(indexSeed);
    finalPrompt = `${asText(prompt)}\n\n${cue}`;
    finalTokens = tokenizePromptText(finalPrompt);
  }
  state.recentTokenSets.push(finalTokens);
  if (state.recentTokenSets.length > 48) state.recentTokenSets = state.recentTokenSets.slice(-48);
  return finalPrompt;
}

// ── Plan building helpers ──────────────────────────────────────────────────────

function resolveActiveReferenceIds(activeReferenceIds, character) {
  const provided = Array.isArray(activeReferenceIds)
    ? activeReferenceIds.filter((id) => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
    : [];
  if (provided.length > 0) return provided;
  if (character && (character.profileImage || character.primaryImageFile)) return ['__profile__'];
  return [];
}

function buildAutoSceneMemory(weeklyPlan) {
  const locationCore = asText(weeklyPlan && weeklyPlan.location_core);
  const fallbackLocation = asText(weeklyPlan && Array.isArray(weeklyPlan.days) && weeklyPlan.days[0] && weeklyPlan.days[0].location_description);
  const detectedLocation = locationCore || fallbackLocation;
  if (!detectedLocation) return null;
  const firstDay = Array.isArray(weeklyPlan.days) ? weeklyPlan.days[0] : null;
  const aestheticKeywords = Array.isArray(weeklyPlan && weeklyPlan.aesthetic_keywords)
    ? weeklyPlan.aesthetic_keywords.map((item) => asText(item)).filter(Boolean) : [];
  return sceneMemoryService.createScene({
    name: `Auto Scene: ${detectedLocation}`.slice(0, 120),
    architecture: detectedLocation,
    lightingProfile: asText(firstDay && firstDay.lighting_style) || 'cinematic mixed lighting',
    colorPalette: aestheticKeywords.length ? aestheticKeywords.join(', ') : 'neutral luxe palette',
    recurringElements: aestheticKeywords.length ? aestheticKeywords.join(', ') : detectedLocation,
    timeOfDayBias: asText(firstDay && firstDay.time_of_day) || 'mixed golden and blue hour',
  });
}

function deriveDefaultFootwearLock(weeklyPlan, personaMode) {
  if (personaMode === 'cosplay' || personaMode === 'goth') return '';
  const source = [
    asText(weeklyPlan && weeklyPlan.location_core),
    asText(weeklyPlan && weeklyPlan.aesthetic_keywords && weeklyPlan.aesthetic_keywords.join(' ')),
    asText(weeklyPlan && Array.isArray(weeklyPlan.days) && weeklyPlan.days[0] && weeklyPlan.days[0].vibe),
  ].join(' ').toLowerCase();
  if (/\b(gym|fitness|training|workout|athletic)\b/.test(source)) return 'clean athletic training sneakers';
  if (/\b(beach|pool|coast|sand|island|resort)\b/.test(source)) return 'minimal strappy flat sandals';
  if (/\b(luxury|editorial|fashion|evening|gala|runway)\b/.test(source)) return 'sleek black stiletto heels';
  return '';
}

function resolveFootwearLock(weeklyPlan, requestedFootwearLock, personaMode) {
  const fromRequest = asText(requestedFootwearLock);
  if (fromRequest) return fromRequest;
  return deriveDefaultFootwearLock(weeklyPlan, personaMode);
}

function buildOutfitMemory(dayPlan, sampled, dayNumber, footwearLock, personaMode) {
  const sampledOutfit = asText(externalProfileMemory.sampleOutfit());
  const sourceOutfit = asText(sampled && sampled.carouselImages && sampled.carouselImages[0] && sampled.carouselImages[0].outfit)
    || asText(dayPlan && dayPlan.theme) || asText(dayPlan && dayPlan.vibe) || sampledOutfit || 'curated fashion look';
  const vibe = asText(dayPlan && dayPlan.vibe) || 'premium editorial';
  const resolvedFootwear = asText(footwearLock);

  if (personaMode === 'cosplay') {
    const cosplayTheme = asText(dayPlan && dayPlan.theme) || sourceOutfit;
    const costumeDesc = asText(dayPlan && dayPlan.costume_description);
    const wigDesc = asText(dayPlan && dayPlan.wig_description);
    return outfitMemoryService.createOutfit({
      name: `Cosplay Day ${dayNumber}`,
      top: `COSTUME LOCK — wear this EXACT outfit in ALL shots: ${costumeDesc || `Cosplay outfit for ${cosplayTheme}`}. WIG LOCK: ${wigDesc || `Character-accurate cosplay wig for ${cosplayTheme}`} — cosplay wig placed over natural hair (SAME person, different hair only), this wig is NON-NEGOTIABLE`,
      bottom: `MANDATORY: thigh-high stockings OR fishnets OR knee-high socks. Plus matching cosplay bottom as part of: ${costumeDesc || `Cosplay outfit for ${cosplayTheme}`}`,
      accessories: `Choker, character-themed hair clips, and props for ${cosplayTheme}. WIG: ${wigDesc || `Character-accurate cosplay wig for ${cosplayTheme}`}`,
      footwear: resolvedFootwear || `Character-matching footwear for ${cosplayTheme}`,
    });
  }

  if (personaMode === 'goth') {
    const gothTheme = asText(dayPlan && dayPlan.theme) || sourceOutfit;
    const costumeDesc = asText(dayPlan && dayPlan.costume_description);
    const hairDesc = asText(dayPlan && dayPlan.wig_description);
    return outfitMemoryService.createOutfit({
      name: `Goth Day ${dayNumber}`,
      top: `OUTFIT LOCK — wear this EXACT outfit: ${costumeDesc || `Goth outfit for ${gothTheme}`}. HAIR: ${hairDesc || 'dark hair, styled'}. BODY: keep EXACT proportions from reference — do NOT exaggerate any features`,
      bottom: `Fishnets or dark tights matching: ${costumeDesc || `Goth outfit for ${gothTheme}`}`,
      accessories: `Cross necklace or choker, chains, dark nails. For ${gothTheme}`,
      footwear: resolvedFootwear || 'platform boots or combat boots',
    });
  }

  return outfitMemoryService.createOutfit({
    name: `Auto Outfit Day ${dayNumber}`,
    top: sourceOutfit,
    bottom: `Coordinated bottom aligned with ${sampledOutfit || sourceOutfit}`,
    accessories: `Accessories styled for ${vibe}`,
    footwear: resolvedFootwear || `Footwear appropriate for ${vibe} setting`,
  });
}

function cameraProfileForType(type, backgroundLocked = false) {
  if (backgroundLocked) return 'led_room_ambient';
  if (type === 'reel' || type === 'story') return 'friend_phone_flash';
  return 'iphone_selfie';
}

function uniquePoseSequence(total) {
  if (total <= 0) return [];
  const list = poseEngine.getPoseList();
  const firstPassCount = Math.min(total, list.length);
  const firstPass = poseEngine.getUniquePoses(firstPassCount);
  if (total <= firstPass.length) return firstPass;
  const sequence = [...firstPass];
  while (sequence.length < total) sequence.push(list[sequence.length % list.length]);
  return sequence;
}

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
}

function resolveStyleAtomIds(weeklyPlan, userAtomIds) {
  const keywords = [
    ...tokenize(asText(weeklyPlan && weeklyPlan.location_core)),
    ...(Array.isArray(weeklyPlan && weeklyPlan.aesthetic_keywords) ? weeklyPlan.aesthetic_keywords.map((k) => String(k).toLowerCase().trim()) : []),
  ];
  const firstDay = weeklyPlan && Array.isArray(weeklyPlan.days) && weeklyPlan.days[0];
  if (firstDay) {
    keywords.push(...tokenize(asText(firstDay.vibe)));
    keywords.push(...tokenize(asText(firstDay.theme)));
    keywords.push(...tokenize(asText(firstDay.lighting_style)));
  }
  const provided = Array.isArray(userAtomIds) ? userAtomIds.filter(Boolean) : [];
  try {
    const autoSelected = styleLibrary.autoSelect(keywords, { excludeIds: provided });
    return [...provided, ...autoSelected];
  } catch {
    return provided;
  }
}

// ── Main plan builder ──────────────────────────────────────────────────────────

function buildAutoPlanData({ weeklyPlan, characterConfig, carouselCount, includeReels, reelCount, includeStories = false, storyCount = 1, similarityCooldown = 'on', footwearLock = '', styleAtomIds = [], personaMode = '', backgroundLocked = false }) {
  const sceneMemory = backgroundLocked ? null : buildAutoSceneMemory(weeklyPlan);
  const sceneMemoryId = sceneMemory ? sceneMemory.id : null;
  const runFootwearLock = resolveFootwearLock(weeklyPlan, footwearLock, personaMode);
  const mergedAtomIds = resolveStyleAtomIds(weeklyPlan, styleAtomIds);
  const imageEntries = [];
  const cooldownEnabled = similarityCooldown !== 'off';
  const cooldownState = { recentTokenSets: [] };

  const days = weeklyPlan.days.map((dayPlan, index) => {
    const sampled = buildDayImages({ dayPlan, characterConfig, carouselCount, includeReels, reelCount });
    const dayNumber = Number.isInteger(dayPlan && dayPlan.day) ? dayPlan.day : index + 1;
    const outfitMemory = buildOutfitMemory(dayPlan, sampled, dayNumber, runFootwearLock, personaMode);
    const outfitId = outfitMemory.id;
    const sharedLocation = sampled.carouselImages[0] ? sampled.carouselImages[0].location : (dayPlan && dayPlan.location_description) || null;
    const hasLifestyle = !!((sampled.lifestyleInsert && sampled.lifestyleInsert.description) || '');
    const totalPoseSlots = sampled.carouselImages.length + sampled.reelImages.length + (hasLifestyle ? 1 : 0);
    const dayPoses = uniquePoseSequence(totalPoseSlots);
    let poseCursor = 0;

    const carouselPrompts = sampled.carouselImages.map((item) => {
      const assignedPose = dayPoses[poseCursor] || item.pose;
      poseCursor += 1;
      const prompt = buildFinalPrompt({ dayPlan, pose: assignedPose, location: item.location, personaMode, backgroundLocked });
      return cooldownEnabled ? applySimilarityCooldown(prompt, cooldownState, dayNumber + poseCursor) : prompt;
    }).filter((p) => typeof p === 'string' && p.trim().length > 0);

    const lifestylePrompt = hasLifestyle
      ? (() => {
        const base = buildFinalPrompt({ dayPlan, pose: dayPoses[poseCursor] || sampled.lifestyleInsert.description, location: sharedLocation, personaMode, backgroundLocked });
        return cooldownEnabled ? applySimilarityCooldown(base, cooldownState, dayNumber + poseCursor + 17) : base;
      })()
      : '';
    if (hasLifestyle) poseCursor += 1;

    const reelPrompts = sampled.reelImages.map((item) => {
      const assignedPose = dayPoses[poseCursor] || item.pose;
      poseCursor += 1;
      const prompt = buildFinalPrompt({ dayPlan, pose: assignedPose, location: sharedLocation, personaMode, backgroundLocked });
      return cooldownEnabled ? applySimilarityCooldown(prompt, cooldownState, dayNumber + poseCursor + 31) : prompt;
    }).filter((p) => typeof p === 'string' && p.trim().length > 0);

    const usedCarouselPoses = new Set(sampled.carouselImages.map((item) => String(item.pose || '').trim()).filter(Boolean));
    const posePool = Array.isArray(characterConfig && characterConfig.life_story && characterConfig.life_story.pose_inspiration)
      ? characterConfig.life_story.pose_inspiration.map((pose) => typeof pose === 'string' ? pose : (pose && typeof pose === 'object' ? (pose.name || pose.title || pose.description || '') : '')).map((p) => String(p || '').trim()).filter(Boolean) : [];

    const storyPrompts = [];
    if (includeStories) {
      const nonCarouselPoses = posePool.filter((p) => !usedCarouselPoses.has(p));
      for (let s = 0; s < storyCount; s += 1) {
        let storyPose = nonCarouselPoses[s % Math.max(nonCarouselPoses.length, 1)] || sampled.reelImages[s % Math.max(sampled.reelImages.length, 1)]?.pose || 'light candid story moment';
        if (usedCarouselPoses.has(String(storyPose || '').trim())) storyPose = `${storyPose} (alternate candid angle ${s + 1})`;
        const basePrompt = `${buildFinalPrompt({ dayPlan, pose: storyPose, location: sharedLocation, personaMode, backgroundLocked })}\nStory style: lighter candid vertical moment`;
        const prompt = cooldownEnabled ? applySimilarityCooldown(basePrompt, cooldownState, dayNumber + s + 53) : basePrompt;
        if (typeof prompt === 'string' && prompt.trim().length > 0) storyPrompts.push(prompt);
      }
    }

    imageEntries.push(...carouselPrompts.map((prompt) => ({ type: 'carousel', prompt, sceneMemoryId, outfitId, cameraProfileId: cameraProfileForType('carousel', backgroundLocked) })));
    if (lifestylePrompt && lifestylePrompt.trim().length > 0) imageEntries.push({ type: 'lifestyle', prompt: lifestylePrompt, sceneMemoryId, outfitId, cameraProfileId: cameraProfileForType('carousel', backgroundLocked) });
    imageEntries.push(...reelPrompts.map((prompt) => ({ type: 'reel', prompt, sceneMemoryId, outfitId, cameraProfileId: cameraProfileForType('reel', backgroundLocked) })));
    imageEntries.push(...storyPrompts.map((prompt) => ({ type: 'story', prompt, sceneMemoryId, outfitId, cameraProfileId: cameraProfileForType('reel', backgroundLocked) })));

    return {
      day: dayNumber,
      carouselPrompts, lifestylePrompt, reelPrompts, storyPrompts,
      sceneMemoryId, outfitId,
      cameraProfiles: { carousel: cameraProfileForType('carousel', backgroundLocked), reel: cameraProfileForType('reel', backgroundLocked) },
      footwearLock: runFootwearLock,
    };
  });

  return { days, imageEntries, sceneMemoryId, footwearLock: runFootwearLock, styleAtomIds: mergedAtomIds };
}

module.exports = {
  startMultiBatches, resolveActiveReferenceIds, buildAutoPlanData,
  normalizePromptText, tokenizePromptText, jaccardSimilarity, applySimilarityCooldown,
  buildAutoSceneMemory, resolveFootwearLock, buildOutfitMemory,
  cameraProfileForType, uniquePoseSequence, resolveStyleAtomIds,
};
