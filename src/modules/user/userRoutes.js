'use strict';
const express = require('express');
const router  = express.Router();
const Joi     = require('joi');
const svc     = require('./userService');
const { success, created, error } = require('../../shared/response');
const { authenticateToken, authorizeRoles } = require('../auth/authMiddleware');
const notificationService = require('../notification/notificationService');

router.use(authenticateToken);

// List users (Req 11.6)
router.get('/', authorizeRoles('super_admin'), async (req, res, next) => {
  try {
    const { rows, total, page, limit } = await svc.listUsers(req.query);
    return success(res, rows, '', 200, { page, limit, total });
  } catch (err) { next(err); }
});

// Get single user
router.get('/:id', authorizeRoles('super_admin'), async (req, res, next) => {
  try {
    const u = await svc.getUserById(+req.params.id);
    return success(res, u);
  } catch (err) {
    if (err.statusCode===404) return error(res, 404, 'NOT_FOUND', err.message);
    next(err);
  }
});

// Create user (Req 11.1)
router.post('/', authorizeRoles('super_admin'), async (req, res, next) => {
  try {
    const schema = Joi.object({
      name:         Joi.string().min(2).max(100).required(),
      email:        Joi.string().email({ tlds: { allow: false } }).required(),
      password:     Joi.string().min(8).max(64).pattern(/[A-Z]/).pattern(/[a-z]/).pattern(/[0-9]/).required(),
      role:         Joi.string().valid('citizen','staff','admin','super_admin').required(),
      departmentId: Joi.number().integer().positive().optional(),
    });
    const { error: vErr, value } = schema.validate(req.body, { abortEarly: false });
    if (vErr) return error(res, 400, 'VALIDATION_ERROR', vErr.details[0].message, vErr.details.map(d=>({field:d.context?.key,msg:d.message})));
    const result = await svc.createUser(value);
    return created(res, result, 'User created successfully.');
  } catch (err) {
    if (err.code==='EMAIL_EXISTS') return error(res, 409, 'EMAIL_EXISTS', err.message);
    if (err.code === 'INVALID_DEPARTMENT') return error(res, 400, err.code, err.message);
    next(err);
  }
});

// Update the signed-in user's own editable profile fields.
router.put('/me', async (req, res, next) => {
  try {
    const schema = Joi.object({
      name: Joi.string().trim().min(2).max(100).required(),
      phone: Joi.string().trim().max(20).allow('').default(''),
    }).unknown(false);
    const { error: validationError, value } = schema.validate(req.body, { abortEarly: false });
    if (validationError) {
      return error(res, 400, 'VALIDATION_ERROR', validationError.details[0].message,
        validationError.details.map(detail => ({ field: detail.context?.key, msg: detail.message })));
    }

    const profile = await svc.updateOwnProfile(req.user.userId, value);
    if (profile.changed && ['citizen', 'staff'].includes(profile.role)) {
      notificationService.notifyAccountActivity(
        req.user.userId,
        'updated their profile details'
      ).catch(err => console.error('[Notify] profile change:', err.message));
    }
    delete profile.changed;
    return success(res, profile, 'Profile updated successfully.');
  } catch (err) {
    if (err.statusCode === 404) return error(res, 404, 'NOT_FOUND', err.message);
    next(err);
  }
});

// Update user (Req 11.2)
router.put('/:id', authorizeRoles('super_admin'), async (req, res, next) => {
  try {
    const schema = Joi.object({
      name: Joi.string().trim().min(2).max(100).optional(),
      email: Joi.string().trim().email({ tlds: { allow: false } }).max(150).optional(),
      temporaryPassword: Joi.string().min(8).max(64)
        .pattern(/[A-Z]/, 'uppercase letter')
        .pattern(/[a-z]/, 'lowercase letter')
        .pattern(/[0-9]/, 'digit')
        .optional()
        .messages({
          'string.min': 'Temporary password must be at least 8 characters long.',
          'string.max': 'Temporary password must not exceed 64 characters.',
          'string.pattern.name': 'Temporary password must contain at least one {#name}.',
        }),
      role: Joi.string().valid('citizen','staff','admin','super_admin').optional(),
      departmentId: Joi.number().integer().positive().allow(null).optional(),
      department_id: Joi.number().integer().positive().allow(null).optional(),
    }).min(1).unknown(false);
    const { error: validationError, value } = schema.validate(req.body, { abortEarly: false });
    if (validationError) {
      return error(res, 400, 'VALIDATION_ERROR', validationError.details[0].message,
        validationError.details.map(detail => ({ field: detail.context?.key, msg: detail.message })));
    }
    const departmentId = value.departmentId ?? value.department_id;
    const updates = { ...value };
    delete updates.department_id;
    if (departmentId !== undefined) updates.departmentId = departmentId;
    const result = await svc.updateUser(+req.params.id, updates);
    return success(
      res,
      null,
      result?.temporaryPasswordSent
        ? 'User updated and temporary password sent by email.'
        : 'User updated.'
    );
  } catch (err) {
    if (err.statusCode===404) return error(res, 404, 'NOT_FOUND', err.message);
    if (err.statusCode===400) return error(res, 400, 'VALIDATION_ERROR', err.message);
    if (err.code === 'EMAIL_EXISTS') return error(res, 409, err.code, err.message);
    if (err.code === 'EMAIL_NOT_CONFIGURED' || err.code === 'EMAIL_DELIVERY_FAILED') {
      return error(res, 503, err.code, err.message);
    }
    next(err);
  }
});

// Deactivate (Req 11.3, 11.5)
router.patch('/:id/deactivate', authorizeRoles('super_admin'), async (req, res, next) => {
  try {
    await svc.deactivateUser(+req.params.id);
    return success(res, null, 'User deactivated.');
  } catch (err) {
    if (err.statusCode===404) return error(res, 404, 'NOT_FOUND', err.message);
    next(err);
  }
});

// Reactivate
router.patch('/:id/reactivate', authorizeRoles('super_admin'), async (req, res, next) => {
  try {
    await svc.reactivateUser(+req.params.id);
    return success(res, null, 'User reactivated.');
  } catch (err) { next(err); }
});

module.exports = router;
