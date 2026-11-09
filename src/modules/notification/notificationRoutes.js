'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('./notificationController');
const { authenticateToken } = require('../auth/authMiddleware');

router.use(authenticateToken);

router.get('/',               ctrl.getNotifications);
router.get('/unread-count',   ctrl.getUnreadCount);
router.patch('/:id/read',     ctrl.markRead);
router.put('/read-all',       ctrl.markAllRead);

module.exports = router;
