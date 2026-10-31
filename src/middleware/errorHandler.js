const { logger } = require('../utils/logger');

/**
 * Central Error Handler Middleware
 * Formats all application and unhandled errors into consistent JSON responses.
 * Attaches the current requestId for client-side tracing.
 * Stack traces are logged internally but NEVER sent in response payloads.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || err.status || 500;
  const errorCode = err.code || (statusCode === 500 ? 'internal_server_error' : 'error');

  // Internal logging for operators
  if (statusCode >= 500) {
    logger.error('Unhandled internal server error', {
      requestId: req.requestId,
      error: err.message,
      stack: err.stack,
      url: req.originalUrl,
      method: req.method
    });
  } else {
    logger.warn('Client or operational error encountered', {
      requestId: req.requestId,
      statusCode,
      errorCode,
      message: err.message,
      url: req.originalUrl
    });
  }

  // Safe client response payload
  const clientMessage = (statusCode === 500 && !err.isOperational)
    ? 'An unexpected internal server error occurred.'
    : (err.message || 'Error processing request');

  const responsePayload = {
    error: errorCode,
    message: clientMessage,
    requestId: req.requestId || null
  };

  // Add rate limiting fields if present on error
  if (err.retryAfter !== undefined) {
    responsePayload.retryAfter = err.retryAfter;
  }
  if (err.remaining !== undefined) {
    responsePayload.remaining = err.remaining;
  }

  res.status(statusCode).json(responsePayload);
}

module.exports = errorHandler;
