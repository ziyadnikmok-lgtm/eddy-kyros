// server/middleware/multipartParser.js
// Shared multipart/form-data parser — extracted from duplicated copies in
// batch.js, reelCopy.js, gallery.js, tweak.js.

const { AppError } = require('./errorHandler');

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50MB

/**
 * Create an Express middleware that parses multipart/form-data requests.
 *
 * @param {object} [options]
 * @param {number} [options.maxBytes=50MB]  Streaming body size cap in bytes.
 * @param {Function} [options.fallback]     Middleware to call when content-type
 *                                          is NOT multipart, or when no file is
 *                                          found after parsing. If omitted, next() is called.
 * @returns {Function} Express middleware
 */
function createMultipartParser(options = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES, fallback = null } = options;

  return function parseMultipartIfNeeded(req, _res, next) {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return fallback ? fallback(req, _res, next) : next();
    }

    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]) : null;
    if (!boundary) {
      return next(new AppError('Invalid multipart request boundary', 400, 'UPLOAD_PARSE_ERROR'));
    }

    const chunks = [];
    let totalBytes = 0;
    let done = false;

    req.on('data', (chunk) => {
      if (done) return;
      totalBytes += chunk.length;
      if (maxBytes > 0 && totalBytes > maxBytes) {
        done = true;
        chunks.length = 0; // release buffered data for GC
        req.destroy();
        return next(new AppError(`Upload exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`, 413, 'PAYLOAD_TOO_LARGE'));
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const raw = Buffer.concat(chunks).toString('latin1');
        chunks.length = 0; // release chunk references after concat
        const parts = raw.split(`--${boundary}`);
        const body = {};
        let file = null;

        for (const part of parts) {
          if (!part || part === '--\r\n' || part === '--') continue;
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;

          const headers = part.slice(0, headerEnd);
          let value = part.slice(headerEnd + 4);
          if (value.endsWith('\r\n')) value = value.slice(0, -2);

          const disp = headers.match(/Content-Disposition:[^\r\n]*/i)?.[0] || '';
          const name = disp.match(/name="([^"]+)"/i)?.[1];
          if (!name) continue;

          const filename = disp.match(/filename="([^"]*)"/i)?.[1];
          const mimeType = headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim();

          if (filename !== undefined && filename !== '') {
            file = {
              fieldname: name,
              originalname: filename,
              mimetype: mimeType || 'application/octet-stream',
              buffer: Buffer.from(value, 'latin1'),
              size: Buffer.byteLength(value, 'latin1'),
            };
          } else {
            body[name] = value;
          }
        }

        req.body = { ...(req.body || {}), ...body };
        if (file) {
          req.file = file;
          return next();
        }

        // No file found — use fallback if provided, otherwise just continue
        return fallback ? fallback(req, _res, next) : next();
      } catch (_err) {
        return next(new AppError('Failed to parse multipart upload', 400, 'UPLOAD_PARSE_ERROR'));
      }
    });

    req.on('error', () => {
      if (done) return;
      done = true;
      chunks.length = 0; // release buffered data for GC
      next(new AppError('Failed to read upload stream', 400, 'UPLOAD_PARSE_ERROR'));
    });
  };
}

module.exports = { createMultipartParser };
