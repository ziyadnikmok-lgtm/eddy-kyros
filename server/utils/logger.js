// server/utils/logger.js
// Thin structured-JSON logger. Every line is machine-parseable JSON.
// Usage: const log = require('./utils/logger');  log.info('event_name', { extra })

function _emit(level, event, meta = {}) {
  const entry = { level, event, ...meta, ts: new Date().toISOString() };
  const fn = level === 'error' ? console.error : console.log;
  fn(JSON.stringify(entry));
}

module.exports = {
  info:  (event, meta) => _emit('info',  event, meta),
  warn:  (event, meta) => _emit('warn',  event, meta),
  error: (event, meta) => _emit('error', event, meta),
};
