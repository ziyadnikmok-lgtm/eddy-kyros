// server/middleware/compression.js
// Gzip compression for JSON responses above a size threshold.
// Adapted from zArma-Studio's compression pattern.

const { promisify } = require('node:util');
const { gzip } = require('node:zlib');

const gzipAsync = promisify(gzip);

function compressionMiddleware(minBytes = 1024) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = async function (data) {
      const acceptEncoding = req.headers['accept-encoding'] || '';
      if (!acceptEncoding.includes('gzip')) return originalJson(data);

      let jsonString;
      try {
        jsonString = JSON.stringify(data);
      } catch {
        return originalJson(data);
      }

      if (jsonString.length < minBytes) return originalJson(data);

      try {
        const compressed = await gzipAsync(Buffer.from(jsonString, 'utf8'));
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Length', compressed.length);
        return res.end(compressed);
      } catch {
        // Fall back to uncompressed on any gzip error
        return originalJson(data);
      }
    };

    next();
  };
}

module.exports = compressionMiddleware;
