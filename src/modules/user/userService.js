'use strict';
/**
 * User management service (Req 11.1–11.6)
 */

const bcrypt = require('bcryptjs');
const { query, getConnection } = require('../../config/db');
const { isEmailConfigured } = require('../../config/email');
const { sendTemporaryPassword } = require('../../services/emailService');

async function listUsers(filters) {
  const { page = 1, limit = 20, role, departmentId, isActive, search } = filters;
  const maxLimit = 100;
  const safeLimit = Math.min(parseInt(limit, 10), maxLimit);
  const offset    = (parseInt(page, 10) - 1) * safeLimit;
  const conditions = [], params = [];

  if (role)         { conditions.push('r.name = ?');             params.push(role); }
  if (departmentId) { conditions.push('u.department_id = ?');    params.push(departmentId); }
  if (isActive !== undefined && isActive !== '') {
                      conditions.push('u.is_active = ?');        params.push(+isActive); }
  if (search)       {
    conditions.push('(u.name LIKE ? OR u.email LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [{ total }] = await query(
    `SELECT COUNT(*) AS total FROM users u JOIN roles r ON r.id=u.role_id ${where}`, params
  );
  const rows = await query(
    `SELECT u.id, u.id AS user_id, u.name, u.email, r.name AS role, u.department_id,
            d.name AS department_name, u.is_active, u.created_at, u.last_login_at
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN departments d ON d.id = u.department_id
     ${where}
     ORDER BY u.created_at DESC
     LIMIT ${safeLimit} OFFSET ${offset}`,
    params
  );
  return { rows, total: parseInt(total, 10), page: parseInt(page, 10), limit: safeLimit };
}

async function getUserById(userId) {
  const [user] = await query(
    `SELECT u.id, u.name, u.email, r.name AS role, u.department_id,
            d.name AS department_name, u.is_active, u.created_at, u.last_login_at
     FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN departments d ON d.id=u.department_id
     WHERE u.id = ?`,
    [userId]
  );
  if (!user) { const e=new Error('User not found.'); e.statusCode=404; throw e; }
  return user;
}

async function createUser({ name, email, password, role, departmentId }) {
  // Check email uniqueness
  const [ex] = await query('SELECT id FROM users WHERE LOWER(email)=LOWER(?)', [email]);
  if (ex) { const e=new Error('Email already exists.'); e.statusCode=409; e.code='EMAIL_EXISTS'; throw e; }

  const [roleRow] = await query('SELECT id FROM roles WHERE name = ?', [role]);
  if (!roleRow) { const e=new Error('Invalid role.'); e.statusCode=400; throw e; }

  const passwordHash = await bcrypt.hash(password, 12);
  const conn = await getConnection();
  await conn.beginTransaction();
  try {
    const [res] = await conn.execute(
      'INSERT INTO users (name, email, password_hash, role_id, department_id) VALUES (?, ?, ?, ?, ?)',
      [name, email.toLowerCase(), passwordHash, roleRow.id, departmentId || null]
    );
    const userId = res.insertId;
    // Create role-specific profile row
    if (role === 'citizen')     await conn.execute('INSERT INTO citizens (user_id) VALUES (?)', [userId]);
    if (role === 'staff')       await conn.execute('INSERT INTO staff (user_id) VALUES (?)', [userId]);
    if (role === 'admin' || role === 'super_admin') {
      await conn.execute(
        "INSERT INTO administrators (user_id, access_level) VALUES (?, ?)",
        [userId, role === 'super_admin' ? 'system' : 'department']
      );
    }
    await conn.commit();
    return { userId };
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
}

async function updateUser(userId, { name, email, temporaryPassword, departmentId, role }) {
  let target;
  if (email !== undefined || temporaryPassword !== undefined) {
    [target] = await query(
      `SELECT u.name, u.email, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      [userId]
    );
    if (!target) { const e = new Error('User not found.'); e.statusCode = 404; throw e; }
    const targetRole = role ?? target.role;
    if (!['citizen', 'staff'].includes(targetRole)) {
      const e = new Error('Email and temporary password recovery is available only for citizen and staff accounts.');
      e.statusCode = 400;
      throw e;
    }
  }

  const updates = [], params = [];
  if (name !== undefined)         { updates.push('name = ?');          params.push(name); }
  if (email !== undefined) {
    const normalizedEmail = email.trim().toLowerCase();
    const [existing] = await query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id <> ?',
      [normalizedEmail, userId]
    );
    if (existing) {
      const e = new Error('Email already exists.');
      e.statusCode = 409;
      e.code = 'EMAIL_EXISTS';
      throw e;
    }
    updates.push('email = ?');
    params.push(normalizedEmail);
  }
  if (temporaryPassword !== undefined) {
    if (!isEmailConfigured()) {
      const e = new Error('Email delivery is not configured. The temporary password was not changed.');
      e.statusCode = 503;
      e.code = 'EMAIL_NOT_CONFIGURED';
      throw e;
    }
    updates.push('password_hash = ?', 'must_change_password = 1');
    params.push(await bcrypt.hash(temporaryPassword, 12));
  }
  if (departmentId !== undefined) { updates.push('department_id = ?'); params.push(departmentId || null); }
  if (role !== undefined) {
    const [r] = await query('SELECT id FROM roles WHERE name=?', [role]);
    if (!r) { const e=new Error('Invalid role.'); e.statusCode=400; throw e; }
    updates.push('role_id = ?'); params.push(r.id);
  }
  if (!updates.length) return;
  params.push(userId);
  if (temporaryPassword !== undefined) {
    const connection = await getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
      const delivery = await sendTemporaryPassword({
        email: email === undefined ? target.email : email.trim().toLowerCase(),
        name: name ?? target.name,
        password: temporaryPassword,
      });
      if (!delivery.success) {
        const e = new Error('The temporary password email could not be sent. The account was not changed.');
        e.statusCode = 503;
        e.code = 'EMAIL_DELIVERY_FAILED';
        throw e;
      }
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
    return { temporaryPasswordSent: true };
  }

  await query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
  return { temporaryPasswordSent: false };
}

async function updateOwnProfile(userId, { name, phone }) {
  const conn = await getConnection();
  await conn.beginTransaction();
  try {
    const [existing] = await conn.execute(
      `SELECT u.id, u.name, r.name AS role, COALESCE(c.phone, s.phone, a.phone) AS phone
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN citizens c ON c.user_id = u.id
       LEFT JOIN staff s ON s.user_id = u.id
       LEFT JOIN administrators a ON a.user_id = u.id
       WHERE u.id = ? AND u.is_active = 1`,
      [userId]
    );
    if (!existing[0]) {
      const err = new Error('User not found.');
      err.statusCode = 404;
      throw err;
    }

    const changed = existing[0].name !== name || (existing[0].phone || '') !== (phone || '');
    await conn.execute('UPDATE users SET name = ? WHERE id = ?', [name, userId]);
    const profileTable = {
      citizen: 'citizens',
      staff: 'staff',
      admin: 'administrators',
      super_admin: 'administrators',
    }[existing[0].role];
    await conn.execute(
      `INSERT INTO ${profileTable} (user_id, phone) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE phone = VALUES(phone)`,
      [userId, phone || null]
    );

    const [profiles] = await conn.execute(
      `SELECT u.id, u.name, u.email, r.name AS role, u.department_id, p.phone
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN citizens c ON c.user_id = u.id
       LEFT JOIN staff s ON s.user_id = u.id
       LEFT JOIN administrators a ON a.user_id = u.id
       LEFT JOIN ${profileTable} p ON p.user_id = u.id
       WHERE u.id = ?`,
      [userId]
    );
    await conn.commit();
    return { ...profiles[0], changed };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Req 11.3, 11.5 — deactivation only, no hard delete
async function deactivateUser(userId) {
  const [u] = await query('SELECT id FROM users WHERE id = ?', [userId]);
  if (!u) { const e=new Error('User not found.'); e.statusCode=404; throw e; }
  await query('UPDATE users SET is_active = 0 WHERE id = ?', [userId]);
}

async function reactivateUser(userId) {
  await query('UPDATE users SET is_active = 1 WHERE id = ?', [userId]);
}

module.exports = { listUsers, getUserById, createUser, updateUser, updateOwnProfile, deactivateUser, reactivateUser };
