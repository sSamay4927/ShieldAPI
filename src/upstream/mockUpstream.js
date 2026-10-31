const express = require('express');

/**
 * Factory for Mock Upstream Service
 * Emulates downstream microservices for gateway testing and demonstrations.
 */
function createMockUpstreamApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  // In-memory hit counter for test assertion verification
  const hitCounts = {
    total: 0,
    paths: {}
  };

  app.use((req, res, next) => {
    hitCounts.total += 1;
    const normalizedPath = req.path;
    hitCounts.paths[normalizedPath] = (hitCounts.paths[normalizedPath] || 0) + 1;
    next();
  });

  // GET /catalog - Immediate catalog response
  app.get('/catalog', (req, res) => {
    res.status(200).json({
      items: ['item-a', 'item-b'],
      timestamp: new Date().toISOString(),
      service: 'mock-upstream'
    });
  });

  // GET /slow - Intentionally delayed response to trigger gateway timeouts
  app.get('/slow', (req, res) => {
    const delayMs = Number(req.query.delayMs) || 8000;
    setTimeout(() => {
      if (!res.headersSent) {
        res.status(200).json({
          message: 'Slow response completed',
          delayMs,
          timestamp: new Date().toISOString()
        });
      }
    }, delayMs);
  });

  // POST /echo - Echoes back parsed JSON body and request headers
  app.post('/echo', (req, res) => {
    res.status(200).json({
      echoed: req.body,
      receivedHeaders: {
        'x-request-id': req.headers['x-request-id'] || null,
        'content-type': req.headers['content-type'] || null
      },
      timestamp: new Date().toISOString()
    });
  });

  // Introspection helpers for test assertions
  app.getHitCount = (path) => {
    if (path) {
      return hitCounts.paths[path] || 0;
    }
    return hitCounts.total;
  };

  app.resetHitCounts = () => {
    hitCounts.total = 0;
    hitCounts.paths = {};
  };

  return app;
}

/**
 * Start standalone mock upstream server on specified port.
 */
function startMockUpstream(port = 4001) {
  const app = createMockUpstreamApp();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`[MockUpstream] Listening on port ${port}`);
      resolve({ app, server });
    });
  });
}

// Direct execution entrypoint
if (require.main === module) {
  const port = process.env.UPSTREAM_PORT || 4001;
  startMockUpstream(port).catch((err) => {
    console.error('[MockUpstream] Failed to start:', err);
    process.exit(1);
  });
}

module.exports = {
  createMockUpstreamApp,
  startMockUpstream
};
