'use strict';

const express = require('express');
const Joi = require('joi');
const router = express.Router();
const { query, getConnection } = require('../../config/db');
const { success, error } = require('../../shared/response');
const { authenticateToken, authorizeRoles } = require('../auth/authMiddleware');

const LOCALES = ['en', 'am', 'om'];
const contentSchema = Joi.array().items(Joi.object({
  key: Joi.string().pattern(/^[a-zA-Z0-9._-]+$/).max(120).required(),
  locale: Joi.string().valid(...LOCALES).required(),
  value: Joi.string().max(10000).allow('').required(),
}).unknown(false)).min(1).max(200).required();

router.get('/', async (req, res, next) => {
  const locale = req.query.locale || 'en';
  if (!LOCALES.includes(locale)) return error(res, 400, 'VALIDATION_ERROR', 'Unsupported content language.');
  try {
    const rows = await query(
      'SELECT content_key, content_value FROM public_content WHERE locale = ?',
      [locale]
    );
    return success(res, Object.fromEntries(rows.map(row => [row.content_key, row.content_value])));
  } catch (err) { next(err); }
});

router.get('/manage', authenticateToken, authorizeRoles('admin', 'super_admin'), async (req, res, next) => {
  try {
    const rows = await query(
      'SELECT content_key, locale, content_value, updated_at FROM public_content ORDER BY content_key, locale'
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

router.put('/manage', authenticateToken, authorizeRoles('admin', 'super_admin'), async (req, res, next) => {
  const { error: validationError, value } = contentSchema.validate(req.body, { abortEarly: false });
  if (validationError) {
    return error(res, 400, 'VALIDATION_ERROR', validationError.details[0].message,
      validationError.details.map(detail => ({ field: detail.path.join('.'), msg: detail.message })));
  }

  let connection;
  try {
    connection = await getConnection();
    await connection.beginTransaction();
    for (const entry of value) {
      await connection.execute(
        `INSERT INTO public_content (content_key, locale, content_value, updated_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE content_value = VALUES(content_value), updated_by = VALUES(updated_by)`,
        [entry.key, entry.locale, entry.value, req.user.userId]
      );
    }
    await connection.commit();
    return success(res, null, 'Public site content saved.');
  } catch (err) {
    if (connection) await connection.rollback();
    return next(err);
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
