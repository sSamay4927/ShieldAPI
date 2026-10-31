const express = require('express');
const { getStatus: getMongoStatus } = require('../infrastructure/mongo/mongoClient');
const { ping: pingRedis, isConnected: isRedisConnected, getStatus: getRedisStatus } = require('../infrastructure/redis/redisClient');
const { getQueueStatus } = require('../infrastructure/queue/auditQueue');

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
 * Redis is mandatory for rate-limit decision-making.
 * MongoDB failure reports degraded audit capability without blocking gateway readiness.
 */
router.get('/ready', async (req, res) => {
  let redisHealthy = false;
  try {
    const pong = await pingRedis();
    redisHealthy = pong === 'PONG';
  } catch {
    redisHealthy = false;
  }

  const mongoStatus = getMongoStatus();
  const redisStatus = redisHealthy ? 'connected' : getRedisStatus();
  const queueStatus = getQueueStatus();

  // Fail readiness if Redis (the decision store) is unavailable
  if (!redisHealthy) {
    return res.status(503).json({
      status: 'not_ready',
      redis: redisStatus,
      mongo: mongoStatus,
      queue: queueStatus,
      message: 'Rate limiter decision store (Redis) is unavailable',
      timestamp: new Date().toISOString()
    });
  }

  res.status(200).json({
    status: 'ready',
    redis: 'connected',
    mongo: mongoStatus,
    queue: queueStatus,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
