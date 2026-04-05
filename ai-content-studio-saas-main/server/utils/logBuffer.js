'use strict';

const MAX_LINES = 500;
const _buf = [];

function push(level, text, meta = {}) {
  _buf.push({
    ts: new Date().toISOString(),
    level,
    text,
    userId: meta.userId || null,
    rid: meta.rid || null,
    path: meta.path || null,
    event: meta.event || null,
  });
  if (_buf.length > MAX_LINES) _buf.shift();
}

function getLines(n = 200, options = {}) {
  const userId = options.userId || null;
  const excludePaths = new Set(options.excludePaths || []);
  const source = (userId
    ? _buf.filter((line) => line.userId === userId)
    : _buf)
    .filter((line) => !excludePaths.has(line.path || ''));
  return source.slice(-n);
}

module.exports = { push, getLines };
