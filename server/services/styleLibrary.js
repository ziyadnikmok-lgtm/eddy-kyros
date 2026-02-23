const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const log = require('../utils/logger');
const { atomicWriteJSON } = require('../utils/helpers');

const { DATA_DIR } = require('../paths');
const DATA_FILE = path.join(DATA_DIR, 'styleLibrary.json');
const PROFILES_FILE = path.join(DATA_DIR, 'analyzedProfiles.json');

const VALID_CATEGORIES = ['pose', 'expression', 'outfit', 'scene', 'lighting', 'camera', 'vibe', 'accessories', 'format'];
const VALID_SOURCE_TYPES = ['profile_analysis', 'post_clone', 'manual', 'json_import', 'backfill'];

// Compose order follows Nano-Banana formula: environment → lighting → composition → subject → style → format
const COMPOSE_ORDER = ['scene', 'lighting', 'camera', 'pose', 'expression', 'outfit', 'accessories', 'vibe', 'format'];

// Identity-stripping patterns — removes face/body/skin/hair references
const IDENTITY_PATTERNS = [
  // "A woman with...", "A young woman...", "She is...", "She has..."
  /\b(?:a\s+)?(?:young|tall|short|slim|curvy|petite|athletic)?\s*(?:woman|girl|lady|female|man|boy|guy|male)\s+(?:with|who|has|having)\b[^.;]*/gi,
  // "Her face...", "Her body...", "Her skin..."
  /\bher\s+(?:face|body|skin|hair|eyes|lips|nose|cheeks?|forehead|chin|jawline|eyebrows?|eyelashes?|complexion)\b[^.;]*/gi,
  // "His face...", etc
  /\bhis\s+(?:face|body|skin|hair|eyes|lips|nose|cheeks?|forehead|chin|jawline|eyebrows?|eyelashes?|complexion)\b[^.;]*/gi,
  // Skin tone descriptors
  /\b(?:fair|dark|light|olive|pale|tan(?:ned)?|brown|black|white|caramel|porcelain|ebony|ivory)\s*(?:skin(?:ned)?|complex(?:ion)?|tone)\b/gi,
  // Hair color/style as identity
  /\b(?:blonde|brunette|redhead|black-haired|brown-haired|auburn)\b/gi,
  // Eye color
  /\b(?:blue|green|brown|hazel|gray|grey)\s*eyes?\b/gi,
  // Body proportions
  /\b(?:large|small|ample|flat|perky|full)\s*(?:bust|chest|breasts?|hips?|waist|thighs?|buttocks?)\b/gi,
  // Height / weight
  /\b(?:\d+'?\d*"?\s*(?:tall|short)|(?:weighs?\s+)?\d+\s*(?:lbs?|kg|pounds?|kilos?))\b/gi,
  // "She/He" at sentence start (convert to directive)
  /^(?:she|he)\s+(?:is|has|was|were|looks?|appears?|stands?|sits?|poses?)\s+/gim,
];

class StyleLibraryService {
  constructor() {
    this._ensureDataFile(DATA_FILE);
    this._ensureDataFile(PROFILES_FILE);
    this._store = this._loadFile(DATA_FILE);
    this._profiles = this._loadFile(PROFILES_FILE);
    this._rebuildNormIndex();
  }

  /** Build category→Set<normalizedText> index for O(1) exact-match duplicate checks */
  _rebuildNormIndex() {
    this._normIndex = new Map();
    for (const a of this._store) {
      this._addToNormIndex(a.category, a.text);
    }
  }

  _addToNormIndex(category, text) {
    const key = text.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!this._normIndex.has(category)) this._normIndex.set(category, new Set());
    this._normIndex.get(category).add(key);
  }

  // ─── Quality Gate & Duplicate Detection ────────────────

  /**
   * Check if a near-duplicate already exists in the store.
   * Uses normalized exact match first, then Jaccard similarity > 0.6.
   */
  isDuplicate(category, text) {
    const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
    if (normalized.length < 5) return true; // too short = treat as duplicate

    // O(1) exact match via pre-built index
    if (this._normIndex.get(category)?.has(normalized)) return true;

    // Jaccard similarity > 0.6 (fuzzy match still requires scan)
    const wordsNew = new Set(normalized.split(/\s+/));
    for (const a of this._store) {
      if (a.category !== category) continue;
      const wordsExisting = new Set(a.text.trim().toLowerCase().split(/\s+/));
      const intersection = new Set([...wordsNew].filter(w => wordsExisting.has(w)));
      const union = new Set([...wordsNew, ...wordsExisting]);
      if (union.size > 0 && intersection.size / union.size > 0.6) return true;
    }

    return false;
  }

  /**
   * Minimum quality gate for atoms. Rejects tag-soup, truncated, and identity-leaked text.
   * Returns { pass: boolean, reason?: string }.
   */
  passesQualityGate(category, text) {
    const trimmed = (text || '').trim();
    const words = trimmed.split(/\s+/);

    // Minimum length per category
    const minWords = { outfit: 4, pose: 4, scene: 5, lighting: 4, camera: 4, expression: 3, vibe: 4, accessories: 3, format: 3 };
    const minW = minWords[category] || 3;
    if (words.length < minW) return { pass: false, reason: `too short (${words.length} words, need ${minW})` };

    // Reject identity leaks at the start
    if (/^(?:the|a)\s+(?:woman|girl|lady|man|boy|guy)\s+(?:wears?|is\s+wearing|has\s+on|is\s+dressed)/i.test(trimmed)) {
      return { pass: false, reason: 'identity leak' };
    }
    if (/^(?:she|he)\s+(?:wears?|is|has|looks?|appears?|stands?|sits?)/i.test(trimmed)) {
      return { pass: false, reason: 'identity leak (pronoun start)' };
    }

    // Reject generic quality tags that AI generators already include
    if (/^(?:beautiful|pretty|gorgeous|stunning|4k|realistic|high quality|masterpiece|best quality|ultra)/i.test(trimmed) && words.length < 5) {
      return { pass: false, reason: 'generic quality tag' };
    }

    return { pass: true };
  }

  // ─── CRUD ───────────────────────────────────────────────

  createAtom(data, { skipDuplicateCheck = false } = {}) {
    this._validateAtomPayload(data);

    const text = data.text.trim();

    // Quality gate
    const quality = this.passesQualityGate(data.category, text);
    if (!quality.pass) {
      log.info('style_library_quality_reject', { reason: quality.reason, text: text.substring(0, 60) });
      return null;
    }

    // Duplicate check
    if (!skipDuplicateCheck && this.isDuplicate(data.category, text)) {
      log.info('style_library_duplicate_skip', { text: text.substring(0, 60) });
      return null;
    }

    const atom = {
      id: crypto.randomUUID(),
      category: data.category,
      text,
      tags: Array.isArray(data.tags) ? data.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean) : [],
      source: this._normalizeSource(data.source),
      createdAt: new Date().toISOString(),
      usageCount: 0,
      favorite: false,
    };

    this._store.push(atom);
    this._addToNormIndex(atom.category, atom.text);
    this._persistStore();
    return { ...atom };
  }

  createBulk(atoms, { skipDuplicateCheck = false } = {}) {
    if (!Array.isArray(atoms) || atoms.length === 0) {
      throw new AppError('atoms must be a non-empty array', 400, 'VALIDATION_ERROR');
    }

    const created = [];
    let skippedQuality = 0;
    let skippedDuplicate = 0;

    for (const data of atoms) {
      this._validateAtomPayload(data);
      const text = data.text.trim();

      // Quality gate
      const quality = this.passesQualityGate(data.category, text);
      if (!quality.pass) { skippedQuality++; continue; }

      // Duplicate check (also checks against atoms added in this batch)
      if (!skipDuplicateCheck && this.isDuplicate(data.category, text)) { skippedDuplicate++; continue; }

      const atom = {
        id: crypto.randomUUID(),
        category: data.category,
        text,
        tags: Array.isArray(data.tags) ? data.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean) : [],
        source: this._normalizeSource(data.source),
        createdAt: new Date().toISOString(),
        usageCount: 0,
        favorite: false,
      };
      this._store.push(atom);
      this._addToNormIndex(atom.category, atom.text);
      created.push({ ...atom });
    }

    if (skippedQuality > 0 || skippedDuplicate > 0) {
      log.info(`[style-library] createBulk: ${created.length} created, ${skippedQuality} failed quality, ${skippedDuplicate} duplicates skipped`);
    }

    if (created.length > 0) this._persistStore();
    return created;
  }

  getAtom(id) {
    this._validateId(id);
    const atom = this._store.find(a => a.id === id);
    if (!atom) throw new AppError('Atom not found', 404, 'ATOM_NOT_FOUND');
    return { ...atom };
  }

  listAtoms(filters = {}) {
    let results = this._store;

    if (filters.category) {
      results = results.filter(a => a.category === filters.category);
    }
    if (filters.tag) {
      const tag = filters.tag.toLowerCase();
      results = results.filter(a => a.tags && a.tags.includes(tag));
    }
    if (filters.sourceType) {
      results = results.filter(a => a.source?.type === filters.sourceType);
    }
    if (filters.sourceUsername) {
      results = results.filter(a => a.source?.profileUsername === filters.sourceUsername);
    }
    if (filters.favorite === true || filters.favorite === 'true') {
      results = results.filter(a => a.favorite);
    }
    if (filters.q) {
      const q = filters.q.toLowerCase();
      results = results.filter(a => a.text.toLowerCase().includes(q) || (a.tags && a.tags.some(t => t.includes(q))));
    }

    // Sort: favorites first, then by most recent
    results = results.sort((a, b) => {
      if (a.favorite !== b.favorite) return b.favorite ? 1 : -1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    // Pagination
    const page = Math.max(1, parseInt(filters.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(filters.limit) || 50));
    const total = results.length;
    const offset = (page - 1) * limit;

    return {
      atoms: results.slice(offset, offset + limit).map(a => ({ ...a })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    };
  }

  updateAtom(id, updates) {
    this._validateId(id);
    const idx = this._store.findIndex(a => a.id === id);
    if (idx === -1) throw new AppError('Atom not found', 404, 'ATOM_NOT_FOUND');

    const atom = this._store[idx];

    if (typeof updates.text === 'string' && updates.text.trim().length > 0) {
      atom.text = updates.text.trim();
    }
    if (Array.isArray(updates.tags)) {
      atom.tags = updates.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean);
    }
    if (typeof updates.favorite === 'boolean') {
      atom.favorite = updates.favorite;
    }
    if (typeof updates.category === 'string' && VALID_CATEGORIES.includes(updates.category)) {
      atom.category = updates.category;
    }

    this._persistStore();
    return { ...atom };
  }

  deleteAtom(id) {
    this._validateId(id);
    const idx = this._store.findIndex(a => a.id === id);
    if (idx === -1) throw new AppError('Atom not found', 404, 'ATOM_NOT_FOUND');
    this._store.splice(idx, 1);
    this._rebuildNormIndex();
    this._persistStore();
    return { removed: true };
  }

  deleteBulk(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError('ids must be a non-empty array', 400, 'VALIDATION_ERROR');
    }
    const idSet = new Set(ids);
    const before = this._store.length;
    this._store = this._store.filter(a => !idSet.has(a.id));
    this._rebuildNormIndex();
    this._persistStore();
    return { removed: before - this._store.length };
  }

  deleteAll() {
    const count = this._store.length;
    this._store = [];
    this._normIndex = new Map();
    this._persistStore();
    return { removed: count };
  }

  /**
   * Find duplicate atoms (same category + identical normalized text).
   * Returns { duplicateCount, groups } where groups maps a key to the array of atom IDs to remove (keeps one per group).
   */
  findDuplicates() {
    const groups = new Map(); // key -> [atom, atom, ...]
    for (const atom of this._store) {
      const key = `${atom.category}::${atom.text.trim().toLowerCase().replace(/\s+/g, ' ')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(atom);
    }

    let duplicateCount = 0;
    const toRemove = [];
    for (const [, group] of groups) {
      if (group.length <= 1) continue;
      // Keep: favorite > highest usageCount > earliest createdAt
      group.sort((a, b) => {
        if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
        if ((a.usageCount || 0) !== (b.usageCount || 0)) return (b.usageCount || 0) - (a.usageCount || 0);
        return new Date(a.createdAt) - new Date(b.createdAt);
      });
      // First one is the keeper, rest are duplicates
      for (let i = 1; i < group.length; i++) {
        toRemove.push(group[i].id);
      }
      duplicateCount += group.length - 1;
    }

    return { duplicateCount, removeIds: toRemove };
  }

  /**
   * Remove duplicate atoms, keeping one per (category + normalized text) group.
   * Keeps: favorited > most used > earliest created.
   */
  deleteDuplicates() {
    const { duplicateCount, removeIds } = this.findDuplicates();
    if (removeIds.length === 0) return { removed: 0 };
    const idSet = new Set(removeIds);
    this._store = this._store.filter(a => !idSet.has(a.id));
    this._rebuildNormIndex();
    this._persistStore();
    return { removed: duplicateCount };
  }

  deleteBySource(username) {
    const before = this._store.length;
    this._store = this._store.filter(a => a.source?.profileUsername !== username);
    this._rebuildNormIndex();
    this._persistStore();
    // Also remove from analyzed profiles
    this._profiles = this._profiles.filter(p => p.username !== username);
    this._persistProfiles();
    return { removed: before - this._store.length };
  }

  // ─── Compose ────────────────────────────────────────────

  composePrompt(atomIds) {
    if (!Array.isArray(atomIds) || atomIds.length === 0) {
      throw new AppError('atomIds must be a non-empty array', 400, 'VALIDATION_ERROR');
    }

    const atoms = atomIds.map(id => this._store.find(a => a.id === id)).filter(Boolean);
    if (atoms.length === 0) {
      throw new AppError('No valid atoms found for the given IDs', 404, 'ATOMS_NOT_FOUND');
    }

    // Group by category
    const grouped = {};
    for (const atom of atoms) {
      if (!grouped[atom.category]) grouped[atom.category] = [];
      grouped[atom.category].push(atom.text);
    }

    // Build in compose order
    const parts = [];
    for (const cat of COMPOSE_ORDER) {
      if (grouped[cat] && grouped[cat].length > 0) {
        const label = cat.charAt(0).toUpperCase() + cat.slice(1);
        parts.push(`${label}: ${grouped[cat].join('. ')}`);
      }
    }

    return parts.join('\n');
  }

  // ─── Auto-Select ───────────────────────────────────────

  /**
   * Auto-select the most relevant atoms based on keyword matching.
   * Returns an array of atom IDs (best match per category).
   *
   * @param {string[]} keywords - Words to match against atom text/tags
   * @param {{ maxPerCategory?: number, excludeIds?: string[] }} options
   * @returns {string[]} Array of selected atom IDs
   */
  autoSelect(keywords, { maxPerCategory = 1, excludeIds = [] } = {}) {
    if (!Array.isArray(keywords) || keywords.length === 0) return [];

    const normalizedKeywords = keywords
      .map(k => String(k).toLowerCase().trim())
      .filter(k => k.length >= 3);
    if (normalizedKeywords.length === 0) return [];

    const excludeSet = new Set(excludeIds);
    const candidates = this._store.filter(a => !excludeSet.has(a.id));

    const scored = candidates.map(atom => {
      const hay = `${atom.text} ${(atom.tags || []).join(' ')}`.toLowerCase();
      let score = 0;
      for (const kw of normalizedKeywords) {
        if (hay.includes(kw)) score += 1;
      }
      if (atom.favorite) score += 0.5;
      if ((atom.usageCount || 0) > 5) score += 0.3;
      return { atom, score };
    }).filter(s => s.score > 0);

    const byCategory = {};
    for (const { atom, score } of scored) {
      if (!byCategory[atom.category]) byCategory[atom.category] = [];
      byCategory[atom.category].push({ id: atom.id, score });
    }

    const selected = [];
    for (const cat of COMPOSE_ORDER) {
      if (!byCategory[cat]) continue;
      byCategory[cat].sort((a, b) => b.score - a.score);
      const picks = byCategory[cat].slice(0, maxPerCategory);
      selected.push(...picks.map(p => p.id));
    }

    return selected;
  }

  // ─── Stats & Usage ─────────────────────────────────────

  getStats() {
    const byCategory = {};
    const bySource = {};
    for (const cat of VALID_CATEGORIES) byCategory[cat] = 0;

    for (const atom of this._store) {
      byCategory[atom.category] = (byCategory[atom.category] || 0) + 1;
      const src = atom.source?.type || 'unknown';
      bySource[src] = (bySource[src] || 0) + 1;
    }

    return {
      total: this._store.length,
      byCategory,
      bySource,
      favorites: this._store.filter(a => a.favorite).length,
    };
  }

  incrementUsage(atomId) {
    const atom = this._store.find(a => a.id === atomId);
    if (atom) {
      atom.usageCount = (atom.usageCount || 0) + 1;
      this._persistStore();
    }
  }

  // ─── Profile Tracking ──────────────────────────────────

  getAnalyzedProfiles() {
    return this._profiles.map(p => {
      const atomCount = this._store.filter(a => a.source?.profileUsername === p.username).length;
      return { ...p, atomCount };
    });
  }

  markProfileAnalyzed(username, meta = {}) {
    const existing = this._profiles.find(p => p.username === username);
    if (existing) {
      existing.analyzedAt = new Date().toISOString();
      if (meta.postCount !== undefined) existing.postCount = meta.postCount;
      if (meta.selectedAtomCount !== undefined) existing.selectedAtomCount = meta.selectedAtomCount;
    } else {
      this._profiles.push({
        username,
        analyzedAt: new Date().toISOString(),
        postCount: meta.postCount !== undefined ? meta.postCount : 0,
        selectedAtomCount: meta.selectedAtomCount !== undefined ? meta.selectedAtomCount : 0,
      });
    }
    this._persistProfiles();
  }

  // ─── Identity Stripping ────────────────────────────────

  stripIdentity(text) {
    if (!text || typeof text !== 'string') return '';
    let cleaned = text;
    for (const pattern of IDENTITY_PATTERNS) {
      // Reset lastIndex for global regexes
      pattern.lastIndex = 0;
      cleaned = cleaned.replace(pattern, '');
    }
    // Clean up artifacts: double spaces, orphaned commas, leading/trailing punctuation
    cleaned = cleaned
      .replace(/,\s*,/g, ',')
      .replace(/\.\s*\./g, '.')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,.;]+/, '')
      .replace(/[\s,.;]+$/, '')
      .trim();
    return cleaned;
  }

  // ─── JSON Import Parser ────────────────────────────────

  importFromJSON(jsonData, sourceLabel = 'json_import') {
    if (!jsonData || typeof jsonData !== 'object') {
      throw new AppError('Invalid JSON data', 400, 'VALIDATION_ERROR');
    }

    const atoms = [];

    // Detect format: array of prompt examples vs subject profile
    if (Array.isArray(jsonData)) {
      // Prompt examples format (array of prompt objects)
      for (const item of jsonData) {
        if (!item || typeof item !== 'object') continue;
        // Unwrap nested { prompt: { ... } } structure
        const prompt = item.prompt && typeof item.prompt === 'object' ? item.prompt : item;
        this._extractPromptExampleAtoms(prompt, sourceLabel, atoms);
      }
    } else {
      // Subject profile format — style data may be at top level or nested under life_story
      const profileData = jsonData.life_story && typeof jsonData.life_story === 'object'
        ? jsonData.life_story
        : jsonData;
      this._extractSubjectProfileAtoms(profileData, sourceLabel, atoms);
    }

    // Strip identity from all extracted atoms
    for (const atom of atoms) {
      atom.text = this.stripIdentity(atom.text);
    }

    // Filter out empty or too-short atoms
    return atoms.filter(a => a.text && a.text.length >= 10);
  }

  _extractPromptExampleAtoms(prompt, sourceLabel, atoms) {
    // outfit + fabric_contour → outfit
    const outfitParts = [prompt.outfit, prompt.fabric_contour].filter(Boolean);
    if (outfitParts.length) {
      atoms.push({ category: 'outfit', text: outfitParts.join('. '), tags: [], sourceField: 'outfit+fabric_contour', source: { type: 'json_import', sourceLabel } });
    }

    // framing → camera
    if (prompt.framing) {
      atoms.push({ category: 'camera', text: prompt.framing, tags: [], sourceField: 'framing', source: { type: 'json_import', sourceLabel } });
    }

    // pose + interaction → pose
    const poseParts = [prompt.pose, prompt.interaction].filter(Boolean);
    if (poseParts.length) {
      atoms.push({ category: 'pose', text: poseParts.join('. '), tags: [], sourceField: 'pose+interaction', source: { type: 'json_import', sourceLabel } });
    }

    // expression + gaze → expression
    const exprParts = [prompt.expression, prompt.gaze].filter(Boolean);
    if (exprParts.length) {
      atoms.push({ category: 'expression', text: exprParts.join('. '), tags: [], sourceField: 'expression+gaze', source: { type: 'json_import', sourceLabel } });
    }

    // lighting → lighting
    if (prompt.lighting) {
      atoms.push({ category: 'lighting', text: prompt.lighting, tags: [], sourceField: 'lighting', source: { type: 'json_import', sourceLabel } });
    }

    // background → scene
    if (prompt.background) {
      atoms.push({ category: 'scene', text: prompt.background, tags: [], sourceField: 'background', source: { type: 'json_import', sourceLabel } });
    }

    // style → vibe
    if (prompt.style) {
      atoms.push({ category: 'vibe', text: prompt.style, tags: [], sourceField: 'style', source: { type: 'json_import', sourceLabel } });
    }
  }

  _extractSubjectProfileAtoms(data, sourceLabel, atoms) {
    const src = { type: 'json_import', sourceLabel };

    // ─── pose_inspiration.* → pose ───
    if (data.pose_inspiration && typeof data.pose_inspiration === 'object') {
      this._flattenToAtoms(data.pose_inspiration, 'pose', 'pose_inspiration', src, atoms);
    }

    // ─── hand_interactions → pose ───
    if (Array.isArray(data.hand_interactions)) {
      for (const item of data.hand_interactions) {
        const text = typeof item === 'string' ? item : (item?.description || item?.text || JSON.stringify(item));
        if (text) atoms.push({ category: 'pose', text, tags: ['hands'], sourceField: 'hand_interactions', source: { ...src } });
      }
    }

    // ─── expanded_expressions, emotional_range, camera_relationship → expression ───
    if (Array.isArray(data.expanded_expressions)) {
      for (const item of data.expanded_expressions) {
        const text = typeof item === 'string' ? item : (item?.description || item?.text || '');
        if (text) atoms.push({ category: 'expression', text, tags: [], sourceField: 'expanded_expressions', source: { ...src } });
      }
    }
    if (data.emotional_range && typeof data.emotional_range === 'object') {
      this._flattenToAtoms(data.emotional_range, 'expression', 'emotional_range', src, atoms);
    }
    if (Array.isArray(data.camera_relationship)) {
      for (const item of data.camera_relationship) {
        const text = typeof item === 'string' ? item : (item?.description || item?.text || '');
        if (text) atoms.push({ category: 'expression', text, tags: ['camera-relationship'], sourceField: 'camera_relationship', source: { ...src } });
      }
    }

    // ─── outfit_combos.* → outfit ───
    if (data.outfit_combos && typeof data.outfit_combos === 'object') {
      for (const [subcategory, items] of Object.entries(data.outfit_combos)) {
        if (Array.isArray(items)) {
          for (const item of items) {
            const text = typeof item === 'string' ? item : (item?.description || item?.text || '');
            if (text) atoms.push({ category: 'outfit', text, tags: [subcategory], sourceField: `outfit_combos.${subcategory}`, source: { ...src } });
          }
        } else if (typeof items === 'string') {
          atoms.push({ category: 'outfit', text: items, tags: [subcategory], sourceField: `outfit_combos.${subcategory}`, source: { ...src } });
        }
      }
    }

    // ─── past_locations → scene ───
    if (Array.isArray(data.past_locations)) {
      for (const item of data.past_locations) {
        const text = typeof item === 'string' ? item : (item?.description || item?.text || '');
        if (text) atoms.push({ category: 'scene', text, tags: [], sourceField: 'past_locations', source: { ...src } });
      }
    }

    // ─── locations_and_environments → scene + lighting ───
    if (Array.isArray(data.locations_and_environments)) {
      for (const loc of data.locations_and_environments) {
        if (!loc || typeof loc !== 'object') continue;
        if (loc.physical_environment) {
          atoms.push({ category: 'scene', text: loc.physical_environment, tags: [loc.location_name || ''].filter(Boolean), sourceField: 'locations_and_environments', source: { ...src } });
        }
        if (loc.lighting_profile) {
          atoms.push({ category: 'lighting', text: loc.lighting_profile, tags: [loc.location_name || ''].filter(Boolean), sourceField: 'locations_and_environments.lighting', source: { ...src } });
        }
      }
    }

    // ─── scenes_and_activities.* → vibe (rich scene descriptions) ───
    if (data.scenes_and_activities && typeof data.scenes_and_activities === 'object') {
      for (const [sceneName, items] of Object.entries(data.scenes_and_activities)) {
        if (Array.isArray(items)) {
          for (const item of items) {
            const text = typeof item === 'string' ? item : (item?.description || item?.text || '');
            if (text) atoms.push({ category: 'vibe', text, tags: [sceneName], sourceField: `scenes_and_activities.${sceneName}`, source: { ...src } });
          }
        }
      }
    }

    // ─── outfit_formulas → outfit (combine top+bottom+shoes) ───
    if (Array.isArray(data.outfit_formulas)) {
      for (const formula of data.outfit_formulas) {
        if (!formula || typeof formula !== 'object') continue;
        const parts = [formula.top, formula.bottom, formula.shoes].filter(Boolean);
        if (parts.length > 0) {
          atoms.push({ category: 'outfit', text: parts.join('. '), tags: [formula.name || ''].filter(Boolean), sourceField: 'outfit_formulas', source: { ...src } });
        }
      }
    }

    // ─── wardrobe_catalog.* → outfit ───
    if (data.wardrobe_catalog && typeof data.wardrobe_catalog === 'object') {
      for (const [subcategory, items] of Object.entries(data.wardrobe_catalog)) {
        if (Array.isArray(items)) {
          for (const item of items) {
            const text = typeof item === 'string' ? item : (item?.description || item?.text || '');
            if (text) atoms.push({ category: 'outfit', text, tags: [subcategory], sourceField: `wardrobe_catalog.${subcategory}`, source: { ...src } });
          }
        }
      }
    }

    // ─── past_moments → vibe ───
    if (Array.isArray(data.past_moments)) {
      for (const item of data.past_moments) {
        const text = typeof item === 'string' ? item : (item?.description || item?.text || '');
        if (text) atoms.push({ category: 'vibe', text, tags: ['moment'], sourceField: 'past_moments', source: { ...src } });
      }
    }

    // ─── photography_styles.technical_approach → camera ───
    if (data.photography_styles?.technical_approach) {
      const ta = data.photography_styles.technical_approach;
      if (Array.isArray(ta)) {
        for (const item of ta) {
          const text = typeof item === 'string' ? item : (item?.description || item?.text || '');
          if (text) atoms.push({ category: 'camera', text, tags: [], sourceField: 'photography_styles.technical_approach', source: { ...src } });
        }
      } else if (typeof ta === 'string') {
        atoms.push({ category: 'camera', text: ta, tags: [], sourceField: 'photography_styles.technical_approach', source: { ...src } });
      }
    }

    // ─── generation_rules.lighting_and_atmosphere.keywords → lighting ───
    if (data.generation_rules?.lighting_and_atmosphere?.keywords) {
      const kw = data.generation_rules.lighting_and_atmosphere.keywords;
      if (Array.isArray(kw)) {
        for (const item of kw) {
          const text = typeof item === 'string' ? item : '';
          if (text) atoms.push({ category: 'lighting', text, tags: [], sourceField: 'generation_rules.lighting_and_atmosphere.keywords', source: { ...src } });
        }
      }
    }

    // ─── recurring_visual_motifs, character_energy → vibe ───
    if (Array.isArray(data.recurring_visual_motifs)) {
      for (const item of data.recurring_visual_motifs) {
        const text = typeof item === 'string' ? item : (item?.description || item?.text || '');
        if (text) atoms.push({ category: 'vibe', text, tags: ['motif'], sourceField: 'recurring_visual_motifs', source: { ...src } });
      }
    } else if (data.recurring_visual_motifs?.elements) {
      // Handle { elements: [...] } format
      this._flattenToAtoms(data.recurring_visual_motifs.elements, 'vibe', 'recurring_visual_motifs.elements', src, atoms);
    }
    if (data.character_energy && typeof data.character_energy === 'object') {
      this._flattenToAtoms(data.character_energy, 'vibe', 'character_energy', src, atoms);
    } else if (typeof data.character_energy === 'string') {
      atoms.push({ category: 'vibe', text: data.character_energy, tags: ['energy'], sourceField: 'character_energy', source: { ...src } });
    }

    // ─── accessories_catalog, accessory_styling_combos → accessories ───
    if (Array.isArray(data.accessories_catalog)) {
      for (const item of data.accessories_catalog) {
        const text = typeof item === 'string' ? item : (item?.description || item?.text || '');
        if (text) atoms.push({ category: 'accessories', text, tags: [], sourceField: 'accessories_catalog', source: { ...src } });
      }
    } else if (data.accessories_catalog && typeof data.accessories_catalog === 'object') {
      // Handle { jewelry: [...], eyewear: [...], props: [...] } format
      for (const [subcat, items] of Object.entries(data.accessories_catalog)) {
        if (Array.isArray(items)) {
          for (const item of items) {
            const text = typeof item === 'string' ? item : (item?.description || item?.text || '');
            if (text) atoms.push({ category: 'accessories', text, tags: [subcat], sourceField: `accessories_catalog.${subcat}`, source: { ...src } });
          }
        }
      }
    }
    if (Array.isArray(data.accessory_styling_combos)) {
      for (const item of data.accessory_styling_combos) {
        const text = typeof item === 'string' ? item : (item?.description || item?.text || '');
        if (text) atoms.push({ category: 'accessories', text, tags: ['combo'], sourceField: 'accessory_styling_combos', source: { ...src } });
      }
    }
  }

  /** Recursively flatten an object/array into atoms for a given category */
  _flattenToAtoms(obj, category, parentField, source, atoms) {
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === 'string') {
          atoms.push({ category, text: item, tags: [], sourceField: parentField, source: { ...source } });
        } else if (item && typeof item === 'object') {
          const text = item.description || item.text || item.name || '';
          if (text) atoms.push({ category, text, tags: [], sourceField: parentField, source: { ...source } });
        }
      }
    } else if (typeof obj === 'object' && obj !== null) {
      for (const [key, val] of Object.entries(obj)) {
        const fieldPath = `${parentField}.${key}`;
        if (Array.isArray(val)) {
          for (const item of val) {
            if (typeof item === 'string') {
              atoms.push({ category, text: item, tags: [key], sourceField: fieldPath, source: { ...source } });
            } else if (item && typeof item === 'object') {
              const text = item.description || item.text || item.name || '';
              if (text) atoms.push({ category, text, tags: [key], sourceField: fieldPath, source: { ...source } });
            }
          }
        } else if (typeof val === 'string') {
          atoms.push({ category, text: val, tags: [key], sourceField: fieldPath, source: { ...source } });
        }
      }
    }
  }

  // ─── Backfill from promptKnowledge ─────────────────────

  backfillFromPromptKnowledge() {
    const pkFile = path.join(DATA_DIR, 'promptKnowledge.json');
    if (!fs.existsSync(pkFile)) return { imported: 0 };

    let pkData;
    try {
      pkData = JSON.parse(fs.readFileSync(pkFile, 'utf8'));
    } catch {
      return { imported: 0 };
    }
    if (!Array.isArray(pkData)) return { imported: 0 };

    const categories = ['lighting', 'camera', 'pose', 'expression', 'outfit', 'scene', 'accessories'];
    const atoms = [];

    for (const entry of pkData) {
      for (const cat of categories) {
        const text = entry[cat];
        if (typeof text === 'string' && text.trim().length > 15) {
          atoms.push({
            category: cat,
            text: this.stripIdentity(text.trim()),
            tags: [],
            source: {
              type: 'backfill',
              postUrl: entry.source_url || '',
            },
          });
        }
      }
    }

    // Filter duplicates (by text similarity)
    const unique = [];
    const seen = new Set();
    for (const atom of atoms) {
      const key = `${atom.category}::${atom.text.toLowerCase().slice(0, 80)}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(atom);
      }
    }

    if (unique.length === 0) return { imported: 0 };

    const created = this.createBulk(unique);
    return { imported: created.length };
  }

  // ─── Validation ────────────────────────────────────────

  _validateId(id) {
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new AppError('Atom ID is required', 400, 'VALIDATION_ERROR');
    }
  }

  _validateAtomPayload(data) {
    if (!data || typeof data !== 'object') {
      throw new AppError('Atom data is required', 400, 'VALIDATION_ERROR');
    }
    if (!VALID_CATEGORIES.includes(data.category)) {
      throw new AppError(`category must be one of: ${VALID_CATEGORIES.join(', ')}`, 400, 'VALIDATION_ERROR');
    }
    if (typeof data.text !== 'string' || data.text.trim().length === 0) {
      throw new AppError('text is required and must be a non-empty string', 400, 'VALIDATION_ERROR');
    }
  }

  _normalizeSource(source) {
    if (!source || typeof source !== 'object') return { type: 'manual' };
    return {
      type: VALID_SOURCE_TYPES.includes(source.type) ? source.type : 'manual',
      ...(source.profileUsername ? { profileUsername: source.profileUsername } : {}),
      ...(source.postUrl ? { postUrl: source.postUrl } : {}),
      ...(source.sourceLabel ? { sourceLabel: source.sourceLabel } : {}),
    };
  }

  // ─── File I/O ──────────────────────────────────────────

  _ensureDataFile(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '[]', 'utf8');
  }

  _loadFile(filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      log.warn('style_library_load_failed', { file: filePath, message: err.message });
    }
    fs.writeFileSync(filePath, '[]', 'utf8');
    return [];
  }

  _persistStore() {
    atomicWriteJSON(DATA_FILE, this._store);
  }

  _persistProfiles() {
    atomicWriteJSON(PROFILES_FILE, this._profiles);
  }
}

module.exports = new StyleLibraryService();
