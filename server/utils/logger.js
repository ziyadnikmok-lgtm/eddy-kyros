const logBuffer = require('./logBuffer');

function _emit(level, event, meta = {}) {
  const entry = { level, event, ...meta, ts: new Date().toISOString() };
  const line = JSON.stringify(entry);
  const fn = level === 'error' ? console.error : console.log;
  fn(line);
  logBuffer.push(level, `[${event}] ${meta ? JSON.stringify(meta) : ''}`);
}

module.exports = {
  info:  (event, meta) => _emit('info',  event, meta),
  warn:  (event, meta) => _emit('warn',  event, meta),
  error: (event, meta) => _emit('error', event, meta),
};
