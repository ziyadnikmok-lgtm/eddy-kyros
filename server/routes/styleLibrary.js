const express = require('express');
const styleLibrary = require('../services/styleLibrary');
const apiKeyManager = require('../services/apiKeyManager');
const geminiService = require('../services/geminiService');

const router = express.Router();

/** GET /api/style-library — list atoms with optional filters */
router.get('/', (req, res, next) => {
  try {
    const result = styleLibrary.listAtoms({
      category: req.query.category,
      tag: req.query.tag,
      sourceType: req.query.source,
      sourceUsername: req.query.username,
      favorite: req.query.favorite,
      q: req.query.q,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/** GET /api/style-library/stats — category counts */
router.get('/stats', (_req, res, next) => {
  try {
    const stats = styleLibrary.getStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
});

/** GET /api/style-library/profiles — list analyzed profiles */
router.get('/profiles', (_req, res, next) => {
  try {
    const profiles = styleLibrary.getAnalyzedProfiles();
    res.json({ success: true, data: profiles });
  } catch (err) {
    next(err);
  }
});

/** GET /api/style-library/duplicates — preview duplicate count */
router.get('/duplicates', (_req, res, next) => {
  try {
    const { duplicateCount } = styleLibrary.findDuplicates();
    res.json({ success: true, data: { duplicateCount } });
  } catch (err) {
    next(err);
  }
});

/** GET /api/style-library/content-presets — OFM content type presets (40/30/20/10 mix) */
const _contentPresets = (() => {
  try {
    return JSON.parse(require('node:fs').readFileSync(
      require('node:path').join(require('../paths').DATA_DIR, 'contentTypePresets.json'), 'utf-8'
    ));
  } catch { return []; }
})();
router.get('/content-presets', (_req, res) => {
  res.json({ success: true, data: _contentPresets });
});

/** GET /api/style-library/:id — single atom */
router.get('/:id', (req, res, next) => {
  try {
    const atom = styleLibrary.getAtom(req.params.id);
    res.json({ success: true, data: atom });
  } catch (err) {
    next(err);
  }
});

/** POST /api/style-library — create single atom */
router.post('/', (req, res, next) => {
  try {
    const atom = styleLibrary.createAtom(req.body);
    res.status(201).json({ success: true, data: atom });
  } catch (err) {
    next(err);
  }
});

/** POST /api/style-library/bulk — bulk create atoms */
router.post('/bulk', (req, res, next) => {
  try {
    const atoms = styleLibrary.createBulk(req.body.atoms || req.body);
    res.status(201).json({ success: true, data: { created: atoms.length, atoms } });
  } catch (err) {
    next(err);
  }
});

/** POST /api/style-library/compose — compose prompt from atom IDs */
router.post('/compose', (req, res, next) => {
  try {
    const prompt = styleLibrary.composePrompt(req.body.atomIds);
    res.json({ success: true, data: { prompt } });
  } catch (err) {
    next(err);
  }
});

/** POST /api/style-library/import-json — parse JSON file, return preview atoms (no auto-save) */
router.post('/import-json', (req, res, next) => {
  try {
    const { jsonData, sourceLabel } = req.body;
    const atoms = styleLibrary.importFromJSON(jsonData, sourceLabel || 'json_import');
    res.json({ success: true, data: { atoms, count: atoms.length } });
  } catch (err) {
    next(err);
  }
});

/** POST /api/style-library/backfill — import from existing promptKnowledge.json */
router.post('/backfill', (_req, res, next) => {
  try {
    const result = styleLibrary.backfillFromPromptKnowledge();
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/style-library/:id — update atom */
router.patch('/:id', (req, res, next) => {
  try {
    const atom = styleLibrary.updateAtom(req.params.id, req.body);
    res.json({ success: true, data: atom });
  } catch (err) {
    next(err);
  }
});

/** POST /api/style-library/bulk-delete — delete multiple atoms by IDs */
router.post('/bulk-delete', (req, res, next) => {
  try {
    const result = styleLibrary.deleteBulk(req.body.ids || []);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/** POST /api/style-library/delete-duplicates — remove duplicate atoms */
router.post('/delete-duplicates', (_req, res, next) => {
  try {
    const result = styleLibrary.deleteDuplicates();
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/style-library/all — delete all atoms */
router.delete('/all', (_req, res, next) => {
  try {
    const result = styleLibrary.deleteAll();
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/style-library/:id — delete single atom */
router.delete('/:id', (req, res, next) => {
  try {
    const result = styleLibrary.deleteAtom(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/** POST /api/style-library/suggest — Gemini-powered complementary atom suggestions */
router.post('/suggest', async (req, res, next) => {
  try {
    const { atomIds, targetCategories } = req.body;
    if (!Array.isArray(atomIds) || atomIds.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'atomIds required' } });
    }

    const apiKey = apiKeyManager.getActiveKey();
    if (!apiKey) {
      return res.status(400).json({ success: false, error: { message: 'No active Gemini API key' } });
    }

    // Get the current atoms for context
    const currentAtoms = atomIds.map(id => {
      try { return styleLibrary.getAtom(id); } catch { return null; }
    }).filter(Boolean);

    if (currentAtoms.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'No valid atoms found' } });
    }

    const currentDescription = currentAtoms.map(a => `${a.category}: ${a.text}`).join('\n');
    const categories = ['pose', 'expression', 'outfit', 'scene', 'lighting', 'camera', 'vibe', 'accessories', 'format'];
    const usedCategories = new Set(currentAtoms.map(a => a.category));
    const missing = (Array.isArray(targetCategories) && targetCategories.length > 0)
      ? targetCategories
      : categories.filter(c => !usedCategories.has(c));

    if (missing.length === 0) {
      return res.json({ success: true, data: { suggestions: [] } });
    }

    const prompt = `You are a creative style director for AI image generation. Given these existing style elements for a photo:

${currentDescription}

Generate complementary style atoms for these missing categories: ${missing.join(', ')}

RULES:
- Write each atom as a DESCRIPTIVE NATURAL LANGUAGE sentence (minimum 8 words) — NOT comma-separated tags.
- Use directive tone ("Standing with weight on left hip" NOT "She is standing with weight on left hip").
- DO NOT describe any person's identity, face shape, body type, skin color, or hair color.
- Be specific: describe visual relationships, materials, directions, and effects.
- Example good atom: "Soft golden hour backlight streaming from behind, creating a warm rim glow and long shadows stretching forward"
- Example bad atom: "golden hour, warm, backlit, shadows" — DO NOT write like this.

Return JSON: { ${missing.map(c => `"${c}": "description"`).join(', ')} }
Return ONLY the JSON object.`;

    const raw = await geminiService.generateText(apiKey, prompt);
    let parsed = {};
    try {
      const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) try { parsed = JSON.parse(jsonMatch[0]); } catch { /* skip */ }
    }

    const suggestions = [];
    for (const cat of missing) {
      const text = typeof parsed[cat] === 'string' ? parsed[cat].trim() : '';
      if (text.length >= 10) {
        suggestions.push({
          category: cat,
          text: styleLibrary.stripIdentity(text),
          tags: ['ai-suggested'],
        });
      }
    }

    res.json({ success: true, data: { suggestions } });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/style-library/source/:username — delete all atoms from a profile */
router.delete('/source/:username', (req, res, next) => {
  try {
    const result = styleLibrary.deleteBySource(req.params.username);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
