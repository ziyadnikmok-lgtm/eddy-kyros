// server/tests/instagramAvailability.test.js
// Tests auth-aware cache key logic and cache hit/miss behavior.
// Integration tests (Apify API calls) are tested manually.

import { describe, it, expect, beforeEach } from 'vitest';
const availability = require('../services/instagramAvailabilityService');

describe('instagramAvailabilityService', () => {
  describe('_authFingerprint', () => {
    it('returns "anon" when both token and sessionid are falsy', () => {
      expect(availability._authFingerprint('', '')).toBe('anon');
      expect(availability._authFingerprint(null, null)).toBe('anon');
      expect(availability._authFingerprint(undefined, undefined)).toBe('anon');
    });

    it('returns 8-char hex for non-empty token', () => {
      const fp = availability._authFingerprint('my-token', '');
      expect(fp).toMatch(/^[a-f0-9]{8}$/);
    });

    it('produces different fingerprints for different tokens', () => {
      const fp1 = availability._authFingerprint('token-a', '');
      const fp2 = availability._authFingerprint('token-b', '');
      expect(fp1).not.toBe(fp2);
    });

    it('produces different fingerprints for different sessions', () => {
      const fp1 = availability._authFingerprint('same-token', 'session-a');
      const fp2 = availability._authFingerprint('same-token', 'session-b');
      expect(fp1).not.toBe(fp2);
    });

    it('is deterministic — same input produces same output', () => {
      const a = availability._authFingerprint('tok', 'sess');
      const b = availability._authFingerprint('tok', 'sess');
      expect(a).toBe(b);
    });

    it('does not contain raw token or session in fingerprint', () => {
      const fp = availability._authFingerprint('super-secret-api-key', 'my-session-id');
      expect(fp).not.toContain('super-secret');
      expect(fp).not.toContain('my-session');
      expect(fp.length).toBe(8);
    });
  });

  describe('_buildCacheKey', () => {
    it('includes URL and a pipe separator', () => {
      const key = availability._buildCacheKey('https://instagram.com/p/123', 'tok', 'sess');
      expect(key).toContain('https://instagram.com/p/123');
      expect(key).toContain('|');
    });

    it('does not contain raw token in cache key', () => {
      const key = availability._buildCacheKey('https://instagram.com/p/123', 'my-secret-token', '');
      expect(key).not.toContain('my-secret-token');
    });

    it('produces different keys for same URL but different auth', () => {
      const k1 = availability._buildCacheKey('https://instagram.com/p/123', 'tok-a', '');
      const k2 = availability._buildCacheKey('https://instagram.com/p/123', 'tok-b', '');
      expect(k1).not.toBe(k2);
    });

    it('produces same key for same URL and same auth', () => {
      const k1 = availability._buildCacheKey('https://instagram.com/p/123', 'tok', 'sess');
      const k2 = availability._buildCacheKey('https://instagram.com/p/123', 'tok', 'sess');
      expect(k1).toBe(k2);
    });

    it('produces different keys for different URLs with same auth', () => {
      const k1 = availability._buildCacheKey('https://instagram.com/p/111', 'tok', '');
      const k2 = availability._buildCacheKey('https://instagram.com/p/222', 'tok', '');
      expect(k1).not.toBe(k2);
    });
  });

  describe('cache get/set/clear cycle', () => {
    beforeEach(() => {
      availability._clearCache();
    });

    it('returns null for cache miss', () => {
      expect(availability._getCachedAvailability('nonexistent-key')).toBeNull();
    });

    it('stores and retrieves a cached result', () => {
      const result = { status: 'public', allowed: true };
      availability._setCachedAvailability('test-key', result);
      expect(availability._getCachedAvailability('test-key')).toEqual(result);
    });

    it('returns null for different key (auth-aware isolation)', () => {
      const key1 = availability._buildCacheKey('https://instagram.com/p/abc', 'token-a', '');
      const key2 = availability._buildCacheKey('https://instagram.com/p/abc', 'token-b', '');
      availability._setCachedAvailability(key1, { status: 'public', allowed: true });
      expect(availability._getCachedAvailability(key2)).toBeNull();
    });

    it('clearCache empties all entries', () => {
      availability._setCachedAvailability('k1', { status: 'public' });
      availability._setCachedAvailability('k2', { status: 'private' });
      availability._clearCache();
      expect(availability._getCachedAvailability('k1')).toBeNull();
      expect(availability._getCachedAvailability('k2')).toBeNull();
    });
  });
});
