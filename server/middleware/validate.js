const { AppError } = require('./errorHandler');

function requireString(value, fieldName, { maxLength = 5000, minLength = 1 } = {}) {
  if (value === undefined || value === null || typeof value !== 'string') {
    throw new AppError(`"${fieldName}" is required and must be a string`, 400, 'VALIDATION_ERROR');
  }
  if (value.trim().length < minLength) {
    throw new AppError(`"${fieldName}" must be at least ${minLength} character(s)`, 400, 'VALIDATION_ERROR');
  }
  if (value.trim().length > maxLength) {
    throw new AppError(`"${fieldName}" must be ${maxLength} characters or fewer`, 400, 'VALIDATION_ERROR');
  }
  return value.trim();
}

function optionalString(value, fieldName, { maxLength = 5000 } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new AppError(`"${fieldName}" must be a string`, 400, 'VALIDATION_ERROR');
  }
  if (value.trim().length > maxLength) {
    throw new AppError(`"${fieldName}" must be ${maxLength} characters or fewer`, 400, 'VALIDATION_ERROR');
  }
  return value.trim() || null;
}

function requireId(value, fieldName = 'id') {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(`"${fieldName}" is required`, 400, 'VALIDATION_ERROR');
  }
  return value.trim();
}

function requireArray(value, fieldName, { minLength = 0, maxLength = Infinity } = {}) {
  if (!Array.isArray(value)) {
    throw new AppError(`"${fieldName}" must be an array`, 400, 'VALIDATION_ERROR');
  }
  if (value.length < minLength) {
    throw new AppError(`"${fieldName}" must contain at least ${minLength} item(s)`, 400, 'VALIDATION_ERROR');
  }
  if (value.length > maxLength) {
    throw new AppError(`"${fieldName}" must contain at most ${maxLength} items`, 400, 'VALIDATION_ERROR');
  }
  return value;
}

function requireEnum(value, fieldName, allowed) {
  if (!allowed.includes(value)) {
    throw new AppError(`"${fieldName}" must be one of: ${allowed.join(', ')}`, 400, 'VALIDATION_ERROR');
  }
  return value;
}

function requireInt(value, fieldName, { min = 0, max = Infinity } = {}) {
  const n = typeof value === 'number' ? Math.floor(value) : parseInt(value, 10);
  if (isNaN(n)) {
    throw new AppError(`"${fieldName}" must be a number`, 400, 'VALIDATION_ERROR');
  }
  if (n < min || n > max) {
    throw new AppError(`"${fieldName}" must be between ${min} and ${max}`, 400, 'VALIDATION_ERROR');
  }
  return n;
}

module.exports = {
  requireString,
  optionalString,
  requireId,
  requireArray,
  requireEnum,
  requireInt,
};
