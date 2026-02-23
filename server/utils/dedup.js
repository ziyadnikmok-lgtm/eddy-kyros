// server/utils/dedup.js
// Request deduplication — returns the same promise for identical concurrent
// requests, preventing duplicate work (e.g. double-click Gemini calls).

const _inflight = new Map();

/**
 * Run `fn()` once per unique `key`. Concurrent callers with the same key
 * get the same promise back. The entry is cleaned up on settle.
 */
function dedupRequest(key, fn) {
  const existing = _inflight.get(key);
  if (existing) return existing;

  const promise = fn().finally(() => {
    _inflight.delete(key);
  });

  _inflight.set(key, promise);
  return promise;
}

module.exports = { dedupRequest };
