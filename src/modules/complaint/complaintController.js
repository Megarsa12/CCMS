'use strict';
const { success, created, error } = require('../../shared/response');
const {
  submitComplaintSchema, updateStatusSchema, assignSchema,
  escalateSchema, addNoteSchema, listQuerySchema,
} = require('./complaintValidation');
const svc = require('./complaintService');
const notifSvc = require('../notification/notificationService');

async function submitComplaint(req, res, next) {
  try {
    const { error: valErr, value } = submitComplaintSchema.validate(req.body, { abortEarly: false });
    if (valErr) {
      const details = valErr.details.map(d => ({ field: d.context?.key, msg: d.message }));
      return error(res, 400, 'VALIDATION_ERROR', valErr.details[0].message, details);
    }
    const files  = req.files || [];
    const result = await svc.submitComplaint(req.user.userId, value, files);

    // Notify citizen — non-blocking (Req 4.4, 13.6)
    notifSvc.notifyComplaintReceived(result.complaintId, req.user.userId, result.trackingNumber)
      .catch(err => console.error('[Notify] complaintReceived:', err.message));

    return created(res, result, 'Complaint submitted successfully.');
  } catch (err) {
    if (err.code === 'INVALID_DEPARTMENT') return error(res, 400, err.code, err.message);
    if (err.code === 'DAILY_LIMIT_EXCEEDED') return error(res, 503, err.code, err.message);
    next(err);
  }
}

async function getComplaint(req, res, next) {
  try {
    const c = await svc.getComplaintById(+req.params.id, req.user.userId, req.user.role);
    return success(res, c);
  } catch (err) {
    if (err.statusCode === 404) return error(res, 404, 'NOT_FOUND', err.message);
    if (err.statusCode === 403) return error(res, 403, 'FORBIDDEN', err.message);
    next(err);
  }
}

async function previewLegacyWordAttachment(req, res, next) {
  try {
    const preview = await svc.getLegacyWordAttachmentText(
      +req.params.id,
      +req.params.attachmentId,
      req.user.userId,
      req.user.role
    );
    return success(res, preview);
  } catch (err) {
    if ([400, 403, 404].includes(err.statusCode)) {
      return error(res, err.statusCode, err.code || 'NOT_FOUND', err.message);
    }
    if (err.statusCode === 415) {
      return error(res, 415, err.code, err.message);
    }
    next(err);
  }
}

async function trackComplaint(req, res, next) {
  try {
    const c = await svc.getComplaintByTracking(req.params.trackingNumber.toUpperCase());
    return success(res, c);
  } catch (err) {
    if (err.statusCode === 404) return error(res, 404, 'NOT_FOUND', err.message);
    next(err);
  }
}

async function listComplaints(req, res, next) {
  try {
    const { error: valErr, value } = listQuerySchema.validate(req.query);
    if (valErr) return error(res, 400, 'VALIDATION_ERROR', valErr.details[0].message);
    const { rows, total, page, limit } = await svc.listComplaints(value, req.user.userId, req.user.role);
    return success(res, rows, '', 200, { page, limit, total });
  } catch (err) { next(err); }
}

async function getMyComplaints(req, res, next) {
  try {
    const { error: valErr, value } = listQuerySchema.validate(req.query);
    if (valErr) return error(res, 400, 'VALIDATION_ERROR', valErr.details[0].message);
    const { rows, total, page, limit } = await svc.listComplaints(value, req.user.userId, 'citizen');
    return success(res, rows, '', 200, { page, limit, total });
  } catch (err) { next(err); }
}

async function assignComplaint(req, res, next) {
  try {
    const { error: valErr, value } = assignSchema.validate(req.body);
    if (valErr) return error(res, 400, 'VALIDATION_ERROR', valErr.details[0].message);
    const result = await svc.assignComplaint(+req.params.id, value.staffId, req.user.userId, value.departmentId);

    if (value.staffId) {
      notifSvc.notifyAssignment(result.complaintId, value.staffId, req.user.userId)
        .catch(e => console.error('[Notify] assignment:', e.message));
    }

    return success(res, result, 'Complaint assigned successfully.');
  } catch (err) {
    if (err.statusCode === 404) return error(res, 404, 'NOT_FOUND', err.message);
    if (err.statusCode === 422) return error(res, 422, err.code || 'INVALID_TRANSITION', err.message);
    next(err);
  }
}

async function updateStatus(req, res, next) {
  try {
    const { error: valErr, value } = updateStatusSchema.validate(req.body);
    if (valErr) return error(res, 400, 'VALIDATION_ERROR', valErr.details[0].message);
    const result = await svc.updateComplaintStatus(+req.params.id, value.status, req.user.userId, req.user.role, value.note);

    notifSvc.notifyStatusChange(result.complaintId, result.newStatus, req.user.userId, req.user.role)
      .catch(e => console.error('[Notify] statusChange:', e.message));

    return success(res, result, `Status updated to '${value.status}'.`);
  } catch (err) {
    if (err.statusCode === 404) return error(res, 404, 'NOT_FOUND', err.message);
    if (err.statusCode === 422) return error(res, 422, err.code || 'INVALID_TRANSITION', err.message);
    next(err);
  }
}

async function addNote(req, res, next) {
  try {
    const { error: valErr, value } = addNoteSchema.validate(req.body);
    if (valErr) return error(res, 400, 'VALIDATION_ERROR', valErr.details[0].message);
    const result = await svc.addNote(+req.params.id, req.user.userId, value.note);
    return created(res, result, 'Note added.');
  } catch (err) {
    if (err.statusCode === 404) return error(res, 404, 'NOT_FOUND', err.message);
    next(err);
  }
}

async function addAttachments(req, res, next) {
  try {
    const result = await svc.addAttachments(+req.params.id, req.user.userId, req.files || []);
    return created(res, result, 'Photos uploaded successfully.');
  } catch (err) {
    if (err.statusCode === 400) return error(res, 400, 'NO_ATTACHMENTS', err.message);
    if (err.statusCode === 404) return error(res, 404, 'NOT_FOUND', err.message);
    next(err);
  }
}

async function escalateComplaint(req, res, next) {
  try {
    const { error: valErr, value } = escalateSchema.validate(req.body);
    if (valErr) return error(res, 400, 'VALIDATION_ERROR', valErr.details[0].message);
    const result = await svc.escalateComplaint(+req.params.id, req.user.userId, value.reason);

    notifSvc.notifyEscalation(result.complaintId, req.user.userId)
      .catch(e => console.error('[Notify] escalation:', e.message));

    return success(res, result, 'Complaint escalated.');
  } catch (err) {
    if (err.statusCode === 404) return error(res, 404, 'NOT_FOUND', err.message);
    if (err.statusCode === 422) return error(res, 422, err.code || 'INVALID_TRANSITION', err.message);
    next(err);
  }
}

module.exports = {
  submitComplaint, getComplaint, previewLegacyWordAttachment, trackComplaint, listComplaints,
  getMyComplaints, assignComplaint, updateStatus, addNote, addAttachments, escalateComplaint,
};
