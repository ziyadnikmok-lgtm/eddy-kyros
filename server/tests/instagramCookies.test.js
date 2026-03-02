import { describe, it, expect, beforeEach } from 'vitest';
const { buildLoginCookies } = require('../utils/instagramCookies');

describe('buildLoginCookies (explicit sessionid)', () => {
  beforeEach(() => {
    delete process.env.INSTAGRAM_SESSIONID;
  });

  it('returns cookie array when explicit sessionid is provided', () => {
    const result = buildLoginCookies('abc123');
    expect(result).toEqual([
      {
        name: 'sessionid',
        value: 'abc123',
        domain: '.instagram.com',
        path: '/',
        secure: true,
        httpOnly: true,
      },
    ]);
  });

  it('cookie has correct Instagram domain properties', () => {
    const result = buildLoginCookies('sess-xyz');
    const cookie = result[0];
    expect(cookie.domain).toBe('.instagram.com');
    expect(cookie.path).toBe('/');
    expect(cookie.secure).toBe(true);
    expect(cookie.httpOnly).toBe(true);
  });

  it('trims whitespace from explicit sessionid', () => {
    const result = buildLoginCookies('  spaced  ');
    expect(result[0].value).toBe('spaced');
  });

  it('returns null for whitespace-only explicit sessionid', () => {
    expect(buildLoginCookies('   ')).toBeNull();
  });

  it('returns null for empty string sessionid', () => {
    expect(buildLoginCookies('')).toBeNull();
  });

  it('converts number sessionid to string', () => {
    const result = buildLoginCookies(12345);
    expect(result[0].value).toBe('12345');
  });
});
