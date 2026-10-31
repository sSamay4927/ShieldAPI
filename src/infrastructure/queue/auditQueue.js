const { Queue } = require('bullmq');
const crypto = require('crypto');
const { config } = require('../../config/env');
const { logger } = require('../../utils/logger');

const QUEUE_NAME = 'shieldapi-audit';

let queueInstance = null;
let queueDegraded = false;

/**
 * Parse REDIS_URL into BullMQ-compatible connection options.
 */
function getRedisConnectionOptions(redisUrl = config.REDIS_URL) {
  try {
    const parsed = new URL(redisUrl);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: Number(parsed.port) || 6379,
      password: parsed.password || undefined,
      username: parsed.username || undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    };
  } catch {
    return {
      host: '127.0.0.1',
      port: 6379,
      maxRetriesPerRequest: null
    };
  }
}

/**
 * Get or create the BullMQ Queue singleton.
 */
function getQueue() {
  if (queueInstance) {
    return queueInstance;
  }

  const connection = getRedisConnectionOptions();
  queueInstance = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000
      },
      removeOnComplete: 200,
      removeOnFail: 1000
    }
  });

  queueInstance.on('error', (err) => {
    queueDegraded = true;
    logger.error('BullMQ audit queue connection error', { error: err.message });
  });

  return queueInstance;
}

/**
 * Enqueue an audit event asynchronously.
 * Fire-and-forget: failure to enqueue logs a structured error and marks queue status degraded,
 * but NEVER throws or halts the caller's request lifecycle.
 *
 * @param {Object} payload
 * @returns {Promise<string|null>} Job ID if enqueued, null on failure
 */
async function enqueueAuditEvent(payload) {
  try {
    const queue = getQueue();
    const eventId = payload.eventId || crypto.randomUUID();
    const jobData = {
      ...payload,
      eventId,
      enqueuedAt: new Date().toISOString()
    };

    const job = await queue.add('audit_event', jobData, {
      jobId: eventId // Idempotent deduplication by eventId
    });

    queueDegraded = false;
    return job.id;
  } catch (err) {
    queueDegraded = true;
    logger.error('Failed to enqueue audit event to BullMQ', {
      requestId: payload.requestId,
      error: err.message
    });
    return null;
  }
}

/**
 * Query current queue health and readiness.
 */
function getQueueStatus() {
  if (queueDegraded) {
    return 'degraded';
  }
  return queueInstance ? 'connected' : 'ready';
}

/**
 * Cleanly close the queue connection during graceful shutdown.
 */
async function closeQueue() {
  if (queueInstance) {
    const q = queueInstance;
    queueInstance = null;
    await q.close();
    logger.info('Audit queue closed');
  }
}

module.exports = {
  QUEUE_NAME,
  getQueue,
  enqueueAuditEvent,
  getQueueStatus,
  closeQueue,
  getRedisConnectionOptions
};
