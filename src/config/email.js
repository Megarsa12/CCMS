'use strict';
/**
 * Nodemailer transporter — configured from environment variables only (Req 18.5)
 */

const nodemailer = require('nodemailer');

function isEmailConfigured() {
  const port = Number.parseInt(process.env.SMTP_PORT || '587', 10);
  return Boolean(
    process.env.SMTP_HOST?.trim()
    && process.env.SMTP_USER?.trim()
    && process.env.SMTP_PASS?.trim()
    && Number.isInteger(port)
    && port > 0
    && port <= 65535
  );
}

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Send a plain HTML email.
 * Failures are logged and returned so callers can handle delivery failures.
 *
 * @param {string} to       Recipient email address
 * @param {string} subject  Email subject line
 * @param {string} html     HTML body
 * @returns {Promise<{success:boolean, error?:Error}>}
 */
async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({
      from:    process.env.EMAIL_FROM || '"CCMS" <noreply@city.gov>',
      to,
      subject,
      html,
    });
    return { success: true };
  } catch (error) {
    console.error(`[Email] Failed to send to ${to}:`, error.message);
    return { success: false, error };
  }
}

module.exports = { transporter, sendEmail, isEmailConfigured };
