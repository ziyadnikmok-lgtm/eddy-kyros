const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');
const log = require('../utils/logger');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_DERIVATION_ITERATIONS = 100000;
const DERIVED_KEY_CACHE_MAX = 20;
const { getDataDir } = require('../paths');
const { getUserId } = require('../userContext');

class ApiKeyManager {
  constructor() {
    this._userStores = new Map(); // userId -> store object (lazy-loaded)
    this._derivedKeyCache = new Map();
  }

  get _dataFile() { return path.join(getDataDir(), 'keys.enc'); }

  /** Returns (and lazily initialises) the per-user in-memory store */
  get _store() {
    const userId = getUserId() || '__anon__';
    if (!this._userStores.has(userId)) {
      this._ensureDataDir();
      const store = this._loadStore();
      this._migrateGlobalSpendFor(store);
      this._userStores.set(userId, store);
    }
    return this._userStores.get(userId);
  }

  /** Migrate old global spend data to the active key entry (one-time) */
  _migrateGlobalSpendFor(store) {
    if (typeof store.totalSpendUsd === 'number' && store.totalSpendUsd > 0) {
      const entry = store.activeKeyId ? store.keys.find(k => k.id === store.activeKeyId) : null;
      if (entry && !(entry.totalSpendUsd > 0)) {
        entry.totalSpendUsd = store.totalSpendUsd;
        entry.textCallCount = store.textCallCount || 0;
        entry.imageCallCount = store.imageCallCount || 0;
        entry.spendBudgetUsd = store.spendBudgetUsd || 300;
      }
      delete store.totalSpendUsd;
      delete store.spendBudgetUsd;
      delete store.textCallCount;
      delete store.imageCallCount;
      atomicWriteJSON(this._dataFile, store);
    }
    // Ensure all keys have spend fields
    for (const k of store.keys) {
      if (typeof k.totalSpendUsd !== 'number') k.totalSpendUsd = 0;
      if (typeof k.spendBudgetUsd !== 'number') k.spendBudgetUsd = 300;
      if (typeof k.textCallCount !== 'number') k.textCallCount = 0;
      if (typeof k.imageCallCount !== 'number') k.imageCallCount = 0;
      if (!Array.isArray(k.spendLog)) k.spendLog = [];
      if (!k.characterSpend || typeof k.characterSpend !== 'object') k.characterSpend = {};
    }
  }

  addKey(name, apiKey) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new AppError('Key name is required', 400, 'VALIDATION_ERROR');
    }
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
      throw new AppError('A valid API key is required (min 10 chars)', 400, 'VALIDATION_ERROR');
    }

    const id = crypto.randomUUID();
    const entry = {
      id,
      name: name.trim(),
      maskedKey: this._maskKey(apiKey.trim()),
      encryptedKey: this._encrypt(apiKey.trim()),
      createdAt: new Date().toISOString(),
      totalSpendUsd: 0,
      spendBudgetUsd: 300,
      textCallCount: 0,
      imageCallCount: 0,
      spendLog: [],
      characterSpend: {},
    };

    this._store.keys.push(entry);

    if (this._store.keys.length === 1) {
      this._store.activeKeyId = id;
    }

    this._saveStore();

    return { id: entry.id, name: entry.name, maskedKey: entry.maskedKey, isActive: this._store.activeKeyId === id };
  }

  setActiveKey(keyId) {
    if (!keyId || typeof keyId !== 'string') {
      throw new AppError('Key ID is required', 400, 'VALIDATION_ERROR');
    }

    const entry = this._store.keys.find((k) => k.id === keyId);
    if (!entry) {
      throw new AppError('Key not found', 404, 'KEY_NOT_FOUND');
    }

    this._store.activeKeyId = keyId;
    this._saveStore();

    return { id: entry.id, name: entry.name, maskedKey: entry.maskedKey };
  }

  getActiveKey() {
    if (!this._store.activeKeyId) {
      throw new AppError('No active API key set. Add a key first.', 400, 'NO_ACTIVE_KEY');
    }

    const entry = this._store.keys.find((k) => k.id === this._store.activeKeyId);
    if (!entry) {
      throw new AppError('Active key entry missing. Re-add the key.', 500, 'KEY_CORRUPTED');
    }

    return this._decrypt(entry.encryptedKey);
  }

  listKeys() {
    return this._store.keys.map((k) => ({
      id: k.id,
      name: k.name,
      maskedKey: k.maskedKey,
      createdAt: k.createdAt,
      isActive: k.id === this._store.activeKeyId,
      totalSpendUsd: k.totalSpendUsd || 0,
      spendBudgetUsd: k.spendBudgetUsd || 300,
      textCallCount: k.textCallCount || 0,
      imageCallCount: k.imageCallCount || 0,
    }));
  }

  removeKey(keyId) {
    if (!keyId || typeof keyId !== 'string') {
      throw new AppError('Key ID is required', 400, 'VALIDATION_ERROR');
    }

    const index = this._store.keys.findIndex((k) => k.id === keyId);
    if (index === -1) {
      throw new AppError('Key not found', 404, 'KEY_NOT_FOUND');
    }

    this._store.keys.splice(index, 1);

    if (this._store.activeKeyId === keyId) {
      this._store.activeKeyId = this._store.keys.length > 0 ? this._store.keys[0].id : null;
    }

    this._saveStore();
    return { removed: true };
  }

  setApifyKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
      throw new AppError('A valid Apify API key is required (min 10 chars)', 400, 'VALIDATION_ERROR');
    }
    const value = apiKey.trim();
    this._store.apifyKeyEncrypted = this._encrypt(value);
    this._store.apifyKeyMasked = this._maskKey(value);
    this._store.apifyUpdatedAt = new Date().toISOString();
    this._saveStore();
    return {
      hasApifyKey: true,
      maskedKey: this._store.apifyKeyMasked,
      updatedAt: this._store.apifyUpdatedAt,
    };
  }

  getApifyKey() {
    if (!this._store.apifyKeyEncrypted) return '';
    return this._decrypt(this._store.apifyKeyEncrypted);
  }

  getApifyKeyInfo() {
    return {
      hasApifyKey: !!this._store.apifyKeyEncrypted,
      maskedKey: this._store.apifyKeyMasked || '',
      updatedAt: this._store.apifyUpdatedAt || null,
    };
  }

  clearApifyKey() {
    this._store.apifyKeyEncrypted = null;
    this._store.apifyKeyMasked = '';
    this._store.apifyUpdatedAt = null;
    this._saveStore();
    return { removed: true };
  }

  setWavespeedKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
      throw new AppError('A valid WaveSpeed API key is required (min 10 chars)', 400, 'VALIDATION_ERROR');
    }
    const value = apiKey.trim();
    this._store.wavespeedKeyEncrypted = this._encrypt(value);
    this._store.wavespeedKeyMasked = this._maskKey(value);
    this._store.wavespeedUpdatedAt = new Date().toISOString();
    this._saveStore();
    return {
      hasWavespeedKey: true,
      maskedKey: this._store.wavespeedKeyMasked,
      updatedAt: this._store.wavespeedUpdatedAt,
    };
  }

  getWavespeedKey() {
    if (!this._store.wavespeedKeyEncrypted) return '';
    return this._decrypt(this._store.wavespeedKeyEncrypted);
  }

  getWavespeedKeyInfo() {
    return {
      hasWavespeedKey: !!this._store.wavespeedKeyEncrypted,
      maskedKey: this._store.wavespeedKeyMasked || '',
      updatedAt: this._store.wavespeedUpdatedAt || null,
    };
  }

  clearWavespeedKey() {
    this._store.wavespeedKeyEncrypted = null;
    this._store.wavespeedKeyMasked = '';
    this._store.wavespeedUpdatedAt = null;
    this._saveStore();
    return { removed: true };
  }

  setInstagramSessionId(sessionid) {
    if (!sessionid || typeof sessionid !== 'string' || sessionid.trim().length < 8) {
      throw new AppError('A valid Instagram sessionid is required', 400, 'VALIDATION_ERROR');
    }
    const value = sessionid.trim();
    this._store.instagramSessionEncrypted = this._encrypt(value);
    this._store.instagramSessionMasked = this._maskKey(value);
    this._store.instagramSessionUpdatedAt = new Date().toISOString();
    this._saveStore();
    return {
      hasInstagramSession: true,
      maskedValue: this._store.instagramSessionMasked,
      updatedAt: this._store.instagramSessionUpdatedAt,
    };
  }

  getInstagramSessionId() {
    if (!this._store.instagramSessionEncrypted) return '';
    return this._decrypt(this._store.instagramSessionEncrypted);
  }

  getInstagramSessionInfo() {
    return {
      hasInstagramSession: !!this._store.instagramSessionEncrypted,
      maskedValue: this._store.instagramSessionMasked || '',
      updatedAt: this._store.instagramSessionUpdatedAt || null,
    };
  }

  clearInstagramSessionId() {
    this._store.instagramSessionEncrypted = null;
    this._store.instagramSessionMasked = '';
    this._store.instagramSessionUpdatedAt = null;
    this._saveStore();
    return { removed: true };
  }

  setInstagramLogin(username, password, twoFaSecret) {
    if (!username || typeof username !== 'string' || username.trim().length < 3) {
      throw new AppError('A valid Instagram username is required (min 3 chars)', 400, 'VALIDATION_ERROR');
    }
    if (!password || typeof password !== 'string' || password.trim().length < 6) {
      throw new AppError('A valid Instagram password is required (min 6 chars)', 400, 'VALIDATION_ERROR');
    }
    const u = username.trim();
    const p = password.trim();
    this._store.igLoginUsernameEncrypted = this._encrypt(u);
    this._store.igLoginUsernameMasked = this._maskKey(u);
    this._store.igLoginPasswordEncrypted = this._encrypt(p);
    this._store.igLoginPasswordMasked = this._maskKey(p);
    if (twoFaSecret && typeof twoFaSecret === 'string' && twoFaSecret.trim().length > 0) {
      const s = twoFaSecret.trim().toUpperCase().replace(/\s/g, '');
      this._store.igLogin2faSecretEncrypted = this._encrypt(s);
      this._store.igLogin2faSecretMasked = this._maskKey(s);
    } else {
      this._store.igLogin2faSecretEncrypted = null;
      this._store.igLogin2faSecretMasked = '';
    }
    this._store.igLoginUpdatedAt = new Date().toISOString();
    this._saveStore();
    return {
      hasInstagramLogin: true,
      maskedUsername: this._store.igLoginUsernameMasked,
      maskedPassword: this._store.igLoginPasswordMasked,
      has2fa: !!this._store.igLogin2faSecretEncrypted,
      masked2faSecret: this._store.igLogin2faSecretMasked || '',
      updatedAt: this._store.igLoginUpdatedAt,
    };
  }

  getInstagramLogin() {
    if (!this._store.igLoginUsernameEncrypted || !this._store.igLoginPasswordEncrypted) return null;
    const result = {
      username: this._decrypt(this._store.igLoginUsernameEncrypted),
      password: this._decrypt(this._store.igLoginPasswordEncrypted),
      twoFaSecret: null,
    };
    if (this._store.igLogin2faSecretEncrypted) {
      result.twoFaSecret = this._decrypt(this._store.igLogin2faSecretEncrypted);
    }
    return result;
  }

  getInstagramLoginInfo() {
    return {
      hasInstagramLogin: !!(this._store.igLoginUsernameEncrypted && this._store.igLoginPasswordEncrypted),
      maskedUsername: this._store.igLoginUsernameMasked || '',
      maskedPassword: this._store.igLoginPasswordMasked || '',
      has2fa: !!this._store.igLogin2faSecretEncrypted,
      masked2faSecret: this._store.igLogin2faSecretMasked || '',
      updatedAt: this._store.igLoginUpdatedAt || null,
    };
  }

  clearInstagramLogin() {
    this._store.igLoginUsernameEncrypted = null;
    this._store.igLoginUsernameMasked = '';
    this._store.igLoginPasswordEncrypted = null;
    this._store.igLoginPasswordMasked = '';
    this._store.igLogin2faSecretEncrypted = null;
    this._store.igLogin2faSecretMasked = '';
    this._store.igLoginUpdatedAt = null;
    this._saveStore();
    return { removed: true };
  }

  _getEncryptionSecret() {
    const secret = process.env.ENCRYPTION_SECRET;
    if (!secret || secret.length < 32) {
      throw new AppError(
        'ENCRYPTION_SECRET must be set in .env and be at least 32 characters',
        500,
        'CONFIG_ERROR'
      );
    }
    return secret;
  }

  _deriveKey(salt) {
    const cacheKey = salt.toString('hex');
    const cached = this._derivedKeyCache.get(cacheKey);
    if (cached) return cached;

    const secret = this._getEncryptionSecret();
    const derived = crypto.pbkdf2Sync(secret, salt, KEY_DERIVATION_ITERATIONS, 32, 'sha512');

    if (this._derivedKeyCache.size >= DERIVED_KEY_CACHE_MAX) {
      const oldest = this._derivedKeyCache.keys().next().value;
      this._derivedKeyCache.delete(oldest);
    }
    this._derivedKeyCache.set(cacheKey, derived);

    return derived;
  }

  _encrypt(plaintext) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const derivedKey = this._deriveKey(salt);
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      salt.toString('hex'),
      iv.toString('hex'),
      authTag.toString('hex'),
      encrypted.toString('hex'),
    ].join(':');
  }

  _decrypt(encryptedPayload) {
    try {
      const [saltHex, ivHex, authTagHex, ciphertextHex] = encryptedPayload.split(':');

      const salt = Buffer.from(saltHex, 'hex');
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      const ciphertext = Buffer.from(ciphertextHex, 'hex');

      const derivedKey = this._deriveKey(salt);

      const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return decrypted.toString('utf8');
    } catch {
      throw new AppError('Failed to decrypt API key. Check your ENCRYPTION_SECRET.', 500, 'DECRYPTION_FAILED');
    }
  }

  _maskKey(key) {
    if (key.length <= 8) return '****' + key.slice(-4);
    return key.slice(0, 4) + '****' + key.slice(-4);
  }

  _ensureDataDir() {
    const dataDir = path.dirname(this._dataFile);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  _loadStore() {
    try {
      const dataFile = this._dataFile;
      if (fs.existsSync(dataFile)) {
        const raw = fs.readFileSync(dataFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.keys)) {
          return {
            keys: parsed.keys,
            activeKeyId: parsed.activeKeyId || null,
            apifyKeyEncrypted: parsed.apifyKeyEncrypted || null,
            apifyKeyMasked: parsed.apifyKeyMasked || '',
            apifyUpdatedAt: parsed.apifyUpdatedAt || null,
            instagramSessionEncrypted: parsed.instagramSessionEncrypted || null,
            instagramSessionMasked: parsed.instagramSessionMasked || '',
            instagramSessionUpdatedAt: parsed.instagramSessionUpdatedAt || null,
            igLoginUsernameEncrypted: parsed.igLoginUsernameEncrypted || null,
            igLoginUsernameMasked: parsed.igLoginUsernameMasked || '',
            igLoginPasswordEncrypted: parsed.igLoginPasswordEncrypted || null,
            igLoginPasswordMasked: parsed.igLoginPasswordMasked || '',
            igLogin2faSecretEncrypted: parsed.igLogin2faSecretEncrypted || null,
            igLogin2faSecretMasked: parsed.igLogin2faSecretMasked || '',
            igLoginUpdatedAt: parsed.igLoginUpdatedAt || null,
            wavespeedKeyEncrypted: parsed.wavespeedKeyEncrypted || null,
            wavespeedKeyMasked: parsed.wavespeedKeyMasked || '',
            wavespeedUpdatedAt: parsed.wavespeedUpdatedAt || null,
          };
        }
      }
    } catch (err) {
      log.warn('apikey_load_failed', { message: err.message });
    }
    return {
      keys: [],
      activeKeyId: null,
      apifyKeyEncrypted: null,
      apifyKeyMasked: '',
      apifyUpdatedAt: null,
      wavespeedKeyEncrypted: null,
      wavespeedKeyMasked: '',
      wavespeedUpdatedAt: null,
      instagramSessionEncrypted: null,
      instagramSessionMasked: '',
      instagramSessionUpdatedAt: null,
      igLoginUsernameEncrypted: null,
      igLoginUsernameMasked: '',
      igLoginPasswordEncrypted: null,
      igLoginPasswordMasked: '',
      igLogin2faSecretEncrypted: null,
      igLogin2faSecretMasked: '',
      igLoginUpdatedAt: null,
    };
  }

  // --- Spend tracking (per-key) ---

  _getActiveEntry() {
    if (!this._store.activeKeyId) return null;
    return this._store.keys.find((k) => k.id === this._store.activeKeyId) || null;
  }

  checkBudget() {
    const entry = this._getActiveEntry();
    if (!entry) return; // no key, will fail at getActiveKey() anyway
    const budget = entry.spendBudgetUsd || 300;
    const spent = entry.totalSpendUsd || 0;
    if (spent >= budget) {
      throw new AppError(
        `API budget limit reached ($${spent.toFixed(2)} / $${budget.toFixed(2)}). Add more budget or use a different key.`,
        402,
        'BUDGET_EXCEEDED'
      );
    }
  }

  /**
   * Track text generation spend.
   * gemini-3-flash-preview: $0.50/1M input, $3.00/1M output
   */
  addTextSpend(promptTokens, outputTokens, characterId) {
    const entry = this._getActiveEntry();
    if (!entry) return 0;
    const inputCost = (promptTokens / 1_000_000) * 0.50;
    const outputCost = (outputTokens / 1_000_000) * 3.00;
    const total = inputCost + outputCost;
    entry.totalSpendUsd = (entry.totalSpendUsd || 0) + total;
    entry.textCallCount = (entry.textCallCount || 0) + 1;
    this._appendSpendLog(entry, total, 0, 1, 0);
    this._trackCharacterSpend(entry, characterId, total, 0, 1, 0);
    this._saveStore();
    return total;
  }

  /**
   * Track image generation spend.
   * @param {string} model - 'gemini-3-pro-image-preview' or 'gemini-3.1-flash-image-preview'
   * @param {string} resolution - '0.5K', '1K', '2K', '4K'
   * @param {number} refImageCount - number of reference/input images sent
   * @param {number} promptTokens - input prompt token count (from usageMetadata)
   * @param {number} outputTokens - output token count (text portion)
   */
  addImageSpend(model, resolution = '2K', refImageCount = 0, promptTokens = 0, outputTokens = 0, characterId) {
    if (model === 'nano-bypass-experimental') {
      model = 'gemini-3.1-flash-image-preview';
    }
    let imageCost = 0;
    let inputTokenCostPer1M = 0;
    let outputTextCostPer1M = 0;
    let inputImageCost = 0;

    if (model === 'gemini-3-pro-image-preview') {
      // Pro model pricing
      inputTokenCostPer1M = 2.00;
      outputTextCostPer1M = 12.00;
      inputImageCost = 0.0011; // per input image
      if (resolution === '4K') imageCost = 0.24;
      else imageCost = 0.134; // 1K and 2K same price
    } else {
      // Flash model (gemini-3.1-flash-image-preview)
      inputTokenCostPer1M = 0.50;
      outputTextCostPer1M = 3.00;
      inputImageCost = 0; // not listed separately for flash
      if (resolution === '4K') imageCost = 0.151;
      else if (resolution === '2K') imageCost = 0.101;
      else if (resolution === '1K') imageCost = 0.067;
      else imageCost = 0.045; // 0.5K
    }

    const tokenInputCost = (promptTokens / 1_000_000) * inputTokenCostPer1M;
    const tokenOutputCost = (outputTokens / 1_000_000) * outputTextCostPer1M;
    const refCost = refImageCount * inputImageCost;
    const total = imageCost + tokenInputCost + tokenOutputCost + refCost;

    const entry = this._getActiveEntry();
    if (!entry) return 0;
    entry.totalSpendUsd = (entry.totalSpendUsd || 0) + total;
    entry.imageCallCount = (entry.imageCallCount || 0) + 1;
    this._appendSpendLog(entry, 0, total, 0, 1);
    this._trackCharacterSpend(entry, characterId, 0, total, 0, 1);
    this._saveStore();
    return total;
  }

  /** Append to daily spend log, aggregating by date. Prune entries older than 90 days. */
  _appendSpendLog(entry, textSpend, imageSpend, textCalls, imageCalls) {
    if (!Array.isArray(entry.spendLog)) entry.spendLog = [];
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    let dayEntry = entry.spendLog.find((e) => e.date === today);
    if (dayEntry) {
      dayEntry.textSpend = (dayEntry.textSpend || 0) + textSpend;
      dayEntry.imageSpend = (dayEntry.imageSpend || 0) + imageSpend;
      dayEntry.textCalls = (dayEntry.textCalls || 0) + textCalls;
      dayEntry.imageCalls = (dayEntry.imageCalls || 0) + imageCalls;
    } else {
      entry.spendLog.push({ date: today, textSpend, imageSpend, textCalls, imageCalls });
    }
    // Prune entries older than 90 days
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    entry.spendLog = entry.spendLog.filter((e) => e.date >= cutoff);
  }

  /** Track per-character spend */
  _trackCharacterSpend(entry, characterId, textSpend, imageSpend, textCalls, imageCalls) {
    if (!characterId) return;
    if (!entry.characterSpend || typeof entry.characterSpend !== 'object') entry.characterSpend = {};
    if (!entry.characterSpend[characterId]) {
      entry.characterSpend[characterId] = { imageSpend: 0, textSpend: 0, imageCalls: 0, textCalls: 0 };
    }
    const cs = entry.characterSpend[characterId];
    cs.textSpend = (cs.textSpend || 0) + textSpend;
    cs.imageSpend = (cs.imageSpend || 0) + imageSpend;
    cs.textCalls = (cs.textCalls || 0) + textCalls;
    cs.imageCalls = (cs.imageCalls || 0) + imageCalls;
  }

  /** Get the spend log for the active key */
  getSpendLog() {
    const entry = this._getActiveEntry();
    if (!entry) return [];
    return entry.spendLog || [];
  }

  getSpendInfo() {
    const entry = this._getActiveEntry();
    if (!entry) return { totalSpendUsd: 0, spendBudgetUsd: 300, textCallCount: 0, imageCallCount: 0, remainingUsd: 300, spendLog: [], characterSpend: {}, topCharacters: [] };
    const spent = entry.totalSpendUsd || 0;
    const budget = entry.spendBudgetUsd || 300;
    const charSpend = entry.characterSpend || {};

    // Build top characters sorted by total spend descending
    const topCharacters = Object.entries(charSpend)
      .map(([id, cs]) => ({
        characterId: id,
        totalSpend: (cs.textSpend || 0) + (cs.imageSpend || 0),
        imageSpend: cs.imageSpend || 0,
        textSpend: cs.textSpend || 0,
        imageCalls: cs.imageCalls || 0,
        textCalls: cs.textCalls || 0,
      }))
      .sort((a, b) => b.totalSpend - a.totalSpend);

    return {
      totalSpendUsd: spent,
      spendBudgetUsd: budget,
      textCallCount: entry.textCallCount || 0,
      imageCallCount: entry.imageCallCount || 0,
      remainingUsd: Math.max(0, budget - spent),
      spendLog: entry.spendLog || [],
      characterSpend: charSpend,
      topCharacters,
    };
  }

  resetSpend() {
    const entry = this._getActiveEntry();
    if (entry) {
      entry.totalSpendUsd = 0;
      entry.textCallCount = 0;
      entry.imageCallCount = 0;
      this._saveStore();
    }
    return this.getSpendInfo();
  }

  /**
   * Track WaveSpeed video/NSFW spend.
   * @param {number} costUsd - exact cost from VIDEO_MODELS prices or NSFW flat rate
   * @param {string} [type] - 'video' or 'nsfw-image'
   * @param {string} [characterId]
   */
  addExternalSpend(costUsd, type = 'video', characterId) {
    const entry = this._getActiveEntry();
    if (!entry || !costUsd || costUsd <= 0) return 0;
    entry.totalSpendUsd = (entry.totalSpendUsd || 0) + costUsd;
    entry.imageCallCount = (entry.imageCallCount || 0) + 1;
    this._appendSpendLog(entry, 0, costUsd, 0, 1);
    this._trackCharacterSpend(entry, characterId, 0, costUsd, 0, 1);
    this._saveStore();
    return costUsd;
  }

  /**
   * Backfill spend from existing gallery images (one-time per key).
   * Estimates cost assuming 2K resolution and gemini-3-pro-image-preview.
   * Each image ≈ $0.134 (output) + ~$0.001 token overhead ≈ $0.135
   * Each text call for analysis/planning estimated at ~$0.002 average.
   */
  backfillFromGallery(imageCount) {
    const entry = this._getActiveEntry();
    if (!entry) return;
    if ((entry.imageCallCount || 0) > 0 || (entry.totalSpendUsd || 0) > 0) return; // already has data
    if (!imageCount || imageCount <= 0) return;

    const perImageCost = 0.135;
    const textCallsEstimate = Math.round(imageCount * 0.5);
    const perTextCost = 0.002;

    entry.imageCallCount = imageCount;
    entry.textCallCount = textCallsEstimate;
    entry.totalSpendUsd = (imageCount * perImageCost) + (textCallsEstimate * perTextCost);
    this._saveStore();
    log.info('spend_backfill', { keyId: entry.id, imageCount, textCallsEstimate, totalSpendUsd: entry.totalSpendUsd });
  }

  _saveStore() {
    atomicWriteJSON(this._dataFile, this._store);
  }
}

module.exports = new ApiKeyManager();
