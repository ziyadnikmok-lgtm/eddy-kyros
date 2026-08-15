/**
 * Content-addressed store for the SOURCE images a queued job renders from.
 *
 * WHY THIS EXISTS. Job payloads used to carry their images as base64, and the payload is written to
 * SQLite. Eddy sends the same ~9.8 MB base photo with every combo in a run, so 27 queued jobs took
 * saas.db from 248 KB to 479 MB in ten minutes (2026-08-15). The database, its WAL, the renderer
 * and the server each held those bytes; the app hit 2.9 GB, the CPU pegged, and its own status
 * checks to WaveSpeed timed out at 30s. Nothing finished, and it looked like a network fault.
 *
 * With this, a pass uploads each DISTINCT image once and every job references it by hash. A
 * 48-image run stops sending 48 copies of one photo and sends one, so the payload in the row is a
 * few hundred bytes and 50 in flight is unremarkable rather than fatal.
 *
 * Content addressing is what makes it safe to share: the name IS the sha256 of the bytes, so two
 * jobs referencing one hash cannot disagree about what it holds, and re-uploading is a no-op.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { getDataDir } = require('../paths');
const log = require('../utils/logger');

// Long enough to outlive any queued render (the reconciler abandons a job well before this), short
// enough that a machine generating all day does not accumulate source images forever.
const TTL_MS = 24 * 60 * 60 * 1000;

function dir() {
  const d = path.join(getDataDir(), 'jobblobs');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

const isHash = (ref) => typeof ref === 'string' && /^[a-f0-9]{64}$/.test(ref);

/**
 * Store one image and return its hash. Storing the same bytes twice writes nothing the second time.
 */
function put(base64, mimeType) {
  const raw = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!raw) throw new Error('jobBlobs.put: empty image');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const file = path.join(dir(), `${hash}.json`);
  if (!fs.existsSync(file)) {
    // Written to a temp name and renamed, so a reader can never observe a half-written blob — the
    // failure mode would be a job rendering from a truncated image.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ mimeType: mimeType || 'image/png', base64: raw }));
    fs.renameSync(tmp, file);
  } else {
    // Touched so a blob still in use survives the sweep below.
    try { const t = new Date(); fs.utimesSync(file, t, t); } catch { /* not fatal */ }
  }
  return hash;
}

/** Read one back. Returns null rather than throwing — a caller decides what a missing source means. */
function get(ref) {
  if (!isHash(ref)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir(), `${ref}.json`), 'utf8'));
    return parsed?.base64 ? { base64: parsed.base64, mimeType: parsed.mimeType || 'image/png' } : null;
  } catch {
    return null;
  }
}

/**
 * Turn a payload's image list into what the provider needs.
 *
 * Accepts both shapes on purpose: { ref } for anything enqueued since this existed, and a plain
 * { base64 } for rows written before it. A ref that cannot be read throws by NAME, because
 * rendering a job with one of its source images silently missing produces a wrong picture that
 * still costs money — far worse than failing the job.
 */
function resolve(images) {
  return (Array.isArray(images) ? images : []).map((img, i) => {
    if (img?.base64) return img;
    if (img?.ref) {
      const hit = get(img.ref);
      if (!hit) throw new Error(`source image ${i + 1} (${String(img.ref).slice(0, 12)}…) is no longer available`);
      return hit;
    }
    throw new Error(`source image ${i + 1} has neither bytes nor a reference`);
  });
}

/** Drop blobs nothing has touched for TTL_MS. Called at boot; cheap because the directory is flat. */
function sweep() {
  let removed = 0;
  let bytes = 0;
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir())) {
      const file = path.join(dir(), name);
      try {
        const st = fs.statSync(file);
        if (now - st.mtimeMs > TTL_MS) { bytes += st.size; fs.unlinkSync(file); removed += 1; }
      } catch { /* raced with another sweep — fine */ }
    }
  } catch { /* directory missing is not an error */ }
  if (removed) log.info('job_blobs_swept', { removed, mb: Math.round(bytes / 1048576) });
  return removed;
}

module.exports = { put, get, resolve, sweep };
