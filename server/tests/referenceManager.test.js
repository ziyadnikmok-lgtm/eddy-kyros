// server/tests/referenceManager.test.js
import { describe, it, expect } from 'vitest';
const refManager = require('../services/referenceManager');

describe('referenceManager', () => {
  describe('_sanitizeName', () => {
    it('removes dangerous filesystem characters', () => {
      expect(refManager._sanitizeName('a/b\\c:d*e?f"g<h>i|j.k')).toBe('abcdefghijk');
    });

    it('converts spaces to underscores', () => {
      expect(refManager._sanitizeName('my character name')).toBe('my_character_name');
    });

    it('collapses multiple underscores', () => {
      expect(refManager._sanitizeName('a___b')).toBe('a_b');
    });

    it('trims leading and trailing underscores', () => {
      expect(refManager._sanitizeName('_hello_')).toBe('hello');
    });

    it('limits to 100 characters', () => {
      const long = 'a'.repeat(200);
      expect(refManager._sanitizeName(long).length).toBe(100);
    });

    it('removes path traversal attempts', () => {
      expect(refManager._sanitizeName('..safe..name..')).toBe('safename');
    });
  });

  describe('_sanitizeFileName', () => {
    it('strips extension and dangerous characters', () => {
      expect(refManager._sanitizeFileName('my photo.png')).toBe('my_photo');
    });

    it('limits to 60 characters', () => {
      const long = 'a'.repeat(100) + '.jpg';
      expect(refManager._sanitizeFileName(long).length).toBeLessThanOrEqual(60);
    });

    it('returns "file" for empty result', () => {
      expect(refManager._sanitizeFileName('...')).toBe('file');
      expect(refManager._sanitizeFileName('!@#$.png')).toBe('file');
    });

    it('removes non-alphanumeric chars except underscore and hyphen', () => {
      expect(refManager._sanitizeFileName('hello world (1).jpg')).toBe('hello_world_1');
    });
  });

  describe('_extensionForMime', () => {
    it('maps image/png to .png', () => {
      expect(refManager._extensionForMime('image/png')).toBe('.png');
    });

    it('maps image/jpeg to .jpg', () => {
      expect(refManager._extensionForMime('image/jpeg')).toBe('.jpg');
    });

    it('maps image/webp to .webp', () => {
      expect(refManager._extensionForMime('image/webp')).toBe('.webp');
    });

    it('defaults to .png for unknown types', () => {
      expect(refManager._extensionForMime('image/bmp')).toBe('.png');
    });
  });

  describe('_mimeForExtension', () => {
    it('maps .png to image/png', () => {
      expect(refManager._mimeForExtension('.png')).toBe('image/png');
    });

    it('maps .jpg to image/jpeg', () => {
      expect(refManager._mimeForExtension('.jpg')).toBe('image/jpeg');
    });

    it('maps .jpeg to image/jpeg', () => {
      expect(refManager._mimeForExtension('.jpeg')).toBe('image/jpeg');
    });

    it('defaults to application/octet-stream for unknown', () => {
      expect(refManager._mimeForExtension('.bmp')).toBe('application/octet-stream');
    });
  });

  describe('_validateMagicBytes', () => {
    it('accepts valid PNG magic bytes', () => {
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(() => refManager._validateMagicBytes(buf, 'image/png', 'Test')).not.toThrow();
    });

    it('rejects invalid PNG magic bytes', () => {
      const buf = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      expect(() => refManager._validateMagicBytes(buf, 'image/png', 'Test')).toThrow('does not match');
    });

    it('accepts valid JPEG magic bytes', () => {
      const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      expect(() => refManager._validateMagicBytes(buf, 'image/jpeg', 'Test')).not.toThrow();
    });

    it('rejects invalid JPEG magic bytes', () => {
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      expect(() => refManager._validateMagicBytes(buf, 'image/jpeg', 'Test')).toThrow('does not match');
    });

    it('accepts valid WebP magic bytes', () => {
      // RIFF....WEBP
      const buf = Buffer.alloc(12);
      buf.write('RIFF', 0);
      buf.writeUInt32LE(100, 4);
      buf.write('WEBP', 8);
      expect(() => refManager._validateMagicBytes(buf, 'image/webp', 'Test')).not.toThrow();
    });

    it('rejects invalid WebP (too short)', () => {
      const buf = Buffer.from([0x52, 0x49, 0x46, 0x46]);
      expect(() => refManager._validateMagicBytes(buf, 'image/webp', 'Test')).toThrow('does not match');
    });
  });

  describe('_toSafeCharacter', () => {
    it('strips internal paths and exposes safe fields', () => {
      const data = {
        id: 'abc',
        name: 'TestChar',
        masterPrompt: 'Identity prompt',
        primaryImageFile: 'primary.png',
        references: [
          { id: 'ref1', category: 'Clothing', overridePrompt: 'Dress', isActive: true, createdAt: '2025-01-01', fileName: 'secret.png' },
        ],
        createdAt: '2025-01-01',
        internalPath: '/some/path',
      };
      const safe = refManager._toSafeCharacter(data);
      expect(safe.id).toBe('abc');
      expect(safe.hasPrimaryImage).toBe(true);
      expect(safe.internalPath).toBeUndefined();
      expect(safe.references[0].fileName).toBeUndefined();
      expect(safe.references[0].category).toBe('Clothing');
    });

    it('hasPrimaryImage is false when no file', () => {
      const data = { id: 'x', name: 'Y', masterPrompt: 'Z', primaryImageFile: '', references: [], createdAt: '2025-01-01' };
      expect(refManager._toSafeCharacter(data).hasPrimaryImage).toBe(false);
    });
  });

  describe('static constants', () => {
    it('VALID_CATEGORIES includes expected categories', () => {
      const cats = refManager.constructor.VALID_CATEGORIES;
      expect(cats).toContain('Clothing');
      expect(cats).toContain('Custom');
      expect(cats.length).toBe(7);
    });

    it('ALLOWED_EXTENSIONS includes standard image formats', () => {
      const exts = refManager.constructor.ALLOWED_EXTENSIONS;
      expect(exts).toContain('.png');
      expect(exts).toContain('.jpg');
      expect(exts).toContain('.webp');
    });
  });
});
