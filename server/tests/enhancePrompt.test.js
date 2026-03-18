import { describe, it, expect } from 'vitest';
const geminiService = require('../services/geminiService');

describe('GeminiService — enhancePrompt', () => {
  it('returns original prompt when input is too short (< 5 chars)', async () => {
    const result = await geminiService.enhancePrompt('fake-key', 'hi', {});
    expect(result).toBe('hi');
  });

  it('returns original prompt when input is empty', async () => {
    const result = await geminiService.enhancePrompt('fake-key', '', {});
    expect(result).toBe('');
  });

  it('returns original prompt when input is null', async () => {
    const result = await geminiService.enhancePrompt('fake-key', null, {});
    expect(result).toBeNull();
  });

  it('throws on missing API key for valid prompt', async () => {
    await expect(
      geminiService.enhancePrompt('', 'A beautiful beach scene with sunset', {})
    ).rejects.toThrow(/API key/i);
  });

  it('throws on null API key for valid prompt', async () => {
    await expect(
      geminiService.enhancePrompt(null, 'A beautiful beach scene with sunset', {})
    ).rejects.toThrow(/API key/i);
  });
});

describe('GeminiService — scoreImageQuality', () => {
  it('returns null when image data is missing', async () => {
    const result = await geminiService.scoreImageQuality('fake-key', '', 'image/png');
    expect(result).toBeNull();
  });

  it('returns null when mimeType is missing', async () => {
    const result = await geminiService.scoreImageQuality('fake-key', 'base64data', '');
    expect(result).toBeNull();
  });

  it('returns null when both are missing', async () => {
    const result = await geminiService.scoreImageQuality('fake-key', null, null);
    expect(result).toBeNull();
  });

  it('throws on missing API key with valid image data', async () => {
    await expect(
      geminiService.scoreImageQuality('', 'base64data', 'image/png')
    ).rejects.toThrow(/API key/i);
  });

  it('throws on null API key with valid image data', async () => {
    await expect(
      geminiService.scoreImageQuality(null, 'base64data', 'image/png')
    ).rejects.toThrow(/API key/i);
  });
});
