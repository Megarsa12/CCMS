'use strict';
/**
 * Multer file upload configuration (Req 4.5–4.7, 4.10, 17.4, 18.6)
 * - Server-generated filenames (timestamp + 8 random hex bytes)
 * - MIME type whitelist enforced server-side
 * - Max 5 MB per file, max 5 files per request
 */

const multer = require('multer');
const path   = require('path');
const crypto = require('crypto');
const fs     = require('fs');

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const ALLOWED_EXTENSIONS = ['.jpg','.jpeg','.png','.webp','.gif','.pdf','.doc','.docx'];
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_MB || '5', 10) * 1024 * 1024;
const MAX_FILES     = parseInt(process.env.MAX_FILES_PER_COMPLAINT || '5', 10);
const UPLOAD_DIR    = path.resolve(process.env.UPLOAD_DIR || 'uploads');

// Ensure upload directory exists
const complaintsDir = path.join(UPLOAD_DIR, 'complaints');
if (!fs.existsSync(complaintsDir)) {
  fs.mkdirSync(complaintsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, complaintsDir);
  },
  // Server-generated name — never equal to originalname (Req 4.10)
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uniqueName + ext);
  },
});

// MIME type + extension filter (Req 18.6 — server-side validation)
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_MIME_TYPES.includes(file.mimetype) && ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    const err = new Error(`File "${file.originalname}" is not allowed. Accepted: JPG, PNG, WEBP, GIF, PDF, DOC, DOCX (max 5MB each).`);
    err.code  = 'INVALID_FILE_TYPE';
    cb(err, false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,  // 5 MB per file (Req 4.7)
    files:    MAX_FILES,      // max 5 files   (Req 4.6)
  },
});

module.exports = { upload, ALLOWED_MIME_TYPES, UPLOAD_DIR, complaintsDir };
