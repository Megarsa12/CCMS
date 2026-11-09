'use strict';
/**
 * Auth service — registration, login, password reset (Algorithms 1 & 2 from design.md)
 * Requirements: 1.1–1.7, 2.1–2.8, 3.1–3.6
 */

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { query, getConnection } = require('../../config/db');
const { isEmailConfigured } = require('../../config/email');
const {
  generatePasswordResetCode,
  sendPasswordResetCode,
} = require('../../services/emailService');

const SALT_ROUNDS = 12;  // Req 18.4
const GENERIC_LOGIN_ERROR = 'Invalid email or password.';  // Uniform message (Req 2.2)

async function ensureCitizenProfileColumns() {
  const columns = await query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'citizens'"
  );
  const existing = new Set(columns.map((col) => col.COLUMN_NAME));

  if (!existing.has('phone')) {
    await query('ALTER TABLE citizens ADD COLUMN phone VARCHAR(20) NULL');
  }
  if (!existing.has('gender')) {
    await query("ALTER TABLE citizens ADD COLUMN gender ENUM('male','female','other','prefer_not_to_say') NULL");
  }
  if (!existing.has('preferred_language')) {
    await query("ALTER TABLE citizens ADD COLUMN preferred_language VARCHAR(32) NULL DEFAULT 'en'");
  }
}

/* =====================================================================
   REGISTRATION (Req 1.1 – 1.6)
===================================================================== */
async function registerUser({
  name,
  first_name,
  last_name,
  email,
  password,
  phone,
  gender,
  language,
}) {
  const normalizedFirst = (first_name || '').trim();
  const normalizedLast = (last_name || '').trim();
  const fallbackName = (name || '').trim();
  const fullName = [normalizedFirst, normalizedLast].filter(Boolean).join(' ') || fallbackName || 'Citizen';
  const normalizedEmail = (email || '').trim().toLowerCase();
  const normalizedPhone = (phone || '').trim();
  const normalizedGender = (gender || 'prefer_not_to_say').toLowerCase();
  const normalizedLanguage = (language || 'en').toLowerCase();

  // Check email uniqueness (case-insensitive — Req 1.2)
  const existing = await query(
    'SELECT id FROM users WHERE LOWER(email) = LOWER(?)',
    [normalizedEmail]
  );
  if (existing.length > 0) {
    const err = new Error('This email address is already registered.');
    err.statusCode = 409;
    err.code = 'EMAIL_EXISTS';
    throw err;
  }

  // Hash password — never store plaintext (Req 1.5)
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  // Get citizen role ID
  const [citizenRole] = await query("SELECT id FROM roles WHERE name = 'citizen'");

  const conn = await getConnection();
  await conn.beginTransaction();
  try {
    await ensureCitizenProfileColumns();

    const [result] = await conn.execute(
      'INSERT INTO users (name, email, password_hash, role_id) VALUES (?, ?, ?, ?)',
      [fullName, normalizedEmail, passwordHash, citizenRole.id]
    );
    const userId = result.insertId;

    // Create citizens profile row
    await conn.execute(
      'INSERT INTO citizens (user_id, phone, gender, preferred_language) VALUES (?, ?, ?, ?)',
      [userId, normalizedPhone || null, normalizedGender, normalizedLanguage]
    );

    await conn.commit();
    return { userId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* =====================================================================
   LOGIN (Req 2.1 – 2.4)
===================================================================== */
async function loginUser({ email, password }) {
  // Uniform error to prevent user enumeration (Req 2.2)
  const [user] = await query(
    `SELECT u.id, u.name, u.email, u.password_hash, u.is_active, u.department_id,
            u.must_change_password,
            r.name AS role
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE LOWER(u.email) = LOWER(?)`,
    [email]
  );

  if (!user) {
    const err = new Error(GENERIC_LOGIN_ERROR);
    err.statusCode = 401; err.code = 'INVALID_CREDENTIALS';
    throw err;
  }

  // Deactivated account (Req 2.3)
  if (!user.is_active) {
    const err = new Error('This account has been deactivated. Please contact the administrator.');
    err.statusCode = 403; err.code = 'ACCOUNT_DEACTIVATED';
    throw err;
  }

  // Constant-time password comparison (Req 2.1)
  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    const err = new Error(GENERIC_LOGIN_ERROR);
    err.statusCode = 401; err.code = 'INVALID_CREDENTIALS';
    throw err;
  }

  // Issue JWT (Req 2.1, 2.4)
  const token = jwt.sign(
    {
      userId: user.id,
      role: user.role,
      email: user.email,
      passwordChangeRequired: Boolean(user.must_change_password),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
  );

  // Update last login timestamp
  await query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

  return {
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      departmentId: user.department_id,
      passwordChangeRequired: Boolean(user.must_change_password),
    },
  };
}

/* =====================================================================
   LOGOUT — blacklist the token (Req 2.7, 2.8)
===================================================================== */
async function logoutUser(userId, tokenHash, expiresAt) {
  await query(
    'INSERT IGNORE INTO session_blacklist (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [userId, tokenHash, new Date(expiresAt * 1000)]
  );
}

/* =====================================================================
   FORGOT PASSWORD (Req 3.1, 3.5, 3.6)
===================================================================== */
async function forgotPassword(email) {
  if (!isEmailConfigured()) {
    const err = new Error('Password reset email is not configured. Contact the system administrator.');
    err.statusCode = 503;
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }

  // Always return success-like response to prevent user enumeration (Req 3.5)
  const [user] = await query(
    'SELECT id, name FROM users WHERE LOWER(email) = LOWER(?)',
    [email]
  );
  if (!user) return;  // Silent — no email sent, no error

  // Six-digit code is stored in the existing single-use reset-token table.
  const token     = generatePasswordResetCode();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await query(
    'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
    [user.id, token, expiresAt]
  );

  const delivery = await sendPasswordResetCode({ email, name: user.name, code: token });

  if (!delivery.success) {
    await query(
      'UPDATE password_reset_tokens SET is_used = 1 WHERE user_id = ? AND token = ?',
      [user.id, token]
    );
    const err = new Error('Unable to send the reset email right now. Please try again later or contact the system administrator.');
    err.statusCode = 503;
    err.code = 'EMAIL_DELIVERY_FAILED';
    throw err;
  }
}

/* =====================================================================
   RESET PASSWORD (Req 3.2 – 3.4)
===================================================================== */
async function resetPassword(token, newPassword) {
  // Find valid, unused, unexpired token
  const [row] = await query(
    'SELECT id, user_id FROM password_reset_tokens WHERE token = ? AND is_used = 0 AND expires_at > NOW()',
    [token]
  );
  if (!row) {
    const err = new Error('Reset token is invalid or has expired.');
    err.statusCode = 400; err.code = 'INVALID_TOKEN';
    throw err;
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  const conn = await getConnection();
  await conn.beginTransaction();
  try {
    await conn.execute(
      'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
      [passwordHash, row.user_id]
    );
    await conn.execute('UPDATE password_reset_tokens SET is_used = 1 WHERE id = ?', [row.id]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function changePassword(userId, currentPassword, newPassword) {
  const [user] = await query(
    'SELECT password_hash FROM users WHERE id = ?',
    [userId]
  );
  if (!user) {
    const err = new Error('User not found.');
    err.statusCode = 404;
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
  if (!isMatch) {
    const err = new Error('Current password is incorrect.');
    err.statusCode = 400;
    err.code = 'INVALID_CURRENT_PASSWORD';
    throw err;
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await query(
    'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
    [passwordHash, userId]
  );
}

/* =====================================================================
   GET PROFILE
===================================================================== */
async function getProfile(userId) {
  const [user] = await query(
        `SELECT u.id, u.name, u.email, u.is_active, u.created_at, u.last_login_at,
          r.name AS role, u.department_id, d.name AS department_name,
          COALESCE(c.phone, s.phone, a.phone) AS phone,
          s.employee_id, COALESCE(s.designation, a.designation) AS designation,
          a.access_level, s.is_available, s.current_load
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN departments d ON d.id = u.department_id
     LEFT JOIN citizens c ON c.user_id = u.id
         LEFT JOIN staff s ON s.user_id = u.id
         LEFT JOIN administrators a ON a.user_id = u.id
     WHERE u.id = ?`,
    [userId]
  );
  if (!user) {
    const err = new Error('User not found.'); err.statusCode = 404; throw err;
  }
  return user;
}

module.exports = {
  registerUser,
  loginUser,
  logoutUser,
  forgotPassword,
  resetPassword,
  changePassword,
  getProfile,
};
