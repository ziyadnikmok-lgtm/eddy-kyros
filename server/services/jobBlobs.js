/**
 * The images a queued job is waiting to send, kept OUT of the database row.
 *
 * WHY: a job's payload carries its input pictures as base64 data URLs. Written straight into the
 * row that is exactly what it sounds like — a whole SQLite row per picture, several megabytes of
 * it, and nothing ever deletes it. One hundred-lane run took the database to 479 MB. At three
 * hundred lanes the same run writes gigabytes, into a file that also holds every user account.
 *
 * TWO THINGS FIX IT, and the second one matters more than the first:
 *
 *   1. Raw bytes on disk instead of base64 in a row. base64 is 4 bytes per 3, so this alone is a
 *      third off, and it moves the bulk out of the file that gets backed up and WAL-checkpointed.
 *
 *   2. CONTENT ADDRESSING. A batch is the same base photo and the same outfit against N poses —
 *      so the SAME picture is in every single job of that run. Naming each file after the sha256
 *      of its bytes means the second job through stores nothing at all; it just points at the file
 *      the first one wrote. A 300-job run holds one base, one outfit and 300 poses instead of 900
 *      pictures. That is the difference between ~20 MB and ~1.3 GB.
 *
 * The row keeps a `blob:<sha256>.<ext>` reference, about forty bytes.
 *
 * DELIBERATELY NOT REFCOUNTED. A refcount is a number that leaks the first time a crash lands
 * between two writes, and a leaked refcount either deletes a picture a job still needs or keeps
 * every file forever — silently, both of them. Instead nothing is deleted on the hot path at all;
 * `sweep` asks the queue which references are still live and removes the files nobody names. It is
 * derived from the truth rather than maintained alongside it, so a crash cannot corrupt it.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** data:image/png;base64,AAAA... — the shape the client sends. */
const DATA_URL = /^data:image\/([\w.+-]+);base64,([\s\S]+)$/;
const REF = /^blob:([A-Za-z0-9]+)\.([A-Za-z0-9]+)$/;

let _dir = null;

/**
 * Where the blobs live: beside the database, so one backup or one wipe covers both and a job can
 * never reference a file that a half-restored install has lost.
 *
 * Resolved lazily. Requiring the database at module load would drag better-sqlite3 into every
 * process that touches this file, including the check suites, which run under plain node where
 * that native module cannot load at all.
 */
function blobDir() {
  if (_dir) return _dir;
  if (process.env.KYROS_BLOB_DIR) {
    _dir = process.env.KYROS_BLOB_DIR;
  } else {
    // eslint-disable-next-line global-require
    const db = require('../db');
    _dir = path.join(path.dirname(db.name), 'job-blobs');
  }
  fs.mkdirSync(_dir, { recursive: true });
  return _dir;
}

const extOf = (mime) => (mime.toLowerCase() === 'jpeg' ? 'jpg' : mime.toLowerCase().replace(/[^a-z0-9]/g, ''));
const mimeOf = (ext) => (ext === 'jpg' ? 'jpeg' : ext);

/**
 * Data URLs in, references out. Anything that is not a data URL — an http URL, a reference that has
 * already been through here — passes through untouched, so this is safe to call twice.
 */
function store(images) {
  if (!Array.isArray(images)) return images;
  const dir = blobDir();
  return images.map((img) => {
    /**
     * THE SHAPE THE APP ACTUALLY SENDS IS AN OBJECT, not a data URL.
     *
     * `parseDataUrl()` in EddyGeneratePage returns `{ mimeType, base64 }`, and that object travels
     * all the way into `payload.images`. This function only understood strings, so every real
     * image hit the `typeof img !== 'string'` bail below and was returned untouched — no file
     * written, no error raised, and the full base64 stringified straight into the job row. That is
     * how saas.db reached 800 MB in under an hour while the blob directory stayed empty
     * (2026-08-15). A pass-through that silently does nothing is the most expensive kind.
     *
     * Normalised here rather than at the call sites: this is the one place that knows what a
     * stored image looks like, and the queue has two independent producers.
     */
    const asObject = img && typeof img === 'object' && typeof img.base64 === 'string'
      ? { base64: img.base64.replace(/^data:[^;]+;base64,/, ''), mimeType: img.mimeType || 'image/png' }
      : null;
    if (asObject) {
      const bytes = Buffer.from(asObject.base64, 'base64');
      if (!bytes.length) return img;
      const ext = extOf(asObject.mimeType.replace(/^image\//, '')) || 'png';
      const name = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${ext}`;
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) {
        const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(tmp, bytes);
        try { fs.renameSync(tmp, file); } catch { fs.rmSync(tmp, { force: true }); }
      }
      return `blob:${name}`;
    }

    if (typeof img !== 'string') return img;
    const m = img.match(DATA_URL);
    if (!m) return img;

    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length) return img;   // not decodable — leave it alone rather than store nothing

    const ext = extOf(m[1]) || 'png';
    const name = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    const file = path.join(dir, name);
    // The name IS the hash of the contents, so an existing file is byte-identical by construction.
    // Skipping the write is the whole saving: the 2nd..300th job of a batch write nothing.
    if (!fs.existsSync(file)) {
      // Write to a unique temp name first, then rename. Two lanes storing the same picture at the
      // same instant would otherwise interleave inside one file and leave a corrupt image that
      // still has the right name — the worst possible outcome, since the hash then lies.
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, bytes);
      try { fs.renameSync(tmp, file); } catch { fs.rmSync(tmp, { force: true }); }
    }
    return `blob:${name}`;
  });
}

/**
 * References back to data URLs, for the moment of sending.
 *
 * A missing blob THROWS rather than dropping the image from the list. Sending an edit with two of
 * its three inputs does not fail — it renders a confidently wrong picture and charges for it. A
 * job that stops and says the file is gone is the cheaper of the two by a wide margin.
 */
function load(refs) {
  if (!Array.isArray(refs)) return refs;
  const dir = blobDir();
  return refs.map((ref) => {
    if (typeof ref !== 'string') return ref;
    const m = ref.match(REF);
    if (!m) return ref;
    const file = path.join(dir, `${m[1]}.${m[2]}`);
    if (!fs.existsSync(file)) throw new Error(`Input image is missing from the blob store (${ref})`);
    /**
     * Objects out, NOT data-URL strings.
     *
     * Both providers destructure what they are given — `imageInputs.map(({ base64 }) => …)` in
     * wavespeedService — so a string arrives as `base64 === undefined` and throws on the first
     * `.match`. Returning the same `{ base64, mimeType }` shape the client sent means the round
     * trip through the blob store is invisible to everything downstream, which is the only way a
     * job that was stored can be sent identically to one that was not.
     */
    return { base64: fs.readFileSync(file).toString('base64'), mimeType: `image/${mimeOf(m[2])}` };
  });
}

/**
 * Every reference a payload names, for sweep to collect.
 *
 * Reads BOTH shapes. sweepBlobs derives its keep-set from this alone, so a reference it fails to
 * see is a file it deletes while a queued job still needs it — turning a disk-space fix into every
 * queued job failing at send with "Input image is missing from the blob store".
 */
function refsIn(payload) {
  const out = [];
  for (const img of payload?.images || []) {
    if (typeof img === 'string' && REF.test(img)) out.push(img.slice('blob:'.length));
    else if (img && typeof img === 'object' && typeof img.ref === 'string' && REF.test(img.ref)) {
      out.push(img.ref.slice('blob:'.length));
    }
  }
  return out;
}

/**
 * Delete the files no live job names. `live` is the set of filenames still referenced — the caller
 * derives it from the queue, because knowing that is the queue's job and not this file's.
 *
 * Returns what it removed so a caller can log a real number instead of a claim.
 */
function sweep(live) {
  const dir = blobDir();
  const keep = live instanceof Set ? live : new Set(live || []);
  let removed = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(dir)) {
    if (keep.has(name)) continue;
    const file = path.join(dir, name);
    try {
      // A .tmp from a crashed write has no live reference either, so this collects those too —
      // but only once it is old enough that it cannot be a write happening right now.
      const st = fs.statSync(file);
      if (name.endsWith('.tmp') && Date.now() - st.mtimeMs < 60_000) continue;
      fs.rmSync(file, { force: true });
      removed += 1;
      bytes += st.size;
    } catch { /* a file that vanished under us is already the outcome we wanted */ }
  }
  return { removed, bytes };
}

module.exports = { store, load, refsIn, sweep };
