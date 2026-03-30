'use strict';

const MAX_LINES = 500;
const _buf = [];

function push(level, text) {
  _buf.push({ ts: new Date().toISOString(), level, text });
  if (_buf.length > MAX_LINES) _buf.shift();
}

function getLines(n = 200) {
  return _buf.slice(-n);
}

module.exports = { push, getLines };
