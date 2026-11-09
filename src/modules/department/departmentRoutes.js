'use strict';
const express = require('express');
const router  = express.Router();
const Joi     = require('joi');
const { query } = require('../../config/db');
const { success, created, error } = require('../../shared/response');
const { authenticateToken, authorizeRoles } = require('../auth/authMiddleware');

// List departments — all authenticated roles (Req 12.6)
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const rows = await query('SELECT id, name, code, head_name, contact_email, phone, is_active FROM departments ORDER BY name ASC');
    return success(res, rows);
  } catch (err) { next(err); }
});

// Get single department
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    const [d] = await query('SELECT * FROM departments WHERE id = ?', [+req.params.id]);
    if (!d) return error(res, 404, 'NOT_FOUND', 'Department not found.');
    return success(res, d);
  } catch (err) { next(err); }
});

// Get staff in department (Req 12.4)
router.get('/:id/staff', authenticateToken, authorizeRoles('admin', 'super_admin'), async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT u.id, u.name, u.email, u.department_id, u.is_active, r.name AS role
       FROM users u JOIN roles r ON r.id=u.role_id
       WHERE u.department_id = ? AND u.is_active = 1 AND r.name = 'staff'
       ORDER BY u.name ASC`,
      [+req.params.id]
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

// Get complaints for department
router.get('/:id/complaints', authenticateToken, authorizeRoles('admin','super_admin','staff'), async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT c.id, c.tracking_number, c.title, c.status, c.priority, c.submitted_at
       FROM complaints c WHERE c.department_id = ? ORDER BY c.submitted_at DESC LIMIT 50`,
      [+req.params.id]
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

// Create department — super_admin only (Req 12.1, 12.5)
router.post('/', authenticateToken, authorizeRoles('super_admin'), async (req, res, next) => {
  try {
    const schema = Joi.object({
      name:          Joi.string().max(100).required(),
      code:          Joi.string().max(20).uppercase().required(),
      head_name:     Joi.string().max(100).optional().allow('', null),
      contact_email: Joi.string().email().optional().allow('', null),
      phone:         Joi.string().max(20).optional().allow('', null),
      is_active:     Joi.number().valid(0, 1).default(1),
    });
    const { error: vErr, value } = schema.validate(req.body);
    if (vErr) return error(res, 400, 'VALIDATION_ERROR', vErr.details[0].message);
    const result = await query(
      'INSERT INTO departments (name, code, head_name, contact_email, phone, is_active) VALUES (?, ?, ?, ?, ?, ?)',
      [value.name, value.code, value.head_name || null, value.contact_email || null, value.phone || null, value.is_active]
    );
    const [dept] = await query('SELECT * FROM departments WHERE id = ?', [result.insertId]);
    return created(res, dept, 'Department created.');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return error(res, 409, 'DUPLICATE_CODE', 'A department with this code already exists.');
    next(err);
  }
});

// Update department — admin and super_admin (Req 12.3)
router.put('/:id', authenticateToken, authorizeRoles('admin', 'super_admin'), async (req, res, next) => {
  try {
    const schema = Joi.object({
      name:          Joi.string().max(100).optional(),
      head_name:     Joi.string().max(100).optional().allow('', null),
      contact_email: Joi.string().email().optional().allow('', null),
      phone:         Joi.string().max(20).optional().allow('', null),
      is_active:     Joi.number().valid(0, 1).optional(),
    });
    const { error: vErr, value } = schema.validate(req.body);
    if (vErr) return error(res, 400, 'VALIDATION_ERROR', vErr.details[0].message);
    const updates = [], params = [];
    Object.entries(value).forEach(([k, v]) => { updates.push(`${k} = ?`); params.push(v); });
    if (!updates.length) return success(res, null, 'Nothing to update.');
    params.push(+req.params.id);
    await query(`UPDATE departments SET ${updates.join(', ')} WHERE id = ?`, params);
    return success(res, null, 'Department updated.');
  } catch (err) { next(err); }
});

// DELETE — always 403 (Req 12.5)
router.delete('/:id', authenticateToken, (req, res) => {
  return error(res, 403, 'FORBIDDEN', 'Department deletion is not supported.');
});

module.exports = router;
