'use strict';
/**
 * Joi schemas for auth request validation (Req 1.1, 2.1, 3.2, 17.1)
 */

const Joi = require('joi');

const PASSWORD_RULE = Joi.string()
  .min(8).max(64)
  .pattern(/[A-Z]/, 'uppercase letter')
  .pattern(/[a-z]/, 'lowercase letter')
  .pattern(/[0-9]/, 'digit')
  .required()
  .messages({
    'string.min':     'Password must be at least 8 characters long.',
    'string.max':     'Password must not exceed 64 characters.',
    'string.pattern.name': 'Password must contain at least one {#name}.',
    'any.required':   'Password is required.',
  });

const registerSchema = Joi.object({
  first_name: Joi.string().trim().min(1).max(50).messages({
    'string.min': 'First name must not be empty.',
    'string.max': 'First name must not exceed 50 characters.',
  }),
  last_name: Joi.string().trim().min(1).max(50).messages({
    'string.min': 'Last name must not be empty.',
    'string.max': 'Last name must not exceed 50 characters.',
  }),
  name: Joi.string().trim().min(2).max(100).messages({
    'string.min': 'Name must be at least 2 characters.',
    'string.max': 'Name must not exceed 100 characters.',
  }),
  email: Joi.string().email({ tlds: { allow: false } }).max(150).required().messages({
    'string.email': 'Please enter a valid email address.',
    'any.required': 'Email is required.',
  }),
  phone: Joi.string().trim().pattern(/^\+?[0-9\s\-()]{7,20}$/).messages({
    'string.pattern.base': 'Phone number must be a valid format such as +251 912 345 678.',
  }),
  gender: Joi.string().valid('male', 'female', 'other', 'prefer_not_to_say').messages({
    'any.only': 'Please select a valid gender.',
  }),
  language: Joi.string().valid('en', 'am', 'or', 'so').messages({
    'any.only': 'Please select a valid language.',
  }),
  password: PASSWORD_RULE,
}).custom((value, helpers) => {
  const hasSplitName = Boolean(value.first_name || value.last_name);
  const hasFullName = Boolean(value.name);

  if (hasSplitName) {
    if (!value.first_name || !value.last_name) {
      return helpers.message('First name and last name are required.');
    }
    if (!value.phone) {
      return helpers.message('Phone number is required.');
    }
    if (!value.gender) {
      return helpers.message('Gender is required.');
    }
    if (!value.language) {
      return helpers.message('Language is required.');
    }
    return value;
  }

  if (!hasFullName) {
    return helpers.message('Name is required.');
  }

  return value;
});

const loginSchema = Joi.object({
  email:    Joi.string().required().messages({ 'any.required': 'Email is required.' }),
  password: Joi.string().required().messages({ 'any.required': 'Password is required.' }),
});

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email({ tlds: { allow: false } }).required(),
});

const resetPasswordSchema = Joi.object({
  token:       Joi.string().required(),
  newPassword: PASSWORD_RULE,
});

const changePasswordSchema = Joi.object({
  current_password: Joi.string().required().messages({
    'any.required': 'Current password is required.',
  }),
  new_password: PASSWORD_RULE.invalid(Joi.ref('current_password')).messages({
    'any.invalid': 'New password must be different from your current password.',
  }),
});

module.exports = {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
};
