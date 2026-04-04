'use strict';
/**
 * Unified mail sender.
 * Priority:
 *  1. Resend API  (RESEND_API_KEY + RESEND_FROM with verified domain)
 *  2. SMTP        (SMTP_HOST + SMTP_USER + SMTP_PASS)
 *  3. Console log fallback — link printed to server logs (Dokploy)
 *
 * NOTE: Resend requires a verified domain to send to arbitrary emails.
 *   Set RESEND_FROM=noreply@yourdomain.com after verifying at resend.com/domains
 */
const log = require('./logger');

async function sendMail(to, subject, html) {
  // ── 1. Resend ──────────────────────────────────────────────────────────────
  if (process.env.RESEND_API_KEY) {
    try {
      // RESEND_FROM must be a verified domain address (e.g. noreply@kyros-studio.xyz)
      // onboarding@resend.dev only delivers to the Resend account owner
      const from = process.env.RESEND_FROM || process.env.MAIL_FROM || 'Kyros Studio <onboarding@resend.dev>';
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to, subject, html }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        log.warn('resend_mail_failed', { to, status: resp.status, error: body?.message || JSON.stringify(body) });
        console.error(`[MAIL] Resend error ${resp.status}: ${body?.message || JSON.stringify(body)}`);
        // fall through to SMTP
      } else {
        log.info('mail_sent_resend', { to, subject, id: body?.id });
        console.log(`[MAIL] Sent via Resend to ${to} (id: ${body?.id})`);
        return true;
      }
    } catch (e) {
      log.warn('resend_mail_error', { message: e.message });
      console.error(`[MAIL] Resend exception: ${e.message}`);
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
      await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html });
      log.info('mail_sent_smtp', { to, subject });
      console.log(`[MAIL] Sent via SMTP to ${to}`);
      return true;
    } catch (e) {
      log.warn('smtp_mail_failed', { to, message: e.message });
      console.error(`[MAIL] SMTP error: ${e.message}`);
    }
  }

  // ── 3. Console fallback ────────────────────────────────────────────────────
  const linkMatch = html.match(/href="([^"]+)"/);
  const link = linkMatch ? linkMatch[1] : '(no link found)';
  console.warn(`\n[MAIL FALLBACK - NO PROVIDER CONFIGURED]\nTo: ${to}\nSubject: ${subject}\nLink: ${link}\nHint: Set RESEND_FROM=noreply@yourdomain.com after verifying domain at resend.com/domains\n`);
  log.warn('mail_no_provider', { to, subject, link });
  return false;
}

module.exports = { sendMail };
