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
const { DATA_DIR } = require('../paths');
const DATA_FILE = path.join(DATA_DIR, 'keys.enc');

class ApiKeyManager {
  constructor() {
    this._ensureDataDir();
    this._store = this._loadStore();
    this._derivedKeyCache = new Map();
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
    const dataDir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  _loadStore() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
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

  _saveStore() {
    atomicWriteJSON(DATA_FILE, this._store);
  }
}

module.exports = new ApiKeyManager();
