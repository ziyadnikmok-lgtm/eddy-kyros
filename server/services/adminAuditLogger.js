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

function logAdminAction({
  adminUserId,
  targetUserId = null,
  actionType,
  before = null,
  after = null,
  note = null,
}) {
  if (!adminUserId || !actionType) return null;
  try {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO admin_audit_logs (id, admin_user_id, target_user_id, action_type, before_json, after_json, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, adminUserId, targetUserId, actionType, safeJson(before), safeJson(after), note || null);
    return id;
  } catch (err) {
    log.warn('admin_audit_log_failed', { adminUserId, targetUserId, actionType, error: err.message });
    return null;
  }
}

module.exports = { logAdminAction };
