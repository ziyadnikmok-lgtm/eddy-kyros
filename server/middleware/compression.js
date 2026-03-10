const { gzip } = require('node:zlib');
const { promisify } = require('node:util');
const gzipAsync = promisify(gzip);

function compressionMiddleware(minBytes = 1024) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = function (data) {
      // Skip compression for SSE or already-encoded responses
      const ct = res.getHeader('content-type') || '';
      if (ct.includes('text/event-stream')) return originalJson(data);

      const acceptEncoding = req.headers['accept-encoding'] || '';
      if (!acceptEncoding.includes('gzip')) return originalJson(data);

      let jsonString;
      try {
        jsonString = JSON.stringify(data);
      } catch {
        return originalJson(data);
      }

      if (jsonString.length < minBytes) return originalJson(data);

      // Async gzip to avoid blocking event loop
      gzipAsync(Buffer.from(jsonString, 'utf8'))
        .then((compressed) => {
          if (res.headersSent) return;
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Length', compressed.length);
          res.end(compressed);
        })
        .catch(() => {
          if (!res.headersSent) originalJson(data);
        });
    };

    next();
  };
}

module.exports = compressionMiddleware;
