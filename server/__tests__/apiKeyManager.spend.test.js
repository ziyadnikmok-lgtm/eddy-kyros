/**
 * Spend tracking unit tests for ApiKeyManager.
 *
 * Because the production module exports a singleton, each test suite
 * isolates itself by resetting the module registry via vi.resetModules()
 * and pointing DATA_DIR at a fresh temp directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let manager; // ApiKeyManager singleton for the current test

/** Create a fresh ApiKeyManager backed by a throw-away temp directory. */
function createManager() {
  vi.resetModules();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-test-'));

  // Stub ../paths so DATA_DIR points to our temp folder
  vi.doMock('../paths', () => ({ DATA_DIR: tmpDir }));

  // Stub ../utils/logger to silence console noise during tests
  vi.doMock('../utils/logger', () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }));

  // Ensure encryption secret is available
  process.env.ENCRYPTION_SECRET = 'test-encryption-secret-that-is-at-least-32-chars-long!!';

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../services/apiKeyManager');
  return mod;
}

/** Add a key and make it active, returning the entry id. */
function addActiveKey(mgr, name = 'test-key') {
  const result = mgr.addKey(name, 'AIzaSyFAKEKEY_1234567890');
  mgr.setActiveKey(result.id);
  return result.id;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('ApiKeyManager — Spend Tracking', () => {
  beforeEach(() => {
    manager = createManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up temp directory
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. addTextSpend
  // =========================================================================
  describe('addTextSpend', () => {
    it('calculates cost for 1000 prompt + 500 output tokens', () => {
      addActiveKey(manager);
      const cost = manager.addTextSpend(1000, 500);
      const expected = (1000 / 1_000_000) * 0.50 + (500 / 1_000_000) * 3.00;
      expect(cost).toBeCloseTo(expected, 10);
    });

    it('returns 0 for 0 tokens', () => {
      addActiveKey(manager);
      const cost = manager.addTextSpend(0, 0);
      expect(cost).toBe(0);
    });

    it('handles large token counts (1M input + 1M output)', () => {
      addActiveKey(manager);
      const cost = manager.addTextSpend(1_000_000, 1_000_000);
      const expected = (1_000_000 / 1_000_000) * 0.50 + (1_000_000 / 1_000_000) * 3.00;
      expect(cost).toBeCloseTo(expected, 10);
      expect(cost).toBeCloseTo(3.50, 2);
    });

    it('accumulates totalSpendUsd across multiple calls', () => {
      addActiveKey(manager);
      const c1 = manager.addTextSpend(1000, 500);
      const c2 = manager.addTextSpend(2000, 1000);
      const info = manager.getSpendInfo();
      expect(info.totalSpendUsd).toBeCloseTo(c1 + c2, 10);
      expect(info.textCallCount).toBe(2);
    });

    it('increments textCallCount by 1 per call', () => {
      addActiveKey(manager);
      manager.addTextSpend(100, 50);
      manager.addTextSpend(200, 100);
      manager.addTextSpend(300, 150);
      expect(manager.getSpendInfo().textCallCount).toBe(3);
    });

    it('returns 0 when there is no active key', () => {
      // Ensure no keys / no active key
      manager._store.keys = [];
      manager._store.activeKeyId = null;
      const cost = manager.addTextSpend(1000, 500);
      expect(cost).toBe(0);
    });

    it('tracks per-character spend when characterId is provided', () => {
      addActiveKey(manager);
      manager.addTextSpend(1000, 500, 'char-abc');
      manager.addTextSpend(2000, 1000, 'char-abc');
      const info = manager.getSpendInfo();
      expect(info.characterSpend['char-abc']).toBeDefined();
      expect(info.characterSpend['char-abc'].textCalls).toBe(2);
      expect(info.characterSpend['char-abc'].textSpend).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 2. addImageSpend
  // =========================================================================
  describe('addImageSpend', () => {
    // --- Pro model ---
    describe('Pro model (gemini-3-pro-image-preview)', () => {
      const PRO = 'gemini-3-pro-image-preview';

      it('2K resolution — base cost $0.134 + token costs', () => {
        addActiveKey(manager);
        const promptTokens = 500;
        const outputTokens = 100;
        const cost = manager.addImageSpend(PRO, '2K', 0, promptTokens, outputTokens);
        const expected =
          0.134 +
          (promptTokens / 1_000_000) * 2.00 +
          (outputTokens / 1_000_000) * 12.00;
        expect(cost).toBeCloseTo(expected, 10);
      });

      it('4K resolution — base cost $0.24 + token costs', () => {
        addActiveKey(manager);
        const cost = manager.addImageSpend(PRO, '4K', 0, 500, 100);
        const expected =
          0.24 +
          (500 / 1_000_000) * 2.00 +
          (100 / 1_000_000) * 12.00;
        expect(cost).toBeCloseTo(expected, 10);
      });

      it('1K resolution — same price as 2K ($0.134)', () => {
        addActiveKey(manager);
        const cost = manager.addImageSpend(PRO, '1K', 0, 0, 0);
        expect(cost).toBeCloseTo(0.134, 10);
      });

      it('with reference images — adds $0.0011 per ref image', () => {
        addActiveKey(manager);
        const refCount = 3;
        const cost = manager.addImageSpend(PRO, '2K', refCount, 0, 0);
        const expected = 0.134 + refCount * 0.0011;
        expect(cost).toBeCloseTo(expected, 10);
      });

      it('with reference images and token costs combined', () => {
        addActiveKey(manager);
        const cost = manager.addImageSpend(PRO, '2K', 2, 1000, 200);
        const expected =
          0.134 +
          (1000 / 1_000_000) * 2.00 +
          (200 / 1_000_000) * 12.00 +
          2 * 0.0011;
        expect(cost).toBeCloseTo(expected, 10);
      });
    });

    // --- Flash model ---
    describe('Flash model (gemini-3.1-flash-image-preview)', () => {
      const FLASH = 'gemini-3.1-flash-image-preview';

      it('0.5K resolution — $0.045', () => {
        addActiveKey(manager);
        const cost = manager.addImageSpend(FLASH, '0.5K', 0, 0, 0);
        expect(cost).toBeCloseTo(0.045, 10);
      });

      it('1K resolution — $0.067', () => {
        addActiveKey(manager);
        const cost = manager.addImageSpend(FLASH, '1K', 0, 0, 0);
        expect(cost).toBeCloseTo(0.067, 10);
      });

      it('2K resolution — $0.101', () => {
        addActiveKey(manager);
        const cost = manager.addImageSpend(FLASH, '2K', 0, 0, 0);
        expect(cost).toBeCloseTo(0.101, 10);
      });

      it('4K resolution — $0.151', () => {
        addActiveKey(manager);
        const cost = manager.addImageSpend(FLASH, '4K', 0, 0, 0);
        expect(cost).toBeCloseTo(0.151, 10);
      });

      it('with token costs added on top', () => {
        addActiveKey(manager);
        const cost = manager.addImageSpend(FLASH, '2K', 0, 2000, 500);
        const expected =
          0.101 +
          (2000 / 1_000_000) * 0.50 +
          (500 / 1_000_000) * 3.00;
        expect(cost).toBeCloseTo(expected, 10);
      });

      it('reference images do not add cost for Flash model', () => {
        addActiveKey(manager);
        const costNoRef = manager.addImageSpend(FLASH, '2K', 0, 0, 0);
        // Reset to fresh key to avoid accumulation
        manager.resetSpend();
        const costWithRef = manager.addImageSpend(FLASH, '2K', 5, 0, 0);
        // Flash inputImageCost is 0, so both should be the same
        expect(costWithRef).toBeCloseTo(costNoRef, 10);
      });
    });

    it('increments imageCallCount by 1 per call', () => {
      addActiveKey(manager);
      manager.addImageSpend('gemini-3.1-flash-image-preview', '2K');
      manager.addImageSpend('gemini-3.1-flash-image-preview', '1K');
      expect(manager.getSpendInfo().imageCallCount).toBe(2);
    });

    it('returns 0 when there is no active key', () => {
      manager._store.keys = [];
      manager._store.activeKeyId = null;
      const cost = manager.addImageSpend('gemini-3-pro-image-preview', '2K');
      expect(cost).toBe(0);
    });

    it('defaults resolution to 2K when not provided', () => {
      addActiveKey(manager);
      // The default param is '2K'
      const cost = manager.addImageSpend('gemini-3.1-flash-image-preview');
      expect(cost).toBeCloseTo(0.101, 10);
    });

    it('tracks per-character spend for images', () => {
      addActiveKey(manager);
      manager.addImageSpend('gemini-3-pro-image-preview', '2K', 0, 0, 0, 'char-xyz');
      const info = manager.getSpendInfo();
      expect(info.characterSpend['char-xyz']).toBeDefined();
      expect(info.characterSpend['char-xyz'].imageCalls).toBe(1);
      expect(info.characterSpend['char-xyz'].imageSpend).toBeCloseTo(0.134, 3);
    });
  });

  // =========================================================================
  // 3. checkBudget
  // =========================================================================
  describe('checkBudget', () => {
    it('does not throw when spend is under budget', () => {
      addActiveKey(manager);
      manager.addTextSpend(1000, 500); // tiny amount
      expect(() => manager.checkBudget()).not.toThrow();
    });

    it('throws AppError with BUDGET_EXCEEDED when spend equals budget', () => {
      const keyId = addActiveKey(manager);
      // Directly set spend to match budget
      const entry = manager._store.keys.find((k) => k.id === keyId);
      entry.totalSpendUsd = 300;
      entry.spendBudgetUsd = 300;

      expect(() => manager.checkBudget()).toThrow();
      try {
        manager.checkBudget();
      } catch (err) {
        expect(err.code).toBe('BUDGET_EXCEEDED');
        expect(err.statusCode).toBe(402);
      }
    });

    it('throws AppError with BUDGET_EXCEEDED when spend exceeds budget', () => {
      const keyId = addActiveKey(manager);
      const entry = manager._store.keys.find((k) => k.id === keyId);
      entry.totalSpendUsd = 350;
      entry.spendBudgetUsd = 300;

      expect(() => manager.checkBudget()).toThrow();
      try {
        manager.checkBudget();
      } catch (err) {
        expect(err.code).toBe('BUDGET_EXCEEDED');
      }
    });

    it('returns silently when there is no active key', () => {
      manager._store.keys = [];
      manager._store.activeKeyId = null;
      expect(() => manager.checkBudget()).not.toThrow();
    });

    it('uses default budget of 300 when spendBudgetUsd is falsy', () => {
      const keyId = addActiveKey(manager);
      const entry = manager._store.keys.find((k) => k.id === keyId);
      entry.spendBudgetUsd = 0; // falsy
      entry.totalSpendUsd = 300;

      // Budget falls back to 300, spend is 300 => should throw
      expect(() => manager.checkBudget()).toThrow();
    });
  });

  // =========================================================================
  // 4. backfillFromGallery
  // =========================================================================
  describe('backfillFromGallery', () => {
    it('estimates correct spend for 100 images', () => {
      addActiveKey(manager);
      manager.backfillFromGallery(100);
      const info = manager.getSpendInfo();
      const expectedTextCalls = Math.round(100 * 0.5);
      const expectedSpend = 100 * 0.135 + expectedTextCalls * 0.002;
      expect(info.imageCallCount).toBe(100);
      expect(info.textCallCount).toBe(expectedTextCalls);
      expect(info.totalSpendUsd).toBeCloseTo(expectedSpend, 10);
    });

    it('is idempotent — second call is a no-op because imageCallCount > 0', () => {
      addActiveKey(manager);
      manager.backfillFromGallery(100);
      const spendAfterFirst = manager.getSpendInfo().totalSpendUsd;

      manager.backfillFromGallery(200); // should be skipped
      const spendAfterSecond = manager.getSpendInfo().totalSpendUsd;

      expect(spendAfterSecond).toBe(spendAfterFirst);
      expect(manager.getSpendInfo().imageCallCount).toBe(100); // still 100, not 200
    });

    it('is a no-op when totalSpendUsd > 0 (even with imageCallCount 0)', () => {
      const keyId = addActiveKey(manager);
      // Manually set some spend but no image calls
      const entry = manager._store.keys.find((k) => k.id === keyId);
      entry.totalSpendUsd = 5.0;
      entry.imageCallCount = 0;

      manager.backfillFromGallery(50);
      // Should not modify since totalSpendUsd > 0
      expect(manager.getSpendInfo().imageCallCount).toBe(0);
      expect(manager.getSpendInfo().totalSpendUsd).toBe(5.0);
    });

    it('is a no-op with 0 images', () => {
      addActiveKey(manager);
      manager.backfillFromGallery(0);
      expect(manager.getSpendInfo().imageCallCount).toBe(0);
      expect(manager.getSpendInfo().totalSpendUsd).toBe(0);
    });

    it('is a no-op with negative image count', () => {
      addActiveKey(manager);
      manager.backfillFromGallery(-5);
      expect(manager.getSpendInfo().imageCallCount).toBe(0);
    });

    it('is a no-op when there is no active key', () => {
      manager._store.keys = [];
      manager._store.activeKeyId = null;
      expect(() => manager.backfillFromGallery(100)).not.toThrow();
    });
  });

  // =========================================================================
  // 5. _migrateGlobalSpend
  // =========================================================================
  describe('_migrateGlobalSpend', () => {
    it('migrates global fields to the active key entry', () => {
      // Set up a store with global spend fields (pre-migration format)
      const keyId = addActiveKey(manager);

      // Simulate old global fields
      manager._store.totalSpendUsd = 42.5;
      manager._store.textCallCount = 100;
      manager._store.imageCallCount = 200;
      manager._store.spendBudgetUsd = 500;

      // Reset the active entry spend so migration can proceed
      const entry = manager._store.keys.find((k) => k.id === keyId);
      entry.totalSpendUsd = 0;

      manager._migrateGlobalSpend();

      expect(entry.totalSpendUsd).toBe(42.5);
      expect(entry.textCallCount).toBe(100);
      expect(entry.imageCallCount).toBe(200);
      expect(entry.spendBudgetUsd).toBe(500);
    });

    it('deletes global fields after migration', () => {
      addActiveKey(manager);

      manager._store.totalSpendUsd = 10;
      manager._store.textCallCount = 5;
      manager._store.imageCallCount = 3;
      manager._store.spendBudgetUsd = 300;

      // Reset entry spend to allow migration
      const entry = manager._store.keys.find((k) => k.id === manager._store.activeKeyId);
      entry.totalSpendUsd = 0;

      manager._migrateGlobalSpend();

      expect(manager._store.totalSpendUsd).toBeUndefined();
      expect(manager._store.textCallCount).toBeUndefined();
      expect(manager._store.imageCallCount).toBeUndefined();
      expect(manager._store.spendBudgetUsd).toBeUndefined();
    });

    it('is a no-op if no global spend fields exist', () => {
      const keyId = addActiveKey(manager);
      const entry = manager._store.keys.find((k) => k.id === keyId);
      const spendBefore = entry.totalSpendUsd;

      // No global fields set — migration should do nothing
      manager._migrateGlobalSpend();

      expect(entry.totalSpendUsd).toBe(spendBefore);
    });

    it('does not overwrite existing per-key spend (entry.totalSpendUsd > 0)', () => {
      const keyId = addActiveKey(manager);
      const entry = manager._store.keys.find((k) => k.id === keyId);
      entry.totalSpendUsd = 99;

      // Set global fields
      manager._store.totalSpendUsd = 42.5;

      manager._migrateGlobalSpend();

      // Entry should keep its original spend because entry.totalSpendUsd > 0
      expect(entry.totalSpendUsd).toBe(99);
      // But global fields should still be deleted
      expect(manager._store.totalSpendUsd).toBeUndefined();
    });

    it('ensures all keys have spend fields after migration', () => {
      // Add a key without spend fields
      const result = manager.addKey('bare-key', 'AIzaSyFAKEKEY_BARE_000000');
      const entry = manager._store.keys.find((k) => k.id === result.id);

      // Manually remove spend fields to simulate old data
      delete entry.totalSpendUsd;
      delete entry.spendBudgetUsd;
      delete entry.textCallCount;
      delete entry.imageCallCount;
      delete entry.spendLog;
      delete entry.characterSpend;

      manager._migrateGlobalSpend();

      expect(entry.totalSpendUsd).toBe(0);
      expect(entry.spendBudgetUsd).toBe(300);
      expect(entry.textCallCount).toBe(0);
      expect(entry.imageCallCount).toBe(0);
      expect(Array.isArray(entry.spendLog)).toBe(true);
      expect(typeof entry.characterSpend).toBe('object');
    });
  });

  // =========================================================================
  // 6. resetSpend
  // =========================================================================
  describe('resetSpend', () => {
    it('zeros totalSpendUsd, textCallCount, and imageCallCount', () => {
      addActiveKey(manager);
      manager.addTextSpend(10000, 5000);
      manager.addImageSpend('gemini-3-pro-image-preview', '2K', 0, 500, 100);

      // Verify non-zero before reset
      const before = manager.getSpendInfo();
      expect(before.totalSpendUsd).toBeGreaterThan(0);
      expect(before.textCallCount).toBe(1);
      expect(before.imageCallCount).toBe(1);

      const result = manager.resetSpend();

      expect(result.totalSpendUsd).toBe(0);
      expect(result.textCallCount).toBe(0);
      expect(result.imageCallCount).toBe(0);
    });

    it('returns updated spend info with zeros', () => {
      addActiveKey(manager);
      manager.addTextSpend(5000, 2000);

      const result = manager.resetSpend();

      expect(result).toHaveProperty('totalSpendUsd', 0);
      expect(result).toHaveProperty('textCallCount', 0);
      expect(result).toHaveProperty('imageCallCount', 0);
      expect(result).toHaveProperty('remainingUsd');
      expect(result.remainingUsd).toBe(result.spendBudgetUsd);
    });

    it('works gracefully when there is no active key', () => {
      manager._store.keys = [];
      manager._store.activeKeyId = null;
      const result = manager.resetSpend();
      expect(result.totalSpendUsd).toBe(0);
    });
  });

  // =========================================================================
  // 7. Daily spend log
  // =========================================================================
  describe('Daily spend log (_appendSpendLog)', () => {
    it('addTextSpend appends to spendLog', () => {
      addActiveKey(manager);
      manager.addTextSpend(1000, 500);
      const log = manager.getSpendLog();
      expect(log.length).toBe(1);
      expect(log[0]).toHaveProperty('date');
      expect(log[0].textCalls).toBe(1);
      expect(log[0].textSpend).toBeGreaterThan(0);
    });

    it('multiple calls on same day aggregate into one entry', () => {
      addActiveKey(manager);
      manager.addTextSpend(1000, 500);
      manager.addTextSpend(2000, 1000);
      manager.addImageSpend('gemini-3.1-flash-image-preview', '2K');

      const log = manager.getSpendLog();
      // All calls today — should be a single date entry
      expect(log.length).toBe(1);
      expect(log[0].textCalls).toBe(2);
      expect(log[0].imageCalls).toBe(1);
    });

    it('addImageSpend records imageSpend and imageCalls in log', () => {
      addActiveKey(manager);
      manager.addImageSpend('gemini-3-pro-image-preview', '2K', 0, 0, 0);
      const log = manager.getSpendLog();
      expect(log[0].imageCalls).toBe(1);
      expect(log[0].imageSpend).toBeCloseTo(0.134, 3);
    });

    it('90-day cap: entries older than 90 days are pruned', () => {
      const keyId = addActiveKey(manager);
      const entry = manager._store.keys.find((k) => k.id === keyId);

      // Manually insert an old entry (100 days ago)
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      entry.spendLog = [
        { date: oldDate, textSpend: 1.0, imageSpend: 0, textCalls: 10, imageCalls: 0 },
      ];

      // Now add a new spend, which triggers _appendSpendLog and pruning
      manager.addTextSpend(1000, 500);

      const log = manager.getSpendLog();
      // Old entry should be pruned
      expect(log.find((e) => e.date === oldDate)).toBeUndefined();
      // Only today's entry should remain
      expect(log.length).toBe(1);
    });

    it('entries within 90 days are preserved', () => {
      const keyId = addActiveKey(manager);
      const entry = manager._store.keys.find((k) => k.id === keyId);

      // Insert an entry from 30 days ago (within window)
      const recentDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      entry.spendLog = [
        { date: recentDate, textSpend: 1.0, imageSpend: 0, textCalls: 5, imageCalls: 0 },
      ];

      manager.addTextSpend(1000, 500);

      const log = manager.getSpendLog();
      expect(log.find((e) => e.date === recentDate)).toBeDefined();
      expect(log.length).toBe(2); // old + today
    });
  });

  // =========================================================================
  // 8. getSpendInfo
  // =========================================================================
  describe('getSpendInfo', () => {
    it('returns correct remainingUsd', () => {
      const keyId = addActiveKey(manager);
      const entry = manager._store.keys.find((k) => k.id === keyId);
      entry.spendBudgetUsd = 100;
      entry.totalSpendUsd = 30;

      const info = manager.getSpendInfo();
      expect(info.remainingUsd).toBeCloseTo(70, 10);
    });

    it('remainingUsd never goes below 0', () => {
      const keyId = addActiveKey(manager);
      const entry = manager._store.keys.find((k) => k.id === keyId);
      entry.spendBudgetUsd = 100;
      entry.totalSpendUsd = 150;

      const info = manager.getSpendInfo();
      expect(info.remainingUsd).toBe(0);
    });

    it('returns default values when no active key', () => {
      manager._store.keys = [];
      manager._store.activeKeyId = null;
      const info = manager.getSpendInfo();
      expect(info.totalSpendUsd).toBe(0);
      expect(info.spendBudgetUsd).toBe(300);
      expect(info.textCallCount).toBe(0);
      expect(info.imageCallCount).toBe(0);
      expect(info.remainingUsd).toBe(300);
      expect(info.spendLog).toEqual([]);
      expect(info.characterSpend).toEqual({});
      expect(info.topCharacters).toEqual([]);
    });

    it('topCharacters is sorted by total spend descending', () => {
      addActiveKey(manager);
      // Add a cheap character
      manager.addTextSpend(1000, 500, 'cheap-char');
      // Add an expensive character (many image calls)
      manager.addImageSpend('gemini-3-pro-image-preview', '4K', 0, 0, 0, 'expensive-char');
      manager.addImageSpend('gemini-3-pro-image-preview', '4K', 0, 0, 0, 'expensive-char');

      const info = manager.getSpendInfo();
      expect(info.topCharacters.length).toBe(2);
      expect(info.topCharacters[0].characterId).toBe('expensive-char');
      expect(info.topCharacters[0].totalSpend).toBeGreaterThan(info.topCharacters[1].totalSpend);
    });
  });

  // =========================================================================
  // 9. addExternalSpend
  // =========================================================================
  describe('addExternalSpend', () => {
    it('adds the exact cost to totalSpendUsd', () => {
      addActiveKey(manager);
      const cost = manager.addExternalSpend(0.42, 'video');
      expect(cost).toBe(0.42);
      expect(manager.getSpendInfo().totalSpendUsd).toBeCloseTo(0.42, 10);
    });

    it('increments imageCallCount by 1', () => {
      addActiveKey(manager);
      manager.addExternalSpend(0.21, 'video');
      manager.addExternalSpend(0.01, 'nsfw-image');
      expect(manager.getSpendInfo().imageCallCount).toBe(2);
    });

    it('returns 0 when there is no active key', () => {
      manager._store.keys = [];
      manager._store.activeKeyId = null;
      const cost = manager.addExternalSpend(0.50, 'video');
      expect(cost).toBe(0);
    });

    it('returns 0 for zero cost', () => {
      addActiveKey(manager);
      const cost = manager.addExternalSpend(0, 'video');
      expect(cost).toBe(0);
      expect(manager.getSpendInfo().totalSpendUsd).toBe(0);
    });

    it('returns 0 for negative cost', () => {
      addActiveKey(manager);
      const cost = manager.addExternalSpend(-5, 'video');
      expect(cost).toBe(0);
      expect(manager.getSpendInfo().totalSpendUsd).toBe(0);
    });

    it('tracks per-character spend when characterId is provided', () => {
      addActiveKey(manager);
      manager.addExternalSpend(0.35, 'video', 'char-vid');
      manager.addExternalSpend(0.01, 'nsfw-image', 'char-vid');
      const info = manager.getSpendInfo();
      expect(info.characterSpend['char-vid']).toBeDefined();
      expect(info.characterSpend['char-vid'].imageCalls).toBe(2);
      expect(info.characterSpend['char-vid'].imageSpend).toBeCloseTo(0.36, 10);
    });

    it('appends to daily spend log', () => {
      addActiveKey(manager);
      manager.addExternalSpend(0.21, 'video');
      const log = manager.getSpendLog();
      expect(log.length).toBe(1);
      expect(log[0].imageCalls).toBe(1);
      expect(log[0].imageSpend).toBeCloseTo(0.21, 10);
    });
  });

  // =========================================================================
  // 10. Persistence — data survives save/reload
  // =========================================================================
  describe('Persistence', () => {
    it('spend data persists after save and reload', () => {
      addActiveKey(manager);
      manager.addTextSpend(5000, 2000);
      manager.addImageSpend('gemini-3-pro-image-preview', '2K');
      const infoBefore = manager.getSpendInfo();

      // Reload the store from disk
      manager._store = manager._loadStore();
      manager._migrateGlobalSpend();
      const infoAfter = manager.getSpendInfo();

      expect(infoAfter.totalSpendUsd).toBeCloseTo(infoBefore.totalSpendUsd, 10);
      expect(infoAfter.textCallCount).toBe(infoBefore.textCallCount);
      expect(infoAfter.imageCallCount).toBe(infoBefore.imageCallCount);
    });
  });
});
