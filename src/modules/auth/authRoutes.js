'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('./authController');
const { authenticateToken } = require('./authMiddleware');

// Public routes
router.post('/register',        ctrl.register);
router.post('/login',           ctrl.login);
router.post('/forgot-password', ctrl.forgotPassword);
router.post('/reset-password',  ctrl.resetPassword);

// Protected routes
router.post('/logout',  authenticateToken, ctrl.logout);
router.get('/profile',  authenticateToken, ctrl.getProfile);
router.put('/change-password', authenticateToken, ctrl.changePassword);

module.exports = router;
