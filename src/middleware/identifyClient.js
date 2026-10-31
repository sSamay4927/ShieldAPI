const crypto = require('crypto');
const { config } = require('../config/env');

/**
 * Compute an HMAC-SHA256 hexadecimal digest for a client identifier.
 * Ensures the raw identifier (API key or IP) is never stored, logged, or used as a raw Redis key.
 *
 * @param {string} rawIdentifier
 * @param {string} [secret]
 * @returns {string} 64-character lowercase hex digest
 */
function computeIdentityDigest(rawIdentifier, secret = config.IDENTITY_HASH_SECRET) {
  if (!rawIdentifier || typeof rawIdentifier !== 'string') {
    throw new Error('computeIdentityDigest requires a non-empty string identifier');
  }
  return crypto.createHmac('sha256', secret).update(rawIdentifier.trim()).digest('hex');
}

/**
 * Express middleware to identify client and compute a stable, non-reversible identity digest.
 * Precedence:
 * 1. X-API-Key header (if present and non-empty) -> type: "api-key"
 * 2. req.ip (fallback) -> type: "ip"
 *
 * Attaches to req:
 * - req.identityDigest (64-character hex string)
 * - req.identityType ("api-key" | "ip")
 */
function identifyClient(req, res, next) {
  const apiKeyHeader = req.get('x-api-key');

  if (apiKeyHeader && typeof apiKeyHeader === 'string' && apiKeyHeader.trim() !== '') {
    req.identityDigest = computeIdentityDigest(apiKeyHeader.trim());
    req.identityType = 'api-key';
  } else {
    const rawIp = req.ip || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
    req.identityDigest = computeIdentityDigest(rawIp);
    req.identityType = 'ip';
  }

  next();
}

module.exports = {
  identifyClient,
  computeIdentityDigest
};

