import { describe, it, expect } from 'vitest';
const geminiService = require('../services/geminiService');
const { AppError } = require('../middleware/errorHandler');

describe('GeminiService', () => {
  describe('generateText validation', () => {
    it('throws on missing API key', async () => {
      await expect(geminiService.generateText('', 'test')).rejects.toThrow(/API key/i);
    });

    it('throws on null API key', async () => {
      await expect(geminiService.generateText(null, 'test')).rejects.toThrow(/API key/i);
    });

    it('throws on empty prompt', async () => {
      await expect(geminiService.generateText('key', '')).rejects.toThrow(/prompt/i);
    });

    it('throws on whitespace-only prompt', async () => {
      await expect(geminiService.generateText('key', '   ')).rejects.toThrow(/prompt/i);
    });

    it('throws on prompt exceeding 15k length limit', async () => {
      const longPrompt = 'x'.repeat(16000);
      await expect(geminiService.generateText('key', longPrompt)).rejects.toThrow(/15,000/);
    });
  });

  describe('generateImage validation', () => {
    it('throws on missing API key', async () => {
      await expect(geminiService.generateImage('', 'test')).rejects.toThrow(/API key/i);
    });

    it('throws on empty prompt', async () => {
      await expect(geminiService.generateImage('key', '')).rejects.toThrow(/prompt/i);
    });

    it('throws on prompt exceeding 15k length limit', async () => {
      const longPrompt = 'x'.repeat(16000);
      await expect(geminiService.generateImage('key', longPrompt)).rejects.toThrow(/15,000/);
    });
  });

  describe('analyzeImage validation', () => {
    it('throws on missing API key', async () => {
      await expect(geminiService.analyzeImage('', 'data', 'image/png')).rejects.toThrow(/API key/i);
    });

    it('throws on missing image data', async () => {
      await expect(geminiService.analyzeImage('key', '', 'image/png')).rejects.toThrow(/image/i);
    });
  });

  describe('analyzeImageWithPrompt validation', () => {
    it('throws on missing API key', async () => {
      await expect(
        geminiService.analyzeImageWithPrompt('', 'data', 'image/png', 'describe')
      ).rejects.toThrow(/API key/i);
    });

    it('throws on empty custom prompt', async () => {
      await expect(
        geminiService.analyzeImageWithPrompt('key', 'data', 'image/png', '')
      ).rejects.toThrow(/prompt/i);
    });
  });

  describe('_handleApiError mapping', () => {
    it('maps 401 to INVALID_API_KEY', () => {
      expect(() => geminiService._handleApiError(new Error('401 Unauthorized'))).toThrow();
      try {
        geminiService._handleApiError(new Error('401 Unauthorized'));
      } catch (err) {
        expect(err.code).toBe('INVALID_API_KEY');
        expect(err.statusCode).toBe(401);
      }
    });

    it('maps API_KEY_INVALID to INVALID_API_KEY', () => {
      try {
        geminiService._handleApiError(new Error('API_KEY_INVALID'));
      } catch (err) {
        expect(err.code).toBe('INVALID_API_KEY');
      }
    });

    it('maps 429 / RESOURCE_EXHAUSTED to RATE_LIMITED', () => {
      try {
        geminiService._handleApiError(new Error('429 RESOURCE_EXHAUSTED'));
      } catch (err) {
        expect(err.code).toBe('RATE_LIMITED');
        expect(err.statusCode).toBe(429);
      }
    });

    it('maps SAFETY to SAFETY_BLOCKED', () => {
      try {
        geminiService._handleApiError(new Error('SAFETY filter triggered'));
      } catch (err) {
        expect(err.code).toBe('SAFETY_BLOCKED');
      }
    });

    it('maps timeout errors to GEMINI_TIMEOUT', () => {
      try {
        geminiService._handleApiError(new Error('Timed out after 120000ms'));
      } catch (err) {
        expect(err.code).toBe('GEMINI_TIMEOUT');
      }
    });

    it('maps 503 to GEMINI_TRANSIENT', () => {
      try {
        geminiService._handleApiError(new Error('503 UNAVAILABLE'));
      } catch (err) {
        expect(err.code).toBe('GEMINI_TRANSIENT');
      }
    });

    it('maps unknown errors to GEMINI_ERROR', () => {
      try {
        geminiService._handleApiError(new Error('Something unexpected'));
      } catch (err) {
        expect(err.code).toBe('GEMINI_ERROR');
        expect(err.statusCode).toBe(502);
      }
    });
  });

  describe('_parseImageResponse', () => {
    it('parses image and text from response', () => {
      const result = geminiService._parseImageResponse({
        candidates: [{
          content: {
            parts: [
              { inlineData: { mimeType: 'image/png', data: 'abc' } },
              { text: 'Description' },
            ],
          },
        }],
      });

      expect(result.imageResult).toEqual({ mimeType: 'image/png', base64Data: 'abc' });
      expect(result.textResult).toBe('Description');
      expect(result.hasNoParts).toBe(false);
    });

    it('detects empty parts', () => {
      const result = geminiService._parseImageResponse({
        candidates: [{ content: { parts: [] } }],
      });
      expect(result.hasNoParts).toBe(true);
    });

    it('detects safety block', () => {
      const result = geminiService._parseImageResponse({
        promptFeedback: { blockReason: 'SAFETY' },
        candidates: [{ content: { parts: [] } }],
      });
      expect(result.blockReason).toBeTruthy();
    });

    it('detects SAFETY finish reason', () => {
      const result = geminiService._parseImageResponse({
        candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
      });
      expect(result.blockReason).toBeTruthy();
    });
  });

  describe('_buildRetryPrompt', () => {
    it('returns base prompt on attempt 1', () => {
      expect(geminiService._buildRetryPrompt('test prompt', 1)).toBe('test prompt');
    });

    it('adds output requirement on attempt 2', () => {
      const result = geminiService._buildRetryPrompt('test', 2);
      expect(result).toContain('test');
      expect(result).toContain('Output requirement');
    });

    it('adds stronger requirement on attempt 3', () => {
      const result = geminiService._buildRetryPrompt('test', 3);
      expect(result).toContain('photorealistic');
    });
  });

  describe('static properties', () => {
    it('exports IMAGE_MODEL constant', () => {
      expect(geminiService.constructor.IMAGE_MODEL).toBe('gemini-3-pro-image-preview');
    });

    it('exports TEXT_MODEL constant', () => {
      expect(geminiService.constructor.TEXT_MODEL).toBe('gemini-3-flash-preview');
    });
  });
});
