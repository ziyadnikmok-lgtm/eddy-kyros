'use strict';
/**
 * Sends "your batch is done" email when a job completes.
 * Only fires when:
 *  - An email provider is configured (RESEND_API_KEY or SMTP)
 *  - The job has a real userId (not __anon__)
 *  - HOSTED env var is set (email not useful for local Electron)
 *
 * Wired up once in server/index.js after batchGenerator is imported.
 */
const { sendMail } = require('../utils/mailer');
const db = require('../db');
const log = require('../utils/logger');

const DEBOUNCE_MS = 30_000; // don't spam — batch multiple completions within 30s into one email
const _pending = new Map(); // userId -> { timer, jobs[] }

function isMailConfigured() {
  return !!(process.env.RESEND_API_KEY || (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS));
}

function getUserEmail(userId) {
  try {
    const row = db.prepare('SELECT email, name FROM users WHERE id = ?').get(userId);
    return row || null;
  } catch { return null; }
}

function buildEmailHtml(jobs) {
  const appUrl = (process.env.APP_URL || 'https://kyros-studio.xyz').replace(/\/$/, '');
  const totalImages = jobs.reduce((s, j) => s + (j.completed || 0), 0);
  const totalFailed = jobs.reduce((s, j) => s + (j.failed || 0), 0);

  const rows = jobs.map((j) => {
    const icon = j.status === 'completed' ? '✅' : j.status === 'partial' ? '⚠️' : '❌';
    return `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #2a2a2a;color:#e0e0e0;">${icon} ${j.status}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #2a2a2a;color:#a0a0c0;">${j.completed}/${j.total} images</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#09090b;font-family:system-ui,sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#111;border:1px solid #222;border-radius:12px;overflow:hidden;">
    <div style="background:#1a1a2e;padding:24px 28px;border-bottom:1px solid #222;">
      <div style="color:#818cf8;font-weight:700;font-size:18px;letter-spacing:0.5px;">Kyros Studio</div>
    </div>
    <div style="padding:28px;">
      <h2 style="color:#f0f0f0;margin:0 0 8px;font-size:20px;">Your batch is ready 🎉</h2>
      <p style="color:#a0a0c0;margin:0 0 20px;font-size:14px;">
        ${totalImages} image${totalImages !== 1 ? 's' : ''} generated${totalFailed > 0 ? `, ${totalFailed} failed` : ' successfully'}.
      </p>
      <table style="width:100%;border-collapse:collapse;background:#0d0d0d;border-radius:8px;overflow:hidden;margin-bottom:24px;">
        ${rows}
      </table>
      <a href="${appUrl}/gallery" style="display:inline-block;padding:10px 22px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">View Gallery →</a>
    </div>
    <div style="padding:16px 28px;border-top:1px solid #222;color:#555;font-size:12px;">
      You're receiving this because job notifications are enabled on your Kyros Studio account.
    </div>
  </div>
</body>
</html>`;
}

async function flushUserEmail(userId) {
  const entry = _pending.get(userId);
  if (!entry) return;
  _pending.delete(userId);

  const userInfo = getUserEmail(userId);
  if (!userInfo) return;

  const subject = `Your batch is ready — ${entry.jobs.reduce((s, j) => s + j.completed, 0)} images generated`;
  await sendMail(userInfo.email, subject, buildEmailHtml(entry.jobs));
  log.info('job_completion_email_sent', { userId, to: userInfo.email, jobs: entry.jobs.length });
}

/**
 * Wire this up once: batchGenerator.on('done', handleJobDone)
 */
function handleJobDone({ jobId, status, completed, failed, total, _userId }) {
  if (!process.env.HOSTED) return;
  if (!isMailConfigured()) return;
  if (!_userId || _userId === '__anon__') return;
  if (status === 'failed' && completed === 0) return; // skip total failures — not useful

  const existing = _pending.get(_userId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.jobs.push({ jobId, status, completed, failed, total });
    existing.timer = setTimeout(() => flushUserEmail(_userId), DEBOUNCE_MS);
  } else {
    const timer = setTimeout(() => flushUserEmail(_userId), DEBOUNCE_MS);
    _pending.set(_userId, { timer, jobs: [{ jobId, status, completed, failed, total }] });
  }
}

module.exports = { handleJobDone };
