import { beforeEach, describe, expect, it } from 'vitest';

const db = require('../db');
const {
  getFreeTrialUsage,
  reserveFreeTrialUsage,
  releaseFreeTrialUsage,
} = require('../middleware/planLimits');

function createUser(id = 'trial-user') {
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, verified)
    VALUES (?, ?, 'hash', 'Trial User', 1)
  `).run(id, `${id}@example.com`);
  return id;
}

function insertRun(userId, { id, status = 'succeeded', outputCount = 1 }) {
  db.prepare(`
    INSERT INTO generation_runs (id, user_id, feature, provider, model, status, output_count, started_at, finished_at)
    VALUES (?, ?, 'generate', 'gemini', 'test-model', ?, ?, datetime('now'), datetime('now'))
  `).run(id, userId, status, outputCount);
}

describe('planLimits', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM usage_events').run();
    db.prepare('DELETE FROM generation_runs').run();
    db.prepare('DELETE FROM subscriptions').run();
    db.prepare('DELETE FROM users').run();
  });

  it('counts successful generation history when trial reservation events are missing', () => {
    const userId = createUser('history-only');
    insertRun(userId, { id: 'run-1', outputCount: 7 });
    insertRun(userId, { id: 'run-2', outputCount: 5 });

    expect(getFreeTrialUsage(userId)).toBe(12);
  });

  it('uses the higher of reservation slots and successful output history', () => {
    const userId = createUser('max-usage');
    const reservations = reserveFreeTrialUsage(userId, 3, 'test');
    insertRun(userId, { id: 'run-3', outputCount: 8 });

    expect(getFreeTrialUsage(userId)).toBe(8);
    releaseFreeTrialUsage(reservations);
  });

  it('ignores failed generations for free trial usage fallback', () => {
    const userId = createUser('failed-only');
    insertRun(userId, { id: 'run-failed', status: 'failed', outputCount: 0 });

    expect(getFreeTrialUsage(userId)).toBe(0);
  });
});
