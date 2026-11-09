'use strict';
/**
 * Notification service — email + in-app notifications (Req 13.1–13.7)
 * SMTP failures never propagate to caller — logged only (Req 13.6)
 */

const { query } = require('../../config/db');
const { sendEmail } = require('../../config/email');
const { sendSMS } = require('../../config/sms');
const APP_URL = () => process.env.APP_URL || 'http://localhost:3000';

// Max email retry attempts before marking as failed (Req 13.6)
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 30_000;

async function notifySuperAdmins(type, message, complaintId = null) {
  const admins = await query(
    `SELECT u.id FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.name = 'super_admin' AND u.is_active = 1`
  );

  for (const admin of admins) {
    await query(
      'INSERT INTO notifications (user_id, complaint_id, type, message) VALUES (?, ?, ?, ?)',
      [admin.id, complaintId, type, message]
    );
  }
}

async function notifyAccountActivity(userId, action, details = '') {
  const [actor] = await query(
    `SELECT u.name, r.name AS role
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? AND r.name IN ('citizen', 'staff')`,
    [userId]
  );
  if (!actor) return;

  const roleLabel = actor.role === 'staff' ? 'Staff member' : 'Citizen';
  await notifySuperAdmins(
    'account_activity',
    `${roleLabel} ${actor.name} ${action}${details ? `: ${details}` : '.'}`
  );
}

async function notifyStaffComplaintStatus(complaintId, newStatus, staffId) {
  const [activity] = await query(
    `SELECT u.name, c.tracking_number, c.title
     FROM users u
     JOIN roles r ON r.id = u.role_id AND r.name = 'staff'
     JOIN complaints c ON c.id = ?
     WHERE u.id = ?`,
    [complaintId, staffId]
  );
  if (!activity) return;

  await notifySuperAdmins(
    'staff_complaint_update',
    `Staff member ${activity.name} updated complaint ${activity.tracking_number} ("${activity.title}") to ${String(newStatus).replace(/_/g, ' ')}.`,
    complaintId
  );
}

/* ============================================================
   Core: persist in-app record + send email with retry logic
============================================================ */
async function persistAndSend(userId, complaintId, type, message, emailTo, phoneTo, subject, htmlBody) {
  // Insert in-app notification record (Req 13.1)
  let notifInsertId = null;
  try {
    const insertResult = await query(
      `INSERT INTO notifications (user_id, complaint_id, type, message) VALUES (?, ?, ?, ?)`,
      [userId, complaintId || null, type, message]
    );
    notifInsertId = insertResult?.insertId || null;
  } catch (err) {
    console.error('[Notif] DB insert failed:', err.message);
  }

  // Send email with retry (Req 13.6)
  let attempt = 0;
  const tryEmail = async () => {
    attempt++;
    const { success } = await sendEmail(emailTo, subject, htmlBody);
    if (success) {
      if (notifInsertId) {
        await query(
          'UPDATE notifications SET email_sent = 1, email_attempts = ? WHERE id = ?',
          [attempt, notifInsertId]
        ).catch(() => {});
      }
      return;
    }
    if (attempt < MAX_RETRIES) {
      setTimeout(tryEmail, RETRY_DELAY_MS);
    } else {
      console.error(`[Notif] Email to ${emailTo} permanently failed after ${MAX_RETRIES} attempts.`);
      if (notifInsertId) {
        await query(
          'UPDATE notifications SET email_failed = 1, email_attempts = ? WHERE id = ?',
          [attempt, notifInsertId]
        ).catch(() => {});
      }
    }
  };
  tryEmail(); // non-blocking

  // Send SMS with the same non-blocking retry policy as email.
  let smsAttempt = 0;
  const trySms = async () => {
    smsAttempt++;
    const { success, skipped } = await sendSMS(phoneTo, message);
    if (success || skipped) {
      if (success && notifInsertId) {
        await query(
          'UPDATE notifications SET sms_sent = 1, sms_attempts = ? WHERE id = ?',
          [smsAttempt, notifInsertId]
        ).catch(() => {});
      }
      return;
    }
    if (smsAttempt < MAX_RETRIES) {
      setTimeout(trySms, RETRY_DELAY_MS);
    } else {
      console.error(`[Notif] SMS to ${phoneTo} permanently failed after ${MAX_RETRIES} attempts.`);
      if (notifInsertId) {
        await query(
          'UPDATE notifications SET sms_failed = 1, sms_attempts = ? WHERE id = ?',
          [smsAttempt, notifInsertId]
        ).catch(() => {});
      }
    }
  };
  trySms(); // non-blocking
}

/* ============================================================
   Event: Complaint Received (Req 13.5)
============================================================ */
async function notifyComplaintReceived(complaintId, citizenId, trackingNumber) {
  const [cit] = await query(`
    SELECT u.name, u.email, c.phone, complaints.title
    FROM users u LEFT JOIN citizens c ON c.user_id = u.id
    JOIN complaints ON complaints.id = ?
    WHERE u.id = ?
  `, [complaintId, citizenId]).catch(() => []);
  if (!cit) return;
  await notifySuperAdmins(
    'citizen_complaint_submitted',
    `Citizen ${cit.name} submitted complaint ${trackingNumber} ("${cit.title}").`,
    complaintId
  ).catch(err => console.error('[Notify] super-admin complaint submitted:', err.message));
  await persistAndSend(
    citizenId, complaintId, 'complaint_received',
    `Your complaint has been received. Tracking: ${trackingNumber}`,
    cit.email,
    cit.phone,
    `CCMS: Complaint Received — ${trackingNumber}`,
    `<p>Dear ${cit.name},</p>
     <p>Your complaint has been successfully submitted.</p>
     <p><strong>Tracking Number: ${trackingNumber}</strong></p>
     <p><a href="${APP_URL()}/pages/citizen/complaint-detail.html?tracking=${trackingNumber}">Track your complaint</a></p>
     <p>City Administration — CCMS</p>`
  );
}

/* ============================================================
   Event: Complaint Assigned (Req 13.5)
============================================================ */
async function notifyAssignment(complaintId, staffId, adminId) {
  const [c]     = await query('SELECT tracking_number, citizen_id, title FROM complaints WHERE id = ?', [complaintId]).catch(() => []);
  if (!c) return;
  const [cit]   = await query(`
    SELECT u.name, u.email, c.phone
    FROM users u LEFT JOIN citizens c ON c.user_id = u.id
    WHERE u.id = ?
  `, [c.citizen_id]).catch(() => []);
  const [staff] = await query(`
    SELECT u.name, u.email, s.phone
    FROM users u LEFT JOIN staff s ON s.user_id = u.id
    WHERE u.id = ?
  `, [staffId]).catch(() => []);

  // Notify citizen
  if (cit) {
    await persistAndSend(
      c.citizen_id, complaintId, 'complaint_assigned',
      `Your complaint (${c.tracking_number}) has been assigned to a city staff member.`,
      cit.email,
      cit.phone,
      `CCMS: Complaint Assigned — ${c.tracking_number}`,
      `<p>Dear ${cit.name},</p><p>Your complaint "<strong>${c.title}</strong>" (${c.tracking_number}) has been assigned and is being reviewed.</p><p><a href="${APP_URL()}/pages/citizen/complaint-detail.html">View Complaint</a></p><p>City Administration — CCMS</p>`
    );
  }
  // Notify staff
  if (staff) {
    await persistAndSend(
      staffId, complaintId, 'complaint_assigned',
      `You have been assigned complaint ${c.tracking_number}: "${c.title}"`,
      staff.email,
      staff.phone,
      `CCMS: New Assignment — ${c.tracking_number}`,
      `<p>Dear ${staff.name},</p><p>You have been assigned complaint <strong>${c.tracking_number}</strong>: "${c.title}".</p><p><a href="${APP_URL()}/pages/staff/complaint-detail.html?id=${complaintId}">View and update</a></p>`
    );
  }
}

/* ============================================================
   Event: Status Changed (Req 13.5) — all 10 statuses
============================================================ */
async function notifyStatusChange(complaintId, newStatus, actorId, actorRole) {
  if (actorRole === 'staff') {
    await notifyStaffComplaintStatus(complaintId, newStatus, actorId)
      .catch(err => console.error('[Notify] super-admin staff status update:', err.message));
  }
  const [c]   = await query('SELECT tracking_number, citizen_id, title FROM complaints WHERE id = ?', [complaintId]).catch(() => []);
  if (!c) return;
  const [cit] = await query(`
    SELECT u.name, u.email, c.phone
    FROM users u LEFT JOIN citizens c ON c.user_id = u.id
    WHERE u.id = ?
  `, [c.citizen_id]).catch(() => []);
  if (!cit) return;

  const STATUS_LABELS = {
    submitted:       'Submitted',
    assigned:        'Assigned',
    in_progress:     'In Progress',
    resolved:        'Resolved',
    closed:          'Closed',
    rejected:        'Rejected',
    escalated:       'Escalated',
  };

  const STATUS_MESSAGES = {
    assigned:        'Your complaint has been assigned to a department.',
    in_progress:     'Work is actively in progress to resolve your complaint.',
    resolved:        'Your complaint has been resolved! Please rate our service.',
    closed:          'Your complaint has been officially closed.',
    rejected:        'Your complaint was rejected. Please see the notes for the reason.',
    escalated:       'Your complaint has been escalated to senior administration.',
  };

  const label   = STATUS_LABELS[newStatus]   || newStatus.replace(/_/g,' ');
  const message = STATUS_MESSAGES[newStatus] || `Status changed to: ${label}`;

  await persistAndSend(
    c.citizen_id, complaintId, 'status_change',
    `Complaint ${c.tracking_number}: ${label} — ${message}`,
    cit.email,
    cit.phone,
    `CCMS: Status Update — ${c.tracking_number}`,
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1a3c6e;padding:24px;border-radius:12px 12px 0 0;text-align:center">
        <h2 style="color:#c8a84b;margin:0">Shambu City Administration</h2>
        <p style="color:rgba(255,255,255,.7);margin:4px 0 0;font-size:.85rem">Complaint Management System</p>
      </div>
      <div style="background:#fff;padding:28px;border:1px solid #dee2e6;border-top:none;border-radius:0 0 12px 12px">
        <p>Dear <strong>${cit.name}</strong>,</p>
        <p>Your complaint status has been updated:</p>
        <div style="background:#f4f6fb;border-radius:10px;padding:16px;margin:16px 0">
          <div style="font-size:.8rem;color:#6c757d;margin-bottom:4px">Tracking Number</div>
          <div style="font-family:monospace;font-weight:700;font-size:1.1rem;color:#1a3c6e">${c.tracking_number}</div>
          <div style="font-size:.8rem;color:#6c757d;margin:10px 0 4px">Complaint</div>
          <div style="font-weight:600">${c.title}</div>
          <div style="font-size:.8rem;color:#6c757d;margin:10px 0 4px">New Status</div>
          <div style="font-weight:700;color:#1a3c6e;font-size:1rem">${label}</div>
        </div>
        <p>${message}</p>
        <a href="${APP_URL()}/complaints/${complaintId}" style="display:inline-block;background:#1a3c6e;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px">
          View Complaint
        </a>
        <p style="color:#6c757d;font-size:.8rem;margin-top:24px">Shambu City Administration — CCMS<br>Horo Guduru Wollega, Oromia, Ethiopia</p>
      </div>
    </div>`
  );
}

/* ============================================================
   Event: Escalation (Req 13.5 — citizen + all admin/super_admin)
============================================================ */
async function notifyEscalation(complaintId, actorId) {
  const [c]   = await query('SELECT tracking_number, citizen_id, title FROM complaints WHERE id = ?', [complaintId]).catch(() => []);
  if (!c) return;
  const [cit] = await query(`
    SELECT u.name, u.email, c.phone
    FROM users u LEFT JOIN citizens c ON c.user_id = u.id
    WHERE u.id = ?
  `, [c.citizen_id]).catch(() => []);
  const admins= await query(
    "SELECT u.id, u.name, u.email, a.phone FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN administrators a ON a.user_id=u.id WHERE r.name IN ('admin','super_admin') AND u.is_active=1"
  ).catch(() => []);

  if (cit) {
    await persistAndSend(
      c.citizen_id, complaintId, 'escalated',
      `Your complaint (${c.tracking_number}) has been escalated to senior administration.`,
      cit.email,
      cit.phone,
      `CCMS: Complaint Escalated — ${c.tracking_number}`,
      `<p>Dear ${cit.name},</p><p>Your complaint "<strong>${c.title}</strong>" has been escalated for priority attention.</p>`
    );
  }
  // Notify all admins (Req 9.3 — citizen failure does not block this)
  for (const admin of admins) {
    await persistAndSend(
      admin.id, complaintId, 'escalated',
      `Complaint ${c.tracking_number} has been escalated and requires attention.`,
      admin.email,
      admin.phone,
      `CCMS: Escalation Alert — ${c.tracking_number}`,
      `<p>Dear ${admin.name},</p><p>Complaint <strong>${c.tracking_number}</strong> has been escalated. Please review.</p><p><a href="${APP_URL()}/pages/admin/complaint-detail.html?id=${complaintId}">View Complaint</a></p>`
    );
  }
}

/* ============================================================
   Event: New Announcement — notify all active citizens
============================================================ */
async function notifyAnnouncement(title, body) {
  const citizens = await query(
    "SELECT u.id, u.name, u.email, c.phone FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN citizens c ON c.user_id=u.id WHERE r.name='citizen' AND u.is_active=1 LIMIT 500"
  ).catch(() => []);

  for (const cit of citizens) {
    await persistAndSend(
      cit.id, null, 'announcement',
      `New announcement: ${title}`,
      cit.email,
      cit.phone,
      `Shambu CCMS: ${title}`,
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1a3c6e;padding:24px;border-radius:12px 12px 0 0;text-align:center">
          <h2 style="color:#c8a84b;margin:0">Shambu City Administration</h2>
          <p style="color:rgba(255,255,255,.7);margin:4px 0 0;font-size:.85rem">Official Announcement</p>
        </div>
        <div style="background:#fff;padding:28px;border:1px solid #dee2e6;border-top:none;border-radius:0 0 12px 12px">
          <p>Dear <strong>${cit.name}</strong>,</p>
          <h3 style="color:#1a3c6e">${title}</h3>
          <p>${body}</p>
          <a href="${APP_URL()}/news" style="display:inline-block;background:#1a3c6e;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px">
            View Announcements
          </a>
          <p style="color:#6c757d;font-size:.8rem;margin-top:24px">Shambu City Administration — CCMS<br>Horo Guduru Wollega, Oromia, Ethiopia</p>
        </div>
      </div>`
    ).catch(() => {}); // never fail the whole loop
  }
}

module.exports = {
  notifySuperAdmins, notifyAccountActivity, notifyStaffComplaintStatus,
  notifyComplaintReceived, notifyAssignment,
  notifyStatusChange, notifyEscalation,
  notifyAnnouncement,
};
