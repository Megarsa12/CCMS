'use strict';

const crypto = require('crypto');
const { sendEmail } = require('../config/email');

function generatePasswordResetCode() {
  return String(crypto.randomInt(100000, 1000000));
}

async function sendPasswordResetCode({ email, name, code }) {
  const safeName = String(name).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);

  return sendEmail(
    email,
    'Your CCMS Password Reset Code',
    `<p>Hello ${safeName},</p>
     <p>Your password reset code is:</p>
     <p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>
     <p>This code expires in 1 hour and can be used only once.</p>
     <p>If you did not request this, please ignore this email.</p>`
  );
}

async function sendTemporaryPassword({ email, name, password }) {
  const safeName = String(name).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
  const safePassword = String(password).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);

  return sendEmail(
    email,
    'Your CCMS Temporary Password',
    `<p>Hello ${safeName},</p>
     <p>A CCMS administrator has set a temporary password for your account:</p>
     <p style="font-size:20px;font-weight:bold">${safePassword}</p>
     <p>Sign in with this password. You will be required to choose a new password before using your account.</p>
     <p>If you did not request this change, contact the city administration.</p>`
  );
}

module.exports = { generatePasswordResetCode, sendPasswordResetCode, sendTemporaryPassword };
