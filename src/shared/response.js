'use strict';
/**
 * Standard Response Envelope helpers (Req 16.1 – 16.5)
 *
 * Every API response uses one of these helpers so the envelope format
 * is consistent across all controllers.
 */

/**
 * Send a success response.
 * @param {import('express').Response} res
 * @param {*}      data    Payload object or array
 * @param {string} message Optional human-readable message
 * @param {number} status  HTTP status code (default 200)
 * @param {object} meta    Pagination meta { page, limit, total }
 */
function success(res, data, message = '', status = 200, meta = null) {
  const body = { success: true, data };
  if (message) body.message = message;
  if (meta)    body.meta    = meta;
  return res.status(status).json(body);
}

/**
 * Send a created (201) response.
 */
function created(res, data, message = '') {
  return success(res, data, message, 201);
}

/**
 * Send an error response.
 * @param {import('express').Response} res
 * @param {number} status   HTTP status code
 * @param {string} code     Machine-readable error code (e.g. VALIDATION_ERROR)
 * @param {string} message  Human-readable error message
 * @param {Array}  details  Array of field-level error objects (for 400s)
 */
function error(res, status, code, message, details = []) {
  const body = { success: false, error: { code, message } };
  if (details.length) body.error.details = details;
  return res.status(status).json(body);
}

module.exports = { success, created, error };
