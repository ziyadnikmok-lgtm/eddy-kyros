// server/tests/errorHandler.test.js

import { describe, it, expect, vi } from 'vitest';
const { AppError, errorHandler } = require('../middleware/errorHandler');

describe('AppError', () => {
  it('creates an error with status and code', () => {
    const err = new AppError('Not found', 404, 'NOT_FOUND');
    expect(err.message).toBe('Not found');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err).toBeInstanceOf(Error);
  });

  it('defaults statusCode to 500', () => {
    const err = new AppError('Server error');
    expect(err.statusCode).toBe(500);
  });

  it('defaults code to INTERNAL_ERROR', () => {
    const err = new AppError('oops', 500);
    expect(err.code).toBe('INTERNAL_ERROR');
  });
});

describe('errorHandler middleware', () => {
  function mockReqRes() {
    const req = { id: 'test-rid', method: 'POST', path: '/api/test' };
    const res = {
      _statusCode: null,
      _json: null,
      status(code) { this._statusCode = code; return this; },
      json(obj) { this._json = obj; return this; },
    };
    const next = vi.fn();
    return { req, res, next };
  }

  it('responds with structured error for AppError', () => {
    const { req, res, next } = mockReqRes();
    const err = new AppError('Bad request', 400, 'VALIDATION_ERROR');
    errorHandler(err, req, res, next);

    expect(res._statusCode).toBe(400);
    expect(res._json.success).toBe(false);
    expect(res._json.error.code).toBe('VALIDATION_ERROR');
    expect(res._json.error.message).toBe('Bad request');
  });

  it('responds with 500 for generic errors', () => {
    const { req, res, next } = mockReqRes();
    const err = new Error('Something broke');
    errorHandler(err, req, res, next);

    expect(res._statusCode).toBe(500);
    expect(res._json.success).toBe(false);
    expect(res._json.error.code).toBe('INTERNAL_ERROR');
  });
});
