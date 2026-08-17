/**
 * A pool of face workers, so a big batch uses every core instead of one.
 *
 * THE NUMBERS THIS IS BUILT ON (benchmarked 2026-08-17 over 25 real photos, running the real
 * cascade at the real parameters): one photo costs ~945ms of sweep. On the main thread 500 photos
 * is ~8 minutes with the window frozen solid. Across six workers it is ~80 seconds, and the window
 * stays alive with a counter running.
 *
 * Sizing: hardwareConcurrency minus one, so the UI thread keeps a core to itself, capped at 8.
 * Beyond that the workers fight each other for cache and the wall-clock stops improving.
 *
 * Workers are created on first use and kept — construction costs a module load and a 240 KB cascade
 * unpack each, which is worth paying once rather than per batch.
 */
const MAX_WORKERS = 8;

let _pool = null;
let _broken = false;

function size() {
  const cores = Number(navigator?.hardwareConcurrency) || 4;
  return Math.max(2, Math.min(MAX_WORKERS, cores - 1));
}

function spawn() {
  if (_broken) return null;
  if (_pool) return _pool;
  try {
    const workers = Array.from({ length: size() }, () => {
      const w = new Worker(new URL('./faceWorker.js', import.meta.url), { type: 'module' });
      return { worker: w, busy: false };
    });
    _pool = { workers, queue: [], seq: 0, pending: new Map() };
    for (const slot of _pool.workers) {
      slot.worker.onmessage = (e) => {
        const { id } = e.data || {};
        const waiter = _pool.pending.get(id);
        _pool.pending.delete(id);
        slot.busy = false;
        waiter?.resolve(e.data);
        drain();
      };
      // A worker that dies takes its in-flight job with it; the caller falls back for that photo.
      slot.worker.onerror = () => {
        slot.busy = false;
        drain();
      };
    }
    return _pool;
  } catch {
    // No worker support (or a CSP that forbids one) — every caller falls back to the main thread.
    _broken = true;
    return null;
  }
}

function drain() {
  if (!_pool) return;
  for (const slot of _pool.workers) {
    if (slot.busy || !_pool.queue.length) continue;
    const task = _pool.queue.shift();
    slot.busy = true;
    _pool.pending.set(task.id, task);
    slot.worker.postMessage({ id: task.id, dataUrl: task.dataUrl, blur: task.blur });
  }
}

/** True when the work can actually go off-thread. Callers use it to decide whether to show progress. */
export function poolAvailable() {
  return !!spawn();
}

/** How many photos can genuinely be in flight at once. */
export function poolSize() {
  return spawn() ? _pool.workers.length : 1;
}

/**
 * Detect (and optionally blur) one photo on a worker.
 *
 * Resolves `null` when there is no pool or the worker failed, which means "do this one yourself" —
 * never a silently unprocessed photo.
 */
export function detectAndBlur(dataUrl, { blur = true, timeoutMs = 60000 } = {}) {
  const pool = spawn();
  if (!pool) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = (pool.seq += 1);
    // A wedged worker must not hang the whole batch behind it.
    const timer = setTimeout(() => {
      if (pool.pending.get(id)) { pool.pending.delete(id); resolve(null); }
    }, timeoutMs);
    pool.queue.push({
      id,
      dataUrl,
      blur,
      resolve: (msg) => { clearTimeout(timer); resolve(msg?.ok ? msg : null); },
    });
    drain();
  });
}

/**
 * Run a whole batch, reporting progress as each photo lands.
 *
 * `onEach(result, index)` is called per photo in completion order; `fallback(dataUrl, index)` runs
 * on the main thread for anything the pool could not do. Results come back in the ORIGINAL order.
 */
export async function runBatch(dataUrls, { blur = true, onProgress, fallback } = {}) {
  const out = new Array(dataUrls.length);
  let done = 0;
  await Promise.all(dataUrls.map(async (url, i) => {
    let res = await detectAndBlur(url, { blur });
    if (!res && fallback) res = await fallback(url, i);
    out[i] = res;
    done += 1;
    onProgress?.(done, dataUrls.length);
  }));
  return out;
}
