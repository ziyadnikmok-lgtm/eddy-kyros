import { describe, it, expect, beforeEach } from 'vitest';

const imageStore = require('../services/imageStore');

describe('ImageStore', () => {
  it('stores and retrieves an image entry', () => {
    const result = imageStore.store({
      basePrompt: 'test prompt for store-retrieve',
      source: 'generate',
    });

    expect(result.imageId).toBeDefined();
    expect(result.basePrompt).toBe('test prompt for store-retrieve');
    expect(result.source).toBe('generate');

    const retrieved = imageStore.get(result.imageId);
    expect(retrieved.imageId).toBe(result.imageId);
  });

  it('throws on missing basePrompt', () => {
    expect(() => imageStore.store({})).toThrow(/basePrompt/);
  });

  it('throws on invalid source', () => {
    expect(() =>
      imageStore.store({ basePrompt: 'test', source: 'invalid-source' })
    ).toThrow(/source/);
  });

  it('throws on get with non-existent ID', () => {
    expect(() => imageStore.get('non-existent-id')).toThrow(/not found/i);
  });

  it('tracks children when parentImageId is set', () => {
    const parent = imageStore.store({
      basePrompt: 'parent image for children test',
      source: 'generate',
    });

    const child = imageStore.store({
      basePrompt: 'child image for children test',
      parentImageId: parent.imageId,
      variationIndex: 0,
      source: 'tweak',
    });

    const children = imageStore.getChildren(parent.imageId);
    expect(children.length).toBe(1);
    expect(children[0].imageId).toBe(child.imageId);
  });

  it('has() returns true for existing and false for missing', () => {
    const result = imageStore.store({
      basePrompt: 'has check test',
      source: 'generate',
    });
    expect(imageStore.has(result.imageId)).toBe(true);
    expect(imageStore.has('definitely-not-here')).toBe(false);
  });

  it('stores image data and includes it in get()', () => {
    const result = imageStore.store({
      basePrompt: 'image data test',
      image: { mimeType: 'image/png', base64Data: 'iVBOR...' },
      source: 'generate',
    });

    const retrieved = imageStore.get(result.imageId);
    expect(retrieved.image).toBeDefined();
    expect(retrieved.image.mimeType).toBe('image/png');
    expect(retrieved.image.base64Data).toBe('iVBOR...');
  });

  it('list() returns entries without base64 data', () => {
    imageStore.store({
      basePrompt: 'list test entry',
      image: { mimeType: 'image/jpeg', base64Data: 'abc123' },
      source: 'batch',
    });

    const list = imageStore.list();
    expect(list.length).toBeGreaterThan(0);
    const entry = list.find((e) => e.basePrompt === 'list test entry');
    expect(entry).toBeDefined();
    expect(entry.image).toBeUndefined();
    expect(entry.hasImage).toBe(true);
  });

  it('stats() returns expected shape', () => {
    const stats = imageStore.stats();
    expect(stats).toHaveProperty('entries');
    expect(stats).toHaveProperty('estimatedBytes');
    expect(stats).toHaveProperty('estimatedMB');
    expect(stats).toHaveProperty('capMB');
    expect(typeof stats.entries).toBe('number');
    expect(stats.entries).toBeGreaterThan(0);
  });

  it('getChildCount() returns correct count', () => {
    const parent = imageStore.store({
      basePrompt: 'parent for childcount',
      source: 'generate',
    });
    imageStore.store({
      basePrompt: 'child1 for childcount',
      parentImageId: parent.imageId,
      source: 'tweak',
    });
    imageStore.store({
      basePrompt: 'child2 for childcount',
      parentImageId: parent.imageId,
      source: 'tweak',
    });

    expect(imageStore.getChildCount(parent.imageId)).toBe(2);
    expect(imageStore.getChildCount('nonexistent')).toBe(0);
  });

  it('throws when parentImageId does not exist', () => {
    expect(() =>
      imageStore.store({
        basePrompt: 'orphan child',
        parentImageId: 'no-such-parent',
        source: 'generate',
      })
    ).toThrow(/not found/i);
  });
});
