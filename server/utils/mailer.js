'use strict';
/**
 * Unified mail sender.
 * Priority:
 *  1. Resend API  (RESEND_API_KEY)          — recommended, free tier 3k emails/mo
 *  2. SMTP        (SMTP_HOST + SMTP_USER)    — any SMTP provider
 *  3. Console log fallback                   — link printed to server logs (Dokploy)
 */
const log = require('./logger');

async function sendMail(to, subject, html) {
  // ── 1. Resend ──────────────────────────────────────────────────────────────
  if (process.env.RESEND_API_KEY) {
    try {
      const from = process.env.MAIL_FROM || 'Kyros Studio <onboarding@resend.dev>';
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to, subject, html }),
      });
      if (!resp.ok) {
        const err = await resp.text();
        log.warn('resend_mail_failed', { to, status: resp.status, err });
        // fall through to SMTP
      } else {
        log.info('mail_sent_resend', { to, subject });
        return true;
      }
    } catch (e) {
      log.warn('resend_mail_error', { message: e.message });
      // fall through
    }
  }

  // ── 2. SMTP (nodemailer) ───────────────────────────────────────────────────
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const nodemailer = require('nodemailer');
      const t = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await t.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to, subject, html,
      });
      log.info('mail_sent_smtp', { to, subject });
      return true;
    } catch (e) {
      log.warn('smtp_mail_failed', { to, message: e.message });
      // fall through to console
    }
  }

  // ── 3. Console fallback — visible in Dokploy / server logs ────────────────
  // Strip HTML tags to extract the plain-text link if present
  const linkMatch = html.match(/href="([^"]+)"/);
  log.warn('mail_no_provider_console_fallback', {
    to,
    subject,
    link: linkMatch ? linkMatch[1] : '(see html)',
    hint: 'Add RESEND_API_KEY env var to enable real email delivery',
  });
  // Also print to stdout so it's easy to find in logs
  console.warn(`\n[MAIL FALLBACK] To: ${to}\nSubject: ${subject}\nLink: ${linkMatch ? linkMatch[1] : html}\n`);
  return false;
}

module.exports = { sendMail };
