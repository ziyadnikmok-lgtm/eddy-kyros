// server/services/nicheManager.js

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const log = require('../utils/logger');
const { atomicWriteJSON } = require('../utils/helpers');

const DATA_FILE = path.join(__dirname, '..', 'data', 'niches.json');

// ============================================================================
// Built-in niche definitions
// ============================================================================

const BUILT_IN_NICHES = [
  {
    name: 'Personal Brand',
    tone: 'Confident, authentic, and relatable. Speak as a trusted expert sharing personal insights.',
    styleRules: [
      'Use first person — "I" statements',
      'Share micro-stories and personal anecdotes',
      'Balance vulnerability with authority',
      'Keep sentences punchy — max 15 words',
      'One idea per slide',
    ],
    emotionalTriggers: ['aspiration', 'relatability', 'trust', 'transformation'],
    hookStrategy: 'Lead with a bold personal opinion or a counter-intuitive truth from lived experience.',
    ctaStyle: 'Invite conversation: "What would you do?" or "Follow for more real talk."',
  },
  {
    name: 'Luxury Lifestyle',
    tone: 'Aspirational, polished, and subtly exclusive. Never desperate. The audience comes to you.',
    styleRules: [
      'Use sensory language — textures, scents, light',
      'Short sentences. Let images breathe.',
      'Imply exclusivity without bragging',
      'Minimal emojis — only ✨🤍🖤 if any',
      'Never use exclamation marks',
    ],
    emotionalTriggers: ['desire', 'exclusivity', 'status', 'beauty'],
    hookStrategy: 'Open with an evocative sensory detail or a quiet flex that makes people stop scrolling.',
    ctaStyle: 'Subtle invitation: "Link in bio" or "DM for details." Never hard-sell.',
  },
  {
    name: 'Fitness',
    tone: 'High-energy, disciplined, and motivational. Direct and no-nonsense.',
    styleRules: [
      'Use action verbs — grind, push, build, earn',
      'Short declarative sentences',
      'Include numbers and specifics when possible',
      'Use line breaks for emphasis',
      'Conversational but authoritative',
    ],
    emotionalTriggers: ['discipline', 'transformation', 'pride', 'competition'],
    hookStrategy: 'Start with a hard truth, a before/after contrast, or a challenge to the reader.',
    ctaStyle: 'Direct command: "Save this workout" or "Tag your gym partner."',
  },
  {
    name: 'Motivation',
    tone: 'Empowering, intense, and emotionally charged. Speak to the person at 3am who needs this.',
    styleRules: [
      'One powerful sentence per line',
      'Use repetition and rhythm',
      'Build intensity across slides',
      'End on a peak emotional note',
      'Avoid clichés — find fresh metaphors',
    ],
    emotionalTriggers: ['resilience', 'purpose', 'urgency', 'self-belief'],
    hookStrategy: 'Open with a painful truth everyone feels but nobody says. Create instant recognition.',
    ctaStyle: 'Emotional close: "Share this with someone who needs it" or "Save for when it gets hard."',
  },
  {
    name: 'Influencer',
    tone: 'Friendly, trendy, and conversational. Like texting your most stylish friend.',
    styleRules: [
      'Use casual language — contractions, slang ok',
      'Strategic emoji use throughout',
      'Ask questions to drive engagement',
      'Reference trends and pop culture naturally',
      'Keep it light and shareable',
    ],
    emotionalTriggers: ['FOMO', 'belonging', 'trend-awareness', 'aspiration'],
    hookStrategy: 'Lead with "POV:", "Things I wish I knew:", or a relatable hot take.',
    ctaStyle: 'Engagement bait: "Comment 🔥 if you relate" or "Save for later bestie."',
  },
  {
    name: 'Aesthetic Model',
    tone: 'Dreamy, poetic, and visually evocative. Words should feel like the images look.',
    styleRules: [
      'Minimal text — let visuals dominate',
      'Poetic fragments over full sentences',
      'Use metaphor and symbolism',
      'Lowercase aesthetic acceptable',
      'Max 8 words per slide caption',
    ],
    emotionalTriggers: ['beauty', 'mood', 'mystery', 'sensuality'],
    hookStrategy: 'A single evocative phrase or question that creates atmosphere. No explanation needed.',
    ctaStyle: 'Whisper-soft: "✨" or "more on my page" — never aggressive.',
  },
  {
    name: 'Educational',
    tone: 'Clear, authoritative, and approachable. A smart friend explaining complex things simply.',
    styleRules: [
      'Use numbered lists and frameworks',
      'One concept per slide — no overloading',
      'Define jargon when used',
      'Use "Here\'s why" and "Here\'s how" transitions',
      'End with actionable takeaway',
    ],
    emotionalTriggers: ['curiosity', 'competence', 'growth', 'clarity'],
    hookStrategy: 'Open with a surprising statistic, a common misconception, or "Most people get this wrong."',
    ctaStyle: 'Value-driven: "Save this for reference" or "Share with someone learning this."',
  },
  {
    name: 'E-Girl',
    tone: 'Playful, chaotic, and self-aware. Internet-native with a touch of dark humor.',
    styleRules: [
      'Mix lowercase with strategic caps for EMPHASIS',
      'Use internet speak — "ngl", "lowkey", "fr"',
      'Self-deprecating humor welcome',
      'Emojis: 🖤⛓️🥀💀✨',
      'Break grammar rules intentionally',
    ],
    emotionalTriggers: ['rebellion', 'humor', 'authenticity', 'chaos'],
    hookStrategy: 'Chaotic opener — an unhinged take, a cursed observation, or "no one asked but."',
    ctaStyle: 'Casual chaos: "follow for more unhinged content" or "like if u relate 💀"',
  },
  {
    name: 'Travel',
    tone: 'Adventurous, warm, and immersive. Transport the reader to the destination.',
    styleRules: [
      'Use vivid sensory details — sounds, smells, tastes',
      'Mix practical tips with emotional moments',
      'Include specific location names',
      'Write as if journaling in the moment',
      'Use present tense for immediacy',
    ],
    emotionalTriggers: ['wanderlust', 'freedom', 'discovery', 'nostalgia'],
    hookStrategy: 'Drop the reader into a moment: "The sun hits the water at 6am in Santorini and..."',
    ctaStyle: 'Inspire action: "Save for your next trip" or "Where should I go next? 👇"',
  },
  {
    name: 'Fashion',
    tone: 'Editorial, trend-conscious, and opinionated. Like a magazine editor with a personal blog.',
    styleRules: [
      'Name brands, fabrics, and specific pieces',
      'Use fashion vocabulary naturally',
      'Confidence over explanation — state don\'t justify',
      'Mix high and low references',
      'Clean formatting — no clutter',
    ],
    emotionalTriggers: ['self-expression', 'confidence', 'status', 'creativity'],
    hookStrategy: 'Bold style opinion, unexpected combination, or "The piece everyone needs this season."',
    ctaStyle: 'Chic and direct: "Shop link in bio" or "Outfit details in stories."',
  },
  {
    name: 'Goth',
    tone: 'Dark, atmospheric, and eloquent. Romantic darkness with literary depth.',
    styleRules: [
      'Rich vocabulary — embrace the dramatic',
      'Reference darkness, night, decay, rebirth',
      'Poetic cadence in every line',
      'Emojis: 🖤🌙🥀⛓️🕯️',
      'Never peppy — maintain gravitas',
    ],
    emotionalTriggers: ['melancholy', 'beauty-in-darkness', 'individuality', 'depth'],
    hookStrategy: 'Open with a dark poetic image or a philosophical observation about beauty and shadow.',
    ctaStyle: 'Atmospheric: "Follow for the dark side" or simply 🖤.',
  },
  {
    name: 'Mindset',
    tone: 'Philosophical, calm authority, and transformative. A mentor speaking quietly with conviction.',
    styleRules: [
      'Use "you" directly — speak to the reader',
      'Short wisdom-packed sentences',
      'Build from problem to solution across slides',
      'Use contrast: "Most people X. Winners Y."',
      'No fluff — every word earns its place',
    ],
    emotionalTriggers: ['self-improvement', 'clarity', 'discipline', 'inner-strength'],
    hookStrategy: 'Start with a mindset shift: "The reason you\'re stuck isn\'t what you think."',
    ctaStyle: 'Growth-focused: "Follow for daily mindset shifts" or "Save this. Read it again in 30 days."',
  },
];

// ============================================================================
// NicheManager
// ============================================================================

class NicheManager {
  constructor() {
    this._ensureDataDir();
    this._store = this._loadStore();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  listNiches() {
    return this._store.map((n) => this._toSafe(n));
  }

  getNiche(id) {
    if (!id || typeof id !== 'string') {
      throw new AppError('Niche ID is required', 400, 'VALIDATION_ERROR');
    }
    const niche = this._store.find((n) => n.id === id);
    if (!niche) {
      throw new AppError('Niche not found', 404, 'NICHE_NOT_FOUND');
    }
    return this._toSafe(niche);
  }

  createNiche(data) {
    this._validateNicheData(data);
    this._checkUniqueName(data.name.trim());

    const niche = {
      id: crypto.randomUUID(),
      name: data.name.trim(),
      tone: data.tone.trim(),
      styleRules: this._sanitizeStringArray(data.styleRules),
      emotionalTriggers: this._sanitizeStringArray(data.emotionalTriggers),
      hookStrategy: data.hookStrategy.trim(),
      ctaStyle: data.ctaStyle.trim(),
      isBuiltIn: false,
      createdAt: new Date().toISOString(),
    };

    this._store.push(niche);
    this._save();

    return this._toSafe(niche);
  }

  updateNiche(id, data) {
    if (!id || typeof id !== 'string') {
      throw new AppError('Niche ID is required', 400, 'VALIDATION_ERROR');
    }
    const index = this._store.findIndex((n) => n.id === id);
    if (index === -1) {
      throw new AppError('Niche not found', 404, 'NICHE_NOT_FOUND');
    }

    const existing = this._store[index];

    // Validate partial update fields
    if (data.name !== undefined) {
      if (typeof data.name !== 'string' || data.name.trim().length === 0) {
        throw new AppError('Niche name must be a non-empty string', 400, 'VALIDATION_ERROR');
      }
      if (data.name.trim().toLowerCase() !== existing.name.toLowerCase()) {
        this._checkUniqueName(data.name.trim(), id);
      }
      existing.name = data.name.trim();
    }
    if (data.tone !== undefined) {
      if (typeof data.tone !== 'string' || data.tone.trim().length === 0) {
        throw new AppError('Tone must be a non-empty string', 400, 'VALIDATION_ERROR');
      }
      existing.tone = data.tone.trim();
    }
    if (data.styleRules !== undefined) {
      if (!Array.isArray(data.styleRules)) {
        throw new AppError('styleRules must be an array', 400, 'VALIDATION_ERROR');
      }
      existing.styleRules = this._sanitizeStringArray(data.styleRules);
    }
    if (data.emotionalTriggers !== undefined) {
      if (!Array.isArray(data.emotionalTriggers)) {
        throw new AppError('emotionalTriggers must be an array', 400, 'VALIDATION_ERROR');
      }
      existing.emotionalTriggers = this._sanitizeStringArray(data.emotionalTriggers);
    }
    if (data.hookStrategy !== undefined) {
      if (typeof data.hookStrategy !== 'string') {
        throw new AppError('hookStrategy must be a string', 400, 'VALIDATION_ERROR');
      }
      existing.hookStrategy = data.hookStrategy.trim();
    }
    if (data.ctaStyle !== undefined) {
      if (typeof data.ctaStyle !== 'string') {
        throw new AppError('ctaStyle must be a string', 400, 'VALIDATION_ERROR');
      }
      existing.ctaStyle = data.ctaStyle.trim();
    }

    this._save();
    return this._toSafe(existing);
  }

  deleteNiche(id) {
    if (!id || typeof id !== 'string') {
      throw new AppError('Niche ID is required', 400, 'VALIDATION_ERROR');
    }
    const index = this._store.findIndex((n) => n.id === id);
    if (index === -1) {
      throw new AppError('Niche not found', 404, 'NICHE_NOT_FOUND');
    }
    this._store.splice(index, 1);
    this._save();
    return { removed: true };
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  _validateNicheData(data) {
    if (!data || typeof data !== 'object') {
      throw new AppError('Niche data object is required', 400, 'VALIDATION_ERROR');
    }
    const required = ['name', 'tone', 'hookStrategy', 'ctaStyle'];
    for (const field of required) {
      if (!data[field] || typeof data[field] !== 'string' || data[field].trim().length === 0) {
        throw new AppError(`"${field}" is required and must be a non-empty string`, 400, 'VALIDATION_ERROR');
      }
    }
    if (data.name.trim().length > 100) {
      throw new AppError('Niche name must be 100 characters or fewer', 400, 'VALIDATION_ERROR');
    }
    if (!Array.isArray(data.styleRules)) {
      throw new AppError('"styleRules" must be an array of strings', 400, 'VALIDATION_ERROR');
    }
    if (!Array.isArray(data.emotionalTriggers)) {
      throw new AppError('"emotionalTriggers" must be an array of strings', 400, 'VALIDATION_ERROR');
    }
  }

  _checkUniqueName(name, excludeId = null) {
    const conflict = this._store.find(
      (n) => n.name.toLowerCase() === name.toLowerCase() && n.id !== excludeId
    );
    if (conflict) {
      throw new AppError(`Niche "${name}" already exists`, 409, 'DUPLICATE_NICHE');
    }
  }

  _sanitizeStringArray(arr) {
    return arr
      .filter((s) => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim().slice(0, 500));
  }

  _toSafe(niche) {
    return {
      id: niche.id,
      name: niche.name,
      tone: niche.tone,
      styleRules: niche.styleRules,
      emotionalTriggers: niche.emotionalTriggers,
      hookStrategy: niche.hookStrategy,
      ctaStyle: niche.ctaStyle,
      isBuiltIn: !!niche.isBuiltIn,
      createdAt: niche.createdAt,
    };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  _ensureDataDir() {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _loadStore() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (err) {
      log.warn('niche_load_failed', { message: err.message });
    }

    // Initialize with built-in niches
    return this._initDefaults();
  }

  _initDefaults() {
    const niches = BUILT_IN_NICHES.map((def) => ({
      id: crypto.randomUUID(),
      ...def,
      isBuiltIn: true,
      createdAt: new Date().toISOString(),
    }));
    this._store = niches;
    this._save();
    return niches;
  }

  _save() {
    atomicWriteJSON(DATA_FILE, this._store);
  }
}

// Singleton
module.exports = new NicheManager();
