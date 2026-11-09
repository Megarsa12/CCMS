'use strict';
const express  = require('express');
const router   = express.Router();
const ctrl     = require('./complaintController');
const { authenticateToken, authorizeRoles } = require('../auth/authMiddleware');
const { upload } = require('../../shared/uploadMiddleware');

// Public — no auth required (Req 5.1)
router.get('/track/:trackingNumber', ctrl.trackComplaint);

// Citizen — own complaints
router.get('/my',
  authenticateToken, authorizeRoles('citizen'),
  ctrl.getMyComplaints
);

router.get('/:id/attachments/:attachmentId/preview',
  authenticateToken,
  ctrl.previewLegacyWordAttachment
);

// Submit — citizen only with file upload (Req 4.1)
router.post('/',
  authenticateToken, authorizeRoles('citizen'),
  upload.array('attachments', 5),
  ctrl.submitComplaint
);

// List all — admin/staff/super_admin (Req 15.4)
router.get('/',
  authenticateToken, authorizeRoles('admin', 'super_admin', 'staff'),
  ctrl.listComplaints
);

// Get single complaint — all authenticated roles
router.get('/:id',
  authenticateToken,
  ctrl.getComplaint
);

// Assign — admin / super_admin only (Req 7.4)
router.patch('/:id/assign',
  authenticateToken, authorizeRoles('admin', 'super_admin'),
  ctrl.assignComplaint
);

// Update status — staff / admin / super_admin (Req 8.1)
router.patch('/:id/status',
  authenticateToken, authorizeRoles('staff', 'admin', 'super_admin', 'citizen'),
  ctrl.updateStatus
);

// Add internal note — staff / admin (Req 10.3)
router.post('/:id/notes',
  authenticateToken, authorizeRoles('staff', 'admin', 'super_admin'),
  ctrl.addNote
);

// Staff completion photos
router.post('/:id/attachments',
  authenticateToken, authorizeRoles('staff', 'admin', 'super_admin'),
  upload.array('attachments', 5),
  ctrl.addAttachments
);

// Escalate — staff / admin (Req 9.4)
router.post('/:id/escalate',
  authenticateToken, authorizeRoles('staff', 'admin', 'super_admin'),
  ctrl.escalateComplaint
);

module.exports = router;
