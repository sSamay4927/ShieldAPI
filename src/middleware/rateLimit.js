const crypto = require('crypto');
const { getPolicy } = require('../config/policies');
const rateLimiterService = require('../services/rateLimiter.service');
const { logger } = require('../utils/logger');
const { ServiceUnavailableError } = require('../utils/errors');

/**
 * Express middleware factory for sliding-window rate limiting.
 *
 * @param {Object} [options]
 * @param {string|Object} [options.policy='default'] - Policy ID or custom policy object
 * @param {string} [options.keyPrefix='shieldapi:rl:v1:default'] - Redis key namespace prefix
 * @returns {Function} Express middleware (req, res, next)
 */
function createRateLimitMiddleware(options = {}) {
  const policy = typeof options.policy === 'object' && options.policy !== null
    ? options.policy
    : getPolicy(options.policy || 'default');

  const keyPrefix = options.keyPrefix || `shieldapi:rl:v1:${policy.id || 'default'}`;

  return async function rateLimitMiddleware(req, res, next) {
    const requestId = req.id || req.requestId || crypto.randomUUID();
    const identityDigest = req.identityDigest;

    if (!identityDigest) {
      logger.error('Rate limit middleware invoked before identity resolution', { requestId });
      return res.status(500).json({
        error: 'internal_server_error',
        message: 'Client identity has not been resolved',
        requestId
      });
    }

    const redisKey = `${keyPrefix}:${identityDigest}`;

    try {
      const decision = await rateLimiterService.checkLimit(
        redisKey,
        policy.windowMs,
        policy.maxRequests,
        requestId
      );

      // Attach decision metadata to req for downstream consumers (e.g., audit logging)
      req.rateLimit = {
        allowed: decision.allowed,
        limit: policy.maxRequests,
        remaining: decision.remaining,
        resetEpochSec: decision.resetEpochSec,
        retryAfterSec: decision.retryAfterSec,
        windowMs: policy.windowMs,
        key: redisKey
      };

      // Set standard RFC-compliant rate limit response headers
      res.setHeader('X-RateLimit-Limit', String(policy.maxRequests));
      res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
      res.setHeader('X-RateLimit-Reset', String(decision.resetEpochSec));

      if (decision.allowed) {
        return next();
      }

      // Quota exceeded: set Retry-After header and return 429 JSON
      res.setHeader('Retry-After', String(decision.retryAfterSec));

      logger.warn('Rate limit exceeded for client', {
        requestId,
        identityType: req.identityType,
        identityDigest,
        limit: policy.maxRequests,
        retryAfter: decision.retryAfterSec
      });

      return res.status(429).json({
        error: 'rate_limit_exceeded',
        message: 'Too many requests. Please retry after specified duration.',
        requestId,
        retryAfter: decision.retryAfterSec,
        remaining: 0
      });
    } catch (err) {
      logger.error('Rate limiter service error during limit check', {
        requestId,
        identityDigest,
        error: err.message,
        failMode: policy.failMode
      });

      if (policy.failMode === 'closed') {
        // Fail-closed: deny request with 503 to prevent unmetered traffic spike
        return res.status(503).json({
          error: 'rate_limiter_unavailable',
          message: 'Rate limiting service is temporarily unavailable. Fail-closed policy active.',
          requestId
        });
      }

      // Fail-open: allow request through with degraded indicator header
      res.setHeader('X-RateLimit-Degraded', 'true');
      return next();
    }
  };
}

module.exports = {
  createRateLimitMiddleware,
  rateLimit: createRateLimitMiddleware()
};
