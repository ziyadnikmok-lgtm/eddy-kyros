import { describe, it, expect, beforeEach } from 'vitest';
const galleryManager = require('../services/galleryManager');

describe('galleryManager — updateMetadata', () => {
  // Use an existing entry from the internal store for testing
  // We create a temporary entry via save(), test updateMetadata, then clean up
  let testId;

  beforeEach(() => {
    // Create a tiny test image (1x1 white PNG as base64)
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    const entry = galleryManager.save({
      base64Data: tinyPng,
      mimeType: 'image/png',
      prompt: 'test image for updateMetadata',
      source: 'test',
    });
    testId = entry.id;
  });

  it('updates qualityScore on an existing entry', () => {
    const result = galleryManager.updateMetadata(testId, { qualityScore: 85 });
    expect(result.qualityScore).toBe(85);
  });

  it('updates qualityReasons on an existing entry', () => {
    const reasons = ['Great composition', 'Natural lighting'];
    const result = galleryManager.updateMetadata(testId, { qualityReasons: reasons });
    expect(result.qualityReasons).toEqual(reasons);
  });

  it('updates parentId on an existing entry', () => {
    const result = galleryManager.updateMetadata(testId, { parentId: 'parent-abc' });
    expect(result.parentId).toBe('parent-abc');
  });

  it('ignores disallowed keys', () => {
    const result = galleryManager.updateMetadata(testId, {
      qualityScore: 90,
      _secret: 'should not appear',
      filename: 'hacked.png',
    });
    expect(result.qualityScore).toBe(90);
    expect(result._secret).toBeUndefined();
    expect(result.filename).not.toBe('hacked.png'); // filename should be original
  });

  it('handles empty patch as no-op', () => {
    const result = galleryManager.updateMetadata(testId, {});
    expect(result.id).toBe(testId);
  });

  it('handles null patch as no-op', () => {
    const result = galleryManager.updateMetadata(testId, null);
    expect(result.id).toBe(testId);
  });

  it('throws 404 for invalid ID', () => {
    expect(() => galleryManager.updateMetadata('nonexistent-id', { qualityScore: 50 }))
      .toThrow(/not found/i);
  });

  it('persists multiple fields in one call', () => {
    const result = galleryManager.updateMetadata(testId, {
      qualityScore: 92,
      qualityReasons: ['Sharp focus', 'Excellent color'],
      parentId: 'parent-xyz',
    });
    expect(result.qualityScore).toBe(92);
    expect(result.qualityReasons).toHaveLength(2);
    expect(result.parentId).toBe('parent-xyz');
  });
});

describe('galleryManager — _toSafe with new fields', () => {
  it('exposes qualityScore when present', () => {
    const entry = {
      id: 'qs-test', filename: 'qs.png', mimeType: 'image/png',
      prompt: '', source: 'test', createdAt: '2026-01-01',
      qualityScore: 88, qualityReasons: ['Good'],
    };
    const safe = galleryManager._toSafe(entry);
    expect(safe.qualityScore).toBe(88);
    expect(safe.qualityReasons).toEqual(['Good']);
  });

  it('omits qualityScore when not present', () => {
    const entry = {
      id: 'no-qs', filename: 'no.png', mimeType: 'image/png',
      prompt: '', source: 'test', createdAt: '2026-01-01',
    };
    const safe = galleryManager._toSafe(entry);
    expect(safe.qualityScore).toBeUndefined();
    expect(safe.qualityReasons).toBeUndefined();
  });

  it('exposes parentId when present', () => {
    const entry = {
      id: 'pid-test', filename: 'pid.png', mimeType: 'image/png',
      prompt: '', source: 'test', createdAt: '2026-01-01',
      parentId: 'parent-1',
    };
    const safe = galleryManager._toSafe(entry);
    expect(safe.parentId).toBe('parent-1');
  });

  it('exposes sessionId when present', () => {
    const entry = {
      id: 'sid-test', filename: 'sid.png', mimeType: 'image/png',
      prompt: '', source: 'test', createdAt: '2026-01-01',
      sessionId: 'sess-abc',
    };
    const safe = galleryManager._toSafe(entry);
    expect(safe.sessionId).toBe('sess-abc');
  });
});
