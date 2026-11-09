'use strict';
/**
 * MySQL connection pool — mysql2/promise
 * Credentials loaded exclusively from environment variables (Req 18.5)
 */

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:             process.env.DB_HOST     || 'localhost',
  port:             parseInt(process.env.DB_PORT || '3306', 10),
  user:             process.env.DB_USER,
  password:         process.env.DB_PASS,
  database:         process.env.DB_NAME,
  connectionLimit:  parseInt(process.env.DB_POOL_LIMIT || '10', 10),
  waitForConnections: true,
  queueLimit:       0,
  timezone:         'Z',         // Store/retrieve timestamps as UTC
  charset:          'utf8mb4',
});

/**
 * Convenience wrapper — returns rows array directly.
 * Always uses parameterized queries to prevent SQL injection (Req 17.3).
 *
 * @param {string}  sql    Parameterized SQL string
 * @param {Array}   params Bound parameter values
 * @returns {Promise<Array>}
 */
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * Returns a raw connection for manual transaction management.
 * Caller is responsible for conn.beginTransaction(), commit(), rollback(), release().
 */
async function getConnection() {
  return pool.getConnection();
}

module.exports = { pool, query, getConnection };
