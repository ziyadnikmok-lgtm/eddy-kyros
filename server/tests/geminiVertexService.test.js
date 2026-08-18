import { describe, it, expect } from 'vitest';
const geminiVertexService = require('../services/geminiVertexService');
const { AppError } = require('../middleware/errorHandler');

describe('GeminiVertexService', () => {
  describe('resolveImageModel', () => {
    it('resolves default model when empty/missing', () => {
      expect(geminiVertexService.resolveImageModel('')).toBe('gemini-3-pro-image-preview');
      expect(geminiVertexService.resolveImageModel(null)).toBe('gemini-3-pro-image-preview');
    });

    // The id is `gemini-3.1-flash-image` with NO `-preview` suffix. The suffixed form is not a
    // Vertex model at all — see the note above IMAGE_MODEL_ALTERNATES. This test asserted the
    // suffixed one and had been red ever since the service was corrected.
    it('resolves experimental model to flash alternate', () => {
      expect(geminiVertexService.resolveImageModel('nano-bypass-experimental')).toBe('gemini-3.1-flash-image');
    });

    it('allows valid alternate model', () => {
      expect(geminiVertexService.resolveImageModel('gemini-3.1-flash-image')).toBe('gemini-3.1-flash-image');
    });

    it('throws on unsupported model', () => {
      expect(() => geminiVertexService.resolveImageModel('some-invalid-model')).toThrow(AppError);
    });
  });

  describe('_sanitizePromptForRetry', () => {
    it('swaps sensitive keywords', () => {
      const sanitized = geminiVertexService._sanitizePromptForRetry('a sexy bikini photo', 1);
      expect(sanitized).toBe('a stylish summer outfit photo');
    });

    it('applies editorial prefix on attempt 2+', () => {
      const sanitized = geminiVertexService._sanitizePromptForRetry('a sexy bikini photo', 2);
      expect(sanitized).toContain('Professional fashion photography editorial.');
      expect(sanitized).toContain('Style: tasteful, editorial');
    });
  });

  describe('_sanitizePartsForRetry', () => {
    it('sanitizes text parts in the parts array', () => {
      const parts = [
        { inlineData: { mimeType: 'image/png', data: 'abc' } },
        { text: 'a sexy bikini' }
      ];
      const sanitized = geminiVertexService._sanitizePartsForRetry(parts, 1);
      expect(sanitized[0].inlineData).toEqual({ mimeType: 'image/png', data: 'abc' });
      expect(sanitized[1].text).toBe('a stylish summer outfit');
    });
  });
});
