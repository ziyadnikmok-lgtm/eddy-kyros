const { EventEmitter } = require('node:events');
const apiKeyManager = require('./apiKeyManager');
const geminiService = require('./geminiService');
const referenceManager = require('./referenceManager');
const promptBuilder = require('./promptBuilder');
const galleryManager = require('./galleryManager');
const loraDatasetStore = require('./loraDatasetStore');
const REALISM_DIRECTIVE = require('../utils/realismDirective');
const { AppError } = require('../middleware/errorHandler');
const { getUserId } = require('../userContext');

const FACE_VARIATIONS = [
  { label: 'clean front portrait', prompt: 'tight headshot portrait, facing camera, neutral expression, plain studio background', aspectRatio: '1:1' },
  { label: 'soft smile portrait', prompt: 'tight headshot portrait, subtle soft smile, natural daylight, simple indoor background', aspectRatio: '1:1' },
  { label: 'three quarter left portrait', prompt: 'head and shoulders portrait, three-quarter left angle, calm expression, soft shadows', aspectRatio: '1:1' },
  { label: 'three quarter right portrait', prompt: 'head and shoulders portrait, three-quarter right angle, relaxed expression, soft shadows', aspectRatio: '1:1' },
  { label: 'window light portrait', prompt: 'tight portrait lit by side window light, natural skin texture, minimal background', aspectRatio: '1:1' },
  { label: 'flash portrait', prompt: 'tight direct-flash portrait, crisp detail, casual candid vibe, uncluttered background', aspectRatio: '1:1' },
  { label: 'outdoor portrait', prompt: 'close outdoor portrait under overcast daylight, realistic skin texture, simple park background', aspectRatio: '1:1' },
  { label: 'serious portrait', prompt: 'headshot portrait with serious expression, centered framing, balanced soft light', aspectRatio: '1:1' },
  { label: 'laughing portrait', prompt: 'close portrait mid-laugh, natural expression, daylight, realistic facial detail', aspectRatio: '1:1' },
  { label: 'candid portrait', prompt: 'close candid portrait, relaxed off-camera glance, natural indoor light', aspectRatio: '1:1' },
  { label: 'golden hour portrait', prompt: 'close portrait at golden hour, warm directional light, realistic hair detail', aspectRatio: '1:1' },
  { label: 'profile leaning portrait', prompt: 'portrait near side profile, slight lean, soft light, shallow depth of field', aspectRatio: '1:1' },
  { label: 'upward chin portrait', prompt: 'close portrait with chin slightly raised, confident expression, clean neutral background', aspectRatio: '1:1' },
  { label: 'downward gaze portrait', prompt: 'close portrait with downward gaze, relaxed face, soft natural light', aspectRatio: '1:1' },
  { label: 'hair tucked portrait', prompt: 'close portrait with hair tucked behind one ear, neutral expression, clean background', aspectRatio: '1:1' },
];

const FULL_BODY_VARIATIONS = [
  { label: 'standing front full body', prompt: 'full body standing pose, facing camera, casual relaxed stance, plain background', aspectRatio: '4:5' },
  { label: 'walking full body', prompt: 'full body walking pose, natural stride, candid street-style energy, simple outdoor background', aspectRatio: '4:5' },
  { label: 'hands in pockets full body', prompt: 'full body standing pose with hands in pockets, relaxed posture, clean editorial framing', aspectRatio: '4:5' },
  { label: 'crossed legs full body', prompt: 'full body standing pose with weight on one hip and crossed legs, soft natural light', aspectRatio: '4:5' },
  { label: 'seated full body', prompt: 'full body seated on a simple chair, straight posture, realistic indoor scene', aspectRatio: '4:5' },
  { label: 'floor seated full body', prompt: 'full body seated on floor, knees bent, relaxed casual styling, clean background', aspectRatio: '4:5' },
  { label: 'leaning wall full body', prompt: 'full body leaning against wall, casual stance, balanced daylight, realistic proportions', aspectRatio: '4:5' },
  { label: 'park full body', prompt: 'full body portrait in a simple park setting, natural stance, overcast daylight', aspectRatio: '4:5' },
  { label: 'stairs full body', prompt: 'full body portrait on stairs, casual posture, clean composition, natural ambient light', aspectRatio: '4:5' },
  { label: 'turning full body', prompt: 'full body pose mid-turn, looking back toward camera, realistic motion freeze', aspectRatio: '4:5' },
  { label: 'arms folded full body', prompt: 'full body standing pose with folded arms, confident neutral expression, uncluttered setting', aspectRatio: '4:5' },
  { label: 'phone candid full body', prompt: 'full body candid holding phone, off-camera attention, casual real-life vibe', aspectRatio: '4:5' },
  { label: 'jacket adjustment full body', prompt: 'full body pose adjusting jacket or top layer, realistic fashion-photo stance', aspectRatio: '4:5' },
  { label: 'simple athletic full body', prompt: 'full body pose in simple athletic stance, balanced body proportions, clean minimal background', aspectRatio: '4:5' },
  { label: 'street full body', prompt: 'full body street-style portrait, neutral walk-up background, realistic candid framing', aspectRatio: '4:5' },
];

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeSlug(input, fallback = 'dataset') {
  const normalized = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

function buildCharacterReferenceImages(characterId, activeRefs) {
  const parts = [];
  const primaries = referenceManager.getPrimaryImages(characterId);
  for (const primary of primaries) {
    if (primary?.buffer?.length) {
      parts.push({ mimeType: primary.mimeType, base64Data: primary.buffer.toString('base64') });
    }
  }
  for (const ref of activeRefs || []) {
    const data = referenceManager.getReferenceImage(characterId, ref.id);
    if (data?.buffer?.length) {
      parts.push({ mimeType: data.mimeType, base64Data: data.buffer.toString('base64') });
    }
  }
  return parts;
}

function buildCaptionFallback(triggerWord, shotType, label) {
  return `${triggerWord}, ${shotType === 'face' ? 'portrait close-up' : 'full body portrait'}, ${label}`;
}

async function generateCaptionsBatch({ apiKey, items, triggerWord }) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const prompt = `Write one concise LoRA training caption for each image.

Rules:
- Start the caption with "${triggerWord}"
- Keep it between 10 and 30 words
- Describe visible subject details, clothing, pose, framing, and background
- Do not mention camera quality, aesthetics, training, dataset, or brand names
- Do not use hashtags, markdown, or commentary
- Return ONLY valid JSON with this shape:
{"captions":[{"index":1,"caption":"..."}]}

Image guide:
${items.map((item, idx) => `Image ${idx + 1}: shotType=${item.shotType}, label=${item.label}`).join('\n')}`;

  const raw = await geminiService.analyzeImagesWithPrompt(
    apiKey,
    items.map((item) => ({ base64Data: item.image.base64Data, mimeType: item.image.mimeType })),
    prompt
  );

  try {
    const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(cleaned);
    const captions = Array.isArray(parsed?.captions) ? parsed.captions : [];
    return items.map((item, idx) => {
      const match = captions.find((entry) => Number(entry?.index) === idx + 1);
      const caption = String(match?.caption || '').replace(/\s+/g, ' ').trim();
      if (!caption) return buildCaptionFallback(triggerWord, item.shotType, item.label);
      return caption.toLowerCase().startsWith(triggerWord.toLowerCase()) ? caption : `${triggerWord}, ${caption}`;
    });
  } catch {
    return items.map((item) => buildCaptionFallback(triggerWord, item.shotType, item.label));
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runNext() {
    while (cursor < items.length) {
      const current = cursor++;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
  return results;
}

class LoraDatasetManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this._activeRuns = new Set();
  }

  listRuns() {
    return loraDatasetStore.list();
  }

  getRun(id) {
    return loraDatasetStore.get(id);
  }

  startRun(input) {
    const userId = getUserId() || '__anon__';
    const { datasetName, characterId, triggerWord, imageModel } = input || {};
    if (!characterId || typeof characterId !== 'string') {
      throw new AppError('"characterId" is required', 400, 'VALIDATION_ERROR');
    }
    if (!triggerWord || typeof triggerWord !== 'string' || !triggerWord.trim()) {
      throw new AppError('"triggerWord" is required', 400, 'VALIDATION_ERROR');
    }

    const character = referenceManager.getCharacter(characterId);
    const safeTriggerWord = triggerWord.trim().slice(0, 60);
    const faceCount = clampInt(input?.faceCount, 1, FACE_VARIATIONS.length, 15);
    const fullBodyCount = clampInt(input?.fullBodyCount, 1, FULL_BODY_VARIATIONS.length, 15);
    const selectedImageModel = geminiService.resolveImageModel(imageModel);
    const finalDatasetName = (typeof datasetName === 'string' && datasetName.trim())
      ? datasetName.trim().slice(0, 120)
      : `${character.name} ${safeTriggerWord} dataset`;

    const requestedItems = [
      ...FACE_VARIATIONS.slice(0, faceCount).map((variant, idx) => ({ ...variant, shotType: 'face', order: idx + 1 })),
      ...FULL_BODY_VARIATIONS.slice(0, fullBodyCount).map((variant, idx) => ({ ...variant, shotType: 'full_body', order: idx + 1 })),
    ];

    const run = loraDatasetStore.create({
      userId,
      name: finalDatasetName,
      characterId,
      characterName: character.name,
      triggerWord: safeTriggerWord,
      imageModel: selectedImageModel,
      status: 'running',
      stage: 'queued',
      requested: {
        face: faceCount,
        fullBody: fullBodyCount,
        total: requestedItems.length,
      },
      progress: {
        generated: 0,
        captioned: 0,
        failed: 0,
        total: requestedItems.length,
      },
      items: [],
      failures: [],
    });

    this._activeRuns.add(run.id);
    this.emit('update', { datasetId: run.id, userId, status: 'running', stage: 'queued' });
    this._executeRun(run.id, requestedItems).catch((err) => {
      try {
        const current = loraDatasetStore.get(run.id);
        loraDatasetStore.update(run.id, {
          status: current.items?.length ? 'partial' : 'failed',
          stage: 'failed',
          failures: [...(current.failures || []), { stage: 'run', error: err.message || 'LoRA dataset run failed' }],
        });
        this.emit('update', { datasetId: run.id, userId, status: current.items?.length ? 'partial' : 'failed', stage: 'failed' });
      } catch {}
      this._activeRuns.delete(run.id);
    });

    return run;
  }

  async _executeRun(datasetId, requestedItems) {
    const apiKey = apiKeyManager.getActiveKey();
    const dataset = loraDatasetStore.get(datasetId);
    const activeRefs = referenceManager.getActiveReferences(dataset.characterId, null);
    const referenceImages = buildCharacterReferenceImages(dataset.characterId, activeRefs);
    const character = referenceManager.getCharacter(dataset.characterId);

    loraDatasetStore.update(datasetId, { stage: 'generating' });
    this.emit('update', { datasetId, userId: dataset.userId, status: 'running', stage: 'generating' });

    const generatedItems = await mapWithConcurrency(requestedItems, 2, async (variant) => {
      const userPrompt = [
        'Generate a clean LoRA training reference image of the same person/identity from the supplied character references.',
        `Shot requirement: ${variant.prompt}.`,
        variant.shotType === 'face'
          ? 'Frame the head and shoulders clearly, keep face unobstructed, single subject only.'
          : 'Show the full body clearly from head to toe, keep limbs visible, single subject only.',
        'Avoid extra people, text overlays, watermarks, cropped limbs, masks, heavy props, or distortions.',
        'Keep the background simple and useful for identity training.',
      ].join(' ');

      const finalPrompt = `${promptBuilder.buildPrompt({
        masterPrompt: character.masterPrompt,
        activeReferences: activeRefs,
        userPrompt,
      })}\n\n${REALISM_DIRECTIVE}`;

      try {
        const result = await geminiService.generateImage(apiKey, finalPrompt, {
          aspectRatio: variant.aspectRatio,
          imageSize: '2K',
          referenceImages,
          model: dataset.imageModel,
          characterId: dataset.characterId,
        });

        const galleryEntry = galleryManager.save({
          base64Data: result.image.base64Data,
          mimeType: result.image.mimeType,
          prompt: `[LoRA Dataset] ${dataset.name} - ${variant.label}`,
          source: 'lora-dataset',
          characterId: dataset.characterId,
          aspectRatio: variant.aspectRatio,
          seed: null,
          tags: ['lora-dataset', variant.shotType.replace('_', '-'), safeSlug(dataset.triggerWord, 'trigger')],
        });

        const current = loraDatasetStore.get(datasetId);
        loraDatasetStore.update(datasetId, {
          progress: {
            ...current.progress,
            generated: current.progress.generated + 1,
          },
          items: [
            ...(current.items || []),
            {
              index: (current.items || []).length + 1,
              shotType: variant.shotType,
              label: variant.label,
              aspectRatio: variant.aspectRatio,
              prompt: userPrompt,
              caption: null,
              galleryId: galleryEntry.id,
              createdAt: new Date().toISOString(),
            },
          ],
        });
        this.emit('update', { datasetId, userId: dataset.userId, status: 'running', stage: 'generating' });

        return {
          shotType: variant.shotType,
          label: variant.label,
          aspectRatio: variant.aspectRatio,
          prompt: userPrompt,
          galleryId: galleryEntry.id,
          image: result.image,
        };
      } catch (err) {
        const current = loraDatasetStore.get(datasetId);
        loraDatasetStore.update(datasetId, {
          progress: {
            ...current.progress,
            failed: current.progress.failed + 1,
          },
          failures: [
            ...(current.failures || []),
            { stage: 'generation', shotType: variant.shotType, label: variant.label, error: err.message },
          ],
        });
        this.emit('update', { datasetId, userId: dataset.userId, status: 'running', stage: 'generating' });
        return null;
      }
    });

    const successfulItems = generatedItems.filter(Boolean);
    if (successfulItems.length === 0) {
      loraDatasetStore.update(datasetId, { status: 'failed', stage: 'failed' });
      this.emit('update', { datasetId, userId: dataset.userId, status: 'failed', stage: 'failed' });
      this._activeRuns.delete(datasetId);
      return;
    }

    loraDatasetStore.update(datasetId, { stage: 'captioning' });
    this.emit('update', { datasetId, userId: dataset.userId, status: 'running', stage: 'captioning' });

    const captions = await generateCaptionsBatch({
      apiKey,
      items: successfulItems,
      triggerWord: dataset.triggerWord,
    });

    const current = loraDatasetStore.get(datasetId);
    const existingItems = current.items || [];
    const captionedItems = existingItems.map((item) => {
      const matchIndex = successfulItems.findIndex((candidate) => candidate.galleryId === item.galleryId);
      return matchIndex >= 0
        ? { ...item, caption: captions[matchIndex] || buildCaptionFallback(dataset.triggerWord, item.shotType, item.label) }
        : item;
    });

    const failed = current.progress.failed;
    const status = failed > 0 ? 'partial' : 'completed';
    loraDatasetStore.update(datasetId, {
      status,
      stage: 'completed',
      progress: {
        ...current.progress,
        captioned: successfulItems.length,
      },
      items: captionedItems,
    });
    this.emit('update', { datasetId, userId: dataset.userId, status, stage: 'completed' });
    this._activeRuns.delete(datasetId);
  }
}

module.exports = new LoraDatasetManager();
