'use strict';

const express = require('express');
const Joi = require('joi');
const router = express.Router();
const { getConnection, query } = require('../../config/db');
const { authenticateToken, authorizeRoles } = require('../auth/authMiddleware');
const { success, error } = require('../../shared/response');

const requestSchema = Joi.object({
  type: Joi.string().trim().min(1).max(80).required(),
  priority: Joi.string().valid('low', 'medium', 'high', 'urgent').default('medium'),
  subject: Joi.string().trim().min(3).max(160).required(),
  complaint_id: Joi.number().integer().positive().allow('', null).default(null),
  description: Joi.string().trim().min(20).max(5000).required(),
}).unknown(false);

router.use(authenticateToken);

router.get('/mine', authorizeRoles('citizen', 'staff'), async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT id, complaint_id, request_type AS type, priority, subject, description, status, created_at
       FROM support_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
      [req.user.userId]
    );
    return success(res, rows);
  } catch (err) {
    return next(err);
  }
});

router.post('/', authorizeRoles('citizen', 'staff'), async (req, res, next) => {
  const { error: validationError, value } = requestSchema.validate(req.body, { abortEarly: false });
  if (validationError) {
    return error(
      res,
      400,
      'VALIDATION_ERROR',
      validationError.details[0].message,
      validationError.details.map(detail => ({ field: detail.path.join('.'), msg: detail.message }))
    );
  }

  let connection;
  try {
    connection = await getConnection();
    await connection.beginTransaction();
    const [requestResult] = await connection.execute(
      `INSERT INTO support_requests
         (user_id, complaint_id, request_type, priority, subject, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.user.userId,
        value.complaint_id || null,
        value.type,
        value.priority,
        value.subject,
        value.description,
      ]
    );
    const [requesterRows] = await connection.execute(
      `SELECT u.name, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`,
      [req.user.userId]
    );
    const requester = requesterRows[0];
    const [admins] = await connection.execute(
      `SELECT u.id FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE r.name = 'super_admin' AND u.is_active = 1`
    );
    if (!admins.length) {
      const err = new Error('No active super administrator is available to receive support requests.');
      err.statusCode = 503;
      err.code = 'NO_SUPPORT_ADMIN';
      throw err;
    }

    const roleLabel = requester.role === 'staff' ? 'Staff member' : 'Citizen';
    const message = `${roleLabel} ${requester.name} submitted a ${value.priority} priority support request (#${requestResult.insertId}): ${value.subject}\n${value.description}`;
    for (const admin of admins) {
      await connection.execute(
        'INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)',
        [admin.id, 'support_request', message]
      );
    }
    await connection.commit();
    return success(res, { id: requestResult.insertId }, 'Support request submitted.');
  } catch (err) {
    if (connection) await connection.rollback();
    if (err.code === 'NO_SUPPORT_ADMIN') return error(res, 503, err.code, err.message);
    return next(err);
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
