const crypto = require('crypto');
const { config } = require('../config/env');
const { enqueueAuditEvent } = require('../infrastructure/queue/auditQueue');
const { logger } = require('../utils/logger');

/**
 * Audit Service
 * Handles formatting and asynchronous handoff of security and policy violations to the BullMQ pipeline.
 */

/**
 * Record a rate-limit violation (HTTP 429) event.
 *
 * @param {Object} req - Express request
 * @param {Object} decision - Decision metadata from rate limiter
 * @returns {Promise<string|null>}
 */
async function recordRateLimitViolation(req, decision = {}) {
  try {
    const requestId = req.id || req.requestId || crypto.randomUUID();
    const identityDigest = req.identityDigest;

    if (!identityDigest) {
      logger.warn('Attempted to record rate-limit audit without identity digest', { requestId });
      return null;
    }

    const retentionMs = config.AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const now = new Date();

    const payload = {
      eventId: crypto.randomUUID(),
      occurredAt: now,
      route: req.originalUrl || req.baseUrl || req.path || '/unknown',
      method: (req.method || 'GET').toUpperCase(),
      policyId: req.rateLimit?.policyId || 'default',
      identityType: req.identityType || 'ip',
      identityDigest,
      decision: 'RATE_LIMITED',
      requestId,
      limit: decision.limit || req.rateLimit?.limit || config.RATE_LIMIT_MAX_REQUESTS,
      windowMs: decision.windowMs || req.rateLimit?.windowMs || config.RATE_LIMIT_WINDOW_MS,
      retryAfterMs: decision.retryAfterSec
        ? decision.retryAfterSec * 1000
        : (decision.retryAfterMs || 0),
      expireAt: new Date(now.getTime() + retentionMs)
    };

    return enqueueAuditEvent(payload);
  } catch (err) {
    logger.error('Unexpected error preparing rate-limit audit event', { error: err.message });
    return null;
  }
}

/**
 * Record an upstream gateway error (HTTP 502 / 504) event.
 *
 * @param {Object} req
 * @param {string} errorType - 'bad_gateway' | 'gateway_timeout'
 * @returns {Promise<string|null>}
 */
async function recordUpstreamError(req, errorType = 'bad_gateway') {
  try {
    const requestId = req.id || req.requestId || crypto.randomUUID();
    const identityDigest = req.identityDigest || 'unauthenticated';
    const retentionMs = config.AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const now = new Date();

    const payload = {
      eventId: crypto.randomUUID(),
      occurredAt: now,
      route: req.originalUrl || req.baseUrl || req.path || '/unknown',
      method: (req.method || 'GET').toUpperCase(),
      policyId: 'default',
      identityType: req.identityType || 'ip',
      identityDigest,
      decision: 'UPSTREAM_ERROR',
      requestId,
      limit: config.RATE_LIMIT_MAX_REQUESTS,
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      retryAfterMs: 0,
      expireAt: new Date(now.getTime() + retentionMs)
    };

    return enqueueAuditEvent(payload);
  } catch (err) {
    logger.error('Unexpected error preparing upstream audit event', { error: err.message });
    return null;
  }
}

module.exports = {
  recordRateLimitViolation,
  recordUpstreamError
};

