'use strict';
/**
 * Auto-close resolved complaints after 7 days with no citizen confirmation.
 * Requirement 6.4 — runs on a daily interval.
 */

const { query, getConnection } = require('../config/db');

const INTERVAL_MS      = 24 * 60 * 60 * 1000;  // 24 hours
const AUTO_CLOSE_DAYS  = 7;

async function autoCloseResolvedComplaints() {
  let closed = 0;
  try {
    // Find all resolved complaints older than 7 days
    const eligible = await query(
      `SELECT id FROM complaints
       WHERE status = 'resolved'
         AND resolved_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [AUTO_CLOSE_DAYS]
    );

    if (!eligible.length) return;

    const conn = await getConnection();
    await conn.beginTransaction();
    try {
      for (const { id } of eligible) {
        await conn.execute(
          "UPDATE complaints SET status='closed', closed_at=NOW() WHERE id=?",
          [id]
        );
        await conn.execute(
          `INSERT INTO complaint_status_history
             (complaint_id, changed_by, old_status, new_status, note, is_internal_note)
           VALUES (?, (SELECT id FROM users WHERE role_id=(SELECT id FROM roles WHERE name='super_admin') LIMIT 1), 'resolved', 'closed', 'Auto-closed after 7 days with no citizen confirmation.', 0)`,
          [id]
        );
        closed++;
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      console.error('[AutoClose] Transaction failed:', err.message);
    } finally {
      conn.release();
    }

    if (closed > 0) {
      console.log(`[${new Date().toISOString()}] [AutoClose] Closed ${closed} resolved complaint(s).`);
    }
  } catch (err) {
    console.error('[AutoClose] Job error:', err.message);
  }
}

function startAutoCloseJob() {
  // Run once at startup, then every 24 hours
  autoCloseResolvedComplaints();
  const timer = setInterval(autoCloseResolvedComplaints, INTERVAL_MS);
  // Don't block process exit
  if (timer.unref) timer.unref();
  console.log(`[${new Date().toISOString()}] [AutoClose] Job scheduled (every 24h).`);
}

module.exports = { startAutoCloseJob, autoCloseResolvedComplaints };
