'use strict';
/**
 * Auth controller — thin HTTP layer that delegates to authService.
 */

const {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
} = require('./authValidation');
const jwt = require('jsonwebtoken');
const authService = require('./authService');
const { success, created, error }  = require('../../shared/response');

async function register(req, res, next) {
  try {
    const { error: valErr, value } = registerSchema.validate(req.body, { abortEarly: false });
    if (valErr) {
      const details = valErr.details.map(d => ({ field: d.context?.key, msg: d.message }));
      return error(res, 400, 'VALIDATION_ERROR', valErr.details[0].message, details);
    }
    const result = await authService.registerUser(value);
    return created(res, result, 'Account created successfully.');
  } catch (err) {
    if (err.code === 'EMAIL_EXISTS') return error(res, 409, 'EMAIL_EXISTS', err.message);
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { error: valErr, value } = loginSchema.validate(req.body);
    if (valErr) return error(res, 400, 'VALIDATION_ERROR', valErr.details[0].message);
    const result = await authService.loginUser(value);
    return success(res, result, 'Login successful.');
  } catch (err) {
    if (err.code === 'INVALID_CREDENTIALS') return error(res, 401, 'INVALID_CREDENTIALS', err.message);
    if (err.code === 'ACCOUNT_DEACTIVATED') return error(res, 403, 'ACCOUNT_DEACTIVATED', err.message);
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    const decoded = req.user;
    await authService.logoutUser(decoded.userId, req.tokenHash, decoded.exp);
    return success(res, null, 'Logged out successfully.');
  } catch (err) {
    next(err);
  }
}

async function forgotPassword(req, res, next) {
  try {
    const { error: valErr, value } = forgotPasswordSchema.validate(req.body);
    if (valErr) return error(res, 400, 'VALIDATION_ERROR', valErr.details[0].message);
    await authService.forgotPassword(value.email);
    // Always return success — prevents user enumeration (Req 3.5)
    return success(res, null, 'If that email is registered, a reset code has been sent.');
  } catch (err) {
    if (err.code === 'EMAIL_NOT_CONFIGURED' || err.code === 'EMAIL_DELIVERY_FAILED') {
      return error(res, 503, err.code, err.message);
    }
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const { error: valErr, value } = resetPasswordSchema.validate(req.body);
    if (valErr) {
      const details = valErr.details.map(d => ({ field: d.context?.key, msg: d.message }));
      return error(res, 400, 'VALIDATION_ERROR', valErr.details[0].message, details);
    }
    await authService.resetPassword(value.token, value.newPassword);
    return success(res, null, 'Password has been reset successfully.');
  } catch (err) {
    if (err.code === 'INVALID_TOKEN') return error(res, 400, 'INVALID_TOKEN', err.message);
    next(err);
  }
}

async function changePassword(req, res, next) {
  try {
    const { error: valErr, value } = changePasswordSchema.validate(req.body, { abortEarly: false });
    if (valErr) {
      const details = valErr.details.map(d => ({ field: d.context?.key, msg: d.message }));
      return error(res, 400, 'VALIDATION_ERROR', valErr.details[0].message, details);
    }
    await authService.changePassword(
      req.user.userId,
      value.current_password,
      value.new_password
    );
    const token = req.user.passwordChangeRequired
      ? jwt.sign(
        { userId: req.user.userId, role: req.user.role, email: req.user.email },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
      )
      : null;
    return success(res, token ? { token } : null, 'Password changed successfully.');
  } catch (err) {
    if (err.code === 'INVALID_CURRENT_PASSWORD') {
      return error(res, 400, err.code, err.message);
    }
    if (err.code === 'USER_NOT_FOUND') {
      return error(res, 404, 'NOT_FOUND', err.message);
    }
    next(err);
  }
}

async function getProfile(req, res, next) {
  try {
    const profile = await authService.getProfile(req.user.userId);
    return success(res, profile);
  } catch (err) {
    if (err.statusCode === 404) return error(res, 404, 'NOT_FOUND', err.message);
    next(err);
  }
}

module.exports = {
  register,
  login,
  logout,
  forgotPassword,
  resetPassword,
  changePassword,
  getProfile,
};
