'use strict';
/**
 * Joi validation schemas for complaint operations (Req 4.1, 17.1)
 */

const Joi = require('joi');

const COMPLAINT_CATEGORIES = [
  'roads','water','electricity','waste','drainage',
  'health','education','land','construction','environment',
  'public_safety','corruption','noise','street_lights','other'
];
const COMPLAINT_PRIORITIES = ['low','medium','high','urgent'];
const COMPLAINT_STATUSES = [
  'submitted','assigned','in_progress','resolved','closed','rejected','escalated'
];

const submitComplaintSchema = Joi.object({
  title:        Joi.string().min(10).max(255).required().messages({
    'string.min': 'Title must be at least 10 characters.',
    'string.max': 'Title must not exceed 255 characters.',
    'any.required': 'Title is required.',
  }),
  description:  Joi.string().min(20).max(5000).required().messages({
    'string.min': 'Description must be at least 20 characters.',
    'string.max': 'Description must not exceed 5000 characters.',
    'any.required': 'Description is required.',
  }),
  category:     Joi.string().valid(...COMPLAINT_CATEGORIES).required().messages({
    'any.only':    `Category must be one of: ${COMPLAINT_CATEGORIES.join(', ')}.`,
    'any.required': 'Category is required.',
  }),
  departmentId: Joi.number().integer().positive().required().messages({
    'any.required': 'Department is required.',
  }),
  priority:     Joi.string().valid(...COMPLAINT_PRIORITIES).default('medium'),
  location:     Joi.string().max(500).optional().allow('', null),
});

const updateStatusSchema = Joi.object({
  status: Joi.string().valid(...COMPLAINT_STATUSES).required(),
  note:   Joi.string().max(1000).optional().allow(''),
});

const assignSchema = Joi.object({
  departmentId: Joi.number().integer().positive().optional(),
  staffId: Joi.number().integer().positive().optional(),
  note:    Joi.string().max(500).optional().allow(''),
}).or('departmentId', 'staffId');

const escalateSchema = Joi.object({
  reason: Joi.string().min(1).max(500).required().messages({
    'string.empty': 'Escalation reason is required.',
    'any.required': 'Escalation reason is required.',
  }),
  note:   Joi.string().max(1000).optional().allow(''),
});

const addNoteSchema = Joi.object({
  note: Joi.string().min(1).max(1000).required().messages({
    'string.empty': 'Note text cannot be empty.',
    'any.required': 'Note is required.',
  }),
});

const listQuerySchema = Joi.object({
  page:            Joi.number().integer().min(1).default(1),
  limit:           Joi.number().integer().min(1).max(100).default(20),
  status:          Joi.string().valid(...COMPLAINT_STATUSES, '').optional(),
  priority:        Joi.string().valid(...COMPLAINT_PRIORITIES, '').optional(),
  category:        Joi.string().valid(...COMPLAINT_CATEGORIES, '').optional(),
  department:      Joi.number().integer().positive().optional(),
  search:          Joi.string().max(100).optional().allow(''),
  sort:            Joi.string().valid('submitted_at','priority','status','updated_at').default('submitted_at'),
  order:           Joi.string().valid('asc','desc').default('desc'),
  // Advanced search fields
  tracking_number: Joi.string().max(30).optional().allow(''),
  citizen_name:    Joi.string().max(100).optional().allow(''),
  phone:           Joi.string().max(30).optional().allow(''),
  kebele:          Joi.string().max(50).optional().allow(''),
  date_from:       Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow(''),
  date_to:         Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow(''),
  overdue:         Joi.string().valid('1').optional(),
  assigned_to:     Joi.string().optional().allow(''),
});

module.exports = {
  submitComplaintSchema, updateStatusSchema, assignSchema,
  escalateSchema, addNoteSchema, listQuerySchema,
  COMPLAINT_CATEGORIES, COMPLAINT_PRIORITIES, COMPLAINT_STATUSES,
};
