import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { asText, atomicWriteJSON } = require('../../server/utils/helpers');

describe('asText', () => {
  it('trims strings', () => {
    expect(asText('  hello  ')).toBe('hello');
  });

  it('converts numbers to string', () => {
    expect(asText(42)).toBe('42');
  });

  it('converts booleans to string', () => {
    expect(asText(true)).toBe('true');
    expect(asText(false)).toBe('false');
  });

  it('returns empty string for null/undefined/objects', () => {
    expect(asText(null)).toBe('');
    expect(asText(undefined)).toBe('');
    expect(asText({ a: 1 })).toBe('');
    expect(asText([])).toBe('');
  });
});

describe('atomicWriteJSON', () => {
  const tmpDir = path.join(os.tmpdir(), 'helpers-test-' + Date.now());
  const testFile = path.join(tmpDir, 'test.json');

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes JSON to file atomically', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const data = { key: 'value', num: 123 };
    atomicWriteJSON(testFile, data);
    const result = JSON.parse(fs.readFileSync(testFile, 'utf8'));
    expect(result).toEqual(data);
  });

  it('overwrites existing file', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    atomicWriteJSON(testFile, { old: true });
    atomicWriteJSON(testFile, { new: true });
    const result = JSON.parse(fs.readFileSync(testFile, 'utf8'));
    expect(result).toEqual({ new: true });
  });
});
