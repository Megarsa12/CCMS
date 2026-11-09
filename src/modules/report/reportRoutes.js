'use strict';
/**
 * Reporting & Analytics module (Req 14.1–14.6, Algorithm 6)
 */
const express   = require('express');
const router    = express.Router();
const NodeCache = require('node-cache');
const { query } = require('../../config/db');
const { success, error } = require('../../shared/response');
const { authenticateToken, authorizeRoles } = require('../auth/authMiddleware');

// 5-minute in-memory cache for dashboard stats (Req 21 — non-critical realtime)
const statsCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

router.use(authenticateToken);

/* ---- Citizen personal dashboard summary ---- */
router.get('/citizen-summary', authorizeRoles('citizen'), async (req, res, next) => {
  try {
    const [rows] = await query(`
      SELECT
        COUNT(*) AS total,
        SUM(status IN ('submitted','assigned','in_progress','escalated')) AS pending,
        SUM(status IN ('resolved','closed')) AS resolved,
        SUM(status = 'rejected') AS rejected
      FROM complaints
      WHERE citizen_id = ?
    `, [req.user.userId]);
    return success(res, rows[0] || { total:0, pending:0, resolved:0, rejected:0 });
  } catch (err) { next(err); }
});

// Citizens get 403 on all report endpoints (Req 14.6)
router.use(authorizeRoles('staff', 'admin', 'super_admin'));

/* ---- Admin dashboard summary ---- */
router.get('/summary', authorizeRoles('admin','super_admin'), async (req, res, next) => {
  try {
    const [summaryRows, statusRows] = await Promise.all([
      query(`
        SELECT
          (SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'citizen' AND u.is_active = 1) AS total_citizens,
          (SELECT COUNT(*) FROM complaints) AS total,
          (SELECT COUNT(*) FROM complaints WHERE DATE(submitted_at) = CURDATE()) AS today,
          (SELECT COUNT(*) FROM complaints WHERE priority IN ('high','urgent')) AS highPriority,
          (SELECT COUNT(*) FROM complaints WHERE status NOT IN ('resolved','closed','rejected')
             AND submitted_at < DATE_SUB(NOW(), INTERVAL 7 DAY)) AS overdue,
          (SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'staff' AND u.is_active = 1) AS active_staff,
          (SELECT COUNT(*) FROM departments WHERE is_active = 1) AS total_depts,
          (SELECT COUNT(*) FROM complaints WHERE status IN ('submitted','assigned','in_progress')) AS pending,
          (SELECT COUNT(*) FROM complaints WHERE status = 'resolved') AS resolved,
          (SELECT COUNT(*) FROM complaints WHERE status = 'closed') AS closed,
          COALESCE((SELECT ROUND(AVG(TIMESTAMPDIFF(HOUR, submitted_at, COALESCE(resolved_at, closed_at))) / 24, 1)
                    FROM complaints WHERE status IN ('resolved','closed')), 0) AS avg_resolution_days
      `),
      query('SELECT status, COUNT(*) AS count FROM complaints GROUP BY status'),
    ]);

    const summary = summaryRows[0] || {};
    return success(res, {
      ...summary,
      by_status: Object.fromEntries(statusRows.map(row => [row.status, Number(row.count)])),
    });
  } catch (err) { next(err); }
});

/* ---- Dashboard chart data ---- */
router.get('/by-month', authorizeRoles('admin','super_admin'), async (req, res, next) => {
  try {
    const rows = await query(`
      SELECT DATE_FORMAT(submitted_at, '%Y-%m') AS month, COUNT(*) AS count
      FROM complaints
      GROUP BY month
      ORDER BY month ASC
    `);
    return success(res, rows);
  } catch (err) { next(err); }
});

router.get('/by-category', authorizeRoles('admin','super_admin'), async (req, res, next) => {
  try {
    const rows = await query(`
      SELECT COALESCE(cat.name, 'Uncategorized') AS category, COUNT(c.id) AS count
      FROM complaints c
      LEFT JOIN complaint_categories cat ON cat.id = c.category_id
      GROUP BY cat.id, cat.name
      ORDER BY count DESC
    `);
    return success(res, rows);
  } catch (err) { next(err); }
});

/* ---- Staff personal dashboard summary ---- */
router.get('/staff-summary', authorizeRoles('staff'), async (req, res, next) => {
  try {
    const [rows] = await Promise.all([
      query(`
        SELECT
          COUNT(*) AS total,
          SUM(status = 'assigned') AS assigned,
          SUM(status = 'in_progress') AS active,
          SUM(status IN ('resolved','closed')) AS resolved,
          SUM(status = 'closed') AS closed,
          SUM(status = 'escalated') AS escalated,
          SUM(status = 'rejected') AS rejected,
          SUM(status = 'submitted') AS submitted,
          SUM(priority IN ('high','urgent')) AS urgent,
          SUM(status IN ('assigned','in_progress') AND submitted_at < DATE_SUB(NOW(), INTERVAL 7 DAY)) AS overdue,
          COALESCE(ROUND(AVG(CASE WHEN status IN ('resolved','closed')
            THEN TIMESTAMPDIFF(HOUR, submitted_at, COALESCE(resolved_at, closed_at)) END) / 24, 1), 0) AS avg_resolution_days
        FROM complaints
        WHERE assigned_to = (
          SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1
        )
      `, [req.user.email]),
    ]);

    const summary = rows[0] || {};
    const total = Number(summary.total) || 0;
    const resolved = Number(summary.resolved) || 0;
    return success(res, {
      ...summary,
      resolution_rate: total ? Math.round((resolved / total) * 100) : 0,
    });
  } catch (err) { next(err); }
});

/* ---- Dashboard stats (Req 14.1, 14.2) ---- */
router.get('/dashboard', async (req, res, next) => {
  try {
    const role    = req.user.role;
    const cacheKey = `dashboard_${role}_${req.user.userId}`;
    const cached   = statsCache.get(cacheKey);
    if (cached) return success(res, cached);

    // Scope: staff sees own dept only (Req 14.2)
    let deptFilter = '', deptParam = [];
    if (role === 'staff') {
      const [u] = await query('SELECT department_id FROM users WHERE id = ?', [req.user.userId]);
      if (u?.department_id) {
        deptFilter = 'WHERE department_id = ?';
        deptParam  = [u.department_id];
      }
    }

    const statusBreakdown = await query(
      `SELECT status, COUNT(*) AS count FROM complaints ${deptFilter} GROUP BY status`,
      deptParam
    );

    const avgWhere = deptFilter
      ? `WHERE department_id = ? AND status IN ('resolved','closed')`
      : `WHERE status IN ('resolved','closed')`;
    const avgParams = deptFilter ? deptParam : [];

    const [avgRow] = await query(
      `SELECT AVG(TIMESTAMPDIFF(HOUR, submitted_at, IFNULL(resolved_at, closed_at))) AS avg_hours
       FROM complaints ${avgWhere}`,
      avgParams
    );

    const monthlyTrends = await query(
      `SELECT DATE_FORMAT(submitted_at,'%Y-%m') AS month, COUNT(*) AS count
       FROM complaints ${deptFilter}
       GROUP BY month ORDER BY month DESC LIMIT 12`,
      deptParam
    );

    const data = {
      statusBreakdown,
      avgResolutionHours: parseFloat(avgRow?.avg_hours || 0).toFixed(2),
      monthlyTrends: monthlyTrends.reverse(),
    };

    statsCache.set(cacheKey, data);
    return success(res, data);
  } catch (err) { next(err); }
});

/* ---- By department (Req 14.3) ---- */
router.get('/by-department', authorizeRoles('admin','super_admin'), async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT d.id, d.name AS department_name, COUNT(c.id) AS total_complaints
       FROM departments d LEFT JOIN complaints c ON c.department_id = d.id
       GROUP BY d.id, d.name ORDER BY total_complaints DESC`
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

/* ---- Resolution time (Req 14.4) ---- */
router.get('/resolution-time', authorizeRoles('admin','super_admin'), async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT d.name AS department_name,
              ROUND(AVG(TIMESTAMPDIFF(HOUR, c.submitted_at, IFNULL(c.resolved_at,c.closed_at))),2) AS avg_hours
       FROM complaints c JOIN departments d ON d.id=c.department_id
       WHERE c.status IN ('resolved','closed')
       GROUP BY d.id, d.name ORDER BY avg_hours ASC`
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

/* ---- Monthly trends ---- */
router.get('/monthly-trends', async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT DATE_FORMAT(submitted_at,'%Y-%m') AS month, COUNT(*) AS count
       FROM complaints
       WHERE submitted_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
       GROUP BY month ORDER BY month ASC`
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

/* ---- CSV Export (Req 14.5) ---- */
router.get('/export', authorizeRoles('admin','super_admin'), async (req, res, next) => {
  try {
    const { status, department, from, to } = req.query;
    const conditions = [], params = [];
    if (status)     { conditions.push('c.status = ?');      params.push(status); }
    if (department) { conditions.push('c.department_id = ?'); params.push(+department); }
    if (from)       { conditions.push('c.submitted_at >= ?'); params.push(from); }
    if (to)         { conditions.push('c.submitted_at <= ?'); params.push(to + ' 23:59:59'); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await query(
      `SELECT c.tracking_number, c.title, c.status, cat.name AS category,
              d.name AS department_name, cit.name AS citizen_name,
              c.submitted_at, c.resolved_at
       FROM complaints c
       LEFT JOIN complaint_categories cat ON cat.id=c.category_id
       LEFT JOIN departments d   ON d.id=c.department_id
       LEFT JOIN users cit       ON cit.id=c.citizen_id
       ${where}
       ORDER BY c.submitted_at DESC`,
      params
    );

    // Build CSV (Req 14.5 — minimum required columns)
    const headers = ['Tracking Number','Title','Status','Category','Department','Citizen Name','Submitted At','Resolved At'];
    const csvLines = [
      headers.join(','),
      ...rows.map(r => [
        `"${r.tracking_number}"`,
        `"${(r.title||'').replace(/"/g,'""')}"`,
        `"${r.status}"`,
        `"${r.category||''}"`,
        `"${r.department_name||''}"`,
        `"${(r.citizen_name||'').replace(/"/g,'""')}"`,
        `"${r.submitted_at||''}"`,
        `"${r.resolved_at||''}"`,
      ].join(','))
    ];

    const filename = `ccms-export-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csvLines.join('\n'));
  } catch (err) { next(err); }
});

module.exports = router;
