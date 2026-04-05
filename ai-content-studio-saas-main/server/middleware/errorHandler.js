const log = require('../utils/logger');

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

function _classifyError(err) {
  if (err instanceof SyntaxError) return 'SYNTAX_ERROR';
  if (err instanceof TypeError) return 'TYPE_ERROR';
  if (err instanceof RangeError) return 'RANGE_ERROR';
  return 'INTERNAL_ERROR';
}

function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const code = err.isOperational
    ? (err.code || 'INTERNAL_ERROR')
    : _classifyError(err);

  if (statusCode >= 500) {
    const meta = {
      userId: req.session?.userId || null,
      rid: req.id || null,
      method: req.method,
      path: req.path,
      status: statusCode,
      code,
      message: err.message,
    };
    if (process.env.NODE_ENV !== 'production') {
      meta.stack = err.stack;
    }
    log.error('request_error', meta);
  }

  if (res.headersSent) {
    return res.end();
  }

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message: err.isOperational ? err.message : 'An unexpected error occurred',
    },
  });
}

module.exports = { AppError, errorHandler };
