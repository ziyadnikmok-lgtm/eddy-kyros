// server/tests/promptBuilder.test.js
import { describe, it, expect } from 'vitest';
const promptBuilder = require('../services/promptBuilder');

describe('promptBuilder', () => {
  describe('buildPrompt', () => {
    it('throws when masterPrompt is missing', () => {
      expect(() => promptBuilder.buildPrompt({})).toThrow('Master prompt is required');
      expect(() => promptBuilder.buildPrompt({ masterPrompt: '' })).toThrow();
      expect(() => promptBuilder.buildPrompt({ masterPrompt: '   ' })).toThrow();
    });

    it('returns prompt with identity section for minimal input', () => {
      const result = promptBuilder.buildPrompt({ masterPrompt: 'Tall woman, green eyes' });
      expect(result).toContain('[CHARACTER IDENTITY');
      expect(result).toContain('Tall woman, green eyes');
      expect(result).toContain('[IDENTITY ENFORCEMENT]');
    });

    it('includes override section when activeReferences provided', () => {
      const result = promptBuilder.buildPrompt({
        masterPrompt: 'Tall woman, green eyes',
        activeReferences: [
          { category: 'Clothing', overridePrompt: 'Red dress' },
          { category: 'Hairstyle', overridePrompt: 'Long blonde hair' },
        ],
      });
      expect(result).toContain('[STYLE OVERRIDES');
      expect(result).toContain('Clothing: Red dress');
      expect(result).toContain('Hairstyle: Long blonde hair');
    });

    it('respects category order in overrides', () => {
      const result = promptBuilder.buildPrompt({
        masterPrompt: 'Identity text',
        activeReferences: [
          { category: 'Pose', overridePrompt: 'Standing' },
          { category: 'Expression', overridePrompt: 'Smiling' },
        ],
      });
      const expressionIdx = result.indexOf('Expression: Smiling');
      const poseIdx = result.indexOf('Pose: Standing');
      expect(expressionIdx).toBeLessThan(poseIdx);
    });

    it('includes user prompt in scene section', () => {
      const result = promptBuilder.buildPrompt({
        masterPrompt: 'Identity text',
        userPrompt: 'Beach sunset scene',
      });
      expect(result).toContain('[SCENE / GENERATION INSTRUCTIONS]');
      expect(result).toContain('Beach sunset scene');
    });

    it('skips override section when no valid references', () => {
      const result = promptBuilder.buildPrompt({
        masterPrompt: 'Identity',
        activeReferences: [{ category: '', overridePrompt: '' }],
      });
      expect(result).not.toContain('[STYLE OVERRIDES');
    });

    it('deduplicates overrides within same category', () => {
      const result = promptBuilder.buildPrompt({
        masterPrompt: 'Identity',
        activeReferences: [
          { category: 'Clothing', overridePrompt: 'Red dress' },
          { category: 'Clothing', overridePrompt: 'Red dress' },
        ],
      });
      const matches = result.match(/Red dress/g);
      expect(matches.length).toBe(1);
    });
  });

  describe('_normalize', () => {
    it('lowercases and strips punctuation', () => {
      expect(promptBuilder._normalize('Hello, World!')).toBe('hello world');
    });

    it('collapses whitespace', () => {
      expect(promptBuilder._normalize('  a   b  ')).toBe('a b');
    });
  });

  describe('_extractPhrases', () => {
    it('returns empty for short text', () => {
      expect(promptBuilder._extractPhrases('one two')).toEqual([]);
    });

    it('extracts sliding window phrases for 5+ word text', () => {
      const phrases = promptBuilder._extractPhrases('a b c d e f');
      expect(phrases.length).toBeGreaterThan(1);
      expect(phrases[0]).toBe('a b c d e f'); // full text
    });
  });

  describe('_deduplicatePrompts', () => {
    it('removes exact duplicate prompts', () => {
      const result = promptBuilder._deduplicatePrompts(['Red dress', 'Red dress', 'Blue top']);
      expect(result).toEqual(['Red dress', 'Blue top']);
    });

    it('preserves case in output even though comparison is normalized', () => {
      const result = promptBuilder._deduplicatePrompts(['Red Dress', 'red dress']);
      expect(result).toEqual(['Red Dress']);
    });
  });
});
