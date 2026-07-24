import { describe, it, expect } from 'vitest';
const { asText } = require('../utils/helpers');

describe('asText', () => {
  it('trims string input', () => {
    expect(asText('  hello  ')).toBe('hello');
  });

  it('returns empty string for undefined', () => {
    expect(asText(undefined)).toBe('');
  });

  it('returns empty string for null', () => {
    expect(asText(null)).toBe('');
  });

  it('converts number to string', () => {
    expect(asText(42)).toBe('42');
  });

  it('converts boolean to string', () => {
    expect(asText(true)).toBe('true');
    expect(asText(false)).toBe('false');
  });

  it('returns empty string for object', () => {
    expect(asText({ foo: 'bar' })).toBe('');
  });

  it('returns empty string for array', () => {
    expect(asText([1, 2])).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(asText('')).toBe('');
    expect(asText('   ')).toBe('');
  });
});
