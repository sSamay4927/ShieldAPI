const express = require('express');
const { getStatus: getMongoStatus, isConnected: isMongoConnected } = require('../infrastructure/mongo/mongoClient');

const router = express.Router();

/**
 * GET /health/live
 * Process liveness check.
 * Pure Node.js event-loop check. Never depends on external services (Redis, Mongo).
 */
router.get('/live', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /health/ready
 * Readiness probe for traffic routing.
 * Checks external dependencies status.
 * Note: MongoDB failure reports degraded audit capability without blocking process liveness.
 */
router.get('/ready', (req, res) => {
  const mongoStatus = getMongoStatus();

  // In Phase 4, rate limiting engine is being staged; Redis check will be wired in Phase 5
  res.status(200).json({
    status: 'ready',
    mongo: mongoStatus,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
