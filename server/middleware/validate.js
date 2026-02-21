// server/middleware/validate.js

const { AppError } = require('./errorHandler');

/**
 * Centralized validation helpers to reduce duplication across services and routes.
 * All functions throw AppError on failure.
 */

/**
 * Validate a required non-empty string field.
 */
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

/**
 * Validate an optional string field (allow undefined/null, reject non-string).
 */
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

/**
 * Validate a required UUID/ID string.
 */
function requireId(value, fieldName = 'id') {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(`"${fieldName}" is required`, 400, 'VALIDATION_ERROR');
  }
  return value.trim();
}

/**
 * Validate that a value is an array, with optional min/max length.
 */
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

/**
 * Validate that a value is one of the allowed values.
 */
function requireEnum(value, fieldName, allowed) {
  if (!allowed.includes(value)) {
    throw new AppError(`"${fieldName}" must be one of: ${allowed.join(', ')}`, 400, 'VALIDATION_ERROR');
  }
  return value;
}

/**
 * Validate an integer within bounds.
 */
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
