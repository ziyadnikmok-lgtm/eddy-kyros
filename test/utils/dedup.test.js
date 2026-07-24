import { describe, it, expect } from 'vitest';

const { dedupRequest } = require('../../server/utils/dedup');

describe('dedupRequest', () => {
  it('deduplicates concurrent calls with same key', async () => {
    let callCount = 0;
    const fn = () => new Promise((resolve) => {
      callCount++;
      setTimeout(() => resolve('result'), 10);
    });

    const [a, b] = await Promise.all([
      dedupRequest('key1', fn),
      dedupRequest('key1', fn),
    ]);

    expect(callCount).toBe(1);
    expect(a).toBe('result');
    expect(b).toBe('result');
  });

  it('allows new call after previous completes', async () => {
    let callCount = 0;
    const fn = () => new Promise((resolve) => {
      callCount++;
      setTimeout(() => resolve(callCount), 10);
    });

    const first = await dedupRequest('key2', fn);
    const second = await dedupRequest('key2', fn);

    expect(callCount).toBe(2);
    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it('keeps different keys independent', async () => {
    let callCount = 0;
    const fn = () => new Promise((resolve) => {
      callCount++;
      setTimeout(() => resolve('ok'), 10);
    });

    await Promise.all([
      dedupRequest('a', fn),
      dedupRequest('b', fn),
    ]);

    expect(callCount).toBe(2);
  });
});
