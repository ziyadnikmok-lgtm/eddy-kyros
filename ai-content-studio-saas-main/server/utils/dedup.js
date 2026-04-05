const _inflight = new Map();

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
