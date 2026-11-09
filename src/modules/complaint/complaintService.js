'use strict';
/**
 * Complaint service — core business logic.
 * Implements Algorithms 3, 4, 5 from design.md
 * Requirements: 4, 5, 6, 7, 8, 9, 10, 19
 */

const { query, getConnection } = require('../../config/db');
const fs = require('fs/promises');
const path = require('path');
const WordExtractor = require('word-extractor');
const { complaintsDir } = require('../../shared/uploadMiddleware');

/* =====================================================================
   TRACKING NUMBER GENERATION (Algorithm 5 — Req 4.2)
===================================================================== */
async function generateTrackingNumber() {
  const today   = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');

  const [row] = await query(
    "SELECT COUNT(*) AS cnt FROM complaints WHERE DATE(submitted_at) = CURDATE()"
  );
  let seq = (row.cnt || 0) + 1;

  // Daily overflow guard
  if (seq > 99999) {
    const err = new Error('Daily complaint submission limit reached. Please try again tomorrow.');
    err.statusCode = 503; err.code = 'DAILY_LIMIT_EXCEEDED';
    throw err;
  }

  const candidate = `CC-${dateStr}-${String(seq).padStart(5, '0')}`;

  // Collision guard (race condition protection)
  const [exists] = await query(
    'SELECT id FROM complaints WHERE tracking_number = ?',
    [candidate]
  );
  if (exists) {
    seq++;
    return `CC-${dateStr}-${String(seq).padStart(5, '0')}`;
  }
  return candidate;
}

/* =====================================================================
   STATUS TRANSITION VALIDATION (Algorithm 4 — Req 8.1–8.3)
===================================================================== */
const TRANSITIONS = {
  submitted: {
    admin:       ['assigned', 'rejected'],
    super_admin: ['assigned', 'rejected'],
  },
  assigned: {
    staff:       ['in_progress'],
    admin:       ['in_progress', 'rejected'],
    super_admin: ['in_progress', 'rejected'],
  },
  in_progress: {
    staff:       ['resolved', 'escalated'],
    admin:       ['resolved', 'escalated'],
    super_admin: ['resolved', 'escalated', 'assigned'],
  },
  resolved: {
    admin:       ['closed'],
    super_admin: ['closed'],
    citizen:     ['closed'],
  },
  closed:   {},
  rejected: {},
  escalated: {
    admin:       ['assigned', 'rejected'],
    super_admin: ['assigned', 'rejected'],
  },
};

function validateStatusTransition(currentStatus, newStatus, actorRole) {
  const allowed = TRANSITIONS[currentStatus]?.[actorRole] || [];
  if (allowed.includes(newStatus)) return { valid: true };
  return {
    valid:  false,
    reason: `Transition from '${currentStatus}' to '${newStatus}' is not permitted for role '${actorRole}'.`,
  };
}

/* =====================================================================
   SUBMIT COMPLAINT (Algorithm 3 — Req 4.1–4.10)
===================================================================== */
async function submitComplaint(citizenId, payload, files = []) {
  // Verify department exists and is active (Req 4.8)
  const [dept] = await query(
    'SELECT id FROM departments WHERE id = ? AND is_active = 1',
    [payload.departmentId]
  );
  if (!dept) {
    const err = new Error('The selected department does not exist or is inactive.');
    err.statusCode = 400; err.code = 'INVALID_DEPARTMENT';
    throw err;
  }

  // Map frontend category value → DB code
  const CATEGORY_VALUE_TO_CODE = {
    roads:'INFRA', water:'WATER', electricity:'ELEC', waste:'SANIT',
    drainage:'DRAIN', health:'HEALTH', education:'EDU', land:'LAND',
    construction:'CONST', environment:'ENV', public_safety:'PSAFE',
    corruption:'CORRUPT', noise:'NOISE', street_lights:'LIGHT', other:'GEN',
  };
  const dbCode = CATEGORY_VALUE_TO_CODE[payload.category] || payload.category.toUpperCase();

  // Get category id — match by code
  const [cat] = await query(
    'SELECT id FROM complaint_categories WHERE code = ?',
    [dbCode]
  ).catch(() => [null]);

  const trackingNumber = await generateTrackingNumber();

  const conn = await getConnection();
  await conn.beginTransaction();
  try {
    // INSERT complaint
    const [result] = await conn.execute(
      `INSERT INTO complaints
         (tracking_number, citizen_id, department_id, category_id, title, description, location, priority, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted')`,
      [
        trackingNumber, citizenId, payload.departmentId,
        cat ? cat.id : null,
        payload.title, payload.description,
        payload.location || null,
        payload.priority || 'medium',
      ]
    );
    const complaintId = result.insertId;

    // Initial history row (Req 19.2)
    await conn.execute(
      `INSERT INTO complaint_status_history
         (complaint_id, changed_by, old_status, new_status, note, is_internal_note)
       VALUES (?, ?, NULL, 'submitted', 'Complaint submitted by citizen.', 0)`,
      [complaintId, citizenId]
    );

    // Attachment rows (Req 4.10 — stored_name != original_name)
    for (const file of files) {
      await conn.execute(
        `INSERT INTO attachments
           (complaint_id, original_name, stored_name, file_path, mime_type, file_size_bytes, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [complaintId, file.originalname, file.filename, file.path, file.mimetype, file.size, citizenId]
      );
    }

    await conn.commit();
    return { complaintId, trackingNumber };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* =====================================================================
   GET COMPLAINT (Req 5, 6.2, 6.3)
===================================================================== */
async function getComplaintById(complaintId, actorId, actorRole) {
  const [c] = await query(
    `SELECT c.*, cat.name AS category_name, cat.code AS category_code,
            d.name AS department_name,
            cit.name AS citizen_name, cit.email AS citizen_email,
            st.name AS assigned_to_name
     FROM complaints c
     LEFT JOIN complaint_categories cat ON cat.id = c.category_id
     LEFT JOIN departments d ON d.id = c.department_id
     LEFT JOIN users cit ON cit.id = c.citizen_id
     LEFT JOIN users st  ON st.id  = c.assigned_to
     WHERE c.id = ?`,
    [complaintId]
  );

  if (!c) {
    const err = new Error('Complaint not found.'); err.statusCode = 404; err.code = 'NOT_FOUND'; throw err;
  }

  // Ownership check for citizens (Req 6.3)
  if (actorRole === 'citizen' && c.citizen_id !== actorId) {
    const err = new Error('You do not have permission to view this complaint.');
    err.statusCode = 403; err.code = 'FORBIDDEN'; throw err;
  }
  // Fetch history
  const history = await query(
    `SELECT h.*, u.name AS actor_name
     FROM complaint_status_history h
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.complaint_id = ?
     ORDER BY h.changed_at ASC`,
    [complaintId]
  );

  // Citizens do not see internal notes (Req 10.2)
  const filteredHistory = actorRole === 'citizen'
    ? history.filter(h => !h.is_internal_note)
    : history;

  // Fetch attachments
  const attachments = await query(
    'SELECT id, original_name, stored_name, file_path, mime_type, file_size_bytes, uploaded_at FROM attachments WHERE complaint_id = ?',
    [complaintId]
  );

  return { ...c, history: filteredHistory, attachments };
}

async function getLegacyWordAttachmentText(complaintId, attachmentId, actorId, actorRole) {
  const complaint = await getComplaintById(complaintId, actorId, actorRole);
  const attachment = complaint.attachments.find(item => Number(item.id) === Number(attachmentId));
  if (!attachment) {
    const err = new Error('Attachment not found.');
    err.statusCode = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const storedName = path.basename(attachment.stored_name);
  if (path.extname(storedName).toLowerCase() !== '.doc') {
    const err = new Error('In-app text preview is only available for legacy .doc files.');
    err.statusCode = 415;
    err.code = 'UNSUPPORTED_PREVIEW';
    throw err;
  }

  const filePath = path.join(complaintsDir, storedName);
  const resolvedPath = path.resolve(filePath);
  if (path.dirname(resolvedPath) !== path.resolve(complaintsDir)) {
    const err = new Error('Invalid attachment path.');
    err.statusCode = 400;
    err.code = 'INVALID_ATTACHMENT_PATH';
    throw err;
  }

  try {
    await fs.access(resolvedPath);
  } catch {
    const err = new Error('Attachment file is missing.');
    err.statusCode = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const document = await new WordExtractor().extract(resolvedPath);
  return { text: document.getBody() };
}

async function getComplaintByTracking(trackingNumber) {
  const [c] = await query(
    `SELECT c.id, c.tracking_number, c.title, c.status, cat.name AS category,
            d.name AS department_name, c.submitted_at, c.priority
     FROM complaints c
     LEFT JOIN complaint_categories cat ON cat.id = c.category_id
     LEFT JOIN departments d ON d.id = c.department_id
     WHERE c.tracking_number = ?`,
    [trackingNumber]
  );
  if (!c) {
    const err = new Error('No complaint found with this tracking number.');
    err.statusCode = 404; err.code = 'NOT_FOUND'; throw err;
  }
  return c;  // Public — no PII, no internal notes (Req 5.1, 5.4)
}

async function listComplaints(filters, actorId, actorRole) {
  const {
    page = 1, limit = 20, status, priority, category, department,
    search, sort = 'submitted_at', order = 'desc',
    // New filters
    tracking_number, citizen_name, phone, kebele,
    date_from, date_to, overdue,
  } = filters;

  const maxLimit = (actorRole === 'admin' || actorRole === 'super_admin') ? 100 : 50;
  const safeLimit = Math.min(parseInt(limit, 10), maxLimit);
  const offset    = (parseInt(page, 10) - 1) * safeLimit;

  const conditions = [];
  const params     = [];

  if (actorRole === 'citizen') {
    conditions.push('c.citizen_id = ?'); params.push(actorId);
  } else if (actorRole === 'staff') {
    conditions.push('c.assigned_to = ?'); params.push(actorId);
  }

  if (status)          { conditions.push('c.status = ?');              params.push(status); }
  if (priority)        { conditions.push('c.priority = ?');            params.push(priority); }
  if (category)        { conditions.push('cat.code = UPPER(?)');       params.push(category); }
  if (department)      { conditions.push('c.department_id = ?');       params.push(department); }
  if (tracking_number) { conditions.push('c.tracking_number LIKE ?');  params.push(`%${tracking_number}%`); }
  if (citizen_name)    { conditions.push('cit.name LIKE ?');           params.push(`%${citizen_name}%`); }
  if (phone)           { conditions.push('cit.phone LIKE ?');          params.push(`%${phone}%`); }
  if (kebele)          { conditions.push('c.location LIKE ?');         params.push(`%${kebele}%`); }
  if (date_from)       { conditions.push('DATE(c.submitted_at) >= ?'); params.push(date_from); }
  if (date_to)         { conditions.push('DATE(c.submitted_at) <= ?'); params.push(date_to); }
  if (overdue === '1') {
    conditions.push("c.status NOT IN ('resolved','closed','rejected') AND c.submitted_at < DATE_SUB(NOW(), INTERVAL 7 DAY)");
  }

  if (search) {
    conditions.push('(c.title LIKE ? OR c.tracking_number LIKE ? OR cit.name LIKE ? OR c.description LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const validSortCols = {
    submitted_at: 'c.submitted_at', priority: 'c.priority',
    status: 'c.status', updated_at: 'c.updated_at',
  };
  const sortCol = validSortCols[sort] || 'c.submitted_at';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';

  const [{ total }] = await query(
    `SELECT COUNT(*) AS total FROM complaints c
     LEFT JOIN complaint_categories cat ON cat.id = c.category_id
     LEFT JOIN users cit ON cit.id = c.citizen_id
     ${where}`,
    params
  );

  const rows = await query(
    `SELECT c.id, c.tracking_number, c.title, c.status, c.priority,
            c.submitted_at, c.updated_at, c.location,
            cat.name AS category, d.name AS department_name,
            cit.name AS citizen_name, st.name AS assigned_to_name
     FROM complaints c
     LEFT JOIN complaint_categories cat ON cat.id = c.category_id
     LEFT JOIN departments d   ON d.id  = c.department_id
     LEFT JOIN users cit       ON cit.id = c.citizen_id
     LEFT JOIN users st        ON st.id  = c.assigned_to
     ${where}
     ORDER BY ${sortCol} ${sortDir}
     LIMIT ${safeLimit} OFFSET ${offset}`,
    params
  );

  return { rows, total: parseInt(total, 10), page: parseInt(page, 10), limit: safeLimit };
}

/* =====================================================================
   ASSIGN COMPLAINT (Req 7.1–7.4)
===================================================================== */
async function assignComplaint(complaintId, staffId, adminId, departmentId) {
  const [c] = await query('SELECT id, status, department_id, assigned_to, citizen_id FROM complaints WHERE id = ?', [complaintId]);
  if (!c) { const e=new Error('Complaint not found.'); e.statusCode=404; throw e; }

  const targetDepartmentId = departmentId || c.department_id;
  if (departmentId) {
    const [department] = await query('SELECT id FROM departments WHERE id = ? AND is_active = 1', [departmentId]);
    if (!department) {
      const err = new Error('Department does not exist or is inactive.');
      err.statusCode = 422; err.code = 'INVALID_DEPARTMENT'; throw err;
    }
  }
  if (departmentId && departmentId !== c.department_id && c.assigned_to && !staffId) {
    const err = new Error('Select a staff member from the new department before moving this complaint.');
    err.statusCode = 422; err.code = 'INVALID_ASSIGNMENT'; throw err;
  }

  if (staffId && !['submitted', 'escalated'].includes(c.status)) {
    const err = new Error(`Complaint must be in 'submitted' or 'escalated' status to be assigned (current: ${c.status}).`);
    err.statusCode = 422; err.code = 'INVALID_TRANSITION'; throw err;
  }

  let staff = null;
  if (staffId) {
    const [candidate] = await query(
      "SELECT id, name FROM users WHERE id = ? AND department_id = ? AND is_active = 1 AND role_id = (SELECT id FROM roles WHERE name='staff')",
      [staffId, targetDepartmentId]
    );
    staff = candidate;
    if (!staff) {
      const err = new Error('Staff member does not belong to the complaint department or does not exist.');
      err.statusCode = 422; err.code = 'INVALID_ASSIGNMENT'; throw err;
    }
  }

  const conn = await getConnection();
  await conn.beginTransaction();
  try {
    if (staffId) {
      const [prev] = await conn.execute('SELECT status FROM complaints WHERE id = ?', [complaintId]);
      const oldStatus = prev[0]?.status;
      await conn.execute(
        "UPDATE complaints SET department_id = ?, assigned_to = ?, status = 'assigned', assigned_at = NOW() WHERE id = ?",
        [targetDepartmentId, staffId, complaintId]
      );
      await conn.execute(
        `INSERT INTO complaint_status_history (complaint_id, changed_by, old_status, new_status, note)
         VALUES (?, ?, ?, 'assigned', 'Assigned to staff member.')`,
        [complaintId, adminId, oldStatus]
      );
      await conn.execute(
        'INSERT INTO complaint_assignments (complaint_id, assigned_to, assigned_by) VALUES (?, ?, ?)',
        [complaintId, staffId, adminId]
      );
    } else {
      await conn.execute('UPDATE complaints SET department_id = ? WHERE id = ?', [targetDepartmentId, complaintId]);
    }
    await conn.commit();
    return { complaintId, departmentId: targetDepartmentId, assignedTo: staffId || null, staffName: staff?.name || null };
  } catch (err) {
    await conn.rollback(); throw err;
  } finally {
    conn.release();
  }
}

/* =====================================================================
   UPDATE STATUS (Req 8.1–8.5)
===================================================================== */
async function updateComplaintStatus(complaintId, newStatus, actorId, actorRole, note) {
  const [c] = await query('SELECT id, status, citizen_id FROM complaints WHERE id = ?', [complaintId]);
  if (!c) { const e=new Error('Complaint not found.'); e.statusCode=404; throw e; }

  const { valid, reason } = validateStatusTransition(c.status, newStatus, actorRole);
  if (!valid) {
    const err = new Error(reason); err.statusCode = 422; err.code = 'INVALID_TRANSITION'; throw err;
  }

  const timestampFields = {
    in_progress:     'in_progress_at = NOW(),',
    resolved:        'resolved_at = NOW(),',
    closed:          'closed_at = NOW(),',
    rejected:        'rejected_at = NOW(),',
    escalated:       'escalated_at = NOW(),',
  };
  const tsField = timestampFields[newStatus] || '';

  const conn = await getConnection();
  await conn.beginTransaction();
  try {
    await conn.execute(
      `UPDATE complaints SET status = ?, ${tsField} updated_at = NOW() WHERE id = ?`,
      [newStatus, complaintId]
    );
    await conn.execute(
      `INSERT INTO complaint_status_history (complaint_id, changed_by, old_status, new_status, note)
       VALUES (?, ?, ?, ?, ?)`,
      [complaintId, actorId, c.status, newStatus, note || null]
    );
    await conn.commit();
    return { complaintId, oldStatus: c.status, newStatus };
  } catch (err) {
    await conn.rollback(); throw err;
  } finally {
    conn.release();
  }
}

/* =====================================================================
   ADD NOTE (Req 10.1–10.3)
===================================================================== */
async function addNote(complaintId, actorId, noteText) {
  const [c] = await query('SELECT id FROM complaints WHERE id = ?', [complaintId]);
  if (!c) { const e=new Error('Complaint not found.'); e.statusCode=404; throw e; }

  const result = await query(
    `INSERT INTO complaint_status_history
       (complaint_id, changed_by, old_status, new_status, note, is_internal_note)
     VALUES (?, ?, NULL, (SELECT status FROM complaints WHERE id = ?), ?, 1)`,
    [complaintId, actorId, complaintId, noteText]
  );
  return { noteId: result.insertId };
}

/* =====================================================================
   ADD ATTACHMENTS (staff completion photos)
===================================================================== */
async function addAttachments(complaintId, actorId, files = []) {
  const [complaint] = await query('SELECT id FROM complaints WHERE id = ?', [complaintId]);
  if (!complaint) { const e=new Error('Complaint not found.'); e.statusCode=404; throw e; }
  if (!files.length) { const e=new Error('At least one photo is required.'); e.statusCode=400; throw e; }

  const conn = await getConnection();
  await conn.beginTransaction();
  try {
    const attachmentIds = [];
    for (const file of files) {
      const [result] = await conn.execute(
        `INSERT INTO attachments
           (complaint_id, original_name, stored_name, file_path, mime_type, file_size_bytes, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [complaintId, file.originalname, file.filename, file.path, file.mimetype, file.size, actorId]
      );
      attachmentIds.push(result.insertId);
    }
    await conn.commit();
    return { complaintId, attachmentIds, count: files.length };
  } catch (err) {
    await conn.rollback(); throw err;
  } finally { conn.release(); }
}

/* =====================================================================
   ESCALATE (Req 9.1–9.4)
===================================================================== */
async function escalateComplaint(complaintId, actorId, reason) {
  const [c] = await query('SELECT id, status, citizen_id FROM complaints WHERE id = ?', [complaintId]);
  if (!c) { const e=new Error('Complaint not found.'); e.statusCode=404; throw e; }

  if (c.status !== 'in_progress') {
    const err = new Error("Only complaints with status 'in_progress' can be escalated.");
    err.statusCode = 422; err.code = 'INVALID_TRANSITION'; throw err;
  }

  const conn = await getConnection();
  await conn.beginTransaction();
  try {
    await conn.execute(
      "UPDATE complaints SET status = 'escalated', escalated_at = NOW() WHERE id = ?",
      [complaintId]
    );
    await conn.execute(
      `INSERT INTO complaint_status_history (complaint_id, changed_by, old_status, new_status, note)
       VALUES (?, ?, 'in_progress', 'escalated', ?)`,
      [complaintId, actorId, reason]
    );
    await conn.execute(
      'INSERT INTO escalations (complaint_id, escalated_by, reason) VALUES (?, ?, ?)',
      [complaintId, actorId, reason]
    );
    await conn.commit();
    return { complaintId };
  } catch (err) {
    await conn.rollback(); throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  generateTrackingNumber, validateStatusTransition,
  submitComplaint, getComplaintById, getLegacyWordAttachmentText, getComplaintByTracking,
  listComplaints, assignComplaint, updateComplaintStatus,
  addNote, addAttachments, escalateComplaint,
};
