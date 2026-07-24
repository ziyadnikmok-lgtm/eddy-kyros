import { describe, it, expect } from 'vitest';

const muapi = require('../services/muapiService');

describe('muapiService', () => {
  describe('extForMime — regression: an mp4 must never be named .png', () => {
    // uploadBase64 originally derived the extension from an image-only ternary, so EVERY
    // video upload landed as "<uuid>.png". Muapi keys off the filename, so reference videos
    // would have been rejected/misread. These lock that fix in.
    it('maps video mime types to real video extensions', () => {
      expect(muapi.extForMime('video/mp4')).toBe('.mp4');
      expect(muapi.extForMime('video/quicktime')).toBe('.mov');
      expect(muapi.extForMime('video/webm')).toBe('.webm');
    });

    it('maps audio mime types', () => {
      expect(muapi.extForMime('audio/mpeg')).toBe('.mp3');
      expect(muapi.extForMime('audio/wav')).toBe('.wav');
    });

    it('still maps image mime types', () => {
      expect(muapi.extForMime('image/jpeg')).toBe('.jpg');
      expect(muapi.extForMime('image/webp')).toBe('.webp');
      expect(muapi.extForMime('image/png')).toBe('.png');
    });

    it('defaults to .png only when the type is unknown', () => {
      expect(muapi.extForMime('application/octet-stream')).toBe('.png');
      expect(muapi.extForMime()).toBe('.png');
    });
  });

  describe('extractErrorMessage', () => {
    it('reads the nested error.message shape', () => {
      expect(muapi.extractErrorMessage('{"error":{"message":"Insufficient credit balance"}}'))
        .toBe('Insufficient credit balance');
    });

    it('reads the plain detail string shape', () => {
      expect(muapi.extractErrorMessage('{"detail":"Request ID not found"}'))
        .toBe('Request ID not found');
    });

    it('flattens FastAPI validation arrays instead of printing [object Object]', () => {
      const body = JSON.stringify({ detail: [{ msg: 'URL should have at most 2083 characters' }] });
      expect(muapi.extractErrorMessage(body)).toBe('URL should have at most 2083 characters');
    });

    it('passes non-JSON through untouched', () => {
      expect(muapi.extractErrorMessage('502 Bad Gateway')).toBe('502 Bad Gateway');
    });
  });

  describe('OMNI_MODELS — prices come from Muapi\'s published rates', () => {
    it('exposes every omni variant with a real per-second price', () => {
      for (const [id, m] of Object.entries(muapi.OMNI_MODELS)) {
        expect(m.slug, `${id} needs a slug`).toBeTruthy();
        expect(m.pricePerSecond, `${id} needs a price`).toBeGreaterThan(0);
      }
    });

    it('matches the published rate card', () => {
      expect(muapi.OMNI_MODELS['omni-fast'].pricePerSecond).toBe(0.21);
      expect(muapi.OMNI_MODELS['omni-best'].pricePerSecond).toBe(0.30);
      expect(muapi.OMNI_MODELS['omni-4k'].pricePerSecond).toBe(1.35);
      expect(muapi.OMNI_TRAIN_COST).toBe(0.50);
    });

    it('only the "best" variant exposes a quality toggle (per the OpenAPI schema)', () => {
      expect(muapi.OMNI_MODELS['omni-best'].quality).toBe(true);
      expect(muapi.OMNI_MODELS['omni-fast'].quality).toBe(false);
      expect(muapi.OMNI_MODELS['omni-4k'].quality).toBe(false);
    });

    it('respects Muapi\'s reference caps', () => {
      expect(muapi.OMNI_MAX_VIDEOS).toBe(3);
      expect(muapi.OMNI_MAX_IMAGES).toBe(9);
    });
  });

  describe('input validation happens before any network call', () => {
    it('rejects an unknown omni model', async () => {
      await expect(muapi.createOmniTask('nope', { prompt: 'hi' })).rejects.toThrow(/Unknown Omni model/i);
    });

    it('rejects an empty prompt', async () => {
      await expect(muapi.createOmniTask('omni-fast', { prompt: '  ' })).rejects.toThrow(/prompt is required/i);
    });

    it('rejects more than 3 reference videos', async () => {
      const videos = Array.from({ length: 4 }, () => ({ base64: 'x', mimeType: 'video/mp4' }));
      await expect(muapi.createOmniTask('omni-fast', { prompt: 'go', videos }))
        .rejects.toThrow(/Maximum 3 reference videos/i);
    });

    it('rejects more than 9 reference images', async () => {
      const images = Array.from({ length: 10 }, () => ({ base64: 'x', mimeType: 'image/png' }));
      await expect(muapi.createOmniTask('omni-fast', { prompt: 'go', images }))
        .rejects.toThrow(/Maximum 9 reference images/i);
    });

    it('requires a name and a photo to train a character', async () => {
      await expect(muapi.trainOmniCharacter({ characterName: 'Sienna' })).rejects.toThrow(/photo is required/i);
      await expect(muapi.trainOmniCharacter({ imageBase64: 'x', characterName: ' ' })).rejects.toThrow(/name is required/i);
    });
  });

  describe('generateSeedreamEdit validation', () => {
    it('requires a prompt', async () => {
      await expect(muapi.generateSeedreamEdit([{ base64: 'x', mimeType: 'image/png' }], ''))
        .rejects.toThrow(/prompt is required/i);
    });

    it('requires at least one image', async () => {
      await expect(muapi.generateSeedreamEdit([], 'make it blue')).rejects.toThrow(/at least one source image/i);
    });

    it('rejects more than 10 images (Seedream\'s images_list cap)', async () => {
      const imgs = Array.from({ length: 11 }, () => ({ base64: 'x', mimeType: 'image/png' }));
      await expect(muapi.generateSeedreamEdit(imgs, 'go')).rejects.toThrow(/Maximum 10 images/i);
    });
  });
});
