const crypto = require('crypto');

// Strict RFC 4122 UUID regex (versions 1 through 5)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Request ID Middleware
 * Validates incoming X-Request-Id header to prevent header injection,
 * or generates a new RFC 4122 UUID v4.
 * Attaches the ID to `req.requestId` and sets `X-Request-Id` response header.
 */
function requestIdMiddleware(req, res, next) {
  const incomingId = req.headers['x-request-id'];

  let requestId;
  if (incomingId && typeof incomingId === 'string' && UUID_REGEX.test(incomingId.trim())) {
    requestId = incomingId.trim();
  } else {
    requestId = crypto.randomUUID();
  }

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  next();
}

module.exports = requestIdMiddleware;

