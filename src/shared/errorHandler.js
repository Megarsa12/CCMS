'use strict';
/**
 * Global Express error handler (Req 22.1 – 22.4)
 * Catches all unhandled errors from route handlers and middleware.
 * Never exposes stack traces or internal paths to the client.
 */

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  // Log with ISO 8601 timestamp (Req 22.2)
  console.error(`[${new Date().toISOString()}] ERROR ${req.method} ${req.originalUrl}:`, err.stack || err.message);

  // JWT verification failure
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Authentication token is invalid or expired.' } });
  }

  // Joi validation error (thrown manually with err.isJoi)
  if (err.isJoi || err.name === 'ValidationError') {
    const details = err.details ? err.details.map(d => ({ field: d.context?.key, msg: d.message })) : [];
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message, details } });
  }

  // MySQL duplicate entry
  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ success: false, error: { code: 'DUPLICATE_ENTRY', message: 'A resource with this value already exists.' } });
  }

  // MySQL connection error
  if (err.code === 'ECONNREFUSED' || err.code === 'ER_ACCESS_DENIED_ERROR') {
    return res.status(503).json({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database service is temporarily unavailable.' } });
  }

  // File too large (Multer)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, error: { code: 'FILE_TOO_LARGE', message: `File exceeds the ${process.env.MAX_FILE_SIZE_MB || 5} MB limit.` } });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ success: false, error: { code: 'TOO_MANY_FILES', message: 'Maximum 5 files allowed per complaint.' } });
  }

  // Generic 500 — no internal details in response (Req 22.3)
  return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred. Please try again later.' } });
}

module.exports = errorHandler;
