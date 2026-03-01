const { gzipSync } = require('node:zlib');

function compressionMiddleware(minBytes = 1024) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = function (data) {
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
        const compressed = gzipSync(Buffer.from(jsonString, 'utf8'));
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Length', compressed.length);
        return res.end(compressed);
      } catch {
        return originalJson(data);
      }
    };

    next();
  };
}

module.exports = compressionMiddleware;
