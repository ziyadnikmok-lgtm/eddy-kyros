// server/tests/batchGenerator.test.js
// Tests validation and synchronous logic in BatchGenerator.
// Async execution tests (API calls, events) require extensive mocking of
// 12+ CJS singletons and are tested via integration/manual testing.

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Clean up persisted jobs file before loading the module to avoid stale state
const JOB_STORE_PATH = join(process.cwd(), 'data', 'batch-jobs.json');
beforeAll(() => {
  try { if (existsSync(JOB_STORE_PATH)) unlinkSync(JOB_STORE_PATH); } catch { /* cleanup best-effort */ }
});

const batchGenerator = require('../services/batchGenerator');

describe('BatchGenerator', () => {
  describe('mode validation', () => {
    it('rejects invalid mode', () => {
      expect(() => batchGenerator.startBatch('invalid', {})).toThrow(/mode/i);
    });

    it('rejects undefined mode', () => {
      expect(() => batchGenerator.startBatch(undefined, {})).toThrow(/mode/i);
    });

    it('accepts variation mode', () => {
      expect(() => batchGenerator._validateMode('variation')).not.toThrow();
    });

    it('accepts multi mode', () => {
      expect(() => batchGenerator._validateMode('multi')).not.toThrow();
    });

    it('accepts override mode', () => {
      expect(() => batchGenerator._validateMode('override')).not.toThrow();
    });

    it('accepts edit mode', () => {
      expect(() => batchGenerator._validateMode('edit')).not.toThrow();
    });
  });

  describe('count validation', () => {
    it('defaults to 1 when count is undefined', () => {
      expect(batchGenerator._validateCount(undefined)).toBe(1);
    });

    it('returns the count when valid', () => {
      expect(batchGenerator._validateCount(5)).toBe(5);
    });

    it('floors fractional counts', () => {
      expect(batchGenerator._validateCount(3.7)).toBe(3);
    });

    it('throws when count < 1', () => {
      expect(() => batchGenerator._validateCount(0)).toThrow(/at least 1/i);
    });

    it('throws when count exceeds MAX_BATCH_SIZE', () => {
      expect(() => batchGenerator._validateCount(100)).toThrow(/max/i);
    });
  });

  describe('variation task builder', () => {
    it('throws on empty prompt', () => {
      expect(() => batchGenerator._buildVariationTasks({ prompt: '' })).toThrow(/prompt/i);
    });

    it('throws on missing prompt', () => {
      expect(() => batchGenerator._buildVariationTasks({})).toThrow(/prompt/i);
    });

    it('builds correct number of tasks', () => {
      const tasks = batchGenerator._buildVariationTasks({ prompt: 'test', count: 3 });
      expect(tasks).toHaveLength(3);
      tasks.forEach((t, i) => {
        expect(t.index).toBe(i);
        expect(t.prompt).toBe('test');
      });
    });

    it('defaults count to 1', () => {
      const tasks = batchGenerator._buildVariationTasks({ prompt: 'test' });
      expect(tasks).toHaveLength(1);
    });

    it('applies seed randomization', () => {
      const tasks = batchGenerator._buildVariationTasks({
        prompt: 'test',
        count: 2,
        randomizeSeed: true,
      });
      tasks.forEach((t) => {
        expect(typeof t.seed).toBe('number');
        expect(t.seed).toBeGreaterThanOrEqual(0);
      });
    });

    it('applies temperature range', () => {
      const tasks = batchGenerator._buildVariationTasks({
        prompt: 'test',
        count: 5,
        temperatureRange: { min: 0.5, max: 1.5 },
      });
      tasks.forEach((t) => {
        expect(t.temperature).toBeGreaterThanOrEqual(0.5);
        expect(t.temperature).toBeLessThanOrEqual(1.5);
      });
    });
  });

  describe('multi task builder', () => {
    it('throws on missing prompts', () => {
      expect(() => batchGenerator._buildMultiTasks({})).toThrow(/prompts/i);
    });

    it('throws on empty prompts array', () => {
      expect(() => batchGenerator._buildMultiTasks({ prompts: [] })).toThrow(/prompts/i);
    });

    it('throws on empty string in prompts', () => {
      expect(() => batchGenerator._buildMultiTasks({ prompts: ['good', ''] })).toThrow(/empty/i);
    });

    it('builds one task per prompt', () => {
      const tasks = batchGenerator._buildMultiTasks({
        prompts: ['alpha', 'beta', 'gamma'],
      });
      expect(tasks).toHaveLength(3);
      expect(tasks[0].prompt).toBe('alpha');
      expect(tasks[1].prompt).toBe('beta');
      expect(tasks[2].prompt).toBe('gamma');
    });

    it('throws when prompts exceed MAX_BATCH_SIZE', () => {
      const prompts = Array.from({ length: 25 }, (_, i) => `prompt ${i}`);
      expect(() => batchGenerator._buildMultiTasks({ prompts })).toThrow(/max/i);
    });
  });

  describe('getJob', () => {
    it('throws for missing job ID', () => {
      expect(() => batchGenerator.getJob('')).toThrow();
    });

    it('throws for unknown job ID', () => {
      expect(() => batchGenerator.getJob('nonexistent-id')).toThrow(/not found/i);
    });
  });

  describe('cancelJob', () => {
    it('throws for missing job ID', () => {
      expect(() => batchGenerator.cancelJob('')).toThrow();
    });

    it('throws for unknown job ID', () => {
      expect(() => batchGenerator.cancelJob('nonexistent-id')).toThrow(/not found/i);
    });
  });

  describe('jobStats', () => {
    it('returns correct shape', () => {
      const stats = batchGenerator.jobStats();
      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('running');
      expect(stats).toHaveProperty('completed');
      expect(stats).toHaveProperty('failed');
      expect(stats).toHaveProperty('cancelled');
      expect(typeof stats.total).toBe('number');
    });
  });

  describe('_toSafeJob', () => {
    it('strips internal fields', () => {
      const job = {
        jobId: 'j1',
        mode: 'variation',
        status: 'completed',
        total: 2,
        completed: 2,
        failed: 0,
        results: [],
        createdAt: '2025-01-01',
        _cancelled: false,
        _completedAt: 123,
        _sharedBaseImage: { data: 'big' },
      };
      const safe = batchGenerator._toSafeJob(job);
      expect(safe.jobId).toBe('j1');
      expect(safe._cancelled).toBeUndefined();
      expect(safe._completedAt).toBeUndefined();
      expect(safe._sharedBaseImage).toBeUndefined();
    });
  });

  describe('reference image parsing', () => {
    it('returns null for empty value', () => {
      expect(batchGenerator._parseReferenceImagePayload(null)).toBeNull();
    });

    it('parses data URI', () => {
      const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
      const result = batchGenerator._parseReferenceImagePayload(dataUri);
      expect(result.mimeType).toBe('image/png');
      expect(result.base64Data).toBe('iVBORw0KGgo=');
    });

    it('parses object with image data URI', () => {
      const result = batchGenerator._parseReferenceImagePayload({
        image: 'data:image/jpeg;base64,abc123',
      });
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.base64Data).toBe('abc123');
    });

    it('throws for invalid string (not a data URI)', () => {
      expect(() =>
        batchGenerator._parseReferenceImagePayload('not-a-data-uri')
      ).toThrow(/data URI/i);
    });
  });

  describe('static constants', () => {
    it('exports MAX_CONCURRENCY', () => {
      expect(batchGenerator.constructor.MAX_CONCURRENCY).toBe(5);
    });

    it('exports MAX_BATCH_SIZE', () => {
      expect(batchGenerator.constructor.MAX_BATCH_SIZE).toBe(20);
    });
  });
});
