// server/services/batchGenerator.js

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AppError } = require('../middleware/errorHandler');
const apiKeyManager = require('./apiKeyManager');
const geminiService = require('./geminiService');
const referenceManager = require('./referenceManager');
const { atomicWriteJSON } = require('../utils/helpers');
const promptBuilder = require('./promptBuilder');
const imageStore = require('./imageStore');
const tweakBuilder = require('./tweakBuilder');
const galleryManager = require('./galleryManager');
const sceneMemoryService = require('./sceneMemoryService');
const outfitMemoryService = require('./outfitMemoryService');
const cameraProfileService = require('./cameraProfileService');
const poseEngine = require('./poseEngine');
const expressionEngine = require('./expressionEngine');
const sceneModeEngine = require('./sceneModeEngine');

const cfg = require('../config');

// Cache content type presets at module load (avoids blocking readFileSync per request)
const _contentPresets = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(require('../paths').DATA_DIR, 'contentTypePresets.json'), 'utf-8'));
  } catch { return []; }
})();

// ---------------------------------------------------------------------------
// Constants (from central config)
// ---------------------------------------------------------------------------

const MAX_CONCURRENCY = cfg.BATCH_MAX_CONCURRENCY;
const MAX_BATCH_SIZE = cfg.BATCH_MAX_SIZE;
const MAX_RUNNING_JOBS = cfg.BATCH_MAX_RUNNING_JOBS;
const JOB_TTL_MS = cfg.BATCH_JOB_TTL_MS;
const CLEANUP_INTERVAL_MS = cfg.BATCH_CLEANUP_INTERVAL_MS;
const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_REFERENCE_BYTES = cfg.MAX_REFERENCE_BYTES;

// ---------------------------------------------------------------------------
// Concurrency-limited task runner
// ---------------------------------------------------------------------------

class TaskQueue {
  constructor(concurrency) {
    this._concurrency = concurrency;
    this._running = 0;
    this._queue = [];
  }

  /**
   * Enqueue an async function. Returns a promise that resolves/rejects
   * with the function's result. Respects concurrency limit.
   */
  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this._running < this._concurrency && this._queue.length > 0) {
      const { fn, resolve, reject } = this._queue.shift();
      this._running++;
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          this._running--;
          this._drain();
        });
    }
  }
}

// Shared queue across all batch jobs — enforces global concurrency cap
const globalQueue = new TaskQueue(MAX_CONCURRENCY);

// ---------------------------------------------------------------------------
// Job store
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
const jobs = new Map();

// Persistent job store — saves completed job metadata (no image data) to survive restarts
const JOB_STORE_PATH = require('../paths').BATCH_STORE;

function _loadPersistedJobs() {
  try {
    if (!fs.existsSync(JOB_STORE_PATH)) return;
    const raw = fs.readFileSync(JOB_STORE_PATH, 'utf8');
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    const now = Date.now();
    for (const entry of entries) {
      // Only restore non-expired finished jobs
      if (entry._completedAt && now - entry._completedAt <= JOB_TTL_MS) {
        jobs.set(entry.jobId, entry);
      }
    }
  } catch { /* persisted store unavailable — start fresh */ }
}

let _persistPending = false;
function _persistJobs() {
  if (_persistPending) return; // coalesce rapid writes
  _persistPending = true;
  queueMicrotask(() => {
    _persistPending = false;
    try {
      const dir = path.dirname(JOB_STORE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Only persist completed/failed/cancelled jobs (not running — those won't resume)
      // Strip image base64 data from results to keep file small
      const entries = [];
      for (const job of jobs.values()) {
        if (job.status === 'running') continue;
        const lite = { ...job };
        if (Array.isArray(lite.results)) {
          lite.results = lite.results.map((r) => {
            if (!r) return r;
            const { image, ...rest } = r;
            return rest;
          });
        }
        delete lite._sharedBaseImage;
        entries.push(lite);
      }
      atomicWriteJSON(JOB_STORE_PATH, entries, 0);
    } catch { /* persist best-effort — non-critical */ }
  });
}

// Load on startup
_loadPersistedJobs();

// Periodic cleanup of expired jobs
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  let removed = false;
  for (const [jobId, job] of jobs) {
    if (job._completedAt && now - job._completedAt > JOB_TTL_MS) {
      jobs.delete(jobId);
      removed = true;
    }
  }
  if (removed) _persistJobs();
}, CLEANUP_INTERVAL_MS);

// Prevent the timer from keeping Node alive when the process would otherwise exit
if (cleanupTimer.unref) cleanupTimer.unref();

// ---------------------------------------------------------------------------
// Batch Generator
// ---------------------------------------------------------------------------

class BatchGenerator extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // allow many concurrent SSE clients
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Start a batch job. Returns the job object immediately;
   * processing continues asynchronously.
   *
   * @param {"variation"|"multi"|"override"} mode
   * @param {object} config - Mode-specific configuration
   * @returns {object} Initial job status
   */
  startBatch(mode, config, generationOptions = {}) {
    this._validateMode(mode);

    // Reject if too many jobs are already running
    let runningCount = 0;
    for (const job of jobs.values()) {
      if (job.status === 'running') runningCount++;
    }
    if (runningCount >= MAX_RUNNING_JOBS) {
      throw new AppError(
        `Max ${MAX_RUNNING_JOBS} concurrent batch jobs allowed. Wait for a running job to finish or cancel one.`,
        429,
        'TOO_MANY_JOBS'
      );
    }

    const aspectRatio = generationOptions.aspectRatio || '1:1';
    const imageSize = generationOptions.imageSize || '1K';

    let tasks;
    switch (mode) {
      case 'variation':
        tasks = this._buildVariationTasks(config);
        break;
      case 'multi':
        tasks = this._buildMultiTasks(config);
        break;
      case 'override':
        tasks = this._buildOverrideTasks(config);
        break;
      case 'edit':
        tasks = this._buildEditTasks(config);
        break;
      case 'content-mix':
        tasks = this._buildContentMixTasks(config);
        break;
    }

    if (tasks.length === 0) {
      throw new AppError('Batch produced 0 tasks. Check your config.', 400, 'EMPTY_BATCH');
    }

    // For edit mode, hoist the shared base image to job level so it is stored
    // once instead of duplicated across every task (~2MB × N tasks avoided).
    let sharedBaseImage = null;
    if (mode === 'edit') {
      const first = tasks.find((t) => t.baseImage && t.baseImage.base64Data);
      if (first) {
        sharedBaseImage = first.baseImage;
        for (const task of tasks) {
          if (task.baseImage) {
            task.baseImage = { mimeType: task.baseImage.mimeType };
          }
        }
      }
    }

    const promptLayers = this._resolvePromptLayers(config, tasks.length);
    const enrichedTasks = tasks.map((task, index) => ({
      ...task,
      sceneMemory: promptLayers.sceneMemory,
      outfit: promptLayers.outfit,
      cameraProfile: promptLayers.cameraProfile,
      pose: promptLayers.poses ? promptLayers.poses[index] : null,
      expression: promptLayers.expression || null,
      sceneModeText: promptLayers.sceneModeText || null,
      styleLibraryBlock: promptLayers.styleLibraryBlock || '',
    }));

    const jobId = crypto.randomUUID();
    const job = {
      jobId,
      mode,
      status: 'running',
      total: enrichedTasks.length,
      completed: 0,
      failed: 0,
      results: new Array(enrichedTasks.length).fill(null),
      _cancelled: false,
      _completedAt: null,
      _sharedBaseImage: sharedBaseImage,
      _config: this._sanitizeConfigForHistory(mode, config),
      aspectRatio,
      imageSize,
      createdAt: new Date().toISOString(),
    };
    jobs.set(jobId, job);

    // Fire-and-forget — errors are captured per-task; guard against
    // unhandled rejection from any unexpected top-level failure
    this._executeTasks(job, enrichedTasks).catch(() => {
      if (job.status === 'running') {
        job.status = 'failed';
        job._completedAt = Date.now();
        _persistJobs();
      }
    });

    return this._toSafeJob(job);
  }

  /**
   * Get current job status.
   */
  getJob(jobId) {
    if (!jobId || typeof jobId !== 'string') {
      throw new AppError('Job ID is required', 400, 'VALIDATION_ERROR');
    }
    const job = jobs.get(jobId);
    if (!job) {
      throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    }
    return this._toSafeJob(job);
  }

  /**
   * Cancel a running job. Already-completed results are preserved.
   */
  cancelJob(jobId) {
    if (!jobId || typeof jobId !== 'string') {
      throw new AppError('Job ID is required', 400, 'VALIDATION_ERROR');
    }
    const job = jobs.get(jobId);
    if (!job) {
      throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    }
    if (job.status !== 'running') {
      throw new AppError(`Cannot cancel job with status "${job.status}"`, 400, 'INVALID_STATE');
    }

    job._cancelled = true;
    job.status = 'cancelled';
    job._completedAt = Date.now();
    _persistJobs();

    return this._toSafeJob(job);
  }

  // =========================================================================
  // Task builders — one per mode
  // =========================================================================

  /**
   * Mode A: Variation
   * Same base prompt, multiple generations with seed/temperature variation.
   */
  _buildVariationTasks(config) {
    const { prompt, count, randomizeSeed, temperatureRange, characterId, activeReferenceIds } = config || {};

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new AppError('"prompt" is required for variation mode', 400, 'VALIDATION_ERROR');
    }
    const taskCount = this._validateCount(count);

    // If characterId provided, resolve the prompt through identity lock
    let basePrompt = prompt.trim();
    if (characterId) {
      basePrompt = this._resolveCharacterPrompt(characterId, activeReferenceIds, prompt.trim());
    }

    const tasks = [];
    for (let i = 0; i < taskCount; i++) {
      const seed = randomizeSeed ? crypto.randomInt(0, 2147483647) : undefined;
      let temperature;
      if (temperatureRange && typeof temperatureRange.min === 'number' && typeof temperatureRange.max === 'number') {
        const min = Math.max(0, Math.min(2, temperatureRange.min));
        const max = Math.max(min, Math.min(2, temperatureRange.max));
        temperature = min + Math.random() * (max - min);
        temperature = Math.round(temperature * 100) / 100;
      }

      tasks.push({
        index: i,
        prompt: basePrompt,
        seed,
        temperature,
        characterId: characterId || null,
        activeReferenceIds: activeReferenceIds || null,
        userPrompt: prompt.trim(),
      });
    }
    return tasks;
  }

  /**
   * Mode B: Multi-Prompt
   * One image per distinct prompt.
   */
  _buildMultiTasks(config) {
    const { prompts, temperature, seed, characterId, activeReferenceIds, styleAtomIds } = config || {};

    if (!Array.isArray(prompts) || prompts.length === 0) {
      throw new AppError('"prompts" array is required for multi mode', 400, 'VALIDATION_ERROR');
    }
    if (prompts.length > MAX_BATCH_SIZE) {
      throw new AppError(`Max ${MAX_BATCH_SIZE} prompts per batch`, 400, 'BATCH_TOO_LARGE');
    }

    const tasks = [];
    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      if (!p || typeof p !== 'string' || p.trim().length === 0) {
        throw new AppError(`prompts[${i}] is empty or invalid`, 400, 'VALIDATION_ERROR');
      }
      tasks.push({
        index: i,
        prompt: p.trim(),
        temperature: typeof temperature === 'number' ? temperature : undefined,
        seed: typeof seed === 'number' ? seed : undefined,
        characterId: characterId || null,
        activeReferenceIds: Array.isArray(activeReferenceIds) ? activeReferenceIds : null,
        styleAtomIds: Array.isArray(styleAtomIds) ? styleAtomIds : null,
        userPrompt: p.trim(),
      });
    }
    return tasks;
  }

  /**
   * Mode C: Override Iteration
   * For each override set, build an identity-locked prompt and generate.
   */
  _buildOverrideTasks(config) {
    const { characterId, overrideSets, prompt } = config || {};

    if (!characterId || typeof characterId !== 'string') {
      throw new AppError('"characterId" is required for override mode', 400, 'VALIDATION_ERROR');
    }
    if (!Array.isArray(overrideSets) || overrideSets.length === 0) {
      throw new AppError('"overrideSets" array is required for override mode', 400, 'VALIDATION_ERROR');
    }
    if (overrideSets.length > MAX_BATCH_SIZE) {
      throw new AppError(`Max ${MAX_BATCH_SIZE} override sets per batch`, 400, 'BATCH_TOO_LARGE');
    }

    // Validate character exists upfront
    const character = referenceManager.getCharacter(characterId);

    const tasks = [];
    for (let i = 0; i < overrideSets.length; i++) {
      const set = overrideSets[i];
      if (!set || !Array.isArray(set.referenceIds)) {
        throw new AppError(`overrideSets[${i}] must have a "referenceIds" array`, 400, 'VALIDATION_ERROR');
      }

      // Validate that all referenced IDs exist
      for (const refId of set.referenceIds) {
        const exists = character.references.some((r) => r.id === refId);
        if (!exists) {
          throw new AppError(
            `Reference "${refId}" in overrideSets[${i}] not found on character "${character.name}"`,
            404,
            'REFERENCE_NOT_FOUND'
          );
        }
      }

      // Build identity-locked prompt for this set
      const activeRefs = referenceManager.getActiveReferences(characterId, set.referenceIds);
      const builtPrompt = promptBuilder.buildPrompt({
        masterPrompt: character.masterPrompt,
        activeReferences: activeRefs,
        userPrompt: (prompt && typeof prompt === 'string') ? prompt.trim() : '',
      });

      tasks.push({
        index: i,
        prompt: builtPrompt,
        characterId,
        activeReferenceIds: set.referenceIds,
        userPrompt: (prompt && typeof prompt === 'string') ? prompt.trim() : null,
      });
    }
    return tasks;
  }

  /**
   * Mode D: Edit Existing Image
   * Takes an existing image and generates multiple edited variations.
   */
  _buildEditTasks(config) {
    const {
      imageId,
      modificationPrompt,
      count,
      characterId,
      activeReferenceIds,
      disableCharacterReferenceImages,
      disableCharacterIdentityLock,
      customReferenceImages,
    } = config || {};

    if (!imageId || typeof imageId !== 'string') {
      throw new AppError('"imageId" is required for edit mode', 400, 'VALIDATION_ERROR');
    }
    if (!modificationPrompt || typeof modificationPrompt !== 'string' || modificationPrompt.trim().length === 0) {
      throw new AppError('"modificationPrompt" is required for edit mode', 400, 'VALIDATION_ERROR');
    }

    const original = imageStore.get(imageId);
    if (!original.image) {
      throw new AppError('Cannot edit an image with no image data', 400, 'NO_IMAGE_DATA');
    }

    const taskCount = this._validateCount(count || 4);
    const tasks = [];
    const specificReferences = this._parseCustomReferenceImages(customReferenceImages);

    for (let i = 0; i < taskCount; i++) {
      // Build a tweak-style prompt that preserves scene + applies modification
      const tweakPrompt = tweakBuilder.buildTweakPrompt({
        originalMetadata: original,
        modifications: { mood: modificationPrompt.trim() },
      });

      const shouldUseCharacterLock = !disableCharacterIdentityLock && !!characterId;
      const finalPrompt = shouldUseCharacterLock
        ? this._resolveCharacterPrompt(
          characterId,
          Array.isArray(activeReferenceIds) ? activeReferenceIds : null,
          tweakPrompt
        )
        : tweakPrompt;

      tasks.push({
        index: i,
        prompt: finalPrompt,
        characterId: disableCharacterIdentityLock ? null : (characterId || original.characterId),
        activeReferenceIds: disableCharacterIdentityLock
          ? null
          : (characterId
            ? (Array.isArray(activeReferenceIds) ? activeReferenceIds : null)
            : original.activeReferenceIds),
        disableCharacterReferenceImages: disableCharacterReferenceImages === true,
        userPrompt: modificationPrompt.trim(),
        baseImage: original.image
          ? {
            mimeType: original.image.mimeType,
            base64Data: original.image.base64Data,
          }
          : null,
        specificReferences,
      });
    }
    return tasks;
  }

  /**
   * Mode E: Content Mix — distributes images across content categories
   * using the 40/30/20/10 rule (lifestyle/personality/teasing/engagement).
   */
  _buildContentMixTasks(config) {
    const {
      totalCount,
      distribution,
      characterId,
      activeReferenceIds,
      baseThemes,
    } = config || {};

    const count = this._validateCount(totalCount || 10);

    const categories = ['lifestyle', 'personality', 'teasing', 'engagement'];
    const defaultDist = { lifestyle: 40, personality: 30, teasing: 20, engagement: 10 };
    const dist = distribution && typeof distribution === 'object' ? distribution : defaultDist;

    const total = categories.reduce((sum, cat) => sum + (dist[cat] || 0), 0);
    if (total !== 100) {
      throw new AppError(`Distribution must sum to 100%, got ${total}%`, 400, 'VALIDATION_ERROR');
    }

    // Use cached content type presets (loaded once at module level)
    if (!_contentPresets || _contentPresets.length === 0) {
      throw new AppError('Content type presets not available', 500, 'PRESETS_MISSING');
    }
    const allPresets = _contentPresets;

    // Distribute count across categories (last category gets remainder)
    const catCounts = {};
    let assigned = 0;
    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      const pct = dist[cat] || 0;
      if (i === categories.length - 1) {
        catCounts[cat] = count - assigned;
      } else {
        catCounts[cat] = Math.round(count * pct / 100);
        assigned += catCounts[cat];
      }
    }

    const tasks = [];
    let index = 0;
    for (const cat of categories) {
      const catCount = catCounts[cat];
      if (catCount <= 0) continue;

      const presets = allPresets.filter(p => p.contentType === cat);
      const customTheme = baseThemes && typeof baseThemes[cat] === 'string' ? baseThemes[cat].trim() : '';

      for (let i = 0; i < catCount; i++) {
        let promptText;
        if (customTheme) {
          promptText = customTheme;
        } else if (presets.length > 0) {
          const preset = presets[Math.floor(Math.random() * presets.length)];
          const atoms = preset.suggestedAtoms || {};
          promptText = Object.entries(atoms).map(([k, v]) => `${k}: ${v}`).join('\n');
        } else {
          promptText = `${cat} content — natural, authentic, Instagram-ready`;
        }

        tasks.push({
          index,
          prompt: promptText,
          characterId: characterId || null,
          activeReferenceIds: Array.isArray(activeReferenceIds) ? activeReferenceIds : null,
          userPrompt: promptText,
          tags: [cat],
          contentCategory: cat,
          seed: crypto.randomInt(0, 2147483647),
        });
        index++;
      }
    }

    return tasks;
  }

  // =========================================================================
  // Execution engine
  // =========================================================================

  /**
   * Execute all tasks against the global concurrency-limited queue.
   * Errors are captured per-task — never crash the server.
   */
  async _executeTasks(job, tasks) {
    // Get API key once for the entire batch
    let apiKey;
    try {
      apiKey = apiKeyManager.getActiveKey();
    } catch (err) {
      // Fatal: no key → fail entire job
      job.status = 'failed';
      job._completedAt = Date.now();
      for (let i = 0; i < tasks.length; i++) {
        job.results[i] = {
          index: i,
          success: false,
          image: null,
          error: err.message || 'No active API key',
        };
        job.failed++;
      }
      _persistJobs();
      return;
    }

    // Pre-cache character data once per unique characterId to avoid N sync disk lookups
    const characterCache = new Map();
    for (const task of tasks) {
      if (task.characterId && !characterCache.has(task.characterId)) {
        try {
          characterCache.set(task.characterId, await this.getCharacterById(task.characterId));
        } catch { /* will fail again per-task with proper error handling */ }
      }
    }

    const promises = tasks.map((task) =>
      globalQueue.enqueue(async () => {
        // Check cancellation before starting
        if (job._cancelled) {
          job.results[task.index] = {
            index: task.index,
            success: false,
            image: null,
            error: 'Job cancelled',
          };
          return;
        }

        try {
          let character = null;
          let referenceImages = [];
          if (task.characterId) {
            character = characterCache.get(task.characterId) || await this.getCharacterById(task.characterId);
            if (!task.disableCharacterReferenceImages) {
              // Always include primary images first — they're the strongest identity anchors
              const profileImages = this._resolveProfileImage(task.characterId);
              if (profileImages) referenceImages.push(...profileImages);

              const requestedRefIds = Array.isArray(task.activeReferenceIds)
                ? task.activeReferenceIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
                : null;

              if (requestedRefIds && requestedRefIds.length > 0) {
                for (const refId of requestedRefIds) {
                  if (refId === '__profile__') continue; // already added above
                  // Resolve to buffer immediately instead of pushing metadata
                  const resolved = this._resolveReferenceImage(task.characterId, { id: refId });
                  if (resolved) referenceImages.push(resolved);
                }
              } else {
                // No explicit IDs — use all active references
                const refs = Array.isArray(character.references) ? character.references.filter((r) => r.isActive) : [];
                for (const ref of refs) {
                  const resolved = this._resolveReferenceImage(task.characterId, ref);
                  if (resolved) referenceImages.push(resolved);
                }
              }
            }
          }

          // Build variation suffix for seed/temperature injection
          let taskPrompt = task.prompt;
          if (task.seed !== undefined) {
            taskPrompt += `\n[Seed: ${task.seed}]`;
          }

          const identityLockSection = character
            ? [
              '[IDENTITY LOCK]',
              'This character is identity-locked.',
              'The following identity description is NON-NEGOTIABLE.',
              '',
              'Do NOT:',
              '- Normalize anatomy',
              '- Average toward realism',
              '- Alter proportions',
              '- Change face structure',
              '- Change ethnicity',
              '- Reduce exaggerated features',
              '- Modify skeletal ratios',
              '- Remove defining marks',
              '',
              character.masterPrompt || '',
              '',
              'If identity changes, output is invalid.',
              '',
              'STRICT SOLO RULES:',
              '- Single female subject only.',
              '- No male interaction.',
              '- No couples.',
              '- No romantic physical contact.',
            ].join('\n')
            : [
              '[IDENTITY LOCK]',
              'No explicit identity lock provided.',
              '',
              'STRICT SOLO RULES:',
              '- Single female subject only.',
              '- No male interaction.',
              '- No couples.',
              '- No romantic physical contact.',
            ].join('\n');

          const sceneDnaSection = task.sceneMemory
            ? [
              'SCENE DNA',
              `architecture: ${task.sceneMemory.architecture}`,
              `lightingProfile: ${task.sceneMemory.lightingProfile}`,
              `colorPalette: ${task.sceneMemory.colorPalette}`,
              `recurringElements: ${task.sceneMemory.recurringElements}`,
            ].join('\n')
            : 'SCENE DNA\nNot specified.';

          const outfitLockSection = task.outfit
            ? [
              'OUTFIT LOCK',
              'This outfit lock is strict and non-negotiable across this generation.',
              `top: ${task.outfit.top}`,
              `bottom: ${task.outfit.bottom}`,
              `accessories: ${task.outfit.accessories}`,
              `footwear: ${task.outfit.footwear}`,
              'FOOTWEAR CONTINUITY RULE: Keep the exact same footwear model, style, color, and silhouette. Do not swap shoes.',
            ].join('\n')
            : 'OUTFIT LOCK\nNot specified.';

          const cameraProfileSection = task.cameraProfile
            ? [
              'CAMERA PROFILE',
              `lens: ${task.cameraProfile.lens}`,
              `depth: ${task.cameraProfile.depth}`,
              `lighting: ${task.cameraProfile.lighting}`,
              `realism: ${task.cameraProfile.realism}`,
            ].join('\n')
            : 'CAMERA PROFILE\nNot specified.';

          const poseSection = [
            'POSE',
            task.pose || 'Not specified.',
          ].join('\n');

          const expressionSection = [
            'EXPRESSION',
            task.expression || 'Not specified.',
          ].join('\n');
          const styleLibrarySection = task.styleLibraryBlock
            ? `[STYLE LIBRARY]\n${task.styleLibraryBlock}\n[END STYLE LIBRARY]`
            : null;
          const sceneModeSection = [
            'SCENE MODE',
            task.sceneModeText || 'Not specified.',
          ].join('\n');

          const userSceneContextSection = [
            'USER SCENE CONTEXT',
            taskPrompt,
          ].join('\n');

          const baseImagePrioritySection = task.baseImage
            ? [
              'BASE IMAGE PRIORITY',
              'The first image input is the selected base image and is mandatory as the visual source.',
              'Preserve its scene, wardrobe, styling, and camera feel unless explicitly changed.',
              'Any other references are secondary identity support only.',
            ].join('\n')
            : null;

          const specificReferencesSection = Array.isArray(task.specificReferences) && task.specificReferences.length > 0
            ? [
              'SPECIFIC IMAGE REFERENCES',
              ...task.specificReferences.map((ref, idx) => {
                const typeLabel = ref.referenceType || 'item';
                const noteLabel = ref.note ? ` Note: ${ref.note}.` : '';
                return `- Reference ${idx + 1} type "${typeLabel}": extract and apply this ${typeLabel} detail while preserving character identity and the base image scene intent.${noteLabel}`;
              }),
              'When multiple specific references are provided, combine them coherently without changing identity.',
            ].join('\n')
            : null;

          const photographyRealism = [
            '[PHOTOGRAPHY REALISM DIRECTIVE]',
            'Render this as a REAL photograph taken with a handheld phone or consumer camera. The output MUST look like an authentic casual/amateur photo — NOT a professional studio shot, NOT digital art, NOT anime, NOT 3D render. Include subtle natural imperfections: slight sensor grain, minor focus softness on edges, authentic white balance shifts, natural skin texture with pores and unevenness. Avoid: airbrushed skin, perfect symmetry, overly saturated colors, anime/cartoon stylization, HDR over-processing, studio-perfect lighting. The image should be indistinguishable from a real phone photo posted on Instagram.',
            '[END PHOTOGRAPHY REALISM DIRECTIVE]',
          ].join('\n');

          const finalPrompt = [
            identityLockSection,
            sceneDnaSection,
            outfitLockSection,
            cameraProfileSection,
            poseSection,
            expressionSection,
            styleLibrarySection,
            sceneModeSection,
            baseImagePrioritySection,
            specificReferencesSection,
            userSceneContextSection,
            photographyRealism,
          ].filter(Boolean).join('\n\n');

          const referenceParts = [];
          // Resolve base image: prefer shared job-level copy to avoid per-task duplication
          const resolvedBaseImage = task.baseImage
            ? (job._sharedBaseImage || task.baseImage)
            : null;
          if (resolvedBaseImage && resolvedBaseImage.base64Data && resolvedBaseImage.mimeType) {
            referenceParts.push({
              inlineData: {
                mimeType: resolvedBaseImage.mimeType,
                data: resolvedBaseImage.base64Data,
              },
            });
          }
          for (const ref of task.specificReferences || []) {
            if (ref && ref.base64Data && ref.mimeType) {
              referenceParts.push({
                inlineData: {
                  mimeType: ref.mimeType,
                  data: ref.base64Data,
                },
              });
            }
          }
          for (const img of referenceImages) {
            const part = this._toInlineReferencePart(task.characterId, img);
            if (part) referenceParts.push(part);
          }

          const parts = [
            ...referenceParts,
            { text: finalPrompt },
          ];
          const result = await geminiService.generateImage(apiKey, finalPrompt, {
            aspectRatio: job.aspectRatio,
            imageSize: job.imageSize,
            parts,
          });

          // Re-check cancellation after expensive API call — skip storing results
          if (job._cancelled) {
            job.results[task.index] = {
              index: task.index,
              success: false,
              image: null,
              error: 'Job cancelled',
            };
            return;
          }

          // Store in imageStore (in-memory for tweak/carousel)
          const stored = imageStore.store({
            basePrompt: task.prompt,
            characterId: task.characterId,
            activeReferenceIds: task.activeReferenceIds,
            sceneDescription: task.userPrompt,
            modelUsed: null,
            seed: task.seed || null,
            parentImageId: null,
            variationIndex: null,
            image: { mimeType: result.image.mimeType, base64Data: result.image.base64Data },
            source: 'batch',
          });

          // Save to persistent gallery
          galleryManager.save({
            base64Data: result.image.base64Data,
            mimeType: result.image.mimeType,
            prompt: (task.userPrompt || task.prompt || '').slice(0, 500),
            source: 'batch',
            characterId: task.characterId,
            aspectRatio: job.aspectRatio,
            seed: task.seed || null,
            tags: task.tags || [],
          });

          job.results[task.index] = {
            index: task.index,
            success: true,
            imageId: stored.imageId,
            image: {
              mimeType: result.image.mimeType,
              base64Data: result.image.base64Data,
            },
            text: result.text || null,
            aspectRatio: job.aspectRatio,
            imageSize: job.imageSize,
            error: null,
          };
          job.completed++;
          this.emit('task', { jobId: job.jobId, index: task.index, success: true, completed: job.completed, failed: job.failed, total: job.total });
        } catch (err) {
          job.results[task.index] = {
            index: task.index,
            success: false,
            image: null,
            error: err.message || 'Generation failed',
          };
          job.failed++;
          this.emit('task', { jobId: job.jobId, index: task.index, success: false, completed: job.completed, failed: job.failed, total: job.total });
        }
      })
    );

    // Wait for all tasks to settle
    await Promise.allSettled(promises);

    // Final status (only if not already cancelled)
    if (!job._cancelled) {
      job.status = job.failed === job.total ? 'failed' : 'completed';
    }
    job._completedAt = Date.now();
    _persistJobs();
    this.emit('done', { jobId: job.jobId, status: job.status, completed: job.completed, failed: job.failed, total: job.total });
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  _validateMode(mode) {
    const valid = ['variation', 'multi', 'override', 'edit', 'content-mix'];
    if (!mode || !valid.includes(mode)) {
      throw new AppError(`"mode" must be one of: ${valid.join(', ')}`, 400, 'VALIDATION_ERROR');
    }
  }

  _validateCount(count) {
    const n = typeof count === 'number' ? Math.floor(count) : 1;
    if (n < 1) {
      throw new AppError('Count must be at least 1', 400, 'VALIDATION_ERROR');
    }
    if (n > MAX_BATCH_SIZE) {
      throw new AppError(`Max ${MAX_BATCH_SIZE} images per batch`, 400, 'BATCH_TOO_LARGE');
    }
    return n;
  }

  _resolvePromptLayers(config, taskCount) {
    const sceneMemory =
      config && typeof config.sceneMemoryId === 'string' && config.sceneMemoryId.trim().length > 0
        ? sceneMemoryService.getSceneById(config.sceneMemoryId)
        : null;

    const outfit =
      config && typeof config.outfitId === 'string' && config.outfitId.trim().length > 0
        ? outfitMemoryService.getOutfitById(config.outfitId)
        : null;

    const cameraProfile =
      config && typeof config.cameraProfileId === 'string' && config.cameraProfileId.trim().length > 0
        ? cameraProfileService.getProfileById(config.cameraProfileId)
        : null;

    const poseMode = config && typeof config.poseMode === 'string'
      ? config.poseMode.trim()
      : '';
    const expressionMode = config && typeof config.expressionMode === 'string'
      ? config.expressionMode.trim()
      : '';
    const sceneMode = config && typeof config.sceneMode === 'string'
      ? config.sceneMode.trim()
      : '';

    let poses = null;
    if (poseMode === 'auto' || (config && config.autoPose === true)) {
      poses = poseEngine.getUniquePoses(taskCount);
    } else if (poseMode && poseMode !== 'none') {
      const resolvedPose = poseEngine.poseForMode(poseMode);
      if (resolvedPose) {
        poses = Array.from({ length: taskCount }, () => resolvedPose);
      }
    }

    const expression =
      expressionMode && expressionMode !== 'none'
        ? expressionEngine.expressionForMode(expressionMode)
        : null;
    const sceneModeText =
      sceneMode && sceneMode !== 'none'
        ? sceneModeEngine.sceneForMode(sceneMode)
        : null;

    let styleLibraryBlock = '';
    if (Array.isArray(config.styleAtomIds) && config.styleAtomIds.length > 0) {
      try {
        const styleLibrary = require('./styleLibrary');
        styleLibraryBlock = styleLibrary.composePrompt(config.styleAtomIds);
        config.styleAtomIds.forEach(id => styleLibrary.incrementUsage(id));
      } catch { /* skip if atoms not found */ }
    }

    return {
      sceneMemory,
      outfit,
      cameraProfile,
      poses,
      expression,
      sceneModeText,
      styleLibraryBlock,
    };
  }

  /**
   * Resolve a prompt through the character identity lock system.
   */
  _resolveCharacterPrompt(characterId, activeReferenceIds, userPrompt) {
    const character = referenceManager.getCharacter(characterId);
    const activeRefs = referenceManager.getActiveReferences(
      characterId,
      Array.isArray(activeReferenceIds) ? activeReferenceIds : null
    );
    return promptBuilder.buildPrompt({
      masterPrompt: character.masterPrompt,
      activeReferences: activeRefs,
      userPrompt,
    });
  }

  async getCharacterById(characterId) {
    return referenceManager.getCharacter(characterId);
  }

  _resolveReferenceImage(characterId, reference) {
    if (!reference || !reference.id) return null;
    try {
      const { buffer, mimeType } = referenceManager.getReferenceImage(characterId, reference.id);
      return { buffer, mimeType };
    } catch {
      return null;
    }
  }

  _resolveProfileImage(characterId) {
    try {
      const images = referenceManager.getPrimaryImages(characterId);
      return images.length > 0 ? images : [referenceManager.getPrimaryImage(characterId)];
    } catch {
      return null;
    }
  }

  _convertToBase64(img) {
    if (!img) return '';
    if (typeof img === 'string') return img;
    if (img.base64Data && typeof img.base64Data === 'string') return img.base64Data;
    if (Buffer.isBuffer(img.buffer)) return img.buffer.toString('base64');
    return '';
  }

  _toInlineReferencePart(characterId, img) {
    if (!img) return null;

    // Already has binary/base64 payload
    const directBase64 = this._convertToBase64(img);
    if (directBase64) {
      return {
        inlineData: {
          mimeType: img.mimeType || 'image/jpeg',
          data: directBase64,
        },
      };
    }

    // Reference metadata object from character.references
    if (img.id) {
      const resolved = this._resolveReferenceImage(characterId, img);
      if (!resolved) return null;
      return {
        inlineData: {
          mimeType: resolved.mimeType || 'image/jpeg',
          data: this._convertToBase64(resolved),
        },
      };
    }

    return null;
  }

  _parseReferenceImagePayload(value, fieldName = 'referenceImage') {
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

  _parseCustomReferenceImages(value) {
    if (!Array.isArray(value) || value.length === 0) return [];
    return value.map((item, index) => {
      const parsed = this._parseReferenceImagePayload(item, `customReferenceImages[${index}]`);
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

  /**
   * Strip base64 image data from config for history persistence.
   */
  _sanitizeConfigForHistory(mode, config) {
    if (!config) return null;
    const safe = { ...config };
    // Remove any base64 image data from the config
    delete safe.customReferenceImages;
    delete safe.extraReferenceImage;
    // Keep only text fields for multi prompts
    if (mode === 'multi' && Array.isArray(safe.prompts)) {
      safe.prompts = safe.prompts.map((p) => (typeof p === 'string' ? p.slice(0, 500) : ''));
    }
    if (typeof safe.prompt === 'string') {
      safe.prompt = safe.prompt.slice(0, 500);
    }
    if (typeof safe.modificationPrompt === 'string') {
      safe.modificationPrompt = safe.modificationPrompt.slice(0, 500);
    }
    return safe;
  }

  /**
   * Retry all failed tasks in a completed/failed job.
   * Creates a new job with only the failed tasks' original config.
   */
  retryFailed(jobId) {
    if (!jobId || typeof jobId !== 'string') {
      throw new AppError('Job ID is required', 400, 'VALIDATION_ERROR');
    }
    const job = jobs.get(jobId);
    if (!job) throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    if (job.status === 'running') throw new AppError('Cannot retry a running job', 400, 'INVALID_STATE');

    const failedIndices = [];
    for (let i = 0; i < (job.results || []).length; i++) {
      const r = job.results[i];
      if (r && !r.success) failedIndices.push(i);
    }
    if (failedIndices.length === 0) throw new AppError('No failed tasks to retry', 400, 'NO_FAILED_TASKS');

    // Re-create from stored config
    const config = job._config || {};
    const mode = job.mode;
    const genOpts = { aspectRatio: job.aspectRatio || '1:1', imageSize: job.imageSize || '1K' };

    // For multi mode, extract only failed prompts
    if (mode === 'multi' && Array.isArray(config.prompts)) {
      const retryConfig = { ...config, prompts: failedIndices.map(i => config.prompts[i]).filter(Boolean) };
      return this.startBatch(mode, retryConfig, genOpts);
    }

    // For variation mode, retry with same count of failed
    if (mode === 'variation') {
      const retryConfig = { ...config, count: failedIndices.length };
      return this.startBatch(mode, retryConfig, genOpts);
    }

    // For edit/content-mix, retry with failed count
    if (mode === 'edit') {
      const retryConfig = { ...config, count: failedIndices.length };
      return this.startBatch(mode, retryConfig, genOpts);
    }

    if (mode === 'content-mix') {
      const retryConfig = { ...config, totalCount: failedIndices.length };
      return this.startBatch(mode, retryConfig, genOpts);
    }

    // Fallback: re-run entire job config
    return this.startBatch(mode, config, genOpts);
  }

  /**
   * Remove a completed/failed/cancelled job from history.
   */
  removeJob(jobId) {
    if (!jobId || typeof jobId !== 'string') {
      throw new AppError('Job ID is required', 400, 'VALIDATION_ERROR');
    }
    const job = jobs.get(jobId);
    if (!job) throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    if (job.status === 'running') throw new AppError('Cannot remove a running job — cancel it first', 400, 'INVALID_STATE');
    jobs.delete(jobId);
    _persistJobs();
    return { removed: true };
  }

  /**
   * Queue status — how many tasks are pending in the global queue.
   */
  queueStatus() {
    return {
      queueDepth: globalQueue._queue.length,
      activeWorkers: globalQueue._running,
      maxConcurrency: MAX_CONCURRENCY,
      maxRunningJobs: MAX_RUNNING_JOBS,
    };
  }

  /**
   * List all jobs, newest first. Optional status filter.
   */
  listJobs(statusFilter) {
    const result = [];
    for (const job of jobs.values()) {
      if (statusFilter && job.status !== statusFilter) continue;
      result.push(this._toSafeJob(job));
    }
    return result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /**
   * Summary counts for health/monitoring endpoints.
   */
  jobStats() {
    let running = 0;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    for (const job of jobs.values()) {
      if (job.status === 'running') running++;
      else if (job.status === 'completed') completed++;
      else if (job.status === 'failed') failed++;
      else if (job.status === 'cancelled') cancelled++;
    }
    return { total: jobs.size, running, completed, failed, cancelled };
  }

  /**
   * Strip internal fields from job for API response.
   */
  _toSafeJob(job) {
    const safe = {
      jobId: job.jobId,
      mode: job.mode,
      status: job.status,
      total: job.total,
      completed: job.completed,
      failed: job.failed,
      results: job.results,
      createdAt: job.createdAt,
      aspectRatio: job.aspectRatio || null,
      completedAt: job._completedAt ? new Date(job._completedAt).toISOString() : null,
    };
    if (job._config) safe.config = job._config;
    return safe;
  }
}

// Export constants for tests
BatchGenerator.MAX_CONCURRENCY = MAX_CONCURRENCY;
BatchGenerator.MAX_BATCH_SIZE = MAX_BATCH_SIZE;

// Singleton
module.exports = new BatchGenerator();
