'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const log = require('../utils/logger');

function safeJson(value) {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

function logUsageEvent({
  userId = null,
  eventType,
  entityType = null,
  entityId = null,
  source = null,
  payload = null,
}) {
  if (!eventType) return null;
  try {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO usage_events (id, user_id, event_type, entity_type, entity_id, source, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, eventType, entityType, entityId, source, safeJson(payload));
    return id;
  } catch (err) {
    log.warn('usage_event_write_failed', { eventType, userId, error: err.message });
    return null;
  }
}

function startGenerationRun({
  id = uuidv4(),
  userId,
  feature,
  provider = null,
  model = null,
  status = 'started',
}) {
  try {
    db.prepare(`
      INSERT INTO generation_runs (id, user_id, feature, provider, model, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(id, userId, feature, provider, model, status);
    return id;
  } catch (err) {
    log.warn('generation_run_start_failed', { userId, feature, error: err.message });
    return null;
  }
}

function finishGenerationRun(id, {
  status,
  outputCount = 0,
  errorCode = null,
  errorMessage = null,
  provider = null,
  model = null,
}) {
  if (!id) return false;
  try {
    db.prepare(`
      UPDATE generation_runs
      SET status = ?,
          output_count = ?,
          error_code = ?,
          error_message = ?,
          provider = COALESCE(?, provider),
          model = COALESCE(?, model),
          finished_at = datetime('now')
      WHERE id = ?
    `).run(status, outputCount, errorCode, errorMessage, provider, model, id);
    return true;
  } catch (err) {
    log.warn('generation_run_finish_failed', { id, status, error: err.message });
    return false;
  }
}

module.exports = {
  logUsageEvent,
  startGenerationRun,
  finishGenerationRun,
};
