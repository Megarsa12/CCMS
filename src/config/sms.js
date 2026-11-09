'use strict';
/**
 * SMS provider adapter. SMS is opt-in and remains disabled until configured.
 * Supported provider: Twilio REST API.
 */

const https = require('https');

function isSmsEnabled() {
  return process.env.SMS_PROVIDER === 'twilio'
    && Boolean(process.env.TWILIO_ACCOUNT_SID)
    && Boolean(process.env.TWILIO_AUTH_TOKEN)
    && Boolean(process.env.TWILIO_FROM);
}

function sendTwilioSms(to, body) {
  return new Promise((resolve) => {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const payload = new URLSearchParams({
      To: to,
      From: process.env.TWILIO_FROM,
      Body: body,
    }).toString();

    const request = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve({ success: true });
          return;
        }
        resolve({ success: false, error: new Error(`Twilio returned HTTP ${response.statusCode}: ${responseBody}`) });
      });
    });

    request.on('error', (error) => resolve({ success: false, error }));
    request.write(payload);
    request.end();
  });
}

async function sendSMS(to, body) {
  if (!to || !isSmsEnabled()) return { success: false, skipped: true };
  try {
    return await sendTwilioSms(to, body);
  } catch (error) {
    console.error(`[SMS] Failed to send to ${to}:`, error.message);
    return { success: false, error };
  }
}

module.exports = { isSmsEnabled, sendSMS };