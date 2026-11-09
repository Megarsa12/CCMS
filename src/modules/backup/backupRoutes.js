'use strict';

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../auth/authMiddleware');
const { createBackup, restoreBackup } = require('./backupService');
const { error } = require('../../shared/response');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

router.use(authenticateToken, authorizeRoles('super_admin'));

router.get('/', async (req, res, next) => {
  try {
    const backup = await createBackup();
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="ccms-backup-${date}.json"`);
    return res.send(JSON.stringify(backup, (key, value) => (
      typeof value === 'bigint' ? value.toString() : value
    )));
  } catch (err) {
    return next(err);
  }
});

router.post('/restore', (req, res, next) => {
  upload.single('backup')(req, res, async (uploadError) => {
    if (uploadError) {
      if (uploadError.code === 'LIMIT_FILE_SIZE') {
        return error(res, 413, 'BACKUP_TOO_LARGE', 'Backup files must be 100 MB or smaller.');
      }
      return next(uploadError);
    }
    if (!req.file) {
      return error(res, 400, 'BACKUP_REQUIRED', 'Select a backup JSON file to restore.');
    }

    let backup;
    try {
      backup = JSON.parse(req.file.buffer.toString('utf8'));
    } catch {
      return error(res, 400, 'INVALID_BACKUP', 'The selected file is not valid JSON.');
    }

    try {
      await restoreBackup(backup);
      return res.json({ success: true, message: 'Database restored successfully.' });
    } catch (err) {
      if (err.statusCode === 400) {
        return error(res, 400, 'INVALID_BACKUP', err.message);
      }
      return next(err);
    }
  });
});

module.exports = router;
