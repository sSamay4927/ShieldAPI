const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');

/**
 * Factory for Fixed-Target Gateway Reverse Proxy Middleware
 * Strictly targets UPSTREAM_BASE_URL without allowing user-directed destination tampering.
 *
 * @param {Object} [options]
 * @param {string} [options.target=config.UPSTREAM_BASE_URL]
 * @param {number} [options.timeoutMs=config.PROXY_TIMEOUT_MS]
 * @param {string} [options.pathPrefix='/gateway/v1']
 */
function createUpstreamProxy(options = {}) {
  // Destination is strictly locked to configured base URL
  const target = options.target || config.UPSTREAM_BASE_URL;
  const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : config.PROXY_TIMEOUT_MS;
  const pathPrefix = options.pathPrefix || '/gateway/v1';

  return createProxyMiddleware({
    target,
    changeOrigin: true,
    proxyTimeout: timeoutMs,
    pathRewrite: (path) => {
      // Strip pathPrefix from the start of the URL (e.g. /gateway/v1/catalog -> /catalog)
      if (path.startsWith(pathPrefix)) {
        const rewritten = path.slice(pathPrefix.length);
        return rewritten === '' ? '/' : rewritten;
      }
      return path;
    },
    on: {
      proxyReq: (proxyReq, req) => {
        // Forward sanitized request ID to upstream for distributed tracing
        const reqId = req.id || req.requestId;
        if (reqId) {
          proxyReq.setHeader('X-Request-Id', reqId);
        }

        // Re-stream JSON body if already parsed by body-parser middleware
        fixRequestBody(proxyReq, req);
      },
      error: (err, req, res) => {
        const requestId = req.id || req.requestId || 'unknown';

        logger.error('Upstream proxy connection failed', {
          requestId,
          error: err.message,
          code: err.code
        });

        if (res.headersSent) {
          return;
        }

        const isTimeout =
          err.code === 'ETIMEDOUT' ||
          err.code === 'ECONNRESET' ||
          err.code === 'ESOCKETTIMEDOUT' ||
          (err.message && err.message.toLowerCase().includes('timeout'));

        if (isTimeout) {
          return res.status(504).json({
            error: 'gateway_timeout',
            message: 'Upstream service timed out before responding',
            requestId
          });
        }

        // Connection refused or upstream offline
        return res.status(502).json({
          error: 'bad_gateway',
          message: 'Unable to connect to upstream service',
          requestId
        });
      }
    }
  });
}

module.exports = {
  createUpstreamProxy,
  upstreamProxy: createUpstreamProxy()
};
