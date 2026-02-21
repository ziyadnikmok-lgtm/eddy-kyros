// server/tests/multipartParser.test.js

import { describe, it, expect, vi } from 'vitest';
const { createMultipartParser } = require('../middleware/multipartParser');
const { EventEmitter } = require('node:events');

// Helper: build a fake Express request from a multipart body
function createMockReq(boundary, parts, contentType) {
  const body = parts
    .map((p) => {
      let headers = `Content-Disposition: form-data; name="${p.name}"`;
      if (p.filename) headers += `; filename="${p.filename}"`;
      if (p.contentType) headers += `\r\nContent-Type: ${p.contentType}`;
      return `--${boundary}\r\n${headers}\r\n\r\n${p.value}\r\n`;
    })
    .join('') + `--${boundary}--\r\n`;

  const buffer = Buffer.from(body, 'latin1');
  const req = new EventEmitter();
  req.headers = { 'content-type': contentType || `multipart/form-data; boundary=${boundary}` };
  req.body = {};
  req.destroy = vi.fn();

  // Emit body in next tick so the middleware can attach listeners
  process.nextTick(() => {
    req.emit('data', buffer);
    req.emit('end');
  });

  return req;
}

function createMockRes() {
  return {};
}

describe('createMultipartParser', () => {
  it('parses text fields into req.body', async () => {
    const mw = createMultipartParser();
    const req = createMockReq('----boundary', [
      { name: 'mode', value: 'variation' },
      { name: 'count', value: '5' },
    ]);
    const res = createMockRes();

    await new Promise((resolve, reject) => {
      mw(req, res, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    expect(req.body.mode).toBe('variation');
    expect(req.body.count).toBe('5');
    expect(req.file).toBeUndefined();
  });

  it('parses file upload into req.file', async () => {
    const mw = createMultipartParser();
    const req = createMockReq('----boundary', [
      { name: 'mode', value: 'edit' },
      { name: 'image', value: 'fake-binary-data', filename: 'test.png', contentType: 'image/png' },
    ]);
    const res = createMockRes();

    await new Promise((resolve, reject) => {
      mw(req, res, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    expect(req.body.mode).toBe('edit');
    expect(req.file).toBeDefined();
    expect(req.file.fieldname).toBe('image');
    expect(req.file.originalname).toBe('test.png');
    expect(req.file.mimetype).toBe('image/png');
    expect(req.file.buffer).toBeInstanceOf(Buffer);
  });

  it('passes through for non-multipart requests', async () => {
    const mw = createMultipartParser();
    const req = new EventEmitter();
    req.headers = { 'content-type': 'application/json' };
    req.body = { already: 'parsed' };
    const res = createMockRes();

    await new Promise((resolve, reject) => {
      mw(req, res, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    expect(req.body.already).toBe('parsed');
  });

  it('calls fallback for non-multipart when fallback is provided', async () => {
    const fallback = vi.fn((_req, _res, next) => next());
    const mw = createMultipartParser({ fallback });
    const req = new EventEmitter();
    req.headers = { 'content-type': 'application/json' };
    req.body = {};
    const res = createMockRes();

    await new Promise((resolve, reject) => {
      mw(req, res, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    expect(fallback).toHaveBeenCalledOnce();
  });

  it('rejects uploads exceeding maxBytes', async () => {
    const mw = createMultipartParser({ maxBytes: 10 });
    const bigData = 'x'.repeat(100);
    const req = createMockReq('----boundary', [
      { name: 'file', value: bigData, filename: 'big.bin', contentType: 'application/octet-stream' },
    ]);
    const res = createMockRes();

    const err = await new Promise((resolve) => {
      mw(req, res, (err) => resolve(err));
    });

    expect(err).toBeDefined();
    expect(err.statusCode || err.status).toBe(413);
  });

  it('returns error for missing boundary', async () => {
    const mw = createMultipartParser();
    const req = new EventEmitter();
    req.headers = { 'content-type': 'multipart/form-data' };
    req.body = {};
    const res = createMockRes();

    const err = await new Promise((resolve) => {
      mw(req, res, (err) => resolve(err));
    });

    expect(err).toBeDefined();
    expect(err.message).toMatch(/boundary/i);
  });
});
