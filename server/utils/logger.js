const logBuffer = require('./logBuffer');
const { getUserId } = require('../userContext');

function _emit(level, event, meta = {}) {
  const userId = meta.userId || getUserId() || null;
  const entry = { level, event, ...meta, userId, ts: new Date().toISOString() };
  const line = JSON.stringify(entry);
  const fn = level === 'error' ? console.error : console.log;
  fn(line);
  logBuffer.push(level, `[${event}] ${meta ? JSON.stringify(meta) : ''}`, {
    userId,
    rid: meta.rid || null,
    path: meta.path || null,
    event,
  });
}

module.exports = {
  info:  (event, meta) => _emit('info',  event, meta),
  warn:  (event, meta) => _emit('warn',  event, meta),
  error: (event, meta) => _emit('error', event, meta),
};
