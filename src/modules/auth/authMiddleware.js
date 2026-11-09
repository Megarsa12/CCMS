'use strict';
/**
 * Authentication & RBAC middleware (Req 2.5, 2.6, 15.1–15.7)
 */

const jwt   = require('jsonwebtoken');
const { query } = require('../../config/db');

const VALID_ROLES = ['citizen', 'staff', 'admin', 'super_admin'];

/**
 * Validates JWT on every protected route before the handler executes (Req 15.1).
 * Returns 401 for missing, malformed, expired, blacklisted JWT, or invalid role claim.
 */
async function authenticateToken(req, res, next) {
  let token;

  // Support both Authorization: Bearer <token> and httpOnly cookie
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.cookies && req.cookies.ccms_token) {
    token = req.cookies.ccms_token;
  }

  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication token is required.' } });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Token is invalid or expired.' } });
  }

  // Validate role claim (Req 15.7)
  if (!decoded.role || !VALID_ROLES.includes(decoded.role)) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Token contains an unrecognised role.' } });
  }

  // Check JWT blacklist (logout invalidation — Req 2.7, 2.8)
  const tokenHash = require('crypto').createHash('sha256').update(token).digest('hex');
  const blacklisted = await query(
    'SELECT id FROM session_blacklist WHERE token_hash = ? AND expires_at > NOW()',
    [tokenHash]
  ).catch(() => []);

  if (blacklisted.length > 0) {
    return res.status(401).json({ success: false, error: { code: 'TOKEN_REVOKED', message: 'This session has been revoked. Please sign in again.' } });
  }

  req.user      = decoded;           // { userId, role, email }
  req.tokenHash = tokenHash;         // available for logout handler
  req.rawToken  = token;
  if (
    decoded.passwordChangeRequired
    && !(req.method === 'PUT' && req.originalUrl.split('?')[0].endsWith('/auth/change-password'))
  ) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'Change your temporary password before continuing.',
      },
    });
  }
  next();
}

/**
 * Role-based access control guard (Req 15.2).
 * Returns HTTP 403 when the authenticated user's role is not in allowedRoles.
 * JWT validation runs independently via authenticateToken (Req 15.6).
 *
 * @param {...string} allowedRoles
 */
function authorizeRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' } });
    }
    next();
  };
}

module.exports = { authenticateToken, authorizeRoles };
