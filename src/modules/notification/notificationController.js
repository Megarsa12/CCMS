'use strict';
const { query } = require('../../config/db');
const { success, error } = require('../../shared/response');

// GET /api/notifications — unread notifications for current user (Req 13.2)
async function getNotifications(req, res, next) {
  try {
    const rows = await query(
      `SELECT id, complaint_id, type, message, is_read, sent_at, read_at
       FROM notifications WHERE user_id = ?
       ORDER BY sent_at DESC LIMIT 100`,
      [req.user.userId]
    );
    return success(res, rows);
  } catch (err) { next(err); }
}

// GET /api/notifications/unread-count
async function getUnreadCount(req, res, next) {
  try {
    const [row] = await query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0',
      [req.user.userId]
    );
    return success(res, { count: row.count });
  } catch (err) { next(err); }
}

// PATCH /api/notifications/:id/read (Req 13.3, 13.4, 13.7)
async function markRead(req, res, next) {
  try {
    const [notif] = await query(
      'SELECT id, user_id FROM notifications WHERE id = ?',
      [+req.params.id]
    );
    if (!notif) return error(res, 404, 'NOT_FOUND', 'Notification not found.');
    if (notif.user_id !== req.user.userId) return error(res, 403, 'FORBIDDEN', 'You cannot modify this notification.');
    await query('UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ?', [notif.id]);
    return success(res, { id: notif.id }, 'Marked as read.');
  } catch (err) { next(err); }
}

// PUT /api/notifications/read-all
async function markAllRead(req, res, next) {
  try {
    await query(
      'UPDATE notifications SET is_read = 1, read_at = NOW() WHERE user_id = ? AND is_read = 0',
      [req.user.userId]
    );
    return success(res, null, 'All notifications marked as read.');
  } catch (err) { next(err); }
}

module.exports = { getNotifications, getUnreadCount, markRead, markAllRead };
