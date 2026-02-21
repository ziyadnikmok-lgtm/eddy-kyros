// server/tests/galleryManager.test.js
import { describe, it, expect } from 'vitest';
const galleryManager = require('../services/galleryManager');

describe('galleryManager', () => {
  describe('_toSafe', () => {
    it('returns only safe fields', () => {
      const entry = {
        id: 'abc-123',
        filename: 'abc-123.png',
        mimeType: 'image/png',
        prompt: 'A sunset scene',
        source: 'generate',
        characterId: 'char-1',
        aspectRatio: '16:9',
        seed: 42,
        fileSize: 1024,
        createdAt: '2025-01-01T00:00:00.000Z',
        _internalField: 'should not appear',
      };
      const safe = galleryManager._toSafe(entry);
      expect(safe.id).toBe('abc-123');
      expect(safe.filename).toBe('abc-123.png');
      expect(safe.mimeType).toBe('image/png');
      expect(safe.prompt).toBe('A sunset scene');
      expect(safe.source).toBe('generate');
      expect(safe.characterId).toBe('char-1');
      expect(safe.aspectRatio).toBe('16:9');
      expect(safe.seed).toBe(42);
      expect(safe.fileSize).toBe(1024);
      expect(safe.createdAt).toBe('2025-01-01T00:00:00.000Z');
      expect(safe._internalField).toBeUndefined();
    });

    it('handles null optional fields gracefully', () => {
      const entry = {
        id: 'x',
        filename: 'x.png',
        mimeType: 'image/png',
        prompt: '',
        source: 'batch',
        characterId: null,
        aspectRatio: null,
        seed: null,
        fileSize: 0,
        createdAt: '2025-01-01',
      };
      const safe = galleryManager._toSafe(entry);
      expect(safe.characterId).toBeNull();
      expect(safe.aspectRatio).toBeNull();
      expect(safe.seed).toBeNull();
    });
  });

  describe('getFolderPath', () => {
    it('returns a string path', () => {
      const p = galleryManager.getFolderPath();
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    });
  });
});
