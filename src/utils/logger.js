const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization'
]);

function redactHeaders(headers = {}) {
  const sanitized = {};
  for (const [key, val] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

const logger = {
  info(message, meta = {}) {
    if (process.env.NODE_ENV === 'test') return;
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      message,
      ...meta
    }));
  },

  warn(message, meta = {}) {
    if (process.env.NODE_ENV === 'test') return;
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'warn',
      message,
      ...meta
    }));
  },

  error(message, meta = {}) {
    if (process.env.NODE_ENV === 'test') return;
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      message,
      ...meta
    }));
  },

  debug(message, meta = {}) {
    if (process.env.NODE_ENV !== 'development') return;
    console.debug(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'debug',
      message,
      ...meta
    }));
  }
};

/**
 * Express HTTP Request Logger Middleware
 * Logs method, path, status, requestId, and duration in ms.
 * Sensitive headers are never logged.
 */
function requestLoggerMiddleware(req, res, next) {
  const startAt = process.hrtime.bigint();

  res.on('finish', () => {
    const endAt = process.hrtime.bigint();
    const durationMs = Number(endAt - startAt) / 1e6;

    logger.info('HTTP Request Handled', {
      requestId: req.requestId || null,
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2))
    });
  });

  next();
}

module.exports = {
  logger,
  redactHeaders,
  requestLoggerMiddleware
};

