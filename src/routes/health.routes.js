const express = require('express');
const router = express.Router();

/**
 * GET /health/live
 * Process liveness check.
 * Pure Node.js runtime/event-loop check. Never depends on external services (Redis, Mongo).
 */
router.get('/live', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
